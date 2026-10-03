/**
 * The MCP page's staged fleet editor over the `mcp-manager` entry's volatile
 * `servers` field.
 *
 * The page stages a whole fleet and writes it in one revision-fenced `set` of
 * that field, so a save is one document write whatever the user changed. Only
 * the fields this page edits ride: an entry it updates keeps everything else
 * another writer stored (env, headers, timeouts, reconnect).
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Profile entry whose volatile fleet this page edits. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const MCP_MANAGER_ENTRY = 'mcp-manager'

/** Server names must match the tool namespace budget the Host enforces. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Transport one stored server entry speaks. */
export type McpTransport = 'stdio' | 'streamable-http'

/** One stored server entry, structurally open so fields this page does not edit survive an update. */
export type McpServerEntry = { [field: string]: JsonValue }

/** The fleet the `mcp-manager` entry stores. */
export interface McpFleetSettings {
  /** Fleet keyed by server name. */
  servers?: Record<string, McpServerEntry>
}

/** One server row the page renders. */
export interface McpServerView {
  /** Dict key namespacing the server's tools. */
  name: string
  /** Transport, or `unknown` when the stored entry names none the page knows. */
  transport: McpTransport | 'unknown'
  /** Whether the draft enables this server. */
  enabled: boolean
  /** One-line endpoint summary (command line or URL). */
  detail: string
  /** Stdio executable, as the row's edit form seeds it. */
  command: string
  /** Stdio arguments, one per line, as the row's edit form seeds them. */
  argsText: string
  /** Streamable HTTP endpoint, as the row's edit form seeds it. */
  url: string
}

/** Validation failure for a staged server entry. */
export type McpServerValidation =
  | 'nameRequired'
  | 'nameInvalid'
  | 'commandRequired'
  | 'urlRequired'
  | 'urlInvalid'

/** Structured server entry staged by the page's add form. */
export interface McpServerDraft {
  /** Dict key; when `previousName` differs the old key is renamed. */
  name: string
  /** Previous key for a rename; omission adds or updates `name` in place. */
  previousName?: string
  /** Transport selecting which endpoint fields apply. */
  transport: McpTransport
  /** Whether the staged entry mounts. */
  enabled: boolean
  /** Stdio executable. */
  command: string
  /** Stdio arguments, one per line in the form, stored as an array. */
  argsText: string
  /** Streamable HTTP endpoint URL. */
  url: string
}

/** State rendered by the fleet page. */
export interface McpServersCardState extends SettingsFormShell {
  /** Draft fleet rows, ordered by name. */
  servers: readonly McpServerView[]
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
}

/** Registration-side face for the fleet page. */
export interface McpServersCardFace {
  hooks: {
    /** Page snapshot bound by the renderer as useMcpServersCard. */
    mcpServersCard: SnapshotStore<McpServersCardState>
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
function stringField(entry: McpServerEntry, field: string): string {
  const value = entry[field]
  return typeof value === 'string' ? value : ''
}

/**
 * Split the form's argument text.
 * @param text - one trimmed argument per line.
 * @returns the arguments, blank lines dropped.
 */
function argsOf(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/**
 * Summarize one stored entry for its row.
 * @param name - dict key.
 * @param entry - stored server entry.
 * @returns the rendered row.
 */
export function toServerView(name: string, entry: McpServerEntry): McpServerView {
  const transport = entry['transport']
  const enabled = entry['enabled'] !== false
  if (transport === 'streamable-http') {
    const url = stringField(entry, 'url')
    return { name, transport, enabled, detail: url, command: '', argsText: '', url }
  }
  if (transport === 'stdio') {
    const args = entry['args']
    const parts = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : []
    const command = stringField(entry, 'command')
    return {
      name,
      transport,
      enabled,
      detail: [command, ...parts].filter(part => part.length > 0).join(' '),
      command,
      argsText: parts.join('\n'),
      url: '',
    }
  }
  return { name, transport: 'unknown', enabled, detail: '', command: '', argsText: '', url: '' }
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
    return draft.command.trim().length === 0 ? 'commandRequired' : undefined
  }
  if (draft.url.trim().length === 0) return 'urlRequired'
  try {
    const protocol = new URL(draft.url.trim()).protocol
    return protocol === 'http:' || protocol === 'https:' ? undefined : 'urlInvalid'
  } catch (invalidUrl) {
    if (!(invalidUrl instanceof TypeError)) throw invalidUrl
    return 'urlInvalid'
  }
}

/**
 * Project a staged entry into the stored shape. Only the page's simple fields
 * ride: advanced tuning (env, headers, timeouts, reconnect) stays with the
 * profile and survives because staged updates merge per server.
 * @param draft - validated structured entry.
 * @returns the stored server entry.
 */
export function toStoredEntry(draft: McpServerDraft): McpServerEntry {
  if (draft.transport === 'stdio') {
    return { transport: 'stdio', enabled: draft.enabled, command: draft.command.trim(), args: argsOf(draft.argsText) }
  }
  return { transport: 'streamable-http', enabled: draft.enabled, url: draft.url.trim() }
}

/** Bridges one settings form onto the staged fleet page. */
export class McpServersCardController {
  private draftServers: Map<string, McpServerEntry> | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private readonly store: SnapshotStore<McpServersCardState>
  private readonly unsubscribe: () => void

  /** @param scope - the bound form for the `mcp-manager` entry. */
  constructor(private readonly scope: ConfigForm<McpFleetSettings>) {
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

  /** Stop observing the entry and suppress late write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this page.
   * @returns the snapshot and staged fleet actions injected into the renderer.
   */
  inject(): McpServersCardFace {
    return {
      hooks: { mcpServersCard: this.store },
      toggleEnabled: (name) => { this.toggleEnabled(name) },
      removeServer: (name) => { this.removeServer(name) },
      saveServer: draft => this.saveServer(draft),
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private currentServers(): Map<string, McpServerEntry> {
    const servers = this.scope.getSnapshot().value?.servers ?? {}
    return new Map(Object.entries(servers).map(([name, entry]) => [name, { ...entry }]))
  }

  private desiredServers(): Map<string, McpServerEntry> {
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

  private beginDraft(): Map<string, McpServerEntry> {
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

  /** @returns whether a staged edit may be accepted right now. */
  private editable(): boolean {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || this.saving) return false
    return snapshot.status === 'ready' && snapshot.writable
  }

  private toggleEnabled(name: string): void {
    if (!this.editable()) return
    const draft = this.beginDraft()
    const entry = draft.get(name)
    if (entry === undefined) return
    const enabled = entry['enabled'] !== false
    draft.set(name, { ...entry, enabled: !enabled })
    this.failed = false
    this.publish()
  }

  private removeServer(name: string): void {
    if (!this.editable()) return
    const draft = this.beginDraft()
    if (!draft.delete(name)) return
    this.failed = false
    this.publish()
  }

  private saveServer(input: McpServerDraft): McpServerValidation | undefined {
    if (!this.editable()) return undefined
    const failure = validateServerDraft(input)
    if (failure !== undefined) return failure
    const servers = this.beginDraft()
    const name = input.name.trim()
    const previous = input.previousName?.trim()
    if (previous !== undefined && previous.length > 0 && previous !== name) servers.delete(previous)
    const stored = toStoredEntry(input)
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
    if (!this.editable() || this.draftServers === undefined || this.sameAsCurrent()) return
    if (this.scope.getSnapshot().revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    const desired = Object.fromEntries(this.draftServers.entries())
    await this.scope.mutate([{ op: 'set', path: ['servers'], value: desired }], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = this.sameAsCurrent()
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  private projection(): McpServersCardState {
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
