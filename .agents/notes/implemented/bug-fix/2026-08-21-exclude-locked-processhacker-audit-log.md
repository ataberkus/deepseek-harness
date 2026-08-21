# Agent Note: Exclude the locked Process Hacker audit log

Status: implemented

English | [中文](2026-08-21-exclude-locked-processhacker-audit-log.zh.md)

## Problem

The web bundle's workspace checkpoint restore treated `processhacker_audit.log` as an extra workspace file. Process Hacker keeps it open on Windows, so restore's `rm` received `EBUSY`; rollback retried the same deletion, marked the workspace as requiring recovery, and the next message was rejected before model work.

## Decision

`packages/bundle/web-app/cordis.patch.yml` excludes `**/processhacker_audit.log` alongside `.git` and `node_modules`. `packages/bundle/web-app/tests/web-app.spec.ts` pins this deployment configuration.

## Alternatives considered

**Ignore `EBUSY` in restore.** Rejected: silently leaving an arbitrary locked workspace path would weaken transactional restore and hide incomplete mutations.

**Stop Process Hacker or delete its log before restore.** Rejected: the checkpoint provider does not own external processes or their audit data.

**Require each user to add the exclusion.** Rejected: the web bundle owns this known harness-generated artifact and can protect every Windows web launch consistently.

## Consequences

Checkpoint capture and restore leave the Process Hacker audit log in place, while ordinary workspace files remain subject to strict restore and rollback handling. The deployment regression test prevents the web bundle from removing this exclusion.

`packages/session/workspace-checkpoint-local/tests/restore.spec.ts` also pins restoring older checkpoint manifests without mutating newly excluded files.
