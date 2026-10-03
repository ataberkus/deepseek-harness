---
description: "The MCP fleet's settings page on the dsh web client's Plugins page: the servers the mcp-manager entry mounts."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

## Summary

Open **Plugins** in the sidebar and select **MCP servers** in the Official group to add, edit, disable, or remove the Model Context Protocol servers the `mcp-manager` entry mounts. Every server this page stages is one entry under that entry's volatile `servers` field, keyed by the name that namespaces its tools. The page stages the whole fleet and writes it only on save, and it exists while the Host serves that entry's form.

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

The **MCP servers** card in the Official group opens the page. Each row is one configured server with its **Enabled** switch, its transport, and its command line or endpoint; **Edit** loads the row into the form below, and **Remove** stages its removal. The form adds one server: a name, a transport, the command and one argument per line for stdio or the endpoint for Streamable HTTP, and whether it mounts. Nothing is written until **Save**; leaving the page drops the draft, and a name outside `[A-Za-z0-9_-]{1,32}`, a missing command or endpoint, or an endpoint that is not an http or https URL is refused under the field instead of staged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half binds the `mcp-manager` entry's form through `ctx.configForms.get`, keeps the staged fleet in `McpServersCardController` over the entry's volatile `servers` field, and registers `McpServersCard` into the Plugins page's `plugins.item` slot through `ctx.configForms.whileServed`. The page's copy lives in this package's `settings.mcp` dictionary.

The controller holds one draft per page: edits, additions, and removals mutate a copy of the stored fleet, and a save sends that copy as a single `set` of the `servers` field, fenced by the revision the draft started from. It writes only the fields its form edits, so an entry it updates keeps the environment, headers, timeouts, and reconnect policy another writer stored. The draft carries no hosted secret: an entry's `env` and `headers` stay in the profile.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the config form and the served-entry watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form frame and the controls the page renders.
- [mcp-manager](../../mcp/mcp-manager/README.md) — the Host plugin that mounts the fleet this page edits.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None from this page; the next request after a save carries a different tool schema, because `mcp-manager` mounts the servers this page writes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Two transports** — the page edits stdio and Streamable HTTP entries. The advanced tuning of either (environment, headers, per-call timeout, reconnect policy) stays in the profile and survives an update rather than being editable here.
- **Plain-text endpoints** — a stored `env` or `headers` value is visible to every configuration surface; the page offers no credential reference for either.
- **Runtime invariant:** No companion is published. The page holds no owned relationship of its own: what it shows derives from the entry's form, and what it writes the Host validates against the manager's schema.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The fleet field is declared `.volatile()` on the Host schema. Without that the Loader refuses a live write, and the page would need a remount before a new server appeared.

</details>
