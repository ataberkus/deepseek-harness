# Agent Note: LM Studio 是一条一等本地 pi-ai 路由

Status: implemented

[English](2026-08-20-lm-studio-local-provider.md) | 中文

## Problem

本地 LM Studio 服务使用 OpenAI 兼容的 Chat Completions 协议，但可以不启用认证。若把它只当作普通手工声明路由，Models 页面会要求服务并不需要的字段；同时 pi-ai 的 OpenAI 客户端仍要求输入非空的密钥格式值。服务返回的模型 id 还是不透明且由部署决定的，因此伪造 catalog 条目或改写 id 会让发现结果与后续请求指向不同模型。

## Decision

`dsh-llm-pi-ai` 在可配置提供方目录中声明命名路由 `lmstudio`。它不是伪造的 pi-ai catalog 模型。profile 省略下列字段时，路由提供这些默认值：

- `api`：`openai-completions`；
- `baseURL`：`http://127.0.0.1:1234/v1`；
- 显示名称：`LM Studio`。

profile 仍然要求明确的 `models` 列表。列表项是用户持久化的选择，id 保持逐字节不变。profile 可以覆盖端点或协议；显式的 `apiKeyEnv` 通过 Harness 凭据 seam 解析，并优先于本地无密钥行为。

没有 `apiKeyEnv` 时，请求解析只为 `lmstudio` 路由提供非机密值 `lm-studio`。这满足 pi-ai 的 OpenAI 客户端要求，却不会保存或暴露凭据。其他路由仍保留现有区别：无引用时使用提供方原生环境发现，点名引用却无法解析时以 `MISSING_CREDENTIAL` 失败。

现有的 `llm.discoverModels` 路径承担发现工作。对 LM Studio，它请求已配置兼容端点的 `/models` 资源，把返回的 id 展示在 Models 页面，并只把用户采纳的模型写入 `settings.yaml`。运行时模型解析读取这份明确列表，不会轮询 LM Studio，也不会在每次请求时替换列表。因此不透明 id 在发现、settings、选择器元数据与请求之间始终是唯一标识。提供方声明目录的决策仍由[已有 Agent Note](../architecture/2026-08-03-pi-ai-declared-provider-catalog.md)拥有，本记录只扩展它。

可配置提供方视图为 `api` 与 `baseURL` 携带可选设置默认值。LLM 注册表会复制这些嵌套值，Host API 会投影并校验它们，Models 编辑器只在用户层和有效 profile 都没有字段时才把默认值写进草稿。应用草稿会把采纳的默认值作为普通 profile 字段保存，因此显式编辑和 composition 值都不会被覆盖。

## Alternatives considered

- **只把 LM Studio 保留为自定义提供方。** 这保留旧界面，却让每次本地设置都重复填写相同端点和协议，并为无需密钥的服务显示密钥字段。命名路由让 Models 页面提供可发现的选项，同时不改变通用自定义提供方路径。
- **在已安装 catalog 中加入伪造的 LM Studio 模型。** 这会让部署决定的 id 看起来像权威值，无法容纳任意已加载 id，并把路由绑定到一个模型。命名路由不制造模型，继续保持 catalog 边界。
- **每次请求刷新 LM Studio 的运行时 catalog。** 这会让请求行为依赖端点的可变状态，并要求缓存失效与离线策略。发现是用户动作；持久化模型列表仍是请求的唯一真源。
- **始终要求真实 API key，或完全不传 key。** 完全不传会在 pi-ai 内部失败，无法让无密钥服务响应；保存真实 key 又没有必要。路由私有的非机密占位值满足库的要求，同时保留显式凭据优先级和命名引用的响亮失败规则。

## Consequences

LM Studio 在 profile 存在之前就以休眠的一等选项出现在 Models 页面；编辑器可以使用文档规定的本地端点发现模型，而不需要初始密钥。用户必须明确采纳返回列表，因此后来在 LM Studio 中加载的模型不会自动出现在选择器中，直到再次发现。默认值元数据是可选且通用的，因此其他可配置提供方目录也能使用同一编辑器字段，而不必让 Host API 或 UI 绑定 LM Studio。

本地端点是产品默认值，不是网络可达性保证：在其他地址运行 LM Studio 时必须编辑 `baseURL`，启用认证的服务必须设置 `apiKeyEnv`。占位值从不是凭据记录，配置显式引用时也不会使用它。

## Testing

pi-ai catalog、配置、发现与适配器套件覆盖命名目录条目、精确默认值、显式覆盖、不透明 id、无密钥请求和凭据优先级。LLM topology、Host API 投影／schema 与 Models 编辑器套件覆盖嵌套默认值复制、协议投影、草稿填充、发现 payload 和 profile 字段持久化。组装后的 Web replay 与 GUI gate 仍是 Models 页面组合的产品级验证。
