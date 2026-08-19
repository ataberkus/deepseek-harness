/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered from that catalog.
 * OpenRouter catalog routes overlay the endpoint listing: catalog ids keep
 * catalog capacities, and tool-capable ids the snapshot does not ship are
 * appended. A listing failure falls back to the catalog so Fetch still
 * returns the installed set. Only a route the catalog does not describe — a
 * gateway, a self-hosted server — is interrogated with no catalog floor, and
 * that path still fails loud.
 *
 * Neither path writes configuration. The request carries a draft the user is
 * still editing, and the reply is candidate metadata the surface offers for
 * adoption. `settings.yaml` remains the only thing that decides what a route
 * serves; the live overlay on an installed-catalog route is what the picker
 * and request path already serve, not a stored replacement list.
 *
 * Only OpenAI-compatible protocols are interrogated. Their listing is the one
 * shape a gateway, a self-hosted server, and the official endpoints all agree
 * on, which is the case this action exists for; every other protocol reports
 * that it cannot be interrogated so the surface falls back to hand-entry
 * rather than guessing a response shape.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { catalogModels, catalogProvider } from './catalog.ts'
import {
  catalogListingTarget,
  discoveredFromListing,
  fetchModelListing,
  LISTABLE_PROTOCOLS,
  overlayDiscoveredModels,
} from './listing.ts'

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Catalog rows in the discovery reply shape, including capacities. */
function catalogDiscoveryRows(provider: string): LlmDiscoveredModel[] {
  return [...catalogModels(provider).values()].map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }))
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedApiKey - the credential the named route already stored, asked
 *   for only when the draft carries none and only on the path that reaches
 *   the network. A configuration surface never holds a stored secret — it edits
 *   a redacted descriptor — so without this an already-configured route would
 *   be interrogated unauthenticated and answer 401.
 * @returns the advertised models in endpoint order; catalog routes prepend the
 *   installed set and append live-only ids.
 * @throws LlmError when the protocol has no readable listing, a non-catalog
 *   endpoint refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  const installed = request.provider === undefined ? [] : catalogDiscoveryRows(request.provider)
  const overlayBase = request.baseURL !== undefined && request.baseURL.length > 0
    ? request.baseURL
    : request.provider === undefined
      ? undefined
      : catalogProvider(request.provider)?.baseUrl
  const listingTarget = request.provider === undefined
    ? undefined
    : catalogListingTarget(request.provider, {
      ...request.api === undefined ? {} : { api: request.api },
      ...overlayBase === undefined || overlayBase.length === 0 ? {} : { baseURL: overlayBase },
    })
  if (installed.length > 0 && listingTarget === undefined) return installed

  const baseURL = request.baseURL !== undefined && request.baseURL.length > 0
    ? request.baseURL
    : listingTarget?.baseURL
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A draft that has not chosen a protocol yet is asked as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for. The cost is a misdirected message
  // when the endpoint speaks something else (an Anthropic gateway answers 401,
  // which reads as a credential problem), and hand-entry remains the way out.
  const api = request.api ?? listingTarget?.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing. The
  // stored one is only asked for here, past the catalog-only short-circuit and
  // the protocol check, so a route answered from the registry alone costs no
  // credential lookup — and no diagnostic about a credential it never needed.
  // A probe carrying no key stays unauthenticated, which is how a route that
  // relies on the provider's own ambient discovery is meant to be asked.
  const supplied = request.apiKey ?? await storedApiKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  try {
    const live = await fetchModelListing({
      baseURL,
      ...apiKey === undefined ? {} : { apiKey },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    return installed.length === 0
      ? live.map(discoveredFromListing)
      : overlayDiscoveredModels(installed, live)
  } catch (error: unknown) {
    if (installed.length > 0 && !(error instanceof LlmError && error.code === 'ABORTED')) {
      return installed
    }
    throw error
  }
}
