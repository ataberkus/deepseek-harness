# dsh-workspace-checkpoint-capture

English | [中文](README.zh.md)

`@deepseek-ai/dsh-workspace-checkpoint-capture` is the consumer for the workspace-checkpoint capability.

It captures Checkpoint 0 when a session with a cwd is created and captures one checkpoint after each settled `turn/end`.

The consumer flushes session persistence before reading a turn boundary, selects the latest ready non-emergency checkpoint as the next parent, and keeps capture failures out of the session append path.

It wraps `llm/stream` and top-level `tools/execute`; a workspace marked `recoveryRequired` receives no downstream model or tool dispatch until a restore consumer clears the flag.

## Composition

The package requires `ctx.workspaceCheckpoint`, `ctx.sessions`, `ctx.llm`, and `ctx.tools`.

The Web bundle loads it after `dsh-workspace-checkpoint-local`; the abstract service definition is not a separate Loader row.

## Turn outcomes

`completed` maps to `completed`, `aborted` to `cancelled`, `interrupted` to `interrupted`, and `error`, `max-tokens`, or `blocked` to `failed`.

Unknown merge-extensible turn endings fail closed as `failed`.

## Model Experience

None, as the consumer only captures workspace files and guards dispatch; it contributes no prompt, schema, tool, or message.

#### KV Cache effect

It does not alter the model request or cache prefix; it only rejects dispatch while recovery is required.

## Known Limitations and Deferred Work

- Checkpoints cover files below the session cwd; external services, databases, terminals, and ignored paths are not restored.
- Capture serialization is process-local. A second process targeting the same cwd requires an external workspace lock.
- The consumer observes published session events; a session created before this plugin loads does not receive a new initial capture.
