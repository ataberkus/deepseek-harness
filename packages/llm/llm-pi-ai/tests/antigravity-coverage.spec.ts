/** Antigravity OAuth, request, and stream edge-case fixtures. Scripted fetch and loopback only; never a live Google API. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, AssistantMessageEvent, Context as PiContext, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import {
  GOOGLE_ANTIGRAVITY_BASE_URL,
  GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL,
  GOOGLE_ANTIGRAVITY_PROJECT_HEADER,
  GOOGLE_ANTIGRAVITY_TOKEN_URL,
} from '../src/google-antigravity/constants.ts'
import { antigravityModel } from '../src/google-antigravity/models.ts'
import {
  antigravityOAuthInternals,
  completeAntigravityLogin,
  createAntigravityCallbackServer,
  discoverProject,
  refreshAntigravityToken,
} from '../src/google-antigravity/oauth.ts'
import { loginAntigravity, toAntigravityAuth } from '../src/google-antigravity/provider.ts'
import { buildAntigravityRequest } from '../src/google-antigravity/request.ts'
import { antigravityStreamInternals, streamAntigravity } from '../src/google-antigravity/stream.ts'

const originalOAuthFetch = antigravityOAuthInternals.fetch
const originalSleep = antigravityOAuthInternals.sleep
const originalCreateServer = antigravityOAuthInternals.createLoopbackServer
const originalStreamFetch = antigravityStreamInternals.fetch

afterEach(() => {
  antigravityOAuthInternals.fetch = originalOAuthFetch
  antigravityOAuthInternals.sleep = originalSleep
  antigravityOAuthInternals.createLoopbackServer = originalCreateServer
  antigravityStreamInternals.fetch = originalStreamFetch
})

const REDIRECT = 'http://127.0.0.1:51121/oauth-callback'

function reasoningModel(): Model<Api> {
  return antigravityModel('gemini-3.7-flash', 'Gemini 3.7 Flash', true)
}

function plainModel(): Model<Api> {
  return antigravityModel('gpt-oss-120b', 'GPT OSS', false)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

function scripted(handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  })
}

function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : ''
}

/** Reject with a value that is deliberately not an Error, as a misbehaving transport might. */
function rejectWith(reason: string): Promise<never> {
  return Promise.reject(Object.assign(Object(reason), {}) as Error)
}

const TOKEN_OK = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }

/** Install a fetch where each URL substring maps to one response factory. */
function routes(table: Record<string, () => Response | Promise<Response>>): void {
  antigravityOAuthInternals.fetch = scripted((url) => {
    for (const [needle, make] of Object.entries(table)) {
      if (url.includes(needle)) return make()
    }
    throw new Error(`Unhandled test fetch: ${url}`)
  })
}

