# OAuth-host runtime health

Status: draft for review

## Scope

This specification covers the runtime symptoms reported for the hosted `google-gemini-cli` and `cursor` providers. It preserves the existing OAuth route, model catalog, and agent-loop ownership while making provider availability observable at the model-listing and streaming boundaries.

## Confirmed evidence

The active Web process exposes a connected Cursor route and a fallback model group containing `grok-4.6`. Cursor `GetUsableModels` returns a successful empty payload, and a Cursor `Run` for every tested model returns only a heartbeat update before the stream closes. The adapter therefore turns a provider-side empty stream into the generic `EMPTY_RESPONSE` failure and retries it.

The active process does not contain a Gemini OAuth credential or a live Gemini route. The source catalog resolves the bundled Gemini models, and the existing OAuth tests cover route injection and model listing. A live Gemini selector failure is therefore not reproducible in the active process; the remaining code-level risk is the composed host-to-client invalidation path after login.

## Goals

- Verify the composed OAuth login path from credential persistence through `llm.providers`, `llm.models`, the forwarded `llm/adapters-updated` event, and an already-open model picker.
- Distinguish a successful but empty Cursor discovery response from a network failure.
- Report a Cursor heartbeat-only terminal stream as a provider-specific failure instead of a successful empty completion.
- Keep provider credentials, access tokens, and request bodies out of diagnostics and tests.
- Preserve normal Cursor text, thinking, tool-call, image, and checkpoint behavior.

## Proposed behavior

### Gemini composition check

Add a real-composition Web test with mocked OAuth and browser-opening edges. After the login command completes, the composed host must expose the injected OAuth provider and the bundled Gemini model group. The host must forward the topology event, and the Client model-selection service must refresh an already-loaded directory without requiring a page reload. The test must also verify that an unopened directory does not fetch merely because an invalidation arrived.

If this test passes without a source change, the Gemini provider implementation remains unchanged. A live Settings row from a different Harness home or an old process is an environment diagnosis, not a catalog defect.

### Cursor discovery

Keep the bundled fallback for an unavailable network or a missing access token, because those conditions do not prove that the account has no usable models. Treat a successful empty `GetUsableModels` payload as a backend health failure instead of silently returning the fallback. The `session.models` response must retain a failure for the Cursor provider so the picker cannot offer model ids that the active backend did not confirm.

The failure message must identify Cursor model discovery and state that the backend returned no usable models. It must not include the access token, request body, or account identity.

### Cursor streaming

Track whether a Cursor stream produced text, thinking, or a tool call. If the stream closes after heartbeat-only updates without a terminal content block, emit a provider-specific error event. The Harness finish chunk must use a non-retryable Cursor-empty-stream code and an actionable message rather than `EMPTY_RESPONSE`; the existing retry policy must not repeat a known heartbeat-only backend result by default.

A stream that produces a valid content block remains successful even when heartbeat updates are interleaved. Existing transport errors, aborts, tool-call resumes, and normal terminal updates retain their current classifications.

## Verification

- Add failing regression tests before production changes for composed Gemini login invalidation, empty Cursor discovery, and heartbeat-only Cursor streaming.
- Keep existing provider, OAuth, adapter, and model-picker tests green.
- Run the focused LLM and Client tests, the affected package build, and the assembled Web artifact build.
- Refresh `http://127.0.0.1:3080` and verify the live model picker and Settings page after the affected artifacts rebuild.
- Run the repository's required documentation and diff checks for the design and Agent Note changes.

## Non-goals

This change does not add a Gemini model-listing endpoint, add a Settings-page model editor for OAuth providers, or read credentials from Gemini CLI or Cursor IDE private stores. It does not attempt a full Cursor protocol rewrite, replace the unofficial Connect client with `@cursor/sdk`, or promise functionality when Cursor's upstream service returns no usable data.

## Alternatives considered

- **Keep fallback models for every empty Cursor response:** rejected because a successful empty backend response currently advertises ids that the account or service did not confirm and causes misleading retries.
- **Change only the model picker:** rejected because the invalid state originates in provider discovery and streaming, not in rendering.
- **Treat the heartbeat-only stream as `EMPTY_RESPONSE`:** rejected because it loses the provider-side cause and permits the normal empty-response retry loop.
- **Port the latest community Cursor wire implementation immediately:** deferred because current live probes still return heartbeat-only responses with the candidate framing; a larger protocol rewrite requires a verified working comparison before it can be a safe fix.
- **Add a Gemini sign-in control or change the Settings row:** rejected because OAuth login is already a command flow and the current Settings presentation is intentional; the unresolved Gemini evidence is runtime state, not a proven UI contract defect.

## Risks and mitigations

A transient Cursor service response with an empty successful payload will hide the fallback group rather than present stale models. The diagnostic names the failed discovery operation, and a later topology refresh can retry listing. The external Cursor protocol remains unofficial; the tests pin failure classification and preserve valid fixture behavior without asserting that upstream availability is permanent.

The Gemini composition test may pass while a user's GUI still points at another Harness home or an old process. The test reports the host and Client contract only; live troubleshooting must compare the active process, Harness home, and built Web revision.
