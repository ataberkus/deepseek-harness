# Web 统计行的会话美元花费

Status: draft for review

[English](2026-08-19-session-spend-on-stats-line.md) | 中文

## 范围

本规范覆盖按目录价格计算的 USD 花费从实时 pi-ai 模型调用经过持久化 `TokenUsage`、`tokenUsage` 会话投影和独立浏览器 fixture，最终到达 Web 对话 composer 统计行的路径。

本变更保持提供方所有权不变：pi-ai 报告按价格计算的总额，`dsh-llm-pi-ai` 负责映射，`dsh-token-meter` 负责持久化与折算，`ui-conversation` 负责呈现会话总额。

## 目标

- 将正的逐调用 pi-ai 目录花费保存为可选的 `TokenUsage.costUsd`，不修改 `SESSION_FORMAT_VERSION`。
- 使用与 token bucket 相同的最新样本替换规则，在完整持久会话日志中汇总花费。
- 在现有输入／输出 token 分组之前紧邻显示本地化的 `Cost {cost}`／`花费 {cost}`。
- 一美分以下或带有小数分精度的值保留四位小数，整分值保留两位小数，并省略零、未知和未定价花费。
- 保持回放重建的 pi-ai 消息为零花费；已计花费属于实时持久化 usage 事件。
- 同步更新源 JSDoc、子系统和包文档、所需的 implemented Agent Note，以及所有编辑过的双语文件。

## 数据流与所有权

`TokenUsage` 增加可选的 `costUsd?: number`，JSDoc 说明它是单次调用由适配器报告的 USD，由 pi-ai 目录价格复制而来；没有价格或总额为零时省略。

`mapUsage()` 仅在 `usage.cost.total` 大于零时复制该值，与现有零 cache bucket 的省略方式一致。pi-ai catalog 注释说明零价格会省略花费，而 `replay.ts` 继续构造零花费的重建消息。

`TokenUsageProjection` 增加必需的 `costUsd: number`。`tokenUsageProjectionDefinition` 用同一浮点 bucket 初始化、校验、比较、替换和求和。检查点 `stateVersion` 变为 `2`，旧版本会丢弃并从持久日志重新折算。浏览器 fixture 镜像相同折算和输出字段。

`StatsLine` 导出 `formatCost(usd)`；金额低于一美分或带有小数分精度时保留四位小数（包括 `$0.0123`），整分金额保留两位小数（包括 `$1.20`），并且只有当 `usage.costUsd > 0` 时才在缓存命中率之后、token 分组之前添加本地化花费分组。缺失或为零时现有 token-only 输出保持不变。

## 兼容性与非目标

usage 字段是增量兼容的，不需要修改会话格式版本。没有价格的现有日志和适配器重新折算为 `costUsd: 0`；界面隐藏该分组，绝不渲染 `$0.00`。

本实现不会用当前选中模型的价格乘以累计 token，不会在 `llm-deepseek` 中计算美元，不会添加 projection key，不会为 TUI 或 subagent surface 添加花费 chrome，不会添加依赖，也不会刷新不带正 `costUsd` 的 Web snapshot。

Cursor 和 Gemini CLI catalog 模型保持 `NO_COST`，`llm-deepseek` 在适配器报告 `costUsd` 前保持未定价。混合模型会话与不同缓存价格通过汇总每次调用持久化的花费处理，而不是重新给总量定价。

## 验证

增加正、零 pi-ai 总额的适配器映射测试。为 token-meter 期望值加入 `costUsd: 0`，并增加覆盖不同步骤求和及同一步骤替换的测试。更新 fixture 空日志期望，并增加 StatsLine 格式和本地化顺序测试。

运行 `pnpm exec vitest run packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/token-meter/tests/token-usage-projection.spec.ts packages/client/ui-conversation/tests/chat-stats.client.spec.tsx packages/client/connection/tests/fixture.client.spec.ts`，如果聚焦测试没有编译这些包，再对受影响的包执行 typecheck。

对每个编辑过的双语文件运行 `pnpm run verify-translation-pairing --write`，包括新的 Agent Note 和需要在 `tokenUsage` 句子中提及 `costUsd` 的 architecture note。运行相关文档与 diff 检查；除非 fixture 有意加入可计费花费，否则不刷新 snapshot。

## 考虑过的替代方案

- **用当前模型目录价格乘以当前累计 token 总量：** 否决，因为会话可以切换模型，缓存读取和未缓存 bucket 也使用不同价格。
- **只在客户端估算花费而不保存持久字段：** 否决，因为分页和压缩已经要求会话范围的 `tokenUsage` 投影，客户端估算无法可靠跨越这些边界。
- **在 `llm-deepseek` 中硬编码 DeepSeek 价格：** 否决，因为该适配器没有 catalog 价格来源；在适配器报告自有 `costUsd` 前保持省略。
- **添加单独的 projection key：** 否决，因为花费属于现有持久 token 用量记账，不需要另一套投影生命周期。
- **为回放消息定价：** 否决，因为回放元数据是重建历史，不是实时计费尝试；持久 usage 携带已计花费。

## 后果

只要服务适配器为每次调用报告目录价格，统计行报告的会话花费就能跨越分页、压缩、重新连接和模型切换保持稳定。只有未定价或零花费调用的会话继续显示原有 token-only 外观。

投影 schema 现在携带浮点 USD 值并使用状态版本 `2`。旧检查点状态会有意重新折算，而不变的会话格式保留增量 usage 兼容性。浏览器 fixture 与宿主投影保持一致，不引入客户端专用估算。

当存在正花费时，界面增加一个本地化分组和少量宽度；其顺序让花费紧邻它概括的 token 记账，并保留所有无花费 fixture 的现有 keyless snapshot 输出。
