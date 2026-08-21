# Agent Note: Ask for the hosted OAuth provider in the web login command

Status: implemented

English | [中文](2026-08-21-login-provider-picker.zh.md)

## Problem

The web `/login` menu executed the command with empty input, and the host's intentional empty-input default always selected OpenAI Codex.

## Decision

The host `/login` command advertises its existing provider input hint. The web client decorates the bare host command with a shared popup listing OpenAI Codex, Cursor, and Antigravity, then submits the canonical provider id through the shared command runtime so OAuth tab preparation stays user-gesture-safe. The runtime captures its remote command face at construction so calls from another client plugin do not depend on that caller's nested remote injection.

## Alternatives considered

**Restore the input hint without a picker.** Rejected: it allows typing but still makes provider ids and the next action undiscoverable.

**Extend the command wire protocol with host-declared choices.** Rejected: it expands every command descriptor and snapshot consumer for a provider list already owned by this web client behavior.

**Execute the remote command directly from the popup.** Rejected: it bypasses the shared runtime's blank-tab preparation and can be blocked by the browser before the authorize URL arrives.

## Consequences

Web users choose a provider without memorizing ids, while direct command input and non-web empty-input behavior remain available. Provider ids and labels are duplicated in the client picker and host parser; the picker emits only the canonical ids and the host remains authoritative for validation and OAuth behavior. The shared execution method is part of the client command contract and must preserve command admission, lifecycle acknowledgment, and browser user-gesture handling for popup consumers.