describe('antigravity token endpoint', () => {
  it('reports a non-OK refresh reply with its text', async () => {
    routes({ [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => new Response('invalid_grant', { status: 400 }) })
    await expect(
      refreshAntigravityToken({ type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: 'p' }),
    ).rejects.toThrow('Antigravity token refresh failed: invalid_grant')
  })

  it.each([
    ['a non-object', 'null', 'Invalid JSON from token refresh: expected object'],
    ['a missing access token', '{"expires_in":10}', 'Invalid JSON from token refresh: missing access_token'],
    ['an empty access token', '{"access_token":"","expires_in":10}', 'Invalid JSON from token refresh: missing access_token'],
    ['a missing expiry', '{"access_token":"x"}', 'Invalid JSON from token refresh: missing expires_in'],
    ['a non-finite expiry', '{"access_token":"x","expires_in":"soon"}', 'Invalid JSON from token refresh: missing expires_in'],
  ])('rejects a refresh reply with %s', async (_label, body, message) => {
    routes({ [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => new Response(body, { status: 200 }) })
    await expect(
      refreshAntigravityToken({ type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: 'p' }),
    ).rejects.toThrow(message)
  })

  it('names the token exchange in malformed exchange replies', async () => {
    routes({ [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => new Response('"text"', { status: 200 }) })
    await expect(completeAntigravityLogin('code', REDIRECT)).rejects.toThrow(
      'Invalid JSON from token exchange: expected object',
    )
  })

  it('rejects an unparseable token body', async () => {
    routes({ [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => new Response('not json', { status: 200 }) })
    await expect(
      refreshAntigravityToken({ type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: 'p' }),
    ).rejects.toThrow()
  })

  it('computes expiry with a five-minute skew and treats an empty refresh token as absent', async () => {
    routes({
      [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => json(200, { access_token: 'n', refresh_token: '', expires_in: 3600 }),
    })
    const before = Date.now()
    const refreshed = await refreshAntigravityToken({
      type: 'oauth',
      access: 'a',
      refresh: 'kept',
      expires: 1,
      projectId: 'p',
    })
    const after = Date.now()
    expect(refreshed.refresh).toBe('kept')
    expect(refreshed.expires).toBeGreaterThanOrEqual(before + 3600_000 - 300_000)
    expect(refreshed.expires).toBeLessThanOrEqual(after + 3600_000 - 300_000)
  })

  it('drops a non-string stored email on refresh', async () => {
    routes({ [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => json(200, TOKEN_OK) })
    const refreshed = await refreshAntigravityToken({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
      projectId: 'p',
      email: 42,
    })
    expect(refreshed).not.toHaveProperty('email')
  })

  it('sends the grant as a form body', async () => {
    let seen: { body?: string; contentType?: string } = {}
    antigravityOAuthInternals.fetch = scripted((_url, init) => {
      seen = {
        body: bodyOf(init),
        contentType: new Headers(init?.headers).get('Content-Type') ?? undefined,
      }
      return json(200, TOKEN_OK)
    })
    await refreshAntigravityToken({ type: 'oauth', access: 'a', refresh: 'old-ref', expires: 1, projectId: 'p' })
    const form = new URLSearchParams(seen.body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('old-ref')
    expect(seen.contentType).toBe('application/x-www-form-urlencoded')
  })
})

describe('antigravity login email lookup', () => {
  const userinfo = (make: () => Response | Promise<Response>) => ({
    [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => json(200, TOKEN_OK),
    userinfo: make,
    loadCodeAssist: () => json(200, { cloudaicompanionProject: 'proj' }),
  })

  it.each([
    ['a non-OK reply', () => new Response('no', { status: 401 })],
    ['a null body', () => json(200, null)],
    ['a body without email', () => json(200, { name: 'x' })],
    ['a non-string email', () => json(200, { email: 7 })],
    ['a blank email', () => json(200, { email: '   ' })],
    ['a transport failure', () => { throw new Error('offline') }],
  ])('omits email after %s', async (_label, make) => {
    routes(userinfo(make))
    const credential = await completeAntigravityLogin('code', REDIRECT)
    expect(credential).not.toHaveProperty('email')
    expect(credential.projectId).toBe('proj')
  })

  it('trims the reported email', async () => {
    routes(userinfo(() => json(200, { email: '  me@example.com ' })))
    expect((await completeAntigravityLogin('code', REDIRECT)).email).toBe('me@example.com')
  })
})

describe('antigravity project discovery', () => {
  it.each([
    ['a plain string', { cloudaicompanionProject: ' proj-a ' }, 'proj-a'],
    ['an object id', { cloudaicompanionProject: { id: 'proj-b' } }, 'proj-b'],
    ['the projectId field', { projectId: 'proj-c' }, 'proj-c'],
    ['the project field', { project: { id: 'proj-d' } }, 'proj-d'],
    ['a later field after a blank string', { cloudaicompanionProject: '  ', projectId: 'proj-e' }, 'proj-e'],
    ['a later field after a blank object id', { cloudaicompanionProject: { id: ' ' }, project: 'proj-f' }, 'proj-f'],
  ])('uses %s from loadCodeAssist', async (_label, payload, expected) => {
    routes({ loadCodeAssist: () => json(200, payload) })
    await expect(discoverProject('tok')).resolves.toBe(expected)
  })

  it('falls back to the second endpoint after a non-OK first reply', async () => {
    const hosts: string[] = []
    antigravityOAuthInternals.fetch = scripted((url) => {
      hosts.push(url)
      if (url.startsWith(GOOGLE_ANTIGRAVITY_BASE_URL)) return new Response('', { status: 503 })
      return json(200, { projectId: 'fallback-proj' })
    })
    await expect(discoverProject('tok')).resolves.toBe('fallback-proj')
    expect(hosts[1]?.startsWith(GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL)).toBe(true)
  })

  it('reports unknown error text when every endpoint fails with an empty body', async () => {
    routes({ loadCodeAssist: () => new Response('', { status: 502 }) })
    await expect(discoverProject('tok')).rejects.toThrow('loadCodeAssist failed: 502: unknown error')
  })

  it('surfaces an abort raised during loadCodeAssist', async () => {
    const controller = new AbortController()
    antigravityOAuthInternals.fetch = scripted(() => {
      controller.abort('stop')
      throw new Error('fetch aborted')
    })
    await expect(discoverProject('tok', controller.signal)).rejects.toThrow('Antigravity login aborted')
  })

  it('proceeds to onboarding after transport failures on both endpoints', async () => {
    let onboardBody: Record<string, unknown> = {}
    let onboardHeaders: Headers | undefined
    antigravityOAuthInternals.fetch = scripted((url, init) => {
      if (url.includes('loadCodeAssist')) {
        // Both endpoints fail: one with an Error, one with a bare string.
        if (url.startsWith(GOOGLE_ANTIGRAVITY_BASE_URL)) throw new Error('refused')
        return rejectWith('plain failure')
      }
      onboardBody = JSON.parse(bodyOf(init)) as Record<string, unknown>
      onboardHeaders = new Headers(init?.headers)
      return json(200, { done: true, response: { cloudaicompanionProject: { id: 'onboarded' } } })
    })
    await expect(discoverProject('tok')).resolves.toBe('onboarded')
    expect(onboardBody.tier_id).toBe('free-tier')
    expect(onboardHeaders?.get('User-Agent')).toContain('google-api-nodejs-client')
    expect(onboardHeaders?.get('Authorization')).toBe('Bearer tok')
  })

  it.each([
    ['the default allowed tier', { allowedTiers: [{ id: 'other' }, { id: ' paid ', isDefault: true }] }, 'paid'],
    ['the current tier when no allowed tier is default', { allowedTiers: [{ id: 'x' }], currentTier: { id: ' cur ' } }, 'cur'],
    ['the current tier when the default has a blank id', { allowedTiers: [{ id: ' ', isDefault: true }], currentTier: { id: 'cur2' } }, 'cur2'],
    ['the free tier for an empty allowed list and blank current id', { allowedTiers: [], currentTier: { id: ' ' } }, 'free-tier'],
    ['the free tier when nothing is advertised', {}, 'free-tier'],
  ])('onboards with %s', async (_label, load, tier) => {
    let sent: Record<string, unknown> = {}
    antigravityOAuthInternals.fetch = scripted((url, init) => {
      if (url.includes('loadCodeAssist')) return json(200, load)
      sent = JSON.parse(bodyOf(init)) as Record<string, unknown>
      return json(200, { done: true, response: { project: 'p-onboard' } })
    })
    await expect(discoverProject('tok')).resolves.toBe('p-onboard')
    expect(sent.tier_id).toBe(tier)
  })

  it('reports a non-OK onboardUser reply', async () => {
    routes({
      loadCodeAssist: () => json(200, {}),
      onboardUser: () => new Response('nope', { status: 403, statusText: 'Forbidden' }),
    })
    await expect(discoverProject('tok')).rejects.toThrow('onboardUser failed: 403 Forbidden: nope')
  })

  it('polls onboarding until the attempt limit when no project is provisioned', async () => {
    let calls = 0
    const sleeps: number[] = []
    antigravityOAuthInternals.sleep = async (ms) => {
      sleeps.push(ms)
    }
    routes({
      loadCodeAssist: () => json(200, {}),
      onboardUser: () => {
        calls++
        // Alternate between "not done" and "done without a project".
        return json(200, calls % 2 === 0 ? { done: true, response: {} } : { done: false })
      },
    })
    await expect(discoverProject('tok')).rejects.toThrow(
      'onboardUser did not return a provisioned project id after 5 attempts',
    )
    expect(calls).toBe(5)
    expect(sleeps).toEqual([2000, 2000, 2000, 2000])
  })

  it('ignores a non-object onboard response', async () => {
    routes({
      loadCodeAssist: () => json(200, {}),
      onboardUser: () => json(200, { done: true, response: 'text' }),
    })
    antigravityOAuthInternals.sleep = async () => {}
    await expect(discoverProject('tok')).rejects.toThrow('did not return a provisioned project id')
  })
})

describe('antigravity sleep', () => {
  it('resolves after the delay', async () => {
    await expect(antigravityOAuthInternals.sleep(1)).resolves.toBeUndefined()
  })

  it('resolves with a live signal and detaches its listener', async () => {
    const controller = new AbortController()
    await antigravityOAuthInternals.sleep(1, controller.signal)
    controller.abort()
  })

  it('rejects immediately for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort('early')
    await expect(antigravityOAuthInternals.sleep(60_000, controller.signal)).rejects.toThrow(
      'Antigravity login aborted',
    )
  })

  it('rejects when the signal aborts during the wait', async () => {
    const controller = new AbortController()
    const waiting = antigravityOAuthInternals.sleep(60_000, controller.signal)
    controller.abort('later')
    await expect(waiting).rejects.toMatchObject({ message: 'Antigravity login aborted', cause: 'later' })
  })
})

describe('antigravity loopback callback server', () => {
  it('rejects waiting when the signal is already aborted', async () => {
    const server = await createAntigravityCallbackServer(0)
    const controller = new AbortController()
    controller.abort('pre')
    await expect(server.waitForCallback(controller.signal)).rejects.toThrow('Antigravity login aborted')
  })

  it('keeps the first callback when Google redirects twice', async () => {
    const server = await createAntigravityCallbackServer(0)
    await fetch(`${server.redirectUri}?code=first`)
    await fetch(`${server.redirectUri}?code=second`)
    await expect(server.waitForCallback()).resolves.toBe('first')
  })

  it('removes the abort listener once a code arrives', async () => {
    const server = await createAntigravityCallbackServer(0)
    const controller = new AbortController()
    const waiting = server.waitForCallback(controller.signal)
    await fetch(`${server.redirectUri}?code=ok`)
    await expect(waiting).resolves.toBe('ok')
  })

  it('treats an empty code as missing', async () => {
    const server = await createAntigravityCallbackServer(0)
    const waiting = server.waitForCallback()
    const assertion = expect(waiting).rejects.toThrow('missing code query parameter')
    expect((await fetch(`${server.redirectUri}?code=`)).status).toBe(400)
    await assertion
  })

  it('fails to start when the port is taken', async () => {
    const first = await createAntigravityCallbackServer(0)
    try {
      const port = Number(new URL(first.redirectUri).port)
      await expect(createAntigravityCallbackServer(port)).rejects.toThrow()
    } finally {
      await first.close()
    }
  })
})

describe('antigravity provider login', () => {
  it('closes the loopback server and propagates an exchange failure', async () => {
    const server = await createAntigravityCallbackServer(0)
    let closed = false
    antigravityOAuthInternals.createLoopbackServer = async () => ({
      ...server,
      close: async () => {
        closed = true
        await server.close()
      },
    })
    routes({ [GOOGLE_ANTIGRAVITY_TOKEN_URL]: () => new Response('denied', { status: 400 }) })
    const interaction = {
      signal: new AbortController().signal,
      notify: () => undefined,
      prompt: () => Promise.reject(new Error('unused')),
    }
    const failure = expect(loginAntigravity(interaction)).rejects.toThrow('Token exchange failed: denied')
    await fetch(`${server.redirectUri}?code=c`)
    await failure
    expect(closed).toBe(true)
  })

  it('rejects auth for a credential without projectId', async () => {
    await expect(toAntigravityAuth({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })).rejects.toThrow(
      'missing projectId',
    )
  })

  it('binds the production loopback factory on the requested port', async () => {
    const server = await antigravityOAuthInternals.createLoopbackServer(0)
    try {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/)
    } finally {
      await server.close()
    }
  })

  it('closes the loopback server when the user aborts', async () => {
    const server = await createAntigravityCallbackServer(0)
    antigravityOAuthInternals.createLoopbackServer = async () => server
    const controller = new AbortController()
    const interaction = {
      signal: controller.signal,
      notify: () => {
        controller.abort('cancel')
      },
      prompt: () => Promise.reject(new Error('unused')),
    }
    await expect(loginAntigravity(interaction)).rejects.toThrow('Antigravity login aborted')
  })
})

describe('antigravity request building', () => {
  const userContext = (content: PiContext['messages'][number]): PiContext => ({ messages: [content] })

  it('derives a stable session id from the first non-blank user text', () => {
    const ctx: PiContext = {
      messages: [
        { role: 'user', content: '   ', timestamp: 0 },
        { role: 'user', content: 'same text', timestamp: 0 },
      ],
    }
    const a = buildAntigravityRequest(plainModel(), ctx, 'p').request.sessionId
    const b = buildAntigravityRequest(plainModel(), ctx, 'p').request.sessionId
    expect(a).toBe(b)
    expect(a).toMatch(/^-\d+$/)
  })

  it('hashes the first text part of block content and skips images', () => {
    const blocks = buildAntigravityRequest(
      plainModel(),
      userContext({
        role: 'user',
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'same text' },
        ],
        timestamp: 0,
      }),
      'p',
    )
    const plain = buildAntigravityRequest(plainModel(), userContext({ role: 'user', content: 'same text', timestamp: 0 }), 'p')
    expect(blocks.request.sessionId).toBe(plain.request.sessionId)
  })

  it('uses a random session id when no user message carries text', () => {
    const ctx: PiContext = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ignored: not a user message' }],
          api: 'google-generative-ai',
          provider: 'google-antigravity',
          model: 'm',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 0,
        },
        { role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 0 },
      ],
    }
    const a = buildAntigravityRequest(plainModel(), ctx, 'p').request.sessionId
    const b = buildAntigravityRequest(plainModel(), ctx, 'p').request.sessionId
    expect(a).toMatch(/^-\d+$/)
    expect(a).not.toBe(b)
  })

  it('omits optional sections when the context and options are bare', () => {
    const req = buildAntigravityRequest(plainModel(), { messages: [], systemPrompt: '', tools: [] }, 'p')
    expect(req.request.systemInstruction).toBeUndefined()
    expect(req.request.tools).toBeUndefined()
    expect(req.request.toolConfig).toBeUndefined()
    expect(req.request.generationConfig).toBeUndefined()
  })

  it('sets only the sampling options that were given', () => {
    const onlyTemp = buildAntigravityRequest(plainModel(), { messages: [] }, 'p', { temperature: 0 })
    expect(onlyTemp.request.generationConfig).toEqual({ temperature: 0 })
    const onlyTokens = buildAntigravityRequest(plainModel(), { messages: [] }, 'p', { maxTokens: 10 })
    expect(onlyTokens.request.generationConfig).toEqual({ maxOutputTokens: 10 })
  })

  it('does not request thoughts from non-reasoning models even with a reasoning level', () => {
    const req = buildAntigravityRequest(plainModel(), { messages: [] }, 'p', { reasoning: 'high' })
    expect(req.request.generationConfig).toBeUndefined()
  })

  it('requests thoughts without a level when no reasoning option is given', () => {
    const req = buildAntigravityRequest(reasoningModel(), { messages: [] }, 'p')
    expect(req.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it.each([
    ['minimal', 'MINIMAL'],
    ['low', 'LOW'],
    ['medium', 'MEDIUM'],
    ['high', 'HIGH'],
    ['xhigh', 'HIGH'],
  ] as Array<[ThinkingLevel, string]>)('maps reasoning %s to %s', (level, wire) => {
    const req = buildAntigravityRequest(reasoningModel(), { messages: [] }, 'p', { reasoning: level })
    expect(req.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: wire })
  })

  it('maps an unrecognized reasoning level to HIGH', () => {
    const req = buildAntigravityRequest(reasoningModel(), { messages: [] }, 'p', {
      reasoning: 'unknown' as ThinkingLevel,
    })
    expect(req.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH')
  })
})

interface Gate {
  push: (text: string) => void
  close: () => void
  fail: (reason: unknown) => void
  response: Response
}

/** A 200 SSE response whose body is fed by the test. */
function gatedSse(): Gate {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    push: (text) => {
      controller.enqueue(encoder.encode(text))
    },
    close: () => {
      controller.close()
    },
    fail: (reason) => {
      controller.error(reason)
    },
    response: new Response(body, { status: 200 }),
  }
}

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const parts = (...p: unknown[]) => ({ response: { candidates: [{ content: { parts: p } }] } })
const withFinish = (finishReason: string, ...p: unknown[]) => ({
  response: { candidates: [{ content: { parts: p }, finishReason }] },
})

function sse(...frames: string[]): Response {
  return new Response(frames.join(''), { status: 200 })
}

const CREDS = { apiKey: 'tok', headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'proj' } }
const CONTEXT: PiContext = { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }

async function run(
  options: Parameters<typeof streamAntigravity>[2] = CREDS,
  m: Model<Api> = reasoningModel(),
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of streamAntigravity(m, CONTEXT, options)) events.push(event)
  return events
}

function terminal(events: AssistantMessageEvent[]): AssistantMessageEvent {
  const last = events.at(-1)
  if (last === undefined) throw new Error('stream produced no events')
  return last
}

function errorOf(events: AssistantMessageEvent[]): { reason: string; message?: string; stopReason: string } {
  const last = terminal(events)
  if (last.type !== 'error') throw new Error(`expected error, got ${last.type}`)
  return { reason: last.reason, message: last.error.errorMessage, stopReason: last.error.stopReason }
}

describe('antigravity stream credentials and transport', () => {
  it('accepts a bearer Authorization header with either casing and sends the project in the body', async () => {
    const seen: Array<{ headers: Headers; body: { project: string; model: string } }> = []
    antigravityStreamInternals.fetch = scripted((_url, init) => {
      seen.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(bodyOf(init)) as { project: string; model: string },
      })
      return sse(frame(withFinish('STOP', { text: 'ok' })))
    })
    const claude = antigravityModel('claude-sonnet-4-6', 'Claude', true)
    await run({ headers: { Authorization: 'Bearer  upper ', [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'proj-1' } }, claude)
    await run({ headers: { authorization: 'Bearer lower', [GOOGLE_ANTIGRAVITY_PROJECT_HEADER.toLowerCase()]: 'proj-2' } })
    expect(seen[0]?.headers.get('Authorization')).toBe('Bearer upper')
    expect(seen[0]?.headers.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14')
    expect(seen[0]?.headers.get('Accept')).toBe('text/event-stream')
    expect(seen[0]?.body).toMatchObject({ project: 'proj-1', model: 'claude-sonnet-4-6' })
    expect(seen[1]?.headers.get('Authorization')).toBe('Bearer lower')
    expect(seen[1]?.headers.get('anthropic-beta')).toBeNull()
    expect(seen[1]?.body.project).toBe('proj-2')
  })

  it.each([
    ['an empty api key and no header', { apiKey: '', headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'p' } }],
    ['a non-bearer Authorization header', { headers: { Authorization: 'Basic abc', [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'p' } }],
    ['no project header', { apiKey: 'tok', headers: { other: 'x' } }],
    ['an empty project header', { apiKey: 'tok', headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: '' } }],
    ['no headers', { apiKey: 'tok' }],
  ])('refuses to call the API with %s', async (_label, options) => {
    let called = false
    antigravityStreamInternals.fetch = scripted(() => {
      called = true
      return sse()
    })
    const failure = errorOf(await run(options))
    expect(failure.message).toContain('Provider is not configured: google-antigravity')
    expect(called).toBe(false)
  })

  it('ends with an aborted error without calling the API when already aborted', async () => {
    let called = false
    antigravityStreamInternals.fetch = scripted(() => {
      called = true
      return sse()
    })
    const controller = new AbortController()
    controller.abort()
    const events = await run({ ...CREDS, signal: controller.signal })
    expect(events).toHaveLength(1)
    const failure = errorOf(events)
    expect(failure).toMatchObject({ stopReason: 'aborted', message: 'Request was aborted' })
    expect(called).toBe(false)
  })

  it('reports the last endpoint failure with its status and body', async () => {
    antigravityStreamInternals.fetch = scripted(() => new Response('quota', { status: 429 }))
    const failure = errorOf(await run())
    expect(failure.stopReason).toBe('error')
    expect(failure.message).toBe('Cloud Code Assist API error (429): quota')
  })

  it('rethrows the last transport Error after both endpoints fail', async () => {
    let calls = 0
    antigravityStreamInternals.fetch = scripted(() => {
      calls++
      throw new Error(`down ${calls}`)
    })
    expect(errorOf(await run()).message).toBe('down 2')
  })

  it('wraps a non-Error transport failure', async () => {
    antigravityStreamInternals.fetch = (() => rejectWith('plain'))
    expect(errorOf(await run()).message).toBe('Cloud Code Assist API error: plain')
  })

  it('reports an abort that interrupts the request as aborted, passing the signal to fetch', async () => {
    const controller = new AbortController()
    let received: AbortSignal | null | undefined
    antigravityStreamInternals.fetch = scripted((_url, init) => {
      received = init?.signal
      controller.abort()
      throw new Error('aborted by caller')
    })
    const failure = errorOf(await run({ ...CREDS, signal: controller.signal }))
    expect(failure.stopReason).toBe('aborted')
    expect(received).toBe(controller.signal)
  })

  it('fails when a successful reply has no body', async () => {
    antigravityStreamInternals.fetch = scripted(() => new Response(null, { status: 200 }))
    expect(errorOf(await run()).message).toBe('Cloud Code Assist API returned no response body')
  })
})

