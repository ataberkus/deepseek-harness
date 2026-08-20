/**
 * Fixed Cursor AgentService identifiers. These are protocol constants, not
 * deployment tunables: the unofficial Connect/protobuf backend names them.
 *
 * @module dsh-llm-pi-ai/cursor/constants
 */

/** Provider route key and `CredentialStore` key. */
export const CURSOR_PROVIDER = 'cursor'

/** Selector and Models-page label. */
export const CURSOR_DISPLAY_NAME = 'Cursor'

/** Successful GetUsableModels response contained no usable model rows. */
export const CURSOR_NO_USABLE_MODELS_CODE = 'CURSOR_NO_USABLE_MODELS'

/** Cursor Run closed after heartbeat updates without text, thinking, or tools. */
export const CURSOR_EMPTY_STREAM_CODE = 'CURSOR_EMPTY_STREAM'

/** pi-ai `Model.api` for the hosted Cursor provider. */
export const CURSOR_API = 'cursor-agent'

/** Default AgentService origin. */
export const CURSOR_BASE_URL = 'https://api2.cursor.sh'

/** Browser login page; query carries PKCE challenge and uuid, never tokens. */
export const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'

/** Poll until the browser login completes. */
export const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll'

/** Refresh an access token from a stored refresh token. */
export const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'

/** Connect RPC that streams one agent turn. */
export const CURSOR_RUN_PATH = '/agent.v1.AgentService/Run'

/** Connect RPC that lists models the signed-in account may use. */
export const CURSOR_MODELS_PATH = '/agent.v1.AgentService/GetUsableModels'

/** `x-cursor-client-type` the unofficial CLI clients send. */
export const CURSOR_CLIENT_TYPE = 'cli'

/** `x-cursor-client-version` used by the current Cursor CLI wire protocol. */
export const CURSOR_CLIENT_VERSION = 'cli-2026.07.23-e383d2b'

/** Client heartbeat interval required while a Run stream remains open. */
export const CURSOR_CLIENT_HEARTBEAT_INTERVAL_MS = 5_000
