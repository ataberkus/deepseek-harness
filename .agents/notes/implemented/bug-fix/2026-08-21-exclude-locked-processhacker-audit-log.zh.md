# Agent Note: 排除被锁定的 Process Hacker 审计日志

Status: implemented

[English](2026-08-21-exclude-locked-processhacker-audit-log.md) | 中文

## Problem

Web 组合包的工作区检查点恢复把 `processhacker_audit.log` 当作工作区中的额外文件。Process Hacker 在 Windows 上保持该文件打开，因此恢复操作的 `rm` 收到 `EBUSY`；回滚再次尝试删除同一文件，工作区被标记为需要恢复，下一条消息在模型工作开始前被拒绝。

## Decision

`packages/bundle/web-app/cordis.patch.yml` 与 `.git` 和 `node_modules` 一起排除 `**/processhacker_audit.log`。`packages/bundle/web-app/tests/web-app.spec.ts` 固定了这项部署配置。

## Alternatives considered

**在恢复逻辑中忽略 `EBUSY`。** 否决：静默保留任意被锁定的工作区路径会削弱事务恢复，并隐藏未完成的变更。

**在恢复前停止 Process Hacker 或删除其日志。** 否决：检查点提供方不拥有外部进程或其审计数据。

**要求每位用户自行添加排除项。** 否决：Web 组合包拥有这个已知的 Harness 生成文件，可以一致地保护所有 Windows Web 启动。

## Consequences

检查点捕获和恢复会保留 Process Hacker 审计日志，而普通工作区文件仍受严格的恢复和回滚处理。部署回归测试防止 Web 组合包删除此排除项。

`packages/session/workspace-checkpoint-local/tests/restore.spec.ts` 还钉住从旧检查点清单恢复时不会修改新排除的文件。
