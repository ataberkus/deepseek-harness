# Agent Note: Settings 驱动的 MCP 舰队

Status: implemented

[English](2026-09-13-mcp-settings-fleet.md) | 中文

## Problem

MCP 服务器每个对应一条 `cordis.yml` 配置行。每次新增、轮换 URL 或禁用，都需要编辑 profile 组合，这会重启或重载组合，也超出了只持有设置文档或网页插件页面的运维人员的能力范围。桥接层（`dsh-mcp-client`）按单服务器设计，因此一直缺少一个用户可配置的舰队地址。

## Decision

### Fleet manager package

新增 `@deepseek-ai/dsh-mcp-manager`（`packages/mcp/mcp-manager/`），拥有 `mcp` 设置分节，并为每个启用的条目挂载一个 `dsh-mcp-client` 子实例。设置字典的键就是服务器名称：它决定工具命名 `mcp__<serverName>__<tool>`，必须匹配 `[A-Za-z0-9_-]{1,32}`。条目携带 `enabled`（默认 `true`）以及客户端桥接除 `serverName` 之外的传输字段，`serverName` 由管理器从键注入。经明确选择，`env` 与 `headers` 为明文设置值；携带密钥的服务器仍放在固定部署的客户端配置行中。

示例分节：

```yaml
mcp:
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

管理器以零服务器休眠挂载，并已编入 `dsh-base`。它以组合条目为 `base` 安装分节，监听解析值，并串行化同步：先释放被移除与被禁用的子实例；新增与变更条目先经 `McpClient.Config` 校验，再替换旧子实例，因此被拒绝的条目会保持上一代继续服务。子 fiber 归属管理器 fiber，管理器释放时舰队一并释放。挂载失败会明确记录日志并保持该服务器未挂载，其他服务器继续服务。

禁用是删除部署基座服务器的路径：设置层按服务器合并在组合基座之上，因此基座服务器只能用 `enabled: false` 关闭，不能靠删除键来移除。

### Browser card

插件设置页新增以 `mcp` 命名空间为键的 MCP 卡片。卡片暂存整个 `servers` 映射（开关、移除、新增），并以一次带版本围栏的 `mutate` 持久化，因此过期编辑会冲突而不是覆盖。新增表单覆盖常用字段（名称、传输方式、命令与按行分隔的参数、URL）；超时、环境变量、请求头与重连调优仍在 `settings.yaml` 中完成。

## Alternatives considered

### Per-server settings sections

Rejected. 每个服务器一个命名空间会重新引入组合问题（命名空间必须由已经知道该服务器的组合行注册），并把插件页面切成每服务器一张卡片，失去舰队总览。

### Manager owning connections directly

Rejected. 在管理器内部重做连接会重复客户端的重连、代际切换与命名逻辑。把现有桥接作为子实例挂载，可以原样复用已锁定的命名约定与逐服务器重连预算。

### Credential references for fleet secrets

Deferred. 逐服务器的 `apiKeyEnv` 式引用需要卡片可渲染、脱敏 walker 可证明的引用词汇。v1 约定把 `env`/`headers` 存为明文，在文档与卡片中声明边界，携带密钥的服务器仍走固定部署配置行。

### Array-valued fleet

Rejected. 数组下标随每次插入移位，`mutate` 路径操作在多编辑器下不稳定。字典键是稳定地址，且让重名在结构上不可能出现。

## Testing

- **Unit**（`packages/mcp/mcp-manager/tests/settings.spec.ts`，内存提供方）：休眠注册、非法名称与字段校验、禁用条目存储、提供方分离回退、无提供方组合、命名空间释放。
- **Integration**（`packages/mcp/mcp-manager/tests/fleet.spec.ts`，真实 Streamable HTTP fixture）：按 URL 设置驱动挂载、禁用/移除回收工具、组合条目挂载、被拒绝写入后兄弟服务器继续服务。
- **Real composition**（`packages/mcp/mcp-manager/tests/loader-composition.spec.ts`）：经 Loader + Include 的测试专用 `cordis.yml` 以休眠启动，带有 `mcp` 命名空间且零 `mcp__` 工具。
- **Client**（`packages/client/ui-settings-plugins/tests/mcp-card-controller.client.spec.ts`，fake scope）：行摘要、草稿校验、存储投影、一次保存背后的暂存开关/移除/新增、非法草稿保持干净、放弃修改。

## Consequences

- 运维人员在 `settings.yaml` 或插件卡片中增删、启停 MCP 服务器；固定部署的服务器仍走直接客户端配置行。
- 工具名称保持锁定的 `mcp__<server>__<tool>` 约定；无关服务器的增删不会重命名已有工具。
- 舰队 `env`/`headers` 为配置界面可见的明文；管理器 README 与卡片文案声明该边界。
- 被拒绝或失败的服务器只记录日志并保持未挂载，舰队其余部分继续服务。
