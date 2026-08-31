/** Shared model directory: optimistic selection and in-place catalog refresh. */
import { describe, expect, it } from 'vitest'
import type { ModelCatalog, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelCatalogDirectory, ModelCatalogState } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const sessionId = 's' as SessionId

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fail<T>(message: string): RemoteResult<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function catalogValue(current: { provider: string; model: string }, extras?: {
  groups?: ModelCatalog['groups']
  failures?: ModelCatalog['failures']
  routableProviders?: string[]
}): ModelCatalog {
  return {
    default: current,
    routableProviders: extras?.routableProviders ?? [current.provider],
    groups: extras?.groups ?? [{
      id: 'p',
      name: 'P',
      models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    }],
    failures: extras?.failures ?? [],
  }
}

function makeDirectory(opts: {
  catalog: ModelCatalog
  selectModel: (payload: {
    sessionId: SessionId
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<RemoteResult<{ selected: { provider: string; model: string; reasoningEffort?: string } }>>
  projected?: unknown
  load?: () => Promise<ModelCatalog>
}) {
  const catalogStore = createSnapshotStore<ModelCatalogState>({
    value: opts.catalog,
    status: 'ready',
    error: null,
  })
  const catalog = {
    store: catalogStore,
    load: async () => {
      if (opts.load !== undefined) {
        const value = await opts.load()
        catalogStore.set({ value, status: 'ready', error: null })
        return value
      }
      const value = catalogStore.getSnapshot().value
      if (value === null) throw new Error('empty catalog')
      return value
    },
  } as ModelCatalogDirectory
  const projected = createSnapshotStore(opts.projected ?? { next: opts.catalog.default })
  return new ModelDirectory(
    { selectModel: opts.selectModel },
    sessionId,
    () => true,
    catalog,
    projected,
  )
}

describe('ModelDirectory', () => {
  it('echoes the selection before the host answers', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const selected = { provider: 'p', model: 'b', reasoningEffort: 'high' }
    const directory = makeDirectory({
      catalog: catalogValue({ provider: 'p', model: 'a' }),
      selectModel: async () => {
        await gate
        return ok({ selected })
      },
    })
    await directory.load()
    const pending = directory.select(selected)
    expect(directory.store.getSnapshot().current).toEqual({ provider: 'p', model: 'a' })
    expect(directory.store.getSnapshot().status).toBe('selecting')
    release()
    await pending
    expect(directory.store.getSnapshot()).toMatchObject({ status: 'ready' })
  })

  it('restores the previous selection when the host refuses', async () => {
    const directory = makeDirectory({
      catalog: catalogValue({ provider: 'p', model: 'a' }),
      selectModel: () => Promise.resolve(fail('no')),
    })
    await directory.load()
    await expect(directory.select({ provider: 'p', model: 'b' }))
      .rejects.toThrow(/gateway\/internal/)
    expect(directory.store.getSnapshot().current).toEqual({ provider: 'p', model: 'a' })
    expect(directory.store.getSnapshot().status).toBe('error')
  })

  it('keeps loaded groups visible while a catalog refresh is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let loads = 0
    const directory = makeDirectory({
      catalog: catalogValue({ provider: 'p', model: 'a' }),
      selectModel: () => Promise.reject(new Error('unused')),
      load: async () => {
        loads += 1
        if (loads > 1) await gate
        return catalogValue({ provider: 'p', model: 'a' })
      },
    })
    await directory.load()
    const refresh = directory.load()
    expect(directory.store.getSnapshot().groups).toHaveLength(1)
    release()
    await refresh
    expect(directory.store.getSnapshot().status).toBe('ready')
  })

  it('clears provider failures while retrying and commits a recovered catalog', async () => {
    let loads = 0
    const directory = makeDirectory({
      catalog: catalogValue({ provider: 'cursor', model: 'cursor-model' }, {
        groups: [],
        failures: [{
          id: 'cursor',
          name: 'Cursor',
          message: 'GetUsableModels returned no usable models',
        }],
        routableProviders: ['cursor'],
      }),
      selectModel: () => Promise.reject(new Error('unused')),
      load: () => {
        loads += 1
        return loads === 1
          ? Promise.resolve(catalogValue({ provider: 'cursor', model: 'cursor-model' }, {
            groups: [],
            failures: [{
              id: 'cursor',
              name: 'Cursor',
              message: 'GetUsableModels returned no usable models',
            }],
            routableProviders: ['cursor'],
          }))
          : Promise.resolve(catalogValue({ provider: 'cursor', model: 'cursor-model' }))
      },
    })

    await directory.load()
    expect(directory.store.getSnapshot().failures).toHaveLength(1)
    await directory.load()
    expect(directory.store.getSnapshot()).toMatchObject({ status: 'ready', failures: [] })
    expect(directory.store.getSnapshot().groups[0]?.id).toBe('p')
  })
})
