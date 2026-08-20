# Agent Note: Host Gemini CLI OAuth for Cloud Code Assist

Status: implemented

English | [中文](2026-08-19-google-gemini-cli-oauth-host.zh.md)

## Problem

The Models page and model picker cannot run Gemini CLI subscription models. pi-ai's installed catalog has `google` as an API-key Generative Language route: there is no `google-gemini-cli` provider. Gemini CLI login is Google auth-code on `127.0.0.1:8085/oauth2callback`, then Cloud Code Assist project discovery; inference is unofficial `POST /v1internal:streamGenerateContent?alt=sse` on `cloudcode-pa.googleapis.com`, not `generativelanguage.googleapis.com`.

Community clients implement that unofficial wire. [oh-my-pi](https://github.com/can1357/oh-my-pi) hosts `google-gemini-cli` (and a separate `google-antigravity` id) inside its own agent runtime, including leak-healing and Gemini CLI exec. pi-ai 0.82.1 still has no catalog factory for that OAuth host.

## Decision

`dsh-llm-pi-ai` hosts Gemini CLI OAuth on the same [`FileOAuthStore`](../../../../packages/llm/llm-pi-ai/src/oauth-store.ts) as [OpenAI Codex](2026-08-18-openai-codex-oauth-host.md) and [Cursor](2026-08-18-cursor-oauth-host.md). The hosted table is `openai-codex`, `cursor`, `google-gemini-cli`. Empty `/login` remains `openai-codex`. Any other name fails. One in-flight login covers the whole host so a Gemini loopback, a Codex PKCE callback, and a Cursor poll cannot race. The Web client opens a blank tab for `/login google-gemini-cli` as well. The loopback HTML only acknowledges receipt of Google's authorization response; `/login` reports success after token exchange, project discovery, and `models.login` persist the credential.

Gemini CLI login constructs the hosted `google-gemini-cli` Provider (`auth.oauth.login` / `refresh` / `toAuth`, no `auth.apiKey`) and calls `models.setProvider` plus `models.login('google-gemini-cli', 'oauth', interaction)`. The interaction reuses `createBrowserOAuthInteraction` only to open `auth_url`; Gemini CLI never prompts `select` or `manual_code`. Google's registered redirect for the public Gemini CLI installed-app client is `http://127.0.0.1:8085/oauth2callback`; tests may bind port `0`. The client id and secret are that public Gemini CLI client, base64-decoded at runtime, not a harness secret. After the token exchange, `discoverProject` calls `v1internal:loadCodeAssist` and may `onboardUser` plus poll the LRO. Workspace accounts that need an explicit GCP project read `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID`. The credential stores `projectId` beside access and refresh; refresh keeps it. `toAuth` sends `authorization: Bearer <access>` and `x-goog-user-project: <projectId>`.

`catalogProvider('google-gemini-cli')` returns that hosted Provider so `catalogProviderTakesApiKey('google-gemini-cli')` is false and the Models directory still withholds a key card. `catalogProviderIds()` does not list `google-gemini-cli`. A stored oauth credential injects a settings-free live route. A settings-declared `google-gemini-cli` profile is not `auth: oauth`. The Models page shows the injected route as a signed-in row with Gemini CLI copy and Sign out. There is no Sign-in button.

The unofficial Cloud Code Assist client is owned here. Message and tool conversion reuses `@earendil-works/pi-ai/api/google-shared`; this adapter only wraps that payload in the CCA envelope and maps SSE `functionCall` parts onto pi-ai `toolCall`. Gemini CLI exec, Antigravity, and leak-healing are not implemented, so tools and approvals stay on the harness loop. Listing is the bundled fallback (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-3-flash-preview`, `gemini-3-pro-preview`); Cloud Code Assist has no OpenAI-style `GET /models`. Requests identify as `GeminiCLI/0.46.0/...` plus `Client-Metadata`. `google-gemini-cli` is not in `LISTABLE_PROTOCOLS`. This is not the installed `google` API-key catalog provider.

`Provider is not configured: google-gemini-cli` maps to `LlmError('MISSING_CREDENTIAL')` and names `/login google-gemini-cli`.

This is not a public Google API. Google may change the wire or restrict accounts.

## Alternatives considered

**Wait for pi-ai to ship `google-gemini-cli`.** Rejected: it would leave Gemini CLI unsupported, which does not meet adding Gemini OAuth login.

**Treat it as `models.login('google', ...)`.** Rejected: pi-ai's `google` catalog is API-key Generative Language. Gemini CLI OAuth is a different host, redirect, and backend.

**Add oh-my-pi or `@rahularya01/pi-cursor` as an npm dependency.** Rejected: those packages are other agent runtimes, not a Provider factory this harness can `setProvider`.

**Vendor oh-my-pi's Gemini CLI file wholesale.** Rejected: that file owns exec, Antigravity, and leak-healing this harness must not run. Tools stay on the harness permission loop.

**Copy Codex browser PKCE.** Rejected: Gemini CLI is Google auth-code on port 8085, not OpenAI PKCE on 1455.

**Copy Cursor poll.** Rejected: Gemini CLI has a localhost callback; hanging a Cursor-style poll never completes.

**Host `google-antigravity` in the same change.** Rejected: one unofficial backend is enough; Antigravity is a different product and wire.

**Reading Gemini CLI on-disk credentials.** Rejected: it binds the harness to another product's private store and still needs refresh plus a `CredentialStore` this adapter can `modify`.

**`GEMINI_API_KEY` as a silent ambient OAuth credential.** Rejected: that key authenticates Generative Language, not Cloud Code Assist. Login is explicit `/login google-gemini-cli`.

**Always-registering a keyless `google-gemini-cli` route.** Rejected: a live keyless route would mark onboarding ready without a working provider.

**Models-page Sign-in button.** Rejected: a key field cannot complete Google OAuth, and a Sign-in control on the Models page is out of scope with Codex and Cursor.

**Live Cloud Code Assist model listing.** Rejected: there is no OpenAI-style list endpoint to overlay. The bundled fallback is the catalog after login.

**Putting Gemini tokens on `credentials.describe`.** Rejected: OAuth tokens stay in `FileOAuthStore`, not the API-key seam.

## Consequences

A CLI, ACP, or Web session can run `/login google-gemini-cli`, complete Google login, and select a `google-gemini-cli` model. Settings → Models shows that route as signed in with Gemini CLI. The agent loop, tools, approvals, and session log stay harness-owned. The unofficial Cloud Code Assist backend is a reverse-engineered subscription transport; a Google-side change updates this adapter.

Device-code login, a Models Sign-in button, `dsh auth login`, other OAuth catalog providers, Gemini CLI on-disk token reuse, `google-antigravity`, live CCA listing, and Gemini CLI exec remain unoffered.

## Testing

`tests/google-gemini-cli.spec.ts` pins the public-client authorize URL, token exchange, project discovery (existing companion, onboard plus LRO, workspace `GOOGLE_CLOUD_PROJECT`, VPC-SC), refresh that keeps `projectId`, loopback callback (success, denial, missing code, abort, second bind, second callback after settle), neutral callback HTML, request envelope and thinking-level map, and streamSimple mapping of text, thinking, and `functionCall` SSE — never a live Google API. `tests/oauth-login.spec.ts` pins `/login google-gemini-cli` / `/logout google-gemini-cli`, empty input still Codex, boot injection without a directory card, settings-declared `google-gemini-cli` is not `auth: oauth`, and `MISSING_CREDENTIAL` naming `/login google-gemini-cli`. `tests/catalog.spec.ts` keeps the directory withholding `google-gemini-cli` unless a settings profile names it. Models UI tests pin Gemini CLI signed-in copy. Package tests cover login text; a keyless assembled snapshot cannot replay Google login.
