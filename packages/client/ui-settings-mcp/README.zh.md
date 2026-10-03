---
description: "dsh Web 客户端插件页上的 MCP 舰队设置页：mcp-manager 条目挂载的服务器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

[English](README.md) | 中文

## 概述

在侧栏打开**插件**，在官方分组里选择 **MCP 服务器**，即可新增、编辑、停用或移除 `mcp-manager` 条目挂载的模型上下文协议（MCP）服务器。本页暂存的每个服务器都是该条目易变 `servers` 字段下的一个条目，以给其工具命名空间的名字为键。页面暂存整个舰队、只在保存时写入，并且只在该条目的表单被 Host 服务期间存在。

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

官方分组里的 **MCP 服务器**卡片打开这一页。每一行是一个已配置的服务器及其**已启用**开关、传输方式和命令行或接口地址；**编辑**把该行载入下方表单，**移除**暂存它的删除。表单每次添加一个服务器：名称、传输方式、stdio 的命令与每行一个参数、或 Streamable HTTP 的接口地址，以及是否挂载。点击**保存**之前不会写入任何内容；离开页面即丢弃草稿；名称不符合 `[A-Za-z0-9_-]{1,32}`、缺少命令或接口地址、或接口地址不是 http/https，都会在字段下被拒绝而不是暂存。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行，客户端模块系统据此送出浏览器半侧。浏览器半侧通过 `ctx.configForms.get` 绑定 `mcp-manager` 条目的表单，用 `McpServersCardController` 在条目易变的 `servers` 字段上维护暂存的舰队，并通过 `ctx.configForms.whileServed` 把 `McpServersCard` 注册进插件页的 `plugins.item` slot。页面文案在本包的 `settings.mcp` 字典里。

控制器为每个页面持有一份草稿：编辑、新增与移除都改在已存舰队的副本上，保存时以草稿起始的修订号做一次围栏，把 `servers` 字段整体 `set` 写入。它只写表单自己编辑的字段，因此它更新的条目会保留其他写入方存下的环境变量、请求头、超时与重连策略。草稿不携带任何托管密钥：条目的 `env` 与 `headers` 留在 profile 里。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的配置表单与"条目被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——本页渲染的设置表单框架与控件。
- [mcp-manager](../../mcp/mcp-manager/README.zh.md)——挂载本页所编辑舰队的宿主插件。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

本页自身没有；保存之后的下一个请求会携带不同的工具 schema，因为 `mcp-manager` 挂载的正是本页写入的服务器。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **两种传输方式**——本页编辑 stdio 与 Streamable HTTP 条目。二者的进阶调优（环境变量、请求头、单次调用超时、重连策略）留在 profile 中，更新时会保留，而不在此编辑。
- **明文接口配置**——存下来的 `env` 或 `headers` 对每个配置界面可见；本页不为它们提供凭据引用。
- **运行时不变量：**不发布伴生。本页没有自己拥有的关系：它显示的内容派生自条目表单，它写入的内容由 Host 按管理器 schema 校验。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

舰队字段在宿主 schema 上声明为 `.volatile()`。否则 Loader 会拒绝活写入，页面需要重新挂载后才能显示新服务器。

</details>
