// @vitest-environment jsdom

/**
 * The workspace checkpoint card as a user drives it: a real controller and
 * staged form over a scripted `workspace-checkpoint` settings scope.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { WorkspaceCheckpointCard, type WorkspaceCheckpointCardProps } from '../src/client/WorkspaceCheckpointCard.tsx'
import {
  WorkspaceCheckpointCardController,
  type WorkspaceCheckpointSettings,
} from '../src/client/workspace-checkpoint-card-controller.ts'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en) => en[key]

afterEach(cleanup)

type Host = StubSettingsScope<WorkspaceCheckpointSettings>

/** Host that accepts `set` and `unset` the way the Host document does. */
function hostWith(
  initial: { enabled?: boolean; base?: boolean; writable?: boolean; status?: 'ready' | 'loading' } = {},
): Host {
  const host = stubSettingsScope<WorkspaceCheckpointSettings>()
  const user = initial.enabled === undefined ? {} : { enabled: initial.enabled }
  const base = initial.base === undefined ? {} : { enabled: initial.base }
  host.publish({
    status: initial.status ?? 'ready',
    writable: initial.writable ?? true,
    value: { ...base, ...user },
    base,
    user,
  })
  let stored: WorkspaceCheckpointSettings = user
  host.set.mockImplementation((field: string, value: unknown) => {
    stored = { ...stored, [field]: value }
    host.publish({ value: { ...base, ...stored }, user: stored })
  })
  host.unset.mockImplementation(() => {
    stored = {}
    host.publish({ value: base, user: stored })
  })
  return host
}

function renderCard(host: Host) {
  const controller = new WorkspaceCheckpointCardController(host.scope)
  const face = controller.inject()
  const props = {
    ...face,
    t,
    useWorkspaceCheckpointCard: bindSnapshotSelector(face.hooks.workspaceCheckpointCard),
  } as unknown as WorkspaceCheckpointCardProps
  render(<ul><WorkspaceCheckpointCard {...props} /></ul>)
  const title = screen.queryByText(en.workspaceCheckpointTitle)
  if (title !== null) fireEvent.click(title)
  return face
}

const checkbox = () => screen.getByRole<HTMLInputElement>('checkbox', { name: en.workspaceCheckpointEnabled })

describe('WorkspaceCheckpointCard', () => {
  it('renders nothing while the namespace is not served', () => {
    renderCard(hostWith({ status: 'loading' }))

    expect(screen.queryByText(en.workspaceCheckpointTitle)).toBeNull()
  })

  it('shows the opt-in unchecked by default with its explanation', () => {
    renderCard(hostWith())

    expect(screen.getByText(en.workspaceCheckpointDescription)).toBeTruthy()
    expect(screen.getByText(en.workspaceCheckpointEnabledHint)).toBeTruthy()
    expect(checkbox().checked).toBe(false)
    expect(screen.queryByText(en.overridden)).toBeNull()
  })

  it('stages the toggle and writes true only when saved', async () => {
    const host = hostWith()
    renderCard(host)

    fireEvent.click(checkbox())

    expect(checkbox().checked).toBe(true)
    expect(screen.getByText(en.unsaved)).toBeTruthy()
    expect(screen.getByText(en.overridden)).toBeTruthy()
    expect(host.set).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await Promise.resolve() })

    expect(host.set.mock.calls).toEqual([['enabled', true]])
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('writes an explicit false over an inherited true', async () => {
    const host = hostWith({ base: true })
    renderCard(host)
    expect(checkbox().checked).toBe(true)

    fireEvent.click(checkbox())
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await Promise.resolve() })

    expect(host.set.mock.calls).toEqual([['enabled', false]])
  })

  it('resets a stored override back to the inherited value on save', async () => {
    const host = hostWith({ enabled: true, base: false })
    renderCard(host)
    expect(screen.getByText(en.overridden)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(checkbox().checked).toBe(false)
    expect(screen.queryByText(en.overridden)).toBeNull()
    expect(host.unset).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await Promise.resolve() })

    expect(host.unset.mock.calls).toEqual([['enabled']])
  })

  it('discards a staged toggle', () => {
    const host = hostWith()
    renderCard(host)

    fireEvent.click(checkbox())
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(checkbox().checked).toBe(false)
    expect(screen.queryByText(en.unsaved)).toBeNull()
    expect(host.set).not.toHaveBeenCalled()
  })

  it('disables the checkbox and reset for a read-only deployment', () => {
    renderCard(hostWith({ enabled: true, writable: false }))

    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(checkbox().disabled).toBe(true)
    expect(screen.getByRole('button', { name: en.reset })).toHaveProperty('disabled', true)
  })

  it('reports a save the Host did not take and keeps the draft', async () => {
    const host = hostWith()
    host.set.mockImplementation(() => {})
    renderCard(host)

    fireEvent.click(checkbox())
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(checkbox().checked).toBe(true)
  })

  describe('boolean drafts', () => {
    it('blank means inherit: saving clears a stored override', async () => {
      const host = hostWith({ enabled: true })
      const face = renderCard(host)

      act(() => { face.edit('enabled', '  ') })
      expect(checkbox().checked).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: en.save }))
      await act(async () => { await Promise.resolve() })

      expect(host.unset.mock.calls).toEqual([['enabled']])
    })

    it('accepts true and false case-insensitively', async () => {
      const host = hostWith()
      const face = renderCard(host)

      act(() => { face.edit('enabled', ' TRUE ') })
      expect(checkbox().checked).toBe(true)
      act(() => { face.edit('enabled', 'False') })
      expect(checkbox().checked).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: en.save }))
      await act(async () => { await Promise.resolve() })

      expect(host.set.mock.calls).toEqual([['enabled', false]])
    })

    it('flags any other text, explains it, and blocks the save', async () => {
      const host = hostWith()
      const face = renderCard(host)

      act(() => { face.edit('enabled', 'maybe') })

      expect(screen.getByText(en.invalidBoolean)).toBeTruthy()
      expect(screen.queryByText(en.workspaceCheckpointEnabledHint)).toBeNull()
      expect(checkbox().getAttribute('aria-invalid')).toBe('true')
      expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
      face.save()
      await act(async () => { await Promise.resolve() })
      expect(host.set).not.toHaveBeenCalled()
    })
  })
})
