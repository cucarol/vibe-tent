# Desktop Contract · Concept & Box Document Model

Status: **V0.2 Node/Type domain** (aligned with architecture Judge)  
Scope: OKF concept space, concept types `goal|prompt|output`, `cx-` handles, physical layout, links, attachments, operational exclusion, external-edit concurrency, Markdown MVP boundaries  
Non-goals: Task/Delivery state machine (`docs/desktop/task-api.md`), service process topology (`docs/desktop/architecture.md`), AgentRuntime adapters (`docs/desktop/agent-runtime.md`)

This document freezes the document model for independent desktop Tent. Canonical English names are API/schema truth. UI may localize labels via i18n; persisted enums never use localized values.

Peer contracts that must not invert these rules:

- Architecture: Local Service is the sole mutation entry; Markdown subsystem is a client of Query/Command.
- Task API: box occupation, assignee projection, and delivery review live in operational space; documents only supply concept identity and body.

---

## 1. Two spaces

```text
OKF concept space (user-facing Markdown)
├── concept (always has non-empty type ∈ goal|prompt|output [+ optional secondary])
└── (non-concept) operational space
    ├── task          tk-
    ├── delivery      dl-
    ├── session       ss-
    ├── handoff / claim / review records
    └── pipeline / temp envelopes
```

| Space | What lives there | Indexed as concept? | OKF validator? |
| --- | --- | --- | --- |
| **Concept** | User-facing Markdown nodes | yes | yes (subject to generated-file rules) |
| **Operational** | Task, delivery, session, handoff, claim, review, temp pipeline | **no** | **no** |

**One sentence:** content lives in concepts; collaboration lifecycle is projected from Task/Session/Delivery (every valid concept may be claimed); pipeline state lives in operational space and is cleaned by retention policy.

### 1.1 Hard exclusions from concept space

Never register as concepts:

- `.tent/**` system registries, locks, machine-agnostic collaboration facts that are not user notes
- `temp/**` and other pipeline envelopes
- Generated OKF helpers such as root/folder `index.md` / `log.md` as *user edit targets* (they may exist on disk for OKF compliance; they are not ordinary notes)
- Real workspace trees (source, project docs, builds)—only via **`ArtifactRef`**
- Machine-local service data (search index, window state, credentials, session rows, **AgentProfile** paths)
- Session registry / PIDs / resume tokens (task may hold `sessionId` only)

Operational Markdown **may** reuse the same renderer component in lifecycle panels. `DocumentController` / concept index **must not** list them as ordinary documents.

---

## 2. Identity model

### 2.1 Dual identity (not dual keys)

| Layer | Field | Role |
| --- | --- | --- |
| **OKF identity** | Bundle-relative path of the concept note (canonical path form) | Stable for OKF; changes on controlled rename/move |
| **Handle** | `cx-` + random collision-checked suffix | Immutable after create; used by task, relations, `contextRef`, migration continuity |
| **Display name** | Path stem and optional `title` | Human/agent-readable; **not** a third identity |

**Forbidden:**

- A second `boxId` distinct from `cx-`
- A `key` / semantic-slug identity competing with path
- Treating `cx-` as OKF concept name or as a second path
- Long-term dual `bx-` / `cx-` formats after cutover (migration is one-shot; dual-read only during the window)

### 2.2 Invariants

1. Path is the OKF identity. Frontmatter must not invent a parallel semantic key.
2. Every concept receives a random, stable, immutable `cx-` at creation.
3. UI does not emphasize `cx-` by default; expose it for copy, drag `contextRef`, diagnostics, and agent tools.
4. Controlled rename/move **changes** OKF path identity and **must** rewrite internal Markdown links and rebuild/update index entries. `cx-` proves “same concept” across the move.
5. Type changes keep the same path, body, and `cx-` (no promote / demote product path).

### 2.3 Frontmatter shape (contract)

