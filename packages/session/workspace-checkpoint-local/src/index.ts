/**
 * Local workspace-checkpoint provider: Harness-home object store, manifest
 * capture, and journaled restore.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { resolve } from 'node:path'
import {
  CheckpointId,
  WORKSPACE_CHECKPOINT_SETTINGS_NAMESPACE,
  WORKSPACE_CHECKPOINT_SETTINGS_SCHEMA,
  WorkspaceCheckpoint,
  WorkspaceCheckpointError,
  workspaceCheckpointDomainSpec,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointEditLink,
  CheckpointRecord,
  CheckpointView,
  RestoreRequest,
  RestoreResult,
  WorkspaceCheckpointSettings,
  WorkspaceLease,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Config } from './config.ts'
import { WorkspaceLeaseTable } from './lease.ts'
import { resolveObjectRoot } from './objects.ts'
import { canonicalizeCwd } from './paths.ts'
import { evictCheckpoints } from './retention.ts'
import { captureCheckpoint, inspectCheckpoint, listCheckpoints, loadSessionIndex } from './store.ts'
import { restoreCheckpoint } from './restore.ts'

export { Config } from './config.ts'
export type { Config as LocalWorkspaceCheckpointConfig } from './config.ts'
export { hashCanonicalJson, hashFile } from './hash.ts'
export { buildManifest } from './manifest.ts'
export type { ManifestBuildOptions } from './manifest.ts'
export { fileStatsRaced, throwIfFileRaced } from './manifest.ts'
export { canonicalizeCwd, fromManifestPath, isContained, toManifestPath } from './paths.ts'
export { captureInternals, loadSessionIndex } from './store.ts'
export { restoreInternals } from './restore.ts'

/**
 * Harness-home implementation of `ctx.workspaceCheckpoint`.
 */
export class LocalWorkspaceCheckpoint extends WorkspaceCheckpoint {
  static inject = ['storageDomain']
  static Config = z.object({
    enabled: z.boolean().default(false),
    objectRoot: z.string(),
    dshHome: z.string(),
    maxTotalBytes: z.number().required(),
    excludeGlobs: z.array(z.string()).required(),
    captureRetryCount: z.number().required(),
    captureRetryDelayMs: z.number().required(),
  })

