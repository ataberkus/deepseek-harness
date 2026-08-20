# Agent Note: Keep Cordis client startup resilient to remote readiness

Status: implemented

English | [中文](2026-08-20-cordis-client-startup-remote-failures.zh.md)

## Problem

Cordis client plugins can activate while the browser Connection is opening. The UI Cordis inventory invokes a generated remote method during apply; an inactive Connection or a stale remote namespace can throw synchronously before a Promise exists, and that exception rejects plugin activation and leaves the Web shell blank. Client inspect providers have the same readiness window when they publish their manifest.

## Decision

[createCordisInventory](../../../../packages/extensions/ui-cordis/src/client/inventory.ts) normalizes synchronous inventory RPC throws into the existing rejected-read path. The inventory keeps its last rows, records the failure, and reports it without allowing apply to throw.

[cordis-client-runner](../../../../packages/extensions/cordis-client-runner/src/client/index.ts) treats the first `connection/reset` event as the point at which inspect-manifest RPC is callable. Provider registration retains the manifest before that event; synchronization is published after the event and remains retriable on later resets.

The corresponding Client bundles are rebuilt whenever these browser package sources change. The shipped Web artifact therefore carries the remote method set and the synchronous-failure guard together.

## Alternatives considered

**Call remote methods immediately and log rejections.** Rejected because a synchronous proxy throw can escape the inventory store before its rejection handler runs, taking down the plugin fiber.

**Retry with a timer.** Rejected because a timer does not identify the active Connection generation and can publish a stale manifest or inventory response after reconnect.

**Silently ignore all startup remote errors.** Rejected because inventory failures must remain visible in the panel state, while inspect synchronization needs the explicit `connection/reset` retry point.

## Consequences

The inventory panel can render an error state while preserving rows from the last successful read, including when the remote method is absent in a stale artifact. Inspect manifests are not sent before a live Connection exists, so normal startup does not report an unavailable-Connection error. A reconnect publishes the complete provider manifest again.

The guard protects the plugin lifecycle; it does not make an incompatible remote artifact compatible. Rebuilding the dependent Client bundles remains required after changing the remote method set.

## Testing

`packages/extensions/ui-cordis/tests/inventory.client.spec.ts` covers a missing inventory method that throws synchronously without escaping `refresh`. `packages/extensions/cordis-client-runner/tests/plugin.client.spec.ts` covers deferring inspect synchronization until `connection/reset`. The GUI suite, both Cordis package bundles, the Web build, the focused Web blank-session smoke, and a live probe of `http://127.0.0.1:3080` cover the assembled path; the live probe observed a non-empty page with no console or page errors.
