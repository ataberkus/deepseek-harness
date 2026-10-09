/** OAuth sign-in tab preparation as wired by the Models section registration. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { remoteDefaultResponses } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses.ts'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'

async function mountedSection(): Promise<{ ctx: Context; injected: () => ModelsSectionInjected }> {
  const mock = RemoteMock.create().load(remoteDefaultResponses)
  onTestFinished(() => { mock.assertNoUnmatched() })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('locale', new LocaleRuntime(ctx))
  const remote = new TestRemote(ctx, {
    credentials: { describe: vi.fn(), set: vi.fn(), unset: vi.fn() },
    llm: {
      listProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      listConfigurableProviders: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      discoverModels: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
    },
    settings: mock.remote.settings,
  })
  remote.$host = { home: undefined, isLoopback: true }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
  await ctx.plugin({ inject: [...inject], apply }).await()
  const entry = slots.entries('settings.section')[0]!
  return { ctx, injected: entry.inject as unknown as () => ModelsSectionInjected }
}

describe('OAuth login tab preparation', () => {
  it('asks the command surface to open a login tab when sign-in starts', async () => {
    const { ctx, injected } = await mountedSection()
    const prepareOAuthLoginTab = vi.fn()
    ctx.provide('commandUi', { prepareOAuthLoginTab } as never)

    injected().prepareLoginTab()

    expect(prepareOAuthLoginTab).toHaveBeenCalledTimes(1)
  })

  it('still lets sign-in proceed in a composition without the command surface', async () => {
    const { injected } = await mountedSection()

    expect(() => { injected().prepareLoginTab() }).not.toThrow()
  })
})
