/**
 * Map Cursor AgentService/Run InteractionUpdate frames onto pi-ai streamSimple.
 *
 * Native Cursor exec/shell/MCP channels are ignored so harness tools and
 * approvals stay on this adapter's loop. MCP tool calls advertised as `dsh`
 * map to pi-ai `toolCall` / `toolUse`. Conversation checkpoints stay in process,
 * keyed by `sessionId`.
 *
 * @module dsh-llm-pi-ai/cursor/stream
 */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import {
  CURSOR_BASE_URL,
  CURSOR_CLIENT_HEARTBEAT_INTERVAL_MS,
  CURSOR_RUN_PATH,
} from './constants.ts'
import { connectStream } from './connect.ts'
import {
  concat,
  decodeFields,
  encodeEmptyMessage,
  encodeMessage,
  encodeString,
  encodeVarint,
  fieldMapBytes,
  fieldRepeated,
  fieldString,
  fieldVarint,
} from './protobuf.ts'
import {
  collectContextImages,
  contextEndsWithToolResult,
  encodeAgentRunClientMessage,
  encodeAllowlistPrecheckResponse,
  encodeCursorClientHeartbeat,
  encodeCursorInteractionResponse,
  encodeExecStreamClose,
  encodeExecThrowResponse,
  encodeKvGetBlobResponse,
  encodeKvSetBlobResponse,
  encodeRequestContextResponse,
  flattenContextText,
  latestTurnText,
  streamMaxMode,
} from './request.ts'

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

interface SessionState {
  conversationId: string
  blobStore: Map<string, Uint8Array>
  checkpoint?: Uint8Array
  awaitingTools: boolean
}
const sessions = new Map<string, SessionState>()

/** Test hook: drop in-process conversation checkpoints. */
export function resetCursorSessions(): void {
  sessions.clear()
}

/**
 * Cursor `stream` / `streamSimple` implementation.
 * @param model - Cursor model descriptor.
 * @param context - harness-converted pi-ai context.
 * @param options - auth headers, abort, session id, reasoning.
 * @returns a pi-ai assistant event stream.
 */
export function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void runCursorStream(stream, model, context, options)
  return stream
}

