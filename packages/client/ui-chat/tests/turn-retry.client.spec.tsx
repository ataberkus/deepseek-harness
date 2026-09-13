// @vitest-environment jsdom
/** Same-branch retry on terminal turn failures: button visibility, dispatch, and error display. */
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { CheckpointSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TurnErrorNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => {
  cleanup()
})

const SID = 's1' as SessionId
const t = makeTranslate(zh, commonZh)

function checkpointRow(id: string, boundarySeq: number): CheckpointSnapshot['checkpoints'][number] {
  return {
    id: id as never,
    sessionId: SID as never,
    boundarySeq,
    labelIndex: 0,
    role: 'turn',
    status: { kind: 'ready' },
    restoreEligible: true,
    fileCount: 1,
    createdAt: 1,
  }
}

function sessionState(over: Record<string, unknown> = {}) {
  return {
    sessionId: SID,
    queue: [],
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open' as const,
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
    checkpoints: {
      enabled: true,
      checkpoints: [checkpointRow('cp-0', -1), checkpointRow('cp-1', 5)],
    } satisfies CheckpointSnapshot,
    ...over,
  }
}

function inputState() {
  return {
    draft: '',
    attachmentIds: [],
    draftRev: 0,
    phase: 'plain' as const,
    occurrences: [],
    queue: [],
  }
}

function turnErrorNode(chat: ReturnType<typeof chatSnapshotFixture>): ChatNode<'turn-error'> {
  const node = chat.nodes.values().find(candidate => candidate.kind === 'turn-error')
  if (node === undefined) throw new Error('fixture has no turn-error node')
  return node as ChatNode<'turn-error'>
}

function renderTurnError(options: {
  readonly chat: ReturnType<typeof chatSnapshotFixture>
  readonly session?: Record<string, unknown>
  readonly input?: Record<string, unknown>
  readonly retryTurn?: ReturnType<typeof vi.fn>
}) {
  const sessionHook = bindSnapshotSelector(createSnapshotStore(sessionState(options.session)))
  const chatHook = bindSnapshotSelector(createSnapshotStore(options.chat))
  const inputHook = bindSnapshotSelector(createSnapshotStore({ ...inputState(), ...options.input }))
  const retryTurn = options.retryTurn
  const view = render(
    <TurnErrorNodeView
      {...{
        node: turnErrorNode(options.chat),
        t,
        sessionId: SID,
        useSession: sessionHook,
        useChat: chatHook,
        useInput: inputHook,
        ...(retryTurn === undefined ? {} : { retryTurn }),
      } as never}
    />,
  )
  return view
}

