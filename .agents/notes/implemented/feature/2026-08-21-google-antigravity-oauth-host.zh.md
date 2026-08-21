# Agent Note: 托管用于 Cloud Code Assist 的 Antigravity OAuth

Status: implemented

[English](2026-08-21-google-antigravity-oauth-host.md) | 中文

## 问题

模型页和模型选择器无法为普通 Google 账号连接 Cloud Code Assist，因为之前的 Gemini CLI OAuth 客户端需要显式 Google Cloud 项目配置（`GOOGLE_CLOUD_PROJECT`）、使用端口 8085，并且缺少 Antigravity 的自动免费层级项目开通以及更广泛的模型支持（Gemini 3.7 Flash、Claude Opus 4.5/4.6、Claude Sonnet 4.5/4.6、GPT OSS 120B 等）。

Oh My Pi 通过 Antigravity 的公开 OAuth 客户端（`1071006060591-...`）、`127.0.0.1:51121/oauth-callback` 上的回调、`loadCodeAssist` 项目发现以及自动化的 `onboardUser` 层级开通来托管 `google-antigravity`。

## 决策

`dsh-llm-pi-ai` 将 Gemini CLI OAuth 宿主完全替换为 `google-antigravity`，并在同一份 [`FileOAuthStore`](../../../../packages/llm/llm-pi-ai/src/oauth-store.ts) 上与 `openai-codex` 和 `cursor` 并列托管。托管表为 `openai-codex`、`cursor`、`google-antigravity`。支持 `/login google-antigravity`（以及 `/login antigravity` 别名）和 `/logout google-antigravity`。

Antigravity 登录在 `127.0.0.1:51121/oauth-callback` 上使用公开的 Antigravity 客户端。在与 Google OAuth 完成授权码换票后，`discoverProject` 会在 `https://daily-cloudcode-pa.googleapis.com`（回退至 `https://cloudcode-pa.googleapis.com`）上携带 `{ metadata: { ideType: "ANTIGRAVITY" } }` 调用 `loadCodeAssist`。若尚无项目，则自动通过带 `ide_type: "ANTIGRAVITY"` 的 `onboardUser` 开通用户层级，无需任何手动 GCP 项目配置。

推理请求采用 Antigravity 信封格式（`project`、`requestId`、`request: { contents, systemInstruction, tools, toolConfig, generationConfig, labels, sessionId }`、`model`、`userAgent: "antigravity"`、`requestType: "agent"`），并为 Claude 推理模型附带 `anthropic-beta: interleaved-thinking-2025-05-14`。内置回退目录包括 Gemini 3.7 Flash、Gemini 3.1 Pro、Gemini 3 Flash/Pro、Gemini 2.5 Pro/Flash、Claude Sonnet 4.5/4.6、Claude Opus 4.5/4.6 以及 GPT OSS 120B。

## Alternatives considered

**保留 Gemini CLI OAuth。** 不采用：它的显式项目要求、回调端口和较窄的模型覆盖无法提供托管的 Antigravity 连接。

**要求用户配置 Google Cloud 项目。** 不采用：Antigravity 的公开客户端和 Cloud Code Assist 开通流程可以在没有部署专属项目设置的情况下发现并开通免费层级项目。

**把 Antigravity 增加为 API-key 提供方。** 不采用：该路由通过浏览器 OAuth 鉴权并保存 refresh credential，而不是使用 API key。

## 影响

CLI、ACP 或 Web 会话可以运行 `/login google-antigravity`，完成 Google 登录，零配置接入 Antigravity 模型。设置 → 模型会把该路由显示为已使用 Antigravity 登录。

## 测试

`packages/llm/llm-pi-ai/tests/google-antigravity.spec.ts` 钉住 Antigravity 授权 URL、换票、通过 `loadCodeAssist` 与 `onboardUser` 完成的项目发现与开通、保留 `projectId` 的刷新、回调回环服务器、带 agent 信封的请求格式化、thinking 选项以及 SSE 流式传输。`packages/llm/llm-pi-ai/tests/oauth-login.spec.ts` 钉住 `/login google-antigravity` 和 `/logout google-antigravity` 流程。
