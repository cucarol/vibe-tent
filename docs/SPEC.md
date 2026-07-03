# Tent Specification

Tent / 帷幄 is an OKF v0.1 bundle plus a coordination layer for user-agent work.
The Obsidian plugin and CLI are clients of the same core rules.

## 1. Two Spaces

A Tent points to exactly one real workspace:

- **Tent** stores intent, context, box state, role contracts, and temporary prompt
  pointers. It is plain files and does not use Git.
- **Workspace** stores code and real deliverables. It must use Git.

`output` is an ordinary box type, not a synonym for every delivery. An output
box may map the Tent to the workspace:

```yaml
id: bx-7k2f9q
type: output
workspace: C:/path/to/workspace
ref: 0123abcd
```

`ref` is a workspace commit. A Tent with multiple distinct workspace pointers
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
- A box name is chosen at creation. Tent has no rename operation.
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

A type is either a base or modifier. A compound type such as `goal-draft`
combines a base with a modifier. Each permission axis resolves independently:

1. invalid subtree forces false;
2. archived subtree forces false;
3. explicit box `readable` or `writable`;
4. modifier value when present;
5. base default, otherwise false.

Permission axes do not inherit from ancestors. Hierarchy expresses service
relationships. Legacy `kind` is read-compatible but new writes use only
`type`; `tent migrate-kind-to-type` performs the migration.

Manifest R/W is an honor contract, not an OS sandbox. Core enforces mechanical
invariants, not semantic prompt authority.

## 3.1 Overlay Format Migrations

OKF covers the interoperable Markdown bundle. Tent's overlay is the data that
only Tent understands: `.tent/` registries, `bx-` ids, owner/status semantics,
temp manifests, reports, handoffs, and permission resolution.

Any breaking overlay format change must ship with an idempotent
`tent migrate-*` command. Migration commands must:

- be named for the source and target shape, such as `migrate-kind-to-type`;
- be safe to run more than once;
- report touched files;
- preserve user-authored note body text;
- have regression tests covering old data and already-migrated data.

When upstream OKF changes, Tent updates the vendored conformance suite and, if
needed, provides an OKF-version migration anchored by `okf_version`.

## 4. Roles, Claims, And Dispatch

A role is `name + optional stable prompt`. One role represents one long-lived
agent session in a Tent. A role may own multiple non-overlapping boxes,
including boxes under unrelated parents.

Each role gets one long-lived workspace lane:

```text
branch:   tent-role/<safe-role-name>
worktree: <workspace-parent>/<workspace-name>-worktrees/<safe-role-name>
```

Unicode role names are allowed after filesystem/Git-invalid characters are
sanitized. The lane is reused across dispatches. Agents split workspace commits
by logical delivery/box; boxes do not create branches.

Confirmed dispatch:

1. validates owner overlap;
2. writes `owner` and `status: doing` on a newly claimed root;
3. updates `temp/<role>/manifest.yml` with all current claims;
4. creates/reuses the role workspace lane;
5. writes an immutable task envelope under `temp/<role>/tasks/`;
6. returns the task pointer for delivery to the agent session.

Manifest fields include `claims`, `readable`, `writable`, `preloaded`, and the
workspace lane. Dynamic claim/task data never enters role init.

Role init is stable and cache-friendly:

```text
temp/<role>/init.md
```

It contains only Tent identity, the `RULES.md` pointer, role prompt, and honor
protocol. A task must contain a user prompt and/or a handoff pointer. Whether to
reuse an existing session is controlled by the user, not Tent.

## 5. Completion And Interruption

An agent's report is still its chat response. To make that delivery reviewable
in the Obsidian UI, the agent also submits the same text and its commit refs to
the deterministic temporary path `temp/<role>/reports/<boxId>.md`. A report has
no id and is not permanent history.

Only user confirmation completes delivery.

**Complete**

1. integrate every commit bound to the ready report into the workspace target branch
   (normally `main`) using conflict-aware cherry-pick;
2. if integration succeeds, set the accepted box to `done` and clear its direct
   owner, then remove the temporary report;
3. if integration fails, leave Tent owner/status unchanged.

Rejecting a report performs no workspace integration, keeps the owner and
`doing` state, and marks the temporary report rejected so the agent can replace
it with a revised delivery.

The workspace target branch must be checked out and clean. Tent never pushes.
Repeated confirmation of the same `-x` cherry-pick is idempotent.

**Interrupt / force release**

- performs no workspace integration;
- sets the directly owned box to `todo`;
- clears its owner;
- removes any temporary report for that box;
- preserves the role branch/worktree and all workspace changes.

Completion and interruption are distinct core actions even if a UI groups them
under one release control.

## 6. Proposal, Handoff, Report, And Fork

Proposal and handoff are immutable temporary Markdown documents. Their path is
their identity; they have no persistent id.

Proposal:

- agent-to-user decision text in `temp/<role>/proposals/`;
- targets a readable box;
- state is `open -> accepted/rejected -> applied`;
- acceptance changes proposal state only and does not trigger an agent.

Handoff:

- agent-authored dispatch prompt in `temp/<role>/handoffs/hf-*.md`;
- may target any box and role;
- does not transfer or mutate owner;
- user confirmation performs the later dispatch using the handoff pointer.

Report:

- agent-to-user delivery text plus an all-or-nothing commit list;
- deterministic temporary path, no id and no archive;
- lifecycle is `ready -> rejected -> ready` until user confirmation removes it;
- only a ready report enables completion in the UI.

Fork:

- copies a complete subtree, including output boxes;
- changes only the copied root name;
- preserves descendant names and content;
- regenerates all copied box ids;
- clears copied owner/status;
- records no permanent lineage or A/B selection history.

Fork is available through Tent and through automatic adoption of a native
Obsidian subtree copy.

## 7. Mutation And Conflict Rules

Every Tent mutation uses a short global per-Tent lock at
`.tent/mutation.lock`. This serializes file writes from the CLI and Obsidian
without restricting agent work in workspace worktrees.

Core fails loudly on:

- duplicate ids that are not adopted copies;
- owner overlap on confirmed dispatch;
- stale/active mutation lock;
- multiple workspace pointers;
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
tent dispatch <boxId> <role> [prompt...] [--handoff <path>]
tent report <boxId> <bodyFile|-> [--commits <sha,sha>]
tent complete <boxId> [--commits <sha,sha>]
tent stamp <boxId>
tent force-release <boxId>
tent new-box <name> <type> [parentId]
tent propose <targetId> <role> <bodyFile|->
tent proposal <path> accept|reject [note]
tent apply <proposalPath>
tent apply-done <proposalPath>
tent handoff <fromBoxId> <targetId> <targetRole> <promptFile|->
tent fork <boxId>
tent clean-temp [role]
tent migrate-kind-to-type
tent okf-sync
tent skill-install [--target claude] [--force]
tent tree
```

`stamp` is completion without workspace commits. `complete` is the normal
workspace-aware acceptance path.

## 10. UI Contract

The UI renders core state and invokes core actions:

- property edits and drag/drop update files immediately;
- native copy is adopted as fork;
- report text stays in the conversation layer;
- completion presents selected commit integration and only then releases owner;
- interruption releases owner without integration;
- proposal acceptance does not dispatch;
- handoff creation does not transfer owner;
- immutable names have no rename control;
- errors are shown rather than silently repaired.

The UI may change presentation, but must not invent a second lifecycle.
