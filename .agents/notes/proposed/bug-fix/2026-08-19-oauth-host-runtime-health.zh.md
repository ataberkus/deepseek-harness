# Agent Note: 让托管 OAuth 运行时错误可观测

Status: proposed

[English](2026-08-19-oauth-host-runtime-health.md) | 中文

## Problem

托管 OAuth 路由可能显示为已连接，但上游模型入口实际上不可用。Cursor 的模型发现可能成功返回空 payload，随后回退目录仍会宣传 `grok-4.6` 等模型 id。之后 Cursor 可能只发送 heartbeat 就结束 Run，Harness 将其报告为 `EMPTY_RESPONSE` 并重试，却没有说明提供方返回的具体状态。

Gemini 路由注入和内置模型解析已经通过单元测试，但 OAuth 登录后的真实 Web 组合仍需要一个跨越实际组合的测试，覆盖 Host 到 Client 的失效通知。来自其他 Harness 进程或 Harness home 的实时 Settings 行不能被当作目录缺陷。

本文扩展 [Cursor OAuth 托管](../../implemented/feature/2026-08-18-cursor-oauth-host.md) 的运行时健康行为，并补充 [Gemini CLI OAuth 托管](../../implemented/feature/2026-08-19-google-gemini-cli-oauth-host.md) 的组合验证。上述笔记仍负责登录、凭据、路由所有权和内置提供方目录。

## Proposal

为 Gemini 登录增加组合 Web 回归测试。模拟 OAuth 完成后必须持久化凭据，通过 Host API 暴露注入的提供方和内置模型组，转发 `llm/adapters-updated`，并刷新已经加载的模型目录。尚未打开的目录仍必须保持惰性。

按结果区分 Cursor 发现失败。网络失败和缺少访问令牌时保留已安装的回退目录；成功但为空的 `GetUsableModels` payload 则变成模型目录组装失败，使选择器不再提供未经确认的 id。

独立追踪 Cursor 流是否产生内容。流在没有文本、思考或工具调用而只发送 heartbeat 后关闭时，发出提供方专属且不可重试的空流错误。有效内容以及现有的传输、取消、工具调用、图像和 checkpoint 行为保持不变。

诊断不得包含访问令牌、请求 body 或账户身份。在经过可工作的上游对照确认所需 wire 变化之前，完整 Cursor 协议重写不属于本文范围。

## Alternatives considered

**每次发现为空都保留回退目录。** 否决：成功的空响应不能证明宣传的模型可用，会直接导致误导性的重试。

**保留通用的 `EMPTY_RESPONSE` 分类。** 否决：它隐藏 Cursor 只发送 heartbeat 的事实，并允许默认的空响应重试策略重复同一个上游结果。

**只修改模型选择器 UI。** 否决：无效模型状态由提供方发现和流式处理产生，不是渲染造成的。

**立即移植当前社区 Cursor 客户端。** 延后：在当前运行时对候选 framing 的探测仍得到只有 heartbeat 的响应；更大的非官方协议重写需要已验证可工作的对照实现。

**修改 Gemini Settings 展示或增加登录按钮。** 否决：现有命令式 OAuth 展示是有意设计，且当前进程没有复现 Gemini 目录缺陷。

## Acceptance criteria

- 组合 Gemini OAuth 登录测试证明凭据持久化、提供方和模型 API 可见、拓扑失效通知转发，以及已加载模型目录刷新。
- 成功但为空的 Cursor 模型发现响应产生目录失败，而不是回退模型组。
- Cursor 只有 heartbeat 的流产生提供方专属且不可重试的失败，而不是 `EMPTY_RESPONSE`。
- 有效的 Cursor fixture 流保留文本、思考、工具调用、图像和 checkpoint 行为。
- 诊断和测试不暴露 OAuth 秘密或请求 payload。
- 聚焦测试、受影响的构建、Web 产物验证和实时 GUI 刷新均通过。

## Risks

短暂的成功空响应会在下一次刷新前隐藏 Cursor 回退模型。这选择了真实的模型选择状态，而不是提供后端未确认的 id；失败信息会指出模型发现操作，便于服务恢复后重试。

Gemini 测试通过时，用户 GUI 仍可能使用不同的 Harness home、进程或 Web 产物修订。测试可以确立组合约定，但不能修正不一致的运行时状态。
