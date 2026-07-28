# Session boundaries

## Managed and external Sessions

| | Managed ACP | External / relay |
| --- | --- | --- |
| Start | Desktop / Service `task.startSession` | Host process + `tent agent enter` |
| Claim | Service claims first | Executor runs `tent task claim` |
| Delivery | Service captures the final report | Executor runs `tent task deliver` |
| Session ID | Service-owned `ss-…` | `tent agent enter`, optionally with `--session` / `--key` |
| Process | ACP child under Tent Service | Claude, Codex, Grok, or another host process |

This file covers Session boundaries only. Read [task-cli.md](task-cli.md) for the Task lifecycle.

## External Session CLI

```text
tent agent enter   → state=external registry row; no ACP spawn; idempotent
tent agent status  → open? + incompleteTasks
tent agent leave   → unbind only; delivered=false, accepted=false
```

- `leave` never delivers, accepts, or stops unrelated external processes.
- Hook aliases are `tent agent session-start|session-status|session-end --host <agent>` using a stable external key. Outside Tent, hooks exit silently.
- External GUI Sessions are registry/orientation records; this Skill never turns them into ACP child processes.

## Recover from stale or replaced Sessions

1. Re-query persisted Session and Task state after restart, compaction, handoff, provider change, or replacement.
2. Never treat an old live handle, process ID, or remembered resume token as current authority.
3. Use `task.replaceSession` only through the Service and only when its current eligibility checks allow it; do not manufacture a replacement by editing registry files.
4. Reuse a downstream Session only through a Core operation that confirms the current binding and compatibility. If that capability is absent, start through the existing Task lifecycle.
5. Do not stop a process merely because its Session projection looks stale; confirm ownership and current runtime state first.

## Host tools stay with the host

- Tent does not replace the host Agent’s tool-approval or permission UI.
- Do not read or write host permission stores from this Skill.
- Managed ACP tool approval, when available, remains a separate runtime path.

## Context is not permission

The Task manifest is a context pointer, not an ACL. Open the referenced content when the Task requires it; never infer authorization from a manifest list.
