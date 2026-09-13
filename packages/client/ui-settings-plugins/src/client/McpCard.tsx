/** The MCP fleet card: the settings-driven servers the model can call as tools. */

import { useState } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import type { McpCardFace, McpServerValidation } from './mcp-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './McpCard.module.css'

/** Props the renderer binds for the fleet card. */
export type McpCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<McpCardFace>

/** Local add-form state; the controller owns the staged fleet, not this text. */
interface McpAddForm {
  name: string
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  url: string
}

/** Initial add-form state. */
const EMPTY_FORM: McpAddForm = {
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  url: '',
}

/**
 * Render the fleet card.
 * @param props - locale copy, the card snapshot, and its staged actions.
 * @returns the card.
 */
export function McpCard(props: McpCardProps) {
  const { t } = props
  const state = props.useMcpCard(snapshot => snapshot)
  const [form, setForm] = useState<McpAddForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<McpServerValidation | undefined>(undefined)
  const disabled = !state.writable || state.saving
  const edit = (patch: Partial<McpAddForm>): void => {
    setForm(previous => ({ ...previous, ...patch }))
    setFormError(undefined)
  }
  const stage = (): void => {
    const failure = props.saveServer({
      name: form.name,
      transport: form.transport,
      enabled: true,
      command: form.command,
      argsText: form.argsText,
      url: form.url,
    })
    setFormError(failure)
    if (failure === undefined) setForm(EMPTY_FORM)
  }
  return (
    <PluginCard
      t={t}
      titleKey="mcpTitle"
      descriptionKey="mcpDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {state.conflicted ? <p className={css.conflict} role="status">{t('mcpConflict')}</p> : null}
      {state.servers.length === 0
        ? <p className={css.empty}>{t('mcpEmpty')}</p>
        : (
          <ul className={css.servers}>
            {state.servers.map(server => (
              <li key={server.name} className={css.server}>
                <div className={css.serverHead}>
                  <span className={css.serverName}>{server.name}</span>
                  {server.transport === 'unknown'
                    ? null
                    : (
                      <Tag tone="quiet">
                        {t(server.transport === 'stdio' ? 'mcpTransportStdio' : 'mcpTransportHttp')}
                      </Tag>
                    )}
                  <Switch
                    checked={server.enabled}
                    label={server.name}
                    disabled={disabled}
                    onChange={() => { props.toggleEnabled(server.name) }}
                  />
                </div>
                {server.detail.length > 0 ? <p className={css.detail}>{server.detail}</p> : null}
                <div className={css.serverFoot}>
                  <button
                    type="button"
                    className={css.remove}
                    disabled={disabled}
                    onClick={() => { props.removeServer(server.name) }}
                  >
                    {t('mcpRemove')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <div className={css.add}>
        <h3 className={css.addTitle}>{t('mcpAddTitle')}</h3>
        <div className={css.grid}>
          <div className={css.field}>
            <label className={css.label} htmlFor="plugin-config-mcp-name">{t('mcpName')}</label>
            <input
              id="plugin-config-mcp-name"
              className={css.control}
              type="text"
              value={form.name}
              disabled={disabled}
              placeholder="github"
              autoComplete="off"
              spellCheck={false}
              onChange={event => { edit({ name: event.target.value }) }}
            />
          </div>
          <div className={css.field}>
            <label className={css.label} htmlFor="plugin-config-mcp-transport">{t('mcpTransport')}</label>
            <select
              id="plugin-config-mcp-transport"
              className={css.control}
              value={form.transport}
              disabled={disabled}
              onChange={event => { edit({ transport: event.target.value as McpAddForm['transport'] }) }}
            >
              <option value="stdio">{t('mcpTransportStdio')}</option>
              <option value="streamable-http">{t('mcpTransportHttp')}</option>
            </select>
          </div>
          {form.transport === 'stdio'
            ? (
              <>
                <div className={`${css.field} ${css.span}`}>
                  <label className={css.label} htmlFor="plugin-config-mcp-command">{t('mcpCommand')}</label>
                  <input
                    id="plugin-config-mcp-command"
                    className={css.control}
                    type="text"
                    value={form.command}
                    disabled={disabled}
                    placeholder="npx"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => { edit({ command: event.target.value }) }}
                  />
                </div>
                <div className={`${css.field} ${css.span}`}>
                  <label className={css.label} htmlFor="plugin-config-mcp-args">{t('mcpArgs')}</label>
                  <textarea
                    id="plugin-config-mcp-args"
                    className={css.area}
                    value={form.argsText}
                    disabled={disabled}
                    placeholder={'-y\n@modelcontextprotocol/server-github'}
                    spellCheck={false}
                    onChange={event => { edit({ argsText: event.target.value }) }}
                  />
                </div>
              </>
            )
            : (
              <div className={`${css.field} ${css.span}`}>
                <label className={css.label} htmlFor="plugin-config-mcp-url">{t('mcpUrl')}</label>
                <input
                  id="plugin-config-mcp-url"
                  className={css.control}
                  type="text"
                  value={form.url}
                  disabled={disabled}
                  placeholder="http://localhost:3000/mcp"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={event => { edit({ url: event.target.value }) }}
                />
              </div>
            )}
        </div>
        {formError !== undefined
          ? (
            <p className={css.error} role="status">
              {t(formError === 'nameRequired'
                ? 'mcpNameRequired'
                : formError === 'nameInvalid'
                  ? 'mcpNameInvalid'
                  : formError === 'commandRequired'
                    ? 'mcpCommandRequired'
                    : formError === 'urlRequired'
                      ? 'mcpUrlRequired'
                      : 'mcpUrlInvalid')}
            </p>
          )
          : null}
        <div className={css.stageRow}>
          <button type="button" className={css.stage} disabled={disabled} onClick={stage}>
            {t('mcpAdd')}
          </button>
        </div>
        <p className={css.hint}>{t('mcpAdvancedHint')}</p>
      </div>
    </PluginCard>
  )
}
