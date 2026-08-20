# Agent Note: Keep Cursor AgentService Run wire-compatible

Status: implemented

English | [中文](2026-08-20-cursor-agentservice-wire-compatibility.zh.md)

## Problem

Cursor OAuth login already uses the current `loginDeepControl` and token exchange flow, but the hosted `AgentService/Run` endpoint is a bidirectional Connect RPC. The adapter sent a bare `AgentRunRequest`, left no client-frame path after the first request, and did not answer server interaction queries. Cursor could therefore return only heartbeat and turn-ended updates, producing `CURSOR_EMPTY_STREAM` even when login succeeded.

The fallback catalog also retains legacy bare Grok ids while current Cursor wire ids namespace those SKUs under `cursor-grok` and select effort-specific variants. Sending the display id unchanged can fail independently of OAuth.

## Decision

`encodeAgentRunClientMessage` wraps `AgentRunRequest` in `AgentClientMessage.runRequest` field 1. `connectStream` writes the initial Connect frame without ending request input and exposes an `onOpen` writer for later client frames; unary calls keep their existing end-on-send behavior.

The hosted stream sends `AgentClientMessage.clientHeartbeat` field 7 every five seconds while the Run remains open. It records top-level checkpoint field 3, handles top-level interaction-query field 7, and sends `AgentClientMessage.interactionResponse` field 6 for supported hosted permission queries. Web-search and fetch queries are approved, unsupported interactive, mode, and plan queries are rejected, and VM setup queries remain unanswered because the client has no truthful setup result.

The client advertises the current Cursor CLI version `cli-2026.07.23-e383d2b`. Bare `grok-4.5` and `grok-4.6` ids are translated to `cursor-grok` wire ids, with an effort-specific suffix when thinking is enabled; already current ids and Composer ids remain unchanged. OAuth, tools, selected images, checkpoints, and the non-retryable `CURSOR_EMPTY_STREAM` classification remain owned by their existing paths.

## Alternatives considered

**Change the Cursor OAuth flow.** Rejected because the PKCE login, poll, and refresh endpoints already match the current hosted flow; the failure is in Run transport and message handling.

**Continue sending a bare `AgentRunRequest`.** Rejected because the current server expects the `AgentClientMessage` oneof envelope and otherwise may close with heartbeat-only output.

**End the HTTP/2 request after the initial frame.** Rejected because Run is bidirectional and the server can require client heartbeats, interaction responses, and other client messages before it finishes.

**Automatically approve VM setup queries.** Rejected because this client cannot truthfully report a VM or workspace setup result; leaving that query unanswered avoids claiming capabilities it does not provide.

**Port the entire community provider, including conversation blobs.** Deferred because the targeted wire changes solve the framing and liveness gap without replacing Harness history, tool, image, checkpoint, and error abstractions. Full conversation-state blob handling remains a separate verified design.

## Consequences

Cursor Run requests now keep a live client stream and can satisfy the server messages needed for hosted permissions and liveness. The heartbeat timer is cleared on every stream exit, including abort and transport failure. A provider that emits only heartbeat and turn-ended frames still fails with `CURSOR_EMPTY_STREAM`; the transport now distinguishes an empty successful wire exchange from an actually usable completion but does not invent assistant content.

The adapter remains coupled to an unofficial service and a published CLI version string. Cursor protocol changes may require another targeted update. Legacy bare Grok selections continue to work through wire-id translation, while live catalog ids remain authoritative when discovery supplies them.

## Testing

`packages/llm/llm-pi-ai/tests/cursor.spec.ts` pins Connect open-stream framing and additional client frames, the AgentClientMessage Run envelope, heartbeat and interaction-response encoding, supported interaction-query responses, legacy Grok wire-id translation, checkpoint/tool/image requests, and heartbeat-only classification. Package typechecking covers the new callback and protocol helpers. The runtime-health note remains responsible for discovery and empty-stream user-facing classification.
