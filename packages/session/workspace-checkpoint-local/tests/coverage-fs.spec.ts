import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupDir, journalPath, readJournal, removeJournal, stagingDir, writeJournal } from '../src/journal.ts'
import type { RestoreJournal } from '../src/journal.ts'
import { WorkspaceLeaseTable } from '../src/lease.ts'
import { buildManifest } from '../src/manifest.ts'
import { blobExists, blobPath, putBlob, readBlob, totalBlobBytes } from '../src/objects.ts'
import { bootCoverage, capture, trySymlink } from './coverage-harness.ts'

const run = promisify(execFile)
const HASH = 'ab'.repeat(32)

describe('manifest walking', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-coverage-manifest-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('sorts entries by manifest path regardless of directory listing order', async () => {
    await mkdir(join(cwd, 'a'))
    await mkdir(join(cwd, 'a-b'))
    await writeFile(join(cwd, 'a', 'f'), 'f')
    await writeFile(join(cwd, 'a-b', 'g'), 'g')
    const manifest = await buildManifest(cwd, { excludeGlobs: [] })
    expect(manifest.entries.map(entry => entry.relativePath)).toEqual(['a', 'a-b', 'a-b/g', 'a/f'])
  })

  it('skips an excluded symlink without following it', async () => {
    await writeFile(join(cwd, 'target.txt'), 't')
    if (!await trySymlink('target.txt', join(cwd, 'skip-link'))) return
    await trySymlink('target.txt', join(cwd, 'kept-link'))
    const manifest = await buildManifest(cwd, { excludeGlobs: ['skip-link'] })
    expect(manifest.entries.map(entry => entry.relativePath)).toEqual(['kept-link', 'target.txt'])
  })

  it.skipIf(process.platform === 'win32')('records a FIFO as an unsafe entry instead of opening it', async () => {
    await run('mkfifo', [join(cwd, 'pipe')])
    const manifest = await buildManifest(cwd, { excludeGlobs: [] })
    expect(manifest.entries).toEqual([
      expect.objectContaining({ relativePath: 'pipe', kind: 'file', size: 0, restoreSafe: false }),
    ])
    expect(manifest.entries[0]).not.toHaveProperty('hash')
  })
})

describe('FIFO capture', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it.skipIf(process.platform === 'win32')('persists an unsafe-entry unavailable record that cannot be restored', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await run('mkfifo', [join(h.cwd, 'pipe')])
    const record = await capture(h)
    expect(record).toMatchObject({ status: { kind: 'unavailable', reason: 'unsafe-entry' }, restoreEligible: false })
    await expect(h.service.restore({ checkpointId: record.id, cwd: h.cwd }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
  })
})

describe('object store failures', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-coverage-objects-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stores a blob once, reads it back, and sums stored bytes', async () => {
    await expect(totalBlobBytes(root)).resolves.toBe(0)
    await expect(blobExists(root, HASH)).resolves.toBe(false)
    await putBlob(root, HASH, Buffer.from('payload'))
    await putBlob(root, HASH, Buffer.from('ignored second write'))
    expect(await readFile(blobPath(root, HASH), 'utf8')).toBe('payload')
    await expect(readBlob(root, HASH)).resolves.toEqual(Buffer.from('payload'))
    await expect(totalBlobBytes(root)).resolves.toBe(7)
    await expect(readBlob(root, 'cd'.repeat(32))).rejects.toMatchObject({ code: 'CHECKPOINT_HASH_MISMATCH' })
  })

  it('propagates filesystem errors other than a missing blob or store', async () => {
    await writeFile(join(root, 'objects'), 'not a directory')
    await expect(blobExists(root, HASH)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(totalBlobBytes(root)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(readBlob(root, HASH)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('removes its temporary file when the final rename fails', async () => {
    await mkdir(blobPath(root, HASH), { recursive: true })
    await expect(putBlob(root, HASH, Buffer.from('payload'))).rejects.toBeTruthy()
    await expect(readdir(join(root, 'objects', HASH.slice(0, 2)))).resolves.toEqual([HASH])
    expect((await stat(blobPath(root, HASH))).isDirectory()).toBe(true)
  })
})

describe('restore journal file', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-coverage-journal-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips, reports absence as undefined, and removes idempotently', async () => {
    const path = journalPath(root, '/work/space')
    expect(journalPath(root, '/work/space')).toBe(path)
    expect(journalPath(root, '/work/other')).not.toBe(path)
    await expect(readJournal(path)).resolves.toBeUndefined()
    const id = CheckpointId('cp_journal')
    const journal: RestoreJournal = {
      checkpointId: id,
      cwd: '/work/space',
      backupDir: backupDir(root, id),
      stagingDir: stagingDir(root, id),
      ops: [
        { kind: 'mkdir', relativePath: 'd' },
        { kind: 'write', relativePath: 'd/f' },
        { kind: 'symlink', relativePath: 'l', linkTarget: 'd/f' },
        { kind: 'delete', relativePath: 'old' },
      ],
    }
    await writeJournal(path, journal)
    await expect(readJournal(path)).resolves.toEqual(journal)
    await removeJournal(path)
    await removeJournal(path)
    await expect(readJournal(path)).resolves.toBeUndefined()
  })

  it('rethrows a corrupt journal and an unreadable journal path', async () => {
    const corrupt = join(root, 'corrupt.json')
    await writeFile(corrupt, '{not json')
    await expect(readJournal(corrupt)).rejects.toBeInstanceOf(SyntaxError)
    const directory = join(root, 'dir.json')
    await mkdir(directory)
    await expect(readJournal(directory)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('workspace lease table', () => {
  it('runs a joining restore immediately while the Host lease is held, but queues a plain capture behind it', async () => {
    const table = new WorkspaceLeaseTable()
    const lease = table.acquire('/ws')
    const order: string[] = []
    const joined = table.withLease('/ws', () => {
      order.push('joined')
      return Promise.resolve('joined')
    }, true)
    const queued = table.withLease('/ws', () => {
      order.push('queued')
      return Promise.resolve('queued')
    }, false)
    await expect(joined).resolves.toBe('joined')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['joined'])
    lease.release()
    lease.release()
    await expect(queued).resolves.toBe('queued')
    expect(order).toEqual(['joined', 'queued'])
  })

  it('keeps FIFO order after a queued job fails and rejects a Host acquire while internal work runs', async () => {
    const table = new WorkspaceLeaseTable()
    const order: string[] = []
    let finishFirst!: () => void
    const first = table.withLease('/ws', () => new Promise<void>((resolve) => {
      finishFirst = resolve
    }).then(() => { order.push('first') }), false)
    const failing = table.withLease('/ws', () => Promise.reject(new Error('job failed')), false)
    const last = table.withLease('/ws', () => {
      order.push('last')
      return Promise.resolve()
    }, false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(() => table.acquire('/ws')).toThrow(expect.objectContaining({ code: 'CHECKPOINT_LEASE_HELD' }) as Error)
    finishFirst()
    await first
    await expect(failing).rejects.toThrow('job failed')
    await last
    expect(order).toEqual(['first', 'last'])
    const free = table.acquire('/ws')
    free.release()
  })
})
