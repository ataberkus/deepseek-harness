---
description: "Automatic workspace checkpoint capture at session creation and every settled turn, plus a recovery-required guard on model and top-level tool dispatch."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-checkpoint-capture

English | [中文](README.zh.md)

## Summary

Load this plugin to record a workspace checkpoint when a session with a cwd starts and after every settled turn, so the Host can later restore files to any turn boundary. It also stops model and top-level tool dispatch while a workspace needs recovery after a failed restore. A capture failure is logged and never blocks the session log or the turn. Nothing runs until `ctx.workspaceCheckpoint.enabled` is true, so existing sessions and workspaces stay untouched by default.

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

`@deepseek-ai/dsh-workspace-checkpoint-capture` is the consumer for the workspace-checkpoint capability; mount it beside a provider and it captures and guards without further calls.

### When to choose it

Choose it with `dsh-workspace-checkpoint-local` whenever a composition offers workspace restore or conversation edits; without it, no checkpoints are captured and a workspace marked for recovery is not guarded. The Web bundle loads it after `dsh-workspace-checkpoint-local`; the abstract service definition is not a separate Loader row.

### Minimal configuration

The package has no configuration fields. It requires `ctx.workspaceCheckpoint`, `ctx.sessions`, `ctx.llm`, and `ctx.tools`:

```yaml
- id: workspace-checkpoint-capture
  name: '@deepseek-ai/dsh-workspace-checkpoint-capture'
```

### What gets captured

It captures Checkpoint 0 when a session with a cwd is created and captures one checkpoint after each settled `turn/end` while `ctx.workspaceCheckpoint.enabled` is true. The default-disabled provider therefore leaves existing sessions and workspaces untouched until the dashboard enables the feature. A resumed or forked session already owns its checkpoint lineage, so it receives no new Checkpoint 0.

The consumer flushes session persistence before reading a turn boundary, selects the latest ready, restore-eligible, non-emergency checkpoint as the next parent, and keeps capture failures out of the session append path.

### Recovery guard

It wraps `llm/stream` and top-level `tools/execute`; a workspace marked `recoveryRequired` receives no downstream model or tool dispatch until a restore consumer clears the flag. The guard rejects dispatch with `CHECKPOINT_RECOVERY_REQUIRED`. When disabled, those admission guards are bypassed while stored recovery diagnostics remain available to the Host.

### Turn outcomes

`completed` maps to `completed`, `aborted` to `cancelled`, `interrupted` to `interrupted`, and `error`, `max-tokens`, or `blocked` to `failed`.

Unknown merge-extensible turn endings fail closed as `failed`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the consumer schedules capture and admission; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The plugin is a listener-only consumer with one piece of state: a per-session promise chain that runs the initial capture and every turn capture in order. Each queued job re-reads `enabled` when it runs, so a feature toggle takes effect between captures. A `turn/end` listener flushes the session, then queues a capture whose parent is chosen from the provider's current checkpoint list; provider errors are caught and logged so they cannot reach the session append path. The admission guard reads the provider's recovery diagnostic for the session cwd before the LLM adapter stream starts and before a top-level tool body runs; nested tool dispatches are not checked again.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: capture listeners, per-session ordering, turn-outcome mapping, model and tool recovery guard |
| — | No runtime invariant companion is published; this consumer owns listener scheduling and fail-soft admission, while the provider owns the checkpoint record relations, so there is no separate relation to validate. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the consumer contract is not enough. They move from the service it consumes to the provider that stores checkpoints.

- [Workspace checkpoint service](../workspace-checkpoint/README.md) — the `ctx.workspaceCheckpoint` contract and checkpoint metadata.
- [Local provider](../workspace-checkpoint-local/README.md) — the Harness-home object store, retention, and journaled restore.
- [Session durability checkpoints](../session-checkpoint-policy/README.md) — the session-log flush policy that runs beside this consumer.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the consumer only captures workspace files and guards dispatch; it contributes no prompt, schema, tool, or message.

#### KV Cache effect

It does not alter the model request or cache prefix; it only rejects dispatch while recovery is required.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define which workspace states the consumer can capture and guard.

- Checkpoints cover files below the session cwd; external services, databases, terminals, and ignored paths are not restored.
- Capture serialization is process-local. A second process targeting the same cwd requires an external workspace lock.
- The consumer observes published session events; a session created before this plugin loads does not receive a new initial capture.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
