// @vitest-environment jsdom

/**
 * The fleet card as a user drives it: a real controller over a scripted `mcp`
 * settings scope, asserting what the card shows and what a save writes.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { McpCard, type McpCardProps } from '../src/client/McpCard.tsx'
import { McpCardController, type McpFleetSettings } from '../src/client/mcp-card-controller.ts'
import { en } from '../src/client/locales.ts'

type Servers = NonNullable<McpFleetSettings['servers']>

const t = (key: keyof typeof en) => en[key]

const WEB = { transport: 'streamable-http', url: 'http://localhost:3000/mcp', enabled: true }
const ECHO = { transport: 'stdio', command: 'echo', args: ['hi'], enabled: true }

let controllers: McpCardController[] = []

afterEach(() => {
  cleanup()
  for (const controller of controllers) controller.dispose()
  controllers = []
})

interface Host extends StubSettingsScope<McpFleetSettings> {
  /** Pending settlements of `mutate`, resolved by the test; empty when writes settle at once. */
  gate: { release: (() => void) | undefined }
}

/**
 * Host whose `mutate` applies a wholesale `servers` write and bumps the revision,
 * unless `accepts` is false, in which case the Host silently keeps its document.
 */
function hostWith(servers: Servers, options: { writable?: boolean; accepts?: boolean; hold?: boolean } = {}): Host {
  const stub = stubSettingsScope<McpFleetSettings>()
  const gate: Host['gate'] = { release: undefined }
  let revision = 1
  stub.publish({
    status: 'ready',
    writable: options.writable ?? true,
    value: { servers },
    base: { servers: {} },
    user: { servers },
    revision,
  })
  const mutate = vi.fn<SettingsScope<McpFleetSettings>['mutate']>(async (ops) => {
    if (options.hold === true) await new Promise<void>((resolve) => { gate.release = resolve })
    if (options.accepts === false) return
    revision += 1
    const op = ops[0]!
    const next = { servers: structuredClone(op.op === 'set' ? op.value : {}) as Servers }
    stub.publish({ value: next, user: next, revision })
  })
  return Object.assign(stub, { gate, mutate, scope: { ...stub.scope, mutate } })
}

