/** Pure request framing and output cleanup for one prompt-enhancement call. */

import type { Message } from '@deepseek-ai/dsh-llm'

/**
 * Enhancer instructions sent as the auxiliary call's system prompt.
 * @param maxLookups - lookup budget the enhancer is told about; 0 omits the lookup instructions.
 * @param withImages - whether the draft carries attached images.
 * @returns the system prompt text.
 */
export function enhanceSystemPrompt(maxLookups: number, withImages: boolean): string {
  return [
    'You are a prompt enhancer for a coding agent working in this workspace. Rewrite the user\'s draft into a clear, specific prompt that agent can act on.',
    '- Keep the user\'s intent, scope and language. Do not add requirements they did not ask for.',
    '- Use the conversation and workspace instructions, when given, to resolve references such as "it" or "that file".',
    maxLookups > 0
      ? `- Look up only what the draft refers to, with at most ${String(maxLookups)} read, grep or glob calls. Name real files, symbols and commands you confirmed or that appear in the conversation or draft; never invent paths.`
      : '- Name only files, symbols and commands that appear in the conversation or the draft; never invent paths.',
    ...withImages
      ? ['- Images are attached: use what they show to make the prompt concrete. They stay attached to the final message, so refer to them rather than re-describing everything.']
      : [],
    '- Include acceptance criteria or a verification step only when the draft implies one.',
    '- Output ONLY the rewritten prompt as plain Markdown. No preamble, no explanation, no code fence around the whole prompt.',
  ].join('\n')
}

/** One conversation turn shown to the enhancer. */
export interface ConversationLine {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

function textOf(message: Message): string {
  return message.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
    .trim()
}

/**
 * Select the text of the latest user prompts and assistant messages.
 * Producer-injected user-role context (instructions, reminders) is skipped.
 * @param messages - derived Session history, oldest first.
 * @param count - maximum number of lines kept.
 * @param maxChars - per-line character cap; longer text is cut and marked with an ellipsis.
 * @returns at most `count` non-empty lines, oldest first.
 */
export function conversationTail(messages: readonly Message[], count: number, maxChars: number): ConversationLine[] {
  const lines: ConversationLine[] = []
  for (const message of [...messages].reverse()) {
    if (lines.length >= count) break
    const role = message.role === 'user' && message.source.kind === 'user' ? 'user'
      : message.role === 'assistant' ? 'assistant' : undefined
    if (role === undefined) continue
    const text = textOf(message)
    if (text === '') continue
    lines.push({ role, text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text })
  }
  return lines.reverse()
}

/**
 * Collect the workspace instructions (AGENTS.md and compatible files) the
 * Session has already loaded into its context.
 * @param messages - derived Session history, oldest first.
 * @param maxChars - total character cap; longer text is cut and marked with an ellipsis.
 * @returns the instruction text, or an empty string when none is loaded or the cap is 0.
 */
export function workspaceInstructions(messages: readonly Message[], maxChars: number): string {
  if (maxChars === 0) return ''
  const text = messages
    .filter(message => message.role === 'user' && message.source.kind === 'agent-instructions')
    .map(textOf)
    .filter(part => part !== '')
    .join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** Context framed around the draft. */
export interface EnhanceContext {
  /** Session working directory, when known. */
  readonly cwd: string | undefined
  /** Loaded workspace instructions; empty when none. */
  readonly instructions: string
  /** Recent conversation lines, oldest first. */
  readonly tail: readonly ConversationLine[]
}

/**
 * Frame the draft and its context as the text of the call's single user message.
 * @param draft - the composer draft to rewrite.
 * @param context - workspace, instructions, and conversation shown with it.
 * @returns the user-message text.
 */
export function enhanceInput(draft: string, context: EnhanceContext): string {
  const parts: string[] = []
  if (context.cwd !== undefined) parts.push(`<workspace>${context.cwd}</workspace>`)
  if (context.instructions !== '') parts.push(`<instructions>\n${context.instructions}\n</instructions>`)
  if (context.tail.length > 0) {
    parts.push(`<conversation>\n${context.tail.map(line => `${line.role === 'user' ? 'User' : 'Assistant'}: ${line.text}`).join('\n')}\n</conversation>`)
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
