# Cursor 运行时健康实现计划

[English](2026-08-19-cursor-runtime-health.md) | 中文

> **致代理工作者：** 必须使用 subagent-driven-development（推荐）或 executing-plans 子技能，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在 Cursor 成功返回空发现响应后停止宣传未经确认的 fallback 模型，并阻止只有 heartbeat 的完成被转化为可重试的通用 `EMPTY_RESPONSE` 失败。

**架构：** 保留网络失败和缺少访问凭据时现有的已安装 fallback 路径，但让成功为空的 `GetUsableModels` 响应抛出类型化 Cursor 目录错误。通过模型目录 wire 结果保留该 code，只清除被拒绝的逐 snapshot 列举 promise，使用户重试可以恢复，并将没有内容块的 Cursor 模型归类为不可重试的提供方专属流失败。不包含 Connect/protobuf wire 重写。

**技术栈：** TypeScript、Vitest、Cordis LLM 适配器、protobuf/Connect 夹具、Host API Proxy schema、`LlmError`、Playwright/Web 产物验证。

**规格：** `docs/superpowers/specs/2026-08-19-oauth-host-runtime-health.md`（Cursor 发现和流式处理）

## 全局约束

- 网络失败和缺少访问凭据时保留捆绑的 Cursor fallback；只有成功但为空的 `GetUsableModels` payload 才是类型化的无可用模型失败。
- 使用提供方专属 code：`CURSOR_NO_USABLE_MODELS` 和 `CURSOR_EMPTY_STREAM`；二者都不属于默认可重试 code 列表。
- 在没有单独验证过的上游对照实现之前，不移植社区 Cursor 协议实现，也不改变 framing、headers、字段解析或请求编码。
- 错误、测试、夹具和日志中绝不包含访问令牌、request body 或账户身份。
- 保留有效的 Cursor 文本、思考、工具调用、图像、checkpoint、取消和传输行为。
- 使用 TDD：先编写并运行失败的回归测试，再修改生产实现。
- 与行为变更同一改动更新 package README 对和已实现 Agent Note 对。
- API catalog 失败 code 在 wire 上可选，使现有非 Harness 错误和旧调用方继续有效；类型化 `HarnessError` 暴露其稳定 code。

---

## 文件映射

- 修改：`packages/llm/llm-pi-ai/src/cursor/constants.ts` — 定义两个稳定的 Cursor 健康 code。
- 修改：`packages/llm/llm-pi-ai/src/cursor/models.ts` — 成功的可用模型回复为空时抛错，同时保留传输失败时的 fallback。
- 修改：`packages/llm/llm-pi-ai/src/adapter.ts` — 移除被拒绝的 served-model promise，使显式重试能够重新列举。
- 修改：`packages/llm/llm-pi-ai/src/stream.ts` — 将空的 Cursor 完成与通用的提供方中立空输出分开分类。
- 修改：`packages/host/apiproxy/src/api/sessions.ts` — 给 `ModelCatalogFailure` 增加可选 `code`。
- 修改：`packages/host/apiproxy/src/api/sessions.schema.ts` — 校验可选且非空的失败 code。
- 修改：`packages/host/apiproxy/src/api-proxy.ts` — 构造逐提供方目录失败时保留 `HarnessError.code`。
- 修改：`packages/llm/llm-pi-ai/tests/cursor.spec.ts` — 增加失败列举、重试和只有 heartbeat 的流回归测试。
- 修改：`packages/llm/llm-pi-ai/tests/convert.spec.ts` — 增加提供方专属空 stop 映射并保留通用行为。
- 修改：`packages/host/apiproxy/tests/api-proxy-models.spec.ts` — 增加类型化目录失败传播测试。
- 修改：`packages/host/apiproxy/tests/rpc-schemas.spec.ts` — 增加可选目录失败 code 的 wire 校验。
- 修改：`packages/llm/llm-pi-ai/README.md` 和 `packages/llm/llm-pi-ai/README.zh.md` — 更新当前列举和失败语义。
- 修改：`.agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.md` 及其中文对 — 更新当前 Cursor 列举和测试事实。
- 移动并重写：`.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md` 和 `.zh.md` 到 `.agents/notes/implemented/bug-fix/` — 记录已发布的运行时健康决策。