describe('antigravity stream payload handling', () => {
  it('fails on a stream error payload using message, status, or a generic label', async () => {
    const cases: Array<[unknown, string]> = [
      [{ error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 'Quota exceeded'],
      [{ error: { status: 'UNAVAILABLE' } }, 'UNAVAILABLE'],
      [{ error: {} }, 'unknown error'],
    ]
    for (const [payload, detail] of cases) {
      antigravityStreamInternals.fetch = scripted(() => sse(frame(payload)))
      expect(errorOf(await run()).message).toBe(`Cloud Code Assist stream error: ${detail}`)
    }
  })

  it('fails when the prompt is blocked, with and without a message', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(frame({ response: { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'unsafe' } } })))
    expect(errorOf(await run()).message).toBe('Request blocked by Google (SAFETY): unsafe')
    antigravityStreamInternals.fetch = scripted(() => sse(frame({ response: { promptFeedback: { blockReason: 'OTHER' } } })))
    expect(errorOf(await run()).message).toBe('Request blocked by Google (OTHER)')
  })

  it('skips chunks without a response and non-object chunks', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse('data: 5\n\n', 'data: null\n\n', frame({}), frame({ traceId: 'x' }), frame(withFinish('STOP', { text: 'after' }))))
    const done = terminal(await run())
    expect(done.type).toBe('done')
    if (done.type === 'done') expect(done.message.content).toEqual([{ type: 'text', text: 'after' }])
  })

  it('ignores comments, unparseable data, empty data, and non-data lines in an event', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(
        ': keepalive\n\n',
        'data: not-json\n\n',
        'data:\n\n',
        `event: message\nid: 1\ndata: ${JSON.stringify(withFinish('STOP', { text: 'kept' }))}\n\n`,
      ))
    const done = terminal(await run())
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.message.content).toEqual([{ type: 'text', text: 'kept' }])
  })

  it('reassembles events split across reads, including a split multibyte character', async () => {
    const bytes = new TextEncoder().encode(frame(withFinish('STOP', { text: 'héllo' })))
    const cut = bytes.indexOf(0xc3) + 1
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut))
        c.enqueue(bytes.slice(cut, cut + 7))
        c.enqueue(bytes.slice(cut + 7))
        c.close()
      },
    })
    antigravityStreamInternals.fetch = scripted(() => new Response(body, { status: 200 }))
    const done = terminal(await run())
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.message.content).toEqual([{ type: 'text', text: 'héllo' }])
  })

  it('drops a trailing event without a terminator and still completes', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(frame(parts({ text: 'complete' })), `data: ${JSON.stringify(parts({ text: ' cut off' }))}`))
    const done = terminal(await run())
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.reason).toBe('stop')
    expect(done.message.content).toEqual([{ type: 'text', text: 'complete' }])
  })

  it('finishes with an empty message for an empty stream', async () => {
    antigravityStreamInternals.fetch = scripted(() => sse())
    const events = await run()
    expect(events.map(e => e.type)).toEqual(['start', 'done'])
  })

  it('tolerates candidates without content, parts without text, and empty text', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(
        frame({ response: { candidates: [{}] } }),
        frame({ response: { candidates: [] } }),
        frame(parts({}, { text: '' }, { thought: true, text: '' })),
        frame(withFinish('STOP', { text: 'x' })),
      ))
    const events = await run()
    expect(events.map(e => e.type)).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done'])
  })
})

