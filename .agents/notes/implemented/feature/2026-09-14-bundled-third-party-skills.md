# Agent Note: Bundled third-party skills

Status: implemented

English | [中文](2026-09-14-bundled-third-party-skills.zh.md)

## Problem

`dsh-skill-badge` is the only bundled skill provider, so deployments that want the popular third-party skill sets `i-have-adhd` (ADHD-friendly output style) and `ponytail` (lazy-senior-dev minimal-diff coding) must hand-copy upstream `SKILL.md` files into a local skill root with no version record, no composition gating, and no single owner for the upstream version. Hand copies also collide silently with user skills of the same name instead of resolving through provider ranks.

## Decision

Two immutable bundled providers under `packages/skill/` vendor the upstream bodies: `@deepseek-ai/dsh-skill-i-have-adhd` contributes the single `i-have-adhd` skill with a user-only invocation policy mirroring the upstream `disable-model-invocation: true` frontmatter, and `@deepseek-ai/dsh-skill-ponytail` contributes all six upstream skills (`ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`) as model- and user-invocable. Both register at `BUNDLED_SKILL_RANK` under their upstream provider names, expose `assets/` as the directory resource base, and read each body from `assets/<name>.md` on every load; the ponytail provider carries each body-file URL as the candidate locator so loading follows the winning candidate without branching.

### Vendoring

Each `assets/<name>.md` is the upstream `SKILL.md` body with frontmatter stripped; the frontmatter description and invocation policy live as constants in `src/index.ts` so the catalog matches upstream without runtime frontmatter parsing. The pinned upstream commit is recorded in the source header and the package README: `i-have-adhd` at `4092de07ce3ed88389d77c0d623b7af89b40ac0e`, `ponytail` at v4.10.0 (`e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`). Both projects are MIT-licensed. Re-vendoring means copying the new bodies, updating the description constants and pinned SHAs, and running the provider specs.

### Composition

Both plugins ship as `disabled: true` rows in the `dsh-base` bundle beside `skill-badge`, keeping opt-ins out of shipped defaults: no catalog entry, no snapshot, and no request change until a deployment enables them. Enabling `skill-i-have-adhd` exposes `/i-have-adhd` through the user-explicit gesture only (the model catalog never advertises it); enabling `skill-ponytail` lists all six skills in the session catalog.

## Alternatives considered

### Hand-copied filesystem skills

Rejected. Copies into project or user skill roots carry no upstream version, bypass composition gating, and lose provider-rank resolution against same-name skills. The bundled providers keep the upstream version, pinning, and enablement in one place.

### One combined package for both upstreams

Rejected. The two upstreams version independently and deserve independent attribution and re-vendoring; one package per upstream mirrors the source repositories and lets deployments enable exactly one set.

### Enabled by default in `dsh-base`

Rejected. Ponytail's six catalog entries and the ADHD output style would change every shipped session's catalog and model-visible guidance, violating the opt-ins-out-of-defaults rule the `skill-badge` row establishes. The requester chose opt-in bundling.

### Runtime frontmatter parsing or submodule

Rejected. Parsing frontmatter at load time adds a failure mode to an otherwise immutable provider, and a submodule adds network and checkout complexity. Vendored bodies keep the provider offline, branchless, and fully covered by the registry-level specs.

## Consequences

Enabling either row gives agents versioned third-party skills with no new services, config, or tools; the shipped defaults are byte-identical in behavior, so no recorded-session snapshot changes. The cost is maintainer re-vendoring when upstream fixes land, recorded as a Known Limitation in both package READMEs.

## Testing

Provider specs assert the exact catalog entries (names, descriptions, invocation, provider, source, resource base), body markers for all seven skills, and disposal emptiness. `SENTENCE_MODEL_EXPERIENCE` in `scripts/verify-package-readme-model-experience.ts` carries both packages as `indirect`, and the change runs the workspace constraints, typecheck, translation pairing, and `verify-cordis-config` gates.
