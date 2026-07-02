---
name: tent-genesis
description: 创建全新的 Tent / 帷幄：grill 帐名、Obsidian vault、唯一真实 workspace、首批框与 role，scaffold 无 Git 的 Tent，并初始化或连接真实 workspace Git 仓库。
---

# tent-genesis

Use when the user wants to create a Tent from scratch.

## Protocol

1. Grill for the Tent name, Obsidian vault path, one real workspace path, first
   concrete outcome, initial boxes, and role names.
2. For each new role, run a tiny `/grilling`-style calibration. Keep the feel
   of `$grill-me`, but make it lightweight: ask one pointed question about what
   the role should roughly handle, and at most one follow-up about what it
   should avoid or when it must stop and ask the user. If the user says
   "都可以", "你定", or otherwise delegates judgment, infer a practical role
   from the Tent's goal. Draft a short `description`, `prompt`, and optional
   `color`, show them to the user for confirmation, then write the role
   definition. Stop as soon as the role is clear enough; do not introduce skill
   slots, presets, complex permissions, or workflow theory.
3. Run `tent new <tent-name> --vault <vault-path>`. The CLI reads the vault's
   configured `tentsRoot`; do not hardcode it or place the Tent at vault root.
   For a standalone Tent, `tent new <explicit-path>` is allowed.
4. The scaffold contains `RULES.md`, `.tent/types.json`, `.tent/roles.json`,
   `.tent/tags.json`, and `temp/`. It creates no generic zones and no Tent Git
   repository. Do not create `SPEC.md`, agent config files, or `.gitignore`.
5. Initialize the real workspace as a Git repository when needed. Prefer a
   `main` target branch. If it already is a repository, preserve its history and
   current configuration.
6. Create the concrete box tree from the grill. Every box is a folder plus a
   same-named Markdown note with `id: bx-<six random chars>` and `type`.
   Names are immutable after creation. Do not create legacy `kind`.
7. Create one output box that maps the Tent to the workspace with `workspace`
   and optional current `ref`. A Tent must not point to multiple workspaces.
8. Write `{ "roles": [{ "name", "description"?, "prompt"?, "color"? }] }` to
   `.tent/roles.json` and put project-specific conventions in `RULES.md`.
9. Commit the initial workspace only when genesis created or intentionally
   changed workspace files. Never commit the Tent.

Do not create `.tent/skills.json` or `for:` links.
