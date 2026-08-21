/**
 * Antigravity Google auth-code login, Cloud Code Assist project discovery, and
 * token refresh.
 *
 * @module dsh-llm-pi-ai/google-antigravity/oauth
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  GOOGLE_ANTIGRAVITY_AUTH_URL,
  GOOGLE_ANTIGRAVITY_BASE_URL,
  GOOGLE_ANTIGRAVITY_CALLBACK_PATH,
  GOOGLE_ANTIGRAVITY_CALLBACK_PORT,
  GOOGLE_ANTIGRAVITY_CLIENT_ID,
  GOOGLE_ANTIGRAVITY_CLIENT_SECRET,
  GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL,
  GOOGLE_ANTIGRAVITY_SCOPES,
  GOOGLE_ANTIGRAVITY_TOKEN_URL,
  GOOGLE_ANTIGRAVITY_VERSION,
} from './constants.ts'
import { antigravityHeaders, antigravityUserAgent } from './headers.ts'
/** Injectable HTTP, sleep, and loopback so tests never hit Google. */
export const antigravityOAuthInternals = {
  fetch: globalThis.fetch.bind(globalThis),
  sleep: (ms: number, signal?: AbortSignal) => sleepMs(ms, signal),
  createLoopbackServer: (port?: number) => createAntigravityCallbackServer(port),
}

const AUTH_REQUEST_TIMEOUT_MS = 30_000
const ONBOARD_POLL_INTERVAL_MS = 2_000
const ONBOARD_MAX_ATTEMPTS = 5
const TOKEN_SKEW_MS = 5 * 60 * 1000
const TIER_FREE = 'free-tier'

/** Loopback waiter that yields the authorization code Google redirected with. */
export interface AntigravityCallbackServer {
  /** Redirect URI Google must match against the client registration. */
  redirectUri: string
  /** Resolved when Google redirects back with a code, or rejected on failure/abort. */
  waitForCallback: (signal?: AbortSignal) => Promise<string>
  /** Close the loopback server. */
  close: () => Promise<void>
}

/**
 * Listen on `127.0.0.1` for the Antigravity OAuth redirect.
 * @param port - production uses {@link GOOGLE_ANTIGRAVITY_CALLBACK_PORT}; tests may use `0`.
 * @returns the waiter and the redirect URI Google must use.
 */
