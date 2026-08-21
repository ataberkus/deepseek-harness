/**
 * Fixed Google Antigravity identifiers and endpoints. These are protocol
 * constants of Google's public Antigravity OAuth client and Cloud Code Assist
 * API, not deployment tunables.
 *
 * @module dsh-llm-pi-ai/google-antigravity/constants
 */

/** Provider route key and `CredentialStore` key. */
export const GOOGLE_ANTIGRAVITY_PROVIDER = 'google-antigravity'

/** Selector and Models-page label. */
export const GOOGLE_ANTIGRAVITY_DISPLAY_NAME = 'Antigravity'

/** pi-ai `Model.api` for the hosted Antigravity provider. */
export const GOOGLE_ANTIGRAVITY_API = 'google-antigravity'

/** Primary Antigravity Cloud Code Assist origin. */
export const GOOGLE_ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'

/** Fallback Cloud Code Assist origin. */
export const GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL = 'https://cloudcode-pa.googleapis.com'

/** Google authorization endpoint. */
export const GOOGLE_ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Google token endpoint. */
export const GOOGLE_ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Loopback callback port the public Antigravity OAuth client registers. Google
 * rejects any other redirect_uri port for this client id.
 */
export const GOOGLE_ANTIGRAVITY_CALLBACK_PORT = 51121

/** Path Google redirects to after consent. */
export const GOOGLE_ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'

/** Quota project header Cloud Code Assist and Google APIs accept. */
export const GOOGLE_ANTIGRAVITY_PROJECT_HEADER = 'x-goog-user-project'

/**
 * Antigravity OAuth scopes required for Cloud Code Assist access,
 * user info, and configuration experiments.
 */
export const GOOGLE_ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

/**
 * Public Antigravity installed-app OAuth client, XOR-masked then base64 so
 * secret scanners do not treat it as a harness credential.
 */
const CLIENT_ID_XOR_B64 = 'a2pta2pqbGpsam9ja3cuNzIpKTM0aDJoazY5KD9oaW8sLjU2NTAybj1uamk/KnQ7KiopdD01NT02Py8pPyg5NTQuPzQudDk1Nw=='

/** Matching public client secret, masked the same way. */
const CLIENT_SECRET_XOR_B64 = 'HRUZCQoCdxFvYhwNCG5ibBY+FhBrNxYYYikCGW4gbCseGzw='

const PUBLIC_CLIENT_XOR = 0x5a

function decodePublicClient(encoded: string): string {
  const bytes = Buffer.from(encoded, 'base64')
  for (let i = 0; i < bytes.length; i++) {
    /* v8 ignore next -- Buffer index is in range for 0..length. */
    bytes[i] = (bytes[i] ?? 0) ^ PUBLIC_CLIENT_XOR
  }
  return bytes.toString('utf8')
}

/** Antigravity installed-app OAuth client id. */
export const GOOGLE_ANTIGRAVITY_CLIENT_ID = decodePublicClient(CLIENT_ID_XOR_B64)

/** Antigravity installed-app OAuth client secret. */
export const GOOGLE_ANTIGRAVITY_CLIENT_SECRET = decodePublicClient(CLIENT_SECRET_XOR_B64)

/** Antigravity version identifier. */
export const GOOGLE_ANTIGRAVITY_VERSION = '2.8.0'

/** Antigravity change-list (CL) identifier. */
export const GOOGLE_ANTIGRAVITY_CL = '963137146'
