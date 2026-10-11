/** Web SSE transport for page-owned client entry reconciliation and rebuilt code replacement. */
import type { Context } from '@deepseek-ai/cordis'
import type { PluginsEventParseResult } from '../events.ts'
import { EVENTS_ROUTE, parsePluginsEventFrame } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required service: the client module system whose entry controller handles received frames. */
export const inject = ['modules']

/** Page-to-page message: a follower asking for the latest graph, or one relayed valid SSE frame. */
type ChannelMessage = { kind: 'hello' } | { kind: 'frame'; frame: Frame }

type Frame = Extract<PluginsEventParseResult, { kind: 'frame' }>['frame']

/**
 * Forward graph snapshots and rebuilds to the page's shared serial controller.
 *
 * Browsers cap HTTP/1.1 connections per origin at six, and an EventSource holds
 * one for its lifetime, so the pages of one app mount (keyed by the resolved
 * events URL) elect one leader through a Web Lock. Only the leader opens the
 * EventSource; it relays every frame to the other pages over a BroadcastChannel
 * and answers a newcomer's `hello` with the latest graph. When the leader
 * closes, the next page acquires the lock and connects. Contexts without Web
 * Locks (plain-HTTP LAN addresses are not secure contexts) keep one EventSource
 * per page.
 * @param ctx - Plugin context with the client module system.
 */
export function apply(ctx: Context): void {
  const entries = ctx.modules.entries
  const handle = (frame: Frame): void => {
    const run = frame.type === 'graph'
      ? Promise.resolve().then(() => entries.sync(frame.graph))
      : entries.reload(frame.id, frame.rev)
    void run.catch((error: unknown) => { ctx.logger.error(error) })
  }
  const parse = (data: string): Frame | undefined => {
    let value: unknown
    try {
      value = JSON.parse(data) as unknown
    } catch {
      // Wire boundary: a malformed transport frame is dropped loudly.
      ctx.logger.warn(`client-hmr: unparseable event frame: ${data}`)
      return undefined
    }
    const parsed = parsePluginsEventFrame(value)
    if (parsed.kind === 'invalid') ctx.logger.warn(`client-hmr: invalid event frame: ${data}`)
    return parsed.kind === 'frame' ? parsed.frame : undefined
  }
  const connect = (onFrame: (frame: Frame) => void): EventSource => {
    const source = new EventSource(EVENTS_ROUTE)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      const frame = parse(event.data)
      if (frame !== undefined) onFrame(frame)
    })
    return source
  }

  ctx.effect(() => {
    // DOM types declare `locks` unconditionally; insecure contexts omit it.
    const locks = navigator.locks as LockManager | undefined
    if (locks === undefined) {
      const source = connect(handle)
      return () => { source.close() }
    }
    // One name per resolved events URL: apps mounted at different paths of one
    // origin elect separate leaders and never see each other's frames.
    const leaderName = `dsh-client-hmr:${new URL(EVENTS_ROUTE, document.baseURI).href}`
    const channel = new BroadcastChannel(leaderName)
    const post = (message: ChannelMessage): void => { channel.postMessage(message) }
    // Set only while this page leads; a follower's hello finds it undefined.
    let latestGraph: Frame | undefined
    channel.addEventListener('message', (event: MessageEvent<ChannelMessage>) => {
      const message = event.data
      if (message.kind === 'frame') handle(message.frame)
      else if (latestGraph !== undefined) post({ kind: 'frame', frame: latestGraph })
    })
    const disposed = new AbortController()
    const released = Promise.withResolvers<void>()
    locks.request(leaderName, { signal: disposed.signal }, async () => {
      const source = connect((frame) => {
        if (frame.type === 'graph') latestGraph = frame
        post({ kind: 'frame', frame })
        handle(frame)
      })
      await released.promise
      source.close()
    }).catch((_abortedWhileQueued: unknown) => {
      // Disposal aborts a page still queued for leadership; it opened nothing.
    })
    post({ kind: 'hello' })
    return () => {
      disposed.abort()
      released.resolve()
      channel.close()
    }
  }, 'client-hmr: event source')
}
