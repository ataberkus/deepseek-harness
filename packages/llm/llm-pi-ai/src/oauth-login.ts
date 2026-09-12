/**
 * Provider-managed login for `openai-codex` (pi-ai browser PKCE), `cursor`
 * (loginDeepControl poll), and `google-antigravity` (Google auth-code on
 * 127.0.0.1:51121), plus the OpenCode Go API-key method. All persist in
 * {@link FileOAuthStore}.
 *
 * Codex keeps {@link createBrowserOAuthInteraction}: always choose browser
 * login, open the authorize URL, hang the manual-code prompt until the
 * localhost callback aborts it. Cursor and Gemini CLI notify `auth_url` and
 * wait; they never prompt `select` or `manual_code`, so the same interaction
 * only opens the URL.
 *
 * @module dsh-llm-pi-ai/oauth-login
 */

import { spawn } from 'node:child_process'
import { release as osRelease } from 'node:os'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthInteraction, AuthPrompt, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'
import type { PiAiProviderProfile } from './config.ts'
import {
  hostedOAuthProvider,
  OAUTH_COMMAND_HINT,
  OAUTH_LOGIN_IN_PROGRESS,
  OAUTH_LOGIN_UNSUPPORTED,
  OAUTH_LOGOUT_UNSUPPORTED,
  OPENAI_CODEX_PROVIDER,
  parseOAuthProvider,
} from './oauth-hosts.ts'
import type { FileOAuthStore } from './oauth-store.ts'

export {
  hostedOAuthProvider,
  hostedOAuthProviders,
  OAUTH_COMMAND_HINT,
  OAUTH_LOGIN_IN_PROGRESS,
  OAUTH_LOGIN_UNSUPPORTED,
  OAUTH_LOGOUT_UNSUPPORTED,
  OPENAI_CODEX_DISPLAY_NAME,
  OPENAI_CODEX_PROVIDER,
  parseOAuthProvider,
} from './oauth-hosts.ts'
export { CURSOR_DISPLAY_NAME, CURSOR_PROVIDER } from './cursor/constants.ts'
export {
  GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
  GOOGLE_ANTIGRAVITY_PROVIDER,
} from './google-antigravity/constants.ts'
/** pi-ai's browser login method id for OpenAI Codex. */
export const OPENAI_CODEX_BROWSER_LOGIN_METHOD = 'browser'
/** pi-ai provider id for OpenCode Go. */
export const OPENCODE_GO_PROVIDER = 'opencode-go'
/** Human-readable OpenCode Go provider name. */
export const OPENCODE_GO_DISPLAY_NAME = 'OpenCode Go'


/**
 * Settings-free profiles for OAuth credentials this host persists.
 *
 * Only hosted table ids (`openai-codex`, `cursor`, `google-antigravity`) are
 * injected: other catalog providers that offer OAuth beside an api-key method
 * stay on the key path the Models page already configures. Settings profiles
 * @param infos - non-secret store listing.
 * @returns a providers dict suitable for {@link resolveProfiles}.
 */
export function oauthProviderProfiles(
  infos: readonly CredentialInfo[],
): Record<string, PiAiProviderProfile> {
  const profiles: Record<string, PiAiProviderProfile> = {}
  for (const info of infos) {
    if (info.type !== 'oauth') continue
    const host = hostedOAuthProvider(info.providerId)
    if (host === undefined) continue
    profiles[host.id] = {
      displayName: catalogProvider(host.id)?.name ?? host.displayName,
    }
  }
  return profiles
}

/**
 * Settings-free profiles for supported API-key logins this host persists.
 * @param infos - non-secret store listing.
 * @returns a providers dict suitable for {@link resolveProfiles}.
 */
export function apiKeyProviderProfiles(
  infos: readonly CredentialInfo[],
): Record<string, PiAiProviderProfile> {
  return infos.some(info => info.providerId === OPENCODE_GO_PROVIDER && info.type === 'api_key')
    ? { [OPENCODE_GO_PROVIDER]: { displayName: OPENCODE_GO_DISPLAY_NAME } }
    : {}
}

/** Injectable platform facts so tests do not depend on the host OS. */
export interface BrowserOpenInternals {
  /** `process.platform` override. */
  platform?: NodeJS.Platform
  /** Kernel release override used to distinguish WSL from desktop Linux. */
  osRelease?: string
  /** Environment used for WSL markers. */
  env?: NodeJS.ProcessEnv
}

