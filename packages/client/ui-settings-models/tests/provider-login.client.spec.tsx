// @vitest-environment jsdom
/** Connected provider logins on the Models page: their labels, sign-out, and adapter setup defaults. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelsSection, providerCopy } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    api: Schema.string(),
  })),
})

function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

const piAiNamespace: SettingsNamespaceView = {
  ns: 'llm-pi-ai',
  schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
  value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
  user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
  applies: 'live',
  secrets: [],
  revision: 0,
}

/**
 * Mount the section over a scripted Host: an openai profile that is usable,
 * the given live logins, and the given extra settings-addressable routes.
 */
async function mountSection(options: {
  logins?: ReadonlyArray<{ id: string; name: string; auth: 'oauth' | 'api-key' }>
  logout?: ReturnType<typeof vi.fn>
  configurable?: ReadonlyArray<Record<string, unknown>>
} = {}) {
  const mutate = vi.fn(() => Promise.resolve(remoteOk(piAiNamespace)))
  const logout = options.logout ?? vi.fn(() => Promise.resolve())
  const face = {
    llm: {
      listProviders: vi.fn(() => Promise.resolve(remoteOk([
        { id: 'openai', name: 'openai' },
        ...options.logins ?? [],
      ]))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(remoteOk([
        {
          provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'openai'],
          defaults: { api: 'openai-responses' },
        },
        ...options.configurable ?? [],
      ]))),
      discoverModels: vi.fn(() => Promise.resolve(remoteOk([]))),
      loginOAuth: vi.fn(() => Promise.resolve(remoteOk(undefined))),
      loginApiKey: vi.fn(() => Promise.resolve(remoteOk(undefined))),
      logout,
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: [piAiNamespace] }))),
      mutate,
    },
    credentials: {
      describe: vi.fn((refs: string[]) => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
      ))),
      set: vi.fn(() => Promise.resolve(remoteOk(undefined))),
      unset: vi.fn(() => Promise.resolve(remoteOk(undefined))),
    },
  }
  const ctx = { remote: face } as unknown as ConstructorParameters<typeof ModelsSettingsStore>[0]
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  await controller.load()
  const props: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    operations: createModelsOperations(ctx),
    schema: settingsSchema,
    t,
    renderSlot: () => null,
  }
  render(<ModelsSection {...props} />)
  return { face, controller, logout, mutate }
}

const target = (id: string, name: string) => ({ provider: id, displayName: name })

describe('connected provider login rows', () => {
  it.each([
    ['cursor', 'Cursor', 'oauth', en.oauthConfiguredCursor],
    ['google-antigravity', 'Antigravity', 'oauth', en.oauthConfiguredAntigravity],
    ['google-gemini-cli', 'Gemini CLI', 'oauth', en.oauthConfiguredAntigravity],
    ['openai-codex', 'ChatGPT', 'oauth', en.oauthConfigured],
    ['opencode-go', 'OpenCode Go', 'api-key', en.apiKeyLoginConfigured],
  ] as const)('labels the signed-in state of %s for its login method', async (id, name, auth, label) => {
    await mountSection({ logins: [{ id, name, auth }] })

    expect(screen.getByRole('img', { name: label })).toBeTruthy()
    expect(screen.getByRole('button', { name: providerCopy(en.oauthSignOutProvider, target(id, name)) })).toBeTruthy()
  })
})

describe('signing out of a connected provider', () => {
  it('confirms, disconnects the OAuth login, and reloads the page without touching settings', async () => {
    const gate = Promise.withResolvers<undefined>()
    const logout = vi.fn(() => gate.promise)
    const { controller, mutate } = await mountSection({
      logins: [{ id: 'cursor', name: 'Cursor', auth: 'oauth' }],
      logout,
    })
    const load = vi.spyOn(controller, 'load')
    const cursor = target('cursor', 'Cursor')

    fireEvent.click(screen.getByRole('button', { name: providerCopy(en.oauthSignOutProvider, cursor) }))
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.oauthSignOutTitle, cursor) })
    expect(dialog.textContent).toContain(providerCopy(en.oauthSignOutDescription, cursor))
    expect(logout).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: providerCopy(en.oauthSignOutConfirm, cursor) }))
    expect(within(dialog).getByRole('button', { name: providerCopy(en.oauthSigningOut, cursor) })).toBeTruthy()
    expect(logout).toHaveBeenCalledExactlyOnceWith('cursor')

    await act(async () => { gate.resolve(undefined) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(load).toHaveBeenCalledTimes(1)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('names the disconnect for an API-key login while it is pending', async () => {
    const gate = Promise.withResolvers<undefined>()
    const logout = vi.fn(() => gate.promise)
    await mountSection({ logins: [{ id: 'opencode-go', name: 'OpenCode Go', auth: 'api-key' }], logout })
    const go = target('opencode-go', 'OpenCode Go')

    fireEvent.click(screen.getByRole('button', { name: providerCopy(en.oauthSignOutProvider, go) }))
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.apiKeyDisconnectTitle, go) })
    expect(dialog.textContent).toContain(providerCopy(en.apiKeyDisconnectDescription, go))
    fireEvent.click(within(dialog).getByRole('button', { name: providerCopy(en.apiKeyDisconnectConfirm, go) }))
    expect(within(dialog).getByRole('button', { name: providerCopy(en.apiKeyDisconnecting, go) })).toBeTruthy()

    await act(async () => { gate.resolve(undefined) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it.each([
    ['an Error', new Error('login store locked'), 'login store locked'],
    ['a bare string', 'keychain unavailable', 'keychain unavailable'],
  ])('keeps the dialog open with the failure when logout rejects with %s', async (_label, reason, message) => {
    const logout = vi.fn().mockRejectedValue(reason)
    const { controller } = await mountSection({
      logins: [{ id: 'cursor', name: 'Cursor', auth: 'oauth' }],
      logout,
    })
    const load = vi.spyOn(controller, 'load')
    const cursor = target('cursor', 'Cursor')

    fireEvent.click(screen.getByRole('button', { name: providerCopy(en.oauthSignOutProvider, cursor) }))
    const dialog = screen.getByRole('dialog', { name: providerCopy(en.oauthSignOutTitle, cursor) })
    fireEvent.click(within(dialog).getByRole('button', { name: providerCopy(en.oauthSignOutConfirm, cursor) }))

    await waitFor(() => { expect(within(dialog).getByText(message)).toBeTruthy() })
    expect(load).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: providerCopy(en.oauthSignOutConfirm, cursor) })).toBeTruthy()
  })
})

describe('adapter setup defaults on provider cards', () => {
  it('seeds a configured route’s editor with the directory defaults', async () => {
    const { mutate } = await mountSection()

    fireEvent.click(screen.getByRole('button', { name: providerCopy(en.editProvider, target('openai', 'openai')) }))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'openai', 'api'], value: 'openai-responses' }],
      0,
    )
  })

  it('seeds the add card for a dormant route with the directory defaults', async () => {
    const { mutate } = await mountSection({
      configurable: [{
        provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'anthropic'],
        defaults: { baseURL: 'https://gateway.example/anthropic' },
      }],
    })

    fireEvent.click(screen.getByText(en.add))
    fireEvent.click(screen.getByText(en.customized))
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).value).toBe('https://gateway.example/anthropic')
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic', 'baseURL'], value: 'https://gateway.example/anthropic' }],
      0,
    )
  })
})
