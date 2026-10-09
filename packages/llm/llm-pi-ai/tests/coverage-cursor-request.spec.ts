/** Cursor request encoding branches: blob history, turns, request context, and run request defaults. */
import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Context, ToolResultMessage } from '@earendil-works/pi-ai'
import { CURSOR_API, CURSOR_PROVIDER } from '../src/cursor/constants.ts'
import {
  decodeFields,
  fieldRepeated,
  fieldString,
} from '../src/cursor/protobuf.ts'
import {
  buildConversationTurns,
  buildRootPromptMessagesJson,
  encodeAgentRunRequest,
  encodeAllowlistPrecheckResponse,
  encodeConversationState,
  encodeRequestContextResponse,
  findLastUserMessageIndex,
} from '../src/cursor/request.ts'

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER,
    model: 'composer-1.5',
    usage: USAGE,
    stopReason: 'stop',
    timestamp: 0,
  }
}

function toolResult(content: ToolResultMessage['content'], isError: boolean): ToolResultMessage {
  return { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content, isError, timestamp: 0 }
}

function jsonBlobs(store: Map<string, Uint8Array>): unknown[] {
  return [...store.values()]
    .map(bytes => new TextDecoder().decode(bytes))
    .filter(text => text.startsWith('{'))
    .map(text => JSON.parse(text) as unknown)
}

describe('cursor root prompt history', () => {
  it('uses the default system prompt for a blank prompt and keeps only non-empty history', () => {
    const store = new Map<string, Uint8Array>()
    const context: Context = {
      systemPrompt: '   ',
      messages: [
        { role: 'user', content: '', timestamp: 0 },
        { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'QQ==', mimeType: 'image/png' }], timestamp: 0 },
        assistant([{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }]),
        assistant([
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'pondering' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
        ]),
        toolResult([], false),
        toolResult([{ type: 'text', text: 'boom' }], true),
      ],
    }
    const ids = buildRootPromptMessagesJson(context, -1, store)
    expect(ids).toHaveLength(5)
    expect(jsonBlobs(store)).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'text', text: 'pondering' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        id: 'call-1',
        content: [{ type: 'tool-result', toolName: 'bash', toolCallId: 'call-1', result: '(no output)' }],
      },
      {
        role: 'tool',
        id: 'call-1',
        content: [{ type: 'tool-result', toolName: 'bash', toolCallId: 'call-1', result: 'boom', isError: true }],
      },
    ])
  })

  it('stops history before the active user message and falls back without a system prompt', () => {
    const store = new Map<string, Uint8Array>()
    const ids = buildRootPromptMessagesJson({
      messages: [
        { role: 'user', content: 'old', timestamp: 0 },
        { role: 'user', content: 'active', timestamp: 0 },
      ],
    }, 1, store)
    expect(ids).toHaveLength(2)
    expect(JSON.stringify(jsonBlobs(store))).not.toContain('active')
  })
})

describe('cursor conversation turns', () => {
  it('groups steps per user message and prefixes tool results by outcome', () => {
    const store = new Map<string, Uint8Array>()
    const context: Context = {
      messages: [
        assistant([{ type: 'text', text: 'orphan before any user' }]),
        { role: 'user', content: 'first', timestamp: 0 },
        assistant([
          { type: 'text', text: '' },
          { type: 'text', text: 'said' },
          { type: 'thinking', thinking: '' },
          { type: 'thinking', thinking: 'thought' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { a: 1 } },
        ]),
        toolResult([{ type: 'text', text: 'fine' }], false),
        toolResult([{ type: 'text', text: 'bad' }], true),
        { role: 'user', content: 'second', timestamp: 0 },
      ],
    }
    const turns = buildConversationTurns(context, -1, store)
    expect(turns).toHaveLength(2)
    const texts = [...store.values()].map(bytes => Buffer.from(bytes).toString('latin1'))
    expect(texts.some(text => text.includes('[Tool Result]\nfine'))).toBe(true)
    expect(texts.some(text => text.includes('[Tool Error]\nbad'))).toBe(true)
    expect(texts.some(text => text.includes('orphan'))).toBe(false)
    expect(buildConversationTurns(context, 5, new Map())).toHaveLength(1)
  })
})

