/**
 * Encode AgentRunRequest protobuf for Cursor AgentService/Run.
 *
 * Field numbers follow the unofficial agent.proto used by community CLI
 * clients. Native Cursor shell/exec tools are never advertised; harness tools
 * are sent as MCP definitions so InteractionUpdate MCP calls can map back.
 *
 * @module dsh-llm-pi-ai/cursor/request
 */

import type { Context, SimpleStreamOptions, Tool } from '@earendil-works/pi-ai'
import {
  concat,
  encodeBool,
  encodeBytes,
  encodeEmptyMessage,
  encodeMapBytes,
  encodeMessage,
  encodeProtobufValue,
  encodeVarint,
  encodeString,
} from './protobuf.ts'

/** Identifier Cursor stores on MCP tools this adapter advertises. */
export const CURSOR_MCP_PROVIDER = 'dsh'

/**
 * One raster image for Cursor `SelectedImage` (`uuid`/`path`/`mime_type`/`data`).
 */
export interface CursorSelectedImage {
  /** Client-generated image id. */
  uuid: string
  /** Filename Cursor stores beside the bytes. */
  path: string
  /** Image media type such as `image/png`. */
  mimeType: string
  /** Decoded raster bytes (not base64). */
  data: Uint8Array
}

/** Inputs {@link encodeAgentRunRequest} needs besides the Connect envelope. */
export interface AgentRunEncodeInput {
  /** Session conversation id; reused across turns when a checkpoint exists. */
  conversationId: string
  /** Opaque ConversationStateStructure bytes from the last checkpoint, when any. */
  checkpoint?: Uint8Array
  /** Flattened user text for this turn's UserMessageAction. */
  userText: string
  /** Raster images for `UserMessage.selected_context`; omitted when none. */
  images?: readonly CursorSelectedImage[]
  /** Optional system prompt; sent as `custom_system_prompt`. */
  systemPrompt?: string
  /** Cursor model id. */
  modelId: string
  /** Selector label; defaults to `modelId`. */
  modelName?: string
  /** Harness tools advertised as MCP definitions. */
  tools?: readonly Tool[]
  /** When true, set ModelDetails.max_mode. */
  maxMode?: boolean
  /** When true, include ThinkingDetails so Cursor enables thinking. */
  thinking?: boolean
  /** Canonical effort sent inside ThinkingDetails when thinking is on. */
  thinkingEffort?: string
}

/**
 * Encode one AgentRunRequest.
 * @param input - conversation, model, and tools for this turn.
 * @returns protobuf payload (not Connect-framed).
 */
export function encodeAgentRunRequest(input: AgentRunEncodeInput): Uint8Array {
  const wireModelId = cursorWireModelId(input.modelId, input.thinking, input.thinkingEffort)
  const modelDetails = concat(
    encodeString(1, wireModelId),
    encodeThinkingDetails(input.thinking === true, input.thinkingEffort),
    encodeString(3, input.modelId),
    encodeString(4, input.modelName ?? input.modelId),
    encodeBool(7, input.maxMode === true),
  )
  const requestedModel = concat(
    encodeString(1, wireModelId),
    encodeBool(2, input.maxMode === true),
  )
  return concat(
    input.checkpoint === undefined ? new Uint8Array() : encodeBytes(1, input.checkpoint),
    encodeMessage(2, encodeMessage(1, encodeUserMessage(input.userText, input.images ?? []))),
    encodeMessage(3, modelDetails),
    encodeMcpTools(input.tools ?? []),
    encodeString(5, input.conversationId),
    input.systemPrompt === undefined ? new Uint8Array() : encodeString(8, input.systemPrompt),
    encodeMessage(9, requestedModel),
  )
}

/**
 * Wrap an AgentRunRequest in the current Cursor AgentClientMessage envelope.
 * @param input - conversation, model, and tools for this turn.
 * @returns a protobuf AgentClientMessage payload (not Connect-framed).
 */
export function encodeAgentRunClientMessage(input: AgentRunEncodeInput): Uint8Array {
  return encodeMessage(1, encodeAgentRunRequest(input))
}

/**
 * Encode a Cursor client heartbeat for an open Run stream.
 * @returns a protobuf AgentClientMessage payload (not Connect-framed).
 */
export function encodeCursorClientHeartbeat(): Uint8Array {
  return encodeEmptyMessage(7)
}

