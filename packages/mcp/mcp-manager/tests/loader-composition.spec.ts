/**
 * Real-composition guard: the manager boots from a test-only cordis.yml
 * through the actual Loader + Include path with zero servers and mounts no
 * tools. Its fleet field is declared volatile, which is what lets the Plugins
 * settings card commit an edit into the running manager without a remount.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('mcp-manager real Loader composition', () => {
  it('boots cordis.yml dormant with a live-editable fleet and no managed tools', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
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

    const names = context.tools.schemas().map(tool => tool.name)
    expect(names.filter(toolName => toolName.startsWith('mcp__'))).toEqual([])
    // The settings card edits this field live; the Loader only commits values
    // into the running reference when the schema declares them volatile.
    const schema = McpManager.Config as unknown as {
      dict: Record<string, { meta?: { volatile?: boolean } }>
    }
    expect(schema.dict.servers?.meta?.volatile).toBe(true)
  })
})
