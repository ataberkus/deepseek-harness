/**
 * Live Codex model listing over the ChatGPT OAuth backend.
 *
 * pi-ai ships the `openai-codex` catalog as a static snapshot, so account-entitled
 * SKUs that landed after the snapshot was cut (Daybreak Blue and other rolling
 * aliases) never appear in the picker. This module fetches the account-scoped
 * registry (`GET {baseURL}/codex/models`, then `/models`) with the stored OAuth
 * access token and merges it over the installed catalog: live rows win per id,
 * installed-only ids stay, and live-only ids are built from the first installed
 * model so protocol, endpoint, and compatibility travel with them. Any failure
 * answers `undefined` and the caller keeps the installed catalog, so the picker
 * never goes empty because the registry was unreachable. An explicit profile
 * `models` list never reaches this module; the adapter returns it untouched.
 *
 * The registry is account-scoped: the `chatgpt-account-id` claim is read from the
 * JWT access token and sent beside the bearer token, with the `version` header and
 * `client_version` query the backend version-gates availability against. No byte
 * ceiling is enforced here: unlike the user-typed gateway URLs in `listing.ts`,
 * this endpoint is the fixed Codex backend (or a deliberate proxy override), the
 * same trust posture as the hosted Cursor listing.
 *
 * @module dsh-llm-pi-ai/codex/models
 */

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { OPENAI_CODEX_PROVIDER } from '../oauth-hosts.ts'
import { attachThinking, listingEffortToLevel, thinkingLevelMapFromOffered } from '../thinking-levels.ts'

/**
 * Codex backend origin serving inference and the account model registry. Mirrors
 * the installed catalog models' `baseUrl`; a profile `baseURL` override replaces
 * it per call for proxy deployments.
 */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

/** pi-ai `Model.api` carried by every Codex descriptor this module builds. */
export const CODEX_API = 'openai-codex-responses'

/** Registry paths tried in order; the plain path is the fallback. */
const CODEX_MODELS_PATHS = ['/codex/models', '/models'] as const

/**
 * Client version sent as the `version` header and `client_version` query. The
 * backend version-gates model availability against it, so the pin mirrors the
 * `@openai/codex` dependency in `dsh-subagent-codex`: discovery sees what the
 * bundled CLI sees.
 */
const CODEX_CLIENT_VERSION = '0.153.4'

/** JWT claim namespace carrying the ChatGPT account id. */
const CODEX_JWT_CLAIM = 'https://api.openai.com/auth'

/** Capacity assumed when a row omits `context_window`. */
const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000

/** Capacity assumed for GPT-5.6-generation rows that omit `context_window`. */
const GPT_5_6_DEFAULT_CONTEXT_WINDOW = 372_000

/** Output cap; the registry never advertises more per request. */
const CODEX_DEFAULT_MAX_TOKENS = 128_000

/**
 * Slugs whose registry window predates the 1M subscription rollout and must be
 * floored; reports above the floor are honored as-is.
 */
const CODEX_1M_SLUGS = new Set(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'])

/** Slugs riding the GPT-5.6 wire generation, including rolling Daybreak aliases. */
const GPT_5_6_FAMILY = /^(gpt-5\.6|gpt-daybreak)/

/** Pricing for a live-only model the installed catalog does not describe. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Injectable listing HTTP so tests pin scripted replies without hitting OpenAI. */
export const codexListingInternals = {
  /** Resolves `fetch` at call time so `vi.stubGlobal('fetch')` still applies. */
  fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, init)),
  /* v8 ignore next -- production leaves VITEST unset and always lists. */
  allowNetwork: process.env['VITEST'] !== 'true',
}

