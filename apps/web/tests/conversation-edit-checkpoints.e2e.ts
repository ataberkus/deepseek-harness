// Keyless assembled Web coverage for conversation edit checkpoints. The source
// transcript is cold-seeded, while the real Host provider captures the boundary,
// restores the workspace, publishes the child, and runs its replacement turn
// through a positional replay child fixture.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint/types'
import type {} from '@deepseek-ai/dsh-workspace-checkpoint/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/conversation-edit-checkpoints', import.meta.url))
const CHECKPOINT_OVERLAY = fileURLToPath(new URL('./conversation-edit-checkpoints.overlay.yml', import.meta.url))
const REPLAY_FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const REPLAY_CHILD_FIXTURE = join(SNAPSHOT_DIR, 'child.jsonl')
const SOURCE_FIXTURE = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const EDITING_EXPECTED = join(SNAPSHOT_DIR, 'editing.expected.md')
const RECOVERY_EXPECTED = join(SNAPSHOT_DIR, 'recovery.expected.md')
const SOURCE_ID = 'conversation-edit-source-web-e2e'
const ORIGINAL_TEXT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
const REPLACEMENT_TEXT = 'Read the restored workspace state and reply with EDIT_CHECKPOINT_OK.'
const SECOND_REPLACEMENT_TEXT = 'Read the restored workspace state again and reply with EDIT_CHECKPOINT_OK.'
const RECOVERY_REASON = 'browser checkpoint recovery fixture'

