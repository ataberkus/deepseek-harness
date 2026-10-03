/** The staged fleet editor: what it stages, what one save writes, and its refusals. */

import { describe, expect, it, vi } from 'vitest'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import {
  McpServersCardController, type McpFleetSettings, type McpServerEntry,
} from '../src/client/mcp-servers-card-controller.ts'

/** A ready document holding the servers the test names. */
function serve(host: StubConfigForm<McpFleetSettings>, servers: Record<string, McpServerEntry>, revision = 3): void {
  host.publish({ status: 'ready', writable: true, revision, value: { servers }, base: {}, user: {} })
}

/** Make the stub land every write as the Host accepted it. */
function acceptWrites(host: StubConfigForm<McpFleetSettings>, servers: Record<string, McpServerEntry>): void {
  host.mutate.mockImplementation(() => {
    host.publish({ value: { servers }, revision: 4 })
    return Promise.resolve(true)
  })
}

describe('McpServersCardController', () => {
  it('stages an added server and writes the whole fleet in one fenced mutation', async () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, {})
    const accepted: Record<string, McpServerEntry> = {
      fs: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'fs-server'] },
    }
    acceptWrites(host, accepted)
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    expect(face.saveServer({
      name: 'fs', transport: 'stdio', enabled: true, command: 'npx', argsText: '-y\nfs-server', url: '',
    })).toBeUndefined()
    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({
      available: true,
      dirty: true,
      servers: [{ name: 'fs', transport: 'stdio', enabled: true, detail: 'npx -y fs-server' }],
    })

    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([{
        op: 'set',
        path: ['servers'],
        value: { fs: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'fs-server'] } },
      }], 3)
    })
    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({ dirty: false, failed: false, conflicted: false })
  })

  it('merges an update into the stored entry so fields it does not edit survive', () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, { fs: { transport: 'stdio', command: 'npx', env: { TOKEN: 'kept' } } })
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    expect(face.saveServer({
      name: 'fs', previousName: 'fs', transport: 'stdio', enabled: false, command: 'bunx', argsText: '', url: '',
    })).toBeUndefined()
    face.save()

    return vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([{
        op: 'set',
        path: ['servers'],
        value: { fs: { transport: 'stdio', command: 'bunx', env: { TOKEN: 'kept' }, enabled: false, args: [] } },
      }], 3)
    })
  })

  it('renames a staged server by dropping its previous key', () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, { fs: { transport: 'stdio', command: 'npx' } })
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    face.saveServer({ name: 'files', previousName: 'fs', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '' })

    expect(face.hooks.mcpServersCard.getSnapshot().servers.map(server => server.name)).toEqual(['files'])
  })

  it('refuses a draft the Host name budget or the endpoint fields reject, staging nothing', () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, {})
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    expect(face.saveServer({ name: '', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '' })).toBe('nameRequired')
    expect(face.saveServer({ name: 'bad name', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '' })).toBe('nameInvalid')
    expect(face.saveServer({ name: 'web', transport: 'stdio', enabled: true, command: '', argsText: '', url: '' })).toBe('commandRequired')
    expect(face.saveServer({ name: 'web', transport: 'streamable-http', enabled: true, command: '', argsText: '', url: '' })).toBe('urlRequired')
    expect(face.saveServer({ name: 'web', transport: 'streamable-http', enabled: true, command: '', argsText: '', url: 'ftp://host' })).toBe('urlInvalid')
    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({ dirty: false, servers: [] })
  })

  it('stages a toggle and a removal, and drops both on discard', () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, { fs: { transport: 'stdio', command: 'npx' } })
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    face.toggleEnabled('fs')
    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({
      dirty: true,
      servers: [{ name: 'fs', enabled: false }],
    })
    face.discard()
    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({
      dirty: false,
      servers: [{ name: 'fs', enabled: true }],
    })

    face.removeServer('fs')
    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({ dirty: true, servers: [] })
  })

  it('reports a read-only document so the page disables its controls and writes nothing', () => {
    const host = stubConfigForm<McpFleetSettings>()
    host.publish({ status: 'ready', writable: false, revision: 1, value: { servers: {} }, base: {}, user: {} })
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    expect(face.hooks.mcpServersCard.getSnapshot().writable).toBe(false)
    face.saveServer({ name: 'fs', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '' })
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('keeps the draft and flags a conflict when another writer moved the revision', async () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, { fs: { transport: 'stdio', command: 'npx' } })
    const controller = new McpServersCardController(host.scope)
    const face = controller.inject()

    face.toggleEnabled('fs')
    host.publish({ value: { servers: { fs: { transport: 'stdio', command: 'npx' }, web: { transport: 'stdio', command: 'npx' } } }, revision: 9 })

    expect(face.hooks.mcpServersCard.getSnapshot()).toMatchObject({ conflicted: true, dirty: true })
    face.save()
    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('stops observing the entry once disposed', () => {
    const host = stubConfigForm<McpFleetSettings>()
    serve(host, {})
    const controller = new McpServersCardController(host.scope)

    controller.dispose()

    expect(host.listenerCount()).toBe(0)
  })
})