```yaml
---
id: cx-a1b2c3          # stable handle; migration may rewrite legacy bx- once
type: prompt           # goal | prompt | output (+ optional -reference|-asset)
tags: [ui]             # optional lookup facets; orthogonal to secondary type
title: Optional title  # optional display override
mode: archived         # omit for editable default; only archived is persisted
# owner / status / acceptedBy — stripped by migration; not product fields
# artifactRefs: optional ArtifactRef[] to real deliverables (architecture §5.2)
---
# Markdown body
```

| Field | Rule |
| --- | --- |
| `id` | Required; `cx-…` after migration |
| `type` | Required; primary ∈ `goal\|prompt\|output`; optional secondary ∈ registry modifiers |
| `tags` | Optional; never replace type or hierarchy |
| `mode` | Omit = editable; `archived` freezes subtree. No `read-only` |
| legacy `status` / `owner` | **Stripped on migrate**; not written at runtime; occupation is Task-based |
| `artifactRefs` | Optional `ArtifactRef[]`; not concept identity |
| Readable/writable | **Retired** as domain axes; not honor ACL |

**Occupation authority:** only an **active Task envelope** occupies a box for mutual exclusion and for `box.projection` assignee/`activeTaskId`. See Task API §2.3.

**Active-task write guard:** ordinary **`docs.write`** must not set retired collaboration keys (`status`/`owner`/`assignee`). Service rejects those field patches; clients use Task API transitions and read `box.projection`. Non-projection body edits remain allowed subject to etag concurrency.

---

## 3. Type registry (V0.2)

### 3.1 Semantic types only

Type registry entries store **tier** (`base` | `modifier`). Domain R/W, coordination, color, and description are not product fields.

| Class | Values |
| --- | --- |
| Fixed primaries | `goal`, `prompt`, `output` |
| Built-in secondaries | `reference`, `asset` (custom modifiers allowed without chrome) |

One-shot migration: `note`→`prompt`, `artifact`→`output`; strip R/W/chrome; drop retired modifiers `open`/`sealed` from compounds. No permanent alias.

### 3.2 Concept terminology

| Term | Definition |
| --- | --- |
| **concept** / **Node** | User-facing Markdown in OKF concept space with non-empty `type` and a `cx-` |
| **box** | Historical synonym for concept in APIs; not a second file format |

Every valid non-archived concept may enter the task lifecycle. There is no coordination gate and no `docs.promote`.

### 3.3 Fork (parallel occupation)

Canonical command: **`docs.fork(boxId | path)`** (CLI alias: `tent fork`).

| Rule | Detail |
| --- | --- |
| Effect | Copy concept/box **subtree**; new `cx-` ids; clear owner/status occupation on the fork root |
| Does **not** | Start a task, claim, or session |
| Parallelism | After fork, `task.dispatch` on the fork root (Task API §2.4) |
| Active task | Source box occupation is unchanged unless separately interrupted |

Fork is a **docs** group command, not a Task API verb, and not an AgentRuntime call.

---

## 4. Physical layout (document tree, not workspace tree)

Principles:

- Organization follows Tent logical entities.
- On disk: ordinary directories + Markdown files under the **fixed** tent system location **`<workspace>/.tent/`** (architecture §3.1; name not reopened in B1).
- MVP **forces note layout isomorphic to box** so promote is zero-move.

| Form | Layout | MVP |
| --- | --- | --- |
| **Box concept** | `Name/Name.md` (folder + same-named identity note); nested folders express service/organization relations | **required** |
| **Note concept** | Same `Name/Name.md` isomorphism | **required** |
| **Transparent group** | Directory without same-named note; organizational only, **not** a concept | retained |
| **Attachments** | Prefer `.tent/attachments/<cx>/<name>-<contentId>.<ext>` (gitignore-friendly; original bytes on disk) | MVP minimum |
| **Single-file note** `Name.md` | Compatibility only | **post-MVP** |

Agents creating concepts must choose meaningful path/name segments; path remains OKF identity.

---

## 5. Document tree projection (UI)

### 5.1 Shown in the ordinary document tree

- All concepts (notes + boxes)
- Type color / badge; boxes additionally show `status` badge
- Hierarchy from folder nesting / parent relations

### 5.2 Not shown as ordinary tree nodes

