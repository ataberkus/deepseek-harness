/**
 * Host checkpoint retry: restore the pre-turn workspace checkpoint and re-run
 * the failed message as a new turn in the same session.
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

/** Complete Agent fixture; unexpected driver or inbox mutations fail the test. */
function agentFixture(
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

async function composed(enabled = true): Promise<{
  ctx: Context
  checkpoint: WorkspaceCheckpoint
  capture: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
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
      const agent = agentFixture(ownerCtx, session)
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
        followup,
      })
      const setup = await options.setup?.(agentCtx, agent)
      setup?.commit()
      ctx.agents.register(agent)
      return { agent, dispose: async () => undefined }
    },
    resume: () => Promise.reject(new Error('retry test does not resume cold agents')),
  })

  const snapshots = new Map<string, string>()
  const records = new Map<string, CheckpointRecord>()
  let nextCheckpoint = 1
  const capture = vi.fn(async (captureRequest: CaptureRequest): Promise<CheckpointRecord> => {
    const id = CheckpointId(`cp-${String(nextCheckpoint++)}`)
    let value = ''
    try {
      value = await readFile(join(captureRequest.cwd, 'note.txt'), 'utf8')
    } catch {
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

function addFailedTurn(session: ReturnType<Context['sessions']['create']>, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', {
    turn,
    reason: {
      kind: 'error',
      error: { message: 'provider exploded', code: 'SERVER' },
    },
  })
}

describe('session.retry', () => {
  it('rejects retry when checkpoints are disabled', async () => {
    const { ctx } = await composed(false)
    try {
      await expect(host(ctx).retry({
        sessionId: sid('disabled-session'),
        messageSeq: 1,
        checkpointId: CheckpointId('cp-disabled'),
      }, abort())).rejects.toMatchObject({ code: 'checkpoint-disabled' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores the pre-turn checkpoint and re-runs the failed message in the same session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-retry-'))
    const { ctx, checkpoint, capture } = await composed()
    try {
      const session = ctx.sessions.create(sid('retry-parent'), { meta: { cwd } })
      addTurn(session, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const checkpointAfterTurn1 = await checkpoint.capture({
        sessionId: session.id,
        cwd,
        boundarySeq: session.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      addFailedTurn(session, 2, 'B')
      await writeFile(join(cwd, 'note.txt'), 'after-failed-turn')
      const messageB = session.snapshotEvents().find(event => event.type === 'user/message' && messageText(event) === 'B')
      if (messageB === undefined) throw new Error('test message B was not appended')
      const live = agentFixture(ctx, session)
      const eventsBefore = session.snapshotEvents().length
      live.followup = ((message: UserMessage): void => {
        const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
        session.append('turn/start', { turn })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }) as Agent['followup']
      ctx.agents.register(live)

      const value = await host(ctx, cwd).retry({
        sessionId: session.id,
        messageSeq: messageB.seq,
        checkpointId: checkpointAfterTurn1.id,
      }, abort())
      expect(value).toEqual({ accepted: true })
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-1')
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(session.snapshotEvents().length).toBeGreaterThan(eventsBefore)
      const texts = session.snapshotEvents()
        .filter(event => event.type === 'user/message')
        .map(event => messageText(event))
      expect(texts.filter(text => text === 'B')).toHaveLength(2)
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ role: 'emergency' }))
      expect(capture).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'initial' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses retry on a completed turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-retry-completed-'))
    const { ctx, checkpoint } = await composed()
    try {
      const session = ctx.sessions.create(sid('retry-completed'), { meta: { cwd } })
      addTurn(session, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const checkpointAfterTurn1 = await checkpoint.capture({
        sessionId: session.id,
        cwd,
        boundarySeq: session.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      const messageA = session.snapshotEvents().find(event => event.type === 'user/message' && messageText(event) === 'A')
      if (messageA === undefined) throw new Error('test message A was not appended')
      ctx.agents.register(agentFixture(ctx, session))
      await expect(host(ctx, cwd).retry({
        sessionId: session.id,
        messageSeq: messageA.seq,
        checkpointId: checkpointAfterTurn1.id,
      }, abort())).rejects.toMatchObject({ code: 'retry-not-retryable' })
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses retry while the agent has pending work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-retry-pending-'))
    const { ctx, checkpoint, capture } = await composed()
    try {
      const session = ctx.sessions.create(sid('retry-pending'), { meta: { cwd } })
      addTurn(session, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const checkpointAfterTurn1 = await checkpoint.capture({
        sessionId: session.id,
        cwd,
        boundarySeq: session.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      addFailedTurn(session, 2, 'B')
      const messageB = session.snapshotEvents().find(event => event.type === 'user/message' && messageText(event) === 'B')
      if (messageB === undefined) throw new Error('test message B was not appended')
      const pending = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
      ctx.agents.register(agentFixture(ctx, session, { nextTurn: [pending], nextStep: [] }))
      await expect(host(ctx, cwd).retry({
        sessionId: session.id,
        messageSeq: messageB.seq,
        checkpointId: checkpointAfterTurn1.id,
      }, abort())).rejects.toMatchObject({ code: 'session/agent-busy' })
      expect(capture).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'emergency' }))
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses retry with an unknown checkpoint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-retry-unknown-cp-'))
    const { ctx } = await composed()
    try {
      const session = ctx.sessions.create(sid('retry-unknown-cp'), { meta: { cwd } })
      addTurn(session, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      addFailedTurn(session, 2, 'B')
      const messageB = session.snapshotEvents().find(event => event.type === 'user/message' && messageText(event) === 'B')
      if (messageB === undefined) throw new Error('test message B was not appended')
      ctx.agents.register(agentFixture(ctx, session))
      await expect(host(ctx, cwd).retry({
        sessionId: session.id,
        messageSeq: messageB.seq,
        checkpointId: CheckpointId('cp-missing'),
      }, abort())).rejects.toMatchObject({ code: 'checkpoint-unavailable' })
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses retry while workspace recovery is required', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-retry-recovery-'))
    const { ctx, checkpoint } = await composed()
    try {
      const session = ctx.sessions.create(sid('retry-recovery'), { meta: { cwd } })
      addTurn(session, 1, 'A')
      await writeFile(join(cwd, 'note.txt'), 'after-turn-1')
      const checkpointAfterTurn1 = await checkpoint.capture({
        sessionId: session.id,
        cwd,
        boundarySeq: session.snapshotEvents().at(-1)?.seq ?? -1,
        role: 'turn',
        turnOutcome: 'completed',
      })
      addFailedTurn(session, 2, 'B')
      const messageB = session.snapshotEvents().find(event => event.type === 'user/message' && messageText(event) === 'B')
      if (messageB === undefined) throw new Error('test message B was not appended')
      ctx.agents.register(agentFixture(ctx, session))
      vi.mocked(checkpoint.recoveryRequired).mockResolvedValueOnce('rollback failed earlier')
      await expect(host(ctx, cwd).retry({
        sessionId: session.id,
        messageSeq: messageB.seq,
        checkpointId: checkpointAfterTurn1.id,
      }, abort())).rejects.toMatchObject({ code: 'checkpoint-recovery-required' })
    } finally {
      await ctx.fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
