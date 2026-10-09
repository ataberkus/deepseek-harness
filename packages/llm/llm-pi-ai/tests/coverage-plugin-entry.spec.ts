/** Plugin entry in a real composition: stored logins, sign-in flows, replay degradation, and refused directory swaps. */
import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { cursorOAuthInternals } from '../src/cursor/oauth.ts'
import { authUrlFallbackMessage, OAUTH_LOGIN_UNSUPPORTED, OPENCODE_GO_PROVIDER } from '../src/oauth-login.ts'
import { hostedOAuthProvider } from '../src/oauth-hosts.ts'
import { OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'
import * as catalog from '../src/catalog.ts'
import { assemble } from './assemble.ts'
import { isolateDshHome, removeIsolatedHomes } from './dsh-home.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn }))

const NS = 'llm-pi-ai'
const contexts: Context[] = []
const originalOAuthFetch = cursorOAuthInternals.fetch
const originalOAuthSleep = cursorOAuthInternals.sleep

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  cursorOAuthInternals.fetch = originalOAuthFetch
  cursorOAuthInternals.sleep = originalOAuthSleep
  spawn.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeMockServers()
  await removeIsolatedHomes()
})

async function boot(config: LlmPiAi.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

async function storeCredentials(home: string, records: Record<string, unknown>): Promise<void> {
  await writeFile(join(home, OAUTH_CREDENTIALS_FILENAME), `${JSON.stringify(records)}\n`, { mode: 0o600 })
}

const oauthRecord = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 3_600_000,
}

function scriptCursorPoll(): void {
  cursorOAuthInternals.sleep = async () => undefined
  cursorOAuthInternals.fetch = vi.fn(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ accessToken: 'polled-access', refreshToken: 'polled-refresh' }),
  }) as Response)
}

describe('stored logins beside settings routes', () => {
  it('marks a stored login as injected only when settings do not already declare the route', async () => {
    const home = await isolateDshHome()
    await storeCredentials(home, {
      cursor: oauthRecord,
      [OPENCODE_GO_PROVIDER]: { type: 'api_key', key: 'stored-key' },
    })
    const bare = await boot()
    expect(bare.llm.listProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cursor', auth: 'oauth' }),
      expect.objectContaining({ id: OPENCODE_GO_PROVIDER, auth: 'api-key' }),
    ]))

    const declared = await boot({ providers: { cursor: {}, [OPENCODE_GO_PROVIDER]: {} } })
    const infos = declared.llm.listProviders().filter(provider => provider.id === 'cursor' || provider.id === OPENCODE_GO_PROVIDER)
    expect(infos).toHaveLength(2)
    for (const info of infos) expect(info).not.toHaveProperty('auth')
  })
})

describe('OAuth sign-in from the Models page', () => {
  it('opens the authorize URL through a commands/open-url subscriber without the host browser', async () => {
    await isolateDshHome()
    scriptCursorPoll()
    const ctx = await boot()
    const opened: string[] = []
    ctx.on('commands/open-url', (url) => { opened.push(url) })
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await ctx.llm.loginOAuth(NS, 'cursor')

    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('loginDeepControl')
    expect(write).toHaveBeenCalledWith(authUrlFallbackMessage(opened[0] ?? ''))
    expect(spawn).not.toHaveBeenCalled()
    expect(ctx.llm.listProviders().find(provider => provider.id === 'cursor')).toMatchObject({ auth: 'oauth' })
  })

  it('falls back to the host browser opener when nothing subscribes', async () => {
    await isolateDshHome()
    scriptCursorPoll()
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = vi.fn()
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const ctx = await boot()
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await ctx.llm.loginOAuth(NS, 'cursor', new AbortController().signal)

    expect(spawn).toHaveBeenCalledTimes(1)
    const [, args] = spawn.mock.calls[0] as [string, readonly string[]]
    expect(args.join(' ')).toContain('loginDeepControl')
  })

  it('reports a failed sign-in with the provider error text, or its fallback when the error has none', async () => {
    await isolateDshHome()
    const ctx = await boot()
    const cursor = catalog.catalogProvider('cursor')
    if (cursor?.auth.oauth === undefined) throw new Error('expected cursor oauth')
    const login = vi.spyOn(cursor.auth.oauth, 'login')

    login.mockRejectedValueOnce(new Error('user denied'))
    await expect(ctx.llm.loginOAuth(NS, 'cursor')).rejects.toThrow('user denied')
    login.mockRejectedValueOnce(new Error('  '))
    await expect(ctx.llm.loginOAuth(NS, 'cursor')).rejects.toThrow(hostedOAuthProvider('cursor')?.loginFailed ?? '')
    login.mockRejectedValueOnce('not an error object')
    await expect(ctx.llm.loginOAuth(NS, 'cursor')).rejects.toThrow(hostedOAuthProvider('cursor')?.loginFailed ?? '')
    expect(ctx.llm.listProviders().find(provider => provider.id === 'cursor')).toBeUndefined()
  })

  it('refuses a provider with no hosted OAuth login', async () => {
    await isolateDshHome()
    const ctx = await boot()
    await expect(ctx.llm.loginOAuth(NS, 'openai')).rejects.toThrow(OAUTH_LOGIN_UNSUPPORTED)
  })
})

