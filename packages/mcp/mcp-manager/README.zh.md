---
description: "面向部署与维护者的 settings 驱动 MCP 服务器舰队管理器，无需编辑 cordis.yml 即可配置 MCP 服务器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-manager

[English](README.md) | 中文

## Summary

`dsh-mcp-manager` 为 `mcp` 设置分节中每个启用的条目挂载一个 `@deepseek-ai/dsh-mcp-client` 子实例，运维人员可以直接在 `settings.yaml` 或插件设置卡片中配置 MCP 服务器，而无需编辑 `cordis.yml`。管理器自身默认不挂载任何服务器；设置字典的键就是服务器名称，对应工具命名为 `mcp__<serverName>__<tool>`。需要固定部署的服务器仍可直接使用 `dsh-mcp-client` 配置行。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当 MCP 服务器需要在运行时由用户配置时，添加 `dsh-mcp-manager`。每个服务器只需一个设置条目：取一个服务器名称、选择一种传输方式，它的工具就会以 `mcp__<serverName>__<tool>` 形式出现。

### Minimal configuration

挂载一次管理器（`dsh-base` 已默认挂载），然后在 `mcp:` 设置分节中描述服务器：

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

| Field | Default | Meaning |
|---|---|---|
| `servers` | `{}` | 以服务器名称为键的舰队；键同时是工具命名空间，必须匹配 `[A-Za-z0-9_-]{1,32}` |
| `servers.<name>.enabled` | `true` | `false` 表示保留配置但不挂载 |
| `transport` | required | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio：可执行文件、参数、合并到清洗后环境之上的额外变量、工作目录 |
| `url` / `headers` | — | streamable-http：端点 URL 与额外请求头 |
| `toolCallTimeoutMs` | `60,000` | 每次 `tools/call` 调用的超时 |
| `failOnStartupError` | `false` | 初始连接失败时是否拒绝子实例激活 |
| `reconnect.*` | `true` / `500` / `30,000` / `10` | 连接丢失后的自动重连策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager)是每个受支持字段的穷尽式真源。

`env` 与 `headers` 以明文保存在设置文档中，并会原样出现在配置界面中。生产密钥请使用带 `!!js process.env.*` 的固定部署 `dsh-mcp-client` 配置行，不要放在这里。

禁用是删除部署基座服务器的路径：设置层按服务器合并在组合基座之上，因此基座服务器只能用 `enabled: false` 关闭，不能靠删除键来移除。`replace({})` 会重新继承组合条目。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the fleet and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **字典键就是身份。** 设置键直接提供 `serverName`，因此一个名称只有一个条目，条目不可能与自己的键持有不同的名字。
- **写入时校验，提交后同步。** 非法服务器名称在 `validate` 处拒绝设置写入；字段错误由 schema 拒绝。同步只挂载校验通过的条目，因此被拒绝的条目会保持上一代继续服务。
- **每个启用的条目对应一个子实例。** 禁用的条目不挂载任何内容。移除与禁用先释放旧子实例；新增与变更条目先经客户端 schema 校验，再替换旧子实例。
- **突发变更串行化。** 设置突发写入排在同一条同步链上，因此同一服务器的释放与重挂不会交错。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`mcp` 设置分节、舰队同步、子实例生命周期 |

### Lifecycle and sync

`apply` 以组合条目为当前数据源，在设置服务存在时安装 `mcp` 分节，并在每次变更后调度一次同步。同步用 `deepEqualJson` 比较期望的启用条目与存活子实例，先释放过期子实例，再经 `McpClient.Config` 校验新增条目，最后用 `ctx.plugin` 挂载。子 fiber 归属管理器 fiber，因此管理器释放时舰队一并释放。挂载失败会明确记录日志并保持该服务器未挂载，其他服务器继续服务。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the bridged tools to the fleet's design evidence and worked example configurations.

- [MCP client bridge](../mcp-client/README.zh.md) — 单个服务器的连接、命名、执行与重连约定。
- [MCP group](../README.zh.md) — MCP 组的两个包及其分工。
- [Third-party memory MCP guide](../../../docs/user/guide/mcp-memory.zh.md) — 同一份服务器配置行现在也可以写成设置条目。
- [Generated configuration catalog](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-manager) — 每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through managed `dsh-mcp-client` children, which own any model-facing tools and results; the manager registers nothing model-facing itself.

#### KV Cache effect

No direct invalidation; a managed child that folds its tools into the request prefix owns that change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what you cannot do with this package and when it needs operational attention. They are current package constraints, not a comparison with other MCP clients or a task backlog.

- **设置值均为明文** — `env` 与 `headers` 以明文保存在设置文档中，并原样经过脱敏 describe 路径。目前舰队条目没有凭据引用或 secret 角色；携带密钥的服务器请使用固定部署的客户端配置行。
- **部署基座服务器只能禁用，不能删除** — 设置层按服务器合并在组合基座之上，因此基座服务器只能用 `enabled: false` 关闭。
- **单个服务器失败不会阻塞其他服务器** — 被拒绝或挂载失败的条目只会记录日志并保持未挂载，舰队其余部分继续服务。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above and the package code.

- 舰队 `env`/`headers` 的凭据引用（类似 `apiKeyEnv`）是明文密钥的 deferred 答案；它需要设置卡片可以渲染的逐服务器引用词汇。
- `env`/`headers` 字典值的 fail-closed secret 角色同样 deferred：wire 界面隐藏它们之前，walker 必须证明每条密钥路径，正如设置脱敏限制中所述。

</details>
