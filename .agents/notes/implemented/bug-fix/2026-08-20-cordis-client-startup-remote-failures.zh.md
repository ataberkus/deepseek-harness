# Agent Note: 让 Cordis 客户端启动能够承受远程就绪时序

Status: implemented

English | [English](2026-08-20-cordis-client-startup-remote-failures.md)

## Problem

浏览器 Connection 正在建立时，Cordis 客户端插件可能已经激活。UI Cordis 清单在 apply 期间调用生成的远程方法；Connection 尚未激活或远程命名空间过期时，调用可能在 Promise 创建前同步抛出异常，导致插件激活失败并让 Web 外壳空白。客户端 inspect provider 发布清单时也存在相同的就绪时序窗口。

## Decision

[createCordisInventory](../../../../packages/extensions/ui-cordis/src/client/inventory.ts) 将同步抛出的清单 RPC 异常归一到现有的失败读取路径。清单保留上次读取的行、记录错误并报告错误，不让 apply 抛出异常。

[cordis-client-runner](../../../../packages/extensions/cordis-client-runner/src/client/index.ts) 将第一次 `connection/reset` 事件视为可以调用 inspect 清单 RPC 的时点。在此事件之前，provider 注册仍然保留清单；事件发生后发布清单，并在后续 reset 时再次同步。

这些浏览器包的源代码变化会同时重建对应的 Client bundle。发布的 Web artifact 因而同时包含远程方法集合与同步异常保护。

## Alternatives considered

**立即调用远程方法并只记录 Promise rejection。** 不采用，因为同步代理异常可能在清单 store 的 rejection handler 执行前逸出并终止插件 fiber。

**使用定时器重试。** 不采用，因为定时器不能识别当前 Connection generation，重连后可能发布过期清单或清单读取结果。

**静默忽略所有启动远程错误。** 不采用，因为清单读取失败必须保留在面板状态中，而 inspect 同步需要明确的 `connection/reset` 重试时点。

## Consequences

清单面板可以在保留上次成功读取行的同时呈现错误状态，即使过期 artifact 中缺少远程方法。活动 Connection 建立前不会发送 inspect 清单，因此正常启动不会报告 Connection 不可用错误。重连会再次发布完整 provider 清单。

该保护机制保证插件生命周期不会被远程调用失败破坏；它不会让不兼容的远程 artifact 变得兼容。改变远程方法集合后仍然必须重建相关 Client bundle。

## Testing

`packages/extensions/ui-cordis/tests/inventory.client.spec.ts` 覆盖缺少 inventory 方法且同步抛出的场景，确认异常不会逃出 `refresh`。`packages/extensions/cordis-client-runner/tests/plugin.client.spec.ts` 覆盖直到 `connection/reset` 后才同步 inspect 清单。GUI 套件、两个 Cordis 包 bundle、Web 构建、聚焦的 Web 空白会话 smoke，以及 `http://127.0.0.1:3080` 的实时探针覆盖组装路径；实时探针观察到非空页面且没有 console 或 page error。
