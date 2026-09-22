/**
 * Bundled `i-have-adhd` skill provider.
 *
 * Skill body vendored from https://github.com/ayghri/i-have-adhd (MIT) at
 * commit 4092de07ce3ed88389d77c0d623b7af89b40ac0e; the upstream frontmatter
 * description and `disable-model-invocation: true` policy are repeated below
 * so the catalog entry matches the source without parsing frontmatter at
 * runtime.
 *
 * @module @deepseek-ai/dsh-skill-i-have-adhd
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'i-have-adhd'
const SKILL_BODY_URL = new URL('../assets/i-have-adhd.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: false, userInvocable: true } as const
const DESCRIPTION = 'Shape output for a reader with ADHD: lead with the next action, number multi-step work, restate state across turns, suppress tangents, give specific time estimates, make wins visible. Invoke with /i-have-adhd; stays on until "stop adhd mode".'
const CANDIDATE: SkillCandidate = {
  name: 'i-have-adhd',
  description: DESCRIPTION,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-i-have-adhd'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled `i-have-adhd` provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
