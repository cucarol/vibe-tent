# Task CLI surface

Collaboration lifecycle mutates only through **Local Service** (`tent task *`). CLI attaches to the machine-local service, mounts the workspace, and calls RPC. CLI exit does **not** stop the service.

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

External session lifecycle (orthogonal; no ACP spawn):

```text
tent agent enter   [--session <ss-…>] [--role <name>] [--profile <id>]
                   [--key <externalKey>] [--host <agent>] [--task <taskId>] [--json]
tent agent status  [sessionId|externalKey] [--key <externalKey>] [--json]
tent agent leave   [sessionId|externalKey] [--key <externalKey>] [--json]
```

User / dispatcher write path and review (not the executor’s self-inbox):

```text
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
tent task user-ask list|get <askId>|reply <askId>|deny <askId> […]
tent task accept <taskPath> --actor <user|role> …
tent task reject <taskPath> --actor <user|role> [--note …] [--resume|--no-resume] …
tent task cancel <taskPath> …
tent task dispatch <boxId> <role> …
```

Agents should **not** self-accept their own delivery unless the product path explicitly authorizes it.

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
   Creates a reviewable delivery; does **not** accept. Manual `deliveryPolicy` waits for user.

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

- Write the conclusion promptly through the authorized Tent mutation path into the nearest relevant writable Node.
- Prefer extending the current architecture, lifecycle, or feature Node; do not create one Node per conversational detail.
- If no suitable writable Node exists, preserve the conclusion in the Delivery summary and mark it as unplaced.
- Before Delivery, check that confirmed decisions do not exist only in chat.

## External session CLI

Verified public surface (sibling lifecycle CLI):

| Command | Meaning |
| --- | --- |
| `tent agent enter` | Register/reuse external session (`state=external`). No ACP. Idempotent. |
| `tent agent status` | Probe session + incomplete tasks. |
| `tent agent leave` | End binding only. **Never** deliver/accept. |

Hook aliases (native install / projection): `session-start` / `session-status` / `session-end` with `--host <agent>` → same enter/status/leave via stable `externalKey`. Outside Tent: silent exit 0 for hooks.

Optional bind on claim: `tent task claim … --session <ss-…>` when the host already has a session id.

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
