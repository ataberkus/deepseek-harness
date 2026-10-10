---
description: "Web 输入框按钮与键盘命令：用 Host 改写的提示词替换草稿，并支持撤销。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-prompt-enhance

[English](README.md) | 中文

## 概述

这个浏览器插件绘制 [prompt-enhance 插件包](../prompt-enhance/README.zh.md)的 ✨ 控件。它注册一个 `conversation.input.right` 条目和 `composer.enhancePrompt` 键盘命令。按下后，草稿提交到 Host 路由，并由返回结果替换。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

插件包会加载本插件；在插件管理器中开启 **提示词增强** 即可。草稿为空、以 `/` 或 `!` 开头，或输入框正在提交时，按钮不可用。改写进行中按钮显示 ✕，按下即取消。改写完成后替换草稿并弹出带 **撤销** 的提示，撤销会恢复替换前一刻的草稿。失败时显示 Host 返回的信息，草稿保持不变。键盘命令默认为 **Ctrl+Shift+E**（macOS 上为 **⌘⇧E**），作用于当前获得焦点的输入框，可在快捷键设置中重新绑定。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

[`EnhancePrompt.tsx`](src/client/EnhancePrompt.tsx) 通过 `useInput` 读取草稿，通过 `inputActions.setDraft` 再调用 `persistDraft` 写入。切换会话或卸载时会中止进行中的请求。每个已挂载的控件都会注册一个快捷键目标；命令选择其输入框卡片包含当前焦点元素的目标。[`request.ts`](src/client/request.ts) 向文档相对路由 `prompt-enhance` 发送请求。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Host 路由与策略](../prompt-enhance/README.zh.md)。

-----

<a id="model-experience"></a>
## 模型体验

无，因为控件只替换未发送的草稿；只有用户发送后 Agent 才会看到文本。

#### KV Cache 影响

无直接影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 替换草稿会把内联引用标签变成纯文本形式；撤销恢复的是文本，而不是标签。
- 改写进行中输入框仍可编辑；期间的修改会被替换，撤销可以恢复它们。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
