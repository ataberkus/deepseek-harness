import { describe, expect, it } from 'vitest'
import type { CheckpointSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { selectEditCheckpoint } from '../src/client/chat/MessageItem.tsx'

function snapshot(checkpoints: CheckpointSnapshot['checkpoints'], enabled = true): CheckpointSnapshot {
  return { enabled, checkpoints }
}

function row(
  id: string,
  boundarySeq: number,
  overrides: Partial<CheckpointSnapshot['checkpoints'][number]> = {},
): CheckpointSnapshot['checkpoints'][number] {
  return {
    id: id as never,
    sessionId: 'session-1' as never,
    boundarySeq,
    labelIndex: boundarySeq + 1,
    role: 'turn',
    status: { kind: 'ready' },
    restoreEligible: true,
    fileCount: 1,
    createdAt: boundarySeq,
    ...overrides,
  }
}

describe('selectEditCheckpoint', () => {
  it('returns undefined when checkpoints are disabled', () => {
    expect(selectEditCheckpoint(snapshot([row('cp-0', -1)], false), 5)).toBeUndefined()
  })

  it('picks the latest eligible checkpoint before the message', () => {
    const checkpoints = snapshot([row('cp-0', -1), row('cp-1', 10), row('cp-2', 20)])
    expect(selectEditCheckpoint(checkpoints, 25)?.id).toBe('cp-2')
    expect(selectEditCheckpoint(checkpoints, 20)?.id).toBe('cp-1')
    expect(selectEditCheckpoint(checkpoints, 0)?.id).toBe('cp-0')
  })

  it('skips emergency, unready, and ineligible rows', () => {
    const checkpoints = snapshot([
      row('cp-0', -1),
      row('cp-emergency', 5, { role: 'emergency' }),
      row('cp-unready', 6, { status: { kind: 'unavailable', reason: 'x' } }),
      row('cp-ineligible', 7, { restoreEligible: false }),
      row('cp-1', 10),
    ])
    expect(selectEditCheckpoint(checkpoints, 25)?.id).toBe('cp-1')
    expect(selectEditCheckpoint(checkpoints, 10)?.id).toBe('cp-0')
  })

  it('returns undefined with no checkpoint before the message', () => {
    expect(selectEditCheckpoint(snapshot([]), 5)).toBeUndefined()
    expect(selectEditCheckpoint(undefined, 5)).toBeUndefined()
  })
})
