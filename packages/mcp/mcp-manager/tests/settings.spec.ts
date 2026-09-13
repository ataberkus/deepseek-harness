/** The `mcp` settings section layered over the fleet manager's composition entry. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { MCP_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

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

async function boot(config: Record<string, unknown> = {}): Promise<{
  ctx: Context
  settingsFiber: Fiber
  managerFiber: Fiber
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const managerFiber = ctx.plugin(McpManager, config)
  await managerFiber.await()
  return { ctx, settingsFiber, managerFiber }
}

describe('mcp-manager settings section', () => {
  it('registers the mcp namespace dormant with zero servers', async () => {
    const bench = await boot()
    const namespaces = bench.ctx.settings.describe().map(row => String(row.ns))
    expect(namespaces).toContain('mcp')
    expect(bench.ctx.settings.get(MCP_SETTINGS_NAMESPACE)).toEqual({ servers: {} })
    await bench.ctx.fiber.dispose()
  })

  it('refuses a server name outside the tool namespace budget', async () => {
    const bench = await boot()
    await expect(bench.ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
      servers: { 'bad name!': { transport: 'stdio', command: 'echo' } },
    })).rejects.toThrow(/must match/)
    await bench.ctx.fiber.dispose()
  })

  it('refuses a stdio entry without a command', async () => {
    const bench = await boot()
    await expect(bench.ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
      servers: { broken: { transport: 'stdio' } },
    })).rejects.toThrow()
    await bench.ctx.fiber.dispose()
  })

  it('stores a disabled entry without mounting it', async () => {
    const bench = await boot()
    await bench.ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
      servers: {
        dormant: {
          transport: 'streamable-http',
          url: 'http://127.0.0.1:1/mcp',
          enabled: false,
        },
      },
    })
    expect(bench.ctx.settings.get(MCP_SETTINGS_NAMESPACE)).toMatchObject({
      servers: { dormant: { enabled: false } },
    })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await boot({
      servers: {
        base: { transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
      },
    })
    await bench.ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
      servers: {
        user: { transport: 'streamable-http', url: 'http://127.0.0.1:2/mcp' },
      },
    })
    expect(Object.keys((bench.ctx.settings.get(MCP_SETTINGS_NAMESPACE) as { servers: Record<string, unknown> }).servers))
      .toContain('user')

    await bench.settingsFiber.dispose()

    expect(bench.ctx.settings.get(MCP_SETTINGS_NAMESPACE)).toBeUndefined()
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(McpManager, {
      servers: { base: { transport: 'stdio', command: 'echo' } },
    })
    await ctx.fiber.dispose()
  })

  it('releases the namespace when the manager unloads', async () => {
    const bench = await boot()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('mcp')

    await bench.managerFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('mcp')
    await bench.ctx.fiber.dispose()
  })
})
