---
description: "Workspace-file checkpoint service for session turns: capture, list, inspect, restore, lease, recovery flags, and retention behind ctx.workspaceCheckpoint."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-checkpoint

English | [中文](README.zh.md)

## Summary

Use this service to save the session working directory at turn boundaries, list and inspect those snapshots, and restore the files after a bad turn or a conversation edit. Checkpoints cover workspace files only: they do not flush the session log, never enter model history, and do not undo network, database, or terminal effects. A failed capture leaves the completed turn intact, and a failed restore blocks new model work until recovery succeeds. The feature stays disabled until a provider such as `dsh-workspace-checkpoint-local` enables it.

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

Code that needs workspace checkpoints calls `ctx.workspaceCheckpoint`; a composition supplies it by loading a provider and the capture consumer.

### When to choose it

Choose the capability when users must roll the session cwd back to a turn boundary, or edit an earlier message and continue from the matching file state. It does not flush the session log; that remains [`session-checkpoint-policy`](../session-checkpoint-policy/). The abstract service is not a Loader entry: compose `dsh-workspace-checkpoint-local` as the provider and `dsh-workspace-checkpoint-capture` as the consumer.

### Capability roles

This package owns the Service Definition role of the workspace-checkpoint capability:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-workspace-checkpoint` (this) | Service Definition: abstract service, branded ids, domain spec |
| `@deepseek-ai/dsh-workspace-checkpoint-local` | Service Provider: Harness-home object store and journaled restore |
| `@deepseek-ai/dsh-workspace-checkpoint-capture` | Consumer: initial and per-`turn/end` capture, recovery-required guard |

### Checkpoint metadata

Checkpoint metadata is not a `SessionEvent` and never enters the system prompt or derived model history. `Checkpoint 0` uses `boundarySeq: -1` for the workspace before the first turn. The durable session sidecar links a selected boundary checkpoint, an emergency checkpoint, and the child session created by an edit; the relation is separate from the append-only conversation log.

### Service API (`ctx.workspaceCheckpoint`)

| Member | Semantics |
|---|---|
| `enabled` | Live feature flag. Providers default to `false`; when disabled, automatic capture and recovery admission are bypassed and Host edit/activation is refused. Existing metadata remains readable. |
| `capture(request)` | Snapshot the session cwd. Capture is fail-soft: an unavailable record does not erase a completed turn. A caller holding the workspace lease may include it in the request for a multi-step operation. |
| `inspect(id)` | Return one durable record, or throw `CHECKPOINT_NOT_FOUND`. |
| `list(sessionId)` | Client-safe views in label order, with no blob internals. |
| `sessionIndex(sessionId)` | Durable session sidecar row used by Host activation and projections; `undefined` from a provider without a metadata index. |
| `restore(request)` | Make `cwd` match the manifest, or roll back. Fail-closed after the first filesystem mutation. |
| `recordEdit(link)` | Persist the source/boundary/selected/emergency/child relation after a branch is published. |
| `acquireLease(workspaceKey)` | Exclusive in-process lease; throws `CHECKPOINT_LEASE_HELD` when held. |
| `recoveryRequired(workspaceKey)` | Durable diagnostic, or `undefined` when the workspace is writable. |
| `markRecoveryRequired` / `clearRecoveryRequired` | Block or re-enable model work after a rollback failure. |
| `evict()` | Apply retention without silently dropping blobs required by an applied branch. |

Implementations subclass `WorkspaceCheckpoint` and load as the `workspaceCheckpoint` service. Restore claims workspace-file restoration only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the Service Definition fixes for every provider; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package fixes the vocabulary that providers, consumers, and the Host share: the abstract service, the branded `CheckpointId`, the `workspace_checkpoint` storage-domain spec with its stored-row schemas, and the closed `WorkspaceCheckpointError` code set. It also declares the `workspace-checkpoint` settings namespace, whose `enabled` field defaults to `false`; the base `enabled` getter returns `false`, so a provider that does not expose the setting stays disabled. Providers emit `workspace-checkpoint/changed` with the session id whenever durable metadata or a workspace association changes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Abstract service, settings namespace and schema, `workspace-checkpoint/changed` event |
| [`src/types.ts`](src/types.ts) | Requests, records, client views, manifest entries, lease, branded `CheckpointId` |
| [`src/spec.ts`](src/spec.ts) | `workspace_checkpoint` storage-domain spec and stored-row schemas |
| [`src/error.ts`](src/error.ts) | `WorkspaceCheckpointError` and its closed code set |
| — | No runtime invariant companion is published; this Service Definition owns no mutable store, and the local provider registers the executable checks for the checkpoint relations it persists. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the service contract is not enough. They move from the provider and consumer to the generated reference and the design record.

- [Local provider](../workspace-checkpoint-local/README.md) — the Harness-home object store, retention, and journaled restore.
- [Capture consumer](../workspace-checkpoint-capture/README.md) — turn-boundary capture and the recovery-required dispatch guard.
- [Session subsystem reference](../../../docs/subsystems/session.md#ctxworkspacecheckpoint--workspacecheckpoint-abstract-seam) — the generated `ctx.workspaceCheckpoint` API and `workspace-checkpoint/*` events.
- [Session durability checkpoints](../session-checkpoint-policy/README.md) — the separate session-log flush policy.
- [Conversation edit checkpoints note](../../../.agents/notes/implemented/feature/2026-08-20-conversation-edit-checkpoints.md) — the design decision behind turn-bound workspace checkpoints.

-----

<a id="model-experience"></a>
## Model Experience

None, as this trusted checkpoint service registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what a workspace checkpoint can and cannot reconstruct.

- **Metadata is not a session event** — lineage for model history stays on the existing session fork/seed prefix; this sidecar cannot reconstruct conversation text by itself.
- **Restore covers the session cwd only** — network, database, terminal, and ignored-external effects are out of scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
