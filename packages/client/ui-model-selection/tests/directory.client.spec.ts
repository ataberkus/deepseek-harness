/** Shared model directory: optimistic selection and in-place catalog refresh. */
import { describe, expect, it } from 'vitest'
import type { RpcResponse, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelDirectory } from '../src/client/directory.ts'

const sessionId = 's' as SessionId

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string, code: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code, message, details: {} } as never } }
}

function modelsOk(current: { provider: string; model: string }) {
  return Promise.resolve(ok({
    current,
    routable: true,
    groups: [{
      id: 'p',
      name: 'P',
      models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    }],
    failures: [],
  }))
}

describe('ModelDirectory', () => {
  it('echoes the selection before the host answers', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const selected = { provider: 'p', model: 'b', reasoningEffort: 'high' }
    const directory = new ModelDirectory({
      models: () => modelsOk({ provider: 'p', model: 'a' }),
      selectModel: async () => {
        await gate
        return ok({ selected })
      },
    }, sessionId, () => true)
    await directory.load()
    const pending = directory.select(selected)
    expect(directory.store.getSnapshot().current).toEqual(selected)
    expect(directory.store.getSnapshot().status).toBe('selecting')
    release()
    await pending
    expect(directory.store.getSnapshot()).toMatchObject({ current: selected, status: 'ready' })
  })

  it('restores the previous selection when the host refuses', async () => {
    const directory = new ModelDirectory({
      models: () => modelsOk({ provider: 'p', model: 'a' }),
      selectModel: () => Promise.resolve(fail('no', 'model-unavailable')),
    }, sessionId, () => true)
    await directory.load()
    await expect(directory.select({ provider: 'p', model: 'b' }))
      .rejects.toThrow(/model-unavailable/)
    expect(directory.store.getSnapshot().current).toEqual({ provider: 'p', model: 'a' })
    expect(directory.store.getSnapshot().status).toBe('error')
  })

  it('keeps loaded groups visible while a catalog refresh is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let loads = 0
    const directory = new ModelDirectory({
      models: async () => {
        loads += 1
        if (loads > 1) await gate
        return modelsOk({ provider: 'p', model: 'a' })
      },
      selectModel: () => Promise.reject(new Error('unused')),
    }, sessionId, () => true)
    await directory.load()
    const refresh = directory.load()
    expect(directory.store.getSnapshot().status).toBe('ready')
    expect(directory.store.getSnapshot().groups).toHaveLength(1)
    release()
    await refresh
    expect(directory.store.getSnapshot().status).toBe('ready')
  })
})
