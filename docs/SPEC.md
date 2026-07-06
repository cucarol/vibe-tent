# Tent Specification

Tent / 帷幄 is an OKF v0.1 bundle plus a coordination layer for user-agent work.
The Obsidian plugin and CLI are clients of the same core rules.

## 1. Two Spaces

A Tent points to exactly one real workspace:

- **Tent** stores intent, context, box state, role contracts, and task
  envelopes. It consists of plain files and does not use Git.
- **Workspace** stores code and real deliverables. It must use Git.

`output` is an ordinary box type, not a synonym for every delivery. An output
box may map the Tent to the workspace:

```yaml
id: bx-7k2f9q
type: output
workspace: C:/path/to/workspace
ref: 0123abcd
```

`ref` is a workspace commit. A Tent with multiple distinct workspace output boxes
is invalid for dispatch/integration.

## 2. Boxes And Identity

A box is a folder plus a same-named Markdown identity note:

```text
some task/
  some task.md
```

A folder without a same-name note is a transparent group. `temp/` is a system
pipeline, never a box.

Box frontmatter:

```yaml
id: bx-7k2f9q
type: goal
tags: [backend]
readable: true
writable: false
archived: true
owner: executor
status: doing
```

- Only boxes have persistent ids: `bx-` plus six random collision-checked
  characters.
- A box name is chosen at creation. A Tent has no rename operation.
- Native moves are supported; paths may change while ids stay stable.
- Native renames are unsupported.
- `status` is `todo`, `doing`, or `done`.
- Locking is derived from `owner`; no separate lock field is stored.
- Tags are lookup facets only.

Duplicate ids are never silently indexed. A native copied subtree is adopted as
a fork: every copied box gets a fresh id and copied `owner`/`status` are
cleared. Any duplicate that cannot be identified as a fresh copy is invalid.

## 3. Type And Permission Resolution

`.tent/types.json` is a flat OKF-aligned type map. Built-ins are `goal`,
`prompt`, `output`, `open`, `reference`, `asset`, and `sealed`.

A type is either a base type or a modifier. A compound type such as `goal-draft`
combines a base with a modifier. Each permission axis resolves independently:

1. invalid subtree forces false;
2. archived subtree forces false;
3. explicit box `readable` or `writable`;
4. modifier value when present;
5. base default, otherwise false.

Permission axes do not inherit from ancestors. Hierarchy expresses organization
and containment, not permission inheritance.

Manifest R/W is an honor contract, not an OS sandbox. Core enforces mechanical
invariants, not semantic prompt authority.

## 4. Roles, Claims, And Dispatch

A role is `name + optional stable prompt + optional host CLI hint`. One role
represents one long-lived agent session in a Tent. A role may own multiple
non-overlapping boxes, including boxes under unrelated parents.

`.tent/roles.json` may include an optional `cli` object:

```json
{
  "roles": [
    {
      "name": "planner",
      "prompt": "Plan work and review reports.",
      "cli": {
        "command": "codex",
        "resume": "codex resume"
      }
    }
  ]
}
```

`cli.command` is required when `cli` exists; `cli.resume` is optional. Tent
stores and validates these fields but never spawns the process. They are read-only
hints for a user or external orchestrator.

Each role gets one long-lived workspace lane:

```text
branch:   tent-role/<safe-role-name>
worktree: <workspace-parent>/<workspace-name>-worktrees/<safe-role-name>
```

Unicode role names are allowed, but filesystem/Git-invalid characters such as
`/` are rejected. The lane is reused across dispatches. Agents split workspace
commits by logical delivery/box; boxes do not create branches.

Confirmed dispatch:

1. validates owner overlap;
2. writes `owner` and `status: doing` on a newly claimed box;
3. updates `temp/<role>/manifest.yml` with all current claims;
4. creates/reuses the role workspace lane;
5. writes a task envelope under `temp/<role>/tasks/`;
6. returns the relay prompt for delivery to the agent session.

Manifest fields include `claims`, `readable`, `writable`, `preloaded`, and the
workspace lane. Dynamic claim/task data never enters role init.

`temp/<role>/manifest.yml` is a snapshot from dispatch time. Changing a box's
`readable`, `writable`, or `type` after dispatch does not affect already issued
manifests; dispatch the concrete box again after release if the role needs a
fresh contract.

The task envelope is the machine-readable delivery record. Its prompt body is immutable;
its `status` field flips one way from `pending` to `taken` when `task-ack`
acknowledges the task. The claimed box remains the task truth: scope, background,
context, and acceptance criteria belong in the box body or child boxes. A
draft or incomplete box may be dispatched; after `task-ack`, the agent aligns the task, asks
when unclear, and writes confirmed conclusions back to the box.

Role init is stable and cache-friendly:

```text
temp/<role>/init.md
```

It contains only Tent identity, the `RULES.md` pointer, role prompt, and honor
protocol. A task envelope must contain the user prompt that caused dispatch.
Whether to reuse an existing session is controlled by the user, not Tent.

## 5. Completion And Interruption

An agent's report is still its chat response. To make that delivery reviewable
in the Obsidian UI, the agent also submits the same text and its commit refs to
the deterministic temporary path `temp/<role>/reports/<boxId>.md`. A report has
no id and is not permanent history.

