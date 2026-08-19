/**
 * Durable storage-domain declaration for workspace-file checkpoint metadata.
 * File bytes live in the local object store; this domain holds records and the
 * per-session index only.
 * @module @deepseek-ai/dsh-workspace-checkpoint/src/spec
 */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CheckpointId } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Runtime schema for one durable {@link import('./types.ts').CheckpointRecord}. */
export const checkpointRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceKey: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  boundarySeq: z.number().int().gte(-1),
  parentCheckpointId: z.string().min(1).optional(),
  role: z.enum(['initial', 'turn', 'emergency']),
  turnOutcome: z.enum(['initial', 'completed', 'failed', 'cancelled', 'interrupted']),
  status: z.union([
    z.object({ kind: z.literal('ready') }),
    z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }),
  ]),
  createdAt: nonNegativeSafeInteger,
  manifestHash: z.string().min(1),
  fileCount: nonNegativeSafeInteger,
  restoreEligible: z.boolean(),
  labelIndex: z.number().int().nonnegative(),
  entries: z.array(z.object({
    relativePath: z.string().min(1),
    kind: z.enum(['file', 'directory', 'symlink']),
    mode: z.number().int().optional(),
    size: nonNegativeSafeInteger,
    hash: z.string().min(1).optional(),
    linkTarget: z.string().optional(),
    restoreSafe: z.boolean(),
  })),
})

/** Runtime schema for one session's checkpoint index sidecar. */
export const sessionCheckpointIndexSchema = z.object({
  checkpointIds: z.array(z.string().min(1)),
  appliedCheckpointId: z.string().min(1).optional(),
  emergencyCheckpointId: z.string().min(1).optional(),
  recoveryRequired: z.string().min(1).optional(),
})

/** Inferred durable checkpoint row. */
export type StoredCheckpointRecord = z.infer<typeof checkpointRecordSchema>
/** Inferred per-session checkpoint index row. */
export type StoredSessionCheckpointIndex = z.infer<typeof sessionCheckpointIndexSchema>

/**
 * The workspace_checkpoint domain spec. Version 0: no compatibility with other
 * media; a version mismatch rejects at open.
 */
export const workspaceCheckpointDomainSpec = defineDomain({
  name: 'workspace_checkpoint',
  version: 0,
  tables: {
    checkpoints: domainTable<CheckpointId, StoredCheckpointRecord>(checkpointRecordSchema),
    sessions: domainTable<SessionId, StoredSessionCheckpointIndex>(sessionCheckpointIndexSchema),
  },
})
