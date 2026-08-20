# 对话编辑检查点实现计划

[English](2026-08-19-conversation-edit-checkpoints.md) | 中文

> **致代理工作者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 子技能来实现本计划，并按任务逐项执行。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让 Web 用户编辑一条已结算的直接用户消息，并从该消息之前即时存在的工作区文件继续运行，作为新的子分支；原会话及其检查点保持可恢复。

**架构：** 新增 workspace-checkpoint 能力 seam（Service Definition、本地 Harness home Service Provider、回合捕获 Consumer）。Host `session.edit` 通过 journal 事务恢复文件，然后用现有 `ctx.agents.create` seed 路径创建子会话并接纳编辑后的提示词。浏览器 runtime 拥有检查点和操作快照；`ui-conversation` 拥有草稿模式和 `Edit & resend` 入口。不修改 `agent-loop`。不添加 Git refs，也不改写会话日志。

**技术栈：** TypeScript、Vitest、Cordis、`storage-domain`、`dsh-home-paths`、`dsh-atomic-write`、Host API Proxy RPC + mux 帧、client snapshot store、Playwright Web replay。

**规格：** `docs/superpowers/specs/2026-08-19-conversation-edit-checkpoints-design.md`

这是一个面向用户的功能，保持为一份计划。若评审需要更小的合入窗口，可按三个连续 PR 交付：任务 1–6（捕获／恢复）、任务 7–8（Host + runtime）、任务 9–12（UI、文档、组装回放）。每个 PR 仍须可独立测试。

## 全局约束

- 不修改 `packages/core/agent-loop`。编辑行为属于检查点 seam、Host 命令和 client 插件。
- 检查点元数据不是 `SessionEvent`，不得进入 system prompt 或派生的模型历史。
- 会话日志保持仅追加。子会话通过现有 fork/seed API 继承事件前缀；父日志永不截断。
- `session.edit` 的 fork 边界是已完成 `turn/end`，且严格位于所选 `user/message` 之前。这不是 `session.fork` 的“第一个 `turn/end`，位于 `atSeq` 处或之后”规则。
- 编辑第一条消息时创建空 seed 子会话，设置 `parentSession`，并恢复 `Checkpoint 0`（`boundarySeq: -1`）。
- 发送前取消不得改动检查点、文件或会话状态。
- 普通模型工作的捕获是 fail-soft。恢复／提交是 fail-closed，并通过 journal 回滚。回滚失败将工作区标为需要恢复，并阻止新的模型工作。
- 恢复只声称工作区文件恢复。不得暗示网络、数据库、终端或被忽略的外部效果已被撤销。
- 不透明 id 使用 branded `CheckpointId`。普通文件字节存放在 Harness home 下的内容寻址对象库；元数据存放在 storage-domain `workspace_checkpoint`。
- Provider 不跟随符号链接。含有不安全或不受支持条目的检查点不具备自动恢复资格。
- 保留策略和排除项是插件 `Config` 字段，并在 `cordis.yml` 中重述；不要用 `DEFAULT_*` 常量代替可配置性。
- 新 seam 命名为 `workspace-checkpoint`，以免与 `@deepseek-ai/dsh-session-checkpoint-policy`（会话日志 flush）冲突。
- 将该家族组合进 `packages/bundle/web-app`（storage-domain 已在那里）。本次不要加入 `dsh-base`。
- 产品文案为中文；代码注释为英文。使用 TDD。行为变更同时更新 README 配对文件、子系统文档和 Agent Note。
- Windows 是一等测试目标：清单路径使用 `/` 分隔符；符号链接用例在 `EPERM` 时跳过。

---

## 文件地图

- 创建：`packages/session/workspace-checkpoint/` — Service Definition `ctx.workspaceCheckpoint`。
- 创建：`packages/session/workspace-checkpoint-local/` — Harness home 对象库、清单捕获、journal 恢复、租约、保留。
- 创建：`packages/session/workspace-checkpoint-capture/` — 初始捕获和每次 `turn/end` 后的捕获，以及 recovery-required 守卫。
- 修改：`packages/session/README.md` 和 `README.zh.md` — 在持久化旁加入 workspace-checkpoint 家族。
- 修改：`packages/host/apiproxy/src/api/sessions.ts` — 添加 `edit` 和 `activate`。
- 修改：`packages/host/apiproxy/src/api/sessions.schema.ts` — 添加请求／响应 schema。
- 修改：`packages/host/apiproxy/src/api/rpc-map.ts` — 注册 `session.edit` 和 `session.activate`。
- 修改：`packages/host/apiproxy/src/api/events.ts` — 添加 `session/checkpoints` mux 帧。
- 修改：`packages/host/apiproxy/src/fetch/handler.ts` 和 `src/fetch/client.ts` — 接入新的 RPC。
- 修改：`packages/host/apiproxy/src/api-proxy.ts` — 实现编辑事务、激活恢复，并发出检查点快照。
- 修改：`packages/client/runtime/src/client/sessions/` — 检查点／操作快照、`edit`／`activate` 方法，以及选择时的 activate。
- 修改：`packages/client/ui-conversation/src/client/` — `Edit & resend`、草稿横幅、本地化文本、MessageIconActions。
- 修改：`packages/bundle/web-app/cordis.patch.yml` 和 `package.json` — 挂载 Service Provider 和捕获 Consumer。
- 修改：`tsconfig.host.json` — 为三个新包和新的 Web e2e 文件添加项目引用。
- 创建：`apps/web/tests/conversation-edit-checkpoints.e2e.ts` 以及 `apps/web/tests/snapshots/conversation-edit-checkpoints/`。
- 创建：`docs/subsystems/workspace-checkpoint.md`，并在 `docs/subsystems/README.md` 中注册。
- 创建：实现期间创建 `.agents/notes/proposed/feature/2026-08-19-conversation-edit-checkpoints.md`，行为发布时再移到 `implemented/`。
- 仅审阅：`packages/core/session/src/index.ts`（`fork`）、`packages/session/session-checkpoint-policy/`（日志 flush）、`packages/core/agent-loop/`（不要编辑）。

## 共享接口

后续任务将严格使用以下名称。后续任务不得重命名这些名称。

```text
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'

export type CheckpointId = Branded<'CheckpointId'>
export function CheckpointId(id: string): CheckpointId {
  return id as CheckpointId
}

export type CheckpointRole = 'initial' | 'turn' | 'emergency'
export type CheckpointTurnOutcome =
  | 'initial'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type CheckpointStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly reason: string }

export type ManifestEntryKind = 'file' | 'directory' | 'symlink'

export interface ManifestEntry {
  readonly relativePath: string
  readonly kind: ManifestEntryKind
  readonly mode?: number
  readonly size: number
  readonly hash?: string
  readonly linkTarget?: string
  readonly restoreSafe: boolean
}

export interface CheckpointManifest {
  readonly cwd: string
  readonly hash: string
  readonly entries: readonly ManifestEntry[]
}

export interface CheckpointRecord {
  readonly id: CheckpointId
  readonly sessionId: SessionId
  readonly workspaceKey: string
  readonly workspaceId?: WorkspaceId
  readonly boundarySeq: number
  readonly parentCheckpointId?: CheckpointId
  readonly role: CheckpointRole
  readonly turnOutcome: CheckpointTurnOutcome
  readonly status: CheckpointStatus
  readonly createdAt: number
  readonly manifestHash: string
  readonly fileCount: number
  readonly restoreEligible: boolean
  readonly labelIndex: number
}

export interface CheckpointView {
  readonly id: CheckpointId
  readonly sessionId: SessionId
  readonly boundarySeq: number
  readonly labelIndex: number
  readonly role: CheckpointRole
  readonly status: CheckpointStatus
  readonly restoreEligible: boolean
  readonly fileCount: number
  readonly createdAt: number
}

export type CheckpointOperationPhase =
  | 'preparing'
  | 'capturing-emergency'
  | 'restoring'
  | 'creating-branch'
  | 'ready'
  | 'failed'

export interface CheckpointOperationView {
  readonly sourceSessionId: SessionId
  readonly childSessionId?: SessionId
  readonly checkpointId: CheckpointId
  readonly phase: CheckpointOperationPhase
  readonly fileCount: number
  readonly message?: string
}

export interface CaptureRequest {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly workspaceId?: WorkspaceId
  readonly boundarySeq: number
  readonly parentCheckpointId?: CheckpointId
  readonly role: CheckpointRole
  readonly turnOutcome: CheckpointTurnOutcome
}

export interface RestoreRequest {
  readonly checkpointId: CheckpointId
  readonly cwd: string
  readonly signal?: AbortSignal
}

export interface RestoreResult {
  readonly checkpointId: CheckpointId
  readonly fileCount: number
}

export interface WorkspaceLease {
  readonly workspaceKey: string
  release(): void
}

export type WorkspaceCheckpointErrorCode =
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_UNAVAILABLE'
  | 'CHECKPOINT_LEASE_HELD'
  | 'CHECKPOINT_RECOVERY_REQUIRED'
  | 'CHECKPOINT_QUOTA_EXHAUSTED'
  | 'CHECKPOINT_CONTAINMENT'
  | 'CHECKPOINT_HASH_MISMATCH'
  | 'CHECKPOINT_CONCURRENT_WRITE'

export class WorkspaceCheckpointError extends Error {
  constructor(
    message: string,
    public readonly code: WorkspaceCheckpointErrorCode,
  ) {
    super(message)
    this.name = 'WorkspaceCheckpointError'
  }
}
```

