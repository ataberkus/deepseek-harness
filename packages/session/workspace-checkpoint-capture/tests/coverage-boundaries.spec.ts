/**
 * Capture scheduling and recovery admission edge paths: sessions without a
 * cwd, seeded sessions, the enabled toggle between queued jobs, fail-soft
 * provider and persistence errors, and pass-through of clear workspaces.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointRecord,
  CheckpointView,
  WorkspaceCheckpoint,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import * as workspaceCheckpointCapture from '../src/index.ts'

/** Scriptable provider state shared with the service double. */
interface Provider {
  enabled: boolean
  recovery: Map<string, string>
  captures: CaptureRequest[]
  /** Holds every capture open until resolved. */
  captureGate: Promise<void> | undefined
  /** Fails capture with this error. */
  captureError: Error | undefined
  /** Fails list with this error. */
  listError: Error | undefined
}

const contexts: Context[] = []

async function setup(): Promise<{ ctx: Context; provider: Provider; logs: Message[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: Message[] = []
  // Level 3 admits warn messages, which the default exporter threshold drops.
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(message) } })
  const provider: Provider = {
    enabled: true,
    recovery: new Map(),
    captures: [],
    captureGate: undefined,
    captureError: undefined,
    listError: undefined,
  }
  const records: CheckpointRecord[] = []
  const service = {
    get enabled() { return provider.enabled },
    capture: async (request: CaptureRequest): Promise<CheckpointRecord> => {
      await provider.captureGate
      if (provider.captureError !== undefined) throw provider.captureError
      provider.captures.push(request)
      const record: CheckpointRecord = {
        id: CheckpointId(`cp_${records.length + 1}`),
        sessionId: request.sessionId,
        workspaceKey: request.cwd,
        boundarySeq: request.boundarySeq,
        role: request.role,
        turnOutcome: request.turnOutcome,
        status: { kind: 'ready' },
        createdAt: records.length + 1,
        manifestHash: 'm',
        fileCount: 0,
        restoreEligible: true,
        labelIndex: records.length,
      }
      records.push(record)
      return record
    },
    list: async (): Promise<readonly CheckpointView[]> => {
      if (provider.listError !== undefined) throw provider.listError
      return records
    },
    recoveryRequired: async (workspaceKey: string) => provider.recovery.get(workspaceKey),
  } as unknown as WorkspaceCheckpoint
  ctx.provide('workspaceCheckpoint', service)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(workspaceCheckpointCapture)
  return { ctx, provider, logs }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Warn-level messages as plain text. */
function warnings(logs: Message[]): string[] {
  return logs.filter(message => message.type === 'warn').map(message => String(message.args[0]))
}

