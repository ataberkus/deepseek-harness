/**
 * Bundled Cursor fallback catalog and live GetUsableModels overlay.
 *
 * @module dsh-llm-pi-ai/cursor/models
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  CURSOR_API,
  CURSOR_BASE_URL,
  CURSOR_MODELS_PATH,
  CURSOR_PROVIDER,
} from './constants.ts'
import { connectUnary } from './connect.ts'
import {
  decodeFields,
  encodeString,
  fieldRepeated,
  fieldString,
} from './protobuf.ts'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Capacities assumed when GetUsableModels omits them. */
export const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000
/** Output cap assumed when GetUsableModels omits it. */
export const CURSOR_DEFAULT_MAX_TOKENS = 32_768

interface FallbackSpec {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
}

/**
 * Offline catalog served until GetUsableModels succeeds, and used to fill
 * documented `-fast` siblings when live listing omits them. Ids follow
 * Cursor's public model table (standard SKU plus Fast where Cursor ships one).
 */
const FALLBACK: readonly FallbackSpec[] = [
  spec('composer-1.5', 'Composer 1.5'),
  spec('composer-1', 'Composer 1'),
  spec('composer-2.5', 'Composer 2.5'),
  spec('composer-2.5-fast', 'Composer 2.5 Fast'),
  spec('grok-4.6', 'Grok 4.6', 256_000),
  spec('grok-4.6-fast', 'Grok 4.6 Fast', 256_000),
  spec('grok-4.5', 'Grok 4.5', 256_000),
  spec('grok-4.5-fast', 'Grok 4.5 Fast', 256_000),
  spec('claude-4.6-sonnet', 'Claude 4.6 Sonnet'),
  spec('claude-4.6-opus', 'Claude 4.6 Opus'),
  spec('claude-4.5-sonnet', 'Claude 4.5 Sonnet'),
  spec('claude-4.5-opus', 'Claude 4.5 Opus'),
  spec('claude-4.5-haiku', 'Claude 4.5 Haiku'),
  spec('claude-opus-5', 'Claude Opus 5'),
  spec('claude-opus-5-fast', 'Claude Opus 5 Fast'),
  spec('gpt-5.4', 'GPT-5.4', 272_000),
  spec('gpt-5.3-codex', 'GPT-5.3 Codex', 272_000),
  spec('gpt-5', 'GPT-5'),
  spec('gpt-5-fast', 'GPT-5 Fast'),
  spec('gemini-3-flash', 'Gemini 3 Flash'),
  spec('gemini-3-pro', 'Gemini 3 Pro'),
  spec('kimi-k3', 'Kimi K3', 1_000_000),
]

function spec(id: string, name: string, contextWindow = CURSOR_DEFAULT_CONTEXT_WINDOW): FallbackSpec {
  return { id, name, reasoning: true, contextWindow }
}

const FALLBACK_BY_ID = new Map(FALLBACK.map(entry => [entry.id, entry]))

/**
 * Bundled Cursor models this adapter serves without a network round trip.
 * @returns pi-ai models tagged `cursor-agent`.
 */
export function cursorFallbackModels(): Model<Api>[] {
  return FALLBACK.map(entry => cursorModel(entry.id, entry.name, entry.reasoning, entry.contextWindow))
}

/**
 * One Cursor model descriptor.
 * @param id - Cursor model id.
 * @param name - display name.
 * @param reasoning - whether the model thinks.
 * @param contextWindow - input capacity.
 * @returns a pi-ai model.
 */
export function cursorModel(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow: number = CURSOR_DEFAULT_CONTEXT_WINDOW,
): Model<Api> {
  return {
    id,
    name,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER,
    baseUrl: CURSOR_BASE_URL,
    reasoning,
    input: ['text'],
    cost: NO_COST,
    contextWindow,
    maxTokens: CURSOR_DEFAULT_MAX_TOKENS,
  }
}

/** Injectable listing so tests never hit Cursor. */
export const cursorListingInternals = {
  /** Unary GetUsableModels; tests replace this. */
  fetch: defaultCursorListingFetch,
  /* v8 ignore next -- production leaves VITEST unset and always lists. */
  allowNetwork: process.env['VITEST'] !== 'true',
}

async function defaultCursorListingFetch(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!cursorListingInternals.allowNetwork) {
    throw new Error('Cursor GetUsableModels is skipped in unit tests')
  }
  return connectUnary({
    baseUrl: CURSOR_BASE_URL,
    path: CURSOR_MODELS_PATH,
    accessToken,
    body: new Uint8Array(),
    ...signal === undefined ? {} : { signal },
  })
}

