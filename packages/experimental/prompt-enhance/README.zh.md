---
description: "可选插件包：在只读查阅工作区后，把输入框草稿改写成更清晰、更具体的提示词。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-prompt-enhance

[English](README.md) | 中文

## 概述

这个可选插件包为 Web 输入框加入提示词增强。Host 插件注册 `POST /prompt-enhance`；[浏览器控件](../client-ui-prompt-enhance/README.zh.md)提交已打开会话的草稿，并用返回结果替换草稿。增强器使用会话所选模型、会话已加载的工作区说明、最近的对话文本和草稿中的图片。回答前，它可以在会话工作目录内读取、搜索和列出文件，以便写出真实的文件和符号名。它不会向 Agent 发送任何内容。

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

在插件管理器中开启 **提示词增强**。输入框随后会在模型选择器前显示 ✨ 按钮；输入框获得焦点时，**Ctrl+Shift+E**（macOS 上为 **⌘⇧E**）效果相同。草稿会被原地替换，并弹出带 **撤销** 的提示；不会自动发送。改写进行中，输入框工具行会显示所用模型和当前查阅，例如 `读取 src/app.ts`；再次按下按钮即可取消。空草稿以及以 `/` 或 `!` 开头的草稿不会被改写。

插件包条目设置了下列策略。可在配置文件的 patch 层中以 `prompt-enhance` id 覆盖。

| 字段 | 插件包取值 | 含义 |
|---|---|---|
| `maxDraftChars` | 20000 | 可接受的最长草稿。 |
| `historyMessages` | 6 | 提供给模型的最近用户提示与助手消息数。 |
| `historyMessageChars` | 1500 | 每条消息的字符上限。 |
| `instructionsMaxChars` | 20000 | 提供给模型的已加载 AGENTS.md 兼容说明的字符上限；0 表示不提供。 |
| `maxToolCalls` | 6 | 一次改写可执行的工作区查阅次数；0 表示不发送工具。 |
| `toolResultMaxChars` | 12000 | 每次查阅结果的字符上限。 |
| `scanMaxBytes` | 2000000 | 查阅可读取的最大文件，以及可解析的最大原始搜索输出。 |
| `maxOutputTokens` | 4000 | 每次模型请求的输出 token 上限。 |
| `timeoutMs` | 150000 | 一次改写（含查阅）的端到端截止时间。 |
| `maxConcurrent` | 3 | 同时允许的调用数；超出时返回 HTTP 429。 |
| `provider`、`model` | 未设置 | 所有调用使用的固定路由，须同时配置；未设置时使用会话模型。 |
| `reasoningEffort` | 未设置 | 所有调用使用的适配器推理强度；未设置时使用所选模型的强度。 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节 — 点击展开</summary>

路由只响应通过组合中 `connection` 防护的请求。它接受带字符串 `sessionId` 与 `text` 的 `application/json` 请求体，长度受 `maxDraftChars` 限制，并可附带 base64 `images`，由 `ctx.attachments` 在调用前存储。会话必须有存活的 Agent。路由按以下顺序确定模型：配置的 `provider`/`model`、会话待生效的选择、上一次请求的模型、默认模型。调用开始前被拒绝的请求以 4xx/5xx 状态返回 `{ code, message }`。被接受的请求以 `200` 返回 NDJSON 帧：带路由的 `start`、每次查阅一个 `step`，最后是带改写结果的 `done` 或 `error`。[`index.ts`](src/index.ts) 中的调用循环发送 [`enhance.ts`](src/enhance.ts) 的系统提示词和 [`lookup.ts`](src/lookup.ts) 的 `read`/`grep`/`glob` 模式。查阅在插件内部执行而不经过工具注册表，因此工具策略、观察记录、溢出存储和会话事件都看不到它们。查阅会解析符号链接并拒绝工作目录之外的路径；`glob` 跳过被忽略的文件。超过 `maxToolCalls` 的调用得到错误结果，模型若仍不回答则以 `tool-calls` 失败。关闭请求会中止调用。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [浏览器控件](../client-ui-prompt-enhance/README.zh.md) — 输入框按钮、撤销提示与键盘命令。

-----

<a id="model-experience"></a>
## 模型体验

对 Agent 没有影响，因为改写是会话之外的辅助调用；只有用户发送的提示词才会以普通用户消息到达 Agent。每次改写每轮查阅产生一次模型请求，最多 `maxToolCalls + 2` 次，每次都携带说明、对话尾部、草稿、图片和之前的查阅结果。

#### KV Cache 影响

无直接影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 调用不会记录到会话日志，因此无法从日志重放改写。
- 查阅绕过会话的工具策略（包括审批和钩子）；作为替代，它们只读且限制在工作目录内。
- 带 `include` 的 `grep` 与 ripgrep 自身的 `--glob` 一样，也会搜索被忽略的文件。
- 即使丢弃改写结果，图片也会作为附件存储。
- 只有拥有存活 Agent 的会话可以增强；尚未开始的新会话输入框会收到 HTTP 404。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
