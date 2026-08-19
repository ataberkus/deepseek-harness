# OAuth 托管运行时健康

[English](2026-08-19-oauth-host-runtime-health.md) | 中文

Status: draft for review

## 范围

本规格覆盖托管的 `google-gemini-cli` 和 `cursor` 提供方报告的运行时症状。它保留现有 OAuth 路由、模型目录和 agent-loop 所有权，同时让提供方可用性在模型列举和流式处理边界可见。

## 已确认证据

活动 Web 进程暴露已连接的 Cursor 路由和包含 `grok-4.6` 的 fallback 模型组。Cursor `GetUsableModels` 成功返回空 payload，并且每个已测试模型的 Cursor `Run` 只返回一个 heartbeat update 就关闭流。因此适配器会把提供方空流转为通用的 `EMPTY_RESPONSE` 失败并重试。

活动进程不包含 Gemini OAuth 凭据或实时 Gemini 路由。源目录可以解析捆绑的 Gemini 模型，现有 OAuth 测试覆盖路由注入和模型列举。因此活动进程中无法复现实时 Gemini 选择器失败；剩余的代码风险是登录后的 Host 到 Client 组合失效路径。

## 目标

- 验证从凭据持久化到 `llm.providers`、`llm.models`、转发的 `llm/adapters-updated` 事件和已打开模型选择器的组合 OAuth 登录路径。
- 区分成功但为空的 Cursor 发现响应和网络失败。
- 将 Cursor 只有 heartbeat 的终止流报告为提供方专属失败，而不是成功的空完成。
- 让提供方凭据、访问令牌和 request body 不出现在诊断和测试中。
- 保留正常的 Cursor 文本、思考、工具调用、图像和 checkpoint 行为。

## 提议行为

### Gemini 组合检查

增加一个带有模拟 OAuth 和浏览器打开边缘的真实组合 Web 测试。登录命令完成后，组装的 Host 必须暴露注入的 OAuth 提供方和捆绑的 Gemini 模型组。Host 必须转发拓扑事件，Client 模型选择服务必须刷新已经加载的目录，而不需要页面重新加载。测试还必须验证未打开的目录不会仅因为收到失效通知就发起 fetch。

如果该测试在没有源代码变更的情况下通过，则 Gemini 提供方实现保持不变。来自不同 Harness home 或旧进程的实时 Settings 行属于环境诊断，不是目录缺陷。

### Cursor 发现

当网络不可用或缺少访问令牌时保留捆绑 fallback，因为这些条件不能证明账户没有可用模型。成功但为空的 `GetUsableModels` payload 应被视为后端健康失败，而不是静默返回 fallback。`session.models` 响应必须为 Cursor 提供方保留失败记录，使选择器不能提供活动后端未确认的模型 id。

失败消息必须指出 Cursor 模型发现，并说明后端没有返回可用模型。它不得包含访问令牌、request body 或账户身份。

### Cursor 流式处理

追踪 Cursor 流是否产生文本、思考或工具调用。如果流在只有 heartbeat 的更新后关闭，且没有终止内容块，则发出提供方专属错误事件。Harness finish 分片必须使用不可重试的 Cursor 空流 code 和可操作消息，而不是 `EMPTY_RESPONSE`；现有重试策略默认不得重复已知的只有 heartbeat 的后端结果。

产生有效内容块的流仍然成功，即使其中交错了 heartbeat 更新。现有传输错误、取消、工具调用恢复和正常终止更新继续使用当前分类。

## 验证

- 在生产变更前为 Gemini 组合登录失效、空 Cursor 发现和只有 heartbeat 的 Cursor 流式处理增加失败回归测试。
- 保持现有提供方、OAuth、适配器和模型选择器测试通过。
- 运行聚焦 LLM 和 Client 测试、受影响的 package 构建以及组装后的 Web 产物构建。
- 重新构建受影响产物后刷新 `http://127.0.0.1:3080`，验证实时模型选择器和 Settings 页面。
- 针对规格和 Agent Note 变更运行仓库要求的文档与 diff 检查。

## 非目标

本改动不增加 Gemini 模型列举 endpoint，不为 OAuth 提供方增加 Settings 页面模型编辑器，也不从 Gemini CLI 或 Cursor IDE 私有存储读取凭据。不尝试完整 Cursor 协议重写，不用 `@cursor/sdk` 替换非官方 Connect client，也不承诺 Cursor 上游服务没有可用数据时仍提供功能。

## Alternatives considered

- **每次 Cursor 响应为空都保留 fallback 模型：** 否决，因为成功的空后端响应会宣传账户或服务未确认的 id，并导致误导性重试。
- **只修改模型选择器：** 否决，因为无效状态来自提供方发现和流式处理，而不是渲染。
- **把只有 heartbeat 的流视为 `EMPTY_RESPONSE`：** 否决，因为这会丢失提供方原因，并允许正常的空响应重试循环。
- **立即移植最新社区 Cursor wire 实现：** 延后，因为当前实时探测在候选 framing 下仍返回只有 heartbeat 的响应；更大的协议重写需要在成为安全修复前先有经过验证可工作的对照实现。
- **增加 Gemini 登录控件或修改 Settings 行：** 否决，因为 OAuth 已经是命令式流程，当前 Settings 展示是有意设计；未解决的 Gemini 证据属于运行时状态，而不是已证明的 UI 约定缺陷。

## 风险和缓解

Cursor 服务短暂地成功返回空 payload 时，系统会隐藏 fallback 组，而不是显示过时模型。诊断会指出失败的发现操作，后续拓扑刷新可以重试列举。外部 Cursor 协议仍是非官方协议；测试固定失败分类并保留有效夹具行为，不断言上游可用性永久不变。

Gemini 组合测试通过时，用户 GUI 仍可能指向另一个 Harness home 或旧进程。测试只报告 Host 和 Client 约定；实时排查必须比较活动进程、Harness home 和构建后的 Web 修订。
