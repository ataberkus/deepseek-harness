# Gemini OAuth 组合实现计划

[English](2026-08-19-gemini-oauth-composition.md) | 中文

> **致代理工作者：** 必须使用 subagent-driven-development（推荐）或 executing-plans 子技能，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 证明完整的 Gemini CLI OAuth 登录会到达真实 Web Host，并刷新已经加载的模型目录，同时不改变已经通过测试的 Gemini 目录实现。

**架构：** 扩展现有真实 Web scaffold 测试 lane，而不是增加第二个 Host 或仅供测试使用的产品组合。测试配置一个确定性的非 OAuth seed 路由，打开真实浏览器模型选择器，通过模拟 Google/Cloud Code Assist HTTP 和回环回调边缘完成 Gemini OAuth，并在转发拓扑事件后同时断言 Host 目录和实时选择器。另一个 Client 浏览器插件单元测试单独固定规则：失效通知不能加载从未打开过的惰性目录。

**技术栈：** TypeScript、Vitest、Playwright、Cordis Loader 组合、现有 `launchWebScaffold`、Node 22 `fetch` 和回环 HTTP 回调、托管的 `@deepseek-ai/dsh-llm-pi-ai` OAuth。

**规格：** `docs/superpowers/specs/2026-08-19-oauth-host-runtime-health.md`（Gemini 组合检查）

## 全局约束

- 除非回归测试暴露缺陷，否则不修改 Gemini 提供方目录或 Cloud Code Assist wire。
- 只模拟 Google OAuth、Cloud Code Assist 项目发现和打开浏览器的边缘；绝不调用真实 Google endpoint 或存储真实 token。
- 测试保持无密钥且不调用模型；任何多余模型请求都必须通过 scaffold 的无适配器保护机制大声失败。
- 断言真实 Host HTTP/WebSocket 组合和用户可见的模型选择器状态，而不只是手工构造的 `Context`。
- OAuth access 和 refresh 值不得出现在日志、截图、夹具或断言消息中。
- 保留现有命令式 OAuth 展示；不要增加 Models 页面登录控件。
- 在同一实现改动中增加或更新非平凡 Agent Note。
- 使用 TDD：在修改生产行为之前编写并运行失败的回归测试。

---

## 文件映射

- 创建：`apps/web/tests/oauth-model-directory.e2e.ts` — Gemini 登录、Host 目录可见性、转发拓扑失效和选择器刷新真实组合浏览器回归。
- 修改：`packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` — 针对未打开 session 目录的惰性失效回归。
- 仅复查：`packages/llm/llm-pi-ai/tests/oauth-login.spec.ts` — 保留命令持久化和路由注册现有单元覆盖；不要在浏览器测试中重复。
- 实现后修改：`.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md` — 移入已实现生命周期并记录已发布测试路径，然后同时更新英中对。

## 接口

- 消费：`launchWebScaffold`、`WebScaffold.ctx`、`connectFreshWorkspaceZh`、`settingsNamespace`、`SessionId`、`ctx.agents.create` 和现有的远程 `llm/adapters-updated` 转发。
- 产出：可执行的 `apps/web/tests/oauth-model-directory.e2e.ts`，证明模拟的 `/login google-gemini-cli` 完成后已打开的选择器出现 `Gemini 2.5 Flash`，以及浏览器插件断言未打开目录在失效时产生零次 `session.models` 调用。

### 任务 1：增加惰性目录失败回归

**文件：**
- 修改：`packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts:139-323`

**接口：**
- 消费：现有 `bench()` 返回值中的 `calls.models` 和 `ctx.remote.$dispatch`。
- 产出：当 `llm/adapters-updated` 发生时，如果实现 eager 创建或加载目录，测试将失败。

- [ ] **步骤 1：编写失败测试**

在 `ui-model-selection dual entry` suite 中增加此测试：

