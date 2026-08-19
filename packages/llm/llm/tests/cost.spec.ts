import { describe, expect, it } from 'vitest'
import { priceTokenUsage } from '../src/cost.ts'

describe('priceTokenUsage', () => {
  it('prices disjoint input, cache, and output buckets per million tokens', () => {
    const priced = priceTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    }, {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 3,
    }, 'reported-usage')
    expect(priced).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costBasis: 'reported-usage',
    })
    expect(priced.estimatedCostUsd).toBeCloseTo(0.00016)
  })

  it('leaves usage unpriced when a non-empty bucket has no rate', () => {
    expect(priceTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
    }, {
      input: 1,
      output: 2,
    }, 'estimated-input')).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
    })
  })
})
