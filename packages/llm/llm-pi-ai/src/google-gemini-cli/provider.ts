/**
 * Hosted Gemini CLI pi-ai Provider: Google auth-code OAuth plus Cloud Code
 * Assist streamSimple.
 *
 * Not an installed pi-ai catalog provider. `auth.apiKey` is absent so the
 * Models directory still withholds a key card. Tokens persist in the same
 * FileOAuthStore as Codex and Cursor. The unofficial Cloud Code Assist
 * backend is owned here; Gemini CLI exec is not.
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/provider
 */

import type {
  AuthInteraction,
  ModelAuth,
  OAuthCredential,
  Provider,
} from '@earendil-works/pi-ai'
import {
  GOOGLE_GEMINI_CLI_BASE_URL,
  GOOGLE_GEMINI_CLI_DISPLAY_NAME,
  GOOGLE_GEMINI_CLI_PROJECT_HEADER,
  GOOGLE_GEMINI_CLI_PROVIDER,
} from './constants.ts'
import { geminiCliFallbackModels } from './models.ts'
import {
  completeGeminiLogin,
  geminiAuthorizeUrl,
  geminiOAuthInternals,
  geminiProjectId,
  refreshGeminiToken,
} from './oauth.ts'
import { streamGeminiCli } from './stream.ts'

let memoized: Provider | undefined

/**
 * The memoized hosted Gemini CLI provider. Spies on `auth.oauth.login` need a
 * stable object across `/login google-gemini-cli` tests.
 * @returns the Gemini CLI provider.
 */
export function geminiCliProvider(): Provider {
  memoized ??= createGeminiCliProvider()
  return memoized
}

/**
 * Build a Gemini CLI provider. Prefer {@link geminiCliProvider} so login spies stick.
 * @returns a new provider instance.
 */
export function createGeminiCliProvider(): Provider {
  return {
    id: GOOGLE_GEMINI_CLI_PROVIDER,
    name: GOOGLE_GEMINI_CLI_DISPLAY_NAME,
    baseUrl: GOOGLE_GEMINI_CLI_BASE_URL,
    auth: {
      oauth: {
        name: GOOGLE_GEMINI_CLI_DISPLAY_NAME,
        login: loginGeminiCli,
        refresh: refreshGeminiCli,
        toAuth: toGeminiCliAuth,
      },
    },
    getModels: geminiCliFallbackModels,
    stream: streamGeminiCli,
    streamSimple: streamGeminiCli,
  }
}

/**
 * Open Google consent, wait for the loopback code, exchange it, and discover
 * a Cloud Code Assist project. Does not prompt `select` or `manual_code`.
 * @param interaction - host callbacks; `signal` aborts the callback wait.
 * @returns the stored OAuth credential including `projectId`.
 */
export async function loginGeminiCli(interaction: AuthInteraction): Promise<OAuthCredential> {
  const server = await geminiOAuthInternals.createCallbackServer()
  try {
    const state = geminiOAuthInternals.randomState()
    interaction.notify({ type: 'auth_url', url: geminiAuthorizeUrl(server.redirectUri, state) })
    const callback = await server.wait(interaction.signal)
    if (callback.state !== state) {
      throw new Error('Gemini CLI login state mismatch')
    }
    return await completeGeminiLogin(callback.code, server.redirectUri, interaction.signal)
  } finally {
    await server.close()
  }
}

/**
 * Exchange the stored refresh token, keeping `projectId`.
 * @param credential - current OAuth credential.
 * @param signal - abort the exchange.
 * @returns a credential with a new access token.
 */
export async function refreshGeminiCli(
  credential: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  return refreshGeminiToken(credential, signal)
}

/**
 * Request auth from a stored Gemini CLI credential.
 * @param credential - access token and `projectId` source; never logged.
 * @returns bearer and quota-project headers Models merges into stream options.
 */
export async function toGeminiCliAuth(credential: OAuthCredential): Promise<ModelAuth> {
  const projectId = geminiProjectId(credential)
  if (projectId === undefined) {
    throw new Error('Gemini CLI OAuth credential is missing projectId; run /login google-gemini-cli again')
  }
  return {
    headers: {
      authorization: `Bearer ${credential.access}`,
      [GOOGLE_GEMINI_CLI_PROJECT_HEADER]: projectId,
    },
  }
}
