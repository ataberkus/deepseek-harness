import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalWorkspaceCheckpoint from '../src/index.ts'
import type { Config } from '../src/config.ts'

async function boot(maxTotalBytes: number) {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-retention-'))
  const cwd = await mkdtemp(join(parent, 'cwd-'))
  const ctx = new Context()
  const config: Config = {
    objectRoot: join(parent, 'objects'),
    maxTotalBytes,
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
    service: ctx.workspaceCheckpoint as LocalWorkspaceCheckpoint,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

describe('workspace checkpoint retention', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('retains blobs referenced by the applied branch and marks the other branch unavailable when quota requires eviction', async () => {
    const harness = await boot(100)
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'parent.bin'), Buffer.alloc(80, 1))
    const parent = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('parent'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await rm(join(harness.cwd, 'parent.bin'))
    await writeFile(join(harness.cwd, 'child.bin'), Buffer.alloc(80, 2))
    const child = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('child'),
      cwd: harness.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    await harness.ctx.workspaceCheckpoint.restore({ checkpointId: child.id, cwd: harness.cwd })
    await harness.ctx.workspaceCheckpoint.evict()
    await expect(harness.ctx.workspaceCheckpoint.inspect(child.id)).resolves.toMatchObject({ restoreEligible: true })
    const evicted = await harness.ctx.workspaceCheckpoint.inspect(parent.id)
    expect(evicted.restoreEligible).toBe(false)
    expect(evicted.status.kind).toBe('unavailable')
  })

  it('keeps an emergency checkpoint linked on the session index', async () => {
    const harness = await boot(1024 * 1024)
    dispose.push(() => harness.dispose())
    await writeFile(join(harness.cwd, 'a.txt'), 'e')
    const emergency = await harness.ctx.workspaceCheckpoint.capture({
      sessionId: SessionId('s1'),
      cwd: harness.cwd,
      boundarySeq: 3,
      role: 'emergency',
      turnOutcome: 'completed',
    })
    const index = harness.service.sessionIndex(SessionId('s1'))
    expect(index?.emergencyCheckpointId).toBe(emergency.id)
  })
})
