# Agent Note: 为 Cursor 模型托管 Cursor OAuth

Status: implemented

[English](2026-08-18-cursor-oauth-host.md) | 中文

## 问题

模型页和模型选择器无法运行 Cursor 订阅模型。pi-ai 已安装 catalog 没有 `cursor` 提供方：[`oauth-login.ts`](../../../../packages/llm/llm-pi-ai/src/oauth-login.ts) 里的 Codex 登录是 ChatGPT 浏览器 PKCE，并把 `manual_code` 挂在 `127.0.0.1:1455` 上，而 Cursor 从不重定向到那里。Cursor 登录打开 `https://cursor.com/loginDeepControl` 并轮询 `https://api2.cursor.sh/auth/poll`；推理是 HTTP/2 Connect protobuf `POST /agent.v1.AgentService/Run`，不是 OpenAI Chat Completions。

社区客户端实现的是这条非官方协议。[`@rahularya01/pi-cursor`](https://www.npmjs.com/package/@rahularya01/pi-cursor) 是 Pi coding-agent 扩展：它不导出 Provider 工厂，依赖 `@earendil-works/pi-coding-agent`，默认还复用 Cursor IDE／钥匙串／`state.vscdb` 的 token。oh-my-pi 的 Cursor 文件也会把 Cursor 原生的 shell 与 MCP 执行映射进它自己的 agent runtime。

## 决策

`dsh-llm-pi-ai` 把 Cursor OAuth 托管在 [`FileOAuthStore`](../../../../packages/llm/llm-pi-ai/src/oauth-store.ts) 上，与 [OpenAI Codex](2026-08-18-openai-codex-oauth-host.md) 和 [Gemini CLI](2026-08-19-google-gemini-cli-oauth-host.md) 共用同一份存储。一张托管 id 表（`openai-codex`、`cursor`、`google-gemini-cli`）拥有 `/login`／`/logout` 以及 live 路由注入。空的 `/login` 仍表示 `openai-codex`。其他名字失败。一次进行中的登录覆盖整个宿主，因此 Cursor 轮询、Codex 的 localhost 回调与 Gemini 回环不能竞态。Web 客户端仍会为 `/login`、`/login openai-codex`、`/login cursor` 和 `/login google-gemini-cli` 打开空白标签。

Cursor 登录构造托管的 `cursor` Provider（`auth.oauth.login`／`refreshToken`，没有 `auth.apiKey`），并调用 `models.setProvider` 以及 `models.login('cursor', 'oauth', interaction)`。interaction 只复用 `createBrowserOAuthInteraction` 来打开 `auth_url`；Cursor 从不提示 `select` 或 `manual_code`。刷新走 `https://api2.cursor.sh/auth/exchange_user_api_key`。

`catalogProvider('cursor')` 返回该托管 Provider，因此 `catalogProviderTakesApiKey('cursor')` 为 false，模型目录仍然不提供密钥卡片。`catalogProviderIds()` 不列出 `cursor`。已存储的 `cursor` oauth 凭据会注入一条无 settings 的 live 路由。settings 声明的 `cursor` profile 不是 `auth: oauth`。模型页把注入路由显示为已登录行，文案是 Cursor，并提供退出登录；Codex 文案仍是 ChatGPT。没有 Sign-in 按钮。

非官方 AgentService 客户端由本适配器持有：Node 22 `http2` 加上一份聚焦的 protobuf 编解码（不是生成的 proto，也不是 `@bufbuild/protobuf`）。`streamSimple` 把 harness／pi-ai 上下文（消息加上作为 MCP `dsh` 通告的 harness 工具）映射到 `AgentService/Run`。用户栅格图片走非官方 `UserMessage.selected_context` 的 `SelectedImage`。会话检查点按 `sessionId` 留在进程内。Cursor 原生的 exec／shell／MCP 执行会被忽略，因此工具与审批仍走 harness 循环。列表把 `GetUsableModels` 以实时优先叠到捆绑 fallback 上，fallback 含 Cursor 已记录的 Fast SKU（`grok-4.6`、`grok-4.6-fast` 及其兄弟项）。网络失败或空回复保留 fallback；实时列表只点名标准 id 时会补上已记录的 `{id}-fast` 兄弟项。`cursor-agent` 不在 `LISTABLE_PROTOCOLS` 里。

`Provider is not configured: cursor` 映射为 `LlmError('MISSING_CREDENTIAL')`，并点名 `/login cursor`。

这不是公开的 Cursor API。Cursor 可能改协议或限制账号。

## 考虑过的替代方案

**等 pi-ai 提供 `cursor`。** 否决：那只会把 `/login` 做成一张表并让 Cursor 继续不受支持，达不到「加入 Cursor 模型」。

**把 `@rahularya01/pi-cursor` 加为 npm 依赖。** 否决：它是 Pi coding-agent 扩展，不是 Provider 工厂，会拉入 `pi-coding-agent`，默认 token 来源还是 Cursor IDE。

**把 oh-my-pi 的 Cursor 提供方文件 vendoring 进来。** 否决：那份文件拥有本 harness 不得运行的 exec／MCP agent runtime。工具必须留在 harness 权限循环上。

**照搬 Codex 浏览器 PKCE。** 否决：Cursor 没有 localhost 回调；挂起 `manual_code` 永远完不成。

**OpenAI 兼容的 Cursor 代理子进程。** 与 Codex app-server 同样否决：另一套 agent runtime 会插进 harness 的工具与审批循环。

**读取 Cursor IDE 钥匙串／`state.vscdb`。** 否决：这会把 harness 绑到另一个产品的私有存储，而且仍然需要刷新以及一份本适配器能 `modify` 的 `CredentialStore`。

**把 `CURSOR_ACCESS_TOKEN` 当成静默环境密钥。** 否决：这与读取 `~/.codex/auth.json` 同类。登录必须是显式的 `/login cursor`。

**在没有已存 token 时始终注册无密钥 `cursor` 路由。** 否决：一条无密钥 live 路由会在没有可用提供方时把引导标成就绪。

**模型页 Sign-in 按钮。** 否决：密钥字段无法完成 Cursor 登录，而且模型页上的 Sign-in 控件与 Codex 一样不在范围内。

**把 Cursor token 放到 `credentials.describe`。** 否决：OAuth token 留在 `FileOAuthStore`，不进 API 密钥层。

## 后果

CLI、ACP 或 Web 会话可以运行 `/login cursor`，完成 Cursor 浏览器登录，然后选择 `cursor` 模型。设置 → 模型会把该路由显示为已使用 Cursor 登录。agent 循环、工具、审批与会话日志仍由 harness 拥有。非官方 Connect／protobuf 后端是反向工程的订阅传输；Cursor 侧变更时更新的是本适配器。

device-code 登录、模型页 Sign-in 按钮、`dsh auth login`、其他 OAuth catalog 提供方、IDE token 复用，以及 Cursor 原生 exec／MCP 仍不提供。

## 测试

`tests/cursor.spec.ts` 钉住轮询 404 pending 随后得到 token、中止、连续错误、刷新响应体、protobuf／Connect 夹具、GetUsableModels 实时优先叠加、已记录 Fast SKU、推断出的图片输入、AgentRunRequest 的 `SelectedImage` 编码、忽略原生 exec 的流映射，以及从已存 oauth 文件做适配器列表。`tests/oauth-login.spec.ts` 钉住 `/login cursor`／`/logout cursor`、空输入仍是 Codex、未知名字、重叠 `/login`、`commands/open-url`、无目录卡片的启动注入、settings 声明的 `cursor` 不是 `auth: oauth`，以及 `MISSING_CREDENTIAL` 点名 `/login cursor`。`tests/catalog.spec.ts` 保留目录不予提供 `cursor`，除非 settings profile 点名它。模型 UI 测试把 Cursor 已登录文案钉在 Codex 的 ChatGPT 文案旁边。包测试覆盖登录文本；无密钥的装配快照无法重放 Cursor 登录。单元测试会跳过对 `api2.cursor.sh` 的实时列表，除非测试替换 listing fetch。
