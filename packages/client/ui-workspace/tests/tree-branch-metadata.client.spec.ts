import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveFlat, deriveSearchResults } from '../src/client/tree.ts'

const sid = (id: string) => id as SessionId
const branched: SessionSummary = {
  id: sid('branched'), displayTitle: 'Branched needle', running: false, blank: false, updatedAt: 5,
  checkpointLabelIndex: 3, workspaceResumable: false,
}
const sessions: SessionListState = {
  ids: [branched.id],
  byId: { [branched.id]: branched },
  current: undefined,
  phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}
const noAttention: ReadonlyMap<SessionId, SessionPendingInteractionBase> = new Map()

describe('branch metadata on Session rows', () => {
  it('carries the checkpoint label index and workspace-resumable flag onto flat rows', () => {
    expect(deriveFlat(sessions, [], noAttention)[0])
      .toMatchObject({ checkpointLabelIndex: 3, workspaceResumable: false })
  })

  it('carries the checkpoint label index and workspace-resumable flag onto search results', () => {
    const result = deriveSearchResults(sessions, [], 'needle', [], noAttention, { items: [], hasMore: false }, 5)
    expect(result.items[0]).toMatchObject({ id: branched.id, checkpointLabelIndex: 3, workspaceResumable: false })
  })
})