```text
it('does not load an unopened directory when the Host topology changes', async () => {
  const b = await bench()
  b.ctx.remote.$dispatch('llm/adapters-updated', [])
  await Promise.resolve()
  await Promise.resolve()
  expect(b.calls.models).toBe(0)
})
```

- [ ] **步骤 2：运行聚焦测试，确认回归可执行**

运行：`pnpm exec vitest run packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts -t "does not load an unopened directory"`

预期：新测试在当前惰性实现上通过。如果失败，在继续前停止并诊断 Client service；不要削弱断言。

- [ ] **步骤 3：除非测试暴露 eager-load 缺陷，否则保持生产 Client 代码不变**

现有 `ModelDirectoryResolver` 刷新循环只遍历 `live.directories`。测试通过时不要重构它，也不要增加第二个惰性标志。

- [ ] **步骤 4：运行完整的 package 浏览器插件文件**

运行：`pnpm exec vitest run packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts`

预期：所有现有共享目录、重连、路由和 disposal 测试通过。

- [ ] **步骤 5：提交隔离的测试交付物**

```sh
git add packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts
git commit -m "test: pin lazy model-directory invalidation"
```

### 任务 2：增加真实 Web Gemini OAuth 组合回归

**文件：**
- 创建：`apps/web/tests/oauth-model-directory.e2e.ts`
- 复查：`apps/web/tests/scaffold.ts:166-184` 和 `apps/web/tests/support.ts:57-110`

**接口：**
- 消费：`launchWebScaffold` 提供的已构建 Web 产物、Host `commands` 和 `apiProxy` 面，以及浏览器模型选择器。
- 产出：无密钥、不调用模型的 Web e2e，跨越 OAuth 持久化、路由注册、Host 目录组装、远程事件转发和 Client 选择器刷新。

- [ ] **步骤 1：编写失败的浏览器回归**

创建一个 serial `describe` 块，并执行以下设置操作：

```text
const SEED_PROVIDER = 'oauth-e2e-seed'
const SEED_MODEL = 'oauth-e2e-model'

beforeAll(async () => {
  scaffold = await launchWebScaffold({})
  await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
    providers: {
      [SEED_PROVIDER]: {
        displayName: 'OAuth E2E Seed',
        api: 'openai-completions',
        baseURL: 'https://oauth-e2e.invalid/v1',
        models: [{ id: SEED_MODEL, name: 'OAuth E2E Seed Model' }],
      },
    },
  })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  tripwire = watchConsole(page)
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
})
```

测试必须在调用登录命令前安装临时的 `globalThis.fetch` wrapper。它将所有无关 URL 委托给原始 fetch，只对 `https://oauth2.googleapis.com/token` 和 `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` 返回确定性 JSON。token 响应使用固定的测试字符串，load 响应返回 companion project id。监听 `commands/open-url`，解析发出的 authorize URL，并使用发出的 `state`、固定授权 code 请求其 `redirect_uri`，使真实回环回调 server 完成。即使命令失败，也要在 `afterAll` 恢复原始 fetch。

使用 `scaffold.ctx.agents.create({ sessionId: SessionId('oauth-model-directory'), meta: { cwd: scaffold.workspaceCwd } })` 创建真实 Agent；通过 `scaffold.ctx.commands.execute` 执行 `/login google-gemini-cli`，并使用有界 signal。移除 secret 前不要记录命令结果。

测试主体必须先打开真实模型选择器并等待 `OAuth E2E Seed Model`，证明登录前目录已加载。命令返回现有的精确成功文本后，断言 Host `scaffold.ctx.apiProxy.llm.models(...)` 或 session model 响应包含 `google-gemini-cli` 提供方和 `gemini-2.5-flash`。保持选择器打开并断言浏览器现在包含 `Gemini 2.5 Flash`；这证明转发的 `llm/adapters-updated` 到达现有目录，而不是依赖页面重新加载。断言 `tripwire.pageErrors` 为空，并且页面内容不包含测试 access 或 refresh 值。