- Operational entities (task, delivery, session, …)—lifecycle panels only
- Workspace source / project files (artifact chips + open-external only)
- Machine-local indexes and window state
- Tent system dir internals by default (diagnostic entry only; architecture)

### 5.3 Artifact association (`ArtifactRef`)

```ts
type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  target: string;
  label?: string;
};
```

| Mechanism | Purpose |
| --- | --- |
| **`ArtifactRef`** | Points to file, directory, commit, URL, or other real deliverable **outside** concept identity |
| Open action | Default: open with original tool / OS handler |
| Search | Artifact **bodies** are not in default concept search |

**Forbidden in MVP:** workspace file browser, source tree navigator, built-in code editor, LSP, IDE terminal, build panel, in-app commit diff, line-by-line review, full Git client UI.

---

## 6. Links, search, and attachments

### 6.1 Link model

| Layer | Form | Role |
| --- | --- | --- |
| Authoring | `[[Name]]` / `[[path\|label]]` / `[[path#heading]]` / `[[path^block]]` | User input; editor completion |
| Standard MD | `[label](dest)` and reference links, including `<angle dest>`, balanced/escaped parens, optional titles, query/fragment | Interop / OKF |
| Resolution keys | path, title/name, `cx-`, legacy `bx-` **during migration only** | Unique hit required to resolve |
| Backlinks | Inverted from outbound **concept** links in index | Side/bottom panel |
| artifact links | Structured **`ArtifactRef`** or dedicated scheme (`https:`, `mailto:`, `tent-artifact:`) | External open |

**Graph extraction (`src/markdown/links.ts`):**

- Uses block/inline scanning (not whole-document regex). Fenced/indented code, inline code, raw HTML/`script`/`style`, and escaped syntax do not contribute edges.
- Wiki links are taken only from prose text; heading/block suffixes resolve the concept target while `raw` retains the authoring form.
- Relative destinations normalize against the source concept note path; query/fragment are stripped for concept resolution.
- **Not** concept backlinks: external schemes, pure anchors (`#…`), attachment paths (`attachments/…` and relative climbs into that tree), ordinary images (`![]()`), and wiki embeds (`![[]]`). Images/embeds only become graph edges if a future contract explicitly resolves them to a concept (current contract: never).
- Duplicates (same kind + raw + label) are collapsed on outbound extract; reverse index records one hit per distinct outbound edge that resolves.

**Resolve vs project split:**

1. **Resolve API** — read-only, for preview/jump (always available).
2. **Index build** — writes machine-local cache only; **never** rewrites user body by default.
3. **Optional OKF project** — explicit command/export may rewrite wiki → relative MD for compliance; **never** auto-run on dirty buffers; refuse destructive project when the tab is dirty (or dry-run only).

Default edit path does **not** perform destructive link projection on every save.

### 6.2 Search (MVP)

- Scope: concept titles + bodies (simple tokens / substring).
- Results: concept hits + snippet offsets; open tab and select match.
- Out of scope: semantic embedding search, workspace source search.

### 6.3 Attachments (MVP)

- Store under tent attachment root keyed by `cx-`: **`<workspace>/.tent/attachments/<cx>/…`** (FsAdapter / system-root relative: `attachments/<cx>/…`).
- **Disk format:** original binary bytes only. No `.b64` companion files or text markers.
- **Wire format (JSON-RPC):** `docs.importAttachment` carries base64 in `bytesBase64` (optional alias `contentBase64`). Service decodes strictly and writes raw bytes.
- Path is content-addressed for idempotency: `attachments/<cx>/<safeName>-<sha256-12><ext>`. Re-importing the same concept + file name + bytes returns the same path without rewriting when the file already matches.
- Filename validation: directory separators and traversal segments are rejected; Windows-invalid characters and reserved device names (`CON`, `NUL`, …) are neutralized.
- **Size limit:** decoded payload max **25 MiB** (`MAX_ATTACHMENT_BYTES`); larger imports are rejected.
- Return value includes `relativePath` (system-root relative), a Markdown link relative to the owning concept note, and optional `ArtifactRef` `{ kind: "path", target, label }`.
- Insert ordinary relative Markdown image/file links (or service-logical URLs resolved in preview).
- No cloud image host; large-file warnings allowed. No migration layer for legacy `.b64` markers.
- Attachment ownership is `cx-` based: while the owning concept exists (including
  `archived` concepts), every file under its attachment directory is durable even
  when temporarily absent from the body. Rename/move therefore never changes
  attachment ownership.
