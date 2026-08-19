/**
 * Bundled Gemini CLI fallback catalog. Cloud Code Assist has no OpenAI-style
 * `GET /models`; this snapshot is what the picker shows after login.
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/models
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  GOOGLE_GEMINI_CLI_API,
  GOOGLE_GEMINI_CLI_BASE_URL,
  GOOGLE_GEMINI_CLI_PROVIDER,
} from './constants.ts'

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const VISION_INPUT: Model<Api>['input'] = ['text', 'image']

/** Input capacity assumed for current Gemini CLI ids. */
export const GEMINI_CLI_DEFAULT_CONTEXT_WINDOW = 1_048_576
/** Output cap assumed for current Gemini CLI ids. */
export const GEMINI_CLI_DEFAULT_MAX_TOKENS = 65_536

interface FallbackSpec {
  id: string
  name: string
  reasoning: boolean
}

/**
 * Offline catalog served after `/login google-gemini-cli`. Ids follow Gemini
 * CLI / Cloud Code Assist spellings, not the `google` API-key catalog.
 */
const FALLBACK: readonly FallbackSpec[] = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', reasoning: false },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', reasoning: true },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', reasoning: true },
]

/**
 * Bundled Gemini CLI models this adapter serves without a network round trip.
 * @returns pi-ai models tagged `google-gemini-cli`.
 */
export function geminiCliFallbackModels(): Model<Api>[] {
  return FALLBACK.map(entry => geminiCliModel(entry.id, entry.name, entry.reasoning))
}

/**
 * One Gemini CLI model descriptor.
 * @param id - Cloud Code Assist model id.
 * @param name - display name.
 * @param reasoning - whether the model thinks.
 * @returns a vision-capable pi-ai model.
 */
export function geminiCliModel(id: string, name: string, reasoning: boolean): Model<Api> {
  return {
    id,
    name,
    api: GOOGLE_GEMINI_CLI_API,
    provider: GOOGLE_GEMINI_CLI_PROVIDER,
    baseUrl: GOOGLE_GEMINI_CLI_BASE_URL,
    reasoning,
    input: VISION_INPUT,
    cost: NO_COST,
    contextWindow: GEMINI_CLI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: GEMINI_CLI_DEFAULT_MAX_TOKENS,
  }
}
