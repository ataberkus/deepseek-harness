---
description: "在会话创建时与每个已结算回合后自动捕获工作区检查点，并为模型与顶层工具调度提供 recovery-required 守卫。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-checkpoint-capture

[English](README.md) | 中文

## 概述

加载本插件后，带有 cwd 的会话开始时以及每个已结算回合之后都会记录一个工作区检查点，Host 之后可以把文件恢复到任一回合边界。在恢复失败、工作区需要恢复期间，它还会阻止模型与顶层工具调度。捕获失败只会被记录到日志，绝不会阻塞会话日志或回合。在 `ctx.workspaceCheckpoint.enabled` 为 `true` 之前它什么也不做，因此既有会话和工作区默认不受影响。

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

`@deepseek-ai/dsh-workspace-checkpoint-capture` 是 workspace-checkpoint 能力的消费者；把它与提供方一起挂载后，它无需额外调用即可捕获并守卫。

### 何时选择

只要组合提供工作区恢复或对话编辑，就与 `dsh-workspace-checkpoint-local` 一起选择它；没有它时不会捕获检查点，被标记为需要恢复的工作区也不受守卫。Web bundle 会在 `dsh-workspace-checkpoint-local` 之后加载它；抽象服务定义不需要单独的 Loader 行。

### 最小配置

此包没有配置字段。它需要 `ctx.workspaceCheckpoint`、`ctx.sessions`、`ctx.llm` 和 `ctx.tools`：

```yaml
- id: workspace-checkpoint-capture
  name: '@deepseek-ai/dsh-workspace-checkpoint-capture'
```

### 捕获什么

当带有 cwd 的会话创建时，它会在 `ctx.workspaceCheckpoint.enabled` 为 `true` 时捕获检查点 0，并在每个已结算的 `turn/end` 之后捕获一个检查点。因此，提供方默认关闭时不会触碰既有会话和工作区，直到面板启用该功能。恢复或分叉的会话已经拥有自己的检查点谱系，因此不会获得新的检查点 0。

消费者会在读取回合边界前刷新会话持久化，选择最新的可用、可恢复且非 emergency 的检查点作为下一个父检查点，并使捕获失败不会进入会话追加路径。

### 恢复守卫

它包装 `llm/stream` 和顶层 `tools/execute`；被标记为 `recoveryRequired` 的工作区在恢复消费者清除标记前不会继续执行模型或工具。守卫以 `CHECKPOINT_RECOVERY_REQUIRED` 拒绝调度。关闭时会跳过这些准入守卫，但 Host 仍可读取已保存的恢复诊断。

### 回合结果

`completed` 映射为 `completed`，`aborted` 映射为 `cancelled`，`interrupted` 映射为 `interrupted`，`error`、`max-tokens` 或 `blocked` 映射为 `failed`。

未知的可扩展回合结束类型会按 `failed` 处理。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明消费者如何调度捕获与准入；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

该插件是只含监听器的消费者，只持有一项状态：按会话的 promise 链，按顺序运行初始捕获与每次回合捕获。每个排队任务在运行时重新读取 `enabled`，因此功能开关会在两次捕获之间生效。`turn/end` 监听器先刷新会话，再排入一次捕获，其父检查点从提供方当前的检查点列表中选出；提供方错误会被捕获并记录到日志，无法进入会话追加路径。准入守卫会在 LLM 适配器流开始前、以及顶层工具正文运行前读取提供方针对会话 cwd 的恢复诊断；嵌套工具调度不会再次检查。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：捕获监听器、按会话排序、回合结果映射、模型与工具恢复守卫 |
| — | 不发布运行时不变式伴生入口；本消费者拥有监听器调度与 fail-soft 准入，而提供方拥有检查点记录关系，因此没有独立的关系需要校验。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当消费者约定不够用时阅读以下页面。它们从所消费的服务逐步进入存储检查点的提供方。

- [工作区检查点服务](../workspace-checkpoint/README.zh.md)——`ctx.workspaceCheckpoint` 约定与检查点元数据。
- [本地提供方](../workspace-checkpoint-local/README.zh.md)——Harness home 对象库、保留策略与带日志恢复。
- [会话持久性检查点](../session-checkpoint-policy/README.zh.md)——与本消费者并行运行的会话日志刷写策略。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

无。该消费者只捕获工作区文件并守卫调度，不添加 prompt、schema、工具或消息。

#### KV Cache 影响

它不改变模型请求或缓存前缀；仅在需要恢复时拒绝调度。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制界定消费者能够捕获与守卫的工作区状态。

- 检查点覆盖会话 cwd 下的文件；外部服务、数据库、终端和被忽略的路径不会恢复。
- 捕获串行化仅限进程内；多个进程同时操作同一 cwd 需要外部工作区锁。
- 消费者只观察已发布的会话事件；在此插件加载前创建的会话不会获得新的初始捕获。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
