---
description: "本地工作区检查点提供方：Harness home 内容寻址对象库、字节上限、排除 glob、带日志恢复、保留策略与恢复标记。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-checkpoint-local

[English](README.md) | 中文

## 概述

使用此提供方可把工作区检查点保存在本机：文件字节进入 Harness home 下的内容寻址对象库，检查点元数据进入 `workspace_checkpoint` storage domain。恢复带有日志，因此部分失败会回滚，而回滚失败会在恢复可用检查点之前阻止新的模型工作。你需要设置字节上限与排除 glob；超过上限的捕获会记录一个 unavailable 检查点，而不是让回合失败。在 `enabled` 或 Web 插件面板开启之前，该功能保持关闭。

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

[`workspace-checkpoint`](../workspace-checkpoint/) 的本地 Service Provider；它作为 `ctx.workspaceCheckpoint` 加载，并要求在其 `cordis.yml` 行中显式给出捕获限制。

### 何时选择

当 Host 与会话 cwd 位于同一台机器、且检查点存储可以放在 Harness home 下时，选择它。它是该能力唯一随产品交付的提供方；在其旁边加载 `dsh-workspace-checkpoint-capture` 以获得自动捕获与恢复守卫。

### 最小配置

与 `storage`、`storage-json` 和 `storage-domain`（`backend: 'json'`）一起装配。Web bundle 以下列值挂载它：

```yaml
- id: workspace-checkpoint
  name: '@deepseek-ai/dsh-workspace-checkpoint-local'
  config:
    enabled: false
    maxTotalBytes: 1073741824
    excludeGlobs:
      - '**/.git/**'
      - '**/node_modules/**'
      - '**/processhacker_audit.log'
    captureRetryCount: 3
    captureRetryDelayMs: 50
```

| 配置 | 必填 | 语义 |
|---|---|---|
| `enabled` | 否 | 启用自动捕获、恢复准入和对话编辑/激活。默认 `false`；Web 插件面板可通过实时的 `workspace-checkpoint` 设置命名空间覆盖它。 |
| `objectRoot` | 否 | 对象库目录。默认 `{dshHome}/workspace-checkpoints`。 |
| `dshHome` | 否 | 仅在省略 `objectRoot` 时使用的 Harness home 覆盖。 |
| `maxTotalBytes` | 是 | 若写入会让 blob 库超过该上限，则持久化 unavailable 记录并保留既有检查点。 |
| `excludeGlobs` | 是 | 捕获与恢复规划跳过的斜杠分隔 glob（`path.matchesGlob`）；这些路径留在磁盘上。 |
| `captureRetryCount` | 是 | 遇到 `CHECKPOINT_CONCURRENT_WRITE` 后的额外 `buildManifest` 次数。 |
| `captureRetryDelayMs` | 是 | 这些重试之间的延迟。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workspace-checkpoint-local)是所有可接受字段的完整来源。

### 捕获、恢复与保留

捕获把普通文件字节存入内容寻址对象库，并把检查点元数据放在 `workspace_checkpoint` storage domain。遍历使用 `lstat`，不跟随符号链接。恢复使用日志和当前目录树的备份回滚部分文件变更；持久 recovery 标记会在恢复可用检查点之前阻止新的模型工作。带有匹配租约的捕获请求会在调用方的多步骤租约中执行，不会等待该租约释放。保留策略保护已应用检查点及紧急检查点链，`recordEdit` 会在源会话和子会话旁车中持久化分支关系。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明提供方如何排序与存储工作；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计理念

提供方通过一个进程内队列串行执行捕获、恢复与淘汰，按工作区的租约表则防止 Host 持有的租约与内部操作在同一个规范化 cwd 上重叠。捕获把 cwd 遍历为有序清单，按内容哈希写入缺失的 blob，并把记录与会话索引存入 storage domain；遍历期间的并发写入会触发配置的重试。恢复会先校验 blob 哈希、暂存目标目录树、备份当前目录树，并在修改 cwd 之前把计划的操作写入日志；第一次变更之后的失败会依据日志与备份回滚，而回滚失败会把工作区标记为需要恢复。每次持久元数据变化都会发出 `workspace-checkpoint/changed`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LocalWorkspaceCheckpoint` 服务：设置段、操作队列、租约检查、恢复标记、`recordEdit` |
| [`src/config.ts`](src/config.ts) | 插件 `Config` 接口；加载器 schema 是 `src/index.ts` 中的 `LocalWorkspaceCheckpoint.Config` |
| [`src/manifest.ts`](src/manifest.ts) | 基于 `lstat` 遍历生成相对 cwd 的清单，并检测并发写入 |
| [`src/store.ts`](src/store.ts) | 捕获、查看、列出与会话索引持久化 |
| [`src/objects.ts`](src/objects.ts) 与 [`src/hash.ts`](src/hash.ts) | 内容寻址 blob 库与哈希 |
| [`src/restore.ts`](src/restore.ts) 与 [`src/journal.ts`](src/journal.ts) | 带日志恢复与回滚 |
| [`src/retention.ts`](src/retention.ts) | 按字节上限淘汰，并保留已应用与紧急检查点链 |
| [`src/lease.ts`](src/lease.ts) 与 [`src/paths.ts`](src/paths.ts) | 按工作区的租约表，以及 cwd 规范化与包含检查 |
| [`src/invariant.ts`](src/invariant.ts) | `./invariant` 伴生入口：每次 `workspace-checkpoint/changed` 时检查父检查点、已应用、紧急与编辑关系 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当提供方约定不够用时阅读以下页面。它们从所实现的服务逐步进入其依赖的消费者与存储。

- [工作区检查点服务](../workspace-checkpoint/README.zh.md)——`ctx.workspaceCheckpoint` 约定与检查点元数据。
- [捕获消费者](../workspace-checkpoint-capture/README.zh.md)——回合边界捕获与 recovery-required 调度守卫。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-workspace-checkpoint-local)——生成的 `Config` 参考。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

无。此受信任检查点提供方不注册面向模型的 prompt、schema、工具或消息。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制界定本地提供方恢复保证的终点。

- **恢复只覆盖会话 cwd** — 网络、数据库、终端和被忽略的外部效果不在范围内。
- **捕获是 fail-soft** — unavailable 记录不会抹掉已完成的回合；Host 不得为该检查点提供自动恢复。
- **本地 invariant companion 由事件驱动** — 已存在的关系错误会在下一次检查点变更发出时报告；storage schema 校验仍会在 domain 打开时拒绝格式错误的记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
