---
name: tent-init
description: "Initialize or adopt a software project as a Tent (帷幄) workspace. Use when a user asks to create a new Tent, add Tent to an existing or in-progress project, onboard a project into Tent, or derive an initial Tent Node and Role structure from the current working context or project files. Preserve existing work, draft the initial structure before mutation, and require user approval before materializing an existing project's Nodes."
---

# tent-init

Use this one-time onboarding contract to establish a Tent workspace. It does not replace `tent-role` or `tent-task`: after initialization, load those Skills only when an executor enters a durable Role or executes a Task.

## Establish the project root

1. Resolve the directory the user means. Prefer the Git root for an existing repository unless the user explicitly chooses a subdirectory.
2. Check for an existing `.tent/`, workspace-root `AGENTS.md`, Git state, and the public `tent` CLI before mutation.
3. If `.tent/` already exists, do not initialize again. Re-query the existing workspace and offer mounting or orientation. When it is an orphan with a missing index and recognizable generic Tent evidence, use the explicit one-shot `tent new <target> --repair-existing`; it must fail closed for empty, unrecognized, invalid-index, or already-valid state.
4. Never overwrite `AGENTS.md`, application files, Git history, uncommitted changes, or an existing Tent.

For a repository with uncommitted work, explain that those changes are not part of a Task worktree's recorded Git base. Do not commit, stash, reset, clean, or discard them on the user's behalf.

## Reuse current working context

First decide whether the current working context already captures the project.

- **Context-rich execution:** when the executor can accurately state the current objective, confirmed decisions, active problems, existing outputs, and workspace, reuse that context. Re-check only mutable facts such as root path, current Git state, `AGENTS.md`, and whether Tent already exists.
- **New or uncertain execution:** inspect a bounded set of high-signal sources such as `AGENTS.md`, README, documentation indexes, package/project manifests, Git status, and recent history. Search for specific gaps instead of reading the whole repository.

Working memory is evidence for drafting, not durable truth. User approval and persisted Tent state make the result authoritative.

## Draft the initial Node map

Before creating Nodes for an existing project, present a compact proposed tree. Do not mirror the file tree or import documents wholesale.

For each proposed Node show:

- name and parent;
- primary type: `goal`, `prompt`, or `output`;
- optional secondary type only when its symbol or behavior matters;
- a small reused tag vocabulary;
- source pointers to relevant workspace files, Git facts, deliverables, or confirmed working context;
- one short reason the Node belongs in the initial map.

Use `goal` only for a real objective or outcome. Use `prompt` for context, work, questions, decisions, and constraints. Use `output` for an existing or intended deliverable or its workspace pointer. Prefer a few useful Nodes over exhaustive coverage.

For an existing or in-progress project, wait for explicit user approval. Offer to accept, edit, or simplify the map. Do not materialize it merely because the executor feels confident.

For a new project, ask at most one or two lightweight questions about the intended outcome and immediate scope. If the user delegates the details, propose a minimal map and proceed after their confirmation.

## Initialize through supported Tent surfaces

- New directory: use `tent new <path>`.
- Existing project root: run `tent new .` from that root.
- Existing orphan `.tent/`: use `tent new <target> --repair-existing` only for the narrow re-adopt case above. It preserves existing bytes and fills structural gaps; it is not a migration or doctor framework.
- Use only public Tent CLI, Desktop, or Service mutation surfaces. Never hand-write files under `.tent/` or call provider adapters directly.
- If CLI attach rejects a legacy or incompatible Local Service protocol, stop and report the exact version/endpoint mismatch. Do not initialize through private RPC, direct provider calls, or hand-written `.tent` state.
- Preserve an existing workspace-root `AGENTS.md`. Tent operational state belongs under `.tent/`, which the initializer adds to Git ignore rules.
- A non-Git project may use Tent Nodes, but managed worktrees and commit integration require Git. Ask before initializing Git.

After approval, create parents before children with `tent node create`, pass substantial bodies through stdin, and retain every returned stable ID. Use `tent node write|rename|move|type|tags|archive|restore` for corrections. If the installed CLI does not expose `tent node`, stop after the approved draft and report that exact version gap; never fall back to direct filesystem edits or raw private RPC calls.

## Verify and hand off

1. Mount or attach the workspace through Local Service and re-query it.
2. Verify the persisted Node tree, types, tags, pointers, and workspace root against the approved draft.
3. Show the resulting structure to the user and correct only requested differences through official mutations.
4. Offer, but do not force, creation of the first durable Role. If the current executor will remain accountable, enter that Role and load `tent-role`.
5. Load `tent-task` only when concrete work is dispatched or claimed.

Finish with the workspace root, created Node IDs, any Role created or entered, Git/dirty-state warning, and remaining explicit choices. Do not leave behind temporary onboarding Nodes, copied project summaries, or duplicate rules files.