Host RPC payloads:

```text
interface SessionRpc {
edit(request: RpcRequest<{
  sessionId: SessionId
  messageSeq: number
  checkpointId: CheckpointId
  text: string
}>): Promise<RpcResponse<{ sessionId: SessionId }>>

activate(request: RpcRequest<{
  sessionId: SessionId
}>): Promise<RpcResponse<{
  restored: boolean
  checkpointId?: CheckpointId
  unavailable?: boolean
}>>
}
```

Mux frame（完整替换快照，与 `session/jobs` 采用相同方式）：

```text
interface SessionCheckpointsFrame {
  type: 'session/checkpoints'
  sessionId: SessionId
  checkpoints: CheckpointView[]
  appliedCheckpointId?: CheckpointId
  operation?: CheckpointOperationView
  recoveryRequired?: string
}
```

Host 和 UI 使用的可编辑消息规则：

- `event.type === 'user/message'`
- `event.data.source.kind === 'user'`
- 所属 turn 存在 `turn/end`
- 每个内容块的类型都是 `type: 'text'` 或 `type: 'image'`
- 至少存在一个 `text` 块

发送时保留图片块。客户端只发送 `text`；Host 从源事件复制原始图片块。

---

### 任务 1：WorkspaceCheckpoint Service Definition

**文件：**
- 创建：`packages/session/workspace-checkpoint/package.json`
- 创建：`packages/session/workspace-checkpoint/tsconfig.json`
- 创建：`packages/session/workspace-checkpoint/src/index.ts`
- 创建：`packages/session/workspace-checkpoint/src/types.ts`
- 创建：`packages/session/workspace-checkpoint/src/spec.ts`
- 创建：`packages/session/workspace-checkpoint/src/error.ts`
- 创建：`packages/session/workspace-checkpoint/src/invariant.ts`
- 创建：`packages/session/workspace-checkpoint/README.md`
- 创建：`packages/session/workspace-checkpoint/README.zh.md`
- 创建：`packages/session/workspace-checkpoint/tests/spec.spec.ts`
- 修改：`tsconfig.host.json` — 添加 `{ "path": "./packages/session/workspace-checkpoint" }`，位置在 `session-stats` 之后

**接口：**
- 消费：`dsh-brand`、`dsh-session/types`、`dsh-storage-domain` 的 `defineDomain`／`domainTable`、Cordis `Service`。
- 产出：`CheckpointId`、`WorkspaceCheckpoint`、`workspaceCheckpointDomainSpec`、`WorkspaceCheckpointError`、`ctx.workspaceCheckpoint`。

- [ ] **步骤 1：编写失败的 domain-spec 测试**

```text
import { describe, expect, it } from 'vitest'
import { CheckpointId } from '../src/types.ts'
import { workspaceCheckpointDomainSpec } from '../src/spec.ts'

describe('workspaceCheckpointDomainSpec', () => {
  it('declares the durable metadata domain', () => {
    expect(workspaceCheckpointDomainSpec.name).toBe('workspace_checkpoint')
    expect(workspaceCheckpointDomainSpec.version).toBe(0)
    expect(Object.keys(workspaceCheckpointDomainSpec.tables)).toEqual([
      'checkpoints',
      'sessions',
    ])
  })

  it('brands checkpoint ids without rewriting the string', () => {
    expect(CheckpointId('cp_1')).toBe('cp_1')
  })
})
```

- [ ] **步骤 2：运行测试，并确认它因包不存在而失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint/tests/spec.spec.ts --reporter=dot`

预期：由于 `../src/spec.ts` 模块不存在而 FAIL。

- [ ] **步骤 3：创建包骨架和 Service Definition**

`package.json` 的 name 为 `@deepseek-ai/dsh-workspace-checkpoint`，version 为 `0.1.0-rc.7`，`private: true`，为 `.` 和 `./invariant` 提供 ESM exports，peer+dev 依赖 `@deepseek-ai/cordis`，并对 `dsh-session`、`dsh-storage-domain`、`dsh-brand`、`dsh-invariants` 声明 peers。`files` 必须严格为 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*.d.ts`。

`tsconfig.json` extends `../../../tsconfig.base.json`，`rootDir: src`，`outDir: lib/types`，并引用 cosmokit、cordis、schemastery、`../../util/brand`、`../../core/session`、`../../storage/storage-domain`、`../../runtime-diagnostics/invariants`。

`src/types.ts` 只包含共享接口中的类型（除 `CheckpointId()` 外不包含运行时内容）。

`src/error.ts` 包含 `WorkspaceCheckpointError`。

`src/spec.ts`：

```text
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CheckpointId } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const checkpointRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceKey: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  boundarySeq: z.number().int().gte(-1),
  parentCheckpointId: z.string().min(1).optional(),
  role: z.enum(['initial', 'turn', 'emergency']),
  turnOutcome: z.enum(['initial', 'completed', 'failed', 'cancelled', 'interrupted']),
  status: z.union([
    z.object({ kind: z.literal('ready') }),
    z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }),
  ]),
  createdAt: nonNegativeSafeInteger,
  manifestHash: z.string().min(1),
  fileCount: nonNegativeSafeInteger,
  restoreEligible: z.boolean(),
  labelIndex: z.number().int().nonnegative(),
})

export const sessionCheckpointIndexSchema = z.object({
  checkpointIds: z.array(z.string().min(1)),
  appliedCheckpointId: z.string().min(1).optional(),
  emergencyCheckpointId: z.string().min(1).optional(),
  recoveryRequired: z.string().min(1).optional(),
})

export const workspaceCheckpointDomainSpec = defineDomain({
  name: 'workspace_checkpoint',
  version: 0,
  tables: {
    checkpoints: domainTable<CheckpointId, z.infer<typeof checkpointRecordSchema>>(checkpointRecordSchema),
    sessions: domainTable<SessionId, z.infer<typeof sessionCheckpointIndexSchema>>(sessionCheckpointIndexSchema),
  },
})
```

`src/index.ts` 默认导出此类：

```text
export abstract class WorkspaceCheckpoint extends Service {
  static readonly [Service.provide] = 'workspaceCheckpoint'
  constructor(ctx: Context) {
    super(ctx, 'workspaceCheckpoint')
  }
  abstract capture(request: CaptureRequest): Promise<CheckpointRecord>
  abstract inspect(id: CheckpointId): Promise<CheckpointRecord>
  abstract list(sessionId: SessionId): Promise<readonly CheckpointView[]>
  abstract restore(request: RestoreRequest): Promise<RestoreResult>
  abstract acquireLease(workspaceKey: string): Promise<WorkspaceLease>
  abstract recoveryRequired(workspaceKey: string): Promise<string | undefined>
  abstract markRecoveryRequired(workspaceKey: string, reason: string): Promise<void>
  abstract clearRecoveryRequired(workspaceKey: string): Promise<void>
}
```

通过声明合并添加 `ctx.workspaceCheckpoint: WorkspaceCheckpoint`。

README 的模型体验：该包不添加 prompt、工具 schema 或 token。已知限制：元数据不是会话事件；恢复仅覆盖会话 cwd 文件。

不变量配套项：`No runtime invariant: the definition owns no mutable store; the local provider and capture consumer register the executable checks.`

