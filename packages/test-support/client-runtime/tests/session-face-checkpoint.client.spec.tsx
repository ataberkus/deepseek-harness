// @vitest-environment jsdom
/**
 * Fixture session face: the checkpoint commands (edit, retry, activate) fail
 * loudly until the fixture supplies them, so a feature spec cannot pass by
 * silently depending on an unstubbed Remote command.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'

afterEach(cleanup)

describe('fixture session face checkpoint commands', () => {
  it.each(['edit', 'retry', 'activate'] as const)(
    'names the unstubbed %s verb and the session that called it',
    async (verb) => {
      const runtime = await SlotTestRuntime.create()
      try {
        await runtime.sessions.add({ id: 'checkpoint-session' })
        const face = runtime.sessions.behavior('checkpoint-session')
        expect(() => face[verb]()).toThrow(
          `test session "checkpoint-session": ${verb} is not stubbed — supply it on the fixture's session face`,
        )
      } finally {
        await runtime.dispose()
      }
    },
  )
})