/** Let queued microtasks and timers settle when asserting that nothing happened. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

describe('workspace-checkpoint-capture boundaries', () => {
  it.each([
    ['blocked', { kind: 'blocked' }],
    ['max-tokens', { kind: 'max-tokens' }],
    ['an unknown ending', { kind: 'future-ending' }],
  ])('records %s as a failed turn', async (_label, reason) => {
    const { ctx, provider } = await setup()
    const session = ctx.sessions.create(SessionId('failed-endings'), { meta: { cwd: process.cwd() } })
    await vi.waitFor(() => { expect(provider.captures).toHaveLength(1) })

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: reason as never })

    await vi.waitFor(() => { expect(provider.captures).toHaveLength(2) })
    expect(provider.captures[1]).toMatchObject({ role: 'turn', turnOutcome: 'failed' })
  })

  it('captures nothing for a session without a cwd', async () => {
    const { ctx, provider } = await setup()
    const session = ctx.sessions.create(SessionId('no-cwd'), {})
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    await settle()

    expect(provider.captures).toEqual([])
  })

  it('captures a seeded session turn without a parent checkpoint', async () => {
    const { ctx, provider } = await setup()
    const session = ctx.sessions.create(SessionId('seeded-turn'), {
      seed: [{ type: 'session/end-seed', seq: SessionSeq(0), time: 1, data: {} }],
      meta: { cwd: process.cwd() },
    })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => { expect(provider.captures).toHaveLength(1) })
    expect(provider.captures[0]).toMatchObject({ role: 'turn', turnOutcome: 'completed' })
    expect(provider.captures[0]).not.toHaveProperty('parentCheckpointId')
  })

  it('skips a queued turn capture when the provider is disabled before it runs', async () => {
    const { ctx, provider } = await setup()
    const initial = Promise.withResolvers<undefined>()
    provider.captureGate = initial.promise
    const session = ctx.sessions.create(SessionId('toggle'), { meta: { cwd: process.cwd() } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)

    provider.enabled = false
    initial.resolve(undefined)
    await settle()

    expect(provider.captures.map(request => request.role)).toEqual(['initial'])
  })

  it('logs a failed capture and keeps the turn in the session log', async () => {
    const { ctx, provider, logs } = await setup()
    const session = ctx.sessions.create(SessionId('capture-fails'), { meta: { cwd: process.cwd() } })
    await vi.waitFor(() => { expect(provider.captures).toHaveLength(1) })
    provider.captureError = new Error('storage offline')

    session.append('turn/start', { turn: 1 })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(warnings(logs)).toContain(
        'workspace checkpoint capture failed for session "capture-fails": Error: storage offline',
      )
    })
    expect(session.snapshotEvents().some(event => event.type === 'turn/end' && event.seq === end.seq)).toBe(true)
  })

  it('logs a failed parent lookup and still runs the next queued capture', async () => {
    const { ctx, provider, logs } = await setup()
    const session = ctx.sessions.create(SessionId('list-fails'), { meta: { cwd: process.cwd() } })
    await vi.waitFor(() => { expect(provider.captures).toHaveLength(1) })
    provider.listError = new Error('index unreadable')

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => {
      expect(warnings(logs)).toContain(
        'workspace checkpoint capture scheduling failed for session "list-fails": Error: index unreadable',
      )
    })

    provider.listError = undefined
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(provider.captures).toHaveLength(2) })
    expect(provider.captures[1]).toMatchObject({ role: 'turn', parentCheckpointId: 'cp_1' })
  })

  it('logs a failed session flush instead of capturing the turn', async () => {
    const { ctx, provider, logs } = await setup()
    const session = ctx.sessions.create(SessionId('flush-fails'), { meta: { cwd: process.cwd() } })
    await vi.waitFor(() => { expect(provider.captures).toHaveLength(1) })
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValue(new Error('disk full'))

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(warnings(logs)).toContain(
        'workspace checkpoint turn boundary failed for session "flush-fails": Error: disk full',
      )
    })
    expect(provider.captures).toHaveLength(1)
  })
})

describe('workspace-checkpoint-capture recovery admission', () => {
  const source = (chunks: readonly StreamChunk[]) => async function* (): AsyncIterable<StreamChunk> {
    yield* chunks
  }
  const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

  async function stream(ctx: Context, sessionId: SessionId | undefined): Promise<StreamChunk[]> {
    const options = { provider: 'mock', model: 'mock', messages: [], ...sessionId === undefined ? {} : { sessionId } }
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.waterfall(ctx as never, 'llm/stream', options, source([finish]))) chunks.push(chunk)
    return chunks
  }

  it('streams the model response when the workspace has no recovery flag', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('stream-clear'), { meta: { cwd: process.cwd() } })

    await expect(stream(ctx, session.id)).resolves.toEqual([finish])
  })

  it('streams without a check for requests with no session, an unknown session, or no cwd', async () => {
    const { ctx, provider } = await setup()
    provider.recovery.set(process.cwd(), 'rollback failed')
    const bare = ctx.sessions.create(SessionId('stream-bare'), {})

    await expect(stream(ctx, undefined)).resolves.toEqual([finish])
    await expect(stream(ctx, SessionId('stream-unknown'))).resolves.toEqual([finish])
    await expect(stream(ctx, bare.id)).resolves.toEqual([finish])
  })

  it('streams without a check while the provider is disabled', async () => {
    const { ctx, provider } = await setup()
    const session = ctx.sessions.create(SessionId('stream-disabled'), { meta: { cwd: process.cwd() } })
    provider.recovery.set(process.cwd(), 'rollback failed')
    provider.enabled = false

    await expect(stream(ctx, session.id)).resolves.toEqual([finish])
  })

  it('dispatches a top-level tool when the workspace has no recovery flag', async () => {
    const { ctx } = await setup()
    const session = ctx.sessions.create(SessionId('tool-clear'), { meta: { cwd: process.cwd() } })
    ctx.tools.register({
      name: 'write-clear',
      description: 'write',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'written',
    })

    const result = await ctx.tools.execute({
      callId: ToolCallId('tool-clear-call'),
      name: 'write-clear',
      arguments: {},
      agent: { session } as Agent,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: false, value: 'written' })
  })

  it('dispatches a tool whose session has no cwd even while a workspace needs recovery', async () => {
    const { ctx, provider } = await setup()
    provider.recovery.set(process.cwd(), 'rollback failed')
    const session = ctx.sessions.create(SessionId('tool-bare'), {})
    ctx.tools.register({
      name: 'write-bare',
      description: 'write',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'written',
    })

    const result = await ctx.tools.execute({
      callId: ToolCallId('tool-bare-call'),
      name: 'write-bare',
      arguments: {},
      agent: { session } as Agent,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ isError: false, value: 'written' })
  })
})