- [ ] **步骤 4：运行 spec 测试**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint/tests/spec.spec.ts --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint tsconfig.host.json
git commit -m "feat: add workspace-checkpoint service definition"
```

---

### 任务 2：Manifest capture

**文件：**
- 创建：`packages/session/workspace-checkpoint-local/package.json`
- 创建：`packages/session/workspace-checkpoint-local/tsconfig.json`
- 创建：`packages/session/workspace-checkpoint-local/src/manifest.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/hash.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/paths.ts`
- 创建：`packages/session/workspace-checkpoint-local/tests/manifest.spec.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/invariant.ts`（在任务 5 前保持空实现）
- 修改：`tsconfig.host.json` — 添加 `{ "path": "./packages/session/workspace-checkpoint-local" }`

**接口：**
- 消费：cwd + `excludeGlobs`、Node `fs/promises` + `lstat`。
- 产出：`buildManifest(cwd, options): Promise<CheckpointManifest>` 和 `hashFile`。

- [ ] **步骤 1：编写失败的 manifest 测试**

在 `beforeEach` 中创建临时目录。在 `packages/session/workspace-checkpoint-local/tests/manifest.spec.ts` 中覆盖以下用例：

```text
it('records created, modified, and deleted files as a cwd-relative manifest', async () => {
  await writeFile(join(cwd, 'kept.txt'), 'a')
  await mkdir(join(cwd, 'sub'))
  await writeFile(join(cwd, 'sub', 'nested.bin'), Buffer.from([0, 1, 2]))
  const first = await buildManifest(cwd, { excludeGlobs: [] })
  await writeFile(join(cwd, 'kept.txt'), 'b')
  await writeFile(join(cwd, 'new.txt'), 'n')
  await rm(join(cwd, 'sub', 'nested.bin'))
  const second = await buildManifest(cwd, { excludeGlobs: [] })
  expect(entry(first, 'kept.txt')?.hash).not.toBe(entry(second, 'kept.txt')?.hash)
  expect(entry(second, 'new.txt')?.kind).toBe('file')
  expect(entry(second, 'sub/nested.bin')).toBeUndefined()
  expect(entry(second, 'sub')?.kind).toBe('directory')
})

it('skips configured exclusions and does not follow symlinks', async () => {
  await writeFile(join(cwd, 'keep.txt'), 'k')
  await mkdir(join(cwd, 'node_modules'))
  await writeFile(join(cwd, 'node_modules', 'x.js'), 'ignored')
  try {
    await symlink(join(cwd, 'keep.txt'), join(cwd, 'link.txt'))
  } catch (error) {
    if (isPermDenied(error)) return
    throw error
  }
  const manifest = await buildManifest(cwd, { excludeGlobs: ['**/node_modules/**'] })
  expect(entry(manifest, 'node_modules/x.js')).toBeUndefined()
  const link = entry(manifest, 'link.txt')
  expect(link?.kind).toBe('symlink')
  expect(link?.restoreSafe).toBe(true)
})

it('rejects a path that escapes the workspace', async () => {
  await expect(buildManifest(join(cwd, '..'), { excludeGlobs: [] }))
    .rejects.toMatchObject({ code: 'CHECKPOINT_CONTAINMENT' })
})

it('marks a symlink whose target leaves the workspace unsafe', async () => {
  try {
    await symlink(join(cwd, '..', 'outside.txt'), join(cwd, 'escape'))
  } catch (error) {
    if (isPermDenied(error)) return
    throw error
  }
  const manifest = await buildManifest(cwd, { excludeGlobs: [] })
  expect(entry(manifest, 'escape')?.restoreSafe).toBe(false)
})
```

辅助函数 `entry(manifest, path)` 查找 `relativePath === path` 的条目。清单相对路径即使在 Windows 上也必须使用 `/`。

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/manifest.spec.ts --reporter=dot`

预期：由于 `buildManifest` 未定义而 FAIL。

- [ ] **步骤 3：实现捕获**

`src/paths.ts`：

- `toManifestPath(cwd, absolutePath)` → 使用斜杠分隔的相对路径。
- `fromManifestPath(cwd, relativePath)` → 平台路径；拒绝 `..` 和绝对路径段，并使用 `CHECKPOINT_CONTAINMENT`。
- 遍历前对 `cwd` 执行 `realpath`。

`src/hash.ts`：通过 `createHash('sha256')` 流式读取文件，生成 SHA-256 十六进制值。

`src/manifest.ts` 的 `buildManifest(cwd, { excludeGlobs })`：

1. 对 cwd 执行 realpath；如果它不是目录，则抛出 `CHECKPOINT_CONTAINMENT`。
2. 使用 `readdir` + `lstat` 遍历（绝不使用 `stat`）。
3. 跳过匹配 `excludeGlobs` 的名称（在 Node 22 上使用 `path.matchesGlob`）。
4. 文件：记录 size、可选的 mode、hash，并设置 `restoreSafe: true`。
5. 目录：设置 `restoreSafe: true`，不记录 hash。
6. 符号链接：保存链接文本；当解析后的目标仍在 cwd 内时，`restoreSafe` 才为 true。
7. 按 `relativePath` 对条目排序。
8. `manifest.hash` 是条目规范 JSON 的 SHA-256。

如果预哈希 stat 和后哈希 stat 之间的 `lstat` size／mtime 发生变化，则抛出 `CHECKPOINT_CONCURRENT_WRITE`。

- [ ] **步骤 4：运行 manifest 测试**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/manifest.spec.ts --reporter=dot`

预期：PASS。符号链接权限跳过不得导致文件失败。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint-local tsconfig.host.json
git commit -m "feat: capture workspace checkpoint manifests without following symlinks"
```

---

### 任务 3：Object store and metadata domain

**文件：**
- 创建：`packages/session/workspace-checkpoint-local/src/objects.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/store.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/index.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/config.ts`
- 创建：`packages/session/workspace-checkpoint-local/tests/store.spec.ts`
- 创建：`packages/session/workspace-checkpoint-local/README.md` 和 `README.zh.md`

**接口：**
- 消费：`workspaceCheckpointDomainSpec`、`buildManifest`、`dshHomePath`、`ctx.storageDomain`。
- 产出：`LocalWorkspaceCheckpoint.capture`、`inspect` 和 `list`。

- [ ] **步骤 1：编写失败的 store 测试**

启动一个小型 Cordis 应用，包含 `storage`、`storage-json`（`root` = 临时目录）、`storage-domain`（`backend: 'json'`）和本地 Provider（`objectRoot` = 临时目录、`maxTotalBytes: 1024 * 1024`、`excludeGlobs: []`、`captureRetryCount: 2`、`captureRetryDelayMs: 10`）。

```text
it('stores file bytes by content hash and reuses identical contents', async () => {
  await writeFile(join(cwd, 'a.txt'), 'same')
  await writeFile(join(cwd, 'b.txt'), 'same')
  const record = await ctx.workspaceCheckpoint.capture({
    sessionId: SessionId('s1'),
    cwd,
    boundarySeq: -1,
    role: 'initial',
    turnOutcome: 'initial',
  })
  expect(record.status).toEqual({ kind: 'ready' })
  expect(record.restoreEligible).toBe(true)
  expect(record.labelIndex).toBe(0)
  const objects = await readdir(objectRoot, { recursive: true })
  expect(objects.filter(name => !name.includes('.'))).toHaveLength(1)
})

it('marks a checkpoint unavailable when quota is exhausted and keeps prior records', async () => {
  await writeFile(join(cwd, 'big.bin'), Buffer.alloc(2048, 1))
  const tiny = await createLocalCheckpoint({ maxTotalBytes: 100 })
  const record = await tiny.capture({
    sessionId: SessionId('s1'), cwd, boundarySeq: -1, role: 'initial', turnOutcome: 'initial',
  })
  expect(record.status.kind).toBe('unavailable')
  await expect(tiny.inspect(record.id)).resolves.toMatchObject({ status: { kind: 'unavailable' } })
})

it('survives process restart by reopening the domain', async () => {
  const first = await captureThenDispose()
  const reopened = await openProvider()
  await expect(reopened.inspect(first.id)).resolves.toMatchObject({
    id: first.id,
    manifestHash: first.manifestHash,
  })
})
```

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/store.spec.ts --reporter=dot`

预期：由于 `LocalWorkspaceCheckpoint` 尚未注册而 FAIL。

- [ ] **步骤 3：实现本地 Provider 的捕获路径**

配置（schemastery，除 `objectRoot`／`dshHome` 外均为必填）：

```text
export interface Config {
  objectRoot?: string
  dshHome?: string
  maxTotalBytes: number
  excludeGlobs: string[]
  captureRetryCount: number
  captureRetryDelayMs: number
}
```

对象布局：`{objectRoot}/objects/{hash[0:2]}/{hash}`；使用 `writeFileAtomic`，文件模式为 `0o600`，目录模式为 `0o700`。默认 `objectRoot` 是 `dshHomePath('workspace-checkpoints')`，位于 `resolveDshHome(config.dshHome)` 之后。

`capture`：

1. 在 apply 时于 `workspace_checkpoint` domain 中使用 `ctx.effect` 打开；`open` 的调用方负责关闭。
2. 对 `buildManifest` 最多重试 `captureRetryCount` 次，处理 `CHECKPOINT_CONCURRENT_WRITE`；如果仍在竞争，则持久化 `status: { kind: 'unavailable', reason: 'concurrent-write' }` 和 `restoreEligible: false`。
3. 如果任何条目的 `restoreSafe === false`，则持久化 unavailable／`restoreEligible: false`，且不为不安全目标写入 blob。
4. 将每个普通文件复制到对象库；相同 hash 不执行任何操作。
5. 如果添加 blob 会超出 `maxTotalBytes`，则持久化 unavailable `CHECKPOINT_QUOTA_EXHAUSTED`，不删除较旧检查点（驱逐在任务 5 中实现）。
6. 将 `labelIndex` 设为 `role !== 'emergency'` 检查点的数量，这些检查点已存储在 `sessionId` 下。
7. 写入 `checkpoints[id]`，并将 id 追加到 `sessions[sessionId].checkpointIds`。

缺少记录时，`inspect` 抛出 `CHECKPOINT_NOT_FOUND`。`list` 按 label 顺序返回 `CheckpointView[]`，排除 blob 内部信息。

- [ ] **步骤 4：运行 store 测试**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/store.spec.ts --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint-local
git commit -m "feat: persist workspace checkpoints in a content-addressed store"
```

