/**
 * In-process exclusive workspace lease: Host acquire throws when held;
 * capture waits; restore may join an already-held Host lease.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/lease
 */

import { WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { WorkspaceLease } from '@deepseek-ai/dsh-workspace-checkpoint'

interface HostHold {
  readonly lease: WorkspaceLease
  readonly released: Promise<void>
  resolve(): void
}

/**
 * Per-workspace Host holds and FIFO internal chain.
 */
export class WorkspaceLeaseTable {
  private readonly hostHolds = new Map<string, HostHold>()
  private readonly internalBusy = new Set<string>()
  private readonly queue = new Map<string, Promise<void>>()

  /**
   * Acquire a Host-facing exclusive lease. Throws when the workspace is busy.
   * @param workspaceKey - canonical workspace path.
   * @returns a lease whose `release()` is idempotent.
   */
  acquire(workspaceKey: string): WorkspaceLease {
    if (this.hostHolds.has(workspaceKey) || this.internalBusy.has(workspaceKey)) {
      throw new WorkspaceCheckpointError('workspace lease is held', 'CHECKPOINT_LEASE_HELD')
    }
    let resolve!: () => void
    const released = new Promise<void>((next) => {
      resolve = next
    })
    const lease: WorkspaceLease = {
      workspaceKey,
      release: () => {
        const current = this.hostHolds.get(workspaceKey)
        if (current?.lease !== lease) return
        this.hostHolds.delete(workspaceKey)
        current.resolve()
      },
    }
    this.hostHolds.set(workspaceKey, { lease, released, resolve })
    return lease
  }

  /**
   * Run `fn` under the internal FIFO chain. Capture waits for a Host hold;
   * restore joins it so an edit transaction can restore without deadlocking.
   * @param workspaceKey - canonical workspace path.
   * @param fn - work to run while the workspace is reserved.
   * @param joinHost - when true, run immediately if this process already holds the Host lease.
   * @returns `fn`'s result.
   */
  async withLease<T>(workspaceKey: string, fn: () => Promise<T>, joinHost: boolean): Promise<T> {
    if (joinHost && this.hostHolds.has(workspaceKey)) return fn()
    const previous = this.queue.get(workspaceKey) ?? Promise.resolve()
    let releaseQueue!: () => void
    const next = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    this.queue.set(workspaceKey, previous.then(() => next, () => next))
    await previous
    while (this.hostHolds.has(workspaceKey)) {
      await this.hostHolds.get(workspaceKey)?.released
    }
    this.internalBusy.add(workspaceKey)
    try {
      return await fn()
    } finally {
      this.internalBusy.delete(workspaceKey)
      releaseQueue()
    }
  }
}
