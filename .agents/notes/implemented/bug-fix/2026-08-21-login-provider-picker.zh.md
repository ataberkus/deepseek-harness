# Agent Note: Ask for the hosted OAuth provider in the web login command

Status: implemented

English | [中文](2026-08-21-login-provider-picker.md)

## Problem

Web 端的 `/login` 菜单会以空输入执行命令，而宿主有意将空输入默认解析为 OpenAI Codex，因此它始终选择 OpenAI Codex。

## Decision

宿主 `/login` 命令发布已有的提供方输入提示。Web 客户端为裸调用的宿主命令添加共享 popup，列出 OpenAI Codex、Cursor 与 Antigravity，再经共享命令 runtime 提交规范化的提供方 ID，从而保证 OAuth 标签页的准备发生在用户手势中。runtime 在构造时捕获远程命令接口，使另一个客户端插件发起调用时不依赖调用方作用域的嵌套 remote 注入。

## Alternatives considered

**只恢复输入提示而不提供选择器。** 拒绝：它允许输入，但仍然要求用户记忆提供方 ID，也不会说明下一步操作。

**让宿主通过命令 wire 协议发布选择项。** 拒绝：这会为一个已有 Web 客户端行为拥有的提供方列表扩展每个命令 descriptor 和快照消费者。

**让 popup 直接执行远程命令。** 拒绝：这会绕过共享 runtime 的空白标签页准备，授权 URL 到达前浏览器可能已经拦截弹窗。

## Consequences

Web 用户无需记忆 ID 即可选择提供方，同时直接输入命令和非 Web 调用的空输入行为仍然可用。提供方 ID 和标签同时存在于客户端选择器与宿主解析器中；选择器只发出规范化 ID，宿主仍是验证与 OAuth 行为的权威。共享执行方法成为客户端命令约定的一部分，popup 消费者必须保留命令准入、生命周期确认和浏览器用户手势处理。
