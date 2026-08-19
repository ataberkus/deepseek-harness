# Agent Note: 会话 USD 费用估算

Status: implemented

[English](2026-08-19-session-usd-cost.md) | 中文

## 问题

会话日志已经保存了彼此独立的提供方 token 桶，但 Web 和 headless 输出没有显示会话的 USD 估算值。oh-my-pi 会累加每条 assistant usage 记录的 `cost.total`；这对有 catalog 价格的模型有用，但 Cursor 和自定义路由缺少价格元数据时会悄悄显示为零。Cursor AgentService 会报告输出 token 增量，却不会报告完整的计费输入与缓存用量。

## 决策

`TokenUsage` 携带可选的 `estimatedCostUsd` 与 `costBasis`。`reported-usage` 使用提供方完整 usage 与价格表；`estimated-input` 使用 Cursor 的输出 token 增量，以及对序列化请求输入的固定密度估算。`tokenUsage` projection 按 step 累积这些字段，并用最终样本替换早期 chunk 样本，因此流式 usage 不会重复计数。

已知的 pi-ai 模型价格以及配置的 DeepSeek 或自定义模型价格表，都按每百万 token 对彼此独立的输入、读缓存、写缓存和输出桶计价。缺少所需价格时，该 step 标记为未定价。会话中只要存在未定价 usage，就显示「预计费用不可用」，而不是把缺少价格当作 `$0`。

Cursor 价格是官方 [Models & Pricing 表](https://cursor.com/docs/models-and-pricing) 的提交快照，日期为 2026-08-19。`GetUsableModels` 决定可用性；快照为文档中的模型 id 和 Fast 变体提供价格。配置的 `cursorTokenRate` 会对第三方模型加上文档所述 Teams 或 Enterprise 每百万 token $0.25 的附加费；Cursor 自有模型免除此费用。运行时不会抓取文档，也不会应用临时促销折扣。

Web composer stats strip 在 token usage 后追加本地化的预计、近似或不可用费用。headless runner 保持 stdout 只有答案，并把费用状态写入 stderr。两个表面都使用 oh-my-pi 的按数量级 USD 精度：低于 $0.01 保留四位，小于 $1 保留三位，否则保留两位。

## 考虑过的替代方案

**照搬 oh-my-pi 的零费用行为。** 否决：零价格并不证明 Cursor 或自定义模型免费。

**使用当前 catalog 重新计算历史会话。** 否决：价格变化会改写旧会话的含义。每次调用的估算会随 usage 样本一起记录。

**等待 Cursor 报告完整输入计费。** 否决：当前 AgentService stream 暴露输出 token 增量与检查点占用，因此面向用户的估算记录近似输入依据，同时保留该限制。

## 后果

已知 catalog 和已配置模型会显示有用的会话估算。Cursor 估算会明确标记为近似；未记录在快照中的新模型 id 在补充价格前仍显示不可用。订阅权益消耗无法从接口观察，因此显示值绝不表示发票或账户实际扣费。

新增 usage 字段不会改变 `SESSION_FORMAT_VERSION`；projection checkpoint 只提升自身的 `tokenUsage` state version。headless stderr 行不会改变读取 stdout 的脚本。

## 测试

专门的单元测试覆盖共享费用计算、token-meter 样本替换与 checkpoint、提供方映射、Cursor 价格别名与附加费、Cursor token 增量、Web 格式与文案，以及 headless stdout/stderr 分离。官方 Cursor 价格 URL 与快照日期保存在此处，运行时不请求该页面。
