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
- The HTTP listener accepts literal loopback addresses only (`127.0.0.0/8` or
  `::1`); hostnames, wildcard binds, LAN, and public addresses fail before bind.
- Authenticated `/rpc` buffers at most 36 MiB. This includes headroom for the
  documented 25 MiB attachment after base64 expansion; larger requests return
  HTTP 413 and do not reach a handler.
- One process owns each service data directory through `service.lock`. A live
  owner rejects a second Service; stale crash state is reclaimed. Concurrent CLI
  bootstraps converge on the healthy winner instead of creating parallel writers.
- `service.json` carries the owning instance id. Shutdown removes the endpoint
  only when it still belongs to that instance, so an old process cannot erase a
  replacement Service's discovery record.
- Shutdown first stops accepting new HTTP work, terminates long-lived SSE
  streams, and lets finite RPCs drain before disposing runtime/workspace state
  or releasing the data-directory lease. Each SSE subscriber has a bounded
  1 MiB pending queue; stalled subscribers are disconnected on overflow.
- **CLI exit does not stop the service** (detached child + no stop on process end). Closing Desktop windows likewise leaves the service running so claim/deliver still work.

## Commands (stable names)

| Command | RPC | Notes |
| --- | --- | --- |
| `tent task list` | `task.list` | Read-only |
| `tent task get <taskPath>` | `task.get` | Read-only |
| `tent task claim <taskPath>` | `task.claim` | Required for external agents |
| `tent task deliver <taskPath> --summary <text>\|-` | `task.deliver` | Required for external agents |
| `tent task dispatch <boxId> <role> …` | `task.dispatch` | Durable **role** assignee (queued; no auto session) |
| `tent task dispatch <boxId> --profile <profileId> …` | `task.dispatch` | One-shot **agentProfile** + `startSession: true`; does **not** register a role. Prints managed `sessionId` / `sessionState` when returned. Positionals after `boxId` are prompt only — never inferred as a profile. |
| `tent task accept <taskPath> --actor …` | `task.accept` | Optional RPC mapping |
| `tent task reject <taskPath> --actor …` | `task.reject` | Optional RPC mapping |
| `tent task cancel <taskPath>` | `task.cancel` | Optional RPC mapping |

Common flags:

- `--workspace <path>` — workspace root (wins over cwd; default: resolve from cwd)
- `--json` — machine-readable result
- `--data-dir <path>` — service data area override
- `--attach-only` — do not bootstrap; fail if service missing
- `--service-entry <path>` — entry used when bootstrapping

Workspace must be an **in-workspace Tent** (`<workspace>/.tent/index.md`). CLI mounts via `workspace.mount` (idempotent if already mounted).

## CLI boundary

The supported layout is `<workspace>/.tent`. `tent new .` adopts an existing
project without copying project files. Node, Task, Proposal, Role Checkpoint,
Session, and Agent mutations route through Local Service; the CLI has no
direct-core fallback, external-root mode, migration command, or compatibility
aliases. Read-only `tree`, `status`, `roles`, `find`, and `tags` remain local
queries.

Machine-local bundled skills are also available through authenticated Local
Service RPC: `skill.list` and `skill.install`. Installation sources are fixed to
the package's bundled `skills/` directory, and destinations are restricted to
`~/.agents/skills` (`shared-agents`) and `~/.claude/skills` (`claude`). The CLI
uses the same backend via `tent skill-install --target all|shared-agents|claude`.
There is intentionally no remote marketplace, arbitrary path, uninstall, or
third-party hook editor in this surface.

Use `tent node *`, `tent task *`, and service-routed `tent propose` whenever
Desktop or another client shares the same Local Service.

## Agent minimal flow

```bash
# cwd = workspace root (contains .tent/)
tent task list
tent task claim temp/<role>/tasks/<file>.md
# … work in role worktree …
tent task deliver temp/<role>/tasks/<file>.md --summary "what changed" --commits <sha>
```

After Desktop window close, the same commands still attach to the running service and Desktop sees the same `task.get` / `task.list` state on reopen.
