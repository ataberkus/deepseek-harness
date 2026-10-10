/** Claude Pro/Max OAuth port: authorize URL, loopback callback, paste input, exchange, refresh — never a live Anthropic API. */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthPrompt, OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai'
import {
  ANTHROPIC_AUTHORIZE_URL,
  ANTHROPIC_BOOTSTRAP_URL,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_SCOPES,
  ANTHROPIC_TOKEN_URL,
  anthropicOAuthInternals,
  claudeOAuth,
  loginClaude,
  parseCallbackInput,
  refreshClaude,
} from '../src/anthropic/oauth.ts'
import { catalogProvider, catalogProviderTakesApiKey } from '../src/catalog.ts'

const original = { ...anthropicOAuthInternals }
const blockers: Server[] = []

afterEach(async () => {
  Object.assign(anthropicOAuthInternals, original)
  await Promise.all(blockers.splice(0).map((server) => {
    server.close()
    return once(server, 'close')
  }))
})

const hasIpv6Loopback = Object.values(networkInterfaces())
  .some(addresses => addresses?.some(address => address.internal && address.family === 'IPv6'))

interface Recorded { url: string; init: RequestInit }

/** Serve the token and bootstrap endpoints from fixed replies, recording each request. */
function anthropicFetch(replies: { token?: () => Response; bootstrap?: () => Response }): Recorded[] {
  const recorded: Recorded[] = []
  anthropicOAuthInternals.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = input.toString()
    recorded.push({ url, init: init ?? {} })
    if (url === ANTHROPIC_TOKEN_URL && replies.token) return replies.token()
    if (url === ANTHROPIC_BOOTSTRAP_URL && replies.bootstrap) return replies.bootstrap()
    throw new Error(`Unhandled test fetch: ${url}`)
  }) as typeof fetch
  return recorded
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Interaction whose manual-code prompt answers from `pastes` (given the login state), then hangs until its signal aborts. */
function interaction(pastes: Array<(state: string) => string> = [], signal = new AbortController().signal) {
  const authUrl = Promise.withResolvers<URL>()
  let state = ''
  const progress: string[] = []
  const value: ProviderAuthInteraction = {
    signal,
    notify: (event) => {
      if (event.type === 'auth_url') {
        const url = new URL(event.url)
        state = url.searchParams.get('state') ?? ''
        authUrl.resolve(url)
      }
      if (event.type === 'progress') progress.push(event.message)
    },
    prompt: (prompt: AuthPrompt) => {
      const paste = pastes.shift()
      if (paste !== undefined) return Promise.resolve(paste(state))
      const pending = Promise.withResolvers<string>()
      prompt.signal?.addEventListener('abort', () => { pending.reject(prompt.signal?.reason) }, { once: true })
      return pending.promise
    },
  }
  return { value, authUrl: authUrl.promise, progress }
}

