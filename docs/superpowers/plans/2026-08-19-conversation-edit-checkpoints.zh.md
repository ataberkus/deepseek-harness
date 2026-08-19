# 对话编辑检查点实现计划

[English](2026-08-19-conversation-edit-checkpoints.md) | 中文

> **致代理工作者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 子技能，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让 Web 用户编辑一条已结算的直接用户消息，并从该消息之前的工作区文件状态继续运行，作为新的子分支；原会话及其检查点保持可恢复。

**架构：** 新增 workspace-checkpoint 能力缝（Service Definition、Harness home 本地 Provider、回合捕获 Consumer）。Host `session.edit` 通过带日志的事务恢复文件，再用现有 `ctx.agents.create` seed 路径创建子会话并接纳编辑后的 prompt。浏览器 runtime 拥有检查点与操作快照；`ui-conversation` 拥有草稿模式和 `编辑并重发` 入口。不修改 `agent-loop`。不添加 Git refs，不改写会话日志。

**技术栈：** TypeScript、Vitest、Cordis、`storage-domain`、`dsh-home-paths`、`dsh-atomic-write`、Host API Proxy RPC + mux 帧、client snapshot store、Playwright Web replay。

**规格：** `docs/superpowers/specs/2026-08-19-conversation-edit-checkpoints-design.md`

这是一个面向用户的功能，保持为一份计划。若评审需要更小的合入窗口，可按三个连续 PR 交付：任务 1–6（捕获/恢复）、任务 7–8（Host + runtime）、任务 9–12（UI、文档、组装回放）。每个 PR 仍须可独立测试。

完整任务步骤、接口签名、测试代码与命令以英文计划为准：`docs/superpowers/plans/2026-08-19-conversation-edit-checkpoints.md`。本文件记录同一计划的中文对照。

## 全局约束

- 不修改 `packages/core/agent-loop`。编辑行为属于检查点缝、Host 命令和 client 插件。
- 检查点元数据不是 `SessionEvent`，不得进入 system prompt 或派生的模型历史。
- 会话日志保持只追加。子会话通过现有 fork/seed API 继承事件前缀；父日志永不截断。
- `session.edit` 的 fork 边界是所选 `user/message` **之前**最近的已完成 `turn/end`。这不是 `session.fork` 的“第一个 `seq >= atSeq` 的 `turn/end`”规则。
- 编辑第一条消息时创建空 seed 子会话，设置 `parentSession`，并恢复 `Checkpoint 0`（`boundarySeq: -1`）。
- 发送前取消不得改动检查点、文件或会话状态。
- 普通模型工作的捕获是 fail-soft。恢复/提交是 fail-closed 并带回滚日志。回滚失败将工作区标为需要恢复，并阻止新的模型工作。
- 恢复只声称工作区文件恢复。不得暗示网络、数据库、终端或被忽略的外部效果已被撤销。
- 不透明 id 使用 branded `CheckpointId`。常规文件字节存放在 Harness home 下的内容寻址对象库；元数据存放在 storage-domain `workspace_checkpoint`。
- Provider 不跟随符号链接。含不安全或不支持条目的检查点不能自动恢复。
- 保留策略和排除项是插件 `Config` 字段，并在 `cordis.yml` 中重述；不要用 `DEFAULT_*` 常量代替可配置性。
- 新缝命名为 `workspace-checkpoint`，以免与 `@deepseek-ai/dsh-session-checkpoint-policy`（会话日志 flush）冲突。
- 将该家族组合进 `packages/bundle/web-app`（storage-domain 已在那里）。本次不要加入 `dsh-base`。
- 产品文案为中文；代码注释为英文。使用 TDD。行为变更同时更新 README 对、子系统文档和 Agent Note。
- Windows 是一等测试目标：清单路径使用 `/` 分隔符；符号链接用例在 `EPERM` 时跳过。

## 文件地图

