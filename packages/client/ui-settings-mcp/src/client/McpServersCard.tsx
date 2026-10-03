/**
 * The MCP fleet's settings page: the servers the `mcp-manager` entry mounts,
 * plus the form that stages one server into the draft.
 */

import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Checkbox, Input, SegmentedControl, SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type {
  McpServerValidation, McpServerView, McpServersCardFace, McpTransport,
} from './mcp-servers-card-controller.ts'
import css from './McpServersCard.module.css'

/** Props the renderer binds for the MCP fleet page. */
export type McpServersCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpServersCardFace>

/** What the add form holds; `previousName` names the row it renames. */
interface ServerForm {
  name: string
  previousName: string | undefined
  transport: McpTransport
  command: string
  argsText: string
  url: string
  enabled: boolean
}

/** The form a page load starts from. */
const EMPTY_FORM: ServerForm = {
  name: '', previousName: undefined, transport: 'stdio', command: '', argsText: '', url: '', enabled: true,
}

/** Base id of the transport tablist; its panels are `<base>-<value>-panel`. */
const TRANSPORT_ID = 'plugin-config-mcp-transport'

/**
 * Render the MCP fleet's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the page snapshot, and its actions.
 * @returns the one-liner, or the fleet form.
 */
export function McpServersCard(props: McpServersCardProps) {
  const { t } = props
  const state = props.useMcpServersCard(snapshot => snapshot)
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM)
  const [failure, setFailure] = useState<McpServerValidation | undefined>(undefined)
  if (props.view === 'summary') {
    return state.servers.length === 0 ? t('summaryEmpty') : t('summaryCount', { count: state.servers.length })
  }
  const disabled = !state.writable || state.saving
  const editing = form.previousName
  const edit = (server: McpServerView): void => {
    setFailure(undefined)
    setForm({
      name: server.name,
      previousName: server.name,
      transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      command: server.command,
      argsText: server.argsText,
      url: server.url,
      enabled: server.enabled,
    })
  }
  const submit = (): void => {
    const result = props.saveServer({
      name: form.name,
      ...(form.previousName === undefined ? {} : { previousName: form.previousName }),
      transport: form.transport,
      enabled: form.enabled,
      command: form.command,
      argsText: form.argsText,
      url: form.url,
    })
    setFailure(result)
    if (result === undefined) setForm(EMPTY_FORM)
  }
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {state.conflicted ? <p className={css.notice} role="status">{t('conflicted')}</p> : null}
      <h4 className={css.heading}>{t('servers')}</h4>
      {state.servers.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : (
          <ul className={css.rows}>
            {state.servers.map(server => (
              <li key={server.name} className={css.row}>
                <Checkbox
                  checked={server.enabled}
                  disabled={disabled}
                  label={server.name}
                  onChange={() => { props.toggleEnabled(server.name) }}
                />
                <span className={css.transport}>
                  {server.transport === 'stdio' ? t('transportStdio') : server.transport === 'streamable-http' ? t('transportHttp') : '?'}
                </span>
                <span className={css.detail}>{server.detail}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={t('edit', { name: server.name })}
                  onClick={() => { edit(server) }}
                >
                  {t('editAction')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={t('remove', { name: server.name })}
                  onClick={() => { props.removeServer(server.name) }}
                >
                  {t('removeAction')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      <form
        className={css.form}
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <h4 className={css.heading}>{editing === undefined ? t('addTitle') : t('updateTitle', { name: editing })}</h4>
        <div className={css.field}>
          <label htmlFor="plugin-config-mcp-name">{t('name')}</label>
          <Input
            id="plugin-config-mcp-name"
            value={form.name}
            disabled={disabled}
            aria-describedby="plugin-config-mcp-name-hint"
            onChange={(event) => { setForm({ ...form, name: event.target.value }) }}
          />
          <p id="plugin-config-mcp-name-hint" className={css.hint}>{t('nameHint')}</p>
        </div>
        <SegmentedControl
          id={TRANSPORT_ID}
          label={t('transport')}
          value={form.transport}
          disabled={disabled}
          options={[
            { value: 'stdio', label: t('transportStdio') },
            { value: 'streamable-http', label: t('transportHttp') },
          ]}
          onChange={(next) => { setForm({ ...form, transport: next }) }}
        />
        {form.transport === 'stdio'
          ? (
            <div
              id={`${TRANSPORT_ID}-stdio-panel`}
              role="tabpanel"
              aria-labelledby={`${TRANSPORT_ID}-stdio`}
              className={css.field}
            >
              <label htmlFor="plugin-config-mcp-command">{t('command')}</label>
              <Input
                id="plugin-config-mcp-command"
                value={form.command}
                disabled={disabled}
                onChange={(event) => { setForm({ ...form, command: event.target.value }) }}
              />
              <p className={css.hint}>{t('commandHint')}</p>
              <label htmlFor="plugin-config-mcp-args">{t('args')}</label>
              <textarea
                id="plugin-config-mcp-args"
                className={css.args}
                value={form.argsText}
                disabled={disabled}
                onChange={(event) => { setForm({ ...form, argsText: event.target.value }) }}
              />
              <p className={css.hint}>{t('argsHint')}</p>
            </div>
          )
          : (
            <div
              id={`${TRANSPORT_ID}-streamable-http-panel`}
              role="tabpanel"
              aria-labelledby={`${TRANSPORT_ID}-streamable-http`}
              className={css.field}
            >
              <label htmlFor="plugin-config-mcp-url">{t('url')}</label>
              <Input
                id="plugin-config-mcp-url"
                value={form.url}
                disabled={disabled}
                onChange={(event) => { setForm({ ...form, url: event.target.value }) }}
              />
              <p className={css.hint}>{t('urlHint')}</p>
            </div>
          )}
        <Checkbox
          checked={form.enabled}
          disabled={disabled}
          label={t('enabled')}
          onChange={(next) => { setForm({ ...form, enabled: next }) }}
        />
        {failure === undefined ? null : <p className={css.error} role="status">{t(failure)}</p>}
        <div className={css.actions}>
          <Button type="submit" size="sm" variant="primary" disabled={disabled}>
            {editing === undefined ? t('add') : t('update')}
          </Button>
          {editing === undefined ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => { setFailure(undefined); setForm(EMPTY_FORM) }}
            >
              {t('cancel')}
            </Button>
          )}
        </div>
      </form>
    </SettingsForm>
  )
}
