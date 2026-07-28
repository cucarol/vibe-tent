# Task CLI surface

Collaboration lifecycle mutates only through **Local Service** (`tent task *`). CLI attaches to the machine-local service, mounts the workspace, and calls RPC. CLI exit does **not** stop the service.

Read only the section needed for the current responsibility. Dispatcher and reviewer commands describe the API; they do not grant an executor authority on its own Task.

## Commands agents actually use

```text
tent task list [--workspace <path>] [--json]
tent task get <taskPath> [--workspace <path>] [--json]
tent task claim <taskPath> [--session <sessionId>] [--workspace <path>] [--json]
tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]
tent task ask-user <taskPath> --question <text>|- [--choices id=label,…] [--workspace <path>] [--json]
tent task task-input list <taskPath> | --task <taskPath> [--workspace <path>] [--json]
tent task task-input get <inputId> --task <taskPath> [--workspace <path>] [--json]
tent task task-input ack <inputId> --task <taskPath> --actor <role|sessionId> [--workspace <path>] [--json]
```

User / dispatcher write path and review (not the executor’s self-inbox):

```text
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
tent task user-ask list|get <askId>|reply <askId>|deny <askId> […]
tent task accept <taskPath> --actor <user|role> …
tent task reject <taskPath> --actor <user|role> [--note …] [--resume|--no-resume] …
tent task cancel <taskPath> …
tent task dispatch <boxId> <role> …
tent task dispatch <boxId> --profile <profileId> …
```

Dispatch forms:

| Form | Assignee | Session |
| --- | --- | --- |
| `tent task dispatch <boxId> <role> [prompt…]` | Durable **role** (registry) | Queued only; no auto start |
| `tent task dispatch <boxId> --profile <id> [prompt…]` | One-shot **agentProfile** | Always `startSession`; prints `sessionId` / `sessionState` |

- `--profile` does **not** register or create a role. Envelope lands under `temp/agent-profiles/<profileId>/…`.
- A bare role-like string is **never** inferred as a profile; use `--profile` explicitly.
- Do not pass low-level `--assignee-kind` / `--start-session` on the CLI.
- Prompt: positionals **or** `--prompt <text>|-`, not both. With `--profile`, every positional after `boxId` is prompt text.
- Role attribution / A2A: any dispatch with explicit `--by`/`--from`/`--dispatched-by` (must name a **role**, not `user`), or implicit `TENT_ROLE`, or `--as-sub`, sends `callerKind=role` on **both** role and profile forms; plain user dispatch omits `--by` and sends `callerKind=user`. Explicit `--by user` is rejected.

Agents never self-accept their own Delivery. Use the persisted Task’s current `asSub`, `dispatchedBy`, and `deliveryPolicy` fields; review authority comes from Core and persisted state.

As a behavior contract, a downstream executor never requests or elevates `bypass` or `agent-decide`. If persisted state contradicts the intended review-to-parent model, fail loudly to the dispatcher. The V0.2 target replaces these compatibility fields with an explicit parent actor/reviewer contract.

## taskPath

- Always relative to **system root** (`.tent`), e.g.  
  `temp/agent-profiles/grok-core-worker/tasks/task-….md`
- Reading the same file from disk:  
  `.tent/temp/agent-profiles/grok-core-worker/tasks/task-….md`

## Claim / get / deliver

1. **claim** — external path only when state is still `queued`. Moves task to `running`, projects box owner/status.  
   Managed ACP: service already claimed via `startSession` — **do not claim again**.
2. **get** — re-read machine state after claim or mid-run. Envelope is the delivery record; box body is the task definition.
3. **deliver** — submit Delivery with a human summary and optional commit SHAs.  
   Creates a Delivery; does **not** accept. The current wire stores `deliveryPolicy` per Task: `review` waits for authorized review, `bypass` auto-integrates, and `agent-decide` requires integrate or request-review. Executors never elevate it. The V0.2 behavior target restricts downstream Task Agent → parent review and reserves the three-state choice for a durable Role’s user-facing Delivery.
   Service refuses ready Delivery while this task still has open TaskInput (`pending` / `processing` / retryable `failed`) with stable code `PENDING_TASK_INPUT` — consume via managed inject or `task-input ack` first; do not expect seal/cleanup to cancel blockers for you.

```bash
tent task deliver temp/.../tasks/task-….md --summary "what changed" --commits <sha>
```

## U2A — writers vs executor

**Write path** (`tent task send-input`): **user** or **dispatcher** (including an agent dispatcher pushing U2A into a **subordinate** task).

```bash
tent task send-input <taskPath> [--text "…"] [--refs id,id]
```

**Consume path** (executor of that task):

```bash
tent task task-input list <taskPath>
tent task task-input get <inputId> --task <taskPath>
tent task task-input ack <inputId> --task <taskPath> --actor <role|sessionId>
```

Rules:

- Do **not** self-`send-input` on the **same** task you are currently executing.
- A dispatcher **may** `send-input` to another task’s path when acting as U2A writer.
- `list` / `get` / `ack` always need `taskPath` scope; no global inbox.
- `ack` `--actor` must match the task role or a service-verified session id for that task.
- Managed ACP injects fixed-format follow-ups (`## User Input` / review feedback); external agents poll + ack.

## A2U — agent asks, user answers

```bash
tent task ask-user <taskPath> --question "…" [--choices a=Label A,b=Label B]
```

Creates a UserAsk and moves the task to `waiting(user-input)`. User replies via Desktop or:

```bash
tent task user-ask reply <askId> [--answer …] [--choice <id>]
tent task user-ask deny <askId>
```

Wait for the reply through the service; do not busy-loop inventing answers.

## Confirmed decisions

During design, review, or planning, treat explicit user confirmation as durable project context:

- Include the conclusion in the Delivery report.
- Persist it into the nearest relevant writable Node only when this executor is also the authorized Role.
- Otherwise return it to the parent reviewer for placement.
- Before Delivery, check that confirmed decisions do not exist only in chat.

For external Session entry/status/leave, read [session-boundaries.md](session-boundaries.md). An external executor may bind an existing Session ID during claim with `tent task claim … --session <ss-…>`.

## Orientation helpers

```bash
tent status          # proposals, tasks, paths (read-only)
tent roles           # role registry
tent tree            # box tree
tent task list       # service task list
tent agent status    # external session orientation
```

## What not to use as the main path

| Avoid as primary | Why |
| --- | --- |
| `tent task-ack` | Legacy direct-core; blocked on in-workspace `.tent` |
| `tent complete` / old report flows | Formal delivery is Delivery-only via `task.deliver` |
| Chat-only “done” without deliver | External path must `task.deliver` |
| Self `task.accept` | User (or authorized) review only |
| Self `send-input` on **this** task | Executor consumes via `task-input *`; writers are user/dispatcher |
