# Gemini OAuth Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a completed Gemini CLI OAuth login reaches the real Web host and refreshes an already-loaded model directory without changing the already-passing Gemini catalog implementation.

**Architecture:** Extend the existing real Web scaffold test lane rather than adding a second host or a test-only product composition. The test will configure one deterministic non-OAuth seed route, open the real browser model picker, complete Gemini OAuth against mocked Google/Cloud Code Assist HTTP and loopback callback edges, and assert both the host catalog and the live picker after the forwarded topology event. A client browser-plugin unit test separately pins the lazy rule that an invalidation does not load a directory that has never been opened.

**Tech Stack:** TypeScript, Vitest, Playwright, Cordis Loader composition, the existing `launchWebScaffold`, Node 22 `fetch` and loopback HTTP callback, `@deepseek-ai/dsh-llm-pi-ai` hosted OAuth.

**Spec:** `docs/superpowers/specs/2026-08-19-oauth-host-runtime-health.md` (Gemini composition check)

## Global Constraints

- Do not alter the Gemini provider catalog or Cloud Code Assist wire unless a regression exposes a defect.
- Mock only Google OAuth, Cloud Code Assist project discovery, and the browser-opening edge; never call a real Google endpoint or store a real token.
- Keep the test keyless and model-call-free; a stray model request must fail loudly through the scaffold's no-adapter guard.
- Assert the real Host HTTP/WebSocket composition and user-visible model-picker state, not only a hand-built `Context`.
- Keep OAuth access and refresh values out of logs, screenshots, fixtures, and assertion messages.
- Preserve the existing command-based OAuth presentation; do not add a Models-page Sign-in control.
- Add or update the non-trivial Agent Note in the same implementation change.
- Use TDD: write and run the failing regression before changing production behavior.

---

## File Map

- Create: `apps/web/tests/oauth-model-directory.e2e.ts` — real-composition browser regression for Gemini login, host catalog visibility, forwarded topology invalidation, and picker refresh.
- Modify: `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` — lazy-directory invalidation regression for an unopened session directory.
- Review only: `packages/llm/llm-pi-ai/tests/oauth-login.spec.ts` — retain the existing unit coverage for command persistence and route registration; do not duplicate it in the browser test.
- Modify after implementation: `.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md` — move to the implemented lifecycle and record the shipped test path, then update the English/Chinese pair together.

## Interfaces

- Consumes: `launchWebScaffold`, `WebScaffold.ctx`, `connectFreshWorkspaceZh`, `settingsNamespace`, `SessionId`, `ctx.agents.create`, and the existing remote `llm/adapters-updated` forwarding.
- Produces: an executable `apps/web/tests/oauth-model-directory.e2e.ts` that proves a mocked `/login google-gemini-cli` completion makes `Gemini 2.5 Flash` appear in an already-open picker, plus a browser-plugin assertion that an unopened directory makes zero `session.models` calls on invalidation.

### Task 1: Add the lazy-directory failing regression

**Files:**
- Modify: `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts:139-323`

**Interfaces:**
- Consumes: the existing `bench()` return value with `calls.models` and `ctx.remote.$dispatch`.
- Produces: a test that fails if `llm/adapters-updated` eagerly creates or loads a directory.

- [ ] **Step 1: Write the failing test**

Add this test in the `ui-model-selection dual entry` suite:

```ts
it('does not load an unopened directory when the Host topology changes', async () => {
  const b = await bench()
  b.ctx.remote.$dispatch('llm/adapters-updated', [])
  await Promise.resolve()
  await Promise.resolve()
  expect(b.calls.models).toBe(0)
})
```

- [ ] **Step 2: Run the focused test to verify the regression is executable**

Run: `pnpm exec vitest run packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts -t "does not load an unopened directory"`

Expected: the new test passes against the current lazy implementation. If it fails, stop and diagnose the client service before proceeding; do not weaken the assertion.

- [ ] **Step 3: Keep production client code unchanged unless the test exposes an eager-load defect**

The existing `ModelDirectoryResolver` refresh loop iterates only `live.directories`. Do not refactor it or add a second lazy flag when the test passes.

- [ ] **Step 4: Run the complete package browser-plugin file**

Run: `pnpm exec vitest run packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts`

Expected: all existing shared-directory, reconnect, routing, and disposal tests pass.

- [ ] **Step 5: Commit the isolated test deliverable**

```sh
git add packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts
git commit -m "test: pin lazy model-directory invalidation"
```

### Task 2: Add the real Web Gemini OAuth composition regression

**Files:**
- Create: `apps/web/tests/oauth-model-directory.e2e.ts`
- Review: `apps/web/tests/scaffold.ts:166-184` and `apps/web/tests/support.ts:57-110`

**Interfaces:**
- Consumes: the built Web artifact served by `launchWebScaffold`, the host `commands` and `apiProxy` faces, and the browser model selector.
- Produces: a keyless, model-call-free Web e2e that crosses OAuth persistence, route registration, host catalog assembly, remote event forwarding, and Client picker refresh.

- [ ] **Step 1: Write the failing browser regression**

Create one serial `describe` block with these setup actions:

