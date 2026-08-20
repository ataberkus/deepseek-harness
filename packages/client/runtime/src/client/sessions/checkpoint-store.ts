/** Browser-owned projection of Host workspace-checkpoint metadata and progress. */

import type { MuxFrame } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '../contract/store.ts'
import { Notifier } from './notifier.ts'

/** One client-safe checkpoint row from a `session/checkpoints` frame. */
export type CheckpointView = Extract<MuxFrame, { type: 'session/checkpoints' }>['checkpoints'][number]

/** One Host-owned edit or activation operation. */
export type CheckpointOperation = NonNullable<Extract<MuxFrame, { type: 'session/checkpoints' }>['operation']>

/** Complete control-plane state for one session's workspace checkpoints. */
export interface CheckpointSnapshot {
  /** Durable checkpoint rows, ordered by the Host's user-facing label index. */
  readonly checkpoints: readonly CheckpointView[]
  /** Last checkpoint applied to the workspace, when the provider records one. */
  readonly appliedCheckpointId?: CheckpointView['id']
  /** Current edit or activation operation, including its terminal phase. */
  readonly operation?: CheckpointOperation
  /** User-facing checkpoint ordinal for an edit child branch. */
  readonly branchLabelIndex?: number
  /** Whether the session has a known usable workspace-file checkpoint. */
  readonly workspaceResumable?: boolean
  /** Durable workspace diagnostic that blocks new model work. */
  readonly recoveryRequired?: string
}

/** Empty checkpoint state before the first Host baseline arrives. */
export const EMPTY_CHECKPOINT_SNAPSHOT: CheckpointSnapshot = { checkpoints: [] }

/**
 * Stable observable store for one session's complete checkpoint snapshot.
 *
 * The store is manager-owned so a `session/checkpoints` baseline received before
 * a Session object is opened is retained and adopted when that object is built.
 */
export class CheckpointSnapshotStore implements ObservableSnapshot<CheckpointSnapshot> {
  private snapshot: CheckpointSnapshot = EMPTY_CHECKPOINT_SNAPSHOT
  private readonly notifier = new Notifier(() => {})

  /**
   * Read the current checkpoint projection.
   * @returns the reference-stable snapshot.
   */
  getSnapshot(): CheckpointSnapshot {
    this.notifier.ensureFresh()
    return this.snapshot
  }

  /**
   * Subscribe to checkpoint projection replacement.
   * @param listener - callback invoked after a complete snapshot changes.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Install one complete Host frame.
   * @param frame - validated `session/checkpoints` payload.
   */
  replace(frame: Extract<MuxFrame, { type: 'session/checkpoints' }>): void {
    this.snapshot = {
      checkpoints: frame.checkpoints,
      ...frame.appliedCheckpointId === undefined ? {} : { appliedCheckpointId: frame.appliedCheckpointId },
      ...frame.operation === undefined ? {} : { operation: frame.operation },
      ...frame.branchLabelIndex === undefined ? {} : { branchLabelIndex: frame.branchLabelIndex },
      ...frame.workspaceResumable === undefined ? {} : { workspaceResumable: frame.workspaceResumable },
      ...frame.recoveryRequired === undefined ? {} : { recoveryRequired: frame.recoveryRequired },
    }
    this.notifier.notifyNow()
  }

  /**
   * Drop the previous generation's projection before a new Host baseline.
   */
  reset(): void {
    if (this.snapshot === EMPTY_CHECKPOINT_SNAPSHOT) return
    this.snapshot = EMPTY_CHECKPOINT_SNAPSHOT
    this.notifier.notifyNow()
  }
}
