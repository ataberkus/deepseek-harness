import { describe, expect, it } from 'vitest'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { cleanEnhanced, conversationTail, enhanceInput } from '../src/enhance.ts'

const user = (text: string): Message => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'dsh-prompt-enhance' },
})

describe('conversationTail', () => {
  it('keeps the latest user text, oldest first, and caps each line', () => {
    const tail = conversationTail([user('first'), user('two'), user('x'.repeat(10)), user('  ')], 2, 5)
    expect(tail).toEqual([
      { role: 'user', text: 'two' },
      { role: 'user', text: 'xxxx…' },
    ])
  })

  it('returns nothing for a zero count', () => {
    expect(conversationTail([user('a')], 0, 10)).toEqual([])
  })
})

describe('enhanceInput', () => {
  it('frames workspace, conversation, and draft', () => {
    expect(enhanceInput('fix it', [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], '/repo')).toBe(
      '<workspace>/repo</workspace>\n<conversation>\nUser: a\nAssistant: b\n</conversation>\n<draft>\nfix it\n</draft>',
    )
  })

  it('omits empty context', () => {
    expect(enhanceInput('x', [], undefined)).toBe('<draft>\nx\n</draft>')
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
