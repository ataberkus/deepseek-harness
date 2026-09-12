# Agent Note: List live Codex OAuth models over the account registry

Status: implemented

[English](2026-09-12-codex-oauth-model-listing.md) | 中文

## 问题

模型选择器对 `openai-codex` 只提供已安装 pi-ai 快照中的模型。快照裁剪之后上线的账号专属 SKU——Daybreak Blue 及其他滚动别名——永远不会出现，即使登录账号本来可以调用它们。pi-ai 0.85.1 没有提供 Codex 模型发现接口，而配置时模型发现按设计对目录路由只回答快照内容，因此两条路径都无法给出这些模型。

## 决策

`dsh-llm-pi-ai` 在每次解析服务模型列表时读取账号维度的 Codex 注册表，并将其合并到已安装目录之上。`src/codex/models.ts` 拥有抓取、归一化与合并逻辑；pi-ai 仍是 Codex 传输层。

`fetchCodexModels` 依次尝试 `GET {baseURL}/codex/models` 与 `GET {baseURL}/models`，均携带 `?client_version=0.153.4`。请求携带存储的 OAuth 访问令牌作为 `Authorization: Bearer`、从该 JWT 读取的 `chatgpt-account-id` 声明、`OpenAI-Beta: responses=experimental`、`originator: pi`、`version` 头以及 harness `User-Agent`。客户端版本 pin 与 `dsh-subagent-codex` 中的 `@openai/codex` 依赖保持一致，因为后端据此对模型可用性做版本门控。基地址取 profile `baseURL` 覆盖值，否则为 `https://chatgpt.com/backend-api`。响应接受 `models` 或 `data` 数组；隐藏行与无可用 slug 的条目会被跳过，不影响其余模型。

归一化后的行携带注册表 slug、显示名、推理能力声明、已声明的输入模态与上报窗口。推理等级以裸名或 `{ effort }` 对象到达，并映射到规范 pi-ai 等级；只声明 `none` 的行不提供选择器。未声明的模态保持未声明，合并时绝不虚构图片能力。上报窗口优先；缺省时，已知 id 沿用目录容量，纯新增 id 取代系默认值（GPT-5.6 世代含 Daybreak 别名为 372K，其余为 272K）。Luna、Sol 与 Terra 保底为注册表仍低报的 1M 订阅窗口，高于保底的上报值按原值采用。输出上限为 `min(128K, window)`。

`mergeCodexCatalogs` 先按后端顺序提供实时行，再按目录顺序追加仅目录中的 id。实时行保留注册表名称与容量。已知 id 保留目录价格；纯新增 id 克隆首个已安装模型的协议、端点与兼容性并计零价格，因为订阅制没有按 token 计费事实。实时 effort 映射替换快照映射；否则已安装描述符原样保留。显式 profile `models` 列表永远不进入合并。抓取、解析或凭据的任何失败都回答已安装目录，因此选择器永远不会放空。

列表读取直接从凭据存储取令牌且永不刷新：过期令牌会收到 401、回退到已安装目录，而请求路径仍在 pi-ai 锁下刷新并在失败时明确报错。单测禁止访问注册表网络并 stub 抓取，与托管 Cursor 列表做法一致。

## 考虑过的替代方案

**升级 `@earendil-works/pi-ai` 获取更新快照。** 否决，与 [OpenRouter 叠加](2026-08-18-openrouter-live-catalog.zh.md) 同理：下一次发版又会过期。仍可为其他目录工作单独升级。

**用实时列表替换已安装目录。** 否决：空白或漂移的注册表响应会隐藏选择器已有且请求路径可用的模型。并集保留快照，只追加账号专属 id。

**复用 `listing.ts` 的 `overlayLiveCatalogModels`。** 否决：该叠加保留已知 id 的已安装容量，会隐藏 Luna/Sol/Terra 的 1M 保底；其模板克隆还会把模板价格误算到纯新增的订阅模型上。

**列表鉴权走带刷新的 `Models.getAuth`。** 否决：每次渲染选择器都触发刷新会带来网络与锁争用，吊销的令牌还会直接打爆列表。直接读存储使列表保持尽力而为；请求保持权威。

**为 `-wm` worker slug 合成 plain 路由。** 否决：oh-my-pi 需要该合成是因为其发现会剪枝；此处的并集已保证每个已安装 plain id 可解析，无需虚构路由。

**读取 `~/.codex/auth.json` 获取更多账号。** 按既有 [Codex OAuth 宿主](2026-08-18-openai-codex-oauth-host.zh.md) 决定否决：harness 只绑定自有凭据存储，不绑定其他工具的私有文件。

## 后果

登录账号无需改 `settings.yaml` 即可在选择器看到 Daybreak Blue 及其他滚动别名，且选中可用，因为请求路径会路由注册表公布的任何 id。以显式 `models` 列表收窄路由仍会隐藏列表之外的一切。纯新增模型在 token 用量中记零花费；已知 id 保留目录价格。注册表结构漂移只需改 `src/codex/models.ts`；Codex Responses 传输仍是 pi-ai。[Codex OAuth 宿主](2026-08-18-openai-codex-oauth-host.zh.md)仍拥有登录、存储与刷新。

## 测试

`tests/codex.spec.ts` 锁定请求头构造与账号声明提取、路径回退与凭据拒绝行为、行归一化（Daybreak 能力、`{ effort }` 对象、隐藏行、模态与窗口规则、1M 保底）、合并并集与价格行为、存储与注册表失败时的已安装回退、代理 `baseURL`，以及选择器与 `resolveModel` 对纯新增 id 的服务。`tests/oauth-login.spec.ts` 中的托管请求回归现已定位到请求路径的存储读取，因为列表读取先取令牌。新模块保持 100% 行、分支与函数覆盖率。
