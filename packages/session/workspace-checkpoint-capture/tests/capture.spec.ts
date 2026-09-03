import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, Session, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointRecord,
  CheckpointView,
  WorkspaceCheckpoint,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import * as workspaceCheckpointCapture from '../src/index.ts'

const contexts: Context[] = []

interface Probe {
  readonly service: WorkspaceCheckpoint
  readonly captures: ReturnType<typeof vi.fn>
  readonly records: CheckpointRecord[]
}

function checkpointProbe(enabled = true): Probe {
  const records: CheckpointRecord[] = []
  let sequence = 0
  const captures = vi.fn(async (request: CaptureRequest): Promise<CheckpointRecord> => {
    const record: CheckpointRecord = {
      id: CheckpointId(`cp_${++sequence}`),
      sessionId: request.sessionId,
      workspaceKey: request.cwd,
      boundarySeq: request.boundarySeq,
      ...request.parentCheckpointId === undefined ? {} : { parentCheckpointId: request.parentCheckpointId },
      role: request.role,
      turnOutcome: request.turnOutcome,
      status: { kind: 'ready' },
      createdAt: sequence,
      manifestHash: `manifest_${sequence}`,
      fileCount: 0,
      restoreEligible: true,
      labelIndex: records.filter(item => item.role !== 'emergency').length,
    }
    records.push(record)
    return record
  })
  const service = {
    enabled,
    capture: captures,
    list: async (sessionId: SessionId): Promise<readonly CheckpointView[]> =>
      records.filter(record => record.sessionId === sessionId).map(record => ({
        id: record.id,
        sessionId: record.sessionId,
        boundarySeq: record.boundarySeq,
        labelIndex: record.labelIndex,
        role: record.role,
        status: record.status,
        restoreEligible: record.restoreEligible,
        fileCount: record.fileCount,
        createdAt: record.createdAt,
      })),
    inspect: async () => { throw new Error('not used') },
    restore: async () => { throw new Error('not used') },
    acquireLease: async () => { throw new Error('not used') },
    recoveryRequired: async () => undefined,
    markRecoveryRequired: async () => undefined,
    clearRecoveryRequired: async () => undefined,
    evict: async () => undefined,
  } as unknown as WorkspaceCheckpoint
  return { service, captures, records }
}

async function setup(enabled = true): Promise<{ ctx: Context; probe: Probe }> {
  const ctx = new Context()
  contexts.push(ctx)
  const probe = checkpointProbe(enabled)
  ctx.provide('workspaceCheckpoint', probe.service)
  ctx.provide('llm', {} as never)
  ctx.provide('tools', {} as never)
  await ctx.plugin((await import('@deepseek-ai/dsh-session')).default)
  await ctx.plugin(workspaceCheckpointCapture)
  return { ctx, probe }
}

async function waitFor<T>(read: () => T | Promise<T>, expected: T): Promise<void> {
  await vi.waitFor(async () => {
    expect(await read()).toEqual(expected)
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('workspace-checkpoint-capture', () => {
  it('does not capture or flush when the provider is disabled', async () => {
    const { ctx, probe } = await setup(false)
    const flushes: Session[] = []
    ctx.on('session/flush', (session) => { flushes.push(session) })
    const session = ctx.sessions.create(SessionId('capture-disabled'), { meta: { cwd: process.cwd() } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(probe.records).toHaveLength(0)
      expect(flushes).toHaveLength(0)
    })
  })

  it('captures checkpoint 0 at session creation and a later checkpoint after turn/end', async () => {
    const { ctx, probe } = await setup()
    const session = ctx.sessions.create(SessionId('capture-start'), { meta: { cwd: process.cwd() } })

    await waitFor(() => probe.records.length, 1)
    expect(probe.records[0]?.boundarySeq).toBe(-1)
    expect(probe.records[0]?.role).toBe('initial')

    session.append('turn/start', { turn: 1 })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await waitFor(() => probe.records.length, 2)

    expect(probe.records[1]).toMatchObject({
      boundarySeq: end.seq,
      role: 'turn',
      turnOutcome: 'completed',
      parentCheckpointId: probe.records[0]?.id,
    })
  })

  it('does not create a new checkpoint 0 for a seeded session', async () => {
    const { ctx, probe } = await setup()
    ctx.sessions.create(SessionId('capture-resume'), {
      seed: [{
        type: 'session/end-seed',
        seq: SessionSeq(0),
        time: 1,
        data: {},
      }],
      meta: { cwd: process.cwd() },
    })

    await vi.waitFor(() => {
      expect(probe.records).toHaveLength(0)
    })
  })

  it('flushes before turn capture and preserves the completed turn when capture is unavailable', async () => {
    const { ctx, probe } = await setup()
    const flushes: Session[] = []
    ctx.on('session/flush', (session) => { flushes.push(session) })
    const session = ctx.sessions.create(SessionId('capture-unavailable'), { meta: { cwd: process.cwd() } })
    await waitFor(() => probe.records.length, 1)
    probe.captures.mockImplementationOnce((request: CaptureRequest) => {
      const record: CheckpointRecord = {
        id: CheckpointId('cp-unavailable'),
        sessionId: request.sessionId,
        workspaceKey: request.cwd,
        boundarySeq: request.boundarySeq,
        role: request.role,
        turnOutcome: request.turnOutcome,
        status: { kind: 'unavailable', reason: 'concurrent-write' },
        createdAt: 2,
        manifestHash: 'unavailable',
        fileCount: 0,
        restoreEligible: false,
        labelIndex: 1,
      }
      probe.records.push(record)
      return record
    })

    session.append('turn/start', { turn: 1 })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await waitFor(() => probe.records.length, 2)

    expect(flushes).toContain(session)
    expect(session.snapshotEvents().some(event => event.type === 'turn/end' && event.seq === end.seq)).toBe(true)
    expect(probe.records[1]).toMatchObject({
      boundarySeq: end.seq,
      status: { kind: 'unavailable' },
      restoreEligible: false,
    })
  })

  it('captures failed, cancelled, and interrupted turn outcomes', async () => {
    const { ctx, probe } = await setup()
    const session = ctx.sessions.create(SessionId('capture-outcomes'), { meta: { cwd: process.cwd() } })
    await waitFor(() => probe.records.length, 1)
    const reasons: SessionEvent<'turn/end'>['data']['reason'][] = [
      { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'interrupted' },
    ]

    for (const [index, reason] of reasons.entries()) {
      session.append('turn/start', { turn: index + 1 })
      session.append('turn/end', { turn: index + 1, reason })
    }
    await waitFor(() => probe.records.length, 4)

    expect(probe.records.slice(1).map(record => record.turnOutcome)).toEqual([
      'failed',
      'cancelled',
      'interrupted',
    ])
  })
})