async function runCursorStream(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const partial = emptyAssistant(model)
  const pushPartial = (): AssistantMessage => ({ ...partial, content: [...partial.content] })
  try {
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial), 'aborted')
      return
    }
    const accessToken = accessTokenFromOptions(options)
    if (accessToken === undefined) {
      throw new Error(`Provider is not configured: ${model.provider}`)
    }
    const session = sessionState(options?.sessionId)
    const flatten = session.checkpoint === undefined
      || session.awaitingTools
      || contextEndsWithToolResult(context)
    const includeCheckpoint = !flatten && session.checkpoint !== undefined
    let userText: string
    if (flatten) userText = flattenContextText(context)
    else userText = latestTurnText(context)
    const images = collectContextImages(context, !flatten)
    const body = encodeAgentRunClientMessage({
      conversationId: session.conversationId,
      ...includeCheckpoint ? { checkpoint: session.checkpoint } : {},
      context,
      blobStore: session.blobStore,
      userText,
      ...images.length === 0 ? {} : { images },
      ...context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt },
      modelId: model.id,
      modelName: model.name,
      ...context.tools === undefined ? {} : { tools: context.tools },
      maxMode: streamMaxMode(options),
      thinking: model.reasoning && options?.reasoning !== undefined,
      ...options?.reasoning === undefined ? {} : { thinkingEffort: options.reasoning },
    })
    stream.push({ type: 'start', partial: pushPartial() })
    let textIndex: number | undefined
    let thinkingIndex: number | undefined
    const toolCalls: ToolCall[] = []
    const partialArgs = new Map<string, string>()
    let turnEnded = false
    let sendToCursor: ((payload: Uint8Array) => void) | undefined
    const heartbeat = setInterval(() => {
      sendToCursor?.(encodeCursorClientHeartbeat())
    }, CURSOR_CLIENT_HEARTBEAT_INTERVAL_MS)
    try {
      for await (const payload of connectStream({
        baseUrl: model.baseUrl || CURSOR_BASE_URL,
        path: CURSOR_RUN_PATH,
        accessToken,
        body,
        onOpen: (send) => { sendToCursor = send },
        ...options?.signal === undefined ? {} : { signal: options.signal },
      })) {
        if (options?.signal?.aborted) {
          fail(stream, aborted(partial), 'aborted')
          return
        }
        const message = decodeFields(payload)
        const checkpoint = fieldRepeated(message, 3)[0]
        if (checkpoint !== undefined) session.checkpoint = checkpoint

        for (const kvField of fieldRepeated(message, 4)) {
          const kvFields = decodeFields(kvField)
          const id = fieldVarint(kvFields, 1)
          const idNum = id !== undefined && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : undefined
          if (idNum !== undefined) {
            const getBlobField = fieldRepeated(kvFields, 2)[0]
            if (getBlobField !== undefined) {
              const blobId = fieldRepeated(decodeFields(getBlobField), 1)[0]
              const hex = blobId !== undefined ? Buffer.from(blobId).toString('hex') : ''
              const blobData = session.blobStore.get(hex)
              sendToCursor?.(encodeKvGetBlobResponse(idNum, blobData))
            }
            const setBlobField = fieldRepeated(kvFields, 3)[0]
            if (setBlobField !== undefined) {
              const setBlobFields = decodeFields(setBlobField)
              const blobId = fieldRepeated(setBlobFields, 1)[0]
              const blobData = fieldRepeated(setBlobFields, 2)[0]
              if (blobId !== undefined && blobData !== undefined) {
                session.blobStore.set(Buffer.from(blobId).toString('hex'), blobData)
              }
              sendToCursor?.(encodeKvSetBlobResponse(idNum))
            }
          }
        }

        for (const execField of fieldRepeated(message, 2)) {
          const execFields = decodeFields(execField)
          const id = fieldVarint(execFields, 1)
          const execId = fieldString(execFields, 15)
          const idNum = id !== undefined && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : undefined
          if (idNum !== undefined) {
            if (fieldRepeated(execFields, 10).length > 0) {
              sendToCursor?.(encodeRequestContextResponse(idNum, execId, context.systemPrompt, context.tools))
            } else if (fieldRepeated(execFields, 41).length > 0) {
              sendToCursor?.(encodeAllowlistPrecheckResponse(idNum, execId, 41))
            } else if (fieldRepeated(execFields, 42).length > 0) {
              sendToCursor?.(encodeAllowlistPrecheckResponse(idNum, execId, 42))
            } else if (fieldRepeated(execFields, 43).length > 0) {
              sendToCursor?.(encodeAllowlistPrecheckResponse(idNum, execId, 43))
            } else if (fieldRepeated(execFields, 11).length > 0) {
              const mcpArgsFields = decodeFields(fieldRepeated(execFields, 11)[0] ?? new Uint8Array())
              const isApproval = fieldVarint(mcpArgsFields, 7) === 1n || fieldRepeated(mcpArgsFields, 6).length > 0
              if (isApproval) {
                const execClientMsg = concat(
                  encodeVarint((1 << 3) | 0),
                  encodeVarint(idNum),
                  execId.length > 0 ? encodeString(15, execId) : new Uint8Array(),
                  encodeEmptyMessage(7),
                )
                sendToCursor?.(encodeMessage(2, encodeMessage(11, execClientMsg)))
              } else {
                sendToCursor?.(encodeExecThrowResponse(idNum, 'MCP tool not available', 'tool_unavailable'))
                sendToCursor?.(encodeExecStreamClose(idNum))
              }
            } else {
              sendToCursor?.(encodeExecThrowResponse(idNum, 'Not implemented by this client', 'exec_variant_unsupported'))
              sendToCursor?.(encodeExecStreamClose(idNum))
            }
          }
        }
        const interactionQuery = fieldRepeated(message, 7)[0]
        if (interactionQuery !== undefined) {
          const query = decodeFields(interactionQuery)
          const queryId = fieldVarint(query, 1)
          const queryField = query.find(field => field.field >= 2 && field.wire === 2)?.field
          const queryIdNumber = queryId !== undefined && queryId <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(queryId)
            : undefined
          if (queryIdNumber !== undefined && queryField !== undefined) {
            const response = encodeCursorInteractionResponse(queryIdNumber, queryField)
            if (response !== undefined) sendToCursor?.(response)
          }
        }

        const update = fieldRepeated(message, 1)[0]
        if (update === undefined) continue
        for (const field of decodeFields(update)) {
          switch (field.field) {
            case 1: {
              const delta = fieldString(decodeFields(field.bytes), 1)
              if (delta.length === 0) break
              textIndex ??= openText(stream, partial, pushPartial)
              const block = partial.content[textIndex]
              /* v8 ignore next -- openText always pushes a text block at this index. */
              if (block?.type === 'text') block.text += delta
              stream.push({ type: 'text_delta', contentIndex: textIndex, delta, partial: pushPartial() })
              break
            }
            case 4: {
              const delta = fieldString(decodeFields(field.bytes), 1)
              if (delta.length === 0) break
              thinkingIndex ??= openThinking(stream, partial, pushPartial)
              const block = partial.content[thinkingIndex]
              /* v8 ignore next -- openThinking always pushes a thinking block at this index. */
              if (block?.type === 'thinking') block.thinking += delta
              stream.push({ type: 'thinking_delta', contentIndex: thinkingIndex, delta, partial: pushPartial() })
              break
            }
            case 2:
            case 3:
            case 7: {
              const parsed = parseMcpToolUpdate(field.bytes, partialArgs)
              if (parsed === undefined) break
              const existing = toolCalls.find(call => call.id === parsed.id)
              if (existing !== undefined) {
                if (Object.keys(parsed.arguments).length > 0) {
                  existing.arguments = parsed.arguments
                }
                break
              }
              closeOpenBlocks(stream, partial, textIndex, thinkingIndex, pushPartial)
              textIndex = undefined
              thinkingIndex = undefined
              const contentIndex = partial.content.length
              partial.content.push(parsed)
              toolCalls.push(parsed)
              stream.push({ type: 'toolcall_start', contentIndex, partial: pushPartial() })
              const delta = JSON.stringify(parsed.arguments)
              stream.push({ type: 'toolcall_delta', contentIndex, delta, partial: pushPartial() })
              stream.push({ type: 'toolcall_end', contentIndex, toolCall: parsed, partial: pushPartial() })
              break
            }
            case 14:
              turnEnded = true
              break
            default:
              break
          }
        }
        if (turnEnded) break
      }
    } finally {
      clearInterval(heartbeat)
      sendToCursor = undefined
    }
    closeOpenBlocks(stream, partial, textIndex, thinkingIndex, pushPartial)
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial), 'aborted')
      return
    }
    if (toolCalls.length > 0) {
      session.awaitingTools = true
      partial.stopReason = 'toolUse'
      stream.push({ type: 'done', reason: 'toolUse', message: pushPartial() })
      stream.end(pushPartial())
      return
    }
    session.awaitingTools = false
    partial.stopReason = 'stop'
    stream.push({ type: 'done', reason: 'stop', message: pushPartial() })
    stream.end(pushPartial())
  } catch (error) {
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial), 'aborted')
      return
    }
    const failed: AssistantMessage = {
      ...partial,
      stopReason: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    }
    fail(stream, failed, 'error')
  }
}

