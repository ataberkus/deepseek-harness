/**
 * Claude Pro/Max subscription OAuth for the `anthropic` route, ported from Oh
 * My Pi (its catalog package's `src/compat/rules/auth/anthropic.kdl` and its
 * ai package's `src/registry/oauth/anthropic.ts`). Login is a PKCE
 * authorization code on claude.ai whose loopback callback listens on
 * `localhost:54545/callback` (both loopback families; a random port when
 * 54545 is busy) and also accepts a pasted code or redirect URL. Exchange and
 * refresh go to `api.anthropic.com`; account and organization identity come
 * from the token response or, when it omits them, the Claude CLI bootstrap
 * endpoint.
 *
 * Inference stays with pi-ai's `anthropic-messages`, which sends `sk-ant-oat`
 * tokens with the Claude Code headers and system block.
 *
 * @module dsh-llm-pi-ai/anthropic/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OAuthAuth, OAuthCredential, Provider, ProviderAuthInteraction } from '@earendil-works/pi-ai'

/** Injectable HTTP, callback port, and callback timeout so tests never reach Anthropic. */
export const anthropicOAuthInternals = {
  fetch: globalThis.fetch.bind(globalThis),
  callbackPort: 54545,
  callbackTimeoutMs: 300_000,
}

/** Claude Code's public OAuth client id. */
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** claude.ai authorize endpoint; it issues tokens with `user:inference`. */
export const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
/** Token endpoint for both the code exchange and refresh. */
export const ANTHROPIC_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token'
/** Claude CLI bootstrap endpoint reporting the signed-in account and organization. */
export const ANTHROPIC_BOOTSTRAP_URL =
  'https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8'
/** Scopes Claude Code requests. */
export const ANTHROPIC_OAUTH_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

const CALLBACK_PATH = '/callback'
const OAUTH_BETA = 'oauth-2025-04-20'
/** The Claude Code release pi-ai's `anthropic-messages` also presents for subscription tokens. */
const CLAUDE_CODE_VERSION = '2.1.280'
/** The `@anthropic-ai/sdk` release that Claude Code version bundles. */
const CLAUDE_CODE_SDK_VERSION = '0.112.1'
const REQUEST_TIMEOUT_MS = 30_000
const TOKEN_SKEW_MS = 5 * 60 * 1000

/** The bound callback listener for one login. */
interface CallbackListener {
  redirectUri: string
  wait: (signal: AbortSignal) => Promise<string>
  close: () => void
}

/**
 * Open claude.ai consent, take the code from the loopback callback or a pasted
 * code/redirect URL, and exchange it.
 * @param interaction - host interaction; `auth_url` opens the browser and `manual_code` may resolve with a paste.
 * @returns the credential to store, with any identity fields Anthropic reports.
 */
export async function loginClaude(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { signal } = interaction
  signal.throwIfAborted()
  const state = randomBytes(16).toString('hex')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const listener = await listenForCallback(state)
  const settled = new AbortController()
  try {
    const params = new URLSearchParams({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: listener.redirectUri,
      scope: ANTHROPIC_OAUTH_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      code: 'true',
    })
    interaction.notify({
      type: 'auth_url',
      url: `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`,
      instructions:
        'Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.',
    })
    const wait = AbortSignal.any([
      signal,
      settled.signal,
      AbortSignal.timeout(anthropicOAuthInternals.callbackTimeoutMs),
    ])
    const code = await Promise.race([listener.wait(wait), pastedCode(interaction, state, wait)])
    interaction.notify({ type: 'progress', message: 'Exchanging authorization code for tokens...' })
    return await exchangeCode(code, state, verifier, listener.redirectUri, signal)
  } finally {
    settled.abort()
    listener.close()
  }
}

/**
 * Exchange the stored refresh token with Claude Code's refresh headers. Stored
 * identity is kept unless the response reports new account fields; the
 * organization stays the one captured at login.
 * @param credential - stored Claude credential; never logged.
 * @param signal - aborts the refresh.
 * @returns the renewed credential.
 */
export async function refreshClaude(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const body = await postToken(
    { grant_type: 'refresh_token', client_id: ANTHROPIC_OAUTH_CLIENT_ID, refresh_token: credential.refresh },
    {
      'anthropic-beta': OAUTH_BETA,
      'User-Agent': `anthropic-sdk-typescript/${CLAUDE_CODE_SDK_VERSION} userOAuthProvider`,
    },
    'token refresh',
    signal,
  )
  return withBootstrapIdentity(
    { ...credential, ...tokenCredential(body, credential.refresh), ...identity(body, TOKEN_IDENTITY, false) },
    false,
    signal,
  )
}

