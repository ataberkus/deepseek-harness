/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom } from './auth.ts'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { registerPiAiFlows } from './login.ts'
import {
  apiKeyProviderProfiles,
  authUrlFallbackMessage,
  commandFailure,
  createBrowserOAuthInteraction,
  emitOAuthOpenUrl,
  hostedOAuthProviders,
  OAUTH_LOGIN_UNSUPPORTED,
  hostedOAuthProvider,
  loginHostedOAuth,
  loginOpenCodeGo,
  logoutManagedLogin,
  oauthProviderProfiles,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_PROVIDER,
  openUrl,
  registerOAuthCommands,
} from './oauth-login.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from './oauth-store.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { supportedProtocols } from './provider.ts'
export { OPENAI_CODEX_DISPLAY_NAME, OPENAI_CODEX_PROVIDER } from './oauth-login.ts'
export { OPENCODE_GO_DISPLAY_NAME, OPENCODE_GO_PROVIDER } from './oauth-login.ts'
export { CURSOR_DISPLAY_NAME, CURSOR_PROVIDER } from './cursor/constants.ts'
export {
  GOOGLE_ANTIGRAVITY_DISPLAY_NAME,
  GOOGLE_ANTIGRAVITY_PROVIDER,
} from './google-antigravity/constants.ts'
export { OAUTH_CREDENTIALS_FILENAME } from './oauth-store.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = 'llm-pi-ai'

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The provider-owned login one catalog route offers instead of a settings key
 * card. A route that authenticates through OAuth alone has no key a deployment
 * could store, so it renders as a Connect card; a route whose key the settings
 * page can write keeps its key card, because the login seam refuses an api-key
 * login for every provider but OpenCode Go (declared separately).
 * @param provider - provider route key.
 * @returns the login method that makes this route a Connect card, or `undefined`.
 */
function catalogLoginMethod(provider: string): LlmConfigurableProvider['auth'] {
  const auth = catalogProvider(provider)?.auth
  return auth?.oauth !== undefined && auth.apiKey === undefined ? 'oauth' : undefined
}

