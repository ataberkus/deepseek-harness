/** Gemini CLI OAuth, Cloud Code Assist request, and streamSimple fixtures — never a live Google API. */
import { afterEach, describe, expect, it } from 'vitest'
import type { Api, Context as PiContext, Model, Tool } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import {
  GOOGLE_GEMINI_CLI_AUTH_URL,
  GOOGLE_GEMINI_CLI_CLIENT_ID,
  GOOGLE_GEMINI_CLI_PROJECT_HEADER,
  GOOGLE_GEMINI_CLI_PROVIDER,
} from '../src/google-gemini-cli/constants.ts'
import { geminiCliHeaders } from '../src/google-gemini-cli/headers.ts'
import { geminiCliFallbackModels, geminiCliModel } from '../src/google-gemini-cli/models.ts'
import {
  completeGeminiLogin,
  createGeminiCallbackServer,
  discoverProject,
  geminiAuthorizeUrl,
  geminiOAuthInternals,
  geminiProjectId,
  refreshGeminiToken,
} from '../src/google-gemini-cli/oauth.ts'
import {
  createGeminiCliProvider,
  geminiCliProvider,
  loginGeminiCli,
  refreshGeminiCli,
  toGeminiCliAuth,
} from '../src/google-gemini-cli/provider.ts'
import { buildCloudCodeAssistRequest } from '../src/google-gemini-cli/request.ts'
import { geminiStreamInternals, streamGeminiCli } from '../src/google-gemini-cli/stream.ts'
import { catalogModels, catalogProvider, catalogProviderTakesApiKey } from '../src/catalog.ts'

const originalOAuthFetch = geminiOAuthInternals.fetch
const originalSleep = geminiOAuthInternals.sleep
const originalRandomState = geminiOAuthInternals.randomState
const originalCreateServer = geminiOAuthInternals.createCallbackServer
const originalStreamFetch = geminiStreamInternals.fetch

afterEach(() => {
  geminiOAuthInternals.fetch = originalOAuthFetch
  geminiOAuthInternals.sleep = originalSleep
  geminiOAuthInternals.randomState = originalRandomState
  geminiOAuthInternals.createCallbackServer = originalCreateServer
  geminiStreamInternals.fetch = originalStreamFetch
  delete process.env['GOOGLE_CLOUD_PROJECT']
  delete process.env['GOOGLE_CLOUD_PROJECT_ID']
})

