/**
 * Package-owned invariant companion for
 * `@deepseek-ai/dsh-workspace-checkpoint-capture`.
 *
 * @module @deepseek-ai/dsh-workspace-checkpoint-capture/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workspace-checkpoint-capture'

/** Cordis companion plugin name. */
export const name = 'workspace-checkpoint-capture-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the consumer owns listener scheduling and fail-soft
 * admission, while the provider owns checkpoint record relations. There is no
 * separate mutable relation for this companion to validate.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
