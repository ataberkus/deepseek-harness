/**
 * Typed failures for workspace-checkpoint capture, restore, and lease.
 * @module @deepseek-ai/dsh-workspace-checkpoint/src/error
 */

/** Closed failure vocabulary for {@link WorkspaceCheckpointError}. */
export type WorkspaceCheckpointErrorCode =
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_UNAVAILABLE'
  | 'CHECKPOINT_LEASE_HELD'
  | 'CHECKPOINT_RECOVERY_REQUIRED'
  | 'CHECKPOINT_QUOTA_EXHAUSTED'
  | 'CHECKPOINT_CONTAINMENT'
  | 'CHECKPOINT_HASH_MISMATCH'
  | 'CHECKPOINT_CONCURRENT_WRITE'

/**
 * Typed workspace-checkpoint failure.
 * @param message - human-readable account of the failure.
 * @param code - stable machine code for Host mapping and tests.
 */
export class WorkspaceCheckpointError extends Error {
  constructor(
    message: string,
    public readonly code: WorkspaceCheckpointErrorCode,
  ) {
    super(message)
    this.name = 'WorkspaceCheckpointError'
  }
}
