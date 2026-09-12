# Agent Note: Models 页面提供方连接

Status: implemented

[English](2026-09-12-models-page-oauth-connect.md) | 中文

## Problem

托管 OAuth 路由（`openai-codex`、`cursor`、`google-antigravity`）只能通过 `/login` 斜杠命令连接。OpenCode Go 虽然已存在于 pi-ai catalog 中，但在 Models 页面只能作为普通 settings profile 使用，即使其提供方自有登录只是一次 API 密钥提示。页面对这两类提供方登录都没有直接的 Connect 生命周期。

## Decision

目录提供带方法标记的 dormant 登录条目，Models 页面从 Connect 卡片驱动每种提供方自有登录。

`LlmConfigurableProvider` 与 live 提供方元数据携带 `auth: 'oauth' | 'api-key'`，表示该路由通过提供方自有登录而非 settings profile 连接。`directoryEntries()` 把三个托管路由与 OpenCode Go 声明为 dormant 条目；已存储 profile 会覆盖对应条目（保留普通 settings 路径），已注入的 live 凭据会收回对应条目，因此页面永远不会为同一路由同时渲染连接卡片与已连接行。页面 join 仅在 live 路由上把任一标记视为已配置；dormant 登录行不进入凭据批量查询、不进入添加菜单，并渲染为带进行中状态与按卡片拒绝信息的方法专属 Connect 卡片。

登录走新的命名空间级 `llm/loginOAuth` Remote，与 `registerModelDiscovery` 同构：待连接的提供方尚无 live 注册可指名，因此以命名空间为键。`llm-pi-ai` 注册该 offer；它用与 `/login` 相同的授权 URL 行为运行 `loginHostedOAuth`（向 GUI 订阅者发送 `commands/open-url`，否则回退到宿主浏览器打开方式），成功后刷新路由。并发登录守卫从命令处理器移入按 store 键控的 `loginHostedOAuth`，使 `/login` 行与 Connect 点击共享同一守卫。Connect 点击在自己的用户手势内调用新增的 `CommandUiContract.prepareOAuthLoginTab()`，使稍后到达的授权 URL 导航已准备的页签，而非被弹窗拦截的新页签。

OpenCode Go 走独立的命名空间级 `llm/loginApiKey` Remote，因此秘密是显式类型参数，而非命令文本。客户端校验不含空格的可打印 ASCII，从密码字段提交 trim 后的值，并立即清空字段。宿主在 Remote 边界再次校验，驱动 pi-ai 的 `api_key` 登录方法，并把记录持久化到既有且仅属主可访问的 `$DSH_HOME/oauth-credentials.json` store。该凭据无需写入 `settings.yaml` 即可注入 live `opencode-go` 路由；断开连接会删除记录并恢复 dormant 卡片。

## Alternatives considered

**让 `logout` 保持为未装饰的服务方法。** 之前客户端通过无类型窄 cast 强制调用该方法，但网关只认 `@Remote` 描述。提供方托管 Connect 需要真实的断开生命周期，因此 `logout` 现在带有装饰，并通过生成的类型使用。

**把托管登录注册为授权 seam 流程。** 该 seam 已覆盖已安装目录提供方，仍是聊天/ACP 路径。让 Models 按钮走它，要求页面为每个提供方渲染完整 notify/prompt 交互；经由共享托管交互的一个命名空间 remote 更窄。

**让按钮经命令分发器提交 `/login`。** 命令执行是会话作用域，而设置界面不持有会话；为此把设置与 composer 耦合没有行为收益。

**增加 `/login opencode-go <key>`。** 命令行对模型可见，并作为交互文本保留，因此把秘密放入其中会扩大暴露范围。Models 密码字段与携带秘密的 Remote 可使 API 密钥不进入命令和会话记录。

**手工编辑生成的 API 目录。** `api-catalog.ts` 经重新生成后会列出新 remote，但生成当前被无关且已存在的 `session/checkpoints` JSDoc 违规阻塞；为绕过它们手工编辑生成产物会在下次重新生成时漂移。

## Consequences

`/login` 与 `/logout` 行为与之前完全一致，包括进行中的 OAuth 拒绝文本。Models 页面无需 composer 即可连接和断开 OAuth 与 OpenCode Go。API 密钥校验不会在诊断中包含提交的密钥，浏览器也会在 Remote 完成前清除自身副本。页签交接、秘密持久化、拒绝信息展示、目录收回／恢复生命周期分别覆盖于 `catalog.spec.ts`、`oauth-login.spec.ts`、`topology.spec.ts`、Models store/component spec 与 ui-commands service spec。在拒绝一切 `window.open` 的桌面壳中，客户端不再消费 `commands/open-url`，改由宿主打开器在系统浏览器中完成登录。`session/checkpoints` JSDoc 违规及依赖它的 `api-catalog.ts` 重新生成仍未解决，且与本变更无关。
