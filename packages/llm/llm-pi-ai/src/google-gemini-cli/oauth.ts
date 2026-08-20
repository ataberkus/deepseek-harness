/**
 * Gemini CLI Google auth-code login, Cloud Code Assist project discovery, and
 * token refresh.
 *
 * Flow: open accounts.google.com, receive the code on
 * `127.0.0.1:8085/oauth2callback`, exchange it, then `loadCodeAssist` /
 * `onboardUser` for a `projectId` stored beside the tokens. This is not
 * Codex PKCE and not Cursor poll.
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/oauth
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  GOOGLE_GEMINI_CLI_AUTH_URL,
  GOOGLE_GEMINI_CLI_CALLBACK_PATH,
  GOOGLE_GEMINI_CLI_CALLBACK_PORT,
  GOOGLE_GEMINI_CLI_CLIENT_ID,
  GOOGLE_GEMINI_CLI_CLIENT_SECRET,
  GOOGLE_GEMINI_CLI_SCOPES,
  GOOGLE_GEMINI_CLI_TOKEN_URL,
  GOOGLE_GEMINI_CLI_BASE_URL,
} from './constants.ts'
import { geminiCliHeaders } from './headers.ts'

/** Injectable HTTP, sleep, and loopback so tests never hit Google. */
export const geminiOAuthInternals = {
  /** Resolves `fetch` at call time so `vi.stubGlobal('fetch')` still applies. */
  fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, init)) as typeof fetch,
  /** Delay between LRO polls; tests replace this to avoid waiting. */
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => sleepMs(ms, signal),
  /** CSRF state for the authorize URL; tests pin it. */
  randomState: (): string => crypto.randomUUID(),
  /** Bind the loopback callback; tests replace this with a fake waiter. */
  createCallbackServer: createGeminiCallbackServer,
}

const AUTH_REQUEST_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 5_000
const POLL_MAX_ATTEMPTS = 24
const TOKEN_SKEW_MS = 5 * 60 * 1000
const TIER_FREE = 'free-tier'
const TIER_LEGACY = 'legacy-tier'
const TIER_STANDARD = 'standard-tier'

/** Loopback waiter that yields the authorization code Google redirected with. */
export interface GeminiCallbackServer {
  /** `redirect_uri` registered on the authorize request. */
  redirectUri: string
  /**
   * Wait until Google hits the callback, or `signal` aborts.
   * @param signal - aborts the wait and closes in-flight sockets.
   * @returns code and state from the query.
   */
  wait: (signal?: AbortSignal) => Promise<{ code: string; state: string }>
  /** Close the listener. Safe to call more than once. */
  close: () => Promise<void>
}

/**
 * Listen on `127.0.0.1` for the Gemini CLI OAuth redirect.
 * @param port - production uses {@link GOOGLE_GEMINI_CLI_CALLBACK_PORT}; tests may use `0`.
 * @returns the waiter and the redirect URI Google must use.
 */
export async function createGeminiCallbackServer(port = GOOGLE_GEMINI_CLI_CALLBACK_PORT): Promise<GeminiCallbackServer> {
  let resolveCode: ((value: { code: string; state: string }) => void) | undefined
  let rejectCode: ((error: Error) => void) | undefined
  const pending = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  let settled = false
  const server: Server = createServer((request, response) => {
    handleCallbackRequest(request, response, (result) => {
      if (settled) return
      settled = true
      if (result.ok) resolveCode?.(result.value)
      else rejectCode?.(result.error)
    })
  })
  await new Promise<void>((resolve, listenReject) => {
    const fail = (error: Error): void => {
      server.off('listening', succeed)
      listenReject(error)
    }
    const succeed = (): void => {
      server.off('error', fail)
      resolve()
    }
    server.once('error', fail)
    server.once('listening', succeed)
    server.listen(port, '127.0.0.1')
  })
  const address = server.address()
  /* v8 ignore start -- Node reports a TCP listen as an AddressInfo, never a pipe path. */
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Gemini CLI OAuth callback server did not bind a TCP port')
  }
  /* v8 ignore stop */
  const redirectUri = `http://127.0.0.1:${address.port}${GOOGLE_GEMINI_CLI_CALLBACK_PATH}`
  return {
    redirectUri,
    wait: async (signal) => {
      if (signal?.aborted) {
        await closeServer(server)
        throw abortedError(signal)
      }
      const onAbort = (): void => {
        /* v8 ignore next -- abort after the callback already settled is a no-op. */
        if (settled) return
        settled = true
        rejectCode?.(abortedError(signal))
        void closeServer(server)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await pending
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },
    close: () => closeServer(server),
  }
}

/**
 * Build the Google authorize URL. The query carries client id, scopes, and
 * CSRF state, never tokens.
 * @param redirectUri - loopback URI the callback server is listening on.
 * @param state - CSRF token the callback must echo.
 * @returns the URL the host must open.
 */
export function geminiAuthorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_GEMINI_CLI_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_GEMINI_CLI_SCOPES.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  return `${GOOGLE_GEMINI_CLI_AUTH_URL}?${params.toString()}`
}

