// @vitest-environment jsdom
/** The composer control replaces the draft, offers Undo, cancels, and reports failures. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { EnhancePrompt, type EnhancePromptProps, type EnhanceShortcutTarget } from '../src/client/EnhancePrompt.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

function fixture(draft: string, enhance: EnhancePromptProps['enhance']) {
  const input = createSnapshotStore({ draft, phase: 'plain' as const })
  const inputActions = {
    captureInsertion: vi.fn(), insertText: vi.fn(() => true), persistDraft: vi.fn(),
    setDraft: vi.fn((text: string) => { input.set({ ...input.getSnapshot(), draft: text }) }),
    addAttachments: vi.fn(() => true), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit: vi.fn(),
  }
  const targets: EnhanceShortcutTarget[] = []
  // The fixture stores carry only the fields the control reads.
  const props = {
    sessionId: 'session-1' as EnhancePromptProps['sessionId'], inputActions, enhance,
    useInput: bindSnapshotSelector(input) as never, useSession: bindSnapshotSelector(createSnapshotStore({ removed: false })) as never,
    useEnhanceShortcut: bindSnapshotSelector(createSnapshotStore<readonly string[]>(['Ctrl', '+', 'Shift', '+', 'E'])),
    bindShortcut: (target: EnhanceShortcutTarget) => { targets.push(target); return () => {} },
    t: makeTranslate(zh, commonZh),
  } satisfies EnhancePromptProps
  render(<div data-composer-card><EnhancePrompt {...props} /></div>)
  return { input, inputActions, targets }
}

it('replaces the draft with the rewrite and restores it through Undo', async () => {
  const enhance = vi.fn(async () => 'Rewritten')
  const b = fixture('fix it', enhance)
  fireEvent.click(screen.getByRole('button', { name: zh.enhance }))
  await waitFor(() => { expect(b.inputActions.setDraft).toHaveBeenCalledWith('Rewritten') })
  expect(enhance).toHaveBeenCalledWith('session-1', 'fix it', expect.any(AbortSignal))
  expect(b.inputActions.persistDraft).toHaveBeenCalled()
  expect(b.inputActions.submit).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: zh.undo }))
  expect(b.inputActions.setDraft).toHaveBeenLastCalledWith('fix it')
})

it('cancels a running rewrite without touching the draft', async () => {
  let signal: AbortSignal | undefined
  const b = fixture('fix it', (_session, _text, aborted) => {
    signal = aborted
    return new Promise((_resolve, reject) => { aborted.addEventListener('abort', () => { reject(new Error('aborted')) }) })
  })
  fireEvent.click(screen.getByRole('button', { name: zh.enhance }))
  fireEvent.click(await screen.findByRole('button', { name: zh.cancel }))
  expect(signal?.aborted).toBe(true)
  await screen.findByRole('button', { name: zh.enhance })
  expect(b.inputActions.setDraft).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the Host failure and keeps the draft', async () => {
  const b = fixture('fix it', async () => { throw new Error('no key') })
  fireEvent.click(screen.getByRole('button', { name: zh.enhance }))
  expect((await screen.findByRole('alert')).textContent).toContain('no key')
  expect(b.inputActions.setDraft).not.toHaveBeenCalled()
})

it.each(['', '   ', '/compact', '!ls'])('disables the control for %j', (draft) => {
  fixture(draft, vi.fn())
  expect((screen.getByRole('button', { name: zh.enhance }) as HTMLButtonElement).disabled).toBe(true)
})

it('exposes a shortcut target scoped to its composer card', async () => {
  const enhance = vi.fn(async () => 'Rewritten')
  const b = fixture('fix it', enhance)
  const [target] = b.targets
  expect(target!.contains(screen.getByRole('button', { name: zh.enhance }))).toBe(true)
  expect(target!.contains(document.body)).toBe(false)
  expect(target!.available()).toBe(true)
  act(() => { target!.toggle() })
  await waitFor(() => { expect(enhance).toHaveBeenCalled() })
})
