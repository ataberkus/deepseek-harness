---
description: "Local workspace-checkpoint provider: Harness-home content-addressed object store, byte cap, exclusion globs, journaled restore, retention, and recovery flags."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-checkpoint-local

English | [中文](README.zh.md)

## Summary

Use this provider to keep workspace checkpoints on the local machine: file bytes go into a content-addressed object store under Harness home, and checkpoint metadata goes into the `workspace_checkpoint` storage domain. Restores are journaled, so a partial failure rolls back, and a failed rollback blocks new model work until a usable checkpoint is restored. You set a byte cap and exclusion globs; a capture past the cap records an unavailable checkpoint instead of failing the turn. The feature stays off until `enabled` or the Web Plugins dashboard turns it on.

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

Local Service Provider for [`workspace-checkpoint`](../workspace-checkpoint/); it loads as `ctx.workspaceCheckpoint` and needs explicit capture limits in its `cordis.yml` row.

### When to choose it

Choose it when the Host and the session cwd share one machine and checkpoint storage can live under Harness home. It is the only shipped provider of the capability; load `dsh-workspace-checkpoint-capture` beside it for automatic capture and the recovery guard.

### Minimal configuration

Compose this provider with `storage`, `storage-json`, and `storage-domain` (`backend: 'json'`). The Web bundle mounts it with these values:

```yaml
- id: workspace-checkpoint
  name: '@deepseek-ai/dsh-workspace-checkpoint-local'
  config:
    enabled: false
    maxTotalBytes: 1073741824
    excludeGlobs:
      - '**/.git/**'
      - '**/node_modules/**'
      - '**/processhacker_audit.log'
    captureRetryCount: 3
    captureRetryDelayMs: 50
```

| Config | Required | Semantics |
|---|---|---|
| `enabled` | no | Enables automatic capture, recovery admission, and conversation edit/activation. Defaults to `false`; the live `workspace-checkpoint` settings namespace can override it from the Web Plugins dashboard. |
| `objectRoot` | no | Object-store directory. Default `{dshHome}/workspace-checkpoints`. |
| `dshHome` | no | Harness-home override used only when `objectRoot` is omitted. |
| `maxTotalBytes` | yes | Capture that would grow the blob store past this cap persists an unavailable record and keeps prior checkpoints. |
| `excludeGlobs` | yes | Slash-separated globs skipped by capture and restore planning (`path.matchesGlob`); those paths stay on disk. |
| `captureRetryCount` | yes | Extra `buildManifest` attempts after `CHECKPOINT_CONCURRENT_WRITE`. |
| `captureRetryDelayMs` | yes | Delay between those retries. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-workspace-checkpoint-local) is the exhaustive source for every accepted field.

### Capture, restore, and retention

Capture stores regular file bytes in the content-addressed object store and keeps checkpoint metadata in the `workspace_checkpoint` storage domain. Walking uses `lstat` and does not follow symlinks. Restore uses a journal and a backup of the current tree to roll back partial filesystem mutations; recovery flags block new model work until a usable checkpoint is restored. A capture request carrying the matching lease runs inside the caller's multi-step lease instead of waiting for that lease to be released. Retention preserves applied and emergency chains, and `recordEdit` persists the source/child branch relation in both session sidecars.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider orders and stores work; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The provider serializes capture, restore, and eviction through one in-process queue, and a per-workspace lease table keeps a Host-held lease and internal operations from overlapping on one canonical cwd. Capture walks the cwd into a sorted manifest, writes missing blobs by content hash, and stores the record and the session index in the storage domain; a concurrent write during the walk triggers the configured retries. Restore verifies blob hashes, stages the target tree, backs up the current tree, and writes the planned operations to a journal before it mutates the cwd; a failure after the first mutation rolls back from the journal and backup, and a failed rollback marks the workspace as requiring recovery. Every durable metadata change emits `workspace-checkpoint/changed`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `LocalWorkspaceCheckpoint` service: settings section, operation queue, lease checks, recovery flags, `recordEdit` |
| [`src/config.ts`](src/config.ts) | Plugin `Config` schema |
| [`src/manifest.ts`](src/manifest.ts) | `lstat` walk into a cwd-relative manifest and concurrent-write detection |
| [`src/store.ts`](src/store.ts) | Capture, inspection, listing, and session-index persistence |
| [`src/objects.ts`](src/objects.ts) and [`src/hash.ts`](src/hash.ts) | Content-addressed blob store and hashing |
| [`src/restore.ts`](src/restore.ts) and [`src/journal.ts`](src/journal.ts) | Journaled restore and rollback |
| [`src/retention.ts`](src/retention.ts) | Byte-cap eviction that keeps applied and emergency chains |
| [`src/lease.ts`](src/lease.ts) and [`src/paths.ts`](src/paths.ts) | Per-workspace lease table and cwd canonicalization and containment |
| [`src/invariant.ts`](src/invariant.ts) | `./invariant` companion: on each `workspace-checkpoint/changed`, checks parent, applied, emergency, and edit relations |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the provider contract is not enough. They move from the service it implements to the consumer and storage it depends on.

- [Workspace checkpoint service](../workspace-checkpoint/README.md) — the `ctx.workspaceCheckpoint` contract and checkpoint metadata.
- [Capture consumer](../workspace-checkpoint-capture/README.md) — turn-boundary capture and the recovery-required dispatch guard.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-workspace-checkpoint-local) — the generated `Config` reference.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this trusted checkpoint provider registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the local provider's restore guarantee stops.

- **Restore covers the session cwd only** — network, database, terminal, and ignored-external effects are out of scope.
- **Capture is fail-soft** — an unavailable record does not erase a completed turn; the Host must not offer automatic restore for that checkpoint.
- **The local invariant companion is event-driven** — existing malformed relations are reported when the next checkpoint change is emitted; storage schema validation still rejects malformed rows while opening the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
