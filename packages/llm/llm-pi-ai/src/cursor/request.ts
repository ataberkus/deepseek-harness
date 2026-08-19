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
  encodeString,
} from './protobuf.ts'

/** Identifier Cursor stores on MCP tools this adapter advertises. */
export const CURSOR_MCP_PROVIDER = 'dsh'

/** Inputs {@link encodeAgentRunRequest} needs besides the Connect envelope. */
export interface AgentRunEncodeInput {
  /** Session conversation id; reused across turns when a checkpoint exists. */
  conversationId: string
  /** Opaque ConversationStateStructure bytes from the last checkpoint, when any. */
  checkpoint?: Uint8Array
  /** Flattened user text for this turn's UserMessageAction. */
  userText: string
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
  const modelDetails = concat(
    encodeString(1, input.modelId),
    encodeThinkingDetails(input.thinking === true, input.thinkingEffort),
    encodeString(4, input.modelName ?? input.modelId),
    encodeBool(7, input.maxMode === true),
  )
  const requestedModel = concat(
    encodeString(1, input.modelId),
    encodeBool(2, input.maxMode === true),
  )
  return concat(
    input.checkpoint === undefined ? new Uint8Array() : encodeBytes(1, input.checkpoint),
    encodeMessage(2, encodeMessage(1, encodeUserMessage(input.userText))),
    encodeMessage(3, modelDetails),
    encodeMcpTools(input.tools ?? []),
    encodeString(5, input.conversationId),
    input.systemPrompt === undefined ? new Uint8Array() : encodeString(8, input.systemPrompt),
    encodeMessage(9, requestedModel),
  )
}

/**
 * Flatten pi-ai context messages into one user-message string. Images become
 * a placeholder: this unofficial backend does not accept multimodal MCP args.
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

function encodeUserMessage(text: string): Uint8Array {
  return concat(encodeString(1, text), encodeString(2, crypto.randomUUID()))
}

function userContentText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'image') return '[image]'
    return ''
  }).join('')
}
