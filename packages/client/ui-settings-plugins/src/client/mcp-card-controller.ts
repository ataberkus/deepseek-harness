/** Staged fleet editor for the Host-owned `mcp` settings section. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CardShell } from './card-form.ts'

/**
 * Namespace of the Host-owned MCP fleet. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const MCP_NS = 'mcp'

/** Server names must match the tool namespace budget the Host enforces. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Settings fields stored for the fleet; server entries stay structurally open. */
export interface McpFleetSettings {
  /** Fleet keyed by server name. */
  servers?: Record<string, Record<string, unknown>>
}

/** One server row the card renders. */
export interface McpServerView {
  /** Dict key namespacing the server's tools. */
  name: string
  /** Transport, or `unknown` when the stored entry names none the card knows. */
  transport: 'stdio' | 'streamable-http' | 'unknown'
  /** Whether the draft enables this server. */
  enabled: boolean
  /** One-line endpoint summary (command line or URL). */
  detail: string
}

/** Validation failure for a staged server entry. */
export type McpServerValidation =
  | 'nameRequired'
  | 'nameInvalid'
  | 'commandRequired'
  | 'urlRequired'
  | 'urlInvalid'

/** Structured server entry staged by the card's add form. */
export interface McpServerDraft {
  /** Dict key; when `previousName` differs the old key is renamed. */
  name: string
  /** Previous key for a rename; omission adds or updates `name` in place. */
  previousName?: string
  /** Transport selecting which endpoint fields apply. */
  transport: 'stdio' | 'streamable-http'
  /** Whether the staged entry mounts. */
  enabled: boolean
  /** Stdio executable. */
  command: string
  /** Stdio arguments, one per line in the form, stored as an array. */
  argsText: string
  /** Streamable HTTP endpoint URL. */
  url: string
}

/** State rendered by the staged fleet card. */
export interface McpCardState extends CardShell {
  /** Draft fleet rows in registration order. */
  servers: readonly McpServerView[]
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
}

/** Registration-side face for the fleet card. */
export interface McpCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useMcpCard. */
    mcpCard: SnapshotStore<McpCardState>
  }
  /** Stage an enabled flip for one server. */
  toggleEnabled: (name: string) => void
  /** Stage the removal of one server. */
  removeServer: (name: string) => void
  /**
   * Stage an addition or update from the add form.
   * @param draft - structured entry from the form.
   * @returns undefined when staged; otherwise the validation failure to display.
   */
  saveServer: (draft: McpServerDraft) => McpServerValidation | undefined
  /** Persist the staged fleet as one revision-fenced mutation. */
  save: () => void
  /** Drop the staged fleet. */
  discard: () => void
}

/**
 * Read one string field from a structurally open server entry.
 * @param entry - stored server entry.
 * @param field - field to read.
 * @returns the string value, or an empty string when absent or mistyped.
 */