## 接口

- 消费：`cursorListingInternals.fetch`、`listCursorModels`、`PiAiAdapter.listModels`、`mapStopReason`、`ModelCatalogFailure`、`HarnessError` 和现有 Cursor 流夹具。
- 产出：`CURSOR_NO_USABLE_MODELS_CODE`、`CURSOR_EMPTY_STREAM_CODE`、可选的 `ModelCatalogFailure.code`、可安全重试分类的 finish 分片，以及空响应后可重新列举的 Cursor snapshot。

### 任务 1：增加失败的 Cursor 列举、流和 wire 测试

**文件：**
- 修改：`packages/llm/llm-pi-ai/tests/cursor.spec.ts`
- 修改：`packages/llm/llm-pi-ai/tests/convert.spec.ts`
- 修改：`packages/host/apiproxy/tests/api-proxy-models.spec.ts`
- 修改：`packages/host/apiproxy/tests/rpc-schemas.spec.ts`

**接口：**
- 消费：当前 fallback 行为、`cursorListingInternals`、`streamCursor`、`mapStopReason`、`CatalogAdapter` 和 `sessionModelsValueSchema`。
- 产出：在当前 fallback 和通用 `EMPTY_RESPONSE` 行为下失败的可执行回归测试。

- [ ] **步骤 1：编写失败的模型列举测试**

在 `cursor models` suite 中，将空成功预期改为类型化失败，并保留传输失败预期：

```text
it('rejects a successful empty GetUsableModels response without exposing the fallback', async () => {
  cursorListingInternals.fetch = async () => new Uint8Array()
  await expect(listCursorModels('token')).rejects.toMatchObject({
    code: 'CURSOR_NO_USABLE_MODELS',
    message: expect.stringContaining('GetUsableModels'),
  })
})

it('keeps the fallback when GetUsableModels cannot be reached', async () => {
  cursorListingInternals.fetch = async () => { throw new Error('down') }
  await expect(listCursorModels('token')).resolves.toEqual(expect.arrayContaining(
    cursorFallbackModels(),
  ))
})
```

增加一个适配器级测试，使用一个 `PiAiAdapter` snapshot：第一次 `cursorListingInternals.fetch` 返回空 payload 并使 `adapter.listModels('cursor')` 拒绝；第二次调用返回含有 `live-only` 的 payload 并解析出该 id。该测试证明被拒绝的 `servedModels` promise 不会作为永久的 snapshot 失败被保留。

- [ ] **步骤 2：编写失败的只有 heartbeat 的流测试**

在 `cursor.spec.ts` 中，将只收集事件类型的测试 helper 替换为会保留事件的本地 helper，并为一个新案例保留事件。输入一个 field-13 heartbeat update，随后输入 EOF 或 field-14 turn end，然后断言 pi-ai 事件仍是没有内容的 `done` 事件。将该流通过 `toStreamChunks` 转换，断言最终 finish code 是 `CURSOR_EMPTY_STREAM`，且消息指出这是只有 heartbeat 的 Cursor 响应。

在 `convert.spec.ts` 中，紧邻现有通用断言增加提供方专属的直接映射：

```text
it('classifies an empty Cursor stop as a non-retryable Cursor backend failure', () => {
  expect(mapStopReason(assistant({ provider: 'cursor', stopReason: 'stop' }))).toEqual({
    kind: 'error',
    failure: {
      code: 'CURSOR_EMPTY_STREAM',
      message: expect.stringContaining('heartbeat-only'),
    },
  })
})
```

保留现有期望 `EMPTY_RESPONSE` 的 DeepSeek 断言；提供方专属例外不得改变通用适配器。

- [ ] **步骤 3：编写类型化目录失败测试**

在 `api-proxy-models.spec.ts` 中，注册一个小型 `CatalogAdapter`，其 `listModels()` 以 `new LlmError('Cursor GetUsableModels returned no usable models', 'CURSOR_NO_USABLE_MODELS')` 拒绝，调用 `sessions.models`，并断言失败同时包含 `{ code: 'CURSOR_NO_USABLE_MODELS' }`、id、name 和 message。保留普通 `Error('catalog offline')` 预期不带 code。

