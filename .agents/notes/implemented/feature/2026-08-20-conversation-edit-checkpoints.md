# Agent Note: Conversation edit checkpoints

Status: implemented

English | [中文](2026-08-20-conversation-edit-checkpoints.zh.md)

## Problem

Editing a settled user message needs to rerun the conversation from the files that existed before that turn. Session history is append-only, while filesystem state is mutable and cannot be reconstructed from the conversation log.

## Decision

`WorkspaceCheckpoint` owns content-addressed workspace snapshots, journaled restore, emergency snapshots, recovery markers, leases, and retention. The capture consumer records the initial tree and settled-turn boundaries, and blocks model and top-level tool work while recovery is required.

`session.edit` cancels and awaits an active source turn, then validates the direct user message after cancellation, its preceding ready checkpoint, and the workspace association. It captures an emergency snapshot, restores the selected tree, creates a child from the prefix before the edited turn, records the source/selected/emergency/child relation in durable session sidecars, and queues only the replacement message on the child. `session.activate` restores the latest usable non-emergency checkpoint for an idle session.

The edit operation passes its held workspace lease into the child's initial checkpoint capture. The local provider treats a matching capture lease as reentrant for that operation, so the transaction retains exclusivity without waiting for its own lease to release.

The `session/checkpoints` projection carries checkpoint rows, operation phases, applied and recovery state, the selected branch label, and workspace resumability. The Web client retains this baseline before Session creation, renders `Edit and rerun` for eligible direct user messages even while the source is running, and reports an unrestorable workspace without hiding readable conversation history.

## Alternatives considered

**Mutate the source log in place.** This would destroy the original transcript and make the pre-edit workspace relationship ambiguous, so edit creates a child and keeps the source append-only.

**Fork without restoring files.** A transcript fork alone leaves tools and subsequent turns in the wrong filesystem state, so the selected checkpoint is restored before the child is published.

**Store file bytes in session events.** This would enlarge the log and expose workspace data to every history consumer, so manifests and blobs remain in the provider's storage domain and object store.

**Treat an unavailable checkpoint as an empty workspace.** Silent file loss would make reruns unsafe, so unavailable trees remain readable but disable new work until a usable restore is available.

## Consequences

An edit preserves both conversation branches and provides a durable emergency path back to the pre-edit workspace. Checkpoint metadata is a sidecar rather than model-visible session history, so a client can reconnect to branch and recovery diagnostics without receiving file contents. The local provider requires a storage-domain backend and reports cross-record relation failures through its invariant companion. This reintroduces the settled-message edit affordance removed in [Drop the user-message edit stub](../simplification/2026-07-31-drop-user-message-edit-stub.md), now backed by checkpoint restore and a child branch.

## Testing

Service, provider, lease, restore, retention, Host RPC including running-source cancellation, wire-schema, runtime projection, input-state, and browser component tests cover the checkpoint and edit paths. The assembled Web snapshot suite covers the real Host/client transport, edit affordance, branch label, recovery diagnostic, child execution, and reconnect projection.