  private readonly config: Config
  private readonly objectRoot: string
  private enabledSource: () => WorkspaceCheckpointSettings
  private domain?: Domain<typeof workspaceCheckpointDomainSpec>
  private readonly leases = new WorkspaceLeaseTable()
  private readonly recovery = new Map<string, string>()
  private captureTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Cordis context that receives `ctx.workspaceCheckpoint`.
   * @param config - required capture and storage limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config
    this.objectRoot = resolveObjectRoot(config)
    const entry: WorkspaceCheckpointSettings = { enabled: config.enabled ?? false }
    this.enabledSource = () => entry
    installSettingsSection(ctx, WORKSPACE_CHECKPOINT_SETTINGS_NAMESPACE, WORKSPACE_CHECKPOINT_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.enabledSource = current },
      onChange: () => {},
    })
  }

  /** Whether automatic workspace capture and recovery admission are enabled. */
  override get enabled(): boolean {
    return this.enabledSource().enabled
  }

  /** Open the workspace_checkpoint domain and close it with this fiber. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceCheckpointDomainSpec)
    this.ctx.effect(() => async () => {
      await domain.close()
    }, 'workspace-checkpoint-local.domainClose')
    this.domain = domain
  }

  /**
   * @param request - session, cwd, boundary, role, optional parent, and lease.
   * @returns the stored record; `status.kind` may be `unavailable` on fail-soft capture.
   */
  override capture(request: CaptureRequest): Promise<CheckpointRecord> {
    return this.enqueue(async () => {
      let key: string
      try {
        key = await canonicalizeCwd(request.cwd)
      } catch {
        // A cwd that cannot be canonicalized still receives an unavailable
        // checkpoint record under its absolute fallback key.
        key = resolve(request.cwd)
      }
      const run = () => captureCheckpoint(request, {
        objectRoot: this.objectRoot,
        maxTotalBytes: this.config.maxTotalBytes,
        excludeGlobs: this.config.excludeGlobs,
        captureRetryCount: this.config.captureRetryCount,
        captureRetryDelayMs: this.config.captureRetryDelayMs,
        domain: this.requireDomain(),
        workspaceKey: key,
        emitChanged: (sessionId) => { this.ctx.emit('workspace-checkpoint/changed', sessionId) },
      })
      if (request.lease !== undefined) {
        if (request.lease.workspaceKey !== key) {
          throw new WorkspaceCheckpointError(
            'capture lease does not match the target workspace',
            'CHECKPOINT_LEASE_HELD',
          )
        }
        return run()
      }
      return this.leases.withLease(key, run, false)
    })
  }

  /**
   * @param id - opaque checkpoint id.
   * @returns the stored record.
   */
  override inspect(id: CheckpointId): Promise<CheckpointRecord> {
    return Promise.resolve().then(() => inspectCheckpoint(id, this.requireDomain()))
  }

  /**
   * @param sessionId - owning session.
   * @returns client-safe views in label order.
   */
  override list(sessionId: SessionId): Promise<readonly CheckpointView[]> {
    return Promise.resolve().then(() => listCheckpoints(sessionId, this.requireDomain()))
  }

  /**
   * @param request - checkpoint id, target cwd, optional abort signal.
   * @returns the restored checkpoint id and restored file count.
   */
  override restore(request: RestoreRequest): Promise<RestoreResult> {
    return this.enqueue(async () => {
      const key = await canonicalizeCwd(request.cwd)
      const run = () => restoreCheckpoint(request, {
        domain: this.requireDomain(),
        objectRoot: this.objectRoot,
        excludeGlobs: this.config.excludeGlobs,
        markRecoveryRequired: (workspaceKey, reason) => this.markRecoveryRequired(workspaceKey, reason),
        clearRecoveryRequired: workspaceKey => this.clearRecoveryRequired(workspaceKey),
        emitChanged: (sessionId) => { this.ctx.emit('workspace-checkpoint/changed', sessionId) },
      })
      if (request.lease !== undefined) {
        if (request.lease.workspaceKey !== key) {
          throw new WorkspaceCheckpointError(
            'restore lease does not match the target workspace',
            'CHECKPOINT_LEASE_HELD',
          )
        }
        return run()
      }
      return this.leases.withLease(key, run, true)
    })
  }

  /**
   * @param workspaceKey - canonical workspace path.
   * @returns a lease whose `release()` is idempotent.
   */
  override acquireLease(workspaceKey: string): Promise<WorkspaceLease> {
    return Promise.resolve().then(() => this.leases.acquire(workspaceKey))
  }

  /**
   * @param workspaceKey - canonical workspace path.
   * @returns the diagnostic string, or `undefined` when the workspace is writable.
   */
  override async recoveryRequired(workspaceKey: string): Promise<string | undefined> {
    const key = await this.recoveryKey(workspaceKey)
    const cached = this.recovery.get(key)
    if (cached !== undefined) return cached
    const domain = this.domain
    if (domain === undefined) return undefined
    const checkpoints = domain.table('checkpoints')
    for (const [, index] of domain.table('sessions').entries()) {
      if (index.recoveryRequired === undefined) continue
      if (index.checkpointIds.some(id => checkpoints.get(CheckpointId(id))?.workspaceKey === key)) {
        this.recovery.set(key, index.recoveryRequired)
        return index.recoveryRequired
      }
    }
    return undefined
  }

  /**
   * @param workspaceKey - canonical workspace path.
   * @param reason - durable diagnostic presented to the user.
   */
  override async markRecoveryRequired(workspaceKey: string, reason: string): Promise<void> {
    const key = await this.recoveryKey(workspaceKey)
    this.recovery.set(key, reason)
    const domain = this.domain
    if (domain === undefined) return
    const checkpoints = domain.table('checkpoints')
    const sessions = domain.table('sessions')
    for (const [sessionId, index] of sessions.entries()) {
      if (!index.checkpointIds.some(id => checkpoints.get(CheckpointId(id))?.workspaceKey === key)) continue
      await sessions.put(sessionId, {
        checkpointIds: index.checkpointIds,
        ...index.appliedCheckpointId === undefined ? {} : { appliedCheckpointId: index.appliedCheckpointId },
        ...index.emergencyCheckpointId === undefined ? {} : { emergencyCheckpointId: index.emergencyCheckpointId },
        recoveryRequired: reason,
        ...index.edit === undefined ? {} : { edit: index.edit },
      })
      this.ctx.emit('workspace-checkpoint/changed', SessionId(sessionId))
    }
  }

  /**
   * @param workspaceKey - canonical workspace path.
   */
  override async clearRecoveryRequired(workspaceKey: string): Promise<void> {
    const key = await this.recoveryKey(workspaceKey)
    this.recovery.delete(key)
    const domain = this.domain
    if (domain === undefined) return
    const checkpoints = domain.table('checkpoints')
    const sessions = domain.table('sessions')
    for (const [sessionId, index] of sessions.entries()) {
      if (!index.checkpointIds.some(id => checkpoints.get(CheckpointId(id))?.workspaceKey === key)) continue
      await sessions.put(sessionId, {
        checkpointIds: index.checkpointIds,
        ...index.appliedCheckpointId === undefined ? {} : { appliedCheckpointId: index.appliedCheckpointId },
        ...index.emergencyCheckpointId === undefined ? {} : { emergencyCheckpointId: index.emergencyCheckpointId },
        ...index.edit === undefined ? {} : { edit: index.edit },
      })
      this.ctx.emit('workspace-checkpoint/changed', SessionId(sessionId))
    }
  }

  /**
   * Apply retention until the blob store fits `maxTotalBytes`.
   */
  override evict(): Promise<void> {
    return this.enqueue(async () => {
      const changed = await evictCheckpoints(this.requireDomain(), this.objectRoot, this.config.maxTotalBytes)
      for (const sessionId of changed) this.ctx.emit('workspace-checkpoint/changed', sessionId)
    })
  }

  /**
   * Read the durable per-session checkpoint index.
   * @param sessionId - owning session.
   * @returns the index row, when present.
   */
  override sessionIndex(sessionId: SessionId): ReturnType<typeof loadSessionIndex> {
    return loadSessionIndex(sessionId, this.requireDomain())
  }

  /**
   * Persist the durable relation created by a conversation edit.
   * @param link - source, boundary, selected checkpoint, emergency checkpoint, and child.
   * @returns fulfillment after both session sidecars are updated.
   */
  override async recordEdit(link: CheckpointEditLink): Promise<void> {
    const sessions = this.requireDomain().table('sessions')
    const edit = {
      sourceSessionId: String(link.sourceSessionId),
      sourceBoundarySeq: link.sourceBoundarySeq,
      selectedCheckpointId: String(link.selectedCheckpointId),
      emergencyCheckpointId: String(link.emergencyCheckpointId),
      childSessionId: String(link.childSessionId),
    }
    const source = sessions.get(link.sourceSessionId)
    if (source === undefined) {
      throw new WorkspaceCheckpointError(
        `edit source session not found: ${String(link.sourceSessionId)}`,
        'CHECKPOINT_UNAVAILABLE',
      )
    }
    await sessions.put(link.sourceSessionId, { ...source, edit })
    const child = sessions.get(link.childSessionId)
    await sessions.put(link.childSessionId, child === undefined
      ? { checkpointIds: [], edit }
      : { ...child, edit })
    this.ctx.emit('workspace-checkpoint/changed', link.sourceSessionId)
    this.ctx.emit('workspace-checkpoint/changed', link.childSessionId)
  }

  private requireDomain(): Domain<typeof workspaceCheckpointDomainSpec> {
    if (this.domain === undefined) {
      throw new WorkspaceCheckpointError('workspace-checkpoint domain is not open', 'CHECKPOINT_UNAVAILABLE')
    }
    return this.domain
  }

  /** Normalize recovery lookups so aliases cannot bypass the guard. */
  private async recoveryKey(workspaceKey: string): Promise<string> {
    try {
      return await canonicalizeCwd(workspaceKey)
    } catch {
      // A missing or inaccessible path still needs a stable in-process key.
      return resolve(workspaceKey)
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.captureTail.then(job, job)
    this.captureTail = run.then(() => undefined, () => undefined)
    return run
  }
}

export default LocalWorkspaceCheckpoint
