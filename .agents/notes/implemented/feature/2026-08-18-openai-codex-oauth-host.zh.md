# Agent Note: 在 llm-pi-ai 内托管 OpenAI Codex OAuth

Status: implemented

[English](2026-08-18-openai-codex-oauth-host.md) | 中文

## 问题

模型页无法用密钥字段认证 `openai-codex`。pi-ai 已安装 catalog 把该路由标成仅 OAuth：ChatGPT 浏览器 PKCE、已存储的 access/refresh token，以及 Codex Responses 后端——不是 `api.openai.com` 的 Chat Completions，也不是 `DEEPSEEK_API_KEY`。[目录不予提供](../bug-fix/2026-08-13-oauth-only-providers-withheld.md)关掉了坏掉的密钥卡片；若没有宿主登录和持久 `CredentialStore`，这条路由仍然跑不起来。

在 pi-ai 旁边再手写一套 Codex Responses 客户端，会重复 pi-ai 已经拥有的 OAuth 刷新、SSE 与工具映射。把 OpenAI 的 Codex app-server 拉成子进程，则会在 harness 循环和模型之间再插入另一套 agent runtime。

## 决策

`dsh-llm-pi-ai` 是已安装 `openai-codex` catalog 提供方的 OAuth 宿主。Codex 传输仍由 pi-ai 负责。

`FileOAuthStore` 实现 pi-ai 的 `CredentialStore`，文件在 `$DSH_HOME/oauth-credentials.json`（属主只读 `0600`，父目录 `0700`，`writeFileAtomic` 外加跨进程锁）。唯一写路径是 `modify`，避免 token 刷新被旋转两次。诊断只点名路径和键，从不写出 access 或 refresh token。API 密钥仍走 harness 凭据层，并按请求以 `apiKey` 传入；进入 `createModels({ credentials })` 集合的只有 OAuth 凭据。

`/login [openai-codex]` 与 `/logout [openai-codex]` 通过 `ctx.inject(['commands'])` 注册，因为 base bundle 里 `commands` 在 `llm-pi-ai` 之后加载。空输入表示 `openai-codex`；其他名字失败。只提供浏览器登录：interaction 始终选择 pi-ai 的 `browser` id，打开授权 URL，并让 `manual_code` 挂起直到 localhost 回调中止它。不提供 device-code 登录。

宿主把该 URL 作为单一 argv 打开：macOS 用 `open`，桌面 Linux 用 `xdg-open`，Windows 与 WSL 用 `rundll32.exe url.dll,FileProtocolHandler`。`cmd /c start` 会在 `&` 处拆开命令，从而丢掉 `client_id` 和其余 OAuth 查询，OpenAI 就会渲染 `missing_required_parameter`。第一次登录仍在等待时，第二次 `/login` 会被拒绝，避免两条授权 URL 共用 pi-ai 的 `127.0.0.1:1455` 回调（那种 mismatch 就是 OpenAI 的 **Authentication failed / State mismatch** 页）。授权 URL 以 `commands/open-url` 发出（转发到 Web 客户端；绝不是会话日志事件），并写到 stderr，浏览器标签被截断时可以把整段 URL 粘贴回去；其中只有 PKCE challenge 与 state，没有 access 或 refresh token。

Web 客户端在提交 `/login` 的按键手势里打开空白标签，并在收到 `commands/open-url` 时导航到授权页。授权 URL 到达后再 `window.open` 会被弹窗拦截；Node 里的 `dsh web` 进程也无法可靠地在已经打开的浏览器里再开标签。CLI 与 ACP 仍使用操作系统 opener。命名标签会被复用，因此第二次 `/login` 不会把进行中的授权页换成 `about:blank`。

已存储的 `openai-codex` oauth 凭据会向适配器注册表注入一条无 settings 的 live 路由，模型选择器因此可以列出 pi-ai catalog 模型。可配置提供方目录仍然不提供仅 OAuth 的 catalog **密钥卡片**，这是不予提供那条笔记的决策；settings 里已存储的 profile 仍会出现在目录中，以便编辑或删除。live 路由不点名 `apiKeyEnv`，因此首次引导在 Codex 登录之前仍要求有一个可用的 API 密钥提供方。模型页把这条注入路由显示为已登录行（名称加上已连接圆点，通过 `llm.logout` 退出登录，没有编辑器，也没有 Sign-in 按钮）。`/logout openai-codex` 仍是命令等价物。

