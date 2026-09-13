---
description: "Settings-driven MCP fleet manager for deployments and maintainers configuring MCP servers without editing cordis.yml."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

English | [中文](README.zh.md)

## Summary

`dsh-mcp-manager` mounts one `@deepseek-ai/dsh-mcp-client` child per enabled entry in the `mcp` settings section, so operators configure MCP servers from `settings.yaml` or the Plugins settings card instead of editing `cordis.yml`. The manager itself ships dormant with zero servers; the settings dict key is the server name and namespaces that server's tools as `mcp__<serverName>__<tool>`. Direct `dsh-mcp-client` rows remain supported for deployment-pinned servers.

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

Add `dsh-mcp-manager` when MCP servers should be user-configurable at runtime. One settings entry per server is the entire setup: pick a server name, choose a transport, and the server's tools appear as `mcp__<serverName>__<tool>`.

### Minimal configuration

Mount the manager once (the `dsh-base` bundle already does), then describe servers in the `mcp:` settings section:

```yaml
# settings.yaml
mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: ghp_example
    web:
      transport: streamable-http
      url: http://localhost:3000/mcp
```

| Field | Default | Meaning |
|---|---|---|
| `servers` | `{}` | Fleet keyed by server name; the key namespaces tools and must match `[A-Za-z0-9_-]{1,32}` |
| `servers.<name>.enabled` | `true` | `false` keeps the configuration but mounts nothing |
| `transport` | required | `stdio` or `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio: executable, arguments, extra env over scrubbed ambient env, working directory |
| `url` / `headers` | — | streamable-http: endpoint URL and extra request headers |
| `toolCallTimeoutMs` | `60,000` | Timeout per `tools/call` invocation |
| `failOnStartupError` | `false` | Reject the child activation when the initial connection fails |
| `reconnect.*` | `true` / `500` / `30,000` / `10` | Automatic reconnect policy after a lost connection |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) is the exhaustive source for every accepted field.

`env` and `headers` are stored in plain text in the settings document and are visible to configuration surfaces. Do not store production secrets here when the credentials store is available; prefer a deployment-pinned `dsh-mcp-client` row with `!!js process.env.*` for secret-bearing servers.

Disabling is the removal path for deployment-base servers: the settings merge cannot delete a composition key, so set `enabled: false` instead of deleting the entry. `replace({})` re-inherits the composition entry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the fleet and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **The dict key is the identity.** The settings key supplies `serverName`, so one name has one entry by construction and no entry can disagree with its key about what it is called.
- **Validate at the write, sync after the commit.** An illegal server name refuses the settings write through `validate`; field errors refuse through the schema. Sync only mounts schema-valid entries, so a refused entry keeps the previous generation serving.
- **One child per enabled entry.** Disabled entries mount nothing. Removals dispose first; additions and changed entries validate through the client schema before replacing the previous child.
- **Bursts serialize.** Settings bursts queue behind one reconciliation chain so a dispose and a remount of the same server never interleave.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `mcp` settings section, fleet reconciliation, child lifecycle |

### Lifecycle and sync

`apply` keeps the composition entry as the current source, installs the `mcp` section when a settings service exists, and schedules one reconciliation per change. Reconciliation diffs desired enabled entries against live children with `deepEqualJson`, disposes stale children, validates additions through `McpClient.Config`, then mounts them with `ctx.plugin`. Child fibers belong to the manager fiber, so manager disposal disposes the fleet. Mount failures log loudly and leave that server unmounted; other servers keep serving.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the bridged tools to the fleet's design evidence and worked example configurations.

- [MCP client bridge](../mcp-client/README.md) — one server's connection, naming, execution, and reconnection contract.
- [MCP group](../README.md) — the two packages of the MCP group and their roles.
- [Third-party memory MCP guide](../../../docs/user/guide/mcp-memory.md) — overlay rows that the same server entries now express as settings.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-manager) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through managed `dsh-mcp-client` children, which own any model-facing tools and results; the manager registers nothing model-facing itself.

#### KV Cache effect

No direct invalidation; a managed child that folds its tools into the request prefix owns that change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what you cannot do with this package and when it needs operational attention. They are current package constraints, not a comparison with other MCP clients or a task backlog.

- **Settings values are plain text** — `env` and `headers` ride the settings document and the redacted describe path verbatim. There is no credential reference or secret role on fleet entries; secret-bearing servers belong in deployment-pinned client rows.
- **Deployment-base servers disable, not delete** — the settings layer merges over the composition base per server, so a base server is removed by `enabled: false`, not by deleting its key.
- **One failed server never blocks its siblings** — a refused or failed mount logs and leaves that server unmounted while the rest of the fleet keeps serving.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

- Credential references (`apiKeyEnv`-style) for fleet `env`/`headers` are the deferred answer to plain-text secrets; they need a per-server reference vocabulary the settings card can render.
- A fail-closed secret role on `env`/`headers` dict values is deferred for the same reason the settings redaction limitation is deferred: the walker must prove every secret path before a wire surface can hide it.

</details>
