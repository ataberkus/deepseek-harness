# Agent Note: Restore repository quality gates

Status: implemented

English | [中文](2026-08-21-repository-quality-gates.zh.md)

## Problem

The repository quality gates reported TypeScript and lint diagnostics, stale generated graph and Cordis catalog outputs, wrong-locale links in implemented notes, hard-wrapped package README paragraphs, and an implemented Agent Note without the required alternatives section.

## Decision

The affected source and test contracts use the current strict TypeScript and lint rules. Generated graph and Cordis catalog documents are regenerated from their source programs. Bilingual links and consistency records are corrected at their owning documents, README paragraph boundaries are restored, and the incomplete Agent Note records its rejected alternatives.

## Alternatives considered

**Disable or narrow the lint and typecheck rules.** Rejected: the diagnostics identify real type-contract, promise, unsafe-data, and dead-condition defects across source and tests.

**Suppress the documentation gates.** Rejected: stale generated documents and wrong-locale links make the repository's reference graph and translation checks unreliable.

**Repair only the login-picker files.** Rejected: the request covers the repository gates, and leaving unrelated diagnostics would keep the same checks red after the feature merge.

## Consequences

The repository lint, typecheck, and documentation gates share one consistent source and generated-document state. Future changes to event declarations, Cordis surfaces, or bilingual notes must run the owning generators and pairing record update instead of editing derived output alone.
