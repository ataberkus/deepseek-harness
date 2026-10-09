---
description: "面向部署与维护者的 settings 驱动 MCP 服务器舰队管理器，无需编辑 cordis.yml 即可配置 MCP 服务器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

## 概述

`dsh-mcp-manager` 为 `mcp` 设置分节中每个启用的条目挂载一个 `@deepseek-ai/dsh-mcp-client` 子实例，运维人员可以直接在 `settings.yaml` 或插件设置卡片中配置 MCP 服务器，而无需编辑 `cordis.yml`。管理器自身默认不挂载任何服务器；设置字典的键就是服务器名称，并把该服务器的工具命名为 `mcp__<serverName>__<tool>`。需要固定部署的服务器仍可直接使用 `dsh-mcp-client` 配置行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 MCP 服务器需要在运行时由用户配置时，添加 `dsh-mcp-manager`。每个服务器只需一个设置条目：取一个服务器名称、选择一种传输方式，它的工具就会以 `mcp__<serverName>__<tool>` 形式出现。

### 最小配置

挂载一次管理器（`dsh-base` bundle 已挂载），然后在 `mcp:` 设置分节中描述服务器：

```yaml
# settings.yaml
mcp:
  servers:
    github:
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: ghp_example
    web:
      transport: streamable-http
      url: http://localhost:3000/mcp
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `servers` | `{}` | 以服务器名称为键的舰队；键同时是工具命名空间，必须匹配 `[A-Za-z0-9_-]{1,32}` |
| `servers.<name>.enabled` | `true` | `false` 表示保留配置但不挂载 |
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio：可执行文件、参数、合并到清洗后环境之上的额外环境变量、工作目录 |
| `url` / `headers` | — | streamable-http：端点 URL 与额外请求标头 |
| `toolCallTimeoutMs` | `60,000` | 每次 `tools/call` 调用的超时 |
| `failOnStartupError` | `false` | 初始连接或工具同步失败时拒绝子实例激活 |
| `reconnect.*` | `true` / `500` / `30,000` / `10` | 连接丢失后的自动重连策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager)是每个受支持字段的穷尽式真源。

`env` 与 `headers` 以明文保存在设置文档中，并对配置界面可见。不要在这里存放生产密钥；携带密钥的服务器请放进带 `!!js process.env.*` 的固定部署 `dsh-mcp-client` 配置行。

禁用是移除部署基座服务器的途径：设置合并无法删除组合中的键，因此请设置 `enabled: false`，而不是删除该条目。`replace({})` 会重新继承组合条目。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释舰队背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **字典键就是身份。** 设置键直接提供 `serverName`，因此一个名称天然只有一个条目，条目不可能与自己的键持有不同的名字。
- **写入时校验，提交后同步。** 非法服务器名称在 `validate` 处拒绝设置写入；字段错误由 schema 拒绝。同步只挂载通过 schema 校验的条目，因此被拒绝的条目会让上一代继续服务。
- **每个启用的条目对应一个子实例。** 禁用的条目不挂载任何内容。移除与禁用先释放旧子实例；新增与变更条目先经客户端 schema 校验，再替换旧子实例。
- **突发变更串行化。** 设置突发写入排在同一条同步链上，因此同一服务器的释放与重挂不会交错。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`mcp` 设置分节、舰队同步、子实例生命周期 |
| — | 不发布运行时不变式伴生入口；存活子实例映射是私有的同步状态，子实例的工具归各自的 `dsh-mcp-client` 注册所有，而被拒绝或挂载失败的条目会有意让设置分节与已挂载舰队不一致。 |

### 生命周期与同步

`apply` 以组合条目为当前数据源，在设置服务存在时安装 `mcp` 分节，并在每次变更后调度一次同步。同步用 `deepEqualJson` 比较期望的启用条目与存活子实例，先释放过期子实例，再经 `McpClient.Config` 校验新增条目，最后用 `ctx.plugin` 挂载。子 fiber 归属管理器 fiber，因此管理器释放时舰队一并释放。挂载失败会明确记录日志并保持该服务器未挂载，其他服务器继续服务。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从已桥接的工具逐步进入舰队的设计证据与可运行的示例配置。

- [MCP 客户端桥接](../mcp-client/README.zh.md)——单个服务器的连接、命名、执行与重连约定。
- [MCP 组](../README.zh.md)——MCP 组的两个包及其分工。
- [MCP 设置舰队 Agent Note](../../../.agents/notes/implemented/feature/2026-09-13-mcp-settings-fleet.zh.md)——舰队的设置分节、同步与插件卡片设计。
- [第三方记忆 MCP 指南](../../../docs/user/guide/mcp-memory.zh.md)——其中的 overlay 配置行现在也可以写成同样的设置条目。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过受管的 `dsh-mcp-client` 子实例体现，它们拥有所有面向模型的工具与结果；管理器自身不注册任何面向模型的内容。

#### KV Cache 影响

没有直接失效；把工具并入请求前缀的受管子实例拥有该变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明你无法用本包做什么、以及何时需要运维注意。它们是当前包约束，不是与其他 MCP 客户端的对比，也不是任务积压。

- **设置值均为明文**——`env` 与 `headers` 原样经过设置文档与脱敏 describe 路径。舰队条目没有凭据引用或 secret 角色；携带密钥的服务器属于固定部署的客户端配置行。
- **部署基座服务器只能禁用，不能删除**——设置层按服务器合并在组合基座之上，因此基座服务器通过 `enabled: false` 移除，而不是删除其键。
- **单个服务器失败不会阻塞其他服务器**——被拒绝或挂载失败的条目只记录日志并保持该服务器未挂载，舰队其余部分继续服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放设计方向。它明确不具权威性——已交付行为、限制与既定理由以上文与包代码为准。

- 舰队 `env`/`headers` 的凭据引用（类似 `apiKeyEnv`）是明文密钥问题的延期解决方案；它需要设置卡片可以渲染的逐服务器引用词汇。
- `env`/`headers` 字典值的 fail-closed secret 角色延期的原因与设置脱敏限制延期的原因相同：wire 界面隐藏它们之前，walker 必须证明每条密钥路径。

</details>
