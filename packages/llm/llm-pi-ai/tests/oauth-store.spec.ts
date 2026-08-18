import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME, parseOAuthCredentialDocument } from '../src/oauth-store.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name = OAUTH_CREDENTIALS_FILENAME): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-store-'))
  dirs.push(dir)
  return join(dir, name)
}

const OAUTH = {
  type: 'oauth' as const,
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 1_787_000_000_000,
  accountId: 'acc_test',
}

describe('parseOAuthCredentialDocument', () => {
  it('refuses invalid JSON without quoting the source', () => {
    expect(() => parseOAuthCredentialDocument('{not json', '/tmp/oauth-credentials.json'))
      .toThrow(/is not valid JSON/)
    try {
      parseOAuthCredentialDocument('{ "openai-codex": { "refresh": "secret-refresh" }', '/tmp/oauth-credentials.json')
    } catch (error) {
      expect(String(error)).not.toContain('secret-refresh')
    }
  })

  it('refuses a non-object root', () => {
    expect(() => parseOAuthCredentialDocument('[]', '/tmp/oauth-credentials.json'))
      .toThrow(/must be a JSON object keyed by provider id/)
    expect(() => parseOAuthCredentialDocument('null', '/tmp/oauth-credentials.json'))
      .toThrow(/must be a JSON object keyed by provider id/)
  })

  it('refuses a non-object entry and an unknown type', () => {
    expect(() => parseOAuthCredentialDocument('{"p": 1}', '/tmp/oauth-credentials.json'))
      .toThrow(/entry "p" must be an object/)
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "other"}}', '/tmp/oauth-credentials.json'))
      .toThrow(/must have type "oauth" or "api_key"/)
  })

  it('refuses incomplete oauth and api-key entries', () => {
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "oauth", "access": "", "refresh": "r", "expires": 1}}', '/tmp/x'))
      .toThrow(/missing access/)
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "oauth", "access": "a", "refresh": "", "expires": 1}}', '/tmp/x'))
      .toThrow(/missing refresh/)
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "oauth", "access": "a", "refresh": "r", "expires": "soon"}}', '/tmp/x'))
      .toThrow(/missing expires/)
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "api_key", "key": ""}}', '/tmp/x'))
      .toThrow(/empty api-key/)
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "api_key", "env": []}}', '/tmp/x'))
      .toThrow(/non-object env/)
    expect(() => parseOAuthCredentialDocument('{"p": {"type": "api_key", "env": null}}', '/tmp/x'))
      .toThrow(/non-object env/)
    expect(parseOAuthCredentialDocument('{"p": {"type": "api_key"}}', '/tmp/x').get('p'))
      .toEqual({ type: 'api_key' })
    expect(parseOAuthCredentialDocument(
      '{"p": {"type": "api_key", "key": "sk", "env": {"REGION": "us"}}}',
      '/tmp/x',
    ).get('p')).toEqual({ type: 'api_key', key: 'sk', env: { REGION: 'us' } })
  })
})

describe('FileOAuthStore', () => {
  it('treats a missing file as an empty store', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    expect(await store.list()).toEqual([])
    expect(await store.read('openai-codex')).toBeUndefined()
  })

  it('persists an oauth credential owner-only and lists without secrets', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    const stored = await store.modify('openai-codex', async () => OAUTH)
    expect(stored).toMatchObject({ type: 'oauth', accountId: 'acc_test' })
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
    const text = await readFile(filename, 'utf8')
    expect(text).toContain('refresh-token')
    expect(await store.list()).toEqual([{ providerId: 'openai-codex', type: 'oauth' }])
    expect(JSON.stringify(await store.list())).not.toContain('refresh-token')
    expect(await store.read('openai-codex')).toEqual(OAUTH)
  })

  it('round-trips an api-key credential with env metadata', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await store.modify('openai', async () => ({ type: 'api_key', key: 'sk-test', env: { REGION: 'us' } }))
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'sk-test', env: { REGION: 'us' } })
  })

  it('leaves the entry unchanged when modify returns undefined', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await store.modify('openai-codex', async () => OAUTH)
    const revision = store.revision
    expect(await store.modify('openai-codex', async () => undefined)).toEqual(OAUTH)
    expect(store.revision).toBe(revision)
  })

  it('deletes a credential and is a no-op for a missing provider', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await store.modify('openai-codex', async () => OAUTH)
    await store.delete('openai-codex')
    expect(await store.list()).toEqual([])
    await store.delete('openai-codex')
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({})
  })

  it('reloads an external replacement of the document', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await writeFile(filename, JSON.stringify({ openai: { type: 'api_key', key: 'external' } }), { mode: 0o600 })
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'external' })
  })

  it('serializes concurrent modify calls', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await Promise.all([
      store.modify('a', async () => ({ type: 'api_key', key: 'one' })),
      store.modify('b', async () => ({ type: 'api_key', key: 'two' })),
    ])
    expect(await store.list()).toEqual([
      { providerId: 'a', type: 'api_key' },
      { providerId: 'b', type: 'api_key' },
    ])
  })

  it('recovers the write queue after a failed modify', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await expect(store.modify('openai-codex', async () => {
      throw new Error('boom')
    })).rejects.toThrow(/boom/)
    await store.modify('openai-codex', async () => OAUTH)
    expect(await store.read('openai-codex')).toEqual(OAUTH)
  })

  it('loads an existing owner-only document in the constructor', async () => {
    const filename = await tempFile()
    await writeFile(filename, `${JSON.stringify({ 'openai-codex': OAUTH }, null, 2)}\n`, { mode: 0o600 })
    const store = new FileOAuthStore(filename)
    expect(await store.read('openai-codex')).toEqual(OAUTH)
    const revision = store.revision
    expect(await store.read('openai-codex')).toEqual(OAUTH)
    expect(store.revision).toBe(revision)
  })

  it('clears in-memory credentials when the document is removed', async () => {
    const filename = await tempFile()
    const store = new FileOAuthStore(filename)
    await store.modify('openai-codex', async () => OAUTH)
    await rm(filename)
    expect(await store.list()).toEqual([])
    expect(await store.read('openai-codex')).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('refuses a document readable beyond its owner', async () => {
    const filename = await tempFile()
    await writeFile(filename, '{}\n', { mode: 0o644 })
    await chmod(filename, 0o644)
    expect(() => new FileOAuthStore(filename)).toThrow(/readable beyond its owner/)
  })
})
