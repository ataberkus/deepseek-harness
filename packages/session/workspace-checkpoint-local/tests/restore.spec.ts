import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalWorkspaceCheckpoint, { captureInternals, canonicalizeCwd, restoreInternals } from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { buildManifest } from '../src/manifest.ts'
import { rename as fsRename } from 'node:fs/promises'

interface Harness {
  readonly ctx: Context
  readonly cwd: string
  readonly objectRoot: string
  dispose(): Promise<void>
}

async function boot(excludeGlobs: string[] = []): Promise<Harness> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-restore-'))
  const cwd = await mkdtemp(join(parent, 'cwd-'))
  const storageRoot = join(parent, 'storage')
  const objectRoot = join(parent, 'objects')
  await mkdir(storageRoot, { recursive: true })
  await mkdir(objectRoot, { recursive: true })
  const ctx = new Context()
  const config: Config = {
    objectRoot,
    maxTotalBytes: 1024 * 1024,
    excludeGlobs,
    captureRetryCount: 2,
    captureRetryDelayMs: 10,
  }
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalWorkspaceCheckpoint, config)
  return {
    ctx,
    cwd,
    objectRoot,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

describe('LocalWorkspaceCheckpoint restore', () => {
  const dispose: Array<() => Promise<void>> = []

  afterEach(async () => {
    captureInternals.buildManifest = buildManifest
    restoreInternals.rename = fsRename
    restoreInternals.rollback = undefined
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('restores modified, created, deleted, renamed, and binary files', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'one')
    await writeFile(join(harness.cwd, 'keep.bin'), Buffer.from([1, 2, 3]))
    const cp = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await writeFile(join(harness.cwd, 'a.txt'), 'two')
    await writeFile(join(harness.cwd, 'extra.txt'), 'x')
    await rm(join(harness.cwd, 'keep.bin'))
    await harness.ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd: harness.cwd })
    expect(await readFile(join(harness.cwd, 'a.txt'), 'utf8')).toBe('one')
    expect(await readFile(join(harness.cwd, 'keep.bin'))).toEqual(Buffer.from([1, 2, 3]))
    await expect(stat(join(harness.cwd, 'extra.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves an excluded file untouched when restoring an older checkpoint', async () => {
    const excludeGlobs = ['**/processhacker_audit.log']
    const harness = await boot(excludeGlobs)
    captureInternals.buildManifest = cwd => buildManifest(cwd, { excludeGlobs: [] })
    dispose.push(() => harness.dispose())
    const lockedPath = join(harness.cwd, 'processhacker_audit.log')
    await writeFile(lockedPath, 'before\n')
    const cp = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s-excluded'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await writeFile(lockedPath, 'after\n')
    await harness.ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd: harness.cwd })
    expect(await readFile(lockedPath, 'utf8')).toBe('after\n')
  })

  it('leaves excluded trees in place when the object store lives inside cwd', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-restore-nested-'))
    const cwd = join(parent, 'cwd')
    const storageRoot = join(parent, 'storage')
    const objectRoot = join(cwd, '.dsh-home', 'workspace-checkpoints')
    await mkdir(cwd, { recursive: true })
    await mkdir(storageRoot, { recursive: true })
    await mkdir(objectRoot, { recursive: true })
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(LocalWorkspaceCheckpoint, {
      objectRoot,
      maxTotalBytes: 1024 * 1024,
      excludeGlobs: ['**/.dsh-home/**'],
      captureRetryCount: 2,
      captureRetryDelayMs: 10,
    } satisfies Config)
    dispose.push(async () => {
      await ctx.fiber.dispose()
      await rm(parent, { recursive: true, force: true })
    })
    await writeFile(join(cwd, 'state.txt'), 'before-edit\n')
    const cp = await ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await writeFile(join(cwd, 'state.txt'), 'after-edit\n')
    await writeFile(join(cwd, '.dsh-home', 'keep.txt'), 'harness')
    await ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd })
    expect(await readFile(join(cwd, 'state.txt'), 'utf8')).toBe('before-edit\n')
    expect(await readFile(join(cwd, '.dsh-home', 'keep.txt'), 'utf8')).toBe('harness')
  })

  it('rejects a missing blob without touching the workspace', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'kept.txt'), 'k')
    const cp = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await rm(join(harness.objectRoot, 'objects'), { recursive: true, force: true })
    await writeFile(join(harness.cwd, 'marker.txt'), 'stay')
    await expect(harness.ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd: harness.cwd }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_HASH_MISMATCH' })
    expect(await readFile(join(harness.cwd, 'marker.txt'), 'utf8')).toBe('stay')
  })

  it('rolls back a mid-commit failure and leaves the original tree', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'one')
    const cp = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await writeFile(join(harness.cwd, 'dirty.txt'), 'dirty')
    restoreInternals.rename = async () => {
      throw new Error('injected rename failure')
    }
    await expect(harness.ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd: harness.cwd }))
      .rejects.toBeTruthy()
    expect(await readFile(join(harness.cwd, 'dirty.txt'), 'utf8')).toBe('dirty')
  })

  it('marks recovery-required when rollback itself fails', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'one')
    const cp = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    restoreInternals.rename = async () => {
      throw new Error('injected rename failure')
    }
    restoreInternals.rollback = async () => {
      throw new Error('injected rollback failure')
    }
    await expect(harness.ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd: harness.cwd }))
      .rejects.toBeTruthy()
    const key = await canonicalizeCwd(harness.cwd)
    await expect(harness.ctx.workspaceCheckpoint.recoveryRequired(key))
      .resolves.toEqual(expect.stringContaining('recovery'))
  })
})
