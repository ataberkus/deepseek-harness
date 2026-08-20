/** The workspace checkpoint card's staged form over the feature namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, booleanField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Namespace of the user-owned workspace checkpoint setting. */
export const WORKSPACE_CHECKPOINT_NS = 'workspace-checkpoint'

/** The field exposed by the workspace checkpoint card. */
export interface WorkspaceCheckpointSettings {
  enabled?: boolean
}

/** What the workspace checkpoint card renders. */
export interface WorkspaceCheckpointCardState extends CardShell {
  enabled: CardFieldState
}

/** Registration-side face injected into the workspace checkpoint card. */
export interface WorkspaceCheckpointCardFace extends CardActions {
  hooks: {
    workspaceCheckpointCard: SnapshotStore<WorkspaceCheckpointCardState>
  }
}

/** Bridges the feature namespace onto the existing staged card form. */
export class WorkspaceCheckpointCardController {
  private readonly form: CardForm<WorkspaceCheckpointSettings>
  private readonly store: SnapshotStore<WorkspaceCheckpointCardState>

  /** @param scope - the bound settings scope for the workspace checkpoint namespace. */
  constructor(scope: SettingsScope<WorkspaceCheckpointSettings>) {
    this.form = new CardForm(scope, [booleanField('enabled')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): WorkspaceCheckpointCardState {
    return { ...this.form.shell(), enabled: this.form.field('enabled') }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card snapshot and staged form actions.
   */
  inject(): WorkspaceCheckpointCardFace {
    return { hooks: { workspaceCheckpointCard: this.store }, ...this.form.actions() }
  }
}
