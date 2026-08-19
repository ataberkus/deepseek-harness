/**
 * Map Cloud Code Assist SSE `streamGenerateContent` onto pi-ai streamSimple.
 *
 * Tools stay on the harness loop: functionCall parts become pi-ai `toolCall`.
 * Antigravity, leak-healing, and Gemini CLI exec are not implemented.
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/stream
 */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { isThinkingPart, mapStopReasonString } from '@earendil-works/pi-ai/api/google-shared'
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
import { GOOGLE_GEMINI_CLI_BASE_URL, GOOGLE_GEMINI_CLI_PROJECT_HEADER } from './constants.ts'
import { geminiCliHeaders } from './headers.ts'
import { buildCloudCodeAssistRequest } from './request.ts'

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** Injectable HTTP so tests never hit Cloud Code Assist. */
export const geminiStreamInternals = {
  fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    globalThis.fetch(input, init)) as typeof fetch,
}

/**
 * Gemini CLI `stream` / `streamSimple` implementation.
 * @param model - hosted Gemini CLI model.
 * @param context - harness-converted pi-ai context.
 * @param options - auth headers, abort, sampling, reasoning.
 * @returns a pi-ai assistant event stream.
 */
export function streamGeminiCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void runGeminiCliStream(stream, model, context, options)
  return stream
}

async function runGeminiCliStream(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const partial = emptyAssistant(model)
  const snapshot = (): AssistantMessage => ({ ...partial, content: [...partial.content] })
  try {
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial), 'aborted')
      return
    }
    const accessToken = accessTokenFromOptions(options)
    const projectId = projectIdFromOptions(options)
    if (accessToken === undefined || projectId === undefined) {
      throw new Error(`Provider is not configured: ${model.provider}`)
    }
    const body = buildCloudCodeAssistRequest(model, context, projectId, options)
    const response = await geminiStreamInternals.fetch(
      `${GOOGLE_GEMINI_CLI_BASE_URL}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...geminiCliHeaders(model.id),
        },
        body: JSON.stringify(body),
        ...options?.signal === undefined ? {} : { signal: options.signal },
      },
    )
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`)
    }
    if (response.body === null) {
      throw new Error('Cloud Code Assist API returned no response body')
    }
    stream.push({ type: 'start', partial: snapshot() })
    let textIndex: number | undefined
    let thinkingIndex: number | undefined
    const toolCalls: ToolCall[] = []
    let finishReason: string | undefined
    for await (const chunk of readSseJson(response.body, options?.signal)) {
      if (options?.signal?.aborted) {
        fail(stream, aborted(partial), 'aborted')
        return
      }
      const payload = cloudCodeAssistPayload(chunk)
      if (payload.error !== undefined) {
        const detail = payload.error.message ?? payload.error.status ?? 'unknown error'
        throw new Error(`Cloud Code Assist stream error: ${detail}`)
      }
      const responseData = payload.response
      if (responseData === undefined) continue
      if (responseData.promptFeedback?.blockReason !== undefined) {
        const detail = responseData.promptFeedback.blockReasonMessage
        throw new Error(
          `Request blocked by Google (${responseData.promptFeedback.blockReason})${detail === undefined ? '' : `: ${detail}`}`,
        )
      }
      applyUsage(partial, responseData.usageMetadata)
      const candidate = responseData.candidates?.[0]
      if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall !== undefined) {
          closeOpenBlocks(stream, partial, textIndex, thinkingIndex, snapshot)
          textIndex = undefined
          thinkingIndex = undefined
          const parsed = functionCallPart(part.functionCall)
          const contentIndex = partial.content.length
          partial.content.push(parsed)
          toolCalls.push(parsed)
          stream.push({ type: 'toolcall_start', contentIndex, partial: snapshot() })
          stream.push({
            type: 'toolcall_delta',
            contentIndex,
            delta: JSON.stringify(parsed.arguments),
            partial: snapshot(),
          })
          stream.push({ type: 'toolcall_end', contentIndex, toolCall: parsed, partial: snapshot() })
          continue
        }
        if (part.text === undefined || part.text.length === 0) continue
        if (isThinkingPart(part)) {
          if (textIndex !== undefined) {
            closeText(stream, partial, textIndex, snapshot)
            textIndex = undefined
          }
          if (thinkingIndex === undefined) thinkingIndex = openThinking(stream, partial, snapshot)
          const block = partial.content[thinkingIndex]
          /* v8 ignore next -- thinkingIndex is only set after a thinking block is opened. */
          if (block?.type === 'thinking') block.thinking += part.text
          stream.push({
            type: 'thinking_delta',
            contentIndex: thinkingIndex,
            delta: part.text,
            partial: snapshot(),
          })
          continue
        }
        if (thinkingIndex !== undefined) {
          closeThinking(stream, partial, thinkingIndex, snapshot)
          thinkingIndex = undefined
        }
        if (textIndex === undefined) textIndex = openText(stream, partial, snapshot)
        const block = partial.content[textIndex]
        /* v8 ignore next -- textIndex is only set after a text block is opened. */
        if (block?.type === 'text') block.text += part.text
        stream.push({
          type: 'text_delta',
          contentIndex: textIndex,
          delta: part.text,
          partial: snapshot(),
        })
      }
    }
    closeOpenBlocks(stream, partial, textIndex, thinkingIndex, snapshot)
    /* v8 ignore next 4 -- abort after the SSE body ends is the same terminal as abort mid-chunk. */
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial), 'aborted')
      return
    }
    if (toolCalls.length > 0) {
      partial.stopReason = 'toolUse'
      stream.push({ type: 'done', reason: 'toolUse', message: snapshot() })
      stream.end(snapshot())
      return
    }
    if (finishReason === undefined) {
      partial.stopReason = 'stop'
      stream.push({ type: 'done', reason: 'stop', message: snapshot() })
    } else {
      const stopReason = mapStopReasonString(finishReason)
      if (stopReason === 'length') {
        partial.stopReason = 'length'
        stream.push({ type: 'done', reason: 'length', message: snapshot() })
      } else if (stopReason === 'stop') {
        partial.stopReason = 'stop'
        stream.push({ type: 'done', reason: 'stop', message: snapshot() })
      } else {
        fail(stream, {
          ...snapshot(),
          stopReason: 'error',
          errorMessage: `Cloud Code Assist stopped: ${finishReason}`,
        }, 'error')
        return
      }
    }
    stream.end(snapshot())
  } catch (error) {
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial), 'aborted')
      return
    }
    fail(stream, {
      ...partial,
      content: [...partial.content],
      stopReason: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    }, 'error')
  }
}

