# Task CLI surface

Collaboration lifecycle mutates only through **Local Service** (`tent task *`). CLI attaches to the machine-local service, mounts the workspace, and calls RPC. CLI exit does **not** stop the service.

## Commands agents actually use

```text
tent task list [--workspace <path>] [--json]
tent task get <taskPath> [--workspace <path>] [--json]
tent task claim <taskPath> [--session <sessionId>] [--workspace <path>] [--json]
tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
tent task ask-user <taskPath> --question <text>|- [--choices id=label,…] [--workspace <path>] [--json]
tent task user-ask list|get <askId>|reply <askId>|deny <askId> […]   # usually user/Desktop
tent task task-input list <taskPath>|get <inputId>|ack <inputId> --task <taskPath> --actor <role|sessionId>
```

Optional review (user / authorized):

```text
tent task accept <taskPath> --actor <user|role> …
tent task reject <taskPath> --actor <user|role> [--note …] [--resume|--no-resume] …
tent task cancel <taskPath> …
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

## send-input (U2A)

User (or Desktop) can append one-shot text or concept refs to a **running** task. Agents consume via the task-input surface (`task-input list/get/ack`) as exposed by the service. Do not invent a second inbox under the workspace root.

## ask-user (A2U)

Lightweight agent→user business question — not a chat product:

```bash
tent task ask-user <taskPath> --question "…" [--choices a=Label A,b=Label B]
```

Wait for user reply through the service / Desktop; do not busy-loop inventing answers.

## Agent session CLI (orthogonal)

```text
tent agent enter|status|leave [--json]
```

- Bind / inspect / unbind external session metadata.
- **leave does not deliver or accept.**
- Non-Tent cwd: lifecycle hooks that are silent no-ops must exit 0.

## What not to use as the main path

| Avoid as primary | Why |
| --- | --- |
| `tent task-ack` | Legacy direct-core; blocked on in-workspace `.tent` |
| `tent complete` / old report flows | Formal delivery is Delivery-only via `task.deliver` |
| Chat-only “done” without deliver | External path must `task.deliver` |
| Self `task.accept` | User (or authorized) review only |

## Orientation helpers

```bash
tent status          # proposals, tasks, paths (read-only)
tent roles           # role registry
tent task list       # service task list
```
