/**
 * Hosted Antigravity pi-ai Provider: Google auth-code OAuth plus Cloud Code
 * Assist SSE streaming.
 *
 * @module dsh-llm-pi-ai/google-antigravity/provider
 */

import { randomBytes } from 'node:crypto'
import type {
  AuthInteraction,
  ModelAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import {
  GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
  GOOGLE_ANTIGRAVITY_PROJECT_HEADER,
  GOOGLE_ANTIGRAVITY_PROVIDER,
} from './constants.ts'
import { antigravityFallbackModels } from './models.ts'
import {
  antigravityAuthorizeUrl,
  antigravityOAuthInternals,
  antigravityProjectId,
  completeAntigravityLogin,
  refreshAntigravityToken,
} from './oauth.ts'
import { streamAntigravity } from './stream.ts'

let memoized: Provider | undefined

/**
 * The memoized hosted Antigravity provider. Spies on `auth.oauth.login` need a
 * stable object across `/login google-antigravity` tests.
 * @returns the Antigravity provider.
 */
export function antigravityProvider(): Provider {
  if (memoized === undefined) memoized = createAntigravityProvider()
  return memoized
}

/**
 * Build an Antigravity provider. Prefer {@link antigravityProvider} so login spies stick.
 * @returns a new provider instance.
 */
export function createAntigravityProvider(): Provider {
  return {
    id: GOOGLE_ANTIGRAVITY_PROVIDER,
    name: GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
    stream: streamAntigravity,
    streamSimple: streamAntigravity,
    getModels: antigravityFallbackModels,
    auth: {
      oauth: {
        name: GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
        login: loginAntigravity,
        refresh: refreshAntigravity,
        toAuth: toAntigravityAuth,
      },
    },
  }
}

/**
 * Open Google consent, wait for the loopback code, exchange it, and discover
 * or provision an Antigravity Cloud Code Assist project.
 * @param interaction - host UI interaction opening the authorize URL.
 * @returns ready-to-store credential with `projectId`.
 */
export async function loginAntigravity(interaction: AuthInteraction): Promise<OAuthCredential> {
  const server = await antigravityOAuthInternals.createLoopbackServer()
  try {
    const state = randomBytes(16).toString('hex')
    const authorizeUrl = antigravityAuthorizeUrl(server.redirectUri, state)
    interaction.notify({
      type: 'auth_url',
      url: authorizeUrl,
      instructions: 'Complete sign-in in your browser.',
    })
    const code = await server.waitForCallback(interaction.signal)
    return await completeAntigravityLogin(code, server.redirectUri, interaction.signal)
  } finally {
    await server.close()
  }
}

/**
 * Exchange the stored refresh token, keeping `projectId`.
 * @param credential - stored Antigravity credential.
 * @param signal - optional abort signal.
 * @returns renewed credential.
 */
export async function refreshAntigravity(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  return refreshAntigravityToken(credential, signal)
}

/**
 * Request auth from a stored Antigravity credential.
 * @param credential - access token and `projectId` source; never logged.
 * @returns bearer and quota-project headers Models merges into stream options.
 */
export async function toAntigravityAuth(credential: OAuthCredential): Promise<ModelAuth> {
  const projectId = antigravityProjectId(credential)
  if (projectId === undefined) {
    throw new Error('Antigravity OAuth credential is missing projectId; run /login google-antigravity again')
  }
  return {
    headers: {
      Authorization: `Bearer ${credential.access}`,
      [GOOGLE_ANTIGRAVITY_PROJECT_HEADER]: projectId,
    },
  }
}
