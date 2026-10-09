/** Provider-login facts the page store joins and the sign-out call it forwards. */
import { describe, expect, it, vi } from 'vitest'
import { joinProviderDirectory, ModelsSettingsStore } from '../src/client/store.ts'
import { settingsSchema } from './settings-schema.client.ts'

describe('joinProviderDirectory login facts', () => {
  it('takes the live route’s login method over the directory entry and keeps setup defaults', () => {
    const rows = joinProviderDirectory(
      [{ id: 'cursor', name: 'Cursor', auth: 'oauth' }],
      [{
        provider: 'cursor', displayName: 'Cursor', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'cursor'],
        auth: 'api-key', defaults: { baseURL: 'https://cursor.example/v1' },
      }],
    )

    expect(rows).toEqual([{
      provider: 'cursor', displayName: 'Cursor', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'cursor'],
      active: true, auth: 'oauth', defaults: { baseURL: 'https://cursor.example/v1' },
    }])
  })
})

describe('ModelsSettingsStore.logout', () => {
  it('disconnects the named provider login through the LLM service', async () => {
    const logout = vi.fn(() => Promise.resolve())
    const store = new ModelsSettingsStore({ remote: { llm: { logout } } } as never, settingsSchema, {} as never)

    await store.logout('opencode-go')

    expect(logout).toHaveBeenCalledExactlyOnceWith('opencode-go')
  })

  it('lets a failed disconnect reach the caller', async () => {
    const logout = vi.fn(() => Promise.reject(new Error('login store locked')))
    const store = new ModelsSettingsStore({ remote: { llm: { logout } } } as never, settingsSchema, {} as never)

    await expect(store.logout('opencode-go')).rejects.toThrow('login store locked')
  })
})