`Provider is not configured` 映射为 `LlmError('MISSING_CREDENTIAL')`，并点名 `/login openai-codex`。托管的 `cursor` 与 `google-gemini-cli` 登录是同一 store 与命令表上的兄弟路由；那些非官方传输见 [Cursor OAuth 宿主](2026-08-18-cursor-oauth-host.md) 和 [Gemini CLI OAuth 宿主](2026-08-19-google-gemini-cli-oauth-host.md)。

## 考虑过的替代方案

**新建 `dsh-llm-openai-codex` 包并手写 Responses/SSE 客户端。** 否决：harness 对其余非 DeepSeek catalog 路由已经包装 pi-ai，且[优先使用受维护依赖](../process/2026-07-26-dependencies-over-hand-rolling.md)禁止再复制 pi-ai 已经提供的协议。

**经 JSON-RPC 把 OpenAI Codex app-server 当子进程。** 否决：认证维护会更轻，但模型后端将不再只是模型后端——Codex 自己的 agent runtime 会插进 harness 的工具与审批循环。

**读取 `~/.codex/auth.json`。** 否决：这会把 harness 绑到另一个工具的私有文件格式上，而且仍然需要刷新以及一份 pi-ai 能 `modify` 的存储。

**在没有已存 token 时始终注册 `openai-codex`。** 否决：一条无密钥 live 路由会在没有可用提供方时把引导标成就绪，并搅动模型页／引导快照。注册跟随已存储凭据。

**把 OAuth JSON 放进 `$DSH_HOME/.credentials.yaml` 或环境变量。** 否决：那份文档是 API 密钥层；pi-ai 刷新需要按提供方 id 索引的 `CredentialStore`，且 refresh token 不得出现在进程列表或日志里。

**只从 Node 进程打开授权 URL。** 对 `dsh web` 否决：服务进程无法可靠地在已经打开的浏览器里再开标签，授权 URL 到达后再 `window.open` 会被弹窗拦截。Web 客户端在 `/login` 按键手势里打开空白标签，Host 转发 `commands/open-url` 以便该标签导航。CLI 仍使用操作系统 opener。

**在模型页把 `openai-codex` 重新做成密钥卡片。** 否决：密钥字段仍然无法完成 ChatGPT 登录。已登录的已连接行不是那张卡片：它报告宿主已经知道的 OAuth 状态，既没有 Sign-in 控件，也没有可编辑密钥。退出登录会删除已存储的登录，不会加上密钥字段。

## 后果

CLI、ACP 或 Web 会话可以运行 `/login openai-codex`，完成 ChatGPT 浏览器登录，然后选择 `openai-codex` 模型。设置 → 模型随后会把该路由显示为已使用 ChatGPT 登录。agent 循环、工具、审批与会话日志仍由 harness 拥有；PKCE、刷新与 Codex Responses 由 pi-ai 拥有。Codex 后端不是一份与公开 API 同等稳定的契约——OpenAI 侧变更时更新的是 pi-ai 适配器，而不是 harness 自有的协议解析器。

device-code／SSH 登录、模型页「登录」按钮、`dsh auth login` 启动器子命令、图片输入，以及其他仅 OAuth 的 catalog 提供方仍不提供。

## 测试

`tests/oauth-store.spec.ts` 钉住永不引用秘密的解析拒绝、属主独占持久化、`modify`／`delete`／`list`、并发写入，以及 POSIX 下拒绝他人可读。`tests/oauth-login.spec.ts` 钉住仅浏览器 interaction、`/login`／`/logout`、重叠 `/login` 拒绝、`commands/open-url` 发出、无目录卡片的 live 路由注入、`listProviders().auth === 'oauth'`、从已存文件启动、冲突路由的包容、无存储 token 的无密钥 Codex 流得到 `MISSING_CREDENTIAL`，以及 opener argv 在 Windows／WSL 上让含 `&` 的 URL 保持为单个参数（`rundll32`）。`packages/host/apiproxy/tests/api-proxy-config.spec.ts` 钉住未声明 OAuth 视图携带 `auth` 与 `connected`。`packages/client/ui-settings-models/tests` 钉住 store join（普通 `settingsNs: ''` 仍隐藏；`auth: oauth` 视为已配置）以及通过 `llm.logout` 退出登录的已登录行。插件 apply 测试会 stub `$DSH_HOME`，避免开发者本机凭据文件注入 live 路由。`tests/catalog.spec.ts` 中的目录不予提供测试保留：除非 settings profile 点名该路由，否则密钥卡片仍不出现。授权 URL 的 stderr 行由该包测试钉住；无密钥的装配快照无法重放 ChatGPT 登录。
