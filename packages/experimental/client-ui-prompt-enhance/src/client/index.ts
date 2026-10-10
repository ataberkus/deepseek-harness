/**
 * Browser half of prompt enhancement: the ✨ composer control and its
 * keyboard command. The Host route belongs to
 * `@deepseek-ai/dsh-experimental-prompt-enhance`, whose bundle loads both.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { EnhancePrompt, type EnhancePromptInjected, type EnhanceShortcutTarget } from './EnhancePrompt.tsx'
import { en, NS, zh } from './locales.ts'
import { requestEnhancement } from './request.ts'

export type { EnhancePromptInjected, EnhancePromptProps, EnhanceShortcutTarget } from './EnhancePrompt.tsx'
export type { PromptEnhanceKey } from './locales.ts'

/** Required services: slots, copy, and the shortcut registry. */
export const inject = ['slots', 'locale', 'shortcuts']

const COMMAND_ID = 'composer.enhancePrompt' as ShortcutCommandId

/**
 * Register dictionaries, the composer control, and its keyboard command.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prompt-enhance: dictionaries')
  const t = ctx.locale.bind(NS)
  const targets = new Set<EnhanceShortcutTarget>()
  const shortcutKeys = createSnapshotStore<readonly string[]>([])
  const publishKeys = (): void => {
    const keys = ctx.shortcuts.catalog.getSnapshot().find(entry => entry.id === COMMAND_ID)?.keys ?? []
    const current = shortcutKeys.getSnapshot()
    if (keys.length !== current.length || keys.some((key, index) => key !== current[index])) shortcutKeys.set(keys)
  }
  ctx.effect(() => ctx.shortcuts.register({
    id: COMMAND_ID,
    label: () => t('command'),
    aliases: ['enhance prompt', 'improve prompt', 'rewrite prompt'],
    defaults: {
      'desktop:macos': { code: 'KeyE', modifiers: ['primary', 'shift'] },
      'desktop:windows': { code: 'KeyE', modifiers: ['primary', 'shift'] },
      'desktop:linux': { code: 'KeyE', modifiers: ['primary', 'shift'] },
      'web:macos': { code: 'KeyE', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyE', modifiers: ['primary', 'shift'] },
    },
    regions: ['editable'],
    modals: [],
    resolve: (context) => {
      const focused = context.target
      const target = focused === null ? undefined : [...targets].find(candidate => candidate.contains(focused))
      if (target === undefined) return { status: 'pass' }
      if (!target.available()) return { status: 'blocked', reason: t('shortcut.unavailable') }
      return { status: 'handled', run: () => { target.toggle() } }
    },
  }), 'prompt-enhance: keyboard command')
  ctx.effect(() => {
    publishKeys()
    return ctx.shortcuts.catalog.subscribe(publishKeys)
  }, 'prompt-enhance: shortcut keys')
  const injected: EnhancePromptInjected = {
    enhance: (sessionId, text, signal) => requestEnhancement(sessionId, text, signal),
    bindShortcut: (target) => {
      targets.add(target)
      return () => { targets.delete(target) }
    },
    hooks: { enhanceShortcut: shortcutKeys },
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'prompt-enhance', order: 0, locale: NS, inject: () => injected,
  }, EnhancePrompt))
}
