import { Fragment, memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  CheckpointSnapshot, CheckpointView, PendingSubmission,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, fileExtension, FileTypeIcon, fileSizeText, JsonBlock, projectUserText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ModelRetryNode, TurnErrorNode, UserMessageNode } from '../contract/snapshot.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>
type UserFile = Extract<UserMessageNode['content'][number], { type: 'file' }>
type PresentedAttachment =
  | { readonly type: 'image'; readonly image: MessageImageSource }
  | { readonly type: 'file'; readonly file: UserFile['attachment'] }

function contentParts(content: readonly unknown[]): {
  text: string
  attachments: PresentedAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const attachments: PresentedAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: (b as UserImage).attachment } })
    }
    else if (b.type === 'file' && b.attachment !== undefined) {
      attachments.push({ type: 'file', file: (b as UserFile).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function failureMessage(
  message: string,
  code: unknown,
  t: ChatViewSlotProps['t'],
): string {
  return code === 'AUTH' ? t('message.failure.auth') : message
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {t('duration.milliseconds', { milliseconds: Math.round(node.delayMs) })}
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {failureMessage(node.failure.message, node.failure.code, t)}
        </div>
      </div>
    </details>
  )
}

/** Seq of the direct user message opening one failed turn, when it is in the window. */
function failedTurnUserSeq(snapshot: ChatSnapshot, turn: number): number | undefined {
  for (const key of snapshot.locations.getTurn(turn)) {
    const node = snapshot.nodes.get(key) as ChatNode | undefined
    if (node?.kind === 'user') return node.data.seq
  }
  return undefined
}

/** Persistent, turn-positioned feedback for a terminal failure with same-branch retry. */
function TurnErrorItem({ node, t, useSession, useChat, useInput, retryTurn }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
  useSession: ChatNodeViewProps<'turn-error'>['useSession']
  useChat: ChatNodeViewProps<'turn-error'>['useChat']
  useInput: ChatNodeViewProps<'turn-error'>['useInput']
  retryTurn: ChatNodeOwnerProps['retryTurn']
}) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  let checkpoints: CheckpointSnapshot | undefined
  try {
    checkpoints = useSession(s => s.checkpoints)
  } catch {
    checkpoints = undefined
  }
  let running = false
  try {
    running = useSession(s => s.running) ?? false
  } catch {
    running = false
  }
  let alreadyEditing = false
  try {
    alreadyEditing = useInput(s => s.edit) !== undefined
  } catch {
    alreadyEditing = false
  }
  let userSeq: number | undefined
  try {
    userSeq = useChat(snapshot => failedTurnUserSeq(snapshot, node.turn))
  } catch {
    userSeq = undefined
  }
  let isLatest = false
  try {
    isLatest = useChat(snapshot => snapshot.timeline.turnOrder.at(-1) === node.turn) ?? false
  } catch {
    isLatest = false
  }
  const eligible = userSeq === undefined || alreadyEditing
    ? undefined
    : selectEditCheckpoint(checkpoints, userSeq)
  const operationBusy = checkpoints?.operation !== undefined
    && checkpoints.operation.phase !== 'ready'
    && checkpoints.operation.phase !== 'failed'
  const blocked = checkpoints?.recoveryRequired !== undefined || !isLatest || running || operationBusy
  const canRetry = retryTurn !== undefined
    && userSeq !== undefined
    && eligible !== undefined
    && !blocked
  const showActions = canRetry || retrying || retryError !== null
  const busy = retrying || running || operationBusy
  return (
    <div className={css.turnErrorWrap}>
      <div className={css.turnErrorRow} role="status">
        <StateDot state="error" className={css.turnErrorDot} />
        <div className={css.turnErrorCopy}>
          <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
          <span className={css.turnErrorMessage}>{failureMessage(node.message, node.code, t)}</span>
        </div>
        {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
      </div>
      {showActions && (
        <div className={css.turnErrorActions}>
          {(canRetry || retrying) && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canRetry}
              onClick={() => {
                if (retryTurn === undefined || userSeq === undefined || eligible === undefined || busy || !canRetry) return
                setRetrying(true)
                setRetryError(null)
                void retryTurn(userSeq, eligible.id).then(
                  (result) => {
                    setRetrying(false)
                    if (!result.ok) setRetryError(`${result.error.message} (${result.error.code})`)
                  },
                  (error: unknown) => {
                    setRetrying(false)
                    setRetryError(error instanceof Error ? error.message : String(error))
                  },
                )
              }}
            >
              {busy ? t('message.turnRetry.running') : t('message.turnRetry')}
            </Button>
          )}
          {retryError !== null && <span className={css.turnErrorRetryError} role="alert">{retryError}</span>}
        </div>
      )}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content, renderMessageImages, actions, pending = false, echo = false, referenceLabels = [], skillNames = [],
  previewAttachments, references, t,
}: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
  echo?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  /** Skill names the step's `skill-invocation` injections loaded for this message. */
  skillNames?: readonly string[]
  /** Local submission-echo attachments replacing the content-derived attachment sequence. */
  previewAttachments?: readonly PresentedAttachment[]
  references?: Pick<ChatNodeOwnerProps, 'openFile' | 'openSkill'>
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, attachments: contentAttachments, rest } = contentParts(content)
  const attachments = previewAttachments ?? contentAttachments
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div
      className={css.userRow}
      data-pending-steering={pending || undefined}
      data-submission-echo={echo || undefined}
    >
      <div className={css.userStack}>
        {attachments.length > 0 && (
          <div className={css.attachmentRow} data-message-attachments>
            {attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {renderMessageImages({
                    images: [attachment.image],
                    align: 'end',
                    compact: compactImages,
                  })}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                  <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                  <span className={css.fileContent}>
                    <span className={css.fileName}>{attachment.file.name}</span>
                    <span className={css.fileMeta}>
                      {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                        .filter(Boolean).join(' ')}
                    </span>
                  </span>
                </span>
              ))}
          </div>
        )}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels, skillNames, 'skill', references)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(text)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * Render one local transcript or steering submission echo with the same
 * visual language and surface marker as the Host occurrence that replaces
 * it: draft text plus object-URL previews, visible from the submit click
 * until the durable `user/message` or steering occurrence renders.
 * @param props - the session snapshot's pending submission and render seats.
 * @returns the echoed user bubble.
 */
