/** Staged fleet card over a fake `mcp` scope: no wire, no mirror. */

import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  McpCardController,
  toServerView,
  toStoredEntry,
  validateServerDraft,
  type McpFleetSettings,
} from '../src/client/mcp-card-controller.ts'

/** In-memory scope with revision-fenced wholesale writes. */
function fakeScope(initial: McpFleetSettings = { servers: {} }): SettingsScope<McpFleetSettings> & {
  revision: number
  listeners: Set<() => void>
} {
  const listeners = new Set<() => void>()
  let value: McpFleetSettings = structuredClone(initial)
  let revision = 0
  const snapshot = (): SettingsScopeSnapshot<McpFleetSettings> => ({
    status: 'ready',
    value: structuredClone(value),
    base: undefined,
    user: structuredClone(value),
    revision,
    writable: true,
    mode: 'host',
  })
  return {
    revision,
    listeners,
    getSnapshot: snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async mutate(ops, expectedRevision): Promise<void> {
      if (expectedRevision !== undefined && expectedRevision !== revision) return
      for (const op of ops) {
        if (op.op === 'set' && op.path.length === 1 && op.path[0] === 'servers') {
          value = { servers: structuredClone(op.value) as NonNullable<McpFleetSettings['servers']> }
        }
      }
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    async set(): Promise<void> {},
    async unset(): Promise<void> {},
  }
}

describe('mcp card fleet editor', () => {
  it('summarizes stdio and http rows', () => {
    expect(toServerView('web', { transport: 'streamable-http', url: 'http://localhost:3000/mcp' }))
      .toMatchObject({ name: 'web', transport: 'streamable-http', enabled: true })
    expect(toServerView('gh', { transport: 'stdio', command: 'npx', args: ['-y', 'srv'], enabled: false }))
      .toMatchObject({ name: 'gh', transport: 'stdio', enabled: false, detail: 'npx -y srv' })
    expect(toServerView('odd', { transport: 'gopher' })).toMatchObject({ transport: 'unknown' })
  })

  it('validates staged entries', () => {
    expect(validateServerDraft({
      name: '', transport: 'stdio', enabled: true, command: '', argsText: '', url: '',
    })).toBe('nameRequired')
    expect(validateServerDraft({
      name: 'bad name!', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '',
    })).toBe('nameInvalid')
    expect(validateServerDraft({
      name: 'gh', transport: 'stdio', enabled: true, command: '', argsText: '', url: '',
    })).toBe('commandRequired')
    expect(validateServerDraft({
      name: 'web', transport: 'streamable-http', enabled: true, command: '', argsText: '', url: '',
    })).toBe('urlRequired')
    expect(validateServerDraft({
      name: 'web', transport: 'streamable-http', enabled: true, command: '', argsText: '', url: 'gopher://x',
    })).toBe('urlInvalid')
    expect(validateServerDraft({
      name: 'gh', transport: 'stdio', enabled: true, command: 'npx', argsText: '-y\nsrv\n', url: '',
    })).toBeUndefined()
  })

  it('stores staged entries with parsed args', () => {
    expect(toStoredEntry({
      name: 'gh', transport: 'stdio', enabled: true, command: 'npx', argsText: '-y\nsrv\n', url: '',
    })).toEqual({ transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'srv'] })
    expect(toStoredEntry({
      name: 'web', transport: 'streamable-http', enabled: true, command: '', argsText: '', url: 'http://localhost:3000/mcp',
    })).toEqual({ transport: 'streamable-http', enabled: true, url: 'http://localhost:3000/mcp' })
  })

  it('stages toggles, removals, and additions behind one save', async () => {
    const scope = fakeScope({
      servers: {
        web: { transport: 'streamable-http', url: 'http://localhost:3000/mcp', enabled: true },
        old: { transport: 'stdio', command: 'echo', enabled: true },
      },
    })
    const controller = new McpCardController(scope)
    const face = controller.inject()
    const seen: string[][] = []
    face.hooks.mcpCard.subscribe(() => {
      seen.push(face.hooks.mcpCard.getSnapshot().servers.map(server => server.name))
    })

    face.toggleEnabled('web')
    face.removeServer('old')
    expect(face.saveServer({
      name: 'gh', transport: 'stdio', enabled: true, command: 'npx', argsText: '-y', url: '',
    })).toBeUndefined()
    expect(face.hooks.mcpCard.getSnapshot().dirty).toBe(true)

    face.save()
    await scope.mutate([], undefined)
    const snapshot = face.hooks.mcpCard.getSnapshot()
    expect(snapshot.servers.map(server => server.name).sort()).toEqual(['gh', 'web'])
    expect(snapshot.servers.find(server => server.name === 'web')?.enabled).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    controller.dispose()
  })

  it('rejects invalid staged entries without dirtying the draft', () => {
    const scope = fakeScope({ servers: {} })
    const controller = new McpCardController(scope)
    const face = controller.inject()
    expect(face.saveServer({
      name: 'bad name!', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '',
    })).toBe('nameInvalid')
    expect(face.hooks.mcpCard.getSnapshot().dirty).toBe(false)
    controller.dispose()
  })

  it('discards a staged draft', () => {
    const scope = fakeScope({ servers: { web: { transport: 'streamable-http', url: 'http://x/mcp' } } })
    const controller = new McpCardController(scope)
    const face = controller.inject()
    face.removeServer('web')
    expect(face.hooks.mcpCard.getSnapshot().dirty).toBe(true)
    face.discard()
    expect(face.hooks.mcpCard.getSnapshot().dirty).toBe(false)
    expect(face.hooks.mcpCard.getSnapshot().servers.map(server => server.name)).toEqual(['web'])
    controller.dispose()
  })
})
