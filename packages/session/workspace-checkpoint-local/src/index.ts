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
import { resolveObjectRoot } from './objects.ts'
import { captureCheckpoint, inspectCheckpoint, listCheckpoints } from './store.ts'
import { restoreCheckpoint } from './restore.ts'

export { Config } from './config.ts'
export type { Config as LocalWorkspaceCheckpointConfig } from './config.ts'
export { hashCanonicalJson, hashFile } from './hash.ts'
export { buildManifest } from './manifest.ts'
export type { ManifestBuildOptions } from './manifest.ts'
export { fileStatsRaced, throwIfFileRaced } from './manifest.ts'
export { canonicalizeCwd, fromManifestPath, isContained, toManifestPath } from './paths.ts'
export { captureInternals } from './store.ts'
export { restoreInternals } from './restore.ts'

/**
 * Harness-home implementation of `ctx.workspaceCheckpoint`.
 */
export class LocalWorkspaceCheckpoint extends WorkspaceCheckpoint {
  static inject = ['storageDomain']
  static Config = ConfigSchema

  private readonly config: ProviderConfig
  private readonly objectRoot: string
  private domain?: Domain<typeof workspaceCheckpointDomainSpec>
  private readonly leases = new Map<string, WorkspaceLease>()
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
    return this.enqueue(async () => captureCheckpoint(request, {
      objectRoot: this.objectRoot,
      maxTotalBytes: this.config.maxTotalBytes,
      excludeGlobs: this.config.excludeGlobs,
      captureRetryCount: this.config.captureRetryCount,
      captureRetryDelayMs: this.config.captureRetryDelayMs,
      domain: this.requireDomain(),
    }))
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
    return this.enqueue(async () => restoreCheckpoint(request, {
      domain: this.requireDomain(),
      objectRoot: this.objectRoot,
      acquireLease: workspaceKey => this.acquireLease(workspaceKey),
      markRecoveryRequired: (workspaceKey, reason) => this.markRecoveryRequired(workspaceKey, reason),
      clearRecoveryRequired: workspaceKey => this.clearRecoveryRequired(workspaceKey),
    }))
  }

  /**
   * @param workspaceKey - canonical workspace path.
   * @returns a lease whose `release()` is idempotent.
   */
  override acquireLease(workspaceKey: string): Promise<WorkspaceLease> {
    if (this.leases.has(workspaceKey)) {
      return Promise.reject(new WorkspaceCheckpointError('workspace lease is held', 'CHECKPOINT_LEASE_HELD'))
    }
    const lease: WorkspaceLease = {
      workspaceKey,
      release: () => {
        if (this.leases.get(workspaceKey) === lease) this.leases.delete(workspaceKey)
      },
    }
    this.leases.set(workspaceKey, lease)
    return Promise.resolve(lease)
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

  /** Retention lands in a later task; this is a successful no-op. */
  override evict(): Promise<void> {
    return Promise.resolve()
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
