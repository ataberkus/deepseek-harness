/**
 * Canonical pi-ai thinking levels and the maps live listings attach so a
 * picker offers only the efforts the endpoint named.
 *
 * @module dsh-llm-pi-ai/thinking-levels
 */

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'

/**
 * Every pi-ai thinking level. The `Record` key type is a drift gate: a pi-ai
 * upgrade that adds or removes a level fails compilation here.
 */
const THINKING_LEVEL_GATE: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/** Every pi-ai thinking level a profile or listing may declare, in escalation order. */
export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_GATE) as readonly ModelThinkingLevel[]

/** OpenRouter gateway effort names when `supported_efforts` is JSON null. */
const OPENROUTER_GATEWAY_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const

/**
 * Parse one canonical pi-ai thinking level.
 * @param value - candidate spelling.
 * @returns the level, or `undefined` when it is not in the pi-ai set.
 */
export function parseThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  return value in THINKING_LEVEL_GATE ? value as ModelThinkingLevel : undefined
}

/**
 * Map one listing/gateway effort name onto a pi-ai level. OpenRouter's `none`
 * is pi-ai `off`; other names must already be canonical.
 * @param value - listing effort spelling.
 * @returns the level, or `undefined` when the name is not a known effort.
 */
export function listingEffortToLevel(value: unknown): ModelThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  if (value === 'none') return 'off'
  return parseThinkingLevel(value)
}

/**
 * Build a pi-ai `thinkingLevelMap` that offers exactly `offered` and pins
 * every other level unsupported. Pinning matters because pi-ai treats an
 * absent base-level key as supported.
 * @param offered - levels the picker should show, in any order.
 * @param offWire - wire spelling for Off; omit the key (send nothing) when
 *   Off is offered and this is `undefined`; OpenRouter `none` passes `'none'`.
 * @returns a map dispatch can read.
 */
export function thinkingLevelMapFromOffered(
  offered: readonly ModelThinkingLevel[],
  offWire?: string,
): ThinkingLevelMap {
  const set = new Set(offered)
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    if (!set.has(level)) {
      map[level] = null
      continue
    }
    if (level === 'off') {
      if (offWire !== undefined) map.off = offWire
      continue
    }
    map[level] = level
  }
  return map
}

/**
 * Attach a thinking map (and optional advertised default) onto a model.
 * @param model - descriptor to copy.
 * @param map - offered levels, every other level pinned unsupported.
 * @param defaultLevel - picker default when the profile does not name one.
 * @returns a reasoning model carrying that map.
 */
export function attachThinking(
  model: Model<Api>,
  map: ThinkingLevelMap,
  defaultLevel?: ModelThinkingLevel,
): Model<Api> {
  const { thinkingLevelMap: _previous, ...rest } = model
  return {
    ...rest,
    reasoning: true,
    thinkingLevelMap: map,
    ...defaultLevel === undefined ? {} : { defaultThinkingLevel: defaultLevel },
  }
}

/**
 * Advertised picker default a live listing or Cursor family table attached.
 * @param model - served descriptor.
 * @returns the level when present and canonical.
 */
export function advertisedDefaultEffort(model: Model<Api>): ModelThinkingLevel | undefined {
  return parseThinkingLevel((model as { defaultThinkingLevel?: unknown }).defaultThinkingLevel)
}

/**
 * OpenRouter `reasoning` object plus `supported_parameters` fallback.
 * @param reasoning - listing `reasoning` field; object, absent, or junk.
 * @param parameterReasoning - whether `supported_parameters` named a
 *   reasoning parameter.
 * @returns selectable map and default, or empty when the row has no selector.
 */
export function openRouterThinkingFromListing(
  reasoning: unknown,
  parameterReasoning: boolean,
): { map: ThinkingLevelMap; defaultEffort?: ModelThinkingLevel } | undefined {
  if (reasoning !== null && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const object = reasoning as Record<string, unknown>
    const effortsField = object['supported_efforts']
    const mandatory = object['mandatory'] === true
    let names: readonly string[] | undefined
    if (Array.isArray(effortsField)) {
      names = effortsField.filter((entry): entry is string => typeof entry === 'string')
    } else if (effortsField === null) {
      names = mandatory
        ? OPENROUTER_GATEWAY_EFFORTS.filter(name => name !== 'none')
        : OPENROUTER_GATEWAY_EFFORTS
    }
    if (names !== undefined) {
      const offered: ModelThinkingLevel[] = []
      let offWire: string | undefined
      for (const name of names) {
        const level = listingEffortToLevel(name)
        if (level === undefined) continue
        if (level === 'off') offWire = name === 'none' ? 'none' : name
        if (!offered.includes(level)) offered.push(level)
      }
      if (offered.length === 0) return undefined
      const map = thinkingLevelMapFromOffered(offered, offWire)
      const parsedDefault = listingEffortToLevel(object['default_effort'])
      const defaultEffort = parsedDefault !== undefined && offered.includes(parsedDefault)
        ? parsedDefault
        : undefined
      return defaultEffort === undefined ? { map } : { map, defaultEffort }
    }
    return undefined
  }
  if (!parameterReasoning) return undefined
  return {
    map: thinkingLevelMapFromOffered(['low', 'medium', 'high']),
  }
}
