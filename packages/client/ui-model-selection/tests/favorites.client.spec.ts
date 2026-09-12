import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import {
  MODEL_FAVORITES_STORAGE_KEY, createFavoritesStore, favoriteEntries, favoriteId,
  normalizeFavorites, toggledFavorites,
} from '../src/client/favorites.ts'

const GROUPS: readonly ModelProviderGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'acme-gateway',
    name: 'Acme Gateway',
    models: [{ id: 'acme-large', name: 'Acme Large' }],
  },
]

function stubStorage(backing: Map<string, string>) {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('favoriteId', () => {
  it('joins provider and model with a slash', () => {
    expect(favoriteId('p', 'm')).toBe('p/m')
  })
})

describe('normalizeFavorites', () => {
  it('rejects non-array values', () => {
    expect(normalizeFavorites(undefined)).toEqual([])
    expect(normalizeFavorites(null)).toEqual([])
    expect(normalizeFavorites('p/m')).toEqual([])
    expect(normalizeFavorites({ favorites: ['p/m'] })).toEqual([])
  })

  it('keeps only well-formed ids and dedupes in stored order', () => {
    expect(normalizeFavorites([
      'deepseek-official/deepseek-v4-flash',
      'bad',
      '/leading',
      'trailing/',
      42,
      null,
      'deepseek-official/deepseek-v4-flash',
      'acme-gateway/acme-large',
    ])).toEqual([
      'deepseek-official/deepseek-v4-flash',
      'acme-gateway/acme-large',
    ])
  })
})

describe('toggledFavorites', () => {
  it('appends a missing id and removes a present one', () => {
    expect(toggledFavorites([], 'p/a')).toEqual(['p/a'])
    expect(toggledFavorites(['p/a', 'p/b'], 'p/c')).toEqual(['p/a', 'p/b', 'p/c'])
    expect(toggledFavorites(['p/a', 'p/b'], 'p/a')).toEqual(['p/b'])
  })
})

describe('favoriteEntries', () => {
  it('lists favorited rows in catalog order and skips unknown ids', () => {
    expect(favoriteEntries(GROUPS, [
      'acme-gateway/acme-large',
      'ghost/model',
      'deepseek-official/deepseek-v4-pro',
    ]).map(entry => `${entry.group.id}/${entry.model.id}`)).toEqual([
      'deepseek-official/deepseek-v4-pro',
      'acme-gateway/acme-large',
    ])
  })

  it('returns nothing without favorites', () => {
    expect(favoriteEntries(GROUPS, [])).toEqual([])
  })
})

describe('createFavoritesStore', () => {
  it('starts empty without storage and persists toggled ids across instances', () => {
    const backing = new Map<string, string>()
    stubStorage(backing)
    const first = createFavoritesStore()
    expect(first.getSnapshot()).toEqual({ favorites: [] })
    first.update((draft) => { draft.favorites = toggledFavorites(draft.favorites, 'p/a') })
    expect(JSON.parse(backing.get(MODEL_FAVORITES_STORAGE_KEY)!)).toEqual({ favorites: ['p/a'] })
    expect(createFavoritesStore().getSnapshot()).toEqual({ favorites: ['p/a'] })
  })

  it('resets a malformed persisted list to the normalized ids', () => {
    const backing = new Map<string, string>()
    stubStorage(backing)
    backing.set(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify({
      favorites: ['deepseek-official/deepseek-v4-flash', 'bad', 'deepseek-official/deepseek-v4-flash'],
    }))
    expect(createFavoritesStore().getSnapshot()).toEqual({
      favorites: ['deepseek-official/deepseek-v4-flash'],
    })
  })

  it('resets a non-array persisted value to empty', () => {
    const backing = new Map<string, string>()
    stubStorage(backing)
    backing.set(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify({ favorites: 'nope' }))
    expect(createFavoritesStore().getSnapshot()).toEqual({ favorites: [] })
  })
})
