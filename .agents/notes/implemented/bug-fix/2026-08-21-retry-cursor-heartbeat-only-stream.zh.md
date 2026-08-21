# Agent Note：重试 Cursor 仅心跳完成

状态：已实现

[English](2026-08-21-retry-cursor-heartbeat-only-stream.md) | 中文

## 问题

Cursor AgentService 可能在只有客户端 heartbeat 更新、没有文本、推理或工具块时关闭 Run。pi-ai 会把这类完成映射为 `CURSOR_EMPTY_STREAM`；有界默认重试策略没有包含该 code，因此即使这次尝试没有产生持久 assistant 内容，agent 轮次也会立即失败。

## 决策

保留提供方特定的 `CURSOR_EMPTY_STREAM` 分类用于诊断，并把它加入 dsh-llm 的有界 normal 默认可重试 code。agent 重试执行器最多重复失败步骤五次；显式提供方 `retryPolicy.retryableCodes` 列表仍具有最终决定权。

## 考虑过的替代方案

**把完成映射为 `EMPTY_RESPONSE`。** 拒绝：提供方特定 code 能识别 Cursor 服务恢复失败，并在耗尽重试预算后保留有用诊断。

**无限重试。** 拒绝：持续的 Cursor 中断必须遵守 normal 模式的有界重试预算，并保持可取消。

## 后果

所有 Cursor 模型的仅心跳完成都会获得与其他暂时性空响应相同的有界恢复行为。直接使用 `ctx.llm.stream()` 的消费者仍只尝试一次，因为重试归 agent 的 `request-error` 边界负责。
