# Agent Note: A live-editable MCP fleet on the plugin entry

Status: implemented

English | [中文](2026-09-13-mcp-settings-fleet.zh.md)

## Problem

MCP servers are one `cordis.yml` row per server. Each addition, URL rotation, or disable means editing the profile composition, which restarts or reloads the composition and is out of reach for operators who only have the web Plugins page. The bridge itself (`dsh-mcp-client`) is per-server by design, so there is no fleet an operator can edit without touching the composition.

## Decision

### Fleet manager package

`@deepseek-ai/dsh-mcp-manager` (`packages/mcp/mcp-manager/`) owns its own profile entry's `servers` mapping and mounts one `dsh-mcp-client` child per enabled entry. The mapping key IS the server name: it namespaces tools as `mcp__<serverName>__<tool>` and must match `[A-Za-z0-9_-]{1,32}`. An entry carries `enabled` (default `true`) plus the transport fields the client bridge accepts minus `serverName`, which the manager injects from the key. The field is declared `.volatile()`, which is what lets the Loader commit a live value into the running manager. `env` and `headers` are plain profile values by explicit choice; secret-bearing servers stay in deployment-pinned client rows.

Example entry config:

```yaml
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

The manager mounts dormant with zero servers and is composed in `dsh-base`. `apply` reads the fleet from its config reference, refuses a mapping whose keys cannot be tool namespaces, and serializes reconciliations: removals and disables dispose first; additions and changed entries validate through `McpClient.Config` before replacing the previous child, so a refused entry keeps the previous generation serving. Each live commit and each `loader/volatile-update` schedules one reconciliation. Child fibers belong to the manager fiber, so manager disposal disposes the fleet. Mount failures log loudly and leave that server unmounted while siblings keep serving.

Disabling is the removal path for a server a profile pins: a committed value replaces the mapping, so a server the editor does not carry stops mounting, while `enabled: false` keeps the name reserved and mounts nothing.

### Browser page

The companion package `@deepseek-ai/dsh-client-ui-settings-mcp` owns the Plugins page's **MCP servers** card. It binds the `mcp-manager` entry's form through `ctx.configForms`, stages the whole `servers` mapping (toggles, removals, additions), and writes it as one revision-fenced `set`, so a stale editor conflicts instead of overwriting. The add form covers the common fields (name, transport, command plus newline-separated args, URL); timeouts, environment, headers, and reconnect tuning stay in the profile. The page registers into `plugins.item` while the Host serves the entry, and its copy lives in its own `settings.mcp` dictionary.

## Alternatives considered

### Settings-section fleet

Superseded. The first implementation gave the manager an `mcp` settings section of its own. A plugin-owned section needs the settings service present, leaves the fleet with two sources of truth (composition and section), and had to be re-derived once the web surface moved to per-entry configuration pages. Declaring the entry's own field volatile reaches the same live edit through the Loader, with the profile as the single owner of the value.

### Per-server settings sections

Rejected. One namespace per server reintroduces the composition problem (the namespace must be registered by a composition row that already knows the server) and fragments the Plugins page into one card per server with no fleet overview.

### Manager owning connections directly

Rejected. Reimplementing the supervisor inside the manager duplicates the client's reconnect, generation-swap, and naming logic. Mounting the existing bridge as children reuses the pinned naming contract and the per-server reconnect budget unchanged.

### Credential references for fleet secrets

Deferred. An `apiKeyEnv`-style reference per server needs a reference vocabulary the page can render and the redaction walker can prove. The v1 contract stores `env`/`headers` in plain text, documents the boundary, and keeps secret-bearing servers in deployment rows.

### Array-valued fleet

Rejected. Array indices shift on every insertion and make `set` path ops unstable across editors. Dict keys are stable addresses and make duplicate names structurally impossible.

## Testing

- **Unit** (`packages/client/ui-settings-mcp/tests/controller.client.spec.ts`, stubbed form): staged add, update, and rename, a merge that keeps fields the form does not edit, validation refusals that stage nothing, toggle and removal behind one save, read-only refusal, revision conflict, disposal.
- **Registration** (`packages/client/ui-settings-mcp/tests/apply.client.spec.ts`): the page appears only while the Host serves the `mcp-manager` entry, is titled in the active locale, and leaves with its fiber.
- **Integration** (`packages/mcp/mcp-manager/tests/fleet.spec.ts`, real Streamable HTTP fixture): live-config mount by URL, disable and removal retiring tools, composition-entry mount, sibling survival across a refused entry.
- **Real composition** (`packages/mcp/mcp-manager/tests/loader-composition.spec.ts`): a test-only `cordis.yml` through Loader + Include boots dormant with a volatile, live-editable fleet and zero `mcp__` tools.

## Consequences

- Operators add, disable, or remove MCP servers from the Plugins page or the profile entry; direct client rows remain for deployment-pinned servers.
- Tool names keep the pinned `mcp__<server>__<tool>` contract; adding or removing an unrelated server never renames an existing tool.
- Fleet `env`/`headers` are plain text visible to configuration surfaces; the manager README and the page's limitations state the boundary.
- A refused or failed server logs and stays unmounted while the rest of the fleet serves.
