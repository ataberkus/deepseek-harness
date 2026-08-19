# Agent Note: Host Cursor OAuth for Cursor models

Status: implemented

English | [中文](2026-08-18-cursor-oauth-host.zh.md)

## Problem

The Models page and model picker cannot run Cursor subscription models. pi-ai's installed catalog has no `cursor` provider: Codex login in [`oauth-login.ts`](../../../../packages/llm/llm-pi-ai/src/oauth-login.ts) is a ChatGPT browser PKCE flow that hangs `manual_code` on `127.0.0.1:1455`, and Cursor never redirects there. Cursor login opens `https://cursor.com/loginDeepControl` and polls `https://api2.cursor.sh/auth/poll`; inference is HTTP/2 Connect protobuf `POST /agent.v1.AgentService/Run`, not OpenAI Chat Completions.

Community clients implement that unofficial wire. [`@rahularya01/pi-cursor`](https://www.npmjs.com/package/@rahularya01/pi-cursor) is a Pi coding-agent extension: it does not export a Provider factory, depends on `@earendil-works/pi-coding-agent`, and by default reuses Cursor IDE / Keychain / `state.vscdb` tokens. oh-my-pi's Cursor file also maps Cursor-native shell and MCP execution into its own agent runtime.

## Decision

`dsh-llm-pi-ai` hosts Cursor OAuth on the same [`FileOAuthStore`](../../../../packages/llm/llm-pi-ai/src/oauth-store.ts) as [OpenAI Codex](2026-08-18-openai-codex-oauth-host.md). A table of hosted ids (`openai-codex`, `cursor`) owns `/login` / `/logout` and live-route injection. Empty `/login` remains `openai-codex`. Any other name fails. One in-flight login covers the whole host so a Cursor poll and a Codex localhost callback cannot race. The Web client still opens a blank tab for `/login`, `/login openai-codex`, and `/login cursor`.

Cursor login constructs the hosted `cursor` Provider (`auth.oauth.login` / `refreshToken`, no `auth.apiKey`) and calls `models.setProvider` plus `models.login('cursor', 'oauth', interaction)`. The interaction reuses `createBrowserOAuthInteraction` only to open `auth_url`; Cursor never prompts `select` or `manual_code`. Refresh uses `https://api2.cursor.sh/auth/exchange_user_api_key`.

`catalogProvider('cursor')` returns that hosted Provider so `catalogProviderTakesApiKey('cursor')` is false and the Models directory still withholds a key card. `catalogProviderIds()` does not list `cursor`. A stored `cursor` oauth credential injects a settings-free live route. A settings-declared `cursor` profile is not `auth: oauth`. The Models page shows the injected route as a signed-in row with Cursor copy and Sign out; Codex copy stays ChatGPT. There is no Sign-in button.

The unofficial AgentService client is owned here: Node 22 `http2` plus a focused protobuf codec (not a generated proto, not `@bufbuild/protobuf`). `streamSimple` maps harness/pi-ai context (messages plus harness tools advertised as MCP `dsh`) onto `AgentService/Run`. Conversation checkpoints stay in-process keyed by `sessionId`. Cursor-native exec / shell / MCP execution is ignored so tools and approvals stay on the harness loop. Listing overlays `GetUsableModels` live-first onto a bundled fallback that includes documented Fast SKUs (`grok-4.6`, `grok-4.6-fast`, and siblings Cursor ships). Network failure or an empty reply keeps the fallback; a documented `{id}-fast` sibling is added when live listing names only the standard id. `cursor-agent` is not in `LISTABLE_PROTOCOLS`.

`Provider is not configured: cursor` maps to `LlmError('MISSING_CREDENTIAL')` and names `/login cursor`.

This is not a public Cursor API. Cursor may change the wire or restrict accounts.

## Alternatives considered

**Wait for pi-ai to ship `cursor`.** Rejected: it would generalize `/login` to a table and leave Cursor unsupported, which does not meet adding Cursor models.

**Add `@rahularya01/pi-cursor` as an npm dependency.** Rejected: it is a Pi coding-agent extension, not a Provider factory, it pulls `pi-coding-agent`, and its default token source is the Cursor IDE.

**Vendor oh-my-pi's Cursor provider file.** Rejected: that file owns exec/MCP agent runtime this harness must not run. Tools stay on the harness permission loop.

**Copy Codex browser PKCE.** Rejected: Cursor has no localhost callback; hanging `manual_code` never completes.

**OpenAI-compatible Cursor proxy subprocess.** Rejected for the same reason as Codex app-server: another agent runtime would sit inside the harness tool and approval loop.

**Reading Cursor IDE Keychain / `state.vscdb`.** Rejected: it binds the harness to another product's private store and still needs refresh plus a `CredentialStore` this adapter can `modify`.

**`CURSOR_ACCESS_TOKEN` as a silent ambient key.** Rejected: same class as reading `~/.codex/auth.json`. Login is explicit `/login cursor`.

**Always-registering a keyless `cursor` route.** Rejected: a live keyless route would mark onboarding ready without a working provider.

**Models-page Sign-in button.** Rejected: a key field cannot complete Cursor login, and a Sign-in control on the Models page is out of scope with Codex.

**Putting Cursor tokens on `credentials.describe`.** Rejected: OAuth tokens stay in `FileOAuthStore`, not the API-key seam.

## Consequences

A CLI, ACP, or Web session can run `/login cursor`, complete Cursor browser login, and select a `cursor` model. Settings → Models shows that route as signed in with Cursor. The agent loop, tools, approvals, and session log stay harness-owned. The unofficial Connect/protobuf backend is a reverse-engineered subscription transport; a Cursor-side change updates this adapter.

Device-code login, a Models Sign-in button, `dsh auth login`, other OAuth catalog providers, IDE token reuse, and Cursor-native exec/MCP remain unoffered.

## Testing

`tests/cursor.spec.ts` pins poll 404-pending then tokens, abort, consecutive errors, refresh body, protobuf/Connect fixtures, GetUsableModels live-first overlay, documented Fast SKUs, AgentRunRequest flatten, stream mapping that ignores native exec, and adapter listing from a stored oauth file. `tests/oauth-login.spec.ts` pins `/login cursor` / `/logout cursor`, empty input still Codex, unknown names, overlapping `/login`, `commands/open-url`, boot injection without a directory card, settings-declared `cursor` is not `auth: oauth`, and `MISSING_CREDENTIAL` naming `/login cursor`. `tests/catalog.spec.ts` keeps the directory withholding `cursor` unless a settings profile names it. Models UI tests pin Cursor signed-in copy next to Codex ChatGPT copy. Package tests cover login text; a keyless assembled snapshot cannot replay Cursor login. Unit tests skip live `api2.cursor.sh` listing unless a test replaces the listing fetch.