Only user confirmation completes delivery.

**Complete**

1. if `--require-check <command>` is supplied, run it in the integration
   workspace before any workspace or Tent mutation;
2. integrate every commit bound to the ready report into the workspace target
   branch (normally `main`): fast-forward when the selected commits are exactly
   the complete `target..last` interval, otherwise use conflict-aware
   cherry-pick;
3. if integration succeeds, set the accepted box to `done`, clear its direct
   owner, record `acceptedBy`, then remove the temporary report;
4. if the required check or integration fails, leave workspace state and Tent
   owner/status/report state unchanged.

A report can be rejected by manually setting the temporary report `status` to
`rejected` (or by UI affordances that do the same). This performs no workspace
integration, keeps the owner and `doing` state, and lets the agent replace it
with a revised delivery.

The workspace target branch must be checked out and clean. A cherry-pick batch
is atomic: Tent records the original target tip and resets the workspace to it
if any selected commit fails. Tent never pushes. Repeated confirmation of the
same `-x` cherry-pick is idempotent.

**Interrupt / force release**

- performs no workspace integration;
- sets the directly owned box to `todo`;
- clears its owner;
- removes any temporary report for that box;
- preserves the role branch/worktree and all workspace changes.

Completion and interruption are distinct core actions even if a UI groups them
under one release control.

## 6. Proposal, Report, And Fork

Proposal:

- agent-to-user prompt text about one target box;
- deterministic temporary path `temp/<role>/proposals/<boxId>.md`;
- no tree box is created or modified by submission;
- the lifecycle is `pending -> accepted` or `pending -> rejected`;
- only pending proposals enter triage;
- accepted and rejected proposal files remain on disk so the submitting agent can read the result.

Report:

- agent-to-user delivery text plus an all-or-nothing commit list;
- deterministic temporary path, no id and no archive;
- the lifecycle is `ready -> rejected -> ready` until user confirmation removes it;
- only a ready report enables completion in the UI.

Fork:

- copies a complete subtree, including output boxes;
- changes only the copied root name;
- preserves descendant names and content;
- regenerates all copied box ids;
- clears copied owner/status;
- records no permanent lineage or A/B selection history.

Forking is available through the CLI/UI and through automatic adoption of a native
Obsidian subtree copy.

## 7. Mutation And Conflict Rules

Every Tent mutation uses a short-lived per-Tent global lock at
`.tent/mutation.lock`. This serializes file writes from the CLI and Obsidian
without restricting agent work in workspace worktrees.

Core fails loudly on:

- duplicate ids that are not adopted copies;
- owner overlap on confirmed dispatch;
- stale/active mutation lock;
- multiple workspace output boxes;
- dirty or wrong workspace target branch;
- Git integration conflict;
- invalid order/type state.

Core does not hard-enforce role competence, prompt precedence, or semantic write
intent. Agents are expected to stop and ask the user when honor rules conflict.

## 8. OKF Projection

`tent okf-sync` projects resolvable wiki links to relative Markdown links and
writes root/folder `index.md` plus a root `log.md`. Since Tent has no Git,
`log.md` is an OKF placeholder rather than repository history.

The vendored validator lives in `vendor/okf-conformance/`.

```text
npm run okf:check
npm run okf:check:strict
```

## 9. CLI Surface

Run from a Tent root:

```text
tent role-init <role>
tent roles
tent dispatch <boxId> <role> [prompt...] [--as-sub --by <role>]
tent task-ack <taskPath>
tent report <boxId> <bodyFile|-> [--commits <sha,sha>]
tent complete <boxId> [--commits <sha,sha>] [--require-check <command>] [--by <role>]
tent stamp <boxId> [--by <role>]
tent status
tent force-release <boxId>
tent new-box <name> <type> [parentId]
tent fork <boxId>
tent clean-temp [role]
tent okf-sync
tent skill-install [--target claude] [--force]
tent tree
```

`stamp` is completion without workspace commits. `complete` is the normal
workspace-aware acceptance path. When a ready report exists, `complete`
defaults to that report's commit list; an explicit `--commits` list overrides
it. A successful `complete` consumes the ready report after integration and
state mutation succeed. With no report and no explicit commits, `complete`
remains equivalent to the zero-integration `stamp` path. A rejected report must
be replaced before `complete` may proceed.

`status` is a read-only status view for quick orientation: Tent root, workspace,
pending proposals, pending task envelopes, and active claims.

`--require-check` is a user-supplied mechanical gate. It runs in the resolved
workspace before cherry-pick, owner clearing, report deletion, or any other
mutation. A non-zero exit or missing command aborts completion. `--by <role>`
records the accepting role in `acceptedBy`; without it, acceptance is recorded
as `user`.

## 10. UI Contract

The UI renders core state and invokes core actions:

- property edits and drag/drop update files immediately;
- native copy is adopted as fork;
- report text stays in the conversation layer;
- proposals are temporary prompt deliveries resolved by confirmation or rejection;
- completion presents the selected commit-integration step and releases the owner only after integration;
- interruption releases owner without integration;
- pending task envelopes are shown as task envelopes; copying relay text does
  not consume them, only `task-ack` does;
- immutable names have no rename control;
- errors are shown rather than silently repaired.

The UI may change presentation, but must not invent a second lifecycle.
