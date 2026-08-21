# Login provider picker design
[English](2026-08-21-login-provider-picker-design.md) | 中文

## Problem

Web dashboard 将 `/login` 显示为 `Sign in to OpenAI Codex, Cursor, or Antigravity`，但宿主注册该命令时没有输入 descriptor。因此客户端把菜单选择当作裸命令，使用空输入执行 `/login`。OAuth parser 有意将空输入映射为 `openai-codex`，所以 dashboard 总是打开 OpenAI，却没有询问用户要使用哪个提供方。已有的 `OAUTH_COMMAND_HINT` 定义了支持的提供方 ID，但没有附加到命令定义上。

## Goals

- 在 Web 斜杠菜单中选择 `/login` 时打开提供方选择器，而不是执行空输入登录。
- 选择器显示易懂的提供方名称和简短的订阅说明。
- 选择提供方后使用规范化的提供方 ID 执行现有宿主命令。
- 保持直接输入 `/login <provider>` 的支持，包括 parser 已有的别名。
- OAuth 标签页准备、HTTPS 校验、进行中保护、凭证持久化、路由刷新、命令生命周期记账和错误报告继续由现有代码负责。
- headless 与 CLI 调用继续保留 `/login` 空输入的既有行为。
- 选择器复用已有 popup shell 的键盘、搜索、焦点和无障碍行为。

## Non-goals

- 不修改 OAuth 提供方、token 交换、回调处理、凭证存储或模型路由。
- 不增加命令 wire 字段或宿主协议变更。
- 不替换现有的 `/login <provider>` 语法。
- 不在 Models 设置页增加提供方管理 UI。
- 不在本次聚焦变更中修改 `/logout` 行为。

## User interaction

Web 斜杠菜单继续显示一个 `/login` 行。选择该行或提交裸 `/login` 时，选择器显示以下选项：

| Option | Command id | Detail |
| --- | --- | --- |
| OpenAI Codex | `openai-codex` | ChatGPT subscription |
| Cursor | `cursor` | Cursor subscription |
| Antigravity | `google-antigravity` | Google Cloud Code Assist subscription |

选择选项后，经共享客户端命令 runtime 提交 `/login <command id>`。命令准入后选择器关闭并将焦点还给 composer。现有命令生命周期负责呈现成功或失败。传输失败或命令格式错误会通过 popup shell 的现有错误路径保持选择器打开。

直接输入仍然可用。宿主命令发布 `input: { hint: OAUTH_COMMAND_HINT }`，因此 composer 会认领 `/login ` 以接收提供方输入，而不是把该行立即作为裸命令执行。宿主 parser 继续接受 `openai-codex`、`cursor`、`google-antigravity`、`antigravity` 和 `google-gemini-cli`；对于非 Web 调用，空输入仍然是宿主默认值。

## Architecture

### Host command

`packages/llm/llm-pi-ai/src/oauth-login.ts` 将已有的 `OAUTH_COMMAND_HINT` 加入 `/login` 定义。handler、parser、提供方表和结果消息保持不变。

### Shared command runtime

`packages/client/ui-commands/src/client/service.ts` 通过 `CommandUiContract` 暴露现有的命令执行路径。该方法接收会话和完整命令行，保留现有的 login 标签页准备，执行远程调用，发布本地 `command/executed` 事件，并返回现有的 `SubmitOutcome` 语义。它不会成为第二个命令执行器，也不会把 OAuth 逻辑移入客户端。

`packages/client/ui-commands/src/client/contract.ts` 记录该方法的输入、返回值、传输拒绝、hosted OAuth 行为产生的浏览器标签页副作用以及生命周期归属。现有调用方继续使用相同的内部行为。

### Provider picker decoration

`packages/client/ui-model-selection/src/client/index.ts` 为宿主命令 `login` 注册 `CommandDecoration`。该装饰对普通会话可用；命令目录仍然负责确认宿主命令存在，因此被寻址的 subagent 会话以及没有 `/login` 的部署不会收到虚构的选择器。

装饰的 option builder 返回三个固定的 hosted provider ID，并使用本地化的标签和说明。选择 handler 通过共享命令 runtime 提交 `/login ${option.id}`；只有共享执行路径拒绝准入或传输时才抛错，使现有 popup controller 保留重试状态。

`packages/client/ui-model-selection/src/client/locales.ts` 以类型化的英文和简体中文键对拥有选择器标签与说明。不需要新的 CSS 或 popup 组件。

## Data flow and safety

1. 斜杠 source 加载会话的宿主命令目录。
2. 裸 `/login` 菜单选择或 Enter 解析到宿主行后，`login` decoration 打开共享 popup。
3. 用户选择提供方选项。
4. 共享命令 runtime 在用户手势中准备或复用具名空白 OAuth 标签页，然后执行完整的宿主命令行。
5. 宿主解析提供方 ID 并运行现有 OAuth 流程。
6. 宿主发布 `commands/open-url`；客户端只接受 HTTPS 并导航已准备的标签页。
7. 凭证成功后触发现有适配器刷新。命令生命周期仍然是唯一的持久化结果渠道。

选择器只会发出固定选项表中的 ID。直接输入仍由 `parseOAuthProvider` 校验。宿主的 `loginInFlight` 保护仍是并发登录的权威规则。任何 secret 或 token 都不会进入客户端选项数据、命令 metadata 或 UI 文案。

## Verification

- 增加宿主命令断言，确认 `/login` 暴露 `OAUTH_COMMAND_HINT`，同时直接命令执行保持不变。
- 增加 command runtime 覆盖，验证公开执行路径仍会准备 OAuth 标签页并保留传输语义。
- 增加 model-selection 客户端覆盖，验证选项标签和 ID、选中后的命令提交、宿主缺失时的行为以及 effect dispose。
- 扩展真实 `apps/web` 组合测试，在实际斜杠菜单中打开 `/login`，选择提供方，并验证选中的提供方命令进入既有确定性 OAuth 测试 harness。
- 在 `apps/web/tests/snapshots/` 下增加该选择器交互的无 key 浏览器快照场景。
- 运行聚焦测试、typecheck、lint，以及变更 UI 和文档所需的组合测试与文档 gate；只报告实际执行的命令。

## Affected areas

- `packages/llm/llm-pi-ai/src/oauth-login.ts`
- `packages/client/ui-commands/src/client/contract.ts`
- `packages/client/ui-commands/src/client/service.ts`
- `packages/client/ui-model-selection/src/client/index.ts`
- `packages/client/ui-model-selection/src/client/locales.ts`
- 对应的 package 测试、`apps/web` 组合覆盖以及一份记录已发布决策的 active Agent Note。
