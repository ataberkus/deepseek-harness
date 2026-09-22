---
description: "随包附带的 ADHD 友好输出风格 skill（技能），供启用、使用或排查该可选 i-have-adhd 提供方的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-i-have-adhd

[English](README.md) | 中文

## 概述

agent（智能体）可以通过该内置提供方加载 `i-have-adhd` skill，并遵循其指令，把每条回复都塑造成 ADHD 读者可以直接行动的形状：下一步行动置顶、多步工作编号、结尾只给一个具体下一步，并且没有开场白、复述与客套收尾。该提供方没有配置，随附 CLI（命令行界面）组合以禁用状态包含该插件，因此部署方需要显式启用。skill 正文从上游 `i-have-adhd` 项目（MIT）随包分发；本包不携带钩子或常开模式，因此只有加载该 skill 时风格才生效。

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

启用插件即可让 `i-have-adhd` skill 出现在会话 skill 目录中；随后模型可以像加载任何其他 skill 一样加载它，并遵循其 ADHD 友好输出指令。

### 何时选择

当回复应当下一步行动置顶、多步工作编号、每轮重述进展、并且压制题外话与客套话，而又不想把 skill 文件存入本地 skill 目录时，选择此提供方。当输出风格无需塑造时，请跳过——插件默认禁用，启用前不增加任何东西。

### 启用插件

该插件没有配置。把它的组合行加入组合即可；随附 CLI 组合以 `disabled: true` 携带该行，因此在那里需要显式启用。

```yaml
- name: '@deepseek-ai/dsh-skill-i-have-adhd'
```

启用后，用户显式手势 `/i-have-adhd` 会调用该 skill（该 skill 仅用户可调用、模型不可调用，与上游 `disable-model-invocation: true` 策略一致），其规则在该会话剩余时间内保持生效，直到用户说「stop adhd mode」或「normal mode」。模型目录从不展示它，因此模型不会主动加载。

### i-have-adhd skill 提供什么

- **十条输出规则。** 下一步行动置顶、多步任务编号、结尾只给一个具体下一步、压制题外话、每轮重述状态、给出具体时间估计、让进展可见、出错就事论事、列表上限 5 项，并且去掉开场白、复述与客套收尾。
- **打破规则的条件。** 何时完整解释、破坏性操作前确认、何时停止调试循环、改问一个澄清问题。
- **发送前检查。** 发送前删除宣告式开头、「还有别的问题吗」式结尾、题外话、空洞的模糊副词与习语。

### 可观察的成功与失败

启用插件会使 `i-have-adhd` 可凭名称通过用户显式 `/i-have-adhd` 手势加载；禁用或省略该行则它不会出现在任何目录中。由于提供方不可变，发现始终成功且恰好返回一个 skill，绝不会报告部分结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释内置提供方如何接线；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是一个不可变、同步注册的 skill 来源：它以 `i-have-adhd` 作为提供方名称、按内置 skill rank（600）注册一个固定候选项，把随包分发的 `assets/` 目录作为该 skill 的目录资源基底公开，并在每次加载时从随包分发的 `assets/i-have-adhd.md` 文件读取 skill 正文。其调用策略仅用户可用，与上游 `disable-model-invocation: true` 前置元数据一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口与不可变提供方：一个候选项、资源基底、正文加载 |
| — | 不发布运行时不变式伴生入口；本包只持有一个不可变的提供方注册，注册唯一性与生命周期检查由 skill 注册表负责。 |
| [`assets/`](assets/) | 随包分发的 skill 正文（`i-have-adhd.md`），从上游项目复制而来 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时，请阅读以下页面。这些页面先介绍该提供方注册到的注册表，再说明 skill 如何到达模型。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——该提供方实现的注册表与提供方约定。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表，以及已加载 skill 的共享渲染。
- [tool-skill 包](../tool-skill/README.zh.md)——skill 如何到达会话目录与模型，包括作为该 skill 唯一入口的用户显式手势。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；当用户显式调用时，该包会把已加载的 skill 正文渲染给模型。

#### KV Cache 影响

该插件默认禁用，不会改变任何请求。启用后，已加载正文会在其插入点改变提供方的 KV 前缀；该 skill 从不出现在面向模型的目录中，因此不增加目录 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明内置提供方不做什么。它们是当前包约束，不是任务积压。

- **固定一个 skill，无运行时自定义**——提供方恰好贡献 `i-have-adhd` 这一个 skill；需要其他输出规则的部署请自行编写 skill。
- **仅用户调用，从不向模型展示**——该 skill 按设计留在面向模型的目录与加载器之外，因此用户先调用 `/i-have-adhd` 之前，模型不会采用该风格。
- **复制的正文会与上游产生漂移**——随包分发的正文是源码中记录的固定提交处上游 skill 的复制；上游修复只有在本包重新复制后才会到达。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