/** One usable Codex registry row, normalized for the merge. */
export interface CodexLiveModel {
  /** Registry slug: the id the backend routes. */
  id: string
  /** Registry display name. */
  name: string
  /** Whether the row disclosed reasoning (a non-`none` default or effort). */
  reasoning: boolean
  /** Request modalities, present only when the row disclosed them. */
  input?: Model<Api>['input']
  /** Reported row window, present only when the row sized itself. */
  contextWindow?: number
  /** Effort map, present only when the row named usable levels. */
  thinkingLevelMap?: ThinkingLevelMap
  /** Picker default, present only when the row defaulted to an offered level. */
  defaultEffort?: ModelThinkingLevel
}

/** Options for {@link fetchCodexModels}. */
export interface CodexFetchOptions {
  /** OAuth access token; never logged. */
  accessToken: string
  /** Registry origin; defaults to {@link CODEX_BASE_URL}. */
  baseURL?: string
}

/** One entry of a Codex registry reply. */
interface CodexRegistryEntry {
  slug?: unknown
  id?: unknown
  display_name?: unknown
  context_window?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: unknown
  input_modalities?: unknown
  visibility?: unknown
}

/** A non-empty trimmed string, or `undefined`. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A positive integer, or `undefined` when absent or unusable. */
function capacity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/**
 * Read the ChatGPT account id from an OAuth access token without validating it.
 * @param accessToken - Codex OAuth access token; never logged.
 * @returns the account id claim, or `undefined` when the token carries none.
 */
export function codexAccountId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split('.')[1]
    if (payload === undefined) return undefined
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = claims[CODEX_JWT_CLAIM]
    if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return undefined
    return text((auth as Record<string, unknown>)['chatgpt_account_id'])
  } catch {
    return undefined
  }
}