/**
 * Exchange the authorization code, discover or provision a Cloud Code Assist
 * project, and return the stored credential.
 * @param code - authorization code from the loopback query.
 * @param redirectUri - the same URI sent on the authorize request.
 * @param signal - aborts token exchange and project discovery.
 * @returns access, refresh, expiry, and `projectId`.
 */
export async function completeGeminiLogin(
  code: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const tokens = await exchangeAuthorizationCode(code, redirectUri, signal)
  const projectId = await discoverProject(tokens.access, signal)
  return geminiCredential(tokens.access, tokens.refresh, tokens.expiresIn, projectId)
}

/**
 * Exchange a refresh token for a new access token, keeping `projectId`.
 * @param credential - current OAuth credential; never logged.
 * @param signal - abort the exchange.
 * @returns a credential with a new access token and the same `projectId`.
 */
export async function refreshGeminiToken(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const projectId = geminiProjectId(credential)
  if (projectId === undefined) {
    throw new Error('Gemini CLI OAuth credential is missing projectId; run /login google-gemini-cli again')
  }
  const body = new URLSearchParams({
    client_id: GOOGLE_GEMINI_CLI_CLIENT_ID,
    client_secret: GOOGLE_GEMINI_CLI_CLIENT_SECRET,
    refresh_token: credential.refresh,
    grant_type: 'refresh_token',
  })
  const response = await geminiOAuthInternals.fetch(GOOGLE_GEMINI_CLI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: requestSignal(signal),
  })
  if (!response.ok) {
    throw new Error(`Gemini CLI token refresh failed: ${response.status}`)
  }
  const tokens = parseTokenJson(await response.json(), 'Gemini CLI token refresh')
  return geminiCredential(tokens.access, tokens.refresh ?? credential.refresh, tokens.expiresIn, projectId)
}

/**
 * `projectId` persisted on a Gemini CLI OAuth credential.
 * @param credential - stored credential; never logged.
 * @returns the Cloud Code Assist project, or `undefined` when absent.
 */
export function geminiProjectId(credential: OAuthCredential): string | undefined {
  const value = credential['projectId']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function geminiCredential(
  access: string,
  refresh: string,
  expiresIn: number,
  projectId: string,
): OAuthCredential {
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - TOKEN_SKEW_MS,
    projectId,
  }
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expiresIn: number }> {
  const response = await geminiOAuthInternals.fetch(GOOGLE_GEMINI_CLI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_GEMINI_CLI_CLIENT_ID,
      client_secret: GOOGLE_GEMINI_CLI_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
    signal: requestSignal(signal),
  })
  if (!response.ok) {
    throw new Error(`Gemini CLI token exchange failed: ${response.status}`)
  }
  const tokens = parseTokenJson(await response.json(), 'Gemini CLI token exchange')
  if (tokens.refresh === undefined) {
    throw new Error('Gemini CLI token exchange returned no refresh token')
  }
  return { access: tokens.access, refresh: tokens.refresh, expiresIn: tokens.expiresIn }
}

/**
 * Resolve the Cloud Code Assist project Google will bill and route through.
 * Workspace accounts that need an explicit GCP project read
 * `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID`.
 * @param accessToken - bearer token; never logged.
 * @param signal - abort discovery and LRO polls.
 * @returns the project id stored on the credential.
 */
export async function discoverProject(accessToken: string, signal?: AbortSignal): Promise<string> {
  const envProjectId = process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID']
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...geminiCliHeaders('login'),
  }
  const loadResponse = await geminiOAuthInternals.fetch(
    `${GOOGLE_GEMINI_CLI_BASE_URL}/v1internal:loadCodeAssist`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cloudaicompanionProject: envProjectId,
        metadata: {
          ideType: 'IDE_UNSPECIFIED',
          platform: 'PLATFORM_UNSPECIFIED',
          pluginType: 'GEMINI',
          duetProject: envProjectId,
        },
      }),
      signal: requestSignal(signal),
    },
  )
  let data: LoadCodeAssistPayload
  if (!loadResponse.ok) {
    const errorText = await loadResponse.text()
    if (isVpcScAffectedUser(errorText)) {
      data = { currentTier: { id: TIER_STANDARD } }
    } else {
      throw new Error(`loadCodeAssist failed: ${loadResponse.status}: ${errorText}`)
    }
  } else {
    data = (await loadResponse.json()) as LoadCodeAssistPayload
  }
  if (data.currentTier) {
    if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject.length > 0) {
      return data.cloudaicompanionProject
    }
    if (envProjectId !== undefined && envProjectId.length > 0) return envProjectId
    throw workspaceProjectRequired()
  }
  const tierId = defaultTierId(data.allowedTiers)
  if (tierId !== TIER_FREE && (envProjectId === undefined || envProjectId.length === 0)) {
    throw workspaceProjectRequired()
  }
  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  }
  if (tierId !== TIER_FREE && envProjectId !== undefined) {
    onboardBody['cloudaicompanionProject'] = envProjectId
    ;(onboardBody['metadata'] as Record<string, unknown>)['duetProject'] = envProjectId
  }
  const onboardResponse = await geminiOAuthInternals.fetch(
    `${GOOGLE_GEMINI_CLI_BASE_URL}/v1internal:onboardUser`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(onboardBody),
      signal: requestSignal(signal),
    },
  )
  if (!onboardResponse.ok) {
    const errorText = await onboardResponse.text()
    throw new Error(`onboardUser failed: ${onboardResponse.status}: ${errorText}`)
  }
  let lro = (await onboardResponse.json()) as LongRunningOperationResponse
  if (lro.done !== true && typeof lro.name === 'string' && lro.name.length > 0) {
    lro = await pollOperation(lro.name, headers, signal)
  }
  const projectId = lro.response?.cloudaicompanionProject?.id
  if (typeof projectId === 'string' && projectId.length > 0) return projectId
  if (envProjectId !== undefined && envProjectId.length > 0) return envProjectId
  throw new Error(
    'Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT. See https://goo.gle/gemini-cli-auth-docs#workspace-gca',
  )
}

