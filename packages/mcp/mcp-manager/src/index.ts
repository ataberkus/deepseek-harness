/**
 * Settings-driven fleet manager for MCP servers. One manager instance owns the
 * `mcp` settings section and mounts one `@deepseek-ai/dsh-mcp-client` child
 * per enabled server entry, so operators add, edit, disable, or remove servers
 * from `settings.yaml` or the Plugins settings card instead of editing
 * `cordis.yml`.
 *
 * The settings dict key IS the server name: it namespaces the server's tools
 * as `mcp__<serverName>__<tool>` and must match `[A-Za-z0-9_-]{1,32}`. An entry
 * with `enabled: false` keeps its configuration but mounts nothing. A
 * deployment-base server is disabled the same way; the settings merge cannot
 * delete a composition key, so disabling is the removal path for base rows.
 *
 * @module @deepseek-ai/dsh-mcp-manager
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-settings'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/** Services required by this plugin. */
export const inject = ['tools']

/** Settings namespace carrying the fleet description. */
export const MCP_SETTINGS_NAMESPACE = 'mcp'

/** Valid server names, matching the client bridge namespace budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default per-tool-call timeout, mirroring the client bridge default. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

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

/** Resolved manager configuration after schemastery applied the defaults. */
type ResolvedConfig = { servers: Record<string, ResolvedEntry> }

/** One resolved entry with defaults applied. */
type ResolvedEntry = (
  | Omit<McpStdioServerEntry, 'enabled' | 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError'>
  | Omit<McpHttpServerEntry, 'enabled' | 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError'>
) & {
  enabled: boolean
  toolCallTimeoutMs: number
  failOnStartupError: boolean
} & Record<string, unknown>

const Reconnect: z<McpReconnectEntry> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(500),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(10),
})

const StdioEntry = z.object({
  transport: z.const('stdio'),
  enabled: z.boolean().default(true),
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
})

const HttpEntry = z.object({
  transport: z.const('streamable-http'),
  enabled: z.boolean().default(true),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
})

/** Schema for the `mcp` settings section and the manager composition entry. */
export const Config: z<Config, ResolvedConfig> = z.object({
  servers: z.dict(z.union([StdioEntry, HttpEntry]) as unknown as z<McpServerEntry>).default({}),
}) as unknown as z<Config, ResolvedConfig>

/**
 * Reject a resolved section the fleet could not mount. The schema validates
 * each entry's fields; only the dict keys escape it, so an illegal server name
 * is refused where it is written instead of failing one child at sync time.
 * @param value - the resolved section, schema-valid by construction.
 */
export function assertServiceableMcpConfig(value: ResolvedConfig): void {
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
  let current: () => ResolvedConfig = () => config
  const live = new Map<string, LiveChild>()
  let closed = false
  ctx.effect(() => () => {
    closed = true
  }, 'mcp-manager.close')
  let tail: Promise<void> = Promise.resolve()
  /**
   * Reconcile live children with the currently authoritative section. Removals
   * and disables dispose first; additions and changed entries validate through
   * the client schema before the previous child (if any) is replaced, so a
   * refused entry keeps the previous generation serving.
   */
  const reconcile = async (): Promise<void> => {
    if (closed) return
    const resolved = current()
    const desired = new Map<string, McpClient.Config>()
    for (const [serverName, entry] of Object.entries(resolved.servers)) {
      if (entry.enabled === false) continue
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
    if (closed) return
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
        if (closed) return
      }
      try {
        const fiber = await ctx.plugin(McpClient, parsed)
        if (closed) {
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
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MCP_SETTINGS_NAMESPACE, Config, config, {
      validate: assertServiceableMcpConfig,
      setSource: (source) => {
        current = source as () => ResolvedConfig
      },
      onChange: () => {
        schedule()
      },
    })
  })
  schedule()
}
