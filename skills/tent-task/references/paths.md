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

1. Workspace root contains `.tent/`. Rules, temp, roles/types registries live **inside** `.tent/`.
2. **Never** join operational paths as `<workspaceRoot>/temp` or `<workspaceRoot>/RULES.md`.
3. CLI args (`taskPath`, most core-relative paths) stay `temp/...` relative to system root. On disk for editors/agents reading files: `.tent/temp/...`.
4. Context Card / bootstrap may give `workspaceRoot` + `systemRoot`. Prefer those. If `tentRoot` appears, it means **system root** (`.tent`), not workspace.
5. Do not invent missing envelope, manifest, or box bodies — open the path or fetch via `tent task get` first.
6. Treat `manifest.yml` as a **context pointer** from dispatch: which claims and paths to load for this task. V0.2 `tent-task` does **not** project or enforce permission axes from the manifest.

## Common locations

| Kind | On disk (from workspace root) | CLI / system-relative |
| --- | --- | --- |
| Project rules | `.tent/RULES.md` | `RULES.md` |
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

If lane fields are absent, the task may be pure Tent (no Git lane). That is valid. Do not invent a worktree.
