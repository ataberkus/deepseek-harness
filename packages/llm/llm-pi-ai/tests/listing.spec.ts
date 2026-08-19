/** Live OpenAI-compatible listing overlay for installed-catalog routes. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import {
  catalogListingTarget,
  fetchModelListing,
  listingUrl,
  modelListingAllowed,
  modelListingInternals,
  overlayDiscoveredModels,
  overlayLiveCatalogModels,
  readListing,
  resetModelListingCache,
} from '../src/listing.ts'

const servers: Server[] = []

afterEach(async () => {
  resetModelListingCache()
  modelListingInternals.allowNonLoopback = false
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function listingServer(behavior: {
  status?: number
  body?: string
  holdOpenMs?: number
}): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    if (behavior.holdOpenMs !== undefined) {
      response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
      response.write(behavior.body ?? '{"data":[]}')
      setTimeout(() => { response.end() }, behavior.holdOpenMs)
      return
    }
    const body = behavior.body ?? '{"data":[]}'
    response.writeHead(behavior.status ?? 200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    })
    response.end(body)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address !== 'object') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths }
}

describe('listingUrl / modelListingAllowed / catalogListingTarget', () => {
  it('keeps a deployment path and allows loopback while refusing other hosts in unit tests', () => {
    expect(listingUrl('https://gateway.example/openai/v1/')).toBe('https://gateway.example/openai/v1/models')
    expect(modelListingAllowed('http://127.0.0.1:9/models')).toBe(true)
    expect(modelListingAllowed('http://[::1]/models')).toBe(true)
    expect(modelListingAllowed('https://openrouter.ai/api/v1/models')).toBe(false)
    expect(modelListingAllowed('not a url')).toBe(false)
    modelListingInternals.allowNonLoopback = true
    expect(modelListingAllowed('https://openrouter.ai/api/v1/models')).toBe(true)
  })

  it('names a listable catalog endpoint and refuses one that is not', () => {
    expect(catalogListingTarget('openrouter')).toEqual({
      api: 'openai-completions',
      baseURL: 'https://openrouter.ai/api/v1',
    })
    expect(catalogListingTarget('openrouter', { baseURL: 'http://127.0.0.1/v1' })).toEqual({
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1/v1',
    })
    expect(catalogListingTarget('deepseek')).toBeUndefined()
    expect(catalogListingTarget('openai')).toBeUndefined()
    expect(catalogListingTarget('deepseek', { baseURL: 'https://openrouter.ai/api/v1' })).toEqual({
      api: 'openai-completions',
      baseURL: 'https://openrouter.ai/api/v1',
    })
    expect(catalogListingTarget('openai', { api: 'openai-completions', baseURL: 'https://preview.openrouter.ai/api/v1' })).toEqual({
      api: 'openai-completions',
      baseURL: 'https://preview.openrouter.ai/api/v1',
    })
    expect(catalogListingTarget('deepseek', { baseURL: 'not a url' })).toBeUndefined()
    expect(catalogListingTarget('missing')).toBeUndefined()
    expect(catalogListingTarget('openrouter', { api: 'anthropic-messages' })).toBeUndefined()
    expect(catalogListingTarget('missing', { baseURL: 'http://127.0.0.1/v1' })).toBeUndefined()
    expect(catalogListingTarget('missing', { api: 'openai-completions', baseURL: 'http://127.0.0.1/v1' }))
      .toBeUndefined()
    expect(catalogListingTarget('openrouter', { baseURL: '' })).toBeUndefined()
  })
})

describe('readListing', () => {
  it('reads OpenRouter capacities and drops rows that cannot call tools', () => {
    expect(readListing({
      data: [
        {
          id: 'vendor/with-tools',
          name: 'With Tools',
          architecture: { input_length: 100_000, output_length: 8_000 },
          supported_parameters: ['tools', 'temperature'],
        },
        {
          id: 'vendor/reasoning',
          supported_parameters: ['tools', 'reasoning'],
        },
        {
          id: 'vendor/effort',
          supported_parameters: ['tools', 'reasoning_effort'],
        },
        {
          id: 'vendor/no-tools',
          supported_parameters: ['temperature'],
        },
        {
          id: 'vendor/params-object',
          supported_parameters: { tools: true },
        },
        { id: 'vendor/plain' },
        { id: 'vendor/null-architecture', architecture: null, top_provider: [] },
        { id: '' },
        null,
        {
          id: 'vendor/top-provider',
          name: '',
          display_name: 'Top',
          context_window: 32_000,
          top_provider: { max_completion_tokens: 4_096 },
        },
        { id: 'vendor/fraction', context_window: 1.5 },
      ],
    })).toEqual([
      { id: 'vendor/with-tools', name: 'With Tools', contextWindow: 100_000, maxTokens: 8_000 },
      { id: 'vendor/reasoning', reasoning: true },
      { id: 'vendor/effort', reasoning: true },
      { id: 'vendor/params-object' },
      { id: 'vendor/plain' },
      { id: 'vendor/null-architecture' },
      { id: 'vendor/top-provider', name: 'Top', contextWindow: 32_000, maxTokens: 4_096 },
      { id: 'vendor/fraction' },
    ])
  })

  it('refuses a body with no data array', () => {
    expect(() => readListing({ models: [] })).toThrow(/no "data" array/)
    expect(() => readListing(null)).toThrow(/no "data" array/)
  })
})

describe('overlay helpers', () => {
  it('appends live-only discovered ids and keeps catalog rows first', () => {
    expect(overlayDiscoveredModels(
      [{ id: 'known', name: 'Known', contextWindow: 1, maxTokens: 2 }],
      [
        { id: 'known', name: 'Live name' },
        { id: 'extra', reasoning: true },
        { id: 'extra' },
      ],
    )).toEqual([
      { id: 'known', name: 'Known', contextWindow: 1, maxTokens: 2 },
      { id: 'extra' },
    ])
  })

  it('clones the first installed model for live-only ids', () => {
    const [template] = getBuiltinModels('openrouter')
    if (template === undefined) throw new Error('expected an OpenRouter catalog model')
    expect(overlayLiveCatalogModels([], [{ id: 'x' }], { contextWindow: 1, maxTokens: 2 })).toEqual([])
    const overlaid = overlayLiveCatalogModels(
      [template],
      [{ id: template.id }, { id: 'vendor/live-only', name: 'Live', contextWindow: 9, maxTokens: 3 }],
      { contextWindow: 100, maxTokens: 10 },
    )
    expect(overlaid).toHaveLength(2)
    expect(overlaid[0]).toBe(template)
    expect(overlaid[1]).toMatchObject({
      id: 'vendor/live-only',
      name: 'Live',
      provider: template.provider,
      api: template.api,
      baseUrl: template.baseUrl,
      reasoning: false,
      contextWindow: 9,
      maxTokens: 3,
      input: ['text'],
    })
    expect(overlaid[1]).not.toHaveProperty('thinkingLevelMap')
    const reasoning = overlayLiveCatalogModels(
      [template],
      [{ id: 'vendor/thinks', reasoning: true }],
      { contextWindow: 100, maxTokens: 10 },
    )
    expect(reasoning[1]).toMatchObject({
      id: 'vendor/thinks',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
    })
    const fallback = overlayLiveCatalogModels(
      [template],
      [{ id: 'vendor/unsized' }],
      { contextWindow: 100, maxTokens: 10 },
    )
    expect(fallback[1]).toMatchObject({ id: 'vendor/unsized', name: 'vendor/unsized', contextWindow: 100, maxTokens: 10 })
  })
})

describe('fetchModelListing', () => {
  it('caches a successful listing, coalesces in-flight reads, and retries a failure', async () => {
    const server = await listingServer({
      body: JSON.stringify({ data: [{ id: 'a' }] }),
      holdOpenMs: 20,
    })
    const [first, second] = await Promise.all([
      fetchModelListing({ baseURL: server.url }),
      fetchModelListing({ baseURL: server.url }),
    ])
    expect(first).toEqual([{ id: 'a' }])
    expect(second).toEqual([{ id: 'a' }])
    expect(server.paths).toHaveLength(1)
    await expect(fetchModelListing({ baseURL: server.url })).resolves.toEqual([{ id: 'a' }])
    expect(server.paths).toHaveLength(1)

    const refused = await listingServer({ status: 401, body: '{}' })
    await expect(fetchModelListing({ baseURL: refused.url, apiKey: 'k' }))
      .rejects.toThrow(/answered 401; check the API key/)
    const forbidden = await listingServer({ status: 403, body: '{}' })
    await expect(fetchModelListing({ baseURL: forbidden.url })).rejects.toThrow(/answered 403; check the API key/)
    const broken = await listingServer({ status: 500, body: '{}' })
    await expect(fetchModelListing({ baseURL: broken.url })).rejects.toThrow(/answered 500$/)
    await expect(fetchModelListing({ baseURL: broken.url })).rejects.toThrow(/answered 500$/)
    const notJson = await listingServer({ body: 'not-json' })
    await expect(fetchModelListing({ baseURL: notJson.url })).rejects.toThrow(/did not answer with JSON/)

    const keyed = await listingServer({ body: JSON.stringify({ data: [{ id: 'k' }] }) })
    await fetchModelListing({ baseURL: keyed.url, apiKey: 'one' })
    await fetchModelListing({ baseURL: keyed.url, apiKey: 'two' })
    await fetchModelListing({ baseURL: keyed.url })
    expect(keyed.paths).toHaveLength(3)
  })

  it('refuses a non-loopback listing in unit tests and an unreachable loopback', async () => {
    await expect(fetchModelListing({ baseURL: 'https://openrouter.ai/api/v1' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    await expect(fetchModelListing({ baseURL: 'http://127.0.0.1:9/v1' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    const aborted = AbortSignal.abort('test')
    await expect(fetchModelListing({ baseURL: 'http://127.0.0.1:9/v1', signal: aborted }))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })
})
