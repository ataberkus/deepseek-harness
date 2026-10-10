/** Pure request framing and output cleanup for one prompt-enhancement call. */

import type { Message } from '@deepseek-ai/dsh-llm'

/** Fixed enhancer instructions sent as the auxiliary call's system prompt. */
export const ENHANCE_SYSTEM_PROMPT = [
  'You are a prompt enhancer for a coding agent. Rewrite the user\'s draft into a clear, specific prompt that agent can act on.',
  '- Keep the user\'s intent, scope and language. Do not add requirements they did not ask for.',
  '- Use the conversation, when given, to resolve references such as "it" or "that file". Name only files, symbols and commands that appear in the conversation or the draft; never invent paths.',
  '- Include acceptance criteria or a verification step only when the draft implies one.',
  '- Output ONLY the rewritten prompt as plain Markdown. No preamble, no explanation, no code fence around the whole prompt.',
].join('\n')

/** One conversation turn shown to the enhancer. */
export interface ConversationLine {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/**
 * Select the text of the latest user and assistant messages.
 * @param messages - derived Session history, oldest first.
 * @param count - maximum number of lines kept.
 * @param maxChars - per-line character cap; longer text is cut and marked with an ellipsis.
 * @returns at most `count` non-empty lines, oldest first.
 */
export function conversationTail(messages: readonly Message[], count: number, maxChars: number): ConversationLine[] {
  const lines: ConversationLine[] = []
  for (const message of [...messages].reverse()) {
    if (lines.length >= count) break
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
      .trim()
    if (text === '') continue
    lines.push({ role: message.role, text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text })
  }
  return lines.reverse()
}

/**
 * Frame the draft and its context as the single user message of the call.
 * @param draft - the composer draft to rewrite.
 * @param tail - recent conversation lines, oldest first.
 * @param cwd - Session working directory, when known.
 * @returns the user-message text.
 */
export function enhanceInput(draft: string, tail: readonly ConversationLine[], cwd: string | undefined): string {
  const parts: string[] = []
  if (cwd !== undefined) parts.push(`<workspace>${cwd}</workspace>`)
  if (tail.length > 0) {
    parts.push(`<conversation>\n${tail.map(line => `${line.role === 'user' ? 'User' : 'Assistant'}: ${line.text}`).join('\n')}\n</conversation>`)
  }
  parts.push(`<draft>\n${draft}\n</draft>`)
  return parts.join('\n')
}

/**
 * Strip surrounding whitespace and one fence wrapping the whole answer.
 * @param text - raw model text.
 * @returns the rewritten prompt, or an empty string when the answer holds none.
 */
export function cleanEnhanced(text: string): string {
  const trimmed = text.trim()
  if (/^```[\w-]*$/u.test(trimmed)) return ''
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}