使用 `onTestFailed` 和不含 secret 的文件名调用 `saveFailureShot`。在 `afterAll` 中按 Agent、browser、scaffold 的顺序释放创建的 Agent、浏览器和 scaffold。

- [ ] **步骤 2：运行新的浏览器测试，确认组合事件路径损坏时实现在修改前失败**

运行：`pnpm run build && pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/oauth-model-directory.e2e.ts`

预期：测试可能在现有实现上直接通过，证明不需要 Gemini 生产修复；也可能在精确的组合断言处失败。detached browser opener 或端口冲突导致的失败属于测试 harness 设置失败，必须在模拟边缘修复，不能删除登录或 reload 断言。

- [ ] **步骤 3：只实现测试暴露出的 harness 修正**

如果登录命令完成但选择器没有更新，检查 Host `llm/adapters-updated` 转发和 Client `ModelDirectoryResolver` 订阅。不要在测试中增加第二个刷新调用。如果 Host group 缺失，检查 scaffold 的构建 package 修订和 OAuth credential home，再决定是否修改提供方代码。

- [ ] **步骤 4：运行聚焦浏览器和 Host OAuth suite**

运行：`pnpm exec vitest run packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts packages/llm/llm-pi-ai/tests/oauth-login.spec.ts`

预期：现有 OAuth 命令持久化和 Client 目录行为继续通过。

- [ ] **步骤 5：提交真实组合回归**

```sh
git add apps/web/tests/oauth-model-directory.e2e.ts
git commit -m "test: cover Gemini OAuth model-directory refresh"
```

### 任务 3：测试验证后更新已实现 Agent Note

**文件：**
- 修改：`.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md`
- 修改：`.agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md`
- 仅在已发布测试改变事实测试陈述时修改：`.agents/notes/implemented/feature/2026-08-19-google-gemini-cli-oauth-host.md`

**接口：**
- 消费：任务 1 和 2 的已提交测试路径及观察到的组合行为。
- 产出：使用现在时测试事实且没有过时 proposal 标题的已实现 Agent Note 对。

- [ ] **步骤 1：将 proposed 笔记移入 `implemented/bug-fix/` 并重写其生命周期部分**

将 `Status: proposed` 改为 `Status: implemented`，将 `## Proposal` 重写为现在时的 `## Decision`，将 `## Acceptance criteria` 合并到现在时的 `## Testing`，并将 `## Risks` 合并到 `## Consequences`。保留指向 Cursor 和 Gemini OAuth 托管笔记的链接。保持中文对的结构一致。

- [ ] **步骤 2：记录确切测试覆盖并保留 Gemini 笔记的所有权**

在已实现笔记中写出 `apps/web/tests/oauth-model-directory.e2e.ts` 和 `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts`。不要重复 Gemini OAuth 协议决策；改为链接现有 Gemini 托管笔记。

- [ ] **步骤 3：运行文档检查**

运行：`pnpm run verify-agent-note-format && pnpm run verify-md-wrap && pnpm run verify-md-links`

预期：所有 Agent Note 和 Markdown 链接通过。

- [ ] **步骤 4：提交文档生命周期更新**

```sh
git add .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/proposed/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.md .agents/notes/implemented/bug-fix/2026-08-19-oauth-host-runtime-health.zh.md
git commit -m "docs: record OAuth composition coverage"
```

## 计划自检

- **规格覆盖：** Gemini 路由注入、Host `llm.models`、转发的 `llm/adapters-updated`、已加载选择器刷新和未打开目录的惰性行为由任务 1 和 2 覆盖。不修改 Gemini 目录或协议代码，因为现有提供方和 OAuth 单元测试已经固定这些行为。
- **占位符扫描：** 每一步都列出文件、断言、命令或确切生命周期重写；没有 TODO/TBD 实现占位符。
- **类型一致性：** `launchWebScaffold` 返回 `WebScaffold.ctx`；现有 scaffold 和 support helper 提供测试使用的精确浏览器/Host 面；测试专用 seed provider 是一个带显式 model 的 OpenAI 兼容手工声明路由。
