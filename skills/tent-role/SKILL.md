---
name: tent-role
description: 让 agent 进入现有 Tent 的长期 role session：读取稳定 init 与动态 task/manifest 指针，在真实 workspace 的 role worktree/branch 工作并提交，用 proposal、handoff、fork 协作，最后在聊天中报告 commit 等待 user 验收。
---

# tent-role

Use when an agent starts or resumes a role session inside an existing Tent.

## Model

- A Tent stores intent/context/state as plain files and does not use Git.
- One Tent points to one real Git workspace.
- One role is one long-lived session and one reusable workspace
  `worktree + branch`. A role may own several unrelated boxes.
- A box is a folder plus a same-named Markdown identity note. Its `bx-` id stays
  stable across moves. Hierarchy means service relationship.
- `manifest.yml` resolves `claims`, `readable`, and `writable`. Treat it as an
  honor contract. If instructions conflict with it, stop and ask the user.
- The report is your chat response. `tent report` also places a temporary,
  deterministic transport copy in Tent so the user can review it in Obsidian;
  it has no id and is removed after acceptance or interruption.

## Protocol

1. Confirm the working directory is the Tent root containing `RULES.md`,
   `.tent/`, and `temp/`. Otherwise stop and tell the user.
2. If the user asks you to create or initialize a role that is not already
   clearly defined, run a tiny `/grilling`-style calibration first. Keep the
   feel of `$grill-me`, but make it lightweight: ask one pointed question about
   what the role should roughly handle, and at most one follow-up about what it
   should avoid or when it must stop and ask the user. If the user says
   "都可以", "你定", or otherwise delegates judgment, infer a practical role
   from the current Tent context. Draft a short `description`, `prompt`, and
   optional `color`, show them to the user for confirmation, then write
   `.tent/roles.json` and run `tent role-init <role>`. Stop as soon as the role
   is clear enough; do not invent complex permissions, presets, or workflows.
3. On a new role session, read `temp/<role>/init.md` once. It contains only
   stable role context and is designed for prompt-cache reuse.
4. Read the task Markdown path supplied by the user. Then read its manifest,
   box pointers, user prompt, and/or the exact handoff pointer selected by the
   user. When a handoff pointer is present, read that file as agent-authored
   task context. Do not scan `temp/` for guessed work or choose a different
   handoff yourself.
5. Use the task's `worktree` as the real code working directory and its `branch`
   as your long-lived role branch. Reuse them on later tasks for this role.
6. Read `RULES.md` and only the manifest-readable context needed for the task.
   Write Tent files only inside `writable`. This is honor-based, not a sandbox.
7. Commit real workspace changes in logical batches aligned with boxes or
   independently reviewable deliveries. Do not commit Tent state.
8. Collaboration verbs:
   - `tent roles` reads the shared role registry before choosing a handoff
     target role.
   - `tent propose <targetId> <role> <bodyFile|->` creates agent-to-user
     decision text for a readable target.
   - `tent handoff <fromBoxId> <targetId> <targetRole> <promptFile|->` creates
     an immutable agent-to-agent prompt pointer carrying its target box and
     intended role. It does not change owner or dispatch. The user later
     chooses that specific handoff when dispatching the target box.
   - `tent fork <boxId>` copies a subtree, changes only its root name,
     regenerates ids, and clears owner/status.
9. Finish by replying in chat with what changed, what remains, tests run, and
   the workspace commit hashes grouped by box/delivery. Submit that same report
   for UI review with
   `tent report <boxId> <bodyFile|-> --commits <sha,sha>`. Do not mark boxes
   done. Only user confirmation completes work.

Proposal acceptance does not launch an agent. Handoff creation does not dispatch
or transfer ownership. `tent complete` and `tent force-release` are user-side
actions.
