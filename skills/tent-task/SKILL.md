---
name: tent-task
description: "Execute one concrete Tent (帷幄) Task from its persisted Context Card through scoped work, TaskInput/UserAsk handling, isolated Git lane, verification, explicit terminal outcome, and Delivery to the exact parent reviewer. Use for every Tent Task executor: durable Role, managed ACP Agent, external Agent, or user-started one-shot Agent. Also apply tent-role when the executor is a durable Role."
---

# tent-task

Apply this contract whenever executing a Tent Task. Every Tent Agent uses it while doing concrete work; a durable Role additionally applies `tent-role`.

Load unchanged Skill text once per Session. For later compatible Tasks, append only the new Context Card and incremental TaskInput/review delta; never repeat the stable prefix merely to remind the Agent.

## Resolve the authoritative Task

1. Work from the workspace root containing `.tent/`. CLI Task paths are relative to `.tent` (`temp/...`); direct file reads use `.tent/temp/...`.
2. Resolve the exact Task path/ID from managed binding, Context Card, or `tent task list`. Managed ACP is already claimed by Service; external/relay execution must claim before work and may bind its host Session.
3. Read the persisted envelope and Context Card: objective, frozen decisions, included/excluded scope, acceptance, Node/Task/Delivery/Git refs, `parentActor`, exact `reviewer`, assignee, context generation, Task delta digest, and execution lane.
4. Resolve Node refs by stable ID; treat any stored path as a refreshable hint. Node references are non-exclusive context, not tree locks or authority.
5. Fail loud to the parent when required context or a declared ref is missing. Never infer it from prompt memory, stale Session handles, old `claims`, or a manifest.

Read [references/paths.md](references/paths.md) for path/lane details, [references/session-boundaries.md](references/session-boundaries.md) for managed/external recovery, and [references/task-cli.md](references/task-cli.md) only for commands needed by the current responsibility.

## Work inside the recorded lane

- Use the envelope worktree and branch when present; do not invent a lane. Preserve unrelated/pre-existing dirty work and never reset or clean it away.
- Start from recorded `baseCommit`. Ordinary executors produce only linear Task commits and must not merge or rebase the parent, target, or dependency branches. Parent/Service owns integration. Core rejects unauthorized merge/foreign ancestry at Delivery.
- Stay within Context Card scope and acceptance. Ask the parent before changing product intent, authority, irreversible scope, or explicit exclusions.
- Implement and test in proportion to risk. Commit code work in the Task lane; never commit `.tent/`.

## Handle Task communication

- A2U: use `tent task ask-user` for a required user decision, then wait through the supported lifecycle.
- U2A: consume and acknowledge scoped TaskInputs with `task-input list|get|ack` (managed Sessions receive them through Service injection).
- Never send input to the same Task as its executor. The user or parent dispatcher writes TaskInput.
- A blocker, question, or unfinished report is not a successful Delivery.

## Finish with one structured outcome

Lead the terminal report with exactly one:

- `outcome: delivered` — acceptance is met and stable evidence is ready;
- `outcome: blocked` — an external state change is required;
- `outcome: needs-input` — a specific decision/answer is required.

Managed Service may publish a ready Delivery only for `delivered`, after the turn, TaskInputs, worktree, commits, and history are settled. Use `ask-user`/waiting for questions; do not end with a question and expect Core to reinterpret it.

## Deliver to the exact parent

- Managed ACP: Service owns claim and Delivery publication; return the structured outcome and evidence only when ready to end the turn.
- External/relay: on `delivered`, run `tent task deliver` with an honest summary and exact commit SHAs. Chat text alone is not Delivery.
- Delivery is never acceptance. The executor never accepts its own Delivery.
- Use persisted `parentActor` and exact `reviewer`; never infer reviewer from history or identity labels. A downstream executor always uses review-to-parent and cannot elevate to `bypass` or `agent-decide`.
- A durable Role executing its own user-facing Task follows that Role's configured three-state policy through `tent-role`.

Before `delivered`, ensure all TaskInputs are settled, the lane is clean as required, and reported commits/evidence match reality. Include user-confirmed decisions in the report; persist them directly only when also acting as the authorized Role.

After terminal settle, Core may automatically reclaim a clean, integrated agentProfile Task worktree. Do not force cleanup, delete audit records, or continue writing after Delivery; dirty, busy, unintegrated, ambiguous, external, and durable Role lanes remain fail-closed.
