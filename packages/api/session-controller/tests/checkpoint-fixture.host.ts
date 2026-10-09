/**
 * Shared Host fixture for the checkpoint command specs: real Session store and
 * Agent registry, a scripted Agent factory, and an in-memory
 * `WorkspaceCheckpoint` whose restore writes `note.txt` in the Session cwd.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointRecord,
  CheckpointView,
  RestoreRequest,
  WorkspaceCheckpoint,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { SessionCheckpointFrame } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

export const sid = (id: string): SessionId => id as SessionId
export const abort = (): AbortSignal => new AbortController().signal

/**
 * Build the Session command controller used by checkpoint specs.
 * @param ctx - composed Host context.
 * @param cwd - default cwd for sessions created through the controller.
 * @returns the test controller.
 */
export function host(ctx: Context, cwd = process.cwd()) {
  return createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
    cwd,
  })
}

/**
 * Read the first text block of a `user/message` event.
 * @param event - any Session event.
 * @returns the text, or undefined for other events.
 */
export function messageText(event: { type: string; data: unknown }): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as { content?: Array<{ type?: string; text?: string }> }
  return data.content?.find(block => block.type === 'text')?.text
}

/**
 * Complete Agent fixture; unexpected driver or inbox mutations fail the test.
 * @param ctx - owner context.
 * @param session - Session the Agent drives.
 * @param pending - inbox contents to expose.
 * @returns the Agent.
 */
export function agentFixture(
  ctx: Context,
  session: Agent['session'],
  pending: { nextTurn: UserMessage[]; nextStep: UserMessage[] } = { nextTurn: [], nextStep: [] },
): Agent {
  const unexpected = (): never => { throw new Error('unexpected Agent fixture operation') }
  return {
    id: session.id,
    session,
    ctx,
    status: 'idle',
    options: {},
    inbox: {
      ...pending,
      clear: unexpected,
      append: unexpected,
      prepend: unexpected,
      replace: unexpected,
      remove: unexpected,
      splice: unexpected,
    },
    cancel: unexpected,
    whenIdle: async () => undefined,
    runMaintenance: unexpected,
    send: unexpected,
    followup: unexpected,
    steer: unexpected,
    inject: unexpected,
  }
}

/**
 * Append one turn whose reply ended with the given outcome.
 * @param session - Session to extend.
 * @param turn - turn number.
 * @param text - user message text.
 * @param failed - whether the turn ended in a provider error.
 */
export function addTurn(
  session: ReturnType<Context['sessions']['create']>,
  turn: number,
  text: string,
  failed = false,
): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', {
    turn,
    reason: failed
      ? { kind: 'error', error: { message: 'provider exploded', code: 'SERVER' } }
      : { kind: 'completed' },
  })
}

/** Spies for the checkpoint service methods the command specs script or assert. */
export interface CheckpointSpies {
  readonly inspect: Mock<(id: CheckpointRecord['id']) => Promise<CheckpointRecord>>
  readonly acquireLease: Mock<(workspaceKey: string) => Promise<{ workspaceKey: string; release: () => void }>>
  readonly recordEdit: Mock<(link: unknown) => Promise<void>>
  readonly sessionIndex: Mock<(sessionId: SessionId) => { appliedCheckpointId: CheckpointRecord['id'] } | undefined>
  readonly recoveryRequired: Mock<(workspaceKey: string) => Promise<string | undefined>>
  readonly markRecoveryRequired: Mock<(workspaceKey: string, reason: string) => Promise<void>>
  readonly clearRecoveryRequired: Mock<(workspaceKey: string) => Promise<void>>
}

export interface CheckpointFixture {
  readonly ctx: Context
  readonly checkpoint: WorkspaceCheckpoint
  readonly records: Map<string, CheckpointRecord>
  readonly frames: SessionCheckpointFrame[]
  readonly workspaces: Workspace[]
  readonly capture: Mock<(request: CaptureRequest) => Promise<CheckpointRecord>>
  readonly restore: Mock<(request: RestoreRequest) => Promise<{ checkpointId: CheckpointRecord['id']; fileCount: number }>>
  readonly spies: CheckpointSpies
  /** Unmocked implementations, for specs that wrap or fail one call. */
  readonly impl: {
    readonly capture: (request: CaptureRequest) => Promise<CheckpointRecord>
    readonly restore: (request: RestoreRequest) => Promise<{ checkpointId: CheckpointRecord['id']; fileCount: number }>
  }
  readonly lease: { release: Mock<() => void> }
  /** Child sessions are registered with a followup that completes a turn. */
  readonly childAgentFactory: { attach: boolean }
}

/**
 * Compose the Host context and in-memory checkpoint service.
 * @returns the context plus spies and the mutable record store.
 */
