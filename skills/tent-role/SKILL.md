---
name: tent-role
description: "Operate a durable Tent Role across replaceable Sessions: resume Role identity, maintain Node context, dispatch and review Tasks, and remain accountable to the user. Apply tent-task while executing a concrete Task."
---

# tent-role

Use this Skill for a durable Role that must remain accountable across Sessions.
Also apply `tent-task` whenever the Role executes a concrete Task.

## Enter the exact Role

1. Run `tent role-init <role>` and read the returned Role id, prompt, system root,
   workspace, and Session binding.
2. Re-read the Role, relevant Nodes, active Tasks, exact TaskResults, Sessions,
   and Git facts. Never reconstruct authority from chat memory.
3. If Role or Session identity cannot be proven, stop and report the mismatch.

Role is durable responsibility; Session is replaceable execution. An Agent
Connection is machine availability only.

## Keep durable context small

Task plus TaskResult are the default durable record for one work unit. Promote
only cross-Task/cross-Session decisions, constraints, or accepted results into
an existing relevant writable Node. If none exists, report to the requester;
never create a process-only Node.

Load the canonical input with `tent task package <taskPath>`. It is the same
frozen Task/Context Card contract for every Harness. Incremental TaskInput/review
deltas remain persisted facts, never chat memory.

## Dispatch

- Direct Role work: `tent task claim [--node ...] --prompt ...`.
- Durable handoff: `tent task dispatch --target role:<roleId> ...`.
- Optional Tent-managed ACP execution: `tent task dispatch --target connection:<connectionId> ...`.
- Preserve exact ordered `nodeIds[]` roots and requester chain. Do not invent Role,
  Connection, Session, or Task facts.

Use SubGrok only through Tent-managed Task/Session lifecycle. Codex/native host
subagents stay inside the host: they do not enter Tent or create/impersonate a
Tent Task, Session, or TaskResult. Only the parent Role's already-formal Task and
TaskResult remain in Tent.

## Review

Read the exact current `resultId` from Task/Inbox projection. Review only when
requester authority belongs to this Role, interactions are settled, and Git
facts/checks are exact. Accept/reject never edits a Node or binds Output.

An accepted result may later inform an explicit update to an existing Node. For
an Output derivation, create the `type: output` Node, then use
`tent task bind-output <resultId> --output-node <nodeId> --actor <user|roleId>`.
Keep that Node-authority decision separate from review.

## Report to the user

Surface completed Tasks, current TaskResults, unresolved Decisions, blocked or
failed status detail, and durable Node changes. Do not turn routine host chat or
Session diagnostics into permanent Nodes.

Use [tent-task](../tent-task/SKILL.md) for execution details.
