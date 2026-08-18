/**
 * OpenAI-compatible `GET /models` listing shared by endpoint interrogation and
 * the live overlay on installed-catalog routes.
 *
 * A catalog OpenRouter route that keeps its installed catalog (no explicit
 * `models` list) overlays the endpoint's current listing onto that catalog:
 * installed ids keep catalog metadata, and tool-capable ids the snapshot does
 * not ship are appended. Overlay is the `openrouter` catalog id, or a listable
 * route whose listing host is `openrouter.ai` / `*.openrouter.ai`. Other
 * catalog endpoints share the inference URL and are not listed. An explicit
 * `models` list still replaces the catalog and is not overlaid. Network
 * failure falls back to the installed catalog so a picker never goes empty
 * because OpenRouter was unreachable.
 *
 * Rows that disclose `supported_parameters` without `"tools"` are dropped;
 * listings that omit the field (generic OpenAI `GET /models`) keep every
 * usable id. Unit tests leave non-loopback listings off so they never wait on
 * a provider API; production (VITEST unset) always lists.
 *
 * @module dsh-llm-pi-ai/listing
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { Api, Model } from '@earendil-works/pi-ai'
import { catalogModels, catalogProvider } from './catalog.ts'

/**
 * Protocols whose model listing this module can read: the two that speak
 * OpenAI's `GET /models` shape with bearer auth. Azure is absent despite its
 * OpenAI lineage — it authenticates with an `api-key` header and requires an
 * `api-version` query — and Codex authenticates through OAuth; guessing at
 * either would report an authentication failure as a provider with no models.
 * pi-ai's remaining protocols are absent for the same reason.
 */
export const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** One entry of an OpenAI-compatible `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  architecture?: unknown
  top_provider?: unknown
  supported_parameters?: unknown
}

/** Injectable listing HTTP so tests pin loopback servers without hitting provider APIs. */
export const modelListingInternals = {
  /** Resolves `fetch` at call time so `vi.stubGlobal('fetch')` still applies. */
  fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, init)) as typeof fetch,
  /* v8 ignore next -- production leaves VITEST unset and always lists non-loopback endpoints. */
  allowNonLoopback: process.env['VITEST'] !== 'true',
}

const listingCache = new Map<string, readonly LlmDiscoveredModel[]>()
const listingInflight = new Map<string, Promise<readonly LlmDiscoveredModel[]>>()

/** Drop process-lifetime listing cache. Tests call this so one scripted reply cannot leak. */
export function resetModelListingCache(): void {
  listingCache.clear()
  listingInflight.clear()
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Nested object field, or `undefined`. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 * @param baseURL - endpoint prefix, with or without a trailing slash.
 * @returns the listing URL.
 */
export function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Whether this listing URL may be fetched in the current process. Loopback is
 * always allowed (scripted unit servers). Non-loopback is refused while
 * {@link modelListingInternals.allowNonLoopback} is false.
 * @param url - absolute listing URL.
 * @returns whether {@link fetchModelListing} may call the network.
 */
export function modelListingAllowed(url: string): boolean {
  if (modelListingInternals.allowNonLoopback) return true
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

function listingHost(baseURL: string): string | undefined {
  try {
    return new URL(listingUrl(baseURL)).hostname
  } catch {
    return undefined
  }
}

/**
 * Whether a listable catalog route should overlay a live listing. OpenRouter's
 * public `/models` list outruns the installed snapshot; other OpenAI-compatible
 * catalog endpoints share the inference base URL and ship a complete snapshot,
 * so overlaying them would issue a GET that is not a catalog refresh and can
 * consume a scripted inference reply.
 */
function overlaysLiveCatalog(provider: string, baseURL: string): boolean {
  if (provider === 'openrouter') return true
  const host = listingHost(baseURL)
  return host === 'openrouter.ai' || (host !== undefined && host.endsWith('.openrouter.ai'))
}

/**
 * Protocol and endpoint to list for a catalog route, when that route overlays
 * a live listing. OpenRouter (the catalog id, or an OpenRouter hostname on
 * another listable route) overlays; other catalog endpoints do not.
 * @param provider - provider route key.
 * @param profile - optional protocol and endpoint overrides.
 * @returns the protocol and base URL to list, or `undefined` when this route
 *   has no readable listing.
 */
export function catalogListingTarget(
  provider: string,
  profile: { api?: string; baseURL?: string } = {},
): { api: string; baseURL: string } | undefined {
  const catalog = catalogProvider(provider)
  const baseURL = profile.baseURL ?? catalog?.baseUrl
  if (baseURL === undefined || baseURL.length === 0) return undefined
  const apis = new Set<string>()
  for (const model of catalogModels(provider).values()) apis.add(model.api)
  const api = profile.api ?? (apis.size === 1 ? [...apis][0] : undefined)
  if (api === undefined || !LISTABLE_PROTOCOLS.has(api)) return undefined
  if (!overlaysLiveCatalog(provider, baseURL)) return undefined
  return { api, baseURL }
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Whether one listing row can serve tool calls. OpenRouter publishes
 * `supported_parameters`; a row that names the field without `"tools"` cannot
 * run the harness tool loop. Listings that omit the field keep the row.
 * @param entry - one `data[]` element.
 * @returns whether the row should be offered.
 */
function listingRowSupportsTools(entry: ListingEntry): boolean {
  const params = entry.supported_parameters
  if (params === undefined) return true
  if (!Array.isArray(params)) return true
  return params.includes('tools')
}

/**
 * Read one OpenAI-compatible listing reply. Entries without a usable id are
 * skipped rather than failing the whole interrogation: a single malformed row
 * should not deny the user the rest of a working endpoint's catalog.
 * @param body - parsed JSON reply.
 * @returns advertised models in endpoint order.
 */
export function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = (raw ?? {}) as ListingEntry
    const id = label(entry.id)
    if (id === undefined) continue
    if (!listingRowSupportsTools(entry)) continue
    const architecture = record(entry.architecture)
    const topProvider = record(entry.top_provider)
    const name = label(entry.name, entry.display_name)
    const contextWindow = capacity(
      entry.context_window,
      entry.context_length,
      architecture?.['input_length'],
    )
    const maxTokens = capacity(
      entry.max_output_tokens,
      entry.max_tokens,
      topProvider?.['max_completion_tokens'],
      architecture?.['output_length'],
    )
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/** Cache key: listing URL plus whether a credential rode the request. */
function listingCacheKey(url: string, apiKey: string | undefined): string {
  if (apiKey === undefined) return `${url}\0anon`
  let hash = 0
  for (let i = 0; i < apiKey.length; i++) hash = (hash * 33 + apiKey.charCodeAt(i)) | 0
  return `${url}\0auth:${apiKey.length}:${hash}`
}

/**
 * Fetch and parse one OpenAI-compatible model listing. Successful replies are
 * cached for the process lifetime so the picker can overlay without repeating
 * the same GET on every `listModels` call; failures are not cached.
 * @param options - listing URL parts, optional bearer key, optional abort.
 * @returns advertised models in endpoint order.
 * @throws LlmError when the endpoint refuses, the reply is not a listing, or
 *   unit tests have non-loopback listings disabled.
 */
export async function fetchModelListing(options: {
  baseURL: string
  apiKey?: string
  signal?: AbortSignal
}): Promise<readonly LlmDiscoveredModel[]> {
  const url = listingUrl(options.baseURL)
  if (!modelListingAllowed(url)) {
    throw new LlmError(`${url} listing is disabled in unit tests`, 'DISCOVERY_FAILED')
  }
  const cacheKey = listingCacheKey(url, options.apiKey)
  const cached = listingCache.get(cacheKey)
  if (cached !== undefined) return cached
  const pending = listingInflight.get(cacheKey)
  if (pending !== undefined) return pending
  const request = readListingFromNetwork(url, options).then((models) => {
    listingCache.set(cacheKey, models)
    return models
  })
  listingInflight.set(cacheKey, request)
  try {
    return await request
  } finally {
    listingInflight.delete(cacheKey)
  }
}

async function readListingFromNetwork(
  url: string,
  options: { apiKey?: string; signal?: AbortSignal },
): Promise<readonly LlmDiscoveredModel[]> {
  let response: Response
  try {
    response = await modelListingInternals.fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` },
        ...attributionHeaders(),
      },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}

