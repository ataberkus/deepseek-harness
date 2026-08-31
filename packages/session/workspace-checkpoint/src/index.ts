/**
 * Service Definition for workspace-file checkpoints associated with session turns.
 * Capture, restore, lease, and retention belong to a provider; turn listening
 * and Host edit commands are consumers. Metadata is not a session event.
 * @module @deepseek-ai/dsh-workspace-checkpoint
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CaptureRequest,
  CheckpointEditLink,
  CheckpointId,
  CheckpointRecord,
  CheckpointView,
  RestoreRequest,
  RestoreResult,
  WorkspaceLease,
} from './types.ts'
import type { StoredSessionCheckpointIndex } from './spec.ts'

/** Settings namespace used by the local provider and Web Plugins card. */
export const WORKSPACE_CHECKPOINT_SETTINGS_NAMESPACE = 'workspace-checkpoint'

/** User-owned settings for workspace conversation checkpoints. */
export interface WorkspaceCheckpointSettings {
  /** Capture workspace checkpoints and enforce workspace recovery admission. */
  enabled: boolean
}

/** Settings schema; fresh compositions and absent user values are disabled. */
export const WORKSPACE_CHECKPOINT_SETTINGS_SCHEMA: z<WorkspaceCheckpointSettings> = z.object({
  enabled: z.boolean().default(false),
})

export { WorkspaceCheckpointError } from './error.ts'
export type { WorkspaceCheckpointErrorCode } from './error.ts'
export {
  workspaceCheckpointDomainSpec,
  checkpointRecordSchema,
  sessionCheckpointIndexSchema,
} from './spec.ts'
export type { StoredCheckpointRecord, StoredSessionCheckpointIndex } from './spec.ts'
export { CheckpointId } from './types.ts'
export type {
  CaptureRequest,
  CheckpointEditLink,
  CheckpointManifest,
  CheckpointOperationPhase,
  CheckpointOperationView,
  CheckpointRecord,
  CheckpointRole,
  CheckpointStatus,
  CheckpointTurnOutcome,
  CheckpointView,
  ManifestEntry,
  ManifestEntryKind,
  RestoreRequest,
  RestoreResult,
  WorkspaceLease,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceCheckpoint: WorkspaceCheckpoint
  }

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
 * Abstract workspace-checkpoint service. Subclass, implement the abstract
 * methods, and load the subclass as a plugin — it registers as
 * `ctx.workspaceCheckpoint`.
 */
export abstract class WorkspaceCheckpoint extends Service {
  /**
   * Whether automatic workspace checkpoint capture and recovery admission are enabled.
   * Providers that do not expose the setting remain safely disabled.
   */
  get enabled(): boolean {
    return false
  }

  /**
   * @param ctx - Cordis context that receives `ctx.workspaceCheckpoint`.
   */
  constructor(ctx: Context) {
    super(ctx, 'workspaceCheckpoint')
  }

  /**
   * Capture the session cwd into a durable checkpoint record.
   * @param request - session, cwd, boundary, role, optional parent, and lease.
   * @returns the stored record; `status.kind` may be `unavailable` on fail-soft capture.
   */
  abstract capture(request: CaptureRequest): Promise<CheckpointRecord>

  /**
   * Read one durable checkpoint.
   * @param id - opaque checkpoint id.
   * @returns the stored record.
   */
  abstract inspect(id: CheckpointId): Promise<CheckpointRecord>

  /**
   * List checkpoints for one session in label order.
   * @param sessionId - owning session.
   * @returns client-safe views with no blob internals.
   */
  abstract list(sessionId: SessionId): Promise<readonly CheckpointView[]>

  /**
   * Read the durable session sidecar used by Host activation and projections.
   * Providers without a metadata index may return `undefined`.
   * @param _sessionId - owning session.
   * @returns the index row, when present.
   */
  sessionIndex(_sessionId: SessionId): StoredSessionCheckpointIndex | undefined {
    return undefined
  }

  /**
   * Make `request.cwd` match the checkpoint manifest, or roll back.
   * @param request - checkpoint id, target cwd, optional lease, and abort signal.
   * @returns the restored checkpoint id and restored file count.
   */
  abstract restore(request: RestoreRequest): Promise<RestoreResult>

  /**
   * Persist the source/child relationship for a successful conversation edit.
   * @param link - selected, emergency, source, boundary, and child ids.
   * @returns fulfillment after the sidecar is durable.
   */
  abstract recordEdit(link: CheckpointEditLink): Promise<void>

  /**
   * Acquire an exclusive in-process lease for one canonical workspace path.
   * Throws `CHECKPOINT_LEASE_HELD` when another holder already owns it.
   * @param workspaceKey - canonical workspace path.
   * @returns a lease whose `release()` is idempotent.
   */
  abstract acquireLease(workspaceKey: string): Promise<WorkspaceLease>

  /**
   * Read the recovery-required diagnostic for a workspace, if any.
   * @param workspaceKey - canonical workspace path.
   * @returns the diagnostic string, or `undefined` when the workspace is writable.
   */
  abstract recoveryRequired(workspaceKey: string): Promise<string | undefined>

  /**
   * Mark a workspace as requiring recovery and block new model work.
   * @param workspaceKey - canonical workspace path.
   * @param reason - durable diagnostic presented to the user.
   */
  abstract markRecoveryRequired(workspaceKey: string, reason: string): Promise<void>

  /**
   * Clear the recovery-required diagnostic after a successful restore.
   * @param workspaceKey - canonical workspace path.
   */
  abstract clearRecoveryRequired(workspaceKey: string): Promise<void>

  /**
   * Apply configured retention: evict unreferenced blobs without silently
   * dropping an applied branch's required objects.
   */
  abstract evict(): Promise<void>
}

export default WorkspaceCheckpoint
