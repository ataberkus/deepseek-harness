# Agent Note: List live Codex OAuth models over the account registry

Status: implemented

English | [中文](2026-09-12-codex-oauth-model-listing.zh.md)

## Problem

The model picker serves `openai-codex` from the installed pi-ai snapshot only. Account-entitled SKUs that land after the snapshot is cut — Daybreak Blue and other rolling aliases — never appear, even though the signed-in account can route them. pi-ai 0.85.1 ships no Codex discovery API, and configuration-time discovery answers catalog routes from the snapshot by design, so neither path can surface them.

## Decision

`dsh-llm-pi-ai` reads the account-scoped Codex registry and merges it over the installed catalog on every served-model resolution. `src/codex/models.ts` owns the fetch, the normalization, and the merge; pi-ai remains the Codex transport.

`fetchCodexModels` tries `GET {baseURL}/codex/models` then `GET {baseURL}/models`, each with `?client_version=0.153.4`. The request carries `Authorization: Bearer` with the stored OAuth access token, the `chatgpt-account-id` claim read from that JWT, `OpenAI-Beta: responses=experimental`, `originator: pi`, the `version` header, and the harness `User-Agent`. The client-version pin mirrors the `@openai/codex` dependency in `dsh-subagent-codex`, because the backend version-gates model availability against it. The base is the profile `baseURL` override or `https://chatgpt.com/backend-api`. Replies accept the `models` or `data` array; hidden rows and entries without a routable slug are skipped without hiding the rest.

A normalized row carries the registry slug, display name, reasoning disclosure, disclosed input modalities, and reported window. Reasoning levels arrive as bare names or `{ effort }` objects and map onto the canonical pi-ai levels; a row naming only `none` offers no selector. An undisclosed modality stays undisclosed so the merge never invents an image claim. A reported window wins; an omitted one keeps the known id's catalog capacity, or the generation default (372K for the GPT-5.6 family including Daybreak aliases, 272K otherwise). Luna, Sol, and Terra floor at the 1M subscription window the registry still under-reports; reports above the floor are honored. The output cap is `min(128K, window)`.

`mergeCodexCatalogs` serves live rows first in backend order, then installed-only ids in catalog order. A live row keeps its registry name and capacities. A known id keeps its catalog cost; a live-only id clones the first installed model's protocol, endpoint, and compatibility with zero cost, because a subscription carries no per-token billing fact. A live effort map replaces the snapshot map; otherwise the installed descriptor survives untouched. An explicit profile `models` list never reaches the merge. Any fetch, parse, or credential failure answers the installed catalog, so the picker never goes empty.

Listing reads the token straight from the credential store and never refreshes: an expired token answers 401, falls back to installed, and the request path still refreshes under pi-ai's lock and fails loud there. Unit tests forbid registry network and stub the fetch, following the hosted Cursor listing.

## Alternatives considered

**Bumping `@earendil-works/pi-ai` for a newer snapshot.** Rejected as the durable fix, for the same reason as the [OpenRouter overlay](2026-08-18-openrouter-live-catalog.md): the next release would stale the bundle again. A bump may still land separately for other catalog work.

**Replacing the installed catalog with the live list.** Rejected: an empty or drifted registry reply would hide models the picker already offers and the request path already serves. Union keeps the snapshot and adds account-entitled ids.

**Reusing `overlayLiveCatalogModels` from `listing.ts`.** Rejected: that overlay keeps installed capacities for known ids, which would hide the Luna/Sol/Terra 1M floor, and its template clone would misattribute the template's cost to live-only subscription models.

**Resolving listing auth through `Models.getAuth` with refresh.** Rejected: refresh during listing adds network and lock contention to every picker render, and a revoked token would fail listing instead of degrading. Direct store reads keep listing best-effort; requests stay authoritative.

**Synthesizing plain routes for `-wm` worker slugs.** Rejected: oh-my-pi needs that synthesis because its discovery prunes; the union here already keeps every installed plain id resolvable, so no phantom route is required.

**Reading `~/.codex/auth.json` for more accounts.** Rejected under the existing [Codex OAuth host](2026-08-18-openai-codex-oauth-host.md) decision: the harness stays bound to its own credential store, not another tool's private file.

## Consequences

A signed-in account sees Daybreak Blue and other rolling aliases in the picker with no `settings.yaml` edit, and selecting one works because the request path routes whatever id the registry advertised. Narrowing the route with an explicit `models` list still hides everything not in that list. Live-only models report zero spend in token usage; known ids keep their catalog rates. Registry shape drift updates `src/codex/models.ts`; Codex Responses transport stays pi-ai. The [Codex OAuth host](2026-08-18-openai-codex-oauth-host.md) still owns login, storage, and refresh.

## Testing

`tests/codex.spec.ts` pins header construction and account-claim extraction, path fallback and credential-rejection behavior, row normalization (Daybreak capabilities, `{ effort }` objects, hidden rows, modality and window rules, 1M floors), merge union and cost behavior, installed fallback on store and registry failure, proxy `baseURL`, and picker plus `resolveModel` serving a live-only id. The hosted-request regression in `tests/oauth-login.spec.ts` now targets the request-path store read, because listing reads the token first. The new module holds 100% line, branch, and function coverage.
