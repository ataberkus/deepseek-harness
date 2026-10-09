// @vitest-environment jsdom
/** Adapter setup defaults seeding a provider card, and what Apply then writes. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    api: Schema.string(),
  })),
})

function namespaceWith(effective: JsonValue | undefined): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers: effective === undefined ? {} : { acme: effective } },
    user: { providers: {} },
    applies: 'live',
    secrets: [],
    revision: 2,
  }
}

function operationsFor(namespace: SettingsNamespaceView) {
  const writeSettings = vi.fn(() => Promise.resolve({ kind: 'written' as const, view: namespace }))
  const operations: ModelsOperations = {
    describeCredential: vi.fn(() => Promise.resolve(undefined)),
    storeCredential: vi.fn(() => Promise.resolve(undefined)),
    removeCredential: vi.fn(() => Promise.resolve(undefined)),
    writeSettings,
    discoverModels: vi.fn(() => Promise.resolve({ kind: 'found' as const, models: [] })),
    loginOAuth: vi.fn(() => Promise.resolve(undefined)),
    loginApiKey: vi.fn(() => Promise.resolve(undefined)),
  }
  return { operations, writeSettings }
}

function mountEditor(namespace: SettingsNamespaceView) {
  const { operations, writeSettings } = operationsFor(namespace)
  const onClose = vi.fn()
  render(
    <ProviderEditor
      provider="acme"
      displayName="acme"
      namespace={namespace}
      schema={settingsSchema}
      settingsPath={['providers', 'acme']}
      defaults={{ baseURL: 'https://acme.example/v1', api: 'openai-completions' }}
      operations={operations}
      t={key => en[key]}
      readOnly={false}
      onClose={onClose}
    />,
  )
  return { writeSettings, onClose }
}

describe('provider card setup defaults', () => {
  it.each<[string, JsonValue | undefined]>([
    ['no stored profile', undefined],
    ['a null profile', null],
    ['a list where the profile should be', []],
  ])('seeds every adapter default into the card for %s and writes them on Apply', async (_label, effective) => {
    const { writeSettings, onClose } = mountEditor(namespaceWith(effective))

    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).value).toBe('https://acme.example/v1')
    fireEvent.click(screen.getByRole('button', { name: en.apply }))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(writeSettings).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'acme', 'baseURL'], value: 'https://acme.example/v1' },
      { op: 'set', path: ['providers', 'acme', 'api'], value: 'openai-completions' },
    ], 2)
  })

  it('leaves a default alone when the effective profile already supplies that field', async () => {
    const { writeSettings, onClose } = mountEditor(
      namespaceWith({ baseURL: 'https://pinned.example/v1' }),
    )

    // The composition pins the endpoint, so the card shows it as inherited
    // rather than copying the adapter default over it.
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: en.apply }))

    await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
    expect(writeSettings).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'acme', 'api'], value: 'openai-completions' },
    ], 2)
  })
})
