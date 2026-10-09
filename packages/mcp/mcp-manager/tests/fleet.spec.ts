/**
 * Fleet lifecycle: one managed child per enabled `servers` entry, proven
 * against a real Streamable HTTP fixture over the MCP wire. The fleet is one
 * volatile config field, so an edit commits a new snapshot into the running
 * reference and the manager re-reconciles without remounting.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import { startHttpMcpFixture } from '../../mcp-client/tests/http-fixture.ts'

/** Tool names currently registered on the harness tool runtime. */
function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(tool => tool.name)
}

/** One manager mounted behind a real Loader entry, so edits take the volatile commit path. */
interface Bench {
  readonly ctx: Context
  readonly fiber: Fiber
  update(config: unknown): Promise<void>
  dispose(): Promise<void>
}

/**
 * @param initial - the composition entry config the manager boots with.
 * @returns the booted manager and its config-update handle.
 */
async function boot(initial: unknown = { servers: {} }): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Loader)
  ctx.loader.builtins['mcp-manager'] = McpManager
  const id = await ctx.loader.create({ name: 'cordis:mcp-manager', config: initial })
  const fiber = ctx.loader.resolve(id).fiber!
  await fiber.await()
  return {
    ctx,
    fiber,
    async update(config: unknown): Promise<void> {
      await fiber.entry!.update({ config })
      await fiber.await()
    },
    async dispose(): Promise<void> {
      await ctx.fiber.dispose()
    },
  }
}

describe('mcp-manager fleet', () => {
  it('mounts one child per enabled entry and retires it on disable', async () => {
    const fixture = await startHttpMcpFixture()
    const bench = await boot()
    try {
      const reference: unknown = bench.fiber.config
      expect(toolNames(bench.ctx)).not.toContain('mcp__web__ping')

      await bench.update({ servers: { web: { transport: 'streamable-http', url: fixture.url } } })
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).toContain('mcp__web__ping') })
      // The commit mutated the running reference; the plugin instance stayed.
      expect(bench.fiber.config).toBe(reference)

      await bench.update({
        servers: { web: { transport: 'streamable-http', url: fixture.url, enabled: false } },
      })
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).not.toContain('mcp__web__ping') })

      await bench.update({
        servers: { web: { transport: 'streamable-http', url: fixture.url, enabled: true } },
      })
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).toContain('mcp__web__ping') })

      await bench.update({ servers: {} })
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).not.toContain('mcp__web__ping') })
    } finally {
      await bench.dispose()
      await fixture.close()
    }
  }, 30_000)

  it('mounts the composition entry without any later edit', async () => {
    const fixture = await startHttpMcpFixture()
    const bench = await boot({ servers: { base: { transport: 'streamable-http', url: fixture.url } } })
    try {
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).toContain('mcp__base__ping') })
    } finally {
      await bench.dispose()
      await fixture.close()
    }
  }, 30_000)

  it('keeps serving its sibling when an edit names an illegal server', async () => {
    const fixture = await startHttpMcpFixture()
    const bench = await boot()
    try {
      await bench.update({ servers: { good: { transport: 'streamable-http', url: fixture.url } } })
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).toContain('mcp__good__ping') })

      // A dict key escapes the schema; the manager skips that entry and keeps
      // serving the entries the tool namespace budget accepts.
      await bench.update({
        servers: {
          good: { transport: 'streamable-http', url: fixture.url },
          'bad name!': { transport: 'streamable-http', url: fixture.url },
        },
      })
      expect(toolNames(bench.ctx)).toContain('mcp__good__ping')
    } finally {
      await bench.dispose()
      await fixture.close()
    }
  }, 30_000)

  it('keeps the committed fleet when an edit is schema-invalid', async () => {
    const fixture = await startHttpMcpFixture()
    const bench = await boot({ servers: { good: { transport: 'streamable-http', url: fixture.url } } })
    try {
      await vi.waitFor(() => { expect(toolNames(bench.ctx)).toContain('mcp__good__ping') })

      // A stdio entry without `command` fails the schema, so the candidate is
      // logged and the committed references keep serving.
      await bench.update({ servers: { broken: { transport: 'stdio' } } })
      expect(toolNames(bench.ctx)).toContain('mcp__good__ping')
    } finally {
      await bench.dispose()
      await fixture.close()
    }
  }, 30_000)
})