function stringField(entry: Record<string, unknown>, field: string): string {
  const value = entry[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Summarize one stored entry for its row.
 * @param name - dict key.
 * @param entry - stored server entry.
 * @returns the rendered row.
 */
export function toServerView(name: string, entry: Record<string, unknown>): McpServerView {
  const transport = entry['transport']
  const enabled = entry['enabled']
  if (transport === 'streamable-http') {
    return {
      name,
      transport,
      enabled: enabled !== false,
      detail: stringField(entry, 'url'),
    }
  }
  if (transport === 'stdio') {
    const command = stringField(entry, 'command')
    const args = Array.isArray(entry['args'])
      ? (entry['args'] as unknown[]).filter((arg): arg is string => typeof arg === 'string')
      : []
    return {
      name,
      transport,
      enabled: enabled !== false,
      detail: [command, ...args].filter(part => part.length > 0).join(' '),
    }
  }
  return { name, transport: 'unknown', enabled: enabled !== false, detail: '' }
}

/**
 * Validate a staged entry before it joins the draft.
 * @param draft - structured entry from the add form.
 * @returns undefined when the entry may be staged; otherwise the failure to display.
 */
export function validateServerDraft(draft: McpServerDraft): McpServerValidation | undefined {
  if (draft.name.trim().length === 0) return 'nameRequired'
  if (!SERVER_NAME_PATTERN.test(draft.name.trim())) return 'nameInvalid'
  if (draft.transport === 'stdio') {
    if (draft.command.trim().length === 0) return 'commandRequired'
    return undefined
  }
  if (draft.url.trim().length === 0) return 'urlRequired'
  try {
    const parsed = new URL(draft.url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'urlInvalid'
  } catch (_invalidUrl) {
    return 'urlInvalid'
  }
  return undefined
}

/**
 * Project a staged entry into the stored shape. Only the card's simple fields
 * ride: advanced tuning (env, headers, timeouts, reconnect) stays in
 * `settings.yaml` and survives because staged updates merge per server.
 * @param draft - validated structured entry.
 * @returns the stored server entry.
 */
export function toStoredEntry(draft: McpServerDraft): Record<string, unknown> {
  const name = draft.name.trim()
  void name
  if (draft.transport === 'stdio') {
    const args = draft.argsText.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    return {
      transport: 'stdio' as const,
      enabled: draft.enabled,
      command: draft.command.trim(),
      args,
    }
  }
  return {
    transport: 'streamable-http' as const,
    enabled: draft.enabled,
    url: draft.url.trim(),
  }
}

/** Bridges one settings scope onto a staged fleet card. */
export class McpCardController {
  private draftServers: Map<string, Record<string, unknown>> | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private readonly store: SnapshotStore<McpCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `mcp` settings scope.
   */
  constructor(private readonly scope: SettingsScope<McpFleetSettings>) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draftServers !== undefined
        && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (this.sameAsCurrent()) this.clearDraft()
        else this.conflicted = true
      }
      this.publish()
    })
  }

  /** Stop observing settings and suppress late write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns the snapshot and staged card actions injected into the renderer.
   */
  inject(): McpCardFace {
    return {
      hooks: { mcpCard: this.store },
      toggleEnabled: (name) => { this.toggleEnabled(name) },
      removeServer: (name) => { this.removeServer(name) },
      saveServer: draft => this.saveServer(draft),
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private currentServers(): Map<string, Record<string, unknown>> {
    const servers = this.scope.getSnapshot().value?.servers ?? {}
    return new Map(Object.entries(servers).map(([name, entry]) => [name, { ...(entry as Record<string, unknown>) }]))
  }

  private desiredServers(): Map<string, Record<string, unknown>> {
    return this.draftServers ?? this.currentServers()
  }

  private sameAsCurrent(): boolean {
    const current = this.currentServers()
    const desired = this.desiredServers()
    if (current.size !== desired.size) return false
    for (const [name, entry] of desired) {
      const other = current.get(name)
      if (other === undefined || JSON.stringify(other) !== JSON.stringify(entry)) return false
    }
    return true
  }

  private beginDraft(): Map<string, Record<string, unknown>> {
    if (this.draftServers === undefined) {
      this.draftServers = this.currentServers()
      this.draftRevision = this.scope.getSnapshot().revision
    }
    return this.draftServers
  }

  private clearDraft(): void {
    this.draftServers = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private toggleEnabled(name: string): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    const draft = this.beginDraft()
    const entry = draft.get(name)
    if (entry === undefined) return
    draft.set(name, { ...entry, enabled: entry['enabled'] !== false ? false : true })
    this.failed = false
    this.publish()
  }

  private removeServer(name: string): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    const draft = this.beginDraft()
    if (!draft.has(name)) return
    draft.delete(name)
    this.failed = false
    this.publish()
  }

  private saveServer(draft: McpServerDraft): McpServerValidation | undefined {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return undefined
    const failure = validateServerDraft(draft)
    if (failure !== undefined) return failure
    const servers = this.beginDraft()
    const name = draft.name.trim()
    const previous = draft.previousName?.trim()
    if (previous !== undefined && previous.length > 0 && previous !== name) servers.delete(previous)
    const stored = toStoredEntry(draft)
    const existing = servers.get(name)
    servers.set(name, existing === undefined ? stored : { ...existing, ...stored })
    this.failed = false
    this.publish()
    return undefined
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    if (this.draftServers === undefined || this.sameAsCurrent()) return
    if (snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    const desired = Object.fromEntries([...this.draftServers.entries()])
    await this.scope.mutate([{ op: 'set', path: ['servers'], value: desired as unknown as JsonValue }], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = this.sameAsCurrent()
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  private projection(): McpCardState {
    const snapshot = this.scope.getSnapshot()
    const servers = [...this.desiredServers().entries()].map(([name, entry]) => toServerView(name, entry))
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.draftServers !== undefined && !this.sameAsCurrent(),
      invalid: false,
      saving: this.saving,
      failed: this.failed,
      servers,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
