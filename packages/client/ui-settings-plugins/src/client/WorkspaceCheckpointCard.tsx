/** Workspace checkpoint opt-in card in the Plugins settings tab. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BooleanField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WorkspaceCheckpointCardFace } from './workspace-checkpoint-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the workspace checkpoint card. */
export type WorkspaceCheckpointCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WorkspaceCheckpointCardFace>

/**
 * Render the workspace checkpoint opt-in card.
 * @param props - locale copy, card snapshot, and staged form actions.
 * @returns the card.
 */
export function WorkspaceCheckpointCard(props: WorkspaceCheckpointCardProps) {
  const { t } = props
  const state = props.useWorkspaceCheckpointCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="workspaceCheckpointTitle"
      descriptionKey="workspaceCheckpointDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <BooleanField
        id="plugin-config-workspace-checkpoint-enabled"
        label={t('workspaceCheckpointEnabled')}
        hint={t('workspaceCheckpointEnabledHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidBoolean')}
        disabled={!state.writable}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
    </PluginCard>
  )
}