/**
 * Merge an installed catalog's discovered rows with a live listing. Installed
 * ids keep catalog name and capacities (a listing rarely matches those);
 * live-only ids append in listing order.
 * @param installed - catalog rows in catalog order.
 * @param live - tool-filtered listing rows.
 * @returns the union, catalog ids first.
 */
export function overlayDiscoveredModels(
  installed: readonly LlmDiscoveredModel[],
  live: readonly LlmDiscoveredModel[],
): LlmDiscoveredModel[] {
  const seen = new Set(installed.map(model => model.id))
  const extra = live.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
  return [...installed, ...extra]
}

/**
 * Overlay a live listing onto installed pi-ai models so the picker and the
 * request path share one catalog. Known ids keep the installed descriptor;
 * live-only ids clone the first installed model's protocol and endpoint.
 * @param installed - models the route already serves.
 * @param live - tool-filtered listing rows.
 * @param fallback - capacities for a live-only id the listing did not size.
 * @returns installed models followed by live-only models.
 */
export function overlayLiveCatalogModels(
  installed: readonly Model<Api>[],
  live: readonly LlmDiscoveredModel[],
  fallback: { contextWindow: number; maxTokens: number },
): Model<Api>[] {
  const template = installed[0]
  if (template === undefined) return []
  const seen = new Set(installed.map(model => model.id))
  const extra: Model<Api>[] = []
  for (const row of live) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const { thinkingLevelMap: _catalogMap, ...rest } = template
    extra.push({
      ...rest,
      id: row.id,
      name: row.name ?? row.id,
      reasoning: false,
      contextWindow: row.contextWindow ?? fallback.contextWindow,
      maxTokens: row.maxTokens ?? fallback.maxTokens,
      input: ['text'],
    })
  }
  return [...installed, ...extra]
}
