# Agent Note: Restore repository quality gates

Status: implemented

English | [中文](2026-08-21-repository-quality-gates.md)

## Problem

仓库质量 gate 报告了 TypeScript 与 lint 诊断、过期的生成式 graph 与 Cordis catalog 输出、已实现 note 中错误语言的链接、包 README 中硬换行的段落，以及一份缺少必需 alternatives section 的已实现 Agent Note。

## Decision

受影响的源码和测试约定采用当前严格的 TypeScript 与 lint 规则。Graph 和 Cordis catalog 文档从源码程序重新生成。双语链接和一致性记录在所属文档中修正，README 段落边界恢复，缺少内容的 Agent Note 补充其被拒绝的替代方案。

## Alternatives considered

**禁用或收窄 lint 与 typecheck 规则。** 不采用：这些诊断指出了源码与测试中的真实类型约定、Promise、非安全数据和无效条件问题。

**抑制文档 gate。** 不采用：过期的生成文档和错误语言的链接会使仓库引用图和翻译检查不可靠。

**只修复 login-picker 文件。** 不采用：请求覆盖仓库 gate；保留其他诊断会让同一组检查在功能合并后仍然失败。

## Consequences

仓库 lint、typecheck 与文档 gate 共享一致的源码和生成文档状态。后续修改 event declaration、Cordis surface 或双语 note 时，必须运行所属生成器并更新 pairing record，不能只编辑派生输出。