/**
 * Encode the response for a Cursor interaction query. Web search and fetch
 * permissions are approved; unsupported interactive operations are rejected so
 * the server can finish the turn instead of waiting forever.
 * @param queryId - server-assigned interaction id.
 * @param queryField - InteractionQuery oneof field number.
 * @returns a protobuf AgentClientMessage payload, or `undefined` when the
 *   operation has no truthful response (Cursor VM setup).
 */
export function encodeCursorInteractionResponse(
  queryId: number,
  queryField: number,
): Uint8Array | undefined {
  if (!Number.isSafeInteger(queryId) || queryId < 0) return undefined
  const result = interactionResult(queryField)
  if (result === undefined) return undefined
  const interactionResponse = concat(
    encodeVarint((1 << 3) | 0),
    encodeVarint(queryId),
    encodeMessage(queryField, result),
  )
  return encodeMessage(6, interactionResponse)
}

function interactionResult(queryField: number): Uint8Array | undefined {
  if (queryField === 2 || queryField === 5 || queryField === 6 || queryField === 9) {
    return encodeEmptyMessage(1)
  }
  if (queryField === 3) {
    return encodeMessage(1, encodeMessage(3, encodeString(1, 'Interactive questions are not supported by this client')))
  }
  if (queryField === 4) {
    return encodeMessage(2, encodeString(1, 'Mode switches are not supported by this client'))
  }
  if (queryField === 7) {
    return encodeMessage(1, encodeMessage(2, encodeString(1, 'Plan files are not supported by this client')))
  }
  return undefined
}

/**
 * Flatten pi-ai context messages into one user-message string. Image bytes
 * travel in `UserMessage.selected_context`, so image blocks contribute no text.
 * @param context - harness-converted pi-ai context.
 * @returns concatenated turn text.
 */
export function flattenContextText(context: Context): string {
  const parts: string[] = []
  for (const message of context.messages) {
    if (message.role === 'user') {
      parts.push(userContentText(message.content))
      continue
    }
    if (message.role === 'assistant') {
      const body = message.content.map((block) => {
        if (block.type === 'text') return block.text
        if (block.type === 'thinking') return block.thinking
        return `${block.name}:${JSON.stringify(block.arguments)}`
      }).join('\n')
      if (body.length > 0) parts.push(body)
      continue
    }
    const result = message.content.map(block => userContentText([block])).join('\n')
    parts.push(`${message.toolName}: ${result.length === 0 ? '(no output)' : result}`)
  }
  return parts.filter(part => part.length > 0).join('\n\n')
}

/**
 * Whether the trailing messages are tool results (a harness tool-use follow-up).
 * @param context - current request context.
 * @returns true when the last message is a tool result.
 */
export function contextEndsWithToolResult(context: Context): boolean {
  const last = context.messages.at(-1)
  return last?.role === 'toolResult'
}

/**
 * Latest user-visible text for a follow-up that still has a conversation checkpoint.
 * @param context - current request context.
 * @returns the last user message text, or flattened tool results.
 */
export function latestTurnText(context: Context): string {
  const last = context.messages.at(-1)
  if (last === undefined) return ''
  if (last.role === 'user') return userContentText(last.content)
  if (last.role === 'toolResult') {
    const trailing: string[] = []
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const message = context.messages[i]
      if (message?.role !== 'toolResult') break
      const result = message.content.map(block => userContentText([block])).join('\n')
      trailing.unshift(`${message.toolName}: ${result.length === 0 ? '(no output)' : result}`)
    }
    return trailing.join('\n\n')
  }
  return flattenContextText(context)
}

/**
 * Encode advertised MCP tools. Empty lists omit the field.
 * @param tools - harness tools.
 * @returns field 4 or empty.
 */
export function encodeMcpTools(tools: readonly Tool[]): Uint8Array {
  if (tools.length === 0) return new Uint8Array()
  const definitions = tools.map(tool => encodeMessage(1, concat(
    encodeString(1, tool.name),
    encodeString(2, tool.description),
    encodeBytes(3, encodeProtobufValue(tool.parameters)),
    encodeString(4, CURSOR_MCP_PROVIDER),
    encodeString(5, tool.name),
  )))
  return encodeMessage(4, concat(...definitions))
}

/**
 * Encode MCP argument map values as JSON UTF-8 bytes.
 * @param args - parsed tool arguments.
 * @returns map field 2 payload.
 */
export function encodeMcpArgMap(args: Readonly<Record<string, unknown>>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [key, value] of Object.entries(args)) {
    entries[key] = new TextEncoder().encode(JSON.stringify(value))
  }
  return encodeMapBytes(2, entries)
}

