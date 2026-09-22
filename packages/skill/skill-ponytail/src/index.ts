/**
 * Bundled `ponytail` skill provider.
 *
 * Skill bodies vendored from https://github.com/DietrichGebert/ponytail (MIT)
 * at v4.10.0 (commit e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156); the upstream
 * frontmatter descriptions are repeated below so catalog entries match the
 * sources without parsing frontmatter at runtime.
 *
 * @module @deepseek-ai/dsh-skill-ponytail
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

const PROVIDER_NAME = 'ponytail'
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const SKILLS: readonly { readonly name: string; readonly description: string }[] = [
  {
    name: 'ponytail',
    description: 'Forces the laziest solution that actually works, simplest, shortest, most minimal. Channels a senior dev who has seen everything: question whether the task needs to exist at all (YAGNI), reach for the standard library before custom code, native platform features before dependencies, one line before fifty. Supports intensity levels: lite, full (default), ultra. Use on ANY coding task: writing, adding, refactoring, fixing, reviewing, or designing code, and choosing libraries or dependencies. Also use whenever the user says "ponytail", "be lazy", "lazy mode", "simplest solution", "minimal solution", "yagni", "do less", or "shortest path", or complains about over-engineering, bloat, boilerplate, or unnecessary dependencies. Do NOT use for non-coding requests (general knowledge, prose, translation, summaries, recipes).',
  },
  {
    name: 'ponytail-review',
    description: 'Code review focused exclusively on over-engineering. Finds what to delete: reinvented standard library, unneeded dependencies, speculative abstractions, dead flexibility. One line per finding: location, what to cut, what replaces it. Use when the user says "review for over-engineering", "what can we delete", "is this over-engineered", "simplify review", or invokes /ponytail-review. Complements correctness-focused review, this one only hunts complexity.',
  },
  {
    name: 'ponytail-audit',
    description: 'Whole-repo audit for over-engineering. Like ponytail-review, but scans the entire codebase instead of a diff: a ranked list of what to delete, simplify, or replace with stdlib/native equivalents. Use when the user says "audit this codebase", "audit for over-engineering", "what can I delete from this repo", "find bloat", "ponytail-audit", or "/ponytail-audit". One-shot report, does not apply fixes.',
  },
  {
    name: 'ponytail-debt',
    description: 'Harvest every `ponytail:` comment in the codebase into a debt ledger, so the deliberate shortcuts and deferrals ponytail leaves behind get tracked instead of rotting into "later means never". Use when the user says "ponytail debt", "/ponytail-debt", "what did ponytail defer", "list the shortcuts", "ponytail ledger", or "what did we mark to do later". One-shot report, changes nothing.',
  },
  {
    name: 'ponytail-gain',
    description: "Show ponytail's measured impact as a compact scoreboard: less code, less cost, more speed, from the benchmark medians. One-shot display, not a persistent mode, and not a per-repo number. Trigger: /ponytail-gain, \"ponytail gain\", \"what does ponytail save\", \"show ponytail impact\", \"ponytail scoreboard\".",
  },
  {
    name: 'ponytail-help',
    description: 'Quick-reference card for all ponytail modes, skills, and commands. One-shot display, not a persistent mode. Trigger: /ponytail-help, "ponytail help", "what ponytail commands", "how do I use ponytail".',
  },
]

const CANDIDATES: readonly SkillCandidate[] = SKILLS.map(skill => ({
  name: skill.name,
  description: skill.description,
  invocation: INVOCATION,
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: new URL(`../assets/${skill.name}.md`, import.meta.url),
}))

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([...CANDIDATES]),
  async get(candidate): Promise<SkillDefinition> {
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(candidate.locator as URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-ponytail'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled `ponytail` provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
