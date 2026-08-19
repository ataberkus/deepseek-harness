# Agent Note: Web 统计行的会话美元花费

Status: implemented

[English](2026-08-19-session-spend-on-stats-line.md) | 中文

## 问题

Web composer 统计行已经报告持久化 token bucket，却没有展示 pi-ai 为按目录价格计算的调用提供的美元花费。用当前选中模型的价格重新计算累计 token 会在会话切换模型，或混合缓存读取、缓存写入与未缓存价格时产生错误结果。

## 决策

实时 pi-ai 流会把正的 `usage.cost.total` 映射为可选的 `TokenUsage.costUsd`；零价格和未知价格的适配器省略该字段，回放重建仍保留原生的零花费 usage。`dsh-token-meter` 在现有 `tokenUsage` 投影中携带 `costUsd`，同一 `(turn, step)` 的最终样本会替换先前样本，并在不同步骤之间求和。持久投影仍由[持久 token 用量与请求上下文](../architecture/2026-07-29-projected-token-usage-and-request-context.md)说明的所有权规则负责；表层启发式不会重新给这笔精确花费定价。状态版本为 `2`，旧检查点行会被丢弃，以便从持久日志重新折算新增 bucket。

独立浏览器 fixture 以 `usage.costUsd ?? 0` 镜像该投影。`StatsLine` 将正的会话花费格式化为本地化分组，放在缓存命中率之后、输入／输出 token 分组之前。花费为零或未知时隐藏该分组，因此无花费日志保持原有输出，绝不显示 `$0.00`。

## 考虑过的替代方案

- **用当前模型目录价格乘以当前 `tokenUsage` 总量：** 否决，因为模型切换会使一个会话包含多个模型，而缓存读取、缓存写入和未缓存输入使用不同价格。
- **只在客户端估算花费，不添加持久字段：** 否决，因为分页和压缩已经要求 `tokenUsage` 提供会话范围的记账；客户端估算无法跨越这些投影边界保持有效。
- **在 `llm-deepseek` 中硬编码 DeepSeek 价格：** 否决，因为该适配器没有目录价格来源；在适配器报告 `costUsd` 之前，它会省略花费。
- **添加单独的投影键：** 否决，因为花费属于现有持久 token 用量记账，不需要另一套投影生命周期。
- **为回放重建的消息计算价格：** 否决，因为回放恢复的是历史提供方元数据，不代表新的计费尝试；实时持久化 usage 才拥有已计花费。

## 后果

按目录价格计算的 pi-ai 会话会在模型切换、分页、压缩、重新连接以及持久日志回放后保留逐调用记账。没有价格的适配器（包括 `llm-deepseek`、Cursor 和 Gemini CLI 路由）贡献零花费，在报告正的 `costUsd` 之前不会改变界面。

现有会话格式保持兼容，因为逐调用 usage 上的 `costUsd` 是可选字段。token 用量检查点 schema 使用版本 `2`，旧检查点行会重新折算；浏览器 fixture 具有同样的必需投影字段，但不添加正花费 fixture 数据。现有 fixture 不携带正花费，因此 Web snapshot 集合保持不变。
