# Tent Specification

Tent / 帷幄 is an OKF v0.1 bundle plus a coordination layer for user-agent work.
The Obsidian plugin and CLI are clients of the same core rules.

## 1. Two Spaces

A Tent lives **in-workspace**: the Tent system root is always
`workspaceRoot/.tent`. Workspace root is derived from that layout (the parent of
the `.tent` directory), not from a box field or a type-axis “workspace pointer.”

- **Workspace** is the real project root. It stores code and deliverables and
  must use Git when agents integrate commits.
- **Tent (system root)** stores intent, context, box state, role contracts, and
  task envelopes under `.tent/`. It consists of plain files and does not use
  Git.

Task code channels use **WorkspaceLane** fields on the task envelope
(`workspace`, `worktree`, `branch`, `targetBranch`). Service/core prepares the
lane at dispatch or managed execution; agents do not invent those paths.

`output` is the built-in primary type for real deliverables or structured
`artifactRefs` pointers. It is an ordinary concept type (not a workspace-binding
mechanism). Legacy names `note` and `artifact` migrate one-shot to `prompt` and
`output`; there is no permanent type alias. The retired `workspacePointer` type
axis is stripped on load and rejected on write.

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
id: cx-7k2f9q
type: goal
tags: [backend]
mode: archived
```

- Concepts have persistent ids: `cx-` plus a short collision-checked suffix
  (legacy `bx-` migrates one-shot).
- A box name is chosen at creation. Controlled renames go through Service.
- Native moves are supported; paths may change while ids stay stable.
- Durable Node facts are body, id, hierarchy/relations, type/tags, archive, and
  annotations. Collaboration progress is projected from Task/Session/Delivery.
- Legacy `owner` / `status` / `acceptedBy` are stripped by one-shot migration and
  are never written by runtime claim/accept paths.
- Tags are orthogonal lookup facets (not a substitute for secondary type).

Duplicate ids are never silently indexed. A native copied subtree is adopted as
a fork: every copied box gets a fresh id and copied `owner`/`status` are
cleared. Any duplicate that cannot be identified as a fresh copy is invalid.

## 3. Type Model (V0.2)

`.tent/types.json` is a flat type map storing **tier only** (`base` |
`modifier`). Domain R/W, coordination, color, and description are not part of
the type domain.

**Canonical primary types (fixed product set):** `goal` | `prompt` | `output`.

**Built-in secondary (optional modifiers):** `reference` | `asset`. Users may
register additional custom secondaries without chrome; tags remain the reusable
cross-cutting facet.

A compound type such as `goal-asset` is `base-modifier`. Type is semantic only:
every valid non-archived concept may be claimed and enter the task lifecycle.
There is no `coordination` gate and no note→box promote path.

**Node mode:** default editable; `mode: archived` freezes the subtree (soft
delete / history). There is no `read-only` mode.

**Mutation gate:** invalid or archived Nodes reject content/structure writes.
Agent-visible context comes from Task claims and manifest **context pointers**,
not from Node `readable`/`writable` axes (those axes are retired).

One-shot migration rewrites `note`→`prompt`, `artifact`→`output`, strips domain
R/W and type chrome, and clears legacy `read-only` mode. No permanent dual-write
or runtime type alias.

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

1. validates structural gates (invalid/archived) for the target Node;
2. updates `temp/<role>/manifest.yml` with readable/writable context pointers
   for the ephemeral dispatch selection (no `claims` YAML key);
3. creates/reuses the role workspace lane when Git is present;
4. writes a pending task envelope under `temp/<role>/tasks/` with Node refs
   only on `contextCard.refs.nodes[]` (never a second on-disk `claims` source);
5. returns the relay prompt for delivery to the agent session.

Dispatch authority is independent of the dispatcher's `readable` and `writable`
manifest grants. Those grants govern the receiving role's work contract, not
who may start work on a Node. The dispatch gate is structural: the target must
not be archived or structurally invalid. Node refs are non-exclusive.

When the in-workspace Git root exists, the CLI derives and creates/reuses the
target role's **WorkspaceLane** from the role name
(`branch: tent-role/<role>`, `worktree: <parent>/<workspace>-worktrees/<role>`);
neither dispatcher nor receiver hand-writes those envelope fields. Without a
Git workspace, a normal peer dispatch is a valid pure-Tent task and its envelope
has no WorkspaceLane.

`--as-sub --by <role>` sets envelope `asSub: true` (Git-lane sub marker), writes
explicit `parentActor`/`reviewer` for the parent Role, and sets `targetBranch`
to the parent role branch (`tent-role/<parent>`). Sub commits integrate into
that parent lane (not mainline). Service `task.dispatch` with `asSub: true` is
the same contract for durable role and agentProfile assignees. **asSub rule:**
sub dispatch requires a durable registry parent Role (not `user`, not the
assignee) and a real Git WorkspaceLane for that parent; it fails before
envelope creation without them. User/peer dispatch does not require a Git
workspace. Missing `asSub` reads as peer (`false`). Review authority uses
`parentActor`/`reviewer`, not `asSub`. Legacy `dispatchedBy` migrates once to
the explicit wire and is not dual-written.

Manifest fields include `readable`, `writable`, and the workspace lane.
Task Node refs live only on `Task.contextCard.refs.nodes[]` — Manifest YAML
does not persist a second `claims` source. Dispatch selection is ephemeral
(`claimBoxes` / `claimRoot` input only). Dynamic task data never enters role init.

`temp/<role>/manifest.yml` is a snapshot from dispatch time. Changing a box's
`readable`, `writable`, or `type` after dispatch does not affect already issued
manifests; dispatch the concrete box again after release if the role needs a
fresh contract.

The task envelope is the machine-readable delivery record. Its prompt body is immutable;
its `status` field flips one way from `pending` to `taken` when `task-ack`
acknowledges the task. Neither dispatch nor `task-ack` dual-writes Node
`owner`/`status`; occupation is the active Task envelope only. Until claim,
the pending envelope is the dispatch placeholder and blocks dispatch of the
same box or any overlapping ancestor/descendant subtree. The claimed box
remains the document truth: scope, background, context, and acceptance
criteria belong in the box body or child boxes. A draft or incomplete box may
be dispatched; after `task-ack`, the agent aligns the task, asks when unclear,
and writes confirmed conclusions back to the box.

Role init is stable and cache-friendly:

```text
temp/<role>/init.md
```

It contains only Tent identity, the `RULES.md` pointer, role prompt, and honor
protocol. A task envelope must contain the user prompt that caused dispatch.
Whether to reuse an existing session is controlled by the user, not Tent.

## 5. Completion And Interruption

An agent's chat response is still human-readable progress. Formal delivery is a
**Delivery** record (`dl-`) written under `temp/<role>/deliveries/<dl-id>.md`
(or `temp/agent-profiles/<profile>/deliveries/…` for profile tasks). The body
of that file is `Delivery.summary` — the same report text the user reviews —
with commits, checks, artifactRefs, and review metadata in frontmatter.

Only user confirmation (`task.accept`) completes delivery under the default
`review` policy. Agents submit via `task.deliver` / `tent task deliver`.

**Accept (task.accept)**

1. optional workspace checks and commit integration run before Tent mutation
   when the ready Delivery lists commits;
2. integrate every commit bound to the ready Delivery into the workspace target
   branch (normally `main`): fast-forward when the selected commits are exactly
   the complete `target..last` interval, otherwise use conflict-aware
   cherry-pick;
3. if integration succeeds, mark the task `accepted`, record review on the
   Delivery, leave the accepted Delivery file for operational history/retention
   (Node frontmatter is not dual-written);
4. if integration fails, leave workspace state and Task/Delivery state unchanged.

A Delivery can be rejected (`task.reject`). This performs no workspace
integration, keeps occupation via task state (resume path), marks the Delivery
`rejected`, and lets the agent deliver again.

The workspace target branch must be checked out and clean. A cherry-pick batch
is atomic: Tent records the original target tip and resets the workspace to it
if any selected commit fails. Tent never pushes. Repeated confirmation of the
same `-x` cherry-pick is idempotent.

**Interrupt / force release**

- performs no workspace integration;
- ends occupation by terminating active tasks for the box (interrupt/cancel/fail);
- removes non-accepted Delivery records for that box;
- does not write Node `owner`/`status`;
- preserves the role branch/worktree and all workspace changes.

Completion and interruption are distinct core actions even if a UI groups them
under one release control.

## 6. Proposal, Delivery, And Fork

Proposal:

- agent-to-user prompt text about one target box;
- deterministic temporary path `temp/<role>/proposals/<boxId>.md`;
- no tree box is created or modified by submission;
- the lifecycle is `pending -> accepted` or `pending -> rejected`;
- only pending proposals enter triage;
- accepted and rejected proposal files remain on disk so the submitting agent can read the result.

Delivery:

- formal agent-to-user delivery record (`dl-`) under
  `temp/<role>/deliveries/<dl-id>.md` (or profile deliveries dir);
- body is `Delivery.summary` (user-facing report text) plus commits, checks,
  artifactRefs, and review metadata in frontmatter;
- lifecycle is `ready -> rejected -> ready` until `task.accept` marks it
  `accepted` (accepted files remain for operational history/retention);
- only a ready Delivery enables completion under the default `review` policy.

Fork:

- copies a complete subtree, including artifact boxes;
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
- owner or pending-envelope overlap on confirmed dispatch;
- stale/active mutation lock;
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
tent task list|get|claim|deliver|accept|reject|…
tent task dispatch <boxId> <role> [prompt...] [--as-sub --by <role>]
tent task dispatch <boxId> --profile <profileId> [prompt...]   # one-shot agentProfile + startSession; does not register a role
tent dispatch <boxId> <role> [prompt...] [--as-sub --by <role>]   # legacy external root only
tent task-ack <taskPath>
tent task-cancel <taskPath>
tent complete|stamp                  # retired (no Node owner/status dual-write)
tent status
tent force-release <boxId>
tent new-box <name> <type> [parentId]
tent fork <boxId>
tent clean-temp [role]
tent okf-sync
tent skill-install [--target all|claude|shared-agents] [--force]  # default: all
tent tree
```

