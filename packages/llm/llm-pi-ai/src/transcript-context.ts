/**
 * Adapter from pi-ai's provider-facing `TranscriptContext` (prompt and tools carried
 * by system messages) back to the `Context` fields the hosted Cursor and Antigravity
 * request builders read.
 *
 * @module dsh-llm-pi-ai/transcript-context
 */

import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { Context, TranscriptContext } from '@earendil-works/pi-ai'

/**
 * Replay every system message into `systemPrompt` and `tools`, and drop system
 * messages from the history.
 * @param context - transcript pi-ai passes to a registered provider.
 * @returns the same request with the replayed prompt and tools in `Context` fields.
 */
export function contextFromTranscript(context: TranscriptContext): Context {
  const systemPrompt = getCurrentSystemPrompt(context.messages)
  const tools = getCurrentTools(context.messages)
  return {
    messages: context.messages.filter(message => message.role !== 'system'),
    ...systemPrompt.length === 0 ? {} : { systemPrompt },
    ...tools.length === 0 ? {} : { tools },
  }
}
