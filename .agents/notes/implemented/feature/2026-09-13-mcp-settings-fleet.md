# Agent Note: Settings-driven MCP fleet

Status: implemented

English | [中文](2026-09-13-mcp-settings-fleet.zh.md)

## Problem

MCP servers are one `cordis.yml` row per server. Each addition, URL rotation, or disable means editing the profile composition, which restarts or reloads the composition and is out of reach for operators who only have the settings document or the web Plugins page. The bridge itself (`dsh-mcp-client`) is per-server by design, so there is no user-configurable fleet address.

## Decision

### Fleet manager package

A single package `@deepseek-ai/dsh-mcp-manager` at `packages/mcp/mcp-manager/` owns the `mcp` settings section and mounts one `dsh-mcp-client` child per enabled entry. The settings dict key IS the server name: it namespaces tools as `mcp__<serverName>__<tool>` and must match `[A-Za-z0-9_-]{1,32}`. An entry carries `enabled` (default `true`) plus the transport fields the client bridge accepts minus `serverName`, which the manager injects from the key. `env` and `headers` are plain settings values by explicit choice; secret-bearing servers stay in deployment-pinned client rows.

Example section:

```yaml
mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
    web:
      transport: streamable-http
      url: http://localhost:3000/mcp
```

### Lifecycle

The manager mounts dormant with zero servers and is composed in `dsh-base`. It installs the section with the composition entry as `base`, watches the resolved value, and serializes reconciliations: removals and disables dispose first; additions and changed entries validate through `McpClient.Config` before replacing the previous child, so a refused entry keeps the previous generation serving. Child fibers belong to the manager fiber, so manager disposal disposes the fleet. Mount failures log loudly and leave that server unmounted while siblings keep serving.

Disabling is the removal path for deployment-base servers: the settings layer merges per server over the composition base, so a base server is removed with `enabled: false`, not by deleting its key.

### Browser card

The Plugins section ships an MCP card keyed on the `mcp` namespace. The card stages the whole `servers` map (toggles, removals, additions) and persists it as one revision-fenced `mutate`, so a stale editor conflicts instead of overwriting. The add form covers the common fields (name, transport, command plus newline-separated args, URL); timeouts, environment, headers, and reconnect tuning live in `settings.yaml`.

## Alternatives considered

### Per-server settings sections

Rejected. One namespace per server reintroduces the composition problem (the namespace must be registered by a composition row that already knows the server) and fragments the Plugins page into one card per server with no fleet overview.

### Manager owning connections directly

Rejected. Reimplementing the supervisor inside the manager duplicates the client's reconnect, generation-swap, and naming logic. Mounting the existing bridge as children reuses the pinned naming contract and the per-server reconnect budget unchanged.

### Credential references for fleet secrets

Deferred. An `apiKeyEnv`-style reference per server needs a reference vocabulary the card can render and the redaction walker can prove. The v1 contract stores `env`/`headers` in plain text, documents the boundary, and keeps secret-bearing servers in deployment rows.

### Array-valued fleet

Rejected. Array indices shift on every insertion and make `mutate` path ops unstable across editors. Dict keys are stable addresses and make duplicate names structurally impossible.

## Testing

- **Unit** (`packages/mcp/mcp-manager/tests/settings.spec.ts`, memory provider): dormant registration, illegal-name and field validation, disabled-entry storage, provider-detach fallback, provider-absent composition, namespace release.
- **Integration** (`packages/mcp/mcp-manager/tests/fleet.spec.ts`, real Streamable HTTP fixture): settings-driven mount by URL, disable/removal retiring tools, composition-entry mount, sibling survival across a refused write.
- **Real composition** (`packages/mcp/mcp-manager/tests/loader-composition.spec.ts`): test-only `cordis.yml` through Loader + Include boots dormant with the `mcp` namespace and zero `mcp__` tools.
- **Client** (`packages/client/ui-settings-plugins/tests/mcp-card-controller.client.spec.ts`, fake scope): row summaries, draft validation, stored-entry projection, staged toggle/remove/add behind one save, invalid drafts staying clean, discard.

## Consequences

- Operators add, disable, or remove MCP servers from `settings.yaml` or the Plugins card; direct client rows remain for deployment-pinned servers.
- Tool names keep the pinned `mcp__<server>__<tool>` contract; adding or removing an unrelated server never renames an existing tool.
- Fleet `env`/`headers` are plain text visible to configuration surfaces; the manager README and card copy state the boundary.
- A refused or failed server logs and stays unmounted while the rest of the fleet serves.
