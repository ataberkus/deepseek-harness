/**
 * File-backed pi-ai {@link CredentialStore} at `$DSH_HOME/oauth-credentials.json`.
 *
 * The file is the host persistence pi-ai's OAuth login and refresh expect: one
 * type-tagged credential per provider, written under a cross-process lock so
 * concurrent refresh cannot rotate a token twice. API keys for catalog routes
 * still resolve through the harness credential seam; this store holds OAuth
 * tokens. Refresh and access tokens never appear in diagnostics.
 *
 * @module dsh-llm-pi-ai/oauth-store
 */

import { readFileSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { ApiKeyCredential, Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'

/** Basename of the OAuth credential document inside the harness home. */
export const OAUTH_CREDENTIALS_FILENAME = 'oauth-credentials.json'

/** Permission bits outside the owner; the credential document must have none. */
const GROUP_OTHER_BITS = 0o077

/** Whether a filesystem error means absence. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Reject a credential document other OS users can read, before its contents
 * are parsed. The store creates and replaces the file at `0600`, but a
 * hand-copied one carries whatever umask produced it.
 *
 * POSIX only: Windows has no mode to inspect, so the check is skipped rather
 * than faked.
 * @param filename - absolute path of the document.
 * @param mode - `stat` mode bits of the existing file.
 * @throws when the file exists with group or other permission bits set.
 */
function assertOwnerOnly(filename: string, mode: number): void {
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native Windows coverage does. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows has no POSIX mode enforcement; POSIX behavior tests enforce this peer. */
  const offending = mode & GROUP_OTHER_BITS
  if (offending === 0) return
  throw new Error(
    `llm-pi-ai: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
    + ` run "chmod 600 ${filename}" before starting again`,
  )
  /* v8 ignore stop */
}

/**
 * Parse one OAuth credential document into a provider-keyed map. The document
 * is a JSON object of provider id to a type-tagged credential; a non-object
 * root and an entry that is not a credential are refused rather than skipped,
 * because a silently ignored token reads as "the login I completed has no
 * effect". Diagnostics name the path and the offending key, never the secret.
 * @param text - the document text.
 * @param filename - absolute path, for diagnostics.
 * @returns credentials keyed by provider id.
 */
export function parseOAuthCredentialDocument(text: string, filename: string): Map<string, Credential> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (syntaxError) {
    // JSON.parse quotes the offending snippet; this file holds refresh tokens.
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} is not valid JSON`, { cause: syntaxError })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} must be a JSON object keyed by provider id`)
  }
  const credentials = new Map<string, Credential>()
  for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
    credentials.set(providerId, parseCredential(providerId, value, filename))
  }
  return credentials
}

/** Validate one stored credential without echoing its secret fields. */
function parseCredential(providerId: string, value: unknown, filename: string): Credential {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" must be an object`)
  }
  const record = value as Record<string, unknown>
  if (record.type === 'api_key') return parseApiKeyCredential(providerId, record, filename)
  if (record.type === 'oauth') return parseOAuthCredential(providerId, record, filename)
  throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" must have type "oauth" or "api_key"`)
}

function parseApiKeyCredential(
  providerId: string,
  record: Record<string, unknown>,
  filename: string,
): ApiKeyCredential {
  if (record.key !== undefined && (typeof record.key !== 'string' || record.key.length === 0)) {
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" has an empty api-key`)
  }
  const credential: ApiKeyCredential = { type: 'api_key' }
  if (typeof record.key === 'string') credential.key = record.key
  if (record.env !== undefined) {
    if (record.env === null || typeof record.env !== 'object' || Array.isArray(record.env)) {
      throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" has a non-object env`)
    }
    credential.env = record.env as Exclude<ApiKeyCredential['env'], undefined>
  }
  return credential
}

