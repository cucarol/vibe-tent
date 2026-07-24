---
name: tent-agent
description: Unified Tent (帷幄) entry for any Agent: create or enter a Tent, initialize or resume a role, bind external sessions, and drive the task lifecycle.
---

# tent-agent

Use this skill whenever an agent creates, joins, or resumes work inside a Tent (帷幄) workspace. `帷幄` is the Chinese product name and should be treated as an alias of Tent. This is the **single V0.2 model-side entry**; the former two Tent skills are retired.

Details live under `references/` — keep this file short and cache-friendly.

## When to use

- You need to create a Tent in a workspace that does not yet have `.tent/`.
- You are inside (or should attach to) a workspace that has `.tent/`.
- Bootstrap / Context Card / relay prompt points at a task envelope under `.tent/temp/…`.
- You need claim → work → deliver, or mid-task A2U / U2A.

## Create or initialize

- If `.tent/` is absent, confirm the workspace root and initial roles, then use `tent new <workspace>`; do not invent an external Tent root.
- For a durable role, read `.tent/RULES.md` and `.tent/temp/<role>/init.md`; generate the latter with `tent role-init <role>` for a new role.

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
| **delivery** | Agent submission (`dl-…`); not user accept |
| **accept** | User (or authorized) review of a delivery |

Never invent missing envelope / manifest / box content — fetch by path or id first. Never resolve operational files as `<workspaceRoot>/temp` (use `.tent/temp`).

More path rules: `references/paths.md`.

## External session (pull-host)

```bash
tent agent enter [--session <ss-…>] [--role <name>] [--profile <id>] [--key <externalKey>] [--json]
tent agent status [sessionId|externalKey] [--key <externalKey>] [--json]
tent agent leave [sessionId|externalKey] [--key <externalKey>] [--json]
```

- **enter** registers/reuses an external session; **status** probes it; **leave** ends it without delivering or accepting.
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

## Capture confirmed decisions

- During design, review, or planning work, treat an explicit user confirmation as durable project context.
- Immediately after an explicit confirmation, write the conclusion into the nearest existing relevant Node through the authorized Tent mutation path; only then move to the next topic.
- Do not create one new Decision Node per conversational detail. Extend the current architecture, lifecycle, or feature Node instead.
- If no writable relevant Node exists, preserve the exact conclusion in the Delivery summary and state that it still needs placement.
- Before Delivery, check whether any confirmed conclusion still exists only in the conversation. Place it in a relevant Node or list it explicitly as unplaced in the Delivery summary.

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

- Not ACP runtime, host tool-permission UI, or Desktop control.
- Not a permission projector: use the manifest as **what context to open**, not as an ACL.
