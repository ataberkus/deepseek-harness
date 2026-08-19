# Agent Note: 实时 catalog 推理档位、OAuth 退出登录与 Cursor Fast SKU

Status: implemented

[English](2026-08-19-catalog-reasoning-oauth-signout-cursor-fast.md) | 中文

## 问题

托管 OAuth 与 OpenRouter 实时叠加落地之后，catalog 与模型页上同时出现三处缺口。

选择仅实时出现的 OpenRouter 模型（DeepSeek Flash 以及快照之后的 id）时，推理档位控件不会出现。叠加会克隆第一条 catalog 模型，却强制 `reasoning: false` 并剥掉 `thinkingLevelMap`，即便 OpenRouter `GET /models` 已在 `supported_parameters` 中点名 `reasoning` 或 `reasoning_effort`。已安装快照 id 仍保留 catalog 档位；新 id 没有。

Codex 与 Cursor 在设置 → 模型中显示为已登录行，却无法移除已存储的登录。登出只存在 `/logout openai-codex` 与 `/logout cursor`。OpenRouter 卡片上的「获取可用模型」与选择器使用同一份叠加，但只有 320px 的复选框列表，没有搜索，也没有全选，因此要从一份很大的 catalog 里采纳子集并不实际。

Cursor 登录成功后仍会漏掉 Grok 4.6 与 Fast SKU。捆绑 fallback 是一份止于 Grok 4.5 的短列表，实时额外项只是追加，protobuf 缺少 `thinking_details` 时会把模型标成不推理。oh-my-pi 以实时 GetUsableModels 为准，并把 Fast 当成独立 id（`grok-4.6-fast`），而不是 `maxMode` 标志。

## 决策

OpenRouter 实时叠加读取 `supported_parameters`。仅实时 id 若点名 `reasoning` 或 `reasoning_effort`，会被标为具备推理能力，并带上 OpenRouter 映射 `{ low, medium, high }`。其余仅实时 id 仍不具备推理能力。已安装 catalog id 保留快照映射。发现回复仍省略 `reasoning`，因此 `llm.discoverModels` 只携带 id／名称／容量。[OpenRouter 实时叠加](../feature/2026-08-18-openrouter-live-catalog.md) 拥有这份并集；本笔记拥有推理标志。

`LlmAdapter.logout`／`LlmRuntime.logout`／`llm.logout` 通过与 `/logout` 相同的 `logoutHostedOAuth` 路径删除托管 OAuth 凭据。模型页上 `auth: oauth` 行的退出登录会先确认，再调用该 RPC 并重新加载。它不走 `settings.mutate`。[Codex](../feature/2026-08-18-openai-codex-oauth-host.md) 与 [Cursor](../feature/2026-08-18-cursor-oauth-host.md) 登录仍只走命令；本笔记补的是断开，不是 Sign-in。「获取可用模型」沿用同一份叠加，并加上搜索框，以及针对**已过滤**候选列表的全选／取消全选。

Cursor 列表以实时为准：GetUsableModels 描述在 id 冲突时胜出，捆绑 fallback 补上回复遗漏的已记录 id（含 `grok-4.6`／`grok-4.6-fast` 以及 Cursor 提供的其他 Fast SKU），且 `withFastVariants` 只在 fallback 表里有该 id 时才补 `{id}-fast`。不会合成 `gpt-5.4-fast` 这类未记录 Fast id。推理先看 thinking details，再看 fallback 行，再看 id／名称标记（`grok`、`claude`、`gpt-`、`composer`……），`grok-code` 除外。

## 考虑过的替代方案

**把第一条 catalog 模型的 `thinkingLevelMap` 复制到每个仅实时 OpenRouter id。** 否决：那会在 OpenRouter 只记录 `low`／`medium`／`high` 的模型上提供 `xhigh`／`max`，请求会以 `UNSUPPORTED_REASONING_EFFORT` 失败。

**把缺席的 `supported_parameters` 当成具备推理。** 否决：通用 OpenAI `GET /models` 会省略该字段；发明选择器会提供端点无法兑现的档位。

**通过 `settings.mutate` 或 `credentials.unset` 删除 OAuth 登录。** 否决：live 路由没有 settings 地址，token 在 `$DSH_HOME/oauth-credentials.json` 里，不在 API 密钥凭据存储。退出登录必须调用适配器拥有的存储删除。

**为每个实时 Cursor id 都合成 `{id}-fast`。** 否决：Cursor 把 Fast 记录为具体 SKU。发明 `gpt-5.4-fast` 会发出后端并不服务的 id。

## 后果

新列入的 OpenRouter 推理模型会在 composer 上显示档位控件，无需 `settings.yaml` 的 `models` 条目。从设置 → 模型退出 Codex 或 Cursor 登录会注销 live 路由。大型 OpenRouter catalog 上的 Fetch 可搜索。即便 GetUsableModels 遗漏，Cursor 登录也会列出 Grok 4.6 与已记录 Fast 变体。仅实时 OpenRouter id 仍不声称具备图片输入。

## 测试

`packages/llm/llm-pi-ai/tests/listing.spec.ts` 与 `live-catalog.spec.ts` 钉住仅实时推理叠加以及 `resolveModelInfo` 档位。`tests/cursor.spec.ts` 钉住 fallback id、实时优先合并、仅已记录 Fast，以及推断出的推理。`packages/llm/llm/tests/service.spec.ts` 钉住默认 `UNSUPPORTED_OPTION` 以及适配器拥有的 logout。`packages/host/apiproxy/tests` 钉住 `llm.logout` 往返与 `oauth-logout-failed`。`packages/client/ui-settings-models/tests` 钉住退出登录以及 Fetch 的搜索／全选。