function sessionState(sessionId: string | undefined): SessionState {
  if (sessionId === undefined || sessionId.length === 0) {
    return { conversationId: crypto.randomUUID(), blobStore: new Map(), awaitingTools: false }
  }
  const existing = sessions.get(sessionId)
  if (existing !== undefined) return existing
  const created: SessionState = { conversationId: sessionId, blobStore: new Map(), awaitingTools: false }
  sessions.set(sessionId, created)
  return created
}

function accessTokenFromOptions(options: SimpleStreamOptions | undefined): string | undefined {
  const headers = options?.headers
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'authorization' || typeof value !== 'string') continue
      const bearer = /^Bearer\s+(\S+)/i.exec(value)
      const token = (bearer?.[1] ?? value).trim()
      if (token.length > 0) return token
    }
  }
  const apiKey = options?.apiKey?.trim()
  return apiKey === undefined || apiKey.length === 0 ? undefined : apiKey
}

function emptyAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function aborted(partial: AssistantMessage): AssistantMessage {
  return { ...partial, content: [...partial.content], stopReason: 'aborted', errorMessage: 'Request was aborted' }
}

function fail(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  reason: 'error' | 'aborted',
): void {
  stream.push({ type: 'error', reason, error: message })
  stream.end(message)
}

function openText(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  snapshot: () => AssistantMessage,
): number {
  const index = partial.content.length
  partial.content.push({ type: 'text', text: '' } satisfies TextContent)
  stream.push({ type: 'text_start', contentIndex: index, partial: snapshot() })
  return index
}

