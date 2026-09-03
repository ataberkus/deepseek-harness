/**
 * Host checkpoint commands: edit settles an active source boundary,
 * restores the selected workspace, and publishes an isolated child session.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
import { createSessionTestController } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId
const abort = (): AbortSignal => new AbortController().signal

function host(ctx: Context, cwd = process.cwd()) {
  return createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'provider', model: 'model' }),
    cwd,
  })
}

function messageText(event: { type: string; data: unknown }): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as { content?: Array<{ type?: string; text?: string }> }
  return data.content?.find(block => block.type === 'text')?.text
}

async function composed(enabled = true): Promise<{
  ctx: Context
  checkpoint: WorkspaceCheckpoint
  capture: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)

  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      })
      const agent = {} as Agent
      const followup = (message: UserMessage): void => {
        const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
        session.append('turn/start', { turn })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        session,
        status: 'idle',
        ctx: agentCtx,
        inbox: { hasPending: false, nextTurn: [], nextStep: [] },
        followup,
      })
      await options.setup?.(agentCtx)
      ctx.agents.register(agent)
      return { agent, dispose: async () => undefined }
    },
    resume: () => Promise.reject(new Error('edit test does not resume cold agents')),
  })

  const snapshots = new Map<string, string>()
  const records = new Map<string, CheckpointRecord>()
  let nextCheckpoint = 1
  const capture = vi.fn(async (captureRequest: CaptureRequest): Promise<CheckpointRecord> => {
    const id = CheckpointId(`cp-${String(nextCheckpoint++)}`)
    const value = await readFile(join(captureRequest.cwd, 'note.txt'), 'utf8')
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
    ctx.emit('workspace-checkpoint/changed', captureRequest.sessionId)
    return record
  })
  const checkpoint = {
    enabled,
    capture,
    inspect: vi.fn(async (id: ReturnType<typeof CheckpointId>) => {
      const record = records.get(String(id))
      if (record === undefined) throw new Error(`checkpoint not found: ${String(id)}`)
      return record
    }),
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
    restore: vi.fn(async (restoreRequest: RestoreRequest) => {
      const record = records.get(String(restoreRequest.checkpointId))
      if (record === undefined) throw new Error(`checkpoint not found: ${String(restoreRequest.checkpointId)}`)
      await writeFile(join(restoreRequest.cwd, 'note.txt'), snapshots.get(String(record.id)) ?? '')
      ctx.emit('workspace-checkpoint/changed', record.sessionId)
      return { checkpointId: record.id, fileCount: record.fileCount }
    }),
    acquireLease: vi.fn(async (workspaceKey: string) => ({
      workspaceKey,
      release: vi.fn(),
    })),
    recordEdit: vi.fn(async () => undefined),
    sessionIndex: vi.fn(() => undefined),
    recoveryRequired: vi.fn(async () => undefined),
    markRecoveryRequired: vi.fn(async () => undefined),
    clearRecoveryRequired: vi.fn(async () => undefined),
    evict: vi.fn(async () => undefined),
  } as unknown as WorkspaceCheckpoint
  ctx.provide('workspaceCheckpoint', checkpoint)
  return { ctx, checkpoint, capture }
}

function addTurn(session: ReturnType<Context['sessions']['create']>, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('session.edit and session.activate', () => {
  it('rejects edit and activation before touching a session when checkpoints are disabled', async () => {
    const { ctx } = await composed(false)
    try {
      const controller = host(ctx)
      await expect(controller.edit({
        sessionId: sid('disabled-session'),
        messageSeq: 1,
        checkpointId: CheckpointId('cp-disabled'),
        text: 'edited',
      }, abort())).rejects.toMatchObject({ code: 'checkpoint-disabled' })
      await expect(controller.activate({
        sessionId: sid('disabled-session'),
      }, abort())).rejects.toMatchObject({ code: 'checkpoint-disabled' })

    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('edits a later user message from the preceding checkpoint and hides descendants in the child', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
    const { ctx, checkpoint, capture } = await composed()
    try {
      const parent = ctx.sessions.create(sid('parent'), { meta: { cwd } })
      addTurn(parent, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const checkpointAfterTurn1 = await checkpoint.capture({
        sessionId: parent.id,
        cwd,
        boundarySeq: parent.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      addTurn(parent, 2, 'B')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-2')
      const messageB = parent.snapshotEvents().find(event => event.type === 'user/message' && messageText(event) === 'B')
      if (messageB === undefined) throw new Error('test message B was not appended')
      ctx.agents.register({
        id: parent.id,
        session: parent,
        status: 'idle',
        inbox: { hasPending: false },
        ctx,
      } as Agent)

      const value = await host(ctx, cwd).edit({
        sessionId: parent.id,
        messageSeq: messageB.seq,
        checkpointId: checkpointAfterTurn1.id,
        text: 'edited B',
      }, abort())
      const child = ctx.sessions.get(value.sessionId)
      if (child === undefined) throw new Error('edit did not publish a child')
      expect(child.header.parentSession).toBe(parent.id)
      expect(child.snapshotEvents().some(event => event.type === 'user/message' && messageText(event) === 'edited B')).toBe(true)
      expect(child.snapshotEvents().some(event => messageText(event) === 'B')).toBe(false)
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-1')
      expect(parent.snapshotEvents().some(event => messageText(event) === 'B')).toBe(true)
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ role: 'emergency' }))
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: child.id,
        role: 'initial',
        parentCheckpointId: checkpointAfterTurn1.id,
      }))
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('cancels a running source before restoring its checkpoint and branching', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-edit-running-'))
    const { ctx, checkpoint, capture } = await composed()
    try {
      const parent = ctx.sessions.create(sid('running-parent'), { meta: { cwd } })
      addTurn(parent, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const checkpointAfterTurn1 = await checkpoint.capture({
        sessionId: parent.id,
        cwd,
        boundarySeq: parent.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      parent.append('turn/start', { turn: 2 })
      const messageB = parent.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'B' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await writeFile(join(cwd, 'note.txt'), 'while-running')

      let status: Agent['status'] = 'running'
      const cancel = vi.fn(() => {
        parent.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
        status = 'idle'
      })
      const whenIdle = vi.fn(async () => undefined)
      ctx.agents.register({
        id: parent.id,
        session: parent,
        get status() { return status },
        inbox: { hasPending: false },
        ctx,
        cancel,
        whenIdle,
      } as unknown as Agent)

      const value = await host(ctx, cwd).edit({
        sessionId: parent.id,
        messageSeq: messageB.seq,
        checkpointId: checkpointAfterTurn1.id,
        text: 'edited B',
      }, abort())
      expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
      expect(whenIdle).toHaveBeenCalledOnce()
      const child = ctx.sessions.get(value.sessionId)
      if (child === undefined) throw new Error('edit did not publish a child')
      expect(parent.snapshotEvents().at(-1)?.type).toBe('turn/end')
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-1')
      expect(child.snapshotEvents().some(event => event.type === 'user/message' && messageText(event) === 'edited B')).toBe(true)
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: parent.id,
        role: 'emergency',
      }))
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('activates the latest usable checkpoint without changing conversation history', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-activate-'))
    const { ctx, checkpoint } = await composed()
    try {
      const session = ctx.sessions.create(sid('activate'), { meta: { cwd } })
      addTurn(session, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const record = await checkpoint.capture({
        sessionId: session.id,
        cwd,
        boundarySeq: session.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      await writeFile(join(cwd, 'note.txt'), 'changed-after-checkpoint')
      const value = await host(ctx, cwd).activate({ sessionId: session.id }, abort())
      expect(value).toMatchObject({ restored: true, checkpointId: record.id })
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-1')
      expect(session.snapshotEvents().some(event => event.type === 'user/message' && messageText(event) === 'A')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
