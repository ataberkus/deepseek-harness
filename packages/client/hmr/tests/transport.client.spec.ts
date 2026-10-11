/** Web transport delegates module and entry changes to the page-owned controller. */
import { Context } from '@deepseek-ai/cordis'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** EventSource stand-in recording every connection one test opens and the page base it opened under. */
class FakeSource {
  static opened: FakeSource[] = []
  readonly base = document.baseURI
  receive!: (event: { data: string }) => void
  close = vi.fn()
  constructor() { FakeSource.opened.push(this) }
  addEventListener(_name: string, listener: (event: { data: string }) => void) { this.receive = listener }
}

/** Exclusive FIFO lock manager for one origin, keyed by lock name, with abort while queued. */
function fakeLocks(): Pick<LockManager, 'request'> {
  const locks = new Map<string, { held: boolean; queue: (() => void)[] }>()
  const request = async (name: string, options: LockOptions, callback: () => Promise<void>): Promise<void> => {
    let lock = locks.get(name)
    if (lock === undefined) locks.set(name, lock = { held: false, queue: [] })
    const { queue } = lock
    if (lock.held) {
      await new Promise<void>((resolve, reject) => {
        queue.push(resolve)
        options.signal?.addEventListener('abort', () => {
          queue.splice(queue.indexOf(resolve), 1)
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }
    lock.held = true
    try {
      await callback()
    } finally {
      const next = queue.shift()
      if (next === undefined) lock.held = false
      else next()
    }
  }
  return { request } as Pick<LockManager, 'request'>
}

/** Open one page of the app mounted at `base`; activation reads the base synchronously. */
async function page(base = 'http://127.0.0.1:3080/') {
  vi.stubGlobal('document', { baseURI: base })
  const ctx = new Context()
  const sync = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  ctx.provide('modules', { entries: { sync, reload } } as unknown as ClientModuleLoader)
  const warnings = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const fiber = ctx.plugin({ apply, inject })
  await fiber.await()
  return { sync, reload, warnings, errors, close: async () => { await fiber.dispose(); await ctx.fiber.dispose() } }
}

it('forwards full graphs and rebuilt frames, contains wire errors and closes its EventSource without Web Locks', async () => {
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('EventSource', FakeSource)
  FakeSource.opened = []
  const { sync, reload, warnings, errors, close } = await page()
  try {
    const receive = FakeSource.opened[0]!.receive
    const graph = { rev: 'r', entries: [], batches: [] }
    receive({ data: JSON.stringify({ type: 'graph', graph }) })
    receive({ data: JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' }) })
    await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graph) })
    expect(reload).toHaveBeenCalledWith('a', 'r1')
    receive({ data: '{' })
    receive({ data: JSON.stringify({ type: 'graph', graph: null }) })
    receive({ data: JSON.stringify({ type: 'future' }) })
    expect(warnings).toHaveBeenCalledTimes(2)
    sync.mockRejectedValueOnce(new Error('invalid graph'))
    receive({ data: JSON.stringify({ type: 'graph', graph: {} }) })
    await vi.waitFor(() => { expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'invalid graph' })) })
  } finally {
    await close()
  }
  expect(FakeSource.opened).toHaveLength(1)
  expect(FakeSource.opened[0]!.close).toHaveBeenCalledOnce()
})

it('holds one EventSource per app mount however many pages are open, relays its frames and hands it over on close', async () => {
  vi.stubGlobal('navigator', { locks: fakeLocks() })
  vi.stubGlobal('EventSource', FakeSource)
  FakeSource.opened = []
  const pages = [await page(), await page(), await page()]
  try {
    await vi.waitFor(() => { expect(FakeSource.opened).toHaveLength(1) })
    const graph = { rev: 'r', entries: [], batches: [] }
    FakeSource.opened[0]!.receive({ data: JSON.stringify({ type: 'graph', graph }) })
    FakeSource.opened[0]!.receive({ data: JSON.stringify({ type: 'rebuilt', id: 'a', rev: 'r1' }) })
    for (const { sync, reload } of pages) {
      await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graph) })
      await vi.waitFor(() => { expect(reload).toHaveBeenCalledWith('a', 'r1') })
    }

    // A page opened later receives the current graph without its own connection.
    const late = await page()
    pages.push(late)
    await vi.waitFor(() => { expect(late.sync).toHaveBeenCalledWith(graph) })
    expect(FakeSource.opened).toHaveLength(1)

    // Closing the leader page lets exactly one remaining page connect.
    await pages.shift()!.close()
    expect(FakeSource.opened[0]!.close).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(FakeSource.opened).toHaveLength(2) })
    const next = { rev: 'r2', entries: [], batches: [] }
    FakeSource.opened[1]!.receive({ data: JSON.stringify({ type: 'graph', graph: next }) })
    for (const { sync } of pages) await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(next) })
  } finally {
    for (const { close } of pages) await close()
  }
  for (const source of FakeSource.opened) expect(source.close).toHaveBeenCalledOnce()
})

it('elects one leader per app mount on a shared origin and keeps their frames apart', async () => {
  vi.stubGlobal('navigator', { locks: fakeLocks() })
  vi.stubGlobal('EventSource', FakeSource)
  FakeSource.opened = []
  const a = [await page('https://gw.example/a/'), await page('https://gw.example/a/')]
  const b = [await page('https://gw.example/b/'), await page('https://gw.example/b/')]
  try {
    await vi.waitFor(() => { expect(FakeSource.opened.map(source => source.base)).toEqual(['https://gw.example/a/', 'https://gw.example/b/']) })
    const [sourceA, sourceB] = FakeSource.opened
    const graphA = { rev: 'a', entries: [], batches: [] }
    sourceA!.receive({ data: JSON.stringify({ type: 'graph', graph: graphA }) })
    sourceB!.receive({ data: JSON.stringify({ type: 'rebuilt', id: 'b-entry', rev: 'b1' }) })
    for (const { sync } of a) await vi.waitFor(() => { expect(sync).toHaveBeenCalledWith(graphA) })
    for (const { reload } of b) await vi.waitFor(() => { expect(reload).toHaveBeenCalledWith('b-entry', 'b1') })
    for (const { reload } of a) expect(reload).not.toHaveBeenCalled()
    for (const { sync } of b) expect(sync).not.toHaveBeenCalled()
  } finally {
    for (const { close } of [...a, ...b]) await close()
  }
})
