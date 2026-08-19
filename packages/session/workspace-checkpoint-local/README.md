# @deepseek-ai/dsh-workspace-checkpoint-local

English | [中文](README.zh.md)

Local Service Provider for [`workspace-checkpoint`](../workspace-checkpoint/). It stores regular file bytes in a content-addressed object store under Harness home and keeps checkpoint metadata in the `workspace_checkpoint` storage domain. Walking uses `lstat` and does not follow symlinks.

## Plugin (namespace: `workspace-checkpoint-local`)

| Config | Required | Semantics |
|---|---|---|
| `objectRoot` | no | Object-store directory. Default `{dshHome}/workspace-checkpoints`. |
| `dshHome` | no | Harness-home override used only when `objectRoot` is omitted. |
| `maxTotalBytes` | yes | Capture that would grow the blob store past this cap persists an unavailable record and keeps prior checkpoints. |
| `excludeGlobs` | yes | Slash-separated globs skipped by the walker (`path.matchesGlob`). |
| `captureRetryCount` | yes | Extra `buildManifest` attempts after `CHECKPOINT_CONCURRENT_WRITE`. |
| `captureRetryDelayMs` | yes | Delay between those retries. |

Compose this provider with `storage`, `storage-json`, and `storage-domain` (`backend: 'json'`). Restore, durable recovery flags, and eviction complete the provider in follow-up tasks of the same family.

## Model Experience

None, as this trusted checkpoint provider registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Restore covers the session cwd only** — network, database, terminal, and ignored-external effects are out of scope.
- **Capture is fail-soft** — an unavailable record does not erase a completed turn; the Host must not offer automatic restore for that checkpoint.
