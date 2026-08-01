---
name: tent-role
description: "Operate a durable Tent (帷幄) Role that remains accountable to the user across replaceable Sessions: resume Role identity and prompt, maintain long-term context, use the Role's authorized Agent roster, reuse compatible downstream Sessions through Core, dispatch and review Tasks, preserve decisions, and deliver to the user. Use whenever an Agent acts as a persistent Tent Role; also apply tent-task while that Role executes a concrete Task."
---

# tent-role

Apply this contract whenever acting as a durable Role. Also apply `tent-task` while owning or executing a concrete Task; every Tent Task executor uses that shared execution contract.

## Resume from persisted facts

1. Work from the workspace root containing `.tent/`; never resolve Tent state as `<workspace>/temp`.
2. Read workspace-root `AGENTS.md` when present, `.tent/temp/<role>/init.md`, the Role projection, and relevant durable Nodes. Generate a missing init with `tent role-init <role>`; never fabricate it.
3. For an external host fallback, bind with `tent session enter --role <role>`, inspect with `tent session status`, and unbind with `tent session leave`. Managed bootstrap belongs to Service/adapter.
4. Re-query Task, Delivery, Session, Context Card, and Git/worktree state after restart, compaction, replacement, or handoff. A Session is replaceable execution state, not the Role identity.
5. Treat the Role prompt as jointly maintained by user and Role. Update it through an authorized mutation when preserving confirmed intent; ask before changing responsibility, values, or confirmed boundaries.

Never invent a Role prompt, roster entry, Task, Delivery, Session, compatibility result, or persisted state.

## Coordinate work

- Understand user intent, maintain relevant Nodes, make product/architecture judgments, and split work only when separate delivery units help.
- Use authorized downstream Agents when the Role prompt or Task calls for them; do not require repeated user reminders.
- Keep irreversible choices and final acceptance judgment with the Role unless the user explicitly delegates them.
- Preserve user-confirmed decisions in the nearest relevant durable Node.

## Use the Role roster and reusable Sessions

- Treat `agentId` as the stable logical worker/capability and AgentProfile as machine-local provider/model/credential launch resolution. Roster membership is the user's standing authorization for this Role; do not add per-Session allow/ask/deny.
- Query the current Role with `tent role show <role>` and logical workers with `tent agent list|get`; use the returned roster order and `ready | missing-definition | missing-profile` projection. Never read or infer machine registry files directly.
- Dispatch a roster worker by `agentId`; out-of-roster dispatch must fail loud. Never substitute a similarly named Profile or invent roster membership.
- Reuse a downstream Session only when Core confirms the same workspace, parent Role, `agentId`, purpose, Skill set, profile/adapter, context generation, and compatible lane, plus an exclusive idle lease with no busy turn, pending input, or unresolved Delivery. Otherwise create a fresh Session through Task lifecycle.
- Keep stable Skill/project/Role context cacheable. Append only the current Task Context Card and incremental TaskInput/review delta. A changed compatibility generation requires a new Session generation; never trade correctness for a cache hit.

## Dispatch and review Tasks

- Give every downstream Task a complete Context Card: objective, frozen decisions, included and excluded scope, acceptance requirements, and durable Node/Task/Delivery/Git refs. Role execution base is deferred to first claim; a peer Agent lane is deferred to managed start, while a Role-dispatched subordinate Agent lane may already exist at dispatch. Missing critical context must fail loud to this Role, not be guessed by the executor.
- Use `tent task dispatch --target agent:<agentId> --node <nodeId> … --prompt <text>|-` for managed downstream work. Use `--target role:<roleIdOrName>` for a queued durable Role handoff. Caller authority and the parent Role lane are derived by Tent; never expose or recreate Profile, `asSub`, reviewer, or delivery-policy knobs.
- Trust persisted `parentActor` and exact `reviewer`. A downstream Task Agent always delivers for review by its parent actor; it has no `bypass`, `agent-decide`, or self-accept path.
- Inspect the real diff, reported commit lane membership, target-head snapshot, tests, TaskInputs, Session settle state, and Delivery evidence. `TARGET_MOVED` requires reject/resume and a new Delivery against the current target; never bypass the snapshot or hand-edit persisted state.
- Replace a failed Session only through Service eligibility for the same Task and only while its turn is idle. When the user wants a new Task or context contract, retire the old Task through lifecycle and dispatch fresh instead of replacing it.
- Keep unrelated downstream diffs and Task lanes separate. Integration authority belongs to the recorded parent/Service, not the executor.

## Preserve cooperative continuity

For a planned Role Session transfer, optionally store a short continuation note with:

- current objective and next action;
- Node, Task, Delivery, and Git pointers needed to resume;
- no copied history or replacement for authoritative state.

Use `tent role-checkpoint set|show|clear`. A checkpoint is bounded advisory dynamic-tail context only. Missing or corrupt content is fail-open; abnormal recovery must succeed from persisted Tent and Git facts without it.

## Deliver to the user

- For the Role's own user-facing Delivery, obey its configured `review | bypass | agent-decide` policy without elevating it.
- `agent-decide` chooses direct integration or user review; it never impersonates an independent reviewer.
- Report judgment, evidence, remaining risk, and meaningful blockers rather than forwarding raw downstream output.

## Boundary

`tent-task` owns Context Card consumption, workspace-lane execution, TaskInput/UserAsk, tests, outcomes, and Delivery wire. Do not duplicate those instructions here or create another Core entity/Session kind for Skill composition.
