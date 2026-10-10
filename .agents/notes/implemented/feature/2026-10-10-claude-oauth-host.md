# Agent Note: Port Oh My Pi's Claude subscription OAuth

Status: implemented

English | [中文](2026-10-10-claude-oauth-host.zh.md)

## Problem

`/login claude` ran pi-ai's built-in Anthropic OAuth: a callback bound only to `127.0.0.1:53692` while advertising `localhost`, code exchange and refresh on `platform.claude.com`, a state equal to the PKCE verifier, refresh without Claude Code's headers, and no account or organization identity on the stored credential.

Oh My Pi signs in with the same public Claude Code client but follows Claude Code's own requests: `packages/catalog/src/compat/rules/auth/anthropic.kdl` declares the flow, and `packages/ai/src/registry/oauth/anthropic.ts` supplies the identity lookup.

## Decision

[`anthropic/oauth.ts`](../../../../packages/llm/llm-pi-ai/src/anthropic/oauth.ts) ports the login and credential parts of that flow, and [`catalog.ts`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) swaps it into the catalog `anthropic` provider's `auth.oauth`. `/login claude`, the Models-page authorization flow, and token refresh therefore all use it; the API-key method, models, and streams stay pi-ai's.

- Authorize on `https://claude.ai/oauth/authorize` with PKCE S256, a separate 16-byte hex `state`, `code=true`, and Claude Code's scopes.
- Listen on `localhost:54545/callback`, bound on both `127.0.0.1` and `::1`; a busy port falls back to a random one. Only a redirect carrying this login's `state` completes or fails the login. A pasted redirect URL, query string, or `code#state` is accepted through the `manual_code` prompt.
- Exchange and refresh with JSON on `https://api.anthropic.com/v1/oauth/token`; the exchange sends `state`, and refresh sends `anthropic-beta: oauth-2025-04-20` and `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`. Expiry keeps a five-minute margin; an unrotated refresh token is kept.
- Store `accountId`, `email`, `orgId`, and `orgName` from the token response, or from `/api/claude_cli/bootstrap` when it omits them. Refresh never rewrites the organization captured at login.

Request-side Claude Code identity (`sk-ant-oat` detection, the `claude-code-20250219` and `oauth-2025-04-20` betas, the Claude Code system block and tool names) stays with pi-ai's `anthropic-messages`, which already sends them at Claude Code 2.1.280.

## Alternatives considered

**Keep pi-ai's Claude OAuth.** Rejected: it diverges from Claude Code's token endpoint and refresh headers and drops identity.

**Vendor Oh My Pi's declarative auth engine.** Rejected: one provider does not justify the KDL compiler, hook registry, and broker; the port keeps only the requests that provider makes.

**Port Oh My Pi's request runtime.** Rejected: pi-ai already sends the Claude Code request identity, and a second request path would fork the `anthropic` stream.

## Consequences

The callback port changes from 53692 to 54545. Credentials stored by the previous flow keep working: the record format is unchanged, and refresh adds identity when the bootstrap lookup succeeds.

`/logout` now declares the same `input` hint as `/login`. Without it, the Web composer ran only the bare `/logout`, which signs out of `openai-codex`, and sent `/logout claude` to the model as a chat message.

## Testing

[`tests/anthropic-oauth.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/anthropic-oauth.spec.ts) covers the authorize URL, callback state checks, pasted input, port fallback, cancellation, exchange and refresh requests, and identity lookup. [`tests/oauth-login.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/oauth-login.spec.ts) covers `/login claude` and `/logout claude`.
