/**
 * Durable capture: manifest retry, blob admission, and metadata records.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/store
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  CheckpointId,
  WorkspaceCheckpointError,
  workspaceCheckpointDomainSpec,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  CaptureRequest,
  CheckpointManifest,
  CheckpointRecord,
  CheckpointView,
  ManifestEntry,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type { StoredCheckpointRecord, StoredSessionCheckpointIndex } from '@deepseek-ai/dsh-workspace-checkpoint'
import { buildManifest } from './manifest.ts'
import { blobExists, putBlob } from './objects.ts'
import { canonicalizeCwd, fromManifestPath } from './paths.ts'

/** Test hook: replace `buildManifest` to inject concurrent-write failures. */
export const captureInternals: {
  buildManifest: typeof buildManifest
} = {
  buildManifest,
}

type CheckpointDomain = Domain<typeof workspaceCheckpointDomainSpec>

/**
 * Capture one filesystem manifest and persist its checkpoint metadata.
 * @param request - capture input.
 * @param options - blob-store, retry, domain, and event options.
 * @returns the stored record projected to {@link CheckpointRecord}.
 */
export async function captureCheckpoint(
  request: CaptureRequest,
  options: {
    readonly objectRoot: string
    readonly maxTotalBytes: number
    readonly excludeGlobs: readonly string[]
    readonly captureRetryCount: number
    readonly captureRetryDelayMs: number
    readonly domain: CheckpointDomain
    readonly workspaceKey?: string
    emitChanged?(sessionId: SessionId): void
  },
): Promise<CheckpointRecord> {
  const workspaceKey = options.workspaceKey ?? await canonicalizeCwd(request.cwd)
  const manifest = await manifestOrUnavailable(workspaceKey, options)
  const checkpoints = options.domain.table('checkpoints')
  const sessions = options.domain.table('sessions')
  const sessionId = request.sessionId
  const index = sessions.get(sessionId)
  const labelIndex = countNonEmergency(checkpoints, index)
  const id = CheckpointId(`cp_${randomUUID()}`)
  const fileCount = manifest.entries.filter(entry => entry.kind === 'file').length
  const unsafe = manifest.entries.some(entry => !entry.restoreSafe)
  let status: CheckpointRecord['status'] = { kind: 'ready' }
  let restoreEligible = !unsafe
  if (manifest.unavailableReason !== undefined) {
    status = { kind: 'unavailable', reason: manifest.unavailableReason }
    restoreEligible = false
  } else if (unsafe) {
    status = { kind: 'unavailable', reason: 'unsafe-entry' }
    restoreEligible = false
  } else {
    try {
      const admission = await admitBlobs(workspaceKey, manifest.entries, options.objectRoot, options.maxTotalBytes)
      if (admission !== undefined) {
        status = { kind: 'unavailable', reason: admission }
        restoreEligible = false
      }
    } catch (error: unknown) {
      status = { kind: 'unavailable', reason: captureFailureReason(error) }
      restoreEligible = false
    }
  }
  const stored: StoredCheckpointRecord = {
    id,
    sessionId,
    workspaceKey,
    ...request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId },
    boundarySeq: request.boundarySeq,
    ...request.parentCheckpointId === undefined ? {} : { parentCheckpointId: request.parentCheckpointId },
    role: request.role,
    turnOutcome: request.turnOutcome,
    status,
    createdAt: Date.now(),
    manifestHash: manifest.hash,
    fileCount,
    restoreEligible,
    labelIndex,
    entries: manifest.entries.map(cloneEntry),
  }
  await checkpoints.put(id, stored)
  await sessions.put(sessionId, {
    checkpointIds: [...index?.checkpointIds ?? [], id],
    ...index?.appliedCheckpointId === undefined ? {} : { appliedCheckpointId: index.appliedCheckpointId },
    ...request.role === 'emergency'
      ? { emergencyCheckpointId: id }
      : index?.emergencyCheckpointId === undefined ? {} : { emergencyCheckpointId: index.emergencyCheckpointId },
    ...index?.recoveryRequired === undefined ? {} : { recoveryRequired: index.recoveryRequired },
    ...index?.edit === undefined ? {} : { edit: index.edit },
  })
  options.emitChanged?.(sessionId)
  return toRecord(stored)
}

/**
 * Load one stored checkpoint row.
 * @param id - checkpoint id.
 * @param domain - open domain.
 * @returns the stored row including manifest entries.
 */
export function loadStoredCheckpoint(id: CheckpointId, domain: CheckpointDomain): StoredCheckpointRecord {
  const stored = domain.table('checkpoints').get(id)
  if (stored === undefined) {
    throw new WorkspaceCheckpointError(`checkpoint not found: ${id}`, 'CHECKPOINT_NOT_FOUND')
  }
  return stored
}

/**
 * Read one stored checkpoint and project it to the public record.
 * @param id - checkpoint id.
 * @param domain - open domain.
 * @returns the stored record.
 */
export function inspectCheckpoint(id: CheckpointId, domain: CheckpointDomain): CheckpointRecord {
  return toRecord(loadStoredCheckpoint(id, domain))
}

/**
 * Read one session's checkpoint index.
 * @param sessionId - owning session.
 * @param domain - open domain.
 * @returns the session index row, when present.
 */
