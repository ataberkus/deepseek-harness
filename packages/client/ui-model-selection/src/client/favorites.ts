/**
 * Browser-local model favorites: the viewing preference that pins models to
 * the top of both selection entries. Favorites are presentation-only — ids
 * stay the selection keys, and the Host catalog remains the routing
 * authority. Storage is one localStorage entry owned by the
 * ModelDirectoryResolver service; unknown ids are retained but never listed.
 *
 * @module dsh-client-ui-model-selection/favorites
 */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** localStorage identity for the browser-local favorites list. */
export const MODEL_FAVORITES_STORAGE_KEY = 'dsh.modelFavorites.v1'

/** Persisted favorites value: an ordered list of `provider/model` row ids. */
export interface ModelFavoritesState {
  favorites: string[]
}

/** One favorited catalog row with its owning group for selection. */
export interface FavoriteEntry {
  group: ModelProviderGroup
  model: ModelProviderGroup['models'][number]
}

/**
 * Build the opaque row id for one provider/model pair.
 * @param providerId - provider id.
 * @param modelId - provider-owned model id.
 * @returns the `provider/model` storage key.
 */
export function favoriteId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/**
 * Coerce an unknown persisted value to an ordered, deduped id list.
 * @param value - raw persisted `favorites` value.
 * @returns the usable ids in stored order.
 */
export function normalizeFavorites(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const slash = entry.indexOf('/')
    if (slash <= 0 || slash >= entry.length - 1) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * Create the persisted favorites store. Invalid stored shapes reset to empty
 * rather than breaking the selector.
 * @returns the browser-local favorites store.
 */
export function createFavoritesStore(): SnapshotStore<ModelFavoritesState> {
  const store = createSnapshotStore<ModelFavoritesState>(
    { favorites: [] },
    { persist: { name: MODEL_FAVORITES_STORAGE_KEY } },
  )
  // Normalization only removes invalid or duplicated ids while preserving
  // order, so a length mismatch proves the stored value needs a reset.
  const stored = store.getSnapshot().favorites
  if (!Array.isArray(stored) || normalizeFavorites(stored).length !== stored.length) {
    store.set({ favorites: normalizeFavorites(stored) })
  }
  return store
}

/**
 * Toggle one id in an ordered favorites list.
 * @param favorites - current ordered ids.
 * @param id - the `provider/model` id to add or remove.
 * @returns the next ordered list.
 */
export function toggledFavorites(favorites: readonly string[], id: string): string[] {
  return favorites.includes(id)
    ? favorites.filter(entry => entry !== id)
    : [...favorites, id]
}

/**
 * List the favorited catalog rows in catalog order (provider-group order,
 * then model order). Unknown ids are skipped; the list is presentation-only.
 * @param groups - the directory's advertised provider groups.
 * @param favorites - ordered favorite ids (unknown ids skipped).
 * @returns the favorited rows in catalog order.
 */
export function favoriteEntries(
  groups: readonly ModelProviderGroup[],
  favorites: readonly string[],
): FavoriteEntry[] {
  const wanted = new Set(favorites)
  const out: FavoriteEntry[] = []
  for (const group of groups) {
    for (const model of group.models) {
      if (wanted.has(favoriteId(group.id, model.id))) out.push({ group, model })
    }
  }
  return out
}
