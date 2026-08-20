# @deepseek-ai/dsh-workspace-checkpoint

English | [中文](README.zh.md)

The **`WorkspaceCheckpoint`** service (`ctx.workspaceCheckpoint`) defines capture, inspection, restore, lease, and retention for workspace-file checkpoints bound to session turns. It does not flush the session log — that remains [`session-checkpoint-policy`](../session-checkpoint-policy/).

This package owns the Service Definition role of the workspace-checkpoint capability:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-workspace-checkpoint` (this) | Service Definition: abstract service, branded ids, domain spec |
| `@deepseek-ai/dsh-workspace-checkpoint-local` | Service Provider: Harness-home object store and journaled restore |
| `@deepseek-ai/dsh-workspace-checkpoint-capture` | Consumer: initial and per-`turn/end` capture, recovery-required guard |

Checkpoint metadata is not a `SessionEvent` and never enters the system prompt or derived model history. `Checkpoint 0` uses `boundarySeq: -1` for the workspace before the first turn. The durable session sidecar links a selected boundary checkpoint, an emergency checkpoint, and the child session created by an edit; the relation is separate from the append-only conversation log.

## Service API (`ctx.workspaceCheckpoint`)

| Member | Semantics |
|---|---|
| `enabled` | Live feature flag. Providers default to `false`; when disabled, automatic capture and recovery admission are bypassed and Host edit/activation is refused. Existing metadata remains readable. |
| `capture(request)` | Snapshot the session cwd. Capture is fail-soft: an unavailable record does not erase a completed turn. A caller holding the workspace lease may include it in the request for a multi-step operation. |
| `inspect(id)` | Return one durable record, or throw `CHECKPOINT_NOT_FOUND`. |
| `list(sessionId)` | Client-safe views in label order, with no blob internals. |
| `restore(request)` | Make `cwd` match the manifest, or roll back. Fail-closed after the first filesystem mutation. |
| `recordEdit(link)` | Persist the source/boundary/selected/emergency/child relation after a branch is published. |
| `acquireLease(workspaceKey)` | Exclusive in-process lease; throws `CHECKPOINT_LEASE_HELD` when held. |
| `recoveryRequired(workspaceKey)` | Durable diagnostic, or `undefined` when the workspace is writable. |
| `markRecoveryRequired` / `clearRecoveryRequired` | Block or re-enable model work after a rollback failure. |
| `evict()` | Apply retention without silently dropping blobs required by an applied branch. |

Implementations subclass `WorkspaceCheckpoint` and load as the `workspaceCheckpoint` service. Restore claims workspace-file restoration only.

## Model Experience

None, as this trusted checkpoint service registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Metadata is not a session event** — lineage for model history stays on the existing session fork/seed prefix; this sidecar cannot reconstruct conversation text by itself.
- **Restore covers the session cwd only** — network, database, terminal, and ignored-external effects are out of scope.