- The Local Service performs conservative, invisible attachment housekeeping.
  Only files whose owner concept no longer exists **and** which are unreferenced
  by concept or operational Markdown/ArtifactRefs become candidates. A candidate
  must remain orphaned for 30 days after first observation before deletion;
  missing/corrupt GC state and scan ambiguity fail closed.
- Attachment references are extracted separately from concept links. The same
  derived edges may feed a future relationship graph, but graph/cache absence is
  never sufficient proof for deletion: each GC sweep rechecks disk sources.

### 6.4 Editor session state

Open tabs, scroll, selection live in **machine-local** window state. They must not be written into concept files.

---

## 7. External modification · minimal optimistic concurrency

### 7.1 Sources of truth

| Fact | Authority |
| --- | --- |
| On-disk bytes | Last successful write |
| Editor buffer | Unflushed tab content |
| Collaboration facts | core mutations under service + mutation lock |
| Search/link index | Derived cache; **always rebuildable** |

### 7.2 Version token

`docs.readForEdit` returns at least:

```ts
{
  cx: string;
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  etag: string; // content hash and/or mtimeMs+size
}
```

`docs.write` / `writeBody` on an **existing Node** **must** supply a non-empty `baseEtag` (from `docs.readForEdit`; legacy param alias `etag` accepted). Create/bootstrap paths (`docs.createNote`, `new` / `migrate` / `role-init`) are separate; external file edits land via watcher as fact change, not via blind `docs.write`.

1. Under mutation serialization, re-read disk and compute `diskEtag` (`sha256` content token).
2. If `baseEtag` is missing/empty → **`-32008`** (`etag_required`): reject; error `data` includes `currentEtag`, `path`, `id` — **no body**.
3. If `diskEtag !== baseEtag` → **`-32009`** (`etag_conflict`): reject; error `data` includes `currentEtag`, `baseEtag`, `path`, `id` — **no body**. Clients may re-`readForEdit` for a full disk snapshot when UI needs it.
4. If the target is a box with an **active task** and the patch attempts to set projected collaboration fields (`status`/`assignee`/legacy `owner` in competition with Task API) → **reject** with a collaboration-field error (not a silent merge). Body text and non-projection frontmatter may still write (still with a valid `baseEtag`).
5. Else write, publish **`concept.changed`** (via **EventEnvelope** — architecture §5.2), update callers’ etag.

Structured mutations (promote, type change, controlled move, **fork**) continue to use core `withTentMutation` / service command path; they still must not silently clobber a dirty editor buffer (flush or explicit merge of frontmatter-only updates).

**Event channel:** document invalidation uses `concept.changed` / `concept.removed` only. There is **no** `box.changed` dual stream.

### 7.3 Autosave and watch

```text
Editor buffer
    │ debounce save
    ▼
ConflictGate.write(baseEtag, content)
    │
    ├─ ok → update baseEtag, clear dirty
    └─ conflict → keep dirty buffer, show banner:
         [Load disk] [Keep mine / overwrite] [Side-by-side plain text]
```

Watch rules:

- Clean tab + etag change → silent reload allowed.
- Dirty tab + etag change → banner; **silent reload forbidden**.
- Self-echo from this service write may be ignored via generation / `source: self`.

### 7.4 Explicit non-goals (concurrency)

- Character-level 3-way merge / CRDT
- Automatic semantic frontmatter merge
- Cross-machine sync conflict UI
- Built-in Git diff as the conflict surface (external tool open is fine)

### 7.5 Index rebuild

- Startup full scan + watch incremental updates.
- Corruption or version skew → full rebuild from disk.
- Index never becomes a second source of truth for body text.

---

## 8. Service API surface (document group)

Logical APIs consumed by Desktop Markdown and CLI (transport owned by architecture):