/**
 * Whether this stream should send max_mode.
 * @param options - pi-ai simple stream options.
 * @returns true for `max` and `xhigh`.
 */
export function streamMaxMode(options: SimpleStreamOptions | undefined): boolean {
  return options?.reasoning === 'max' || options?.reasoning === 'xhigh'
}

/**
 * Translate legacy bare Grok ids to the current Cursor AgentService ids.
 * Cursor keeps Composer ids bare but namespaces hosted Grok SKUs under
 * `cursor-grok`; effort-specific ids are selected when thinking is enabled.
 * @param id - selected model id.
 * @param thinking - whether the request enables thinking.
 * @param effort - requested thinking effort.
 * @returns the model id Cursor expects on the wire.
 */
function cursorWireModelId(id: string, thinking: boolean | undefined, effort: string | undefined): string {
  const match = /^(?:cursor-)?grok-(4\.5|4\.6)(-fast)?$/i.exec(id)
  if (match === null) return id
  const base = `cursor-grok-${match[1]}`
  const fast = match[2] ?? ''
  if (!thinking) return `${base}${fast}`
  const level = effort === undefined || effort === 'off' ? 'low' : effort
  return `${base}-${level}${fast}`
}

/**
 * ThinkingDetails for one run: an empty message enables thinking at Cursor's
 * default, and a named effort is field 1 inside that message.
 * @param thinking - whether the model should think.
 * @param effort - canonical effort; omitted or `off` sends no field 1.
 * @returns ModelDetails field 2, or empty when thinking is off.
 */
function encodeThinkingDetails(thinking: boolean, effort: string | undefined): Uint8Array {
  if (!thinking) return new Uint8Array()
  if (effort === undefined || effort === 'off') return encodeEmptyMessage(2)
  return encodeMessage(2, encodeString(1, effort))
}

function encodeUserMessage(text: string, images: readonly CursorSelectedImage[]): Uint8Array {
  return concat(
    encodeString(1, text),
    encodeString(2, crypto.randomUUID()),
    images.length === 0 ? new Uint8Array() : encodeMessage(3, encodeSelectedContext(images)),
  )
}

function encodeSelectedContext(images: readonly CursorSelectedImage[]): Uint8Array {
  return concat(...images.map(image => encodeMessage(1, concat(
    encodeString(2, image.uuid),
    encodeString(3, image.path),
    encodeString(7, image.mimeType),
    encodeBytes(8, image.data),
  ))))
}

/**
 * Raster images in `context` for the unofficial `SelectedImage` field.
 * A checkpointed follow-up (`latestTurnOnly`) sends only this turn's images;
 * a flattened history sends every user and tool-result image in order.
 * @param context - harness-converted pi-ai context.
 * @param latestTurnOnly - true when conversation state already holds prior turns.
 * @returns images with generated uuids; empty when none.
 */
export function collectContextImages(context: Context, latestTurnOnly = false): CursorSelectedImage[] {
  const images: CursorSelectedImage[] = []
  for (const message of latestTurnOnly ? latestTurnMessages(context) : context.messages) {
    if (message.role === 'user' || message.role === 'toolResult') {
      images.push(...imagesFromContent(message.content))
    }
  }
  return images
}

function latestTurnMessages(context: Context): Context['messages'] {
  const last = context.messages.at(-1)
  if (last === undefined) return []
  if (last.role === 'user') return [last]
  if (last.role !== 'toolResult') return []
  const trailing: Context['messages'] = []
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i]
    if (message?.role !== 'toolResult') break
    trailing.unshift(message)
  }
  return trailing
}

function imagesFromContent(content: string | readonly { type: string; data?: string; mimeType?: string }[]): CursorSelectedImage[] {
  if (typeof content === 'string') return []
  const images: CursorSelectedImage[] = []
  for (const block of content) {
    if (block.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string') continue
    if (block.data.length === 0) continue
    const uuid = crypto.randomUUID()
    images.push({
      uuid,
      path: `${uuid}${extensionFor(block.mimeType)}`,
      mimeType: block.mimeType,
      data: Uint8Array.from(Buffer.from(block.data, 'base64')),
    })
  }
  return images
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return '.jpg'
  if (mimeType === 'image/gif') return '.gif'
  if (mimeType === 'image/webp') return '.webp'
  return '.png'
}

function userContentText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return block.text ?? ''
    return ''
  }).join('')
}
