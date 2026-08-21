/** Antigravity OAuth, Cloud Code Assist request, and streamSimple fixtures — never a live Google API. */
import { afterEach, describe, expect, it } from 'vitest'
import type { Api, AssistantMessageEvent, Context as PiContext, Model, Tool } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import {
  GOOGLE_ANTIGRAVITY_AUTH_URL,
  GOOGLE_ANTIGRAVITY_BASE_URL,
  GOOGLE_ANTIGRAVITY_CLIENT_ID,
  GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL,
  GOOGLE_ANTIGRAVITY_PROJECT_HEADER,
  GOOGLE_ANTIGRAVITY_PROVIDER,
  GOOGLE_ANTIGRAVITY_SCOPES,
  GOOGLE_ANTIGRAVITY_TOKEN_URL,
} from '../src/google-antigravity/constants.ts'
import { antigravityHeaders, antigravityUserAgent } from '../src/google-antigravity/headers.ts'
import { antigravityModel } from '../src/google-antigravity/models.ts'
import {
  antigravityAuthorizeUrl,
  antigravityOAuthInternals,
  antigravityProjectId,
  completeAntigravityLogin,
  createAntigravityCallbackServer,
  discoverProject,
  refreshAntigravityToken,
} from '../src/google-antigravity/oauth.ts'
import {
  antigravityProvider,
  createAntigravityProvider,
  loginAntigravity,
  refreshAntigravity,
  toAntigravityAuth,
} from '../src/google-antigravity/provider.ts'
import { buildAntigravityRequest } from '../src/google-antigravity/request.ts'
import { antigravityStreamInternals, streamAntigravity } from '../src/google-antigravity/stream.ts'
import { catalogModels, catalogProvider, catalogProviderTakesApiKey } from '../src/catalog.ts'

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

