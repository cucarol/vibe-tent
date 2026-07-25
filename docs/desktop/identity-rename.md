# Immutable identity & rename foundations (batch 1)

Status: implementation note for Core / Local Service  
Scope: unify identity/ref conventions; RoleDefinition stable `rl-` id + mutable `displayName`  
Non-scope: moving `temp/<role>/`, Git branch/worktree renames, bulk historical task rewrites, type/tag id injection

## 1. Entity identity map

| Entity | Stable id | Mutable label | Path / operational key | Batch 1 action |
| --- | --- | --- | --- | --- |
| **Node / concept** | `cx-…` (legacy `bx-` only in migration window) | folder stem / optional `title` | OKF path (`Name/Name.md`) | Immutable id; **native rename via `docs.rename`** (atomic move + link rewrite + rollback) |
| **AgentProfile** | profile `id` (machine-local) | `displayName` / `displayNameKey` | n/a (not tent-tree) | Already id-based; no change |
| **Role** | **`rl-…` (new)** | **`displayName` (new)** | `name` → `temp/<name>/`, `task.role`, worktree labels | **Implement**: fill id + displayName; project both; compat resolve |
| **Type** | registry key string | same string (UI) | `types.json` key; box `type` field | **No id** this batch — keys are semantic R/W vocabulary; rename would rewrite every box type string (separate batch if product needs it) |
| **Tag** | registry string | same string | `tags.json` + frontmatter arrays | **No id** this batch — tags are lookup facets; rename is a later global string rewrite |

**Rule:** do not invent ids “for uniformity.” Only entities whose references must survive renames get stable handles.

## 2. Role model (batch 1)

```ts
type RoleDefinition = {
  id: string;           // rl-… immutable after create / migration fill
  name: string;         // operational key (temp path, task.role) — not renamed this batch
  displayName: string;  // mutable human label; defaults to name
  prompt?: string;
  description?: string;
  color?: string;
  a2aPolicy?: "allow" | "ask" | "deny";
  allowedProfiles?: string[];
  cli?: { command: string; resume?: string };
};
```

### Load / migrate

- Missing `id` → **deterministic** `rl-` from `name` via platform-neutral digest of `tent.role.id.v1:` + name, encoded with the shared id alphabet (no `node:crypto`). Same name always gets the same id across loads.
- Missing `displayName` → `name`.
- Ordinary **`loadRolesRegistry` projects legacy ids in memory only** — it does **not** write the registry. Persist filled fields only through an explicit mutation (`createRole` / `updateRole` / `deleteRole` / service registry CRUD), which rewrites the full normalized registry.
- New `createRole` assigns a **random** collision-checked `rl-` (not derived from name).

### Resolve (compat)

`resolveRole(roles, ref)` order:

1. exact `id` (`rl-…`)
2. exact operational `name` (legacy task/session/envelope refs)

**Never resolve by `displayName`.** Display labels are presentation only; duplicates are allowed and must not create ambiguous identity.

Task envelopes, sessions, and historical refs may still carry **name** strings. Do **not** rewrite historical task files in this batch. New internal service logic should prefer `roleId` when both are available.

### Projection (`registry.roles` / CRUD results)

```ts
type RoleRegistryEntryProjection = {
  roleId: string;
  name: string;
  displayName: string;
  // …metadata, a2aPolicy, allowedProfiles
};
```

UI must show **displayName**, not raw `rl-` ids, in primary chrome.

### Mutations

| Op | Identity |
| --- | --- |
| create | client supplies `name` (+ optional `displayName`); server assigns `id` |
| update | resolve by `roleId` or operational `name` only; may change `displayName` / metadata; **cannot** change `id` or operational `name` |
| delete | resolve by `roleId` or operational `name` only; confirmation = operational `name` **or** `id`; blocks active role task / managed session |

## 3. Deferred: operational name / temp / git

Changing `name` would require:

1. rename `temp/<old>/` → `temp/<new>/` (tasks, deliveries, init)
2. rewrite open task envelopes / manifests `role:` fields
3. rename role worktree / branch if present (`tent-role/<name>`)
4. update order / any path caches

**Explicitly out of batch 1.** Callers that need a visible rename use `displayName` only.

## 4. Node rename contract (implemented)

