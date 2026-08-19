# Conversation edit checkpoints

English | [中文](2026-08-19-conversation-edit-checkpoints-design.zh.md)

Status: draft for review

## Scope

This specification adds Cursor-like edit-and-rerun behavior to the Web conversation. A user can select an earlier direct message, edit its text, and send the change from the workspace state that existed before that message. The edited run becomes an active child branch, while the original conversation and its workspace checkpoints remain recoverable.

The feature versions conversation history and files inside the session workspace. It does not version arbitrary host files, undo network or database effects, stop or reverse deployed resources, or provide general workflow and job checkpointing.

## Current constraints

A `Session` is an append-only event log. The existing session store can fork a live session from an inclusive event boundary, and a fork boundary must end at a completed turn rather than inside an open turn. The existing session checkpoint policy durably flushes log events before model and tool boundaries; it does not capture workspace files or expose user-visible restore points.

The Web client keeps business state in the browser runtime and composes presentation through slots and stores. Host owns session mutation and filesystem authority. The concrete agent loop must remain unchanged; edit behavior belongs in a checkpoint capability, a session edit consumer, and client plugins.

## Goals

- Capture an initial workspace checkpoint and one checkpoint after every settled turn.
- Associate each direct user message with the checkpoint immediately before its turn.
- Restore that checkpoint automatically when the user sends an edited message.
- Continue from the edited message in a new child session without showing the discarded descendants in the active branch.
- Preserve the original session, its later messages, and its checkpoints for recovery and comparison.
- Make cancellation before Send side-effect-free and make restore and branch creation recoverable after failure.
- Support text edits while preserving existing attachment blocks; unsupported content blocks disable editing in the first version.
- Keep checkpoint storage bounded, durable across restart, and independent of Git history.

## Checkpoint model

A checkpoint is a durable control-plane record containing an opaque `CheckpointId`, session id, workspace identity, the inclusive session sequence boundary it represents, optional parent checkpoint id, branch metadata, capture status, creation time, manifest hash, and content-addressed file references.

`Checkpoint 0` represents the workspace before the first turn. Each later checkpoint represents the workspace after one settled turn and its durable session flush. The user-facing label is derived from branch order; the runtime uses the opaque id and sequence boundary. A checkpoint becomes selectable only after its manifest and metadata are durable.

The manifest is rooted at the session cwd and records relative paths, file kind, mode where supported, size, and content hash. Regular file contents are stored in a local content-addressed object store under the Harness home, while metadata is stored in a dedicated storage domain. The provider does not follow symlinks. Safe link entries may be recorded; a checkpoint with unsupported or unsafe entries is not eligible for automatic restore. Configured exclusions and storage limits are explicit provider settings.

Checkpoint metadata is not a session event because it is not model-visible conversation data. The child session still receives the authoritative inherited event prefix through the existing session fork and seed mechanisms. Parent-session lineage remains in the session header; checkpoint records add the workspace and edit relationship without changing the message projection.

## Turn capture

A checkpoint consumer listens to settled-turn and durability extension points. It captures the initial state when a session obtains a workspace and captures the next state after each `turn/end` once the preceding session events are durably flushed. Captures include completed, failed, cancelled, and interrupted turns when a stable workspace state can be obtained; the checkpoint status records the turn outcome.

Workspace capture is fail-soft for ordinary model work. A capture failure does not erase a completed response or block a later user message, but the affected message has no edit action until a usable checkpoint exists. The Host and browser runtime expose the failure as a checkpoint diagnostic rather than silently claiming that the state is restorable. A concurrent write during capture causes a retry or an unavailable status instead of a manifest that may not describe one filesystem state.

The capture consumer does not consider a background process an undoable part of the turn. A file changed after the turn has settled is included only in a later consistent checkpoint or an explicit recovery snapshot. The workspace lease prevents an edit restore from racing an active agent-owned operation.

## Edit transaction

Editing is a two-phase user interaction:

1. The client enters draft mode and copies the selected direct user message into the existing composer state. No checkpoint, file, or session mutation occurs.
2. Send submits the session id, message identity, edited text, preserved attachment blocks, and the selected checkpoint reference to a Host command.

The Host command validates that the message is a direct user message in a settled turn, that the source agent is idle, that the checkpoint belongs to the same session lineage and workspace, and that the edited payload is valid. The command resolves the fork boundary as the completed `turn/end` immediately before the selected message. Editing the first message creates an empty-seed child with explicit parent-session metadata because no source event boundary precedes it.

Before changing the workspace, the command captures an emergency checkpoint of the current files. It then acquires a per-workspace lease, stages the target manifest, verifies every object and containment rule, and applies the restore through a rollback journal. Once the filesystem commit begins, cancellation waits for the transaction to finish or roll back. A successful restore is followed by creation of the child session from the existing fork/seed API, creation of its agent with the source composition, and admission of the edited user message.

The child header records normal parent-session and seed-length lineage. The checkpoint sidecar records the source session, source boundary, selected checkpoint, edited message, and emergency checkpoint. The child becomes the active session only after restore and child publication succeed. If staging, validation, restore, or child publication fails, the journal restores the original filesystem and the source session remains active. If the child is published and its later model call fails, the child remains as a failed branch and the original remains untouched.

The same transaction is used when the user switches to an older branch. The active workspace always corresponds to the selected branch's latest usable checkpoint. A branch whose required blobs were evicted or whose workspace no longer satisfies the manifest is shown as unavailable rather than resumed against unrelated files.

## GUI behavior

A settled direct user message with editable text and optional preserved attachments renders an `Edit & resend` action. In-flight messages, injected context, steering messages, goal rounds, synthetic notices, and messages with unsupported content blocks do not render the action.

