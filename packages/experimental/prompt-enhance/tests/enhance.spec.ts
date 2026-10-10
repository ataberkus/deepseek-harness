import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { cleanEnhanced, conversationTail, enhanceInput, enhanceSystemPrompt, workspaceInstructions } from '../src/enhance.ts'

const user = (text: string): Message => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (text: string): Message => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'p', model: 'm' } })
// Only the source kind matters to the readers under test.
const injected = (kind: string, text: string): Message => createUserMessage({ content: [{ type: 'text', text }], source: { kind } as never })

describe('conversationTail', () => {
  it('keeps the latest prompts and replies, oldest first, and caps each line', () => {
    const tail = conversationTail([user('first'), assistant('two'), user('x'.repeat(10)), user('  ')], 2, 5)
    expect(tail).toEqual([
      { role: 'assistant', text: 'two' },
      { role: 'user', text: 'xxxx…' },
    ])
  })

  it('skips producer-injected user context and non-conversation roles', () => {
    const tool = { role: 'tool', content: [{ type: 'text', text: 'out' }] } as never
    expect(conversationTail([user('ask'), injected('agent-instructions', 'rules'), tool], 5, 50)).toEqual([{ role: 'user', text: 'ask' }])
    const thinking = createAssistantMessage({ content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } })
    expect(conversationTail([thinking], 5, 50)).toEqual([{ role: 'assistant', text: 'ok' }])
  })

  it('returns nothing for a zero count', () => {
    expect(conversationTail([user('a')], 0, 10)).toEqual([])
  })
})

describe('workspaceInstructions', () => {
  it('joins loaded instruction messages and caps them', () => {
    const history = [injected('agent-instructions', 'A'), user('ask'), injected('agent-instructions', ' '), injected('agent-instructions', 'B')]
    expect(workspaceInstructions(history, 100)).toBe('A\n\nB')
    expect(workspaceInstructions(history, 3)).toBe('A\n…')
    expect(workspaceInstructions(history, 0)).toBe('')
  })
})

describe('enhanceSystemPrompt', () => {
  it('states the lookup budget and image guidance only when they apply', () => {
    const full = enhanceSystemPrompt(6, true)
    expect(full).toContain('at most 6 read, grep or glob calls')
    expect(full).toContain('Images are attached')
    const plain = enhanceSystemPrompt(0, false)
    expect(plain).not.toContain('read, grep or glob')
    expect(plain).toContain('never invent paths')
    expect(plain).not.toContain('Images')
  })
})

describe('enhanceInput', () => {
  it('frames workspace, instructions, conversation, and draft', () => {
    expect(enhanceInput('fix it', { cwd: '/repo', instructions: 'Use pnpm.', tail: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] })).toBe(
      '<workspace>/repo</workspace>\n<instructions>\nUse pnpm.\n</instructions>\n<conversation>\nUser: a\nAssistant: b\n</conversation>\n<draft>\nfix it\n</draft>',
    )
  })

  it('omits empty context', () => {
    expect(enhanceInput('x', { cwd: undefined, instructions: '', tail: [] })).toBe('<draft>\nx\n</draft>')
  })
})

describe('cleanEnhanced', () => {
  it('removes one fence around the whole answer', () => {
    expect(cleanEnhanced('```md\nDo X\n```')).toBe('Do X')
    expect(cleanEnhanced('  Do `x` here \n')).toBe('Do `x` here')
  })

  it('treats a bare fence as no prompt', () => {
    for (const text of ['```', '```md', '  ```  ', '```\n```']) expect(cleanEnhanced(text)).toBe('')
  })
})
