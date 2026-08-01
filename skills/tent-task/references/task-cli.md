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
tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>] [--workspace <path>] [--json]
```

User / dispatcher write path and review (not the executor’s self-inbox):

```text
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
tent task user-ask list|get <askId>|reply <askId>|deny <askId> […]
tent task accept <taskPath> --actor <user|role> …
tent task reject <taskPath> --actor <user|role> [--note …] [--resume|--no-resume] …
tent task interrupt <taskPath> …
tent task cancel <taskPath> …
tent task dispatch --target role:<roleIdOrName>|agent:<agentId> \
  --node <nodeId> [--node <nodeId> …] --prompt <text>|-
```

Dispatch forms:

| Form | Assignee | Session |
| --- | --- | --- |
| `--target role:<roleIdOrName>` | Durable Role | Queued only; no managed ACP start at dispatch |
| `--target agent:<agentId>` | Logical AgentDefinition | Resolves the machine-local LaunchProfile and starts managed ACP |

- `--node` is repeatable and supplies the exact ordered Context Card Node refs; at least one is required. Node refs are non-exclusive.
- `agentId` is stable logical identity; LaunchProfile is local resolution and never a public dispatch selector. A Role caller may use only its ready roster; user-direct dispatch is authorized by the user actor.
- Caller identity supplies equal `parentActor` and `reviewer`. A Role caller also derives the parent Role Git lane internally; user-direct dispatch uses user. Do not pass or recreate `--profile`, `--agent`, `--delivery-policy`, `--as-sub`, `--by`, `--caller-kind`, or `--assignee-kind`.
- Prompt is required through `--prompt <text>|-`; positional Task source or prompt forms are not aliases.

Agents never self-accept. Review authority is the exact persisted `reviewer`, which must equal `parentActor`. Downstream Task Agents always use review-to-parent and cannot elevate `bypass` or `agent-decide`; the three-state policy is only for a durable Role's user-facing Delivery.

## taskPath

- Always relative to **system root** (`.tent`), e.g.  
  `temp/agent-profiles/grok-core-worker/tasks/task-….md`
- Reading the same file from disk:  
  `.tent/temp/agent-profiles/grok-core-worker/tasks/task-….md`

## Claim / get / deliver

1. **claim** — external path only when state is still `queued`. Moves the Task to `running`; Node collaboration remains a projection and Node refs are non-exclusive.
   Managed ACP: service already claimed via `startSession` — **do not claim again**.
2. **get** — re-read machine state after claim or mid-run. The Task envelope and Context Card are the execution contract; referenced Node bodies are context. Delivery is a separate record.
3. **deliver** — submit Delivery with a human summary and optional commit SHAs.  
   Creates a Delivery; does **not** accept. A downstream executor delivers only for its exact parent reviewer. A durable Role's own user-facing Task may use its configured `review | bypass | agent-decide` policy.
   Service refuses ready Delivery while this task has attention TaskInput (`pending`, `processing`, `failed`, or `uncertain`) with stable code `PENDING_TASK_INPUT`. `uncertain` means injection may already have happened: never retry or re-inject it. An authorized acknowledgement resolves the blocker and may schedule only a durable report-draft retry.

A commit-bearing ready Delivery records reported commits from the exact lane range plus a target-head snapshot. The commit list may be empty or a relevant subset; every listed SHA must belong to the lane. `TARGET_MOVED` is a review boundary: reject/resume and re-deliver against the current target instead of overriding or rewriting persisted facts.

Managed ACP final reports lead with `outcome: delivered|blocked|needs-input`. Only `delivered` may publish a ready Delivery after the turn and lane settle; `blocked` and `needs-input` remain non-delivery outcomes.

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
tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>]
```

Rules:

- Do **not** self-`send-input` on the **same** task you are currently executing.
- A dispatcher **may** `send-input` to another task’s path when acting as U2A writer.
- `list` / `get` / `ack` always need `taskPath` scope; no global inbox.
- An explicit `--actor` must match the exact Task Role, persisted parent/reviewer Role, or a Service-verified Session bound to that Task. Text such as `--actor user` is not user authority.
- For the Local Service user path, omit `--actor`; Service derives user authority from its authenticated boundary plus persisted user parent/reviewer. Acknowledging `uncertain` preserves its diagnostic history and never prompts the provider again.
- Managed ACP injects fixed-format follow-ups (`## User Input` / review feedback); external agents poll + ack.

## Stop an obsolete Task

- `task cancel` is for a Task that is still `queued`.
- `task interrupt` is for `running` or `waiting`; it preserves audit state and stops the exact managed Session through Service ownership.
- Once a ready Delivery exists, the reviewer accepts or rejects it. Interrupt does not erase a published Delivery.
- Never kill a provider PID, edit an envelope, or delete its lane as a lifecycle substitute.

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
tent role list       # durable Role registry projection
tent role show <id>  # roster readiness for one Role
tent agent list      # logical AgentDefinitions (not Sessions)
tent tree            # Node tree
tent task list       # service task list
tent session status  # managed or external Session orientation
```

## What not to use as the main path

| Avoid as primary | Why |
| --- | --- |
| Chat-only “done” without deliver | External path must `task.deliver` |
| Self `task.accept` | User (or authorized) review only |
| Self `send-input` on **this** task | Executor consumes via `task-input *`; writers are user/dispatcher |
