/**
 * Real-composition guard: the manager boots from a test-only cordis.yml
 * through the actual Loader + Include path with zero servers, registers the
 * `mcp` namespace, and mounts no tools.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

/** The smallest real provider: one empty document, always writable. */
class MemorySettings extends SettingsProvider {
  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    void ns
    void section
    return Promise.resolve()
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('mcp-manager real Loader composition', () => {
  it('boots cordis.yml dormant with the mcp namespace and no managed tools', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'test-memory-settings'",
      "- name: '@deepseek-ai/dsh-mcp-manager'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['test-memory-settings', MemorySettings],
      ['@deepseek-ai/dsh-mcp-manager', McpManager],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    await vi.waitFor(() => {
      expect(context!.get('settings')?.describe().map(entry => String(entry.ns))).toContain('mcp')
    })
    const names = (context!.tools as unknown as { list(): Array<{ name: string }> }).list()
      .map(tool => tool.name)
    expect(names.filter(toolName => toolName.startsWith('mcp__'))).toEqual([])
  })
})
