import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import * as catalog from '../src/catalog.ts'
import {
  createBrowserOAuthInteraction,
  loginOpenaiCodex,
  OPENAI_CODEX_BROWSER_LOGIN_METHOD,
  OPENAI_CODEX_PROVIDER,
  oauthProviderProfiles,
  openUrl,
  parseOAuthProvider,
} from '../src/oauth-login.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'
import { assemble } from './assemble.ts'
import { isolateDshHome, removeIsolatedHomes } from './dsh-home.ts'
import { rethrowPiAiError } from '../src/stream.ts'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn,
}))

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await removeIsolatedHomes()
})

function fakeAgent(): Agent {
  const session = Session.create(SessionId('oauth-login'))
  return { session, status: 'idle', options: {} } as unknown as Agent
}

describe('parseOAuthProvider', () => {
  it('defaults empty input to openai-codex and rejects any other name', () => {
    expect(parseOAuthProvider('')).toBe(OPENAI_CODEX_PROVIDER)
    expect(parseOAuthProvider('  openai-codex  ')).toBe(OPENAI_CODEX_PROVIDER)
    expect(parseOAuthProvider('anthropic')).toBeUndefined()
  })
})

describe('oauthProviderProfiles', () => {
  it('injects only a stored openai-codex oauth credential', () => {
    expect(oauthProviderProfiles([
      { providerId: 'openai-codex', type: 'oauth' },
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai-codex', type: 'api_key' },
    ])).toEqual({
      'openai-codex': { displayName: catalog.catalogProvider('openai-codex')?.name ?? 'OpenAI Codex' },
    })
    expect(oauthProviderProfiles([])).toEqual({})
  })
})

describe('createBrowserOAuthInteraction', () => {
  it('selects browser login, opens the authorize URL, and hangs manual_code until abort', async () => {
    const opened: string[] = []
    const interaction = createBrowserOAuthInteraction({
      openUrl: async (url) => { opened.push(url) },
    })
    await expect(interaction.prompt({
      type: 'select',
      message: 'Select OpenAI Codex login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login (headless)' },
      ],
    })).resolves.toBe(OPENAI_CODEX_BROWSER_LOGIN_METHOD)

    interaction.notify({ type: 'info', message: 'starting' })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' })
    await vi.waitFor(() => expect(opened).toEqual(['https://auth.example/authorize']))

    const ac = new AbortController()
    const hanging = interaction.prompt({
      type: 'manual_code',
      message: 'paste',
      signal: ac.signal,
    })
    ac.abort(new Error('callback won'))
    await expect(hanging).rejects.toThrow(/callback won/)
  })

  it('refuses a select that has no browser method and unsupported prompt types', async () => {
    const interaction = createBrowserOAuthInteraction({ openUrl: async () => undefined })
    await expect(interaction.prompt({
      type: 'select',
      message: 'pick',
      options: [{ id: 'device_code', label: 'Device' }],
    })).rejects.toThrow(/only supports browser OAuth/)
    await expect(interaction.prompt({ type: 'text', message: 'key' }))
      .rejects.toThrow(/does not support text prompts/)
    await expect(interaction.prompt({ type: 'secret', message: 'key' }))
      .rejects.toThrow(/does not support secret prompts/)
  })

  it('fails the hanging manual_code prompt when opening the URL fails', async () => {
    const interaction = createBrowserOAuthInteraction({
      openUrl: async () => { throw new Error('no browser') },
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' })
    await expect(interaction.prompt({ type: 'manual_code', message: 'paste' }))
      .rejects.toThrow(/no browser/)
  })

  it('fails an in-flight manual_code prompt when opening the URL fails', async () => {
    let rejectOpen: (error: Error) => void = () => undefined
    const interaction = createBrowserOAuthInteraction({
      openUrl: () => new Promise((_, reject) => { rejectOpen = reject }),
    })
    const hanging = interaction.prompt({ type: 'manual_code', message: 'paste' })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' })
    rejectOpen(new Error('no browser'))
    await expect(hanging).rejects.toThrow(/no browser/)
  })

  it('rejects an already-aborted prompt signal on manual_code', async () => {
    const interaction = createBrowserOAuthInteraction({ openUrl: async () => undefined })
    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'paste',
      signal: AbortSignal.abort(new Error('callback won')),
    })).rejects.toThrow(/callback won/)
  })

  it('rejects an already-aborted host signal on manual_code', async () => {
    const interaction = createBrowserOAuthInteraction({
      openUrl: async () => undefined,
      signal: AbortSignal.abort(new Error('already cancelled')),
    })
    await expect(interaction.prompt({ type: 'manual_code', message: 'paste' }))
      .rejects.toThrow(/already cancelled/)
  })

  it('fails an in-flight manual_code prompt when the host signal aborts', async () => {
    const ac = new AbortController()
    const interaction = createBrowserOAuthInteraction({
      openUrl: async () => undefined,
      signal: ac.signal,
    })
    expect(interaction.signal).toBe(ac.signal)
    const hanging = interaction.prompt({ type: 'manual_code', message: 'paste' })
    ac.abort(new Error('user cancelled'))
    await expect(hanging).rejects.toThrow(/user cancelled/)
  })

  it('rejects a non-Error abort reason as Login cancelled', async () => {
    const interaction = createBrowserOAuthInteraction({ openUrl: async () => undefined })
    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'paste',
      signal: AbortSignal.abort('stop'),
    })).rejects.toThrow(/Login cancelled/)
  })
})

