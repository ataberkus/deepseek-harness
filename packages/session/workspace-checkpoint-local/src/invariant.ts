/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workspace-checkpoint-local`.
 * Every applied checkpoint must remain restore-eligible, or the session index
 * must carry `recoveryRequired`.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'

const PACKAGE_NAME = '@deepseek-ai/dsh-workspace-checkpoint-local'

/** Cordis companion plugin name. */
export const name = 'workspace-checkpoint-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('workspace-checkpoint/changed', (sessionId: SessionId) => {
    const domain = ctx.storageDomain.get('workspace_checkpoint')
    if (domain === undefined) {
      return fail(`workspace-checkpoint/changed for '${sessionId}' emitted while the domain is not open`)
    }
    const index = domain.table('sessions').get(sessionId) as { appliedCheckpointId?: string; recoveryRequired?: string } | undefined
    if (index?.appliedCheckpointId === undefined) return
    const record = domain.table('checkpoints').get(CheckpointId(index.appliedCheckpointId)) as { restoreEligible?: boolean } | undefined
    if (record?.restoreEligible === true) return
    if (index.recoveryRequired !== undefined) return
    return fail(`applied checkpoint '${index.appliedCheckpointId}' is not restore-eligible and recoveryRequired is unset`)
  }, { global: true })
}, { inject: ['storageDomain'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
