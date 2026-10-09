import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { totalBlobBytes } from '../src/objects.ts'
import { bootCoverage, capture } from './coverage-harness.ts'

async function blobFiles(objectRoot: string): Promise<string[]> {
  const names = await readdir(join(objectRoot, 'objects'), { recursive: true })
  const files: string[] = []
  for (const name of names) {
    if ((await stat(join(objectRoot, 'objects', name))).isFile()) files.push(name)
  }
  return files
}

describe('retention eviction', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('evicts oldest-first only until the blob store fits the cap, and keeps shared blobs while a live checkpoint uses them', async () => {
    const h = await bootCoverage({ maxTotalBytes: 100 })
    dispose.push(() => h.dispose())
    const changed: SessionId[] = []
    h.ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => { changed.push(sessionId) })
    await writeFile(join(h.cwd, 'f.bin'), Buffer.alloc(60, 1))
    const oldest = await capture(h)
    await writeFile(join(h.cwd, 'f.bin'), Buffer.alloc(60, 2))
    const middle = await capture(h, { boundarySeq: 0, role: 'turn', turnOutcome: 'completed' })
    await writeFile(join(h.cwd, 'f.bin'), Buffer.alloc(10, 3))
    const newest = await capture(h, { boundarySeq: 1, role: 'turn', turnOutcome: 'completed' })
    await h.service.restore({ checkpointId: newest.id, cwd: h.cwd })
    expect(await totalBlobBytes(h.objectRoot)).toBe(130)
    changed.length = 0

    await h.service.evict()

    await expect(h.service.inspect(oldest.id)).resolves.toMatchObject({
      restoreEligible: false,
      status: { kind: 'unavailable', reason: 'evicted' },
    })
    await expect(h.service.inspect(middle.id)).resolves.toMatchObject({ restoreEligible: true, status: { kind: 'ready' } })
    await expect(h.service.inspect(newest.id)).resolves.toMatchObject({ restoreEligible: true })
    expect(await totalBlobBytes(h.objectRoot)).toBe(70)
    expect(changed).toEqual([SessionId('s1')])
    await expect(h.service.restore({ checkpointId: oldest.id, cwd: h.cwd }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
  })

  it('removes a blob shared by several evicted checkpoints exactly once and keeps the applied blob', async () => {
    const h = await bootCoverage({ maxTotalBytes: 100 })
    dispose.push(() => h.dispose())
    await mkdir(join(h.cwd, 'sub'))
    await writeFile(join(h.cwd, 'f.bin'), Buffer.alloc(60, 1))
    const first = await capture(h)
    const second = await capture(h, { boundarySeq: 0, role: 'turn', turnOutcome: 'completed' })
    await writeFile(join(h.cwd, 'f.bin'), Buffer.alloc(60, 2))
    const applied = await capture(h, { boundarySeq: 1, role: 'turn', turnOutcome: 'completed' })
    await h.service.restore({ checkpointId: applied.id, cwd: h.cwd })
    expect(await blobFiles(h.objectRoot)).toHaveLength(2)

    await h.service.evict()

    for (const record of [first, second]) {
      await expect(h.service.inspect(record.id)).resolves.toMatchObject({ restoreEligible: false })
    }
    await expect(h.service.inspect(applied.id)).resolves.toMatchObject({ restoreEligible: true })
    expect(await blobFiles(h.objectRoot)).toHaveLength(1)
    expect(await totalBlobBytes(h.objectRoot)).toBe(60)
  })

  it('stops when only applied and emergency chains remain, even above the cap', async () => {
    const h = await bootCoverage({ maxTotalBytes: 10 })
    dispose.push(() => h.dispose())
    const changed: SessionId[] = []
    await writeFile(join(h.cwd, 'f.bin'), 'uuuuuuuu')
    const unprotected = await capture(h, { sessionId: 'other' })
    await writeFile(join(h.cwd, 'f.bin'), 'aaaaaaaa')
    const root = await capture(h, { sessionId: 's1' })
    await writeFile(join(h.cwd, 'f.bin'), 'bbbbbbbb')
    const applied = await capture(h, {
      sessionId: 's1', boundarySeq: 0, role: 'turn', turnOutcome: 'completed', parentCheckpointId: root.id,
    })
    await writeFile(join(h.cwd, 'f.bin'), 'cccccccc')
    const emergency = await capture(h, {
      sessionId: 's1', boundarySeq: 1, role: 'emergency', turnOutcome: 'completed', parentCheckpointId: applied.id,
    })
    await h.service.restore({ checkpointId: applied.id, cwd: h.cwd })
    h.ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => { changed.push(sessionId) })

    await h.service.evict()

    await expect(h.service.inspect(unprotected.id)).resolves.toMatchObject({
      restoreEligible: false,
      status: { kind: 'unavailable', reason: 'evicted' },
    })
    for (const record of [root, applied, emergency]) {
      await expect(h.service.inspect(record.id)).resolves.toMatchObject({ restoreEligible: true, status: { kind: 'ready' } })
    }
    expect(await totalBlobBytes(h.objectRoot)).toBe(24)
    expect(changed).toEqual([SessionId('other')])
  })

  it('does nothing when the store already fits the cap', async () => {
    const h = await bootCoverage({ maxTotalBytes: 1000 })
    dispose.push(() => h.dispose())
    const changed: SessionId[] = []
    await writeFile(join(h.cwd, 'f.bin'), 'small')
    const cp = await capture(h)
    h.ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => { changed.push(sessionId) })
    await h.service.evict()
    await expect(h.service.inspect(cp.id)).resolves.toMatchObject({ restoreEligible: true })
    expect(changed).toEqual([])
  })
})