/** Whether one environment marker is set to a non-empty value. */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/** Distinguish WSL from desktop Linux using its process and kernel markers. */
function isWsl(internals: BrowserOpenInternals): boolean {
  const env = internals.env ?? process.env
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true
  return (internals.osRelease ?? osRelease()).toLowerCase().includes('microsoft')
}

/**
 * Platform browser-helper argv for `url`.
 *
 * The authorize URL's query string must stay one argument. `cmd /c start`
 * splits on `&`, which drops `client_id` and the remaining OAuth query and
 * makes OpenAI render `missing_required_parameter`. Windows and WSL use
 * `rundll32` so the query string is never a cmd command line.
 * @param url - the authorize URL pi-ai emitted.
 * @param internals - platform and environment overrides for tests.
 * @returns the helper command and argv.
 */
export function browserOpenArgv(
  url: string,
  internals: BrowserOpenInternals = {},
): { command: string; args: readonly string[] } {
  const platform = internals.platform ?? process.platform
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32' || (platform === 'linux' && isWsl(internals))) {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Stderr instructions when the opened tab is the authorize URL with a
 * truncated query. The URL carries PKCE challenge and state, never tokens.
 * @param url - the authorize URL pi-ai emitted.
 * @returns the diagnostic including a trailing newline.
 */
export function authUrlFallbackMessage(url: string): string {
  return `If the login page reports a missing parameter, paste this entire URL into the address bar (do not click a line-wrapped terminal link):\n${url}\n`
}

/**
 * Open `url` with the platform browser helper. The child is detached so a
 * hanging helper cannot pin the login command.
 * @param url - the authorize URL pi-ai emitted.
 * @param internals - platform and environment overrides for tests.
 */
export async function openUrl(url: string, internals: BrowserOpenInternals = {}): Promise<void> {
  const { command, args } = browserOpenArgv(url, internals)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore', detached: true, windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
/**
 * Forward one authorize URL to `commands/open-url` subscribers (the web and
 * desktop login tab) and run every listener inline, as Cordis emit dispatch
 * does. Callers keep the answer to decide whether the host browser opener
 * must still run for listener-less compositions like plain CLI.
 * @param emit - dispatches `['commands/open-url', url]` and answers the subscribed listeners.
 * @param url - the authorize URL pi-ai emitted.
 * @returns whether any subscriber received the URL.
 */
export function emitOAuthOpenUrl(emit: (url: string) => unknown, url: string): boolean {
  const listeners = emit(url) as Array<(authUrl: string) => unknown>
  for (const listener of listeners) listener(url)
  return listeners.length > 0
}

/** Dependencies for {@link createBrowserOAuthInteraction}. */
export interface BrowserOAuthInteractionOptions {
  /** Open the authorize URL; defaults to {@link openUrl}. */
  openUrl?: (url: string) => Promise<void>
  /** Aborts the whole login, including a hanging manual-code prompt. */
  signal?: AbortSignal
  /** Write the authorize URL for paste recovery; defaults to stderr. */
  writeAuthUrl?: (url: string) => void
}

/**
 * Auth interaction that always selects browser login, opens the authorize
 * URL, and hangs the manual-code prompt until pi-ai's localhost callback
 * aborts it. Device-code login is not offered.
 * @param options - optional URL opener, abort signal, and authorize-URL writer.
 * @returns the interaction pi-ai's `Models.login` drives.
 */
export function createBrowserOAuthInteraction(
  options: BrowserOAuthInteractionOptions = {},
): AuthInteraction {
  const open = options.openUrl ?? openUrl
  const writeAuthUrl = options.writeAuthUrl ?? ((url: string) => {
    process.stderr.write(authUrlFallbackMessage(url))
  })
  let openError: Error | undefined
  let cancelManual: ((reason: unknown) => void) | undefined
  const interaction: AuthInteraction = {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      switch (prompt.type) {
        case 'select':
          if (!prompt.options.some(option => option.id === OPENAI_CODEX_BROWSER_LOGIN_METHOD)) {
            throw new Error('openai-codex login only supports browser OAuth in this build')
          }
          return OPENAI_CODEX_BROWSER_LOGIN_METHOD
        case 'manual_code': {
          if (openError !== undefined) throw openError
          const signal = prompt.signal
          return await new Promise<string>((_resolve, reject) => {
            const fail = (reason: unknown): void => {
              reject(reason instanceof Error ? reason : new Error('Login cancelled'))
            }
            cancelManual = fail
            if (signal?.aborted) {
              fail(signal.reason)
              return
            }
            if (options.signal?.aborted) {
              fail(options.signal.reason)
              return
            }
            signal?.addEventListener('abort', () =>{  fail(signal.reason) }, { once: true })
            options.signal?.addEventListener('abort', () =>{  fail(options.signal?.reason) }, { once: true })
          })
        }
        default:
          throw new Error(
            `openai-codex login does not support ${prompt.type} prompts; use browser OAuth`,
          )
      }
    },
    notify: (event: AuthEvent): void => {
      if (event.type !== 'auth_url') return
      writeAuthUrl(event.url)
      void open(event.url).catch((error: unknown) => {
        openError = error instanceof Error ? error : new Error('Failed to open the login page')
        cancelManual?.(openError)
      })
    },
  }
  if (options.signal !== undefined) interaction.signal = options.signal
  return interaction
}

/**
 * Logins in flight keyed by their credential store. One plugin instance owns
 * one store, so a `/login` line and a Models-page Connect click racing at the
 * same store share this guard instead of opening two browser flows at it.
 */
const loginFlightByStore = new WeakMap<CredentialStore, boolean>()

/** Run one provider login under the credential store's single-flight guard. */
async function withLoginFlight(store: CredentialStore, operation: () => Promise<void>): Promise<void> {
  if (loginFlightByStore.get(store) === true) {
    throw new Error(OAUTH_LOGIN_IN_PROGRESS)
  }
  loginFlightByStore.set(store, true)
  try {
    await operation()
  } finally {
    loginFlightByStore.delete(store)
  }
}

/**
 * Run hosted OAuth login against `store` and persist the credential.
 * @param id - hosted provider id (`openai-codex`, `cursor`, or `google-antigravity`).
 * @param store - the host credential store passed to `createModels`.
 * @param interaction - host {@link AuthInteraction}; Codex hangs `manual_code`, Cursor and Antigravity only need `auth_url`.
 */
export async function loginHostedOAuth(
  id: string,
  store: CredentialStore,
  interaction: AuthInteraction,
): Promise<void> {
  await withLoginFlight(store, async () => {
    const provider = catalogProvider(id)
    if (provider === undefined) {
      throw new Error(`llm-pi-ai: hosted catalog does not ship ${id}`)
    }
    if (provider.auth.oauth === undefined) {
      throw new Error(`llm-pi-ai: provider "${id}" does not offer OAuth`)
    }
    const models = createModels({ credentials: store })
    models.setProvider(provider)
    await models.login(id, 'oauth', interaction)
  })
}

/**
 * Persist an OpenCode Go key through pi-ai's provider-owned API-key method.
 * @param store - the host credential store passed to `createModels`.
 * @param apiKey - secret received from the login surface.
 * @param signal - caller cancellation.
 */
export async function loginOpenCodeGo(
  store: CredentialStore,
  apiKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const key = assertUsableApiKey(apiKey, 'llm-pi-ai', 'OpenCode Go API-key login')
  await withLoginFlight(store, async () => {
    const provider = catalogProvider(OPENCODE_GO_PROVIDER)
    if (provider === undefined) {
      throw new Error(`llm-pi-ai: hosted catalog does not ship ${OPENCODE_GO_PROVIDER}`)
    }
    if (provider.auth.apiKey === undefined) {
      throw new Error(`llm-pi-ai: provider "${OPENCODE_GO_PROVIDER}" does not offer API-key login`)
    }
    const interaction: AuthInteraction = {
      prompt: (prompt): Promise<string> => {
        if (prompt.type !== 'secret') {
          throw new Error(`OpenCode Go API-key login does not support ${prompt.type} prompts`)
        }
        return Promise.resolve(key)
      },
      notify: () => undefined,
      ...signal === undefined ? {} : { signal },
    }
    const models = createModels({ credentials: store })
    models.setProvider(provider)
    await models.login(OPENCODE_GO_PROVIDER, 'api_key', interaction)
  })
}

/**
 * Run pi-ai's Codex OAuth login against `store` and persist the credential.
 * @param store - the host credential store passed to `createModels`.
 * @param interaction - browser-only {@link AuthInteraction}.
 */
export async function loginOpenaiCodex(
  store: CredentialStore,
  interaction: AuthInteraction,
): Promise<void> {
  await loginHostedOAuth(OPENAI_CODEX_PROVIDER, store, interaction)
}

/** Command registration hooks after a credential write. */
export interface OAuthCommandDeps {
  /** Persistent store the login writes and logout deletes. */
  store: FileOAuthStore
  /** Re-register live adapter routes after login or logout. */
  onCredentialChange: () => void
}

/**
 * Register `/login` and `/logout` once a command registry is composed.
 * @param ctx - plugin context; the command child activates only with `commands`.
 * @param deps - store and route-refresh hook.
 */
export function registerOAuthCommands(ctx: Context, deps: OAuthCommandDeps): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'login',
      description: 'Sign in to OpenAI Codex, Cursor, or Antigravity',
      input: { hint: OAUTH_COMMAND_HINT },
      handler: async ({ rawInput, signal }) => {
        const provider = parseOAuthProvider(rawInput)
        if (provider === undefined) {
          return { kind: 'error', text: OAUTH_LOGIN_UNSUPPORTED }
        }
        const host = hostedOAuthProvider(provider)
        if (host === undefined) {
          return { kind: 'error', text: OAUTH_LOGIN_UNSUPPORTED }
        }
        try {
          // Web subscribers open the gesture-owned tab; CLI has no subscriber and uses the host opener.
          let browserEventDelivered = false
          await loginHostedOAuth(provider, deps.store, createBrowserOAuthInteraction({
            signal,
            openUrl: async (url) => {
              if (browserEventDelivered) return
              await openUrl(url)
            },
            writeAuthUrl: (url) => {
              browserEventDelivered = emitOAuthOpenUrl(
                authUrl => commandCtx.events.dispatch('emit', ['commands/open-url', authUrl]),
                url,
              )
              process.stderr.write(authUrlFallbackMessage(url))
            },
          }))
          deps.onCredentialChange()
          return { kind: 'success', text: host.signedIn }
        } catch (error) {
          return { kind: 'error', text: commandFailure(error, host.loginFailed) }
        }
      },
    })
    commandCtx.commands.register({
      name: 'logout',
      description: 'Sign out of OpenAI Codex, Cursor, or Antigravity',
      handler: async ({ rawInput }) => {
        const provider = parseOAuthProvider(rawInput)
        if (provider === undefined) {
          return { kind: 'error', text: OAUTH_LOGOUT_UNSUPPORTED }
        }
        try {
          return { kind: 'success', text: await logoutHostedOAuth(provider, deps) }
        } catch (error) {
          const host = hostedOAuthProvider(provider)
          return { kind: 'error', text: commandFailure(error, host?.logoutFailed ?? OAUTH_LOGOUT_UNSUPPORTED) }
        }
      },
    })
  })
}

