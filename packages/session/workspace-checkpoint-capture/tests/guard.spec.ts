import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { WorkspaceCheckpoint } from '@deepseek-ai/dsh-workspace-checkpoint'
import * as workspaceCheckpointCapture from '../src/index.ts'

const contexts: Context[] = []

async function setup(enabled = true): Promise<{ ctx: Context; recovery: Map<string, string> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const recovery = new Map<string, string>()
  const checkpoint = {
    enabled,
    recoveryRequired: async (workspaceKey: string) => recovery.get(workspaceKey),
  } as unknown as WorkspaceCheckpoint
  ctx.provide('workspaceCheckpoint', checkpoint)
  await ctx.plugin((await import('@deepseek-ai/dsh-session')).default)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(workspaceCheckpointCapture)
  return { ctx, recovery }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('workspace-checkpoint-capture recovery guard', () => {
  it('bypasses recovery admission when the provider is disabled', async () => {
    const { ctx, recovery } = await setup(false)
    const session = ctx.sessions.create(SessionId('guard-disabled'), { meta: { cwd: process.cwd() } })
    recovery.set(process.cwd(), 'rollback failed')
    let dispatched = false
    ctx.tools.register({
      name: 'write-disabled',
      description: 'write',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => {
        dispatched = true
        return null
      },
    })

    await ctx.tools.execute({
      callId: ToolCallId('guard-disabled-call'),
      name: 'write-disabled',
      arguments: {},
      agent: { session } as Agent,
      signal: new AbortController().signal,
    })

    expect(dispatched).toBe(true)
  })

  it('blocks model streaming while recovery is required', async () => {
    const { ctx, recovery } = await setup()
    const session = ctx.sessions.create(SessionId('guard-stream'), { meta: { cwd: process.cwd() } })
    recovery.set(process.cwd(), 'rollback failed')

    await expect(drain(ctx.llm.stream({
      provider: 'missing',
      model: 'missing',
      messages: [],
      sessionId: session.id,
    }))).rejects.toMatchObject({
      code: 'CHECKPOINT_RECOVERY_REQUIRED',
    })
  })

  it('returns a structured tool failure without dispatching the tool body', async () => {
    const { ctx, recovery } = await setup()
    const session = ctx.sessions.create(SessionId('guard-tool'), { meta: { cwd: process.cwd() } })
    recovery.set(process.cwd(), 'rollback failed')
    let dispatched = false
    ctx.tools.register({
      name: 'write',
      description: 'write',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => {
        dispatched = true
        return null
      },
    })

    const result = await ctx.tools.execute({
      callId: ToolCallId('guard-tool-call'),
      name: 'write',
      arguments: {},
      agent: { session } as Agent,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      isError: true,
      error: { message: 'workspace requires recovery: rollback failed' },
    })
    expect(dispatched).toBe(false)
  })

  it('does not add another recovery check for nested tool dispatches', async () => {
    const { ctx, recovery } = await setup()
    const session = ctx.sessions.create(SessionId('guard-nested'), { meta: { cwd: process.cwd() } })
    recovery.set(process.cwd(), 'rollback failed')
    let checks = 0
    const checkpoint = ctx.workspaceCheckpoint as unknown as {
      recoveryRequired: (workspaceKey: string) => Promise<string | undefined>
    }
    const original = checkpoint.recoveryRequired
    checkpoint.recoveryRequired = async (key) => {
      checks += 1
      return original(key)
    }
    ctx.tools.register({
      name: 'nested',
      description: 'nested',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    })

    await ctx.tools.execute({
      callId: ToolCallId('guard-nested-call'),
      name: 'nested',
      arguments: {},
      agent: { session } as Agent,
      parent: Symbol('outer') as never,
      signal: new AbortController().signal,
    })

    expect(checks).toBe(0)
  })
})