function openThinking(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  snapshot: () => AssistantMessage,
): number {
  const index = partial.content.length
  partial.content.push({ type: 'thinking', thinking: '' } satisfies ThinkingContent)
  stream.push({ type: 'thinking_start', contentIndex: index, partial: snapshot() })
  return index
}

function closeOpenBlocks(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  textIndex: number | undefined,
  thinkingIndex: number | undefined,
  snapshot: () => AssistantMessage,
): void {
  if (thinkingIndex !== undefined) {
    const block = partial.content[thinkingIndex]
    stream.push({
      type: 'thinking_end',
      contentIndex: thinkingIndex,
      /* v8 ignore next -- thinkingIndex is only set after a thinking block is opened. */
      content: block?.type === 'thinking' ? block.thinking : '',
      partial: snapshot(),
    })
  }
  if (textIndex !== undefined) {
    const block = partial.content[textIndex]
    stream.push({
      type: 'text_end',
      contentIndex: textIndex,
      /* v8 ignore next -- textIndex is only set after a text block is opened. */
      content: block?.type === 'text' ? block.text : '',
      partial: snapshot(),
    })
  }
}

function parseMcpToolUpdate(
  bytes: Uint8Array,
  partialArgs: Map<string, string>,
): ToolCall | undefined {
  const fields = decodeFields(bytes)
  const callId = fieldString(fields, 1)
  const argsDelta = fieldString(fields, 3)
  if (argsDelta.length > 0 && callId.length > 0) {
    partialArgs.set(callId, `${partialArgs.get(callId) ?? ''}${argsDelta}`)
  }
  const toolCall = fieldRepeated(fields, 2)[0]
  const fromTool = toolCall === undefined ? undefined : mcpToolCall(toolCall, callId)
  if (fromTool !== undefined) return fromTool
  const accumulated = callId.length === 0 ? undefined : partialArgs.get(callId)
  if (accumulated === undefined || callId.length === 0) return undefined
  return {
    type: 'toolCall',
    id: callId,
    name: 'unknown',
    arguments: parseJsonObject(accumulated),
  }
}

function mcpToolCall(toolCall: Uint8Array, fallbackId: string): ToolCall | undefined {
  const mcp = fieldRepeated(decodeFields(toolCall), 15)[0]
  if (mcp === undefined) return undefined
  const envelope = decodeFields(mcp)
  const argsMessage = fieldRepeated(envelope, 1)[0]
  if (argsMessage === undefined) return undefined
  const argsFields = decodeFields(argsMessage)
  const name = fieldString(argsFields, 1)
  if (name.length === 0) return undefined
  const id = fieldString(argsFields, 3) || fallbackId || crypto.randomUUID()
  const args: Record<string, unknown> = {}
  for (const [key, value] of fieldMapBytes(argsFields, 2)) {
    args[key] = decodeJsonValue(value)
  }
  return { type: 'toolCall', id, name, arguments: args }
}

function decodeJsonValue(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Partial JSON from a delta; keep a recoverable raw payload.
  }
  return { _raw: text }
}
