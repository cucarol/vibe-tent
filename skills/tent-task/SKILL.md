---
name: tent-task
description: Execute one concrete Task inside Tent (帷幄), from Context Card and claim through scoped work, TaskInput/UserAsk handling, testing, terminal outcome, and Delivery. Use whenever any durable Role, managed ACP Agent, external Agent, or one-shot Agent is responsible for a Tent Task. Combine with tent-role when the executor is also a durable Role.
---

# tent-task

Apply this contract whenever executing a Task. Load the unchanged Skill text once per Session; for later Tasks append only the new Task pointer, acceptance requirements, and incremental inputs. If the executor is a durable Role, also apply `tent-role`; being managed or external does not change that decision.

## Resolve the Task

1. Work from the real workspace root containing `.tent/`. CLI task paths are relative to the `.tent` system root (`temp/...`); direct file reads use `.tent/temp/...`. Never use `<workspace>/temp`.
2. Resolve the exact task path or Task ID from the Context Card, persisted binding, or `tent task list`.
3. Managed ACP is already claimed by the Service; do not claim it again. External/relay execution must claim before working and may bind its host Session through `tent agent enter` or `claim --session`.
4. Fetch the envelope and read the referenced Nodes/boxes, manifest, Context Card, acceptance requirements, and current TaskInputs. Treat the manifest as a context pointer, not an ACL.
5. Do not infer missing Task content or use a stale Session handle as truth.

Read [references/paths.md](references/paths.md) for path and WorkspaceLane details, [references/session-boundaries.md](references/session-boundaries.md) for managed/external Session recovery, and [references/task-cli.md](references/task-cli.md) for exact commands and wire behavior.

## Work inside the assigned lane

- Use the envelope worktree and branch when present. If no lane exists, do not invent one.
- Preserve unrelated and pre-existing dirty work; never reset or clean it away.
- Stay inside the Task claims and acceptance requirements. Ask when a necessary expansion changes product intent, authority, or irreversible scope.
- Implement, inspect, and test in proportion to risk. Commit code work when the envelope provides a Git lane; never commit `.tent/`.

## Handle mid-Task communication

- A2U: use `tent task ask-user` when the Task needs a user decision, then wait for the reply.
- U2A: consume scoped TaskInputs with `task-input list|get|ack`.
- Never self-send input to the same Task. A dispatcher may send input to a subordinate Task it owns.
- A blocker, question, or unfinished report is not a successful Delivery.

## Finish with an explicit outcome

State exactly one terminal outcome in the final Task report:

- `delivered`: acceptance requirements are satisfied and evidence is ready for review/integration.
- `blocked`: work cannot safely continue without an external state change.
- `needs-input`: a specific decision or answer is required.

Use `delivered`, `blocked`, and `needs-input` as report conventions only unless the host explicitly exposes a structured Task outcome channel. Current managed runtimes may auto-deliver the final assistant reply, so do not end the managed turn with a blocker or question and assume Core will suppress Delivery. Use `ask-user`, the current waiting path, or fail loudly through the runtime-supported lifecycle.

### Deliver correctly

- Managed ACP: the Service owns claim and Delivery publication. Return the explicit outcome and report only when the runtime-supported lifecycle is ready to end; do not manually claim or deliver.
- External/relay: on `delivered`, run `tent task deliver` with an honest summary and commit SHAs. Chat text alone is not Delivery.
- Delivery never means accept. Do not set the box to done and never accept your own Delivery.
- Use the persisted Task’s current `asSub`, `dispatchedBy`, and `deliveryPolicy` fields; review must be authorized by Core from the persisted Task, not inferred from prompt memory.
- As a behavior contract, a downstream executor must never request or elevate `bypass` or `agent-decide`. If persisted state contradicts the intended review-to-parent model, fail loudly to the dispatcher instead of pretending Core already selected a parent reviewer.
- When a durable Role itself executes a user-facing Task, follow the Role’s configured `review | bypass | agent-decide` policy without elevating it. `agent-decide` means integrate or request review, never fake independent acceptance.

Before reporting `delivered`, ensure pending TaskInputs are settled and the worktree/commit state matches the report.

## Preserve durable decisions

Include any user-confirmed decision encountered during the Task in the Delivery report. Persist it directly only when this executor is also the authorized Role; otherwise return it to the parent reviewer for placement.

## Stop at the Task boundary

After Delivery, wait for Core/parent review. Do not manage the durable Role prompt, roster, downstream Agent selection, or reusable downstream Session pool from this Skill; those belong to `tent-role`.
