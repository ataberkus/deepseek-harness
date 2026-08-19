# Agent Note: 按模型的 OpenRouter 与 Cursor 推理档位

Status: implemented

[English](2026-08-19-per-model-listing-reasoning-efforts.md) | 中文

## 问题

composer 的档位菜单与每个模型实际接受的档位不一致。Cursor 的 Grok 4.6 会显示 Default／Off／Minimal／Low／Medium／High，因为 `cursorModel` 只设了 `reasoning: true`、没有 `thinkingLevelMap`，于是 pi-ai 把缺席的基础档位键当成支持，且缺少 `defaultEffort` 时选择器会插入一行 Default。Grok 4.6 文档中的集合是 `low`／`medium`／`high`／`xhigh`，推理不能关闭，默认是 `high`。

OpenRouter 上的 DeepSeek 行是同一类错误。实时叠加给仅实时 id 盖上 `{ low, medium, high }`，已安装快照映射原样保留，因此 DeepSeek V4 Flash（`xhigh`／`high`，默认 `high`）以及其他 listing `reasoning` 对象到不了选择器。

[实时 catalog 推理笔记](2026-08-19-catalog-reasoning-oauth-signout-cursor-fast.md) 仍拥有推理标志、OAuth 退出登录与 Cursor Fast SKU。

## 决策

OpenRouter 叠加解析每一行 listing 的 `reasoning` 对象：`supported_efforts` 是提供的档位，`default_effort` 是选择器公布的默认值，`none` 对应 pi-ai 的 `off`，JSON null 的 `supported_efforts` 表示网关全集（`mandatory` 为 true 时去掉 `none`）。`supported_parameters` 点名了推理参数却没有可用对象时，仍使用 `{ low, medium, high }`。匹配的已安装 id 采用实时映射，以免快照继续提供端点已不再点名的 Off／Minimal／多余档位。未声明的 pi-ai 档位被钉成 `null`；缺席的基础档位键否则会被当成支持。`resolveModelInfo` 公布 `defaultThinkingLevel`，因此 listing 或家族表已点名默认值时，composer 不会插入 Default 行。

Cursor GetUsableModels 的 `ThinkingDetails` 只是存在标志、没有档位名，因此按 id（去掉 Fast 后缀）查家族表来挂映射。Grok 4.6 是 `low`／`medium`／`high`／`xhigh`，默认 `high`。其余 Grok id、Composer、Kimi／`k3` 以及未知推理 id 是 `low`／`medium`／`high`，默认 `high`。GPT-5.4 是 Off（线上为 `none`）／Minimal／Low／Medium／High／Xhigh，默认 `medium`。其余 GPT／Codex id 不含 Xhigh。Claude 是 Off／Low／Medium／High，默认 `high`。Gemini 是 Minimal／Low／Medium／High。GLM 是 Low／High／Max。Cursor 运行把选中的档位编进 ThinkingDetails 字段 1；开启思考但未点名档位时发空消息（Cursor 默认）；`off` 省略 ThinkingDetails。

## 考虑过的替代方案

**继续给仅实时 OpenRouter id 盖硬编码的 `{ low, medium, high }`。** 否决：DeepSeek V4 Flash 是 `xhigh`／`high`；Grok 4.6 含 `xhigh` 且强制推理。

**listing 点名同一 id 时仍保留已安装快照映射。** 否决：已安装 id 会在实时列表点名更窄集合之后仍提供 catalog 的 Off／Minimal。

**从 GetUsableModels ThinkingDetails 读取 Cursor 档位。** 否决：该适配器解码的 Connect proto 里，这个字段是空的存在标志。

**在 Grok 4.6 上提供 Off 或 Minimal。** 否决：该模型的推理不能关闭；除非把基础档位键钉成 `null`，pi-ai 会把缺席当成支持。

## 后果

composer 为 Cursor Grok 4.6 显示 Low／Medium／High／Xhigh，并选中 High。OpenRouter DeepSeek V4 Flash 显示 High／Xhigh，并选中 High。listing 未点名 `default_effort` 时仍省略 `defaultEffort`，因此只有端点未公布默认值时才会出现 Default 行。仅实时 OpenRouter id 仍不声称具备图片输入。

## 测试

`packages/llm/llm-pi-ai/tests/thinking-levels.spec.ts` 钉住钉死未声明档位、`none` → `off`，以及 listing 对象解析。`tests/listing.spec.ts` 钉住实时 `supported_efforts`／`default_effort`，以及覆盖已安装 id 的快照映射。`tests/live-catalog.spec.ts` 钉住 DeepSeek V4 Flash 的 High／Xhigh 与默认 High。`tests/cursor.spec.ts` 钉住家族映射、Grok 4.6 把 Off／Minimal 钉成不支持、ThinkingDetails 字段 1，以及档位为 `off` 时省略 ThinkingDetails。
