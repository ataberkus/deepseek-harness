// @vitest-environment jsdom
/** Sent user messages render their Markdown inside the unchanged bubble. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type UserViewProps = ChatNodeViewProps<'user' | 'steering'>

const t: UserViewProps['t'] = makeTranslate(zh, commonZh)

function renderUser(
  content: UserViewProps['node']['data']['content'],
  options: { skillNames?: readonly string[]; renderMessageImages?: UserViewProps['renderMessageImages'] } = {},
) {
  const openFile = vi.fn()
  const openSkill = vi.fn()
  const props: Partial<UserViewProps> = {
    node: {
      key: 'fixture:user:1',
      kind: 'user',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'session' },
      visibility: 'visible',
      data: {
        kind: 'user',
        seq: 1,
        time: 1_000,
        content,
        source: null,
        ...options.skillNames === undefined ? {} : { skillNames: options.skillNames },
      },
    },
    t,
    renderMessageImages: options.renderMessageImages ?? (() => null),
    openFile,
    openSkill,
  }
  const view = render(<UserMessageNodeView {...props as UserViewProps} />)
  const bubble = view.container.querySelector('[data-markdown-variant]')
  if (bubble === null) throw new Error('user message body missing')
  return { view, bubble, openFile, openSkill }
}

const text = (value: string): UserViewProps['node']['data']['content'] => [{ type: 'text', text: value }]

describe('user message Markdown', () => {
  it('renders bold text, inline code, and a nested list', () => {
    const source = 'Add a **desktop app** section:\n\n- **Platform:** run `node companion/server.mjs`\n  - Node.js 22+\n  - Rust via `rustup`\n- Commands'
    const { bubble } = renderUser(text(source))
    expect([...bubble.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['desktop app', 'Platform:'])
    expect([...bubble.querySelectorAll('code')].map(node => node.textContent)).toEqual(['node companion/server.mjs', 'rustup'])
    const outer = bubble.querySelector(':scope > ul')
    expect(outer?.querySelectorAll(':scope > li')).toHaveLength(2)
    const nested = outer?.querySelector(':scope > li > ul')
    expect([...nested?.querySelectorAll(':scope > li') ?? []].map(node => node.textContent)).toEqual(['Node.js 22+', 'Rust via rustup'])
    expect(bubble.textContent).not.toContain('**')
    expect(bubble.textContent).not.toContain('`')
  })

  it('renders headings, links, and fenced code', () => {
    const { bubble } = renderUser(text('## Plan\n\nSee [the docs](https://example.com/docs).\n\n```sh\npnpm vitest run\n```'))
    expect(bubble.querySelector('h2')?.textContent).toBe('Plan')
    expect(bubble.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs')
    expect(bubble.querySelector('pre')?.textContent).toContain('pnpm vitest run')
  })

  it('copies the original Markdown source', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const source = '**bold** and `code`\n\n- item'
    renderUser(text(source))
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith(source)
  })

  it('keeps plain line breaks and paragraphs without adding Markdown elements', () => {
    const { bubble } = renderUser(text('first line\nsecond line\n\nnext paragraph'))
    const paragraphs = [...bubble.querySelectorAll('p')]
    expect(paragraphs.map(node => node.textContent)).toEqual(['first linesecond line', 'next paragraph'])
    expect(paragraphs[0]?.querySelectorAll('br')).toHaveLength(1)
    expect(bubble.querySelectorAll('strong, em, code, ul, ol, h1, h2, h3')).toHaveLength(0)
  })

  it('keeps reference chips in prose and leaves references inside code as code', () => {
    const { bubble, openFile, openSkill } = renderUser(
      text('Read **see @src/a.ts** and @src/__tests__/b.ts with /review and not `@src/c.ts`.\n\n看看 @[会话 *一*](dsh-session:InNlc3Npb24i)'),
      { skillNames: ['review'] },
    )
    const chips = [...bubble.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(chip => [chip.getAttribute('data-ref-chip'), chip.textContent]))
      .toEqual([['file', 'a.ts'], ['file', 'b.ts'], ['skill', '/review'], ['session', '会话 *一*']])
    expect(chips[0]?.closest('strong')?.textContent).toBe('see a.ts')
    expect(bubble.querySelector('code')?.textContent).toBe('@src/c.ts')
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'b.ts' }))
    fireEvent.click(screen.getByRole('button', { name: '/review' }))
    expect(openFile.mock.calls).toEqual([['src/a.ts'], ['src/__tests__/b.ts']])
    expect(openSkill).toHaveBeenCalledWith('review')
  })

  it('keeps attachments beside the Markdown body', () => {
    const renderMessageImages = vi.fn<UserViewProps['renderMessageImages']>(() => <span data-image-fixture />)
    const { view } = renderUser([
      { type: 'text', text: '**see** attached' },
      { type: 'image', attachment: { id: 'att-1', mediaType: 'image/png' } },
      { type: 'file', attachment: { id: 'att-2', name: 'notes.pdf', mediaType: 'application/pdf', bytes: 2_048 } },
    ] as never, { renderMessageImages })
    expect(renderMessageImages).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-image-fixture]')).not.toBeNull()
    expect(view.getByText('notes.pdf')).toBeTruthy()
    expect(view.container.querySelector('strong')?.textContent).toBe('see')
  })
})