/**
 * Decode GetUsableModelsResponse.models into pi-ai models.
 * @param payload - protobuf payload (Connect wrapper already stripped).
 * @returns models with ids; empty when the reply names none.
 */
export function decodeUsableModels(payload: Uint8Array): Model<Api>[] {
  const models: Model<Api>[] = []
  const seen = new Set<string>()
  for (const raw of fieldRepeated(decodeFields(payload), 1)) {
    const fields = decodeFields(raw)
    const id = fieldString(fields, 1).trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = fieldString(fields, 4) || fieldString(fields, 3) || id
    const reasoning = inferCursorReasoning(id, fieldRepeated(fields, 2).length > 0)
    const contextWindow = inferContextWindow(id, name)
    models.push(cursorModel(id, name, reasoning, contextWindow))
  }
  return models
}

/**
 * Overlay live GetUsableModels onto the bundled fallback. Live ids win;
 * fallback fills documented ids (including `-fast` siblings) the reply
 * omitted. Network failure or an empty reply returns the fallback so a
 * picker never goes empty.
 * @param accessToken - Cursor access token; never logged.
 * @param signal - abort listing.
 * @returns live ids first, then fallback-only ids including priced Fast SKUs.
 */
export async function listCursorModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Model<Api>[]> {
  const fallback = cursorFallbackModels()
  try {
    const payload = await cursorListingInternals.fetch(accessToken, signal)
    const live = decodeUsableModels(payload)
    if (live.length === 0) return withFastVariants(fallback)
    return withFastVariants(mergeCursorCatalogs(live, fallback))
  } catch {
    return withFastVariants(fallback)
  }
}

/**
 * Live listing first, then fallback ids the endpoint did not name.
 * @param live - decoded GetUsableModels rows.
 * @param fallback - bundled catalog.
 * @returns the union, live descriptors winning on id collision.
 */
export function mergeCursorCatalogs(
  live: readonly Model<Api>[],
  fallback: readonly Model<Api>[],
): Model<Api>[] {
  const byId = new Map<string, Model<Api>>()
  for (const model of live) byId.set(model.id, model)
  for (const model of fallback) {
    if (!byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()]
}

/**
 * Ensure each non-fast id that has a documented Fast sibling also appears as
 * `{id}-fast`. Cursor's picker lists both; GetUsableModels sometimes ships
 * only the standard id.
 * @param models - live-or-fallback union.
 * @returns the same list plus missing documented Fast SKUs.
 */
export function withFastVariants(models: readonly Model<Api>[]): Model<Api>[] {
  const byId = new Map(models.map(model => [model.id, model]))
  for (const model of models) {
    if (model.id.endsWith('-fast')) continue
    const fastId = `${model.id}-fast`
    if (byId.has(fastId)) continue
    const documented = FALLBACK_BY_ID.get(fastId)
    if (documented === undefined) continue
    byId.set(fastId, cursorModel(
      fastId,
      documented.name,
      model.reasoning,
      model.contextWindow,
    ))
  }
  return [...byId.values()]
}

function inferCursorReasoning(id: string, thinkingDetails: boolean): boolean {
  if (thinkingDetails) return true
  const documented = FALLBACK_BY_ID.get(id)
  if (documented !== undefined) return documented.reasoning
  const lower = id.toLowerCase()
  if (lower.includes('grok-code')) return false
  return /grok|claude|gpt-|composer|gemini|kimi|glm|opus|sonnet/.test(lower)
}

function inferContextWindow(id: string, name: string): number {
  const blob = `${id} ${name}`.toLowerCase()
  if (/\b1m\b/.test(blob)) return 1_000_000
  if (/\b272k\b/.test(blob)) return 272_000
  if (/\b256k\b/.test(blob)) return 256_000
  const documented = FALLBACK_BY_ID.get(id)
  if (documented !== undefined) return documented.contextWindow
  return CURSOR_DEFAULT_CONTEXT_WINDOW
}

/**
 * Encode GetUsableModelsRequest (empty, or custom ids). Unused at runtime; tests pin field 1.
 * @param customModelIds - optional ids to request; empty means the default listing.
 * @returns protobuf payload (not Connect-framed).
 */
export function encodeUsableModelsRequest(customModelIds: readonly string[] = []): Uint8Array {
  const parts = customModelIds.map(id => encodeString(1, id))
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
