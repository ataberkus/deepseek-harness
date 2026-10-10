---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-usage-cost-prompt-enhance-source

English | [中文](2026-10-10-usage-cost-prompt-enhance-source.zh.md)

## Summary

Adds the optional adapter-reported costUsd field to persisted token usage and the attribution-only dsh-prompt-enhance message source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-usage-cost-prompt-enhance-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "aa8e45404220b59a49762f2932337a6227607d3c8afff4b2e1910e38f8e23ea8"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "39aea4918333186466d0ef13e5e330d432c2e5f679709684037119207b9ec39a"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "b33384cad1bb37fde7462b897a6147555998e990aeff8240758b606bee2ba568"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "b2200ff436821da1fac464f76fa7e4b90dd3b4def5a5aa906562850dde0b1314"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "00d8c1365c96ef8a61625d608a205565d4f9c3711a37a54463d96e3e9ac146aa"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "f4d5a3bf28376003c070ba5f8a10e1c1b9f8c4a8382b4e2ddf88cfa62022e1da"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "31c248679a1c8288dd0fd3f70bc0ce83b25752e41e320b846500d437200e2ce4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. costUsd is optional and absent when an adapter reports no spend; readers fold a missing value as zero. The dsh-prompt-enhance kind belongs to the prompt-enhancement request, which is never appended to a Session log; readers preserve an unknown kind without the producer.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/token-meter packages/experimental/prompt-enhance packages/client/ui-chat/tests/chat-stats.client.spec.tsx: all tests passed.

<a id="dev-note"></a>
## Dev Note

None.