describe('antigravity stream content blocks', () => {
  it('interleaves thinking and text, closing each block before the next opens', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(
        frame(parts({ text: 'think 1', thought: true })),
        frame(parts({ text: ' think 2', thought: true })),
        frame(parts({ text: 'answer ' })),
        frame(parts({ text: 'more' })),
        frame(parts({ text: 'rethink', thought: true })),
        frame(withFinish('STOP', { text: 'final' })),
      ))
    const events = await run()
    expect(events.map(e => e.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ])
    const done = terminal(events)
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.message.content).toEqual([
      { type: 'thinking', thinking: 'think 1 think 2' },
      { type: 'text', text: 'answer more' },
      { type: 'thinking', thinking: 'rethink' },
      { type: 'text', text: 'final' },
    ])
  })

  it('ends a trailing open thinking block at stream end', async () => {
    antigravityStreamInternals.fetch = scripted(() => sse(frame(parts({ text: 'only thoughts', thought: true }))))
    const events = await run()
    expect(events.map(e => e.type)).toEqual(['start', 'thinking_start', 'thinking_delta', 'thinking_end', 'done'])
  })

  it('closes open text and thinking blocks before a function call and fills call defaults', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(
        frame(parts({ text: 'plan', thought: true }, { text: 'calling' })),
        frame(parts({ functionCall: {} }, { functionCall: { name: 'read', args: { p: 1 }, id: 'c1' } })),
      ))
    const events = await run()
    const types = events.map(e => e.type)
    expect(types.slice(0, 9)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
    ])
    const done = terminal(events)
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.reason).toBe('toolUse')
    const calls = done.message.content.filter(block => block.type === 'toolCall')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: '', arguments: {} })
    expect(calls[0]?.id).toMatch(/^call_[a-z0-9]+$/)
    expect(calls[1]).toEqual({ type: 'toolCall', id: 'c1', name: 'read', arguments: { p: 1 } })
    const delta = events.find(e => e.type === 'toolcall_delta' && e.contentIndex === 3)
    expect(delta).toMatchObject({ delta: JSON.stringify({ p: 1 }) })
  })

  it('prefers tool use over a length finish reason when a call was emitted', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(frame(withFinish('MAX_TOKENS', { functionCall: { name: 'f', id: 'i' } }))))
    const done = terminal(await run())
    expect(done.type === 'done' && done.reason).toBe('toolUse')
  })
})

