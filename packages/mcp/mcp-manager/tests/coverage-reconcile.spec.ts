/**
 * Fleet reconciliation edge paths: refused entries, remounts, failure
 * containment, and disposal racing a reconcile. The MCP client is replaced by a
 * scripted plugin that registers one `ping` tool per server, so no transport,
 * port, or child process is involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { MCP_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

/** Per-server script consulted by the scripted client when it mounts. */
interface Script {
  /** Rejects the mount with this error. */
  startupError?: Error
  /** Holds the mount open until resolved. */
  startGate?: Promise<void>
  /** Holds the child's teardown open until resolved. */
  disposeGate?: Promise<void>
  /** Fails the child's teardown with this error after the tool is unregistered. */
  disposeError?: Error
}

const hub = vi.hoisted(() => ({
  scripts: new Map<string, unknown>(),
  mounts: [] as string[],
  disposals: [] as string[],
}))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  return new Proxy({
    ...actual,
    async apply(ctx: Context, config: { serverName: string }): Promise<void> {
      const script = (hub.scripts.get(config.serverName) ?? {}) as Script
      hub.mounts.push(config.serverName)
      ctx.effect(() => async () => {
        hub.disposals.push(config.serverName)
        await script.disposeGate
        if (script.disposeError !== undefined) throw script.disposeError
      })
      ctx.tools.register(defineTool({
        name: `mcp__${config.serverName}__ping`,
        description: 'scripted',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'pong' },
      }))
      await script.startGate
      if (script.startupError !== undefined) throw script.startupError
    },
  }, {
    // Cordis probes optional plugin metadata keys (`provide`, `intercept`, ...) that the
    // real module simply lacks; vitest's strict mock would throw on them.
    has: () => true,
  })
})

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  hub.scripts.clear()
  hub.mounts.length = 0
  hub.disposals.length = 0
})

function script(serverName: string, value: Script): void {
  hub.scripts.set(serverName, value)
}

/** Error-level messages the fleet manager logged, in order. */
function errorLogs(logs: Message[]): string[] {
  return logs
    .filter(message => message.type === 'error' && typeof message.args[0] === 'string')
    .map(message => String(message.args[0]))
    .filter(text => text.startsWith('mcp-manager:'))
}

