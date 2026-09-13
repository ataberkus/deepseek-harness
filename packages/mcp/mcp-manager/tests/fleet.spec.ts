/**
 * Fleet lifecycle: one managed child per enabled `mcp` settings entry, proven
 * against a real Streamable HTTP fixture over the MCP wire.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { MCP_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { startHttpMcpFixture } from '../../mcp-client/tests/http-fixture.ts'

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

/** Tool names currently registered on the harness tool runtime. */
function toolNames(ctx: Context): string[] {
  const tools = (ctx as unknown as { tools: { list(): Array<{ name: string }> } }).tools
  return tools.list().map(tool => tool.name)
}

describe('mcp-manager fleet', () => {
  it('mounts one child per enabled entry and retires it on disable', async () => {
    const fixture = await startHttpMcpFixture()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const settingsFiber = ctx.plugin(MemorySettings)
      await settingsFiber.await()
      const managerFiber = ctx.plugin(McpManager, {})
      await managerFiber.await()

      await ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
        servers: { web: { transport: 'streamable-http', url: fixture.url } },
      })
      await vi.waitFor(() => {
        expect(toolNames(ctx)).toContain('mcp__web__ping')
      })

      await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
        { op: 'set', path: ['servers', 'web', 'enabled'], value: false },
      ])
      await vi.waitFor(() => {
        expect(toolNames(ctx)).not.toContain('mcp__web__ping')
      })

      await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
        { op: 'set', path: ['servers', 'web', 'enabled'], value: true },
      ])
      await vi.waitFor(() => {
        expect(toolNames(ctx)).toContain('mcp__web__ping')
      })

      await ctx.settings.mutate(MCP_SETTINGS_NAMESPACE, [
        { op: 'unset', path: ['servers', 'web'] },
      ])
      await vi.waitFor(() => {
        expect(toolNames(ctx)).not.toContain('mcp__web__ping')
      })
    } finally {
      await ctx.fiber.dispose()
      await fixture.close()
    }
  }, 30_000)

  it('mounts the composition entry without any settings write', async () => {
    const fixture = await startHttpMcpFixture()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const settingsFiber = ctx.plugin(MemorySettings)
      await settingsFiber.await()
      const managerFiber = ctx.plugin(McpManager, {
        servers: { base: { transport: 'streamable-http', url: fixture.url } },
      })
      await managerFiber.await()
      await vi.waitFor(() => {
        expect(toolNames(ctx)).toContain('mcp__base__ping')
      })
    } finally {
      await ctx.fiber.dispose()
      await fixture.close()
    }
  }, 30_000)

  it('keeps serving its sibling when one entry is invalid', async () => {
    const fixture = await startHttpMcpFixture()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const settingsFiber = ctx.plugin(MemorySettings)
      await settingsFiber.await()
      const managerFiber = ctx.plugin(McpManager, {})
      await managerFiber.await()

      await ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
        servers: { good: { transport: 'streamable-http', url: fixture.url } },
      })
      await vi.waitFor(() => {
        expect(toolNames(ctx)).toContain('mcp__good__ping')
      })

      await expect(ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
        servers: { broken: { transport: 'stdio' } },
      })).rejects.toThrow()
      expect(toolNames(ctx)).toContain('mcp__good__ping')
    } finally {
      await ctx.fiber.dispose()
      await fixture.close()
    }
  }, 30_000)
})
