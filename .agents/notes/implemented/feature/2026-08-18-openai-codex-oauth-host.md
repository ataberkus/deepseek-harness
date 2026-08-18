# Agent Note: Host OpenAI Codex OAuth inside llm-pi-ai

Status: implemented

English | [中文](2026-08-18-openai-codex-oauth-host.zh.md)

## Problem

The Models page cannot authenticate `openai-codex` with a key field. pi-ai's installed catalog ships that route as OAuth-only: ChatGPT browser PKCE, a stored access and refresh token, and the Codex Responses backend — not `api.openai.com` Chat Completions and not `DEEPSEEK_API_KEY`. The [directory withholding](../bug-fix/2026-08-13-oauth-only-providers-withheld.md) closed the broken key card; without a host login and a persistent `CredentialStore`, the route still could not run.

Hand-rolling a second Codex Responses client beside pi-ai would duplicate OAuth refresh, SSE, and tool mapping that `@earendil-works/pi-ai` already owns. Spawning OpenAI's Codex app-server would insert another agent runtime between the harness loop and the model.

## Decision

`dsh-llm-pi-ai` is the OAuth host for the installed `openai-codex` catalog provider. pi-ai remains the Codex transport.

`FileOAuthStore` implements pi-ai's `CredentialStore` at `$DSH_HOME/oauth-credentials.json` (owner-only `0600`, parent `0700`, `writeFileAtomic` plus a cross-process lock). `modify` is the only write path so token refresh cannot double-rotate. Diagnostics name the path and key, never access or refresh tokens. API keys stay on the harness credential seam and still arrive per request as `apiKey`; only OAuth credentials enter the `createModels({ credentials })` collection.

`/login [openai-codex]` and `/logout [openai-codex]` register through `ctx.inject(['commands'])` because `commands` loads after `llm-pi-ai` in the base bundle. Empty input means `openai-codex`; any other name fails. Browser login is the only offered method: the interaction always selects pi-ai's `browser` id, opens the authorize URL, and hangs `manual_code` until the localhost callback aborts it. Device-code login is not offered.

The host opens that URL as one argv: `open` on macOS, `xdg-open` on desktop Linux, and `rundll32.exe url.dll,FileProtocolHandler` on Windows and WSL. `cmd /c start` splits on `&`, which drops `client_id` and the remaining OAuth query and makes OpenAI render `missing_required_parameter`. A second `/login` while the first is still waiting is refused so two authorize URLs cannot share pi-ai's `127.0.0.1:1455` callback (that mismatch is OpenAI's **Authentication failed / State mismatch** page). The authorize URL is emitted as `commands/open-url` (forwarded to the Web client; never a session-log event) and also written to stderr so a mangled tab can be recovered by pasting the whole URL; it carries PKCE challenge and state, never access or refresh tokens.

The Web client opens a blank tab during the `/login` keystroke and navigates it when `commands/open-url` arrives. A `window.open` after the URL is known is popup-blocked; the Node `dsh web` process cannot reliably open a tab in the already-open browser. CLI and ACP still use the OS opener. The named tab is reused so a second `/login` does not replace an in-progress authorize page with `about:blank`.

A stored `openai-codex` oauth credential injects a settings-free live route into the adapter registry so the model picker can list pi-ai's catalog models. The configurable-provider directory still withholds the OAuth-only catalog **key card**, which is the withholding note's decision; a settings-stored profile still appears there so it can be edited or deleted. The live route names no `apiKeyEnv`, so first-run onboarding still requires a usable API-key provider until Codex login. The Models page shows that injected route as a read-only signed-in row (name plus connected dot, no editor, no Sign-in button). Logout remains `/logout openai-codex`.

`Provider is not configured` maps to `LlmError('MISSING_CREDENTIAL')` and names `/login openai-codex`.

## Alternatives considered

**A new `dsh-llm-openai-codex` package with a hand-rolled Responses/SSE client.** Rejected: the harness already wraps pi-ai for every other non-DeepSeek catalog route, and [preferring maintained dependencies](../process/2026-07-26-dependencies-over-hand-rolling.md) forbids duplicating a protocol pi-ai already ships.

**JSON-RPC to OpenAI's Codex app-server subprocess.** Rejected: authentication would be cheaper, but the model backend would no longer be a model backend — Codex's own agent runtime would sit inside the harness tool and approval loop.

**Reading `~/.codex/auth.json`.** Rejected: it binds the harness to another tool's private file format and still needs refresh plus a store pi-ai can `modify`.

**Always-registering `openai-codex` without a stored token.** Rejected: a live keyless route would mark onboarding ready without a working provider and would churn Models/onboarding snapshots. Registration follows a stored credential.

**Putting OAuth JSON in `$DSH_HOME/.credentials.yaml` or an environment variable.** Rejected: that document is the API-key seam; pi-ai refresh expects a `CredentialStore` keyed by provider id, and refresh tokens must not appear in process listings or logs.

**Opening the authorize URL only from the Node process.** Rejected for `dsh web`: the server process cannot reliably open a tab in the already-open browser, and a `window.open` after the URL arrives is popup-blocked. The Web client opens a blank tab during the `/login` keystroke and the Host forwards `commands/open-url` so that tab can navigate. CLI keeps the OS opener.

**Un-withholding `openai-codex` as a key card on the Models page.** Rejected: a key field still cannot complete ChatGPT login. A read-only connected row is not that card: it reports OAuth state the host already knows, without a Sign-in control or an editable key.

## Consequences

A CLI, ACP, or Web session can run `/login openai-codex`, complete ChatGPT browser login, and select an `openai-codex` model. Settings → Models then shows the route as signed in with ChatGPT. The agent loop, tools, approvals, and session log stay harness-owned; pi-ai owns PKCE, refresh, and Codex Responses. The Codex backend is not a public-API stability contract — an OpenAI change updates the pi-ai adapter, not a harness-owned wire parser.

Device-code / SSH login, a Models-page Sign-in button, a `dsh auth login` launcher subcommand, image input, and other OAuth-only catalog providers remain unoffered.

## Testing

`tests/oauth-store.spec.ts` pins parse refusals that never quote secrets, owner-only persistence, `modify`/`delete`/`list`, concurrent writes, and POSIX world-readable refusal. `tests/oauth-login.spec.ts` pins browser-only interaction, `/login`/`/logout`, overlapping `/login` refusal, `commands/open-url` emission, live-route injection without a directory card, `listProviders().auth === 'oauth'`, boot from a stored file, colliding-route containment, `MISSING_CREDENTIAL` for an unconfigured keyless Codex stream, and opener argv so a URL containing `&` stays one argument on Windows and WSL (`rundll32`). `packages/host/apiproxy/tests/api-proxy-config.spec.ts` pins undeclared OAuth views carrying `auth` and `connected`. `packages/client/ui-settings-models/tests` pin the store join (generic `settingsNs: ''` stays hidden; `auth: oauth` is configured) and the read-only signed-in row. Plugin-apply tests stub `$DSH_HOME` so a developer's credential file cannot inject a live route. Directory withholding tests in `tests/catalog.spec.ts` stay: the key card remains absent unless a settings profile names the route. The authorize-URL stderr line is pinned in that package test; a keyless assembled snapshot cannot replay ChatGPT login.
