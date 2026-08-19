import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { CheckpointId, WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'
import LocalWorkspaceCheckpoint, { captureInternals } from '../src/index.ts'
import { resolveObjectRoot } from '../src/objects.ts'
import type { Config } from '../src/config.ts'

interface Harness {
  readonly ctx: Context
  readonly cwd: string
  readonly objectRoot: string
  dispose(): Promise<void>
}

async function boot(options: {
  readonly parent: string
  readonly maxTotalBytes?: number
  readonly persistRoots?: { readonly storageRoot: string; readonly objectRoot: string }
} = { parent: '' }): Promise<Harness> {
  const parent = options.parent === ''
    ? await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-store-'))
    : options.parent
  const cwd = await mkdtemp(join(parent, 'cwd-'))
  const storageRoot = options.persistRoots?.storageRoot ?? join(parent, 'storage')
  const objectRoot = options.persistRoots?.objectRoot ?? join(parent, 'objects')
  await mkdir(storageRoot, { recursive: true })
  await mkdir(objectRoot, { recursive: true })
  const ctx = new Context()
  const config: Config = {
    objectRoot,
    maxTotalBytes: options.maxTotalBytes ?? 1024 * 1024,
    excludeGlobs: [],
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
      if (options.parent === '') await rm(parent, { recursive: true, force: true })
    },
  }
}

function blobNames(names: readonly string[]): string[] {
  return names.filter(name => /[0-9a-f]{64}$/.test(name.replaceAll('\\', '/')))
}

describe('LocalWorkspaceCheckpoint capture', () => {
  const dispose: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('stores file bytes by content hash and reuses identical contents', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'same')
    await writeFile(join(harness.cwd, 'b.txt'), 'same')
    const record = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    expect(record.status).toEqual({ kind: 'ready' })
    expect(record.restoreEligible).toBe(true)
    expect(record.labelIndex).toBe(0)
    const objects = await readdir(harness.objectRoot, { recursive: true })
    expect(blobNames(objects)).toHaveLength(1)
    const listed = await harness.ctx.workspaceCheckpoint.list(SessionId('s1'))
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(record.id)
  })

  it('marks a checkpoint unavailable when quota is exhausted and keeps prior records', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-quota-'))
    dispose.push(async () => { await rm(parent, { recursive: true, force: true }) })
    const first = await boot({ parent, maxTotalBytes: 1024 * 1024 })
    await writeFile(join(first.cwd, 'small.txt'), 'ok')
    const prior = await first.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: first.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    expect(prior.status).toEqual({ kind: 'ready' })
    await first.dispose()

    const tiny = await boot({
      parent,
      maxTotalBytes: 100,
      persistRoots: { storageRoot: join(parent, 'storage'), objectRoot: join(parent, 'objects') },
    })
    dispose.push(() => tiny.dispose())
    await writeFile(join(tiny.cwd, 'big.bin'), Buffer.alloc(2048, 1))
    const record = await tiny.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: tiny.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    expect(record.status.kind).toBe('unavailable')
    await expect(tiny.ctx.workspaceCheckpoint.inspect(record.id)).resolves.toMatchObject({ status: { kind: 'unavailable' } })
    await expect(tiny.ctx.workspaceCheckpoint.inspect(prior.id)).resolves.toMatchObject({ id: prior.id, status: { kind: 'ready' } })
  })

  it('survives process restart by reopening the domain', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-restart-'))
    dispose.push(async () => { await rm(parent, { recursive: true, force: true }) })
    const firstHarness = await boot({ parent })
    await writeFile(join(firstHarness.cwd, 'keep.txt'), 'hello')
    const first = await firstHarness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: firstHarness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await firstHarness.dispose()

    const reopened = await boot({
      parent,
      persistRoots: { storageRoot: join(parent, 'storage'), objectRoot: join(parent, 'objects') },
    })
    dispose.push(() => reopened.dispose())
    await expect(reopened.ctx.workspaceCheckpoint.inspect(first.id)).resolves.toMatchObject({
      id: first.id,
      manifestHash: first.manifestHash,
    })
  })

  it('throws CHECKPOINT_NOT_FOUND for an unknown id', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await expect(harness.ctx.workspaceCheckpoint.inspect(CheckpointId('missing')))
      .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' })
    expect(await harness.ctx.workspaceCheckpoint.list(SessionId('missing'))).toEqual([])
  })

  it('persists unavailable when capture keeps racing', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    const original = captureInternals.buildManifest
    captureInternals.buildManifest = async () => {
      throw new WorkspaceCheckpointError('raced', 'CHECKPOINT_CONCURRENT_WRITE')
    }
    try {
      const record = await harness.ctx.workspaceCheckpoint.capture({
        sessionId: SessionId('s1'),
        cwd: harness.cwd,
        boundarySeq: -1,
        role: 'initial',
        turnOutcome: 'initial',
      })
      expect(record.status).toEqual({ kind: 'unavailable', reason: 'concurrent-write' })
      expect(record.restoreEligible).toBe(false)
    } finally {
      captureInternals.buildManifest = original
    }
  })

  it('propagates non-concurrent capture failures', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    const original = captureInternals.buildManifest
    captureInternals.buildManifest = async () => {
      throw new Error('boom')
    }
    try {
      await expect(harness.ctx.workspaceCheckpoint.capture({
        sessionId: SessionId('s1'),
        cwd: harness.cwd,
        boundarySeq: -1,
        role: 'initial',
        turnOutcome: 'initial',
      })).rejects.toThrow('boom')
    } finally {
      captureInternals.buildManifest = original
    }
  })

  it('marks an unsafe symlink checkpoint unavailable', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    try {
      await symlink(join(harness.cwd, '..', 'outside.txt'), join(harness.cwd, 'escape'))
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) return
      throw error
    }
    const record = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    expect(record.status).toEqual({ kind: 'unavailable', reason: 'unsafe-entry' })
    expect(record.restoreEligible).toBe(false)
  })

  it('holds an in-process lease and records recovery flags', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await expect(harness.ctx.workspaceCheckpoint.recoveryRequired('k')).resolves.toBeUndefined()
    await harness.ctx.workspaceCheckpoint.markRecoveryRequired('k', 'recovery required')
    await expect(harness.ctx.workspaceCheckpoint.recoveryRequired('k')).resolves.toBe('recovery required')
    await harness.ctx.workspaceCheckpoint.clearRecoveryRequired('k')
    await expect(harness.ctx.workspaceCheckpoint.recoveryRequired('k')).resolves.toBeUndefined()
    await expect(harness.ctx.workspaceCheckpoint.evict()).resolves.toBeUndefined()
    await expect(harness.ctx.workspaceCheckpoint.restore({
      checkpointId: CheckpointId('missing'),
      cwd: harness.cwd,
    })).rejects.toMatchObject({ code: 'CHECKPOINT_NOT_FOUND' })
    const lease = await harness.ctx.workspaceCheckpoint.acquireLease('k')
    await expect(harness.ctx.workspaceCheckpoint.acquireLease('k'))
      .rejects.toMatchObject({ code: 'CHECKPOINT_LEASE_HELD' })
    lease.release()
    lease.release()
    const again = await harness.ctx.workspaceCheckpoint.acquireLease('k')
    again.release()
  })

  it('resolves the default object root under the configured harness home', () => {
    const home = resolve(join(tmpdir(), 'dsh-home-checkpoint'))
    expect(resolveObjectRoot({
      dshHome: home,
      maxTotalBytes: 1,
      excludeGlobs: [],
      captureRetryCount: 0,
      captureRetryDelayMs: 0,
    })).toBe(join(home, 'workspace-checkpoints'))
  })
})
