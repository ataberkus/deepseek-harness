/** The MCP fleet card: the settings-driven servers the model can call as tools. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import type { McpCardFace, McpServerValidation } from './mcp-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './PluginsSettingsSection.module.css'

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
  const disabled = !state.writable
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
      {state.conflicted ? <p role="status">{t('mcpConflict')}</p> : null}
      {state.servers.length === 0
        ? <p>{t('mcpEmpty')}</p>
        : (
          <ul>
            {state.servers.map(server => (
              <li key={server.name}>
                <span>{server.name}</span>
                {' '}
                <span>{server.transport === 'unknown' ? server.transport : t(server.transport === 'stdio' ? 'mcpTransportStdio' : 'mcpTransportHttp')}</span>
                {' '}
                <span>{server.detail}</span>
                {' '}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => { props.toggleEnabled(server.name) }}
                >
                  {t(server.enabled ? 'mcpDisable' : 'mcpEnable')}
                </button>
                {' '}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => { props.removeServer(server.name) }}
                >
                  {t('mcpRemove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      <div className={css.panel}>
        <h3>{t('mcpAddTitle')}</h3>
        <label>
          {t('mcpName')}
          <input
            type="text"
            value={form.name}
            disabled={disabled}
            placeholder="github"
            onChange={(event) => { edit({ name: event.target.value }) }}
          />
        </label>
        <label>
          {t('mcpTransport')}
          <select
            value={form.transport}
            disabled={disabled}
            onChange={(event) => { edit({ transport: event.target.value as McpAddForm['transport'] }) }}
          >
            <option value="stdio">{t('mcpTransportStdio')}</option>
            <option value="streamable-http">{t('mcpTransportHttp')}</option>
          </select>
        </label>
        {form.transport === 'stdio'
          ? (
            <>
              <label>
                {t('mcpCommand')}
                <input
                  type="text"
                  value={form.command}
                  disabled={disabled}
                  placeholder="npx"
                  onChange={(event) => { edit({ command: event.target.value }) }}
                />
              </label>
              <label>
                {t('mcpArgs')}
                <textarea
                  value={form.argsText}
                  disabled={disabled}
                  placeholder="-y&#10;@modelcontextprotocol/server-github"
                  onChange={(event) => { edit({ argsText: event.target.value }) }}
                />
              </label>
            </>
          )
          : (
            <label>
              {t('mcpUrl')}
              <input
                type="text"
                value={form.url}
                disabled={disabled}
                placeholder="http://localhost:3000/mcp"
                onChange={(event) => { edit({ url: event.target.value }) }}
              />
            </label>
          )}
        {formError !== undefined
          ? (
            <p role="status">
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
        <button type="button" disabled={disabled} onClick={stage}>
          {t('mcpAdd')}
        </button>
        <p>{t('mcpAdvancedHint')}</p>
      </div>
    </PluginCard>
  )
}