export async function createAntigravityCallbackServer(
  port = GOOGLE_ANTIGRAVITY_CALLBACK_PORT,
): Promise<AntigravityCallbackServer> {
  let settled = false
  let notify: ((result: CallbackResult | CallbackFailure) => void) | undefined
  const callbackPromise = new Promise<CallbackResult | CallbackFailure>((resolve) => {
    notify = resolve
  })

  const server = createServer((req, res) => {
    handleCallbackRequest(req, res, (result) => {
      if (!settled && notify !== undefined) {
        settled = true
        notify(result)
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  /* v8 ignore next -- address is always an AddressInfo when bound to a TCP port. */
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  const redirectUri = `http://127.0.0.1:${boundPort}${GOOGLE_ANTIGRAVITY_CALLBACK_PATH}`

  return {
    redirectUri,
    waitForCallback: async (signal?: AbortSignal): Promise<string> => {
      if (signal?.aborted) {
        await closeServer(server)
        throw abortedError(signal)
      }
      return new Promise<string>((resolve, reject) => {
        const onAbort = (): void => {
          signal?.removeEventListener('abort', onAbort)
          void closeServer(server).finally(() => {
            reject(abortedError(signal))
          })
        }
        signal?.addEventListener('abort', onAbort)

        callbackPromise
          .then((result) => {
            signal?.removeEventListener('abort', onAbort)
            void closeServer(server).finally(() => {
              if (result.kind === 'success') {
                resolve(result.code)
              } else {
                reject(new Error(`Antigravity OAuth failed: ${result.message}`))
              }
            })
          })
          .catch((error: unknown) => {
            signal?.removeEventListener('abort', onAbort)
            void closeServer(server).finally(() => {
              reject(error instanceof Error ? error : new Error(String(error)))
            })
          })
      })
    },
    close: () => closeServer(server),
  }
}

/**
 * Build the Google authorize URL for Antigravity OAuth.
 * @param redirectUri - loopback URL Google must redirect to.
 * @param state - anti-CSRF token.
 * @returns authorize URL to open in the browser.
 */
export function antigravityAuthorizeUrl(redirectUri: string, state: string): string {
  const query = new URLSearchParams({
    client_id: GOOGLE_ANTIGRAVITY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_ANTIGRAVITY_SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  return `${GOOGLE_ANTIGRAVITY_AUTH_URL}?${query.toString()}`
}

/**
 * Exchange the authorization code, discover or provision an Antigravity
 * project, and assemble a stored credential.
 * @param code - authorization code from the loopback callback.
 * @param redirectUri - redirect URI used during the authorize request.
 * @param signal - optional abort signal.
 * @returns ready-to-store credential with `projectId`.
 */
export async function completeAntigravityLogin(
  code: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const tokens = await exchangeAuthorizationCode(code, redirectUri, signal)
  const email = await fetchUserInfoEmail(tokens.access, signal)
  const projectId = await discoverProject(tokens.access, signal)
  return antigravityCredential(tokens.access, tokens.refresh, tokens.expiresIn, projectId, email)
}

/**
 * Exchange a refresh token for a new access token, keeping `projectId`.
 * @param credential - stored Antigravity credential.
 * @param signal - optional abort signal.
 * @returns renewed credential with `projectId` preserved.
 */
export async function refreshAntigravityToken(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const projectId = antigravityProjectId(credential)
  if (projectId === undefined) {
    throw new Error('Antigravity OAuth credential is missing projectId; run /login google-antigravity again')
  }
  const body = new URLSearchParams({
    client_id: GOOGLE_ANTIGRAVITY_CLIENT_ID,
    client_secret: GOOGLE_ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: credential.refresh,
    grant_type: 'refresh_token',
  })
  const response = await antigravityOAuthInternals.fetch(GOOGLE_ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: requestSignal(signal),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Antigravity token refresh failed: ${errorText}`)
  }
  const parsed = parseTokenJson(await response.json(), 'token refresh')
  return antigravityCredential(
    parsed.access,
    parsed.refresh ?? credential.refresh ?? '',
    parsed.expiresIn,
    projectId,
    typeof (credential as Record<string, unknown>).email === 'string' ? (credential as Record<string, unknown>).email as string : undefined,
  )
}

/**
 * `projectId` persisted on an Antigravity OAuth credential.
 * @param credential - stored credential; never logged.
 * @returns the Antigravity project, or `undefined` when absent.
 */
export function antigravityProjectId(credential: OAuthCredential): string | undefined {
  const raw = (credential as Record<string, unknown>).projectId
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function antigravityCredential(
  access: string,
  refresh: string,
  expiresIn: number,
  projectId: string,
  email?: string,
): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - TOKEN_SKEW_MS,
    projectId,
    ...(email ? { email } : {}),
  }
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: GOOGLE_ANTIGRAVITY_CLIENT_ID,
    client_secret: GOOGLE_ANTIGRAVITY_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })
  const response = await antigravityOAuthInternals.fetch(GOOGLE_ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: requestSignal(signal),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token exchange failed: ${errorText}`)
  }
  const parsed = parseTokenJson(await response.json(), 'token exchange')
  if (parsed.refresh === undefined) {
    throw new Error('No refresh token received. Please try again.')
  }
  return { access: parsed.access, refresh: parsed.refresh, expiresIn: parsed.expiresIn }
}

async function fetchUserInfoEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await antigravityOAuthInternals.fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: requestSignal(signal),
    })
    if (response.ok) {
      const data: unknown = await response.json()
      if (data && typeof data === 'object' && 'email' in data && typeof data.email === 'string') {
        const email = data.email.trim()
        return email.length > 0 ? email : undefined
      }
    }
  } catch {
    // Ignore userinfo fetch errors; email is optional metadata
  }
  return undefined
}

function extractProjectString(val: unknown): string | undefined {
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim()
  }
  if (val && typeof val === 'object' && 'id' in val && typeof val.id === 'string') {
    const s = val.id.trim()
    if (s.length > 0) return s
  }
  return undefined
}

function extractProjectId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const obj = payload as Record<string, unknown>
  for (const field of ['cloudaicompanionProject', 'projectId', 'project']) {
    const found = extractProjectString(obj[field])
    if (found) return found
  }
  return undefined
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string }
  projectId?: string | { id?: string }
  project?: string | { id?: string }
  currentTier?: { id?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
}

function selectTier(response: LoadCodeAssistResponse): string {
  if (response.allowedTiers && response.allowedTiers.length > 0) {
    const defaultTier = response.allowedTiers.find(t => t.isDefault && typeof t.id === 'string' && t.id.trim().length > 0)
    if (defaultTier?.id) return defaultTier.id.trim()
  }
  if (response.currentTier && typeof response.currentTier.id === 'string' && response.currentTier.id.trim().length > 0) {
    return response.currentTier.id.trim()
  }
  return TIER_FREE
}

/**
 * Resolve the Antigravity Cloud Code Assist project.
 * @param accessToken - Google access token.
 * @param signal - optional abort signal.
 * @returns Cloud Code Assist project id.
 */
