/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. The named `lmstudio` route is an
 * OpenAI-compatible preset with local endpoint and protocol defaults. Profile
 * facts resolve per request over the optional `llm-pi-ai` user-settings
 * section and credential seam, so a changed key, endpoint, model, or knob
 * reaches the next request without a restart; a changed *route set* (or a
 * route's registration-captured retry policy) re-registers the same adapter instance
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
 *       # First-class LM Studio route; models remain explicit.
 *       lmstudio:
 *         models:
 *           - id: qwen/qwen3-4b@q4_k_m
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

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { PiAiAdapter } from './adapter.ts'
import { authContextFrom } from './auth.ts'
import { catalogProviderIds, catalogProviderTakesApiKey } from './catalog.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { logoutHostedOAuth, oauthProviderProfiles, registerOAuthCommands } from './oauth-login.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from './oauth-store.ts'
import {
  LM_STUDIO_API,
  LM_STUDIO_BASE_URL,
  LM_STUDIO_DISPLAY_NAME,
  LM_STUDIO_PLACEHOLDER_API_KEY,
  LM_STUDIO_PROVIDER,
} from './lmstudio.ts'
import { registerPiAiFlows } from './login.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
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
 * The configurable-provider directory: every installed catalog route this
 * adapter can authenticate, the named LM Studio preset, plus every route the
 * current profiles declare. A hand-declared route has no catalog entry, so
 * without this union it would have no settings address and configuration
 * surfaces could neither show nor edit it.
 *
 * The profile half is unconditional, which is what keeps a route already
 * stored against a withheld provider editable and deletable rather than
 * stranded in the settings document with nothing on the page to remove it.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in catalog order, followed by LM Studio and
 * profile-only routes.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): LlmConfigurableProvider[] {
  const catalog = new Set(catalogProviderIds())
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (
    provider: string,
    displayName: string,
    defaults?: LlmConfigurableProvider['defaults'],
  ): void => {
    entries.set(provider, {
      provider,
      displayName,
      settingsNs: NS,
      settingsPath: ['providers', provider],
      ...defaults === undefined ? {} : { defaults: { ...defaults } },
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: !catalog.has(provider),
    })
  }
  // A provider whose only native method is OAuth leaves this adapter nothing
  // to authenticate with, so offering it would put a card on the settings page
  // whose own posture — no key, credentials discovered by the provider — fails
  // every request. Catalog *membership* is unaffected, so `declare` above still
  // answers what pi-ai ships.
  for (const provider of catalog) {
    if (catalogProviderTakesApiKey(provider)) declare(provider, provider)
  }
  declare(LM_STUDIO_PROVIDER, LM_STUDIO_DISPLAY_NAME, {
    api: LM_STUDIO_API,
    baseURL: LM_STUDIO_BASE_URL,
  })
  for (const [provider, profile] of profiles) {
    declare(
      provider,
      profile.displayName,
      provider === LM_STUDIO_PROVIDER
        ? { api: LM_STUDIO_API, baseURL: LM_STUDIO_BASE_URL }
        : undefined,
    )
  }
  return [...entries.values()]
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  const oauthStore = new FileOAuthStore(join(resolveDshHome(), OAUTH_CREDENTIALS_FILENAME))
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastOAuthRevision: number | undefined
  let memoizedSettings: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  let memoizedLive: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * Rebuild both profile maps when the settings snapshot identity or the OAuth
   * store revision changes. Settings profiles feed the configurable-provider
   * directory (so a login does not invent a key-card). Live profiles feed the
   * adapter registry (so a stored Codex token becomes a selectable route).
   */
  const resolveMemo = (): void => {
    const raw = current()
    const revision = oauthStore.revision
    if (raw === lastRaw && revision === lastOAuthRevision
      && memoizedSettings !== undefined && memoizedLive !== undefined) return
    lastRaw = raw
    lastOAuthRevision = revision
    memoizedSettings = resolveProfiles(raw.providers)
    memoizedLive = resolveProfiles({
      ...oauthProviderProfiles(oauthStore.credentialInfos()),
      ...raw.providers,
    })
  }
  /** Route keys injected solely by a stored OAuth credential, not settings. */
  const oauthInjected = (): ReadonlySet<string> => {
    resolveMemo()
    const injected = new Set<string>()
    for (const id of Object.keys(oauthProviderProfiles(oauthStore.credentialInfos()))) {
      if (!(memoizedSettings as ReadonlyMap<string, ResolvedPiAiProviderProfile>).has(id)) injected.add(id)
    }
    return injected
  }
  /** Profiles the Models page can address; OAuth-injected routes stay out. */
  const settingsProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    resolveMemo()
    return memoizedSettings as ReadonlyMap<string, ResolvedPiAiProviderProfile>
  }
  /** Profiles the adapter serves, including stored hosted OAuth routes. */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    resolveMemo()
    return memoizedLive as ReadonlyMap<string, ResolvedPiAiProviderProfile>
  }
  profiles()

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery; LM Studio receives its non-secret placeholder
    // below because pi-ai's OpenAI client still requires a key-shaped value. Once
    // one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) {
      return provider === LM_STUDIO_PROVIDER ? LM_STUDIO_PLACEHOLDER_API_KEY : undefined
    }
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
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: oauthStore, authContext: authContextFrom(ctx) }
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    oauthInjected,
    logoutOAuth: async (provider) => {
      await logoutHostedOAuth(provider, { store: oauthStore, onCredentialChange })
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
    const entries = directoryEntries(settingsProfiles())
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
  ctx.llm.registerModelDiscovery(NS, (request, signal) => discoverModels(
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
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
    lastOAuthRevision = undefined
    try {
      ensureRegistrationFacts()
    } catch (error) {
      ctx.logger.error('llm-pi-ai: keeping the previously registered routes after an OAuth credential change')
      ctx.logger.error(error)
    }
  }
  registerOAuthCommands(ctx, { store: oauthStore, onCredentialChange })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      // Refuse an unserviceable section where it is written: without this a
      // schema-valid profile the adapter cannot serve would be stored and then
      // silently disable every route in this namespace.
      validate: assertServiceable,
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        // Named here rather than left to the settings watcher: `assertServiceable`
        // cannot see the llm registry, so a profile claiming a route another
        // adapter family owns is stored successfully and only fails at this swap.
        // Without its own diagnostic that refusal reaches the operator as a
        // generic "settings: watcher failed", naming neither the route nor why it
        // is not serving. The previous routes keep serving either way.
        try {
          ensureRegistrationFacts()
        } catch (error) {
          ctx.logger.error('llm-pi-ai: keeping the previously registered routes after a refused update')
          ctx.logger.error(error)
        }
        // The directory follows the profiles the registry accepted, so a route
        // that failed to register is not advertised as configurable. A refused
        // directory swap is contained here for the same reason the registry's
        // is: the previous entries keep serving, and `directoryFacts` stays put
        // so returning to a working configuration re-applies.
        try {
          ensureDirectory()
        } catch (error) {
          ctx.logger.error('llm-pi-ai: keeping the previous configurable-provider directory after a refused update')
          ctx.logger.error(error)
        }
      },
    })
  })
}