describe('turn-error retry', () => {
  it('shows Retry on the latest failed turn and dispatches its pre-turn checkpoint', async () => {
    const chat = chatSnapshotFixture({
      nodes: [
        { kind: 'user', seq: 10, time: 10_000, content: [{ type: 'text', text: 'try' }], source: null, turn: 1 } as never,
        { kind: 'turn-error', seq: 20, time: 20_000, turn: 1, step: 0, message: 'boom' } as never,
      ],
      turnTimings: new Map([[1, { startTime: 1, endTime: 2 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const retryTurn = vi.fn(async () => ({ ok: true, value: { accepted: true } }) as never)
    const view = renderTurnError({ chat, retryTurn })
    const button = view.getByRole('button', { name: '重试' })
    expect(button).toBeDefined()
    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => {
      expect(retryTurn).toHaveBeenCalledWith(10, 'cp-1')
    })
  })

  it('hides Retry without an eligible checkpoint', () => {
    const chat = chatSnapshotFixture({
      nodes: [
        { kind: 'user', seq: 10, time: 10_000, content: [{ type: 'text', text: 'try' }], source: null, turn: 1 } as never,
        { kind: 'turn-error', seq: 20, time: 20_000, turn: 1, step: 0, message: 'boom' } as never,
      ],
      turnTimings: new Map([[1, { startTime: 1, endTime: 2 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const retryTurn = vi.fn(async () => ({ ok: true, value: { accepted: true } }) as never)
    const view = renderTurnError({
      chat,
      retryTurn,
      session: {
        checkpoints: { enabled: false, checkpoints: [] } satisfies CheckpointSnapshot,
      },
    })
    expect(view.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('hides Retry on an older failed turn and while the session runs', () => {
    const chat = chatSnapshotFixture({
      nodes: [
        { kind: 'user', seq: 10, time: 10_000, content: [{ type: 'text', text: 'try' }], source: null, turn: 1 } as never,
        { kind: 'turn-error', seq: 20, time: 20_000, turn: 1, step: 0, message: 'boom' } as never,
        { kind: 'user', seq: 30, time: 30_000, content: [{ type: 'text', text: 'next' }], source: null, turn: 2 } as never,
      ],
      turnTimings: new Map([[1, { startTime: 1, endTime: 2 }], [2, { startTime: 3 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const retryTurn = vi.fn(async () => ({ ok: true, value: { accepted: true } }) as never)
    const older = renderTurnError({ chat, retryTurn })
    expect(older.queryByRole('button', { name: '重试' })).toBeNull()
    older.unmount()
    const running = renderTurnError({ chat, retryTurn, session: { running: true } })
    expect(running.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('surfaces a rejected retry without losing the failure row', async () => {
    const chat = chatSnapshotFixture({
      nodes: [
        { kind: 'user', seq: 10, time: 10_000, content: [{ type: 'text', text: 'try' }], source: null, turn: 1 } as never,
        { kind: 'turn-error', seq: 20, time: 20_000, turn: 1, step: 0, message: 'boom' } as never,
      ],
      turnTimings: new Map([[1, { startTime: 1, endTime: 2 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const retryTurn = vi.fn(async () => ({ ok: false, error: { message: 'still down', code: 'SERVER' } }) as never)
    const view = renderTurnError({ chat, retryTurn })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: '重试' }))
    })
    await waitFor(() => {
      expect(view.getByRole('alert').textContent).toBe('still down (SERVER)')
    })
    expect(view.getByRole('status').textContent).toContain('本轮运行失败')
  })

  it('hides Retry while the composer edits another message', () => {
    const chat = chatSnapshotFixture({
      nodes: [
        { kind: 'user', seq: 10, time: 10_000, content: [{ type: 'text', text: 'try' }], source: null, turn: 1 } as never,
        { kind: 'turn-error', seq: 20, time: 20_000, turn: 1, step: 0, message: 'boom' } as never,
      ],
      turnTimings: new Map([[1, { startTime: 1, endTime: 2 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const retryTurn = vi.fn(async () => ({ ok: true, value: { accepted: true } }) as never)
    const view = renderTurnError({
      chat,
      retryTurn,
      input: { edit: { messageSeq: 10, checkpointId: 'cp-1', originalText: 'try' } },
    })
    expect(view.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('labels the control while a retry is in flight', async () => {
    const chat = chatSnapshotFixture({
      nodes: [
        { kind: 'user', seq: 10, time: 10_000, content: [{ type: 'text', text: 'try' }], source: null, turn: 1 } as never,
        { kind: 'turn-error', seq: 20, time: 20_000, turn: 1, step: 0, message: 'boom' } as never,
      ],
      turnTimings: new Map([[1, { startTime: 1, endTime: 2 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    let resolveRetry!: (value: never) => void
    const pending = new Promise<never>((resolve) => {
      resolveRetry = resolve
    })
    const retryTurn = vi.fn(() => pending)
    const view = renderTurnError({ chat, retryTurn })
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: '重试' }))
    })
    const busy = view.getByRole('button', { name: '正在重试…' })
    expect(busy).toHaveProperty('disabled', true)
    await act(async () => {
      resolveRetry({ ok: true, value: { accepted: true } } as never)
      await pending.catch(() => undefined)
    })
    await waitFor(() => {
      expect(view.getByRole('button', { name: '重试' })).toBeDefined()
    })
  })
})