| API | Kind | Effect |
| --- | --- | --- |
| `docs.list` / `docs.get` | Query | Concept projections |
| `docs.readForEdit` | Query | Body + etag for editing |
| `docs.write` | Command | Existing-node write; **required** `baseEtag` (`-32008` missing / `-32009` conflict); **cannot** bypass active-task projections; **cannot** set `type`/`tags` (use dedicated commands) |
| `docs.setType` | Command | User-only set compound Node type (`baseEtag` required); emits `concept.changed` reason `docs.setType` |
| `docs.tags.set` / `docs.tag.add` / `docs.tag.remove` | Command | User-only Node tag mutations (`baseEtag` required); detach does not prune registry |
| `registry.types` / `registry.type.create` / `registry.type.delete` | Query / Command | Type registry read + custom secondary create/delete (user-only mutations; in-use delete fails loud) |
| `registry.tags` / `registry.tag.create` / `registry.tag.delete` | Query / Command | Tag vocabulary read + create; global delete cascades off all Nodes |
| `docs.createNote` | Command | New concept (`cx-`, type, path) |
| `docs.promote` | Command | Note → box in place |
| `docs.fork` | Command | Copy subtree for parallel occupation (new `cx-`s; clear occupation on fork root) |
| `docs.search` / `docs.backlinks` / `docs.resolveLink` | Query | Navigation |
| `docs.importAttachment` | Command | Params: `workspaceId`, concept `id`\|`path`\|`boxId`, `fileName`, `bytesBase64`. Store **original bytes** under `attachments/<cx>/…`; return `{ relativePath, markdown, artifactRef }` |
| `docs.watch` / events | Events | `concept.changed` \| `concept.removed` \| conflict signals (EventEnvelope) |
| `annotation.list` | Query | Per-node underline annotations with live relocate projection (`anchored` \| `relocated` \| `orphan`) |
| `annotation.create` / `resolve` / `reopen` / `delete` | Command | User-only first-class annotation records (MutationBus); never write markers into body |

### 8.1 Underline annotations (划线注释)

Product boundary: annotations are **first-class workspace records**, independent of Markdown body markers, Node frontmatter attributes, and Task. Default path does **not** inject Agent; UI may later turn a comment into `task.sendInput` explicitly.

Persistence (system root, not concept body):

| Field | Notes |
| --- | --- |
| `id` | Stable `an-…` |
| `nodeId` | Concept identity (`cx-`); path-independent |
| `quote` / `start` / `end` | Create-time anchor into **body** (half-open offsets) |
| `documentEtag` | Same etag family as `docs.readForEdit` (hash of on-disk note raw) |
| `body` | Plain comment text |
| `author` | Always `user` in this batch |
| `status` | `open` \| `resolved` |
| timestamps | `createdAt` / `updatedAt` / optional `resolvedAt` |

**Create validation:** non-empty quote/body; range in body; `body.slice(start,end) === quote`; required `documentEtag` must match current disk etag or RPC rejects with etag conflict. Does not mutate the Node file.

**List/read projection (relocate, non-mutating):**

1. If Node missing → `anchorState=orphan`, `orphanReason=missing-node`.
2. Else if stored offsets still match quote → `anchored`.
3. Else find quote occurrences in current body: unique hit, or unique nearest to original `start` → `relocated` with `currentStart`/`currentEnd`.
4. No hit → `orphan`/`quote-mismatch`; equal-distance multi-hit → `orphan`/`ambiguous`.

Projection **must not** auto-edit the document or silently rewrite persisted anchors.

Document subsystem **does not** implement: `task.dispatch` / claim / deliver / accept, A2A spawn, or adapter process control. It may **render** operational Markdown supplied by collaboration queries. Clients use **`docs.*`**, **`annotation.*`**, and **`task.*`**; **`AgentRuntimePort.*`** is service-internal.

---

## 9. Module boundary