export async function discoverProject(accessToken: string, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...antigravityHeaders('login'),
  }

  let selectedTier = TIER_FREE
  let lastStatus: number | undefined
  let lastErrorText: string | undefined
  let loadSucceeded = false

  for (const endpoint of [GOOGLE_ANTIGRAVITY_BASE_URL, GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL]) {
    try {
      const response = await antigravityOAuthInternals.fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: { ideType: 'ANTIGRAVITY' },
        }),
        signal: requestSignal(signal),
      })
      if (!response.ok) {
        lastStatus = response.status
        lastErrorText = await response.text()
        continue
      }
      loadSucceeded = true
      const data = (await response.json()) as LoadCodeAssistResponse
      const existingProject = extractProjectId(data)
      if (existingProject) {
        return existingProject
      }
      selectedTier = selectTier(data)
      break
    } catch (err) {
      if (signal?.aborted) throw abortedError(signal)
      lastErrorText = err instanceof Error ? err.message : String(err)
    }
  }

  if (!loadSucceeded && lastStatus !== undefined) {
    throw new Error(`loadCodeAssist failed: ${lastStatus}: ${lastErrorText || 'unknown error'}`)
  }

  // Provision via onboardUser
  const onboardHeaders: Record<string, string> = {
    ...headers,
    'User-Agent': `${headers['User-Agent'] ?? antigravityUserAgent()} google-api-nodejs-client/10.3.0`,
    'X-Goog-Api-Client': 'gl-node/22.21.1',
  }
  const onboardBody = {
    tier_id: selectedTier,
    metadata: {
      ide_type: 'ANTIGRAVITY',
      ide_version: GOOGLE_ANTIGRAVITY_VERSION,
      ide_name: 'antigravity',
    },
  }

  for (let attempt = 1; attempt <= ONBOARD_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await antigravityOAuthInternals.sleep(ONBOARD_POLL_INTERVAL_MS, signal)
    }
    const response = await antigravityOAuthInternals.fetch(`${GOOGLE_ANTIGRAVITY_BASE_URL}/v1internal:onboardUser`, {
      method: 'POST',
      headers: onboardHeaders,
      body: JSON.stringify(onboardBody),
      signal: requestSignal(signal),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`onboardUser failed: ${response.status} ${response.statusText}: ${text}`)
    }
    const result = (await response.json()) as { done?: boolean; response?: unknown }
    if (!result.done) {
      continue
    }
    const provisioned = extractProjectId(result.response)
    if (provisioned) {
      return provisioned
    }
  }

  throw new Error(`onboardUser did not return a provisioned project id after ${ONBOARD_MAX_ATTEMPTS} attempts`)
}

function parseTokenJson(
  value: unknown,
  endpoint: string,
): { access: string; refresh?: string; expiresIn: number } {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid JSON from ${endpoint}: expected object`)
  }
  const record = value as Record<string, unknown>
  const access = record.access_token
  const refresh = record.refresh_token
  const expiresIn = record.expires_in
  if (typeof access !== 'string' || access.length === 0) {
    throw new Error(`Invalid JSON from ${endpoint}: missing access_token`)
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    throw new Error(`Invalid JSON from ${endpoint}: missing expires_in`)
  }
  return {
    access,
    ...(typeof refresh === 'string' && refresh.length > 0 ? { refresh } : {}),
    expiresIn,
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  return signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortedError(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortedError(signal))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

function abortedError(signal?: AbortSignal): Error {
  return new Error('Antigravity login aborted', { cause: signal?.reason })
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() =>{  resolve() })
  })
}

interface CallbackResult {
  kind: 'success'
  code: string
}

interface CallbackFailure {
  kind: 'failure'
  message: string
}

function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  done: (result: CallbackResult | CallbackFailure) => void,
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== GOOGLE_ANTIGRAVITY_CALLBACK_PATH) {
    writeHtml(response, 404, 'Not Found')
    return
  }
  const error = url.searchParams.get('error')
  if (error !== null) {
    writeHtml(response, 400, 'Authentication denied or failed. You may close this tab.')
    done({ kind: 'failure', message: error })
    return
  }
  const code = url.searchParams.get('code')
  if (code === null || code.length === 0) {
    writeHtml(response, 400, 'Missing authorization code. You may close this tab.')
    done({ kind: 'failure', message: 'missing code query parameter' })
    return
  }
  writeHtml(
    response,
    200,
    'Authentication complete. You may close this tab and return to the application.',
  )
  done({ kind: 'success', code })
}

function writeHtml(response: ServerResponse, status: number, message: string): void {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Antigravity Sign In</title></head><body><p>${message}</p></body></html>`
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  })
  response.end(html)
}
