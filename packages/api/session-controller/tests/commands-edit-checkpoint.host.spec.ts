/**
 * Host `session.edit` refusals, progress notifications, and rollback: which
 * messages and checkpoints are refused, what the operation emits, and how a
 * failed branch restores the workspace.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { CheckpointRecord } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
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
  cwd = await mkdtemp(join(tmpdir(), 'dsh-edit-checkpoint-'))
  fixture = await composeCheckpointFixture()
})

afterEach(async () => {
  await fixture.ctx.fiber.dispose()
  await rm(cwd, { recursive: true, force: true })
})

const phases = (): string[] =>
  fixture.frames.map(frame => frame.operation?.phase).filter((phase): phase is NonNullable<typeof phase> => phase !== undefined)

describe('session.edit refusals', () => {
  it.each(['', '   \n\t'])('refuses replacement text %j without capturing or restoring anything', async (text) => {
    const { session, messageSeq, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-empty')
    fixture.ctx.agents.register(agentFixture(fixture.ctx, session))
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text,
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
    expect(fixture.capture).toHaveBeenCalledTimes(1)
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(fixture.frames).toEqual([])
  })

  it('reports a source that cannot be stopped as busy and leaves the workspace untouched', async () => {
    const { session, messageSeq, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-unstoppable')
    const cancel = vi.fn()
    fixture.ctx.agents.register({
      ...agentFixture(fixture.ctx, session),
      status: 'running',
      cancel,
      whenIdle: () => Promise.reject(new Error('still streaming')),
    })
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({
      code: 'session/agent-busy',
      message: expect.stringContaining('still streaming') as string,
    })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
  })

  it('refuses a message when the session has no working directory', async () => {
    const session = fixture.ctx.sessions.create(sid('edit-no-cwd'), {})
    addTurn(session, 1, 'A')
    const seq = session.snapshotEvents().find(event => messageText(event) === 'A')?.seq ?? -1
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: seq, checkpointId: CheckpointId('cp-x'), text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it.each([-1, 1.5, Number.NaN])('refuses malformed message sequence %s', async (messageSeq) => {
    const { session, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-bad-seq')
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('refuses a sequence that names no event', async () => {
    const { session, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-missing-seq')
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: 9999, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('refuses a sequence that names an event other than a user message', async () => {
    const { session, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-not-message')
    const turnStart = session.snapshotEvents().find(event => event.type === 'turn/start')
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: turnStart?.seq ?? -1, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('refuses a user message that only replaced earlier transcript content', async () => {
    const { session, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-hidden')
    session.append('turn/start', { turn: 3 })
    const original = session.snapshotEvents().find(event => messageText(event) === 'A')
    if (original === undefined) throw new Error('test message A was not appended')
    const hidden = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summarized' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: hidden.seq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('refuses a message that a plugin, not the user, produced', async () => {
    const { session, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-plugin-message')
    session.append('turn/start', { turn: 3 })
    const injected = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected' }],
      source: { kind: 'plugin', plugin: 'test-plugin' } as never,
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: injected.seq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('refuses a message whose turn has not ended', async () => {
    const { session, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-open-turn')
    session.append('turn/start', { turn: 3 })
    const open = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'open' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: open.seq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('refuses a message that no turn started', async () => {
    const session = fixture.ctx.sessions.create(sid('edit-no-turn-start'), { meta: { cwd } })
    const orphan = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'orphan' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: orphan.seq, checkpointId: CheckpointId('cp-x'), text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'edit-not-editable' })
  })

  it('reports an unknown session as not found', async () => {
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: sid('no-such-session'), messageSeq: 1, checkpointId: CheckpointId('cp-x'), text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('reports an unreadable session as an internal failure', async () => {
    const { session, messageSeq, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-unreadable')
    vi.spyOn(session, 'snapshotEvents').mockImplementation(() => { throw new Error('disk gone') })
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({
      code: 'gateway/internal',
      message: expect.stringContaining('disk gone') as string,
    })
  })

  it('refuses edit while workspace recovery is required and creates no child', async () => {
    const { session, messageSeq, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-recovery')
    fixture.spies.recoveryRequired.mockResolvedValueOnce('rollback failed earlier')
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'checkpoint-recovery-required' })
    expect(fixture.ctx.sessions.get(sid('edit-recovery'))).toBe(session)
  })
})

describe('session.edit checkpoint selection', () => {
  const mutations: ReadonlyArray<readonly [string, (record: CheckpointRecord) => CheckpointRecord]> = [
    ['belongs to another session', record => ({ ...record, sessionId: sid('other') })],
    ['belongs to another workspace', record => ({ ...record, workspaceKey: '/elsewhere' })],
    ['restores a different boundary', record => ({ ...record, boundarySeq: record.boundarySeq + 1 })],
    ['is an emergency checkpoint', record => ({ ...record, role: 'emergency' })],
    ['is not ready', record => ({ ...record, status: { kind: 'failed', reason: 'bad' } as never })],
    ['is not restore-eligible', record => ({ ...record, restoreEligible: false })],
  ]

  it.each(mutations)('refuses a checkpoint that %s without restoring anything', async (_name, mutate) => {
    const { session, messageSeq, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-select')
    fixture.records.set(String(cp1.id), mutate(cp1))
    fixture.ctx.agents.register(agentFixture(fixture.ctx, session))
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'checkpoint-unavailable' })
    expect(fixture.restore).not.toHaveBeenCalled()
    expect(fixture.frames).toEqual([])
  })

  it('refuses a checkpoint id the store does not know', async () => {
    const { session, messageSeq } = await seedTwoTurns(fixture, cwd, 'edit-unknown')
    await expect(host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: CheckpointId('cp-missing'), text: 'edited',
    }, abort())).rejects.toMatchObject({ code: 'checkpoint-unavailable' })
  })
})

describe('session.edit branching', () => {
  it('branches the first turn of a cold session, attaches the child to the source workspace, and emits ordered progress', async () => {
    const session = fixture.ctx.sessions.create(sid('edit-first-turn'), { meta: { cwd } })
    await writeFile(join(cwd, 'note.txt'), 'pristine')
    const initial = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: -1, role: 'initial', turnOutcome: 'initial',
    })
    session.append('turn/start', { turn: 1 })
    const image = { type: 'file', attachment: { name: 'spec.pdf' } } as never
    const message = session.append('user/message', createUserMessage({
      content: [image, { type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await writeFile(join(cwd, 'note.txt'), 'edited-by-turn-1')
    const attachSession = vi.fn(async () => undefined)
    fixture.workspaces.push({ id: 'ws-1', sessionIds: [session.id], attachSession } as unknown as Workspace)

    const value = await host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: message.seq, checkpointId: initial.id, text: 'rewritten',
    }, abort())

    const child = fixture.ctx.sessions.get(value.sessionId)
    if (child === undefined) throw new Error('edit did not publish a child')
    expect(attachSession).toHaveBeenCalledWith(value.sessionId)
    const childMessage = child.snapshotEvents().find(event => event.type === 'user/message')
    expect(childMessage?.data).toMatchObject({ content: [image, { type: 'text', text: 'rewritten' }] })
    expect(fixture.capture).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: value.sessionId, role: 'initial', boundarySeq: -1,
    }))
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('pristine')
    expect(phases()).toEqual([
      'preparing', 'capturing-emergency', 'restoring', 'creating-branch', 'ready',
    ])
    expect(fixture.frames.at(-1)).toMatchObject({
      sessionId: session.id,
      appliedCheckpointId: initial.id,
      branchCheckpoint: { id: initial.id },
      operation: { checkpointId: initial.id, childSessionId: value.sessionId, phase: 'ready' },
    })
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('prepends the edited text when the original message had no text block', async () => {
    const session = fixture.ctx.sessions.create(sid('edit-attachment-only'), { meta: { cwd } })
    await writeFile(join(cwd, 'note.txt'), 'pristine')
    const initial = await fixture.checkpoint.capture({
      sessionId: session.id, cwd, boundarySeq: -1, role: 'initial', turnOutcome: 'initial',
    })
    session.append('turn/start', { turn: 1 })
    const file = { type: 'file', attachment: { name: 'spec.pdf' } } as never
    const message = session.append('user/message', createUserMessage({
      content: [file],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const value = await host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq: message.seq, checkpointId: initial.id, text: 'describe this',
    }, abort())

    const childMessage = fixture.ctx.sessions.get(value.sessionId)?.snapshotEvents()
      .find(event => event.type === 'user/message')
    expect(childMessage?.data).toMatchObject({ content: [{ type: 'text', text: 'describe this' }, file] })
  })
})

describe('session.edit presets', () => {
  it('starts the child with the preset mounted on the source session', async () => {
    const { session, messageSeq, cp1 } = await seedTwoTurns(fixture, cwd, 'edit-preset')
    fixture.ctx.agents.register(agentFixture(fixture.ctx, session))
    const mount = vi.fn(async () => undefined)
    fixture.ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'minimal' }),
      mount,
    } as never)
    const value = await host(fixture.ctx, cwd).edit({
      sessionId: session.id, messageSeq, checkpointId: cp1.id, text: 'edited',
    }, abort())
    expect(fixture.ctx.sessions.get(value.sessionId)?.header.agentPreset).toBe('minimal')
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'minimal')
  })
})

describe('session.edit failure rollback', () => {
  async function seeded(id: string) {
    const seed = await seedTwoTurns(fixture, cwd, id)
    fixture.ctx.agents.register(agentFixture(fixture.ctx, seed.session))
    const run = () => host(fixture.ctx, cwd).edit({
      sessionId: seed.session.id, messageSeq: seed.messageSeq, checkpointId: seed.cp1.id, text: 'edited',
    }, abort())
    return { ...seed, run }
  }

  it('restores the pre-edit workspace and reports checkpoint-unavailable when the branch link cannot be recorded', async () => {
    const { run } = await seeded('edit-record-fails')
    fixture.spies.recordEdit.mockRejectedValueOnce(new Error('index locked'))
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-unavailable',
      message: expect.stringContaining('session edit failed') as string,
    })
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
    expect(phases().at(-1)).toBe('failed')
    expect(fixture.frames.at(-1)?.operation?.message).toContain('index locked')
    expect(fixture.spies.clearRecoveryRequired).toHaveBeenCalledOnce()
    expect(fixture.spies.markRecoveryRequired).not.toHaveBeenCalled()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('passes a Remote error from the branch step through unchanged', async () => {
    const { run } = await seeded('edit-remote-error')
    const failure = new RemoteError('session/agent-busy', 'busy child', {})
    fixture.spies.recordEdit.mockRejectedValueOnce(failure)
    await expect(run()).rejects.toBe(failure)
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
  })

  it('marks the workspace recovery-required when the rollback also fails', async () => {
    const { run } = await seeded('edit-rollback-fails')
    fixture.spies.recordEdit.mockRejectedValueOnce(new Error('index locked'))
    const original = fixture.restore.getMockImplementation()
    fixture.restore.mockImplementation(async (request) => {
      if (fixture.restore.mock.calls.length > 1) throw new Error('disk full')
      return original?.(request)
    })
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-recovery-required',
      message: expect.stringContaining('disk full') as string,
    })
    expect(fixture.spies.markRecoveryRequired).toHaveBeenCalledWith(
      cwd, expect.stringContaining('checkpoint rollback failed') as string,
    )
    expect(fixture.spies.clearRecoveryRequired).not.toHaveBeenCalled()
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('fails without touching the workspace when the emergency checkpoint is not ready', async () => {
    const { run } = await seeded('edit-emergency-unready')
    const original = fixture.capture.getMockImplementation()
    fixture.capture.mockImplementationOnce(async (request) => {
      const record: CheckpointRecord = await original?.(request)
      const unready = { ...record, status: { kind: 'failed', reason: 'quota exceeded' } as never }
      fixture.records.set(String(record.id), unready)
      return unready
    })
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-unavailable',
      message: expect.stringContaining('quota exceeded') as string,
    })
    expect(fixture.restore).toHaveBeenCalledTimes(1)
    expect(fixture.restore).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: 'cp-2' }))
    expect(phases()).toContain('failed')
    expect(fixture.lease.release).toHaveBeenCalledOnce()
  })

  it('rolls back when the child workspace attachment fails', async () => {
    const { run, session } = await seeded('edit-attach-fails')
    const attachSession = vi.fn(() => Promise.reject(new Error('workspace closed')))
    fixture.workspaces.push({ id: 'ws-1', sessionIds: [session.id], attachSession } as unknown as Workspace)
    await expect(run()).rejects.toMatchObject({ code: 'checkpoint-unavailable' })
    expect(attachSession).toHaveBeenCalledOnce()
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
  })

  it('rolls back when the child Agent never attaches', async () => {
    const { run } = await seeded('edit-child-detached')
    fixture.childAgentFactory.attach = false
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-unavailable',
      message: expect.stringContaining('was not attached') as string,
    })
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
  })

  it('rolls back when the child initial checkpoint is not ready', async () => {
    const { run } = await seeded('edit-child-initial-unready')
    const original = fixture.capture.getMockImplementation()
    fixture.capture.mockImplementation(async (request) => {
      const record: CheckpointRecord = await original?.(request)
      return request.role === 'initial'
        ? { ...record, status: { kind: 'failed', reason: 'cannot snapshot child' } as never }
        : record
    })
    await expect(run()).rejects.toMatchObject({
      code: 'checkpoint-unavailable',
      message: expect.stringContaining('cannot snapshot child') as string,
    })
    expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-2')
  })
})