/** The `anthropic` provider's OAuth method: Claude Pro/Max through this module. */
export const claudeOAuth: OAuthAuth = {
  name: 'Anthropic (Claude Pro/Max)',
  isSubscription: true,
  login: loginClaude,
  refresh: refreshClaude,
  toAuth: credential => Promise.resolve({ apiKey: credential.access }),
}

/**
 * Replace a catalog `anthropic` provider's OAuth method with {@link claudeOAuth}.
 * @param provider - pi-ai's installed `anthropic` provider.
 * @returns the same provider with this module's OAuth method.
 */
export function withClaudeOAuth(provider: Provider): Provider {
  return { ...provider, auth: { ...provider.auth, oauth: claudeOAuth } }
}

/**
 * Parse a pasted redirect URL, query string, or `code#state` value.
 * @param input - text the user pasted.
 * @returns the code and state it carries.
 */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (value.length === 0) return {}
  if (URL.canParse(value)) {
    const url = new URL(value)
    return paramsCode(url.searchParams)
  }
  if (value.includes('code=')) return paramsCode(new URLSearchParams(value.replace(/^[?#]/, '')))
  const [code = '', state] = value.split('#', 2)
  return state === undefined ? { code } : { code, state }
}

function paramsCode(params: URLSearchParams): { code?: string; state?: string } {
  const code = params.get('code')
  const state = params.get('state')
  return { ...code === null ? {} : { code }, ...state === null ? {} : { state } }
}

/** Re-prompt until the paste carries a code whose state, if any, is this login's. */
async function pastedCode(
  interaction: ProviderAuthInteraction,
  state: string,
  signal: AbortSignal,
): Promise<string> {
  for (;;) {
    const input = await interaction.prompt({
      type: 'manual_code',
      message: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
      signal,
    })
    const parsed = parseCallbackInput(input)
    if (parsed.code && (parsed.state === undefined || parsed.state === state)) return parsed.code
  }
}

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  // claude.ai's code page shows `code#state`; the fragment wins over this login's state.
  const [exchangeCode = '', fragment] = code.split('#', 2)
  const body = await postToken(
    {
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: exchangeCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      state: fragment || state,
    },
    {},
    'token exchange',
    signal,
  )
  return withBootstrapIdentity({ ...tokenCredential(body), ...identity(body, TOKEN_IDENTITY, true) }, true, signal)
}

async function postToken(
  params: Record<string, string>,
  headers: Record<string, string>,
  label: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await anthropicOAuthInternals.fetch(ANTHROPIC_TOKEN_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Claude ${label} failed: ${response.status} ${text.slice(0, 500)}`)
  const body = parseObject(text)
  if (body === undefined) throw new Error(`Claude ${label} returned invalid JSON`)
  return body
}

function tokenCredential(body: Record<string, unknown>, previousRefresh = ''): OAuthCredential {
  const access = body.access_token
  const expiresIn = body.expires_in
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error('Claude token response is missing access_token')
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new Error('Claude token response is missing expires_in')
  }
  const refresh = body.refresh_token
  return {
    type: 'oauth',
    access,
    refresh: typeof refresh === 'string' && refresh.length > 0 ? refresh : previousRefresh,
    expires: Date.now() + expiresIn * 1000 - TOKEN_SKEW_MS,
  }
}

type IdentityField = 'accountId' | 'email' | 'orgId' | 'orgName'

/** Where the token response reports identity. */
const TOKEN_IDENTITY: Record<IdentityField, readonly [string, string]> = {
  accountId: ['account', 'uuid'],
  email: ['account', 'email_address'],
  orgId: ['organization', 'uuid'],
  orgName: ['organization', 'name'],
}

/** Where the Claude CLI bootstrap reports identity. */
const BOOTSTRAP_IDENTITY: Record<IdentityField, readonly [string, string]> = {
  accountId: ['oauth_account', 'account_uuid'],
  email: ['oauth_account', 'account_email'],
  orgId: ['oauth_account', 'organization_uuid'],
  orgName: ['oauth_account', 'organization_name'],
}

/**
 * The non-empty identity strings `body` carries at `paths`. Organization
 * fields are read only at login: the organization a token is scoped to is
 * fixed then, and refresh must not re-key it.
 */
function identity(
  body: Record<string, unknown>,
  paths: Record<IdentityField, readonly [string, string]>,
  includeOrg: boolean,
): Partial<Record<IdentityField, string>> {
  const out: Partial<Record<IdentityField, string>> = {}
  for (const [field, [parent, key]] of Object.entries(paths) as Array<[IdentityField, readonly [string, string]]>) {
    if (!includeOrg && (field === 'orgId' || field === 'orgName')) continue
    const container = body[parent]
    const value = typeof container === 'object' && container !== null
      ? (container as Record<string, unknown>)[key]
      : undefined
    if (typeof value === 'string' && value.length > 0) out[field] = value
  }
  return out
}

/**
 * Fill account (and, at login, organization) identity from the Claude CLI
 * bootstrap endpoint when the credential lacks it. A failed lookup keeps the
 * credential as it is.
 */
async function withBootstrapIdentity(
  credential: OAuthCredential,
  includeOrg: boolean,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const orgSatisfied = !includeOrg || credential.orgId !== undefined
  if (credential.accountId !== undefined && credential.email !== undefined && orgSatisfied) return credential
  let raw: string | undefined
  try {
    raw = await fetchBootstrap(credential.access, signal)
  } catch (error) {
    // Identity is display metadata; a network failure must not fail login or refresh.
    void error
    return credential
  }
  const body = raw === undefined ? undefined : parseObject(raw)
  if (body === undefined) return credential
  return { ...identity(body, BOOTSTRAP_IDENTITY, includeOrg), ...credential }
}

/** GET the Claude CLI bootstrap with Claude Code's headers; `undefined` on a non-2xx reply. */
async function fetchBootstrap(access: string, signal: AbortSignal): Promise<string | undefined> {
  const response = await anthropicOAuthInternals.fetch(ANTHROPIC_BOOTSTRAP_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      'User-Agent': `claude-code/${CLAUDE_CODE_VERSION}`,
      'anthropic-beta': OAUTH_BETA,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  })
  return response.ok ? await response.text() : undefined
}

async function listenForCallback(state: string): Promise<CallbackListener> {
  const callback = Promise.withResolvers<string>()
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    /* v8 ignore next -- an http.Server request always carries `url`. */
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== CALLBACK_PATH) {
      writeHtml(response, 404, 'Not found.')
      return
    }
    const returnedState = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    if (error !== null) {
      writeHtml(response, 400, 'Claude sign-in did not complete. You may close this tab.')
      // Only a redirect carrying this login's state comes from the real consent
      // page; any local process can forge one without it.
      if (returnedState === state) {
        const description = url.searchParams.get('error_description') ?? error
        callback.reject(new Error(`Claude authorization failed: ${description}`))
      }
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code.length === 0) {
      writeHtml(response, 400, 'Missing authorization code.')
      return
    }
    if (returnedState !== state) {
      writeHtml(response, 400, 'State mismatch.')
      return
    }
    writeHtml(response, 200, 'Claude sign-in complete. You may close this tab and return to the application.')
    callback.resolve(code)
  }
  const preferred = anthropicOAuthInternals.callbackPort
  let servers: Server[]
  try {
    servers = await bindLoopback(handle, preferred)
  } catch (error) {
    if (preferred === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    // ponytail: no redraw when the random port is also held on ::1; that collision is vanishingly rare.
    servers = await bindLoopback(handle, 0)
  }
  const port = boundPort(servers[0])
  return {
    redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
    wait: (signal) => {
      const aborted = Promise.withResolvers<never>()
      const onAbort = (): void => { aborted.reject(signal.reason) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      return Promise.race([callback.promise, aborted.promise])
    },
    close: () => {
      for (const server of servers) {
        server.close()
        server.closeAllConnections()
      }
    },
  }
}

/**
 * Bind `127.0.0.1` and, when the host has IPv6 loopback, `::1` on the same
 * port: browsers resolve `localhost` to either, and a process on the other
 * family's port would otherwise receive the code.
 */
async function bindLoopback(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  port: number,
): Promise<Server[]> {
  const primary = await listen(handle, port, '127.0.0.1')
  try {
    return [primary, await listen(handle, boundPort(primary), '::1')]
  } catch (error) {
    /* v8 ignore next -- only a host without IPv6 loopback fails the `::1` bind for another reason. */
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') return [primary]
    primary.close()
    throw error
  }
}

function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  port: number,
  host: string,
): Promise<Server> {
  const server = createServer(handle)
  const { promise, resolve, reject } = Promise.withResolvers<Server>()
  server.once('error', reject)
  server.listen(port, host, () => {
    server.removeListener('error', reject)
    resolve(server)
  })
  return promise
}

function boundPort(server: Server | undefined): number {
  const address = server?.address()
  /* v8 ignore next -- a TCP listener always reports an AddressInfo. */
  if (address === null || address === undefined || typeof address !== 'object') throw new Error('Claude callback server has no port')
  return address.port
}

function writeHtml(response: ServerResponse, status: number, message: string): void {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Claude Sign In</title></head><body><p>${message}</p></body></html>`
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  })
  response.end(html)
}

function parseObject(value: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    // Callers report their own invalid-JSON failure.
    void error
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
}
