/** Picker and request path overlay live listings onto installed-catalog routes. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { resolveProfiles } from '../src/config.ts'
import { isolateDshHome, removeIsolatedHomes } from './dsh-home.ts'
import { memoryAuth } from './auth-double.ts'
import { resetModelListingCache } from '../src/listing.ts'

const servers: Server[] = []

beforeEach(async () => {
  await isolateDshHome()
})

afterEach(async () => {
  resetModelListingCache()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await removeIsolatedHomes()
})

async function listingServer(body: unknown): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    const text = JSON.stringify(body)
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
    response.end(text)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address !== 'object') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, paths }
}

describe('live catalog overlay', () => {
  it('lists and resolves a tool-capable id the installed snapshot does not ship', async () => {
    const catalog = getBuiltinModels('openrouter')
    const known = catalog[0]
    if (known === undefined) throw new Error('expected an OpenRouter catalog model')
    const server = await listingServer({
      data: [
        { id: known.id, supported_parameters: ['tools'] },
        { id: 'vendor/live-only', name: 'Live Only', context_length: 64_000, max_output_tokens: 8_192, supported_parameters: ['tools'] },
        { id: 'vendor/no-tools', supported_parameters: ['temperature'] },
      ],
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openrouter: { baseURL: server.url } } })

    const listed = await ctx.llm.listModels('openrouter')
    expect(listed.map(model => model.id)).toContain(known.id)
    expect(listed.map(model => model.id)).toContain('vendor/live-only')
    expect(listed.map(model => model.id)).not.toContain('vendor/no-tools')
    await expect(ctx.llm.resolveModelInfo('openrouter', 'vendor/live-only')).resolves.toMatchObject({
      provider: 'openrouter',
      id: 'vendor/live-only',
      name: 'Live Only',
      context: { contextWindow: 64_000 },
    })
    expect((await ctx.llm.resolveModelInfo('openrouter', 'vendor/live-only')).reasoning).toBeUndefined()
    expect(server.paths).toContain('/models')
  })

  it('reuses one listing overlay across listModels and per-id resolveModelInfo', async () => {
    const catalog = getBuiltinModels('openrouter')
    const known = catalog[0]
    if (known === undefined) throw new Error('expected an OpenRouter catalog model')
    const server = await listingServer({
      data: [
        { id: known.id, supported_parameters: ['tools'] },
        { id: 'vendor/live-only', name: 'Live Only', supported_parameters: ['tools'] },
      ],
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openrouter: { baseURL: server.url } } })
    const listed = await ctx.llm.listModels('openrouter')
    const before = server.paths.length
    await Promise.all(listed.map(model => ctx.llm.resolveModelInfo('openrouter', model.id)))
    expect(server.paths.length).toBe(before)
  })

  it('exposes OpenRouter efforts for a live-only row that discloses reasoning', async () => {
    const catalog = getBuiltinModels('openrouter')
    const known = catalog[0]
    if (known === undefined) throw new Error('expected an OpenRouter catalog model')
    const server = await listingServer({
      data: [
        { id: known.id, supported_parameters: ['tools'] },
        {
          id: 'deepseek/deepseek-flash',
          name: 'DeepSeek Flash',
          supported_parameters: ['tools', 'reasoning'],
        },
      ],
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openrouter: { baseURL: server.url } } })

    const resolved = await ctx.llm.resolveModelInfo('openrouter', 'deepseek/deepseek-flash')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual([
      ReasoningEffortId('low'),
      ReasoningEffortId('medium'),
      ReasoningEffortId('high'),
    ])
  })

  it('uses OpenRouter supported_efforts and default_effort for a live DeepSeek id', async () => {
    const catalog = getBuiltinModels('openrouter')
    const known = catalog[0]
    if (known === undefined) throw new Error('expected an OpenRouter catalog model')
    const server = await listingServer({
      data: [
        { id: known.id, supported_parameters: ['tools'] },
        {
          id: 'deepseek/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
          reasoning: {
            mandatory: false,
            supported_efforts: ['xhigh', 'high'],
            default_effort: 'high',
          },
        },
      ],
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openrouter: { baseURL: server.url } } })

    const resolved = await ctx.llm.resolveModelInfo('openrouter', 'deepseek/deepseek-v4-flash')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual([
      ReasoningEffortId('high'),
      ReasoningEffortId('xhigh'),
    ])
    expect(resolved.reasoning?.defaultEffort).toBe(ReasoningEffortId('high'))
  })

  it('does not overlay when the profile names an explicit models list', async () => {
    const catalog = getBuiltinModels('openrouter')
    const known = catalog[0]
    if (known === undefined) throw new Error('expected an OpenRouter catalog model')
    const server = await listingServer({
      data: [{ id: 'vendor/live-only', supported_parameters: ['tools'] }],
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        openrouter: {
          baseURL: server.url,
          models: [{ id: known.id }],
        },
      },
    })

    const listed = await ctx.llm.listModels('openrouter')
    expect(listed.map(model => model.id)).toEqual([known.id])
    expect(server.paths).toEqual([])
  })

  it('falls back to the installed catalog when listing fails', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { openrouter: { baseURL: 'http://127.0.0.1:9/v1' } } })
    const listed = await ctx.llm.listModels('openrouter')
    expect(listed.map(model => model.id).sort())
      .toEqual(getBuiltinModels('openrouter').map(model => model.id).sort())
  })

  it('still lists when the named credential is missing, and rethrows other listing-key faults', async () => {
    const catalog = getBuiltinModels('openrouter')
    const known = catalog[0]
    if (known === undefined) throw new Error('expected an OpenRouter catalog model')
    const server = await listingServer({
      data: [{ id: 'vendor/live-only', supported_parameters: ['tools'] }],
    })
    const missing = new PiAiAdapter({
      profiles: () => resolveProfiles({ openrouter: { apiKeyEnv: 'ABSENT_LIVE_KEY', baseURL: server.url } }),
      resolveApiKey: () => Promise.reject(new LlmError('missing', 'MISSING_CREDENTIAL')),
      auth: memoryAuth(),
    })
    expect((await missing.listModels('openrouter')).map(model => model.id)).toContain('vendor/live-only')

    const invalid = new PiAiAdapter({
      profiles: () => resolveProfiles({ openrouter: { apiKeyEnv: 'ABSENT_LIVE_KEY', baseURL: server.url } }),
      resolveApiKey: () => Promise.reject(new LlmError('bad key', 'INVALID_CREDENTIAL')),
      auth: memoryAuth(),
    })
    expect((await invalid.listModels('openrouter')).map(model => model.id)).toContain('vendor/live-only')

    const boom = new PiAiAdapter({
      profiles: () => resolveProfiles({ openrouter: { baseURL: server.url } }),
      resolveApiKey: () => Promise.reject(new Error('disk')),
      auth: memoryAuth(),
    })
    await expect(boom.listModels('openrouter')).rejects.toThrow(/disk/)
  })

  it('sends a resolved listing key and honors a profile protocol override', async () => {
    const headers: string[] = []
    const server = createServer((request, response) => {
      headers.push(request.headers.authorization ?? '')
      const text = JSON.stringify({ data: [{ id: 'vendor/keyed', supported_parameters: ['tools'] }] })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
      response.end(text)
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address !== 'object') throw new Error('no port')
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        openrouter: {
          api: 'openai-completions',
          apiKeyEnv: 'ABSENT_LIVE_KEY',
          baseURL: `http://127.0.0.1:${address.port}`,
        },
      }),
      resolveApiKey: () => Promise.resolve('listing-secret'),
      auth: memoryAuth(),
    })
    expect((await adapter.listModels('openrouter')).map(model => model.id)).toContain('vendor/keyed')
    expect(headers).toEqual(['Bearer listing-secret'])
  })
})