---

### 任务 4：Journaled restore

**文件：**
- 创建：`packages/session/workspace-checkpoint-local/src/restore.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/journal.ts`
- 修改：`packages/session/workspace-checkpoint-local/src/index.ts` — 实现 `restore`
- 创建：`packages/session/workspace-checkpoint-local/tests/restore.spec.ts`

**接口：**
- 消费：`RestoreRequest`、持久化的 manifest + blob。
- 产出：使 cwd 与 manifest 一致，或执行回滚的 `restore`。

- [ ] **步骤 1：编写失败的 restore 测试**

```text
it('restores modified, created, deleted, renamed, and binary files', async () => {
  await writeFile(join(cwd, 'a.txt'), 'one')
  await writeFile(join(cwd, 'keep.bin'), Buffer.from([1, 2, 3]))
  const cp = await captureReady()
  await writeFile(join(cwd, 'a.txt'), 'two')
  await writeFile(join(cwd, 'extra.txt'), 'x')
  await rm(join(cwd, 'keep.bin'))
  await ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd })
  expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('one')
  expect(await readFile(join(cwd, 'keep.bin'))).toEqual(Buffer.from([1, 2, 3]))
  await expect(stat(join(cwd, 'extra.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a missing blob without touching the workspace', async () => {
  const cp = await captureReady()
  await rmObjectStore()
  await writeFile(join(cwd, 'marker.txt'), 'stay')
  await expect(ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd }))
    .rejects.toMatchObject({ code: 'CHECKPOINT_HASH_MISMATCH' })
  expect(await readFile(join(cwd, 'marker.txt'), 'utf8')).toBe('stay')
})

it('rolls back a mid-commit failure and leaves the original tree', async () => {
  const cp = await captureReady()
  await writeFile(join(cwd, 'dirty.txt'), 'dirty')
  await withInjectedRenameFailure(async () => {
    await expect(ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd })).rejects.toBeTruthy()
  })
  expect(await readFile(join(cwd, 'dirty.txt'), 'utf8')).toBe('dirty')
})

it('marks recovery-required when rollback itself fails', async () => {
  const cp = await captureReady()
  await withInjectedRollbackFailure(async () => {
    await expect(ctx.workspaceCheckpoint.restore({ checkpointId: cp.id, cwd })).rejects.toBeTruthy()
  })
  await expect(ctx.workspaceCheckpoint.recoveryRequired(workspaceKey(cwd)))
    .resolves.toEqual(expect.stringContaining('recovery'))
})
```

导出仅供测试使用的 `restoreInternals` 对象（来自 `src/restore.ts`，可赋值的 `rename`，默认为 `fs.rename`），以便注入提交中途的失败。

- [ ] **步骤 2：运行 restore 测试，并确认它们失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/restore.spec.ts --reporter=dot`

预期：由于 `restore` 尚未实现而 FAIL。

- [ ] **步骤 3：实现暂存、校验、journal 和回滚**

1. 如果 `status.kind !== 'ready'` 或 `restoreEligible === false`，则以 `CHECKPOINT_UNAVAILABLE` 拒绝。
2. 获取每个工作区的租约（任务 5；在此之前使用以规范化 cwd 为键的进程内 promise chain Map）。
3. 读取每个 blob 并校验 SHA-256；在任何 cwd 变更前抛出 `CHECKPOINT_HASH_MISMATCH`。
4. 在 `{objectRoot}/staging/{checkpointId}/` 下暂存完整树。
5. 写入 journal `{objectRoot}/journals/{workspaceHash}.json`，列出计划删除、写入、mkdir、创建符号链接，以及位于 `{objectRoot}/journals/{id}/backup/` 下的被替换路径备份。
6. 应用 journal。第一次 cwd 变更之后，忽略 `signal` abort，只完成操作或回滚。
7. 成功时删除 journal 和 staging 目录，并执行 `clearRecoveryRequired`。
8. 失败时重放备份。如果重放抛出异常，则执行 `markRecoveryRequired` 并重新抛出。
9. 删除或替换时绝不跟随符号链接。拒绝任何未通过 `fromManifestPath` 包含性检查的 journal 路径。

目标 manifest 中不存在的未跟踪文件会被删除，使树与检查点一致。

- [ ] **步骤 4：运行 restore 测试**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/restore.spec.ts --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint-local
git commit -m "feat: restore workspace checkpoints through a rollback journal"
```

---

### 任务 5：Lease, emergency snapshots, retention

**文件：**
- 创建：`packages/session/workspace-checkpoint-local/src/lease.ts`
- 创建：`packages/session/workspace-checkpoint-local/src/retention.ts`
- 修改：`packages/session/workspace-checkpoint-local/src/index.ts`
- 修改：`packages/session/workspace-checkpoint-local/src/invariant.ts`
- 创建：`packages/session/workspace-checkpoint-local/tests/lease.spec.ts`
- 创建：`packages/session/workspace-checkpoint-local/tests/retention.spec.ts`

**接口：**
- 消费：`acquireLease`、`CaptureRequest.role === 'emergency'`、`maxTotalBytes`。
- 产出：独占的进程内工作区租约、紧急检查点记录，以及绝不静默丢弃活动分支 blob 的驱逐机制。

- [ ] **步骤 1：编写失败的 lease 和 retention 测试**

```text
it('serializes restore and capture on one workspace', async () => {
  const held = await ctx.workspaceCheckpoint.acquireLease(key)
  let started = false
  const blocked = ctx.workspaceCheckpoint.capture({
    sessionId: SessionId('s1'), cwd, boundarySeq: 0, role: 'turn', turnOutcome: 'completed',
  }).then(result => {
    started = true
    return result
  })
  await delay(20)
  expect(started).toBe(false)
  held.release()
  await blocked
  expect(started).toBe(true)
})

it('rejects a second acquire while the lease is held', async () => {
  const held = await ctx.workspaceCheckpoint.acquireLease(key)
  await expect(ctx.workspaceCheckpoint.acquireLease(key))
    .rejects.toMatchObject({ code: 'CHECKPOINT_LEASE_HELD' })
  held.release()
})

it('retains blobs referenced by the applied branch and marks the other branch unavailable when quota requires eviction', async () => {
  const parent = await fillUntilNearQuota()
  const child = await captureOnChildSession()
  await ctx.workspaceCheckpoint.restore({ checkpointId: child.id, cwd })
  await ctx.workspaceCheckpoint.evict()
  await expect(ctx.workspaceCheckpoint.inspect(child.id)).resolves.toMatchObject({ restoreEligible: true })
  const evicted = await ctx.workspaceCheckpoint.inspect(parent.id)
  expect(evicted.restoreEligible).toBe(false)
  expect(evicted.status.kind).toBe('unavailable')
})

it('keeps an emergency checkpoint linked on the session index', async () => {
  const emergency = await ctx.workspaceCheckpoint.capture({
    sessionId: SessionId('s1'), cwd, boundarySeq: 3, role: 'emergency', turnOutcome: 'completed',
  })
  const index = await readSessionIndex(SessionId('s1'))
  expect(index.emergencyCheckpointId).toBe(emergency.id)
})
```

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/lease.spec.ts packages/session/workspace-checkpoint-local/tests/retention.spec.ts --reporter=dot`

预期：由于缺少租约排除，或驱逐会删除已应用的检查点而 FAIL。

- [ ] **步骤 3：实现 lease 和 retention**

Lease：从规范化工作区键到持有 token 的进程内 Map。

- Host 编辑使用的 `acquireLease`：如果已有租约，则抛出 `CHECKPOINT_LEASE_HELD`（RPC 不得无进展地挂起）。
- 捕获／恢复内部使用 `withLease(key, fn)`：FIFO chain。

Retention：按 `createdAt` 升序排列可驱逐检查点。绝不驱逐：

- 任何会话的 `appliedCheckpointId`，只要其 `workspaceKey` 匹配
- 该会话的 `emergencyCheckpointId`
- 被保留记录列为 `parentCheckpointId` 的检查点，前提是删除它会使已应用链遗留

必须删除某个检查点时，删除未被引用的 blob，将 `restoreEligible: false` 和 `status: { kind: 'unavailable', reason: 'evicted' }` 写入，并保留元数据行，以便 UI 显示诊断关系。

在持久化提交后发出 `workspace-checkpoint/changed`。不变量：每个 `appliedCheckpointId` 要么检查结果为 `restoreEligible: true`，要么会话索引设置了 `recoveryRequired`。

```text
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Durable checkpoint metadata or workspace association changed.
     * @param sessionId - session whose index or records changed.
     * @mode emit
     */
    'workspace-checkpoint/changed'(sessionId: SessionId): void
  }
}
```

如果任务 1 中尚未有该方法，则在任务 1 中添加 `abstract evict(): Promise<void>` 到 `WorkspaceCheckpoint`；如果任务 1 已经在没有该方法的情况下发布，则在本任务中添加该方法，并更新定义包。

- [ ] **步骤 4：运行 lease、retention、manifest、store 和 restore 测试**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint-local packages/session/workspace-checkpoint
git commit -m "feat: lease workspace restores and bound checkpoint retention"
```

