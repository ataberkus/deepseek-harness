# @deepseek-ai/dsh-workspace-checkpoint-local

English | [中文](README.zh.md)

Local Service Provider for [`workspace-checkpoint`](../workspace-checkpoint/). It stores regular file bytes in a content-addressed object store under Harness home and keeps checkpoint metadata in the `workspace_checkpoint` storage domain. Walking uses `lstat` and does not follow symlinks.

## Plugin (namespace: `workspace-checkpoint-local`)

| Config | Required | Semantics |
|---|---|---|
| `objectRoot` | no | Object-store directory. Default `{dshHome}/workspace-checkpoints`. |
| `dshHome` | no | Harness-home override used only when `objectRoot` is omitted. |
| `maxTotalBytes` | yes | Capture that would grow the blob store past this cap persists an unavailable record and keeps prior checkpoints. |
| `excludeGlobs` | yes | Slash-separated globs skipped by capture and restore planning (`path.matchesGlob`); those paths stay on disk. |
| `captureRetryCount` | yes | Extra `buildManifest` attempts after `CHECKPOINT_CONCURRENT_WRITE`. |
| `captureRetryDelayMs` | yes | Delay between those retries. |

Compose this provider with `storage`, `storage-json`, and `storage-domain` (`backend: 'json'`). Restore uses a journal and emergency snapshot to roll back partial filesystem mutations; recovery flags block new model work until a usable checkpoint is restored. A capture request carrying the matching lease runs inside the caller's multi-step lease instead of waiting for that lease to be released. Retention preserves applied and emergency chains, and `recordEdit` persists the source/child branch relation in both session sidecars.

## Model Experience

None, as this trusted checkpoint provider registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Restore covers the session cwd only** — network, database, terminal, and ignored-external effects are out of scope.
- **Capture is fail-soft** — an unavailable record does not erase a completed turn; the Host must not offer automatic restore for that checkpoint.
- **The local invariant companion is event-driven** — existing malformed relations are reported when the next checkpoint change is emitted; storage schema validation still rejects malformed rows while opening the domain.
