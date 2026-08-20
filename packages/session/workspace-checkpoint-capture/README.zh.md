# dsh-workspace-checkpoint-capture

[English](README.md) | 中文

`@deepseek-ai/dsh-workspace-checkpoint-capture` 是 workspace-checkpoint 能力的消费者。

当带有 cwd 的会话创建时，它捕获检查点 0，并在每个已结算的 `turn/end` 之后捕获一个检查点。

消费者会在读取回合边界前刷新会话持久化，选择最新的可用非 emergency 检查点作为下一个父检查点，并使捕获失败不会进入会话追加路径。

它包装 `llm/stream` 和顶层 `tools/execute`；被标记为 `recoveryRequired` 的工作区在恢复消费者清除标记前不会继续执行模型或工具。

## 组合

此包需要 `ctx.workspaceCheckpoint`、`ctx.sessions`、`ctx.llm` 和 `ctx.tools`。

Web bundle 会在 `dsh-workspace-checkpoint-local` 之后加载它；抽象服务定义不需要单独的 Loader 行。

## 回合结果

`completed` 映射为 `completed`，`aborted` 映射为 `cancelled`，`interrupted` 映射为 `interrupted`，`error`、`max-tokens` 或 `blocked` 映射为 `failed`。

未知的可扩展回合结束类型会按 `failed` 处理。

## 模型体验

无。该消费者只捕获工作区文件并守卫调度，不添加 prompt、schema、工具或消息。

#### KV Cache 影响

它不改变模型请求或缓存前缀；仅在需要恢复时拒绝调度。

## 已知限制与暂缓事项

- 检查点覆盖会话 cwd 下的文件；外部服务、数据库、终端和被忽略的路径不会恢复。
- 捕获串行化仅限进程内；多个进程同时操作同一 cwd 需要外部工作区锁。
- 消费者只观察已发布的会话事件；在此插件加载前创建的会话不会获得新的初始捕获。
