/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only. Inline references follow the consumer's wrapping policy and keep long
 * labels within its width. Four decoration sources, by precedence: the wire session form
 * `@[label](dsh-session:...)` folds to its label; exact session labels
 * supplied by an adjacent recall decorate their bare `@label` mention; plain
 * `@name` word-boundary tokens decorate by shape alone; and a plain `/name`
 * token decorates only when the caller names it — a skill the host actually
 * loaded for that message (ui-chat reads the step's `skill-invocation`
 * injections) or the command a command-input bubble echoes — so `/123` or a
 * stray `/word` stays plain text. A `/name` token is whitespace-bounded like
 * the host skill gesture (`dsh-tool-skill`): it ends at whitespace or the
 * text end, so slash paths (`/nfs-hg/xxx`, `/plan.md`) and punctuation-glued
 * tokens (`/plan。`) stay plain even for a loaded name. `UserMarkdownText`
 * renders the same projection inside sent Markdown: reference tokens outside
 * code stay literal text, and every prose text run decorates as above.
 */
import { Fragment, memo, useMemo } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type * as Md from 'mdast'
import { MarkdownText } from './markdown/MarkdownText.tsx'
import type { MarkdownLabels, MarkdownTextDecorations } from './markdown/MarkdownText.tsx'
import { parseGfmWithMath } from './markdown/parse.ts'
import { ReferenceIconRegular } from './ReferenceIcon.tsx'
import css from './user-text.module.css'
import markdownCss from './markdown/MarkdownText.module.css'

/** The wire form a session chip serializes to; label is the display text. */
const SESSION_WIRE_RE = /@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu

/** Sentence punctuation a bare `@name` token may carry without being part of the reference. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u

interface DecorationRange {
  readonly start: number
  readonly end: number
  /** Matched source text (hover title). */
  readonly label: string
  readonly kind: 'session' | 'plain'
  /** Pre-resolved display text (wire folds); derived from label when absent. */
  readonly display?: string
}

/** Optional navigation supplied by consumers that can preview references. */
export interface UserTextReferences {
  /** Open a file path decoded from an `@` mention. */
  openFile: (path: string) => void
  /** Open the source of a skill loaded for this message. */
  openSkill: (name: string) => void
}

/** The non-overlapping decoration ranges of one text, in source order. */
function decorationRanges(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[],
): DecorationRange[] {
  const ranges: DecorationRange[] = []
  SESSION_WIRE_RE.lastIndex = 0
  let wire: RegExpExecArray | null
  while ((wire = SESSION_WIRE_RE.exec(text)) !== null) {
    ranges.push({
      start: wire.index,
      end: wire.index + wire[0].length,
      label: wire[0],
      kind: 'session',
      display: wire[1] as string, // non-optional capture in SESSION_WIRE_RE
    })
  }
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  // A `/` token ends at whitespace or the text end like the host skill
  // gesture; only `@` tokens shed sentence punctuation below.
  const re = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1] as string).length // (^|\s) captures '' at line start
    const rawLabel = m[2] as string // non-optional alternation capture
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(TRAILING_PUNCTUATION_RE, '')
    if (label.length <= 1) continue
    if (label.startsWith('/') && !slashNames.includes(label.slice(1))) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  const rankOf = (range: DecorationRange): number => range.kind === 'session' ? 0 : 1
  ranges.sort((a, b) => a.start - b.start || rankOf(a) - rankOf(b) || b.end - a.end)
  const selected: DecorationRange[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    selected.push(range)
    cursor = range.end
  }
  return selected
}

/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @param slashNames - names a `/name` token may decorate as: the skills the
 * host loaded for this message, or the command a command bubble echoes
 * (unsent queue rows pass none).
 * @param slashKind - the chip kind those tokens render as.
 * @param references - optional file and skill preview actions; session and command tokens stay labels.
 * @returns inline nodes covering the whole text.
 */
export function projectUserText(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
  references?: UserTextReferences,
): ReactNode {
  const parts: ReactNode[] = []
  let cursor = 0
  const pushPlain = (from: number, to: number): void => {
    parts.push(<span key={`t${from}`} className={css.plainRun}>{text.slice(from, to)}</span>)
  }
  for (const range of decorationRanges(text, sessionLabels, slashNames)) {
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) pushPlain(cursor, tokenStart)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.replace(/^@"|"$/gu, '').endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = range.display
      ?? (referenceKind === undefined
        ? label
        : referenceKind === 'session'
          ? label.slice(1)
          : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1))
    const contents = <>
      {referenceKind !== undefined && (
        <ReferenceIconRegular kind={referenceKind} size={16} className={css.refIcon} />
      )}
      {displayLabel}
    </>
    const open = references === undefined ? undefined
      : referenceKind === 'file'
        ? () => { references.openFile(label.slice(1).replace(/^"|"$/gu, '')) }
        : referenceKind === undefined && slashKind === 'skill'
          ? () => { references.openSkill(label.slice(1)) }
          : undefined
    const className = clsx(css.refChip, referenceKind === undefined && css.slashChip)
    parts.push(open === undefined
      ? <span key={tokenStart} className={className} data-ref-chip={referenceKind ?? slashKind} title={label}>
        {contents}
      </span>
      : <button
        key={tokenStart}
        type="button"
        className={clsx(className, markdownCss.fileMention)}
        data-ref-chip={referenceKind ?? slashKind}
        title={label}
        onClick={(event) => {
          if (event.detail > 1 || (event.detail !== 0 && event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false)) return
          open()
        }}
      >
        {contents}
      </button>)
    cursor = end
  }
  if (parts.length === 0) return <span className={css.plainRun}>{text}</span>
  if (cursor < text.length) pushPlain(cursor, text.length)
  return <>{parts}</>
}

