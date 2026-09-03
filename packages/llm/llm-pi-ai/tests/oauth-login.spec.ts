import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
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
  authUrlFallbackMessage,
  browserOpenArgv,
  createBrowserOAuthInteraction,
  loginHostedOAuth,
  loginOpenaiCodex,
  OPENAI_CODEX_BROWSER_LOGIN_METHOD,
  OPENAI_CODEX_DISPLAY_NAME,
  OPENAI_CODEX_PROVIDER,
  OAUTH_LOGIN_IN_PROGRESS,
  OAUTH_LOGIN_UNSUPPORTED,
  OAUTH_LOGOUT_UNSUPPORTED,
  oauthProviderProfiles,
  openUrl,
  parseOAuthProvider,
} from '../src/oauth-login.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'
import * as oauthHosts from '../src/oauth-hosts.ts'
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

interface StoredCredentialRecord {
  readonly type: string
  readonly refresh?: string
  readonly projectId?: string
}

/** Parse the persisted credential fixture without treating JSON.parse output as typed data. */
function parseStoredCredentials(serialized: string): Record<string, StoredCredentialRecord> {
  return JSON.parse(serialized) as Record<string, StoredCredentialRecord>
}

describe('parseOAuthProvider', () => {
  it('defaults empty input to openai-codex, accepts hosted ids, and rejects any other name', () => {
    expect(parseOAuthProvider('')).toBe(OPENAI_CODEX_PROVIDER)
    expect(parseOAuthProvider('  openai-codex  ')).toBe(OPENAI_CODEX_PROVIDER)
    expect(parseOAuthProvider('cursor')).toBe('cursor')
    expect(parseOAuthProvider('google-antigravity')).toBe('google-antigravity')
    expect(parseOAuthProvider('antigravity')).toBe('google-antigravity')
    expect(parseOAuthProvider('anthropic')).toBeUndefined()
  })
})

describe('host command metadata', () => {
  it('advertises provider input on the host login command', async () => {
    await isolateDshHome()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})

    const login = ctx.commands.list(fakeAgent()).find(command => command.name === 'login')
    expect(login).toMatchObject({
      name: 'login',
      input: { hint: oauthHosts.OAUTH_COMMAND_HINT },
    })
  })
})

describe('oauthProviderProfiles', () => {
  it('injects stored hosted oauth credentials and ignores other catalog oauth', () => {
    expect(oauthProviderProfiles([
      { providerId: 'openai-codex', type: 'oauth' },
      { providerId: 'cursor', type: 'oauth' },
      { providerId: 'google-antigravity', type: 'oauth' },
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai-codex', type: 'api_key' },
    ])).toEqual({
      'openai-codex': { displayName: catalog.catalogProvider('openai-codex')?.name ?? 'OpenAI Codex' },
      cursor: { displayName: catalog.catalogProvider('cursor')?.name ?? 'Cursor' },
      'google-antigravity': {
        displayName: catalog.catalogProvider('google-antigravity')?.name ?? 'Antigravity',
      },
    })
    expect(oauthProviderProfiles([])).toEqual({})
  })

  it('falls back to the OpenAI Codex display name when the catalog provider is missing', () => {
    vi.spyOn(catalog, 'catalogProvider').mockReturnValue(undefined)
    expect(oauthProviderProfiles([{ providerId: 'openai-codex', type: 'oauth' }])).toEqual({
      'openai-codex': { displayName: OPENAI_CODEX_DISPLAY_NAME },
    })
  })
})

