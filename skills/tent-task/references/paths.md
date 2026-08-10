# Paths and layout (in-workspace)

Desktop / co-located agents use **in-workspace** layout only.

## Roots

| Name | Meaning | Example |
| --- | --- | --- |
| **workspace root** | Real project root; run `tent` here | `C:/proj/MyRepo` |
| **system root** | Tent system root = `workspaceRoot/.tent` | `C:/proj/MyRepo/.tent` |
| **CLI taskPath** | Relative to **system root** (no `.tent/` prefix) | exact path returned by Service |
| **direct file read** | Relative to workspace root with `.tent/…`, or absolute under system root | `.tent/temp/…/init.md` |

## Hard rules

1. Workspace root contains `.tent/`. Project Agent rules live at workspace-root `AGENTS.md`; temp and registries live **inside** `.tent/`.
2. **Never** join operational paths as `<workspaceRoot>/temp`. Operational files live under `<workspaceRoot>/.tent/`.
3. CLI args (`taskPath`, most core-relative paths) stay `temp/...` relative to system root. On disk for editors/agents reading files: `.tent/temp/...`.
4. Context Card / bootstrap may give `workspaceRoot` + `systemRoot`. Prefer those. If `tentRoot` appears, it means **system root** (`.tent`), not workspace.
5. Do not invent a missing envelope, Context Card, manifest, or Node body — open the persisted source or fetch the Task first.
6. Context Card v2 persists canonical `workNodeIds[]` and `contextNodeIds[]`.
   Stable Node ID is authoritative; a manifest is an auxiliary dispatch snapshot,
   not an authority source or second Node-ref list.

## Common locations

| Kind | On disk (from workspace root) | CLI / system-relative |
| --- | --- | --- |
| Project Agent rules | `AGENTS.md` | (workspace file read) |
| Tent structural marker | `.tent/index.md` | `index.md` |
| Durable role init | `.tent/temp/<role>/init.md` | `temp/<role>/init.md` |
| Role task envelope | `.tent/temp/<role>/tasks/*.md` | `temp/<role>/tasks/*.md` |
| Managed Session Task | use the exact `taskPath` returned by Service | use the exact `taskPath` returned by Service |
| Task-scoped manifest | use the path recorded on the Task | use the path recorded on the Task |
| Roles registry | `.tent/roles.json` | (file read) |
| Types registry | `.tent/types.json` | (file read) |

## WorkspaceLane (code work)

When the envelope includes lane fields:

- `workspace` — workspace root
- `worktree` — execution directory for code edits
- `branch` — Git branch for this role/task (`tent-role/<role>` or `tent-task/<taskId>`)
- `targetBranch` — integrate target (mainline or dispatcher role branch)
- `baseCommit` — exact Task-lane starting commit captured once at the lifecycle stage that establishes this lane; ordinary executor history must be linear from it
- `integrationAuthority` — derived from exact `parentActor` with Service as mutator

Lane timing depends on execution shape and parent: Role Tasks defer execution
lane/base to first claim; Connection-launched Tasks establish their Task lane
through the managed lifecycle against the correct target. Re-read the envelope
after claim/start and trust only its persisted lane. If a code Task then lacks
its required base, fail loud; an executor never guesses or silently recomputes it.

If lane fields remain absent for a pure Tent Task, that is valid. Do not invent
a worktree. Durable Role worktrees persist; a clean, terminal, settled managed
Task worktree may be reclaimed automatically by Core. Reclaim is a Service-owned
exact-path operation: never manually remove/prune a Task lane or traverse a
junction/reparse-point target.
