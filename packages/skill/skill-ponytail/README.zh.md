---
description: "随包附带的 ponytail skill 提供方，供启用、使用或排查该可选懒人资深开发者 skill 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-ponytail

[English](README.md) | 中文

## 概述

agent（智能体）可以通过该内置提供方加载六个 `ponytail` skill，并遵循其指令，只写任务真正需要的代码：常驻的懒人资深开发者模式，以及一次性的评审、审计、技术债台账、影响记分牌与帮助 skill。该提供方没有配置，随附 CLI（命令行界面）组合以禁用状态包含该插件，因此部署方需要显式启用。skill 正文从上游 `ponytail` 项目（MIT）随包分发；本包不携带生命周期钩子或模式持久化，因此只有加载 skill 时模式才生效。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启用插件即可让 `ponytail` skill 出现在会话 skill 目录中；随后模型可以像加载任何其他 skill 一样加载它们，并遵循其最小 diff 编码指令。

### 何时选择

当编码工作应当停在第一个够用的解法——跳过不需要的工作、复用代码库已有辅助函数、优先标准库与原生平台能力而不是新增依赖、写出能工作的最短 diff——而又不想把 skill 文件存入本地 skill 目录时，选择此提供方。当编码风格无需塑造时，请跳过——插件默认禁用，启用前不增加任何东西。

### 启用插件

该插件没有配置。把它的组合行加入组合即可；随附 CLI 组合以 `disabled: true` 携带该行，因此在那里需要显式启用。

```yaml
- name: '@deepseek-ai/dsh-skill-ponytail'
```

启用后，六个 skill 会出现在会话目录的可用 skill 中，用户显式手势 `/name` 可逐个调用。

### ponytail skill 提供什么

- **`ponytail`。** 常驻的懒人资深开发者模式：七级阶梯（YAGNI、复用、标准库、原生、已安装依赖、一行、最小代码），带 lite/full/ultra 三档强度。
- **`ponytail-review`。** 对当前 diff 的过度工程评审，每个发现一行，以净行数评分收尾。
- **`ponytail-audit`。** 全仓库过度工程审计，按可删行数从大到小排名。
- **`ponytail-debt`。** 把 `ponytail:` 快捷注释收集成可跟踪的技术债台账。
- **`ponytail-gain`。** 已发布的基准记分牌：更少代码、更低成本、更快速度。
- **`ponytail-help`。** 档位、skill 与停用方式的速查卡。

### 可观察的成功与失败

启用插件会使全部六个 skill 出现在目录中并可凭名称加载；禁用或省略该行则它们不会出现在任何目录中。由于提供方不可变，发现始终成功且恰好返回六个 skill，绝不会报告部分结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释内置提供方如何接线；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是一个不可变、同步注册的 skill 来源：它以 `ponytail` 作为提供方名称、按内置 skill rank（600）注册六个固定候选项，把随包分发的 `assets/` 目录作为每个 skill 的目录资源基底公开，并在每次加载时从随包分发的 `assets/<name>.md` 文件读取对应 skill 正文。每个候选项以其正文文件 URL 作为不透明定位器，因此加载跟随胜出的候选项，无需分支。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口与不可变提供方：六个候选项、资源基底、正文加载 |
| — | 不发布运行时不变式伴生入口；本包只持有一个不可变的提供方注册，注册唯一性与生命周期检查由 skill 注册表负责。 |
| [`assets/`](assets/) | 随包分发的 skill 正文（`ponytail.md`、`ponytail-review.md`、`ponytail-audit.md`、`ponytail-debt.md`、`ponytail-gain.md`、`ponytail-help.md`），从上游项目复制而来 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时，请阅读以下页面。这些页面先介绍该提供方注册到的注册表，再说明 skill 如何到达模型。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——该提供方实现的注册表与提供方约定。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表，以及已加载 skill 的共享渲染。
- [tool-skill 包](../tool-skill/README.zh.md)——ponytail skill 如何到达会话目录与模型。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；该包会把该提供方的目录条目和所选 skill 的正文渲染给模型。

#### KV Cache 影响

该插件默认禁用，不会改变任何请求。启用后，其目录条目和任何已加载正文都会在各自插入点改变提供方的 KV 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明内置提供方不做什么。它们是当前包约束，不是任务积压。

- **固定六个 skill，无运行时自定义**——提供方恰好贡献上游 `ponytail` skill 集合；需要其他强度档位或评审格式的部署请自行编写 skill。
- **没有钩子或常开模式**——上游宿主通过生命周期钩子或模式标记注入规则集；本包只提供指令正文，因此风格按每次加载的 skill 生效，而不是每轮生效。
- **复制的正文会与上游产生漂移**——随包分发的正文是源码中记录的固定版本处上游 skill 的复制；上游修复只有在本包重新复制后才会到达。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
