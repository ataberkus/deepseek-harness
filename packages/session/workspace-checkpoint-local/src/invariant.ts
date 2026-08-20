/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workspace-checkpoint-local`.
 * Every applied checkpoint must remain restore-eligible, or the session index
 * must carry `recoveryRequired`.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KvTable, Domain } from '@deepseek-ai/dsh-storage-domain'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  StoredCheckpointRecord, StoredSessionCheckpointIndex,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import { workspaceCheckpointDomainSpec } from '@deepseek-ai/dsh-workspace-checkpoint'

const PACKAGE_NAME = '@deepseek-ai/dsh-workspace-checkpoint-local'
type CheckpointDomain = Domain<typeof workspaceCheckpointDomainSpec>
type CheckpointTable = KvTable<CheckpointId, StoredCheckpointRecord>
type SessionTable = KvTable<SessionId, StoredSessionCheckpointIndex>

/** Cordis companion plugin name. */
export const name = 'workspace-checkpoint-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateRelations(
  ctx: Context,
  fail: InvariantFailure,
  triggerSessionId: SessionId,
): void {
  const domain = ctx.storageDomain.get('workspace_checkpoint') as CheckpointDomain | undefined
  if (domain === undefined) {
    fail(`workspace-checkpoint/changed for '${triggerSessionId}' emitted while the domain is not open`)
  }
  const checkpoints = domain.table('checkpoints')
  const sessions = domain.table('sessions')
  for (const [checkpointId, checkpoint] of checkpoints.entries()) {
    if (checkpoint.parentCheckpointId !== undefined
      && checkpoints.get(CheckpointId(checkpoint.parentCheckpointId)) === undefined) {
      fail(
        `checkpoint '${String(checkpointId)}' references missing parent '${checkpoint.parentCheckpointId}'`,
      )
    }
  }
  for (const [sessionId, index] of sessions.entries()) {
    validateSessionIndex(checkpoints, sessions, sessionId, index, fail)
  }
}

function validateSessionIndex(
  checkpoints: CheckpointTable,
  sessions: SessionTable,
  sessionId: SessionId,
  index: StoredSessionCheckpointIndex,
  fail: InvariantFailure,
): void {
  if (index.appliedCheckpointId !== undefined) {
    const applied = checkpoints.get(CheckpointId(index.appliedCheckpointId))
    const appliedIsReady = applied?.restoreEligible === true && applied.status.kind === 'ready'
    if (!appliedIsReady && index.recoveryRequired === undefined) {
      fail(
        `session '${sessionId}' applies checkpoint '${index.appliedCheckpointId}' without recoveryRequired`,
      )
    }
  }
  if (index.emergencyCheckpointId !== undefined
    && checkpoints.get(CheckpointId(index.emergencyCheckpointId)) === undefined) {
    fail(
      `session '${sessionId}' references missing emergency checkpoint '${index.emergencyCheckpointId}'`,
    )
  }
  if (index.edit === undefined) return
  if (checkpoints.get(CheckpointId(index.edit.selectedCheckpointId)) === undefined) {
    fail(
      `session '${sessionId}' edit references missing selected checkpoint '${index.edit.selectedCheckpointId}'`,
    )
  }
  const emergency = checkpoints.get(CheckpointId(index.edit.emergencyCheckpointId))
  if (emergency === undefined || emergency.role !== 'emergency') {
    fail(
      `session '${sessionId}' edit references invalid emergency checkpoint '${index.edit.emergencyCheckpointId}'`,
    )
  }
  const child = sessions.get(index.edit.childSessionId as SessionId)
  if (child === undefined || child.edit?.childSessionId !== index.edit.childSessionId) {
    fail(
      `session '${sessionId}' edit publishes child '${index.edit.childSessionId}' without a matching child index`,
    )
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => {
    validateRelations(ctx, fail, sessionId)
  }, { global: true })
}, { inject: ['storageDomain'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