export function loadSessionIndex(
  sessionId: SessionId,
  domain: CheckpointDomain,
): StoredSessionCheckpointIndex | undefined {
  return domain.table('sessions').get(sessionId)
}

/**
 * List a session's checkpoint records in label order.
 * @param sessionId - owning session.
 * @param domain - open domain.
 * @returns client-safe views in label order.
 */
export function listCheckpoints(sessionId: SessionId, domain: CheckpointDomain): CheckpointView[] {
  const index = domain.table('sessions').get(sessionId)
  if (index === undefined) return []
  const checkpoints = domain.table('checkpoints')
  const records: CheckpointRecord[] = []
  for (const id of index.checkpointIds) {
    const stored = checkpoints.get(CheckpointId(id))
    if (stored !== undefined) records.push(toRecord(stored))
  }
  records.sort((left, right) => left.labelIndex - right.labelIndex)
  return records.map(toView)
}

function countNonEmergency(
  checkpoints: KvTable<CheckpointId, StoredCheckpointRecord>,
  index: StoredSessionCheckpointIndex | undefined,
): number {
  if (index === undefined) return 0
  let count = 0
  for (const id of index.checkpointIds) {
    const stored = checkpoints.get(CheckpointId(id))
    if (stored !== undefined && stored.role !== 'emergency') count += 1
  }
  return count
}

async function manifestOrUnavailable(
  cwd: string,
  options: { readonly excludeGlobs: readonly string[]; readonly captureRetryCount: number; readonly captureRetryDelayMs: number },
): Promise<CheckpointManifest & { unavailableReason?: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.captureRetryCount; attempt += 1) {
    try {
      return await captureInternals.buildManifest(cwd, { excludeGlobs: options.excludeGlobs })
    } catch (error) {
      lastError = error
      if (!isConcurrentWrite(error) || attempt === options.captureRetryCount) break
      await delay(options.captureRetryDelayMs)
    }
  }
  if (isConcurrentWrite(lastError)) {
    return { cwd, hash: 'unavailable', entries: [], unavailableReason: 'concurrent-write' }
  }
  return { cwd, hash: 'unavailable', entries: [], unavailableReason: captureFailureReason(lastError) }
}

async function admitBlobs(
  cwd: string,
  entries: readonly ManifestEntry[],
  objectRoot: string,
  maxTotalBytes: number,
): Promise<string | undefined> {
  const files = entries.filter((entry): entry is ManifestEntry & { hash: string } => entry.kind === 'file' && entry.hash !== undefined)
  const newHashes = new Set<string>()
  let added = 0
  for (const entry of files) {
    if (newHashes.has(entry.hash) || await blobExists(objectRoot, entry.hash)) continue
    newHashes.add(entry.hash)
    added += entry.size
  }
  if (added > maxTotalBytes) return 'quota-exhausted'
  for (const entry of files) {
    const path = fromManifestPath(cwd, entry.relativePath)
    const bytes = await readFile(path)
    await putBlob(objectRoot, entry.hash, bytes)
  }
  return undefined
}

function isConcurrentWrite(error: unknown): boolean {
  return error instanceof WorkspaceCheckpointError && error.code === 'CHECKPOINT_CONCURRENT_WRITE'
}

/** Keep capture failures fail-soft without persisting filesystem details. */
function captureFailureReason(error: unknown): string {
  return error instanceof WorkspaceCheckpointError
    ? `capture-${error.code.toLowerCase()}`
    : 'capture-failed'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function cloneEntry(entry: ManifestEntry): ManifestEntry {
  return {
    relativePath: entry.relativePath,
    kind: entry.kind,
    size: entry.size,
    restoreSafe: entry.restoreSafe,
    ...entry.mode === undefined ? {} : { mode: entry.mode },
    ...entry.hash === undefined ? {} : { hash: entry.hash },
    ...entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget },
  }
}

/**
 * Project a durable row to the public record (no blob internals / entries).
 * @param stored - domain row.
 * @returns the public record.
 */
export function toRecord(stored: StoredCheckpointRecord): CheckpointRecord {
  return {
    id: CheckpointId(stored.id),
    sessionId: SessionId(stored.sessionId),
    workspaceKey: stored.workspaceKey,
    ...stored.workspaceId === undefined
      ? {}
      : { workspaceId: stored.workspaceId as Exclude<CheckpointRecord['workspaceId'], undefined> },
    boundarySeq: stored.boundarySeq,
    ...stored.parentCheckpointId === undefined ? {} : { parentCheckpointId: CheckpointId(stored.parentCheckpointId) },
    role: stored.role,
    turnOutcome: stored.turnOutcome,
    status: stored.status,
    createdAt: stored.createdAt,
    manifestHash: stored.manifestHash,
    fileCount: stored.fileCount,
    restoreEligible: stored.restoreEligible,
    labelIndex: stored.labelIndex,
  }
}

function toView(record: CheckpointRecord): CheckpointView {
  return {
    id: record.id,
    sessionId: record.sessionId,
    boundarySeq: record.boundarySeq,
    labelIndex: record.labelIndex,
    role: record.role,
    status: record.status,
    restoreEligible: record.restoreEligible,
    fileCount: record.fileCount,
    createdAt: record.createdAt,
  }
}