function model(): Model<Api> {
  return geminiCliModel('gemini-2.5-flash', 'Gemini 2.5 Flash', true)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function routeFetch(routes: Array<{ match: (url: string) => boolean; response: () => Response | Promise<Response> }>): typeof fetch {
  return (async (input) => {
    const url = String(input)
    const route = routes.find(entry => entry.match(url))
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    return route.response()
  }) as typeof fetch
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = []
  for await (const event of stream) types.push(event.type)
  return types
}

describe('gemini CLI catalog', () => {
  it('exposes a hosted OAuth-only provider and bundled fallback models', () => {
    const provider = catalogProvider(GOOGLE_GEMINI_CLI_PROVIDER)
    expect(provider?.id).toBe(GOOGLE_GEMINI_CLI_PROVIDER)
    expect(provider?.auth.apiKey).toBeUndefined()
    expect(provider?.auth.oauth).toBeDefined()
    expect(catalogProviderTakesApiKey(GOOGLE_GEMINI_CLI_PROVIDER)).toBe(false)
    const models = catalogModels(GOOGLE_GEMINI_CLI_PROVIDER)
    expect(models.get('gemini-2.5-flash')?.input).toEqual(['text', 'image'])
    expect(models.get('gemini-2.5-pro')?.reasoning).toBe(true)
    expect(geminiCliFallbackModels().map(entry => entry.id)).toContain('gemini-3-pro-preview')
    expect(createGeminiCliProvider().id).toBe(GOOGLE_GEMINI_CLI_PROVIDER)
    expect(createGeminiCliProvider()).not.toBe(geminiCliProvider())
  })
})

describe('gemini CLI oauth', () => {
  it('builds an authorize URL with the public Gemini CLI client and offline consent', () => {
    const url = geminiAuthorizeUrl('http://127.0.0.1:8085/oauth2callback', 'csrf-state')
    expect(url.startsWith(`${GOOGLE_GEMINI_CLI_AUTH_URL}?`)).toBe(true)
    expect(url).toContain(`client_id=${encodeURIComponent(GOOGLE_GEMINI_CLI_CLIENT_ID)}`)
    expect(url).toContain('access_type=offline')
    expect(url).toContain('prompt=consent')
    expect(url).toContain('state=csrf-state')
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:8085/oauth2callback'))
    expect(GOOGLE_GEMINI_CLI_CLIENT_ID.endsWith('.apps.googleusercontent.com')).toBe(true)
  })

  it('exchanges the code, discovers an existing project, and stores projectId', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('/token'),
        response: () => jsonResponse(200, {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
        }),
      },
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, {
          currentTier: { id: 'free-tier' },
          cloudaicompanionProject: 'proj-existing',
        }),
      },
    ])
    const credential = await completeGeminiLogin('auth-code', 'http://127.0.0.1:8085/oauth2callback')
    expect(credential).toMatchObject({
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      projectId: 'proj-existing',
    })
    expect(geminiProjectId(credential)).toBe('proj-existing')
  })

  it('onboards and polls an LRO when loadCodeAssist has no current tier', async () => {
    let polls = 0
    geminiOAuthInternals.sleep = async () => undefined
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('/token'),
        response: () => jsonResponse(200, {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
        }),
      },
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(200, { name: 'operations/op-1', done: false }),
      },
      {
        match: url => url.includes('operations/op-1'),
        response: () => {
          polls += 1
          if (polls === 1) return jsonResponse(200, { done: false })
          return jsonResponse(200, {
            done: true,
            response: { cloudaicompanionProject: { id: 'proj-onboarded' } },
          })
        },
      },
    ])
    await expect(completeGeminiLogin('auth-code', 'http://127.0.0.1:8085/oauth2callback'))
      .resolves.toMatchObject({ projectId: 'proj-onboarded' })
    expect(polls).toBe(2)
  })

  it('requires GOOGLE_CLOUD_PROJECT for a workspace account without a companion project', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => jsonResponse(200, { currentTier: { id: 'standard-tier' } }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/)
    process.env['GOOGLE_CLOUD_PROJECT'] = 'workspace-proj'
    await expect(discoverProject('access')).resolves.toBe('workspace-proj')
  })

  it('refreshes the access token and keeps projectId', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('/token'),
        response: () => jsonResponse(200, { access_token: 'new-access', expires_in: 3600 }),
      },
    ])
    await expect(refreshGeminiToken({
      type: 'oauth',
      access: 'old',
      refresh: 'refresh',
      expires: Date.now(),
      projectId: 'proj-keep',
    })).resolves.toMatchObject({
      access: 'new-access',
      refresh: 'refresh',
      projectId: 'proj-keep',
    })
  })

  it('refuses refresh and toAuth when projectId is missing', async () => {
    const credential = { type: 'oauth' as const, access: 'a', refresh: 'r', expires: Date.now() }
    await expect(refreshGeminiCli(credential)).rejects.toThrow(/projectId/)
    await expect(toGeminiCliAuth(credential)).rejects.toThrow(/projectId/)
  })

  it('opens Google consent, waits for the loopback code, and returns tokens', async () => {
    const opened: string[] = []
    let closed = false
    geminiOAuthInternals.randomState = () => 'fixed-state'
    geminiOAuthInternals.createCallbackServer = async () => ({
      redirectUri: 'http://127.0.0.1:8085/oauth2callback',
      wait: async () => ({ code: 'auth-code', state: 'fixed-state' }),
      close: async () => { closed = true },
    })
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('/token'),
        response: () => jsonResponse(200, {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
        }),
      },
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, {
          currentTier: { id: 'free-tier' },
          cloudaicompanionProject: 'proj-login',
        }),
      },
    ])
    const credential = await loginGeminiCli({
      prompt: async () => {
        throw new Error('Gemini CLI login does not prompt')
      },
      notify: (event) => {
        if (event.type === 'auth_url') opened.push(event.url)
      },
    })
    expect(opened[0]).toContain('state=fixed-state')
    expect(credential).toMatchObject({ access: 'access', projectId: 'proj-login' })
    expect(closed).toBe(true)
    await expect(toGeminiCliAuth(credential)).resolves.toEqual({
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-login',
      },
    })
  })

  it('rejects a callback whose state does not match', async () => {
    geminiOAuthInternals.randomState = () => 'expected'
    geminiOAuthInternals.createCallbackServer = async () => ({
      redirectUri: 'http://127.0.0.1:8085/oauth2callback',
      wait: async () => ({ code: 'auth-code', state: 'other' }),
      close: async () => undefined,
    })
    await expect(loginGeminiCli({
      prompt: async () => 'unused',
      notify: () => undefined,
    })).rejects.toThrow(/state mismatch/)
  })

  it('serves the loopback callback and yields code plus state', async () => {
    const server = await createGeminiCallbackServer(0)
    try {
      const waiting = server.wait()
      const denied = expect(waiting).rejects.toThrow(/denied/)
      const response = await fetch(`${server.redirectUri}?error=access_denied`)
      expect(response.status).toBe(400)
      await denied
    } finally {
      await server.close()
    }
    const missingServer = await createGeminiCallbackServer(0)
    try {
      const waiting = missingServer.wait()
      const assertion = expect(waiting).rejects.toThrow(/missing code or state/)
      const missing = await fetch(`${missingServer.redirectUri}?state=only`)
      expect(missing.status).toBe(400)
      await assertion
    } finally {
      await missingServer.close()
    }
    const retry = await createGeminiCallbackServer(0)
    try {
      const waiting = retry.wait()
      const favicon = await fetch(new URL('/favicon.ico', retry.redirectUri))
      expect(favicon.status).toBe(404)
      const ok = await fetch(`${retry.redirectUri}?code=loop-code&state=loop-state`)
      expect(ok.status).toBe(200)
      await expect(waiting).resolves.toEqual({ code: 'loop-code', state: 'loop-state' })
    } finally {
      await retry.close()
    }
  })

  it('aborts the callback wait when the login signal fires', async () => {
    const server = await createGeminiCallbackServer(0)
    const ac = new AbortController()
    const waiting = server.wait(ac.signal)
    const assertion = expect(waiting).rejects.toThrow(/aborted/)
    ac.abort(new Error('user cancelled'))
    await assertion
    await server.close()
  })

  it('refuses a token exchange without a refresh token', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => jsonResponse(200, { access_token: 'access', expires_in: 3600 }),
      },
    ])
    await expect(completeGeminiLogin('auth-code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/no refresh token/)
  })

  it('refuses a failed token exchange', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(400, { error: 'invalid_grant' }) },
    ])
    await expect(completeGeminiLogin('auth-code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/token exchange failed: 400/)
  })

  it('surfaces loadCodeAssist failures that are not VPC-SC', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(500, { error: 'boom' }) },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/loadCodeAssist failed: 500/)
  })

  it('treats SECURITY_POLICY_VIOLATED as a workspace account', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => new Response(JSON.stringify({
          error: { details: [{ reason: 'SECURITY_POLICY_VIOLATED' }] },
        }), { status: 403 }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/)
  })

  it('surfaces onboardUser failures', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(500, 'nope'),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/onboardUser failed: 500/)
  })

  it('times out a stuck project-provisioning LRO', async () => {
    geminiOAuthInternals.sleep = async () => undefined
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(200, { name: 'operations/stuck', done: false }),
      },
      {
        match: url => url.includes('operations/stuck'),
        response: () => jsonResponse(200, { done: false }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/did not complete after 24/)
  })

  it('surfaces a failed LRO poll', async () => {
    geminiOAuthInternals.sleep = async () => undefined
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(200, { name: 'operations/bad', done: false }),
      },
      {
        match: url => url.includes('operations/bad'),
        response: () => jsonResponse(502, 'down'),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/poll Cloud Code Assist operation: 502/)
  })

  it('refuses refresh when the token endpoint fails', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(401, { error: 'invalid' }) },
    ])
    await expect(refreshGeminiToken({
      type: 'oauth',
      access: 'old',
      refresh: 'refresh',
      expires: Date.now(),
      projectId: 'proj-keep',
    })).rejects.toThrow(/token refresh failed: 401/)
  })

  it('delegates default fetch, sleep, and state helpers', async () => {
    geminiOAuthInternals.fetch = originalOAuthFetch
    geminiOAuthInternals.sleep = originalSleep
    geminiOAuthInternals.randomState = originalRandomState
    expect(geminiOAuthInternals.randomState()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    await originalSleep(0)
    const ac = new AbortController()
    ac.abort(new Error('already'))
    await expect(originalSleep(5, ac.signal)).rejects.toThrow(/aborted/)
    const previous = globalThis.fetch
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch
    try {
      const response = await originalOAuthFetch('http://127.0.0.1/unused')
      expect(await response.text()).toBe('ok')
    } finally {
      globalThis.fetch = previous
    }
  })

  it('refuses a second bind on the same loopback port', async () => {
    const first = await createGeminiCallbackServer(0)
    const port = Number(new URL(first.redirectUri).port)
    await expect(createGeminiCallbackServer(port)).rejects.toThrow()
    await first.close()
  })

  it('aborts wait that starts already cancelled, and ignores abort after success', async () => {
    const already = await createGeminiCallbackServer(0)
    const aborted = new AbortController()
    aborted.abort(new Error('before wait'))
    await expect(already.wait(aborted.signal)).rejects.toThrow(/aborted/)
    await already.close()

    const server = await createGeminiCallbackServer(0)
    const ac = new AbortController()
    const waiting = server.wait(ac.signal)
    const ok = await fetch(`${server.redirectUri}?code=c&state=s`)
    expect(ok.status).toBe(200)
    await expect(waiting).resolves.toEqual({ code: 'c', state: 's' })
    ac.abort()
    await server.close()
  })

  it('ignores a second loopback callback after the first settled', async () => {
    const server = await createGeminiCallbackServer(0)
    try {
      const waiting = server.wait()
      const first = await fetch(`${server.redirectUri}?code=one&state=st`)
      expect(first.status).toBe(200)
      await expect(waiting).resolves.toEqual({ code: 'one', state: 'st' })
      const second = await fetch(`${server.redirectUri}?code=two&state=st`)
      expect(second.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('onboards a non-free tier with GOOGLE_CLOUD_PROJECT and falls back when LRO omits the id', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'env-proj'
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(200, { done: true, response: {} }),
      },
    ])
    await expect(discoverProject('access')).resolves.toBe('env-proj')
  })

  it('uses currentTier with only an env project', async () => {
    process.env['GOOGLE_CLOUD_PROJECT_ID'] = 'from-id'
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => jsonResponse(200, { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: '' }),
      },
    ])
    await expect(discoverProject('access')).resolves.toBe('from-id')
  })

  it('rejects malformed token JSON', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(200, null) },
    ])
    await expect(completeGeminiLogin('code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/invalid token response/)
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(200, { expires_in: 1 }) },
    ])
    await expect(completeGeminiLogin('code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/no access token/)
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(200, { access_token: 'a', expires_in: 'nope' }) },
    ])
    await expect(completeGeminiLogin('code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/no expires_in/)
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(200, { access_token: 'a', expires_in: 1, refresh_token: 1 }) },
    ])
    await expect(completeGeminiLogin('code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/invalid refresh token/)
  })

  it('keeps a rotated refresh token', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => jsonResponse(200, {
          access_token: 'n',
          refresh_token: 'rotated',
          expires_in: 3600,
        }),
      },
    ])
    await expect(refreshGeminiToken({
      type: 'oauth',
      access: 'old',
      refresh: 'old-refresh',
      expires: Date.now(),
      projectId: 'proj',
    })).resolves.toMatchObject({ refresh: 'rotated' })
  })

  it('aborts sleep while waiting and treats allowedTiers without isDefault as legacy', async () => {
    const ac = new AbortController()
    const waiting = originalSleep(50, ac.signal)
    ac.abort(new Error('mid-sleep'))
    await expect(waiting).rejects.toThrow(/aborted/)

    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'standard-tier' }] }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/)
  })

  it('treats a default allowed tier without an id as legacy', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: () => true,
        response: () => jsonResponse(200, { allowedTiers: [{ isDefault: true }] }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/GOOGLE_CLOUD_PROJECT/)
  })

  it('refuses an empty access token string', async () => {
    geminiOAuthInternals.fetch = routeFetch([
      { match: () => true, response: () => jsonResponse(200, { access_token: '', expires_in: 1 }) },
    ])
    await expect(completeGeminiLogin('code', 'http://127.0.0.1:8085/oauth2callback'))
      .rejects.toThrow(/no access token/)
  })

  it('aborts LRO polling sleep and skips poll when onboard returns no name', async () => {
    geminiOAuthInternals.sleep = async (_ms, signal) => {
      throw new Error('Gemini CLI login aborted', { cause: signal?.reason })
    }
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(200, { name: 'operations/slow', done: false }),
      },
      {
        match: url => url.includes('operations/slow'),
        response: () => jsonResponse(200, { done: false }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/aborted/)

    geminiOAuthInternals.sleep = originalSleep
    geminiOAuthInternals.fetch = routeFetch([
      {
        match: url => url.includes('loadCodeAssist'),
        response: () => jsonResponse(200, { allowedTiers: [{ id: 'free-tier', isDefault: true }] }),
      },
      {
        match: url => url.includes('onboardUser'),
        response: () => jsonResponse(200, { done: false }),
      },
    ])
    await expect(discoverProject('access')).rejects.toThrow(/Could not discover or provision/)
  })

  it('aborts token exchange when the caller signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort(new Error('cancelled'))
    await expect(completeGeminiLogin('code', 'http://127.0.0.1:8085/oauth2callback', ac.signal))
      .rejects.toThrow()
  })

  it('treats an empty stored projectId as missing', () => {
    expect(geminiProjectId({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now(),
      projectId: '',
    })).toBeUndefined()
  })
})