---

### 任务 6：Turn capture consumer and recovery guard

**文件：**
- 创建：`packages/session/workspace-checkpoint-capture/`（匹配任务 1 的完整包骨架）
- 创建：`packages/session/workspace-checkpoint-capture/src/index.ts`
- 创建：`packages/session/workspace-checkpoint-capture/src/invariant.ts`
- 创建：`packages/session/workspace-checkpoint-capture/tests/capture.spec.ts`
- 创建：`packages/session/workspace-checkpoint-capture/tests/guard.spec.ts`
- 创建：`packages/session/workspace-checkpoint-capture/README.md` 和 `README.zh.md`
- 修改：`tsconfig.host.json`
- 修改：`packages/bundle/web-app/cordis.patch.yml` 和 `packages/bundle/web-app/package.json`
- 修改：`packages/session/README.md` 和 `README.zh.md`

**接口：**
- 消费：`ctx.workspaceCheckpoint`、`ctx.sessions`、`session/created`、`turn/end`、`ctx.sessions.flush`、`ctx.llm`／`ctx.tools` waterfall。
- 产出：在工作区获取时创建 Checkpoint 0，每个已结算回合后创建一个检查点，并在 recovery-required 时阻止 prompt／tool。

- [ ] **步骤 1：编写失败的捕获和守卫测试**

使用真实的 Loader 组合：临时目录中的 `session`、persistence-jsonl、storage-json + storage-domain、workspace-checkpoint-local、本 Consumer，以及 stub llm/tools。

```text
it('captures checkpoint 0 when the session obtains a cwd and a later checkpoint after turn/end', async () => {
  const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd } })
  await waitFor(async () => (await ctx.workspaceCheckpoint.list(session.id)).length === 1)
  expect((await ctx.workspaceCheckpoint.list(session.id))[0]?.boundarySeq).toBe(-1)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  await waitFor(async () => (await ctx.workspaceCheckpoint.list(session.id)).length === 2)
  const after = (await ctx.workspaceCheckpoint.list(session.id)).at(-1)
  expect(after?.boundarySeq).toBe(session.events.find(e => e.type === 'turn/end')?.seq)
})

it('keeps the completed turn when capture fails and marks the checkpoint unavailable', async () => {
  await makeCwdUnreadable()
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  const views = await ctx.workspaceCheckpoint.list(session.id)
  expect(views.some(view => view.status.kind === 'unavailable')).toBe(true)
  expect(session.events.some(event => event.type === 'turn/end')).toBe(true)
})

it('captures failed, cancelled, and interrupted turns', async () => {
  for (const reason of [
    { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } },
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'interrupted' },
  ] as const) {
    // one turn each; assert turnOutcome matches
  }
})

it('blocks llm/stream and top-level tools/execute while recovery-required', async () => {
  await ctx.workspaceCheckpoint.markRecoveryRequired(key, 'rollback failed')
  await expect(runStream()).rejects.toMatchObject({ code: 'CHECKPOINT_RECOVERY_REQUIRED' })
  await expect(runTool()).resolves.toMatchObject({ isError: true })
})
```

回合原因映射：`completed` → `completed`；`error`／`max-tokens`／`blocked` → `failed`；`aborted` → `cancelled`；`interrupted` → `interrupted`。

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-capture/tests --reporter=dot`

预期：由于 Consumer 未加载或未监听而 FAIL。

- [ ] **步骤 3：实现 Consumer**

函数插件 `name: 'workspace-checkpoint-capture'`，`inject: ['workspaceCheckpoint', 'sessions', 'llm', 'tools']`。

在 `session/created` 上，如果存在 `header.cwd`，则执行 `capture`，参数为 `boundarySeq: -1`、`role: 'initial'`。不得阻塞会话创建：在 session fiber 上调度该工作。捕获错误转为 unavailable 记录，绝不抛入 session create。

在 `session/event` 上，当 `type === 'turn/end'` 时：

1. `await ctx.sessions.flush(session)`
2. 使用 `withLease` + `capture`，其中 `boundarySeq: event.seq`、`role: 'turn'`、parent = 该会话最近的 ready 非 emergency 检查点
3. 捕获失败 → unavailable 记录，绝不抛入 agent loop

守卫：像 session-checkpoint-policy 一样包装 `llm/stream` 和顶层 `tools/execute`。如果设置了 `recoveryRequired(cwd)`，不要调用 `next()`。嵌套工具复用外层检查。

在 storage-domain 附近的 `packages/bundle/web-app/cordis.patch.yml` 中组合：

```yaml
- id: workspace-checkpoint
  name: '@deepseek-ai/dsh-workspace-checkpoint-local'
  config:
    maxTotalBytes: 1073741824
    excludeGlobs:
      - '**/.git/**'
      - '**/node_modules/**'
    captureRetryCount: 3
    captureRetryDelayMs: 50

- id: workspace-checkpoint-capture
  name: '@deepseek-ai/dsh-workspace-checkpoint-capture'
```

将两个包都添加到 `packages/bundle/web-app/package.json` 的 dependencies。定义包是本地 Provider 的依赖；不要为抽象 Service 添加单独的 cordis 行。

- [ ] **步骤 4：运行 capture 测试**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-capture/tests packages/session/workspace-checkpoint-local/tests --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint-capture packages/session/README.md packages/session/README.zh.md packages/bundle/web-app tsconfig.host.json
git commit -m "feat: capture workspace checkpoints at session start and turn end"
```

---

### 任务 7：Host `session.edit` and `session.activate`

**文件：**
- 修改：`packages/host/apiproxy/src/api/sessions.ts`
- 修改：`packages/host/apiproxy/src/api/sessions.schema.ts`
- 修改：`packages/host/apiproxy/src/api/rpc-map.ts`
- 修改：`packages/host/apiproxy/src/api/events.ts`
- 修改：`packages/host/apiproxy/src/fetch/handler.ts`
- 修改：`packages/host/apiproxy/src/fetch/client.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 创建：`packages/host/apiproxy/tests/api-proxy-edit.spec.ts`
- 修改：`packages/host/apiproxy/tests/rpc-schemas.spec.ts`
- 修改：`packages/host/apiproxy/README.md` 和 `README.zh.md`

**接口：**
- 消费：`WorkspaceCheckpoint`、`ctx.agents.create`、现有的 `readSessionState`／`composeAgent`／`forkWorkspace`／`session.prompt` admission。
- 产出：`session.edit`、`session.activate`、`session/checkpoints` mux 快照和操作阶段。

- [ ] **步骤 1：编写失败的 Host 测试**

挂载本地 Provider 和临时 cwd。为父会话写入两个回合：用户消息 A、assistant、用户消息 B。第 1 回合之后修改一个文件。

```text
it('edits a later user message from the preceding checkpoint and hides descendants in the child', async () => {
  await writeFile(join(cwd, 'note.txt'), 'after-turn-2')
  const result = await sessions.edit({
    sessionId: parentId,
    messageSeq: messageBSeq,
    checkpointId: checkpointAfterTurn1.id,
    text: 'edited B',
  })
  expect(result.ok).toBe(true)
  const child = await inspect(result.value.sessionId)
  expect(child.header.parentSession).toBe(parentId)
  expect(child.events.some(event => event.type === 'user/message' && messageText(event) === 'edited B')).toBe(true)
  expect(child.events.some(event => messageText(event) === 'B')).toBe(false)
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('after-turn-1')
  const parent = await inspect(parentId)
  expect(parent.events.some(event => messageText(event) === 'B')).toBe(true)
})

