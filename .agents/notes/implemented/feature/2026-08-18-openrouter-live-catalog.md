# Agent Note: Overlay live OpenAI-compatible listings on installed-catalog routes

Status: implemented

English | [中文](2026-08-18-openrouter-live-catalog.zh.md)

## Problem

The model picker and `session.models` served OpenRouter from the installed pi-ai snapshot only. `@earendil-works/pi-ai` 0.82.1 ships a few hundred OpenRouter rows; the live `GET https://openrouter.ai/api/v1/models` list is larger, and tool-capable ids that landed after the snapshot was cut never appeared. Fetch on that catalog route short-circuited to the same snapshot, so the configuration surface could not adopt them either. An explicit `models:` list already replaces the catalog and is not this gap.

## Decision

`dsh-llm-pi-ai` overlays a live OpenAI-compatible `GET /models` listing onto an OpenRouter catalog route that serves its installed catalog (absent or empty `models`) and speaks `openai-completions` or `openai-responses`. Overlay applies when the route key is `openrouter`, or when the listing host is `openrouter.ai` / `*.openrouter.ai`. Installed ids keep catalog name and capacities; live `reasoning.supported_efforts` replaces the snapshot effort map. Rows that disclose `supported_parameters` without `"tools"` are dropped; listings that omit the field keep every usable id. Live-only ids append after the catalog, cloning the first installed model's protocol and endpoint so `listModels`, `resolveModel`, and `stream` share one set. A live-only id that discloses a `reasoning` object or a reasoning parameter is marked reasoning with those efforts; other live-only ids stay non-reasoning so the composer does not offer a selector the endpoint cannot honour. Effort-name maps are owned by [per-model listing efforts](../bug-fix/2026-08-19-per-model-listing-reasoning-efforts.md). An explicit `models` list is not overlaid.

Network failure falls back to the installed catalog so a picker never goes empty. Fetch (`discoverModels`) uses the same overlay and the same fallback, except caller abort still fails loud. Successful listings are cached for the process lifetime, keyed by URL and a fingerprint of the bearer credential so a typed probe key does not reuse a stored-key reply. The host and Web UI do not special-case the `openrouter` route key.

Unit tests refuse non-loopback listing URLs so they never wait on a provider API. Production leaves `VITEST` unset and always lists.

## Alternatives considered

**Bumping `@earendil-works/pi-ai` to pick up a newer snapshot.** Rejected as the durable fix: the next OpenRouter release would stale the bundle again. A bump may still land separately for other catalog work.

**Replacing the installed catalog with the live list.** Rejected: OpenAI's `GET /models` is a different, smaller set than pi-ai's snapshot, and dropping bundled ids would hide models the picker already offered. Union keeps the snapshot and adds live-only tool-capable ids.

**Overlaying every listable catalog route (`openai-completions` / `openai-responses`).** Rejected: DeepSeek and OpenAI share the inference base URL with chat, so a picker `GET /models` is not a catalog refresh and can consume a scripted inference reply. Overlay is therefore the OpenRouter catalog id or an OpenRouter listing host, inside `dsh-llm-pi-ai`, not a host or UI branch.

**Special-casing the `openrouter` route key in the host or Web UI.** Rejected: the catalog already resolves in `dsh-llm-pi-ai`, and a proxy that only forwards `openrouter.ai` still needs the same overlay.

**Making live listing a `Config` opt-in defaulting to off.** Rejected: the missing models are the default OpenRouter experience; burying the fetch as a tunable would leave the gap in place.

## Consequences

Selecting an OpenRouter model that exists on the live listing but not in the installed snapshot works without writing `settings.yaml`. Narrowing a route with an explicit `models` list still hides everything not in that list. Fetch on OpenRouter shows the extras for adoption; Fetch on DeepSeek still answers from the catalog with no network call. Live-only models that disclose a reasoning parameter or object offer that row's efforts; others do not claim reasoning or image input. A deployment that needs image input or a listing the overlay cannot read writes them on a `models` entry.

## Testing

`tests/listing.spec.ts` pins URL joining, loopback-only unit-test listing, OpenRouter-only catalog listing targets, `supported_parameters` filtering, OpenRouter capacity fields, live-only reasoning overlay, overlay union, process-lifetime cache, in-flight coalescing, per-key cache identity, and HTTP failures. `tests/discovery.spec.ts` pins catalog-route overlay plus abort-vs-fallback, and keeps DeepSeek catalog-only (no network). `tests/live-catalog.spec.ts` pins picker/`resolveModel` extras, live-only reasoning efforts, explicit-`models` suppression, listing-failure fallback, and `MISSING_CREDENTIAL`/`INVALID_CREDENTIAL` during listing-key resolution.