async function occupy(host: string): Promise<number> {
  const server = createServer()
  blockers.push(server)
  server.listen(0, host)
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

function tokenBody(recorded: Recorded[], index = 0): Record<string, string> {
  return JSON.parse(recorded[index]?.init.body as string) as Record<string, string>
}

describe('claude oauth catalog wiring', () => {
  it('replaces the catalog anthropic OAuth method and keeps its api-key method', async () => {
    const provider = catalogProvider('anthropic')
    expect(provider?.auth.oauth).toBe(claudeOAuth)
    expect(catalogProviderTakesApiKey('anthropic')).toBe(true)
    expect(claudeOAuth.isSubscription).toBe(true)
    await expect(claudeOAuth.toAuth({ type: 'oauth', access: 'sk-ant-oat-x', refresh: 'r', expires: 0 }))
      .resolves.toEqual({ apiKey: 'sk-ant-oat-x' })
  })
})

describe('claude oauth login', () => {
  it('signs in through the loopback callback, ignoring forged and stale redirects', async () => {
    anthropicOAuthInternals.callbackPort = 0
    const recorded = anthropicFetch({
      token: () => json({
        access_token: 'sk-ant-oat-access',
        refresh_token: 'sk-ant-ort-refresh',
        expires_in: 3600,
        account: { uuid: 'acct-1', email_address: 'user@example.com' },
        organization: { uuid: 'org-1', name: 'Personal' },
      }),
    })
    const ui = interaction()
    const before = Date.now()
    const login = loginClaude(ui.value)
    const url = await ui.authUrl

    expect(url.origin + url.pathname).toBe(ANTHROPIC_AUTHORIZE_URL)
    expect(url.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(ANTHROPIC_OAUTH_SCOPES)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code')).toBe('true')
    const state = url.searchParams.get('state') ?? ''
    expect(state).toMatch(/^[0-9a-f]{32}$/)
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
    expect(redirect.hostname).toBe('localhost')
    expect(redirect.pathname).toBe('/callback')

    const callback = (query: string) => fetch(`${redirect.href}?${query}`)
    expect((await fetch(new URL('/other', redirect))).status).toBe(404)
    expect((await callback('error=access_denied')).status).toBe(400)
    expect((await callback('error=access_denied&state=forged')).status).toBe(400)
    expect((await callback(`state=${state}`)).status).toBe(400)
    expect((await callback('code=stale&state=other')).status).toBe(400)
    expect((await callback(`code=good%23echoed&state=${state}`)).status).toBe(200)

    const credential = await login
    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'sk-ant-oat-access',
      refresh: 'sk-ant-ort-refresh',
      accountId: 'acct-1',
      email: 'user@example.com',
      orgId: 'org-1',
      orgName: 'Personal',
    })
    expect(credential.expires).toBeGreaterThanOrEqual(before + 3600_000 - 300_000)
    expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 300_000)
    expect(recorded.map(request => request.url)).toEqual([ANTHROPIC_TOKEN_URL])
    const body = tokenBody(recorded)
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: 'good',
      state: 'echoed',
      redirect_uri: redirect.href,
    })
    expect(createHash('sha256').update(body.code_verifier ?? '').digest('base64url'))
      .toBe(url.searchParams.get('code_challenge'))
    expect(ui.progress).toEqual(['Exchanging authorization code for tokens...'])
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('accepts a pasted code#state, re-prompting past unusable input, and fills identity from bootstrap', async () => {
    anthropicOAuthInternals.callbackPort = 0
    const recorded = anthropicFetch({
      token: () => json({ access_token: 'sk-ant-oat-a', refresh_token: 'r1', expires_in: 60 }),
      bootstrap: () => json({
        oauth_account: {
          account_uuid: 'acct-2',
          account_email: 'b@example.com',
          organization_uuid: 'org-2',
          organization_name: 'Team',
        },
      }),
    })
    const ui = interaction([
      () => '',
      () => 'https://localhost/callback?code=x&state=wrong',
      state => `pasted#${state}`,
    ])
    const credential = await loginClaude(ui.value)

    const url = await ui.authUrl
    expect(tokenBody(recorded)).toMatchObject({ code: 'pasted', state: url.searchParams.get('state') })
    expect(credential).toMatchObject({ accountId: 'acct-2', email: 'b@example.com', orgId: 'org-2', orgName: 'Team' })
    const bootstrap = new Headers(recorded[1]?.init.headers)
    expect(bootstrap.get('Authorization')).toBe('Bearer sk-ant-oat-a')
    expect(bootstrap.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(bootstrap.get('User-Agent')).toBe('claude-code/2.1.280')
  })

  it.each([
    ['error=access_denied&error_description=denied', 'Claude authorization failed: denied'],
    ['error=access_denied', 'Claude authorization failed: access_denied'],
  ])('fails when consent is denied with this login state (%s)', async (query, message) => {
    anthropicOAuthInternals.callbackPort = 0
    anthropicFetch({})
    const ui = interaction()
    const login = loginClaude(ui.value)
    const url = await ui.authUrl
    const state = url.searchParams.get('state') ?? ''
    const failed = expect(login).rejects.toThrow(message)
    await fetch(`${url.searchParams.get('redirect_uri') ?? ''}?${query}&state=${state}`)
    await failed
  })

  it('falls back to a random port when the preferred one is held', async () => {
    const busy = await occupy('127.0.0.1')
    anthropicOAuthInternals.callbackPort = busy
    anthropicFetch({})
    const controller = new AbortController()
    const ui = interaction([], controller.signal)
    const login = loginClaude(ui.value)
    const redirect = new URL((await ui.authUrl).searchParams.get('redirect_uri') ?? '')
    expect(Number(redirect.port)).not.toBe(busy)
    controller.abort(new Error('user cancelled'))
    await expect(login).rejects.toThrow('user cancelled')
  })

  it.runIf(hasIpv6Loopback)('treats a port held on ::1 as busy', async () => {
    const busy = await occupy('::1')
    anthropicOAuthInternals.callbackPort = busy
    anthropicFetch({})
    const controller = new AbortController()
    const ui = interaction([], controller.signal)
    const login = loginClaude(ui.value)
    expect(Number(new URL((await ui.authUrl).searchParams.get('redirect_uri') ?? '').port)).not.toBe(busy)
    controller.abort()
    await expect(login).rejects.toThrow()
  })

  it('surfaces a callback bind failure that is not a busy port', async () => {
    anthropicOAuthInternals.callbackPort = -1
    await expect(loginClaude(interaction().value)).rejects.toThrow()
  })

  it('times out without a callback or paste', async () => {
    anthropicOAuthInternals.callbackPort = 0
    anthropicOAuthInternals.callbackTimeoutMs = 20
    await expect(loginClaude(interaction().value)).rejects.toThrow(/timeout/i)
  })

  it('stops waiting when the host cancels while opening the authorize URL', async () => {
    anthropicOAuthInternals.callbackPort = 0
    const controller = new AbortController()
    const ui = interaction([], controller.signal)
    const notify = ui.value.notify.bind(ui.value)
    ui.value.notify = (event) => {
      notify(event)
      controller.abort(new Error('closed tab'))
    }
    await expect(loginClaude(ui.value)).rejects.toThrow('closed tab')
  })

  it('refuses to start after the login is aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(loginClaude(interaction([], controller.signal).value)).rejects.toThrow('gone')
  })
})