describe('antigravity stream usage and finish reasons', () => {
  it('derives usage from prompt, cached, candidate, and thought token counts', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(
        frame({
          response: {
            usageMetadata: {
              promptTokenCount: 100,
              cachedContentTokenCount: 40,
              candidatesTokenCount: 10,
              thoughtsTokenCount: 5,
            },
          },
        }),
      ))
    const done = terminal(await run())
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.message.usage).toMatchObject({ input: 60, output: 15, cacheRead: 40, totalTokens: 115 })
  })

  it('treats missing usage counts as zero and honors a reported total', async () => {
    antigravityStreamInternals.fetch = scripted(() =>
      sse(frame({ response: { usageMetadata: { totalTokenCount: 9 } } })))
    const done = terminal(await run())
    if (done.type !== 'done') throw new Error(`unexpected ${done.type}`)
    expect(done.message.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, totalTokens: 9 })
  })

  it('reports a length stop for MAX_TOKENS', async () => {
    antigravityStreamInternals.fetch = scripted(() => sse(frame(withFinish('MAX_TOKENS', { text: 'cut' }))))
    const done = terminal(await run())
    expect(done.type === 'done' && done.reason).toBe('length')
    if (done.type === 'done') expect(done.message.stopReason).toBe('length')
  })

  it('reports STOP as stop', async () => {
    antigravityStreamInternals.fetch = scripted(() => sse(frame(withFinish('STOP', { text: 'fine' }))))
    const done = terminal(await run())
    expect(done.type === 'done' && done.reason).toBe('stop')
  })

  it('fails with the finish reason for any other value', async () => {
    antigravityStreamInternals.fetch = scripted(() => sse(frame(withFinish('SAFETY', { text: 'partial' }))))
    const events = await run()
    const failure = errorOf(events)
    expect(failure).toMatchObject({ reason: 'error', stopReason: 'error', message: 'Cloud Code Assist stopped: SAFETY' })
    const last = terminal(events)
    if (last.type === 'error') expect(last.error.content).toEqual([{ type: 'text', text: 'partial' }])
  })
})

