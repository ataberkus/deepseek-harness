/** Session commands whose activation policy is explicit at each Remote method. */

import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError, admitPromptContent } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CheckpointEditLink,
  CheckpointOperationPhase,
  CheckpointRecord,
  WorkspaceCheckpoint,
  WorkspaceLease,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  SessionActivateRequest,
  SessionActivateValue,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionEditRequest,
  SessionEditValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
  ) {}

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
  }

  /**
   * Validate and install one Session-local model selection.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        try {
          await this.ctx.agentDefaultModel.saveSelection(selected)
        } catch (error) {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        }
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from one completed-turn prefix.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const lastSeq = source.events.at(-1)?.seq ?? -1
    const anchoredBoundary = atSeq === undefined
      ? undefined
      : source.events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
    const boundary = anchoredBoundary
      ?? (atSeq === undefined || atSeq > lastSeq
        ? source.events.findLast(event => event.type === 'turn/end')
        : undefined)
    if (boundary === undefined) {
      throw new RemoteError(
        'session/fork-unavailable',
        atSeq !== undefined && atSeq <= lastSeq
          ? `session "${request.sessionId}" has not completed the turn containing event ${String(atSeq)}`
          : `session "${request.sessionId}" has no completed turn to fork from`,
        { sessionId: request.sessionId },
      )
    }
    let cut = SessionLogOffset(boundary.seq + 1)
    while (cut < source.events.length && source.events[cut]?.type !== 'turn/start') {
      cut = SessionLogOffset(cut + 1)
    }
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed: source.events.slice(0, cut),
        inheritedEventCount: cut,
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Admit one browser prompt after explicit Agent resume and image validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    const selection = this.agents.selectionFor(agent).current
    if (!routeServed(this.ctx, selection.provider)) {
      throw new RemoteError(
        'session/model-unavailable',
        `no adapter serves provider "${selection.provider}"; select a model for this session`,
        { provider: selection.provider, model: selection.model },
      )
    }
    const source: MessageSource = { kind: 'user' }
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        if (hasImage) {
          const current = this.agents.selectionFor(agent).current
          const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            throw new RemoteError(
              'session/attachment-invalid',
              `Model "${current.model}" does not support image input.`,
              { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            )
          }
        }
        const content = await admitPromptContent(this.ctx.attachments, request.content)
        const message: UserMessage = createUserMessage({ content, source })
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    let source: SessionReadState
    try {
      source = await this.readSessionState(request.sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const ref = referencedImage(source.events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one still-pending queue occurrence without resuming a cold Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue {
    if (request.action.kind === 'edit'
      && request.action.content.some(block => block.type !== 'text')) {
      throw new RemoteError(
        'session/attachment-invalid',
        'queue edits accept text content only',
        { reason: 'QUEUE_EDIT_NON_TEXT' },
      )
    }
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined && hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    if (agent === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    if (request.action.kind === 'edit') {
      agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
        ...message,
        content: [...request.action.content],
      }))
    } else {
      agent.inbox.remove(request.itemId)
      if (request.action.kind === 'steer') agent.steer(message)
    }
    return { accepted: true }
  }

  /**
   * Edit a completed user message by restoring its workspace checkpoint and
   * creating a child Session from the inherited transcript prefix.
   * @param request - source Session, message sequence, checkpoint, and text.
   * @returns the newly created child Session identity.
   */
  async edit(request: SessionEditRequest): Promise<SessionEditValue> {
    const checkpoint = this.requireCheckpointService(request.sessionId)
    if (request.text.trim() === '') {
      throw new RemoteError('edit-not-editable', 'edited message text cannot be empty', {
        sessionId: request.sessionId,
        messageSeq: request.messageSeq,
      })
    }
    let source = await this.readEditableSource(request.sessionId, request.messageSeq)
    const sourceAgent = this.ctx.agents.get(request.sessionId)
    if (sourceAgent !== undefined && sourceAgent.status !== 'idle') {
      sourceAgent.cancel({ kind: 'user' }, { keepInbox: true })
      try {
        await sourceAgent.whenIdle()
      } catch (error) {
        throw new RemoteError('session/agent-busy', `session "${request.sessionId}" could not be stopped: ${String(error)}`, {
          reason: 'agent did not become idle',
        })
      }
      source = await this.readEditableSource(request.sessionId, request.messageSeq)
    }
    if (sourceAgent !== undefined && sourceAgent.inbox.hasPending) {
      throw new RemoteError('session/agent-busy', `session "${request.sessionId}" has pending work`, {
        reason: 'pending inbox messages',
      })
    }
    const cwd = source.header.cwd
    if (cwd === undefined) throw editRefusal(request)
    const workspaceKey = await canonicalWorkspaceKey(cwd)
    const recovery = await checkpoint.recoveryRequired(workspaceKey)
    if (recovery !== undefined) {
      throw new RemoteError('checkpoint-recovery-required', recovery, {
        sessionId: request.sessionId,
        reason: recovery,
      })
    }
    const targetIndex = source.events.findIndex(event => event.seq === request.messageSeq)
    const target = source.events[targetIndex]
    if (target === undefined
      || target.type !== 'user/message'
      || target.data.source.kind !== 'user'
      || !isAppendSurfaceEvent(target)) {
      throw editRefusal(request)
    }
    const turnStartIndex = source.events.findLastIndex((event, index) =>
      index < targetIndex && event.type === 'turn/start')
    const turnEndIndex = source.events.findIndex((event, index) =>
      index > targetIndex && event.type === 'turn/end')
    if (turnStartIndex < 0 || turnEndIndex < 0) throw editRefusal(request)
    const sourceBoundarySeq = source.events
      .slice(0, turnStartIndex)
      .findLast(event => event.type === 'turn/end')?.seq ?? -1
    const views = await checkpoint.list(request.sessionId)
    const selected = await checkpoint.inspect(request.checkpointId).catch(() => undefined)
    if (selected === undefined
      || selected.sessionId !== request.sessionId
      || selected.workspaceKey !== workspaceKey
      || selected.boundarySeq !== sourceBoundarySeq
      || selected.role === 'emergency'
      || selected.status.kind !== 'ready'
      || !selected.restoreEligible) {
      throw checkpointUnavailable(request)
    }
    const operation = (phase: CheckpointOperationPhase, childSessionId?: SessionId, message?: string): void => {
      this.ctx.emit('session/checkpoints', {
        type: 'session/checkpoints',
        sessionId: request.sessionId,
        checkpoints: views,
        enabled: checkpoint.enabled,
        appliedCheckpointId: selected.id,
        operation: {
          sourceSessionId: request.sessionId,
          ...(childSessionId === undefined ? {} : { childSessionId }),
          checkpointId: selected.id,
          phase,
          fileCount: selected.fileCount,
          ...(message === undefined ? {} : { message }),
        },
        branchCheckpoint: selected,
        branchLabelIndex: selected.labelIndex,
        workspaceResumable: true,
      })
    }
    operation('preparing')
    let lease: WorkspaceLease | undefined
    let emergency: CheckpointRecord | undefined
    try {
      operation('capturing-emergency')
      lease = await checkpoint.acquireLease(workspaceKey)
      emergency = await checkpoint.capture({
        sessionId: request.sessionId,
        cwd,
        boundarySeq: source.events.at(-1)?.seq ?? -1,
        role: 'emergency',
        turnOutcome: 'failed',
        lease,
      })
      if (emergency.status.kind !== 'ready') throw new Error(emergency.status.reason)
      operation('restoring')
      await checkpoint.restore({ checkpointId: selected.id, cwd, lease })
      const childId = brandString<SessionId>(`session-${randomUUID()}`)
      operation('creating-branch', childId)
      const composition = await this.agents.composeAgent(
        sourceAgent === undefined ? undefined : this.agents.presetForSession(sourceAgent.session),
      )
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed: source.events.slice(0, turnStartIndex),
        meta: {
          cwd,
          parentSession: request.sessionId,
          seedLength: turnStartIndex,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
      const workspace = await this.forkWorkspace(source.header)
      if (workspace !== undefined) await workspace.attachSession(childId)
      const childAgent = this.ctx.agents.get(childId)
      if (childAgent === undefined) throw new Error(`child Agent "${childId}" was not attached`)
      const childInitial = await checkpoint.capture({
        sessionId: childId,
        cwd,
        parentCheckpointId: selected.id,
        boundarySeq: turnStartIndex > 0 ? source.events[turnStartIndex - 1]?.seq ?? -1 : -1,
        role: 'initial',
        turnOutcome: 'initial',
        lease,
      })
      if (childInitial.status.kind !== 'ready') throw new Error(childInitial.status.reason)
      await checkpoint.recordEdit({
        sourceSessionId: request.sessionId,
        sourceBoundarySeq,
        selectedCheckpointId: selected.id,
        emergencyCheckpointId: emergency.id,
        childSessionId: childId,
      } satisfies CheckpointEditLink)
      childAgent.followup(createUserMessage({
        content: editedContent(target.data, request.text),
        source: { kind: 'user' },
      }))
      operation('ready', childId)
      return { sessionId: childId }
    } catch (error) {
      operation('failed', undefined, String(error))
      if (emergency !== undefined) {
        try {
          await checkpoint.restore({
            checkpointId: emergency.id,
            cwd,
            ...lease === undefined ? {} : { lease },
          })
          await checkpoint.clearRecoveryRequired(workspaceKey)
        } catch (rollbackError) {
          const reason = `checkpoint rollback failed: ${String(rollbackError)}`
          await checkpoint.markRecoveryRequired(workspaceKey, reason)
          throw new RemoteError('checkpoint-recovery-required', reason, {
            sessionId: request.sessionId,
            reason,
          })
        }
      }
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError('checkpoint-unavailable', `session edit failed: ${String(error)}`, {
        sessionId: request.sessionId,
        checkpointId: request.checkpointId,
      })
    } finally {
      lease?.release()
    }
  }

  /**
   * Restore the latest usable checkpoint for a Session without creating a branch.
   * @param request - Session whose workspace should be restored.
   * @returns restore status and selected checkpoint identity.
   */
  async activate(request: SessionActivateRequest): Promise<SessionActivateValue> {
    const checkpoint = this.requireCheckpointService(request.sessionId)
    const source = await this.readSessionState(request.sessionId)
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined && (agent.status !== 'idle' || agent.inbox.hasPending)) {
      throw new RemoteError('session/agent-busy', `session "${request.sessionId}" is busy`, {
        reason: 'activation requires an idle Agent with an empty inbox',
      })
    }
    const cwd = source.header.cwd
    if (cwd === undefined) return { restored: false, unavailable: true }
    const workspaceKey = await canonicalWorkspaceKey(cwd)
    const recovery = await checkpoint.recoveryRequired(workspaceKey)
    if (recovery !== undefined) {
      throw new RemoteError('checkpoint-recovery-required', recovery, {
        sessionId: request.sessionId,
        reason: recovery,
      })
    }
    const views = await checkpoint.list(request.sessionId)
    const selectedView = views
      .filter(view => view.role !== 'emergency' && view.status.kind === 'ready' && view.restoreEligible)
      .toSorted((left, right) => right.labelIndex - left.labelIndex)[0]
    if (selectedView === undefined) {
      return { restored: false, unavailable: views.length > 0 }
    }
    const selected = await checkpoint.inspect(selectedView.id).catch(() => undefined)
    if (selected === undefined || selected.workspaceKey !== workspaceKey) {
      return { restored: false, unavailable: true }
    }
    const applied = checkpoint.sessionIndex(request.sessionId)?.appliedCheckpointId
    if (applied === selected.id) return { restored: true, checkpointId: selected.id }
    this.ctx.emit('session/checkpoints', {
      type: 'session/checkpoints',
      sessionId: request.sessionId,
      checkpoints: views,
      enabled: checkpoint.enabled,
      appliedCheckpointId: selected.id,
      operation: {
        sourceSessionId: request.sessionId,
        checkpointId: selected.id,
        phase: 'restoring',
        fileCount: selected.fileCount,
      },
      branchCheckpoint: selected,
      branchLabelIndex: selected.labelIndex,
      workspaceResumable: true,
    })
    let lease: Awaited<ReturnType<WorkspaceCheckpoint['acquireLease']>> | undefined
    let emergency: Awaited<ReturnType<WorkspaceCheckpoint['capture']>> | undefined
    try {
      lease = await checkpoint.acquireLease(workspaceKey)
      emergency = await checkpoint.capture({
        sessionId: request.sessionId,
        cwd,
        boundarySeq: source.events.at(-1)?.seq ?? -1,
        role: 'emergency',
        turnOutcome: 'failed',
        lease,
      })
      await checkpoint.restore({
        checkpointId: selected.id,
        cwd,
        ...lease === undefined ? {} : { lease },
      })
      await checkpoint.clearRecoveryRequired(workspaceKey)
      return { restored: true, checkpointId: selected.id }
    } catch (error) {
      if (emergency !== undefined) {
        try {
          await checkpoint.restore({
            checkpointId: emergency.id,
            cwd,
            ...lease === undefined ? {} : { lease },
          })
        } catch (rollbackError) {
          const reason = `checkpoint rollback failed: ${String(rollbackError)}`
          await checkpoint.markRecoveryRequired(workspaceKey, reason)
          throw new RemoteError('checkpoint-recovery-required', reason, {
            sessionId: request.sessionId,
            reason,
          })
        }
      }
      if (remoteErrorOf(error) !== undefined) throw error
      throw new RemoteError('checkpoint-unavailable', `session activation failed: ${String(error)}`, {
        sessionId: request.sessionId,
        checkpointId: selected.id,
      })
    } finally {
      lease?.release()
    }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private requireCheckpointService(sessionId: SessionId): WorkspaceCheckpoint {
    const service = this.ctx.get('workspaceCheckpoint')
    if (service === undefined || !service.enabled) {
      throw new RemoteError('checkpoint-disabled', `workspace checkpoints are disabled for session "${sessionId}"`, {
        sessionId,
      })
    }
    return service
  }

  private async readEditableSource(sessionId: SessionId, messageSeq: number): Promise<SessionReadState> {
    try {
      const source = await this.readSessionState(sessionId)
      if (!Number.isSafeInteger(messageSeq) || messageSeq < 0) throw editRefusal({ sessionId, messageSeq })
      return source
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId })
      }
      throw new RemoteError('gateway/internal', `session "${sessionId}" is unavailable: ${String(error)}`, {})
    }
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return { id: attached.id, header: attached.header, events: attached.snapshotEvents() }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown; readonly content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: readonly { readonly content?: unknown }[]
    readonly chunk?: { readonly type?: unknown; readonly block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  const message = imageBlockIn(data.message?.content, match)
  if (message !== undefined) return message
  for (const inserted of data.inserted ?? []) {
    const found = imageBlockIn(inserted.content, match)
    if (found !== undefined) return found
  }
  return event.type === 'assistant/chunk' && data.chunk?.type === 'block-end'
    ? imageBlockIn([data.chunk.block], match)
    : undefined
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

function routeServed(ctx: Context, provider: string): boolean {
  return ctx.llm.listProviders().some(entry => entry.id === provider)
}

async function canonicalWorkspaceKey(cwd: string): Promise<string> {
  try {
    return await realpath(cwd)
  } catch {
    return cwd
  }
}

function editRefusal(request: Pick<SessionEditRequest, 'sessionId' | 'messageSeq'>): RemoteError<'edit-not-editable'> {
  return new RemoteError(
    'edit-not-editable',
    `message ${String(request.messageSeq)} is not editable in session "${request.sessionId}"`,
    { sessionId: request.sessionId, messageSeq: request.messageSeq },
  )
}

function checkpointUnavailable(
  request: Pick<SessionEditRequest, 'sessionId' | 'checkpointId'>,
): RemoteError<'checkpoint-unavailable'> {
  return new RemoteError(
    'checkpoint-unavailable',
    `checkpoint "${String(request.checkpointId)}" is unavailable for session "${request.sessionId}"`,
    { sessionId: request.sessionId, checkpointId: request.checkpointId },
  )
}

function editedContent(message: UserMessage, text: string): ContentBlock[] {
  let replaced = false
  const content: ContentBlock[] = message.content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    return { type: 'text' as const, text }
  })
  return replaced ? content : [{ type: 'text' as const, text }, ...content]
}