function model(): Model<Api> {
  return antigravityModel('gemini-3.7-flash', 'Gemini 3.7 Flash', true)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(events: unknown[]): Response {
  const body = events
    .map(event => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function routeFetch(routes: Array<{ match: (url: string) => boolean; response: () => Response | Promise<Response> }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    throw new Error(`Unhandled test fetch: ${url}`)
  })
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('antigravity catalog', () => {
  it('supplies the hosted antigravity provider through catalogProvider', () => {
    const provider = catalogProvider(GOOGLE_ANTIGRAVITY_PROVIDER)
    expect(provider).toBeDefined()
    expect(provider?.id).toBe(GOOGLE_ANTIGRAVITY_PROVIDER)
    expect(provider?.name).toBe('Antigravity')
    expect(provider?.auth.apiKey).toBeUndefined()
    expect(provider?.auth.oauth).toBeDefined()
  })

  it('reports that google-antigravity does not take an api key', () => {
    expect(catalogProviderTakesApiKey(GOOGLE_ANTIGRAVITY_PROVIDER)).toBe(false)
  })

  it('serves fallback models for google-antigravity', () => {
    const models = catalogModels(GOOGLE_ANTIGRAVITY_PROVIDER)
    expect(models.size).toBeGreaterThan(0)
    expect(models.get('gemini-3.7-flash')).toBeDefined()
    expect(models.get('claude-sonnet-4-6')).toBeDefined()
    expect(models.get('claude-opus-4-6')).toBeDefined()
    expect(models.get('gpt-oss-120b')).toBeDefined()
  })

  it('creates memoized provider via antigravityProvider', () => {
    const p1 = antigravityProvider()
    const p2 = antigravityProvider()
    expect(p1).toBe(p2)
    const fresh = createAntigravityProvider()
    expect(fresh.id).toBe(GOOGLE_ANTIGRAVITY_PROVIDER)
  })
})

describe('antigravity oauth', () => {
  it('builds the Google authorize URL with Antigravity client id and scopes', () => {
    const url = antigravityAuthorizeUrl('http://127.0.0.1:51121/oauth-callback', 'csrf-state')
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe(GOOGLE_ANTIGRAVITY_AUTH_URL)
    expect(parsed.searchParams.get('client_id')).toBe(GOOGLE_ANTIGRAVITY_CLIENT_ID)
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51121/oauth-callback')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('state')).toBe('csrf-state')
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
    for (const scope of GOOGLE_ANTIGRAVITY_SCOPES) {
      expect(parsed.searchParams.get('scope')).toContain(scope)
    }
  })

  it('completes login by exchanging code and discovering existing project', async () => {
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, {
          access_token: 'antigravity-access',
          refresh_token: 'antigravity-refresh',
          expires_in: 3600,
        }),
      },
      {
        match: url => url.includes('userinfo'),
        response: () => jsonResponse(200, { email: 'user@example.com' }),
      },
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { cloudaicompanionProject: 'discovered-project-123' }),
      },
    ])

    const credential = await completeAntigravityLogin('auth-code-123', 'http://127.0.0.1:51121/oauth-callback')
    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'antigravity-access',
      refresh: 'antigravity-refresh',
      projectId: 'discovered-project-123',
      email: 'user@example.com',
    })
    expect(credential.expires).toBeTypeOf('number')
  })

  it('provisions a project via onboardUser when loadCodeAssist has no project', async () => {
    let onboardCalls = 0
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, {
          access_token: 'antigravity-access',
          refresh_token: 'antigravity-refresh',
          expires_in: 3600,
        }),
      },
      {
        match: url => url.includes('userinfo'),
        response: () => jsonResponse(200, { email: 'user@example.com' }),
      },
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, {
          allowedTiers: [{ id: 'tier-standard', isDefault: true }],
        }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => {
          onboardCalls++
          if (onboardCalls === 1) {
            return jsonResponse(200, { done: false })
          }
          return jsonResponse(200, {
            done: true,
            response: { project: { id: 'provisioned-project-456' } },
          })
        },
      },
    ])
    antigravityOAuthInternals.sleep = async () => {}

    const credential = await completeAntigravityLogin('auth-code-123', 'http://127.0.0.1:51121/oauth-callback')
    expect(credential.projectId).toBe('provisioned-project-456')
    expect(onboardCalls).toBe(2)
  })

  it('fails completeLogin when token exchange returns non-200', async () => {
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => new Response('invalid_grant', { status: 400 }),
      },
    ])

    await expect(completeAntigravityLogin('bad-code', 'http://127.0.0.1:51121/oauth-callback'))
      .rejects.toThrow('Token exchange failed: invalid_grant')
  })

  it('fails completeLogin when token response is missing refresh token', async () => {
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, { access_token: 'token-only', expires_in: 3600 }),
      },
    ])

    await expect(completeAntigravityLogin('code', 'http://127.0.0.1:51121/oauth-callback'))
      .rejects.toThrow('No refresh token received')
  })

  it('fails discoverProject when loadCodeAssist fails on all endpoints and onboard is not possible', async () => {
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => new Response('internal error', { status: 500 }),
      },
    ])

    await expect(discoverProject('access-tok'))
      .rejects.toThrow('loadCodeAssist failed: 500')
  })

  it('refreshes an Antigravity token preserving projectId and email', async () => {
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
      },
    ])

    const oldCredential = {
      type: 'oauth' as const,
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1000,
      projectId: 'my-proj',
      email: 'user@example.com',
    }

    const refreshed = await refreshAntigravityToken(oldCredential)
    expect(refreshed).toMatchObject({
      type: 'oauth',
      access: 'new-access-token',
      refresh: 'new-refresh-token',
      projectId: 'my-proj',
      email: 'user@example.com',
    })
    expect(refreshed.expires).toBeTypeOf('number')
  })

  it('refreshes an Antigravity token keeping old refresh token if new one is omitted', async () => {
    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, {
          access_token: 'new-access-token',
          expires_in: 3600,
        }),
      },
    ])

    const oldCredential = {
      type: 'oauth' as const,
      access: 'old-access',
      refresh: 'preserved-refresh',
      expires: 1000,
      projectId: 'my-proj',
    }

    const refreshed = await refreshAntigravityToken(oldCredential)
    expect(refreshed.refresh).toBe('preserved-refresh')
  })

  it('fails refresh if credential is missing projectId', async () => {
    const invalidCred = {
      type: 'oauth' as const,
      access: 'acc',
      refresh: 'ref',
      expires: 1000,
    }

    await expect(refreshAntigravityToken(invalidCred))
      .rejects.toThrow('Antigravity OAuth credential is missing projectId')
  })

  it('extracts projectId via antigravityProjectId', () => {
    expect(antigravityProjectId({ type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: 'p1' })).toBe('p1')
    expect(antigravityProjectId({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 })).toBeUndefined()
    expect(antigravityProjectId({ type: 'oauth', access: 'a', refresh: 'r', expires: 1, projectId: '' })).toBeUndefined()
  })

  it('binds loopback callback server and receives code', async () => {
    const server = await createAntigravityCallbackServer(0)
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/)

    const waitPromise = server.waitForCallback()
    const res = await fetch(`${server.redirectUri}?code=my-test-code&state=123`)
    expect(res.ok).toBe(true)
    const text = await res.text()
    expect(text).toContain('Authentication complete')

    const code = await waitPromise
    expect(code).toBe('my-test-code')
  })

  it('handles callback server denial', async () => {
    const server = await createAntigravityCallbackServer(0)
    const waitPromise = server.waitForCallback()
    const assertion = expect(waitPromise).rejects.toThrow('Antigravity OAuth failed: access_denied')

    const res = await fetch(`${server.redirectUri}?error=access_denied`)
    expect(res.status).toBe(400)
    await assertion
  })

  it('handles callback server missing code', async () => {
    const server = await createAntigravityCallbackServer(0)
    const waitPromise = server.waitForCallback()
    const assertion = expect(waitPromise).rejects.toThrow('missing code')

    const res = await fetch(server.redirectUri)
    expect(res.status).toBe(400)
    await assertion
  })
  it('handles callback server 404 for different path', async () => {
    const server = await createAntigravityCallbackServer(0)
    const url = new URL(server.redirectUri)
    url.pathname = '/unknown'

    const res = await fetch(url.toString())
    expect(res.status).toBe(404)
    await server.close()
  })

  it('handles callback server abort signal', async () => {
    const server = await createAntigravityCallbackServer(0)
    const controller = new AbortController()
    const waitPromise = server.waitForCallback(controller.signal)
    controller.abort('user cancel')

    await expect(waitPromise).rejects.toThrow('Antigravity login aborted')
  })

  it('executes provider loginAntigravity via mocked loopback server', async () => {
    const server = await createAntigravityCallbackServer(0)
    antigravityOAuthInternals.createLoopbackServer = async () => server

    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, {
          access_token: 'antigravity-access',
          refresh_token: 'antigravity-refresh',
          expires_in: 3600,
        }),
      },
      {
        match: url => url.includes('userinfo'),
        response: () => jsonResponse(200, { email: 'user@example.com' }),
      },
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { projectId: 'proj-login-test' }),
      },
    ])

    let notifiedUrl = ''
    const interaction = {
      signal: new AbortController().signal,
      notify: (ev: { type: string; url?: string }) => {
        if (ev.type === 'auth_url' && ev.url) notifiedUrl = ev.url
      },
      prompt: () => Promise.reject(new Error('unused')),
    }

    const loginPromise = loginAntigravity(interaction)
    // Simulate user redirect in browser
    await fetch(`${server.redirectUri}?code=code-from-browser`)
    const result = await loginPromise

    expect(notifiedUrl).toContain(GOOGLE_ANTIGRAVITY_AUTH_URL)
    expect(result.projectId).toBe('proj-login-test')
  })

  it('converts credential to auth headers via toAntigravityAuth and refreshes via refreshAntigravity', async () => {
    const cred = {
      type: 'oauth' as const,
      access: 'acc-123',
      refresh: 'ref-123',
      expires: 5000,
      projectId: 'proj-hdr',
    }

    const auth = await toAntigravityAuth(cred)
    expect(auth.headers?.Authorization).toBe('Bearer acc-123')
    expect(auth.headers?.[GOOGLE_ANTIGRAVITY_PROJECT_HEADER]).toBe('proj-hdr')

    antigravityOAuthInternals.fetch = routeFetch([
      {
        match: url => url === GOOGLE_ANTIGRAVITY_TOKEN_URL,
        response: () => jsonResponse(200, { access_token: 'acc-456', expires_in: 3600 }),
      },
    ])

    const refreshed = await refreshAntigravity(cred)
    expect(refreshed.access).toBe('acc-456')
  })
})