/** Every ASCII punctuation character, each of which a Markdown backslash escape keeps literal. */
const MARKDOWN_PUNCTUATION_RE = /[!-/:-@[-`{-~]/gu

/** Emphasis and math delimiters that would split a path such as `@src/__init__.py`. */
const TOKEN_DELIMITER_RE = /[$*_~]/gu

/** A delimiter run that closes surrounding emphasis (`**see @a.ts**`) rather than belonging to the token. */
const TRAILING_DELIMITERS_RE = /[*_~]+$/u

/** Nodes whose source renders verbatim, where an escape would show its backslash. */
const LITERAL_NODE_TYPES: ReadonlySet<string> = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html'])

const NO_NAMES: readonly string[] = []

/** Source offsets of every verbatim (code, math, raw HTML) node in a Markdown text. */
function literalSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  const visit = (nodes: readonly Md.RootContent[]): void => {
    for (const node of nodes) {
      if (LITERAL_NODE_TYPES.has(node.type)) {
        /* v8 ignore next -- fromMarkdown stamps a position on every parsed node. */
        if (node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
          spans.push([node.position.start.offset, node.position.end.offset])
        }
      } else if ('children' in node) visit(node.children)
    }
  }
  visit(parseGfmWithMath(text).children)
  return spans
}

/**
 * Escape emphasis and math delimiters inside reference tokens outside
 * verbatim Markdown so they cannot split a token (`@src/__init__.py`); a
 * trailing delimiter run and any link syntax stay Markdown. Wire session
 * forms fold to their fully escaped `@label`, which joins the session labels
 * to decorate.
 */
function userMarkdownSource(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[],
): { source: string; sessionLabels: readonly string[] } {
  const ranges = decorationRanges(text, sessionLabels, slashNames)
  if (ranges.length === 0) return { source: text, sessionLabels }
  const literal = literalSpans(text)
  const labels = [...sessionLabels]
  let source = ''
  let cursor = 0
  for (const range of ranges) {
    if (literal.some(([start, end]) => range.start >= start && range.start < end)) continue
    source += text.slice(cursor, range.start)
    if (range.display === undefined) {
      const token = range.label.replace(TRAILING_DELIMITERS_RE, '')
      source += token.replace(TOKEN_DELIMITER_RE, '\\$&')
      cursor = range.start + token.length
    } else {
      labels.push(range.display)
      source += `@${range.display.replace(MARKDOWN_PUNCTUATION_RE, '\\$&')}`
      cursor = range.end
    }
  }
  return { source: source + text.slice(cursor), sessionLabels: labels }
}

/**
 * Render sent user text as Markdown in the consumer's own size, line height,
 * and ink, with reference chips in prose and soft line breaks kept as breaks.
 * @param props - `text` is the logged model text; `labels` is reference-stable
 * localized Markdown chrome; `sessionLabels`, `slashNames`, and `references`
 * follow {@link projectUserText}.
 * @returns the rendered message body.
 */
export const UserMarkdownText = memo(function UserMarkdownText({
  text, labels, sessionLabels = NO_NAMES, slashNames = NO_NAMES, references,
}: {
  text: string
  labels: MarkdownLabels
  sessionLabels?: readonly string[] | undefined
  slashNames?: readonly string[] | undefined
  references?: UserTextReferences | undefined
}) {
  const { source, decorations } = useMemo(() => {
    const projected = userMarkdownSource(text, sessionLabels, slashNames)
    const textDecorations: MarkdownTextDecorations = {
      decorate: value => value.split(/\r\n?|\n/u).map((line, index) => (
        <Fragment key={index}>
          {index > 0 && <br />}
          {projectUserText(line, projected.sessionLabels, slashNames, 'skill', references)}
        </Fragment>
      )),
    }
    return { source: projected.source, decorations: textDecorations }
  }, [text, sessionLabels, slashNames, references])
  return (
    <div className={css.markdown}>
      <MarkdownText text={source} labels={labels} variant="compact" textDecorations={decorations} />
    </div>
  )
})
