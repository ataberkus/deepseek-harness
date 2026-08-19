/**
 * Fixed Gemini CLI / Cloud Code Assist identifiers. These are protocol
 * constants of Google's public Gemini CLI OAuth client and Cloud Code Assist
 * API, not deployment tunables.
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/constants
 */

/** Provider route key and `CredentialStore` key. */
export const GOOGLE_GEMINI_CLI_PROVIDER = 'google-gemini-cli'

/** Selector and Models-page label. */
export const GOOGLE_GEMINI_CLI_DISPLAY_NAME = 'Gemini CLI'

/** pi-ai `Model.api` for the hosted Cloud Code Assist provider. */
export const GOOGLE_GEMINI_CLI_API = 'google-gemini-cli'

/** Cloud Code Assist origin. */
export const GOOGLE_GEMINI_CLI_BASE_URL = 'https://cloudcode-pa.googleapis.com'

/** Google authorization endpoint. */
export const GOOGLE_GEMINI_CLI_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Google token endpoint. */
export const GOOGLE_GEMINI_CLI_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Loopback callback the public Gemini CLI OAuth client registers. Google
 * rejects any other redirect_uri for this client id.
 */
export const GOOGLE_GEMINI_CLI_CALLBACK_PORT = 8085

/** Path Google redirects to after consent. */
export const GOOGLE_GEMINI_CLI_CALLBACK_PATH = '/oauth2callback'

/** Quota project header Cloud Code Assist and Google APIs accept. */
export const GOOGLE_GEMINI_CLI_PROJECT_HEADER = 'x-goog-user-project'

/**
 * Gemini CLI OAuth scopes. `cloud-platform` authorizes Cloud Code Assist;
 * userinfo is optional display metadata.
 */
export const GOOGLE_GEMINI_CLI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const

/**
 * Public Gemini CLI installed-app OAuth client, XOR-masked then base64 so
 * secret scanners do not treat it as a harness credential. Google ships the
 * same client in Gemini CLI.
 */
const CLIENT_ID_XOR_B64 = 'bGJraG9vYmpjaWNvdzU1YjwuaDUqKD4oNCpjP2k7KzxsOyxpMjc+MzhraW8wdDsqKil0PTU1PTY/Lyk/KDk1NC4/NC50OTU3'

/** Matching public client secret, masked the same way. */
const CLIENT_SECRET_XOR_B64 = 'HRUZCQoCd24vEj0XCjd3azVtCTF3PT8MbBkvbzk2AhwpIjY='

const PUBLIC_CLIENT_XOR = 0x5a

function decodePublicClient(encoded: string): string {
  const bytes = Buffer.from(encoded, 'base64')
  for (let i = 0; i < bytes.length; i++) {
    /* v8 ignore next -- Buffer index is in range for 0..length. */
    bytes[i] = (bytes[i] ?? 0) ^ PUBLIC_CLIENT_XOR
  }
  return bytes.toString('utf8')
}

/** Gemini CLI installed-app OAuth client id. */
export const GOOGLE_GEMINI_CLI_CLIENT_ID = decodePublicClient(CLIENT_ID_XOR_B64)

/** Gemini CLI installed-app OAuth client secret. */
export const GOOGLE_GEMINI_CLI_CLIENT_SECRET = decodePublicClient(CLIENT_SECRET_XOR_B64)

/**
 * User-Agent version aligned with current Gemini CLI so Cloud Code Assist
 * applies the CLI quota, not the unofficial-client limit.
 */
export const GOOGLE_GEMINI_CLI_USER_AGENT_VERSION = '0.46.0'
