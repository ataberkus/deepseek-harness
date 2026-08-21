# Agent Note: Host Antigravity OAuth for Cloud Code Assist

Status: implemented

English | [中文](2026-08-21-google-antigravity-oauth-host.zh.md)

## Problem

The Models page and model picker could not connect standard Google accounts through Cloud Code Assist because the previous Gemini CLI OAuth client required explicit Google Cloud projects (`GOOGLE_CLOUD_PROJECT`), used port 8085, and lacked Antigravity's automatic free-tier project provisioning and broader model support (Gemini 3.7 Flash, Claude Opus 4.5/4.6, Claude Sonnet 4.5/4.6, GPT OSS 120B).

Oh My Pi hosts `google-antigravity` through Antigravity's public OAuth client (`1071006060591-...`), callback on `127.0.0.1:51121/oauth-callback`, `loadCodeAssist` project discovery, and automated `onboardUser` tier provisioning.

## Decision

`dsh-llm-pi-ai` replaces the Gemini CLI OAuth host with `google-antigravity` on the same [`FileOAuthStore`](../../../../packages/llm/llm-pi-ai/src/oauth-store.ts) alongside `openai-codex` and `cursor`. The hosted table is `openai-codex`, `cursor`, `google-antigravity`. Commands support `/login google-antigravity` (and `/login antigravity` alias), and `/logout google-antigravity`.

Antigravity login uses the public Antigravity client on `127.0.0.1:51121/oauth-callback`. After exchanging the authorization code with Google OAuth, `discoverProject` checks `loadCodeAssist` on `https://daily-cloudcode-pa.googleapis.com` (fallback to `https://cloudcode-pa.googleapis.com`) with `{ metadata: { ideType: "ANTIGRAVITY" } }`. If no project exists, it automatically provisions the user tier via `onboardUser` with `ide_type: "ANTIGRAVITY"`, requiring zero manual GCP project setup.

Inference requests are formatted in the Antigravity envelope (`project`, `requestId`, `request: { contents, systemInstruction, tools, toolConfig, generationConfig, labels, sessionId }`, `model`, `userAgent: "antigravity"`, `requestType: "agent"`), adding `anthropic-beta: interleaved-thinking-2025-05-14` for Claude reasoning models. The bundled fallback catalog includes Gemini 3.7 Flash, Gemini 3.1 Pro, Gemini 3 Flash/Pro, Gemini 2.5 Pro/Flash, Claude Sonnet 4.5/4.6, Claude Opus 4.5/4.6, and GPT OSS 120B.

## Alternatives considered

**Retain Gemini CLI OAuth.** Rejected: its explicit project requirement, callback port, and narrower model coverage do not provide the hosted Antigravity connection.

**Require users to configure a Google Cloud project.** Rejected: Antigravity's public client and Cloud Code Assist provisioning can discover and provision the free-tier project without a deployment-specific project setting.

**Add Antigravity as an API-key provider.** Rejected: the route authenticates through browser OAuth and stores refresh credentials, not an API key.

## Consequences

A CLI, ACP, or Web session can run `/login google-antigravity`, complete Google login, and access Antigravity models with zero cloud project configuration. Settings → Models shows the route as signed in with Antigravity.

## Testing

`packages/llm/llm-pi-ai/tests/google-antigravity.spec.ts` pins the Antigravity authorize URL, token exchange, project discovery and provisioning via `loadCodeAssist` and `onboardUser`, refresh keeping `projectId`, callback loopback server, request formatting with agent envelope, thinking options, and SSE streaming. `packages/llm/llm-pi-ai/tests/oauth-login.spec.ts` pins `/login google-antigravity` and `/logout google-antigravity` flows.
