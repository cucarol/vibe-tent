# Immutable identity & rename foundations (batch 1)

Status: implementation note for Core / Local Service  
Scope: unify identity/ref conventions; RoleDefinition stable `rl-` id + mutable `displayName`  
Non-scope: moving `temp/<role>/`, Git branch/worktree renames, bulk historical task rewrites, type/tag id injection

## 1. Entity identity map

| Entity | Stable id | Mutable label | Path / operational key | Batch 1 action |
| --- | --- | --- | --- | --- |
| **Node / concept** | `cx-…` (legacy `bx-` only in migration window) | folder stem / optional `title` | OKF path (`Name/Name.md`) | Already has immutable id; **native rename not implemented** — contract below for next batch |
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

- Missing `id` → **deterministic** `rl-` from `name` (`sha256("tent.role.id.v1:" + name)` encoded with the shared id alphabet). Same name always gets the same id across loads.
- Missing `displayName` → `name`.
- First successful load **writes back** filled fields so disk and memory agree.
- New `createRole` assigns a **random** collision-checked `rl-` (not derived from name).

### Resolve (compat)

`resolveRole(roles, ref)` order:

1. exact `id`
2. exact operational `name`
3. exact `displayName`

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
| update | resolve by `name` or `roleId`; may change `displayName` / metadata; **cannot** change `id` or operational `name` |
| delete | confirmation = operational `name` **or** `id`; blocks active role task / managed session |

## 3. Deferred: operational name / temp / git

Changing `name` would require:

1. rename `temp/<old>/` → `temp/<new>/` (tasks, deliveries, init)
2. rewrite open task envelopes / manifests `role:` fields
3. rename role worktree / branch if present (`tent-role/<name>`)
4. update order / any path caches

**Explicitly out of batch 1.** Callers that need a visible rename use `displayName` only.

## 4. Node rename contract (next executable batch)

Native rename is still unsupported in product code. When implemented, service must:

1. **Identity:** keep frontmatter `id` (`cx-`) unchanged; never accept client id edits.
2. **Atomic tree move:** rename folder and same-named identity note together (`Old/Old.md` → `New/New.md`); refuse if target exists.
3. **Subtree:** move entire directory tree; child relative structure preserved; each child keeps its `cx-`.
4. **Links:** rewrite internal Markdown / wiki links that targeted the old path (and optional title links) within the tent system root; do not invent a second id.
5. **Order / attachments:** `order.json` keys that are paths update to new paths; attachment store keyed by `cx-` stays put.
6. **Occupancy:** refuse rename when the box or descendants have active task occupation (same spirit as delete/fork guards), unless a later contract adds force.
7. **Events:** emit `concept.changed` / path updates once; no dual `box.changed` channel.
8. **UI:** primary label is path stem / title; `cx-` remains copy/diagnostics only.

If any of (2–5) cannot ship atomically, keep rename rejected and leave this section as the acceptance checklist for the follow-up task.

## 5. Tests required (batch 1)

- roles.json round-trip with `id` + `displayName`
- legacy rows without `id` get deterministic fill and persist
- create gets random `rl-`; id immutable on update
- displayName rename; operational name rename rejected
- `resolveRole` accepts id / name / displayName
- registry projection includes `roleId` + `displayName`
- task/session authority still resolves historical **name** refs

## 6. Related

- `src/core/id.ts` — `rl-` generators + deterministic fill
- `src/core/skillRoleRegistry.ts` — RoleDefinition + resolve
- `docs/desktop/concept-model.md` — concept `cx-` / path dual identity
- `docs/desktop/task-api.md` — task envelope still stores role name labels