async function boot(
  config: Record<string, unknown>,
  failLogging: (message: Message) => boolean = () => false,
): Promise<{
  ctx: Context
  logs: Message[]
  settings: ReturnType<Context['plugin']>
  manager: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const logs: Message[] = []
  ctx.logger.exporter({
    export: (message) => {
      logs.push(message)
      if (failLogging(message)) throw new Error('exporter failure')
    },
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const settings = ctx.plugin(MemorySettings)
  await settings.await()
  const manager = ctx.plugin(McpManager, config)
  await manager.await()
  return { ctx, logs, settings, manager }
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(tool => tool.name).sort()
}

/** Logging failure that fires once, for the scripted child teardown error. */
function teardownFailure(): (message: Message) => boolean {
  let fired = false
  return (message) => {
    const first: unknown = message.args[0]
    if (fired || !(first instanceof Error) || first.message !== 'teardown boom') return false
    fired = true
    return true
  }
}

const stdio = (command = 'scripted') => ({ transport: 'stdio', command }) as const

describe('mcp-manager reconcile edge paths', () => {
  it('refuses an invalid composition entry and keeps mounting its siblings', async () => {
    const { ctx, logs } = await boot({ servers: { 'bad name!': stdio(), ok: stdio() } })
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__ok__ping']) })
    expect(errorLogs(logs)).toEqual(['mcp-manager: refusing invalid server "bad name!"'])
  })

  it('remounts only the entry whose configuration changed', async () => {
    const { ctx } = await boot({ servers: { a: stdio(), b: stdio() } })
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__a__ping', 'mcp__b__ping']) })

    await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['servers', 'a', 'toolCallTimeoutMs'], value: 5000 },
    ])
    await vi.waitFor(() => { expect(hub.mounts).toEqual(['a', 'b', 'a']) })
    expect(hub.disposals).toEqual(['a'])
    expect(toolNames(ctx)).toEqual(['mcp__a__ping', 'mcp__b__ping'])
  })

  it('logs a failed teardown on disable and still retires the tools', async () => {
    script('a', { disposeError: new Error('teardown boom') })
    const { ctx, logs } = await boot({ servers: { a: stdio(), b: stdio() } }, teardownFailure())
    await vi.waitFor(() => { expect(toolNames(ctx)).toHaveLength(2) })

    await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['servers', 'a', 'enabled'], value: false },
    ])
    await vi.waitFor(() => { expect(errorLogs(logs)).toEqual(['mcp-manager: disposing server "a" failed']) })
    expect(toolNames(ctx)).toEqual(['mcp__b__ping'])
  })

  it('logs a failed teardown before a remount and mounts the new generation anyway', async () => {
    script('a', { disposeError: new Error('teardown boom') })
    const { ctx, logs } = await boot({ servers: { a: stdio() } }, teardownFailure())
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__a__ping']) })

    await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['servers', 'a', 'toolCallTimeoutMs'], value: 5000 },
    ])
    await vi.waitFor(() => { expect(hub.mounts).toEqual(['a', 'a']) })
    expect(errorLogs(logs)).toEqual(['mcp-manager: disposing server "a" before remount failed'])
    expect(toolNames(ctx)).toEqual(['mcp__a__ping'])
  })

  it('contains a server whose mount fails and keeps its siblings serving', async () => {
    script('down', { startupError: new Error('refused') })
    const { ctx, logs } = await boot({ servers: { down: stdio(), up: stdio() } })
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__up__ping']) })
    expect(new Set(errorLogs(logs))).toEqual(new Set(['mcp-manager: server "down" failed to mount']))
  })

  it('falls back to the composition fleet when the settings provider detaches', async () => {
    const { ctx, settings } = await boot({ servers: { base: stdio() } })
    await ctx.settings.update(MCP_SETTINGS_NAMESPACE, { servers: { extra: stdio() } })
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__base__ping', 'mcp__extra__ping']) })

    await settings.dispose()
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__base__ping']) })
  })

  it('mounts nothing when disposed before the first reconcile runs', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const manager = ctx.plugin(McpManager, { servers: { a: stdio() } })
    await manager.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(hub.mounts).toEqual([])
  })

  it('stops reconciling when disposed while a removed server is still tearing down', async () => {
    const gate = Promise.withResolvers<undefined>()
    script('a', { disposeGate: gate.promise })
    const { ctx, manager } = await boot({ servers: { a: stdio() } })
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__a__ping']) })

    await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['servers', 'a', 'enabled'], value: false },
      { op: 'set', path: ['servers', 'c'], value: stdio() },
    ])
    await vi.waitFor(() => { expect(hub.disposals).toEqual(['a']) })
    const disposing = manager.dispose()
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.resolve(undefined)
    await disposing
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(hub.mounts).toEqual(['a'])
  })

  it('does not remount when disposed while the previous generation is still tearing down', async () => {
    const gate = Promise.withResolvers<undefined>()
    script('a', { disposeGate: gate.promise })
    const { ctx, manager } = await boot({ servers: { a: stdio() } })
    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__a__ping']) })

    await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
      { op: 'set', path: ['servers', 'a', 'toolCallTimeoutMs'], value: 5000 },
    ])
    await vi.waitFor(() => { expect(hub.disposals).toEqual(['a']) })
    const disposing = manager.dispose()
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.resolve(undefined)
    await disposing
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(hub.mounts).toEqual(['a'])
  })

  it('discards servers that finish mounting after the manager was disposed', async () => {
    const gate = Promise.withResolvers<undefined>()
    script('slow', { startGate: gate.promise })
    const { ctx, manager } = await boot({ servers: { slow: stdio(), next: stdio() } })
    await vi.waitFor(() => { expect(hub.mounts).toEqual(['slow']) })

    const disposing = manager.dispose()
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.resolve(undefined)
    await disposing
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(toolNames(ctx)).toEqual([])
    expect(hub.mounts).toEqual(['slow'])
  })

  it('logs a failed teardown of a server that finished mounting after the manager was disposed', async () => {
    const gate = Promise.withResolvers<undefined>()
    script('slow', { startGate: gate.promise })
    const { ctx, logs, manager } = await boot({ servers: { slow: stdio() } })
    // The manager's own teardown has usually started the child's disposal by
    // then, so give the manager's handle a disposer that reports a failure.
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.runtime?.name !== 'mcp-client') return
      Object.assign(fiber, { dispose: () => Promise.reject(new Error('late teardown boom')) })
    })
    await vi.waitFor(() => { expect(hub.mounts).toEqual(['slow']) })

    const disposing = manager.dispose()
    await new Promise(resolve => setTimeout(resolve, 10))
    gate.resolve(undefined)
    await disposing
    await vi.waitFor(() => {
      expect(errorLogs(logs)).toContain('mcp-manager: disposing late-mounted server "slow" failed')
    })
  })

  it('keeps reconciling after a generation fails and its failure cannot even be logged', async () => {
    const gate = Promise.withResolvers<undefined>()
    script('slow', { startGate: gate.promise })
    script('down', { startupError: new Error('refused') })
    let failures = 0
    const { ctx, logs } = await boot(
      { servers: { slow: stdio(), down: stdio() } },
      (message) => {
        const first: unknown = message.args[0]
        const text = typeof first === 'string' ? first : ''
        if (failures === 0 && text.startsWith('mcp-manager: server "down" failed to mount')) {
          failures += 1
          return true
        }
        if (failures === 1 && first instanceof Error && first.message === 'exporter failure') {
          failures += 1
          return true
        }
        return false
      },
    )
    await vi.waitFor(() => {
      expect(hub.mounts).toEqual(['slow'])
      expect(ctx.settings.get(MCP_SETTINGS_NAMESPACE)).toBeDefined()
    })
    // Queue a later generation while the first is still running, then let the first fail.
    await ctx.settings.update(MCP_SETTINGS_NAMESPACE, { servers: { later: stdio() } })
    gate.resolve(undefined)

    await vi.waitFor(() => { expect(toolNames(ctx)).toEqual(['mcp__later__ping', 'mcp__slow__ping']) })
    expect(failures).toBe(2)
    expect(errorLogs(logs)).toContain('mcp-manager: fleet reconciliation failed')
  })
})