/**
 * The configurable-provider directory: every installed catalog route this
 * adapter can authenticate, the named LM Studio preset, the hosted OAuth
 * providers, plus every route the current profiles declare. A hand-declared
 * route has no catalog entry, so without this union it would have no settings
 * address and configuration surfaces could neither show nor edit it.
 *
 * The profile half is unconditional, which is what keeps a route already
 * stored against a withheld provider editable and deletable rather than
 * stranded in the settings document with nothing on the page to remove it.
 * Dormant provider-login entries live only while their route is disconnected:
 * once a credential injects the live route, the entry withdraws so the page
 * renders the signed-in row instead of a second Connect card.
 * @param profiles - the currently resolved provider profiles.
 * @param settingsNs - settings namespace the entries address.
 * @param injected - authentication methods for routes a stored login currently injects.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
  injected: ReadonlyMap<string, NonNullable<LlmConfigurableProvider['auth']>>,
): LlmConfigurableProvider[] {
  const catalog = new Set(catalogProviderIds())
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (
    provider: string,
    displayName: string,
    options: {
      defaults?: LlmConfigurableProvider['defaults']
      error?: string | undefined
      auth?: LlmConfigurableProvider['auth']
      /** Whether this adapter ships the route without an installed-catalog entry. */
      shipped?: boolean
    } = {},
  ): void => {
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      settingsPath: ['providers', provider],
      ...options.defaults === undefined ? {} : { defaults: { ...options.defaults } },
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows. A route this adapter ships itself is
      // not a deployment-declared one either.
      declared: !catalog.has(provider) && options.shipped !== true,
      ...options.error === undefined ? {} : { error: options.error },
      ...options.auth === undefined ? {} : { auth: options.auth },
    })
  }
  // Every installed route is offered, including one that authenticates through
  // a provider-owned login alone: the collection carries a durable credential
  // store and a login flow writes into it, so such a route has a posture that
  // works rather than only one that fails.
  for (const provider of catalog) {
    // A route a stored login already injects is live: its dormant Connect
    // entry withdraws so the page renders the signed-in row instead.
    if (injected.has(provider)) continue
    if (provider === OPENCODE_GO_PROVIDER) {
      // Its own login is the adapter's key flow rather than a settings key.
      declare(provider, OPENCODE_GO_DISPLAY_NAME, { auth: 'api-key' })
      continue
    }
    declare(provider, provider, { auth: catalogLoginMethod(provider) })
  }
  for (const host of hostedOAuthProviders()) {
    if (!entries.has(host.id) && !injected.has(host.id)) {
      declare(host.id, host.displayName, { auth: 'oauth', shipped: true })
    }
  }
  for (const [provider, profile] of profiles) {
    declare(provider, profile.displayName, { error: profile.catalogError })
  }
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  const oauthStore = new FileOAuthStore(join(resolveDshHome(), OAUTH_CREDENTIALS_FILENAME))
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let lastLoginRevision: number | undefined
  let memo: {
    settings: ReadonlyMap<string, ResolvedPiAiProviderProfile>
    live: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  } | undefined
  /**
   * Rebuild both profile maps when the volatile configuration snapshot identity
   * or the managed login-store revision changes, memoized by those identities —
   * which is also what makes the adapter's own snapshot stable across
   * operations that observe no change.
   *
   * The settings half feeds the configurable-provider directory (so a login
   * does not invent a key-card); the live half adds the routes stored provider
   * logins inject, which is what makes a signed-in route selectable. Catalog
   * diagnostics stay in both beside serviceable models, so stored
   * configuration remains visible after an installed catalog changes. Scalar
   * configuration errors still reject resolution.
   */
  const resolveMemo = (): NonNullable<typeof memo> => {
    const raw = config.providers.get()
    const revision = oauthStore.revision
    if (raw === lastRaw && revision === lastLoginRevision && memo !== undefined) return memo
    const providers = structuredClone(raw) as import('./config.ts').Options['providers']
    const credentialInfos = oauthStore.credentialInfos()
    lastRaw = raw
    lastLoginRevision = revision
    memo = {
      settings: resolveProfiles(providers, 'deferred'),
      live: resolveProfiles({
        ...oauthProviderProfiles(credentialInfos),
        ...apiKeyProviderProfiles(credentialInfos),
        ...providers,
      }, 'deferred'),
    }
    return memo
  }
  /** Login methods for routes injected solely by stored credentials, not settings. */
  const loginInjected = (): ReadonlyMap<string, NonNullable<LlmConfigurableProvider['auth']>> => {
    const { settings } = resolveMemo()
    const credentialInfos = oauthStore.credentialInfos()
    const injected = new Map<string, NonNullable<LlmConfigurableProvider['auth']>>()
    for (const id of Object.keys(oauthProviderProfiles(credentialInfos))) {
      if (!settings.has(id)) injected.set(id, 'oauth')
    }
    for (const id of Object.keys(apiKeyProviderProfiles(credentialInfos))) {
      if (!settings.has(id)) injected.set(id, 'api-key')
    }
    return injected
  }
  /** Profiles the Models page can address; managed-login routes stay out. */
  const settingsProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => resolveMemo().settings
  /** Profiles the adapter serves, including stored provider-login routes. */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => resolveMemo().live
  profiles()
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  let onCredentialChange: () => void = () => undefined
  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one. The store is the
  // owner-only login file pi-ai itself writes through, which is what makes a
  // signed-in route visible to the adapter without a settings profile.
  const auth = { credentials: oauthStore, authContext: authContextFrom(ctx) }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    loginInjected,
    logoutManagedLogin: async (provider) => {
      await logoutManagedLogin(provider, { store: oauthStore, onCredentialChange })
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(settingsProfiles(), settingsNs, loginInjected())
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // Signing a hosted OAuth route in is a configuration-time action over a
  // dormant route, so it is offered for the whole namespace rather than per
  // live route: the route a surface is connecting has no registration to name
  // yet. The interaction emits the authorize URL on `commands/open-url` for
  // GUI subscribers and falls back to the host browser opener for
  // listener-less compositions, exactly like the `/login` command path.
  ctx.llm.registerOAuthLogin(settingsNs, async (provider, signal) => {
    const host = hostedOAuthProvider(provider)
    if (host === undefined) {
      throw new Error(OAUTH_LOGIN_UNSUPPORTED)
    }
    let browserEventDelivered = false
    try {
      await loginHostedOAuth(provider, oauthStore, createBrowserOAuthInteraction({
        ...signal === undefined ? {} : { signal },
        openUrl: async (url) => {
          if (browserEventDelivered) return
          await openUrl(url)
        },
        writeAuthUrl: (url) => {
          browserEventDelivered = emitOAuthOpenUrl(
            authUrl => ctx.events.dispatch('emit', ['commands/open-url', authUrl]),
            url,
          )
          process.stderr.write(authUrlFallbackMessage(url))
        },
      }))
    } catch (error) {
      throw new Error(commandFailure(error, host.loginFailed))
    }
    onCredentialChange()
  })
  // OpenCode Go's provider-owned method is an API key rather than OAuth. The
  // Remote receives it as a secret field, pi-ai persists it in the same
  // owner-only store as other provider logins, and the successful write makes
  // the route live without creating a settings profile.
  ctx.llm.registerApiKeyLogin(settingsNs, async (provider, apiKey, signal) => {
    if (provider !== OPENCODE_GO_PROVIDER) {
      throw new Error('Only OpenCode Go supports API-key login from the Models page.')
    }
    await loginOpenCodeGo(oauthStore, apiKey, signal)
    onCredentialChange()
  })
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  onCredentialChange = () => {
    lastRaw = undefined
    lastLoginRevision = undefined
    try {
      ensureRegistrationFacts()
    } catch (error) {
      ctx.logger.error('llm-pi-ai: keeping the previously registered routes after a managed credential change')
      ctx.logger.error(error)
    }
    // A sign-in withdraws its dormant directory entry (and a sign-out
    // restores it), so the Models page never renders both a Connect card
    // and a signed-in row for one route.
    try {
      ensureDirectory()
    } catch (error) {
      ctx.logger.error('llm-pi-ai: keeping the previous configurable-provider directory after a managed credential change')
      ctx.logger.error(error)
    }
  }
  registerOAuthCommands(ctx, { store: oauthStore, onCredentialChange })

  ctx.on('loader/volatile-update', () => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