describe('gemini CLI request', () => {
  it('wraps pi-ai Gemini conversion in the Cloud Code Assist envelope', () => {
    const bash: Tool = {
      name: 'bash',
      description: 'run',
      parameters: Type.Object({ command: Type.String() }),
    }
    const context: PiContext = {
      systemPrompt: 'be helpful',
      tools: [bash],
      messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
    }
    const body = buildCloudCodeAssistRequest(model(), context, 'proj-1', {
      temperature: 0.2,
      maxTokens: 128,
      reasoning: 'low',
    })
    expect(body.project).toBe('proj-1')
    expect(body.model).toBe('gemini-2.5-flash')
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: 'be helpful' }] })
    expect(body.request.tools?.[0]?.functionDeclarations[0]?.['name']).toBe('bash')
    expect(body.request.generationConfig?.temperature).toBe(0.2)
    expect(body.request.generationConfig?.maxOutputTokens).toBe(128)
    expect(body.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'LOW',
    })
    const contents = body.request.contents as Array<{ role: string }>
    expect(contents[0]?.role).toBe('user')
  })

  it('omits thinking when the model does not reason and maps remaining efforts', () => {
    const flash = geminiCliModel('gemini-2.0-flash', 'Gemini 2.0 Flash', false)
    const body = buildCloudCodeAssistRequest(flash, { messages: [] }, 'proj-1')
    expect(body.request.generationConfig).toBeUndefined()
    const high = buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', { reasoning: 'max' })
    expect(high.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH')
    expect(buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', { reasoning: 'minimal' })
      .request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('MINIMAL')
    expect(buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', { reasoning: 'medium' })
      .request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('MEDIUM')
    expect(buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', { reasoning: 'high' })
      .request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH')
    expect(buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', { reasoning: 'xhigh' })
      .request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH')
    expect(buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', {
      reasoning: 'max',
      thinkingBudgets: { high: 99 },
    }).request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH')
    expect(buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', {
      reasoning: 'high',
      thinkingBudgets: {},
    }).request.generationConfig?.thinkingConfig?.thinkingLevel).toBe('HIGH')
    const budgeted = buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1', {
      reasoning: 'medium',
      thinkingBudgets: { medium: 2048 },
    })
    expect(budgeted.request.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    })
    const defaultThinking = buildCloudCodeAssistRequest(model(), { messages: [] }, 'proj-1')
    expect(defaultThinking.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
  })
})