it('edits the first message from checkpoint 0 as an empty-seed child', async () => {
  const result = await sessions.edit({
    sessionId: parentId,
    messageSeq: firstUserSeq,
    checkpointId: checkpoint0.id,
    text: 'edited A',
  })
  const child = await inspect(result.value.sessionId)
  expect(child.header.seedLength ?? 0).toBe(0)
  expect(child.events.filter(event => event.type === 'user/message')).toHaveLength(1)
})

it('preserves image blocks and rejects steering or in-flight messages', async () => {
  await expect(sessions.edit({ sessionId, messageSeq: steeringSeq, checkpointId, text: 'x' }))
    .resolves.toMatchObject({ error: { code: 'edit-not-editable' } })
})

it('rolls the filesystem back and keeps the parent active when child publication fails', async () => {
  await withBrokenAgentCreate(async () => {
    await expect(sessions.edit({ ...valid })).resolves.toMatchObject({ error: { code: 'internal' } })
  })
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('dirty-before-edit')
  expect(await listLive()).toEqual([parentId])
})

it('keeps a published child when the later model call fails', async () => {
  await withFailingAdapter(async () => {
    const result = await sessions.edit({ ...valid })
    expect(result.ok).toBe(true)
  })
  expect(await inspect(childId).then(s => s.header.parentSession)).toBe(parentId)
  expect(await inspect(parentId).events).toEqual(parentEventsBefore)
})

it('activate restores the selected branch latest checkpoint and refuses an evicted tree', async () => {
  await sessions.edit({ ...createChild })
  await sessions.activate({ sessionId: parentId })
  expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('parent-latest')
  await markUnavailable(parentLatest)
  const denied = await sessions.activate({ sessionId: parentId })
  expect(denied.value.unavailable).toBe(true)
  expect(denied.value.restored).toBe(false)
})
```

同时在 `rpc-schemas.spec.ts` 中为 `sessionEditRequestSchema` 添加 schema 用例（非空 text、整数 `messageSeq`、branded id），并覆盖可选的 `session/checkpoints` 帧字段。

操作进度：断言 mux 帧依次经过 `preparing` → `capturing-emergency` → `restoring` → `creating-branch` → `ready`，并断言失败帧使用 `failed` 且没有 child id。

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-edit.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

预期：由于 RPC map 中没有 `session.edit` 而 FAIL。

- [ ] **步骤 3：实现 Host 命令**

RPC 错误码：`edit-not-editable`、`checkpoint-unavailable`、`agent-busy`、`checkpoint-recovery-required`，以及已有的 `session-not-found`／`internal`。

`session.edit` 算法：

1. 使用现有的 `readSessionState` 读取源会话。拒绝不存在的会话。
2. 如果附加的 agent 正在运行，则返回 `agent-busy`。
3. 如果 `recoveryRequired(cwd)`，则返回 `checkpoint-recovery-required`。
4. 定位 `user/message` 的 `messageSeq`。应用可编辑消息规则。收集原始图片块。
5. 验证 `checkpointId` 属于这个 `sessionId`（或属于同一 workspaceKey lineage 中的父会话）、具备 `restoreEligible`，并且 `boundarySeq` 为 `-1`，或对应最后一个 `turn/end`，该回合严格位于 `messageSeq` 之前。
6. 发出操作阶段 `preparing`。
7. 使用 `capture` 捕获当前文件的 emergency 检查点（`role: 'emergency'`）。阶段为 `capturing-emergency`。
8. `acquireLease`。阶段为 `restoring`。执行 `restore({ checkpointId, cwd })`。
9. 计算 seed：取 `turn/end` 的前缀，直到 `seq === checkpoint.boundarySeq`，然后延伸经过后续独立事件直到下一个 `turn/start`，方式与 `session.fork` 完全相同。如果 `boundarySeq === -1`，seed 为 `[]`，`seedLength` 为 `0`。
10. 阶段为 `creating-branch`。调用 `ctx.agents.create`，参数包括 `parentSession`、`cwd`、`seedLength` 和源 composition，复制 `session.fork` 的 create 调用。附加到同一工作区。
11. 通过与 `session.prompt` 相同的持久化 admission 路径接纳编辑后的用户消息（`mode: 'queue'`、`content: [{ type: 'text', text }, ...preservedImages]`）。不要发送原始消息文本。
12. 在会话检查点索引上记录伴随字段：源会话、源边界、选定检查点、紧急检查点、子会话 id。
13. 为源会话和子会话发布 `session/checkpoints`。阶段为 `ready`。返回 `{ sessionId: childId }`。
14. 如果在发布子会话之前失败：恢复 emergency 检查点（或已失败的 restore 已通过 journal 回滚），释放租约，保持源会话选中，阶段为 `failed`。
15. 如果在发布之后失败：保留子会话（失败分支），不修改父日志，只在子会话上将阶段设为 `ready` 或 `failed`。

`session.activate`：

1. 必须有空闲 agent。
2. 选择该会话最近的可用非 emergency 检查点。如果没有，则返回 `{ restored: false }`。
3. 如果已经是 `appliedCheckpointId`，则返回 `{ restored: false }`，不执行第二次恢复。
4. 执行紧急捕获和恢复，并更新 applied id。如果最近的检查点不具备恢复资格，则返回 `{ restored: false, unavailable: true }`，不修改文件。

发出 `session/checkpoints`：在 mux 订阅时（基线）以及 `workspace-checkpoint/changed` 时。

不要复用 `session.fork` 进行截断：它的 `atSeq` 会包含所选消息所属的回合。

- [ ] **步骤 4：运行 Host 测试，包括现有 fork 测试**

运行：`pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-edit.spec.ts packages/host/apiproxy/tests/api-proxy-fork.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

预期：PASS。现有 fork 行为不变。

- [ ] **步骤 5：提交**

```bash
git add packages/host/apiproxy
git commit -m "feat: add session.edit restore-and-branch Host command"
```

---

### 任务 8：Browser runtime snapshots

**文件：**
- 修改：`packages/client/runtime/src/client/sessions/session.ts`
- 修改：`packages/client/runtime/src/client/sessions/service.ts`
- 修改：`packages/client/runtime/src/client/sessions/manager.ts`
- 创建：`packages/client/runtime/src/client/sessions/checkpoint-store.ts`
- 修改：`packages/client/runtime/tests/manager.client.spec.ts`

**接口：**
- 消费：`session/checkpoints` mux 帧、`session.edit`、`session.activate`。
- 产出：session 对象上的不可变 `CheckpointSnapshot`、`sessions.edit`、选择时的 `activate`。

- [ ] **步骤 1：编写失败的 runtime 测试**

```text
it('replaces checkpoint snapshots from mux frames and ignores stale in-flight operations after ready', async () => {
  session.handleMux({ type: 'session/checkpoints', sessionId, checkpoints: [view0], operation: preparing })
  expect(session.snapshot.checkpoints?.operation?.phase).toBe('preparing')
  session.handleMux({ type: 'session/checkpoints', sessionId, checkpoints: [view0], operation: { ...ready } })
  expect(session.snapshot.checkpoints?.operation?.phase).toBe('ready')
})

it('edit() sends text, messageSeq, and checkpointId and returns the child id', async () => {
  const childId = await runtime.edit({ sessionId, messageSeq: 4, checkpointId: CheckpointId('cp1'), text: 'n' })
  expect(calls.edit).toEqual([{ sessionId, messageSeq: 4, checkpointId: 'cp1', text: 'n' }])
  expect(childId).toBe(childSessionId)
})

it('select() activates the branch and keeps conversation available when the workspace is unrestorable', async () => {
  await runtime.select(parentId)
  expect(calls.activate).toEqual([{ sessionId: parentId }])
  session.handleMux({
    type: 'session/checkpoints',
    sessionId: parentId,
    checkpoints: [unavailableView],
  })
  expect(runtime.session(parentId).snapshot.checkpoints?.workspaceResumable).toBe(false)
})
```