/**
 * Delete the hosted OAuth credential for one table id and refresh live routes.
 * @param provider - `openai-codex`, `cursor`, or `google-antigravity`.
 * @param deps - store and route-refresh hook.
 * @returns the signed-out success text.
 */
export async function logoutHostedOAuth(provider: string, deps: OAuthCommandDeps): Promise<string> {
  const host = hostedOAuthProvider(provider)
  if (host === undefined) {
    throw new Error(OAUTH_LOGOUT_UNSUPPORTED)
  }
  await deps.store.delete(provider)
  deps.onCredentialChange()
  return host.signedOut
}

/**
 * Delete a credential-backed route managed outside settings and refresh live routes.
 * @param provider - supported OAuth provider id or `opencode-go`.
 * @param deps - store and route-refresh hook.
 */
export async function logoutManagedLogin(provider: string, deps: OAuthCommandDeps): Promise<void> {
  if (provider !== OPENCODE_GO_PROVIDER && hostedOAuthProvider(provider) === undefined) {
    throw new Error(`llm-pi-ai: provider "${provider}" does not support managed logout`)
  }
  await deps.store.delete(provider)
  deps.onCredentialChange()
}
/**
 * Render a login/logout failure without assuming the value is safe to
 * stringify as a secret. Shared by the `/login` command and the Models-page
 * remote sign-in, which report through different carriers.
 * @param error - rejected value to inspect without stringifying arbitrary data.
 * @param fallback - message used when the rejection has no non-empty Error message.
 * @returns the safe diagnostic for the command or Remote carrier.
 */
export function commandFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}
