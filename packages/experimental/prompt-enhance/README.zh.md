---
description: "可选插件包：通过一次辅助模型调用，把输入框草稿改写成更清晰、更具体的提示词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-prompt-enhance

[English](README.md) | 中文

## 概要

这个可选插件包为 Web 输入框加入提示词增强。Host 插件注册 `POST /prompt-enhance`；[浏览器控件](../client-ui-prompt-enhance/README.zh.md)提交已打开会话的草稿，并用返回结果替换草稿。调用使用会话所选模型、最近的对话文本和会话工作目录，不会向 Agent 发送任何内容。

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

在插件管理器中开启 **提示词增强**。输入框随后会在模型选择器前显示 ✨ 按钮；输入框获得焦点时，**Ctrl+Shift+E**（macOS 上为 **⌘⇧E**）效果相同。草稿会被原地替换，并弹出带 **撤销** 的提示；不会自动发送。改写进行中再次按下按钮即可取消。空草稿以及以 `/` 或 `!` 开头的草稿不会被改写。

插件包条目设置了下列策略。可在配置文件的 patch 层中以 `prompt-enhance` id 覆盖。

| 字段 | 插件包取值 | 含义 |
|---|---|---|
| `maxDraftChars` | 20000 | 可接受的最长草稿。 |
| `historyMessages` | 6 | 提供给模型的最近用户与助手消息数。 |
| `historyMessageChars` | 1500 | 每条消息的字符上限。 |
| `maxOutputTokens` | 4000 | 调用的输出 token 上限。 |
| `timeoutMs` | 120000 | 调用的端到端截止时间。 |
| `maxConcurrent` | 3 | 同时允许的调用数；超出时返回 HTTP 429。 |
| `provider`、`model` | 未设置 | 所有调用使用的固定路由，须同时配置；未设置时使用会话模型。 |
| `reasoningEffort` | 未设置 | 所有调用使用的适配器推理强度；未设置时使用所选模型的强度。 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

路由只响应通过组合中 `connection` 防护的请求。它接受带字符串 `sessionId` 与 `text` 的 `application/json` 请求体，长度受 `maxDraftChars` 限制。会话必须有存活的 Agent。路由按以下顺序确定模型：配置的 `provider`/`model`、会话待生效的选择、上一次请求的模型、默认模型。它以 [`enhance.ts`](src/enhance.ts) 中的固定系统提示词发起一次 `ctx.llm.stream()` 调用，返回 `{ text, provider, model }`，失败时以 4xx/5xx 状态返回 `{ code, message }`。关闭请求会中止调用。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [浏览器控件](../client-ui-prompt-enhance/README.zh.md) — 输入框按钮、撤销提示与键盘命令。

-----

<a id="model-experience"></a>
## 模型体验

对 Agent 没有影响，因为改写是会话之外的辅助调用；只有用户发送的提示词才会以普通用户消息到达 Agent。

#### KV Cache 影响

无直接影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 调用不会记录到会话日志，因此无法从日志重放改写。
- 模型没有工具：无法读取文件确认路径，只会提及草稿或对话中出现的名称。
- 只有拥有存活 Agent 的会话可以增强；尚未开始的新会话输入框会收到 HTTP 404。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