describe('antigravity request', () => {
  it('builds wrapped Antigravity request body', () => {
    const ctx: PiContext = {
      systemPrompt: 'System prompt instructions',
      messages: [
        { role: 'user', content: 'Hello Antigravity', timestamp: 0 },
      ],
    }

    const req = buildAntigravityRequest(model(), ctx, 'test-project', { temperature: 0.7, maxTokens: 4096 })
    expect(req.project).toBe('test-project')
    expect(req.userAgent).toBe('antigravity')
    expect(req.requestType).toBe('agent')
    expect(req.model).toBe('gemini-3.7-flash')
    expect(req.requestId).toMatch(/^agent\/[a-f0-9-]+\/\d+\/[a-f0-9-]+\/2$/)
    expect(req.request.sessionId).toMatch(/^-\d+$/)
    expect(req.request.systemInstruction?.parts[0]?.text).toBe('System prompt instructions')
    expect(req.request.generationConfig?.temperature).toBe(0.7)
    expect(req.request.generationConfig?.maxOutputTokens).toBe(4096)
    expect(req.request.generationConfig?.thinkingConfig?.includeThoughts).toBe(true)
    expect(req.request.labels?.used_claude).toBe('false')
  })

  it('builds Claude model request with used_claude=true label', () => {
    const claudeModel = antigravityModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', true)
    const ctx: PiContext = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Analyze this code' }], timestamp: 0 }],
    }
    const req = buildAntigravityRequest(claudeModel, ctx, 'test-project')
    expect(req.request.labels?.used_claude).toBe('true')
  })

  it('includes tools with VALIDATED toolConfig', () => {
    const tools: Tool[] = [
      {
        name: 'test_tool',
        description: 'a test tool',
        parameters: Type.Object({ query: Type.String() }),
      },
    ]
    const ctx: PiContext = {
      messages: [{ role: 'user', content: 'Run tool', timestamp: 0 }],
      tools,
    }
    const req = buildAntigravityRequest(model(), ctx, 'test-project')
    expect(req.request.tools).toBeDefined()
    expect(req.request.toolConfig?.functionCallingConfig.mode).toBe('VALIDATED')
  })
})

