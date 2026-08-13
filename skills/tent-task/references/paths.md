# Paths and layout

Tent uses an in-workspace system root at `<workspace>/.tent`.

| Fact | Path contract |
| --- | --- |
| project instructions | workspace-root `AGENTS.md` |
| Node tree | Markdown under the mounted workspace |
| Role init | exact path returned by `tent role-init` |
| TaskRecord | exact Service `taskPath`, relative to `.tent` |
| TaskResultRecord | exact result path projected by Service |
| Context Card | path persisted on the Task |

Never guess or hand-write operational paths. CLI `taskPath` is relative to the
system root; editor paths include `.tent/` or use the absolute returned path.

Context Card v2 persists canonical `workNodeIds[]` and `contextNodeIds[]`. Stable
Node id is authority; snapshots are injection facts, not a second ref list.

## WorkspaceLane

Code Tasks may record workspace, worktree, branch, targetBranch, baseCommit, and
integration authority derived from requester. Work only in that exact lane.
Pure Tent work may have no lane and may submit a zero-commit TaskResult.

Worktree reclaim is an explicit exact-Task operation. Never manually delete or
prune a lane, traverse a reparse target, or infer safety from global Session scans.
