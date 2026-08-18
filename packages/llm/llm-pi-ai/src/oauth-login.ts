/**
 * Browser PKCE login for the installed `openai-codex` catalog provider.
 *
 * pi-ai owns the OAuth client, localhost callback, token exchange, and
 * refresh. This module supplies the host interaction (always choose browser
 * login, open the authorize URL, hang the manual-code prompt until the
 * callback aborts it) and the synthetic settings-free profile that registers
 * the route after a credential is stored.
 *
 * @module dsh-llm-pi-ai/oauth-login
 */

import { spawn } from 'node:child_process'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthInteraction, AuthPrompt, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { catalogProvider } from './catalog.ts'
import type { PiAiProviderProfile } from './config.ts'
import type { FileOAuthStore } from './oauth-store.ts'

/** Installed pi-ai provider id for ChatGPT Codex subscription auth. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Fallback display name when the catalog provider is unavailable. */
export const OPENAI_CODEX_DISPLAY_NAME = 'OpenAI Codex'

/** pi-ai's browser login method id for OpenAI Codex. */
export const OPENAI_CODEX_BROWSER_LOGIN_METHOD = 'browser'

/**
 * Settings-free profiles for OAuth credentials this host persists.
 *
 * Only `openai-codex` is injected: other catalog providers that offer OAuth
 * beside an api-key method stay on the key path the Models page already
 * configures. Settings profiles for the same route win at merge time.
 * @param infos - non-secret store listing.
 * @returns a providers dict suitable for {@link resolveProfiles}.
 */
export function oauthProviderProfiles(
  infos: readonly CredentialInfo[],
): Record<string, PiAiProviderProfile> {
  const profiles: Record<string, PiAiProviderProfile> = {}
  for (const info of infos) {
    if (info.providerId !== OPENAI_CODEX_PROVIDER || info.type !== 'oauth') continue
    profiles[OPENAI_CODEX_PROVIDER] = {
      displayName: catalogProvider(OPENAI_CODEX_PROVIDER)?.name ?? OPENAI_CODEX_DISPLAY_NAME,
    }
  }
  return profiles
}

/**
 * Open `url` with the platform browser helper. The child is detached so a
 * hanging helper cannot pin the login command.
 * @param url - the authorize URL pi-ai emitted.
 */
export async function openUrl(url: string): Promise<void> {
  const { command, args } = process.platform === 'darwin'
    ? { command: 'open', args: [url] }
    : process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'start', '', url] }
      : { command: 'xdg-open', args: [url] }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Dependencies for {@link createBrowserOAuthInteraction}. */
export interface BrowserOAuthInteractionOptions {
  /** Open the authorize URL; defaults to {@link openUrl}. */
  openUrl?: (url: string) => Promise<void>
  /** Aborts the whole login, including a hanging manual-code prompt. */
  signal?: AbortSignal
}

/**
 * Auth interaction that always selects browser login, opens the authorize
 * URL, and hangs the manual-code prompt until pi-ai's localhost callback
 * aborts it. Device-code login is not offered.
 * @param options - optional URL opener and abort signal.
 * @returns the interaction pi-ai's `Models.login` drives.
 */
export function createBrowserOAuthInteraction(
  options: BrowserOAuthInteractionOptions = {},
): AuthInteraction {
  const open = options.openUrl ?? openUrl
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
            signal?.addEventListener('abort', () => fail(signal.reason), { once: true })
            options.signal?.addEventListener('abort', () => fail(options.signal?.reason), { once: true })
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
 * Run pi-ai's Codex OAuth login against `store` and persist the credential.
 * @param store - the host credential store passed to `createModels`.
 * @param interaction - browser-only {@link AuthInteraction}.
 */
export async function loginOpenaiCodex(
  store: CredentialStore,
  interaction: AuthInteraction,
): Promise<void> {
  const provider = catalogProvider(OPENAI_CODEX_PROVIDER)
  if (provider === undefined) {
    throw new Error('llm-pi-ai: installed catalog does not ship openai-codex')
  }
  const models = createModels({ credentials: store })
  models.setProvider(provider)
  await models.login(OPENAI_CODEX_PROVIDER, 'oauth', interaction)
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
      description: 'Sign in to OpenAI Codex with ChatGPT',
      input: { hint: '[openai-codex]' },
      handler: async ({ rawInput, signal }) => {
        const provider = parseOAuthProvider(rawInput)
        if (provider === undefined) {
          return { kind: 'error', text: 'Only /login openai-codex is supported.' }
        }
        try {
          await loginOpenaiCodex(deps.store, createBrowserOAuthInteraction({ signal }))
          deps.onCredentialChange()
          return {
            kind: 'success',
            text: 'Signed in to OpenAI Codex. Select an openai-codex model to use the ChatGPT Codex subscription.',
          }
        } catch (error) {
          return { kind: 'error', text: commandFailure(error, 'OpenAI Codex login failed') }
        }
      },
    })
    commandCtx.commands.register({
      name: 'logout',
      description: 'Sign out of OpenAI Codex',
      input: { hint: '[openai-codex]' },
      handler: async ({ rawInput }) => {
        const provider = parseOAuthProvider(rawInput)
        if (provider === undefined) {
          return { kind: 'error', text: 'Only /logout openai-codex is supported.' }
        }
        try {
          await deps.store.delete(OPENAI_CODEX_PROVIDER)
          deps.onCredentialChange()
          return { kind: 'success', text: 'Signed out of OpenAI Codex.' }
        } catch (error) {
          return { kind: 'error', text: commandFailure(error, 'OpenAI Codex logout failed') }
        }
      },
    })
  })
}

/**
 * Resolve the provider argument; empty input means openai-codex.
 * @param rawInput - command remainder after the slash name.
 * @returns `openai-codex`, or `undefined` for any other name.
 */
export function parseOAuthProvider(rawInput: string): typeof OPENAI_CODEX_PROVIDER | undefined {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0 || trimmed === OPENAI_CODEX_PROVIDER) return OPENAI_CODEX_PROVIDER
  return undefined
}

/** Render a command failure without assuming the value is safe to stringify as a secret. */
function commandFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return fallback
}