export async function composeCheckpointFixture(): Promise<CheckpointFixture> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const workspaces: Workspace[] = []
  ctx.provide('workspaceRegistry', { list: () => workspaces } as never)
  const frames: SessionCheckpointFrame[] = []
  ctx.on('session/checkpoints', (frame: SessionCheckpointFrame) => { frames.push(frame) })

  const childAgentFactory = { attach: true }
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      })
      const agent = agentFixture(ownerCtx, session)
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        ctx: agentCtx,
        followup: (message: UserMessage): void => {
          const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
          session.append('turn/start', { turn })
          session.append('user/message', message, { surfaceOp: 'append' })
          session.append('turn/end', { turn, reason: { kind: 'completed' } })
        },
      })
      const setup = await options.setup?.(agentCtx, agent)
      setup?.commit()
      if (childAgentFactory.attach) ctx.agents.register(agent)
      return { agent, dispose: async () => undefined }
    },
    resume: () => Promise.reject(new Error('checkpoint specs do not resume cold agents')),
  })

  const snapshots = new Map<string, string>()
  const records = new Map<string, CheckpointRecord>()
  let nextCheckpoint = 1
  const restoreImpl = async (restoreRequest: RestoreRequest): Promise<{ checkpointId: CheckpointRecord['id']; fileCount: number }> => {
    const record = records.get(String(restoreRequest.checkpointId))
    if (record === undefined) throw new Error(`checkpoint not found: ${String(restoreRequest.checkpointId)}`)
    await writeFile(join(restoreRequest.cwd, 'note.txt'), snapshots.get(String(record.id)) ?? '')
    return { checkpointId: record.id, fileCount: record.fileCount }
  }
  const restore = vi.fn(restoreImpl)
  const lease = { release: vi.fn<() => void>() }
  const captureImpl = async (captureRequest: CaptureRequest): Promise<CheckpointRecord> => {
    const id = CheckpointId(`cp-${String(nextCheckpoint++)}`)
    let value = ''
    try {
      value = await readFile(join(captureRequest.cwd, 'note.txt'), 'utf8')
    } catch {
      // A workspace without note.txt snapshots as empty.
      value = ''
    }
    snapshots.set(String(id), value)
    const record: CheckpointRecord = {
      id,
      sessionId: captureRequest.sessionId,
      workspaceKey: captureRequest.cwd,
      boundarySeq: captureRequest.boundarySeq,
      ...captureRequest.parentCheckpointId === undefined
        ? {}
        : { parentCheckpointId: captureRequest.parentCheckpointId },
      role: captureRequest.role,
      turnOutcome: captureRequest.turnOutcome,
      status: { kind: 'ready' },
      createdAt: nextCheckpoint,
      manifestHash: `hash-${String(nextCheckpoint)}`,
      fileCount: 1,
      restoreEligible: true,
      labelIndex: [...records.values()]
        .filter(candidate => candidate.sessionId === captureRequest.sessionId && candidate.role !== 'emergency')
        .length,
    }
    records.set(String(id), record)
    return record
  }
  const capture = vi.fn(captureImpl)
  const spies: CheckpointSpies = {
    inspect: vi.fn(async (id: CheckpointRecord['id']): Promise<CheckpointRecord> => {
      const record = records.get(String(id))
      if (record === undefined) throw new Error(`checkpoint not found: ${String(id)}`)
      return record
    }),
    acquireLease: vi.fn(async (workspaceKey: string) => ({ workspaceKey, release: lease.release })),
    recordEdit: vi.fn(async () => undefined),
    sessionIndex: vi.fn(() => undefined),
    recoveryRequired: vi.fn(async () => undefined),
    markRecoveryRequired: vi.fn(async () => undefined),
    clearRecoveryRequired: vi.fn(async () => undefined),
  }
  const checkpoint = {
    enabled: true,
    capture,
    ...spies,
    list: vi.fn(async (sessionId: SessionId): Promise<readonly CheckpointView[]> =>
      [...records.values()]
        .filter(record => record.sessionId === sessionId)
        .map(record => ({
          id: record.id,
          sessionId: record.sessionId,
          boundarySeq: record.boundarySeq,
          labelIndex: record.labelIndex,
          role: record.role,
          status: record.status,
          restoreEligible: record.restoreEligible,
          fileCount: record.fileCount,
          createdAt: record.createdAt,
        }))),
    restore,
    evict: vi.fn(async () => undefined),
  } as unknown as WorkspaceCheckpoint
  ctx.provide('workspaceCheckpoint', checkpoint)
  return {
    ctx,
    checkpoint,
    records,
    frames,
    workspaces,
    capture,
    restore,
    spies,
    lease,
    impl: { capture: captureImpl, restore: restoreImpl },
    childAgentFactory,
  }
}

/**
 * Seed a Session with one completed turn A, a checkpoint after it, and turn B.
 * @param fixture - composed fixture.
 * @param cwd - temp workspace directory.
 * @param id - Session id.
 * @param failedB - whether turn B ended in a provider error.
 * @returns the Session, the sequence of message B, and the pre-B checkpoint.
 */
export async function seedTwoTurns(
  fixture: CheckpointFixture,
  cwd: string,
  id: string,
  failedB = false,
) {
  const session = fixture.ctx.sessions.create(sid(id), { meta: { cwd } })
  addTurn(session, 1, 'A')
  await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
  const cp1 = await fixture.checkpoint.capture({
    sessionId: session.id,
    cwd,
    boundarySeq: session.snapshotEvents().at(-1)?.seq ?? -1,
    role: 'turn',
    turnOutcome: 'completed',
  })
  addTurn(session, 2, 'B', failedB)
  await writeFile(join(cwd, 'note.txt'), 'after-turn-2')
  const messageB = session.snapshotEvents().find(event => messageText(event) === 'B')
  if (messageB === undefined) throw new Error('test message B was not appended')
  return { session, messageSeq: messageB.seq, cp1 }
}
