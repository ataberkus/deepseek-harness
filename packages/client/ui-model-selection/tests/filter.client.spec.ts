import { describe, expect, it } from 'vitest'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { filterModelGroups } from '../src/client/filter.ts'

const GROUPS: readonly ModelProviderGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Long-context reasoning' },
    ],
  },
  {
    id: 'acme-gateway',
    name: 'Acme Gateway',
    models: [{ id: 'acme-large', name: 'Acme Large' }],
  },
]

describe('filterModelGroups', () => {
  it('keeps every group when the query is blank', () => {
    expect(filterModelGroups(GROUPS, '')).toBe(GROUPS)
    expect(filterModelGroups(GROUPS, '  ')).toBe(GROUPS)
  })

  it('matches model name, id, description, and provider fields independently', () => {
    expect(filterModelGroups(GROUPS, 'FLASH').map(group => group.models.map(model => model.id)))
      .toEqual([['deepseek-v4-flash']])
    expect(filterModelGroups(GROUPS, 'v4-pro').map(group => group.models.map(model => model.id)))
      .toEqual([['deepseek-v4-pro']])
    expect(filterModelGroups(GROUPS, 'long-context').map(group => group.models.map(model => model.id)))
      .toEqual([['deepseek-v4-pro']])
    expect(filterModelGroups(GROUPS, 'Gateway').map(group => group.id)).toEqual(['acme-gateway'])
    expect(filterModelGroups(GROUPS, 'acme-gateway').map(group => group.id)).toEqual(['acme-gateway'])
  })

  it('drops groups with no matching model', () => {
    expect(filterModelGroups(GROUPS, 'nope')).toEqual([])
  })
})
