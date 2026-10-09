import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import WorkspaceCheckpoint from '../src/index.ts'

/** Provider that implements only the abstract operations, inheriting every default. */
class BareProvider extends WorkspaceCheckpoint {
  capture(): never { throw new Error('unused') }
  inspect(): never { throw new Error('unused') }
  list(): Promise<never[]> { return Promise.resolve([]) }
  restore(): never { throw new Error('unused') }
  recordEdit(): Promise<void> { return Promise.resolve() }
  acquireLease(): never { throw new Error('unused') }
  recoveryRequired(): Promise<undefined> { return Promise.resolve(undefined) }
  markRecoveryRequired(): Promise<void> { return Promise.resolve() }
  clearRecoveryRequired(): Promise<void> { return Promise.resolve() }
  evict(): Promise<void> { return Promise.resolve() }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('WorkspaceCheckpoint defaults', () => {
  it('stays disabled and exposes no session index for a provider that overrides neither', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(BareProvider)

    expect(ctx.workspaceCheckpoint.enabled).toBe(false)
    expect(ctx.workspaceCheckpoint.sessionIndex(SessionId('s1'))).toBeUndefined()
  })
})