Native concept rename is available as user-only Service RPC **`docs.rename`** (MutationBus).

1. **Identity:** keep frontmatter `id` (`cx-`) unchanged; never accept client id edits.
2. **Atomic tree move:** rename folder and same-named identity note together (`Old/Old.md` → `New/New.md`); refuse if target exists.
3. **Subtree:** move entire directory tree; child relative structure preserved; each child keeps its `cx-`.
4. **Links:** rewrite internal Markdown / wiki links that targeted the old path within the tent system root. Unqualified wiki/name targets rewrite only when Tent link resolution uniquely targets the renamed node; ambiguous duplicate names are left unchanged. Do not invent a second id.
5. **Order / attachments:** `order.json` is id-keyed (no path rewrite); attachment store keyed by `cx-` stays put.
6. **Occupancy:** refuse rename when the box or descendants have active task occupation (same spirit as delete/fork guards), unless a later contract adds force.
7. **Events:** emit exactly one `concept.changed` (`reason: docs.rename`) with `id`, `path`, `oldPath`; no dual `box.changed` channel.
8. **Rollback:** snapshot every touched note's original path/content before writes; on any post-move write failure restore completed note writes in reverse order, reverse identity rename, and move the tree back.
9. **UI:** primary label is path stem / title; `cx-` remains copy/diagnostics only.

Core entry: `renameNode` in `src/core/renameOps.ts`. Client: `ServiceRpcClient.docsRename`.

## 4.1 Node move / reparent contract (implemented)

Native structural move is available as user-only Service RPC **`docs.move`** (MutationBus). Canonical name only — **no** `docs.reparent` alias.

1. **Identity:** keep frontmatter `id` (`cx-`) unchanged; folder stem (display name) is preserved on reparent.
2. **Resolve:** moved node, destination parent, and before/after sibling are all stable `cx-` ids. `newParentId: null` = tent root.
3. **Stale path:** `expectedPath` is required. If `concept.path !== expectedPath` → `-32009` with `{ code: "path_stale", currentPath, expectedPath, id }` (tree identity, not body etag).
4. **Position:** `{ mode: "inside" }` appends under parent; `{ mode: "before"|"after", siblingId }` inserts among destination siblings (sibling must already live under that parent).
5. **Same-parent reorder:** updates id-keyed `order.json` only — **no** filesystem move, **no** link rewrite.
6. **Reparent:** moves the folder tree; builds subtree `pathMap`; rewrites path-based Markdown/wiki links (same engine as rename); rolls back notes + tree + order on post-move failure.
7. **Occupancy (placeBox freeze, not rename):** block when the moved node or target parent is occupied as `self` | `ancestor` | `root`. Ancestors of an occupied descendant **may** still move (claim moves with the subtree). Active Task envelopes only — not retired Node owner/status.
8. **Safety:** refuse cycle (into own subtree), name collision at destination, invalid/archived moved or parent, operational/system paths.
9. **Events:** emit exactly one `concept.changed` (`reason: docs.move`) with `id`, `path`, `oldPath`, `pathMap`.
10. **UI / relations:** no frontmatter edits; no relation CRUD in this RPC; parent hierarchy stays folder+order — never implemented as delete/create link edges.

Core entry: `moveNode` in `src/core/moveOps.ts`. Client: `ServiceRpcClient.docsMove`. Wire result: `{ id, path, oldPath, pathMap, rewrittenNotes }`.

## 5. Tests required (batch 1)

- roles.json round-trip with `id` + `displayName`
- legacy rows without `id` get deterministic **in-memory** fill; plain load performs **no write**
- create/update mutation persists filled ids when the registry is explicitly mutated
- create gets random `rl-`; id immutable on update
- displayName rename; operational name rename rejected
- `resolveRole` accepts id / name only — **not** displayName
- two roles may share the same `displayName` without ambiguous resolution
- registry projection includes `roleId` + `displayName`
- task/session authority still resolves historical **name** refs

## 6. Related

- `src/core/id.ts` — `rl-` generators + deterministic fill
- `src/core/skillRoleRegistry.ts` — RoleDefinition + resolve
- `docs/desktop/concept-model.md` — concept `cx-` / path dual identity
- `docs/desktop/task-api.md` — task envelope still stores role name labels