| Concern | Document system owns | Hand off |
| --- | --- | --- |
| Concept load, type/`coordination`, promote, links, search, attachments, conflict gate for bodies | yes | — |
| Task state machine, occupation, delivery review | no | Task API / collab |
| Process/session/adapters | no | AgentRuntime |
| Window shell, multi-workspace mount | no | Architecture / Desktop |
| Workspace Git integrate-after-accept | no | Architecture + Task API |
| Editor implementation (e.g. CodeMirror 6) | Markdown package only | Must not be imported by core |

Dependency direction (architecture):

```text
markdown UI  →  Local Service Query/Command  →  core  →  tent files
```

Core must not import editor frameworks. Clients must not mutate concept frontmatter or bodies outside the service when a service is available.

---

## 10. Migration notes (document identity only)

Aligned with architecture one-shot migration; document-specific requirements:

| From | To |
| --- | --- |
| `bx-` handles | `cx-` handles; emit full map in migration report |
| Box-only tree index | Concept scan of all user-facing notes + boxes |
| Dual mental model (vault-external tent + separate code-root linkage) | Single in-workspace tent at **`.tent/`** |
| Product term “workspace pointer” | Retired; WorkspaceLane is a **task** field, not a concept type |
| Auto OKF project rewriting bodies | Explicit project; default non-destructive resolve |

During migration window only: resolve layer may dual-read `bx-` and `cx-`. After cutover, new writes use `cx-` exclusively.

---

## 11. Markdown MVP acceptance (product checklist)

**Must have**

- [ ] Create ordinary note concept (non-empty type, `cx-`)
- [ ] In-place promote to box (same path / body / `cx-`)
- [ ] Edit + preview + autosave through service
- [ ] External edit conflict detectable with explicit user choice
- [ ] Wiki/path/`cx-` resolve, backlinks, title+body search
- [ ] Image attachment into tent attachment area with Markdown link
- [ ] Operational docs absent from concept tree / OKF concept index
- [ ] **`ArtifactRef`** opens externally—not an in-app workspace browser
- [ ] Active-task projection fields rejected on ordinary `docs.write`
- [ ] `docs.fork` available for parallel box occupation

**Must not have (MVP)**

- [ ] Workspace source tree browser
- [ ] Code LSP / terminal / build panel
- [ ] Built-in commit diff / line comments
- [ ] Automatic destructive OKF body rewrite over dirty buffers
- [ ] Hardcoded coordination by type **name** instead of registry capability
- [ ] Semantic `key` field or second box id

---

## 12. Cross-entity identity (roles / types / tags)

Concept dual identity (`path` + `cx-`) is specified above. Other registries:

| Entity | Immutable id | Mutable label | Notes |
| --- | --- | --- | --- |
| Role | `rl-…` | `displayName` (presentation only; never a resolver) | Resolve by `roleId` or operational `name`; see `identity-rename.md` |
| AgentProfile | profile `id` | `displayName` | Machine-local only |
| Type / tag | registry string key | same | No separate id in batch 1 — not forced for uniformity |

**Rename rule:** id is never edited; rename changes display label and/or path only. Node native rename is Service `docs.rename` with atomic path+link rewrite and true note/tree rollback (contract in `identity-rename.md` §4).

## 13. Frozen decisions (B0)

1. **OKF path** = concept identity; **`cx-`** = immutable handle; no semantic key.
2. **`coordination`** is a type capability; box = coordination-enabled concept.
3. **Promote is in-place**; same path, body, and handle.
4. **Operational pipeline is outside** concept index and OKF validation.
5. **Workspace files** enter only as **`ArtifactRef`**; Tent is not an IDE or disk browser.
6. **External edits** use minimal etag optimistic concurrency; dirty tabs never silent-reload.
7. **Index is rebuildable cache** in machine-local service data, not tent identity truth.
8. **MVP note layout** is folder + same-named Markdown, isomorphic to boxes.
9. **Link project** is explicit; resolve and index are non-destructive by default.
10. **Events** are `concept.changed` / `concept.removed` only—no `box.changed` dual channel.
11. **`docs.fork`** is the parallel-occupation command; active-task fields cannot be bypassed via `docs.write`.
12. Tent system directory name is fixed **`.tent`** under the workspace root.
13. Implementation batches refine code under this contract; they do not reopen vocabulary without an explicit revision of this file.