async function pollOperation(
  operationName: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<LongRunningOperationResponse> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await geminiOAuthInternals.sleep(POLL_INTERVAL_MS, signal)
    const response = await geminiOAuthInternals.fetch(
      `${GOOGLE_GEMINI_CLI_BASE_URL}/v1internal/${operationName}`,
      { method: 'GET', headers, signal: requestSignal(signal) },
    )
    if (!response.ok) {
      throw new Error(`Failed to poll Cloud Code Assist operation: ${response.status}`)
    }
    const data = (await response.json()) as LongRunningOperationResponse
    if (data.done === true) return data
  }
  throw new Error(`Project provisioning did not complete after ${POLL_MAX_ATTEMPTS} attempts`)
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string
  currentTier?: { id?: string }
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>
}

interface LongRunningOperationResponse {
  name?: string
  done?: boolean
  response?: { cloudaicompanionProject?: { id?: string } }
}

function defaultTierId(allowedTiers: LoadCodeAssistPayload['allowedTiers']): string {
  if (allowedTiers === undefined || allowedTiers.length === 0) return TIER_LEGACY
  return allowedTiers.find(tier => tier.isDefault)?.id ?? TIER_LEGACY
}

function isVpcScAffectedUser(errorText: string): boolean {
  return errorText.includes('SECURITY_POLICY_VIOLATED')
}

function workspaceProjectRequired(): Error {
  return new Error(
    'This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca',
  )
}

function parseTokenJson(
  value: unknown,
  endpoint: string,
): { access: string; refresh?: string; expiresIn: number } {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${endpoint} returned an invalid token response`)
  }
  const record = value as Record<string, unknown>
  if (typeof record['access_token'] !== 'string' || record['access_token'].length === 0) {
    throw new Error(`${endpoint} returned no access token`)
  }
  if (typeof record['expires_in'] !== 'number' || !Number.isFinite(record['expires_in'])) {
    throw new Error(`${endpoint} returned no expires_in`)
  }
  if (record['refresh_token'] !== undefined && typeof record['refresh_token'] !== 'string') {
    throw new Error(`${endpoint} returned an invalid refresh token`)
  }
  return {
    access: record['access_token'],
    expiresIn: record['expires_in'],
    ...typeof record['refresh_token'] === 'string' ? { refresh: record['refresh_token'] } : {},
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortedError(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortedError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortedError(signal?: AbortSignal): Error {
  return new Error('Gemini CLI login aborted', { cause: signal?.reason })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      /* v8 ignore start -- Node reports a second close as ERR_SERVER_NOT_RUNNING or no error. */
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error)
        return
      }
      /* v8 ignore stop */
      resolve()
    })
  })
}

interface CallbackResult {
  ok: true
  value: { code: string; state: string }
}

interface CallbackFailure {
  ok: false
  error: Error
}

function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  done: (result: CallbackResult | CallbackFailure) => void,
): void {
  /* v8 ignore next -- IncomingMessage from this HTTP server always has a request URL. */
  const host = request.headers.host ?? `127.0.0.1:${GOOGLE_GEMINI_CLI_CALLBACK_PORT}`
  /* v8 ignore next -- same: Node's HTTP parser supplies `url`. */
  const url = new URL(request.url ?? '/', `http://${host}`)
  if (url.pathname !== GOOGLE_GEMINI_CLI_CALLBACK_PATH) {
    response.writeHead(404)
    response.end()
    return
  }
  const error = url.searchParams.get('error')
  if (error !== null) {
    writeHtml(response, 400, 'Gemini CLI login failed. You can close this tab.')
    done({ ok: false, error: new Error(`Gemini CLI login was denied: ${error}`) })
    return
  }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (code === null || code.length === 0 || state === null || state.length === 0) {
    writeHtml(response, 400, 'Gemini CLI login is missing code or state. You can close this tab.')
    done({ ok: false, error: new Error('Gemini CLI callback is missing code or state') })
    return
  }
  writeHtml(
    response,
    200,
    'Google authorization response received. Return to DeepSeek Harness while Gemini CLI sign-in finishes. You can close this tab.',
  )
  done({ ok: true, value: { code, state } })
}

function writeHtml(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><body><p>${message}</p></body></html>`)
}
