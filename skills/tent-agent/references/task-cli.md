# Task CLI surface

Collaboration lifecycle mutates only through **Local Service** (`tent task *`). CLI attaches to the machine-local service, mounts the workspace, and calls RPC. CLI exit does **not** stop the service.

Only commands that exist on the current CLI are listed below. Do not invent `tent agent *` or other missing top-level verbs.

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

User / Desktop (agents do **not** drive these as their primary path):

```text
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
tent task user-ask list|get <askId>|reply <askId>|deny <askId> […]
tent task accept <taskPath> --actor <user|role> …
tent task reject <taskPath> --actor <user|role> [--note …] [--resume|--no-resume] …
tent task cancel <taskPath> …
tent task dispatch <boxId> <role> …
```

Agents should **not** self-accept their own delivery unless the product path explicitly authorizes it.
Agents should **not** call `tent task send-input` to “message themselves.”

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

## U2A — user writes, agent consumes

**Write path (user / dispatcher only):**

```bash
tent task send-input <taskPath> [--text "…"] [--refs id,id]
```

Service stores a machine-local TaskInput. Managed ACP injects a fixed-format follow-up (`## User Input` / review feedback). External agents must poll.

**Consume path (agent):**

```bash
tent task task-input list <taskPath>
tent task task-input get <inputId> --task <taskPath>
tent task task-input ack <inputId> --task <taskPath> --actor <role|sessionId>
```

- `list` / `get` / `ack` always need the task scope (`taskPath`); there is no global inbox.
- `ack` `--actor` must match the task role or a service-verified session id for that task.
- Do not invent a second inbox under the workspace root.

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

## Orientation helpers (real top-level commands)

```bash
tent status          # proposals, tasks, paths (read-only)
tent roles           # role registry
tent tree            # box tree
tent task list       # service task list
```

There is **no** `tent agent enter|status|leave` on the current CLI. Session bind metadata is optional via `claim --session` when the host provides a session id; do not document missing agent lifecycle subcommands as fallbacks.

## What not to use as the main path

| Avoid as primary | Why |
| --- | --- |
| `tent task-ack` | Legacy direct-core; blocked on in-workspace `.tent` |
| `tent complete` / old report flows | Formal delivery is Delivery-only via `task.deliver` |
| Chat-only “done” without deliver | External path must `task.deliver` |
| Self `task.accept` | User (or authorized) review only |
| Agent calling `task.send-input` | User-only U2A write path |