/** Registry URL for one path candidate; the base is a prefix, never resolved. */
function codexModelsUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}${path}?client_version=${CODEX_CLIENT_VERSION}`
}

/** Headers the registry requires beside the harness attribution. */
function codexHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    ...accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
    'OpenAI-Beta': 'responses=experimental',
    originator: 'pi',
    version: CODEX_CLIENT_VERSION,
    accept: 'application/json',
    ...attributionHeaders(),
  }
}

/**
 * Fetch the account registry and normalize its usable rows in backend order.
 * @param options - access token and optional registry origin.
 * @returns live rows, or `undefined` when no registry path answered usably.
 */
export async function fetchCodexModels(options: CodexFetchOptions): Promise<CodexLiveModel[] | undefined> {
  if (!codexListingInternals.allowNetwork) return undefined
  const baseURL = options.baseURL ?? CODEX_BASE_URL
  const accountId = codexAccountId(options.accessToken)
  const headers = codexHeaders(options.accessToken, accountId)
  for (const path of CODEX_MODELS_PATHS) {
    let response: Response
    try {
      response = await codexListingInternals.fetch(codexModelsUrl(baseURL, path), { headers })
    } catch {
      continue
    }
    if (response.status === 401 || response.status === 403) return undefined
    if (!response.ok) continue
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      continue
    }
    const models = normalizeCodexModels(payload)
    if (models === undefined) continue
    return models
  }
  return undefined
}

/**
 * Read one registry reply. Entries without a routable slug and hidden rows are
 * skipped rather than failing the fetch: one malformed row must not hide the
 * rest of the account's catalog.
 * @param payload - parsed reply body.
 * @returns usable rows in reply order, or `undefined` when the reply has no row list.
 */
function normalizeCodexModels(payload: unknown): CodexLiveModel[] | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const body = payload as { models?: unknown; data?: unknown }
  const entries = body.models ?? body.data
  if (!Array.isArray(entries)) return undefined
  const models: CodexLiveModel[] = []
  for (const entry of entries) {
    const model = normalizeCodexEntry(entry)
    if (model !== undefined) models.push(model)
  }
  return models
}

/** Normalize one registry entry, or `undefined` when it names no usable slug. */
function normalizeCodexEntry(entry: unknown): CodexLiveModel | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const row = entry as CodexRegistryEntry
  const id = text(row.slug) ?? text(row.id)
  if (id === undefined) return undefined
  const visibility = text(row.visibility)?.toLowerCase()
  if (visibility === 'hide' || visibility === 'hidden') return undefined
  const thinking = codexThinking(row.default_reasoning_level, row.supported_reasoning_levels)
  const defaultOn = codexDefaultOn(row.default_reasoning_level)
  const input = codexInput(row.input_modalities)
  const contextWindow = capacity(row.context_window)
  return {
    id,
    name: text(row.display_name) ?? id,
    reasoning: defaultOn || thinking !== undefined,
    ...input === undefined ? {} : { input },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...thinking === undefined ? {} : {
      thinkingLevelMap: thinking.map,
      ...thinking.defaultEffort === undefined ? {} : { defaultEffort: thinking.defaultEffort },
    },
  }
}

/** Whether the row defaulted reasoning to something other than `none`. */
function codexDefaultOn(defaultLevel: unknown): boolean {
  const name = text(defaultLevel)?.toLowerCase()
  return name !== undefined && name !== 'none'
}

/**
 * Map the row's reasoning disclosure onto a picker effort map. Levels arrive as
 * bare names or `{ effort }` objects; unmappable names are dropped. A row naming
 * only `none` offers no selector.
 * @param defaultLevel - row `default_reasoning_level`.
 * @param supported - row `supported_reasoning_levels`.
 * @returns the map and default, or `undefined` when the row names no usable level.
 */
function codexThinking(
  defaultLevel: unknown,
  supported: unknown,
): { map: ThinkingLevelMap; defaultEffort?: ModelThinkingLevel } | undefined {
  const offered: ModelThinkingLevel[] = []
  if (Array.isArray(supported)) {
    for (const entry of supported) {
      const name = typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)['effort']
          : undefined
      const level = listingEffortToLevel(name)
      if (level !== undefined && !offered.includes(level)) offered.push(level)
    }
  }
  if (!offered.some(level => level !== 'off')) return undefined
  const parsedDefault = listingEffortToLevel(defaultLevel)
  const defaultEffort = parsedDefault !== undefined && offered.includes(parsedDefault) ? parsedDefault : undefined
  const map = thinkingLevelMapFromOffered(offered)
  return defaultEffort === undefined ? { map } : { map, defaultEffort }
}

/**
 * Map the row's modality disclosure. Absence stays absent so the merge keeps the
 * installed modalities (or text-only for live-only ids): an undisclosed image
 * claim would admit an attachment the backend then rejects.
 * @param modalities - row `input_modalities`.
 * @returns the modalities, or `undefined` when the row disclosed none.
 */
function codexInput(modalities: unknown): Model<Api>['input'] | undefined {
  if (!Array.isArray(modalities)) return undefined
  let image = false
  let disclosed = false
  for (const entry of modalities) {
    const name = typeof entry === 'string' ? entry.toLowerCase() : undefined
    if (name !== 'text' && name !== 'image') continue
    disclosed = true
    if (name === 'image') image = true
  }
  if (!disclosed) return undefined
  return image ? ['text', 'image'] : ['text']
}

/**
 * Size one row. A reported window wins; an omitted one keeps the known id's
 * catalog capacity, or the generation default for a live-only id. Luna, Sol,
 * and Terra floor at the subscription 1M window the registry still
 * under-reports, while reports above the floor are honored as-is.
 * @param id - registry slug.
 * @param reported - row `context_window`.
 * @param catalogWindow - known id's installed capacity, if any.
 * @returns the input capacity and output cap.
 */
function codexCapacities(
  id: string,
  reported: number | undefined,
  catalogWindow: number | undefined,
): { contextWindow: number; maxTokens: number } {
  const fallback = catalogWindow
    ?? (GPT_5_6_FAMILY.test(id) ? GPT_5_6_DEFAULT_CONTEXT_WINDOW : CODEX_DEFAULT_CONTEXT_WINDOW)
  const window = reported ?? fallback
  const contextWindow = CODEX_1M_SLUGS.has(id) ? Math.max(window, 1_000_000) : window
  return { contextWindow, maxTokens: Math.min(CODEX_DEFAULT_MAX_TOKENS, contextWindow) }
}

/**
 * Merge live rows over the installed catalog. Live rows come first in backend
 * order; installed-only ids follow in catalog order. A live row keeps its
 * registry name and reported capacities (an omitted window keeps the known
 * id's catalog capacity); a live-only id clones the first installed model's
 * protocol, endpoint, and compatibility with zero cost (a subscription has no
 * per-token billing fact to carry), while a known id keeps its catalog cost.
 * A live effort map replaces the snapshot map; otherwise the installed
 * descriptor (including its map) survives untouched.
 * @param live - normalized registry rows.
 * @param installed - models the route already serves.
 * @returns the union the picker and the request path share.
 */
export function mergeCodexCatalogs(
  live: readonly CodexLiveModel[],
  installed: readonly Model<Api>[],
): Model<Api>[] {
  const installedById = new Map(installed.map(model => [model.id, model]))
  const template = installed[0]
  const seen = new Set<string>()
  const merged: Model<Api>[] = []
  for (const row of live) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const same = installedById.get(row.id)
    const base = same ?? template
    if (base === undefined) {
      merged.push(codexModelWithoutBase(row))
      continue
    }
    const { thinkingLevelMap: baseMap, ...rest } = base
    const capacities = codexCapacities(row.id, row.contextWindow, same?.contextWindow)
    const model: Model<Api> = {
      ...rest,
      id: row.id,
      name: row.name,
      reasoning: row.reasoning || base.reasoning,
      input: row.input ?? base.input,
      ...same === undefined ? { cost: { ...NO_COST } } : {},
      ...capacities,
    }
    if (row.thinkingLevelMap === undefined) {
      merged.push(baseMap === undefined ? model : { ...model, thinkingLevelMap: baseMap })
      continue
    }
    const { defaultThinkingLevel: _stale, ...withoutDefault } =
      model as Model<Api> & { defaultThinkingLevel?: unknown }
    merged.push(attachThinking(withoutDefault, row.thinkingLevelMap, row.defaultEffort))
  }
  for (const model of installed) {
    if (!seen.has(model.id)) merged.push(model)
  }
  return merged
}

/**
 * Build a descriptor with no installed base (pi-ai no longer ships the route).
 * @param row - normalized registry row.
 * @returns a Codex descriptor with protocol constants and zero cost.
 */
function codexModelWithoutBase(row: CodexLiveModel): Model<Api> {
  const model: Model<Api> = {
    id: row.id,
    name: row.name,
    api: CODEX_API,
    provider: OPENAI_CODEX_PROVIDER,
    baseUrl: CODEX_BASE_URL,
    reasoning: row.reasoning,
    input: row.input ?? ['text'],
    cost: { ...NO_COST },
    ...codexCapacities(row.id, row.contextWindow, undefined),
  }
  return row.thinkingLevelMap === undefined
    ? model
    : attachThinking(model, row.thinkingLevelMap, row.defaultEffort)
}

/**
 * Resolve the account registry over the installed catalog. Any failure answers
 * the installed list so the picker never goes empty.
 * @param accessToken - Codex OAuth access token; never logged.
 * @param installed - models the route already serves.
 * @param baseURL - registry origin; defaults to {@link CODEX_BASE_URL}.
 * @returns live rows merged over the installed catalog, or the installed list.
 */
export async function listCodexModels(
  accessToken: string,
  installed: readonly Model<Api>[],
  baseURL?: string,
): Promise<Model<Api>[]> {
  const live = await fetchCodexModels({ accessToken, ...baseURL === undefined ? {} : { baseURL } })
  if (live === undefined) return [...installed]
  return mergeCodexCatalogs(live, installed)
}
