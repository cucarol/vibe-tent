# Paths and layout (in-workspace)

Desktop / co-located agents use **in-workspace** layout only.

## Roots

| Name | Meaning | Example |
| --- | --- | --- |
| **workspace root** | Real project root; run `tent` here | `C:/proj/MyRepo` |
| **system root** | Tent system root = `workspaceRoot/.tent` | `C:/proj/MyRepo/.tent` |
| **CLI taskPath** | Relative to **system root** (no `.tent/` prefix) | `temp/<role-or-profile>/tasks/….md` |
| **direct file read** | Relative to workspace root with `.tent/…`, or absolute under system root | `.tent/temp/…/init.md` |

## Hard rules

1. Workspace root contains `.tent/`. Project Agent rules live at workspace-root `AGENTS.md`; temp and registries live **inside** `.tent/`.
2. **Never** join operational paths as `<workspaceRoot>/temp`. Operational files live under `<workspaceRoot>/.tent/`.
3. CLI args (`taskPath`, most core-relative paths) stay `temp/...` relative to system root. On disk for editors/agents reading files: `.tent/temp/...`.
4. Context Card / bootstrap may give `workspaceRoot` + `systemRoot`. Prefer those. If `tentRoot` appears, it means **system root** (`.tent`), not workspace.
5. Do not invent a missing envelope, Context Card, manifest, or Node body — open the persisted source or fetch the Task first.
6. `Task.contextCard.refs.nodes[]` is the only persisted Node-source wire. Stable Node ID is authoritative; path is a refreshable hint. A manifest is an auxiliary dispatch snapshot, not an ACL, authority source, or second Node-ref list.

## Common locations

| Kind | On disk (from workspace root) | CLI / system-relative |
| --- | --- | --- |
| Project Agent rules | `AGENTS.md` | (workspace file read) |
| Tent structural marker | `.tent/index.md` | `index.md` |
| Durable role init | `.tent/temp/<role>/init.md` | `temp/<role>/init.md` |
| Role task envelope | `.tent/temp/<role>/tasks/*.md` | `temp/<role>/tasks/*.md` |
| AgentProfile task | `.tent/temp/agent-profiles/<profileId>/tasks/*.md` | `temp/agent-profiles/<profileId>/tasks/*.md` |
| Task-scoped manifest | `.tent/temp/agent-profiles/<profileId>/manifests/<taskId>.yml` | `temp/agent-profiles/…/manifests/….yml` |
| Roles registry | `.tent/roles.json` | (file read) |
| Types registry | `.tent/types.json` | (file read) |

## WorkspaceLane (code work)

When the envelope includes lane fields:

- `workspace` — workspace root
- `worktree` — execution directory for code edits
- `branch` — Git branch for this role/task (`tent-role/<role>` or `tent-task/<taskId>`)
- `targetBranch` — integrate target (mainline or dispatcher role branch)
- `baseCommit` — exact Task-lane starting commit; ordinary executor history must be linear from it
- `integrationAuthority` — derived from exact parent/reviewer with Service as mutator

If lane fields are absent, the Task may be pure Tent (no Git lane). That is valid. Do not invent a worktree. Durable Role worktrees persist; a clean, terminal, settled agentProfile Task worktree may be reclaimed automatically by Core.
