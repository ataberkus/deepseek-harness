---
description: "The bundled ADHD-friendly output-style skill for users and maintainers enabling, using, or debugging the optional i-have-adhd provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-i-have-adhd

English | [中文](README.zh.md)

## Summary

Agents can load the `i-have-adhd` skill from this bundled provider and follow its instructions to shape every response so a reader with ADHD can act on it: the next action first, numbered multi-step work, one concrete next step at the end, and no preamble, recaps, or closers. The provider has no configuration, and the shipped CLI composition includes the plugin disabled, so deployments enable it explicitly. The skill body is vendored from the upstream `i-have-adhd` project (MIT); this package carries no hooks or always-on mode, so the style applies only when the skill is loaded.

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

Enable the plugin to make the `i-have-adhd` skill available in the session skill catalog; the model can then load it like any other skill and follow its instructions for ADHD-friendly output.

### When to choose it

Choose this provider when responses should lead with the next action, number multi-step work, restate progress each turn, and suppress tangents and pleasantries, without storing a skill file in a local skill directory. Skip it when output style needs no shaping — the plugin is disabled by default and adds nothing until enabled.

### Enable the plugin

The plugin has no configuration. Add its composition row to a composition; the shipped CLI composition carries the row as `disabled: true`, so enable it explicitly there.

```yaml
- name: '@deepseek-ai/dsh-skill-i-have-adhd'
```

After enabling, `/i-have-adhd` invokes the skill through the user-explicit gesture (the skill is user-invocable but not model-invocable, matching the upstream `disable-model-invocation: true` policy), and its rules then stay on for that session until the user says "stop adhd mode" or "normal mode". The model catalog never advertises it, so the model cannot load it unprompted.

### What the i-have-adhd skill provides

- **Ten output rules.** Lead with the next action, number multi-step tasks, end with one concrete next step, suppress tangents, restate state every turn, give specific time estimates, make wins visible, keep errors matter-of-fact, cap lists to 5 items, and drop preambles, recaps, and closers.
- **Break conditions.** When to explain fully, confirm before destructive actions, stop a debug spiral, or ask one clarifying question instead.
- **A pre-send check.** Delete announcing openers, "anything else" closers, sidebars, empty hedges, and idioms before sending.

### Observable success and failures

Enabling the plugin makes `i-have-adhd` loadable by name through the user-explicit `/i-have-adhd` gesture; disabling or omitting the row keeps it out of every catalog. Because the provider is immutable, discovery always succeeds with exactly one skill and never reports partial results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the bundled provider is wired; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is an immutable, synchronously registered skill source: it registers one fixed candidate at the bundled skill rank (600) under the provider name `i-have-adhd`, exposes its packaged `assets/` directory as the skill's directory resource base, and reads the skill body from the packaged `assets/i-have-adhd.md` file on every load. Its invocation policy is user-only, mirroring the upstream `disable-model-invocation: true` frontmatter.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry and the immutable provider: one candidate, resource base, body load |
| — | No runtime invariant companion is published; the package owns one immutable provider registration, while the skill registry owns registration uniqueness and lifecycle checks. |
| [`assets/`](assets/) | Packaged skill body (`i-have-adhd.md`) vendored from the upstream project |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry this provider registers on to how the skill reaches the model.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider contract this provider implements.
- [skill package](../skill/README.md) — the registry the provider registers on, and the shared rendering of loaded skills.
- [tool-skill package](../tool-skill/README.md) — how skills reach the session catalog and the model, including the user-explicit gesture that is this skill's only entry point.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the provider's loaded skill body to the model when the user invokes it explicitly.

#### KV Cache effect

Disabled by default, the plugin changes no request. When enabled, its loaded body changes the provider KV prefix at its insertion point; the skill never appears in the model-facing catalog, so no catalog tokens are added.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the bundled provider does not do. They are current package constraints, not a task backlog.

- **One fixed skill, no runtime customization** — the provider contributes exactly the `i-have-adhd` skill; deployments that need different output rules author their own skill instead.
- **User-invoked only, never model-advertised** — the skill stays out of the model-facing catalog and loader by design, so the model cannot adopt the style without the user invoking `/i-have-adhd` first.
- **Vendored body drifts from upstream** — the packaged body is a copy of the upstream skill at the pinned commit recorded in the source; upstream fixes arrive only when this package re-vendors.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
