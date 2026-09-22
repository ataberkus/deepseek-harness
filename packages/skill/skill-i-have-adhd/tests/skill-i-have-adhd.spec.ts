import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillIHaveAdhd from '@deepseek-ai/dsh-skill-i-have-adhd'

describe('dsh-skill-i-have-adhd', () => {
  it('registers and disposes the bundled i-have-adhd skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillIHaveAdhd)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'i-have-adhd',
      description: 'Shape output for a reader with ADHD: lead with the next action, number multi-step work, restate state across turns, suppress tangents, give specific time estimates, make wins visible. Invoke with /i-have-adhd; stays on until "stop adhd mode".',
      invocation: { modelInvocable: false, userInvocable: true },
      provider: 'i-have-adhd',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('i-have-adhd')
    expect(loaded?.content).toContain('The reader has ADHD')
    expect(loaded?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })
})
