/**
 * Captures workspace checkpoints at session and settled-turn boundaries and
 * blocks model or top-level tool work while a workspace requires recovery.
 *
 * @module @deepseek-ai/dsh-workspace-checkpoint-capture
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  WorkspaceCheckpointError,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointId,
  CheckpointTurnOutcome,
} from '@deepseek-ai/dsh-workspace-checkpoint'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'workspace-checkpoint-capture'

/** Services used by turn capture and recovery admission. */
export const inject = ['workspaceCheckpoint', 'sessions', 'llm', 'tools']

/** Map the durable turn ending vocabulary to checkpoint metadata. */
function checkpointOutcome(reason: TurnEndReason): CheckpointTurnOutcome {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'cancelled'
    case 'interrupted':
      return 'interrupted'
    case 'blocked':
    case 'error':
    case 'max-tokens':
      return 'failed'
    default:
      // Session turn reasons are merge-extensible. An unknown ending is not
      // safe to treat as a successful workspace boundary.
      return 'failed'
  }
}

/** Find the latest ready, non-emergency checkpoint suitable as a parent. */
async function latestParent(ctx: Context, session: Session): Promise<CheckpointId | undefined> {
  const checkpoints = await ctx.workspaceCheckpoint.list(session.id)
  return [...checkpoints]
    .reverse()
    .find(checkpoint => checkpoint.role !== 'emergency'
      && checkpoint.status.kind === 'ready'
      && checkpoint.restoreEligible)?.id
}

/** Capture one boundary without allowing provider failure to affect the session log. */
async function captureBoundary(
  ctx: Context,
  request: CaptureRequest,
): Promise<void> {
  try {
    await ctx.workspaceCheckpoint.capture(request)
  } catch (error: unknown) {
    // Session append and agent progress are already committed. Providers are
    // expected to persist unavailable records; a storage outage itself cannot
    // be converted into another durable write here.
    ctx.logger.warn(
      `workspace checkpoint capture failed for session "${request.sessionId}": ${String(error)}`,
    )
  }
}

/** Capture initial and turn checkpoints in order for one session. */
function scheduleCapture(
  ctx: Context,
  tails: WeakMap<Session, Promise<void>>,
  session: Session,
  job: () => Promise<void>,
): void {
  const run = async (): Promise<void> => {
    if (!ctx.workspaceCheckpoint.enabled) return
    await job()
  }
  const previous = tails.get(session) ?? Promise.resolve()
  const next = previous.then(run, run)
  tails.set(session, next)
  void next.catch((error: unknown) => {
    ctx.logger.warn(
      `workspace checkpoint capture scheduling failed for session "${session.id}": ${String(error)}`,
    )
  })
}

/** Check the workspace admission flag for one session. */
async function assertRecoveryCleared(ctx: Context, session: Session): Promise<void> {
  const cwd = session.header.cwd
  if (cwd === undefined) return
  const reason = await ctx.workspaceCheckpoint.recoveryRequired(cwd)
  if (reason !== undefined) {
    throw new WorkspaceCheckpointError(
      `workspace requires recovery: ${reason}`,
      'CHECKPOINT_RECOVERY_REQUIRED',
    )
  }
}

/** Wrap an LLM request so recovery is checked before the adapter is reached. */
function guardedStream(
  ctx: Context,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    if (ctx.workspaceCheckpoint.enabled && options.sessionId !== undefined) {
      const session = ctx.sessions.get(options.sessionId)
      if (session !== undefined) await assertRecoveryCleared(ctx, session)
    }
    yield* next()
  })()
}

/** Install session capture listeners and the model/tool recovery guard. */
export function apply(ctx: Context): void {
  const tails = new WeakMap<Session, Promise<void>>()

  ctx.on('session/created', (session) => {
    const cwd = session.header.cwd
    if (!ctx.workspaceCheckpoint.enabled) return
    // Seeded sessions are resumed or forked logs. Their existing checkpoint
    // lineage owns boundary -1; capturing the current tree again would attach
    // a post-history tree to Checkpoint 0.
    if (cwd === undefined || session.firstLiveSeq > 0 || session.snapshotEvents().at(-1)?.type === 'session/end-seed') return
    scheduleCapture(ctx, tails, session, () => captureBoundary(ctx, {
      sessionId: session.id,
      cwd,
      boundarySeq: -1,
      role: 'initial',
      turnOutcome: 'initial',
    }))
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || !ctx.workspaceCheckpoint.enabled) return
    void (async (): Promise<void> => {
      await ctx.sessions.flush(session)
      const cwd = session.header.cwd
      if (cwd === undefined) return
      scheduleCapture(ctx, tails, session, async () => {
        const parentCheckpointId = await latestParent(ctx, session)
        await captureBoundary(ctx, {
          sessionId: session.id,
          cwd,
          boundarySeq: event.seq,
          ...parentCheckpointId === undefined ? {} : { parentCheckpointId },
          role: 'turn',
          turnOutcome: checkpointOutcome(event.data.reason),
        })
      })
    })().catch((error: unknown) => {
      ctx.logger.warn(
        `workspace checkpoint turn boundary failed for session "${session.id}": ${String(error)}`,
      )
    })
  }, { global: true })

  ctx.on('llm/stream', (options, next) => guardedStream(ctx, options, next))

  ctx.on('tools/execute', async (
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    if (exec.agent === undefined || exec.parent !== undefined || !ctx.workspaceCheckpoint.enabled) return next()
    await assertRecoveryCleared(ctx, exec.agent.session)
    return next()
  })
}