`workspaceResumable` 为 `true` 当且仅当最近的非 emergency 检查点具有 `restoreEligible`。即使它为 false，对话仍保持在列表中。

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/client/runtime/tests/manager.client.spec.ts --reporter=dot`

预期：由于不存在 `edit`／检查点快照字段而 FAIL。

- [ ] **步骤 3：实现 runtime 接线**

在 `Session` 上将检查点存为普通快照字段，而不是 UI store。将 `session/checkpoints` 放在 `session/jobs` 旁处理。

`SessionRuntime.edit` 调用 unary RPC，成功后再执行 `select(childId)`。

`SessionManager.select` 已经会立即通知。设置 `selected` 后，在不阻塞首次绘制的情况下调用 `session.activate({ sessionId })`：RPC 返回前保留之前的文件，随后由 mux 快照更新。如果 `unavailable: true`，设置 session 诊断标志；不要隐藏 transcript。

不要将检查点 blob 持久化到 `localStorage`。

- [ ] **步骤 4：运行 runtime 检查点测试和 lineage 测试**

运行：`pnpm exec vitest run packages/client/runtime/tests/manager.client.spec.ts --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/client/runtime
git commit -m "feat: project workspace checkpoint snapshots in the browser runtime"
```

---

### 任务 9：Conversation edit affordance and banner

**文件：**
- 修改：`packages/client/ui-conversation/src/client/chat/MessageIconActions.tsx`
- 修改：`packages/client/ui-conversation/src/client/chat/MessageItem.tsx`
- 修改：`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`
- 修改：`packages/client/ui-conversation/src/client/stores.ts`
- 修改：`packages/client/ui-conversation/src/client/locales.ts`
- 修改：`packages/client/ui-conversation/src/client/input/`，仅用于将文本 + 保留的图片 id 加载到现有 composer
- 修改：`packages/client/ui-conversation/tests/chat-view.client.spec.tsx` 和 `input-bar.client.spec.tsx`
- 修改：`packages/client/ui-conversation/README.md` 和 `README.zh.md` — 删除“不得编辑已结算消息”的限制

**接口：**
- 消费：`UserMessageNode`、检查点快照、`runtime.edit`、现有 InputMachine 草稿。
- 产出：符合条件的用户气泡上的 `Edit & resend`、无副作用的草稿、带 Cancel／Send 的横幅。

- [ ] **步骤 1：编写失败的 UI 测试**

在 spec 文件上添加 jsdom pragma。使用真实的 props 渲染 `UserMessageNodeView`／横幅。

```text
it('shows Edit & resend on a settled text user message with a ready preceding checkpoint', () => {
  renderUser({ seq: 4, content: [{ type: 'text', text: 'B' }], checkpointReady: true, running: false })
  expect(screen.getByRole('button', { name: 'Edit & resend' })).toBeTruthy()
})

it('hides the action for steering, in-flight, unsupported blocks, and missing checkpoints', () => {
  renderSteering()
  expect(screen.queryByRole('button', { name: 'Edit & resend' })).toBeNull()
})

it('Cancel leaves files and sessions untouched', async () => {
  const edit = vi.fn()
  enterDraft()
  await user.click(screen.getByRole('button', { name: /cancel/i }))
  expect(edit).not.toHaveBeenCalled()
  expect(screen.queryByRole('status', { name: /checkpoint/i })).toBeNull()
})

it('Send calls edit with the draft text and keeps original images off the wire as text-only', async () => {
  enterDraft()
  await user.type(composer, 'edited')
  await user.click(screen.getByRole('button', { name: /send/i }))
  expect(edit).toHaveBeenCalledWith({
    sessionId, messageSeq: 4, checkpointId: 'cp1', text: expect.stringContaining('edited'),
  })
})
```

`locales.ts` 中 `zh` 的中文文案（真源）：

- `message.editResend`：`编辑并重发`
- `message.editBanner`：`将从检查点 {label} 开始，并恢复 {count} 个文件`
- `message.editCancel`：`取消`
- `message.editSend`：`发送`
- `message.editPhase.preparing`：`正在准备`
- `message.editPhase.capturing-emergency`：`正在保存当前文件`
- `message.editPhase.restoring`：`正在恢复文件`
- `message.editPhase.creating-branch`：`正在创建分支`
- `message.editPhase.failed`：`{message}`
- `message.editUnavailable`：`没有可恢复的工作区检查点`
- `message.workspaceUnresumable`：`对话可查看，但工作区文件无法恢复`

English 字典镜像这些键。默认 UI 语言仍为中文。

- [ ] **步骤 2：运行 UI 测试，并确认它们失败**

运行：`pnpm exec vitest run packages/client/ui-conversation/tests/chat-view.client.spec.tsx packages/client/ui-conversation/tests/input-bar.client.spec.tsx --reporter=dot`

预期：由于控件缺失（2026-07-31 stub removal）而 FAIL。

- [ ] **步骤 3：实现草稿模式和横幅**

添加可选的 `onEdit` 到 `MessageIconActions`，使用 `IconEditOutline16`，与 copy 放在一起（分支保持在 assistant 尾部）。只有在以下条件都满足时，`UserMessageNodeView` 才传入 `onEdit`：

- `node.data.kind === 'user'`
- session 未运行
- 内容块只有 text／image
- 快照包含一个 ready 检查点，且其 `boundarySeq` 是前一个 turn end，或者第一条用户消息时为 `-1`

`onEdit` 通过 input machine 文档化的 draft-set 事件，将连接后的文本复制到现有 composer 草稿，并在 chat store 中存储 `{ messageSeq, checkpointId, fileCount, labelIndex, imageAttachmentIds }`。不调用 RPC。

当该 store 字段存在时，横幅挂载到 `conversation.composer.dock`（与 StatsLine 使用相同位置）。Cancel 清除 store 字段，并恢复进入编辑时保存的之前草稿字符串。Send 禁用 composer，显示 `operation.phase`，并调用 `runtime.edit`。失败时保持源会话选中，并显示 Host 错误消息；不要虚构子会话。

不要从原始事件中移除附件，以保留附件；Host 会重新复制图片块。composer 可以将现有图片显示为只读 chip。第一版不支持在编辑过程中添加／删除图片。

- [ ] **步骤 4：运行 UI 测试和 `pnpm run test:gui`**

运行：`pnpm run test:gui`

预期：受影响的 GUI 包 PASS。如果无关 GUI 测试失败，则停止并报告；不要削弱断言。

- [ ] **步骤 5：提交**

```bash
git add packages/client/ui-conversation
git commit -m "feat: add Edit & resend for settled conversation messages"
```

---

### 任务 10：Branch labels and unrestorable workspace state

**文件：**
- 修改：`packages/client/ui-workspace/src/client/rows/Rows.tsx` 和／或 lineage 展示
- 修改：`packages/client/ui-conversation`，按需为 transcript 添加 workspace-unresumable 横幅
- 创建：`packages/client/ui-workspace/tests/checkpoint-branch.client.spec.tsx`

**接口：**
- 消费：`parentSessionId`、检查点 `labelIndex`、`workspaceResumable`。
- 产出：显示检查点标签的分支行，并拒绝将不可恢复的工作区当作活动 cwd。

- [ ] **步骤 1：编写失败的测试**

```text
it('shows checkpoint labels on ordinary fork children without hiding the parent', () => {
  renderTree([parent, child])
  expect(screen.getByText('检查点 0')).toBeTruthy()
  expect(screen.getByText(parentTitle)).toBeTruthy()
})

it('keeps an unrestorable branch selectable for reading and shows a non-runnable workspace diagnostic', () => {
  renderTree([childUnavailable])
  expect(screen.getByText('对话可查看，但工作区文件无法恢复')).toBeTruthy()
})
```

面向用户的标签为 `检查点 {n}`／`Checkpoint {n}`，来自 `labelIndex`，绝不能使用不透明 id。

- [ ] **步骤 2：运行测试，并确认它们失败**

运行：`pnpm exec vitest run packages/client/ui-workspace/tests/checkpoint-branch.client.spec.tsx --reporter=dot`

预期：由于标签缺失而 FAIL。

- [ ] **步骤 3：实现标签和诊断**

普通 fork 子会话已经作为顶层工作区行出现（`tree.ts`）。不要隐藏父会话。从 runtime 快照添加作为次要文本的检查点标签。如果 `workspaceResumable === false`，禁用 composer send（现有 unavailable 占位模式）并显示诊断。仍可打开对话历史。

- [ ] **步骤 4：运行 workspace 和 conversation GUI 测试**

运行：`pnpm exec vitest run packages/client/ui-workspace/tests/checkpoint-branch.client.spec.tsx packages/client/ui-conversation/tests/chat-view.client.spec.tsx packages/client/ui-conversation/tests/input-bar.client.spec.tsx --reporter=dot`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/client/ui-workspace packages/client/ui-conversation
git commit -m "feat: show checkpoint branch labels and unrestorable workspace state"
```

