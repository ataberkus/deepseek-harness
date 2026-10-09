/**
 * Config-driven fleet manager for MCP servers. One manager instance owns the
 * `mcp` profile entry's `servers` dict and mounts one
 * `@deepseek-ai/dsh-mcp-client` child per enabled entry, so operators add,
 * edit, disable, or remove servers from the Plugins settings card (which
 * edits the active profile) instead of editing `cordis.yml` by hand.
 *
 * The settings dict key IS the server name: it namespaces the server's tools
 * as `mcp__<serverName>__<tool>` and must match `[A-Za-z0-9_-]{1,32}`. An entry
 * with `enabled: false` keeps its configuration but mounts nothing. A
 * deployment-base server is disabled the same way; the settings merge cannot
 * delete a composition key, so disabling is the removal path for base rows.
 *
 * @module @deepseek-ai/dsh-mcp-manager
 */

import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
// Type-only: pulls the Loader's entry and `loader/volatile-update` merges into
// this program so live config commits can re-reconcile the fleet.
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/** Services required by this plugin. */
export const inject = ['tools']

/** Valid server names, matching the client bridge namespace budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Automatic reconnect policy for one settings-driven server entry. */
export interface McpReconnectEntry {
  /** Reconnect automatically after a lost connection. */
  enabled?: boolean
  /** First reconnect delay in milliseconds; doubles per consecutive failed attempt. */
  initialDelayMs?: number
  /** Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets. */
  maxDelayMs?: number
  /** Consecutive failed attempts per outage before giving up for good. */
  maxAttempts?: number
}

/** One stdio server entry; the dict key supplies `serverName`. */
export interface McpStdioServerEntry {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /** False keeps the configuration but mounts nothing. */
  enabled?: boolean
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args?: string[]
  /** Extra env vars merged on top of scrubbed ambient env, stored in plain text. */
  env?: Record<string, string>
  /** Working directory for the child process. */
  cwd?: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: McpReconnectEntry
}

/** One Streamable HTTP server entry; the dict key supplies `serverName`. */
export interface McpHttpServerEntry {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /** False keeps the configuration but mounts nothing. */
  enabled?: boolean
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests, stored in plain text. */
  headers?: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: McpReconnectEntry
}

/** One fleet entry, discriminated on `transport`. */
export type McpServerEntry = McpStdioServerEntry | McpHttpServerEntry

/** Manager configuration: the fleet keyed by server name. */
export interface Config {
  /** Servers by name; the key namespaces the server's tools. */
  servers?: Record<string, McpServerEntry>
}

/**
 * Resolved manager configuration after schemastery applied the defaults.
 * `servers` is volatile: a settings edit commits a new snapshot without
 * remounting the manager, so the fleet is read from the reference each time.
 */
type ResolvedConfig = {
  /** Servers by name with schema defaults applied; read from the volatile reference per reconcile. */
  servers: Volatile<Record<string, ResolvedEntry>>
}

/** One resolved entry with defaults applied. */
type ResolvedEntry = (
  | Omit<McpStdioServerEntry, 'enabled' | 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  | Omit<McpHttpServerEntry, 'enabled' | 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>
) & {
  /** Whether this entry mounts a child; a disabled entry keeps its name reserved but serves no tools. */
  enabled: boolean
  /** Ceiling for one tool call on this server's child before the call fails loud. */
  toolCallTimeoutMs: number
  /** Whether a startup failure refuses the request instead of logging and continuing without the child. */
  failOnStartupError: boolean
} & Record<string, unknown>

const StdioEntry = z.object({
  transport: z.const('stdio'),
  enabled: z.boolean().default(true),
  ...McpClient.StdioServerFields,
})

const HttpEntry = z.object({
  transport: z.const('streamable-http'),
  enabled: z.boolean().default(true),
  ...McpClient.StreamableHttpServerFields,
})

/** Schema for the `mcp` settings section and the manager composition entry. */
export const Config: z<Config, ResolvedConfig> = z.object({
  servers: z.dict(z.union([StdioEntry, HttpEntry]) as unknown as z<McpServerEntry>).default({}).volatile(),
}) as unknown as z<Config, ResolvedConfig>

/**
 * Reject a fleet the manager could not mount. The schema validates each entry's
 * fields; only the dict keys escape it, so an illegal server name is refused
 * here instead of failing one child at sync time.
 * @param value - the resolved fleet section.
 */
export function assertServiceableMcpConfig(value: { servers: Record<string, unknown> }): void {
  for (const serverName of Object.keys(value.servers)) {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error(
        `mcp-manager: server name "${serverName}" must match [A-Za-z0-9_-]{1,32} — rename the "servers" key`,
      )
    }
  }
}

