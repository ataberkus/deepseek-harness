---
description: "与会话回合绑定的工作区文件检查点服务：经由 ctx.workspaceCheckpoint 提供捕获、列出、查看、恢复、租约、恢复标记与保留。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-checkpoint

[English](README.md) | 中文

## 概述

使用本服务可在回合边界保存会话工作目录，列出并查看这些快照，并在某个回合出错或编辑对话后恢复文件。检查点只覆盖工作区文件：它不刷写会话日志，从不进入模型历史，也不会撤销网络、数据库或终端效果。捕获失败不会影响已完成的回合，而恢复失败会在恢复成功之前阻止新的模型工作。在 `dsh-workspace-checkpoint-local` 等提供方启用之前，该功能保持关闭。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

需要工作区检查点的代码调用 `ctx.workspaceCheckpoint`；组合通过加载一个提供方和捕获消费者来提供它。

### 何时选择

当用户必须把会话 cwd 回滚到某个回合边界，或编辑较早的消息并从对应的文件状态继续时，选择此能力。它不负责刷写会话日志——那仍属于 [`session-checkpoint-policy`](../session-checkpoint-policy/)。抽象服务不是 Loader 条目：请把 `dsh-workspace-checkpoint-local` 作为提供方、`dsh-workspace-checkpoint-capture` 作为消费者装配。

### 能力角色

本包承担 workspace-checkpoint 能力的 Service Definition 角色：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-workspace-checkpoint`（本包） | Service Definition：抽象服务、branded id、domain spec |
| `@deepseek-ai/dsh-workspace-checkpoint-local` | Service Provider：Harness home 对象库与带日志恢复 |
| `@deepseek-ai/dsh-workspace-checkpoint-capture` | Consumer：初始与每个 `turn/end` 的捕获，以及 recovery-required 守卫 |

### 检查点元数据

检查点元数据不是 `SessionEvent`，不会进入 system prompt 或派生的模型历史。`Checkpoint 0` 使用 `boundarySeq: -1` 表示第一回合之前的工作区。持久会话旁车会把所选边界检查点、紧急检查点和编辑创建的子会话关联起来；该关系独立于只追加的对话日志。

### 服务 API（`ctx.workspaceCheckpoint`）

| 成员 | 语义 |
|---|---|
| `enabled` | 实时功能开关。提供方默认 `false`；关闭时跳过自动捕获和恢复准入，Host 会拒绝编辑/激活，但仍可读取既有元数据。 |
| `capture(request)` | 快照会话 cwd。捕获是 fail-soft：unavailable 记录不会抹掉已完成的回合。持有工作区租约的调用方可以把租约放入请求，用于多步骤操作。 |
| `inspect(id)` | 返回一条持久记录，缺失时抛出 `CHECKPOINT_NOT_FOUND`。 |
| `list(sessionId)` | 按标签顺序的客户端视图，不含 blob 内部细节。 |
| `sessionIndex(sessionId)` | Host 激活与投影使用的持久会话旁车行；没有元数据索引的提供方返回 `undefined`。 |
| `restore(request)` | 让 `cwd` 匹配清单，否则回滚。第一次文件系统变更之后 fail-closed。 |
| `recordEdit(link)` | 在分支发布后持久化源会话、边界、所选检查点、紧急检查点与子会话的关系。 |
| `acquireLease(workspaceKey)` | 进程内独占租约；已被持有时抛出 `CHECKPOINT_LEASE_HELD`。 |
| `recoveryRequired(workspaceKey)` | 持久诊断；工作区可写时为 `undefined`。 |
| `markRecoveryRequired` / `clearRecoveryRequired` | 回滚失败后阻止或重新允许模型工作。 |
| `evict()` | 执行保留策略，且不会静默删除当前已应用分支所需的 blob。 |

实现方继承 `WorkspaceCheckpoint`，并作为 `workspaceCheckpoint` 服务加载。恢复只声称工作区文件恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明 Service Definition 为每个提供方固定了什么；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

本包固定提供方、消费者与 Host 共享的词汇：抽象服务、branded `CheckpointId`、带有存储行 schema 的 `workspace_checkpoint` storage-domain spec，以及封闭的 `WorkspaceCheckpointError` 错误码集合。它还声明 `workspace-checkpoint` 设置命名空间，其 `enabled` 字段默认 `false`；基类的 `enabled` getter 返回 `false`，因此不公开该设置的提供方保持关闭。每当持久元数据或工作区关联变化时，提供方会携带会话 id 发出 `workspace-checkpoint/changed`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 抽象服务、设置命名空间与 schema、`workspace-checkpoint/changed` 事件 |
| [`src/types.ts`](src/types.ts) | 请求、记录、客户端视图、清单条目、租约、branded `CheckpointId` |
| [`src/spec.ts`](src/spec.ts) | `workspace_checkpoint` storage-domain spec 与存储行 schema |
| [`src/error.ts`](src/error.ts) | `WorkspaceCheckpointError` 及其封闭错误码集合 |
| — | 不发布运行时不变式伴生入口；本 Service Definition 不拥有可变存储，本地提供方为其持久化的检查点关系注册可执行检查。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务约定不够用时阅读以下页面。它们从提供方与消费者逐步进入生成参考与设计记录。

- [本地提供方](../workspace-checkpoint-local/README.zh.md)——Harness home 对象库、保留策略与带日志恢复。
- [捕获消费者](../workspace-checkpoint-capture/README.zh.md)——回合边界捕获与 recovery-required 调度守卫。
- [会话子系统参考](../../../docs/subsystems/session.zh.md#ctxworkspacecheckpoint--workspacecheckpoint-abstract-seam)——生成的 `ctx.workspaceCheckpoint` API 与 `workspace-checkpoint/*` 事件。
- [会话持久性检查点](../session-checkpoint-policy/README.zh.md)——独立的会话日志刷写策略。
- [对话编辑检查点笔记](../../../.agents/notes/implemented/feature/2026-08-20-conversation-edit-checkpoints.zh.md)——与回合绑定的工作区检查点背后的设计决策。

-----

<a id="model-experience"></a>
## 模型体验

无。此受信任检查点服务不注册面向模型的 prompt、schema、工具或消息。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制界定工作区检查点能够与不能重建的内容。

- **元数据不是会话事件** — 模型历史的谱系仍走现有 session fork/seed 前缀；本 sidecar 不能单独重建对话文本。
- **恢复只覆盖会话 cwd** — 网络、数据库、终端和被忽略的外部效果不在范围内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
