# Task CLI surface

Collaboration lifecycle mutates only through **Local Service** (`tent task *`). CLI attaches to the machine-local service, mounts the workspace, and calls RPC. CLI exit does **not** stop the service.

Read only the section needed for the current responsibility. Dispatcher and reviewer commands describe the API; they do not grant an executor authority on its own Task.

## Commands agents actually use

```text
tent task list [--workspace <path>] [--json]
tent task get <taskPath> [--workspace <path>] [--json]
tent task claim <taskPath> [--workspace <path>] [--json]
tent task claim --work-node <nodeId> [--work-node <nodeId> …] [--context-node <nodeId> …] --prompt <text>|- [--from-task <taskPath>] [--workspace <path>] [--json]
tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]
tent task request-decision <taskPath> --question <text>|- [--options id=label,…] [--workspace <path>] [--json]
tent task task-input list <taskPath> | --task <taskPath> [--workspace <path>] [--json]
tent task task-input get <inputId> --task <taskPath> [--workspace <path>] [--json]
tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>] [--workspace <path>] [--json]
```

User / dispatcher write path and review (not the executor’s self-inbox):

```text
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
tent task decision list|get|respond|escalate […]
tent task accept <taskPath> --delivery-id <deliveryId> --actor <user|role> …
tent task reject <taskPath> --delivery-id <deliveryId> --actor <user|role> [--note …] [--resume|--no-resume] …
tent task interrupt <taskPath> …
tent task cancel <taskPath> …
tent task dispatch --target role:<roleId>|connection:<connectionId> \
  --work-node <nodeId> [--work-node <nodeId> …] \
  [--context-node <nodeId> …] --prompt <text>|-
```

Direct Role ownership:

- `task claim --work-node … --prompt …` atomically creates and claims this durable
  Role's own execution Task. It has no target and does not accept
  caller-authored responsibility fields.
- `--from-task <taskPath>` is optional and strict: that Task must be active,
  claimed, and owned by the same Role. Without it, Tent may inherit the exact
  verified Role execution context's persisted chain, including a terminal last
  Task; missing retained history falls back to the Role's user-facing root.

Dispatch forms (downstream assignment only):

| Form | Responsibility | Session |
| --- | --- | --- |
| `--target role:<roleId>` | Durable Role | Queued only; no managed ACP start at dispatch |
| `--target connection:<connectionId>` | Temporary ACP executor | Reserves one Session with an immutable Connection snapshot |

- `--work-node` supplies occupied write refs and is required; `--context-node`
  supplies shared read-only refs. Context Card v2 keeps them separate.
- `connectionId` is a non-secret stable reference to machine Settings. It resolves
  provider, model, endpoint, and credential metadata for the exact Task's
  temporary ACP Session.
- Tent derives reviewer authority and the parent Role Git lane from exact persisted `parentActor`. Callers pass only the documented target, Node refs, and prompt; all other responsibility and execution fields are Service-owned.
- Prompt is required through `--prompt <text>|-`; positional Task source or prompt forms are not aliases.

Executors never self-accept. Review authority is the exact persisted `parentActor`. Downstream Tasks always use review-to-parent and cannot elevate the durable Role's user-facing Delivery policy.

`--delivery-id` is the exact current ready Delivery shown to the reviewer. A
`DELIVERY_CHANGED` error means the review view is stale; refresh it rather than
inferring a Delivery from `taskPath` or retrying with an alias.

## taskPath

- Always use the exact system-relative `taskPath` returned by Service.
- For a direct file read, prefix that returned path with `.tent/`; never infer a Session directory or reconstruct the path from a Connection id.

## Claim / get / deliver

1. **claim** — Role path only when state is still `queued`. Moves the Task to `running`; Node collaboration remains a projection of exact active Task occupation.
   Managed ACP: service already claimed via `startSession` — **do not claim again**.
2. **get** — re-read machine state after claim or mid-run. The Task envelope and Context Card are the execution contract; referenced Node bodies are context. Delivery is a separate record.
3. **deliver** — submit Delivery with a human summary and optional commit SHAs.  
   Creates a Delivery; does **not** accept. A downstream executor delivers only for its exact parent reviewer. Every Task follows its frozen `review-required | auto-accept | agent-decide` mode.
   Service refuses ready Delivery while this task has attention TaskInput (`pending`, `processing`, `failed`, or `uncertain`) with stable code `PENDING_TASK_INPUT`. `uncertain` means injection may already have happened: never retry or re-inject it. Successful authorized acknowledgement resolves the blocker and schedules exactly one durable report-draft retry, never a provider prompt.

