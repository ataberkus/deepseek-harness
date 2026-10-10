/** Composer control that replaces the draft with a Host-rewritten prompt, with an Undo toast. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SubmitAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  Button, IconCloseOutlineRegular, IconSparkleRegular, IconWarningOutlineRegular, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import type { EnhanceImage, EnhanceProgress } from './request.ts'
import css from './EnhancePrompt.module.css'

/** A mounted composer the keyboard command can address. */
export interface EnhanceShortcutTarget {
  /** @returns whether `element` lies inside this composer. */
  contains: (element: Element) => boolean
  /** @returns whether the draft can be enhanced (or a running enhancement cancelled) now. */
  available: () => boolean
  /** Start enhancing, or cancel the running enhancement. */
  toggle: () => void
}

/** Entry-injected Host call and keyboard wiring. */
export interface EnhancePromptInjected {
  /**
   * Rewrite one draft through the Host.
   * @returns the rewritten prompt; rejects with a displayable message.
   */
  enhance: (
    sessionId: string,
    text: string,
    images: readonly EnhanceImage[],
    signal: AbortSignal,
    onProgress: (progress: EnhanceProgress) => void,
  ) => Promise<string>
  /**
   * Make this composer addressable by the keyboard command.
   * @returns disposer withdrawing the target.
   */
  bindShortcut: (target: EnhanceShortcutTarget) => () => void
  hooks: { enhanceShortcut: ObservableSnapshot<readonly string[]> }
}

/** Session input faces plus localized copy and the injected Host call. */
export type EnhancePromptProps = Pick<PropsRuntime<'conversation.input.right'>, 'sessionId' | 'useInput' | 'inputActions' | 'useSession'>
  & PropsLocale<typeof NS> & InjectFace<EnhancePromptInjected>

type Notice = { seq: number; text: string; undo?: string }

/** Drafts that are commands or shell lines are not prose to rewrite. */
const enhanceable = (draft: string): boolean => {
  const trimmed = draft.trim()
  return trimmed !== '' && !trimmed.startsWith('/') && !trimmed.startsWith('!')
}

/** Live progress of the running call: the model in use and the latest lookup. */
type Progress = { model?: string; step?: string }

/** Encoded draft images; a draft whose attachments cannot be encoded is enhanced from its text alone. */
async function draftImages(serialize: () => Promise<readonly SubmitAttachment[]>): Promise<EnhanceImage[]> {
  try {
    return (await serialize()).flatMap(attachment => attachment.type === 'image' ? [{
      mediaType: attachment.mediaType, data: attachment.data, ...attachment.name === undefined ? {} : { name: attachment.name },
    }] : [])
  } catch {
    // Swallows the encoding failure: images are optional context, and send reports the same failure later.
    return []
  }
}

/** Render the ✨ button; while a call runs it turns into a cancel button. */
export function EnhancePrompt({ sessionId, useInput, inputActions, useSession, enhance, bindShortcut,
  useEnhanceShortcut, t }: EnhancePromptProps) {
  const draft = useInput(state => state.draft)
  const busy = useInput(state => state.phase === 'adjudicating' || state.phase === 'submitting')
  const removed = useSession(session => session.removed)
  const shortcutKeys = useEnhanceShortcut(keys => keys)
  const [running, setRunning] = useState<AbortController | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [progress, setProgress] = useState<Progress>({})
  const seq = useRef(0)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const disabled = removed || busy || (running === null && !enhanceable(draft))

  const stepText = (tool: string, target: string): string | undefined => {
    switch (tool) {
      case 'read': return t('step.read', { target })
      case 'grep': return t('step.grep', { target })
      case 'glob': return t('step.glob', { target })
      // A lookup kind this build does not name keeps the previous step text.
      default: return undefined
    }
  }
  const status = progress.model === undefined
    ? t('enhancing')
    : progress.step === undefined
      ? t('progress', { model: progress.model })
      : t('progressStep', { model: progress.model, step: progress.step })

  const show = (text: string, undo?: string): void => {
    seq.current += 1
    setNotice({ seq: seq.current, text, ...(undo === undefined ? {} : { undo }) })
  }

  const toggle = (): void => {
    if (running !== null) {
      running.abort()
      setRunning(null)
      return
    }
    if (disabled) return
    const controller = new AbortController()
    const original = latestDraft.current
    setRunning(controller)
    setProgress({})
    setNotice(null)
    const onProgress = (update: EnhanceProgress): void => {
      if (controller.signal.aborted) return
      if (update.type === 'start') setProgress({ model: update.model })
      else {
        const step = stepText(update.tool, update.target)
        if (step !== undefined) setProgress(current => ({ ...current, step }))
      }
    }
    void draftImages(() => inputActions.serializeAttachments()).then((images) => {
      if (controller.signal.aborted) throw controller.signal.reason
      return enhance(sessionId, original, images, controller.signal, onProgress)
    }).then((text) => {
      if (controller.signal.aborted) return
      const previous = latestDraft.current
      inputActions.setDraft(text)
      inputActions.persistDraft()
      show(t('done'), previous)
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      show(t('failed', { message: error instanceof Error ? error.message : String(error) }))
    }).finally(() => {
      setRunning(current => current === controller ? null : current)
    })
  }

  // A Session switch or unmount abandons the call: its answer belongs to the draft it was asked about.
  useEffect(() => () => { running?.abort() }, [running, sessionId])
  useEffect(() => { setRunning(null); setNotice(null) }, [sessionId])

  const latest = useRef({ toggle, available: () => running !== null || !disabled })
  latest.current = { toggle, available: () => running !== null || !disabled }
  useEffect(() => bindShortcut({
    contains: element => anchorRef.current?.closest('[data-composer-card]')?.contains(element) ?? false,
    available: () => latest.current.available(),
    toggle: () => { latest.current.toggle() },
  }), [bindShortcut])

  const label = t(running === null ? 'enhance' : 'cancel')
  const undo = notice?.undo
  return <>
    <Tooltip label={label} shortcutKeys={shortcutKeys} side="top" delayMs={500} disabled={disabled}>
      <span ref={anchorRef} className={css.anchor}>
        <Button className={css.trigger} size="sm" aria-label={label} aria-busy={running !== null} disabled={disabled}
          data-prompt-enhance={running === null ? 'idle' : 'running'}
          onMouseDown={(event) => { event.preventDefault() }} onClick={toggle}>
          {running === null ? <IconSparkleRegular size={16} /> : <IconCloseOutlineRegular size={14} />}
        </Button>
      </span>
    </Tooltip>
    {running !== null && <span className={css.status} role="status" title={status}>{status}</span>}
    {notice !== null && <Toast
      key={notice.seq}
      text={notice.text}
      {...undo === undefined
        ? { icon: <IconWarningOutlineRegular />, holdMs: 6000 }
        : {
          tone: 'success' as const,
          holdMs: 6000,
          actions: [{ label: t('undo'), prefix: ' · ', onClick: () => {
            inputActions.setDraft(undo)
            inputActions.persistDraft()
            setNotice(null)
          } }],
        }}
      anchor={anchorRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
      onDone={() => { setNotice(current => current?.seq === notice.seq ? null : current) }}
    />}
  </>
}