Formal delivery is **Delivery-only** via `tent task deliver` / `task.deliver`.
There is no legacy `tent report` path. `stamp` / `complete` are **retired**
(they no longer dual-write Node `owner`/`status`; use `task.accept` /
`task.fail`). Desktop and in-workspace mutates use Local Service `task.*` only.
When a ready Delivery exists, `task.accept` uses that Delivery's commit list; an
explicit `--commits` list may override. Accepted Deliveries remain as
operational history (subject to retention). Rejected Deliveries stay until the
agent delivers again or interrupt/force-release drops non-accepted records.

`status` is a read-only status view for quick orientation: Tent root, workspace,
pending proposals, pending task envelopes, and active (claimed) tasks.

Legacy `--require-check` was a user-supplied mechanical gate on external-root
`complete` (now retired with that command). Workspace integration gates live on
the Service/task accept path instead.

## 10. UI Contract

The UI renders core state and invokes core actions:

- property edits and drag/drop update files immediately;
- native copy is adopted as fork;
- chat progress stays conversational; formal report body is `Delivery.summary`;
- proposals are temporary prompt deliveries resolved by confirmation or rejection;
- completion integrates commits then accepts the task (Node FM is not dual-written);
- interruption ends active tasks without integration;
- pending task envelopes are shown as task envelopes; copying relay text does
  not consume them, only `task-ack` does;
- pending task envelopes may be cancelled without force-release; taken tasks
  require the interruption path because the box is already claimed;
- immutable names have no rename control;
- errors are shown rather than silently repaired.

The UI may change presentation, but must not invent a second lifecycle.
