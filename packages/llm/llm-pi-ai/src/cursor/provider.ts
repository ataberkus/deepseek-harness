/**
 * Hosted Cursor pi-ai Provider: poll OAuth plus AgentService streamSimple.
 *
 * Not an installed pi-ai catalog provider. `auth.apiKey` is absent so the
 * Models directory still withholds a key card. Tokens persist in the same
 * FileOAuthStore as Codex. The unofficial Connect/protobuf backend is owned
 * here; Cursor-native exec/MCP is not.
 *
 * @module dsh-llm-pi-ai/cursor/provider
 */

import type {
  AuthInteraction,
  ModelAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import {
  CURSOR_BASE_URL,
  CURSOR_DISPLAY_NAME,
  CURSOR_PROVIDER,
} from './constants.ts'
import { cursorFallbackModels } from './models.ts'
import { generateCursorAuthParams, pollCursorAuth, refreshCursorToken, tokenExpiry } from './oauth.ts'
import { streamCursor } from './stream.ts'

let memoized: Provider | undefined

/**
 * The memoized hosted Cursor provider. Spies on `auth.oauth.login` need a
 * stable object across `/login cursor` tests.
 * @returns the Cursor provider.
 */
export function cursorProvider(): Provider {
  memoized ??= createCursorProvider()
  return memoized
}

/**
 * Build a Cursor provider. Prefer {@link cursorProvider} so login spies stick.
 * @returns a new provider instance.
 */
export function createCursorProvider(): Provider {
  return {
    id: CURSOR_PROVIDER,
    name: CURSOR_DISPLAY_NAME,
    baseUrl: CURSOR_BASE_URL,
    auth: {
      oauth: {
        name: CURSOR_DISPLAY_NAME,
        login: loginCursor,
        refresh: refreshCursor,
        toAuth: toCursorAuth,
      },
    },
    getModels: cursorFallbackModels,
    stream: streamCursor,
    streamSimple: streamCursor,
  }
}

/**
 * Open loginDeepControl, then poll until tokens arrive. Does not prompt
 * `select` or `manual_code`; the host interaction opens `auth_url`.
 * @param interaction - host callbacks; `signal` aborts the poll.
 * @returns the stored OAuth credential.
 */
export async function loginCursor(interaction: AuthInteraction): Promise<OAuthCredential> {
  const params = await generateCursorAuthParams()
  interaction.notify({ type: 'auth_url', url: params.loginUrl })
  const tokens = await pollCursorAuth(params.uuid, params.verifier, interaction.signal)
  return {
    type: 'oauth',
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: tokenExpiry(tokens.accessToken),
  }
}

/**
 * Exchange the stored refresh token.
 * @param credential - current OAuth credential.
 * @param signal - abort the exchange.
 * @returns a credential with a new access token.
 */
export async function refreshCursor(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  return refreshCursorToken(credential.refresh, signal)
}

/**
 * Request auth from a stored Cursor credential.
 * @param credential - access token source; never logged.
 * @returns bearer headers Models merges into the stream options.
 */
export function toCursorAuth(credential: OAuthCredential): Promise<ModelAuth> {
  return Promise.resolve({ headers: { authorization: `Bearer ${credential.access}` } })
}