A commit-bearing ready Delivery records reported commits from the exact lane range plus a target-head snapshot. The commit list may be empty or a relevant subset; every listed SHA must belong to the lane. `TARGET_MOVED` is a review boundary: reject/resume and re-deliver against the current target instead of overriding or rewriting persisted facts.

Managed ACP first preserves every non-empty final report as a durable draft, then publishes natural report content as Delivery after the turn and lane settle. A valid leading `outcome: blocked|needs-input` parks without Delivery but does not discard its preserved body; `outcome: delivered` is accepted but optional. Missing or malformed outcome text never discards the report, and an empty report never invents success.

```bash
tent task deliver temp/.../tasks/task-….md --summary "what changed" --commits <sha>
```

## U2A — writers vs executor

**Write path** (`tent task send-input`): **user** or **parent dispatcher** writing to a downstream Task.

```bash
tent task send-input <taskPath> [--text "…"] [--refs id,id]
```

**Consume path** (executor of that task):

```bash
tent task task-input list <taskPath>
tent task task-input get <inputId> --task <taskPath>
tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>]
```

Rules:

- Do **not** self-`send-input` on the **same** task you are currently executing.
- A dispatcher **may** `send-input` to another task’s path when acting as U2A writer.
- `list` / `get` / `ack` always need `taskPath` scope; no global inbox.
- An explicit `--actor` must match the exact Task Role, persisted parent Role, or a Service-verified Session bound to that Task. Text such as `--actor user` is not user authority.
- For the Local Service user path, omit `--actor`; Service derives user authority from its authenticated boundary plus persisted user `parentActor`. Acknowledging `uncertain` preserves its diagnostic history and never prompts the provider again.
- Managed ACP injects fixed-format follow-ups (`## User Input` / review feedback); a Role executor may poll and acknowledge its Task input.

## Stop an obsolete Task

- `task cancel` is for a Task that is still `queued`.
- `task interrupt` is for `running` or `waiting`; it preserves audit state and stops the exact managed Session through Service ownership.
- Once a ready Delivery exists, the reviewer accepts or rejects it. Interrupt does not erase a published Delivery.
- Never kill a provider PID, edit an envelope, or delete its lane as a lifecycle substitute.

## A2U — exact Session requests a decision

```bash
tent task request-decision <taskPath> --question "…" [--options a=Label A,b=Label B]
```

Creates a DecisionRequest targeted to the frozen parent user or Role and moves
the Task to `waiting(user-input)`. The target responds via Desktop or:

```bash
tent task decision respond <taskPath> <requestId> --option <id>
tent task decision respond <taskPath> <requestId> --text <text>|-
tent task decision respond <taskPath> <requestId> --deny
tent task decision escalate <taskPath> <requestId>
```

Authority comes from authenticated transport, never an actor argument. A Role
target may escalate the same request id to user. Wait through Service; do not
busy-loop inventing answers.

## Confirmed decisions

During design, review, or planning, treat explicit user confirmation as durable project context:

- Include the conclusion in the Delivery report.
- Persist it into the nearest relevant writable Node only when this executor is also the authorized Role.
- Otherwise return it to the parent reviewer for placement.
- Before Delivery, check that confirmed decisions do not exist only in chat.

For temporary managed ACP recovery boundaries, read [session-boundaries.md](session-boundaries.md).

## Orientation helpers

```bash
tent status          # proposals, tasks, paths (read-only)
tent role list       # durable Role registry projection
tent role show <id>  # durable Role metadata
tent tree            # Node tree
tent task list       # service task list
```

## What not to use as the main path

| Avoid as primary | Why |
| --- | --- |
| Chat-only “done” without deliver | Role work must `task.deliver`; managed ACP Delivery is Service-owned |
| Self `task.accept` | User (or authorized) review only |
| Self `send-input` on **this** task | Executor consumes via `task-input *`; writers are user/dispatcher |