describe('antigravity streamSimple', () => {
  it('streams text deltas and usage metadata from SSE chunks', async () => {
    antigravityStreamInternals.fetch = routeFetch([
      {
        match: url => url.includes('streamGenerateContent'),
        response: () => sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Hello, ' }],
                  },
                },
              ],
            },
          },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'world!' }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15,
              },
            },
          },
        ]),
      },
    ])

    const stream = streamAntigravity(model(), { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, {
      apiKey: 'test-token',
      headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'test-project' },
    })

    const events = await collectEvents(stream)
    const types = events.map(e => e.type)
    expect(types).toContain('start')
    expect(types).toContain('text_start')
    expect(types).toContain('text_delta')
    expect(types).toContain('text_end')
    expect(types).toContain('done')

    const done = events.find((e): e is Extract<AssistantMessageEvent, { type: 'done' }> => e.type === 'done')
    expect(done?.message.content).toEqual([{ type: 'text', text: 'Hello, world!' }])
    expect(done?.message.stopReason).toBe('stop')
    expect(done?.message.usage.totalTokens).toBe(15)
  })

  it('streams thinking deltas from reasoning SSE parts', async () => {
    antigravityStreamInternals.fetch = routeFetch([
      {
        match: url => url.includes('streamGenerateContent'),
        response: () => sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Thinking step 1...', thought: true }],
                  },
                },
              ],
            },
          },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Final answer.' }],
                  },
                  finishReason: 'STOP',
                },
              ],
            },
          },
        ]),
      },
    ])

    const stream = streamAntigravity(model(), { messages: [{ role: 'user', content: 'Reason', timestamp: 0 }] }, {
      apiKey: 'test-token',
      headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'test-project' },
    })

    const events = await collectEvents(stream)
    const types = events.map(e => e.type)
    expect(types).toContain('thinking_start')
    expect(types).toContain('thinking_delta')
    expect(types).toContain('thinking_end')

    const done = events.find((e): e is Extract<AssistantMessageEvent, { type: 'done' }> => e.type === 'done')
    expect(done?.message.content).toEqual([
      { type: 'thinking', thinking: 'Thinking step 1...' },
      { type: 'text', text: 'Final answer.' },
    ])
  })

  it('streams toolcall events when candidate returns functionCall', async () => {
    antigravityStreamInternals.fetch = routeFetch([
      {
        match: url => url.includes('streamGenerateContent'),
        response: () => sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: 'read_file',
                          args: { path: 'package.json' },
                          id: 'call_123',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ]),
      },
    ])

    const stream = streamAntigravity(model(), { messages: [{ role: 'user', content: 'Read', timestamp: 0 }] }, {
      apiKey: 'test-token',
      headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'test-project' },
    })

    const events = await collectEvents(stream)
    const types = events.map(e => e.type)
    expect(types).toContain('toolcall_start')
    expect(types).toContain('toolcall_delta')
    expect(types).toContain('toolcall_end')
    expect(types).toContain('done')

    const done = events.find((e): e is Extract<AssistantMessageEvent, { type: 'done' }> => e.type === 'done')
    expect(done?.message.stopReason).toBe('toolUse')
    expect(done?.message.content).toEqual([
      {
        type: 'toolCall',
        id: 'call_123',
        name: 'read_file',
        arguments: { path: 'package.json' },
      },
    ])
  })
  it('fails stream when credentials are missing', async () => {
    const stream = streamAntigravity(model(), { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] })
    const events = await collectEvents(stream)
    const err = events.find((e): e is Extract<AssistantMessageEvent, { type: 'error' }> => e.type === 'error')
    expect(err).toBeDefined()
    expect(err?.error.stopReason).toBe('error')
    expect(err?.error.errorMessage).toContain('Provider is not configured: google-antigravity')
  })

  it('handles stream error payload from SSE', async () => {
    antigravityStreamInternals.fetch = routeFetch([
      {
        match: url => url.includes('streamGenerateContent'),
        response: () => sseResponse([
          {
            error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
          },
        ]),
      },
    ])

    const stream = streamAntigravity(model(), { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, {
      apiKey: 'test-token',
      headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'test-project' },
    })
    const events = await collectEvents(stream)
    const err = events.find((e): e is Extract<AssistantMessageEvent, { type: 'error' }> => e.type === 'error')
    expect(err).toBeDefined()
    expect(err?.error.errorMessage).toContain('Cloud Code Assist stream error: Quota exceeded')
  })

  it('falls back to secondary endpoint when primary fails', async () => {
    let primaryCalled = false
    let fallbackCalled = false

    antigravityStreamInternals.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(GOOGLE_ANTIGRAVITY_BASE_URL)) {
        primaryCalled = true
        return new Response('Unavailable', { status: 503 })
      }
      if (url.startsWith(GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL)) {
        fallbackCalled = true
        return sseResponse([
          {
            response: {
              candidates: [{ content: { parts: [{ text: 'Fallback reply' }] }, finishReason: 'STOP' }],
            },
          },
        ])
      }
      throw new Error(`Unexpected url: ${url}`)
    })

    const stream = streamAntigravity(model(), { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, {
      apiKey: 'test-token',
      headers: { [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: 'test-project' },
    })

    const events = await collectEvents(stream)
    expect(primaryCalled).toBe(true)
    expect(fallbackCalled).toBe(true)
    const done = events.find((e): e is Extract<AssistantMessageEvent, { type: 'done' }> => e.type === 'done')
    expect(done?.message.content).toEqual([{ type: 'text', text: 'Fallback reply' }])
  })
})

describe('antigravity headers', () => {
  it('builds Antigravity user agent string', () => {
    const ua = antigravityUserAgent()
    expect(ua).toMatch(/^antigravity\/hub\/[\d.]+ \(aidev_client; os_type=.+; arch=.+; cl=\d+\)$/)
  })

  it('includes anthropic-beta header for Claude models', () => {
    const claudeHeaders = antigravityHeaders('claude-opus-4-6')
    expect(claudeHeaders['anthropic-beta']).toBe('interleaved-thinking-2025-05-14')

    const geminiHeaders = antigravityHeaders('gemini-3.7-flash')
    expect(geminiHeaders['anthropic-beta']).toBeUndefined()
  })
})