describe('openUrl', () => {
  it('spawns the platform opener and detaches', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    await openUrl('https://auth.example/authorize')
    expect(spawn).toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalled()
    expect(spawn.mock.calls[0]?.[1]).toContain('https://auth.example/authorize')
  })

  it('rejects when the opener fails to spawn', async () => {
    const child = new EventEmitter()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
      return child
    })
    await expect(openUrl('https://auth.example/authorize')).rejects.toThrow(/ENOENT/)
  })

  it('uses open on darwin and cmd start on win32', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    try {
      await openUrl('https://auth.example/authorize')
      expect(spawn.mock.calls.at(-1)?.[0]).toBe('open')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      await openUrl('https://auth.example/authorize')
      expect(spawn.mock.calls.at(-1)?.[0]).toBe('cmd')
      expect(spawn.mock.calls.at(-1)?.[1]).toEqual(['/c', 'start', '', 'https://auth.example/authorize'])
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  })
})

describe('login and logout commands', () => {
  it('signs in, registers a live openai-codex route, and keeps it off the Models directory', async () => {
    const home = await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockImplementation(async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [
          { id: 'browser', label: 'Browser' },
          { id: 'device_code', label: 'Device' },
        ],
      })
      interaction.notify({ type: 'info', message: 'starting' })
      return {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
        accountId: 'acc_test',
      }
    })

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain(OPENAI_CODEX_PROVIDER)

    const agent = fakeAgent()
    const login = await ctx.commands.execute(agent, '/login', AbortSignal.timeout(5_000))
    expect(login?.result).toEqual({
      kind: 'success',
      text: 'Signed in to OpenAI Codex. Select an openai-codex model to use the ChatGPT Codex subscription.',
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: OPENAI_CODEX_PROVIDER, name: provider.name },
    ])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain(OPENAI_CODEX_PROVIDER)
    const models = await ctx.llm.listModels(OPENAI_CODEX_PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]?.provider).toBe(OPENAI_CODEX_PROVIDER)

    const stored = JSON.parse(await readFile(join(home, OAUTH_CREDENTIALS_FILENAME), 'utf8'))
    expect(stored['openai-codex'].type).toBe('oauth')
    expect(stored['openai-codex'].refresh).toBe('refresh-token')

    const logout = await ctx.commands.execute(agent, '/logout openai-codex', AbortSignal.timeout(5_000))
    expect(logout?.result).toEqual({ kind: 'success', text: 'Signed out of OpenAI Codex.' })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects login and logout for any provider other than openai-codex', async () => {
    await isolateDshHome()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const agent = fakeAgent()
    expect((await ctx.commands.execute(agent, '/login anthropic', AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: 'Only /login openai-codex is supported.' })
    expect((await ctx.commands.execute(agent, '/logout anthropic', AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: 'Only /logout openai-codex is supported.' })
  })

  it('registers openai-codex from a stored credential at boot without a settings profile', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
        accountId: 'acc_boot',
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([OPENAI_CODEX_PROVIDER])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain(OPENAI_CODEX_PROVIDER)
  })

  it('keeps a stored settings profile in the directory beside a live oauth route', async () => {
    await isolateDshHome()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_TOKEN' } } })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: OPENAI_CODEX_PROVIDER,
      displayName: OPENAI_CODEX_PROVIDER,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai-codex'],
      declared: false,
    })
  })

  it('returns the login error text when pi-ai login fails', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockRejectedValue(new Error('denied by provider'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const result = await ctx.commands.execute(fakeAgent(), '/login openai-codex', AbortSignal.timeout(1_000))
    expect(result?.result).toEqual({ kind: 'error', text: 'denied by provider' })
  })

  it('uses the fallback login text when the thrown value is not an Error', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockRejectedValue('token-secret-must-not-appear')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const result = await ctx.commands.execute(fakeAgent(), '/login', AbortSignal.timeout(1_000))
    expect(result?.result).toEqual({ kind: 'error', text: 'OpenAI Codex login failed' })
    expect(JSON.stringify(result?.result)).not.toContain('token-secret-must-not-appear')
  })

  it('uses the fallback login text when the Error message is blank', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockRejectedValue(new Error('   '))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const result = await ctx.commands.execute(fakeAgent(), '/login', AbortSignal.timeout(1_000))
    expect(result?.result).toEqual({ kind: 'error', text: 'OpenAI Codex login failed' })
  })

  it('returns the logout error text when the store delete fails', async () => {
    await isolateDshHome()
    vi.spyOn(FileOAuthStore.prototype, 'delete').mockRejectedValue(new Error('disk full'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const result = await ctx.commands.execute(fakeAgent(), '/logout', AbortSignal.timeout(1_000))
    expect(result?.result).toEqual({ kind: 'error', text: 'disk full' })
  })

  it('keeps previously registered routes when login cannot claim openai-codex', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockResolvedValue({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    })
    class StubAdapter extends LlmAdapter {
      override async * stream(): AsyncIterable<never> {
        throw new Error('stub adapter must never stream')
      }
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], new StubAdapter())
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    await ctx.plugin(LlmPiAi, {})
    const result = await ctx.commands.execute(fakeAgent(), '/login openai-codex', AbortSignal.timeout(5_000))
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(logged.mock.calls.some(([value]) =>
      typeof value === 'string' && value.includes('OAuth credential change'),
    )).toBe(true)
    expect(ctx.llm.providerInfo(OPENAI_CODEX_PROVIDER).name).not.toBe(provider.name)
  })

  it('maps a keyless openai-codex stream without a stored token to MISSING_CREDENTIAL', async () => {
    await isolateDshHome()
    const model = getBuiltinModels('openai-codex')[0]
    if (model === undefined) throw new Error('expected openai-codex catalog models')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'openai-codex': {} } })
    const result = await assemble(ctx, {
      provider: OPENAI_CODEX_PROVIDER,
      model: model.id,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })
})