function functionCallPart(call: { name?: string; args?: Record<string, unknown>; id?: string }): ToolCall {
  return {
    type: 'toolCall',
    id: typeof call.id === 'string' && call.id.length > 0 ? call.id : crypto.randomUUID(),
    name: typeof call.name === 'string' && call.name.length > 0 ? call.name : 'unknown',
    arguments: call.args ?? {},
  }
}

function applyUsage(
  partial: AssistantMessage,
  usage: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  } | undefined,
): void {
  if (usage === undefined) return
  partial.usage = {
    ...ZERO_USAGE,
    input: usage.promptTokenCount ?? 0,
    output: usage.candidatesTokenCount ?? 0,
    cacheRead: usage.cachedContentTokenCount ?? 0,
    totalTokens: usage.totalTokenCount ?? 0,
    cost: ZERO_USAGE.cost,
  }
}

interface CloudCodeAssistChunk {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
          thought?: boolean
          functionCall?: { name?: string; args?: Record<string, unknown>; id?: string }
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      cachedContentTokenCount?: number
      totalTokenCount?: number
    }
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string }
  }
  error?: { code?: number; message?: string; status?: string }
}

function cloudCodeAssistPayload(value: unknown): CloudCodeAssistChunk {
  if (value === null || typeof value !== 'object') return {}
  return value as CloudCodeAssistChunk
}

async function* readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request was aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      /* v8 ignore next -- split always yields at least the remainder string. */
      buffer = events.pop() ?? ''
      for (const event of events) {
        const data = event
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data.length === 0 || data === '[DONE]') continue
        yield JSON.parse(data) as unknown
      }
    }
  } finally {
    reader.releaseLock()
  }
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

function projectIdFromOptions(options: SimpleStreamOptions | undefined): string | undefined {
  const headers = options?.headers
  if (headers === undefined) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== GOOGLE_GEMINI_CLI_PROJECT_HEADER) continue
    if (typeof value !== 'string') continue
    const projectId = value.trim()
    if (projectId.length > 0) return projectId
  }
  return undefined
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

function closeThinking(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  thinkingIndex: number,
  snapshot: () => AssistantMessage,
): void {
  const block = partial.content[thinkingIndex]
  stream.push({
    type: 'thinking_end',
    contentIndex: thinkingIndex,
    /* v8 ignore next -- thinkingIndex is only set after a thinking block is opened. */
    content: block?.type === 'thinking' ? block.thinking : '',
    partial: snapshot(),
  })
}

function closeText(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  textIndex: number,
  snapshot: () => AssistantMessage,
): void {
  const block = partial.content[textIndex]
  stream.push({
    type: 'text_end',
    contentIndex: textIndex,
    /* v8 ignore next -- textIndex is only set after a text block is opened. */
    content: block?.type === 'text' ? block.text : '',
    partial: snapshot(),
  })
}

function closeOpenBlocks(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  textIndex: number | undefined,
  thinkingIndex: number | undefined,
  snapshot: () => AssistantMessage,
): void {
  if (thinkingIndex !== undefined) closeThinking(stream, partial, thinkingIndex, snapshot)
  if (textIndex !== undefined) closeText(stream, partial, textIndex, snapshot)
}
