---
description: "Web composer button and keyboard command that replace the draft with a Host-rewritten prompt, with Undo."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-prompt-enhance

English | [中文](README.zh.md)

## Summary

This browser plugin draws the ✨ control of the [prompt-enhance bundle](../prompt-enhance/README.md). It registers one `conversation.input.right` entry and the `composer.enhancePrompt` keyboard command. A press posts the draft and its images to the Host route, shows the route's progress, and replaces the draft with the answer.

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

The bundle loads this plugin; switch on **Enhance Prompt** in the plugin manager. The button is disabled for an empty draft, a draft starting with `/` or `!`, and while the composer submits. While a rewrite runs the button shows ✕ and cancels it, and the row beside it names the model and the current workspace lookup. A finished rewrite replaces the draft and shows a toast with **Undo**, which restores the draft as it was just before the replacement. A failure shows the Host's message and leaves the draft unchanged. The keyboard command defaults to **Ctrl+Shift+E** (**⌘⇧E** on macOS) and acts on the composer that has focus; it can be rebound in the shortcut settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

[`EnhancePrompt.tsx`](src/client/EnhancePrompt.tsx) reads the draft through `useInput` and writes through `inputActions.setDraft` followed by `persistDraft`. A Session switch or unmount aborts the running request. Each mounted control registers a shortcut target; the command resolves the target whose composer card contains the focused element. Draft images come from `inputActions.serializeAttachments`; when they cannot be encoded, the draft is enhanced from its text alone. [`request.ts`](src/client/request.ts) posts to the document-relative `prompt-enhance` route and reads its NDJSON frames; the `start` and `step` frames drive the localized status text.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host route and policy](../prompt-enhance/README.md).

-----

<a id="model-experience"></a>
## Model Experience

None, as the control only replaces the unsent draft; the Agent sees the text only when the user sends it.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Replacing the draft turns inline reference chips into their plain-text form; Undo restores the text, not the chips.
- The composer stays editable while a rewrite runs; edits made meanwhile are replaced, and Undo restores them.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
