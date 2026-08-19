import type { TokenPricing } from '@deepseek-ai/dsh-llm'

/**
 * Cursor's documented per-million-token rates as of 2026-08-19.
 * Source: https://cursor.com/docs/models-and-pricing
 *
 * A zero cache-write rate represents the table's `-` entry: Cursor does not
 * publish a separate charge for that bucket. This is a checked-in snapshot;
 * runtime requests never scrape the documentation page.
 */
type CursorPricing = Required<TokenPricing>

const RATES: Readonly<Record<string, CursorPricing>> = {
  'grok-4.6': { input: 2, cacheWrite: 0, cacheRead: 0.5, output: 6 },
  'grok-4.6-fast': { input: 4, cacheWrite: 0, cacheRead: 1, output: 12 },
  'grok-4.5': { input: 2, cacheWrite: 0, cacheRead: 0.5, output: 6 },
  'grok-4.5-fast': { input: 4, cacheWrite: 0, cacheRead: 1, output: 12 },
  'composer-2.5': { input: 0.5, cacheWrite: 0, cacheRead: 0.2, output: 2.5 },
  'composer-2.5-fast': { input: 3, cacheWrite: 0, cacheRead: 0.5, output: 15 },
  'claude-4-sonnet': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-4-sonnet-1m': { input: 6, cacheWrite: 7.5, cacheRead: 0.6, output: 22.5 },
  'claude-4.5-haiku': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'claude-4.5-opus': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-4.5-sonnet': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-4.6-opus': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-4.6-sonnet': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-4.7-opus': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-4.7-fast': { input: 30, cacheWrite: 37.5, cacheRead: 3, output: 150 },
  'claude-4.8-opus': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-4.8-fast': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-opus-5': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-5-fast': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-sonnet-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'gemini-2.5-flash': { input: 0.3, cacheWrite: 0, cacheRead: 0.03, output: 2.5 },
  'gemini-3-flash': { input: 0.5, cacheWrite: 0, cacheRead: 0.05, output: 3 },
  'gemini-3-pro': { input: 2, cacheWrite: 0, cacheRead: 0.2, output: 12 },
  'gemini-3.1-pro': { input: 2, cacheWrite: 0, cacheRead: 0.2, output: 12 },
  'gemini-3.5-flash': { input: 1.5, cacheWrite: 0, cacheRead: 0.15, output: 9 },
  'gemini-3.6-flash': { input: 1.5, cacheWrite: 0, cacheRead: 0.15, output: 7.5 },
  'gemini-3.7-flash': { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 3.5 },
  'glm-5.2': { input: 1.4, cacheWrite: 0, cacheRead: 0.26, output: 4.4 },
  'gpt-5': { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 },
  'gpt-5-fast': { input: 2.5, cacheWrite: 0, cacheRead: 0.25, output: 20 },
  'gpt-5-mini': { input: 0.25, cacheWrite: 0, cacheRead: 0.025, output: 2 },
  'gpt-5-codex': { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 },
  'gpt-5.1-codex': { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 },
  'gpt-5.1-codex-max': { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 },
  'gpt-5.1-codex-mini': { input: 0.25, cacheWrite: 0, cacheRead: 0.025, output: 2 },
  'gpt-5.2': { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  'gpt-5.2-codex': { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  'gpt-5.3-codex': { input: 1.75, cacheWrite: 0, cacheRead: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cacheWrite: 0, cacheRead: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cacheWrite: 0, cacheRead: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5, cacheWrite: 0, cacheRead: 0.5, output: 30 },
  'gpt-5.6-luna': { input: 0.2, cacheWrite: 0.25, cacheRead: 0.02, output: 1.2 },
  'gpt-5.6-sol': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 12 },
  'kimi-k2.7-code': { input: 0.95, cacheWrite: 0, cacheRead: 0.19, output: 4 },
  'kimi-k3': { input: 3, cacheWrite: 0, cacheRead: 0.3, output: 15 },
}

const CURSOR_MODELS = new Set([
  'grok-4.6',
  'grok-4.6-fast',
  'grok-4.5',
  'grok-4.5-fast',
  'composer-2.5',
  'composer-2.5-fast',
])

function normalizedModelId(id: string): string {
  const normalized = id.toLowerCase().trim()
  return normalized.replace(/-(?:low|medium|high|xhigh|max|extra-high)$/u, '')
}

/**
 * Look up the checked-in Cursor rate card and apply an optional team rate.
 * @param modelId - live Cursor model id, including effort suffixes.
 * @param cursorTokenRate - Teams/Enterprise third-party surcharge per million.
 * @returns rates per million, or undefined when Cursor has no documented rate.
 */
export function cursorPricingForModel(modelId: string, cursorTokenRate = 0): CursorPricing | undefined {
  const key = normalizedModelId(modelId)
  const pricing = RATES[key]
  if (pricing === undefined) return undefined
  const surcharge = CURSOR_MODELS.has(key) ? 0 : cursorTokenRate
  return {
    input: pricing.input + surcharge,
    output: pricing.output + surcharge,
    cacheRead: pricing.cacheRead + surcharge,
    cacheWrite: pricing.cacheWrite + surcharge,
  }
}
