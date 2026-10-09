/**
 * Assistant-message builders shared by the hand-written pi-ai stream adapters
 * (Cursor and Antigravity) that construct `AssistantMessageEventStream`
 * events themselves instead of delegating to a pi-ai provider.
 *
 * @module dsh-llm-pi-ai/assistant-stream
 */

import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Usage } from '@earendil-works/pi-ai'

/** Usage reported before the endpoint discloses any token counts. */
export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Start an assistant turn with no content, zero usage, and a `stop` reason.
 * @param model - model whose `api`, `provider`, and `id` label the message.
 * @returns a fresh mutable message.
 */
export function emptyAssistant(model: Model<Api>): AssistantMessage {
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

/**
 * Copy a partial turn as aborted by the caller.
 * @param partial - the turn accumulated so far.
 * @returns a copy with its own content array, `aborted` stop reason, and abort message.
 */
export function abortedAssistant(partial: AssistantMessage): AssistantMessage {
  return { ...partial, content: [...partial.content], stopReason: 'aborted', errorMessage: 'Request was aborted' }
}

/**
 * Emit a terminal `error` event and end the stream with the same message.
 * @param stream - the adapter's event stream.
 * @param message - final assistant message carried by the error and the end.
 * @param reason - `aborted` for caller cancellation, otherwise `error`.
 */
export function failAssistantStream(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  reason: 'error' | 'aborted' = 'error',
): void {
  stream.push({ type: 'error', reason, error: message })
  stream.end(message)
}
