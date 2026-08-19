# Conversation Edit Checkpoints Implementation Plan

English | [中文](2026-08-19-conversation-edit-checkpoints.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Web user edit a settled direct user message and continue from the workspace files that existed immediately before that message, as a new child branch, while the original session and its checkpoints stay recoverable.

**Architecture:** Add a workspace-checkpoint capability seam (Service Definition, local Harness-home provider, turn-capture consumer). Host `session.edit` restores through a journaled transaction, then creates the child with the existing `ctx.agents.create` seed path and admits the edited prompt. The browser runtime owns checkpoint and operation snapshots; `ui-conversation` owns draft mode and the `Edit & resend` affordance. Do not change `agent-loop`. Do not add Git refs or rewrite the session log.

**Tech Stack:** TypeScript, Vitest, Cordis, `storage-domain`, `dsh-home-paths`, `dsh-atomic-write`, Host API Proxy RPC + mux frames, client snapshot stores, Playwright Web replay.

**Spec:** `docs/superpowers/specs/2026-08-19-conversation-edit-checkpoints-design.md`

This is one user-facing feature. Keep it as one plan. Ship it as three sequential PRs if review wants a smaller gate: Tasks 1–6 (capture/restore), Tasks 7–8 (Host + runtime), Tasks 9–12 (UI, docs, assembled replay). Each PR must still be independently testable.

## Global Constraints

- Do not change `packages/core/agent-loop`. Edit behavior belongs in the checkpoint seam, Host command, and client plugins.
- Checkpoint metadata is not a `SessionEvent` and must not enter the system prompt or derived model history.
- The session log stays append-only. The child inherits an event prefix through existing fork/seed APIs; the parent log is never truncated.
- `session.edit` fork boundary is the completed `turn/end` strictly before the selected `user/message`. This is not `session.fork`'s "first `turn/end` at or after `atSeq`" rule.
- Editing the first message creates an empty-seed child with `parentSession` set and restores `Checkpoint 0` (`boundarySeq: -1`).
- Cancel before Send mutates no checkpoint, file, or session state.
- Capture is fail-soft for ordinary model work. Restore/commit is fail-closed with journal rollback. A rollback failure marks the workspace recovery-required and blocks new model work.
- Restore claims workspace-file restoration only. Do not imply that network, database, terminal, or ignored-external effects were undone.
- Opaque ids are branded (`CheckpointId`). Regular file bytes live in a content-addressed object store under Harness home; metadata lives in storage-domain `workspace_checkpoint`.
- The provider does not follow symlinks. A checkpoint with unsafe or unsupported entries is not eligible for automatic restore.
- Retention and exclusions are plugin `Config` fields restated in `cordis.yml`; do not add `DEFAULT_*` constants as a substitute for configurability.
- Name the new seam `workspace-checkpoint` so it does not collide with `@deepseek-ai/dsh-session-checkpoint-policy` (session-log flush).
- Compose the family in `packages/bundle/web-app` (storage-domain already lives there). Do not add it to `dsh-base` in this change.
- Product copy is Chinese; code comments are English. Use TDD. Update README pairs, subsystem docs, and the Agent Note in the same change as the behavior.
- Windows is a first-class test target: manifest paths use `/` separators; symlink cases skip on `EPERM`.

---

## File Map

- Create: `packages/session/workspace-checkpoint/` — Service Definition `ctx.workspaceCheckpoint`, branded ids, record types, domain spec, typed errors.
- Create: `packages/session/workspace-checkpoint-local/` — Harness-home object store, manifest capture, journaled restore, lease, retention.
- Create: `packages/session/workspace-checkpoint-capture/` — initial + per-`turn/end` capture, recovery-required guard on prompt/tool dispatch.
- Modify: `packages/session/README.md` and `README.zh.md` — add the workspace-checkpoint family beside persistence.
- Modify: `packages/host/apiproxy/src/api/sessions.ts` — add `edit` and `activate`.
- Modify: `packages/host/apiproxy/src/api/sessions.schema.ts` — request/response schemas.
- Modify: `packages/host/apiproxy/src/api/rpc-map.ts` — register `session.edit` and `session.activate`.
- Modify: `packages/host/apiproxy/src/api/events.ts` — add `session/checkpoints` mux frame.
- Modify: `packages/host/apiproxy/src/fetch/handler.ts` and `src/fetch/client.ts` — wire the new RPCs.
- Modify: `packages/host/apiproxy/src/api-proxy.ts` — implement edit transaction, activate restore, emit checkpoint snapshots.
- Modify: `packages/client/runtime/src/client/sessions/` — checkpoint/operation snapshots, `edit`/`activate` methods, select-time activate.
- Modify: `packages/client/ui-conversation/src/client/` — `Edit & resend`, draft banner, locales, MessageIconActions.
- Modify: `packages/bundle/web-app/cordis.patch.yml` and `package.json` — mount provider + capture.
- Modify: `tsconfig.host.json` — project references for the three new packages and the new web e2e file.
- Create: `apps/web/tests/conversation-edit-checkpoints.e2e.ts` plus `apps/web/tests/snapshots/conversation-edit-checkpoints/`.
- Create: `docs/subsystems/workspace-checkpoint.md` and register it in `docs/subsystems/README.md`.
- Create: `.agents/notes/proposed/feature/2026-08-19-conversation-edit-checkpoints.md` during implementation, then move it to `implemented/` when the behavior ships.
- Review only: `packages/core/session/src/index.ts` (`fork`), `packages/session/session-checkpoint-policy/` (log flush), `packages/core/agent-loop/` (do not edit).

## Shared interfaces

Later tasks consume these names exactly. Do not rename them in a later task.

```ts
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

```ts
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
```

Mux frame (complete replacement snapshot, same posture as `session/jobs`):

```ts
| {
  type: 'session/checkpoints'
  sessionId: SessionId
  checkpoints: CheckpointView[]
  appliedCheckpointId?: CheckpointId
  operation?: CheckpointOperationView
  recoveryRequired?: string
}
```

Editable message rule used by Host and UI:

- `event.type === 'user/message'`
- `event.data.source.kind === 'user'`
- the owning turn has a `turn/end`
- every content block is `type: 'text'` or `type: 'image'`
- at least one `text` block exists

Image blocks are preserved on Send. The client sends only `text`; Host copies the original image blocks from the source event.

---

### Task 1: WorkspaceCheckpoint Service Definition

**Files:**
- Create: `packages/session/workspace-checkpoint/package.json`
- Create: `packages/session/workspace-checkpoint/tsconfig.json`
- Create: `packages/session/workspace-checkpoint/src/index.ts`
- Create: `packages/session/workspace-checkpoint/src/types.ts`
- Create: `packages/session/workspace-checkpoint/src/spec.ts`
- Create: `packages/session/workspace-checkpoint/src/error.ts`
- Create: `packages/session/workspace-checkpoint/src/invariant.ts`
- Create: `packages/session/workspace-checkpoint/README.md`
- Create: `packages/session/workspace-checkpoint/README.zh.md`
- Create: `packages/session/workspace-checkpoint/tests/spec.spec.ts`
- Modify: `tsconfig.host.json` — add `{ "path": "./packages/session/workspace-checkpoint" }` after `session-stats`

**Interfaces:**
- Consumes: `dsh-brand`, `dsh-session/types`, `dsh-storage-domain` `defineDomain`/`domainTable`, Cordis `Service`.
- Produces: `CheckpointId`, `WorkspaceCheckpoint`, `workspaceCheckpointDomainSpec`, `WorkspaceCheckpointError`, `ctx.workspaceCheckpoint`.

- [ ] **Step 1: Write the failing domain-spec tests**

```ts
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

- [ ] **Step 2: Run the test and verify it fails because the package does not exist**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint/tests/spec.spec.ts --reporter=dot`

Expected: FAIL with a module-not-found error for `../src/spec.ts`.

- [ ] **Step 3: Create the package skeleton and the Service Definition**

`package.json` name `@deepseek-ai/dsh-workspace-checkpoint`, version `0.1.0-rc.7`, `private: true`, ESM exports for `.` and `./invariant`, peer+dev `@deepseek-ai/cordis`, peers for `dsh-session`, `dsh-storage-domain`, `dsh-brand`, `dsh-invariants`. `files` is exactly `lib/index.js`, `lib/invariant.js`, `lib/types/**/*.d.ts`.

`tsconfig.json` extends `../../../tsconfig.base.json`, `rootDir: src`, `outDir: lib/types`, references cosmokit, cordis, schemastery, `../../util/brand`, `../../core/session`, `../../storage/storage-domain`, `../../runtime-diagnostics/invariants`.

`src/types.ts` holds only the types from Shared interfaces (no runtime besides `CheckpointId()`).

`src/error.ts` holds `WorkspaceCheckpointError`.

`src/spec.ts`:

```ts
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

`src/index.ts` default-exports this class:

```ts
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

Declaration-merge `ctx.workspaceCheckpoint: WorkspaceCheckpoint`.

README Model Experience: the package adds no prompt, tool schema, or tokens. Known Limitations: metadata is not a session event; restore covers session cwd files only.

Invariant companion: `No runtime invariant: the definition owns no mutable store; the local provider and capture consumer register the executable checks.`

- [ ] **Step 4: Run the spec test**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint/tests/spec.spec.ts --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint tsconfig.host.json
git commit -m "feat: add workspace-checkpoint service definition"
```

---

### Task 2: Manifest capture

**Files:**
- Create: `packages/session/workspace-checkpoint-local/package.json`
- Create: `packages/session/workspace-checkpoint-local/tsconfig.json`
- Create: `packages/session/workspace-checkpoint-local/src/manifest.ts`
- Create: `packages/session/workspace-checkpoint-local/src/hash.ts`
- Create: `packages/session/workspace-checkpoint-local/src/paths.ts`
- Create: `packages/session/workspace-checkpoint-local/tests/manifest.spec.ts`
- Create: `packages/session/workspace-checkpoint-local/src/invariant.ts` (empty reason until Task 5)
- Modify: `tsconfig.host.json` — add `{ "path": "./packages/session/workspace-checkpoint-local" }`

**Interfaces:**
- Consumes: cwd + `excludeGlobs`, Node `fs/promises` + `lstat`.
- Produces: `buildManifest(cwd, options): Promise<CheckpointManifest>` and `hashFile`.

- [ ] **Step 1: Write the failing manifest tests**

Create a temp directory in `beforeEach`. Cover these cases in `packages/session/workspace-checkpoint-local/tests/manifest.spec.ts`:

```ts
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

Helper `entry(manifest, path)` finds `relativePath === path`. Manifest relative paths must use `/` even on Windows.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/manifest.spec.ts --reporter=dot`

Expected: FAIL because `buildManifest` is not defined.

- [ ] **Step 3: Implement capture**

`src/paths.ts`:

- `toManifestPath(cwd, absolutePath)` → slash-separated relative path.
- `fromManifestPath(cwd, relativePath)` → platform path; reject `..` and absolute segments with `CHECKPOINT_CONTAINMENT`.
- Canonicalize `cwd` through `realpath` before walking.

`src/hash.ts`: SHA-256 hex via `createHash('sha256')` streaming the file.

`src/manifest.ts` `buildManifest(cwd, { excludeGlobs })`:

1. Realpath the cwd; throw `CHECKPOINT_CONTAINMENT` if it is not a directory.
2. Walk with `readdir` + `lstat` (never `stat`).
3. Skip names matching `excludeGlobs` (`path.matchesGlob` on Node 22).
4. Files: size, optional mode, hash, `restoreSafe: true`.
5. Directories: `restoreSafe: true`, no hash.
6. Symlinks: store the link text, `restoreSafe` iff the resolved target stays inside cwd.
7. Sort entries by `relativePath`.
8. `manifest.hash` is SHA-256 of the canonical JSON of entries.

If `lstat` size/mtime changes between the pre-hash stat and post-hash stat, throw `CHECKPOINT_CONCURRENT_WRITE`.

- [ ] **Step 4: Run the manifest tests**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/manifest.spec.ts --reporter=dot`

Expected: PASS. Symlink-permission skips must not fail the file.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint-local tsconfig.host.json
git commit -m "feat: capture workspace checkpoint manifests without following symlinks"
```

---

### Task 3: Object store and metadata domain

**Files:**
- Create: `packages/session/workspace-checkpoint-local/src/objects.ts`
- Create: `packages/session/workspace-checkpoint-local/src/store.ts`
- Create: `packages/session/workspace-checkpoint-local/src/index.ts`
- Create: `packages/session/workspace-checkpoint-local/src/config.ts`
- Create: `packages/session/workspace-checkpoint-local/tests/store.spec.ts`
- Create: `packages/session/workspace-checkpoint-local/README.md` and `README.zh.md`

**Interfaces:**
- Consumes: `workspaceCheckpointDomainSpec`, `buildManifest`, `dshHomePath`, `ctx.storageDomain`.
- Produces: `LocalWorkspaceCheckpoint.capture`, `inspect`, and `list`.

- [ ] **Step 1: Write the failing store tests**

Boot a small Cordis app with `storage`, `storage-json` (`root` = temp), `storage-domain` (`backend: 'json'`), and the local provider (`objectRoot` = temp, `maxTotalBytes: 1024 * 1024`, `excludeGlobs: []`, `captureRetryCount: 2`, `captureRetryDelayMs: 10`).

```ts
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

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/store.spec.ts --reporter=dot`

Expected: FAIL because `LocalWorkspaceCheckpoint` is not registered.

- [ ] **Step 3: Implement the local provider capture path**

Config (schemastery, all required except `objectRoot` / `dshHome`):

```ts
export interface Config {
  objectRoot?: string
  dshHome?: string
  maxTotalBytes: number
  excludeGlobs: string[]
  captureRetryCount: number
  captureRetryDelayMs: number
}
```

Object layout: `{objectRoot}/objects/{hash[0:2]}/{hash}` using `writeFileAtomic` mode `0o600`, directories `0o700`. Default `objectRoot` is `dshHomePath('workspace-checkpoints')` after `resolveDshHome(config.dshHome)`.

`capture`:

1. Open domain `workspace_checkpoint` in `ctx.effect` on apply; the caller of `open` owns close.
2. Retry `buildManifest` up to `captureRetryCount` on `CHECKPOINT_CONCURRENT_WRITE`; if still racing, persist `status: { kind: 'unavailable', reason: 'concurrent-write' }` and `restoreEligible: false`.
3. If any entry has `restoreSafe === false`, persist unavailable/`restoreEligible: false` without writing blobs for unsafe targets.
4. Copy each regular file into the object store; identical hash is a no-op.
5. If adding blobs would exceed `maxTotalBytes`, persist unavailable `CHECKPOINT_QUOTA_EXHAUSTED` without deleting older checkpoints (eviction is Task 5).
6. Assign `labelIndex` as the count of `role !== 'emergency'` checkpoints already stored for that `sessionId`.
7. Write `checkpoints[id]` and append the id on `sessions[sessionId].checkpointIds`.

`inspect` throws `CHECKPOINT_NOT_FOUND` when missing. `list` returns `CheckpointView[]` in label order, excluding blob internals.

- [ ] **Step 4: Run store tests**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/store.spec.ts --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint-local
git commit -m "feat: persist workspace checkpoints in a content-addressed store"
```

---

### Task 4: Journaled restore

**Files:**
- Create: `packages/session/workspace-checkpoint-local/src/restore.ts`
- Create: `packages/session/workspace-checkpoint-local/src/journal.ts`
- Modify: `packages/session/workspace-checkpoint-local/src/index.ts` — implement `restore`
- Create: `packages/session/workspace-checkpoint-local/tests/restore.spec.ts`

**Interfaces:**
- Consumes: `RestoreRequest`, durable manifest + blobs.
- Produces: `restore` that makes cwd match the manifest or rolls back.

- [ ] **Step 1: Write the failing restore tests**

```ts
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

Export a test-only `restoreInternals` object from `src/restore.ts` (assignable `rename`, defaulting to `fs.rename`) so mid-commit failures are injectable.

- [ ] **Step 2: Run restore tests and verify they fail**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/restore.spec.ts --reporter=dot`

Expected: FAIL because `restore` is unimplemented.

- [ ] **Step 3: Implement staging, verification, journal, and rollback**

1. Refuse `status.kind !== 'ready'` or `restoreEligible === false` with `CHECKPOINT_UNAVAILABLE`.
2. Take the per-workspace lease (Task 5; until then, an in-process Map of promise chains keyed by canonical cwd).
3. Read every blob; verify SHA-256; throw `CHECKPOINT_HASH_MISMATCH` before any cwd mutation.
4. Stage the complete tree under `{objectRoot}/staging/{checkpointId}/`.
5. Write a journal `{objectRoot}/journals/{workspaceHash}.json` listing planned deletes, writes, mkdirs, symlink creates, and backups of replaced paths under `{objectRoot}/journals/{id}/backup/`.
6. Apply the journal. After the first cwd mutation, ignore `signal` abort except to finish or roll back.
7. On success, delete the journal and staging dir, `clearRecoveryRequired`.
8. On failure, replay the backup. If replay throws, `markRecoveryRequired` and rethrow.
9. Never follow symlinks when deleting or replacing. Refuse any journal path that fails `fromManifestPath` containment.

Untracked files that are not in the target manifest are deleted so the tree matches the checkpoint.

- [ ] **Step 4: Run restore tests**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/restore.spec.ts --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint-local
git commit -m "feat: restore workspace checkpoints through a rollback journal"
```

---

### Task 5: Lease, emergency snapshots, retention

**Files:**
- Create: `packages/session/workspace-checkpoint-local/src/lease.ts`
- Create: `packages/session/workspace-checkpoint-local/src/retention.ts`
- Modify: `packages/session/workspace-checkpoint-local/src/index.ts`
- Modify: `packages/session/workspace-checkpoint-local/src/invariant.ts`
- Create: `packages/session/workspace-checkpoint-local/tests/lease.spec.ts`
- Create: `packages/session/workspace-checkpoint-local/tests/retention.spec.ts`

**Interfaces:**
- Consumes: `acquireLease`, `CaptureRequest.role === 'emergency'`, `maxTotalBytes`.
- Produces: exclusive in-process workspace lease, emergency checkpoint records, eviction that never silently drops an active branch's blobs.

- [ ] **Step 1: Write the failing lease and retention tests**

```ts
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

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/lease.spec.ts packages/session/workspace-checkpoint-local/tests/retention.spec.ts --reporter=dot`

Expected: FAIL on missing lease exclusion or eviction deleting the applied checkpoint.

- [ ] **Step 3: Implement lease and retention**

Lease: in-process Map from canonical workspace key to the holding token.

- `acquireLease` for Host edit: throw `CHECKPOINT_LEASE_HELD` if held (the RPC must not hang without progress).
- Internal `withLease(key, fn)` for capture/restore: FIFO chain.

Retention: sort evictable checkpoints by `createdAt` ascending. Never evict:

- the `appliedCheckpointId` for any session whose `workspaceKey` matches
- that session's `emergencyCheckpointId`
- a checkpoint listed as `parentCheckpointId` of a retained record if dropping it would orphan the applied chain

When a checkpoint must go, delete unreferenced blobs, set `restoreEligible: false` and `status: { kind: 'unavailable', reason: 'evicted' }`, and keep the metadata row so the UI can show the diagnostic relationship.

Emit `workspace-checkpoint/changed` after durable commits. Invariant: every `appliedCheckpointId` either inspects as `restoreEligible: true` or the session index has `recoveryRequired` set.

```ts
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

Add `abstract evict(): Promise<void>` on `WorkspaceCheckpoint` in Task 1 if it is not already there; if Task 1 already shipped without it, add the method in this task and update the definition package.

- [ ] **Step 4: Run lease, retention, manifest, store, and restore tests**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint-local packages/session/workspace-checkpoint
git commit -m "feat: lease workspace restores and bound checkpoint retention"
```

---

### Task 6: Turn capture consumer and recovery guard

**Files:**
- Create: `packages/session/workspace-checkpoint-capture/` (full package skeleton matching Task 1)
- Create: `packages/session/workspace-checkpoint-capture/src/index.ts`
- Create: `packages/session/workspace-checkpoint-capture/src/invariant.ts`
- Create: `packages/session/workspace-checkpoint-capture/tests/capture.spec.ts`
- Create: `packages/session/workspace-checkpoint-capture/tests/guard.spec.ts`
- Create: `packages/session/workspace-checkpoint-capture/README.md` and `README.zh.md`
- Modify: `tsconfig.host.json`
- Modify: `packages/bundle/web-app/cordis.patch.yml` and `packages/bundle/web-app/package.json`
- Modify: `packages/session/README.md` and `README.zh.md`

**Interfaces:**
- Consumes: `ctx.workspaceCheckpoint`, `ctx.sessions`, `session/created`, `turn/end`, `ctx.sessions.flush`, `ctx.llm` / `ctx.tools` waterfalls.
- Produces: Checkpoint 0 at workspace obtain, one checkpoint after every settled turn, prompt/tool block while recovery-required.

- [ ] **Step 1: Write the failing capture and guard tests**

Use a real Loader composition: `session`, persistence-jsonl in temp, storage-json + storage-domain, workspace-checkpoint-local, this consumer, a stub llm/tools.

```ts
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

Map turn reasons: `completed` → `completed`; `error`/`max-tokens`/`blocked` → `failed`; `aborted` → `cancelled`; `interrupted` → `interrupted`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-capture/tests --reporter=dot`

Expected: FAIL because the consumer is not loaded or does not listen.

- [ ] **Step 3: Implement the consumer**

Function plugin `name: 'workspace-checkpoint-capture'`, `inject: ['workspaceCheckpoint', 'sessions', 'llm', 'tools']`.

On `session/created`, if `header.cwd` is present, `capture` with `boundarySeq: -1`, `role: 'initial'`. Do not block session creation: schedule the work on the session fiber. Capture errors become unavailable records, never thrown into session create.

On `session/event` where `type === 'turn/end'`:

1. `await ctx.sessions.flush(session)`
2. `withLease` + `capture` with `boundarySeq: event.seq`, `role: 'turn'`, parent = latest ready non-emergency checkpoint for that session
3. Capture failure → unavailable record, never throw into the agent loop

Guard: wrap `llm/stream` and top-level `tools/execute` like session-checkpoint-policy. If `recoveryRequired(cwd)` is set, do not call `next()`. Nested tools reuse the outer check.

Compose in `packages/bundle/web-app/cordis.patch.yml` near storage-domain:

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

Add both packages to `packages/bundle/web-app/package.json` dependencies. The definition package is a dependency of the local provider; do not add a separate cordis row for the abstract Service.

- [ ] **Step 4: Run capture tests**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-capture/tests packages/session/workspace-checkpoint-local/tests --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint-capture packages/session/README.md packages/session/README.zh.md packages/bundle/web-app tsconfig.host.json
git commit -m "feat: capture workspace checkpoints at session start and turn end"
```

---

### Task 7: Host `session.edit` and `session.activate`

**Files:**
- Modify: `packages/host/apiproxy/src/api/sessions.ts`
- Modify: `packages/host/apiproxy/src/api/sessions.schema.ts`
- Modify: `packages/host/apiproxy/src/api/rpc-map.ts`
- Modify: `packages/host/apiproxy/src/api/events.ts`
- Modify: `packages/host/apiproxy/src/fetch/handler.ts`
- Modify: `packages/host/apiproxy/src/fetch/client.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Create: `packages/host/apiproxy/tests/api-proxy-edit.spec.ts`
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts`
- Modify: `packages/host/apiproxy/README.md` and `README.zh.md`

**Interfaces:**
- Consumes: `WorkspaceCheckpoint`, `ctx.agents.create`, existing `readSessionState` / `composeAgent` / `forkWorkspace` / `session.prompt` admission.
- Produces: `session.edit`, `session.activate`, `session/checkpoints` mux snapshots, operation phases.

- [ ] **Step 1: Write the failing Host tests**

Mount the local provider with a temp cwd. Seed a two-turn parent: user message A, assistant, user message B. Mutate a file after turn 1.

```ts
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

Also add schema cases in `rpc-schemas.spec.ts` for `sessionEditRequestSchema` (non-empty text, integer `messageSeq`, branded ids) and the optional `session/checkpoints` frame fields.

Operation progress: assert mux frames walk `preparing` → `capturing-emergency` → `restoring` → `creating-branch` → `ready`, and that a failure frame uses `failed` without a child id.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-edit.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

Expected: FAIL because `session.edit` is not on the RPC map.

- [ ] **Step 3: Implement the Host command**

RPC error codes: `edit-not-editable`, `checkpoint-unavailable`, `agent-busy`, `checkpoint-recovery-required`, plus existing `session-not-found` / `internal`.

`session.edit` algorithm:

1. Read source via existing `readSessionState`. Reject missing session.
2. If the attached agent is running, `agent-busy`.
3. If `recoveryRequired(cwd)`, `checkpoint-recovery-required`.
4. Locate `user/message` at `messageSeq`. Apply the editable-message rule. Collect original image blocks.
5. Verify `checkpointId` belongs to this `sessionId` (or a parent in the same workspaceKey lineage), `restoreEligible`, and `boundarySeq` is `-1` or the last `turn/end` strictly before `messageSeq`.
6. Emit operation `preparing`.
7. `capture` emergency checkpoint of current files (`role: 'emergency'`). Phase `capturing-emergency`.
8. `acquireLease`. Phase `restoring`. `restore({ checkpointId, cwd })`.
9. Compute seed: prefix through the `turn/end` with `seq === checkpoint.boundarySeq`, then extend through standalone events until the next `turn/start` exactly as `session.fork` does. If `boundarySeq === -1`, seed is `[]` and `seedLength` is `0`.
10. Phase `creating-branch`. `ctx.agents.create` with `parentSession`, `cwd`, `seedLength`, source composition — copy the `session.fork` create call. Attach to the same workspace.
11. Admit the edited user message through the same durable admission path as `session.prompt` (`mode: 'queue'`, `content: [{ type: 'text', text }, ...preservedImages]`). Do not send the original message text.
12. Record sidecar fields on the session checkpoint index: source session, source boundary, selected checkpoint, emergency checkpoint, child session id.
13. Publish `session/checkpoints` for source and child. Phase `ready`. Return `{ sessionId: childId }`.
14. On failure before child publication: restore emergency checkpoint (or journal rollback already on the failed restore), release lease, keep source selected, phase `failed`.
15. On failure after publication: leave the child (failed branch), do not mutate the parent log, phase `ready` or `failed` on the child only.

`session.activate`:

1. Idle agent required.
2. Latest usable non-emergency checkpoint for that session. If none, `{ restored: false }`.
3. If already `appliedCheckpointId`, `{ restored: false }` without a second restore.
4. Emergency capture, restore, update applied id. If the latest is not restore-eligible, `{ restored: false, unavailable: true }` and do not mutate files.

Emit `session/checkpoints` on mux subscribe (baseline) and on `workspace-checkpoint/changed`.

Do not reuse `session.fork` for the cut: its `atSeq` includes the selected message's turn.

- [ ] **Step 4: Run Host tests including existing fork tests**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-edit.spec.ts packages/host/apiproxy/tests/api-proxy-fork.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

Expected: PASS. Existing fork behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/host/apiproxy
git commit -m "feat: add session.edit restore-and-branch Host command"
```

---

### Task 8: Browser runtime snapshots

**Files:**
- Modify: `packages/client/runtime/src/client/sessions/session.ts`
- Modify: `packages/client/runtime/src/client/sessions/service.ts`
- Modify: `packages/client/runtime/src/client/sessions/manager.ts`
- Create: `packages/client/runtime/src/client/sessions/checkpoints.ts`
- Create: `packages/client/runtime/tests/checkpoints.client.spec.ts`

**Interfaces:**
- Consumes: `session/checkpoints` mux frames, `session.edit`, `session.activate`.
- Produces: immutable `CheckpointSnapshot` on the session object, `sessions.edit`, select-time `activate`.

- [ ] **Step 1: Write the failing runtime tests**

```ts
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

`workspaceResumable` is `true` iff the latest non-emergency checkpoint is `restoreEligible`. Conversation remains listed even when this is false.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/client/runtime/tests/checkpoints.client.spec.ts --reporter=dot`

Expected: FAIL because `edit` / checkpoint snapshot fields do not exist.

- [ ] **Step 3: Implement runtime wiring**

Store checkpoints on `Session` as a plain snapshot field, not a UI store. Handle `session/checkpoints` next to `session/jobs`.

`SessionRuntime.edit` calls the unary RPC, then `select(childId)` on success.

`SessionManager.select` already notifies immediately. After setting `selected`, call `session.activate({ sessionId })` without blocking the first paint: keep the previous files until the RPC returns, then the mux snapshot updates. If `unavailable: true`, set a session diagnostic flag; do not hide the transcript.

Do not persist checkpoint blobs in `localStorage`.

- [ ] **Step 4: Run runtime checkpoint tests plus lineage tests**

Run: `pnpm exec vitest run packages/client/runtime/tests/checkpoints.client.spec.ts packages/client/runtime/tests/lineage.client.spec.ts --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/runtime
git commit -m "feat: project workspace checkpoint snapshots in the browser runtime"
```

---

### Task 9: Conversation edit affordance and banner

**Files:**
- Modify: `packages/client/ui-conversation/src/client/chat/MessageIconActions.tsx`
- Modify: `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`
- Create: `packages/client/ui-conversation/src/client/chat/EditResendBanner.tsx`
- Modify: `packages/client/ui-conversation/src/client/stores.ts`
- Modify: `packages/client/ui-conversation/src/client/locales.ts`
- Modify: `packages/client/ui-conversation/src/client/input/` only to load text + preserved image ids into the existing composer
- Create: `packages/client/ui-conversation/tests/edit-resend.client.spec.tsx`
- Modify: `packages/client/ui-conversation/README.md` and `README.zh.md` — remove the "no edit on settled messages" limitation

**Interfaces:**
- Consumes: `UserMessageNode`, checkpoint snapshot, `runtime.edit`, existing InputMachine draft.
- Produces: `Edit & resend` on eligible user bubbles, side-effect-free draft, banner with Cancel/Send.

- [ ] **Step 1: Write the failing UI tests**

jsdom pragma on the spec file. Render `UserMessageNodeView` / banner with realistic props.

```ts
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

Chinese copy in `locales.ts` `zh` (source of truth):

- `message.editResend`: `编辑并重发`
- `message.editBanner`: `将从检查点 {label} 开始，并恢复 {count} 个文件`
- `message.editCancel`: `取消`
- `message.editSend`: `发送`
- `message.editPhase.preparing`: `正在准备`
- `message.editPhase.capturing-emergency`: `正在保存当前文件`
- `message.editPhase.restoring`: `正在恢复文件`
- `message.editPhase.creating-branch`: `正在创建分支`
- `message.editPhase.failed`: `{message}`
- `message.editUnavailable`: `没有可恢复的工作区检查点`
- `message.workspaceUnresumable`: `对话可查看，但工作区文件无法恢复`

English dictionary mirrors those keys. The default UI language remains Chinese.

- [ ] **Step 2: Run the UI tests and verify they fail**

Run: `pnpm exec vitest run packages/client/ui-conversation/tests/edit-resend.client.spec.tsx --reporter=dot`

Expected: FAIL because the control is absent (the 2026-07-31 stub removal).

- [ ] **Step 3: Implement draft mode and the banner**

Add optional `onEdit` to `MessageIconActions` using `IconEditOutline16`, placed with copy (branch stays on assistant tails). Only `UserMessageNodeView` passes `onEdit` when:

- `node.data.kind === 'user'`
- session not running
- content blocks are only text/image
- snapshot has a ready checkpoint whose `boundarySeq` is the preceding turn end, or `-1` for the first user message

`onEdit` copies joined text into the existing composer draft through the input machine's documented draft-set event and stores `{ messageSeq, checkpointId, fileCount, labelIndex, imageAttachmentIds }` in the chat store. No RPC.

Banner mounts on `conversation.composer.dock` (same seat as StatsLine) when that store field is set. Cancel clears the store field and restores the previous draft string saved at enter. Send disables the composer, shows `operation.phase`, and calls `runtime.edit`. On failure, keep the source session selected and show the Host error message; do not invent a child.

Preserve attachments by not removing them from the original event; Host recopies image blocks. The composer may show the existing images as read-only chips. First version does not add/remove images during edit.

- [ ] **Step 4: Run UI tests and `pnpm run test:gui`**

Run: `pnpm run test:gui`

Expected: PASS for the touched GUI packages. If unrelated GUI tests fail, stop and report them; do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-conversation
git commit -m "feat: add Edit & resend for settled conversation messages"
```

---

### Task 10: Branch labels and unrestorable workspace state

**Files:**
- Modify: `packages/client/ui-workspace/src/client/rows/Rows.tsx` and/or lineage presentation
- Modify: `packages/client/ui-conversation` as needed for a workspace-unresumable banner on the transcript
- Create: `packages/client/ui-workspace/tests/checkpoint-branch.client.spec.tsx`

**Interfaces:**
- Consumes: `parentSessionId`, checkpoint `labelIndex`, `workspaceResumable`.
- Produces: branch rows that show checkpoint labels and refuse to treat an unrestorable workspace as a live cwd.

- [ ] **Step 1: Write the failing tests**

```ts
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

User-facing label is `检查点 {n}` / `Checkpoint {n}` from `labelIndex`, never the opaque id.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run packages/client/ui-workspace/tests/checkpoint-branch.client.spec.tsx --reporter=dot`

Expected: FAIL because the label is absent.

- [ ] **Step 3: Implement labels and the diagnostic**

Ordinary fork children already appear as top-level workspace rows (`tree.ts`). Do not hide the parent. Add the checkpoint label as secondary text from the runtime snapshot. If `workspaceResumable === false`, disable composer send (existing unavailable placeholder pattern) and show the diagnostic. Conversation history still opens.

- [ ] **Step 4: Run workspace and conversation GUI tests**

Run: `pnpm exec vitest run packages/client/ui-workspace/tests/checkpoint-branch.client.spec.tsx packages/client/ui-conversation/tests/edit-resend.client.spec.tsx --reporter=dot`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-workspace packages/client/ui-conversation
git commit -m "feat: show checkpoint branch labels and unrestorable workspace state"
```

---

### Task 11: Invariants, subsystem docs, Agent Note

**Files:**
- Modify: `packages/session/workspace-checkpoint-local/src/invariant.ts`
- Modify: `packages/session/workspace-checkpoint-capture/src/invariant.ts`
- Create: `packages/session/workspace-checkpoint-local/tests/invariant.spec.ts`
- Create: `docs/subsystems/workspace-checkpoint.md` (and `.zh.md`)
- Modify: `docs/subsystems/README.md` and `README.zh.md`
- Modify: `docs/architecture.md` only with a one-line link in the capability-seam map, no loop rewrite
- Create: `.agents/notes/proposed/feature/2026-08-19-conversation-edit-checkpoints.md` plus `.zh.md` and `.i18n.yaml`; move to `implemented/` in the same PR that ships the behavior
- Modify: `packages/host/apiproxy/README.md` pair for the new RPCs

**Interfaces:**
- Consumes: checkpoint records, session index, operation views, child publication results.
- Produces: runtime invariant checks and current-state documentation.

- [ ] **Step 1: Write the failing invariant tests**

```ts
it('rejects an applied checkpoint whose blobs are gone unless recoveryRequired is set', async () => {
  await deleteBlobs(appliedId)
  await expect(runInvariants(ctx)).rejects.toMatchObject({ message: expect.stringContaining('applied') })
})

it('rejects a ready operation that published no child after a failed edit', async () => {
  emitOperation({ phase: 'ready', childSessionId: undefined, sourceSessionId })
})
```

- [ ] **Step 2: Run invariant tests and verify they fail if checks are still empty**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/invariant.spec.ts --reporter=dot`

Expected: FAIL on the missing relation.

- [ ] **Step 3: Implement checks and docs**

Invariants (local provider):

- every `parentCheckpointId` exists in `checkpoints`
- `appliedCheckpointId` is restore-eligible or `recoveryRequired` is set
- `emergencyCheckpointId` exists when referenced
- terminal operation phases `ready`/`failed` do not transition to `preparing`
- `ready` with a new child id occurs only when that session exists in `ctx.sessions` or persistence

Capture companion: `No runtime invariant: capture is fail-soft; unavailable records are the durable relation the provider already checks.`

Agent Note (`proposed/` then `implemented/` when shipped): Problem / Proposal-or-Decision / Alternatives considered (copy the spec's five rejections) / Acceptance criteria or Consequences. State that restore is workspace-file only. Cross-link `.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md` as the reintroduction this feature satisfies.

Subsystem page: types from Shared interfaces as `ts` type-equiv blocks, plus generated Cordis API. Persistence page: one sentence that session-checkpoint-policy still flushes the log and does not capture files, linking here.

- [ ] **Step 4: Run invariant tests and documentation gates that cover the new files**

Run: `pnpm exec vitest run packages/session/workspace-checkpoint-local/tests/invariant.spec.ts --reporter=dot`

Then run the narrower `verify-md-links` / `verify-agent-note-format` / `verify-export-jsdoc` commands that the pre-push skill would select for the diff.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session/workspace-checkpoint-local packages/session/workspace-checkpoint-capture docs/subsystems docs/architecture.md .agents/notes
git commit -m "docs: record workspace-checkpoint invariants and current-state contracts"
```

---

### Task 12: Keyless assembled Web replay

**Files:**
- Create: `apps/web/tests/conversation-edit-checkpoints.e2e.ts`
- Create: `apps/web/tests/snapshots/conversation-edit-checkpoints/ui.expected.md`
- Create: `apps/web/tests/snapshots/conversation-edit-checkpoints/child.expected.md`
- Modify: `tsconfig.host.json` include list for the new e2e file
- Modify: `apps/web/tests/message-actions.e2e.ts` only if the IconActions golden now includes Edit & resend on user bubbles

**Interfaces:**
- Consumes: `launchWebScaffold`, `seedSession`, Host edit RPC through the real browser.
- Produces: a keyless replay covering edit, file restore, child branch, and the new transcript.

- [ ] **Step 1: Write the failing e2e**

Follow `produced-files.e2e.ts` + `message-actions.e2e.ts`:

1. `launchWebScaffold`
2. Write `workspace/note.txt` = `before`
3. Seed a closed two-turn session whose first turn is a user message "first" and whose second turn is "second"
4. After seed, write `workspace/note.txt` = `after-second`
5. Open the session in the real browser (default Chinese page; assert Chinese strings)
6. Click `编辑并重发` on the second user message
7. Change the composer text to `edited second`
8. Click Send
9. Assert `note.txt` is `before`
10. Assert the visible transcript contains `edited second` and does not contain the original `second` assistant tail
11. Assert the parent remains listed
12. `compareOrRefreshGolden` for the child conversation aria

Zero model calls: build the seed with `Session.append` like `produced-files.e2e.ts`. Prefer a fixture that settles the child user message without a live provider. If admission would dispatch a model call, register the same keyless stub adapter neighboring seed tests use, and assert the admitted user message plus restored file.

- [ ] **Step 2: Run the e2e in replay mode and verify it fails**

Run: `$env:DSH_SNAPSHOT='replay'; pnpm exec vitest run apps/web/tests/conversation-edit-checkpoints.e2e.ts --reporter=dot`

Expected: FAIL because the Edit control or restore path is missing in the assembled app, or the golden does not exist yet.

- [ ] **Step 3: Implement any remaining glue the e2e exposes**

Only fix product gaps the replay proves. Do not weaken the file-content assertion.

- [ ] **Step 4: Refresh goldens only after the behavior is correct, then replay**

Run: `$env:DSH_SNAPSHOT='refresh'; pnpm exec vitest run apps/web/tests/conversation-edit-checkpoints.e2e.ts --reporter=dot`

Then: `$env:DSH_SNAPSHOT='replay'; pnpm exec vitest run apps/web/tests/conversation-edit-checkpoints.e2e.ts --reporter=dot`

Also: `$env:DSH_SNAPSHOT='replay'; pnpm exec vitest run apps/web/tests/message-actions.e2e.ts --reporter=dot` if user-bubble actions changed.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/conversation-edit-checkpoints.e2e.ts apps/web/tests/snapshots/conversation-edit-checkpoints tsconfig.host.json
git commit -m "test: replay conversation edit restore and child branch creation"
```

---

## Self-review

| Spec requirement | Task |
|---|---|
| Initial + per-turn checkpoints | 6 |
| Associate each direct user message with the preceding checkpoint | 7, 9 |
| Restore on Send | 4, 7 |
| Child branch without discarded descendants | 7 |
| Preserve original session and checkpoints | 7 |
| Cancel before Send is side-effect-free | 9 |
| Restore/branch recoverable after failure; emergency snapshot | 4, 5, 7 |
| Text edit, preserve attachments, disable unsupported blocks | 7, 9 |
| Bounded durable storage independent of Git | 3, 5 |
| No Git, no log rewrite, no agent-loop change, no model-facing tool | Global Constraints |
| Unit tests for manifest/restore races/quota/leases | 2–5 |
| Loader composition capture | 6 |
| Host/client tests | 7–10 |
| Keyless Web replay | 12 |
| Runtime invariants | 5, 11 |
| Workspace-file-only guarantee named in UI | 9, 11 |
| Branch conversation vs workspace resumability | 8, 10 |
| `Checkpoint 0` for first-message edit | 6, 7 |

Placeholder scan: no TBD/TODO steps. Types `CheckpointId`, `session.edit`, `session.activate`, `session/checkpoints`, `WorkspaceCheckpoint.capture/restore/acquireLease` are used consistently across tasks.

Do not implement: Git commits, deleting the parent, rewriting the log, restoring files outside cwd, undoing external side effects, checkpointing jobs/workflows, a Trajectory checkpoint editor, or a model-facing checkpoint tool.
