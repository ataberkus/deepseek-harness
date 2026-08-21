/**
 * Bundled Antigravity fallback catalog. Cloud Code Assist has no OpenAI-style
 * `GET /models`; this snapshot is what the picker shows after login.
 *
 * @module dsh-llm-pi-ai/google-antigravity/models
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  GOOGLE_ANTIGRAVITY_API,
  GOOGLE_ANTIGRAVITY_BASE_URL,
  GOOGLE_ANTIGRAVITY_PROVIDER,
} from './constants.ts'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const VISION_INPUT: Model<Api>['input'] = ['text', 'image']
const TEXT_ONLY_INPUT: Model<Api>['input'] = ['text']

/** Input capacity assumed for standard Antigravity models. */
export const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 1_048_576
/** Output cap assumed for standard Antigravity models. */
export const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 65_536

interface FallbackSpec {
  id: string
  name: string
  reasoning: boolean
  contextWindow?: number
  maxTokens?: number
  input?: Model<Api>['input']
}

/**
 * Offline catalog served after `/login google-antigravity`.
 * Supports Google Gemini, Anthropic Claude, and GPT-OSS models via Antigravity backend.
 */
const FALLBACK: readonly FallbackSpec[] = [
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', reasoning: true },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro Preview', reasoning: true, maxTokens: 65_535 },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', reasoning: true },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', reasoning: true, maxTokens: 65_535 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true, maxTokens: 65_535 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 250_000, maxTokens: 64_000 },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 250_000, maxTokens: 64_000 },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'gpt-oss-120b', name: 'GPT OSS 120B', reasoning: true, contextWindow: 131_072, maxTokens: 32_768, input: TEXT_ONLY_INPUT },
]

/**
 * Bundled Antigravity models this adapter serves without a network round trip.
 * @returns pi-ai models tagged `google-antigravity`.
 */
export function antigravityFallbackModels(): Model<Api>[] {
  return FALLBACK.map(entry => antigravityModel(
    entry.id,
    entry.name,
    entry.reasoning,
    entry.contextWindow,
    entry.maxTokens,
    entry.input,
  ))
}

/**
 * One Antigravity model descriptor.
 * @param id - Cloud Code Assist model id.
 * @param name - display name.
 * @param reasoning - whether the model thinks.
 * @param contextWindow - context limit (tokens).
 * @param maxTokens - output limit (tokens).
 * @param input - supported input modalities.
 * @returns a pi-ai model descriptor.
 */
export function antigravityModel(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow = ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
  maxTokens = ANTIGRAVITY_DEFAULT_MAX_TOKENS,
  input = VISION_INPUT,
): Model<Api> {
  return {
    id,
    name,
    api: GOOGLE_ANTIGRAVITY_API,
    provider: GOOGLE_ANTIGRAVITY_PROVIDER,
    baseUrl: GOOGLE_ANTIGRAVITY_BASE_URL,
    reasoning,
    input,
    cost: NO_COST,
    contextWindow,
    maxTokens,
  }
}
