---
name: grill-me
description: Grill the user relentlessly about a plan, design, or idea, one question at a time with a recommended answer, until every decision is settled. Invoke with /grill-me to stress-test your thinking before any implementation.
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Do not implement, edit files, or write code during the session. Map the plan as a **design tree**: every decision branches into the decisions that hang off it.

The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask exactly **one** frontier question per turn, choosing the one that unblocks the most downstream decisions, and give your recommended answer. Then wait for the user's answer before asking the next question.

Format each question like so:

```
❓ **Q<n>** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer. Challenge assumptions, probe edge cases and failure modes, and push back when an answer conflicts with an earlier decision or leaves a gap.

Each answer reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier before the next question.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, documentation), look it up yourself or delegate the lookup to a subagent; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so ask a different frontier question while it runs. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Summarize the settled decisions, and do not act on them until the user confirms you have reached a shared understanding.
