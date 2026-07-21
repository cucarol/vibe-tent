---
name: tent-agent
description: Compact Tent entry for any new Agent: detect .tent and task envelopes, claim/get/deliver via tent task *, consume U2A via task-input, ask user via ask-user. Prefer this over tent-role for new agents.
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

Orientation (read-only, no Service required): `tent status`, `tent roles`, `tent tree`.

### Direction: A2U vs U2A

| Direction | Who writes | Agent action | CLI |
| --- | --- | --- | --- |
| **A2U** (agent → user) | Agent | Ask a business question; wait for reply | `tent task ask-user` (agent). User answers via Desktop / `tent task user-ask reply\|deny` |
| **U2A** (user → agent) | **User or dispatcher only** | **Consume** pending inputs; do **not** call `send-input` on yourself | User writes with `tent task send-input`. Agent: `tent task task-input list\|get\|ack` |

- **Agents never call `tent task send-input`.** That is the user/dispatcher write path.
- Managed ACP may inject U2A as a structured `## User Input` / review-feedback turn; external agents poll + ack.
- `ask-user` is not chat and not tool-permission UI.

### Managed ACP vs external / relay

| Path | Claim | Deliver |
| --- | --- | --- |
| **Managed ACP** (`task.startSession`) | Service already claimed; do **not** re-claim | Final assistant reply is the report; Service auto-delivers. Manual policy still waits for **user** accept |
| **External / relay** (clipboard, pull-host, manual) | `tent task claim` | `tent task deliver --summary …` |

Copying a relay prompt is not consuming the task. Only claim (or service claim) moves `queued → running`.

### Delivery ≠ accept

- `deliver` creates a Delivery for review. Box is **not** done until user **accept**.
- Do not mark box `status: done` yourself.
- Chat summary alone is not delivery; use `tent task deliver` on the external path.

Full command notes: `references/task-cli.md`. Session boundaries: `references/session-boundaries.md`.

## Minimal external loop

1. Confirm cwd is workspace root with `.tent/RULES.md`.
2. Orient with `tent status` / `tent task list` when helpful.
3. Resolve taskPath from Context Card, user, or `tent task list`.
4. `tent task claim` → `tent task get` → read envelope, **manifest as context pointer**, claimed box (real file reads).
5. Prefer envelope `worktree` / `branch` for code work. Commit workspace changes; never commit `.tent/`.
6. Need a decision → `tent task ask-user` (A2U). Mid-run user text → `task-input list/get/ack` (U2A consume); never `send-input` as the agent.
7. `tent task deliver … --summary …`.
8. Stop. Wait for user accept/reject. Do not self-accept.

## What this skill is not

- Not Tent genesis → use `tent-genesis`.
- Not a full durable-role handbook (type registry, tags, orchestrator manual) → see `tent-role` if you need that depth.
- Not ACP runtime, host tool-permission UI, or Desktop control.
- Not a permission projector: V0.2 does **not** enforce or teach `readable`/`writable` as a security or honor-permission system. Use the manifest to know **what context to open**, not as an ACL.