export function PendingSubmissionBubble({ submission, renderMessageImages, t }: {
  submission: PendingSubmission
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  t: ChatViewSlotProps['t']
}): ReactNode {
  const content = useMemo(
    () => (submission.text === '' ? [] : [{ type: 'text', text: submission.text }]),
    [submission.text],
  )
  const previewAttachments = useMemo<readonly PresentedAttachment[]>(
    () => submission.attachments.map(attachment => attachment.type === 'image'
      ? {
        type: 'image',
        image: {
          preview: {
            url: attachment.value.previewUrl,
            ...(attachment.value.name === undefined ? {} : { name: attachment.value.name }),
            ...(attachment.value.width === undefined ? {} : { width: attachment.value.width }),
            ...(attachment.value.height === undefined ? {} : { height: attachment.value.height }),
          },
        },
      }
      : { type: 'file', file: attachment.value }),
    [submission.attachments],
  )
  return (
    <UserStyleBubble
      content={content}
      previewAttachments={previewAttachments}
      renderMessageImages={renderMessageImages}
      pending={submission.placement === 'steering'}
      echo
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={submission.time}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/**
 * Latest usable checkpoint before one durable message, matching the Host edit boundary.
 * @param checkpoints - session checkpoint snapshot, if the control frame arrived.
 * @param messageSeq - durable sequence of the message being edited.
 * @returns the newest ready, eligible, non-emergency checkpoint below the message.
 */
export function selectEditCheckpoint(
  checkpoints: CheckpointSnapshot | undefined,
  messageSeq: number,
): CheckpointView | undefined {
  if (checkpoints?.enabled !== true) return undefined
  return [...checkpoints.checkpoints].reverse().find(checkpoint =>
    checkpoint.role !== 'emergency'
    && checkpoint.status.kind === 'ready'
    && checkpoint.restoreEligible
    && checkpoint.boundarySeq < messageSeq)
}

/** User and admitted-steering keyed Chat renderer. */
export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, renderMessageImages, openFile, openSkill, t, useSession, inputActions, useInput,
}: ChatNodeViewProps<'user' | 'steering'>) {
  const data = node.data
  let checkpoints: CheckpointSnapshot | undefined
  try {
    checkpoints = useSession(s => s.checkpoints)
  } catch {
    checkpoints = undefined
  }
  let alreadyEditing = false
  try {
    alreadyEditing = useInput(s => s.edit) !== undefined
  } catch {
    alreadyEditing = false
  }
  const eligible = alreadyEditing ? undefined : selectEditCheckpoint(checkpoints, data.seq)
  const beginEdit = inputActions?.beginEdit
  return (
    <UserStyleBubble
      content={data.content}
      references={{ openFile, openSkill }}
      renderMessageImages={renderMessageImages}
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      {...data.skillNames === undefined ? {} : { skillNames: data.skillNames }}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          {...eligible === undefined || beginEdit === undefined
            ? {}
            : { onEdit: () => { beginEdit({ messageSeq: data.seq, checkpointId: eligible.id, originalText: text }) } }}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t, useSession, useChat, useInput, retryTurn }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} useSession={useSession} useChat={useChat} useInput={useInput} retryTurn={retryTurn} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
