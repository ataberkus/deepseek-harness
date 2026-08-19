/** Canonical thinking maps for live listings and Cursor family tables. */
import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  advertisedDefaultEffort,
  attachThinking,
  listingEffortToLevel,
  openRouterThinkingFromListing,
  parseThinkingLevel,
  thinkingLevelMapFromOffered,
} from '../src/thinking-levels.ts'

const BASE: Model<Api> = {
  id: 'm',
  name: 'M',
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
}

describe('thinking-levels', () => {
  it('parses canonical names and maps OpenRouter none to off', () => {
    expect(parseThinkingLevel('high')).toBe('high')
    expect(parseThinkingLevel('nope')).toBeUndefined()
    expect(parseThinkingLevel(1)).toBeUndefined()
    expect(listingEffortToLevel('none')).toBe('off')
    expect(listingEffortToLevel('high')).toBe('high')
    expect(listingEffortToLevel(false)).toBeUndefined()
  })

  it('pins undeclared levels and leaves Off absent when offered without a wire value', () => {
    expect(thinkingLevelMapFromOffered(['high'])).toMatchObject({
      off: null,
      minimal: null,
      high: 'high',
      xhigh: null,
    })
    expect(thinkingLevelMapFromOffered(['off', 'high'])).not.toHaveProperty('off')
    expect(thinkingLevelMapFromOffered(['off', 'high'], 'none').off).toBe('none')
  })

  it('attaches a map and reads the advertised default only when canonical', () => {
    const withDefault = attachThinking(BASE, thinkingLevelMapFromOffered(['high']), 'high')
    expect(withDefault.reasoning).toBe(true)
    expect(advertisedDefaultEffort(withDefault)).toBe('high')
    expect(advertisedDefaultEffort(attachThinking(BASE, thinkingLevelMapFromOffered(['low'])))).toBeUndefined()
    expect(advertisedDefaultEffort(BASE)).toBeUndefined()
    expect(advertisedDefaultEffort({ ...BASE, defaultThinkingLevel: 'nope' } as Model<Api>)).toBeUndefined()
  })

  it('ignores a non-object reasoning field and a parameter-less row', () => {
    expect(openRouterThinkingFromListing(['high'], true)).toEqual({
      map: thinkingLevelMapFromOffered(['low', 'medium', 'high']),
    })
    expect(openRouterThinkingFromListing('high', false)).toBeUndefined()
    expect(openRouterThinkingFromListing({ supported_efforts: ['off'] }, false)).toEqual({
      map: thinkingLevelMapFromOffered(['off'], 'off'),
    })
  })
})