The edit banner states that the run starts from a named checkpoint and identifies the number of files scheduled for restore. It provides Cancel and Send controls. Cancel exits draft mode without reading or writing checkpoint storage and without changing the workspace. Send exposes live operation states for preparing, capturing the emergency state, restoring files, creating the branch, and ready or failed.

After a successful Send, the child transcript starts at the inherited prefix, contains the edited user message, and does not contain the original message or any later source descendants. The sidebar and session lineage view keep the original branch available. Each branch displays its checkpoint labels and the current workspace association. A failed operation keeps the source selected and presents an actionable diagnostic without fabricating a successful child.

`ui-conversation` owns the edit affordance, draft state, and banner. The browser runtime owns plain checkpoint and operation snapshots. Host owns authorization, workspace leases, restoration, branch creation, and durable metadata. The first version does not add a separate Trajectory checkpoint editor; later views may consume the same runtime projection.

## Storage and safety

The local provider stores checkpoint metadata and content objects with Harness-home permissions and uses content hashes to deduplicate identical file contents. Retention and total-byte limits are explicit configuration. Eviction cannot remove a checkpoint referenced by an active branch without marking the branch unavailable and retaining the diagnostic relationship. An emergency checkpoint is retained according to the same policy, with a user-visible recovery relationship.

All restore paths enforce canonical workspace containment, reject path traversal, validate object hashes, and avoid following symlinks outside the workspace. Staging and rollback cover file creation, replacement, deletion, rename reconstruction, and metadata application. A rollback failure marks the workspace as requiring recovery and blocks new model work until the user or a recovery command resolves it.

Checkpoint restore does not claim exactly-once external effects. A prior tool may have changed a remote service, database, terminal process, or ignored external directory. The UI names the guarantee as workspace-file restoration and does not imply that the whole world was rewound.

## Composition and interfaces

The capability family has a Service Definition for checkpoint metadata, capture, inspection, restore, and retention; a local provider for Harness-home storage and filesystem snapshots; and consumers for turn capture, edit commands, and client projections. The provider is replaceable without changing session fork semantics or the model-facing tool registry.

The edit command is a Host-owned user operation, not a model-facing tool. It checks the authenticated session owner and active workspace before acquiring authority. The browser receives operation progress through the existing Host connection and renders it from immutable runtime snapshots. No checkpoint internals enter the system prompt or derived model history.

The first implementation should add the checkpoint family, its local provider, the turn/edit consumer, the Host remote contract, and the Web runtime and conversation UI pieces. It should reuse existing session persistence, session forking, agent creation, workspace identity, connection, slot, and store mechanisms rather than adding parallel session or UI state systems.

## Verification

- Unit-test manifest capture and restore for modified, created, deleted, renamed, binary, untracked, excluded, symlink, and path-containment cases.
- Unit-test staging, emergency snapshots, rollback, missing objects, quota exhaustion, concurrent writes, workspace leases, and cancellation before and during commit.
- Test initial and per-turn checkpoint capture, unavailable checkpoint diagnostics, restart and resume, branch lineage, and exact fork boundaries through a real Loader composition.
- Verify that editing the first message restores `Checkpoint 0`, editing a later message restores the preceding checkpoint, and the child model history excludes the replaced message and descendants while the parent remains unchanged.
- Add Host and Client tests for edit, cancel, progress, failure, branch selection, attachment preservation, and recovery-required states.
- Add a keyless assembled Web replay covering message edit, workspace file change, automatic restore, child branch creation, and the new response transcript.
- Add runtime invariants for checkpoint references, manifest identity, branch relationships, terminal operation states, and absence of child publication after a failed transaction.
- Run the focused package tests, `pnpm run test:gui`, the affected build, `DSH_SNAPSHOT=replay pnpm run test:web`, and the required documentation and diff checks.

## Non-goals

This feature does not create Git commits or refs, delete the original session, rewrite the append-only event log, restore arbitrary files outside the session cwd, undo external side effects, checkpoint running background jobs, resume a partially executed workflow, or expose checkpoint selection as a model-facing tool.

## Alternatives considered

- **Conversation-only fork:** rejected because the edited run would inherit file changes from discarded later turns and would not reproduce the selected point in the task.
- **Git-backed checkpoints:** rejected for the first version because workspaces need not be Git repositories, ignored files would be incomplete, and hidden commits or refs would affect user Git state.
- **Destructive log truncation:** rejected because the session log is append-only and because preserving the original branch gives the user recovery and comparison without weakening durability.
- **Restore only after a confirmation dialog:** rejected as the default because Send is the user's explicit commit decision; an automatic emergency checkpoint and visible restore scope provide recovery without a second blocking prompt.
- **Add edit logic to `agent-loop`:** rejected because the loop already exposes session fork, agent creation, lifecycle, and event extension points; embedding workspace and UI policy there would make the concrete driver non-replaceable.

## Risks and mitigations

Snapshot capture can consume storage and delay the availability of edit actions. Content-addressed objects, explicit retention, asynchronous capture with an unavailable status, and a visible checkpoint-ready state bound the cost without blocking completed model work.

A restore can replace uncommitted user work that was created after the selected checkpoint. The automatic emergency checkpoint, visible file count, branch preservation, and recoverable operation diagnostics provide a way back while retaining the requested automatic behavior.

A workspace can be shared by more than one process or external editor. The local lease and post-capture manifest verification prevent known in-process races; cross-process coordination remains outside the first version and must surface as a restore conflict rather than silently overwriting concurrent work.

A child branch can contain a valid conversation but an unavailable workspace checkpoint after retention or filesystem changes. Branch navigation therefore distinguishes conversation availability from workspace resumability and refuses to run a branch whose required file state cannot be restored.