```ts
const SEED_PROVIDER = 'oauth-e2e-seed'
const SEED_MODEL = 'oauth-e2e-model'

beforeAll(async () => {
  scaffold = await launchWebScaffold({})
  await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
    providers: {
      [SEED_PROVIDER]: {
        displayName: 'OAuth E2E Seed',
        api: 'openai-completions',
        baseURL: 'https://oauth-e2e.invalid/v1',
        models: [{ id: SEED_MODEL, name: 'OAuth E2E Seed Model' }],
      },
    },
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  tripwire = watchConsole(page)
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
})
```

The test must install a temporary `globalThis.fetch` wrapper before invoking the login command. It delegates every unrelated URL to the original fetch and returns deterministic JSON only for `https://oauth2.googleapis.com/token` and `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`. The token response uses fixed test-only strings and the load response returns a companion project id. Listen for `commands/open-url`, parse the emitted authorize URL, and request its `redirect_uri` with the emitted `state` and a fixed authorization code so the real loopback callback server completes. Restore the original fetch in `afterAll` even if the command fails.

Create a real Agent with `scaffold.ctx.agents.create({ sessionId: SessionId('oauth-model-directory'), meta: { cwd: scaffold.workspaceCwd } })`; execute `/login google-gemini-cli` through `scaffold.ctx.commands.execute` with a bounded signal. Do not log the command result until secrets are removed.

The test body must first open the real model picker and wait for `OAuth E2E Seed Model`, proving the directory is loaded before login. After the command returns the exact existing success text, assert the host `scaffold.ctx.apiProxy.llm.models(...)` or the session model response contains provider `google-gemini-cli` and `gemini-2.5-flash`. Leave the picker open and assert the browser now contains `Gemini 2.5 Flash`; this proves the forwarded `llm/adapters-updated` reached the existing directory rather than relying on a page reload. Assert `tripwire.pageErrors` is empty and that page content contains neither test access nor refresh values.

Use `onTestFailed` and `saveFailureShot` with a non-secret filename. Dispose the created Agent, browser, and scaffold in `afterAll` in that order.

- [ ] **Step 2: Run the new browser test to verify it fails before implementation if the composed event path is broken**

Run: `pnpm run build && pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/oauth-model-directory.e2e.ts`

Expected: the test either passes against the existing implementation, proving no Gemini production fix is needed, or fails at the precise missing composition assertion. A failure caused by the detached browser opener or a port collision is test-harness setup failure and must be fixed at the mocked edge, not by removing the login or reload assertion.

- [ ] **Step 3: Implement only test-harness corrections exposed by the test**

If the login command completes but the picker does not update, inspect the Host `llm/adapters-updated` forwarding and Client `ModelDirectoryResolver` subscription. Do not add a second refresh call in the test. If the host group is absent, inspect the scaffold's built package revision and OAuth credential home before changing provider code.

- [ ] **Step 4: Run the focused browser and host OAuth suites**

Run: `pnpm exec vitest run packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts packages/llm/llm-pi-ai/tests/oauth-login.spec.ts`

Expected: existing OAuth command persistence and client directory behavior remain green.

- [ ] **Step 5: Commit the real-composition regression**

```sh
git add apps/web/tests/oauth-model-directory.e2e.ts
git commit -m "test: cover Gemini OAuth model-directory refresh"
```

### Task 3: Update the implemented Agent Note after test verification

**Files:**
- Modify: `.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md`
- Modify: `.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md`
- Modify: `.agents/notes/implemented/feature/2026-08-19-google-gemini-cli-oauth-host.md` only if the shipped test changes a factual testing statement.

**Interfaces:**
- Consumes: the committed test paths and observed composed behavior from Tasks 1 and 2.
- Produces: an implemented Agent Note pair with present-tense testing facts and no stale proposal headings.

- [ ] **Step 1: Move the proposed note into `implemented/bug-fix/` and rewrite its lifecycle sections**

Change `Status: proposed` to `Status: implemented`, rewrite `## Proposal` as present-tense `## Decision`, fold `## Acceptance criteria` into a present-tense `## Testing` section, and fold `## Risks` into `## Consequences`. Preserve the links to the Cursor and Gemini OAuth hosting notes. Keep the Chinese counterpart structurally aligned.

- [ ] **Step 2: Record the exact test coverage and preserve the Gemini note's ownership**

Name `apps/web/tests/oauth-model-directory.e2e.ts` and `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` in the implemented note. Do not duplicate the Gemini OAuth protocol decision; link to the existing Gemini hosting note instead.

- [ ] **Step 3: Run documentation gates**

Run: `pnpm run verify-agent-note-format && pnpm run verify-md-wrap && pnpm run verify-md-links`

Expected: all Agent Notes and Markdown links pass.

- [ ] **Step 4: Commit the documentation lifecycle update**

```sh
git add .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md
git commit -m "docs: record OAuth composition coverage"
```

## Plan self-review

- **Spec coverage:** Gemini route injection, host `llm.models`, forwarded `llm/adapters-updated`, loaded-picker refresh, and unopened-directory laziness are covered by Tasks 1 and 2. No Gemini catalog or protocol code is changed because the existing provider and OAuth unit tests already pin it.
- **Placeholder scan:** every step names a file, assertion, command, or exact lifecycle rewrite; no TODO/TBD implementation placeholders remain.
- **Type consistency:** `launchWebScaffold` returns `WebScaffold.ctx`; the existing scaffold and support helpers supply the exact browser/Host faces used by the test; the test-only seed provider is an OpenAI-compatible hand-declared route with an explicit model.
