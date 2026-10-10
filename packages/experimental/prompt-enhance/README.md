---
description: "Optional bundle that rewrites a composer draft into a clearer, more specific prompt after read-only workspace lookups."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-prompt-enhance

English | [中文](README.zh.md)

## Summary

This optional bundle adds prompt enhancement to the Web composer. The Host plugin registers `POST /prompt-enhance`; the [browser control](../client-ui-prompt-enhance/README.md) posts the draft of an open Session and replaces the draft with the answer. The enhancer uses the Session's selected model, the workspace instructions the Session loaded, the latest conversation text, and the draft's images. Before answering it may read, search, and list files inside the Session working directory to name real files and symbols. It sends nothing to the Agent.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Switch on **Enhance Prompt** in the plugin manager. The composer then shows a ✨ button before the model selector; **Ctrl+Shift+E** (**⌘⇧E** on macOS) does the same while the composer has focus. The draft is replaced in place and a toast offers **Undo**; nothing is sent. While a rewrite runs, the composer row shows the model in use and the current lookup, such as `reading src/app.ts`; pressing the button again cancels it. Drafts that are empty or start with `/` or `!` are not rewritten.

The bundle row sets the policy below. Override it in the profile patch layer by targeting the `prompt-enhance` id.

| Field | Bundle value | Meaning |
|---|---|---|
| `maxDraftChars` | 20000 | Longest accepted draft. |
| `historyMessages` | 6 | Latest user prompts and assistant messages shown to the model. |
| `historyMessageChars` | 1500 | Character cap of each shown message. |
| `instructionsMaxChars` | 20000 | Character cap of the loaded AGENTS.md-compatible instructions shown to the model; 0 omits them. |
| `maxToolCalls` | 6 | Workspace lookups one rewrite may run; 0 sends no tools. |
| `toolResultMaxChars` | 12000 | Character cap of each lookup result. |
| `scanMaxBytes` | 2000000 | Largest file a lookup reads, and largest raw search output it parses. |
| `maxOutputTokens` | 4000 | Output-token cap of each model request. |
| `timeoutMs` | 150000 | End-to-end deadline of one rewrite, including lookups. |
| `maxConcurrent` | 3 | Calls allowed at once; more are refused with HTTP 429. |
| `provider`, `model` | unset | A fixed route for every call, configured together; unset uses the Session's model. |
| `reasoningEffort` | unset | Adapter-owned effort for every call; unset uses the selected model's effort. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The route answers only requests that pass the composition's `connection` fence. It accepts `application/json` bodies with string `sessionId` and `text`, bounded by `maxDraftChars`, and optional base64 `images` that `ctx.attachments` stores before the call. The Session must have a live Agent. The route resolves the model in this order: the configured `provider`/`model`, the Session's pending selection, the model of its last request, the default model. Requests refused before the call answer `{ code, message }` with a 4xx/5xx status. An accepted request answers `200` with NDJSON frames: `start` with the route, one `step` per lookup, then `done` with the rewrite or `error`. The call loop in [`index.ts`](src/index.ts) sends the system prompt from [`enhance.ts`](src/enhance.ts) and the `read`/`grep`/`glob` schemas from [`lookup.ts`](src/lookup.ts). Lookups run inside the plugin rather than through the tool registry, so no tool policy, observation, spill, or Session event sees them. They resolve symlinks and refuse paths outside the working directory; `glob` skips ignored files. Calls past `maxToolCalls` get an error result, and a model that still does not answer fails with `tool-calls`. Closing the request aborts the call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser control](../client-ui-prompt-enhance/README.md) — the composer button, Undo toast, and keyboard command.

-----

<a id="model-experience"></a>
## Model Experience

None, as the rewrite is an auxiliary call outside the Session; only a prompt the user sends reaches the Agent, as an ordinary user message. Each rewrite costs one model request per lookup round, at most `maxToolCalls + 2` requests, each carrying the instructions, conversation tail, draft, images, and earlier lookup results.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The call is not recorded in the Session log, so a rewrite cannot be replayed from it.
- Lookups bypass the Session's tool policy, including approvals and hooks; they are read-only and confined to the working directory instead.
- `grep` with `include`, like ripgrep's own `--glob`, also searches ignored files.
- Images are stored as attachments even when the rewrite is discarded.
- Only Sessions with a live Agent can be enhanced; the composer of a new, unstarted Session is refused with HTTP 404.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
