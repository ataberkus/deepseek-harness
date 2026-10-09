/** Adapter served-model cache: concurrent callers of one failing Cursor listing. */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { cursorListingInternals } from '../src/cursor/models.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'

const originalFetch = cursorListingInternals.fetch

afterEach(() => {
  cursorListingInternals.fetch = originalFetch
})

describe('adapter served-model cache', () => {
  it('fails every concurrent caller of a failed listing and retries on the next call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-served-cache-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    await store.modify('cursor', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    let attempts = 0
    cursorListingInternals.fetch = async () => {
      attempts += 1
      return new Uint8Array()
    }
    const profiles = resolveProfiles({ cursor: {} })
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => undefined,
      auth: {
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
    })
    const settled = await Promise.allSettled([adapter.listModels('cursor'), adapter.listModels('cursor')])
    expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(attempts).toBe(1)
    await expect(adapter.listModels('cursor')).rejects.toMatchObject({ code: 'CURSOR_NO_USABLE_MODELS' })
    expect(attempts).toBe(2)
  })
})
