/**
 * Local workspace-checkpoint provider: Harness-home object store, manifest
 * capture, and journaled restore.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  WorkspaceCheckpoint,
  WorkspaceCheckpointError,
  workspaceCheckpointDomainSpec,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointId,
  CheckpointRecord,
  CheckpointView,
  RestoreRequest,
  RestoreResult,
  WorkspaceLease,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Config as ConfigSchema, type Config as ProviderConfig } from './config.ts'
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

/**
 * Harness-home implementation of `ctx.workspaceCheckpoint`.
 */
export class LocalWorkspaceCheckpoint extends WorkspaceCheckpoint {
  static inject = ['storageDomain']
  static Config = ConfigSchema

  private readonly config: ProviderConfig
  private readonly objectRoot: string
  private domain?: Domain<typeof workspaceCheckpointDomainSpec>
  private readonly leases = new WorkspaceLeaseTable()
  private readonly recovery = new Map<string, string>()
  private captureTail: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Cordis context that receives `ctx.workspaceCheckpoint`.
   * @param config - required capture and storage limits.
   */
  constructor(ctx: Context, config: ProviderConfig) {
    super(ctx)
    this.config = config
    this.objectRoot = resolveObjectRoot(config)
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
   * @param request - session, cwd, boundary, role, and optional parent.
   * @returns the stored record; `status.kind` may be `unavailable` on fail-soft capture.
   */
  override capture(request: CaptureRequest): Promise<CheckpointRecord> {
    return this.enqueue(async () => {
      const key = await canonicalizeCwd(request.cwd)
      return this.leases.withLease(key, () => captureCheckpoint(request, {
        objectRoot: this.objectRoot,
        maxTotalBytes: this.config.maxTotalBytes,
        excludeGlobs: this.config.excludeGlobs,
        captureRetryCount: this.config.captureRetryCount,
        captureRetryDelayMs: this.config.captureRetryDelayMs,
        domain: this.requireDomain(),
        emitChanged: sessionId => this.ctx.emit('workspace-checkpoint/changed', sessionId),
      }), false)
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
      return this.leases.withLease(key, () => restoreCheckpoint(request, {
        domain: this.requireDomain(),
        objectRoot: this.objectRoot,
        markRecoveryRequired: (workspaceKey, reason) => this.markRecoveryRequired(workspaceKey, reason),
        clearRecoveryRequired: workspaceKey => this.clearRecoveryRequired(workspaceKey),
        emitChanged: sessionId => this.ctx.emit('workspace-checkpoint/changed', sessionId),
      }), true)
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
  override recoveryRequired(workspaceKey: string): Promise<string | undefined> {
    return Promise.resolve(this.recovery.get(workspaceKey))
  }

  /**
   * @param workspaceKey - canonical workspace path.
   * @param reason - durable diagnostic presented to the user.
   */
  override markRecoveryRequired(workspaceKey: string, reason: string): Promise<void> {
    this.recovery.set(workspaceKey, reason)
    return Promise.resolve()
  }

  /**
   * @param workspaceKey - canonical workspace path.
   */
  override clearRecoveryRequired(workspaceKey: string): Promise<void> {
    this.recovery.delete(workspaceKey)
    return Promise.resolve()
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
  sessionIndex(sessionId: SessionId): ReturnType<typeof loadSessionIndex> {
    return loadSessionIndex(sessionId, this.requireDomain())
  }

  private requireDomain(): Domain<typeof workspaceCheckpointDomainSpec> {
    if (this.domain === undefined) {
      throw new WorkspaceCheckpointError('workspace-checkpoint domain is not open', 'CHECKPOINT_UNAVAILABLE')
    }
    return this.domain
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.captureTail.then(job, job)
    this.captureTail = run.then(() => undefined, () => undefined)
    return run
  }
}

export default LocalWorkspaceCheckpoint