describe('loginOpenaiCodex', () => {
  it('persists the credential pi-ai login returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-login-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockResolvedValue({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      accountId: 'acc',
    })
    await loginOpenaiCodex(store, createBrowserOAuthInteraction({ openUrl: async () => undefined }))
    expect(await store.read(OPENAI_CODEX_PROVIDER)).toMatchObject({ type: 'oauth', accountId: 'acc' })
  })

  it('refuses login when the installed catalog does not ship openai-codex', async () => {
    vi.spyOn(catalog, 'catalogProvider').mockReturnValue(undefined)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-login-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    await expect(loginOpenaiCodex(store, createBrowserOAuthInteraction({ openUrl: async () => undefined })))
      .rejects.toThrow(/does not ship openai-codex/)
  })
})

describe('rethrowPiAiError', () => {
  it('maps an unconfigured provider to MISSING_CREDENTIAL', () => {
    expect(() => rethrowPiAiError(new Error('Provider is not configured: openai-codex'))).toThrow(LlmError)
    try {
      rethrowPiAiError(new Error('Provider is not configured: openai-codex'))
    } catch (error) {
      expect(error).toMatchObject({ code: 'MISSING_CREDENTIAL' })
      expect(String(error)).toMatch(/\/login openai-codex/)
    }
  })

  it('rethrows unrecognized failures unchanged', () => {
    const original = new Error('socket hang up')
    expect(() => rethrowPiAiError(original)).toThrow(original)
  })

  it('maps a non-Error unconfigured-provider value to MISSING_CREDENTIAL', () => {
    expect(() => rethrowPiAiError('Provider is not configured: openai-codex')).toThrow(LlmError)
  })
})
