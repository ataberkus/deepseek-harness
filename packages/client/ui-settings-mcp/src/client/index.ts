/**
 * The MCP fleet's settings page, browser half: the servers the `mcp-manager`
 * entry mounts. The page registers into the Plugins page's `plugins.item` slot
 * while the Host serves that entry's form, so a deployment that mounts no MCP
 * manager shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { McpServersCard } from './McpServersCard.tsx'
import { MCP_MANAGER_ENTRY, McpServersCardController } from './mcp-servers-card-controller.ts'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'

export type { McpServersCardProps } from './McpServersCard.tsx'
export type {
  McpFleetSettings, McpServerDraft, McpServerEntry, McpServerValidation, McpServerView,
  McpServersCardFace, McpServersCardState, McpTransport,
} from './mcp-servers-card-controller.ts'
export type { McpSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP fleet settings page copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the MCP fleet's settings page while the Host serves the entry's form.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')
  const card = new McpServersCardController(ctx.configForms.get(MCP_MANAGER_ENTRY))
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-mcp: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([MCP_MANAGER_ENTRY], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'mcp', order: 50, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, McpServersCard))), 'ui-settings-mcp: page')
}
