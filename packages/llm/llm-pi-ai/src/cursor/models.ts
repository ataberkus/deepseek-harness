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
 * Offline catalog served until GetUsableModels succeeds. Ids match names
 * Cursor currently lists for a subscription account; a live overlay appends
 * anything this snapshot does not ship.
 */
const FALLBACK: readonly FallbackSpec[] = [
  { id: 'composer-1.5', name: 'Composer 1.5', reasoning: true, contextWindow: 200_000 },
  { id: 'composer-1', name: 'Composer 1', reasoning: true, contextWindow: 200_000 },
  { id: 'grok-4.5', name: 'Grok 4.5', reasoning: true, contextWindow: 256_000 },
  { id: 'claude-4.6-sonnet', name: 'Claude 4.6 Sonnet', reasoning: true, contextWindow: 200_000 },
  { id: 'claude-4.6-opus', name: 'Claude 4.6 Opus', reasoning: true, contextWindow: 200_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, contextWindow: 272_000 },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true, contextWindow: 272_000 },
]

/**
 * Bundled Cursor models this adapter serves without a network round trip.
 * @returns pi-ai models tagged `cursor-agent`.
 */
export function cursorFallbackModels(): Model<Api>[] {
  return FALLBACK.map(spec => cursorModel(spec.id, spec.name, spec.reasoning, spec.contextWindow))
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
    const reasoning = fieldRepeated(fields, 2).length > 0
    const contextWindow = inferContextWindow(id, name)
    models.push(cursorModel(id, name, reasoning, contextWindow))
  }
  return models
}

/**
 * Overlay live GetUsableModels onto the bundled fallback. Network failure
 * returns the fallback so a picker never goes empty.
 * @param accessToken - Cursor access token; never logged.
 * @param signal - abort listing.
 * @returns fallback ids first, then live-only ids.
 */
export async function listCursorModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Model<Api>[]> {
  const fallback = cursorFallbackModels()
  try {
    const payload = await cursorListingInternals.fetch(accessToken, signal)
    const live = decodeUsableModels(payload)
    if (live.length === 0) return fallback
    const seen = new Set(fallback.map(model => model.id))
    const extra = live.filter((model) => {
      if (seen.has(model.id)) return false
      seen.add(model.id)
      return true
    })
    return [...fallback, ...extra]
  } catch {
    return fallback
  }
}

function inferContextWindow(id: string, name: string): number {
  const blob = `${id} ${name}`.toLowerCase()
  if (/\b1m\b/.test(blob)) return 1_000_000
  if (/\b272k\b/.test(blob)) return 272_000
  if (/\b256k\b/.test(blob)) return 256_000
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
