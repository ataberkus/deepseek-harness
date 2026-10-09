import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import * as LocalInvariant from '../src/invariant.ts'
import { bootCoverage, capture } from './coverage-harness.ts'
import type { CoverageHarness } from './coverage-harness.ts'

async function bootWithInvariant(): Promise<CoverageHarness> {
  const h = await bootCoverage()
  await h.ctx.plugin(InvariantRegistry)
  await h.ctx.plugin(LocalInvariant)
  return h
}

describe('workspace-checkpoint-local invariant companion', () => {
  const dispose: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(dispose.splice(0).map(fn => fn()))
  })

  const fire = (h: CoverageHarness, sessionId = 's1'): void => {
    h.ctx.emit('workspace-checkpoint/changed', SessionId(sessionId))
  }

  async function seeded() {
    const h = await bootWithInvariant()
    dispose.push(() => h.dispose())
    await writeFile(join(h.cwd, 'a.txt'), 'a')
    const base = await capture(h)
    const emergency = await capture(h, { role: 'emergency', boundarySeq: 0, turnOutcome: 'completed' })
    const sessions = h.domain().table('sessions')
    const checkpoints = h.domain().table('checkpoints')
    const index = sessions.get(SessionId('s1'))
    if (index === undefined) throw new Error('missing index')
    return { h, base, emergency, sessions, checkpoints, index }
  }

  it('accepts real capture, restore, edit, and recovery flows', async () => {
    const { h, base, emergency } = await seeded()
    await h.service.restore({ checkpointId: base.id, cwd: h.cwd })
    await h.service.recordEdit({
      sourceSessionId: SessionId('s1'),
      sourceBoundarySeq: 0,
      selectedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      childSessionId: SessionId('child'),
    })
    expect(() => { fire(h) }).not.toThrow()
    expect(() => { fire(h, 'child') }).not.toThrow()
  })

  it('reports a checkpoint whose parent row is missing', async () => {
    const { h, base, checkpoints } = await seeded()
    const stored = checkpoints.get(CheckpointId(base.id))
    if (stored === undefined) throw new Error('missing row')
    await checkpoints.put(CheckpointId(base.id), { ...stored, parentCheckpointId: 'cp_missing_parent' })
    expect(() => { fire(h) }).toThrow(/references missing parent 'cp_missing_parent'/)
  })

  it('reports an applied checkpoint that is absent or not restore-eligible unless recovery is required', async () => {
    const { h, base, checkpoints, sessions, index } = await seeded()
    await sessions.put(SessionId('s1'), { ...index, appliedCheckpointId: 'cp_ghost' })
    expect(() => { fire(h) }).toThrow(/applies checkpoint 'cp_ghost' without recoveryRequired/)

    await sessions.put(SessionId('s1'), { ...index, appliedCheckpointId: 'cp_ghost', recoveryRequired: 'rollback failed' })
    expect(() => { fire(h) }).not.toThrow()

    const stored = checkpoints.get(CheckpointId(base.id))
    if (stored === undefined) throw new Error('missing row')
    await checkpoints.put(CheckpointId(base.id), {
      ...stored,
      restoreEligible: false,
      status: { kind: 'unavailable', reason: 'evicted' },
    })
    await sessions.put(SessionId('s1'), { ...index, appliedCheckpointId: base.id })
    expect(() => { fire(h) }).toThrow(new RegExp(`applies checkpoint '${base.id}' without recoveryRequired`))
  })

  it('reports an emergency checkpoint id with no row', async () => {
    const { h, sessions, index } = await seeded()
    await sessions.put(SessionId('s1'), { ...index, emergencyCheckpointId: 'cp_ghost_emergency' })
    expect(() => { fire(h) }).toThrow(/missing emergency checkpoint 'cp_ghost_emergency'/)
  })

  it('reports malformed edit relations', async () => {
    const { h, base, emergency, sessions, index } = await seeded()
    const edit = {
      sourceSessionId: 's1',
      sourceBoundarySeq: 0,
      selectedCheckpointId: base.id,
      emergencyCheckpointId: emergency.id,
      childSessionId: 'child',
    }
    await sessions.put(SessionId('child'), { checkpointIds: [], edit })
    await sessions.put(SessionId('s1'), { ...index, edit })
    expect(() => { fire(h) }).not.toThrow()

    await sessions.put(SessionId('s1'), { ...index, edit: { ...edit, selectedCheckpointId: 'cp_missing_selected' } })
    expect(() => { fire(h) }).toThrow(/edit references missing selected checkpoint 'cp_missing_selected'/)

    await sessions.put(SessionId('s1'), { ...index, edit: { ...edit, emergencyCheckpointId: 'cp_missing_emergency' } })
    expect(() => { fire(h) }).toThrow(/edit references invalid emergency checkpoint 'cp_missing_emergency'/)

    await sessions.put(SessionId('s1'), { ...index, edit: { ...edit, emergencyCheckpointId: base.id } })
    expect(() => { fire(h) }).toThrow(new RegExp(`edit references invalid emergency checkpoint '${base.id}'`))

    await sessions.put(SessionId('s1'), { ...index, edit: { ...edit, childSessionId: 'absent-child' } })
    expect(() => { fire(h) }).toThrow(/edit publishes child 'absent-child' without a matching child index/)

    await sessions.put(SessionId('child'), { checkpointIds: [] })
    await sessions.put(SessionId('s1'), { ...index, edit })
    expect(() => { fire(h) }).toThrow(/edit publishes child 'child' without a matching child index/)

    await sessions.put(SessionId('child'), { checkpointIds: [], edit: { ...edit, childSessionId: 'someone-else' } })
    expect(() => { fire(h) }).toThrow(/edit publishes child 'child' without a matching child index/)
  })

  it('reports a change event emitted while the checkpoint domain is not open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-coverage-invariant-'))
    const ctx = new Context()
    dispose.push(async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(LocalInvariant)
    expect(() => { ctx.emit('workspace-checkpoint/changed', SessionId('s1')) })
      .toThrow(/emitted while the domain is not open/)
  })
})
