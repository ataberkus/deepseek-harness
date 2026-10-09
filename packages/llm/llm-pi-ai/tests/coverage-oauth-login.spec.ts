/** OAuth login helpers: OpenCode Go catalog failures, default browser interaction, and managed logout refusal. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as catalog from '../src/catalog.ts'
import {
  createBrowserOAuthInteraction,
  loginOpenCodeGo,
  logoutManagedLogin,
  OPENAI_CODEX_BROWSER_LOGIN_METHOD,
  OPENCODE_GO_PROVIDER,
} from '../src/oauth-login.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

async function newStore(): Promise<FileOAuthStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cov-oauth-login-'))
  return new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
}

describe('loginOpenCodeGo catalog failures', () => {
  it('refuses when the installed catalog does not ship OpenCode Go', async () => {
    vi.spyOn(catalog, 'catalogProvider').mockReturnValue(undefined)
    await expect(loginOpenCodeGo(await newStore(), 'sk-test-key'))
      .rejects.toThrow('hosted catalog does not ship opencode-go')
  })

  it('refuses when the catalog entry offers no API-key login', async () => {
    const real = catalog.catalogProvider(OPENCODE_GO_PROVIDER)
    if (real === undefined) throw new Error('expected opencode-go in the installed catalog')
    vi.spyOn(catalog, 'catalogProvider').mockReturnValue({ ...real, auth: {} })
    await expect(loginOpenCodeGo(await newStore(), 'sk-test-key'))
      .rejects.toThrow('provider "opencode-go" does not offer API-key login')
  })

  it('answers only secret prompts and ignores progress notifications', async () => {
    const real = catalog.catalogProvider(OPENCODE_GO_PROVIDER)
    if (real?.auth.apiKey === undefined) throw new Error('expected opencode-go API-key auth')
    const seen: string[] = []
    vi.spyOn(real.auth.apiKey, 'login').mockImplementation(async (interaction) => {
      interaction.notify({ type: 'info', message: 'working' })
      await interaction.prompt({ type: 'text', message: 'Project?' })
      seen.push('unreachable')
      return { type: 'api_key', key: 'k' }
    })
    await expect(loginOpenCodeGo(await newStore(), 'sk-test-key'))
      .rejects.toThrow('OpenCode Go API-key login does not support text prompts')
    expect(seen).toEqual([])
  })
})

describe('createBrowserOAuthInteraction defaults', () => {
  it('builds with the host browser opener and stderr writer when no options are given', async () => {
    const interaction = createBrowserOAuthInteraction()
    await expect(interaction.prompt({
      type: 'select',
      message: 'method',
      options: [{ id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: 'Browser' }],
    })).resolves.toBe(OPENAI_CODEX_BROWSER_LOGIN_METHOD)
  })
})

describe('logoutManagedLogin', () => {
  it('refuses a provider that is neither OpenCode Go nor a hosted OAuth route', async () => {
    const store = await newStore()
    const onCredentialChange = vi.fn()
    await expect(logoutManagedLogin('openai', { store, onCredentialChange }))
      .rejects.toThrow('provider "openai" does not support managed logout')
    expect(onCredentialChange).not.toHaveBeenCalled()
  })
})
