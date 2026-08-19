/**
 * Restore journal: planned cwd mutations plus the backup directory used to roll back.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/journal
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CheckpointId } from '@deepseek-ai/dsh-workspace-checkpoint'

/** One planned restore mutation, always cwd-relative. */
export type JournalOp =
  | { readonly kind: 'mkdir'; readonly relativePath: string }
  | { readonly kind: 'write'; readonly relativePath: string }
  | { readonly kind: 'symlink'; readonly relativePath: string; readonly linkTarget: string }
  | { readonly kind: 'delete'; readonly relativePath: string }

/** Durable journal written before the first cwd mutation. */
export interface RestoreJournal {
  readonly checkpointId: CheckpointId
  readonly cwd: string
  readonly backupDir: string
  readonly stagingDir: string
  readonly ops: readonly JournalOp[]
}

/**
 * Journal JSON path for one canonical workspace.
 * @param objectRoot - object-store root.
 * @param workspaceKey - canonical cwd.
 * @returns `{objectRoot}/journals/{sha256}.json`.
 */
export function journalPath(objectRoot: string, workspaceKey: string): string {
  const hash = createHash('sha256').update(workspaceKey).digest('hex')
  return join(objectRoot, 'journals', `${hash}.json`)
}

/**
 * Backup directory for one restore attempt.
 * @param objectRoot - object-store root.
 * @param checkpointId - checkpoint being restored.
 * @returns `{objectRoot}/journals/{id}/backup`.
 */
export function backupDir(objectRoot: string, checkpointId: CheckpointId): string {
  return join(objectRoot, 'journals', checkpointId, 'backup')
}

/**
 * Staging directory for one restore attempt.
 * @param objectRoot - object-store root.
 * @param checkpointId - checkpoint being restored.
 * @returns `{objectRoot}/staging/{id}`.
 */
export function stagingDir(objectRoot: string, checkpointId: CheckpointId): string {
  return join(objectRoot, 'staging', checkpointId)
}

/**
 * Persist the journal before cwd mutations begin.
 * @param path - journal JSON path.
 * @param journal - planned operations.
 */
export async function writeJournal(path: string, journal: RestoreJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 })
}

/**
 * Read a journal if present.
 * @param path - journal JSON path.
 * @returns the journal, or `undefined` when missing.
 */
export async function readJournal(path: string): Promise<RestoreJournal | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RestoreJournal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Remove the journal file after a successful restore or completed rollback.
 * @param path - journal JSON path.
 */
export async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true })
}
