---
name: tent-task
description: "Execute one Tent Task through persisted context, scoped work, verification, final report, and Delivery."
---

# tent-task

Use this contract for every concrete Tent Task. Load stable Skill text once per
compatible `contextGeneration`. The host injects each persisted Context Card v2
plus incremental TaskInput/review deltas; treat them as authoritative persisted
facts, never remembered chat context.

## Resolve the authoritative Task

1. Work from the workspace root containing `.tent/`; CLI `taskPath` is relative
   to `.tent`, while direct reads use `.tent/temp/...`.
2. Resolve exact Task path/ID from managed binding, Context Card, or `task list`.
   A Role claims its own work with `task claim`; managed Connection Tasks arrive
   claimed. Neither is downstream dispatch.
3. Read prompt, sole `parentActor`, optional Role/Session, WorkspaceLane, Node
   snapshots, and optional `contextGeneration` from the persisted envelope/card.
4. Resolve Context Card v2 work/context Node refs by stable id; paths are
   refreshable hints. Work refs are occupied; context refs remain shared
   read-only. Related Nodes are read-only unless included.
5. Fail loud when required context or a declared ref is missing. Never infer it
   from prompt memory, a stale Session, an internal field, or a manifest.

The envelope/card define the Task; Node bodies are context and Delivery is a
separate review record. Read only the needed reference:
[paths.md](references/paths.md), [session-boundaries.md](references/session-boundaries.md),
or [task-cli.md](references/task-cli.md).

## Work in the recorded lane

- Use the persisted worktree and branch; never invent a lane. Preserve unrelated
  or pre-existing dirty work and never reset or clean it away.
- Role lane/base is captured at first claim; Service establishes managed lanes.
  Re-read after claim/start; never guess or backfill missing facts.
- Produce only linear Task commits. Parent/Service owns integration; do not
  merge/rebase parent, target, or dependency history.
- Pure Tent or non-code work may have no lane or commits. Do not invent either.
- Verify in proportion to risk. Record process exit code and authoritative
  runner pass/fail counts; tailed, truncated, or grepped output is not proof.

## Handle Task communication

- `workspace.collaboration` is read-only; act through exact Delivery/Decision
  ids, never a TaskInput Inbox.
- A2U: use `tent task request-decision` for a required authority decision, then
  wait through the supported lifecycle. The frozen target responds through
  `tent task decision`; never supply an actor selector.
- U2A: consume exact-Task input through `tent task task-input list|get|ack`.
  Managed Service injects only retryable `pending|failed` rows.
- `pending`, `processing`, `failed`, and `uncertain` all block Delivery.
  `uncertain` is at-most-once ambiguity: never retry or reinject it. Successful
  authorized acknowledgement schedules exactly one retry of the durable report
  draft, never the provider prompt.
- Never send input to the same Task as its executor. The user or parent
  dispatcher writes TaskInput.
- A blocker, unanswered question, or unfinished report is not successful work.

## Finish with an honest final report

A natural, non-empty managed ACP final report is deliverable by default after
required settle gates. Service preserves every non-empty final
report as a durable draft first; write useful prose with no outcome wrapper.

Optional leading controls park instead of deliver:

- `outcome: blocked` — an external state change is required;
- `outcome: needs-input` — a specific decision or answer is required.

Only `blocked` and `needs-input` park. Invalid control text never discards a
valid report; empty output never invents success. A parked control return is
visible through bounded Task `lastReturn`; pre-publication failure is `failed`,
while provider/Session unavailability remains a Session diagnostic and
recoverable park. Use DecisionRequest for a real authority question.

## Deliver to the exact parent

- Managed ACP: Service owns claim, durable report draft, and Delivery
  publication. Return one honest final report only when the Task is ready.
- Durable Role execution: call `tent task deliver` with an honest summary and
  optional exact commit SHAs. Chat text alone is not Delivery.
- Every reported SHA must belong to this Task's lane. Ready Delivery snapshots
  target head; `TARGET_MOVED` requires reject/resume and re-delivery.
- Delivery is never acceptance. The executor never accepts its own Delivery.
- Use persisted `parentActor`. Downstream work cannot change frozen
  `acceptMode` or self-review; a durable Role follows it through `tent-role`.

Before Delivery, settle interactions, execution, lane, and checks.
Task and Delivery report are the default durable record. Promote only decisions,
facts, and accepted results that must survive across Tasks or Sessions into an
existing relevant writable Node. If none exists, report to the parent or user;
never create a process-only Node for this Task.

## Recovery and cleanup

Replace a failed Session only through Service eligibility and exact Task CAS;
never hand-bind a process or reuse remembered provider state. Stop obsolete work
through `task cancel` or `task interrupt`, not PID kill or envelope edits.

Core may reclaim only a clean, integrated, unambiguous managed worktree. Never
manually prune, follow junction targets, delete audit records, or write after
Delivery; every other lane remains fail-closed.

Host lifecycle commands are formal boundaries:

- `tent session status [sessionId|externalKey] --json` inspects the persisted
  binding and incomplete Tasks; it does not infer completion.
- `tent session leave [sessionId|externalKey] --json` ends that exact Tent host
  binding and reports incomplete Tasks. Leave never delivers or accepts a Task,
  and does not claim to stop an external/native Agent process.
