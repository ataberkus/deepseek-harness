/**
 * Cursor loginDeepControl PKCE poll and token refresh.
 *
 * Flow: open cursor.com/loginDeepControl, poll api2.cursor.sh/auth/poll until
 * tokens arrive, refresh via api2.cursor.sh/auth/exchange_user_api_key. This
 * is not OpenAI localhost PKCE; there is no callback server.
 *
 * @module dsh-llm-pi-ai/cursor/oauth
 */

import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  CURSOR_LOGIN_URL,
  CURSOR_POLL_URL,
  CURSOR_REFRESH_URL,
} from './constants.ts'

/** Injectable HTTP so tests never hit Cursor. */
export const cursorOAuthInternals = {
  /** Resolves `fetch` at call time so `vi.stubGlobal('fetch')` still applies. */
  fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, init)) as typeof fetch,
  /** Delay between poll attempts; tests replace this to avoid waiting. */
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => sleepMs(ms, signal),
  randomUUID: (): string => crypto.randomUUID(),
}

const POLL_MAX_ATTEMPTS = 150
const POLL_BASE_DELAY_MS = 1_000
const POLL_MAX_DELAY_MS = 10_000
const POLL_BACKOFF = 1.2
const AUTH_REQUEST_TIMEOUT_MS = 15_000
const CONSECUTIVE_ERROR_LIMIT = 3

/** PKCE verifier, uuid, and the URL the host must open. */
export interface CursorAuthParams {
  verifier: string
  uuid: string
  loginUrl: string
}

/**
 * Build the loginDeepControl URL. The query carries PKCE challenge and uuid,
 * never tokens.
 * @returns params the poll needs plus the URL to open.
 */
export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  const verifierBytes = new Uint8Array(96)
  crypto.getRandomValues(verifierBytes)
  const verifier = Buffer.from(verifierBytes).toString('base64url')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = Buffer.from(digest).toString('base64url')
  const uuid = cursorOAuthInternals.randomUUID()
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  })
  return { verifier, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}` }
}

/**
 * Poll until the browser login completes or `signal` aborts.
 * @param uuid - pairing id from {@link generateCursorAuthParams}.
 * @param verifier - PKCE verifier from {@link generateCursorAuthParams}.
 * @param signal - aborts the poll, including in-flight fetches.
 * @returns access and refresh tokens.
 */
export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
  let delay = POLL_BASE_DELAY_MS
  let consecutiveErrors = 0
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await cursorOAuthInternals.sleep(delay, signal)
    let response: Response
    try {
      response = await cursorOAuthInternals.fetch(
        `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
        { signal: requestSignal(signal) },
      )
    } catch (error) {
      if (signal?.aborted) throw new Error('Cursor authentication polling aborted', { cause: error })
      consecutiveErrors += 1
      if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
        throw new Error('Too many consecutive errors during Cursor auth polling', { cause: error })
      }
      continue
    }
    if (response.status === 404) {
      consecutiveErrors = 0
      delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS)
      continue
    }
    if (!response.ok) {
      consecutiveErrors += 1
      if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
        throw new Error('Too many consecutive errors during Cursor auth polling', {
          cause: new Error(`Cursor authentication polling failed: ${response.status}`),
        })
      }
      continue
    }
    const tokens = parseTokenResponse(await response.json(), 'Cursor authentication polling')
    if (tokens.refreshToken === undefined) {
      throw new Error('Cursor authentication polling returned no refresh token')
    }
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  }
  throw new Error('Cursor authentication polling timeout')
}

/**
 * Exchange a refresh token for a new access token.
 * @param refreshToken - stored refresh token; never logged.
 * @param signal - aborts the exchange.
 * @returns a canonical OAuth credential.
 */
export async function refreshCursorToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const response = await cursorOAuthInternals.fetch(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: requestSignal(signal),
  })
  if (!response.ok) {
    throw new Error(`Cursor token refresh failed: ${response.status}`)
  }
  const tokens = parseTokenResponse(await response.json(), 'Cursor token refresh')
  return {
    type: 'oauth',
    access: tokens.accessToken,
    refresh: tokens.refreshToken ?? refreshToken,
    expires: tokenExpiry(tokens.accessToken),
  }
}

/**
 * JWT `exp` minus a five-minute skew, or one hour from now when the token is
 * not a JWT. Callers persist this as `OAuthCredential.expires`.
 * @param token - access token; never logged.
 * @returns epoch milliseconds.
 */
export function tokenExpiry(token: string): number {
  try {
    const payload = token.split('.')[1]
    if (payload === undefined) return Date.now() + 3_600_000
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (
      decoded !== null
      && typeof decoded === 'object'
      && 'exp' in decoded
      && typeof decoded.exp === 'number'
    ) {
      return decoded.exp * 1000 - 5 * 60 * 1000
    }
  } catch {
    // Access tokens are not always JWTs; fall through to the one-hour default.
  }
  return Date.now() + 3_600_000
}

function parseTokenResponse(
  value: unknown,
  endpoint: string,
): { accessToken: string; refreshToken?: string } {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${endpoint} returned an invalid token response`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.trim().length === 0) {
    throw new Error(`${endpoint} returned no access token`)
  }
  if (record.refreshToken !== undefined && typeof record.refreshToken !== 'string') {
    throw new Error(`${endpoint} returned an invalid refresh token`)
  }
  return {
    accessToken: record.accessToken,
    ...typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {},
  }
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Cursor authentication polling aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Cursor authentication polling aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
