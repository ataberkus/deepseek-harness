---
description: "Optional bundle that rewrites a composer draft into a clearer, more specific prompt with one auxiliary model call."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-prompt-enhance

English | [中文](README.zh.md)

## Summary

This optional bundle adds prompt enhancement to the Web composer. The Host plugin registers `POST /prompt-enhance`; the [browser control](../client-ui-prompt-enhance/README.md) posts the draft of an open Session and replaces the draft with the answer. The call uses the Session's selected model, the latest conversation text, and the Session working directory. It sends nothing to the Agent.

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

Switch on **Enhance Prompt** in the plugin manager. The composer then shows a ✨ button before the model selector; **Ctrl+Shift+E** (**⌘⇧E** on macOS) does the same while the composer has focus. The draft is replaced in place and a toast offers **Undo**; nothing is sent. Pressing the button again while a rewrite runs cancels it. Drafts that are empty or start with `/` or `!` are not rewritten.

The bundle row sets the policy below. Override it in the profile patch layer by targeting the `prompt-enhance` id.

| Field | Bundle value | Meaning |
|---|---|---|
| `maxDraftChars` | 20000 | Longest accepted draft. |
| `historyMessages` | 6 | Latest user and assistant messages shown to the model. |
| `historyMessageChars` | 1500 | Character cap of each shown message. |
| `maxOutputTokens` | 4000 | Output-token cap of the call. |
| `timeoutMs` | 120000 | End-to-end call deadline. |
| `maxConcurrent` | 3 | Calls allowed at once; more are refused with HTTP 429. |
| `provider`, `model` | unset | A fixed route for every call, configured together; unset uses the Session's model. |
| `reasoningEffort` | unset | Adapter-owned effort for every call; unset uses the selected model's effort. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The route answers only requests that pass the composition's `connection` fence. It accepts `application/json` bodies with string `sessionId` and `text`, bounded by `maxDraftChars`. The Session must have a live Agent. The route resolves the model in this order: the configured `provider`/`model`, the Session's pending selection, the model of its last request, the default model. It streams one `ctx.llm.stream()` call with the fixed system prompt in [`enhance.ts`](src/enhance.ts) and answers `{ text, provider, model }`, or `{ code, message }` with a 4xx/5xx status. Closing the request aborts the call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser control](../client-ui-prompt-enhance/README.md) — the composer button, Undo toast, and keyboard command.

-----

<a id="model-experience"></a>
## Model Experience

None, as the rewrite is an auxiliary call outside the Session; only a prompt the user sends reaches the Agent, as an ordinary user message.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The call is not recorded in the Session log, so a rewrite cannot be replayed from it.
- The model has no tools: it cannot read files to confirm paths and names only what the draft or conversation mentions.
- Only Sessions with a live Agent can be enhanced; the composer of a new, unstarted Session is refused with HTTP 404.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
