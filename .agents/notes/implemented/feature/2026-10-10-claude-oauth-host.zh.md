# Agent Note: 移植 Oh My Pi 的 Claude 订阅 OAuth

Status: implemented

[English](2026-10-10-claude-oauth-host.md) | 中文

## 问题

`/login claude` 原先运行 pi-ai 内置的 Anthropic OAuth：回调只绑定 `127.0.0.1:53692` 却声明 `localhost`，授权码交换与刷新走 `platform.claude.com`，`state` 等于 PKCE verifier，刷新不带 Claude Code 的请求头，存储的凭据也没有账号或组织身份。

Oh My Pi 使用同一个公开的 Claude Code 客户端登录，但遵循 Claude Code 自身的请求：其 catalog 包（`src/compat/rules/auth/anthropic.kdl`）声明该流程，其 ai 包（`src/registry/oauth/anthropic.ts`）提供身份查询。

## 决策

[`anthropic/oauth.ts`](../../../../packages/llm/llm-pi-ai/src/anthropic/oauth.ts) 移植该流程中的登录与凭据部分，[`catalog.ts`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) 将其换入目录 `anthropic` provider 的 `auth.oauth`。因此 `/login claude`、模型页授权流程与 token 刷新都使用它；API 密钥方法、模型与流仍由 pi-ai 提供。

- 在 `https://claude.ai/oauth/authorize` 授权，使用 PKCE S256、独立的 16 字节十六进制 `state`、`code=true` 与 Claude Code 的 scope。
- 监听 `localhost:54545/callback`，同时绑定 `127.0.0.1` 与 `::1`；端口被占用时改用随机端口。只有携带本次登录 `state` 的重定向才会完成或终止登录。`manual_code` 提示接受粘贴的重定向 URL、查询串或 `code#state`。
- 以 JSON 在 `https://api.anthropic.com/v1/oauth/token` 交换与刷新；交换发送 `state`，刷新发送 `anthropic-beta: oauth-2025-04-20` 与 `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider`。过期时间保留五分钟余量；未轮换的 refresh token 保持不变。
- 从 token 响应存储 `accountId`、`email`、`orgId` 与 `orgName`，响应缺失时改从 `/api/claude_cli/bootstrap` 获取。刷新从不改写登录时记录的组织。

请求侧的 Claude Code 身份（`sk-ant-oat` 识别、`claude-code-20250219` 与 `oauth-2025-04-20` beta、Claude Code 系统块与工具名）仍由 pi-ai 的 `anthropic-messages` 负责，它已以 Claude Code 2.1.280 发送这些内容。

## 备选方案

**保留 pi-ai 的 Claude OAuth。** 否决：它与 Claude Code 的 token 端点和刷新请求头不一致，且丢失身份。

**引入 Oh My Pi 的声明式认证引擎。** 否决：单个 provider 不足以支撑 KDL 编译器、hook 注册表与 broker；移植只保留该 provider 实际发出的请求。

**移植 Oh My Pi 的请求运行时。** 否决：pi-ai 已发送 Claude Code 请求身份，第二条请求路径会分叉 `anthropic` 流。

## 影响

回调端口由 53692 改为 54545。旧流程存储的凭据继续可用：记录格式不变，bootstrap 查询成功时刷新会补充身份。

`/logout` 现在声明与 `/login` 相同的 `input` 提示。此前 Web 输入框只执行不带参数的 `/logout`（即退出 `openai-codex`），并把 `/logout claude` 作为对话消息发送给模型。

## 测试

[`tests/anthropic-oauth.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/anthropic-oauth.spec.ts) 覆盖授权 URL、回调 state 校验、粘贴输入、端口回退、取消、交换与刷新请求以及身份查询。[`tests/oauth-login.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/oauth-login.spec.ts) 覆盖 `/login claude` 与 `/logout claude`。
