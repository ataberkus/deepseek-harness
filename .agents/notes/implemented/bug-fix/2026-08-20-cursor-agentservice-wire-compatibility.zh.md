# Agent Note: 保持 Cursor AgentService Run wire 兼容

Status: implemented

[English](2026-08-20-cursor-agentservice-wire-compatibility.md) | 中文

## Problem

Cursor OAuth 登录已经使用当前的 `loginDeepControl` 和 token exchange 流程，但托管的 `AgentService/Run` 端点是双向 Connect RPC。适配器发送的是裸 `AgentRunRequest`，首个请求之后没有客户端帧通道，也不会回答服务端的交互查询。因此即使登录成功，Cursor 也可能只返回 heartbeat 和 turn-ended 更新，最终产生 `CURSOR_EMPTY_STREAM`。

回退目录仍保留旧的裸 Grok id，而当前 Cursor wire id 会在这些 SKU 前加上 `cursor-grok`，并按推理档位选择后缀。直接发送显示用 id 也可能独立于 OAuth 失败。

## Decision

`encodeAgentRunClientMessage` 将 `AgentRunRequest` 放入 `AgentClientMessage` 的 `runRequest` field 1。`connectStream` 写入初始 Connect 帧但不结束请求输入，并通过 `onOpen` 暴露后续客户端帧 writer；单向调用仍保持发送后结束的行为。

托管流在 Run 保持打开期间每五秒发送 `AgentClientMessage.clientHeartbeat` field 7。它记录顶层 checkpoint field 3，处理顶层 interaction-query field 7，并为支持的托管权限查询发送 `AgentClientMessage.interactionResponse` field 6。网页搜索和抓取查询会批准；不支持的交互、模式和计划查询会拒绝；VM setup 查询保持不回答，因为客户端无法给出真实的 setup 结果。

客户端声明当前 Cursor CLI 版本 `cli-2026.07.23-e383d2b`。裸 `grok-4.5` 和 `grok-4.6` id 会转换为 `cursor-grok` wire id；启用推理时会追加档位后缀；已经是当前格式的 id 与 Composer id 保持不变。OAuth、工具、选中的图片、checkpoint 以及不可重试的 `CURSOR_EMPTY_STREAM` 分类仍由原有路径负责。

## Alternatives considered

**修改 Cursor OAuth 流程。** 否决：PKCE 登录、轮询和刷新端点已经匹配当前托管流程；失败位于 Run 传输和消息处理。

**继续发送裸 `AgentRunRequest`。** 否决：当前服务需要 `AgentClientMessage` oneof 包络，否则可能只返回 heartbeat 后关闭。

**初始帧之后结束 HTTP/2 请求。** 否决：Run 是双向流，服务端可能在结束前要求客户端 heartbeat、交互响应或其他客户端消息。

**自动批准 VM setup 查询。** 否决：客户端无法真实报告 VM 或 workspace setup 结果；不回答查询可以避免声称并不存在的能力。

**移植完整的社区提供方，包括 conversation blob。** 延后：定向 wire 变更已经解决 framing 和 liveness 缺口，不必替换 Harness 的历史、工具、图片、checkpoint 和错误抽象。完整 conversation-state blob 处理仍需要单独验证的设计。

## Consequences

Cursor Run 请求现在保持客户端流打开，并能满足托管权限和 liveness 所需的服务端消息。无论流因取消还是传输错误退出，heartbeat timer 都会清理。只发送 heartbeat 和 turn-ended 帧的提供方仍会以 `CURSOR_EMPTY_STREAM` 失败；传输现在能区分空的成功 wire exchange 与真正可用的完成，但不会虚构 assistant 内容。

适配器仍依赖非官方服务和公开的 CLI 版本字符串。Cursor 协议变化可能需要再次定向更新。旧的裸 Grok 选择会通过 wire-id 转换继续工作，而实时目录提供的 id 仍然具有权威性。

## Testing

`packages/llm/llm-pi-ai/tests/cursor.spec.ts` 固定 Connect 开放流 framing 与额外客户端帧、AgentClientMessage Run 包络、heartbeat 与交互响应编码、支持的 interaction-query 响应、旧 Grok wire-id 转换、checkpoint/tool/image 请求以及只有 heartbeat 的分类。包级 typecheck 覆盖新的 callback 和协议辅助函数。运行时健康笔记仍负责模型发现和只有空流的用户可见分类。
