---
name: tent-agent
description: Compact Tent entry for any new Agent: detect .tent and task envelopes, run tent agent enter/status/leave, and drive task claim/get/send-input/ask-user/deliver. Prefer this over tent-role for new agents.
---

# tent-agent

Use this skill whenever an agent joins or resumes work inside a Tent workspace. It is the **V0.2 model-side entry** for new agents. Prefer it over `tent-role` on the future main path. Do **not** delete or replace installed `tent-role` / `tent-genesis`; those remain for genesis and durable-role sessions.

Details live under `references/` — keep this file short and cache-friendly.

## When to use

- You are inside (or should attach to) a workspace that has `.tent/`.
- Bootstrap / Context Card / relay prompt points at a task envelope under `.tent/temp/…`.
- You need claim → work → deliver, or A2U (`ask-user`) / U2A (`send-input`) mid-task.

## Hard facts (do not invent)

| Term | Meaning |
| --- | --- |
| **workspace root** | Real project root; run `tent` here |
| **system root** | `workspaceRoot/.tent` |
| **CLI taskPath** | Relative to **system root** (no `.tent/` prefix), e.g. `temp/…/tasks/….md` |
| **file read path** | Relative to workspace root: `.tent/temp/…` |
| **box** | Task content (identity note) |
| **envelope** | Machine delivery record (`tk-…`); not the task body |
| **delivery** | Agent submission (`dl-…`); **not** user accept |
| **accept** | User (or authorized) review of a delivery |

Never invent missing envelope / manifest / box content — fetch by path or id first. Never resolve operational files as `<workspaceRoot>/temp` (use `.tent/temp`).

More path rules: `references/paths.md`.

## Session lifecycle (external)

```bash
# cwd = workspace root (contains .tent/)
tent agent enter [--json]          # bind / resume external session when available
tent agent status [--json]         # session + task orientation
tent agent leave [--json]          # unbind only — does NOT deliver or accept
```

- **leave** ends or unbinds the external session binding and may report unfinished work. It does **not** call deliver/accept.
- Outside a Tent workspace, agent lifecycle hooks that are designed for silent no-op must exit 0 (do not fail the host agent).
- Tent does **not** take over the host product’s native tool/permission UI. External GUI sessions do not become ACP processes via this skill.

## Task lifecycle (Local Service)

Primary collaboration mutations go through **`tent task *`** (Service RPC). Do not use legacy `task-ack` / `complete` as the main path.

```bash
tent task list [--json]
tent task get <taskPath> [--json]
tent task claim <taskPath> [--session <sessionId>] [--json]
# … work in envelope worktree/branch when present …
tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--json]
tent task ask-user <taskPath> --question <text>|- [--choices id=label,…] [--json]
tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--json]
```

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

Full command notes: `references/task-cli.md`. Session / permission boundaries: `references/session-boundaries.md`.

## Minimal external loop

1. Confirm cwd is workspace root with `.tent/RULES.md`.
2. `tent agent enter` / `tent agent status` (when CLI is available); otherwise `tent status` / `tent task list`.
3. Resolve taskPath from Context Card, user, or `tent task list`.
4. `tent task claim` → `tent task get` → read envelope, manifest, claimed box (real file reads).
5. Honor manifest readable/writable (honor contract, not a sandbox). Prefer envelope `worktree` / `branch` for code work. Commit workspace changes; never commit `.tent/`.
6. Need a decision → `tent task ask-user`. Need mid-run user text → consume via `send-input` / task-input ack as the service surface provides.
7. `tent task deliver … --summary …` then `tent agent leave` if you bound a session.
8. Stop. Wait for user accept/reject. Do not self-accept.

## What this skill is not

- Not Tent genesis → use `tent-genesis`.
- Not a full durable-role handbook (type registry, tags, orchestrator manual) → see `tent-role` if you need that depth.
- Not ACP runtime, permission broker, or Desktop UI control.
