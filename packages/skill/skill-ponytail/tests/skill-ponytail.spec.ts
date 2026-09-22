import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillPonytail from '@deepseek-ai/dsh-skill-ponytail'

const EXPECTED_BODY_MARKERS: Readonly<Record<string, string>> = {
  'ponytail': 'You are a lazy senior developer',
  'ponytail-review': 'Review diffs for unnecessary complexity',
  'ponytail-audit': 'ponytail-review, repo-wide',
  'ponytail-debt': "can't quietly become permanent",
  'ponytail-gain': '# Ponytail Gain',
  'ponytail-help': '# Ponytail Help',
}

describe('dsh-skill-ponytail', () => {
  it('registers and disposes the six bundled ponytail skills', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillPonytail)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    const listed = await ctx.skills.list()
    expect(listed.map(skill => skill.name)).toEqual([
      'ponytail',
      'ponytail-audit',
      'ponytail-debt',
      'ponytail-gain',
      'ponytail-help',
      'ponytail-review',
    ])
    for (const skill of listed) {
      expect(skill.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      expect(skill.provider).toBe('ponytail')
      expect(skill.source).toBe('bundled')
      expect(skill.resourceBase).toEqual({ kind: 'directory', path: resourcePath })
      expect(skill.description.length).toBeGreaterThan(0)
    }
    expect(listed.find(skill => skill.name === 'ponytail')?.description).toContain('laziest solution')

    for (const [skillName, marker] of Object.entries(EXPECTED_BODY_MARKERS)) {
      const loaded = await ctx.skills.get(skillName)
      expect(loaded?.content).toContain(marker)
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })
    }

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })
})
