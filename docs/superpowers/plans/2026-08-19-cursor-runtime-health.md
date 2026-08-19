# Cursor Runtime Health Implementation Plan

English | [中文](2026-08-19-cursor-runtime-health.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Cursor from advertising unconfirmed fallback models after a successful empty discovery response and stop heartbeat-only completions from becoming retryable generic `EMPTY_RESPONSE` failures.

**Architecture:** Keep network failures and missing access on the existing installed fallback path, but make a successful empty `GetUsableModels` response throw a typed Cursor catalog error. Preserve that code through the model-catalog wire result, clear only rejected per-snapshot listing promises so a user retry can recover, and classify a Cursor model with no content blocks as a non-retryable provider-specific stream failure. No Connect/protobuf wire rewrite is included.

**Tech Stack:** TypeScript, Vitest, Cordis LLM adapter, protobuf/Connect fixtures, Host API Proxy schemas, `LlmError`, Playwright/Web artifact verification.

**Spec:** `docs/superpowers/specs/2026-08-19-oauth-host-runtime-health.md` (Cursor discovery and streaming)

## Global Constraints

- Keep the bundled Cursor fallback for network failure and missing access; only a successful empty `GetUsableModels` payload is a typed no-usable-models failure.
- Use provider-specific codes `CURSOR_NO_USABLE_MODELS` and `CURSOR_EMPTY_STREAM`; neither belongs to the default retryable code list.
- Do not port a community Cursor protocol implementation or change framing, headers, field parsing, or request encoding without a separately verified upstream comparison.
- Never include access tokens, request bodies, or account identity in errors, tests, fixtures, or logs.
- Preserve valid Cursor text, thinking, tool-call, image, checkpoint, abort, and transport behavior.
- Use TDD: write and run the failing regression tests before production implementation changes.
- Update the package README pair and the implemented Agent Note pair in the same change as the behavior.
- The API catalog failure code is optional on the wire so existing non-Harness errors and older callers remain valid; a typed `HarnessError` exposes its stable code.

---

## File Map

- Modify: `packages/llm/llm-pi-ai/src/cursor/constants.ts` — define the two stable Cursor health codes.
- Modify: `packages/llm/llm-pi-ai/src/cursor/models.ts` — throw on a successful empty usable-model reply while retaining fallback for transport failure.
- Modify: `packages/llm/llm-pi-ai/src/adapter.ts` — remove rejected served-model promises so an explicit retry can re-list.
- Modify: `packages/llm/llm-pi-ai/src/stream.ts` — classify an empty Cursor completion separately from generic provider-neutral empty output.
- Modify: `packages/host/apiproxy/src/api/sessions.ts` — add optional `code` to `ModelCatalogFailure`.
- Modify: `packages/host/apiproxy/src/api/sessions.schema.ts` — validate the optional non-empty failure code.
- Modify: `packages/host/apiproxy/src/api-proxy.ts` — preserve `HarnessError.code` while building provider-local catalog failures.
- Modify: `packages/llm/llm-pi-ai/tests/cursor.spec.ts` — failing listing, retry, and heartbeat-only stream regressions.
- Modify: `packages/llm/llm-pi-ai/tests/convert.spec.ts` — provider-specific empty-stop mapping and generic behavior preservation.
- Modify: `packages/host/apiproxy/tests/api-proxy-models.spec.ts` — typed catalog failure propagation.
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts` — optional catalog failure code wire validation.
- Modify: `packages/llm/llm-pi-ai/README.md` and `packages/llm/llm-pi-ai/README.zh.md` — current listing and failure semantics.
- Modify: `.agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.md` and its Chinese counterpart — update the current Cursor listing/testing facts.
- Move and rewrite: `.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md` and `.zh.md` into `.agents/notes/implemented/bug-fix/` — record the shipped runtime-health decision.

## Interfaces

- Consumes: `cursorListingInternals.fetch`, `listCursorModels`, `PiAiAdapter.listModels`, `mapStopReason`, `ModelCatalogFailure`, `HarnessError`, and existing Cursor stream fixtures.
- Produces: `CURSOR_NO_USABLE_MODELS_CODE`, `CURSOR_EMPTY_STREAM_CODE`, optional `ModelCatalogFailure.code`, retryable-safe finish chunks, and a re-listable Cursor snapshot after an empty response.

### Task 1: Add failing Cursor listing, stream, and wire tests

**Files:**
- Modify: `packages/llm/llm-pi-ai/tests/cursor.spec.ts`
- Modify: `packages/llm/llm-pi-ai/tests/convert.spec.ts`
- Modify: `packages/host/apiproxy/tests/api-proxy-models.spec.ts`
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts`

**Interfaces:**
- Consumes: current fallback behavior, `cursorListingInternals`, `streamCursor`, `mapStopReason`, `CatalogAdapter`, and `sessionModelsValueSchema`.
- Produces: executable regressions that fail under the current fallback and generic `EMPTY_RESPONSE` behavior.

- [ ] **Step 1: Write the failing model-listing tests**

In the `cursor models` suite, replace the empty-success expectation with a typed failure and keep the transport-failure expectation:

```text
it('rejects a successful empty GetUsableModels response without exposing the fallback', async () => {
  cursorListingInternals.fetch = async () => new Uint8Array()
  await expect(listCursorModels('token')).rejects.toMatchObject({
    code: 'CURSOR_NO_USABLE_MODELS',
    message: expect.stringContaining('GetUsableModels'),
  })
})

it('keeps the fallback when GetUsableModels cannot be reached', async () => {
  cursorListingInternals.fetch = async () => { throw new Error('down') }
  await expect(listCursorModels('token')).resolves.toEqual(expect.arrayContaining(
    cursorFallbackModels(),
  ))
})
```

Add an adapter-level test with one `PiAiAdapter` snapshot: the first `cursorListingInternals.fetch` returns an empty payload and rejects `adapter.listModels('cursor')`; the second call returns a payload containing `live-only` and resolves with that id. This proves a rejected `servedModels` promise is not retained as a permanent snapshot failure.

- [ ] **Step 2: Write the failing heartbeat-only stream tests**

In `cursor.spec.ts`, replace the test helper that collects only event types with a local helper that retains events for one new case. Feed a single field-13 heartbeat update followed by EOF or field-14 turn end, then assert the pi-ai event remains a `done` event with no content. Convert that stream through `toStreamChunks` and assert the final finish code is `CURSOR_EMPTY_STREAM` and its message names a heartbeat-only Cursor response.

In `convert.spec.ts`, add the provider-specific direct mapping beside the existing generic assertion:

```text
it('classifies an empty Cursor stop as a non-retryable Cursor backend failure', () => {
  expect(mapStopReason(assistant({ provider: 'cursor', stopReason: 'stop' }))).toEqual({
    kind: 'error',
    failure: {
      code: 'CURSOR_EMPTY_STREAM',
      message: expect.stringContaining('heartbeat-only'),
    },
  })
})
```

Keep the existing DeepSeek assertion expecting `EMPTY_RESPONSE`; the provider-specific exception must not change generic adapters.

- [ ] **Step 3: Write the failing typed-catalog-failure tests**

In `api-proxy-models.spec.ts`, register a small `CatalogAdapter` whose `listModels()` rejects with `new LlmError('Cursor GetUsableModels returned no usable models', 'CURSOR_NO_USABLE_MODELS')`, call `sessions.models`, and assert the failure contains `{ code: 'CURSOR_NO_USABLE_MODELS' }` alongside id, name, and message. Keep plain `Error('catalog offline')` expectations code-free.

In `rpc-schemas.spec.ts`, add `code: 'CURSOR_NO_USABLE_MODELS'` to one parsed `sessionModelsValueSchema` failure and assert the parsed value keeps it. The code field must remain optional for the existing failure fixture.

- [ ] **Step 4: Run the focused tests and verify they fail for the intended reasons**

Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

Expected: failures show the current empty listing returning fallback, the empty Cursor stop returning `EMPTY_RESPONSE`, the rejected listing being cached or lacking the new code, and the wire type not preserving `code`. Do not change assertions to accommodate unrelated failures.

### Task 2: Implement typed Cursor discovery and stream classification

**Files:**
- Modify: `packages/llm/llm-pi-ai/src/cursor/constants.ts`
- Modify: `packages/llm/llm-pi-ai/src/cursor/models.ts`
- Modify: `packages/llm/llm-pi-ai/src/adapter.ts`
- Modify: `packages/llm/llm-pi-ai/src/stream.ts`

**Interfaces:**
- Consumes: the failing tests from Task 1 and existing `LlmError`, `CURSOR_PROVIDER`, `AssistantMessage`, and served-model snapshot types.
- Produces: stable codes and behavior that Task 3 can expose through the Host catalog wire.

- [ ] **Step 1: Define provider-owned health codes**

Add these documented constants to `cursor/constants.ts`:

```text
/** Successful GetUsableModels response contained no usable model rows. */
export const CURSOR_NO_USABLE_MODELS_CODE = 'CURSOR_NO_USABLE_MODELS'

/** Cursor Run closed after heartbeat updates without text, thinking, or tools. */
export const CURSOR_EMPTY_STREAM_CODE = 'CURSOR_EMPTY_STREAM'
```

Do not add either code to `packages/llm/llm/src/retry-policy.ts`; the default retryable list must continue to contain `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT` only.

- [ ] **Step 2: Make empty successful Cursor discovery fail without swallowing transport fallback**

In `listCursorModels`, keep the fallback construction and fetch inside a transport-only `try/catch`. Decode the successful payload after the catch; if `live.length === 0`, throw:

```text
throw new LlmError(
  'Cursor GetUsableModels returned no usable models; check the Cursor service and retry model discovery',
  CURSOR_NO_USABLE_MODELS_CODE,
)
```

Return `withFastVariants(mergeCursorCatalogs(live, fallback))` for a non-empty live reply and keep `withFastVariants(fallback)` only for a fetch/connect failure. The message must not include the token or payload.

- [ ] **Step 3: Allow explicit retry after a rejected listing**

In `PiAiAdapter.servedModels`, await the cached promise inside `try/catch`. When it rejects, delete the cache entry only if it still points at that same promise, then rethrow the original error. Successful listings remain memoized for the immutable snapshot; a failed empty discovery can be retried without rebuilding credentials or routes.

Update the adjacent JSDoc in `adapter.ts` and `models.ts` so it says transport failure falls back but a successful empty reply fails.

- [ ] **Step 4: Map empty Cursor stops to a non-retryable provider code**

Import `CURSOR_EMPTY_STREAM_CODE` into `stream.ts`. In `mapStopReason`, keep the context-overflow check first, then in the `stop` branch detect `message.content.length === 0 && message.provider === CURSOR_PROVIDER`. Return:

```text
{
  kind: 'error',
  failure: {
    message: `Cursor backend returned a heartbeat-only response with no content for model "${message.model}"; retry after the Cursor service recovers`,
    code: CURSOR_EMPTY_STREAM_CODE,
  },
}
```

Leave non-Cursor empty stops on the existing `EMPTY_RESPONSE` path, and leave any Cursor response containing text, thinking, or a tool call successful. The code is absent from the default retry list, so the existing retry plugin will not repeat this known backend result.

- [ ] **Step 5: Run the focused LLM tests**

Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts --reporter=dot`

Expected: the new discovery, retry, heartbeat-only, and generic-empty tests pass with all existing Cursor wire/image/checkpoint tests.

### Task 3: Preserve typed catalog failure codes at the Host wire

**Files:**
- Modify: `packages/host/apiproxy/src/api/sessions.ts:141-149`
- Modify: `packages/host/apiproxy/src/api/sessions.schema.ts:183-188`
- Modify: `packages/host/apiproxy/src/api-proxy.ts:9-18,333-339`
- Modify: `packages/host/apiproxy/tests/api-proxy-models.spec.ts`
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts`

**Interfaces:**
- Consumes: `HarnessError.code` from `@deepseek-ai/dsh-llm` and `CURSOR_NO_USABLE_MODELS_CODE` from Task 2.
- Produces: `ModelCatalogFailure.code?: string` on both `llm.models` and `session.models`, with old plain-error responses unchanged.

- [ ] **Step 1: Add the optional type and schema field**

Extend `ModelCatalogFailure` with:

```text
/** Stable Harness error code when the provider raised a HarnessError. */
code?: string
```

Add `code: z.string().min(1).optional()` to `modelCatalogFailureSchema`. Do not make it required; plain provider exceptions continue to serialize as id, name, and message.

- [ ] **Step 2: Preserve only stable Harness codes in `buildModelCatalog`**

Import the runtime `HarnessError` value alongside the existing LLM imports. Build the failure as:

```text
const failure: ModelCatalogFailure = {
  id: provider.id,
  name: provider.name,
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof HarnessError ? { code: error.code } : {}),
}
```

Do not stringify causes or attach provider request data. The existing provider name and message remain the user-facing diagnostic.

- [ ] **Step 3: Run Host API tests**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

Expected: typed Cursor failures carry `code`, plain errors do not, and all existing catalog grouping and schema rejection tests pass.

- [ ] **Step 4: Run the combined provider/Host regression set**

Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/oauth-login.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

Expected: all focused OAuth, Cursor, conversion, catalog, and wire-schema tests pass.

- [ ] **Step 5: Commit the production behavior**

```sh
git add packages/llm/llm-pi-ai/src/cursor/constants.ts packages/llm/llm-pi-ai/src/cursor/models.ts packages/llm/llm-pi-ai/src/adapter.ts packages/llm/llm-pi-ai/src/stream.ts packages/host/apiproxy/src/api/sessions.ts packages/host/apiproxy/src/api/sessions.schema.ts packages/host/apiproxy/src/api-proxy.ts packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts
git commit -m "fix: classify empty Cursor backend responses"
```

### Task 4: Update package documentation and shipped Agent Notes

**Files:**
- Modify: `packages/llm/llm-pi-ai/README.md`
- Modify: `packages/llm/llm-pi-ai/README.zh.md`
- Modify: `.agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.md`
- Modify: `.agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.zh.md`
- Move and rewrite: `.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md` and `.zh.md` to `.agents/notes/implemented/bug-fix/`

**Interfaces:**
- Consumes: shipped codes and API fields from Tasks 2 and 3.
- Produces: current package contract, current Cursor OAuth note, and implemented runtime-health note without proposal-era headings.

- [ ] **Step 1: Update the package README pair**

In the Catalog resolution and Vocabulary sections, state that Cursor network/listing transport failure retains the fallback, while a successful empty `GetUsableModels` response produces `CURSOR_NO_USABLE_MODELS` and a provider-local catalog failure. State that a Cursor empty stop produces `CURSOR_EMPTY_STREAM` and is outside the default retryable codes; generic non-Cursor empty stops remain `EMPTY_RESPONSE`. Make the same factual changes in `README.zh.md` without re-translating unrelated prose.

- [ ] **Step 2: Update the active Cursor OAuth note in place**

Replace the current fallback sentence in the Decision section with the split behavior shipped by Task 2. Add the two stable error codes and the retry consequence to the Testing or Consequences section. Keep login, credentials, image handling, and protocol ownership facts unchanged. Update the Chinese counterpart identically in structure.

- [ ] **Step 3: Move the runtime-health proposal to implemented**

Move both proposed files into `.agents/notes/implemented/bug-fix/`, change `Status: proposed` to `Status: implemented`, rewrite `## Proposal` as present-tense `## Decision`, fold `## Acceptance criteria` into `## Testing`, and fold `## Risks` into `## Consequences`. Record the actual code paths and tests from this plan. Preserve the cross-links to the Cursor and Gemini hosting notes; do not archive either hosting note because each still owns a non-superseded login/catalog decision.

- [ ] **Step 4: Run documentation gates**

Run: `pnpm run verify-agent-note-format && pnpm run verify-md-wrap && pnpm run verify-md-links && pnpm run doc-sync`

Expected: the note lifecycle, English/Chinese pairing, Markdown wrapping/links, package README contract, and documentation synchronization checks pass.

- [ ] **Step 5: Commit documentation**

```sh
git add packages/llm/llm-pi-ai/README.md packages/llm/llm-pi-ai/README.zh.md .agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.md .agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.zh.md .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md
git commit -m "docs: document Cursor runtime health codes"
```

### Task 5: Build and verify the shipped Web runtime

**Files:**
- No additional source files; verify the affected package and assembled Web artifact.

**Interfaces:**
- Consumes: the production and documentation commits from Tasks 1-4.
- Produces: verified built artifacts and live GUI evidence for model catalog failure handling and unchanged model picker behavior.

- [ ] **Step 1: Run focused package and Host checks once more from the committed state**

Run: `pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/oauth-login.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts --reporter=dot`

Expected: all focused tests pass without relying on uncommitted test output.

- [ ] **Step 2: Build the source and Web artifacts**

Run: `pnpm run build`

Expected: TypeScript, package bundles, and the `apps/web/dist` artifact build successfully. Do not start a replacement Web server.

- [ ] **Step 3: Run the assembled keyless Web lane**

Run: `DSH_SNAPSHOT=replay pnpm run test:web:built`

Expected: existing Web e2e scenarios pass or self-skip according to the repository's replay policy; no new model call is made by this change.

- [ ] **Step 4: Refresh the existing GUI and verify the actual URL**

Refresh `http://127.0.0.1:3080` after the build. Verify Settings → Models still displays connected Cursor state from the active credential store, while a Cursor empty discovery is represented as a provider failure rather than a fallback model group. Verify the model picker still renders valid seeded groups and that no page error appears.

- [ ] **Step 5: Run final diff and verification checks**

Run: `git -c safe.directory=C:/Windows/System32/deepseek-harness diff --check; git -c safe.directory=C:/Windows/System32/deepseek-harness status --short`

Expected: no whitespace errors, only intended paths changed, and unrelated pre-existing untracked files remain untouched.

## Plan self-review

- **Spec coverage:** successful-empty discovery, transport fallback, retry after a rejected listing, provider-specific heartbeat-only failure, default non-retry behavior, typed catalog failure propagation, valid Cursor stream preservation, documentation, build, and live GUI verification all have explicit tasks.
- **Placeholder scan:** every task names exact files, symbols, assertions, commands, and commit boundaries; no TBD/TODO implementation placeholders remain.
- **Type consistency:** the two constants are defined in `cursor/constants.ts`, consumed by `models.ts` and `stream.ts`, `ModelCatalogFailure.code` is optional in the Host type and schema, and `HarnessError.code` is copied only at `buildModelCatalog`.