在 `rpc-schemas.spec.ts` 中，给一个已解析的 `sessionModelsValueSchema` 失败项增加 `code: 'CURSOR_NO_USABLE_MODELS'`，并断言解析结果保留它。现有失败夹具中的 code 必须继续可选。

- [ ] **步骤 4：运行聚焦测试并确认它们因预期原因失败**

运行：`pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

预期：失败应显示当前空列举返回 fallback、空 Cursor stop 返回 `EMPTY_RESPONSE`、被拒绝的列举被缓存或缺少新 code，以及 wire 类型未保留 `code`。不要为了迁就无关失败而改变断言。

### 任务 2：实现类型化 Cursor 发现和流分类

**文件：**
- 修改：`packages/llm/llm-pi-ai/src/cursor/constants.ts`
- 修改：`packages/llm/llm-pi-ai/src/cursor/models.ts`
- 修改：`packages/llm/llm-pi-ai/src/adapter.ts`
- 修改：`packages/llm/llm-pi-ai/src/stream.ts`

**接口：**
- 消费：任务 1 的失败测试和现有 `LlmError`、`CURSOR_PROVIDER`、`AssistantMessage` 与 served-model snapshot 类型。
- 产出：稳定 code 及任务 3 可以通过 Host 目录 wire 暴露的行为。

- [ ] **步骤 1：定义提供方自有的健康 code**

在 `cursor/constants.ts` 中增加以下有文档的常量：

```text
/** Successful GetUsableModels response contained no usable model rows. */
export const CURSOR_NO_USABLE_MODELS_CODE = 'CURSOR_NO_USABLE_MODELS'

/** Cursor Run closed after heartbeat updates without text, thinking, or tools. */
export const CURSOR_EMPTY_STREAM_CODE = 'CURSOR_EMPTY_STREAM'
```

不要将任一 code 加入 `packages/llm/llm/src/retry-policy.ts`；默认可重试列表继续只包含 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT` 和 `TRANSPORT`。

- [ ] **步骤 2：让成功的空 Cursor 发现失败，同时不吞掉传输 fallback**

在 `listCursorModels` 中，将 fallback 构造和 fetch 保持在仅针对传输的 `try/catch` 内。在 catch 之后解码成功 payload；如果 `live.length === 0`，抛出：

```text
throw new LlmError(
  'Cursor GetUsableModels returned no usable models; check the Cursor service and retry model discovery',
  CURSOR_NO_USABLE_MODELS_CODE,
)
```

对非空 live 回复返回 `withFastVariants(mergeCursorCatalogs(live, fallback))`，仅在 fetch/connect 失败时保留 `withFastVariants(fallback)`。消息不得包含 token 或 payload。

- [ ] **步骤 3：允许被拒绝列举后的显式重试**

在 `PiAiAdapter.servedModels` 中，在 `try/catch` 内等待缓存的 promise。promise 拒绝时，仅当缓存仍指向同一个 promise 才删除缓存项，然后重新抛出原始错误。成功列举继续针对不可变 snapshot 缓存；失败的空发现可以重试，而无需重建凭据或路由。

更新 `adapter.ts` 和 `models.ts` 相邻的 JSDoc，使其说明传输失败会 fallback，而成功为空的回复会失败。

- [ ] **步骤 4：将空 Cursor stop 映射为不可重试的提供方 code**

将 `CURSOR_EMPTY_STREAM_CODE` 导入 `stream.ts`。在 `mapStopReason` 中保留上下文溢出检查优先，然后在 `stop` 分支检测 `message.content.length === 0 && message.provider === CURSOR_PROVIDER`。返回：

```text
{
  kind: 'error',
  failure: {
    message: `Cursor backend returned a heartbeat-only response with no content for model "${message.model}"; retry after the Cursor service recovers`,
    code: CURSOR_EMPTY_STREAM_CODE,
  },
}
```

非 Cursor 空 stop 继续走既有 `EMPTY_RESPONSE` 路径，包含文本、思考或工具调用的 Cursor 响应继续成功。该 code 不在默认重试列表中，因此现有重试插件不会重复这一已知后端结果。

- [ ] **步骤 5：运行聚焦 LLM 测试**

运行：`pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts --reporter=dot`