function renderCard(host: Host) {
  const controller = new McpCardController(host.scope)
  controllers.push(controller)
  const face = controller.inject()
  const props = { ...face, t, useMcpCard: bindSnapshotSelector(face.hooks.mcpCard) } as unknown as McpCardProps
  render(<ul><McpCard {...props} /></ul>)
  if (screen.queryByText(en.mcpTitle) !== null) fireEvent.click(screen.getByText(en.mcpTitle))
  return { controller, face }
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function stage(): void {
  fireEvent.click(screen.getByRole('button', { name: en.mcpAdd }))
}

function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('McpCard', () => {
  it('says so when no server is configured and offers the stdio fields first', () => {
    renderCard(hostWith({}))

    expect(screen.getByText(en.mcpEmpty)).toBeTruthy()
    expect(screen.getByLabelText(en.mcpCommand)).toBeTruthy()
    expect(screen.getByLabelText(en.mcpArgs)).toBeTruthy()
    expect(screen.queryByLabelText(en.mcpUrl)).toBeNull()
    expect(screen.getByText(en.mcpAdvancedHint)).toBeTruthy()
  })

  it('stages a stdio server and writes it as one fenced mutation on save', async () => {
    const host = hostWith({})
    renderCard(host)

    type(en.mcpName, ' gh ')
    type(en.mcpCommand, 'npx')
    type(en.mcpArgs, '-y\n@modelcontextprotocol/server-github\n')
    stage()

    const staged = row('gh')
    expect(within(staged).getByText(en.mcpTransportStdio)).toBeTruthy()
    expect(within(staged).getByText('npx -y @modelcontextprotocol/server-github')).toBeTruthy()
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.mcpName).value).toBe('')
    expect(host.mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await flush()

    expect(host.mutate).toHaveBeenCalledWith(
      [{
        op: 'set',
        path: ['servers'],
        value: {
          gh: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
      }],
      1,
    )
    // A landed save collapses the card and leaves nothing pending.
    expect(screen.queryByLabelText(en.mcpName)).toBeNull()
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('stages a streamable-http server through the url field', async () => {
    const host = hostWith({ echo: ECHO })
    renderCard(host)

    type(en.mcpName, 'web')
    fireEvent.change(screen.getByLabelText(en.mcpTransport), { target: { value: 'streamable-http' } })
    expect(screen.queryByLabelText(en.mcpCommand)).toBeNull()
    type(en.mcpUrl, ' http://localhost:3000/mcp ')
    stage()

    expect(within(row('web')).getByText(en.mcpTransportHttp)).toBeTruthy()
    expect(within(row('web')).getByText('http://localhost:3000/mcp')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await flush()

    expect(host.mutate.mock.calls[0]![0]).toEqual([{
      op: 'set',
      path: ['servers'],
      value: { echo: ECHO, web: { transport: 'streamable-http', enabled: true, url: 'http://localhost:3000/mcp' } },
    }])
  })

  it.each([
    ['a name', () => {}, en.mcpNameRequired],
    ['a valid name', () => { type(en.mcpName, 'bad name!') }, en.mcpNameInvalid],
    ['a command', () => { type(en.mcpName, 'gh') }, en.mcpCommandRequired],
    ['a url', () => {
      type(en.mcpName, 'web')
      fireEvent.change(screen.getByLabelText(en.mcpTransport), { target: { value: 'streamable-http' } })
    }, en.mcpUrlRequired],
    ['an http(s) url', () => {
      type(en.mcpName, 'web')
      fireEvent.change(screen.getByLabelText(en.mcpTransport), { target: { value: 'streamable-http' } })
      type(en.mcpUrl, 'gopher://host')
    }, en.mcpUrlInvalid],
    ['a parseable url', () => {
      type(en.mcpName, 'web')
      fireEvent.change(screen.getByLabelText(en.mcpTransport), { target: { value: 'streamable-http' } })
      type(en.mcpUrl, 'not a url')
    }, en.mcpUrlInvalid],
  ])('explains an entry that lacks %s and stages nothing', (_what, fill, message) => {
    renderCard(hostWith({}))

    fill()
    stage()

    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByText(en.mcpEmpty)).toBeTruthy()
    expect(screen.queryByText(en.unsaved)).toBeNull()

    type(en.mcpName, 'anything')
    expect(screen.queryByText(message)).toBeNull()
  })

  it('toggles and removes existing servers, then discards the draft', () => {
    const host = hostWith({ web: WEB, echo: ECHO, odd: { transport: 'gopher', enabled: false } })
    renderCard(host)

    // Rows follow name order; a transport the card does not know shows no tag or detail.
    const names = screen.getAllByRole('switch').map(item => item.getAttribute('aria-label'))
    expect(names).toEqual(['echo', 'odd', 'web'])
    expect(within(row('odd')).queryByText(en.mcpTransportStdio)).toBeNull()
    expect(within(row('odd')).queryByText(en.mcpTransportHttp)).toBeNull()
    expect(within(row('odd')).getByRole('switch').getAttribute('aria-checked')).toBe('false')

    fireEvent.click(within(row('web')).getByRole('switch'))
    fireEvent.click(within(row('odd')).getByRole('switch'))
    fireEvent.click(within(row('echo')).getByRole('button', { name: en.mcpRemove }))

    expect(within(row('web')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(within(row('odd')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('echo', { selector: 'span' })).toBeNull()
    expect(host.mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(within(row('web')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(within(row('echo')).getByText('echo hi')).toBeTruthy()
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('summarizes hand-edited entries with missing or mistyped endpoint fields', () => {
    renderCard(hostWith({
      bare: { transport: 'stdio', command: 7, args: 'not-a-list' },
      mixed: { transport: 'stdio', command: 'run', args: ['a', 3, 'b'] },
      nourl: { transport: 'streamable-http', url: 9 },
    }))

    expect(within(row('bare')).getByText(en.mcpTransportStdio)).toBeTruthy()
    expect(row('bare').querySelector('p')).toBeNull()
    expect(within(row('mixed')).getByText('run a b')).toBeTruthy()
    expect(row('nourl').querySelector('p')).toBeNull()
  })

  it('updates a same-named server in place and keeps tuning only settings.yaml holds', async () => {
    const host = hostWith({ gh: { transport: 'stdio', command: 'old', enabled: false, env: { TOKEN: 'x' } } })
    renderCard(host)

    type(en.mcpName, 'gh')
    type(en.mcpCommand, 'npx')
    stage()
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await flush()

    expect(host.mutate.mock.calls[0]![0]).toEqual([{
      op: 'set',
      path: ['servers'],
      value: { gh: { transport: 'stdio', command: 'npx', enabled: true, args: [], env: { TOKEN: 'x' } } },
    }])
  })

  it('freezes every control while the deployment is read-only', () => {
    renderCard(hostWith({ web: WEB }, { writable: false }))

    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(within(row('web')).getByRole('switch')).toHaveProperty('disabled', true)
    expect(within(row('web')).getByRole('button', { name: en.mcpRemove })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.mcpName)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.mcpAdd })).toHaveProperty('disabled', true)
  })

  it('freezes edits while a save is in flight and ignores late edits', async () => {
    const host = hostWith({ web: WEB }, { hold: true })
    const { face } = renderCard(host)
    fireEvent.click(within(row('web')).getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await flush()

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(within(row('web')).getByRole('switch')).toHaveProperty('disabled', true)
    // The face is also guarded for callers that bypass the disabled controls.
    face.toggleEnabled('web')
    face.removeServer('web')
    face.discard()
    expect(face.saveServer({
      name: 'late', transport: 'stdio', enabled: true, command: 'x', argsText: '', url: '',
    })).toBeUndefined()
    face.save()
    expect(host.mutate).toHaveBeenCalledOnce()

    await act(async () => { host.gate.release?.() })

    // The landed save collapses the card; reopening shows only what was saved.
    fireEvent.click(screen.getByText(en.mcpTitle))
    expect(within(row('web')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('late', { selector: 'span' })).toBeNull()
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('keeps the draft and reports a save the Host did not take', async () => {
    const host = hostWith({ web: WEB }, { accepts: false })
    renderCard(host)
    fireEvent.click(within(row('web')).getByRole('button', { name: en.mcpRemove }))

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await flush()

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByText(en.mcpEmpty)).toBeTruthy()
    expect(screen.getByText(en.unsaved)).toBeTruthy()

    // The next edit clears the failure notice.
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(screen.queryByText(en.saveFailed)).toBeNull()
    expect(within(row('web')).getByRole('switch')).toBeTruthy()
  })

  describe('when settings change elsewhere', () => {
    it('warns about a conflicting draft and refuses to overwrite', async () => {
      const host = hostWith({ web: WEB })
      renderCard(host)
      fireEvent.click(within(row('web')).getByRole('button', { name: en.mcpRemove }))

      act(() => {
        host.publish({ value: { servers: { web: WEB, echo: ECHO } }, user: { servers: { web: WEB, echo: ECHO } }, revision: 2 })
      })

      expect(screen.getByText(en.mcpConflict)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: en.save }))
      await flush()
      expect(host.mutate).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: en.discard }))
      expect(screen.queryByText(en.mcpConflict)).toBeNull()
      expect(within(row('echo')).getByText('echo hi')).toBeTruthy()
    })

    it('refuses a save whose revision moved without a visible notification first', async () => {
      const host = hostWith({ web: WEB })
      const { face } = renderCard(host)
      fireEvent.click(within(row('web')).getByRole('button', { name: en.mcpRemove }))
      const snapshot: SettingsScopeSnapshot<McpFleetSettings> = host.scope.getSnapshot()
      // A revision bump the controller was never told about (no listener fired).
      host.scope.getSnapshot = () => ({ ...snapshot, revision: 9 })

      face.save()
      await flush()

      expect(host.mutate).not.toHaveBeenCalled()
      expect(screen.getByText(en.mcpConflict)).toBeTruthy()
    })

    it('drops a draft that the new revision already matches', () => {
      const host = hostWith({ web: WEB })
      renderCard(host)
      fireEvent.click(within(row('web')).getByRole('button', { name: en.mcpRemove }))

      act(() => { host.publish({ value: { servers: {} }, user: { servers: {} }, revision: 2 }) })

      expect(screen.queryByText(en.unsaved)).toBeNull()
      expect(screen.queryByText(en.mcpConflict)).toBeNull()
    })

    it('does not conflict a draft with an unrelated notification at the same revision', () => {
      const host = hostWith({ web: WEB })
      renderCard(host)
      fireEvent.click(within(row('web')).getByRole('switch'))

      act(() => { host.publish({ writable: true }) })

      expect(screen.queryByText(en.mcpConflict)).toBeNull()
      expect(screen.getByText(en.unsaved)).toBeTruthy()
    })

    it('shows a row set that differs in content as dirty rather than clean', () => {
      const host = hostWith({ web: WEB })
      renderCard(host)

      // Same count, different entry: toggling twice returns to the stored entry, one toggle does not.
      fireEvent.click(within(row('web')).getByRole('switch'))
      expect(screen.getByText(en.unsaved)).toBeTruthy()
      fireEvent.click(within(row('web')).getByRole('switch'))
      expect(screen.queryByText(en.unsaved)).toBeNull()
    })
  })

  describe('face guards', () => {
    it('ignores edits to servers that are not in the fleet', () => {
      const host = hostWith({ web: WEB })
      const { face } = renderCard(host)

      face.toggleEnabled('missing')
      face.removeServer('missing')
      face.save()

      expect(host.mutate).not.toHaveBeenCalled()
      expect(screen.queryByText(en.unsaved)).toBeNull()
    })

    it('renames a server through previousName and trims names', async () => {
      const host = hostWith({ old: ECHO })
      const { face } = renderCard(host)

      expect(face.saveServer({
        name: ' fresh ', previousName: ' old ', transport: 'stdio', enabled: true, command: 'echo', argsText: 'hi', url: '',
      })).toBeUndefined()
      expect(face.saveServer({
        name: 'same', previousName: 'same', transport: 'streamable-http', enabled: false, command: '', argsText: '',
        url: 'https://x.test/mcp',
      })).toBeUndefined()
      expect(face.saveServer({
        name: 'blank', previousName: '  ', transport: 'streamable-http', enabled: true, command: '', argsText: '',
        url: 'https://y.test/mcp',
      })).toBeUndefined()
      await act(async () => { face.save() })

      const written = (host.mutate.mock.calls[0]![0] as { value: Record<string, unknown> }[])[0]!.value
      expect(Object.keys(written).sort()).toEqual(['blank', 'fresh', 'same'])
    })

    it('goes inert once the controller is disposed', () => {
      const host = hostWith({ web: WEB })
      const { controller, face } = renderCard(host)

      controller.dispose()
      face.toggleEnabled('web')
      face.removeServer('web')
      face.save()

      expect(face.saveServer({
        name: 'gh', transport: 'stdio', enabled: true, command: 'npx', argsText: '', url: '',
      })).toBeUndefined()
      expect(host.mutate).not.toHaveBeenCalled()
      expect(host.listenerCount()).toBe(0)
    })

    it('ignores a save settlement that arrives after disposal', async () => {
      const host = hostWith({ web: WEB }, { hold: true })
      const { controller, face } = renderCard(host)
      fireEvent.click(within(row('web')).getByRole('switch'))
      face.save()
      await flush()

      controller.dispose()
      await act(async () => { host.gate.release?.() })

      expect(screen.getByRole('button', { name: en.saving })).toBeTruthy()
    })

    it('treats a scope that is still loading as empty and read-only', () => {
      const host = hostWith({ web: WEB })
      host.publish({ status: 'loading', value: undefined, writable: false })
      const { face } = renderCard(host)

      face.toggleEnabled('web')
      face.removeServer('web')

      expect(host.mutate).not.toHaveBeenCalled()
      expect(screen.queryByText(en.mcpTitle)).toBeNull()
      expect(face.hooks.mcpCard.getSnapshot()).toMatchObject({ available: false, servers: [], dirty: false })
    })
  })
})
