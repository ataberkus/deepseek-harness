import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { StatsPillsProps } from '../src/client/chat/StatsPills.tsx'

/**
 * Session standard props backed by a complete isolated session-list store.
 * @param byId - session summaries visible to the fixture.
 * @param sessionId - current session identity.
 * @returns the required session selector and identity.
 */
export function statsSessionFixture(
  byId: SessionListState['byId'] = {},
  sessionId = 's1' as SessionId,
): Pick<StatsPillsProps, 'useSessions' | 'sessionId'> {
  return {
    sessionId,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: Object.keys(byId) as SessionId[], byId, current: sessionId, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })),
  }
}
