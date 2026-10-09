import { lstat, mkdir, readFile, readdir, readlink, rename as fsRename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { ManifestEntry } from '@deepseek-ai/dsh-workspace-checkpoint'
import { canonicalizeCwd, restoreInternals } from '../src/index.ts'
import { backupDir, journalPath, stagingDir } from '../src/journal.ts'
import { blobPath } from '../src/objects.ts'
import { bootCoverage, capture, trySymlink } from './coverage-harness.ts'
import type { CoverageHarness } from './coverage-harness.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function replaceEntries(h: CoverageHarness, id: string, entries: ManifestEntry[]): Promise<void> {
  const table = h.domain().table('checkpoints')
  const stored = table.get(CheckpointId(id))
  if (stored === undefined) throw new Error('checkpoint row missing')
  await table.put(CheckpointId(id), { ...stored, entries })
}

describe('journaled restore', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    restoreInternals.rename = fsRename
    restoreInternals.rollback = undefined
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('rebuilds directories, nested files, and symlinks, deletes extras, and cleans up its journal', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    const changed: SessionId[] = []
    h.ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => { changed.push(sessionId) })
    await mkdir(join(h.cwd, 'sub', 'deep'), { recursive: true })
    await mkdir(join(h.cwd, 'empty'))
    await writeFile(join(h.cwd, 'sub', 'deep', 'n.txt'), 'nested')
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const linked = await trySymlink('a.txt', join(h.cwd, 'link'))
    const cp = await capture(h)

    await writeFile(join(h.cwd, 'a.txt'), 'two')
    await rm(join(h.cwd, 'sub'), { recursive: true })
    await rm(join(h.cwd, 'empty'), { recursive: true })
    await rm(join(h.cwd, 'link'), { force: true })
    await writeFile(join(h.cwd, 'link'), 'plain file now')
    await mkdir(join(h.cwd, 'x', 'y'), { recursive: true })
    await writeFile(join(h.cwd, 'x', 'y', 'z.txt'), 'extra')
    await writeFile(join(h.cwd, 'extra.txt'), 'extra')
    await trySymlink('a.txt', join(h.cwd, 'cur-link'))
    changed.length = 0

    const result = await h.service.restore({ checkpointId: cp.id, cwd: h.cwd })

    expect(result).toEqual({ checkpointId: cp.id, fileCount: cp.fileCount })
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe('one')
    expect(await readFile(join(h.cwd, 'sub', 'deep', 'n.txt'), 'utf8')).toBe('nested')
    expect((await stat(join(h.cwd, 'empty'))).isDirectory()).toBe(true)
    expect(await exists(join(h.cwd, 'x'))).toBe(false)
    expect(await exists(join(h.cwd, 'extra.txt'))).toBe(false)
    expect(await exists(join(h.cwd, 'cur-link'))).toBe(false)
    if (linked) {
      expect((await lstat(join(h.cwd, 'link'))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(h.cwd, 'link'))).toBe('a.txt')
    }

    const key = await canonicalizeCwd(h.cwd)
    expect(await exists(journalPath(h.objectRoot, key))).toBe(false)
    expect(await exists(stagingDir(h.objectRoot, cp.id))).toBe(false)
    expect(await exists(backupDir(h.objectRoot, cp.id))).toBe(false)
    expect(h.service.sessionIndex(SessionId('s1'))?.appliedCheckpointId).toBe(cp.id)
    // One change from clearing the recovery flag, one from recording the applied checkpoint.
    expect(changed).toEqual([SessionId('s1'), SessionId('s1')])
  })

  it('leaves paths that are excluded at restore time untouched even when the checkpoint holds them', async () => {
    const first = await bootCoverage()
    dispose.push(() => first.dispose())
    await writeFile(join(first.cwd, 'secret.txt'), 'captured')
    await writeFile(join(first.cwd, 'keep.txt'), 'captured')
    await mkdir(join(first.cwd, 'private'))
    await writeFile(join(first.cwd, 'private', 'p.txt'), 'captured')
    const cp = await capture(first)
    await first.ctx.fiber.dispose()

    const second = await bootCoverage({ parent: first.parent, excludeGlobs: ['**/secret.txt', 'private', 'private/**'] })
    dispose.push(() => second.ctx.fiber.dispose())
    await writeFile(join(second.cwd, 'secret.txt'), 'edited')
    await writeFile(join(second.cwd, 'keep.txt'), 'edited')
    await writeFile(join(second.cwd, 'private', 'p.txt'), 'edited')
    await second.service.restore({ checkpointId: cp.id, cwd: second.cwd })
    expect(await readFile(join(second.cwd, 'keep.txt'), 'utf8')).toBe('captured')
    expect(await readFile(join(second.cwd, 'secret.txt'), 'utf8')).toBe('edited')
    expect(await readFile(join(second.cwd, 'private', 'p.txt'), 'utf8')).toBe('edited')
  })

  it('refuses an aborted request, an unavailable checkpoint, and an unknown id before touching the workspace', async () => {
    const h = await bootCoverage({ maxTotalBytes: 10 })
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'big.bin'), Buffer.alloc(32, 7))
    const unavailable = await capture(h)
    expect(unavailable.status).toEqual({ kind: 'unavailable', reason: 'quota-exhausted' })
    await writeFile(join(h.cwd, 'marker.txt'), 'stay')

    const controller = new AbortController()
    controller.abort()
    await expect(h.service.restore({ checkpointId: unavailable.id, cwd: h.cwd, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE', message: 'restore aborted' })
    await expect(h.service.restore({ checkpointId: unavailable.id, cwd: h.cwd }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE', message: 'checkpoint is not restorable' })
    await expect(h.service.restore({ checkpointId: CheckpointId('cp_unknown'), cwd: h.cwd }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' })
    expect(await readFile(join(h.cwd, 'marker.txt'), 'utf8')).toBe('stay')
  })

  it('refuses to restore when a stored blob no longer matches its hash', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'original')
    const cp = await capture(h)
    const hash = h.domain().table('checkpoints').get(CheckpointId(cp.id))?.entries.find(e => e.kind === 'file')?.hash
    if (hash === undefined) throw new Error('no file entry')
    await writeFile(blobPath(h.objectRoot, hash), 'corrupted')
    await writeFile(join(h.cwd, 'a.txt'), 'edited')
    await expect(h.service.restore({ checkpointId: cp.id, cwd: h.cwd }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_HASH_MISMATCH' })
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe('edited')
    expect(await exists(stagingDir(h.objectRoot, cp.id))).toBe(false)
  })

  it('rolls a mid-commit failure back from the backup, including directories and symlinks', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    await writeFile(join(h.cwd, 'z.txt'), 'zed')
    await mkdir(join(h.cwd, 'd'))
    const cp = await capture(h)

    await writeFile(join(h.cwd, 'a.txt'), 'edited-a')
    await writeFile(join(h.cwd, 'z.txt'), 'edited-z')
    await mkdir(join(h.cwd, 'dir', 'inner'), { recursive: true })
    await writeFile(join(h.cwd, 'dir', 'inner', 'f.txt'), 'inner')
    await mkdir(join(h.cwd, 'edir'))
    const linked = await trySymlink('a.txt', join(h.cwd, 'cur-link'))

    let calls = 0
    restoreInternals.rename = async (from, to) => {
      calls += 1
      if (calls === 2) throw new Error('injected second rename failure')
      await fsRename(from, to)
    }
    await expect(h.service.restore({ checkpointId: cp.id, cwd: h.cwd }))
      .rejects.toThrow('injected second rename failure')

    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe('edited-a')
    expect(await readFile(join(h.cwd, 'z.txt'), 'utf8')).toBe('edited-z')
    expect(await readFile(join(h.cwd, 'dir', 'inner', 'f.txt'), 'utf8')).toBe('inner')
    expect((await stat(join(h.cwd, 'edir'))).isDirectory()).toBe(true)
    expect((await stat(join(h.cwd, 'd'))).isDirectory()).toBe(true)
    if (linked) expect(await readlink(join(h.cwd, 'cur-link'))).toBe('a.txt')
    const key = await canonicalizeCwd(h.cwd)
    await expect(h.service.recoveryRequired(key)).resolves.toBeUndefined()
    expect(h.service.sessionIndex(SessionId('s1'))?.appliedCheckpointId).toBeUndefined()
  })

  it('treats a missing backup directory as an empty backup during rollback', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const cp = await capture(h)
    await writeFile(join(h.cwd, 'a.txt'), 'two')
    restoreInternals.rename = async () => {
      await rm(backupDir(h.objectRoot, cp.id), { recursive: true, force: true })
      throw new Error('injected rename failure')
    }
    await expect(h.service.restore({ checkpointId: cp.id, cwd: h.cwd }))
      .rejects.toThrow('injected rename failure')
    const key = await canonicalizeCwd(h.cwd)
    await expect(h.service.recoveryRequired(key)).resolves.toBeUndefined()
  })

  it('persists recovery-required after a failed rollback and clears it on the next successful restore', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    const changed: SessionId[] = []
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const cp = await capture(h)
    await writeFile(join(h.cwd, 'a.txt'), 'two')
    restoreInternals.rename = () => Promise.reject(new Error('injected rename failure'))
    restoreInternals.rollback = () => Promise.reject(new Error('injected rollback failure'))
    h.ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => { changed.push(sessionId) })

    await expect(h.service.restore({ checkpointId: cp.id, cwd: h.cwd }))
      .rejects.toThrow('injected rollback failure')
    const key = await canonicalizeCwd(h.cwd)
    await expect(h.service.recoveryRequired(key))
      .resolves.toBe('recovery required: Error: injected rollback failure')
    expect(h.service.sessionIndex(SessionId('s1'))?.recoveryRequired)
      .toBe('recovery required: Error: injected rollback failure')
    expect(changed).toEqual([SessionId('s1')])

    restoreInternals.rename = fsRename
    restoreInternals.rollback = undefined
    await h.service.restore({ checkpointId: cp.id, cwd: h.cwd })
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe('one')
    await expect(h.service.recoveryRequired(key)).resolves.toBeUndefined()
    const index = h.service.sessionIndex(SessionId('s1'))
    expect(index?.recoveryRequired).toBeUndefined()
    expect(index?.appliedCheckpointId).toBe(cp.id)
  })

  it('keeps another workspace\'s recovery flag when a checkpoint is restored into a different cwd', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    const otherCwd = join(h.parent, 'cwd-other')
    await mkdir(otherCwd)
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const cp = await capture(h)
    await h.service.markRecoveryRequired(await canonicalizeCwd(h.cwd), 'source workspace is broken')
    await h.service.restore({ checkpointId: cp.id, cwd: otherCwd })
    expect(await readFile(join(otherCwd, 'a.txt'), 'utf8')).toBe('one')
    expect(h.service.sessionIndex(SessionId('s1'))).toMatchObject({
      appliedCheckpointId: cp.id,
      recoveryRequired: 'source workspace is broken',
    })
  })

  it('keeps emergency and edit links on the session index across a restore, and rebuilds a missing index row', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const base = await capture(h)
    const emergency = await capture(h, { role: 'emergency', boundarySeq: 0, turnOutcome: 'completed' })
    await h.service.recordEdit({
      sourceSessionId: SessionId('s1'),
      sourceBoundarySeq: 0,
      selectedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      childSessionId: SessionId('child'),
    })
    await h.service.restore({ checkpointId: base.id, cwd: h.cwd })
    expect(h.service.sessionIndex(SessionId('s1'))).toMatchObject({
      checkpointIds: [base.id, emergency.id],
      appliedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      edit: { childSessionId: 'child' },
    })

    await h.domain().table('sessions').delete(SessionId('s1'))
    await h.service.restore({ checkpointId: base.id, cwd: h.cwd })
    expect(h.service.sessionIndex(SessionId('s1'))).toEqual({
      checkpointIds: [base.id],
      appliedCheckpointId: base.id,
    })
  })

  it('rolls back when a stored file entry has no blob hash', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const cp = await capture(h)
    await replaceEntries(h, cp.id, [{ relativePath: 'orphan', kind: 'file', size: 0, restoreSafe: true }])
    await expect(h.service.restore({ checkpointId: cp.id, cwd: h.cwd }))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe('one')
    expect(await exists(join(h.cwd, 'orphan'))).toBe(false)
  })

  it('skips a stored symlink entry that has no link target', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const cp = await capture(h)
    await replaceEntries(h, cp.id, [{ relativePath: 'dangling', kind: 'symlink', size: 0, restoreSafe: true }])
    await h.service.restore({ checkpointId: cp.id, cwd: h.cwd })
    expect(await readdir(h.cwd)).toEqual([])
  })
})
