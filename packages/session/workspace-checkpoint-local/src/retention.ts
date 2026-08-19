/**
 * Evict oldest unreferenced checkpoints until the blob store fits `maxTotalBytes`.
 * Applied and emergency checkpoints, and parents on their chain, stay eligible.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/retention
 */

import { rm } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { CheckpointId, workspaceCheckpointDomainSpec } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { StoredCheckpointRecord, StoredSessionCheckpointIndex } from '@deepseek-ai/dsh-workspace-checkpoint'
import { blobPath, totalBlobBytes } from './objects.ts'

type CheckpointDomain = Domain<typeof workspaceCheckpointDomainSpec>
type CheckpointTable = KvTable<CheckpointId, StoredCheckpointRecord>
type SessionTable = KvTable<SessionId, StoredSessionCheckpointIndex>

/**
 * Mark evictable checkpoints unavailable and delete blobs they uniquely owned.
 * @param domain - open workspace_checkpoint domain.
 * @param objectRoot - blob store root.
 * @param maxTotalBytes - configured blob cap.
 * @returns session ids whose records changed.
 */
export async function evictCheckpoints(
  domain: CheckpointDomain,
  objectRoot: string,
  maxTotalBytes: number,
): Promise<readonly SessionId[]> {
  const checkpoints = domain.table('checkpoints')
  const sessions = domain.table('sessions')
  const changed = new Set<string>()
  const protectedIds = protectedCheckpointIds(checkpoints, sessions)
  while (await totalBlobBytes(objectRoot) > maxTotalBytes) {
    const victim = oldestEvictable(checkpoints, protectedIds)
    if (victim === undefined) break
    await checkpoints.put(CheckpointId(victim.id), {
      ...victim,
      restoreEligible: false,
      status: { kind: 'unavailable', reason: 'evicted' },
    })
    changed.add(victim.sessionId)
    protectedIds.delete(victim.id)
    await deleteUnreferencedBlobs(objectRoot, checkpoints)
  }
  return [...changed].map(id => SessionId(id))
}

function protectedCheckpointIds(checkpoints: CheckpointTable, sessions: SessionTable): Set<string> {
  const byId = new Map<string, StoredCheckpointRecord>()
  for (const [id, record] of checkpoints.entries()) byId.set(id, record)
  const protectedIds = new Set<string>()
  for (const [, index] of sessions.entries()) {
    retainChain(protectedIds, byId, index.appliedCheckpointId)
    retainChain(protectedIds, byId, index.emergencyCheckpointId)
  }
  return protectedIds
}

function retainChain(
  protectedIds: Set<string>,
  byId: Map<string, StoredCheckpointRecord>,
  start: string | undefined,
): void {
  let current = start
  while (current !== undefined && !protectedIds.has(current)) {
    protectedIds.add(current)
    current = byId.get(current)?.parentCheckpointId
  }
}

function oldestEvictable(
  checkpoints: CheckpointTable,
  protectedIds: Set<string>,
): StoredCheckpointRecord | undefined {
  let oldest: StoredCheckpointRecord | undefined
  for (const [, stored] of checkpoints.entries()) {
    if (!stored.restoreEligible || protectedIds.has(stored.id)) continue
    if (oldest === undefined || stored.createdAt < oldest.createdAt) oldest = stored
  }
  return oldest
}

async function deleteUnreferencedBlobs(objectRoot: string, checkpoints: CheckpointTable): Promise<void> {
  const live = new Set<string>()
  for (const [, stored] of checkpoints.entries()) {
    if (!stored.restoreEligible) continue
    for (const entry of stored.entries) {
      if (entry.hash !== undefined) live.add(entry.hash)
    }
  }
  const seen = new Set<string>()
  for (const [, stored] of checkpoints.entries()) {
    for (const entry of stored.entries) {
      if (entry.hash === undefined || live.has(entry.hash) || seen.has(entry.hash)) continue
      seen.add(entry.hash)
      await rm(blobPath(objectRoot, entry.hash), { force: true })
    }
  }
}