- 创建：`packages/session/workspace-checkpoint/` — Service Definition `ctx.workspaceCheckpoint`
- 创建：`packages/session/workspace-checkpoint-local/` — 本地对象库、清单捕获、带日志恢复、租约、保留
- 创建：`packages/session/workspace-checkpoint-capture/` — 初始与每回合捕获，以及 recovery-required 守卫
- 修改：Host `session.edit` / `session.activate`、mux `session/checkpoints`
- 修改：browser runtime 快照与 `ui-conversation` 的编辑入口
- 创建：`apps/web/tests/conversation-edit-checkpoints.e2e.ts` 无密钥组装回放
- 只审阅：`packages/core/agent-loop/`（不要编辑）

## 任务

### 任务 1：WorkspaceCheckpoint Service Definition

新增 `@deepseek-ai/dsh-workspace-checkpoint`，导出 Shared interfaces 中的类型、`workspaceCheckpointDomainSpec`（domain 名 `workspace_checkpoint`，表 `checkpoints` 与 `sessions`）以及抽象服务 `WorkspaceCheckpoint`。先写失败的 `spec.spec.ts`，再实现，再提交 `feat: add workspace-checkpoint service definition`。

### 任务 2：清单捕获

实现 `buildManifest`：`lstat` 遍历、不跟随符号链接、配置排除、`/` 相对路径、并发写入检测。测试覆盖创建/修改/删除/二进制/排除/符号链接/路径逃逸。

### 任务 3：对象库与元数据域

实现 `LocalWorkspaceCheckpoint.capture` / `inspect` / `list`。文件按 SHA-256 去重存放；配额耗尽时记录 unavailable 而不删除旧记录；重启后可重开 domain。

### 任务 4：带日志恢复

`restore` 先校验全部 blob，再通过 journal 应用，失败则回滚。回滚失败则 `markRecoveryRequired`。缺失对象不得改动工作区。

### 任务 5：租约、紧急快照、保留

Host 编辑的 `acquireLease` 在已持有时抛出 `CHECKPOINT_LEASE_HELD`。捕获/恢复使用内部 FIFO `withLease`。驱逐不得静默删除当前分支所需 blob；紧急检查点保留在 session index 上。

### 任务 6：回合捕获 Consumer 与恢复守卫

`session/created` 捕获 Checkpoint 0；每个 `turn/end` 在 `flush` 后捕获。捕获失败不影响已完成回复。`recoveryRequired` 时拦截 `llm/stream` 与顶层 `tools/execute`。在 `packages/bundle/web-app/cordis.patch.yml` 挂载。

### 任务 7：Host `session.edit` 与 `session.activate`

实现编辑事务：校验空闲 agent、紧急快照、恢复、按检查点边界 seed、创建子会话、接纳编辑后的用户消息。子会话成为活动会话仅发生在恢复与发布都成功之后。不要复用 `session.fork` 的 `atSeq` 语义。

### 任务 8：浏览器 runtime 快照

处理 `session/checkpoints` 帧。`edit()` 调用 unary RPC。`select()` 调用 `activate`。`workspaceResumable` 区分对话可查看与工作区可恢复。

### 任务 9：对话编辑入口与横幅

已结算、仅文本/图片、且有就绪检查点的直接用户消息显示 `编辑并重发`。草稿模式无副作用。横幅提供取消与发送，并展示操作阶段。发送失败保持源会话选中。

### 任务 10：分支标签与不可恢复工作区

分支行显示 `检查点 {n}`，不隐藏父会话。工作区不可恢复时仍可打开对话，但禁用发送并给出诊断。

### 任务 11：不变量、子系统文档、Agent Note

实现 applied/emergency/parent 引用不变量。新增 `docs/subsystems/workspace-checkpoint.md`。Agent Note 从 `proposed/feature` 在行为合入时移到 `implemented/`，并交叉链接 `.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md`。

### 任务 12：无密钥组装 Web 回放

`apps/web/tests/conversation-edit-checkpoints.e2e.ts`：编辑消息、恢复文件、创建子分支、新 transcript。`$env:DSH_SNAPSHOT='replay'`。

## 不要实现

Git 提交、删除父会话、改写日志、恢复 cwd 之外的文件、撤销外部副作用、给运行中的作业/工作流做检查点、Trajectory 检查点编辑器、面向模型的检查点工具。
