---
name: tent-task
description: "Execute one concrete Tent (帷幄) Task from its persisted Context Card through scoped work, interaction handling, the recorded Git lane, verification, an honest final report, and Delivery to the exact parent reviewer. Use for durable Roles, managed ACP Sessions, external Agents, and user-started one-shot work; also apply tent-role when the executor is a durable Role."
---

# tent-task

Use this contract for every concrete Tent Task. Load stable Skill text once per
compatible `contextGeneration`; later Tasks append only their Context Card and
incremental input/review delta.

## Resolve the authoritative Task

1. Work from the workspace root containing `.tent/`. CLI `taskPath` is relative
   to `.tent` (`temp/...`); direct reads use `.tent/temp/...`.
2. Resolve the exact Task path/ID from managed binding, Context Card, or
   `tent task list`. Managed ACP is already claimed; external execution claims
   before work and may bind its external Session.
3. Read objective, frozen decisions, scope, acceptance, refs, `parentActor`,
   exact `reviewer`, assignee, generation/digest, and WorkspaceLane.
4. Resolve `refs.nodes[]` by stable id; paths are refreshable hints. Those exact
   refs are occupied write context. Related Nodes are read-only unless included.
5. Fail loud when required context or a declared ref is missing. Never infer it
   from prompt memory, a stale Session, an internal field, or a manifest.

The envelope and Context Card define the Task. Node bodies provide durable
context; Delivery is a separate review record. Read only the needed reference:
[paths.md](references/paths.md), [session-boundaries.md](references/session-boundaries.md),
or [task-cli.md](references/task-cli.md).

## Work in the recorded lane

- Use the persisted worktree and branch; never invent a lane. Preserve unrelated
  or pre-existing dirty work and never reset or clean it away.
- Role lane/base is captured once at first claim; a route Task lane is
  established by Service. Re-read after claim/start. Missing required code-lane
  facts fail loud; never guess or silently backfill them.
- Produce only linear Task commits. Do not merge/rebase parent, target, or
  dependency history; parent/Service owns integration and rejects foreign
  ancestry.
- Pure Tent or non-code work may have no lane or commits. Do not invent either.
- Verify in proportion to risk. Record process exit code and authoritative
  runner pass/fail counts; tailed, truncated, or grepped output is not proof.

## Handle Task communication

- A2U: use `tent task ask-user` for a required user decision, then wait through
  the supported lifecycle.
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
acceptance and settle gates. Service first preserves every non-empty final
report as a durable draft; preserve useful prose and add no parsing wrapper.

Optional leading controls park instead of deliver:

- `outcome: blocked` — an external state change is required;
- `outcome: needs-input` — a specific decision or answer is required.

`outcome: delivered` remains accepted but is redundant. Missing, unknown, or
malformed control text never discards an otherwise valid report. Empty output
never invents success. Use UserAsk for a real question.

## Deliver to the exact parent

- Managed ACP: Service owns claim, durable report draft, and Delivery
  publication. Return one honest final report only when the Task is ready.
- External/relay: call `tent task deliver` with an honest summary and optional
  exact commit SHAs. Chat text alone is not Delivery.
- Every reported SHA must belong to this Task's lane. Ready Delivery snapshots
  target head; `TARGET_MOVED` requires reject/resume and re-delivery.
- Delivery is never acceptance. The executor never accepts its own Delivery.
- Use persisted parent/reviewer. Downstream work cannot elevate `bypass`,
  `agent-decide`, or self-review; a durable Role follows its own user-facing
  policy through `tent-role`.

Before Delivery, settle TaskInputs/UserAsks, turn and Session state, worktree,
commits, and checks. Ensure confirmed decisions are present in the report and,
when acting as the authorized Role, promoted to the relevant Node.

## Recovery and cleanup

Replace a failed Session only through Service eligibility and exact Task CAS;
never hand-bind a process or reuse remembered provider state. Stop obsolete work
through `task cancel` or `task interrupt`, not PID kill or envelope edits.

After terminal settle, Core may reclaim only a clean, integrated, unambiguous
route Task worktree. Never manually prune worktrees, follow junction targets,
delete audit records, or continue writing after Delivery. Dirty, busy,
unintegrated, external, and durable Role lanes remain fail-closed.