describe.skipIf(MODE === 'record')('web e2e: conversation edit checkpoints', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sessionCwd: string
  let tripwire: ReturnType<typeof watchConsole>
  let childId: SessionId | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: CHECKPOINT_OVERLAY,
      replayFixture: REPLAY_FIXTURE,
      replayChildFixtures: [REPLAY_CHILD_FIXTURE, REPLAY_CHILD_FIXTURE],
      paceMs: 12,
    })
    // Seed into the Host workspace path. A subdirectory cwd leaves the
    // session listed, but resume refuses the cwd conflict and never attaches.
    sessionCwd = scaffold.workspaceCwd
    await writeFile(join(sessionCwd, 'state.txt'), 'before-edit\n', 'utf8')
    await seedSession(scaffold, await readFile(SOURCE_FIXTURE, 'utf8'), SOURCE_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 30_000 })
    await groupRow.click()
    const sourceRow = page.locator('[role="treeitem"]').nth(1)
    await sourceRow.waitFor({ timeout: 30_000 })
    await sourceRow.click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })

    await vi.waitFor(() => {
      if (scaffold.ctx.agents.get(SessionId(SOURCE_ID)) === undefined) {
        throw new Error('seeded source Agent did not open')
      }
    }, { timeout: 15_000 })
    const sourceSession = scaffold.ctx.agents.get(SessionId(SOURCE_ID))
    if (sourceSession === undefined) throw new Error('seeded source Agent did not open')
    expect(sourceSession.session.header.cwd).toBe(sessionCwd)
    const checkpoint = await scaffold.ctx.workspaceCheckpoint.capture({
      sessionId: sourceSession.id,
      cwd: sessionCwd,
      boundarySeq: sourceSession.session.snapshotEvents()
        .findLast(event => event.type === 'turn/end')?.seq ?? -1,
      role: 'initial',
      turnOutcome: 'initial',
    })
    expect(checkpoint.status.kind, JSON.stringify(checkpoint.status)).toBe('ready')
    expect(checkpoint.restoreEligible).toBe(true)

    const sourceTurn = scaffold.whenTurnSettled()
    const input = page.getByRole('textbox', { name: 'Message the agent' })
    await input.fill(ORIGINAL_TEXT)
    await input.press('Enter')
    expect(await sourceTurn).toBe(SessionId(SOURCE_ID))
    expect(sourceSession.session.snapshotEvents().some(event =>
      event.type === 'assistant/chunk'
      && event.data.chunk.type === 'text-delta'
      && event.data.chunk.text === 'EDIT_SOURCE_OK',
    )).toBe(true)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('enters edit mode with the original draft and renders its banner', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-edit-banner'))
    const editButton = page.getByRole('button', { name: 'Edit and rerun' }).last()
    await editButton.waitFor({ timeout: 15_000 })
    await editButton.click()
    expect(await page.getByText('Editing this message', { exact: true }).isVisible()).toBe(true)
    const input = page.getByRole('textbox', { name: 'Message the agent' })
    expect(await input.inputValue()).toBe(ORIGINAL_TEXT)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', sessionCwd)
    await compareOrRefreshGolden(EDITING_EXPECTED, snapshot, MODE)
  })

  it('restores the selected tree, publishes the child label, and reports recovery', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-conversation-edit-branch'))
    const input = page.locator('textarea').first()
    expect(await page.getByText('Editing this message', { exact: true }).count()).toBe(1)
    const editRequest = page.waitForRequest(request =>
      request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/'),
    { timeout: 10_000 })
    await input.fill(REPLACEMENT_TEXT)
    const send = page.getByRole('button', { name: 'Send message' })
    expect(await send.isDisabled()).toBe(false)
    await send.click()
    const request = await editRequest
    expect(new URL(request.url()).pathname).toBe('/api/session.edit')
    const response = await request.response()
    if (response === null) {
      throw new Error(`session.edit request ended without a response: ${request.failure()?.errorText ?? 'unknown failure'}`)
    }
    const editReceipt = await response.json() as {
      result:
        | { ok: true; value: { sessionId: string } }
        | { ok: false; error: { code: string; message: string } }
    }
    if (!editReceipt.result.ok) {
      const payload = request.postDataJSON() as { payload?: { checkpointId?: string; messageSeq?: number } }
      const selected = payload.payload?.checkpointId === undefined
        ? undefined
        : await scaffold.ctx.workspaceCheckpoint.inspect(CheckpointId(payload.payload.checkpointId))
      throw new Error(JSON.stringify({
        result: editReceipt.result,
        selectedBoundary: selected?.boundarySeq,
        messageSeq: payload.payload?.messageSeq,
        sourceTail: scaffold.ctx.agents.get(SessionId(SOURCE_ID))?.session.snapshotEvents()
          .filter(event => event.type === 'turn/end').map(event => event.seq),
      }))
    }
    childId = SessionId(editReceipt.result.value.sessionId)
    expect(childId).not.toBe(SessionId(SOURCE_ID))
    await expect.poll(
      () => scaffold.ctx.agents.get(childId!)?.session.snapshotEvents().some(event => event.type === 'turn/end') ?? false,
      { timeout: 30_000 },
    ).toBe(true)
    const childAgent = scaffold.ctx.agents.get(childId)
    if (childAgent === undefined) throw new Error(`child agent ${String(childId)} was not published`)
    await scaffold.ctx.sessions.flush(childAgent.session)
    await expect.poll(
      async () => await readFile(join(sessionCwd, 'state.txt'), 'utf8'),
      { timeout: 15_000 },
    ).toBe('before-edit\n')

    const sourceIndex = scaffold.ctx.workspaceCheckpoint.sessionIndex(SessionId(SOURCE_ID))
    const childIndex = scaffold.ctx.workspaceCheckpoint.sessionIndex(childId)
    expect(sourceIndex?.edit?.childSessionId).toBe(String(childId))
    expect(childIndex?.edit?.sourceSessionId).toBe(SOURCE_ID)
    expect(childIndex?.edit?.childSessionId).toBe(String(childId))

    const selectedCheckpointId = sourceIndex?.edit?.selectedCheckpointId
    if (selectedCheckpointId === undefined) throw new Error('edit did not persist a selected checkpoint')
    const selectedCheckpoint = await scaffold.ctx.workspaceCheckpoint.inspect(CheckpointId(selectedCheckpointId))
    await expect.poll(
      () => page.getByText(`Checkpoint ${String(selectedCheckpoint.labelIndex)}`, { exact: true }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThan(0)
    await expect.poll(() => page.getByText(REPLACEMENT_TEXT, { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    await expect.poll(() => page.getByText('EDIT_CHILD_OK', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThan(0)

    // A replacement turn must retain the same edit affordance so a user can
    // revise the child repeatedly, not only the original source message.
    const secondEditButton = page.getByRole('button', { name: 'Edit and rerun' }).last()
    await secondEditButton.waitFor({ timeout: 15_000 })
    await secondEditButton.click()
    const secondInput = page.getByRole('textbox', { name: 'Message the agent' })
    expect(await secondInput.inputValue()).toBe(REPLACEMENT_TEXT)
    const secondEditRequest = page.waitForRequest(request =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/session.edit',
    { timeout: 10_000 })
    await secondInput.fill(SECOND_REPLACEMENT_TEXT)
    await page.getByRole('button', { name: 'Send message' }).click()
    const secondRequest = await secondEditRequest
    const secondResponse = await secondRequest.response()
    if (secondResponse === null) {
      throw new Error(`second session.edit request ended without a response: ${secondRequest.failure()?.errorText ?? 'unknown failure'}`)
    }
    const secondReceipt = await secondResponse.json() as {
      result:
        | { ok: true; value: { sessionId: string } }
        | { ok: false; error: { code: string; message: string } }
    }
    expect(secondReceipt.result.ok, JSON.stringify(secondReceipt)).toBe(true)
    if (!secondReceipt.result.ok) return
    const grandchildId = SessionId(secondReceipt.result.value.sessionId)
    await expect.poll(
      () => scaffold.ctx.agents.get(grandchildId)?.session.snapshotEvents().some(event => event.type === 'turn/end') ?? false,
      { timeout: 30_000 },
    ).toBe(true)
    await expect.poll(() => page.getByText(SECOND_REPLACEMENT_TEXT, { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    await expect.poll(() => page.getByRole('button', { name: 'Edit and rerun' }).count(), { timeout: 15_000 })
      .toBeGreaterThan(0)

    await scaffold.ctx.workspaceCheckpoint.markRecoveryRequired(sessionCwd, RECOVERY_REASON)
    expect(await page.getByText('Conversation is readable, but workspace files cannot be restored', { exact: true }).first()
      .isVisible()).toBe(true)
    expect(await input.isDisabled()).toBe(true)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', sessionCwd)
    await compareOrRefreshGolden(RECOVERY_EXPECTED, snapshot, MODE)
  }, 90_000)

  it('keeps the assembled surface clean and owns only its goldens', async () => {
    expect(childId).toBeDefined()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.jsonl',
      'child.jsonl',
      'editing.expected.md',
      'recovery.expected.md',
    ])
  })
})
