# Agent Note: Make hosted OAuth runtime failures observable

Status: proposed

English | [中文](2026-08-19-oauth-host-runtime-health.zh.md)

## Problem

Hosted OAuth routes can appear connected while their upstream model surface is unusable. Cursor model discovery may return a successful empty payload, after which the fallback catalog advertises `grok-4.6` and other ids. Cursor can then close a heartbeat-only Run, which the Harness reports as `EMPTY_RESPONSE` and retries without naming the provider-side condition.

Gemini route injection and bundled model resolution pass their unit coverage, but the composed host-to-client invalidation path after OAuth login needs one test that crosses the real Web composition. A live Settings row from another Harness process or home must not be treated as a catalog failure.

This note extends the runtime-health behavior of [Cursor OAuth hosting](../../implemented/feature/2026-08-18-cursor-oauth-host.md) and the composed verification of [Gemini CLI OAuth hosting](../../implemented/feature/2026-08-19-google-gemini-cli-oauth-host.md). Those notes remain authoritative for login, credentials, route ownership, and bundled provider catalogs.

## Proposal

Add a composed Web regression for Gemini login. A mocked OAuth completion must persist the credential, expose the injected provider and bundled model group through the host APIs, forward `llm/adapters-updated`, and refresh an already-loaded model directory. An unopened directory must remain lazy.

Distinguish Cursor discovery failures by outcome. Network failure and missing access keep the installed fallback available. A successful empty `GetUsableModels` payload becomes a provider-health failure returned by model catalog assembly, so the picker does not offer unconfirmed ids.

Track Cursor stream content independently of heartbeat updates. A stream that closes without text, thinking, or a tool call emits a provider-specific non-retryable empty-stream failure. Valid content and existing transport, abort, tool-call, image, and checkpoint behavior remain unchanged.

Diagnostics never include access tokens, request bodies, or account identity. A full Cursor protocol rewrite remains outside this proposal until a working upstream comparison confirms the required wire changes.

## Alternatives considered

**Keep the fallback after every empty discovery response.** Rejected because a successful empty response does not confirm that the advertised models are usable and leads directly to misleading retries.

**Keep the generic `EMPTY_RESPONSE` classification.** Rejected because it hides that Cursor delivered only heartbeat updates and lets the default empty-response retry policy repeat the same upstream result.

**Change only the model-picker UI.** Rejected because the invalid model state is created by provider discovery and streaming.

**Port a current community Cursor client immediately.** Deferred because candidate framing still produced heartbeat-only responses in the active runtime; a larger unofficial protocol rewrite needs a verified working comparison.

**Change Gemini Settings presentation or add a sign-in button.** Rejected because the existing command-based OAuth presentation is intentional and no Gemini catalog defect is reproduced in the active process.

## Acceptance criteria

- A composed Gemini OAuth login test proves credential persistence, provider/model API visibility, forwarded topology invalidation, and refresh of a loaded model directory.
- A successful empty Cursor discovery response produces a catalog failure rather than a fallback model group.
- A Cursor heartbeat-only stream produces a provider-specific non-retryable failure rather than `EMPTY_RESPONSE`.
- Valid Cursor fixture streams preserve text, thinking, tool-call, image, and checkpoint behavior.
- Diagnostics and tests do not expose OAuth secrets or request payloads.
- Focused tests, affected builds, Web artifact verification, and the live GUI refresh pass.

## Risks

A transient successful empty Cursor response hides fallback models until a later refresh. This favors truthful selection over offering ids the backend did not confirm; the failure identifies the discovery operation so the user can retry after service recovery.

The Gemini test may pass while a user's GUI uses a different Harness home, process, or Web artifact revision. The test establishes the composed contract but cannot reconcile mismatched runtime state.
