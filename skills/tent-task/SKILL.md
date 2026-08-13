---
name: tent-task
description: "Execute one Tent Task from persisted context through scoped work, verification, formal TaskResult submission, and exact requester review."
---

# tent-task

Use this Skill for one concrete Task. A durable Role executor also applies
`tent-role`.

## Load the contract

1. Read the exact TaskRecord and Context Card before editing.
2. Verify `prompt`, work/context Node ids, requester, WorkspaceLane, Task state,
   and current Session binding.
3. Consume each TaskInput or review delta once through the formal lifecycle.
4. Work only in the recorded workspace/worktree and preserve unrelated changes.

The host injects persisted Context Card v2 plus incremental input/review deltas.
These are authoritative persisted facts, never chat memory. Node bodies are
context; TaskRecord defines the work; TaskResult is the formal submission.

## Interactions

- Use `tent task request-decision` when user choice is required.
- Never send TaskInput to the same Task you are currently executing; the
  dispatcher sends cross-Task input.
- TaskInput is exact-Task and at-most-once. Never automatically reinject an
  uncertain handoff; external poll/ack remains explicit.

## Execute and verify

Respect exact work Node occupation, Git lane, base/target, scope, and irreversible
boundaries. Run proportionate tests and record exact failures. A zero-commit
TaskResult is valid when the formal result is real but no commit is required.

For managed ACP, natural non-empty final report content is submitted directly as
a TaskResult after required settle gates. It needs no outcome wrapper.
`outcome: blocked` parks the Task with bounded status detail. Needs-input uses a
DecisionRequest. Publication failure keeps the durable report draft and exposes
bounded status detail; it never discards the report or re-prompts the provider.

## Submit to the requester

```text
tent task submit <taskPath> --report <text>|- [--commits sha,sha] [--decision integrate|request-review]
```

The report and commits must be honest and complete. Every commit belongs to the
exact Task lane. A fresh logical submission creates a new TaskResult. An exact
retry must match every immutable candidate field; it converges to the persisted
candidate and `resultId` rather than creating another Result. In `review-required`, the
executor never self-accepts; `auto-accept` and `agent-decide` follow the frozen
Task mode, with `agent-decide` requiring `integrate` or `request-review`. Exact
requester authority reviews the current `resultId` when review is required.

Task and TaskResult are the default durable work record. After acceptance,
promote only cross-Task/cross-Session durable facts into an existing relevant
writable Node. If none exists, report to requester; never create a process-only
Node. Node promotion is optional and never a prerequisite for submission.

## Host Session boundary

- `tent session status` inspects the exact binding and incomplete Tasks.
- `tent session leave` ends the exact Tent host binding, reports incomplete
  Tasks, and never submits or reviews a TaskResult. For an external/native host,
  leave does not claim to stop the user's agent process.

See [task CLI](references/task-cli.md), [paths](references/paths.md), and
[Session boundaries](references/session-boundaries.md).
