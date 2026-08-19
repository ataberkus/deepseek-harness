# Agent Note: 在已安装 catalog 路由上叠加实时 OpenAI 兼容列表

Status: implemented

[English](2026-08-18-openrouter-live-catalog.md) | 中文

## 问题

模型选择器与 `session.models` 只从已安装的 pi-ai 快照提供 OpenRouter。`@earendil-works/pi-ai` 0.82.1 附带几百条 OpenRouter 行；实时 `GET https://openrouter.ai/api/v1/models` 更长，快照截取之后才出现、且具备工具能力的 id 从未出现。该 catalog 路由上的 Fetch 也短路到同一份快照，因此配置界面也无法采纳它们。显式 `models:` 列表本就会替换 catalog，不是这个缺口。

## 决策

`dsh-llm-pi-ai` 对「服务已安装 catalog」（缺省或空的 `models`）且说 `openai-completions` 或 `openai-responses` 的 OpenRouter catalog 路由，叠加一份实时的 OpenAI 兼容 `GET /models` 列表。叠加条件是路由键为 `openrouter`，或列举主机名为 `openrouter.ai`／`*.openrouter.ai`。已安装 id 保留 catalog 元数据。公布了 `supported_parameters` 却不含 `"tools"` 的行会被丢掉；省略该字段的列表保留每个可用 id。仅出现在实时列表中的 id 追加在 catalog 之后，并克隆第一条已安装模型的协议与端点，使 `listModels`、`resolveModel` 与 `stream` 共用同一集合。仅实时 id 若在 `supported_parameters` 中点名 `reasoning` 或 `reasoning_effort`，会被标为具备推理能力并带上 OpenRouter 档位映射（`low`／`medium`／`high`）；其余仅实时 id 仍不具备推理能力，以免选择器提供端点无法兑现的档位。显式 `models` 列表不会被叠加。

网络失败则回退到已安装 catalog，因此选择器不会变空。Fetch（`discoverModels`）使用同一套叠加与同一套回退，但调用方 abort 仍会响亮失败。成功的列表按进程生命周期缓存，键为 URL 以及 bearer 凭据的指纹，因此键入的探测密钥不会复用已存储密钥的回复。host 与 Web UI 不把 `openrouter` 路由键特殊处理。

单元测试拒绝非 loopback 列举 URL，从而不会等待提供方 API。生产环境不设置 `VITEST`，始终列举。

## 考虑过的替代方案

**升级 `@earendil-works/pi-ai` 以换一份更新的快照。** 作为持久修复被否决：下一次 OpenRouter 发布又会让包过期。为了其他 catalog 工作，升级仍可单独落地。

**用实时列表替换已安装 catalog。** 否决：OpenAI 的 `GET /models` 与 pi-ai 快照不是同一集合、而且更小，丢掉捆绑 id 会把选择器已经提供的模型藏起来。取并集既保留快照，又加上仅实时出现、且具备工具能力的 id。

**对每个可列举 catalog 路由（`openai-completions`／`openai-responses`）都叠加。** 否决：DeepSeek 与 OpenAI 的列举与推理共用同一 base URL，选择器上的 `GET /models` 并不是一次 catalog 刷新，还会吃掉脚本化的推理回复。因此叠加只针对 OpenRouter catalog id 或 OpenRouter 列举主机，放在 `dsh-llm-pi-ai` 内，而不是 host 或 UI 分支。

**在 host 或 Web UI 里把 `openrouter` 路由键特殊处理。** 否决：catalog 本就在 `dsh-llm-pi-ai` 里解析；只转发 `openrouter.ai` 的代理仍然需要同一套叠加。

**把实时列举做成默认关闭的 `Config` 可选项。** 否决：缺模型就是默认的 OpenRouter 体验；把这次拉取埋成可调项，缺口还会留着。

## 后果

选择一个存在于实时列表、但不在已安装快照中的 OpenRouter 模型，无需改 `settings.yaml`。用显式 `models` 列表收窄路由时，仍会隐藏该列表以外的一切。OpenRouter 上的 Fetch 会显示这些额外项供采纳；DeepSeek 上的 Fetch 仍由 catalog 作答、不联网。仅实时出现、且公布了推理参数的模型会提供 OpenRouter 档位；其余不声称具备推理或图片输入。需要图片输入或非 OpenRouter 档位映射的部署把它们写在 `models` 条目上。

## 测试

`tests/listing.spec.ts` 钉住 URL 拼接、单元测试仅允许 loopback 列举、仅 OpenRouter 的 catalog 列举目标、`supported_parameters` 过滤、OpenRouter 容量字段、仅实时推理叠加、叠加并集、进程生命周期缓存、进行中请求合并、按密钥区分的缓存身份，以及 HTTP 失败。`tests/discovery.spec.ts` 钉住 catalog 路由叠加以及 abort 与回退的区分，并保留 DeepSeek 仅 catalog（不联网）。`tests/live-catalog.spec.ts` 钉住选择器／`resolveModel` 的额外项、仅实时推理档位、显式 `models` 抑制叠加、列举失败回退，以及列举取密钥时的 `MISSING_CREDENTIAL`／`INVALID_CREDENTIAL`。
