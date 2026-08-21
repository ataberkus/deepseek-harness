/**
 * Hosted OAuth-only provider routes this adapter logs in, not the rest of
 * pi-ai's catalog OAuth methods (those stay on the Models key path).
 *
 * @module dsh-llm-pi-ai/oauth-hosts
 */

import { CURSOR_DISPLAY_NAME, CURSOR_PROVIDER } from './cursor/constants.ts'
import {
  GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
  GOOGLE_ANTIGRAVITY_PROVIDER,
} from './google-antigravity/constants.ts'

/** Installed pi-ai provider id for ChatGPT Codex subscription auth. */
export const OPENAI_CODEX_PROVIDER = 'openai-codex'

/** Fallback display name when the catalog provider is unavailable. */
export const OPENAI_CODEX_DISPLAY_NAME = 'OpenAI Codex'

/** One hosted OAuth route this adapter will inject after login. */
export interface HostedOAuthProvider {
  /** Provider route key and `CredentialStore` key. */
  id: string
  /** Selector and Models-page label when the catalog has no name. */
  displayName: string
  /** `/login` success text after the credential is stored. */
  signedIn: string
  /** `/logout` success text after the credential is deleted. */
  signedOut: string
  /** Fallback command-error text when the thrown value has no message. */
  loginFailed: string
  /** Fallback command-error text when logout cannot delete the store entry. */
  logoutFailed: string
}

const HOSTS: readonly HostedOAuthProvider[] = [
  {
    id: OPENAI_CODEX_PROVIDER,
    displayName: OPENAI_CODEX_DISPLAY_NAME,
    signedIn:
      'Signed in to OpenAI Codex. Select an openai-codex model to use the ChatGPT Codex subscription.',
    signedOut: 'Signed out of OpenAI Codex.',
    loginFailed: 'OpenAI Codex login failed',
    logoutFailed: 'OpenAI Codex logout failed',
  },
  {
    id: CURSOR_PROVIDER,
    displayName: CURSOR_DISPLAY_NAME,
    signedIn: 'Signed in to Cursor. Select a cursor model to use the Cursor subscription.',
    signedOut: 'Signed out of Cursor.',
    loginFailed: 'Cursor login failed',
    logoutFailed: 'Cursor logout failed',
  },
  {
    id: GOOGLE_ANTIGRAVITY_PROVIDER,
    displayName: GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
    signedIn:
      'Signed in to Antigravity. Select a google-antigravity model to use the Antigravity subscription.',
    signedOut: 'Signed out of Antigravity.',
    loginFailed: 'Antigravity login failed',
    logoutFailed: 'Antigravity logout failed',
  },
]

const BY_ID = new Map(HOSTS.map(host => [host.id, host]))

/**
 * Every hosted OAuth route, in table order.
 * @returns the table in declaration order.
 */
export function hostedOAuthProviders(): readonly HostedOAuthProvider[] {
  return HOSTS
}

/**
 * The hosted OAuth table entry for `id`.
 * @param id - provider route key.
 * @returns the host, or `undefined` when this adapter does not log that route in.
 */
export function hostedOAuthProvider(id: string): HostedOAuthProvider | undefined {
  return BY_ID.get(id)
}

const ALIASES: ReadonlyMap<string, string> = new Map([
  ['antigravity', GOOGLE_ANTIGRAVITY_PROVIDER],
  ['google-gemini-cli', GOOGLE_ANTIGRAVITY_PROVIDER],
])

/**
 * Resolve `/login` / `/logout` remainder; empty input means openai-codex.
 * @param rawInput - command remainder after the slash name.
 * @returns a hosted provider id, or `undefined` for any other name.
 */
export function parseOAuthProvider(rawInput: string): string | undefined {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return OPENAI_CODEX_PROVIDER
  const aliased = ALIASES.get(trimmed) ?? trimmed
  return BY_ID.has(aliased) ? aliased : undefined
}

/** Shown when `/login` is invoked while another hosted login is still waiting. */
export const OAUTH_LOGIN_IN_PROGRESS =
  'A login is already in progress. Finish or cancel the open browser tab, then run /login again.'

/** Command remainder hint listing every hosted id. */
export const OAUTH_COMMAND_HINT = '[openai-codex|cursor|google-antigravity]'

/** Error when `/login` names a route this host does not offer. */
export const OAUTH_LOGIN_UNSUPPORTED =
  'Only /login openai-codex, /login cursor, and /login google-antigravity are supported.'

/** Error when `/logout` names a route this host does not offer. */
export const OAUTH_LOGOUT_UNSUPPORTED =
  'Only /logout openai-codex, /logout cursor, and /logout google-antigravity are supported.'
