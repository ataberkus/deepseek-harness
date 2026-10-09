/**
 * Host `session.retry` and `session.activate`: which turns and Agent states
 * are refused, what each operation emits, and how a failed restore rolls the
 * workspace back.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { CheckpointRecord } from '@deepseek-ai/dsh-workspace-checkpoint'
import {
  abort,
  addTurn,
  agentFixture,
  composeCheckpointFixture,
  host,
  messageText,
  seedTwoTurns,
  sid,
} from './checkpoint-fixture.host.ts'
import type { CheckpointFixture } from './checkpoint-fixture.host.ts'

let cwd: string
let fixture: CheckpointFixture

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-retry-activate-'))
  fixture = await composeCheckpointFixture()
})

afterEach(async () => {
  await fixture.ctx.fiber.dispose()
  await rm(cwd, { recursive: true, force: true })
})

const phases = (): string[] =>
  fixture.frames.map(frame => frame.operation?.phase).filter((phase): phase is NonNullable<typeof phase> => phase !== undefined)

const queued = (): UserMessage =>
  createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })

describe('session.retry', () => {
  async function seededFailure(id: string) {
    const seed = await seedTwoTurns(fixture, cwd, id, true)
    const agent = agentFixture(fixture.ctx, seed.session)
    fixture.ctx.agents.register(agent)
    const run = () => host(fixture.ctx, cwd).retry({
      sessionId: seed.session.id, messageSeq: seed.messageSeq, checkpointId: seed.cp1.id,
    }, abort())
    return { ...seed, agent, run }
  }

  it('re-queues the failed message after restoring the checkpoint and emits ordered same-branch progress', async () => {
    const { agent, run, session, cp1 } = await seededFailure('retry-progress')
    const followup = vi.fn()
    agent.followup = followup

    await expect(run()).resolves.toEqual({ accepted: true })

    expect(followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'B' }],
      source: { kind: 'user' },
    }))
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-1')
    expect(phases()).toEqual(['preparing', 'capturing-emergency', 'restoring', 'ready'])
    for (const frame of fixture.frames) {
      expect(frame).toMatchObject({ sessionId: session.id, appliedCheckpointId: cp1.id })
      expect(frame).not.toHaveProperty('branchCheckpoint')
      expect(frame.operation).not.toHaveProperty('childSessionId')
    }
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it.each(['nextTurn', 'nextStep'] as const)('refuses retry while %s holds queued work', async (target) => {
    const seed = await seedTwoTurns(fixture, cwd, `retry-queue-${target}`, true)
    const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
    inbox[target].push(queued())
    fixture.ctx.agents.register(agentFixture(fixture.ctx, seed.session, inbox))
    await expect(host(fixture.ctx, cwd).retry({
      sessionId: seed.session.id, messageSeq: seed.messageSeq, checkpointId: seed.cp1.id,
    }, abort())).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(inbox[target]).toHaveLength(1)
  })

  it('refuses retry while the Agent is running', async () => {
    const seed = await seedTwoTurns(fixture, cwd, 'retry-running', true)
    fixture.ctx.agents.register({ ...agentFixture(fixture.ctx, seed.session), status: 'running' })
    await expect(host(fixture.ctx, cwd).retry({
      sessionId: seed.session.id, messageSeq: seed.messageSeq, checkpointId: seed.cp1.id,
    }, abort())).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(fixture.restore).not.toHaveBeenCalled()
  })

  it('reports a detached session whose Agent cannot be resumed without restoring the workspace', async () => {
    const seed = await seedTwoTurns(fixture, cwd, 'retry-cold', true)
    await expect(host(fixture.ctx, cwd).retry({
      sessionId: seed.session.id, messageSeq: seed.messageSeq, checkpointId: seed.cp1.id,
    }, abort())).rejects.toMatchObject({ code: 'gateway/internal', message: expect.stringContaining('resume failed') as string })
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
  })

  it('reports an unknown session as not found', async () => {
    await expect(host(fixture.ctx, cwd).retry({
      sessionId: sid('retry-missing'), messageSeq: 1, checkpointId: CheckpointId('cp-x'),
    }, abort())).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it.each([-1, 0.5])('refuses malformed message sequence %s as not retryable', async (messageSeq) => {
    const { run: _run, session, cp1 } = await seededFailure(`retry-seq-${String(messageSeq)}`)
    await expect(host(fixture.ctx, cwd).retry({
      sessionId: session.id, messageSeq, checkpointId: cp1.id,
    }, abort())).rejects.toMatchObject({ code: 'retry-not-retryable' })
  })

  it('refuses a failed turn in a session without a working directory', async () => {
    const session = fixture.ctx.sessions.create(sid('retry-no-cwd'), {})
    addTurn(session, 1, 'A', true)
    const seq = session.snapshotEvents().find(event => messageText(event) === 'A')?.seq ?? -1
    fixture.ctx.agents.register(agentFixture(fixture.ctx, session))
    await expect(host(fixture.ctx, cwd).retry({
      sessionId: session.id, messageSeq: seq, checkpointId: CheckpointId('cp-x'),
    }, abort())).rejects.toMatchObject({ code: 'retry-not-retryable' })
  })

  it('rolls the workspace back and reports the failure when queueing the retry throws', async () => {
    const { agent, run } = await seededFailure('retry-followup-fails')
    agent.followup = () => { throw new Error('agent disposed') }
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-unavailable',
      message: expect.stringContaining('session retry failed') as string,
    })
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
    expect(phases().at(-1)).toBe('failed')
    expect(fixture.frames.at(-1)?.operation?.message).toContain('agent disposed')
    expect(fixture.spies.clearRecoveryRequired).toHaveBeenCalledOnce()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('queues the retry on the Agent resolved again when the registry dropped it during the restore', async () => {
    const { agent, run } = await seededFailure('retry-agent-dropped')
    const followup = vi.fn()
    agent.followup = followup
    const registryGet = fixture.ctx.agents.get.bind(fixture.ctx.agents)
    let dropOnce = false
    fixture.restore.mockImplementationOnce(async (request) => {
      dropOnce = true
      await writeFile(join(request.cwd, 'note.txt'), 'after-turn-1')
      return { checkpointId: request.checkpointId, fileCount: 1 }
    })
    vi.spyOn(fixture.ctx.agents, 'get').mockImplementation((id) => {
      if (dropOnce) {
        dropOnce = false
        return undefined
      }
      return registryGet(id)
    })
    await expect(run()).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('keeps the workspace recovery-required when the retry fails and the rollback also fails', async () => {
    const { agent, run } = await seededFailure('retry-rollback-fails')
    agent.followup = () => { throw new Error('agent disposed') }
    fixture.restore.mockImplementation(async (request) => {
      if (fixture.restore.mock.calls.length > 1) throw new Error('disk full')
      return fixture.impl.restore(request)
    })
    await expect(run()).rejects.toMatchObject({ code: 'checkpoint-recovery-required' })
    expect(fixture.spies.markRecoveryRequired).toHaveBeenCalledWith(
      cwd, expect.stringContaining('disk full') as string,
    )
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('passes a Remote error through when the lease cannot be acquired and nothing was captured', async () => {
    const { run } = await seededFailure('retry-lease-fails')
    const failure = new RemoteError('session/agent-busy', 'workspace locked', { reason: 'locked' })
    fixture.spies.acquireLease.mockRejectedValueOnce(failure)
    await expect(run()).rejects.toBe(failure)
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(phases()).toEqual(['preparing', 'capturing-emergency', 'failed'])
    expect(fixture.lease.release).not.toHaveBeenCalled()
  })
})

describe('session.activate', () => {
  async function seededCompleted(id: string) {
    const seed = await seedTwoTurns(fixture, cwd, id)
    await writeFile(join(cwd, 'note.txt'), 'drifted')
    const run = () => host(fixture.ctx, cwd).activate({ sessionId: seed.session.id }, abort())
    return { ...seed, run }
  }

  it('restores the latest ready checkpoint under a lease and announces the restore', async () => {
    const { run, cp1, session } = await seededCompleted('activate-restores')
    await writeFile(join(cwd, 'note.txt'), 'newest-state')
    const cp2 = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: 99, role: 'turn', turnOutcome: 'completed',
    })
    await writeFile(join(cwd, 'note.txt'), 'drifted-again')

    await expect(run()).resolves.toEqual({ restored: true, checkpointId: cp2.id })

    expect(cp2.id).not.toBe(cp1.id)
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('newest-state')
    expect(fixture.restore).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: cp2.id }))
    expect(phases()).toEqual(['restoring'])
    expect(fixture.frames[0]).toMatchObject({ appliedCheckpointId: cp2.id, branchCheckpoint: { id: cp2.id } })
    expect(fixture.spies.clearRecoveryRequired).toHaveBeenCalledOnce()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('skips emergency, failed, and ineligible checkpoints when choosing what to restore', async () => {
    const { run, cp1, session } = await seededCompleted('activate-skips')
    const emergency = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: 50, role: 'emergency', turnOutcome: 'failed',
    })
    const failed = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: 51, role: 'turn', turnOutcome: 'completed',
    })
    const ineligible = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: 52, role: 'turn', turnOutcome: 'completed',
    })
    fixture.records.set(String(failed.id), { ...failed, status: { kind: 'failed', reason: 'bad' } as never })
    fixture.records.set(String(ineligible.id), { ...ineligible, restoreEligible: false })
    await expect(run()).resolves.toEqual({ restored: true, checkpointId: cp1.id })
    expect(emergency.role).toBe('emergency')
  })

  it('reports an already-applied checkpoint as restored without touching the workspace', async () => {
    const { run, cp1 } = await seededCompleted('activate-applied')
    fixture.spies.sessionIndex.mockReturnValue({ appliedCheckpointId: cp1.id })
    await expect(run()).resolves.toEqual({ restored: true, checkpointId: cp1.id })
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(fixture.frames).toEqual([])
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('drifted')
  })

  it('restores a session whose log is still empty from its initial checkpoint', async () => {
    const session = fixture.ctx.sessions.create(sid('activate-empty-log'), { meta: { cwd } })
    await writeFile(join(cwd, 'note.txt'), 'pristine')
    const initial = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: -1, role: 'initial', turnOutcome: 'initial',
    })
    await writeFile(join(cwd, 'note.txt'), 'drifted')
    await expect(host(fixture.ctx, cwd).activate({ sessionId: session.id }, abort()))
      .resolves.toEqual({ restored: true, checkpointId: initial.id })
    expect(fixture.restore).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: initial.id }))
    expect(fixture.capture).toHaveBeenCalledWith(expect.objectContaining({ role: 'emergency', boundarySeq: -1 }))
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('pristine')
  })

  it('matches checkpoints to a working directory that no longer exists by its recorded path', async () => {
    const gone = join(cwd, 'deleted-workspace')
    const session = fixture.ctx.sessions.create(sid('activate-gone'), { meta: { cwd: gone } })
    const record = await fixture.checkpoint.capture({
      sessionId: session.id, cwd: gone, boundarySeq: -1, role: 'initial', turnOutcome: 'initial',
    })
    fixture.spies.sessionIndex.mockReturnValue({ appliedCheckpointId: record.id })
    await expect(host(fixture.ctx, cwd).activate({ sessionId: session.id }, abort()))
      .resolves.toEqual({ restored: true, checkpointId: record.id })
    expect(fixture.spies.recoveryRequired).toHaveBeenCalledWith(gone)
    expect(fixture.restore).not.toHaveBeenCalled()
  })

  it('reports no checkpoint as unavailable without implying one exists', async () => {
    const session = fixture.ctx.sessions.create(sid('activate-none'), { meta: { cwd } })
    await expect(host(fixture.ctx, cwd).activate({ sessionId: session.id }, abort()))
      .resolves.toEqual({ restored: false, unavailable: false })
  })

  it('reports only unusable checkpoints as unavailable', async () => {
    const { run, cp1 } = await seededCompleted('activate-unusable')
    fixture.records.set(String(cp1.id), { ...cp1, restoreEligible: false })
    await expect(run()).resolves.toEqual({ restored: false, unavailable: true })
    expect(fixture.restore).not.toHaveBeenCalled()
  })

  it.each([
    ['cannot be inspected', (_record: CheckpointRecord) => undefined],
    ['belongs to another workspace', (record: CheckpointRecord) => ({ ...record, workspaceKey: '/elsewhere' })],
  ])('reports a checkpoint that %s as unavailable', async (_name, inspected) => {
    const { run, cp1 } = await seededCompleted('activate-inspect')
    fixture.spies.inspect.mockImplementationOnce(async () => {
      const value = inspected(cp1)
      if (value === undefined) throw new Error('manifest corrupt')
      return value
    })
    await expect(run()).resolves.toEqual({ restored: false, unavailable: true })
    expect(fixture.restore).not.toHaveBeenCalled()
  })

  it('reports a session without a working directory as unavailable', async () => {
    const session = fixture.ctx.sessions.create(sid('activate-no-cwd'), {})
    await expect(host(fixture.ctx, cwd).activate({ sessionId: session.id }, abort()))
      .resolves.toEqual({ restored: false, unavailable: true })
  })

  it('refuses activation while workspace recovery is required', async () => {
    const { run } = await seededCompleted('activate-recovery')
    fixture.spies.recoveryRequired.mockResolvedValueOnce('rollback failed earlier')
    await expect(run()).rejects.toMatchObject({ code: 'checkpoint-recovery-required' })
    expect(fixture.restore).not.toHaveBeenCalled()
  })

  it('refuses activation while the Agent is running', async () => {
    const { run, session } = await seededCompleted('activate-running')
    fixture.ctx.agents.register({ ...agentFixture(fixture.ctx, session), status: 'running' })
    await expect(run()).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(fixture.restore).not.toHaveBeenCalled()
  })

  it('restores the emergency checkpoint and reports checkpoint-unavailable when the restore fails', async () => {
    const { run, cp1 } = await seededCompleted('activate-restore-fails')
    fixture.restore.mockImplementationOnce(async () => {
      await writeFile(join(cwd, 'note.txt'), 'half-restored')
      throw new Error('partial write')
    })
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-unavailable',
      message: expect.stringContaining('session activation failed') as string,
      details: { checkpointId: cp1.id },
    })
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('drifted')
    expect(fixture.spies.clearRecoveryRequired).not.toHaveBeenCalled()
    expect(fixture.spies.markRecoveryRequired).not.toHaveBeenCalled()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('marks the workspace recovery-required when activation and its rollback both fail', async () => {
    const { run } = await seededCompleted('activate-rollback-fails')
    fixture.restore.mockRejectedValue(new Error('disk full'))
    await expect(run()).rejects.toMatchObject({ code: 'checkpoint-recovery-required' })
    expect(fixture.spies.markRecoveryRequired).toHaveBeenCalledWith(
      cwd, expect.stringContaining('checkpoint rollback failed') as string,
    )
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('passes a Remote error through when the lease cannot be acquired', async () => {
    const { run } = await seededCompleted('activate-lease-fails')
    const failure = new RemoteError('session/agent-busy', 'workspace locked', { reason: 'locked' })
    fixture.spies.acquireLease.mockRejectedValueOnce(failure)
    await expect(run()).rejects.toBe(failure)
    expect(fixture.restore).not.toHaveBeenCalled()
  })
})
