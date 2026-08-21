# Agent Note: 让托管 OAuth 运行时错误可观测

Status: implemented

[English](2026-08-19-oauth-host-runtime-health.md) | 中文

## Problem

托管 OAuth 路由可能显示为已连接，但上游模型入口实际上不可用。Cursor 的模型发现可能成功返回空 payload，随后回退目录仍会宣传 `grok-4.6` 等未经确认的模型 id。Cursor 也可能只发送 heartbeat 就结束 Run，Harness 会把它报告为 `EMPTY_RESPONSE` 并重试，却没有说明提供方返回的具体状态。

Gemini 路由注入和内置模型解析已经通过单元测试，但 OAuth 登录后的 Host 到 Client 失效通知仍需要跨越真实 Web 组合的覆盖。来自其他 Harness 进程或 Harness home 的实时 Settings 行不是目录失败。

本文扩展 [Cursor OAuth 托管](../feature/2026-08-18-cursor-oauth-host.zh.md) 的运行时健康行为，并补充 [Gemini CLI OAuth 托管](../feature/2026-08-19-google-gemini-cli-oauth-host.zh.md) 的组合验证。上述笔记仍负责登录、凭据、路由所有权和内置提供方目录。

## Decision

`listCursorModels` 在网络传输失败或缺少访问令牌时保留捆绑目录；成功但为空的 `GetUsableModels` 响应则以 `CURSOR_NO_USABLE_MODELS` 抛出 `LlmError`。Host 模型目录会在可选的 `ModelCatalogFailure.code` 字段中保留类型化 `HarnessError.code`，因此逐提供方失败保持可见，而普通错误仍不需要该字段。

`PiAiAdapter` 会在当前 snapshot 中移除被拒绝的 served-model promise，然后重新抛出错误。模型目录的重试因此会重新执行 Cursor 列举，而成功的 snapshot 仍会缓存。

`mapStopReason` 会把没有文本、思考或工具调用块的 Cursor 终止 stop 映射为 `CURSOR_EMPTY_STREAM`。该 code 不在默认可重试列表中。其他提供方继续使用通用且默认可重试的 `EMPTY_RESPONSE`；所有带内容的 Cursor 响应以及既有的传输、取消、工具调用、图像和 checkpoint 行为保持不变。通用提供方规则记录在[可重试的空完成](2026-07-24-empty-model-response-is-retryable.zh.md)中；本文只收窄 Cursor 行为。

组合 Web 回归测试通过真实回环回调完成模拟的 `/login google-gemini-cli` 流程，验证 Host 模型可见，并观察已打开的选择器在 `llm/adapters-updated` 后刷新。浏览器插件回归测试保持尚未打开的模型目录惰性。

诊断和夹具不包含访问令牌、request body 或账户身份。定向 Run framing 与 liveness 由 [Cursor AgentService wire 兼容性](2026-08-20-cursor-agentservice-wire-compatibility.zh.md)负责；完整 conversation-state blob 与更广泛的非官方服务变化仍不属于本文决策。

## Alternatives considered

**每次发现为空都保留回退目录。** 否决：成功的空响应不能证明宣传的模型可用，会直接导致误导性的选择和重试。

**保留通用的 `EMPTY_RESPONSE` 分类。** 否决：它隐藏 Cursor 只发送 heartbeat 的事实，并允许默认的空响应重试策略重复同一个上游结果。

**只修改模型选择器 UI。** 否决：无效模型状态由提供方发现和流式处理产生，Host 调用方也需要类型化失败。

**立即移植当前社区 Cursor 客户端。** 否决作为完整提供方重写。定向 Run framing 与 liveness 变更记录在 [Cursor AgentService wire 兼容性](2026-08-20-cursor-agentservice-wire-compatibility.zh.md)中；完整 conversation-state 处理仍需要单独验证的设计。

**修改 Gemini Settings 展示或增加登录按钮。** 否决：现有命令式 OAuth 展示是有意设计，组合回归测试可以覆盖路由刷新，不需要新增登录入口。

## Consequences

短暂的成功空响应会在下一次刷新前隐藏 Cursor 回退模型。这选择了真实的模型选择状态，而不是提供后端未确认的 id；`CURSOR_NO_USABLE_MODELS` 会指出模型发现操作，便于服务恢复后重试。

只有 heartbeat 的 Cursor 响应会以明确且不可重试的提供方 code 结束，而不是消耗通用空响应的重试预算。一个有意不产生块的提供方仍会让轮次失败，因为空的 assistant 消息没有可持久化价值，也无法与已观察到的后端缺陷区分。

Gemini 测试可以确立组合约定，但不能修正用户 GUI 所使用的不同 Harness home、进程或 Web 产物修订。Cursor 传输仍是非官方协议；定向 Run 兼容性由 [Cursor AgentService wire 兼容性](2026-08-20-cursor-agentservice-wire-compatibility.zh.md)负责，更广泛的服务变化可能需要再次作出协议决策。

## Testing

`apps/web/tests/oauth-model-directory.e2e.ts` 覆盖模拟 Google token 交换、Cloud Code Assist 项目发现、真实回环回调、Host `llm.models`、拓扑失效通知转发以及已打开选择器刷新。`packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` 覆盖尚未打开目录的惰性行为。`packages/llm/llm-pi-ai/tests/cursor.spec.ts` 覆盖成功空响应、网络失败回退、拒绝列举后的重试、AgentService 包络与开放流帧、交互响应、只有 heartbeat 的流以及既有 Cursor 夹具。`packages/llm/llm-pi-ai/tests/convert.spec.ts` 保留通用 `EMPTY_RESPONSE` 并钉住 `CURSOR_EMPTY_STREAM`。Host API 模型测试与 RPC schema 测试覆盖可选类型化失败 code 的传播。聚焦 OAuth、Cursor、转换、Host、构建、Web、Markdown 和 Agent Note 检查是本决策的验证面。
