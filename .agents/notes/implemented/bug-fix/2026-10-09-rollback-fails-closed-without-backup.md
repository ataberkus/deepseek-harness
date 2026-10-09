# Agent Note: Workspace rollback fails closed without a readable backup

Status: implemented

English | [中文](2026-10-09-rollback-fails-closed-without-backup.zh.md)

## Problem

`rollbackJournal` in `workspace-checkpoint-local` removed every non-excluded entry under the cwd, then built a manifest of the backup directory with `.catch(() => undefined)` and returned when the manifest was missing. A missing or unreadable backup left the cwd emptied, restored nothing, and returned normally. `restoreCheckpoint` calls `markRecoveryRequired` only when rollback throws, so the Host saw a completed rollback and kept running model work against an empty workspace.

## Decision

`rollbackJournal` reads the backup manifest first and lets a read failure propagate. No workspace entry is removed before the backup has been read and walked, so a failure leaves the cwd as the failed restore left it. The existing failed-rollback path then marks the workspace `recoveryRequired` and rethrows. The successful path performs the same removals and copies in the same order.

A rollback that completes now also removes the journal file, as the `removeJournal` contract already stated. A rollback that throws keeps the journal. The staging and backup directories of a rolled-back attempt remain until the next restore of the same checkpoint removes them.

## Alternatives considered

**Keep the swallow and mark recovery required when the manifest is undefined.** This leaves the deletion before the check, so the workspace is still emptied before the failure is reported.

**Copy the backup into a temporary directory first, then swap.** It removes the window between deletion and copy entirely, but needs a second full copy of the workspace and does not change the unreadable-backup case, which fails at the read either way.

## Consequences

An unreadable backup reports `CHECKPOINT_CONTAINMENT` or the underlying file-system error and blocks model work until a checkpoint is restored. The window between the first deletion and the last copied entry still exists: a copy error there leaves a partial workspace, and that error also marks recovery required.

`restore` emits `workspace-checkpoint/changed` twice for the restored session: once when clearing the recovery flag rewrites the session rows of the workspace, and once when the applied checkpoint is recorded. The first covers every session that shares the workspace, the second only the restored session, and observers re-read the domain, so the extra event is redundant for the restored session but harmless and is left unchanged.
