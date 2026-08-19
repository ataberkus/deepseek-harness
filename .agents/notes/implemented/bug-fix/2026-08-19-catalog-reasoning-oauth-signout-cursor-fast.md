# Agent Note: Live catalog reasoning, OAuth Sign out, and Cursor Fast SKUs

Status: implemented

English | [中文](2026-08-19-catalog-reasoning-oauth-signout-cursor-fast.zh.md)

## Problem

Three catalog and Models-page gaps landed together after hosted OAuth and the OpenRouter live overlay.

Selecting a live-only OpenRouter model (DeepSeek Flash and later snapshot ids) never showed a reasoning-effort control. The overlay cloned the first catalog model but forced `reasoning: false` and stripped `thinkingLevelMap`, even when OpenRouter `GET /models` named `reasoning` or `reasoning_effort` in `supported_parameters`. Installed snapshot ids kept catalog efforts; new ids did not.

Codex and Cursor appeared as signed-in rows on Settings → Models with no way to remove the stored login. Logout existed only as `/logout openai-codex` and `/logout cursor`. Fetch available models on an OpenRouter card listed the same overlay as the picker but offered a 320px checkbox list with no search and no select-all, so adopting a subset of a large catalog was impractical.

A successful Cursor login still omitted Grok 4.6 and Fast SKUs. The bundled fallback was a short list ending at Grok 4.5, live extras only appended, and missing protobuf `thinking_details` marked a model non-reasoning. oh-my-pi lists live GetUsableModels as source of truth and treats Fast as distinct ids (`grok-4.6-fast`), not a `maxMode` flag.

## Decision

Live OpenRouter overlay reads `supported_parameters`. A live-only id that names `reasoning` or `reasoning_effort` is marked reasoning with the OpenRouter map `{ low, medium, high }`. Other live-only ids stay non-reasoning. Installed catalog ids keep their snapshot map. Discovery replies still omit `reasoning` so `llm.discoverModels` stays id/name/capacities. The [OpenRouter live overlay](../feature/2026-08-18-openrouter-live-catalog.md) owns that union; this note owns the reasoning flag.

`LlmAdapter.logout` / `LlmRuntime.logout` / `llm.logout` delete a hosted OAuth credential through the same `logoutHostedOAuth` path as `/logout`. The Models page Delete control on an `auth: oauth` row confirms, calls that RPC, and reloads. It does not `settings.mutate`. [Codex](../feature/2026-08-18-openai-codex-oauth-host.md) and [Cursor](../feature/2026-08-18-cursor-oauth-host.md) login remain command-only; this note adds disconnect, not Sign-in. Fetch available models keeps the same overlay and adds a search field plus Select all / Deselect all over the **filtered** candidate list.

The composer picker echoes a click immediately: `ModelDirectory.select` writes `current` before `session.selectModel` returns, and the menu closes on submit. A Host refusal restores the previous current. `PiAiAdapter` memoizes the live overlay per snapshot so `session.models` does not rebuild OpenRouter's listing once per advertised id. A picker that already has groups stays `ready` while a catalog refresh is in flight.

Cursor listing is live-first: GetUsableModels descriptors win on id collision, the bundled fallback fills documented ids the reply omitted (including `grok-4.6` / `grok-4.6-fast` and other Fast SKUs Cursor ships), and `withFastVariants` adds `{id}-fast` only when that id is in the fallback table. Undocumented Fast ids such as `gpt-5.4-fast` are not synthesized. Reasoning is inferred from thinking details, then the fallback row, then id/name tokens (`grok`, `claude`, `gpt-`, `composer`, …) except `grok-code`.

## Alternatives considered

**Copying the first catalog model's `thinkingLevelMap` onto every live-only OpenRouter id.** Rejected: that would offer `xhigh`/`max` on models OpenRouter only documents as `low`/`medium`/`high`, and the request would fail with `UNSUPPORTED_REASONING_EFFORT`.

**Treating missing `supported_parameters` as reasoning.** Rejected: generic OpenAI `GET /models` omits the field; inventing a selector would offer levels the endpoint cannot honour.

**Deleting OAuth login through `settings.mutate` or `credentials.unset`.** Rejected: the live route has no settings address and the token lives in `$DSH_HOME/oauth-credentials.json`, not the API-key credential store. Sign out has to call the adapter-owned store delete.

**Keeping the picker checkmark on the last Host-reported current until `session.selectModel` returns.** Rejected: OpenRouter live overlay makes that round trip wait on listing and per-id resolve, so the click appears ignored for several seconds.

**Synthesizing `{id}-fast` for every live Cursor id.** Rejected: Cursor documents Fast as specific SKUs. Inventing `gpt-5.4-fast` would send an id the backend does not serve.

## Consequences

A newly listed OpenRouter reasoning model shows the composer effort control without a `settings.yaml` `models` entry. Signing out of Codex or Cursor from Settings → Models unregisters the live route. Fetch on a large OpenRouter catalog is searchable. Cursor login lists Grok 4.6 and documented Fast variants even when GetUsableModels omits them. Image input on live-only OpenRouter ids and hosted Cursor chat families is owned by [vision modalities](2026-08-19-cursor-openrouter-image-modalities.md). A model or effort click updates the composer seat before the Host round trip finishes.

## Testing

`packages/llm/llm-pi-ai/tests/listing.spec.ts` and `live-catalog.spec.ts` pin live-only reasoning overlay, `resolveModelInfo` efforts, and a single listing GET across `listModels` plus per-id resolve. `tests/cursor.spec.ts` pins fallback ids, live-first merge, documented Fast only, and inferred reasoning. `packages/llm/llm/tests/service.spec.ts` pins default `UNSUPPORTED_OPTION` and adapter-owned logout. `packages/host/apiproxy/tests` pin `llm.logout` round-trip and `oauth-logout-failed`. `packages/client/ui-settings-models/tests` pin Delete-on-OAuth and fetch search / select-all. `packages/client/ui-model-selection/tests` pin menu close before the Host answers and `ModelDirectory` optimistic echo plus refusal rollback.
