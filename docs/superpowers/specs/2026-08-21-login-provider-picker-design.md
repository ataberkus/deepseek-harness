# Login provider picker design

## Problem

The web dashboard lists `/login` as `Sign in to OpenAI Codex, Cursor, or Antigravity`, but the host registers the command without an input descriptor. The client therefore treats a menu selection as a bare command and executes `/login` with empty input. The OAuth parser intentionally maps empty input to `openai-codex`, so the dashboard opens OpenAI without asking which provider the user wants. `OAUTH_COMMAND_HINT` already defines the supported provider ids but is not attached to the command definition.

## Goals

- Selecting `/login` in the web slash menu opens a provider picker instead of executing an empty login.
- The picker presents friendly provider names and concise subscription details.
- Selecting a provider executes the existing host command with its stable provider id.
- Typed `/login <provider>` remains supported, including the parser's existing aliases.
- OAuth tab preparation, HTTPS validation, in-flight protection, credential persistence, route refresh, command lifecycle logging, and error reporting remain owned by existing code.
- Headless and CLI callers retain the existing empty-input behavior for `/login`.
- The picker uses the existing popup shell and its keyboard, search, focus, and accessibility behavior.

## Non-goals

- No change to OAuth providers, token exchange, callback handling, credential storage, or model routing.
- No new command wire fields or host protocol changes.
- No replacement of the existing `/login <provider>` grammar.
- No provider-management UI in the Models settings page.
- No change to `/logout` behavior in this focused change.

## User interaction

The web slash menu continues to show one `/login` row. Selecting the row or submitting bare `/login` opens a popup with these options:

| Option | Command id | Detail |
| --- | --- | --- |
| OpenAI Codex | `openai-codex` | ChatGPT subscription |
| Cursor | `cursor` | Cursor subscription |
| Antigravity | `google-antigravity` | Google Cloud Code Assist subscription |

Choosing an option submits `/login <command id>` through the shared client command runtime. The popup closes after command admission and returns focus to the composer. The existing command lifecycle renders success or failure. A transport or malformed-command failure keeps the popup open through the popup shell's existing error path.

Direct typing remains available. The host command advertises `input: { hint: OAUTH_COMMAND_HINT }`, so the composer claims `/login ` for provider input instead of treating the line as an immediate bare execution. The host parser continues to accept `openai-codex`, `cursor`, `google-antigravity`, `antigravity`, and `google-gemini-cli`; empty input remains the host default for non-web callers.

## Architecture

### Host command

`packages/llm/llm-pi-ai/src/oauth-login.ts` adds the existing `OAUTH_COMMAND_HINT` to the `/login` definition. The handler, parser, provider table, and result messages remain unchanged.

### Shared command runtime

`packages/client/ui-commands/src/client/service.ts` exposes its existing command execution path through `CommandUiContract`. The method accepts a session and complete command line, retains the existing login-tab preparation, performs the remote execution, publishes the local `command/executed` event, and returns the existing `SubmitOutcome` semantics. It does not become a second command executor and does not move OAuth logic into the client.

`packages/client/ui-commands/src/client/contract.ts` documents the method's input, return value, transport rejection, browser-tab side effect for hosted OAuth lines, and lifecycle ownership. Existing callers continue to use the same internal behavior.

### Provider picker decoration

`packages/client/ui-model-selection/src/client/index.ts` registers a `CommandDecoration` for host command `login`. The decoration is available for ordinary session projections; the command directory still determines whether the host command exists, so addressed subagent sessions and deployments without `/login` do not receive a synthetic picker.

The decoration's option builder returns the three fixed hosted provider ids with localized labels and details. Its selection handler calls the shared command runtime with `/login ${option.id}` and throws only when the shared execution path rejects admission or transport, allowing the existing popup controller to preserve its retry state.

`packages/client/ui-model-selection/src/client/locales.ts` owns the English and Simplified Chinese picker labels and details as a typed key pair. No new CSS or popup component is required.

## Data flow and safety

1. The slash source loads the session's host command directory.
2. A bare `/login` menu pick or enter resolves the host row and the `login` decoration opens the shared popup.
3. The user selects a provider option.
4. The shared command runtime prepares or reuses the named blank OAuth tab under the selection gesture, then executes the complete host command line.
5. The host parses the provider id and runs the existing OAuth flow.
6. The host emits `commands/open-url`; the client accepts only HTTPS and navigates the prepared tab.
7. Successful credentials trigger the existing adapter refresh. The command lifecycle remains the only persistent result channel.

The picker emits only ids from its fixed option table. Direct input remains validated by `parseOAuthProvider`. The host's `loginInFlight` guard remains authoritative for overlapping logins. No secret or token enters client option data, command metadata, or UI copy.

## Verification

- Add a host command assertion that `/login` exposes `OAUTH_COMMAND_HINT` while direct command execution remains unchanged.
- Add command-runtime coverage for the exposed execution path, including login tab preparation and transport failure semantics.
- Add client model-selection coverage for option labels/ids, selected command submission, missing-host behavior, and effect disposal.
- Extend the real `apps/web` OAuth composition test to open the actual slash menu, select `/login`, select a provider, and verify the existing deterministic OAuth harness receives the selected provider command.
- Add a keyless browser snapshot scenario under `apps/web/tests/snapshots/` for the picker interaction.
- Run focused tests, typecheck, lint, and the relevant assembled web/docs gates; report only commands actually executed.

## Affected areas

- `packages/llm/llm-pi-ai/src/oauth-login.ts`
- `packages/client/ui-commands/src/client/contract.ts`
- `packages/client/ui-commands/src/client/service.ts`
- `packages/client/ui-model-selection/src/client/index.ts`
- `packages/client/ui-model-selection/src/client/locales.ts`
- Corresponding package tests, `apps/web` composition coverage, and one active Agent Note for the shipped decision.
