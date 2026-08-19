# Agent Note: Session USD cost estimates

Status: implemented

English | [中文](2026-08-19-session-usd-cost.zh.md)

## Problem

The session log already preserves disjoint provider token buckets, but Web and headless output did not show the estimated USD value of a session. oh-my-pi accumulates each assistant usage record's `cost.total`, which is useful for catalog models but silently looks like zero for Cursor and custom routes whose pricing metadata is absent. Cursor's AgentService reports output token deltas but does not report complete billed input and cache usage.

## Decision

`TokenUsage` carries an optional `estimatedCostUsd` and `costBasis`. The `reported-usage` basis uses a provider's complete usage and rate card; `estimated-input` uses Cursor's output token deltas plus a fixed-density estimate of the serialized request input. The `tokenUsage` projection accumulates these fields per step and replaces an early chunk sample with the final sample, so streamed usage is not double-counted.

Known pi-ai model costs and configured DeepSeek or custom model rate cards use disjoint input, cache-read, cache-write, and output buckets priced per million tokens. Missing rates make that step unpriced. A session with any unpriced usage reports `Estimated cost unavailable` instead of treating missing pricing as `$0`.

Cursor pricing is a checked-in snapshot of the official [Models & Pricing table](https://cursor.com/docs/models-and-pricing), dated 2026-08-19. `GetUsableModels` decides availability; the snapshot supplies rates for documented model ids and Fast variants. A configured `cursorTokenRate` adds the documented $0.25/M Teams or Enterprise third-party surcharge; first-party Cursor models are exempt. Runtime code never scrapes the documentation page and does not apply temporary promotional discounts.

The Web composer stats strip appends localized estimated, approximate, or unavailable cost after token usage. The headless runner keeps stdout answer-only and writes the cost status to stderr. Both surfaces use oh-my-pi's magnitude-sensitive USD precision: four decimals below $0.01, three below $1, and two otherwise.

## Alternatives considered

**Copy oh-my-pi's zero-cost behavior.** Rejected: a zero rate is not evidence that a Cursor or custom model is free.

**Reprice historical sessions from the current catalog.** Rejected: price changes would rewrite the meaning of an old session. The per-call estimate is logged with the usage sample.

**Wait for Cursor to report complete input billing.** Rejected: the current AgentService stream exposes output token deltas and checkpoint occupancy, so the user-facing estimate records its approximate input basis while preserving the limitation.

## Consequences

Known catalog and configured models show a useful session estimate. Cursor estimates are explicitly approximate, and undocumented or newly released ids remain unavailable until their rate is added to the dated snapshot. Subscription entitlement consumption is not observable, so the displayed value is never presented as an invoice or actual account charge.

The additive usage fields do not change `SESSION_FORMAT_VERSION`; projection checkpoints advance their own `tokenUsage` state version. The headless stderr line does not change scripts that consume stdout.

## Testing

Shared cost arithmetic, token-meter replacement and checkpoint behavior, provider mapping, Cursor rate aliases and surcharge, Cursor token deltas, Web formatting/copy, and headless stdout/stderr separation are covered by focused unit tests. The official Cursor pricing URL and snapshot date are maintained here rather than fetched at runtime.