describe('claude oauth refresh', () => {
  const stored: OAuthCredential = {
    type: 'oauth',
    access: 'old',
    refresh: 'refresh-old',
    expires: 0,
    accountId: 'acct-1',
    email: 'user@example.com',
    orgId: 'org-1',
    orgName: 'Personal',
  }

  it('sends Claude Code refresh headers and keeps the stored refresh token and organization', async () => {
    const recorded = anthropicFetch({
      token: () => json({ access_token: 'new', expires_in: 3600, organization: { uuid: 'org-other' } }),
    })
    const refreshed = await refreshClaude(stored, new AbortController().signal)
    expect(refreshed).toMatchObject({ access: 'new', refresh: 'refresh-old', accountId: 'acct-1', orgId: 'org-1' })
    expect(tokenBody(recorded)).toEqual({
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: 'refresh-old',
    })
    const headers = new Headers(recorded[0]?.init.headers)
    expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(headers.get('User-Agent')).toBe('anthropic-sdk-typescript/0.112.1 userOAuthProvider')
    expect(recorded).toHaveLength(1)
  })

  it('looks up missing account identity without touching the organization, and tolerates bootstrap failure', async () => {
    const partial: OAuthCredential = { type: 'oauth', access: 'a', refresh: 'r', expires: 0, orgId: 'org-1' }
    anthropicFetch({
      token: () => json({ access_token: 'new', refresh_token: 'r2', expires_in: 1 }),
      bootstrap: () => json({ oauth_account: { account_uuid: 'acct-9', organization_uuid: 'org-9' } }),
    })
    expect(await refreshClaude(partial, new AbortController().signal))
      .toMatchObject({ refresh: 'r2', accountId: 'acct-9', orgId: 'org-1' })

    for (const bootstrap of [
      () => { throw new Error('offline') },
      () => json({}, 500),
      () => new Response('not json'),
      () => json('string body'),
    ]) {
      anthropicFetch({ token: () => json({ access_token: 'new', expires_in: 1 }), bootstrap })
      const refreshed = await refreshClaude(partial, new AbortController().signal)
      expect(refreshed.accountId).toBeUndefined()
    }
  })

  it('reports token endpoint failures', async () => {
    const signal = new AbortController().signal
    anthropicFetch({ token: () => json({ error: 'invalid_grant' }, 400) })
    await expect(refreshClaude(stored, signal)).rejects.toThrow('Claude token refresh failed: 400 {"error":"invalid_grant"}')
    anthropicFetch({ token: () => new Response('<html>') })
    await expect(refreshClaude(stored, signal)).rejects.toThrow('Claude token refresh returned invalid JSON')
    anthropicFetch({ token: () => json({ expires_in: 1 }) })
    await expect(refreshClaude(stored, signal)).rejects.toThrow('missing access_token')
    anthropicFetch({ token: () => json({ access_token: 'a' }) })
    await expect(refreshClaude(stored, signal)).rejects.toThrow('missing expires_in')
  })
})

describe('parseCallbackInput', () => {
  it('reads redirect URLs, query strings, and code#state pastes', () => {
    expect(parseCallbackInput('  ')).toEqual({})
    expect(parseCallbackInput('http://localhost:54545/callback?code=c&state=s')).toEqual({ code: 'c', state: 's' })
    expect(parseCallbackInput('http://localhost:54545/callback')).toEqual({})
    expect(parseCallbackInput('?code=c')).toEqual({ code: 'c' })
    expect(parseCallbackInput('c#s')).toEqual({ code: 'c', state: 's' })
    expect(parseCallbackInput('c')).toEqual({ code: 'c' })
  })
})
