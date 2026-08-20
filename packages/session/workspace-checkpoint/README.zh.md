# @deepseek-ai/dsh-workspace-checkpoint

[English](README.md) | 中文

**`WorkspaceCheckpoint`** 服务（`ctx.workspaceCheckpoint`）定义与会话回合绑定的工作区文件检查点的捕获、查看、恢复、租约和保留。它不负责刷写会话日志——那仍属于 [`session-checkpoint-policy`](../session-checkpoint-policy/)。

本包承担 workspace-checkpoint 能力的 Service Definition 角色：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-workspace-checkpoint`（本包） | Service Definition：抽象服务、branded id、domain spec |
| `@deepseek-ai/dsh-workspace-checkpoint-local` | Service Provider：Harness home 对象库与带日志恢复 |
| `@deepseek-ai/dsh-workspace-checkpoint-capture` | Consumer：初始与每个 `turn/end` 的捕获，以及 recovery-required 守卫 |

检查点元数据不是 `SessionEvent`，不会进入 system prompt 或派生的模型历史。`Checkpoint 0` 使用 `boundarySeq: -1` 表示第一回合之前的工作区。持久会话旁车会把所选边界检查点、紧急检查点和编辑创建的子会话关联起来；该关系独立于只追加的对话日志。

## 服务 API（`ctx.workspaceCheckpoint`）

| 成员 | 语义 |
|---|---|
| `enabled` | 实时功能开关。提供方默认 `false`；关闭时跳过自动捕获和恢复准入，Host 会拒绝编辑/激活，但仍可读取既有元数据。 |
| `capture(request)` | 快照会话 cwd。捕获是 fail-soft：unavailable 记录不会抹掉已完成的回合。持有工作区租约的调用方可以把租约放入请求，用于多步骤操作。 |
| `inspect(id)` | 返回一条持久记录，缺失时抛出 `CHECKPOINT_NOT_FOUND`。 |
| `list(sessionId)` | 按标签顺序的客户端视图，不含 blob 内部细节。 |
| `restore(request)` | 让 `cwd` 匹配清单，否则回滚。第一次文件系统变更之后 fail-closed。 |
| `recordEdit(link)` | 在分支发布后持久化源会话、边界、所选检查点、紧急检查点与子会话的关系。 |
| `acquireLease(workspaceKey)` | 进程内独占租约；已被持有时抛出 `CHECKPOINT_LEASE_HELD`。 |
| `recoveryRequired(workspaceKey)` | 持久诊断；工作区可写时为 `undefined`。 |
| `markRecoveryRequired` / `clearRecoveryRequired` | 回滚失败后阻止或重新允许模型工作。 |
| `evict()` | 执行保留策略，且不会静默删除当前已应用分支所需的 blob。 |

实现方继承 `WorkspaceCheckpoint`，并作为 `workspaceCheckpoint` 服务加载。恢复只声称工作区文件恢复。

## 模型体验

无。此受信任检查点服务不注册面向模型的 prompt、schema、工具或消息。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **元数据不是会话事件** — 模型历史的谱系仍走现有 session fork/seed 前缀；本 sidecar 不能单独重建对话文本。
- **恢复只覆盖会话 cwd** — 网络、数据库、终端和被忽略的外部效果不在范围内。