describe('cursor conversation state', () => {
  it('concatenates prompt ids and turn ids with and without a cached checkpoint', () => {
    const prompt = [new Uint8Array(32).fill(1)]
    const turns = [new Uint8Array(32).fill(2)]
    const bare = decodeFields(encodeConversationState(prompt, turns))
    expect(fieldRepeated(bare, 1)).toEqual(prompt)
    expect(fieldRepeated(bare, 8)).toEqual(turns)
    const withCheckpoint = encodeConversationState(prompt, turns, Uint8Array.of(0x52, 0x01, 0x07))
    expect(Array.from(withCheckpoint.slice(-3))).toEqual([0x52, 0x01, 0x07])
    expect(withCheckpoint.byteLength).toBe(encodeConversationState(prompt, turns).byteLength + 3)
  })
})

describe('cursor run request defaults', () => {
  it('finds no active user message when the trailing message is not from the user', () => {
    expect(findLastUserMessageIndex({ messages: [assistant([])] })).toBe(-1)
    expect(findLastUserMessageIndex({ messages: [] })).toBe(-1)
  })

  it('stores a plain system prompt blob when no context is given', () => {
    const store = new Map<string, Uint8Array>()
    const withPrompt = encodeAgentRunRequest({ conversationId: 'c', modelId: 'm', systemPrompt: 'be brief', blobStore: store })
    expect(jsonBlobs(store)).toEqual([{ role: 'system', content: 'be brief' }])
    expect(fieldString(decodeFields(withPrompt), 8)).toBe('be brief')
    const empty = new Map<string, Uint8Array>()
    encodeAgentRunRequest({ conversationId: 'c', modelId: 'm', systemPrompt: '', blobStore: empty })
    encodeAgentRunRequest({ conversationId: 'c', modelId: 'm', blobStore: empty })
    expect(empty.size).toBe(0)
  })

  it('takes the active user text from context only when its trailing message is a user message', () => {
    const userText = (bytes: Uint8Array): string => {
      const action = fieldRepeated(decodeFields(bytes), 2)[0] ?? new Uint8Array()
      const message = fieldRepeated(decodeFields(action), 1)[0] ?? new Uint8Array()
      return fieldString(decodeFields(message), 1)
    }
    const trailingUser = encodeAgentRunRequest({
      conversationId: 'c',
      modelId: 'm',
      context: { messages: [assistant([]), { role: 'user', content: 'from context', timestamp: 0 }] },
    })
    expect(userText(trailingUser)).toBe('from context')
    const trailingAssistant = encodeAgentRunRequest({
      conversationId: 'c',
      modelId: 'm',
      context: { messages: [assistant([{ type: 'text', text: 'x' }])] },
    })
    expect(userText(trailingAssistant)).toBe('')
    expect(userText(encodeAgentRunRequest({ conversationId: 'c', modelId: 'm' }))).toBe('')
  })
})

describe('cursor exec responses without optional parts', () => {
  it('omits rules, tool definitions, and exec id when they are empty', () => {
    const full = encodeRequestContextResponse(7, 'exec-1', ' rules ', [{ name: 't', description: 'd', parameters: {} }])
    const bare = encodeRequestContextResponse(7, '', undefined, undefined)
    const blank = encodeRequestContextResponse(7, '', '  ', [])
    expect(bare).toEqual(blank)
    expect(bare.byteLength).toBeLessThan(full.byteLength)
    const execMessage = (bytes: Uint8Array): Uint8Array => fieldRepeated(decodeFields(bytes), 2)[0] ?? new Uint8Array()
    expect(fieldString(decodeFields(execMessage(full)), 15)).toBe('exec-1')
    expect(fieldString(decodeFields(execMessage(bare)), 15)).toBe('')
  })

  it('omits the exec id from an allowlist precheck response when empty', () => {
    const withId = encodeAllowlistPrecheckResponse(1, 'exec-1', 42)
    const withoutId = encodeAllowlistPrecheckResponse(1, '', 42)
    const execMessage = (bytes: Uint8Array): Uint8Array => fieldRepeated(decodeFields(bytes), 2)[0] ?? new Uint8Array()
    expect(fieldString(decodeFields(execMessage(withId)), 15)).toBe('exec-1')
    expect(fieldString(decodeFields(execMessage(withoutId)), 15)).toBe('')
    expect(withoutId.byteLength).toBeLessThan(withId.byteLength)
  })
})
