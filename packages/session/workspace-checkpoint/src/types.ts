/**
 * Workspace-checkpoint vocabulary: branded ids, manifests, durable records, and
 * capture/restore request types. Runtime besides {@link CheckpointId} stays in
 * `error.ts` and the Service Definition.
 * @module @deepseek-ai/dsh-workspace-checkpoint/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Identifies one durable workspace-file checkpoint record. */
export type CheckpointId = Branded<'CheckpointId'>

/**
 * Brand a string as a {@link CheckpointId}.
 * @param id - the raw checkpoint id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function CheckpointId(id: string): CheckpointId {
  return id as CheckpointId
}

/** Why a checkpoint was captured. */
export type CheckpointRole = 'initial' | 'turn' | 'emergency'

/** Turn outcome recorded on a per-turn checkpoint. */
export type CheckpointTurnOutcome =
  | 'initial'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Whether a stored checkpoint may be selected for automatic restore. */
export type CheckpointStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Filesystem entry kind recorded in a checkpoint manifest. */
export type ManifestEntryKind = 'file' | 'directory' | 'symlink'

/** One cwd-relative filesystem entry in a checkpoint manifest. */
export interface ManifestEntry {
  /** Slash-separated path relative to the session cwd. */
  readonly relativePath: string
  /** Recorded entry kind; the walker uses `lstat` and does not follow symlinks. */
  readonly kind: ManifestEntryKind
  /** POSIX mode bits when the platform reports them. */
  readonly mode?: number
  /** Byte size for files; 0 for directories and symlinks. */
  readonly size: number
  /** SHA-256 hex of regular file contents. */
  readonly hash?: string
  /** Raw symlink text; present only for `kind: 'symlink'`. */
  readonly linkTarget?: string
  /** False when restore would follow or write outside the session cwd. */
  readonly restoreSafe: boolean
}

/** Content-addressed snapshot of one session cwd. */
export interface CheckpointManifest {
  /** Canonical cwd the walker started from. */
  readonly cwd: string
  /** SHA-256 of the canonical JSON of {@link CheckpointManifest.entries}. */
  readonly hash: string
  /** Sorted cwd-relative entries. */
  readonly entries: readonly ManifestEntry[]
}

/** Durable control-plane record for one workspace checkpoint. */
export interface CheckpointRecord {
  readonly id: CheckpointId
  readonly sessionId: SessionId
  /** Canonical workspace path used for leases and restore containment. */
  readonly workspaceKey: string
  readonly workspaceId?: WorkspaceId
  /** Inclusive session seq represented by this checkpoint; `-1` is Checkpoint 0. */
  readonly boundarySeq: number
  readonly parentCheckpointId?: CheckpointId
  readonly role: CheckpointRole
  readonly turnOutcome: CheckpointTurnOutcome
  readonly status: CheckpointStatus
  readonly createdAt: number
  readonly manifestHash: string
  readonly fileCount: number
  readonly restoreEligible: boolean
  /** User-facing checkpoint ordinal within the session, excluding emergency captures. */
  readonly labelIndex: number
}

/** Client-safe projection of one checkpoint, with no blob internals. */
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

/** Durable relation between an edit source, its restore checkpoints, and child. */
export interface CheckpointEditLink {
  /** Source session whose append-only transcript was edited. */
  readonly sourceSessionId: SessionId
  /** Source turn boundary immediately before the edited message. */
  readonly sourceBoundarySeq: number
  /** Checkpoint selected for the child branch. */
  readonly selectedCheckpointId: CheckpointId
  /** Emergency checkpoint retaining the pre-edit workspace. */
  readonly emergencyCheckpointId: CheckpointId
  /** Child session created from the inherited prefix. */
  readonly childSessionId: SessionId
}

/** Live Host edit/activate progress published on `session/checkpoints`. */
export type CheckpointOperationPhase =
  | 'preparing'
  | 'capturing-emergency'
  | 'restoring'
  | 'creating-branch'
  | 'ready'
  | 'failed'

/** One in-flight or terminal checkpoint operation. */
export interface CheckpointOperationView {
  readonly sourceSessionId: SessionId
  readonly childSessionId?: SessionId
  readonly checkpointId: CheckpointId
  readonly phase: CheckpointOperationPhase
  readonly fileCount: number
  readonly message?: string
}

/** Input to workspace-checkpoint capture. */
export interface CaptureRequest {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly workspaceId?: WorkspaceId
  readonly boundarySeq: number
  readonly parentCheckpointId?: CheckpointId
  readonly role: CheckpointRole
  readonly turnOutcome: CheckpointTurnOutcome
  /**
   * Lease already held by a Host operation. Providers may use it to capture
   * within the same multi-step edit transaction without waiting on itself.
   */
  readonly lease?: WorkspaceLease
}

/** Input to workspace-checkpoint restore. */
export interface RestoreRequest {
  readonly checkpointId: CheckpointId
  readonly cwd: string
  /**
   * Lease already held by the Host operation. Providers may use it to avoid
   * reacquiring the same workspace lease during a multi-step edit transaction.
   */
  readonly lease?: WorkspaceLease
  readonly signal?: AbortSignal
}

/** Successful restore: the tree now matches the named checkpoint. */
export interface RestoreResult {
  readonly checkpointId: CheckpointId
  readonly fileCount: number
}

/** Exclusive in-process lease over one canonical workspace path. */
export interface WorkspaceLease {
  readonly workspaceKey: string
  /** Release the lease. Idempotent. */
  release(): void
}
