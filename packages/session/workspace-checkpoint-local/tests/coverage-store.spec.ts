import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CheckpointId, WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { CaptureRequest } from '@deepseek-ai/dsh-workspace-checkpoint'
import { canonicalizeCwd, captureInternals } from '../src/index.ts'
import { buildManifest } from '../src/manifest.ts'
import { captureCheckpoint } from '../src/store.ts'
import { bootCoverage, capture } from './coverage-harness.ts'

describe('capture records', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    captureInternals.buildManifest = buildManifest
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('canonicalizes the cwd itself when the caller supplies no workspace key', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const record = await captureCheckpoint({
      sessionId: SessionId('direct'),
      cwd: h.cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    }, {
      objectRoot: h.objectRoot,
      maxTotalBytes: 1024,
      excludeGlobs: [],
      captureRetryCount: 0,
      captureRetryDelayMs: 0,
      domain: h.domain(),
    })
    expect(record.workspaceKey).toBe(await canonicalizeCwd(h.cwd))
    expect(record.status).toEqual({ kind: 'ready' })
  })

  it('carries workspace id and parent into the record and preserves the session index fields on later captures', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const workspaceId = 'ws_one' as NonNullable<CaptureRequest['workspaceId']>
    const base = await capture(h, { workspaceId })
    expect(base.workspaceId).toBe('ws_one')
    const emergency = await capture(h, { role: 'emergency', boundarySeq: 0, turnOutcome: 'completed' })
    await h.service.restore({ checkpointId: base.id, cwd: h.cwd })
    await h.service.recordEdit({
      sourceSessionId: SessionId('s1'),
      sourceBoundarySeq: 0,
      selectedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      childSessionId: SessionId('child'),
    })
    await h.service.markRecoveryRequired(await canonicalizeCwd(h.cwd), 'flagged')

    const turn = await capture(h, {
      role: 'turn', boundarySeq: 1, turnOutcome: 'completed', parentCheckpointId: base.id, workspaceId,
    })
    expect(turn.parentCheckpointId).toBe(base.id)
    expect(turn.labelIndex).toBe(1)
    expect(emergency.labelIndex).toBe(1)
    expect(h.service.sessionIndex(SessionId('s1'))).toMatchObject({
      checkpointIds: [base.id, emergency.id, turn.id],
      appliedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      recoveryRequired: 'flagged',
      edit: { childSessionId: 'child' },
    })

    const newerEmergency = await capture(h, { role: 'emergency', boundarySeq: 2, turnOutcome: 'failed' })
    expect(h.service.sessionIndex(SessionId('s1'))?.emergencyCheckpointId).toBe(newerEmergency.id)
  })

  it('lists records in label order and skips ids whose rows are gone', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const first = await capture(h)
    const second = await capture(h, { role: 'turn', boundarySeq: 0, turnOutcome: 'completed' })
    const sessions = h.domain().table('sessions')
    const index = sessions.get(SessionId('s1'))
    if (index === undefined) throw new Error('missing index')
    await sessions.put(SessionId('s1'), { ...index, checkpointIds: [second.id, 'cp_ghost', first.id] })

    const views = await h.service.list(SessionId('s1'))
    expect(views.map(view => view.id)).toEqual([first.id, second.id])
    await expect(h.service.list(SessionId('nobody'))).resolves.toEqual([])

    const third = await capture(h, { role: 'turn', boundarySeq: 1, turnOutcome: 'completed' })
    expect(third.labelIndex).toBe(2)
  })

  it('stores entries without optional mode when the manifest carries none', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    captureInternals.buildManifest = async (cwd, options) => {
      const manifest = await buildManifest(cwd, options)
      return { ...manifest, entries: manifest.entries.map(({ mode: _mode, ...rest }) => rest) }
    }
    const record = await capture(h)
    const stored = h.domain().table('checkpoints').get(CheckpointId(record.id))
    expect(stored?.entries).toHaveLength(1)
    expect(stored?.entries[0]).not.toHaveProperty('mode')
    expect(stored?.entries[0]?.hash).toBeDefined()
  })

  it('admits a capture that exactly fills the byte cap and persists an unavailable record just above it', async () => {
    const h = await bootCoverage({ maxTotalBytes: 8 })
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'f.bin'), '12345678')
    const fits = await capture(h)
    expect(fits.status).toEqual({ kind: 'ready' })
    await writeFile(join(h.cwd, 'f.bin'), '123456789')
    const over = await capture(h, { role: 'turn', boundarySeq: 0, turnOutcome: 'completed' })
    expect(over).toMatchObject({
      status: { kind: 'unavailable', reason: 'quota-exhausted' },
      restoreEligible: false,
    })
    await expect(h.service.inspect(fits.id)).resolves.toMatchObject({ restoreEligible: true })
    expect(h.service.sessionIndex(SessionId('s1'))?.checkpointIds).toEqual([fits.id, over.id])
  })

  it('retries a concurrent-write failure and succeeds when the next attempt is clean', async () => {
    const h = await bootCoverage({ captureRetryCount: 2, captureRetryDelayMs: 1 })
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    let attempts = 0
    captureInternals.buildManifest = (cwd, options) => {
      attempts += 1
      if (attempts <= 2) {
        return Promise.reject(new WorkspaceCheckpointError('raced', 'CHECKPOINT_CONCURRENT_WRITE'))
      }
      return buildManifest(cwd, options)
    }
    const record = await capture(h)
    expect(attempts).toBe(3)
    expect(record.status).toEqual({ kind: 'ready' })
  })

  it('records concurrent-write after the retries run out, and capture-failed for an unrelated error', async () => {
    const h = await bootCoverage({ captureRetryCount: 1, captureRetryDelayMs: 1 })
    dispose.push(() => h.dispose())
    let attempts = 0
    captureInternals.buildManifest = () => {
      attempts += 1
      return Promise.reject(new WorkspaceCheckpointError('raced', 'CHECKPOINT_CONCURRENT_WRITE'))
    }
    const raced = await capture(h)
    expect(attempts).toBe(2)
    expect(raced.status).toEqual({ kind: 'unavailable', reason: 'concurrent-write' })

    attempts = 0
    captureInternals.buildManifest = () => {
      attempts += 1
      return Promise.reject(new Error('disk exploded'))
    }
    const failed = await capture(h, { role: 'turn', boundarySeq: 0, turnOutcome: 'failed' })
    expect(attempts).toBe(1)
    expect(failed.status).toEqual({ kind: 'unavailable', reason: 'capture-failed' })
  })

  it('records an unavailable checkpoint when a file changes between hashing and blob admission', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await mkdir(join(h.cwd, 'sub'))
    await writeFile(join(h.cwd, 'sub', 'a.txt'), 'before')
    captureInternals.buildManifest = async (cwd, options) => {
      const manifest = await buildManifest(cwd, options)
      await writeFile(join(h.cwd, 'sub', 'a.txt'), 'after!')
      return manifest
    }
    const record = await capture(h)
    expect(record.status).toEqual({ kind: 'unavailable', reason: 'capture-checkpoint_concurrent_write' })
    expect(record.restoreEligible).toBe(false)
    expect(await readFile(join(h.cwd, 'sub', 'a.txt'), 'utf8')).toBe('after!')
  })
})
