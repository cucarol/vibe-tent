# CLI ↔ Local Service（P0-2 / B4）

Status: implementation note for Desktop MVP  
Scope: how the `tent` CLI attaches to Local Service for task lifecycle  
Non-scope: Desktop UI, Obsidian plugin, provider adapters

## Architecture boundary

```text
External agent / terminal
        │  tent task claim|deliver|…
        ▼
CLI (short-lived)  ──attach / bootstrap──►  Local Tent Service
        │  JSON-RPC task.* / workspace.mount
        ▼
tent-core (sole domain rules)
```

- **Local Service** is the only mutation entry for collaboration lifecycle in the desktop product path.
- CLI **attaches** to a healthy machine-local endpoint (`%APPDATA%/Tent/service.json` on Windows, or `TENT_SERVICE_DATA_DIR`).
- If no healthy service exists, CLI may **bootstrap** `service.mjs` / `tent-service start`, wait for ready, then RPC.
- **Token** lives only in machine-local `service.json`. Never write token into the workspace or `.tent/`.
- **CLI exit does not stop the service** (detached child + no stop on process end). Closing Desktop windows likewise leaves the service running so claim/deliver still work.

## Commands (stable names)

| Command | RPC | Notes |
| --- | --- | --- |
| `tent task list` | `task.list` | Read-only |
| `tent task get <taskPath>` | `task.get` | Read-only |
| `tent task claim <taskPath>` | `task.claim` | Required for external agents |
| `tent task deliver <taskPath> --summary <text>\|-` | `task.deliver` | Required for external agents |
| `tent task dispatch <boxId> <role> …` | `task.dispatch` | Optional RPC mapping |
| `tent task accept <taskPath> --actor …` | `task.accept` | Optional RPC mapping |
| `tent task reject <taskPath> --actor …` | `task.reject` | Optional RPC mapping |
| `tent task cancel <taskPath>` | `task.cancel` | Optional RPC mapping |

Common flags:

- `--workspace <path>` — workspace root (default: resolve from cwd)
- `--json` — machine-readable result
- `--data-dir <path>` — service data area override
- `--attach-only` — do not bootstrap; fail if service missing
- `--service-entry <path>` — entry used when bootstrapping

Workspace must be an **in-workspace tent** (`<workspace>/.tent/RULES.md`). CLI mounts via `workspace.mount` (idempotent if already mounted).

## Legacy CLI (not service RPC)

Legacy commands that **direct-write** core are **blocked on in-workspace** system roots (`<workspace>/.tent`): they **fail-loud** and tell the agent to use `tent task *` / Desktop Service. There is **no** env escape hatch, dual-write, or silent compat path.

| Class | Commands | In-workspace `.tent` | External / flat system root |
| --- | --- | --- | --- |
| Read-only | `tree`, `status`, `roles`, `find`, `tags` | allowed | allowed |
| Init / derived / machine | `new`, `migrate`/`import`, `role-init`, `skill-install` | allowed | allowed |
| Mutation | `dispatch`, `task-ack`, `task-cancel`, `report`, `propose`, `complete`, `stamp`, `grant-readable`, `new-box`, `tag`, `untag`, `tag-new`, `tag-rm`, `fork`, `clean-temp`, `force-release`, `okf-sync` | **fail-loud** | allowed (migration window) |

Prefer `tent task *` whenever Desktop or another client shares the same Local Service.

## One-shot external tent import (B5)

Copy a legacy independent tent root into a workspace `.tent/` (no service required):

```bash
tent migrate --source <legacy-tent-root> --workspace <workspace-root> [--dry-run] [--force] [--json]
# alias: tent import …
```

Hard refuse if `<workspace>/.tent` already exists. Source is never deleted (`MIGRATED.md` only). Details: `docs/desktop/migration.md`.

## Agent minimal flow

```bash
# cwd = workspace root (contains .tent/)
tent task list
tent task claim temp/<role>/tasks/<file>.md
# … work in role worktree …
tent task deliver temp/<role>/tasks/<file>.md --summary "what changed" --commits <sha>
```

After Desktop window close, the same commands still attach to the running service and Desktop sees the same `task.get` / `task.list` state on reopen.