describe('API-key sign-in from the Models page', () => {
  it('stores an OpenCode Go key and makes its route live, then refuses other providers', async () => {
    await isolateDshHome()
    const ctx = await boot()
    await ctx.llm.loginApiKey(NS, OPENCODE_GO_PROVIDER, 'opencode-test-key', new AbortController().signal)
    expect(ctx.llm.listProviders().find(provider => provider.id === OPENCODE_GO_PROVIDER)).toMatchObject({ auth: 'api-key' })
    await expect(ctx.llm.loginApiKey(NS, 'openai', 'sk-test'))
      .rejects.toThrow('Only OpenCode Go supports API-key login from the Models page.')
  })
})

describe('replay degradation', () => {
  it('sends assistant history provider-neutral and warns when stored replay state is unusable', async () => {
    await isolateDshHome()
    vi.stubEnv('PI_COV_KEY', 'cov-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot({ providers: { deepseek: { apiKeyEnv: 'PI_COV_KEY', baseURL: server.url } } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await assemble(ctx, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } }),
        createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'earlier answer' }],
          source: {
            kind: 'model',
            ...{
              provider: 'deepseek',
              model: 'old',
              replayState: { response: { kind: 'pi-ai', version: 3 }, blocks: [] },
            },
          },
        }),
        createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'plugin', plugin: 'test' } }),
      ],
    })

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(JSON.stringify(server.requests[0])).toContain('earlier answer')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('route "deepseek/deepseek-v4-flash"')
    expect(String(warn.mock.calls[0]?.[0])).toContain('unsupported version 3')
  })
})

describe('refused directory swap after sign-out', () => {
  it('keeps the previous directory and logs when another registration claimed the restored entry', async () => {
    const home = await isolateDshHome()
    await storeCredentials(home, { [OPENCODE_GO_PROVIDER]: { type: 'api_key', key: 'stored-key' } })
    const ctx = await boot()
    expect(ctx.llm.listConfigurableProviders().some(entry => entry.provider === OPENCODE_GO_PROVIDER)).toBe(false)
    ctx.llm.registerConfigurableProviders([{
      provider: OPENCODE_GO_PROVIDER,
      displayName: 'Other claimant',
      settingsNs: 'other',
      settingsPath: ['providers', OPENCODE_GO_PROVIDER],
      declared: true,
    }])
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)

    await ctx.llm.logout(OPENCODE_GO_PROVIDER)

    expect(logged.mock.calls.some(([value]) =>
      typeof value === 'string' && value.includes('previous configurable-provider directory after a managed credential change'),
    )).toBe(true)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === OPENCODE_GO_PROVIDER))
      .toMatchObject({ displayName: 'Other claimant' })
    expect(ctx.llm.listProviders().some(provider => provider.id === OPENCODE_GO_PROVIDER)).toBe(false)
  })
})

