# Agent Note: Per-model OpenRouter and Cursor reasoning efforts

Status: implemented

English | [中文](2026-08-19-per-model-listing-reasoning-efforts.zh.md)

## Problem

The composer effort menu did not match what each model actually accepts. Cursor Grok 4.6 showed Default / Off / Minimal / Low / Medium / High because `cursorModel` set `reasoning: true` with no `thinkingLevelMap`, so pi-ai treated absent base keys as supported and the picker injected a Default row when `defaultEffort` was missing. Grok 4.6's documented set is `low` / `medium` / `high` / `xhigh`, reasoning cannot be turned off, and the default is `high`.

OpenRouter DeepSeek rows had the same class of error. The live overlay stamped `{ low, medium, high }` onto live-only ids and left installed snapshot maps in place, so DeepSeek V4 Flash (`xhigh` / `high`, default `high`) and other listing `reasoning` objects never reached the picker.

The [live catalog reasoning note](2026-08-19-catalog-reasoning-oauth-signout-cursor-fast.md) still owns the reasoning flag, OAuth Sign out, and Cursor Fast SKUs.

## Decision

OpenRouter overlay parses each listing row's `reasoning` object: `supported_efforts` is the offer, `default_effort` is the advertised picker default, `none` is pi-ai `off`, and JSON-null `supported_efforts` means the gateway's full set (dropping `none` when `mandatory` is true). A `supported_parameters` reasoning name without a usable object still uses `{ low, medium, high }`. Matching installed ids receive the live map so a snapshot cannot keep Off / Minimal / extra levels the endpoint no longer names. Undeclared pi-ai levels are pinned `null`; an absent base-level key would otherwise mean supported. `resolveModelInfo` advertises `defaultThinkingLevel` so the composer does not inject a Default row when the listing or family table named a default.

Cursor GetUsableModels `ThinkingDetails` is a presence flag with no effort names, so family tables keyed on the id (Fast suffix stripped) attach the map. Grok 4.6 is `low` / `medium` / `high` / `xhigh` default `high`. Other Grok ids, Composer, Kimi / `k3`, and unknown reasoning ids are `low` / `medium` / `high` default `high`. GPT-5.4 is Off (`none` on the wire) / Minimal / Low / Medium / High / Xhigh default `medium`. Other GPT / Codex ids drop Xhigh. Claude is Off / Low / Medium / High default `high`. Gemini is Minimal / Low / Medium / High. GLM is Low / High / Max. The Cursor run encodes a selected effort as ThinkingDetails field 1; thinking on with no named effort is an empty message (Cursor's default); `off` omits ThinkingDetails.

## Alternatives considered

**Keeping the hardcoded OpenRouter `{ low, medium, high }` for live-only ids.** Rejected: DeepSeek V4 Flash is `xhigh` / `high`; Grok 4.6 includes `xhigh` and is mandatory.

**Leaving installed snapshot maps in place when the listing names the same id.** Rejected: an installed id would keep catalog Off / Minimal after the live listing named a narrower set.

**Reading Cursor efforts from GetUsableModels ThinkingDetails.** Rejected: the field is an empty presence flag in the Connect proto this adapter decodes.

**Offering Off or Minimal on Grok 4.6.** Rejected: that model's reasoning cannot be disabled; pi-ai treats missing base keys as supported unless they are pinned `null`.

## Consequences

Composer shows Low / Medium / High / Xhigh for Cursor Grok 4.6 with High selected. OpenRouter DeepSeek V4 Flash shows High / Xhigh with High selected. A listing that names no `default_effort` still omits `defaultEffort`, so a Default row appears only when the endpoint did not advertise one. Image input on live-only OpenRouter ids remains unclaimed.

## Testing

`packages/llm/llm-pi-ai/tests/thinking-levels.spec.ts` pins pinning, `none` → `off`, and listing-object parse. `tests/listing.spec.ts` pins live `supported_efforts` / `default_effort` and overwriting an installed id's snapshot map. `tests/live-catalog.spec.ts` pins DeepSeek V4 Flash High / Xhigh with default High. `tests/cursor.spec.ts` pins family maps, Grok 4.6 Off/Minimal pinned unsupported, ThinkingDetails field 1, and omitting ThinkingDetails when effort is `off`.
