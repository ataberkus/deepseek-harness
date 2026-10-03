/**
 * MCP fleet settings page, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the page
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. The `mcp-manager` entry the page edits is mounted by the base
 * bundle, so this package registers no plugin of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
