/** Live Codex registry listing over the ChatGPT OAuth backend — stubbed fetch, never OpenAI. */
import { afterEach, describe, expect, it } from 'vitest'
import type { Api, Credential, Model, OAuthCredential } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import {
  CODEX_BASE_URL,
  codexAccountId,
  codexListingInternals,
  fetchCodexModels,
  listCodexModels,
  mergeCodexCatalogs,
} from '../src/codex/models.ts'
import type { CodexLiveModel } from '../src/codex/models.ts'
import { OPENAI_CODEX_PROVIDER } from '../src/oauth-hosts.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const originalFetch = codexListingInternals.fetch
const originalAllowNetwork = codexListingInternals.allowNetwork

afterEach(() => {
  codexListingInternals.fetch = originalFetch
  codexListingInternals.allowNetwork = originalAllowNetwork
})

function installed(): Model<Api>[] {
  return getBuiltinModels(OPENAI_CODEX_PROVIDER)
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installedById(): Map<string, Model<Api>> {
  return new Map(installed().map(model => [model.id, model]))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function seenRequests() {
  const requests: { url: string; headers: Record<string, string> }[] = []
  codexListingInternals.allowNetwork = true
  codexListingInternals.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requests.push({ url: requestUrl(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return jsonResponse({ models: [] })
  })
  return requests
}

function stubCodexModels(bodies: readonly unknown[]): { urls: string[] } {
  const urls: string[] = []
  let call = 0
  codexListingInternals.allowNetwork = true
  codexListingInternals.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(requestUrl(input))
    const body = bodies[Math.min(call, bodies.length - 1)]
    call += 1
    if (body instanceof Error) throw body
    if (body instanceof Response) return body
    return jsonResponse(body)
  })
  return { urls }
}

function jwt(payload: unknown): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

const ACCOUNT_JWT = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } })

function oauthSeed(access: string): Record<string, Credential> {
  const credential: OAuthCredential = {
    type: 'oauth',
    access,
    refresh: 'test-refresh',
    expires: Date.now() + 3_600_000,
  }
  return { [OPENAI_CODEX_PROVIDER]: credential }
}

function codexAdapter(auth: ReturnType<typeof memoryAuth>): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ 'openai-codex': {} }),
    resolveApiKey: () => Promise.resolve(undefined),
    auth,
  })
}

const DAYBREAK_BLUE = {
  slug: 'gpt-daybreak-blue-latest',
  display_name: 'Daybreak Blue',
  default_reasoning_level: 'high',
  supported_reasoning_levels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  input_modalities: ['text', 'image'],
}

describe('codexAccountId', () => {
  it('reads the account claim from a JWT access token', () => {
    expect(codexAccountId(ACCOUNT_JWT)).toBe('acc-1')
  })

  it('answers undefined for non-JWT tokens', () => {
    expect(codexAccountId('plain-token')).toBeUndefined()
  })

  it('answers undefined for undecodable payloads', () => {
    expect(codexAccountId('a.bm90LWpzb24.c')).toBeUndefined()
  })

  it.each([
    ['missing claim namespace', jwt({ other: 1 })],
    ['null auth claim', jwt({ 'https://api.openai.com/auth': null })],
    ['string auth claim', jwt({ 'https://api.openai.com/auth': 'acc-1' })],
    ['array auth claim', jwt({ 'https://api.openai.com/auth': [] })],
    ['missing account id', jwt({ 'https://api.openai.com/auth': {} })],
    ['blank account id', jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: '  ' } })],
    ['non-string account id', jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 42 } })],
    ['string payload', `${Buffer.from('{}').toString('base64url')}.${Buffer.from('"str"').toString('base64url')}.s`],
  ])('answers undefined for %s', (_label, token) => {
    expect(codexAccountId(token)).toBeUndefined()
  })
})

