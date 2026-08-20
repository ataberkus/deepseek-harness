# @deepseek-ai/dsh-workspace-checkpoint-local

[English](README.md) | 中文

[`workspace-checkpoint`](../workspace-checkpoint/) 的本地 Service Provider。它把普通文件字节存在 Harness home 下的内容寻址对象库中，并把检查点元数据放在 `workspace_checkpoint` storage domain。遍历使用 `lstat`，不跟随符号链接。

## 插件（命名空间：`workspace-checkpoint-local`）

| 配置 | 必填 | 语义 |
|---|---|---|
| `objectRoot` | 否 | 对象库目录。默认 `{dshHome}/workspace-checkpoints`。 |
| `dshHome` | 否 | 仅在省略 `objectRoot` 时使用的 Harness home 覆盖。 |
| `maxTotalBytes` | 是 | 若写入会让 blob 库超过该上限，则持久化 unavailable 记录并保留既有检查点。 |
| `excludeGlobs` | 是 | 捕获与恢复规划跳过的斜杠分隔 glob（`path.matchesGlob`）；这些路径留在磁盘上。 |
| `captureRetryCount` | 是 | 遇到 `CHECKPOINT_CONCURRENT_WRITE` 后的额外 `buildManifest` 次数。 |
| `captureRetryDelayMs` | 是 | 这些重试之间的延迟。 |

与 `storage`、`storage-json` 和 `storage-domain`（`backend: 'json'`）一起装配。恢复使用日志和紧急快照回滚部分文件变更；持久 recovery 标记会在恢复可用检查点之前阻止新的模型工作。带有匹配租约的捕获请求会在调用方的多步骤租约中执行，不会等待该租约释放。保留策略保护已应用检查点及紧急检查点链，`recordEdit` 会在源会话和子会话旁车中持久化分支关系。

## 模型体验

无。此受信任检查点提供方不注册面向模型的 prompt、schema、工具或消息。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **恢复只覆盖会话 cwd** — 网络、数据库、终端和被忽略的外部效果不在范围内。
- **捕获是 fail-soft** — unavailable 记录不会抹掉已完成的回合；Host 不得为该检查点提供自动恢复。
- **本地 invariant companion 由事件驱动** — 已存在的关系错误会在下一次检查点变更发出时报告；storage schema 校验仍会在 domain 打开时拒绝格式错误的记录。
