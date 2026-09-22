# Agent Note: Bundled third-party skills

Status: implemented

[English](2026-09-14-bundled-third-party-skills.md) | 中文

## Problem

`dsh-skill-badge` 是唯一的内置 skill 提供方，因此想要流行第三方 skill 集 `i-have-adhd`（ADHD 友好输出风格）与 `ponytail`（懒人资深开发者最小 diff 编码）的部署只能把上游 `SKILL.md` 文件手工复制到本地 skill 根目录：没有版本记录、不能通过组合开关、没有统一出处。手工复制还会与同名用户 skill 静默冲突，而不是走提供方 rank 解析。

## Decision

`packages/skill/` 下新增两个不可变内置提供方，复制上游正文：`@deepseek-ai/dsh-skill-i-have-adhd` 贡献唯一的 `i-have-adhd` skill，调用策略仅用户可用，与上游 `disable-model-invocation: true` 前置元数据一致；`@deepseek-ai/dsh-skill-ponytail` 贡献全部六个上游 skill（`ponytail`、`ponytail-review`、`ponytail-audit`、`ponytail-debt`、`ponytail-gain`、`ponytail-help`），模型与用户均可调用。两者都以上游提供方名称、按 `BUNDLED_SKILL_RANK` 注册，把 `assets/` 作为目录资源基底公开，每次加载时从 `assets/<name>.md` 读取正文；ponytail 提供方以各正文文件 URL 作为候选项定位器，因此加载跟随胜出的候选项，无需分支。

### Vendoring

每个 `assets/<name>.md` 都是去掉前置元数据的上游 `SKILL.md` 正文；前置元数据中的描述与调用策略以常量的形式存放在 `src/index.ts`，因此目录与上游一致，运行时无需解析前置元数据。固定的上游提交记录在源码头部与包 README 中：`i-have-adhd` 位于 `4092de07ce3ed88389d77c0d623b7af89b40ac0e`，`ponytail` 位于 v4.10.0（`e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`）。两个上游项目均为 MIT 许可。重新复制指拷入新正文、更新描述常量与固定 SHA，并运行提供方测试。

### Composition

两个插件在 `dsh-base` 组合中与 `skill-badge` 并列，以 `disabled: true` 行发布，把可选功能挡在默认发布之外：部署显式启用之前，没有目录条目、没有快照、请求没有任何变化。启用 `skill-i-have-adhd` 只通过用户显式手势暴露 `/i-have-adhd`（模型目录从不展示它）；启用 `skill-ponytail` 则在会话目录中列出全部六个 skill。

## Alternatives considered

### Hand-copied filesystem skills

Rejected. 拷入项目或用户 skill 根目录的复制没有上游版本、绕过组合开关，并失去同名 skill 的提供方 rank 解析。内置提供方把出处、版本固定与启用开关收在一处。

### One combined package for both upstreams

Rejected. 两个上游独立发版，各自需要独立的署名与重新复制；每个上游一个包与源仓库一一对应，部署也可以只启用其中一套。

### Enabled by default in `dsh-base`

Rejected. Ponytail 的六个目录条目与 ADHD 输出风格会改变每个默认会话的目录与模型可见指引，违反 `skill-badge` 行确立的可选功能不进默认规则。需求方选择了可选式内置。

### Runtime frontmatter parsing or submodule

Rejected. 加载时解析前置元数据给本不可变提供方增加了一个失败模式，子模块则增加网络与检出复杂度。复制的正文让提供方离线、无分支，并被注册表级测试完全覆盖。

## Consequences

启用任一行，agent 即获得带版本的第三方 skill，不新增服务、配置或工具；默认发布的行为完全一致，因此无需更新录制会话快照。代价是上游修复落地时维护者需要重新复制，已作为已知限制记入两个包的 README。

## Testing

提供方测试断言精确的目录条目（名称、描述、调用策略、提供方、来源、资源基底）、七个 skill 的正文标记，以及释放后为空。`scripts/verify-package-readme-model-experience.ts` 的 `SENTENCE_MODEL_EXPERIENCE` 把两个包记为 `indirect`，本变更运行工作区约束、类型检查、翻译配对与 `verify-cordis-config` 门禁。
