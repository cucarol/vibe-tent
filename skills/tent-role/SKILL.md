---
name: tent-role
description: "Maintain and operate a durable Tent (帷幄) Role that is accountable to the user: enter or resume Role identity, apply its prompt and long-term context, use currently authorized downstream Agents, reuse Sessions only through Core-supported operations, dispatch work, review downstream Deliveries, preserve decisions, and deliver to the user. Combine with tent-task whenever the Role is also executing a concrete Task."
---

# tent-role

Apply this contract whenever the Agent is acting as a durable Role. When the Role owns or executes a concrete Task, also apply `tent-task`; do not duplicate its execution protocol here.

## Resume the Role from persisted state

1. Work from the real workspace root containing `.tent/`; never resolve Tent state as `<workspace>/temp`.
2. Read `.tent/RULES.md`, `.tent/temp/<role>/init.md`, and the persisted Role projection. Generate missing Role initialization with `tent role-init <role>`; never fabricate it.
3. For an external host fallback, bind with `tent agent enter --role <role>`, inspect with `tent agent status`, and unbind with `tent agent leave`. `leave` never delivers or accepts work. Managed Role bootstrap remains owned by the Service/adapter.
4. Re-query current Task, Delivery, Session, and Git/worktree state after a restart, compaction, replacement, or handoff.
5. Treat the Role prompt and durable Tent Nodes as long-lived context. The user and the Role jointly maintain the Role prompt. The Role may update it through an authorized mutation when the change preserves confirmed intent; changes to responsibility, values, or user-confirmed boundaries require user confirmation.
6. Maintain continuity across replaceable Sessions. A Session is an execution instance, not the Role identity.

Never invent a Role prompt, roster entry, Task, Delivery, or Session state. Persisted Tent projections and Git/worktree state are the facts.

## Coordinate work

- Understand the user’s intent, maintain the relevant Nodes, decide what the Role should do, and split only when separate work units are useful.
- Use downstream Agents when the Role prompt or task characteristics call for them; do not make the user repeatedly remind the Role to use available authorized Agents.
- Keep architecture, product judgment, acceptance decisions, and irreversible choices with the Role unless the user explicitly delegates them.
- Apply `tent-task` when personally executing a Task.

## Use downstream Agents

Use only the downstream-Agent roster and reusable-Session fields actually returned by Core. Never invent an `agentId`, roster entry, sub-key, lease, or compatibility generation.

When Core exposes the V0.2 logical roster contract, treat `agentId` as the stable worker identity and AgentProfile as machine-local launch resolution; roster membership is then the standing Role authorization. Until that contract is exposed, obey the current Service A2A policy and `allowedProfiles` gates exactly as returned.

Reuse a downstream Session only through a Core operation that confirms it is idle, compatible, and exclusively bound. If Core exposes no such operation, create or start through the existing Task lifecycle instead of inferring reuse from history. Never attach two active Tasks to one execution Session, mix worktrees, or trade correctness for a cache hit.

## Dispatch and review downstream work

- Use the persisted Task’s current `asSub`, `dispatchedBy`, and `deliveryPolicy` fields; Core remains authoritative for review.
- As a behavior contract, a downstream executor must never request or elevate `bypass` or `agent-decide`. If the persisted Task contradicts the intended review-to-parent model, fail loudly to the dispatcher instead of assuming Core already derived a parent reviewer.
- Never accept a Delivery submitted by the same executor.
- Inspect the actual diff, commits, tests, Task state, and Delivery evidence. Accept, reject, request correction, replace the failed Session, or continue the same Task based on persisted facts.
- Do not mix unrelated downstream diffs during integration.

## Remain accountable to the user

- Preserve user-confirmed decisions in the nearest relevant Tent Node.
- Report meaningful progress, blockers, and remaining risk without forwarding raw downstream output as judgment.
- For the Role’s own user-facing Delivery, obey the configured `review | bypass | agent-decide` policy. Do not grant or elevate that policy yourself.
- `agent-decide` chooses integration or user review; it never allows the Role to impersonate an independent reviewer.

## Boundaries

- Core enforces the authorization and review fields it currently exposes, Session state, Delivery transitions, and integration authority. Capability-gated target semantics above are not claims that the current runtime already implements them.
- This Skill does not define Task claim, worktree, test, TaskInput, terminal-outcome, or Delivery wire details; `tent-task` owns them.
- Do not create a new Core entity or mutually exclusive Session mode merely to represent this Skill composition.
