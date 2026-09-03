// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionListState, SessionSummary, UseProjection,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { assistantStepReading } from '../contract/turn-metrics.ts'
import { formatCacheHitPercent, formatTokens } from './token-format.ts'
import css from './StatsLine.module.css'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ChatSnapshot['legacy']['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number, t: ChatViewSlotProps['t']): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}
/**
 * Format a positive session spend without displaying a misleading zero-cent total.
 * @param usd - cumulative provider-reported spend in US dollars.
 * @returns a dollar amount with four decimals for sub-cent precision and two otherwise.
 */
export function formatCost(usd: number): string {
  const cents = usd * 100
  const hasSubCentPrecision = Math.abs(cents - Math.round(cents)) > 1e-9
  return usd < 0.01 || hasSubCentPrecision ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  return formatCacheHitPercent(usage.cacheReadTokens, denominator)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}
/** Return one positive provider-reported spend value, treating old data as unknown. */
function positiveSpend(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Read one session summary's cumulative provider-reported spend. */
function summarySpend(summary: SessionSummary | undefined): number {
  return positiveSpend(summary?.projectionValues?.tokenUsage?.costUsd)
}

/** Sum descendants connected through uninterrupted subagent-origin lineage. */
function subagentDescendantSpend(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
  ownerId: SessionId,
): number {
  let total = 0
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent' || descendant.id === ownerId) continue
    const spend = summarySpend(descendant)
    if (spend === 0) continue
    const seen = new Set<SessionId>()
    let current: SessionSummary | undefined = descendant
    while (current !== undefined && current.origin === 'subagent'
      && current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.parentId === ownerId) {
        total += spend
        break
      }
      current = summaries[current.parentId]
    }
  }
  return total
}

/** Empty selector used by isolated unit fixtures that do not mount ui-session. */
const EMPTY_SESSION_LIST_SELECTOR: SnapshotSelectorHook<SessionListState> = selector =>
  selector({ byId: {} } as SessionListState)

/** Props: the conversation-snapshot selector plus the projection read seat. */
export interface StatsLineProps {
  useChat: SnapshotSelectorHook<ChatSnapshot>
  useProjection: UseProjection
  /** Session-list selector used to include connected subagent spend. */
  useSessions?: SnapshotSelectorHook<SessionListState>
  /** Current session identity used to root descendant spend. */
  sessionId?: SessionId
  /** The owning dock's locale seat. */
  t: ChatViewSlotProps['t']
}

/** Render and measure one non-empty statistics line. */
const StatsLineContent = memo(function StatsLineContent({
  groups,
  line,
}: {
  readonly groups: readonly string[]
  readonly line: string
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  const measure = useCallback(() => {
    const el = rootRef.current
    if (el === null) return
    const next = el.scrollWidth > el.clientWidth
    setTruncated(current => current === next ? current : next)
  }, [])
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [measure])
  useLayoutEffect(measure, [line, measure])
  return (
    <Tooltip label={line} side="top" delayMs={500} disabled={!truncated}>
      <div ref={rootRef} className={css.root}>
        {groups.map((group, i) => (
          <Fragment key={group}>
            {i > 0 && <><span className={css.sep} aria-hidden>|</span>{' '}</>}
            <span>{group}</span>
          </Fragment>
        ))}
      </div>
    </Tooltip>
  )
})

export const StatsLine = memo(function StatsLine({ useChat, useProjection, useSessions, sessionId, t }: StatsLineProps) {
  const settledNodes = useChat(s => s.legacy.nodes)
  const usage = useProjection('tokenUsage')
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names), paid only
  // while no projection value is served.
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  // Pipe-separated groups (figma stats strip); a group with no data drops out whole.
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs, t) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs, t) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) {
      speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps, t) }))
    }
    if (stats.decodeMs > 0) {
      speeds.push(t('stats.tokensPerSecond', {
        throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
      }))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  const summaries = (useSessions ?? EMPTY_SESSION_LIST_SELECTOR)(list => list.byId)
  const ownCostUsd = positiveSpend(usage?.costUsd)
  const descendantCostUsd = sessionId === undefined
    ? 0
    : subagentDescendantSpend(summaries, sessionId)
  const totalCostUsd = ownCostUsd + descendantCostUsd
  const costLabel = totalCostUsd > 0
    ? descendantCostUsd > 0
      ? t('stats.costWithSubagents', {
        cost: formatCost(totalCostUsd), own: formatCost(ownCostUsd),
      })
      : t('stats.cost', { cost: formatCost(ownCostUsd) })
    : undefined
  // Context occupancy deliberately lives on the composer's ContextMeter ring,
  // not here — one home per fact.
  // Billing rides the durable projection, so these survive paging and
  // compaction. Gated on actual token or spend activity: a session whose
  // steps all settled without billing shows its counts without a zero group.
  const hasBillingActivity = usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0 || ownCostUsd > 0)
  if (hasBillingActivity) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(t('stats.cacheHit', { percent: cacheHit }))
    if (costLabel !== undefined) groups.push(costLabel)
    groups.push(t('stats.tokens', {
      input: formatTokens(billedInputTokens(usage), t),
      output: formatTokens(usage.outputTokens, t),
    }))
  } else if (costLabel !== undefined) {
    groups.push(costLabel)
  }
  const line = groups.join(' | ')
  if (groups.length === 0) return null
  return <StatsLineContent groups={groups} line={line} />
})
