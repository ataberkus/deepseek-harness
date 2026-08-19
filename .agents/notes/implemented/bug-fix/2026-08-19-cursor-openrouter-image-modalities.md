# Agent Note: Cursor and live OpenRouter image modalities

Status: implemented

English | [中文](2026-08-19-cursor-openrouter-image-modalities.zh.md)

## Problem

Attaching an image to Grok 4.6 after `/login cursor` failed before any provider request with `Model "grok-4.6" does not support image input.` Hosted Cursor descriptors always set `input: ['text']`. GetUsableModels has no image-capability field, so live rows went through the same constructor. The unofficial AgentRunRequest flatten also replaced image blocks with `[image]` text and sent no raster bytes.

The OpenRouter live overlay had the same under-claim for ids the installed snapshot does not ship: `overlayLiveCatalogModels` cloned protocol and endpoint, then forced `input: ['text']` even when OpenRouter `GET /models` named image in `architecture.input_modalities` or `architecture.modality`. Installed snapshot ids kept pi-ai's own modalities. DeepSeek stays text-only because that adapter cannot send images.

## Decision

Hosted Cursor chat families advertise `[text, image]`. The same id tokens as reasoning (`grok`, `claude`, `gpt-`, `composer`, `gemini`, `kimi`, `glm`, `opus`, `sonnet`) plus every bundled fallback id count as chat families. `grok-code` and unknown live ids stay `[text]` so the harness does not admit an image the unofficial backend would then reject. [Cursor OAuth](../feature/2026-08-18-cursor-oauth-host.md) still owns login and listing union; this note owns the modality claim and the wire.

Raster bytes travel as unofficial `SelectedImage` on `UserMessage.selected_context` (`uuid` 2, `path` 3, `mime_type` 7, `data` 8). A flattened history sends every user and tool-result image; a checkpointed follow-up sends only this turn. Image blocks contribute no prompt text.

Live-only OpenRouter ids that disclose image in `architecture.input_modalities` or `architecture.modality` (`text+image->text`) are marked `[text, image]`; listings that omit architecture stay text-only. Discovery replies still omit `input`, matching `reasoning`. The [OpenRouter live overlay](../feature/2026-08-18-openrouter-live-catalog.md) owns that union; this note owns the image flag.

## Alternatives considered

**Cloning the first catalog model's `input` onto every live-only OpenRouter id.** Rejected: the first snapshot row may be vision while a live-only id is text-only, which would admit an attachment the endpoint then rejects mid-turn.

**Advertising `[text, image]` on every hosted Cursor id, including `grok-code` and unknown live ids.** Rejected: GetUsableModels does not disclose image capability, and over-claiming leaves a durable image the session cannot switch off of.

**Leaving Cursor text-only because flatten used `[image]` placeholders.** Rejected: the unofficial `SelectedImage` field is what community AgentService clients send, and the host error fired before flatten ran.

**Parsing image support from a GetUsableModels protobuf field.** Rejected: `ModelDetails` in that reply has no such field.

## Consequences

Grok 4.6, Claude, GPT, Composer, Gemini, and the other Cursor chat families accept image attachments and send pixels. `grok-code` still refuses. A live-only OpenRouter vision model disclosed by the listing accepts images without a `settings.yaml` `models` entry; a generic OpenAI listing that omits `architecture` still refuses. DeepSeek remains text-only.

## Testing

`packages/llm/llm-pi-ai/tests/cursor.spec.ts` pins inferred `[text, image]` on `grok-4.6` / Composer, `[text]` on `grok-code` and unknown live ids, `SelectedImage` encoding, flatten omitting `[image]` placeholders, and stream bodies that carry gif bytes. `tests/listing.spec.ts` pins `architecture.input_modalities` / `modality` disclosure and the live-only overlay `input` field.
