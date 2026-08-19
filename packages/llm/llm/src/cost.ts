import type { TokenCostBasis, TokenPricing, TokenUsage } from './types.ts'

/**
 * Apply a per-million-token rate card to disjoint provider usage buckets.
 * Missing rates make a non-empty bucket unpriced and leave the usage unchanged.
 * @param usage - provider usage with disjoint cache buckets.
 * @param pricing - per-million-token rates; omitted buckets are unavailable.
 * @param basis - why the usage estimate is complete or approximate.
 * @returns usage carrying an estimate when every non-empty bucket is priced.
 */
export function priceTokenUsage(
  usage: TokenUsage,
  pricing: TokenPricing,
  basis: TokenCostBasis,
): TokenUsage {
  const buckets: readonly [number, number | undefined][] = [
    [usage.inputTokens, pricing.input],
    [usage.outputTokens, pricing.output],
    [usage.cacheReadTokens ?? 0, pricing.cacheRead],
    [usage.cacheWriteTokens ?? 0, pricing.cacheWrite],
  ]
  if (buckets.some(([tokens, rate]) => tokens > 0 && rate === undefined)) return usage
  const estimatedCostUsd = buckets.reduce(
    (total, [tokens, rate]) => total + tokens * (rate ?? 0) / 1_000_000,
    0,
  )
  return { ...usage, estimatedCostUsd, costBasis: basis }
}