describe('antigravity stream cancellation and read failures', () => {
  it('ends as aborted when the signal fires while a chunk is being applied', async () => {
    const controller = new AbortController()
    // A function call without an id draws a random id while the chunk is applied; abort at that moment.
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      controller.abort()
      return 0.5
    })
    try {
      const gate = gatedSse()
      gate.push(frame(parts({ functionCall: { name: 'f' } })))
      antigravityStreamInternals.fetch = scripted(() => gate.response)
      const events = await run({ ...CREDS, signal: controller.signal })
      expect(errorOf(events)).toMatchObject({ reason: 'aborted', stopReason: 'aborted' })
      expect(events.some(e => e.type === 'toolcall_end')).toBe(true)
    } finally {
      random.mockRestore()
    }
  })

  it('ends as aborted when the signal fires while waiting for the next chunk', async () => {
    const gate = gatedSse()
    antigravityStreamInternals.fetch = scripted(() => gate.response)
    const controller = new AbortController()
    const stream = streamAntigravity(reasoningModel(), CONTEXT, { ...CREDS, signal: controller.signal })
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) {
      events.push(event)
      if (event.type === 'start') {
        controller.abort()
        gate.push(frame(parts({ text: 'late' })))
      }
    }
    const failure = errorOf(events)
    expect(failure).toMatchObject({ reason: 'aborted', stopReason: 'aborted', message: 'Request was aborted' })
    expect(events.some(e => e.type === 'text_delta')).toBe(false)
  })

  it('reports an aborted error when reading fails after the signal fired', async () => {
    const gate = gatedSse()
    antigravityStreamInternals.fetch = scripted(() => gate.response)
    const controller = new AbortController()
    const events: AssistantMessageEvent[] = []
    for await (const event of streamAntigravity(reasoningModel(), CONTEXT, { ...CREDS, signal: controller.signal })) {
      events.push(event)
      if (event.type === 'start') {
        controller.abort()
        gate.fail(new Error('socket closed'))
      }
    }
    expect(errorOf(events).stopReason).toBe('aborted')
  })

  it('reports a mid-stream read failure with its message', async () => {
    const gate = gatedSse()
    antigravityStreamInternals.fetch = scripted(() => gate.response)
    const events: AssistantMessageEvent[] = []
    for await (const event of streamAntigravity(reasoningModel(), CONTEXT, CREDS)) {
      events.push(event)
      if (event.type === 'start') {
        gate.push(frame(parts({ text: 'partial' })))
        gate.fail(new Error('connection reset'))
      }
    }
    expect(errorOf(events)).toMatchObject({ stopReason: 'error', message: 'connection reset' })
  })

  it('stringifies a non-Error read failure', async () => {
    const gate = gatedSse()
    antigravityStreamInternals.fetch = scripted(() => gate.response)
    const events: AssistantMessageEvent[] = []
    for await (const event of streamAntigravity(reasoningModel(), CONTEXT, CREDS)) {
      events.push(event)
      if (event.type === 'start') gate.fail('boom')
    }
    expect(errorOf(events).message).toBe('boom')
  })
})
