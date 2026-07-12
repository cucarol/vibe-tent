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

These remain for package tests / offline pure-core workflows. They **direct-write** core and must **not** be used as the Desktop co-located agent path:

- `tent dispatch`, `tent task-ack`, `tent task-cancel`
- `tent report`, `tent propose`, `tent complete`, `tent stamp`
- structure commands: `new-box`, `tag`, `fork`, …

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
