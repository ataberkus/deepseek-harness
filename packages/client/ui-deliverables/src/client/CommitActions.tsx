/** The changed-files card's commit row: two buttons that ask the Session's agent to commit, and a failed request's notice. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesCommitPhase } from './changes-commit.ts'
import type { NS } from './locales.ts'
import css from './ChangedFiles.module.css'

/** Prompt status and the sender for one Session, supplied by the card's owner. */
export interface CommitActionsProps {
  /** The Session's latest prompt request, or undefined when none is running or failed. */
  phase: ChangesCommitPhase | undefined
  /**
   * Queue a commit prompt in the Session's chat.
   * @param text - the localized prompt.
   */
  request: (text: string) => void
}

/**
 * Render the commit row. Each button queues its prompt in the Session's chat,
 * where the agent reviews the changes, writes the message, and commits.
 * @param props - prompt status, the sender, and localized copy.
 * @returns the row.
 */
export function CommitActions({ phase, request, t }: CommitActionsProps & PropsLocale<typeof NS>) {
  const sending = phase === 'sending'
  return <div className={css.commit} data-changes-commit>
    <div className={css.commitButtons}>
      <Button size="sm" variant="outline" disabled={sending} data-commit-scope="related"
        onClick={() => { request(t('commit.promptRelated')) }}>{t('commit.related')}</Button>
      <Button size="sm" variant="outline" disabled={sending} data-commit-scope="all"
        onClick={() => { request(t('commit.promptAll')) }}>{t('commit.all')}</Button>
    </div>
    {phase === 'error' && <span className={css.commitError} role="alert">{t('commit.error')}</span>}
  </div>
}
