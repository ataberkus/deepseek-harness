import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import LocalWorkspaceCheckpoint, { canonicalizeCwd } from '../src/index.ts'
import { bootCoverage, capture } from './coverage-harness.ts'

/** Minimal in-memory settings provider so the provider's settings hooks run for real. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function collectChanged(ctx: Context): SessionId[] {
  const seen: SessionId[] = []
  ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => { seen.push(sessionId) })
  return seen
}

describe('LocalWorkspaceCheckpoint before its domain opens', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('keeps recovery flags in memory and rejects operations that need the domain', async () => {
    const ctx = new Context()
    dispose.push(() => ctx.fiber.dispose())
    // Mount an ordinary plugin first so the test-wide invariant host settles before the bare service attaches.
    await ctx.plugin(Storage)
    const service = new LocalWorkspaceCheckpoint(ctx, {
      objectRoot: resolve('unused-object-root'),
      maxTotalBytes: 1,
      excludeGlobs: [],
      captureRetryCount: 0,
      captureRetryDelayMs: 0,
    })
    expect(service.enabled).toBe(false)
    const missing = join(resolve('no-such-workspace-dir'), 'child')
    await expect(service.recoveryRequired(missing)).resolves.toBeUndefined()
    await service.markRecoveryRequired(missing, 'in-memory reason')
    await expect(service.recoveryRequired(missing)).resolves.toBe('in-memory reason')
    await service.clearRecoveryRequired(missing)
    await expect(service.recoveryRequired(missing)).resolves.toBeUndefined()

    const id = CheckpointId('cp_none')
    await expect(service.inspect(id)).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
    await expect(service.list(SessionId('s1'))).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
    await expect(service.evict()).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
    expect(() => service.sessionIndex(SessionId('s1'))).toThrow(/domain is not open/)
    await expect(service.recordEdit({
      sourceSessionId: SessionId('a'),
      sourceBoundarySeq: 0,
      selectedCheckpointId: id,
      emergencyCheckpointId: id,
      childSessionId: SessionId('b'),
    })).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
  })
})

describe('LocalWorkspaceCheckpoint provider', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  it('follows the live settings section and falls back to the composition value when settings unload', async () => {
    const h = await bootCoverage({ enabled: false })
    dispose.push(() => h.dispose())
    expect(h.service.enabled).toBe(false)
    const fiber = h.ctx.plugin(MemorySettings)
    await fiber
    await h.ctx.settings.update('workspace-checkpoint', { enabled: true })
    expect(h.service.enabled).toBe(true)
    await fiber.dispose()
    expect(h.service.enabled).toBe(false)
  })

  it('records an unavailable checkpoint for a cwd that cannot be canonicalized', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    const missing = join(h.parent, 'does-not-exist')
    const record = await capture(h, { cwd: missing })
    expect(record.workspaceKey).toBe(resolve(missing))
    expect(record.restoreEligible).toBe(false)
    expect(record.status).toEqual({ kind: 'unavailable', reason: 'capture-checkpoint_containment' })
  })

  it('refuses a capture or restore whose lease belongs to another workspace', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const cp = await capture(h)
    const other = await h.service.acquireLease(join(h.parent, 'other-key'))
    await expect(capture(h, { lease: other })).rejects.toMatchObject({ code: 'CHECKPOINT_LEASE_HELD' })
    await expect(h.service.restore({ checkpointId: cp.id, cwd: h.cwd, lease: other }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_LEASE_HELD' })
    other.release()
  })

  it('restores under the caller lease without re-acquiring it', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'one')
    const cp = await capture(h)
    await writeFile(join(h.cwd, 'a.txt'), 'two')
    const lease = await h.service.acquireLease(await canonicalizeCwd(h.cwd))
    await h.service.restore({ checkpointId: cp.id, cwd: h.cwd, lease })
    expect(await readFile(join(h.cwd, 'a.txt'), 'utf8')).toBe('one')
    lease.release()
    // The lease is free again after the holder releases it.
    const again = await h.service.acquireLease(await canonicalizeCwd(h.cwd))
    again.release()
  })

  it('persists recovery flags on every session index of the workspace and clears them', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    const changed = collectChanged(h.ctx)
    const otherCwd = join(h.parent, 'cwd-other')
    await mkdir(otherCwd)
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const base = await capture(h, { sessionId: 's1' })
    const emergency = await capture(h, { sessionId: 's1', role: 'emergency', boundarySeq: 2, turnOutcome: 'completed' })
    await capture(h, { sessionId: 's2', cwd: otherCwd })
    await h.service.restore({ checkpointId: base.id, cwd: h.cwd })
    await h.service.recordEdit({
      sourceSessionId: SessionId('s1'),
      sourceBoundarySeq: 1,
      selectedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      childSessionId: SessionId('child'),
    })
    changed.length = 0
    const key = await canonicalizeCwd(h.cwd)

    await h.service.markRecoveryRequired(key, 'rollback failed')
    expect(h.service.sessionIndex(SessionId('s1'))).toMatchObject({
      appliedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      recoveryRequired: 'rollback failed',
      edit: { childSessionId: 'child' },
    })
    expect(h.service.sessionIndex(SessionId('s2'))?.recoveryRequired).toBeUndefined()
    expect(changed).toEqual([SessionId('s1')])

    await h.service.clearRecoveryRequired(key)
    const cleared = h.service.sessionIndex(SessionId('s1'))
    expect(cleared?.recoveryRequired).toBeUndefined()
    expect(cleared).toMatchObject({ appliedCheckpointId: base.id, emergencyCheckpointId: emergency.id })
    expect(cleared?.edit?.childSessionId).toBe('child')
    await expect(h.service.recoveryRequired(key)).resolves.toBeUndefined()
  })

  it('reloads a persisted recovery flag in a fresh provider and answers repeat queries from memory', async () => {
    const first = await bootCoverage()
    dispose.push(() => rm(first.parent, { recursive: true, force: true }))
    const otherCwd = join(first.parent, 'cwd-other')
    await mkdir(otherCwd)
    await writeFile(join(first.cwd, 'a.txt'), 'a')
    await capture(first, { sessionId: 's1' })
    await capture(first, { sessionId: 's2', cwd: otherCwd })
    const key = await canonicalizeCwd(first.cwd)
    const otherKey = await canonicalizeCwd(otherCwd)
    await first.service.markRecoveryRequired(key, 'persisted reason')
    await first.ctx.fiber.dispose()

    const second = await bootCoverage({ parent: first.parent })
    dispose.push(() => second.dispose())
    await expect(second.service.recoveryRequired(otherKey)).resolves.toBeUndefined()
    await expect(second.service.recoveryRequired(key)).resolves.toBe('persisted reason')
    // Remove the durable flag behind the provider's back: the cached answer still wins.
    const sessions = second.domain().table('sessions')
    const row = sessions.get(SessionId('s1'))
    if (row === undefined) throw new Error('session index missing')
    const { recoveryRequired: _flag, ...withoutFlag } = row
    await sessions.put(SessionId('s1'), withoutFlag)
    await expect(second.service.recoveryRequired(key)).resolves.toBe('persisted reason')
  })

  it('links an edit to the source and child session indexes', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    const changed = collectChanged(h.ctx)
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const selected = await capture(h, { sessionId: 'src' })
    const emergency = await capture(h, { sessionId: 'src', role: 'emergency', boundarySeq: 3, turnOutcome: 'completed' })
    const existingChild = await capture(h, { sessionId: 'child-existing' })
    changed.length = 0

    const link = (child: string) => ({
      sourceSessionId: SessionId('src'),
      sourceBoundarySeq: 3,
      selectedCheckpointId: selected.id,
      emergencyCheckpointId: emergency.id,
      childSessionId: SessionId(child),
    })
    await h.service.recordEdit(link('child-new'))
    expect(h.service.sessionIndex(SessionId('child-new'))).toEqual({
      checkpointIds: [],
      edit: {
        sourceSessionId: 'src',
        sourceBoundarySeq: 3,
        selectedCheckpointId: selected.id,
        emergencyCheckpointId: emergency.id,
        childSessionId: 'child-new',
      },
    })
    expect(h.service.sessionIndex(SessionId('src'))?.edit?.childSessionId).toBe('child-new')
    expect(changed).toEqual([SessionId('src'), SessionId('child-new')])

    await h.service.recordEdit(link('child-existing'))
    expect(h.service.sessionIndex(SessionId('child-existing'))).toMatchObject({
      checkpointIds: [existingChild.id],
      edit: { childSessionId: 'child-existing' },
    })
  })

  it('rejects an edit whose source session has no index', async () => {
    const h = await bootCoverage()
    dispose.push(() => h.dispose())
    await expect(h.service.recordEdit({
      sourceSessionId: SessionId('ghost'),
      sourceBoundarySeq: 0,
      selectedCheckpointId: CheckpointId('cp_a'),
      emergencyCheckpointId: CheckpointId('cp_b'),
      childSessionId: SessionId('child'),
    })).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE' })
    expect(h.service.sessionIndex(SessionId('child'))).toBeUndefined()
  })
})
