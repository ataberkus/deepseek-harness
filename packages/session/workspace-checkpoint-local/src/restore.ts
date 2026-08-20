/**
 * Journaled restore of a workspace checkpoint into a session cwd.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/restore
 */

import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename as fsRename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { CheckpointId, WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'
import type {
  RestoreRequest,
  RestoreResult,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import type { StoredCheckpointRecord } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { workspaceCheckpointDomainSpec } from '@deepseek-ai/dsh-workspace-checkpoint'
import { buildManifest } from './manifest.ts'
import { readBlob } from './objects.ts'
import { canonicalizeCwd, fromManifestPath } from './paths.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { loadStoredCheckpoint } from './store.ts'
import {
  backupDir,
  journalPath,
  removeJournal,
  stagingDir,
  writeJournal,
  type JournalOp,
  type RestoreJournal,
} from './journal.ts'

type CheckpointDomain = Domain<typeof workspaceCheckpointDomainSpec>

/** Test hooks for commit and rollback failures. */
export const restoreInternals: {
  rename: typeof fsRename
  rollback: ((journal: RestoreJournal) => Promise<void>) | undefined
} = {
  rename: fsRename,
  rollback: undefined,
}

/**
 * Make `request.cwd` match the checkpoint, or roll back.
 * @param request - checkpoint id, target cwd, optional abort signal.
 * @param options - open domain, object root, capture exclusions, and lease/recovery hooks.
 * @returns the restored checkpoint id and file count.
 */
export async function restoreCheckpoint(
  request: RestoreRequest,
  options: {
    readonly domain: CheckpointDomain
    readonly objectRoot: string
    readonly excludeGlobs: readonly string[]
    markRecoveryRequired(workspaceKey: string, reason: string): Promise<void>
    clearRecoveryRequired(workspaceKey: string): Promise<void>
    emitChanged?(sessionId: SessionId): void
  },
): Promise<RestoreResult> {
  if (request.signal?.aborted) {
    throw new WorkspaceCheckpointError('restore aborted', 'CHECKPOINT_UNAVAILABLE')
  }
  const cwd = await canonicalizeCwd(request.cwd)
  const stored = loadStoredCheckpoint(request.checkpointId, options.domain)
  const checkpointId = CheckpointId(stored.id)
  if (stored.status.kind !== 'ready' || !stored.restoreEligible) {
    throw new WorkspaceCheckpointError('checkpoint is not restorable', 'CHECKPOINT_UNAVAILABLE')
  }
  let mutated = false
  let journal: RestoreJournal | undefined
  try {
    await verifyBlobs(stored, options.objectRoot)
    const staging = stagingDir(options.objectRoot, checkpointId)
    await rm(staging, { recursive: true, force: true })
    await stageTree(stored, options.objectRoot, staging)
    const backup = backupDir(options.objectRoot, checkpointId)
    await rm(backup, { recursive: true, force: true })
    const ops = await planOps(cwd, stored, options.excludeGlobs)
    await backupCurrent(cwd, backup, options.excludeGlobs)
    journal = {
      checkpointId,
      cwd,
      backupDir: backup,
      stagingDir: staging,
      ops,
    }
    await writeJournal(journalPath(options.objectRoot, cwd), journal)
    mutated = true
    if (journal === undefined) throw new Error('restore journal was not created')
    await applyJournal(journal)
    await options.clearRecoveryRequired(cwd)
    await rm(staging, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
    await removeJournal(journalPath(options.objectRoot, cwd))
    const sessions = options.domain.table('sessions')
    const sessionId = SessionId(stored.sessionId)
    const index = sessions.get(sessionId)
    await sessions.put(sessionId, {
      checkpointIds: index?.checkpointIds ?? [checkpointId],
      appliedCheckpointId: checkpointId,
      ...index?.emergencyCheckpointId === undefined ? {} : { emergencyCheckpointId: index.emergencyCheckpointId },
      ...index?.recoveryRequired === undefined ? {} : { recoveryRequired: index.recoveryRequired },
      ...index?.edit === undefined ? {} : { edit: index.edit },
    })
    options.emitChanged?.(sessionId)
    return { checkpointId, fileCount: stored.fileCount }
  } catch (error) {
    if (mutated && journal !== undefined) {
      try {
        if (restoreInternals.rollback !== undefined) await restoreInternals.rollback(journal)
        else await rollbackJournal(journal, options.excludeGlobs)
      } catch (rollbackError) {
        await options.markRecoveryRequired(cwd, `recovery required: ${String(rollbackError)}`)
        throw rollbackError
      }
    }
    throw error
  }
}

async function verifyBlobs(stored: StoredCheckpointRecord, objectRoot: string): Promise<void> {
  for (const entry of stored.entries) {
    if (entry.kind !== 'file' || entry.hash === undefined) continue
    const bytes = await readBlob(objectRoot, entry.hash)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== entry.hash) {
      throw new WorkspaceCheckpointError(`blob hash mismatch: ${entry.relativePath}`, 'CHECKPOINT_HASH_MISMATCH')
    }
  }
}

async function stageTree(stored: StoredCheckpointRecord, objectRoot: string, staging: string): Promise<void> {
  await mkdir(staging, { recursive: true, mode: 0o700 })
  for (const entry of stored.entries) {
    const dest = fromManifestPath(staging, entry.relativePath)
    if (entry.kind === 'directory') {
      await mkdir(dest, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    if (entry.kind === 'file' && entry.hash !== undefined) {
      await writeFile(dest, await readBlob(objectRoot, entry.hash), { mode: 0o600 })
      continue
    }
    if (entry.kind === 'symlink' && entry.linkTarget !== undefined) {
      await symlink(entry.linkTarget, dest)
    }
  }
}

async function planOps(
  cwd: string,
  stored: StoredCheckpointRecord,
  excludeGlobs: readonly string[],
): Promise<JournalOp[]> {
  const wanted = new Set(stored.entries.map(entry => entry.relativePath))
  const current = await buildManifest(cwd, { excludeGlobs })
  const ops: JournalOp[] = []
  const extras = current.entries
    .map(entry => entry.relativePath)
    .filter(path => !wanted.has(path))
    .sort((left, right) => right.length - left.length)
  for (const relativePath of extras) ops.push({ kind: 'delete', relativePath })
  for (const entry of stored.entries) {
    if (entry.kind === 'directory') ops.push({ kind: 'mkdir', relativePath: entry.relativePath })
    else if (entry.kind === 'file') ops.push({ kind: 'write', relativePath: entry.relativePath })
    else if (entry.linkTarget !== undefined) {
      ops.push({ kind: 'symlink', relativePath: entry.relativePath, linkTarget: entry.linkTarget })
    }
  }
  return ops
}

async function backupCurrent(cwd: string, backup: string, excludeGlobs: readonly string[]): Promise<void> {
  const current = await buildManifest(cwd, { excludeGlobs })
  await mkdir(backup, { recursive: true, mode: 0o700 })
  for (const entry of current.entries) {
    const source = fromManifestPath(cwd, entry.relativePath)
    const dest = fromManifestPath(backup, entry.relativePath)
    const info = await lstat(source)
    if (info.isSymbolicLink()) {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await symlink(await readlink(source), dest)
      continue
    }
    if (info.isDirectory()) {
      await mkdir(dest, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    await writeFile(dest, await readFile(source), { mode: 0o600 })
  }
}

async function applyJournal(journal: RestoreJournal): Promise<void> {
  for (const op of journal.ops) {
    const dest = fromManifestPath(journal.cwd, op.relativePath)
    if (op.kind === 'delete') {
      await rm(dest, { recursive: true, force: true })
      continue
    }
    if (op.kind === 'mkdir') {
      await mkdir(dest, { recursive: true, mode: 0o700 })
      continue
    }
    await rm(dest, { recursive: true, force: true })
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    if (op.kind === 'symlink') {
      await symlink(op.linkTarget, dest)
      continue
    }
    const staged = fromManifestPath(journal.stagingDir, op.relativePath)
    await restoreInternals.rename(staged, dest)
  }
}

async function rollbackJournal(journal: RestoreJournal, excludeGlobs: readonly string[]): Promise<void> {
  const current = await buildManifest(journal.cwd, { excludeGlobs })
  for (const entry of [...current.entries].sort((left, right) => right.relativePath.length - left.relativePath.length)) {
    await rm(fromManifestPath(journal.cwd, entry.relativePath), { recursive: true, force: true })
  }
  const backup = await buildManifest(journal.backupDir, { excludeGlobs: [] }).catch(() => undefined)
  if (backup === undefined) return
  for (const entry of backup.entries) {
    const source = fromManifestPath(journal.backupDir, entry.relativePath)
    const dest = fromManifestPath(journal.cwd, entry.relativePath)
    const info = await lstat(source)
    if (info.isSymbolicLink()) {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await symlink(await readlink(source), dest)
      continue
    }
    if (info.isDirectory()) {
      await mkdir(dest, { recursive: true, mode: 0o700 })
      continue
    }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    await writeFile(dest, await readFile(source), { mode: 0o600 })
  }
}
