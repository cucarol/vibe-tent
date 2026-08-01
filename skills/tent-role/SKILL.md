---
name: tent-role
description: "Operate a durable Tent (帷幄) Role across replaceable Sessions: resume Role identity and prompt, maintain Node context, dispatch formal work to Roles or machine Settings routes, review Tasks and Deliveries, preserve decisions, and remain accountable to the user. Also apply tent-task while executing a concrete Task."
---

# tent-role

Use this contract whenever acting as a durable Role. Also apply `tent-task`
while owning or executing a concrete Task.

## Resume from persisted facts

1. Work from the workspace root containing `.tent/`; operational paths are
   relative to that system root, never `<workspace>/temp`.
2. Read workspace `AGENTS.md`, `.tent/temp/<role>/init.md`, the Role projection,
   and relevant Nodes. If init is missing, run `tent role-init <role>`; do not
   fabricate it.
3. For external-host fallback, use `tent session enter --role <role>`, inspect
   with `tent session status`, and unbind with `tent session leave`. Managed
   bootstrap belongs to Service.
4. After restart, compaction, handoff, or Session recovery, re-query the exact
   Task, Delivery, Session, Context Card, and Git facts.
5. Treat the Role prompt as jointly maintained. Ask before changing durable
   responsibility, values, or unresolved product decisions.

Never invent a Role prompt, route availability, Task, Delivery, Session
binding, compatibility result, or persisted state.

## Maintain Node-first context

- Node is durable product context; Task is one attempt. Promote confirmed
  decisions, facts, open questions, provenance, and accepted results into the
  nearest relevant Node instead of relying on chat history.
- Give each Task complete objective, frozen decisions, include/exclude scope,
  acceptance, and exact Node/Task/Delivery/Git refs.
- Task `nodeIds[]` are its occupied write context. Parent, child, relation, and
  link expansion is read-only unless explicitly included.
- Keep irreversible product choices and final user judgment with this Role
  unless the user explicitly delegates them.

## Claim own work and dispatch downstream

- Use `tent task claim --node <nodeId> … --prompt <text>|-` to create and
  immediately claim this Role's own execution Task. Use `--from-task
  <taskPath>` only when inheriting that exact active Task's persisted
  responsibility chain. This form has no target and is not delegation.
- Use `tent task dispatch --target role:<roleIdOrName> --node <nodeId> …
  --prompt <text>|-` only for a queued handoff to another durable Role.
- Use `tent task dispatch --target route:<routeId> --node <nodeId> …
  --prompt <text>|-` only for downstream temporary managed ACP work through
  machine Settings.
- A route resolves provider/model/endpoint/credential metadata. Never read
  private registry files or copy secrets into a Node, Task, or report.
- Route dispatch does not register a persistent worker or create another Role.
  Reusable Session bookmarks are not a current public workflow.
- Caller authority and parent lane are derived by Tent. Do not recreate
  internal assignee, reviewer, or delivery-policy knobs.

Resume a managed Session for its bound Task or durable Role only when Core
proves the same provider conversation is recoverable and route/adapter,
workspace, Skills, context generation, lane, settled turn, interactions,
Delivery, and exclusive idle lease all match. Otherwise use explicit Task
recovery or dispatch new work; never present fresh context as the old Session.

## Review downstream Delivery

- Trust persisted `parentActor` and exact `reviewer`. Downstream executors use
  review-to-parent, never self-accept or elevate Role-to-user policy.
- Inspect the real diff, commit ancestry, target-head snapshot, checks, Task
  interactions, Session settle state, and Delivery record.
- `TARGET_MOVED` requires reject/resume and a new Delivery. Never bypass the
  snapshot, hand-edit state, or merge unrelated lanes.
- Use `task.replaceSession` only for the same eligible Task while the turn is
  idle. A changed work contract requires a new Task.

## Preserve cooperative continuity

For a planned Role Session transfer, an optional bounded checkpoint may record
the current objective, next action, and essential Node/Task/Delivery/Git refs.
Use `tent role-checkpoint set|show|clear`. It is advisory dynamic-tail context,
not a transcript or replacement for persisted facts.

## Deliver to the user

- Follow this Role's persisted `review | bypass | agent-decide` user-facing
  policy without elevating it.
- `agent-decide` chooses integration or user review; it does not impersonate an
  independent reviewer.
- Report judgment, evidence, remaining risk, and real blockers rather than
  forwarding raw downstream output.

`tent-task` owns Task lane execution, TaskInput/UserAsk, verification, final
report, and Delivery wire. Do not create a second lifecycle for delegation or
Session continuity.
