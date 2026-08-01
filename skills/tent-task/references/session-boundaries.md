# Session boundaries

## Managed and external Sessions

| | Managed ACP | External / relay |
| --- | --- | --- |
| Start | Desktop / Service `task.startSession` | Host process + `tent session enter` |
| Claim | Service claims first | Executor runs `tent task claim` |
| Delivery | Service captures the final report | Executor runs `tent task deliver` |
| Session ID | Service-owned `ss-…` | `tent session enter`, optionally with `--session` / `--key` |
| Process | ACP child under Tent Service | Claude, Codex, Grok, or another host process |

This file covers Session boundaries only. Read [task-cli.md](task-cli.md) for the Task lifecycle.

## External Session CLI

```text
tent session enter   → state=external registry row; no ACP spawn; idempotent
tent session status  → open? + incompleteTasks
tent session leave   → unbind only; delivered=false, accepted=false
```

- `leave` never delivers, accepts, or stops unrelated external processes.
- Hook aliases are `tent session session-start|session-status|session-end --host <agent>` using a stable external key. Outside Tent, hooks exit silently.
- External GUI Sessions are registry/orientation records; this Skill never turns them into ACP child processes.

## Recover from stale or replaced Sessions

1. Re-query persisted Session and Task state after restart, compaction, handoff, provider change, or replacement.
2. Never treat an old live handle, process ID, or remembered resume token as current authority.
3. Use `task.replaceSession` only through Service for the same Task when the bound context is unusable. It requires a turn-idle `running` Task or `waiting(session_unavailable)`; `TURN_BUSY` fails loud and has no force path. Replacement is explicitly fresh (`contextRestored=false`).
4. Reuse only through Core compatibility checks: workspace, parent Role, logical `agentId`, purpose, Skills, profile/adapter, context generation, lane, exclusive idle lease, settled turn, and no pending input/Delivery must match. A failed check creates a fresh Session generation.
5. Do not stop a process merely because its Session projection looks stale; confirm ownership and current runtime state first.

Session startup runs outside the Task lifecycle lock, then final binding uses an authoritative Task snapshot and lifecycle CAS. A terminal transition may win; the unbound new Session is stopped and Service reports `TASK_SESSION_BIND_CAS_FAILED`. Never hand-bind it or overwrite the terminal Task.

## Protocol and bounded ACP failure

- Public CLI requires the compatible Local Service protocol. If attach reports a legacy/mismatched endpoint, do not bypass Service or call the provider adapter directly. Stop and report the mismatch; restart or upgrade through the environment's documented Service operator procedure rather than inventing a Skill command.
- Oversized ACP frame/report/request fails loud as `ACP_OUTPUT_LIMIT` or `ACP_REQUEST_LIMIT`. Service stops the provider turn and must not publish `prompt_complete`, a Delivery, or a delivered outcome from truncated content.
- Diagnostic tails may be bounded and redacted. They are evidence, not a substitute for the authoritative Session/Task terminal state.

## Host tools stay with the host

- Tent does not replace the host Agent’s tool-approval or permission UI.
- Do not read or write host permission stores from this Skill.
- Managed ACP tool approval, when available, remains a separate runtime path.

## Context is not permission

The Context Card supplies Task refs; the manifest is only an auxiliary snapshot. Neither is an ACL. Authority comes from persisted parent/reviewer, Role roster, Task lifecycle, and integration lane.
