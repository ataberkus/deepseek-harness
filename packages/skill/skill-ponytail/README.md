---
description: "The bundled ponytail skill provider for users and maintainers enabling, using, or debugging the optional lazy-senior-dev skills."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-ponytail

English | [中文](README.zh.md)

## Summary

Agents can load the six `ponytail` skills from this bundled provider and follow their instructions to write only the code the task needs: the persistent lazy-senior-dev mode plus one-shot review, audit, debt-ledger, impact-scoreboard, and help skills. The provider has no configuration, and the shipped CLI composition includes the plugin disabled, so deployments enable it explicitly. The skill bodies are vendored from the upstream `ponytail` project (MIT); this package carries no lifecycle hooks or mode persistence, so the mode applies only when a skill is loaded.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the plugin to make the `ponytail` skills available in the session skill catalog; the model can then load them like any other skill and follow their instructions for minimal-diff coding.

### When to choose it

Choose this provider when coding work should stop at the first sufficient solution — skip unneeded work, reuse codebase helpers, prefer stdlib and native platform features over new dependencies, and write the shortest diff that works — without storing skill files in a local skill directory. Skip it when coding style needs no shaping — the plugin is disabled by default and adds nothing until enabled.

### Enable the plugin

The plugin has no configuration. Add its composition row to a composition; the shipped CLI composition carries the row as `disabled: true`, so enable it explicitly there.

```yaml
- name: '@deepseek-ai/dsh-skill-ponytail'
```

After enabling, the six skills appear in the available skills of the session catalog, and `/name` invokes each one through the user-explicit gesture.

### What the ponytail skills provide

- **`ponytail`.** The persistent lazy-senior-dev mode: the seven-rung ladder (YAGNI, reuse, stdlib, native, installed dependency, one line, minimum code) with lite/full/ultra intensity levels.
- **`ponytail-review`.** One-line-per-finding over-engineering review of the current diff, ending in a net-lines score.
- **`ponytail-audit`.** Whole-repo over-engineering audit ranked biggest cut first.
- **`ponytail-debt`.** Harvest of `ponytail:` shortcut comments into a tracked debt ledger.
- **`ponytail-gain`.** The published benchmark scoreboard: less code, less cost, more speed.
- **`ponytail-help`.** The quick-reference card for levels, skills, and deactivation.

### Observable success and failures

Enabling the plugin makes all six skills appear in the catalog and loadable by name; disabling or omitting the row keeps them out of every catalog. Because the provider is immutable, discovery always succeeds with exactly six skills and never reports partial results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bundled provider is wired; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is an immutable, synchronously registered skill source: it registers six fixed candidates at the bundled skill rank (600) under the provider name `ponytail`, exposes its packaged `assets/` directory as every skill's directory resource base, and reads each skill body from its packaged `assets/<name>.md` file on every load. Each candidate carries its body-file URL as its opaque locator, so loading follows the winning candidate without branching.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry and the immutable provider: six candidates, resource base, body load |
| — | No runtime invariant companion is published; the package owns one immutable provider registration, while the skill registry owns registration uniqueness and lifecycle checks. |
| [`assets/`](assets/) | Packaged skill bodies (`ponytail.md`, `ponytail-review.md`, `ponytail-audit.md`, `ponytail-debt.md`, `ponytail-gain.md`, `ponytail-help.md`) vendored from the upstream project |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry this provider registers on to how the skills reach the model.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider contract this provider implements.
- [skill package](../skill/README.md) — the registry the provider registers on, and the shared rendering of loaded skills.
- [tool-skill package](../tool-skill/README.md) — how the ponytail skills reach the session catalog and the model.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the provider's catalog entries and selected skill bodies to the model.

#### KV Cache effect

Disabled by default, the plugin changes no request. When enabled, its catalog entries and any loaded bodies change the provider KV prefix at their insertion points.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the bundled provider does not do. They are current package constraints, not a task backlog.

- **Fixed six skills, no runtime customization** — the provider contributes exactly the upstream `ponytail` skill set; deployments that need different intensity levels or review formats author their own skills instead.
- **No hook or always-on mode** — upstream hosts inject the ruleset through lifecycle hooks or mode flags; this package ships instruction bodies only, so the style applies per loaded skill rather than every turn.
- **Vendored bodies drift from upstream** — the packaged bodies are copies of the upstream skills at the pinned version recorded in the source; upstream fixes arrive only when this package re-vendors.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
