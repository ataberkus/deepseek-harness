/**
 * Map Antigravity Cloud Code Assist SSE `streamGenerateContent` onto pi-ai streamSimple.
 *
 * @module dsh-llm-pi-ai/google-antigravity/stream
 */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import {
  GOOGLE_ANTIGRAVITY_BASE_URL,
  GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL,
  GOOGLE_ANTIGRAVITY_PROJECT_HEADER,
} from './constants.ts'
import { antigravityHeaders } from './headers.ts'
import { buildAntigravityRequest } from './request.ts'

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** Injectable HTTP so tests never hit Cloud Code Assist. */
export const antigravityStreamInternals = {
  fetch: globalThis.fetch.bind(globalThis),
}

/**
 * Antigravity `stream` / `streamSimple` implementation.
 * @param model - hosted Antigravity model.
 * @param context - harness-converted pi-ai context.
 * @param options - credentials, sampling, and cancellation.
 * @returns an event stream yielding assistant message deltas.
 */
export function streamAntigravity(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void runAntigravityStream(stream, model, context, options)
  return stream
}

async function runAntigravityStream(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const partial = emptyAssistant(model)
  const snapshot = (): AssistantMessage => ({ ...partial, content: [...partial.content] })
  try {
    if (options?.signal?.aborted) {
      fail(stream, aborted(partial))
      return
    }
    const accessToken = accessTokenFromOptions(options)
    const projectId = projectIdFromOptions(options)
    if (accessToken === undefined || projectId === undefined) {
      throw new Error(`Provider is not configured: ${model.provider}`)
    }
    const body = buildAntigravityRequest(model, context, projectId, options)

    let response: Response | undefined
    let lastError: unknown

    for (const baseUrl of [GOOGLE_ANTIGRAVITY_BASE_URL, GOOGLE_ANTIGRAVITY_FALLBACK_BASE_URL]) {
      try {
        const res = await antigravityStreamInternals.fetch(
          `${baseUrl}/v1internal:streamGenerateContent?alt=sse`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...antigravityHeaders(model.id),
            },
            body: JSON.stringify(body),
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          },
        )
        if (res.ok) {
          response = res
          break
        }
        lastError = new Error(`Cloud Code Assist API error (${res.status}): ${await res.text()}`)
      } catch (err) {
        if (options?.signal?.aborted) {
          fail(stream, aborted(partial))
          return
        }
        lastError = err
      }
    }

    if (!response || !response.ok) {
      if (lastError instanceof Error) throw lastError
      throw new Error(`Cloud Code Assist API error: ${String(lastError)}`)
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
    id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: call.name ?? '',
    arguments: call.args ?? {},
  }
}

function applyUsage(
  partial: AssistantMessage,
  usage: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  } | undefined,
): void {
  if (usage === undefined) return
  const input = (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0)
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
  const cacheRead = usage.cachedContentTokenCount ?? 0
  const total = usage.totalTokenCount ?? input + output + cacheRead
  partial.usage = {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

interface CloudCodeAssistChunk {
  error?: { message?: string; status?: string }
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
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string }
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      cachedContentTokenCount?: number
      thoughtsTokenCount?: number
      totalTokenCount?: number
    }
  }
}

function cloudCodeAssistPayload(value: unknown): CloudCodeAssistChunk {
  if (typeof value === 'object' && value !== null) {
    return value
  }
  return {}
}

async function* readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const eventBlock = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of eventBlock.split(/\r?\n/)) {
          if (line.startsWith('data:')) {
            const jsonText = line.slice(5).trim()
            if (jsonText.length > 0) {
              try {
                yield JSON.parse(jsonText)
              } catch {
                // Ignore unparseable non-JSON keepalive/SSE lines
              }
            }
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function accessTokenFromOptions(options: SimpleStreamOptions | undefined): string | undefined {
  if (options?.apiKey !== undefined && options.apiKey.length > 0) {
    return options.apiKey
  }
  const headers = options?.headers
  if (headers !== undefined) {
    const auth = headers.Authorization ?? headers.authorization
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7).trim()
    }
  }
  return undefined
}

function projectIdFromOptions(options: SimpleStreamOptions | undefined): string | undefined {
  const headers = options?.headers
  if (headers !== undefined) {
    const value = headers[GOOGLE_ANTIGRAVITY_PROJECT_HEADER]
      ?? headers[GOOGLE_ANTIGRAVITY_PROJECT_HEADER.toLowerCase()]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
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
  reason: 'error' | 'aborted' = 'error',
): void {
  stream.push({ type: 'error', reason, error: message })
  stream.end(message)
}

function openText(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  snapshot: () => AssistantMessage,
): number {
  const textIndex = partial.content.length
  partial.content.push({ type: 'text', text: '' })
  stream.push({ type: 'text_start', contentIndex: textIndex, partial: snapshot() })
  return textIndex
}

function openThinking(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  snapshot: () => AssistantMessage,
): number {
  const thinkingIndex = partial.content.length
  partial.content.push({ type: 'thinking', thinking: '' })
  stream.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial: snapshot() })
  return thinkingIndex
}

function closeThinking(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  thinkingIndex: number,
  snapshot: () => AssistantMessage,
): void {
  const block = partial.content[thinkingIndex]
  /* v8 ignore next -- thinkingIndex is only closed when a thinking block was open. */
  if (block?.type === 'thinking') {
    stream.push({
      type: 'thinking_end',
      contentIndex: thinkingIndex,
      content: block.thinking,
      partial: snapshot(),
    })
  }
}

function closeText(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  textIndex: number,
  snapshot: () => AssistantMessage,
): void {
  const block = partial.content[textIndex]
  /* v8 ignore next -- textIndex is only closed when a text block was open. */
  if (block?.type === 'text') {
    stream.push({
      type: 'text_end',
      contentIndex: textIndex,
      content: block.text,
      partial: snapshot(),
    })
  }
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

function isThinkingPart(part: { text?: string; thought?: boolean }): boolean {
  return part.thought === true
}

function mapStopReasonString(reason: string): StopReason {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    default:
      return 'error'
  }
}
