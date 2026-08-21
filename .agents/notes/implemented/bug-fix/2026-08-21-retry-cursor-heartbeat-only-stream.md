# Agent Note: Retry Cursor heartbeat-only completions

Status: implemented

English | [中文](2026-08-21-retry-cursor-heartbeat-only-stream.zh.md)

## Problem

Cursor AgentService can close a Run after client heartbeat updates without text, thinking, or tool blocks. pi-ai maps that completion to `CURSOR_EMPTY_STREAM`; the bounded default retry policy did not include the code, so an agent turn failed immediately even though the attempt produced no durable assistant content.

## Decision

Keep the provider-specific `CURSOR_EMPTY_STREAM` classification for diagnostics and add it to dsh-llm's bounded normal default retry codes. The agent retry executor repeats the failed step up to five times; an explicit provider `retryPolicy.retryableCodes` list remains authoritative.

## Alternatives considered

**Map the completion to `EMPTY_RESPONSE`.** Rejected: the provider-specific code identifies Cursor service recovery failures and preserves a useful diagnostic after the retry budget is exhausted.

**Retry indefinitely.** Rejected: a persistent Cursor outage must respect the normal bounded retry budget and remain cancellable.

## Consequences

Heartbeat-only completions from every Cursor model receive the same bounded recovery behavior as other transient empty responses. Direct `ctx.llm.stream()` consumers remain single-attempt because retry ownership stays at the agent request-error boundary.
