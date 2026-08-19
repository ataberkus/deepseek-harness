# Agent Note: Session USD spend on the Web stats line

Status: implemented

English | [中文](2026-08-19-session-spend-on-stats-line.zh.md)

## Problem

The Web composer stats line reports durable token buckets but not the USD spend that pi-ai already calculates for catalog-priced calls. Repricing cumulative tokens with the selected model would be wrong for sessions that switch models or mix cache-read, cache-write, and uncached rates.

## Decision

The live pi-ai stream maps a positive `usage.cost.total` to optional `TokenUsage.costUsd`; zero-rate and unknown-rate adapters omit the field, and replay reconstruction keeps its native zero-cost usage. `dsh-token-meter` carries `costUsd` in the existing `tokenUsage` projection, replaces it with the final sample for the same `(turn, step)`, and sums it across steps. The durable projection remains the owner described in [Projected token usage and request context](../architecture/2026-07-29-projected-token-usage-and-request-context.md); surface heuristics do not reprice this exact spend. State version `2` discards old checkpoint rows so the durable log refolds the new bucket.

The browser fixture mirrors the projection with `usage.costUsd ?? 0`. `StatsLine` formats positive session spend as a localized cost group after cache hit and before the input/output token group. It hides zero and unknown spend, so costless logs retain their existing output and never show `$0.00`.

## Alternatives considered

- **Multiply current `tokenUsage` totals by current model catalog rates:** rejected because model switches make one session mixed-model, and cache-read, cache-write, and uncached input use different rates.
- **Estimate spend only in the client with no durable field:** rejected because paging and compaction already require session-wide accounting in `tokenUsage`; a client estimate would not survive those projection boundaries.
- **Hardcode DeepSeek rates in `llm-deepseek`:** rejected because that adapter has no catalog pricing source; it omits spend until the adapter reports `costUsd`.
- **Add a separate projection key:** rejected because spend belongs to the existing durable token-usage accounting and does not need another projection lifecycle.
- **Price reconstructed replay messages:** rejected because replay restores historical provider metadata rather than representing a new billed attempt; live durable usage owns the billed total.

## Consequences

Catalog-priced pi-ai sessions retain per-call billing across model switches, pagination, compaction, reconnect, and replay of the durable log. Adapters without rates, including `llm-deepseek`, Cursor, and Gemini CLI routes, contribute zero and leave the UI unchanged until they report a positive `costUsd`.

The existing session format remains compatible because `costUsd` is optional on per-call usage. The token-usage checkpoint schema is version `2`, so old checkpoint rows are refolded; the browser fixture has the same required projection field without adding positive-cost fixture data. The Web snapshot corpus remains unchanged because existing fixtures carry no positive spend.