function parseOAuthCredential(
  providerId: string,
  record: Record<string, unknown>,
  filename: string,
): OAuthCredential {
  if (typeof record.access !== 'string' || record.access.length === 0) {
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" is missing access`)
  }
  if (typeof record.refresh !== 'string' || record.refresh.length === 0) {
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" is missing refresh`)
  }
  if (typeof record.expires !== 'number' || !Number.isFinite(record.expires)) {
    throw new Error(`llm-pi-ai: OAuth credential store at ${filename} entry "${providerId}" is missing expires`)
  }
  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'type' && key !== 'access' && key !== 'refresh' && key !== 'expires'),
  )
  return {
    type: 'oauth',
    access: record.access,
    refresh: record.refresh,
    expires: record.expires,
    ...extra,
  }
}

/** Render the in-memory map as the on-disk JSON object. */
function serializeCredentials(credentials: ReadonlyMap<string, Credential>): string {
  return `${JSON.stringify(Object.fromEntries(credentials), null, 2)}\n`
}

/**
 * Owner-only JSON {@link CredentialStore}. `modify` is the only write path and
 * serializes in-process plus across processes, which is what lets pi-ai run
 * OAuth refresh inside `modify` without double-rotating a token.
 */
export class FileOAuthStore implements CredentialStore {
  /** Bumped when the on-disk set of credentials changes, for route memoization. */
  revision = 0

  private credentials = new Map<string, Credential>()
  /** Last observed file text, so an unchanged read does not bump {@link revision}. */
  private fileText: string | undefined
  /** In-process queue so concurrent `modify`/`delete` never interleave. */
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * @param filename - absolute path of the JSON document.
   */
  constructor(readonly filename: string) {
    this.loadFromDisk()
  }

  /**
   * Non-secret metadata for the currently loaded credentials, reloading the
   * file so an external login is visible without a restart.
   * @returns provider id and credential type for each stored entry.
   */
  credentialInfos(): CredentialInfo[] {
    this.loadFromDisk()
    return [...this.credentials.entries()].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  /**
   * @param providerId - provider route key.
   * @returns the stored credential, or `undefined` when the provider has none.
   */
  async read(providerId: string): Promise<Credential | undefined> {
    this.loadFromDisk()
    return this.credentials.get(providerId)
  }

  /**
   * @returns provider id and type for each stored credential, without secrets.
   */
  async list(): Promise<CredentialInfo[]> {
    return this.credentialInfos()
  }

  /**
   * @param providerId - provider route key.
   * @param fn - read-modify-write; returning `undefined` leaves the entry unchanged.
   * @returns the credential stored after the write, or the unchanged current one.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serialize(async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.filename, async () => {
        this.loadFromDisk()
        const next = await fn(this.credentials.get(providerId))
        if (next === undefined) return this.credentials.get(providerId)
        this.credentials.set(providerId, next)
        await this.persist()
        return next
      })
    })
  }

  /**
   * @param providerId - provider route key to remove.
   */
  async delete(providerId: string): Promise<void> {
    await this.serialize(async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.filename, async () => {
        this.loadFromDisk()
        if (!this.credentials.has(providerId)) return
        this.credentials.delete(providerId)
        await this.persist()
      })
    })
  }

  /** Run one write behind the in-process queue. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Replace the in-memory map from disk; a missing file is an empty store. */
  private loadFromDisk(): void {
    let text: string
    try {
      const mode = statSync(this.filename).mode
      assertOwnerOnly(this.filename, mode)
      text = readFileSync(this.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      if (this.fileText === undefined && this.credentials.size === 0) return
      this.fileText = undefined
      this.credentials = new Map()
      this.revision += 1
      return
    }
    if (text === this.fileText) return
    this.credentials = parseOAuthCredentialDocument(text, this.filename)
    this.fileText = text
    this.revision += 1
  }

  /** Replace the document with the in-memory map and bump {@link revision}. */
  private async persist(): Promise<void> {
    const text = serializeCredentials(this.credentials)
    await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 })
    this.fileText = text
    this.revision += 1
  }
}