describe('fetchCodexModels', () => {
  it('stays offline when unit tests forbid network', async () => {
    expect(codexListingInternals.allowNetwork).toBe(false)
    await expect(fetchCodexModels({ accessToken: 'token' })).resolves.toBeUndefined()
  })

  it('reads /codex/models first with Codex headers', async () => {
    const requests = seenRequests()
    await fetchCodexModels({ accessToken: ACCOUNT_JWT })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${CODEX_BASE_URL}/codex/models?client_version=0.153.4`)
    expect(requests[0]?.headers).toMatchObject({
      authorization: `Bearer ${ACCOUNT_JWT}`,
      'chatgpt-account-id': 'acc-1',
      'openai-beta': 'responses=experimental',
      originator: 'pi',
      version: '0.153.4',
      accept: 'application/json',
    })
    expect(requests[0]?.headers['user-agent']).toMatch(/^deepseek-harness\//)
  })

  it('omits the account header for non-JWT tokens and trims a proxy base', async () => {
    const requests = seenRequests()
    await fetchCodexModels({ accessToken: 'plain-token', baseURL: 'https://proxy.example///' })
    expect(requests[0]?.url).toBe('https://proxy.example/codex/models?client_version=0.153.4')
    expect(requests[0]?.headers).not.toHaveProperty('chatgpt-account-id')
  })

  it('normalizes a Daybreak row from the models shape', async () => {
    stubCodexModels([{ models: [DAYBREAK_BLUE] }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models).toHaveLength(1)
    expect(models?.[0]).toMatchObject({
      id: 'gpt-daybreak-blue-latest',
      name: 'Daybreak Blue',
      reasoning: true,
      input: ['text', 'image'],
      defaultEffort: 'high',
    })
    expect(models?.[0]?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    })
  })

  it('reads the data shape and prefers slug over id', async () => {
    stubCodexModels([{ data: [{ slug: '  gpt-6-astra ', id: 'other', display_name: 'Astra' }] }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.map(model => model.id)).toEqual(['gpt-6-astra'])
    expect(models?.[0]?.name).toBe('Astra')
  })

  it('falls back to the plain path when the first fails', async () => {
    for (const first of [
      new Error('offline'),
      new Response('boom', { status: 500 }),
      new Response('not json', { status: 200 }),
      jsonResponse({ models: { 'gpt-5.5': {} } }),
    ]) {
      const { urls } = stubCodexModels([first, { models: [{ id: 'gpt-5.5' }] }])
      const models = await fetchCodexModels({ accessToken: 'token' })
      expect(models?.map(model => model.id)).toEqual(['gpt-5.5'])
      expect(urls).toEqual([
        `${CODEX_BASE_URL}/codex/models?client_version=0.153.4`,
        `${CODEX_BASE_URL}/models?client_version=0.153.4`,
      ])
    }
  })

  it('answers undefined on credential rejection without a second request', async () => {
    for (const status of [401, 403]) {
      const { urls } = stubCodexModels([new Response('denied', { status })])
      await expect(fetchCodexModels({ accessToken: 'token' })).resolves.toBeUndefined()
      expect(urls).toHaveLength(1)
    }
  })

  it('answers undefined when every path fails or names no rows', async () => {
    stubCodexModels([new Error('offline'), new Error('offline')])
    await expect(fetchCodexModels({ accessToken: 'token' })).resolves.toBeUndefined()
    stubCodexModels([jsonResponse(null), jsonResponse([1, 2])])
    await expect(fetchCodexModels({ accessToken: 'token' })).resolves.toBeUndefined()
    stubCodexModels([jsonResponse({}), jsonResponse({})])
    await expect(fetchCodexModels({ accessToken: 'token' })).resolves.toBeUndefined()
  })

  it('skips hidden and unroutable rows without hiding the rest', async () => {
    stubCodexModels([{
      models: [
        null,
        42,
        [],
        { display_name: 'No Id' },
        { slug: '   ' },
        { slug: 'hidden-model', visibility: 'hidden' },
        { slug: 'hide-model', visibility: 'HIDE' },
        { slug: 'visible-model', visibility: 'list' },
      ],
    }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.map(model => model.id)).toEqual(['visible-model'])
  })

  it('falls back to the id for the name and reasons from the default alone', async () => {
    stubCodexModels([{ models: [{ id: 'gpt-5.5', default_reasoning_level: 'high' }] }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.[0]).toMatchObject({ id: 'gpt-5.5', name: 'gpt-5.5', reasoning: true })
    expect(models?.[0]?.thinkingLevelMap).toBeUndefined()
  })

  it('marks a default-none row without levels as non-reasoning', async () => {
    stubCodexModels([{ models: [{ id: 'plain', default_reasoning_level: 'NONE' }] }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.[0]).toMatchObject({ reasoning: false })
  })

  it('delegates to the global fetch before tests stub it', async () => {
    const globalFetch = globalThis.fetch
    const seen: Parameters<typeof fetch>[0][] = []
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      seen.push(args[0])
      return jsonResponse({ models: [] })
    })
    try {
      codexListingInternals.allowNetwork = true
      await fetchCodexModels({ accessToken: 'token' })
      expect(seen.map(requestUrl)[0]).toContain('/codex/models')
    } finally {
      globalThis.fetch = globalFetch
    }
  })

  it('maps { effort } objects and drops unmappable levels', async () => {
    stubCodexModels([{
      models: [{
        id: 'm',
        default_reasoning_level: 'max',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'low' }, { effort: 'ultra' }, 42, null, ['x']],
      }],
    }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.[0]).toMatchObject({ reasoning: true })
    expect(models?.[0]?.thinkingLevelMap).toMatchObject({ low: 'low', medium: null, off: null })
    expect(models?.[0]?.defaultEffort).toBeUndefined()
  })

  it('offers no selector for a levels row that only names none', async () => {
    for (const levels of [['none'], [], 'levels']) {
      stubCodexModels([{ models: [{ id: 'm', supported_reasoning_levels: levels }] }])
      const models = await fetchCodexModels({ accessToken: 'token' })
      expect(models?.[0]).toMatchObject({ reasoning: false })
      expect(models?.[0]?.thinkingLevelMap).toBeUndefined()
    }
  })

  it('keeps text-only rows text-only and undisclosed rows undisclosed', async () => {
    stubCodexModels([{
      models: [
        { id: 't', input_modalities: ['TEXT', 'video', 42] },
        { id: 'u', input_modalities: ['audio'] },
        { id: 'v', input_modalities: [] },
        { id: 'w' },
      ],
    }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.find(model => model.id === 't')?.input).toEqual(['text'])
    expect(models?.find(model => model.id === 'u')?.input).toBeUndefined()
    expect(models?.find(model => model.id === 'v')?.input).toBeUndefined()
    expect(models?.find(model => model.id === 'w')?.input).toBeUndefined()
  })

  it('reports row windows without applying fallbacks', async () => {
    stubCodexModels([{ models: [{ id: 'gpt-5.5', context_window: 400_000 }] }])
    const models = await fetchCodexModels({ accessToken: 'token' })
    expect(models?.[0]?.contextWindow).toBe(400_000)
  })

  it('omits unusable windows', async () => {
    for (const contextWindow of ['big', 0, -1, 1.5]) {
      stubCodexModels([{ models: [{ id: 'm', context_window: contextWindow }] }])
      const models = await fetchCodexModels({ accessToken: 'token' })
      expect(models?.[0]?.contextWindow).toBeUndefined()
    }
  })
})

describe('mergeCodexCatalogs', () => {
  function live(
    overrides: Omit<Partial<CodexLiveModel>, 'contextWindow'> & { id: string; contextWindow?: number | undefined },
  ): CodexLiveModel {
    const { id, name = id, reasoning = false, contextWindow, ...rest } = overrides
    return {
      id,
      name,
      reasoning,
      ...rest,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
  }

  it('overlays a known id with live name and reported capacities, keeping catalog cost', async () => {
    stubCodexModels([{
      models: [{
        slug: 'gpt-5.6-luna',
        display_name: 'GPT-5.6 Luna Live',
        context_window: 400_000,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: ['low', 'medium', 'high'],
        input_modalities: ['text', 'image'],
      }],
    }])
    const merged = mergeCodexCatalogs((await fetchCodexModels({ accessToken: 'token' })) ?? [], installed())
    const luna = merged.find(model => model.id === 'gpt-5.6-luna')
    const catalog = installedById().get('gpt-5.6-luna')
    expect(luna).toMatchObject({
      name: 'GPT-5.6 Luna Live',
      provider: OPENAI_CODEX_PROVIDER,
      api: 'openai-codex-responses',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: catalog?.cost,
    })
    expect(luna?.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high' })
  })

  it('keeps the installed map when the live row names no levels', () => {
    const catalog = installedById().get('gpt-5.3-codex-spark')
    if (catalog === undefined) throw new Error('expected the spark catalog model')
    const merged = mergeCodexCatalogs(
      [live({ id: 'gpt-5.3-codex-spark', name: 'Spark Live', reasoning: true })],
      installed(),
    )
    const spark = merged.find(model => model.id === 'gpt-5.3-codex-spark')
    expect(spark).toMatchObject({
      name: 'Spark Live',
      reasoning: true,
      contextWindow: catalog.contextWindow,
      thinkingLevelMap: catalog.thinkingLevelMap,
    })
  })

  it('appends a Daybreak row from the template with zero cost', async () => {
    stubCodexModels([{ models: [DAYBREAK_BLUE] }])
    const merged = mergeCodexCatalogs((await fetchCodexModels({ accessToken: 'token' })) ?? [], installed())
    const blue = merged.find(model => model.id === 'gpt-daybreak-blue-latest')
    const template = installed()[0]
    if (template === undefined) throw new Error('expected an installed catalog model')
    expect(blue).toMatchObject({
      name: 'Daybreak Blue',
      provider: OPENAI_CODEX_PROVIDER,
      api: template.api,
      baseUrl: template.baseUrl,
      compat: template.compat,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 372_000,
      maxTokens: 128_000,
    })
    expect(merged.map(model => model.id).indexOf('gpt-daybreak-blue-latest')).toBe(0)
    expect(merged.slice(1).map(model => model.id)).toEqual(installed().map(model => model.id))
  })

  it('floors stale Luna windows and honors reports above the floor', () => {
    const rows = (windows: (number | undefined)[]): CodexLiveModel[] => [
      live({ id: 'gpt-5.6-sol', contextWindow: windows[0] }),
      live({ id: 'gpt-5.6-terra', contextWindow: windows[1] }),
      live({ id: 'gpt-5.5', contextWindow: windows[2] }),
    ]
    const merged = mergeCodexCatalogs(rows([272_000, 1_050_000, undefined]), installed())
    expect(merged.find(model => model.id === 'gpt-5.6-sol')?.contextWindow).toBe(1_000_000)
    expect(merged.find(model => model.id === 'gpt-5.6-terra')?.contextWindow).toBe(1_050_000)
    expect(merged.find(model => model.id === 'gpt-5.5')?.contextWindow)
      .toBe(installedById().get('gpt-5.5')?.contextWindow)
  })

  it('keeps the first live duplicate and synthesizes without an installed catalog', () => {
    const merged = mergeCodexCatalogs(
      [
        live({ id: 'gpt-daybreak-red-latest', name: 'Red One', reasoning: true, contextWindow: 400_000 }),
        live({ id: 'gpt-daybreak-red-latest', name: 'Red Two', reasoning: false }),
      ],
      [],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'gpt-daybreak-red-latest',
      name: 'Red One',
      api: 'openai-codex-responses',
      provider: OPENAI_CODEX_PROVIDER,
      baseUrl: CODEX_BASE_URL,
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    })
  })

  it('synthesizes a thinking map without an installed catalog', () => {
    const merged = mergeCodexCatalogs(
      [{
        id: 'gpt-daybreak-blue-latest',
        name: 'Daybreak Blue',
        reasoning: true,
        input: ['text', 'image'],
        thinkingLevelMap: { low: 'low', medium: null, high: null, minimal: null, xhigh: null, max: null },
        defaultEffort: 'low',
      }],
      [],
    )
    expect(merged[0]?.thinkingLevelMap).toMatchObject({ low: 'low', medium: null })
    expect(merged[0]).toMatchObject({ contextWindow: 372_000 })
  })

  it('sizes an unknown live-only id from the generic default', () => {
    const merged = mergeCodexCatalogs([live({ id: 'gpt-9-future', reasoning: true })], [])
    expect(merged[0]).toMatchObject({ contextWindow: 272_000, maxTokens: 128_000 })
  })

  it('keeps a mapless installed descriptor mapless', () => {
    const catalog = installedById().get('gpt-5.5')
    if (catalog === undefined) throw new Error('expected the 5.5 catalog model')
    const { thinkingLevelMap: _dropped, ...mapless } = catalog
    const merged = mergeCodexCatalogs(
      [live({ id: 'gpt-5.5', name: 'GPT-5.5', reasoning: true })],
      [mapless],
    )
    expect(merged[0]).not.toHaveProperty('thinkingLevelMap')
    expect(merged[0]).toMatchObject({ name: 'GPT-5.5', reasoning: true })
  })

  it('replaces a stale picker default when the live row names a new map', () => {
    const catalog = installedById().get('gpt-5.5')
    if (catalog === undefined) throw new Error('expected the 5.5 catalog model')
    const base = {
      ...catalog,
      thinkingLevelMap: { low: 'low' as const },
      defaultThinkingLevel: 'low' as const,
    } as Model<Api>
    const merged = mergeCodexCatalogs(
      [{
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        thinkingLevelMap: { high: 'high' as const, low: null, medium: null, minimal: null, xhigh: null, max: null },
      }],
      [base],
    )
    expect(merged[0]?.thinkingLevelMap).toMatchObject({ high: 'high', low: null })
    expect(merged[0]).not.toHaveProperty('defaultThinkingLevel')
  })
})

describe('listCodexModels', () => {
  it('answers the installed list when the registry is unreachable', async () => {
    stubCodexModels([new Error('offline'), new Error('offline')])
    const listed = await listCodexModels('token', installed())
    expect(listed).toEqual(installed())
    expect(listed).not.toBe(installed())
  })

  it('merges live rows over the installed catalog', async () => {
    stubCodexModels([{ models: [DAYBREAK_BLUE] }])
    const listed = await listCodexModels('token', installed())
    expect(listed.map(model => model.id)).toContain('gpt-daybreak-blue-latest')
    expect(listed.map(model => model.id)).toEqual(
      expect.arrayContaining(installed().map(model => model.id)),
    )
  })
})

describe('PiAiAdapter Codex listing', () => {
  const adapter = codexAdapter

  it('serves the installed catalog without a stored Codex credential', async () => {
    const requests = seenRequests()
    const listed = await adapter(memoryAuth()).listModels(OPENAI_CODEX_PROVIDER)
    expect(listed.map(model => model.id)).toEqual(installed().map(model => model.id))
    expect(requests).toHaveLength(0)
  })

  it('serves the installed catalog for non-OAuth and blank records', async () => {
    const requests = seenRequests()
    const keyAuth = memoryAuth({ [OPENAI_CODEX_PROVIDER]: { type: 'api_key', key: 'k' } })
    expect((await adapter(keyAuth).listModels(OPENAI_CODEX_PROVIDER)).map(model => model.id))
      .toEqual(installed().map(model => model.id))
    const blankAuth = memoryAuth(oauthSeed('   '))
    expect((await adapter(blankAuth).listModels(OPENAI_CODEX_PROVIDER)).map(model => model.id))
      .toEqual(installed().map(model => model.id))
    expect(requests).toHaveLength(0)
  })

  it('lists a Daybreak model the installed snapshot does not ship', async () => {
    stubCodexModels([{ models: [DAYBREAK_BLUE] }])
    const listed = await adapter(memoryAuth(oauthSeed('test-token'))).listModels(OPENAI_CODEX_PROVIDER)
    expect(listed.map(model => model.id)).toContain('gpt-daybreak-blue-latest')
    expect(listed.find(model => model.id === 'gpt-daybreak-blue-latest')).toMatchObject({
      provider: OPENAI_CODEX_PROVIDER,
      id: 'gpt-daybreak-blue-latest',
      name: 'Daybreak Blue',
    })
    const resolved = await adapter(memoryAuth(oauthSeed('test-token'))).resolveModel(
      OPENAI_CODEX_PROVIDER,
      'gpt-daybreak-blue-latest',
    )
    expect(resolved.reasoning?.defaultEffort).toBe(ReasoningEffortId('high'))
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(
      expect.arrayContaining([ReasoningEffortId('high'), ReasoningEffortId('xhigh')]),
    )
  })

  it('serves the installed catalog when the credential lookup fails', async () => {
    const auth = memoryAuth(oauthSeed('test-token'))
    auth.credentials.read = () => Promise.reject(new Error('disk'))
    const listed = await adapter(auth).listModels(OPENAI_CODEX_PROVIDER)
    expect(listed.map(model => model.id)).toEqual(installed().map(model => model.id))
  })

  it('falls back to the installed catalog when the registry fails', async () => {
    stubCodexModels([new Error('offline'), new Error('offline')])
    const listed = await adapter(memoryAuth(oauthSeed('test-token'))).listModels(OPENAI_CODEX_PROVIDER)
    expect(listed.map(model => model.id)).toEqual(installed().map(model => model.id))
  })

  it('reads a proxy baseURL from the profile', async () => {
    const { urls } = stubCodexModels([{ models: [] }])
    const proxy = new PiAiAdapter({
      profiles: () => resolveProfiles({ 'openai-codex': { baseURL: 'https://proxy.example' } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth(oauthSeed('test-token')),
    })
    await proxy.listModels(OPENAI_CODEX_PROVIDER)
    expect(urls[0]).toBe('https://proxy.example/codex/models?client_version=0.153.4')
  })
})
