# Agent Note: 挂在插件条目上的活编辑 MCP 舰队

Status: implemented

[English](2026-09-13-mcp-settings-fleet.md) | 中文

## Problem

MCP 服务器每个对应一条 `cordis.yml` 配置行。每次新增、轮换 URL 或禁用，都需要编辑 profile 组合，这会重启或重载组合，也超出了只持有网页插件页面的运维人员的能力范围。桥接层（`dsh-mcp-client`）按单服务器设计，因此一直缺少一份无需改动组合即可编辑的舰队。

## Decision

### Fleet manager package

`@deepseek-ai/dsh-mcp-manager`（`packages/mcp/mcp-manager/`）拥有自己 profile 条目的 `servers` 映射，并为每个启用的条目挂载一个 `dsh-mcp-client` 子实例。映射的键就是服务器名称：它决定工具命名 `mcp__<serverName>__<tool>`，必须匹配 `[A-Za-z0-9_-]{1,32}`。条目携带 `enabled`（默认 `true`）以及客户端桥接除 `serverName` 之外的传输字段，`serverName` 由管理器从键注入。该字段声明为 `.volatile()`，正是它让 Loader 能把活值提交给正在运行的管理器。经明确选择，`env` 与 `headers` 为 profile 中的明文值；携带密钥的服务器仍放在固定部署的客户端配置行中。

示例条目配置：

```yaml
servers:
  github:
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
  web:
    transport: streamable-http
    url: http://localhost:3000/mcp
```

### Lifecycle

管理器以零服务器休眠挂载，并已编入 `dsh-base`。`apply` 从自己的配置引用读取舰队，拒绝一份键无法作为工具命名空间的映射，并串行化同步：先释放被移除与被禁用的子实例；新增与变更条目先经 `McpClient.Config` 校验，再替换旧子实例，因此被拒绝的条目会保持上一代继续服务。每次活提交与每次 `loader/volatile-update` 都调度一次同步。子 fiber 归属管理器 fiber，管理器释放时舰队一并释放。挂载失败会明确记录日志并保持该服务器未挂载，其他服务器继续服务。

禁用是移除某个已在 profile 中固定的服务器的路径：提交的值会替换整份映射，因此编辑器没有携带的服务器将不再挂载，而 `enabled: false` 会保留名称，只不挂载。

### Browser page

伴生包 `@deepseek-ai/dsh-client-ui-settings-mcp` 拥有插件页的 **MCP 服务器**卡片。它通过 `ctx.configForms` 绑定 `mcp-manager` 条目的表单，暂存整个 `servers` 映射（开关、移除、新增），并以一次带版本围栏的 `set` 写入，因此过期编辑会冲突而不是覆盖。新增表单覆盖常用字段（名称、传输方式、命令与按行分隔的参数、URL）；超时、环境变量、请求头与重连调优留在 profile 中。页面在 Host 服务该条目期间注册进 `plugins.item`，文案在它自己的 `settings.mcp` 字典里。

## Alternatives considered

### Settings-section fleet

Superseded. 首个实现给管理器配了自己的 `mcp` 设置分节。插件自有的分节要求设置服务存在，使舰队出现两个真源（组合与分节），并且在网页界面转向逐条目配置页面后必须重做。把条目自己的字段声明为易变，可以经 Loader 达到同样的活编辑，而 profile 仍是该值的唯一归属。

### Per-server settings sections

Rejected. 每个服务器一个命名空间会重新引入组合问题（命名空间必须由已经知道该服务器的组合行注册），并把插件页面切成每服务器一张卡片，失去舰队总览。

### Manager owning connections directly

Rejected. 在管理器内部重做连接会重复客户端的重连、代际切换与命名逻辑。把现有桥接作为子实例挂载，可以原样复用已锁定的命名约定与逐服务器重连预算。

### Credential references for fleet secrets

Deferred. 逐服务器的 `apiKeyEnv` 式引用需要页面可渲染、脱敏 walker 可证明的引用词汇。v1 约定把 `env`/`headers` 存为明文，在文档与页面中声明边界，携带密钥的服务器仍走固定部署配置行。

### Array-valued fleet

Rejected. 数组下标随每次插入移位，`set` 路径操作在多编辑器下不稳定。字典键是稳定地址，且让重名在结构上不可能出现。

## Testing

- **Unit**（`packages/client/ui-settings-mcp/tests/controller.client.spec.ts`，桩表单）：暂存新增、更新与重命名，合并且保留表单未编辑的字段，校验拒绝且不暂存任何内容，一次保存背后的开关与移除，只读拒绝，版本冲突，释放。
- **Registration**（`packages/client/ui-settings-mcp/tests/apply.client.spec.ts`）：页面只在 Host 服务 `mcp-manager` 条目期间出现，标题按当前语言解析，并随其 fiber 一起消失。
- **Integration**（`packages/mcp/mcp-manager/tests/fleet.spec.ts`，真实 Streamable HTTP fixture）：按活配置中的 URL 挂载、禁用与移除回收工具、组合条目挂载、被拒绝条目之后兄弟服务器继续服务。
- **Real composition**（`packages/mcp/mcp-manager/tests/loader-composition.spec.ts`）：经 Loader + Include 的测试专用 `cordis.yml` 以休眠启动，带有易变、可活编辑的舰队且零 `mcp__` 工具。

## Consequences

- 运维人员在插件页或 profile 条目中增删、启停 MCP 服务器；固定部署的服务器仍走直接客户端配置行。
- 工具名称保持锁定的 `mcp__<server>__<tool>` 约定；无关服务器的增删不会重命名已有工具。
- 舰队 `env`/`headers` 为配置界面可见的明文；管理器 README 与页面限制声明该边界。
- 被拒绝或失败的服务器只记录日志并保持未挂载，舰队其余部分继续服务。
