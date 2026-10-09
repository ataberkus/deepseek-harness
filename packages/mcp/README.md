---
description: "The MCP package group: attach external Model Context Protocol servers so their tools are callable as native tools."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

The `mcp/` group connects the harness to Model Context Protocol (MCP) tool servers. `mcp-client` attaches one external server — a filesystem, GitHub, database, or memory server — so the model calls its tools as native tools under stable server-qualified names. `mcp-manager` mounts one client per enabled entry in the `mcp` settings section, so operators configure servers without editing `cordis.yml`. Nothing ships enabled; you opt in per server. Only the Tools capability is bridged: MCP resources and prompts are not supported. This page maps the group; each package README owns its contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The group holds two packages; the package READMEs and the links below own the details.

| Package | What it provides |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | Attach one external MCP server so the model can call its tools as native tools |
| [`mcp-manager/`](mcp-manager/README.md) | Mount one client per enabled `mcp` settings entry so the fleet is user-configurable |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Note for the behavior decisions behind it.

- [MCP client plugin Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