/** One live child and the desired config it was mounted with. */
interface LiveChild {
  /** Child fiber owning the server's connection and tools. */
  fiber: Fiber
  /** Desired client config at mount time, used for change detection. */
  config: McpClient.Config
}

/**
 * Project one resolved entry plus its dict key into the client bridge config.
 * @param serverName - dict key namespacing the server's tools.
 * @param entry - resolved fleet entry.
 * @returns client config for one `ctx.plugin` mount.
 */
function toClientConfig(serverName: string, entry: ResolvedEntry): McpClient.Config {
  const { enabled, ...rest } = entry
  void enabled
  return { ...rest, serverName } as unknown as McpClient.Config
}

/**
 * Mount one fleet and keep it in sync with the `mcp` settings section. The
 * manager itself stays dormant with zero servers; each enabled entry becomes
 * one child client whose tools appear as `mcp__<serverName>__<tool>`.
 * @param ctx - plugin context mounting the managed children.
 * @param config - composition entry used as the settings base layer.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const servers = (): Record<string, ResolvedEntry> => config.servers.get()
  assertServiceableMcpConfig({ servers: servers() })
  const live = new Map<string, LiveChild>()
  let closed = false
  ctx.effect(() => () => {
    closed = true
  }, 'mcp-manager.close')
  /** Read the close flag fresh after each await; disposal can land mid-reconcile. */
  const isClosed = (): boolean => closed
  let tail: Promise<void> = Promise.resolve()
  /**
   * Reconcile live children with the currently authoritative section. Removals
   * and disables dispose first; additions and changed entries validate through
   * the client schema before the previous child (if any) is replaced, so a
   * refused entry keeps the previous generation serving.
   */
  const reconcile = async (): Promise<void> => {
    if (isClosed()) return
    const desired = new Map<string, McpClient.Config>()
    for (const [serverName, entry] of Object.entries(servers())) {
      if (!entry.enabled) continue
      // A live edit can name a server the tool namespace budget cannot carry;
      // skip that entry rather than mounting a child whose tools could not be
      // addressed.
      if (!SERVER_NAME_PATTERN.test(serverName)) {
        ctx.logger.error(`mcp-manager: refusing server "${serverName}": the name must match [A-Za-z0-9_-]{1,32}`)
        continue
      }
      desired.set(serverName, toClientConfig(serverName, entry))
    }
    for (const [serverName, child] of [...live]) {
      if (!desired.has(serverName)) {
        live.delete(serverName)
        try {
          await child.fiber.dispose()
        } catch (error) {
          ctx.logger.error(`mcp-manager: disposing server "${serverName}" failed`)
          ctx.logger.error(error)
        }
      }
    }
    if (isClosed()) return
    for (const [serverName, next] of desired) {
      const prev = live.get(serverName)
      if (prev !== undefined && deepEqualJson(prev.config, next)) continue
      let parsed: McpClient.Config
      try {
        parsed = McpClient.Config(next)
      } catch (error) {
        ctx.logger.error(`mcp-manager: refusing invalid server "${serverName}"`)
        ctx.logger.error(error)
        continue
      }
      if (prev !== undefined) {
        live.delete(serverName)
        try {
          await prev.fiber.dispose()
        } catch (error) {
          ctx.logger.error(`mcp-manager: disposing server "${serverName}" before remount failed`)
          ctx.logger.error(error)
        }
        if (isClosed()) return
      }
      try {
        const fiber = await ctx.plugin(McpClient, parsed)
        if (isClosed()) {
          await fiber.dispose().catch((error: unknown) => {
            ctx.logger.error(`mcp-manager: disposing late-mounted server "${serverName}" failed`)
            ctx.logger.error(error)
          })
          return
        }
        live.set(serverName, { fiber, config: next })
      } catch (error) {
        ctx.logger.error(`mcp-manager: server "${serverName}" failed to mount`)
        ctx.logger.error(error)
      }
    }
  }
  /**
   * Serialize reconciliations so a settings burst cannot interleave a dispose
   * with a remount of the same server. The trailing catch keeps a failed
   * generation from leaving an unobserved rejection when no later write follows.
   */
  const schedule = (): void => {
    tail = tail.catch(() => undefined).then(async () => {
      try {
        await reconcile()
      } catch (error) {
        ctx.logger.error('mcp-manager: fleet reconciliation failed')
        ctx.logger.error(error)
      }
    })
  }
  // A volatile-only config commit reaches the running instance through the
  // Loader; re-reconcile against the committed snapshot without remounting.
  ctx.on('loader/volatile-update', () => { schedule() })
  schedule()
}
