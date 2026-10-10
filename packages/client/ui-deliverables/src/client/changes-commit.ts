/**
 * Commit requests from the changed-files card, delivered as chat prompts to
 * the Session's agent, and the latest change announcement each Session's cards
 * have shown, which decides the one card that offers the commit actions.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One Session's latest prompt request: running, or failed before the Session queued it. */
export type ChangesCommitPhase = 'sending' | 'error'

/**
 * Queues one prompt in a Session's conversation.
 * @param sessionId - the Session whose agent receives the prompt.
 * @param text - the prompt.
 * @returns once the Session queued the prompt.
 * @throws when the Session has no conversation or refuses the prompt.
 */
export type ChangesPromptSender = (sessionId: SessionId, text: string) => Promise<void>

/** One browser plugin's commit prompts; a disposed controller sends nothing. */
export class ChangesCommitController {
  /** The latest prompt request of each Session, keyed by Session id; a queued prompt clears its entry. */
  readonly state = createSnapshotStore<Record<string, ChangesCommitPhase | undefined>>({})
  /** The highest `workspace/changes` sequence a mounted card of each Session has shown, keyed by Session id. */
  readonly latest = createSnapshotStore<Record<string, number | undefined>>({})
  private disposed = false
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly sendPrompt: ChangesPromptSender) {}

  /**
   * Record that a card shows a served summary; a higher sequence moves the commit actions to its card.
   * @param sessionId - viewed Session.
   * @param seq - the announcing event's sequence.
   */
  noteShown(sessionId: SessionId, seq: number): void {
    const current = this.latest.getSnapshot()[sessionId]
    if (current === undefined || current < seq) this.latest.update((state) => { state[sessionId] = seq })
  }

  /**
   * Queue a commit prompt in one Session's chat unless one is being sent.
   * @param sessionId - viewed Session.
   * @param text - the localized prompt.
   * @returns once the prompt is queued or its failure is published.
   */
  async request(sessionId: SessionId, text: string): Promise<void> {
    if (this.disposed || this.state.getSnapshot()[sessionId] === 'sending') return
    this.state.update((state) => { state[sessionId] = 'sending' })
    const task = this.deliver(sessionId, text)
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Stop publishing and wait until no request can publish state. */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all(this.pending)
  }

  private async deliver(sessionId: SessionId, text: string): Promise<void> {
    let failed = false
    try {
      await this.sendPrompt(sessionId, text)
    } catch {
      // A missing conversation and a refused prompt share the retryable error state.
      failed = true
    }
    if (this.disposed) return
    this.state.update((state) => {
      if (failed) state[sessionId] = 'error'
      else Reflect.deleteProperty(state, sessionId)
    })
  }
}
