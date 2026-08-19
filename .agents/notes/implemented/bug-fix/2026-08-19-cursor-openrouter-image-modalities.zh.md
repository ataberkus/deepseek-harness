# Agent Note: Cursor 与实时 OpenRouter 的图片模态

Status: implemented

[English](2026-08-19-cursor-openrouter-image-modalities.md) | 中文

## 问题

`/login cursor` 之后给 Grok 4.6 附加图片会在任何提供方请求之前失败，报 `Model "grok-4.6" does not support image input.` 托管 Cursor 描述总是把 `input` 设为 `['text']`。GetUsableModels 没有图片能力字段，因此实时行也走同一个构造器。非官方 AgentRunRequest 展平还会把图片块换成 `[image]` 文本，并且不发送栅格字节。

OpenRouter 实时叠加对快照未收录的 id 有同样的少声明：`overlayLiveCatalogModels` 克隆协议与端点后强制 `input: ['text']`，即便 OpenRouter `GET /models` 已在 `architecture.input_modalities` 或 `architecture.modality` 中点名图片。已安装快照 id 仍保留 pi-ai 自己的模态。DeepSeek 仍为纯文本，因为该适配器不能发送图片。

## 决策

托管 Cursor 的聊天家族宣称 `[text, image]`。与推理相同的 id 标记（`grok`、`claude`、`gpt-`、`composer`、`gemini`、`kimi`、`glm`、`opus`、`sonnet`）以及每条捆绑 fallback id 都算聊天家族。`grok-code` 与未知实时 id 仍为 `[text]`，以免 harness 接纳随后会被非官方后端拒绝的图片。[Cursor OAuth](../feature/2026-08-18-cursor-oauth-host.md) 仍拥有登录与列表并集；本笔记拥有模态宣称与线路。

栅格字节作为非官方 `SelectedImage` 走 `UserMessage.selected_context`（`uuid` 为 2、`path` 为 3、`mime_type` 为 7、`data` 为 8）。展平历史发送每张用户与工具结果图片；带检查点的后续轮次只发送本轮。图片块不贡献提示文本。

仅实时 OpenRouter id 若在 `architecture.input_modalities` 或 `architecture.modality`（`text+image->text`）中公布了图片，会被标为 `[text, image]`；省略 architecture 的列表仍为纯文本。发现回复仍省略 `input`，与 `reasoning` 一致。[OpenRouter 实时叠加](../feature/2026-08-18-openrouter-live-catalog.md) 拥有这份并集；本笔记拥有图片标志。

## 考虑过的替代方案

**把第一条 catalog 模型的 `input` 复制到每个仅实时 OpenRouter id。** 否决：第一条快照行可能具备视觉，而仅实时 id 是纯文本，那会接纳随后在轮次中途被端点拒绝的附件。

**对每个托管 Cursor id（含 `grok-code` 与未知实时 id）都宣称 `[text, image]`。** 否决：GetUsableModels 不公布图片能力，多声明会留下会话无法切走的持久图片。

**因为展平使用 `[image]` 占位符而让 Cursor 保持纯文本。** 否决：非官方 `SelectedImage` 字段就是社区 AgentService 客户端所发送的，而且宿主错误在展平之前就触发了。

**从 GetUsableModels 的某个 protobuf 字段解析图片支持。** 否决：该回复里的 `ModelDetails` 没有这样的字段。

## 后果

Grok 4.6、Claude、GPT、Composer、Gemini 以及其他 Cursor 聊天家族会接受图片附件并发送像素。`grok-code` 仍拒绝。列表公布了图片输入的仅实时 OpenRouter 视觉模型无需 `settings.yaml` 的 `models` 条目即可接受图片；省略 `architecture` 的通用 OpenAI 列表仍拒绝。DeepSeek 仍为纯文本。

## 测试

`packages/llm/llm-pi-ai/tests/cursor.spec.ts` 钉住 `grok-4.6`／Composer 上推断出的 `[text, image]`、`grok-code` 与未知实时 id 上的 `[text]`、`SelectedImage` 编码、展平省略 `[image]` 占位符，以及携带 gif 字节的流请求体。`tests/listing.spec.ts` 钉住 `architecture.input_modalities`／`modality` 公布以及仅实时叠加的 `input` 字段。
