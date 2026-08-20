import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalWorkspaceCheckpoint, { canonicalizeCwd } from '../src/index.ts'
import type { Config } from '../src/config.ts'

async function boot() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-lease-'))
  const cwd = await mkdtemp(join(parent, 'cwd-'))
  const ctx = new Context()
  const config: Config = {
    objectRoot: join(parent, 'objects'),
    maxTotalBytes: 1024 * 1024,
    excludeGlobs: [],
    captureRetryCount: 0,
    captureRetryDelayMs: 0,
  }
  await mkdir(join(parent, 'storage'), { recursive: true })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(parent, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalWorkspaceCheckpoint, config)
  return {
    ctx,
    cwd,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

describe('workspace lease', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('serializes restore and capture on one workspace', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'x')
    const key = await canonicalizeCwd(harness.cwd)
    const held = await harness.ctx.workspaceCheckpoint.acquireLease(key)
    let started = false
    const blocked = harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: 0,
      role: 'turn',
      turnOutcome: 'completed',
    }).then((result) => {
      started = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toBe(false)
    held.release()
    await blocked
    expect(started).toBe(true)
  })

  it('captures under the operation lease without waiting for its own release', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'x')
    const key = await canonicalizeCwd(harness.cwd)
    const held = await harness.ctx.workspaceCheckpoint.acquireLease(key)
    const captured = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: 0,
      role: 'initial',
      turnOutcome: 'initial',
      lease: held,
    })
    expect(captured.status).toEqual({ kind: 'ready' })
    held.release()
  })

  it('rejects a second acquire while the lease is held', async () => {
    const harness = await boot()
    dispose.push(() => harness.dispose())
    const key = await canonicalizeCwd(harness.cwd)
    const held = await harness.ctx.workspaceCheckpoint.acquireLease(key)
    await expect(harness.ctx.workspaceCheckpoint.acquireLease(key))
      .rejects.toMatchObject({ code: 'CHECKPOINT_LEASE_HELD' })
    held.release()
  })
})