预期：新的发现、重试、只有 heartbeat 和通用空响应测试通过，同时所有现有 Cursor wire、图像和 checkpoint 测试保持通过。

### 任务 3：在 Host wire 保留类型化目录失败 code

**文件：**
- 修改：`packages/host/apiproxy/src/api/sessions.ts:141-149`
- 修改：`packages/host/apiproxy/src/api/sessions.schema.ts:183-188`
- 修改：`packages/host/apiproxy/src/api-proxy.ts:9-18,333-339`
- 修改：`packages/host/apiproxy/tests/api-proxy-models.spec.ts`
- 修改：`packages/host/apiproxy/tests/rpc-schemas.spec.ts`

**接口：**
- 消费：`@deepseek-ai/dsh-llm` 的 `HarnessError.code` 和任务 2 的 `CURSOR_NO_USABLE_MODELS_CODE`。
- 产出：`llm.models` 和 `session.models` 上的 `ModelCatalogFailure.code?: string`，以及保持不变的旧普通错误响应。

- [ ] **步骤 1：增加可选类型和 schema 字段**

将以下内容加入 `ModelCatalogFailure`：

```text
/** Stable Harness error code when the provider raised a HarnessError. */
code?: string
```

给 `modelCatalogFailureSchema` 增加 `code: z.string().min(1).optional()`。不要将它设为必填；普通提供方异常继续只序列化 id、name 和 message。

- [ ] **步骤 2：在 `buildModelCatalog` 中只保留稳定 Harness code**

将运行时 `HarnessError` 值与现有 LLM 导入一起导入。按以下方式构造失败：

```text
const failure: ModelCatalogFailure = {
  id: provider.id,
  name: provider.name,
  message: error instanceof Error ? error.message : String(error),
  ...(error instanceof HarnessError ? { code: error.code } : {}),
}
```

不要 stringify cause 或附加提供方请求数据。现有提供方名称和消息仍是面向用户的诊断。

- [ ] **步骤 3：运行 Host API 测试**

运行：`pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

预期：类型化 Cursor 失败携带 `code`，普通错误不携带，现有目录分组和 schema 拒绝测试全部通过。

- [ ] **步骤 4：运行组合提供方/Host 回归集**

运行：`pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/oauth-login.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts --reporter=dot`

预期：所有聚焦 OAuth、Cursor、转换、目录和 wire schema 测试通过。

- [ ] **步骤 5：提交生产行为**

```sh
git add packages/llm/llm-pi-ai/src/cursor/constants.ts packages/llm/llm-pi-ai/src/cursor/models.ts packages/llm/llm-pi-ai/src/adapter.ts packages/llm/llm-pi-ai/src/stream.ts packages/host/apiproxy/src/api/sessions.ts packages/host/apiproxy/src/api/sessions.schema.ts packages/host/apiproxy/src/api-proxy.ts packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts
git commit -m "fix: classify empty Cursor backend responses"
```

### 任务 4：更新 package 文档和已发布 Agent Note

**文件：**
- 修改：`packages/llm/llm-pi-ai/README.md`
- 修改：`packages/llm/llm-pi-ai/README.zh.md`
- 修改：`.agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.md`
- 修改：`.agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.zh.md`
- 移动并重写：`.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md` 和 `.zh.md` 到 `.agents/notes/implemented/bug-fix/`

**接口：**
- 消费：任务 2 和 3 发布的 code 与 API 字段。
- 产出：当前 package 约定、当前 Cursor OAuth 笔记，以及不含 proposal 时代标题的已实现运行时健康笔记。

- [ ] **步骤 1：更新 package README 对**

在 Catalog resolution 和 Vocabulary 部分说明：Cursor 网络/列举传输失败保留 fallback，而成功但为空的 `GetUsableModels` 响应产生 `CURSOR_NO_USABLE_MODELS` 和逐提供方目录失败。说明 Cursor 空 stop 产生 `CURSOR_EMPTY_STREAM`，不属于默认可重试 code；非 Cursor 的通用空 stop 继续使用 `EMPTY_RESPONSE`。在 `README.zh.md` 中进行相同的事实更新，不要重新翻译无关内容。

- [ ] **步骤 2：原地更新活动的 Cursor OAuth 笔记**

将 Decision 部分的当前 fallback 句子替换为任务 2 发布的分支行为。在 Testing 或 Consequences 部分增加两个稳定错误 code 和重试后果。保持登录、凭据、图像处理和协议所有权事实不变。按相同结构更新中文对。

- [ ] **步骤 3：将运行时健康 proposal 移为 implemented**

将两个 proposed 文件移动到 `.agents/notes/implemented/bug-fix/`，把 `Status: proposed` 改为 `Status: implemented`，将 `## Proposal` 重写为现在时的 `## Decision`，把 `## Acceptance criteria` 合并到 `## Testing`，把 `## Risks` 合并到 `## Consequences`。记录本计划中的实际代码路径和测试。保留指向 Cursor 和 Gemini 托管笔记的交叉链接；不要归档任一托管笔记，因为每个笔记仍拥有未被取代的登录/目录决策。