---

### 任务 11：Invariants, subsystem docs, Agent Note

**文件：**
- 修改：`packages/session/workspace-checkpoint-local/src/invariant.ts`
- 修改：`packages/session/workspace-checkpoint-capture/src/invariant.ts`
- 修改：`packages/session/workspace-checkpoint-local/tests/store.spec.ts` 和 `lease.spec.ts`
- 创建：`docs/subsystems/workspace-checkpoint.md`（以及 `.zh.md`）
- 修改：`docs/subsystems/README.md` 和 `README.zh.md`
- 修改：`docs/architecture.md`，仅在 capability-seam map 中添加一行链接，不重写 loop
- 创建：`.agents/notes/proposed/feature/2026-08-19-conversation-edit-checkpoints.md` 以及 `.zh.md` 和 `.i18n.yaml`；在发布行为的同一 PR 中移到 `implemented/`
- 修改：`packages/host/apiproxy/README.md` 配对文件，记录新的 RPC

**接口：**
- 消费：检查点记录、会话索引、操作视图、子会话发布结果。
- 产出：runtime 不变量检查和当前状态文档。

- [ ] **步骤 1：编写失败的不变量测试**

```text
it('rejects an applied checkpoint whose blobs are gone unless recoveryRequired is set', async () => {
  await deleteBlobs(appliedId)
  await expect(runInvariants(ctx)).rejects.toMatchObject({ message: expect.stringContaining('applied') })
})

it('rejects a ready operation that published no child after a failed edit', async () => {
  emitOperation({ phase: 'ready', childSessionId: undefined, sourceSessionId })
})
```

- [ ] **步骤 2：运行不变量测试，并确认检查仍为空时它们失败**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/store.spec.ts packages/session/workspace-checkpoint-local/tests/lease.spec.ts --reporter=dot`

预期：由于缺少关系而 FAIL。

- [ ] **步骤 3：实现检查和文档**

不变量（本地 Provider）：

- 每个 `parentCheckpointId` 都存在于 `checkpoints` 中
- `appliedCheckpointId` 具备恢复资格，或已设置 `recoveryRequired`
- 被引用时，`emergencyCheckpointId` 必须存在
- 终止操作阶段 `ready`／`failed` 不得转移到 `preparing`
- `ready` 只有在该 session 存在于 `ctx.sessions` 或持久化数据中时，才能带有新的 child id

Capture 配套项：`No runtime invariant: capture is fail-soft; unavailable records are the durable relation the provider already checks.`

Agent Note（发布前位于 `proposed/`，发布时移到 `implemented/`）：Problem / Proposal-or-Decision / Alternatives considered（复制 spec 的五项拒绝）/ Acceptance criteria 或 Consequences。说明恢复仅针对工作区文件。交叉链接 `.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md`，作为本功能满足的重新引入项。

子系统页面：将共享接口中的类型作为 `ts` 类型等价代码块，并加入生成的 Cordis API。持久化页面：用一句话说明 session-checkpoint-policy 仍然只 flush 日志而不捕获文件，并链接到这里。

- [ ] **步骤 4：运行不变量测试和覆盖新文件的文档门禁**

运行：`pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/store.spec.ts packages/session/workspace-checkpoint-local/tests/lease.spec.ts --reporter=dot`

然后运行 pre-push skill 会为该 diff 选择的较窄 `verify-md-links`／`verify-agent-note-format`／`verify-export-jsdoc` 命令。

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add packages/session/workspace-checkpoint-local packages/session/workspace-checkpoint-capture docs/subsystems docs/architecture.md .agents/notes
git commit -m "docs: record workspace-checkpoint invariants and current-state contracts"
```

---

### 任务 12：Keyless assembled Web replay

**文件：**
- 创建：`apps/web/tests/conversation-edit-checkpoints.e2e.ts`
- 创建：`apps/web/tests/snapshots/conversation-edit-checkpoints/ui.expected.md`
- 创建：`apps/web/tests/snapshots/conversation-edit-checkpoints/child.expected.md`
- 修改：`tsconfig.host.json` 中新 e2e 文件的 include 列表
- 修改：仅当 IconActions golden 现在包含用户气泡上的 Edit & resend 时修改 `apps/web/tests/message-actions.e2e.ts`

**接口：**
- 消费：`launchWebScaffold`、`seedSession`、通过真实浏览器调用的 Host edit RPC。
- 产出：覆盖编辑、文件恢复、子分支和新 transcript 的无密钥回放。

- [ ] **步骤 1：编写失败的 e2e**

遵循 `produced-files.e2e.ts` + `message-actions.e2e.ts`：

1. `launchWebScaffold`
2. 写入 `workspace/note.txt` = `before`
3. 创建一个已关闭的两回合会话，第一回合的用户消息为 "first"，第二回合为 "second"
4. seed 后写入 `workspace/note.txt` = `after-second`
5. 在真实浏览器中打开会话（默认中文页面；断言中文字符串）
6. 点击第二条用户消息上的 `编辑并重发`
7. 将 composer 文本改为 `edited second`
8. 点击 Send
9. 断言 `note.txt` 为 `before`
10. 断言可见 transcript 包含 `edited second`，且不包含原始的 `second` assistant 尾部
11. 断言父会话仍在列表中
12. 对子会话 aria 执行 `compareOrRefreshGolden`

零模型调用：使用 `Session.append` 构建 seed，如同 `produced-files.e2e.ts`。优先使用无需实时 Provider 即可让子会话用户消息结算的 fixture。如果 admission 会调度模型调用，则注册 seed 测试旁边使用的同一个无密钥 stub adapter，并断言已接纳的用户消息以及恢复后的文件。

- [ ] **步骤 2：在 replay 模式运行 e2e，并确认它失败**

运行：`$env:DSH_SNAPSHOT='replay'; pnpm exec vitest run apps/web/tests/conversation-edit-checkpoints.e2e.ts --reporter=dot`

预期：由于组装应用中缺少 Edit 控件或恢复路径，或者 golden 尚不存在，而 FAIL。

- [ ] **步骤 3：实现 e2e 暴露的剩余接线**

只修复回放证明存在的产品缺口。不要削弱文件内容断言。

- [ ] **步骤 4：行为正确后才刷新 goldens，然后回放**

运行：`$env:DSH_SNAPSHOT='refresh'; pnpm exec vitest run apps/web/tests/conversation-edit-checkpoints.e2e.ts --reporter=dot`

然后运行：`$env:DSH_SNAPSHOT='replay'; pnpm exec vitest run apps/web/tests/conversation-edit-checkpoints.e2e.ts --reporter=dot`

此外，如果用户气泡操作发生变化，运行：`$env:DSH_SNAPSHOT='replay'; pnpm exec vitest run apps/web/tests/message-actions.e2e.ts --reporter=dot`。

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add apps/web/tests/conversation-edit-checkpoints.e2e.ts apps/web/tests/snapshots/conversation-edit-checkpoints tsconfig.host.json
git commit -m "test: replay conversation edit restore and child branch creation"
```

---

## 自检

| 规格要求 | 任务 |
|---|---|
| 初始检查点和每回合检查点 | 6 |
| 将每条直接用户消息与前一个检查点关联 | 7、9 |
| 发送时恢复 | 4、7 |
| 不带被丢弃的后代创建子分支 | 7 |
| 保留原会话及其检查点 | 7 |
| 发送前取消无副作用 | 9 |
| 失败后仍可恢复恢复／分支；紧急快照 | 4、5、7 |
| 编辑文本、保留附件、禁用不支持的块 | 7、9 |
| 独立于 Git 的有界持久化存储 | 3、5 |
| 不使用 Git、不改写日志、不修改 agent-loop、不提供面向模型的工具 | 全局约束 |
| manifest／restore 竞争、配额、租约的单元测试 | 2–5 |
| Loader 组合捕获 | 6 |
| Host／client 测试 | 7–10 |
| 无密钥 Web 回放 | 12 |
| runtime 不变量 | 5、11 |
| 在 UI 中明确工作区文件专属保证 | 9、11 |
| 对话分支与工作区可恢复性 | 8、10 |
| 第一条消息编辑使用 `Checkpoint 0` | 6、7 |

占位符扫描：没有 TBD/TODO 步骤。`CheckpointId`、`session.edit`、`session.activate`、`session/checkpoints`、`WorkspaceCheckpoint.capture/restore/acquireLease` 在各任务中使用一致。

不要实现：Git 提交、删除父会话、改写日志、恢复 cwd 之外的文件、撤销外部副作用、为作业／工作流做检查点、Trajectory 检查点编辑器，或面向模型的检查点工具。
