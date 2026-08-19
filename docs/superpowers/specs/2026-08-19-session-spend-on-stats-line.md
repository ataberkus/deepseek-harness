# Session USD spend on the Web stats line

Status: draft for review

English | [中文](2026-08-19-session-spend-on-stats-line.zh.md)

## Scope

This specification covers catalog-priced USD spend from live pi-ai model calls through durable `TokenUsage`, the `tokenUsage` session projection, the standalone browser fixture, and the Web conversation composer stats line.

The change keeps provider ownership intact: pi-ai reports the priced total, `dsh-llm-pi-ai` maps it, `dsh-token-meter` persists and folds it, and `ui-conversation` presents the session total.

## Goals

- Preserve positive per-call catalog spend as optional `TokenUsage.costUsd` without changing `SESSION_FORMAT_VERSION`.
- Sum spend across the complete durable session log with the same last-sample replacement rule used by token buckets.
- Display localized `Cost {cost}` / `花费 {cost}` immediately before the existing input/output token group.
- Format values below one cent, or values carrying sub-cent precision, to four decimal places and other cent-aligned values to two decimal places, while omitting zero, unknown, and unpriced spend.
- Keep replay reconstruction's zero-cost pi-ai messages unchanged; billed spend belongs to the live durable usage event.
- Update the source JSDoc, subsystem and package references, the required implemented Agent Note, and every edited bilingual pair together.

## Data flow and ownership

`TokenUsage` gains optional `costUsd?: number` with JSDoc stating that it is adapter-reported USD for one call, copied from pi-ai catalog rates and omitted when no rates exist or the priced total is zero.

`mapUsage()` copies `usage.cost.total` only when it is greater than zero, matching the existing omission of zero cache buckets. The pi-ai catalog comment states that zero `NO_COST` rates omit spend, while `replay.ts` continues to construct zero-cost reconstructed messages.

`TokenUsageProjection` gains required `costUsd: number`. `tokenUsageProjectionDefinition` initializes, validates, compares, replaces, and sums this floating-point bucket with the token buckets. Its checkpoint `stateVersion` becomes `2`, so an old version is discarded and refolded from the durable log. The browser fixture mirrors the same fold and output field.

`StatsLine` exports `formatCost(usd)`, formats values below one cent or carrying sub-cent precision with four decimals (including `$0.0123`) and cent-aligned values with two decimals (including `$1.20`), and adds the localized cost group after cache hit and before the token group only when `usage.costUsd > 0`. Existing token-only output remains unchanged for absent or zero cost.

## Compatibility and non-goals

The optional usage field is additive and does not require a session-format version change. Existing logs and adapters without rates refold with `costUsd: 0`; the UI hides that group and never renders `$0.00`.

The implementation does not multiply cumulative tokens by the selected model's current rate, compute dollars in `llm-deepseek`, add a projection key, add cost chrome to the TUI or subagent surfaces, add dependencies, or refresh Web snapshots whose fixtures carry no positive `costUsd`.

Cursor and Gemini CLI catalog models remain `NO_COST`, and `llm-deepseek` remains unpriced until that adapter reports `costUsd`. Mixed-model sessions and cache-rate differences are handled by summing each call's persisted spend rather than re-pricing totals.

## Verification

Add adapter mapping tests for positive and zero pi-ai totals. Update token-meter expectations with `costUsd: 0` and add a test covering cost summing and same-step replacement. Update the fixture empty-log expectation and add StatsLine formatting and localized ordering coverage.

Run `pnpm exec vitest run packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/token-meter/tests/token-usage-projection.spec.ts packages/client/ui-conversation/tests/chat-stats.client.spec.tsx packages/client/connection/tests/fixture.client.spec.ts`, then typecheck touched packages if the focused tests do not compile them.

Run `pnpm run verify-translation-pairing --write` for every edited bilingual file, including the new Agent Note and the architecture note whose `tokenUsage` sentence changes. Run the relevant documentation and diff checks; do not run snapshot refresh unless a fixture is intentionally made cost-bearing.

## Alternatives considered

- **Multiply current cumulative token totals by the selected model's catalog rates:** rejected because sessions can switch models and cache versus uncached buckets use different rates.
- **Estimate spend only in the client without a durable field:** rejected because paging and compaction already require session-wide accounting in the `tokenUsage` projection, and a client estimate would not survive those boundaries reliably.
- **Hardcode DeepSeek rates in `llm-deepseek`:** rejected because that adapter has no catalog pricing source; it omits spend until it reports an adapter-owned `costUsd`.
- **Add a separate projection key:** rejected because cost is part of the existing durable token-usage accounting and does not need another projection lifecycle.
- **Price replayed historical pi-ai messages:** rejected because replay metadata is reconstructed history, not a live billed attempt; durable usage carries the billed total.

## Consequences

The stats line reports session spend that remains stable across pagination, compaction, reconnect, and model switching, provided the serving adapter reports catalog cost for each call. Sessions with only unpriced or zero-cost calls retain their existing token-only appearance.

The projection schema now carries a floating-point USD value and state version 2. Old checkpoint state is intentionally refolded, while the unchanged session format preserves additive usage compatibility. The browser fixture stays behaviorally aligned with the host projection without introducing a client-only estimate.

The UI gains one localized group and a small amount of width when positive spend exists; its ordering keeps spend adjacent to the token accounting it summarizes and preserves all existing keyless snapshot output for costless fixtures.
