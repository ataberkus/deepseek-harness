# Agent Note: Make hosted OAuth runtime failures observable

Status: implemented

English | [中文](2026-08-19-oauth-host-runtime-health.zh.md)

## Problem

Hosted OAuth routes can appear connected while their upstream model surface is unusable. Cursor model discovery may return a successful empty payload, after which a fallback catalog can advertise `grok-4.6` and other unconfirmed ids. Cursor can then close a heartbeat-only Run, which the Harness reports as generic `EMPTY_RESPONSE` and retries without naming the provider-side condition.

Gemini route injection and bundled model resolution pass their unit coverage, but the host-to-client invalidation path after OAuth login needs coverage that crosses the real Web composition. A live Settings row from another Harness process or home is not a catalog failure.

This note extends the runtime-health behavior of [Cursor OAuth hosting](../feature/2026-08-18-cursor-oauth-host.md) and the composed verification of [Gemini CLI OAuth hosting](../feature/2026-08-19-google-gemini-cli-oauth-host.md). Those notes remain authoritative for login, credentials, route ownership, and bundled provider catalogs.

## Decision

`listCursorModels` keeps the bundled catalog for transport failure and missing access, but a successful empty `GetUsableModels` response raises `LlmError` with `CURSOR_NO_USABLE_MODELS`. The Host model catalog preserves typed `HarnessError.code` in the optional `ModelCatalogFailure.code` field, so a provider-local failure remains visible without making the field required for plain errors.

`PiAiAdapter` removes a rejected served-model promise from the current snapshot before rethrowing it. A model-directory retry therefore performs a fresh Cursor listing, while successful snapshots remain memoized.

`mapStopReason` maps a Cursor terminal stop with no text, thinking, or tool-call blocks to `CURSOR_EMPTY_STREAM`. That code is outside the default retryable set. Other providers retain the generic retryable `EMPTY_RESPONSE` classification, and all non-empty Cursor content plus existing transport, abort, tool-call, image, and checkpoint behavior remains unchanged. The generic provider rule remains in [retryable empty completions](2026-07-24-empty-model-response-is-retryable.md); this note narrows only Cursor.

The composed Web regression completes a mocked `/login google-gemini-cli` flow through the real loopback callback, verifies Host model visibility, and observes the already-open picker after `llm/adapters-updated`. The browser-plugin regression keeps unopened model directories lazy.

Diagnostics and fixtures do not contain access tokens, request bodies, or account identity. Targeted Run framing and liveness are owned by [Cursor AgentService wire compatibility](2026-08-20-cursor-agentservice-wire-compatibility.md); full conversation-state blobs and broader unofficial service changes remain outside this decision.

## Alternatives considered

**Keep the fallback after every empty discovery response.** Rejected because a successful empty response does not confirm that the advertised models are usable and leads directly to misleading selections and retries.

**Keep the generic `EMPTY_RESPONSE` classification.** Rejected because it hides that Cursor delivered only heartbeat updates and lets the default empty-response retry policy repeat the same upstream result.

**Change only the model-picker UI.** Rejected because the invalid model state is created by provider discovery and streaming, and Host callers also need the typed failure.

**Port a current community Cursor client immediately.** Rejected as a complete provider rewrite. The targeted Run framing and liveness changes are recorded in [Cursor AgentService wire compatibility](2026-08-20-cursor-agentservice-wire-compatibility.md); full conversation-state handling still needs a separately verified design.

**Change Gemini Settings presentation or add a sign-in button.** Rejected because the existing command-based OAuth presentation is intentional and the composed regression covers the route refresh without adding another sign-in surface.

## Consequences

A transient successful empty Cursor response hides fallback models until a later refresh. This favors truthful selection over offering ids the backend did not confirm; `CURSOR_NO_USABLE_MODELS` identifies the discovery operation so the user can retry after service recovery.

A heartbeat-only Cursor response ends with an actionable non-retryable provider code instead of consuming the generic empty-response retry budget. A provider that intentionally emits no blocks still fails the turn, because an empty assistant message has no durable value and is indistinguishable from the observed backend defect.

The Gemini test establishes the composed contract but cannot reconcile a user GUI running a different Harness home, process, or Web artifact revision. The Cursor transport remains unofficial; targeted Run compatibility is owned by [Cursor AgentService wire compatibility](2026-08-20-cursor-agentservice-wire-compatibility.md), and broader service changes may require another protocol decision.

## Testing

`apps/web/tests/oauth-model-directory.e2e.ts` covers mocked Google token exchange, Cloud Code Assist project discovery, the real loopback callback, Host `llm.models`, forwarded topology invalidation, and refresh of an open picker. `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` covers unopened-directory laziness. `packages/llm/llm-pi-ai/tests/cursor.spec.ts` covers successful-empty discovery, transport fallback, retry after a rejected listing, AgentService envelope and open-stream frames, interaction responses, heartbeat-only streams, and existing Cursor fixtures. `packages/llm/llm-pi-ai/tests/convert.spec.ts` preserves generic `EMPTY_RESPONSE` and pins `CURSOR_EMPTY_STREAM`. Host API model and RPC schema tests cover optional typed failure-code propagation. Focused OAuth, Cursor, conversion, Host, build, Web, Markdown, and Agent Note gates are the verification surfaces for this decision.