describe('createBrowserOAuthInteraction', () => {
  it('selects browser login, opens the authorize URL, and hangs manual_code until abort', async () => {
    const opened: string[] = []
    const written: string[] = []
    const interaction = createBrowserOAuthInteraction({
      openUrl: async (url) => { opened.push(url) },
      writeAuthUrl: (url) => { written.push(url) },
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
    await vi.waitFor(() =>{  expect(opened).toEqual(['https://auth.example/authorize']) })
    expect(written).toEqual(['https://auth.example/authorize'])

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
      writeAuthUrl: () => undefined,
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' })
    await Promise.resolve()
    await expect(interaction.prompt({ type: 'manual_code', message: 'paste' }))
      .rejects.toThrow(/no browser/)
  })

  it('wraps a non-Error opener failure', async () => {
    const interaction = createBrowserOAuthInteraction({
      openUrl: async () => { throw 'nope' },
      writeAuthUrl: () => undefined,
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' })
    await Promise.resolve()
    await expect(interaction.prompt({ type: 'manual_code', message: 'paste' }))
      .rejects.toThrow(/Failed to open the login page/)
  })

  it('fails an in-flight manual_code prompt when opening the URL fails', async () => {
    let rejectOpen: (error: Error) => void = () => undefined
    const interaction = createBrowserOAuthInteraction({
      openUrl: () => new Promise((_, reject) => { rejectOpen = reject }),
      writeAuthUrl: () => undefined,
    })
    const hanging = interaction.prompt({ type: 'manual_code', message: 'paste' })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example/authorize' })
    rejectOpen(new Error('no browser'))
    await expect(hanging).rejects.toThrow(/no browser/)
  })

  it('writes the authorize URL to stderr when no writer is supplied', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const interaction = createBrowserOAuthInteraction({ openUrl: async () => undefined })
    const url = 'https://auth.example/authorize?response_type=code&client_id=app'
    interaction.notify({ type: 'auth_url', url })
    expect(write).toHaveBeenCalledWith(authUrlFallbackMessage(url))
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

describe('browserOpenArgv', () => {
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test'

  it('uses open on darwin and xdg-open on desktop linux', () => {
    expect(browserOpenArgv(url, { platform: 'darwin' })).toEqual({ command: 'open', args: [url] })
    expect(browserOpenArgv(url, { platform: 'linux', env: {}, osRelease: '6.8.0-generic' }))
      .toEqual({ command: 'xdg-open', args: [url] })
    expect(browserOpenArgv(url, {
      platform: 'linux',
      env: { WSL_DISTRO_NAME: '', WSL_INTEROP: '' },
      osRelease: '6.8.0-generic',
    })).toEqual({ command: 'xdg-open', args: [url] })
  })

  it('uses rundll32 on Windows and WSL so `&` stays in one argument', () => {
    const expected = {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    }
    expect(browserOpenArgv(url, { platform: 'win32' })).toEqual(expected)
    expect(expected.args.at(-1)).toContain('&')
    expect(browserOpenArgv(url, { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, osRelease: '6.8.0-generic' }))
      .toEqual(expected)
    expect(browserOpenArgv(url, { platform: 'linux', env: { WSL_INTEROP: '/run/WSL/1' }, osRelease: '6.8.0-generic' }))
      .toEqual(expected)
    expect(browserOpenArgv(url, { platform: 'linux', env: {}, osRelease: '5.15.153.1-microsoft-standard-WSL2' }))
      .toEqual(expected)
  })

  it('samples ambient WSL markers and kernel release when internals omit them', () => {
    const env = process.env
    const ambientWsl = (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== '')
      || (env.WSL_INTEROP !== undefined && env.WSL_INTEROP !== '')
      || osRelease().toLowerCase().includes('microsoft')
    expect(browserOpenArgv(url, { platform: 'linux' }).command)
      .toBe(ambientWsl ? 'rundll32.exe' : 'xdg-open')
  })
})

describe('authUrlFallbackMessage', () => {
  it('prints the full authorize URL and warns against clicking a wrapped link', () => {
    const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test'
    expect(authUrlFallbackMessage(url)).toContain(url)
    expect(authUrlFallbackMessage(url)).toMatch(/do not click a line-wrapped terminal link/)
  })
})

describe('openUrl', () => {
  const linuxDesktop = { platform: 'linux' as const, env: {}, osRelease: '6.8.0-generic' }

  it('spawns the platform opener and detaches', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    await openUrl('https://auth.example/authorize', linuxDesktop)
    expect(spawn).toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalled()
    expect(spawn.mock.calls[0]?.[0]).toBe('xdg-open')
    expect(spawn.mock.calls[0]?.[1]).toEqual(['https://auth.example/authorize'])
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: 'ignore', detached: true, windowsHide: true })
  })

  it('rejects when the opener fails to spawn', async () => {
    const child = new EventEmitter()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
      return child
    })
    await expect(openUrl('https://auth.example/authorize', linuxDesktop)).rejects.toThrow(/ENOENT/)
  })

  it('uses open on darwin and rundll32 on win32', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const url = 'https://auth.example/authorize?response_type=code&client_id=app'
    await openUrl(url, { platform: 'darwin' })
    expect(spawn.mock.calls.at(-1)?.[0]).toBe('open')
    await openUrl(url, { platform: 'win32' })
    expect(spawn.mock.calls.at(-1)?.[0]).toBe('rundll32.exe')
    expect(spawn.mock.calls.at(-1)?.[1]).toEqual(['url.dll,FileProtocolHandler', url])
  })

  it('reads process.platform when internals omit it', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    await openUrl('https://auth.example/authorize')
    expect(['open', 'xdg-open', 'rundll32.exe']).toContain(spawn.mock.calls[0]?.[0])
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
    const login = await ctx.commands.execute(agent, '/login', [], AbortSignal.timeout(5_000))
    expect(login?.result).toEqual({
      kind: 'success',
      text: 'Signed in to OpenAI Codex. Select an openai-codex model to use the ChatGPT Codex subscription.',
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: OPENAI_CODEX_PROVIDER, name: provider.name, auth: 'oauth' },
    ])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain(OPENAI_CODEX_PROVIDER)
    const models = await ctx.llm.listModels(OPENAI_CODEX_PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]?.provider).toBe(OPENAI_CODEX_PROVIDER)

    const stored = parseStoredCredentials(await readFile(join(home, OAUTH_CREDENTIALS_FILENAME), 'utf8'))
    expect(stored['openai-codex']!.type).toBe('oauth')
    expect(stored['openai-codex']!.refresh).toBe('refresh-token')

    await ctx.llm.logout(OPENAI_CODEX_PROVIDER)
    expect(ctx.llm.listProviders()).toEqual([])

    const logout = await ctx.commands.execute(agent, '/logout openai-codex', [], AbortSignal.timeout(5_000))
    expect(logout?.result).toEqual({ kind: 'success', text: 'Signed out of OpenAI Codex.' })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('signs in with /login cursor, injects a live route, and keeps the key card withheld', async () => {
    const home = await isolateDshHome()
    const provider = catalog.catalogProvider('cursor')
    if (provider?.auth.oauth === undefined) throw new Error('expected cursor oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockImplementation(async (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://cursor.com/loginDeepControl?challenge=x&uuid=y' })
      return {
        type: 'oauth',
        access: 'cursor-access',
        refresh: 'cursor-refresh',
        expires: Date.now() + 60_000,
      }
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('cursor')
    const login = await ctx.commands.execute(fakeAgent(), '/login cursor', [], AbortSignal.timeout(5_000))
    expect(login?.result).toEqual({
      kind: 'success',
      text: 'Signed in to Cursor. Select a cursor model to use the Cursor subscription.',
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'cursor', name: provider.name, auth: 'oauth' },
    ])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('cursor')
    const models = await ctx.llm.listModels('cursor')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]?.provider).toBe('cursor')
    const stored = parseStoredCredentials(await readFile(join(home, OAUTH_CREDENTIALS_FILENAME), 'utf8'))
    expect(stored.cursor).toMatchObject({ type: 'oauth', refresh: 'cursor-refresh' })
    const logout = await ctx.commands.execute(fakeAgent(), '/logout cursor', [], AbortSignal.timeout(5_000))
    expect(logout?.result).toEqual({ kind: 'success', text: 'Signed out of Cursor.' })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('signs in with /login google-antigravity, injects a live route, and keeps the key card withheld', async () => {
    const home = await isolateDshHome()
    const provider = catalog.catalogProvider('google-antigravity')
    if (provider?.auth.oauth === undefined) throw new Error('expected google-antigravity oauth')
    vi.spyOn(provider.auth.oauth, 'login').mockImplementation(async (interaction) => {
      interaction.notify({
        type: 'auth_url',
        url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      })
      return {
        type: 'oauth',
        access: 'antigravity-access',
        refresh: 'antigravity-refresh',
        expires: Date.now() + 60_000,
        projectId: 'proj-test',
      }
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .not.toContain('google-antigravity')
    const login = await ctx.commands.execute(fakeAgent(), '/login google-antigravity', [], AbortSignal.timeout(5_000))
    expect(login?.result).toEqual({
      kind: 'success',
      text: 'Signed in to Antigravity. Select a google-antigravity model to use the Antigravity subscription.',
    })
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'google-antigravity', name: provider.name, auth: 'oauth' },
    ])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .not.toContain('google-antigravity')
    const models = await ctx.llm.listModels('google-antigravity')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]?.provider).toBe('google-antigravity')
    const stored = parseStoredCredentials(await readFile(join(home, OAUTH_CREDENTIALS_FILENAME), 'utf8'))
    expect(stored['google-antigravity']).toMatchObject({
      type: 'oauth',
      refresh: 'antigravity-refresh',
      projectId: 'proj-test',
    })
    const logout = await ctx.commands.execute(
      fakeAgent(),
      '/logout google-antigravity',
      [],
      AbortSignal.timeout(5_000),
    )
    expect(logout?.result).toEqual({ kind: 'success', text: 'Signed out of Antigravity.' })
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
    expect((await ctx.commands.execute(agent, '/login anthropic', [], AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: OAUTH_LOGIN_UNSUPPORTED })
    expect((await ctx.commands.execute(agent, '/logout anthropic', [], AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: OAUTH_LOGOUT_UNSUPPORTED })
  })

  it('treats a hosted id that disappears from the table as unsupported', async () => {
    await isolateDshHome()
    vi.spyOn(oauthHosts, 'hostedOAuthProvider').mockReturnValue(undefined)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect((await ctx.commands.execute(fakeAgent(), '/login openai-codex', [], AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: OAUTH_LOGIN_UNSUPPORTED })
    expect((await ctx.commands.execute(fakeAgent(), '/logout openai-codex', [], AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: OAUTH_LOGOUT_UNSUPPORTED })
  })

  it('forwards commands/open-url without opening a second host browser and still writes stderr', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test'
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    vi.spyOn(provider.auth.oauth, 'login').mockImplementation(async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [
          { id: 'browser', label: 'Browser' },
          { id: 'device_code', label: 'Device' },
        ],
      })
      interaction.notify({ type: 'auth_url', url })
      return {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      }
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const opened: string[] = []
    spawn.mockClear()
    ctx.on('commands/open-url', (authUrl) => { opened.push(authUrl) })
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result = await ctx.commands.execute(fakeAgent(), '/login openai-codex', [], AbortSignal.timeout(5_000))
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(opened).toEqual([url])
    expect(write).toHaveBeenCalledWith(authUrlFallbackMessage(url))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('opens the host browser when no browser subscriber is present', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test'
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockClear()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    vi.spyOn(provider.auth.oauth, 'login').mockImplementation(async (interaction) => {
      await interaction.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [
          { id: 'browser', label: 'Browser' },
          { id: 'device_code', label: 'Device' },
        ],
      })
      interaction.notify({ type: 'auth_url', url })
      return {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      }
    })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const result = await ctx.commands.execute(fakeAgent(), '/login openai-codex', [], AbortSignal.timeout(5_000))
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(authUrlFallbackMessage(url))
  })

  it('refuses a second /login while the first is still waiting on the callback', async () => {
    await isolateDshHome()
    const provider = catalog.catalogProvider(OPENAI_CODEX_PROVIDER)
    if (provider?.auth.oauth === undefined) throw new Error('expected openai-codex oauth')
    let release!: (value: {
      type: 'oauth'
      access: string
      refresh: string
      expires: number
    }) => void
    const hanging = new Promise<{
      type: 'oauth'
      access: string
      refresh: string
      expires: number
    }>((resolve) => { release = resolve })
    const login = vi.spyOn(provider.auth.oauth, 'login').mockReturnValue(hanging)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(LlmPiAi, {})
    const agent = fakeAgent()
    const first = ctx.commands.execute(agent, '/login openai-codex', [], AbortSignal.timeout(5_000))
    await vi.waitFor(() =>{  expect(login).toHaveBeenCalledTimes(1) })
    expect((await ctx.commands.execute(agent, '/login', [], AbortSignal.timeout(1_000)))?.result)
      .toEqual({ kind: 'error', text: OAUTH_LOGIN_IN_PROGRESS })
    expect(login).toHaveBeenCalledTimes(1)
    release({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    })
    expect((await first)?.result).toMatchObject({ kind: 'success' })
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
    expect(ctx.llm.listProviders()).toEqual([{
      id: OPENAI_CODEX_PROVIDER,
      name: catalog.catalogProvider(OPENAI_CODEX_PROVIDER)?.name ?? OPENAI_CODEX_DISPLAY_NAME,
      auth: 'oauth',
    }])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain(OPENAI_CODEX_PROVIDER)
  })

  it('registers cursor from a stored credential at boot without a settings profile', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      cursor: {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listProviders()).toEqual([{
      id: 'cursor',
      name: catalog.catalogProvider('cursor')?.name ?? 'Cursor',
      auth: 'oauth',
    }])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('cursor')
  })

  it('registers google-antigravity from a stored credential at boot without a settings profile', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      'google-antigravity': {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
        projectId: 'proj-boot',
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {})
    expect(ctx.llm.listProviders()).toEqual([{
      id: 'google-antigravity',
      name: catalog.catalogProvider('google-antigravity')?.name ?? 'Antigravity',
      auth: 'oauth',
    }])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider)).not.toContain('google-antigravity')
  })

  it('does not mark a settings-declared openai-codex route as oauth-injected', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'openai-codex': { apiKeyEnv: 'CODEX_TOKEN' } } })
    expect(ctx.llm.listProviders()).toEqual([{
      id: OPENAI_CODEX_PROVIDER,
      name: OPENAI_CODEX_PROVIDER,
    }])
  })

  it('does not mark a settings-declared cursor route as oauth-injected', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      cursor: {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { cursor: { apiKeyEnv: 'CURSOR_TOKEN' } } })
    expect(ctx.llm.listProviders()).toEqual([{
      id: 'cursor',
      name: 'cursor',
    }])
  })

  it('does not mark a settings-declared google-antigravity route as oauth-injected', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      'google-antigravity': {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
        projectId: 'proj-settings',
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'google-antigravity': { apiKeyEnv: 'ANTIGRAVITY_TOKEN' } } })
    expect(ctx.llm.listProviders()).toEqual([{
      id: 'google-antigravity',
      name: 'google-antigravity',
    }])
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
    const result = await ctx.commands.execute(fakeAgent(), '/login openai-codex', [], AbortSignal.timeout(1_000))
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
    const result = await ctx.commands.execute(fakeAgent(), '/login', [], AbortSignal.timeout(1_000))
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
    const result = await ctx.commands.execute(fakeAgent(), '/login', [], AbortSignal.timeout(1_000))
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
    const result = await ctx.commands.execute(fakeAgent(), '/logout', [], AbortSignal.timeout(1_000))
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
    const result = await ctx.commands.execute(fakeAgent(), '/login openai-codex', [], AbortSignal.timeout(5_000))
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(logged.mock.calls.some(([value]) =>
      typeof value === 'string' && value.includes('OAuth credential change'),
    )).toBe(true)
    expect(ctx.llm.listProviders()).toEqual([
      { id: OPENAI_CODEX_PROVIDER, name: OPENAI_CODEX_PROVIDER },
    ])
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

  it('uses the stored OpenAI Codex OAuth credential for a hosted request', async () => {
    const home = await isolateDshHome()
    await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: Date.now() + 60_000,
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const read = vi.spyOn(FileOAuthStore.prototype, 'read')
      .mockRejectedValue(new Error('OAuth credential lookup reached'))
    const model = getBuiltinModels(OPENAI_CODEX_PROVIDER)[0]
    if (model === undefined) throw new Error('expected openai-codex catalog models')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { [OPENAI_CODEX_PROVIDER]: {} } })
    const result = await assemble(ctx, {
      provider: OPENAI_CODEX_PROVIDER,
      model: model.id,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(read).toHaveBeenCalledWith(OPENAI_CODEX_PROVIDER, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected OAuth lookup to fail the request')
    expect(result.finish.failure.code).toBe('PI_AI_ERROR')
    expect(result.finish.failure.message).toContain('OAuth credential lookup reached')
  })

  it('maps a keyless cursor stream without a stored token to MISSING_CREDENTIAL', async () => {
    await isolateDshHome()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { cursor: {} } })
    const result = await assemble(ctx, {
      provider: 'cursor',
      model: 'composer-1.5',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(JSON.stringify(result.finish)).toMatch(/\/login cursor/)
  })

  it('maps a keyless google-antigravity stream without a stored token to MISSING_CREDENTIAL', async () => {
    await isolateDshHome()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { 'google-antigravity': {} } })
    const result = await assemble(ctx, {
      provider: 'google-antigravity',
      model: 'gemini-3.7-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(JSON.stringify(result.finish)).toMatch(/\/login google-antigravity/)
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

  it('refuses hosted login when the provider offers no OAuth method', async () => {
    vi.spyOn(catalog, 'catalogProvider').mockReturnValue({
      id: 'cursor',
      name: 'Cursor',
      auth: {},
      getModels: () => [],
      stream: () => {
        throw new Error('unused')
      },
      streamSimple: () => {
        throw new Error('unused')
      },
    })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-login-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    await expect(loginHostedOAuth('cursor', store, createBrowserOAuthInteraction({ openUrl: async () => undefined })))
      .rejects.toThrow(/does not offer OAuth/)
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
    try {
      rethrowPiAiError(new Error('Provider is not configured: cursor'))
    } catch (cursorError) {
      expect(cursorError).toMatchObject({ code: 'MISSING_CREDENTIAL' })
      expect(String(cursorError)).toMatch(/\/login cursor/)
    }
    try {
      rethrowPiAiError(new Error('Provider is not configured: google-antigravity'))
    } catch (antigravityError) {
      expect(antigravityError).toMatchObject({ code: 'MISSING_CREDENTIAL' })
      expect(String(antigravityError)).toMatch(/\/login google-antigravity/)
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
