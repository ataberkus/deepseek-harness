# Agent Note: 为 Cloud Code Assist 托管 Gemini CLI OAuth

Status: implemented

[English](2026-08-19-google-gemini-cli-oauth-host.md) | 中文

## 问题

模型页和模型选择器无法运行 Gemini CLI 订阅模型。pi-ai 已安装 catalog 里的 `google` 是 API 密钥版 Generative Language 路由：没有 `google-gemini-cli` 提供方。Gemini CLI 登录是 Google 授权码，回调在 `127.0.0.1:8085/oauth2callback`，随后做 Cloud Code Assist 项目发现；推理是非官方的 `POST /v1internal:streamGenerateContent?alt=sse`（`cloudcode-pa.googleapis.com`），不是 `generativelanguage.googleapis.com`。

社区客户端实现的是这条非官方协议。[oh-my-pi](https://github.com/can1357/oh-my-pi) 在自己的 agent runtime 里托管 `google-gemini-cli`（以及另一个 `google-antigravity` id），还包括 leak-healing 与 Gemini CLI exec。pi-ai 0.82.1 仍没有该 OAuth 宿主的 catalog 工厂。

## 决策

`dsh-llm-pi-ai` 把 Gemini CLI OAuth 托管在 [`FileOAuthStore`](../../../../packages/llm/llm-pi-ai/src/oauth-store.ts) 上，与 [OpenAI Codex](2026-08-18-openai-codex-oauth-host.md) 和 [Cursor](2026-08-18-cursor-oauth-host.md) 共用同一份存储。托管表是 `openai-codex`、`cursor`、`google-gemini-cli`。空的 `/login` 仍表示 `openai-codex`。其他名字失败。一次进行中的登录覆盖整个宿主，因此 Gemini 回环、Codex PKCE 回调与 Cursor 轮询不能竞态。Web 客户端也会为 `/login google-gemini-cli` 打开空白标签。

Gemini CLI 登录构造托管的 `google-gemini-cli` Provider（`auth.oauth.login`／`refresh`／`toAuth`，没有 `auth.apiKey`），并调用 `models.setProvider` 以及 `models.login('google-gemini-cli', 'oauth', interaction)`。interaction 只复用 `createBrowserOAuthInteraction` 来打开 `auth_url`；Gemini CLI 从不提示 `select` 或 `manual_code`。公开 Gemini CLI 已安装应用客户端在 Google 注册的重定向是 `http://127.0.0.1:8085/oauth2callback`；测试可以绑定端口 `0`。client id 与 secret 就是该公开 Gemini CLI 客户端，运行时再 base64 解码，不是 harness 密钥。换票之后，`discoverProject` 调用 `v1internal:loadCodeAssist`，必要时再 `onboardUser` 并轮询 LRO。需要显式 GCP 项目的 Workspace 账号读取 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID`。凭据把 `projectId` 与 access／refresh 存在一起；刷新会保留它。`toAuth` 发送 `authorization: Bearer <access>` 和 `x-goog-user-project: <projectId>`。

`catalogProvider('google-gemini-cli')` 返回该托管 Provider，因此 `catalogProviderTakesApiKey('google-gemini-cli')` 为 false，模型目录仍然不提供密钥卡片。`catalogProviderIds()` 不列出 `google-gemini-cli`。已存储的 oauth 凭据会注入一条无 settings 的 live 路由。settings 声明的 `google-gemini-cli` profile 不是 `auth: oauth`。模型页把注入路由显示为已登录行，文案是 Gemini CLI，并提供退出登录。没有 Sign-in 按钮。

非官方 Cloud Code Assist 客户端由本适配器持有。消息与工具转换复用 `@earendil-works/pi-ai/api/google-shared`；本适配器只把该载荷包进 CCA 信封，并把 SSE `functionCall` 部分映射为 pi-ai `toolCall`。不实现 Gemini CLI exec、Antigravity 和 leak-healing，因此工具与审批仍走 harness 循环。列表是捆绑 fallback（`gemini-2.5-flash`、`gemini-2.5-pro`、`gemini-2.0-flash`、`gemini-3-flash-preview`、`gemini-3-pro-preview`）；Cloud Code Assist 没有 OpenAI 式的 `GET /models`。请求以 `GeminiCLI/0.46.0/...` 加上 `Client-Metadata` 标识。`google-gemini-cli` 不在 `LISTABLE_PROTOCOLS` 里。这不是已安装的 `google` API 密钥 catalog 提供方。

`Provider is not configured: google-gemini-cli` 映射为 `LlmError('MISSING_CREDENTIAL')`，并点名 `/login google-gemini-cli`。

这不是公开的 Google API。Google 可能改协议或限制账号。

## 考虑过的替代方案

**等 pi-ai 提供 `google-gemini-cli`。** 否决：那会让 Gemini CLI 继续不受支持，达不到「加入 Gemini OAuth 登录」。

**当成 `models.login('google', ...)`。** 否决：pi-ai 的 `google` catalog 是 API 密钥版 Generative Language。Gemini CLI OAuth 是另一套宿主、重定向和后端。

**把 oh-my-pi 或 `@rahularya01/pi-cursor` 加为 npm 依赖。** 否决：那些包是其他 agent runtime，不是本 harness 能 `setProvider` 的 Provider 工厂。

**把 oh-my-pi 的 Gemini CLI 文件整份 vendoring 进来。** 否决：那份文件拥有本 harness 不得运行的 exec、Antigravity 与 leak-healing。工具必须留在 harness 权限循环上。

**照搬 Codex 浏览器 PKCE。** 否决：Gemini CLI 是端口 8085 上的 Google 授权码，不是 1455 上的 OpenAI PKCE。

**照搬 Cursor 轮询。** 否决：Gemini CLI 有 localhost 回调；挂起 Cursor 式轮询永远完不成。

**同一变更里托管 `google-antigravity`。** 否决：一条非官方后端已经足够；Antigravity 是另一个产品和协议。

**读取 Gemini CLI 磁盘上的凭据。** 否决：这会把 harness 绑到另一个产品的私有存储，而且仍然需要刷新以及一份本适配器能 `modify` 的 `CredentialStore`。

**把 `GEMINI_API_KEY` 当成静默环境 OAuth 凭据。** 否决：该密钥认证的是 Generative Language，不是 Cloud Code Assist。登录必须是显式的 `/login google-gemini-cli`。

**在没有已存 token 时始终注册无密钥 `google-gemini-cli` 路由。** 否决：一条无密钥 live 路由会在没有可用提供方时把引导标成就绪。

**模型页 Sign-in 按钮。** 否决：密钥字段无法完成 Google OAuth，而且模型页上的 Sign-in 控件与 Codex、Cursor 一样不在范围内。

**实时 Cloud Code Assist 模型列表。** 否决：没有可叠加的 OpenAI 式列表端点。登录后的 catalog 就是捆绑 fallback。

**把 Gemini token 放到 `credentials.describe`。** 否决：OAuth token 留在 `FileOAuthStore`，不进 API 密钥层。

## 后果

CLI、ACP 或 Web 会话可以运行 `/login google-gemini-cli`，完成 Google 登录，然后选择 `google-gemini-cli` 模型。设置 → 模型会把该路由显示为已使用 Gemini CLI 登录。agent 循环、工具、审批与会话日志仍由 harness 拥有。非官方 Cloud Code Assist 后端是反向工程的订阅传输；Google 侧变更时更新的是本适配器。

device-code 登录、模型页 Sign-in 按钮、`dsh auth login`、其他 OAuth catalog 提供方、复用 Gemini CLI 磁盘 token、`google-antigravity`、实时 CCA 列表，以及 Gemini CLI exec 仍不提供。

## 测试

`tests/google-gemini-cli.spec.ts` 钉住公开客户端授权 URL、换票、项目发现（已有 companion、onboard 加 LRO、Workspace 的 `GOOGLE_CLOUD_PROJECT`、VPC-SC）、保留 `projectId` 的刷新、回环回调（成功、拒绝、缺 code、中止、二次绑定、结算后再来一次回调）、请求信封与 thinking 档位映射，以及把文本、thinking 和 `functionCall` SSE 映射到 streamSimple——从不访问真实 Google API。`tests/oauth-login.spec.ts` 钉住 `/login google-gemini-cli`／`/logout google-gemini-cli`、空输入仍是 Codex、无目录卡片的启动注入、settings 声明的 `google-gemini-cli` 不是 `auth: oauth`，以及 `MISSING_CREDENTIAL` 点名 `/login google-gemini-cli`。`tests/catalog.spec.ts` 保留目录不予提供 `google-gemini-cli`，除非 settings profile 点名它。模型 UI 测试钉住 Gemini CLI 已登录文案。包测试覆盖登录文本；无密钥的装配快照无法重放 Google 登录。