describe('gemini CLI streamSimple', () => {
  it('maps text, thinking, and functionCall SSE onto pi-ai events', async () => {
    const sse = [
      'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"plan"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"!"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"!"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{"command":"ls"},"id":"c1"}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}}\n\n',
    ].join('')
    geminiStreamInternals.fetch = (async (input) => {
      expect(String(input)).toContain('streamGenerateContent')
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as typeof fetch
    const types = await collect(streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    }))
    expect(types).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'done',
    ])
  })

  it('maps a missing credential to Provider is not configured', async () => {
    const stream = streamGeminiCli(model(), { messages: [] })
    const events = []
    for await (const event of stream) events.push(event)
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/Provider is not configured: google-gemini-cli/) },
    })
  })

  it('aborts when the caller signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const stream = streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      signal: ac.signal,
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    })
    const events = []
    for await (const event of stream) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' })
  })

  it('surfaces a Cloud Code Assist HTTP error', async () => {
    geminiStreamInternals.fetch = (async () => new Response('quota', { status: 429 })) as typeof fetch
    const stream = streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    })
    const events = []
    for await (const event of stream) events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/429/) },
    })
  })

  it('accepts an apiKey when authorization headers are absent', async () => {
    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const types = await collect(streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      apiKey: 'access',
      headers: { [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    }))
    expect(types).toContain('text_delta')
    expect(types.at(-1)).toBe('done')
  })

  it('maps MAX_TOKENS to length and in-band stream errors to error', async () => {
    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"cut"}]},"finishReason":"MAX_TOKENS"}]}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const lengthStream = streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    })
    const lengthEvents = []
    for await (const event of lengthStream) lengthEvents.push(event)
    expect(lengthEvents.at(-1)).toMatchObject({ type: 'done', reason: 'length' })

    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"no"}]},"finishReason":"SAFETY"}]}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const safetyStream = streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    })
    const safetyEvents = []
    for await (const event of safetyStream) safetyEvents.push(event)
    expect(safetyEvents.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      error: { errorMessage: expect.stringMatching(/SAFETY/) },
    })

    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"error":{"message":"quota exceeded","code":429}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const errorStream = streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    })
    const errorEvents = []
    for await (const event of errorStream) errorEvents.push(event)
    expect(errorEvents.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/quota exceeded/) },
    })
  })

  it('surfaces a Google block reason', async () => {
    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"nope"}}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const stream = streamGeminiCli(model(), {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      headers: {
        authorization: 'Bearer access',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1',
      },
    })
    const events = []
    for await (const event of stream) events.push(event)
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/SAFETY/) },
    })
  })

  it('covers remaining stream branches: empty body, SSE skip, auth fallbacks, thinking after text', async () => {
    geminiStreamInternals.fetch = originalStreamFetch
    const previous = globalThis.fetch
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch
    try {
      expect(await (await originalStreamFetch('http://127.0.0.1/unused')).text()).toBe('ok')
    } finally {
      globalThis.fetch = previous
    }

    geminiStreamInternals.fetch = (async () => ({
      ok: true,
      status: 200,
      body: null,
      text: async () => '',
    }) as Response) as typeof fetch
    const empty = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const emptyEvents = []
    for await (const event of empty) emptyEvents.push(event)
    expect(emptyEvents.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/no response body/) },
    })

    geminiStreamInternals.fetch = (async () => new Response([
      'data: [DONE]\n\n',
      'data: \n\n',
      'data: null\n\n',
      'data: {"error":{}}\n\n',
    ].join(''), { status: 200 })) as typeof fetch
    const statusOnly = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'token-without-bearer', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const statusEvents = []
    for await (const event of statusOnly) statusEvents.push(event)
    expect(statusEvents.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/unknown error/) },
    })

    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"error":{"status":"RESOURCE_EXHAUSTED"}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const statusNamed = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const statusNamedEvents = []
    for await (const event of statusNamed) statusNamedEvents.push(event)
    expect(statusNamedEvents.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringMatching(/RESOURCE_EXHAUSTED/) },
    })

    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"promptFeedback":{"blockReason":"OTHER"}}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const blocked = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const blockedEvents = []
    for await (const event of blocked) blockedEvents.push(event)
    expect(JSON.stringify(blockedEvents.at(-1))).toMatch(/OTHER/)

    geminiStreamInternals.fetch = (async () => new Response([
      'data: {"response":{"candidates":[{}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"},{"text":""}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"plan"}]}}]}}\n\n',
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{}}]}}]}}\n\n',
    ].join(''), { status: 200 })) as typeof fetch
    const mixed = await collect(streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    }))
    expect(mixed).toContain('thinking_start')
    expect(mixed).toContain('toolcall_end')

    const missingProject = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: '   ' },
    })
    const missingEvents = []
    for await (const event of missingProject) missingEvents.push(event)
    expect(JSON.stringify(missingEvents.at(-1))).toMatch(/Provider is not configured/)

    const ac = new AbortController()
    geminiStreamInternals.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n',
        ))
        ac.abort()
        controller.close()
      },
    }), { status: 200 })) as typeof fetch
    const aborting = streamGeminiCli(model(), { messages: [] }, {
      signal: ac.signal,
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const abortEvents = []
    for await (const event of aborting) abortEvents.push(event)
    expect(abortEvents.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' })
  })

  it('covers remaining auth, usage, abort-in-fetch, and nameless stop branches', async () => {
    geminiStreamInternals.fetch = (async () => {
      throw 'nope'
    }) as typeof fetch
    const thrown = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const thrownEvents = []
    for await (const event of thrown) thrownEvents.push(event)
    expect(JSON.stringify(thrownEvents.at(-1))).toMatch(/nope/)

    const ac = new AbortController()
    geminiStreamInternals.fetch = (async () => {
      ac.abort()
      throw new Error('network')
    }) as typeof fetch
    const abortingFetch = streamGeminiCli(model(), { messages: [] }, {
      signal: ac.signal,
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const abortingFetchEvents = []
    for await (const event of abortingFetch) abortingFetchEvents.push(event)
    expect(abortingFetchEvents.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' })

    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{}}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const missing = streamGeminiCli(model(), { messages: [] }, {
      apiKey: '   ',
      headers: {
        authorization: '   ',
        accept: 'text/event-stream',
        [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: null as unknown as string,
      },
    })
    const missingEvents = []
    for await (const event of missing) missingEvents.push(event)
    expect(JSON.stringify(missingEvents.at(-1))).toMatch(/Provider is not configured/)

    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{}}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const stopStream = streamGeminiCli(model(), { messages: [] }, {
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const stopEvents = []
    for await (const event of stopStream) stopEvents.push(event)
    expect(stopEvents.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })

    const hanging = new AbortController()
    geminiStreamInternals.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":{'))
        hanging.abort()
        controller.close()
      },
    }), { status: 200 })) as typeof fetch
    const midRead = streamGeminiCli(model(), { messages: [] }, {
      signal: hanging.signal,
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const midReadEvents = []
    for await (const event of midRead) midReadEvents.push(event)
    expect(midReadEvents.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' })

    let abortedChecks = 0
    const looping = {
      get aborted() {
        abortedChecks += 1
        return abortedChecks >= 3
      },
    } as AbortSignal
    geminiStreamInternals.fetch = (async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"a"}]}}]}}\n\n',
      { status: 200 },
    )) as typeof fetch
    const loopAbort = streamGeminiCli(model(), { messages: [] }, {
      signal: looping,
      headers: { authorization: 'Bearer access', [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: 'proj-1' },
    })
    const loopAbortEvents = []
    for await (const event of loopAbort) loopAbortEvents.push(event)
    expect(loopAbortEvents.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' })
  })
})

describe('gemini CLI headers', () => {
  it('identifies as Gemini CLI', () => {
    const headers = geminiCliHeaders('gemini-2.5-flash')
    expect(headers['User-Agent']).toMatch(/^GeminiCLI\/0\.46\.0\/gemini-2\.5-flash /)
    expect(headers['Client-Metadata']).toContain('pluginType=GEMINI')
  })
})
