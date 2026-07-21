---
name: tent-agent
description: Compact Tent entry for any new Agent: detect .tent and task envelopes, run tent agent enter/status/leave, and drive task claim/get/ask-user/task-input/deliver. Prefer this over tent-role for new agents.
---

# tent-agent

Use this skill whenever an agent joins or resumes work inside a Tent workspace. It is the **V0.2 model-side entry** for new agents. Prefer it over `tent-role` on the future main path. Do **not** delete or replace installed `tent-role` / `tent-genesis`; those remain for genesis and durable-role sessions.

Details live under `references/` — keep this file short and cache-friendly.

## When to use

- You are inside (or should attach to) a workspace that has `.tent/`.
- Bootstrap / Context Card / relay prompt points at a task envelope under `.tent/temp/…`.
- You need claim → work → deliver, or mid-task A2U / U2A.

## Hard facts (do not invent)

| Term | Meaning |
| --- | --- |
| **workspace root** | Real project root; run `tent` here |
| **system root** | `workspaceRoot/.tent` |
| **CLI taskPath** | Relative to **system root** (no `.tent/` prefix), e.g. `temp/…/tasks/….md` |
| **file read path** | Relative to workspace root: `.tent/temp/…` |
| **box** | Task content (identity note) |
| **envelope** | Machine delivery record (`tk-…`); not the task body |
| **manifest** | Dispatch-time **context pointer** (claims + paths to load). Not a permission system |
| **delivery** | Agent submission (`dl-…`); **not** user accept |
| **accept** | User (or authorized) review of a delivery |

Never invent missing envelope / manifest / box content — fetch by path or id first. Never resolve operational files as `<workspaceRoot>/temp` (use `.tent/temp`).

More path rules: `references/paths.md`.

## External session (pull-host)

```bash
tent agent enter [--session <ss-…>] [--role <name>] [--profile <id>] [--key <externalKey>] [--json]
tent agent status [sessionId|externalKey] [--key <externalKey>] [--json]
tent agent leave [sessionId|externalKey] [--key <externalKey>] [--json]
```

- **enter** — register/reuse a `state=external` session row. No ACP spawn. Idempotent.
- **status** — probe session + incomplete tasks bound to it.
- **leave** — unbind/end external session only. Does **not** deliver or accept; may report unfinished tasks.
- Outside a Tent workspace, hook aliases (`session-start` / `session-end`) silent-exit 0; public enter/status/leave fail-loud unless designed silent. See `references/session-boundaries.md`.

## Task lifecycle (Local Service)

Primary collaboration mutations go through **`tent task *`** (Service RPC). Do not use legacy `task-ack` / `complete` as the main path.

```bash
tent task list [--json]
tent task get <taskPath> [--json]
tent task claim <taskPath> [--session <sessionId>] [--json]
# … work in envelope worktree/branch when present …
tent task ask-user <taskPath> --question <text>|- [--choices id=label,…] [--json]
tent task task-input list <taskPath> [--json]
tent task task-input get <inputId> --task <taskPath> [--json]
tent task task-input ack <inputId> --task <taskPath> --actor <role|sessionId> [--json]
tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--json]
```

Orientation (read-only): `tent status`, `tent roles`, `tent tree`.

### Direction: A2U vs U2A

| Direction | Writer | Executor (this task) | CLI |
| --- | --- | --- | --- |
| **A2U** | Agent on this task | Ask; wait for reply | `tent task ask-user` → user `user-ask reply\|deny` |
| **U2A** | **User or dispatcher** (incl. agent dispatcher to a **sub** task) | **Consume** inputs for *this* task | Writer: `tent task send-input`. Executor: `task-input list\|get\|ack` |

- Do **not** self-`send-input` on the **same** task you are executing.
- A dispatcher **may** `send-input` to a subordinate task it owns as writer.
- Managed ACP may inject U2A as `## User Input` / review feedback; external agents poll + ack.
- `ask-user` is not chat and not tool-permission UI.

### Managed ACP vs external / relay

| Path | Claim | Deliver |
| --- | --- | --- |
| **Managed ACP** (`task.startSession`) | Service already claimed; do **not** re-claim | Final assistant reply is the report; Service auto-delivers. Manual policy still waits for **user** accept |
| **External / relay** | `tent task claim` | `tent task deliver --summary …` |

Copying a relay prompt is not consuming the task. Only claim (or service claim) moves `queued → running`.

### Delivery ≠ accept

- `deliver` creates a Delivery for review. Box is **not** done until user **accept**.
- Do not mark box `status: done` yourself.
- Chat summary alone is not delivery; use `tent task deliver` on the external path.

Full command notes: `references/task-cli.md`. Session boundaries: `references/session-boundaries.md`.

## Minimal external loop

1. Confirm cwd is workspace root with `.tent/RULES.md`.
2. `tent agent enter` / `tent agent status` when binding an external session; else `tent status` / `tent task list`.
3. Resolve taskPath from Context Card, user, or `tent task list`.
4. `tent task claim` → `tent task get` → read envelope, **manifest as context pointer**, claimed box (real file reads).
5. Prefer envelope `worktree` / `branch` for code work. Commit workspace changes; never commit `.tent/`.
6. Need a decision → `tent task ask-user` (A2U). Mid-run user/dispatcher text → `task-input list/get/ack` (U2A consume). Do not self-`send-input` on this same task.
7. `tent task deliver … --summary …` then `tent agent leave` if you bound a session.
8. Stop. Wait for user accept/reject. Do not self-accept.

## What this skill is not

- Not Tent genesis → use `tent-genesis`.
- Not a full durable-role handbook → see `tent-role` if you need that depth.
- Not ACP runtime, host tool-permission UI, or Desktop control.
- Not a permission projector: use the manifest as **what context to open**, not as an ACL.
