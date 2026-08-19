/**
 * Bundled Cursor fallback catalog and live GetUsableModels overlay.
 *
 * @module dsh-llm-pi-ai/cursor/models
 */

import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  CURSOR_API,
  CURSOR_BASE_URL,
  CURSOR_MODELS_PATH,
  CURSOR_NO_USABLE_MODELS_CODE,
  CURSOR_PROVIDER,
} from './constants.ts'
import { connectUnary } from './connect.ts'
import {
  decodeFields,
  encodeString,
  fieldRepeated,
  fieldString,
} from './protobuf.ts'
import { attachThinking, thinkingLevelMapFromOffered } from '../thinking-levels.ts'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const TEXT_INPUT: Model<Api>['input'] = ['text']
const VISION_INPUT: Model<Api>['input'] = ['text', 'image']

/** Ids whose Cursor SKU is a coding model, not a vision chat model. */
const CURSOR_TEXT_ONLY = /grok-code/

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
 * @returns a pi-ai model whose `input` is `[text, image]` for Cursor chat
 *   families and `[text]` for `grok-code` and unknown ids.
 */
export function cursorModel(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow: number = CURSOR_DEFAULT_CONTEXT_WINDOW,
): Model<Api> {
  const model: Model<Api> = {
    id,
    name,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER,
    baseUrl: CURSOR_BASE_URL,
    reasoning,
    input: inferCursorInput(id),
    cost: NO_COST,
    contextWindow,
    maxTokens: CURSOR_DEFAULT_MAX_TOKENS,
  }
  if (!reasoning) return model
  const spec = cursorThinkingSpec(id)
  return attachThinking(
    model,
    thinkingLevelMapFromOffered(spec.efforts, spec.offWire),
    spec.defaultEffort,
  )
}

interface CursorThinkingSpec {
  efforts: readonly ModelThinkingLevel[]
  defaultEffort: ModelThinkingLevel
  offWire?: string
}

/**
 * Documented Cursor family effort lists. GetUsableModels `ThinkingDetails` is
 * a presence flag with no effort names, so the picker cannot read them live.
 * @param id - Cursor model id, including `-fast` siblings.
 * @returns offered levels; unknown reasoning ids get `low`/`medium`/`high`.
 */
function cursorThinkingSpec(id: string): CursorThinkingSpec {
  const bare = id.replace(/-fast$/i, '').toLowerCase()
  if (bare.includes('grok-code')) {
    return { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }
  }
  if (bare.includes('grok-4.6')) {
    return { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }
  }
  if (bare.includes('grok')) {
    return { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }
  }
  if (bare.includes('gpt-5.4')) {
    return {
      efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      offWire: 'none',
    }
  }
  if (/gpt-|codex/.test(bare)) {
    return {
      efforts: ['off', 'minimal', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
      offWire: 'none',
    }
  }
  if (/claude|opus|sonnet|haiku/.test(bare)) {
    return { efforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' }
  }
  if (bare.includes('gemini')) {
    return { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'high' }
  }
  if (bare.includes('kimi') || /(^|\/)k3$/.test(bare)) {
    return { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }
  }
  if (bare.includes('glm')) {
    return { efforts: ['low', 'high', 'max'], defaultEffort: 'high' }
  }
  if (bare.includes('composer')) {
    return { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }
  }
  return { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }
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
 * omitted. Network failure returns the fallback; a successful empty reply
 * fails so the picker does not advertise unconfirmed models.
 * @param accessToken - Cursor access token; never logged.
 * @param signal - abort listing.
 * @returns live ids first, then fallback-only ids including priced Fast SKUs.
 */
export async function listCursorModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<Model<Api>[]> {
  const fallback = cursorFallbackModels()
  let payload: Uint8Array
  try {
    payload = await cursorListingInternals.fetch(accessToken, signal)
  } catch {
    return withFastVariants(fallback)
  }
  const live = decodeUsableModels(payload)
  if (live.length === 0) {
    throw new LlmError(
      'Cursor GetUsableModels returned no usable models; check the Cursor service and retry model discovery',
      CURSOR_NO_USABLE_MODELS_CODE,
    )
  }
  return withFastVariants(mergeCursorCatalogs(live, fallback))
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
  return cursorChatFamily(id)
}

/**
 * Whether this Cursor id is a vision chat model. GetUsableModels has no
 * image-capability field, so the same family tokens as reasoning apply;
 * `grok-code` stays text-only. Unknown ids stay text-only rather than
 * admitting an image the unofficial backend would then reject.
 * @param id - Cursor model id.
 * @returns request modalities.
 */
function inferCursorInput(id: string): Model<Api>['input'] {
  if (CURSOR_TEXT_ONLY.test(id.toLowerCase())) return TEXT_INPUT
  if (FALLBACK_BY_ID.has(id) || cursorChatFamily(id)) return VISION_INPUT
  return TEXT_INPUT
}

function cursorChatFamily(id: string): boolean {
  const lower = id.toLowerCase()
  if (CURSOR_TEXT_ONLY.test(lower)) return false
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