- [ ] **步骤 4：运行文档检查**

运行：`pnpm run verify-agent-note-format && pnpm run verify-md-wrap && pnpm run verify-md-links && pnpm run doc-sync`

预期：笔记生命周期、英中配对、Markdown 换行/链接、package README 约定和文档同步检查通过。

- [ ] **步骤 5：提交文档**

```sh
git add packages/llm/llm-pi-ai/README.md packages/llm/llm-pi-ai/README.zh.md .agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.md .agents/notes/implemented/feature/2026-08-18-cursor-oauth-host.zh.md .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md
git commit -m "docs: document Cursor runtime health codes"
```

### 任务 5：构建并验证已发布的 Web 运行时

**文件：**
- 不增加源文件；验证受影响的 package 和组装后的 Web 产物。

**接口：**
- 消费：任务 1–4 的生产和文档提交。
- 产出：已验证的构建产物，以及模型目录失败处理和未改变的模型选择器行为的 GUI 证据。

- [ ] **步骤 1：从已提交状态再次运行聚焦 package 和 Host 检查**

运行：`pnpm exec vitest run packages/llm/llm-pi-ai/tests/cursor.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/oauth-login.spec.ts packages/host/apiproxy/tests/api-proxy-models.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts --reporter=dot`

预期：所有聚焦测试通过，不依赖未提交的测试输出。

- [ ] **步骤 2：构建源代码和 Web 产物**

运行：`pnpm run build`

预期：TypeScript、package bundle 和 `apps/web/dist` 产物成功构建。不要启动替代 Web server。

- [ ] **步骤 3：运行组装后的无密钥 Web lane**

运行：`DSH_SNAPSHOT=replay pnpm run test:web:built`

预期：现有 Web e2e 场景根据仓库 replay 策略通过或自行跳过；此改动不发起新的模型调用。

- [ ] **步骤 4：刷新现有 GUI 并验证实际 URL**

构建后刷新 `http://127.0.0.1:3080`。验证 Settings → Models 仍显示活动凭据存储中的已连接 Cursor 状态，同时 Cursor 空发现由逐提供方失败表示，而不是 fallback 模型组。验证模型选择器仍渲染有效的 seeded group，并且没有页面错误。

- [ ] **步骤 5：运行最终差异和验证检查**

运行：`git -c safe.directory=C:/Windows/System32/deepseek-harness diff --check; git -c safe.directory=C:/Windows/System32/deepseek-harness status --short`

预期：没有空白错误，只有预期路径变更，并且无关的预先存在的未跟踪文件保持不变。

## 计划自检

- **规格覆盖：** 成功为空的发现、传输 fallback、被拒绝列举后的重试、提供方专属 heartbeat-only 失败、默认不可重试行为、类型化目录失败传播、有效 Cursor 流保留、文档、构建和 GUI 验证都有明确任务。
- **占位符扫描：** 每个任务都列出确切文件、符号、断言、命令和提交边界；没有 TBD/TODO 实现占位符。
- **类型一致性：** 两个常量在 `cursor/constants.ts` 中定义，由 `models.ts` 和 `stream.ts` 使用；`ModelCatalogFailure.code` 在 Host 类型和 schema 中可选；`HarnessError.code` 只在 `buildModelCatalog` 中复制。
