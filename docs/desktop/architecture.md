# B0 · Desktop & Local Service Architecture Contract

Status: **frozen contract** for independent desktop product architecture.  
Scope: dependency directions among Desktop shell, Local Service, CLI, core, in-workspace tent data, and machine-local service data.  
Non-scope: Task/Delivery IDL details (`docs/desktop/task-api.md`), concept/box document model (`docs/desktop/concept-model.md`), AgentRuntimePort/adapters (`docs/desktop/agent-runtime.md`). Those contracts must not invert the rules below.

**External vs internal APIs:** clients (Desktop, CLI, MCP) call only `task.*` and `docs.*` (plus Query/Events). `AgentRuntimePort.*` is **service-internal** — never exposed as a client command surface.

This document freezes **what depends on what** and **who may mutate**. Implementation batches B1+ implement this contract; they do not reopen it without an explicit revision.

---

## 1. Product stack (dependency direction)

```text
Desktop shell (Electron, Windows v0.1)
CLI / future thin clients
        │  attach only (IPC / loopback / named-pipe)
        │  Query + Command; no direct tent mutation
        ▼
Local Tent Service  ←── sole runtime host for mutation, watch, multi-workspace, agent lifecycle
        │  in-process domain calls
        ▼
tent-core  ←── sole business-rule source (FsAdapter + mutation.lock)
        │
        ▼
Workspace-resident tent system dir + machine-local service data area
```

### Hard rules

1. **core** owns domain rules (concept/box tree, types/capabilities, claim topology, task/delivery semantics as data+ops, workspace ports). Core does not own windows, process supervision, or provider credentials.
2. **Local Service** is the **only mutation entry** for tent operational and concept writes in the desktop product path. Desktop renderer, Electron main (except bootstrap), CLI, MCP tools, and adapters **must not** call core mutation paths that bypass the service when a service is available.
3. **CLI** remains a first-class client: short-lived process that **attaches** to a running service; if none is reachable it may **bootstrap** a lightweight service and retry. CLI must not maintain a second lifecycle implementation.
4. **Desktop shell** is a client: main process owns OS windows/tray; renderer shows projections and issues commands (including HTML5 contextCard drag). Closing the main window must not stop the service or in-flight tasks.
5. **Adapters** (ACP/CLI agents) are execution ports injected by the service. They emit process/session events only; they do not implement box occupancy, dispatch/claim/accept, or chat routing.
6. **Markdown subsystem** consumes Query/Command APIs; Tent core/service must not import editor implementations.

Forbidden reverse edges:

- Desktop / plugin / adapter → direct filesystem mutation of tent registries, envelopes, or concept frontmatter (outside service).
- core → Electron, UI frameworks, or provider SDKs.
- Duplicating dispatch/claim/deliver/accept state machines outside service→core.

---

## 2. Process model & lifecycle

| Component | Responsibility | Lifetime |
| --- | --- | --- |
| **Electron main** | Windows, tray, floating control, discover/start service | User session; may exit while service continues |
| **Renderer** | Workbench UI: tree, attributes, dispatch draft, review surface, projections; contextCard HTML5 `text/plain` drag | Restartable; truth is service state |
| **Local Service** | WorkspaceHost, mutation bus, file watch, event fan-out, Task/Query API, A2A gate, Git/worktree orchestration, session/process supervision | Longer than main window; recoverable from disk + process probe after crash |
| **CLI** | Agent/automation entry | Short-lived; attach → bootstrap → retry |
| **Adapter workers** | Provider-specific agent processes | Supervised by service; bound to replaceable sessions |

### Lifecycle invariants

- **Close main window ≠ stop tasks.** Tray/floating control may remain; service keeps mounted workspaces and agent processes per policy.
- **Stop service** is the control plane for tearing down background orchestration (adapter child policy is refined in the agent-runtime contract).
- **Foreground workspace** is a UI selection: exactly one workspace is shown in the main workbench at a time.
- **Background workspaces** stay mounted in the service; switching the foreground does not interrupt other workspaces’ agents or watches.
- Service may mount **N workspaces** concurrently. There is **no** cross-project dashboard product surface—only optional minimal tray aggregates (running/waiting/failed counts) and jump-back.

---

## 3. Data placement

### 3.1 Tent is in-workspace (single location model)

```text
<workspace>/
  .gitignore                 # ignore tent system dir + operational temp
  <user project files>       # real work / artifacts
  .tent/                     # **fixed** tent system directory name; one active tent per workspace
    … boxes / concepts, RULES, registries, operational pipeline …
```

- A **workspace** is the sole root of real files and (when present) Git history.
- A **tent** is the collaboration instance **owned by** that workspace, living at `<workspace>/.tent/`. It is **not** an external vault folder that links back to a separate code root.
- The system directory name is **`.tent`**, fixed in this contract. B1 implements scaffold and migration into `.tent/`; it does **not** reopen naming.
- Non-git document libraries are still workspaces: skip gitignore/worktree steps; tent semantics unchanged.
- `.tent/` is **hidden from the workbench tree by default** (diagnostic entry only) and listed in workspace `.gitignore` when the repo uses Git.

### 3.2 What lives with the workspace (migratable collaboration facts)

- Concept/box tree and frontmatter (`cx-` handles, type, tags, status, …)
- Project-level type / tags / roles registries
- Workspace collaboration settings (`.tent/settings.json`: e.g. `defaultDeliveryPolicy`; extensible)
- Operational records required for recovery (task, handoff, delivery, …) subject to retention
- `ArtifactRef` associations on concepts/deliveries (structured refs; see §5.2)
- RULES / project conventions
- Task operational records may store **`sessionId` only** as a reference; never session rows, PIDs, or resume tokens

### 3.3 What lives only on the machine (service data area)

Example root: `%APPDATA%/Tent/` (platform-specific).

- Window / floating-control geometry, recent workspaces
- Search/index caches, notification read state
- CLI paths, credentials, PID files, session tokens, full session registry rows
- **AgentProfile** configs (binary paths, argv templates, auth references)
- Absolute worktree path caches (rebuildable)
- **RuntimeWorkspace** bindings used by process supervision (cwd, env handles)—not collaboration facts

Copying a workspace must preserve collaboration semantics. Reconnecting agents on a new machine must not require shipping old PIDs, credentials, session rows, or absolute paths.

### 3.4 Real deliverables

User-visible workspace trees (code, docs, builds) remain outside Tent’s document browser. Tent associates via **`ArtifactRef`** and “open with original tool”; it does not host a source tree, IDE, or disk file manager.

### 3.5 WorkspaceLane vs RuntimeWorkspace

| Term | Owner | Meaning |
| --- | --- | --- |
| **WorkspaceLane** | Task / collaboration (`task-api.md`) | Role worktree + branch + targetBranch prepared for a task attempt (Git lane) |
| **RuntimeWorkspace** | AgentRuntime / machine-local | Process cwd and launch binding for a live session; may mirror a lane’s worktree path but is **not** a task field |

Do **not** reuse legacy “workspace pointer” product language for either concept. Legacy external-tent → code-root linking is retired by the in-workspace `.tent` model.

---

## 4. Service as sole mutation entry

### 4.1 Command path

```text
Client command
  → Service authorize / serialize
  → core ops (withTentMutation / mutation.lock)
  → FsAdapter write under tent system dir
  → watch + event fan-out
```

### 4.2 Query path

```text
Client query / subscribe
  → Service projection (in-memory + disk)
  → read-only views; no client-side “shadow truth”
```

### 4.3 What must go through the service

- Concept/box create, patch, place, archive, type/capability changes
- Task lifecycle commands (dispatch, claim, wait, deliver, review, accept, reject, interrupt, …)
- Session start/stop/resume (after A2A gate)
- Git/worktree orchestration used for role lanes and integrate-after-accept
- Multi-workspace mount/unmount and foreground selection events
- Workspace collaboration settings mutations

### 4.4 What may stay local without inventing domain rules

- Pure UI draft state (unsaved editor buffer until save command)
- Ephemeral drag of contextCard payloads (pointer + fixed prompt template) — see **B6** below
- Machine-local preferences in the service data area

Clients must not re-implement claim topology, type resolution, or accept/integrate separation.

### 4.5 Context Card drag (B6 · Windows MVP)

**Goal:** left-drag a small card from the main window or floating control into an external official agent GUI input, delivering a stable Tent pointer + fixed auxiliary prompt as **plain text**.

| Rule | Detail |
| --- | --- |
| Payload | Strictly `contextCardToDragText` → Context Card **v1** template (`text/plain` only). No document snapshots, no compatibility bags. |
| Mechanism | Chromium/Electron **HTML5 drag** (`dataTransfer.setData("text/plain", …)`). On Windows this crosses apps as OLE text. |
| Not used | `webContents.startDrag` — Electron API is **file-path only** (icon + file(s)); it cannot carry arbitrary text. |
| Forbidden “completion” | Clipboard-only fallback sold as drag; generating temp `.md` / dragging files to impersonate a text card. |
| Click | Optional **copy** on click remains an auxiliary path; drag must not depend on prior clipboard write. |
| Surfaces | Main workbench “最近上下文卡” list and floating control card list. |

External drop into third-party agent GUIs is validated manually by the user; automated tests cover payload integrity, renderer `dataTransfer` wiring, and IPC surface (no fake native-drag channel).

---

## 5. API surface (architectural, not full IDL)

Logical groups shared by Desktop and CLI (transport chosen in B2: loopback HTTP or named pipe + JSON-RPC).

### 5.1 External groups (clients)

| Group | Canonical examples | Notes |
| --- | --- | --- |
| **Query** | `docs.list` / `docs.get` / concept reads; `task.get` / `task.list`; `delivery.*`; `session.get` / `session.list` (projections); `a2a.listPending`; `toolApproval.listPending` / `toolApproval.get`; `subscribeEvents` | Read projections only |
| **Command** | **`docs.*`** (create, write, promote, fork, place, **importAttachment**, …); **`task.*`** (`dispatch` / `claim` / `wait` / `deliver` / `accept` / `reject` / `interrupt` / …); **`a2a.resolve`**; **`toolApproval.approveOnce` / `toolApproval.deny`** (user-only) | Serialized mutations; **only** external mutation verbs. Attachment import may use base64 on the wire; disk stores original bytes under `.tent/attachments/`. |
| **Events** | `concept.changed`, `concept.removed`, `task.state`, `delivery.updated`, `session.state`, `a2a.ask`, `toolApproval.pending` / `toolApproval.resolved`, `workspace.switched`, `service.health` | Single fan-out channel; **no** `box.changed` dual stream |

**Forbidden as client commands:** `AgentRuntimePort.startSession` / `stopSession` / `resumeSession` / `probe` / `subscribe`. Session lifecycle for agents is invoked **inside** Local Service after `task.startSession` (or equivalent orchestration) has already passed A2A. Clients may issue `task.startSession` where authorized; they never call the runtime port directly.

Field names follow the canonical vocabulary (`cx-`, `assignee`, `delivery`, `ArtifactRef`, …). Detailed task states and **`A2APolicy`** (`allow` \| `ask` \| `deny`) are owned by the Task API contract; detailed runtime port shapes by the AgentRuntime contract.

CLI keeps familiar verbs where possible, but implementation becomes **attach service → command/query**, not re-open tent files as a second writer.

The current transport is deliberately machine-local: Local Service binds only
to literal loopback IPs, authenticates `/rpc` and `/events` with the machine-local
endpoint token, and caps buffered JSON-RPC bodies at 36 MiB. The cap preserves
the 25 MiB binary-attachment contract after base64 expansion while rejecting
unbounded request buffering before dispatch.

### 5.2 Shared shapes (cross-contract)

```ts
/** Structured association to a real deliverable outside concept identity. */
type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  /** Workspace-relative path, commit SHA, absolute URL, or other stable locator. */
  target: string;
  label?: string;
};

/** Common wire wrapper for all service fan-out events. */
type EventEnvelope<TType extends string, TPayload> = {
  id: string;              // unique event id
  type: TType;             // e.g. "concept.changed", "task.state"
  workspaceId: string;     // mounted workspace key
  ts: string;              // ISO-8601
  source: "service" | "self"; // self = echo of this client's write (may ignore)
  payload: TPayload;
};

/** Role / orchestration spawn authority (evaluated only in service). */
type A2APolicy = "allow" | "ask" | "deny";

/**
 * Machine-local launch profile — binary paths, argv templates, auth refs.
 * Lives only in service data area; never in workspace git / concept bodies.
 */
type AgentProfile = {
  id: string;
  adapterId: string;
  displayNameKey?: string;
  // binary path, default argv, authModel, capability flags — machine-local
};
```

### 5.3 Active-task field protection

While a box has an **active task**, collaboration projection fields (`status` when projected as `doing`, `assignee` / legacy `owner`) are **not** independently writable through ordinary `docs.write` / body frontmatter patches. Clients must use Task API transitions; service/core reject competing writes (see `task-api.md` §2.3 and `concept-model.md`).

---

## 6. Repository module boundaries

Target monorepo layout (implementation may stage under `src/` first, then packages):

```text
packages/
  core/              # domain: today’s src/core + node FsAdapter
  service/           # Local Tent Service
  cli/               # thin tent CLI client
  desktop/           # Electron main + renderer shell
  workbench-model/   # UI-framework-free projections & command DTOs
  adapters/          # ACP/CLI provider adapters (ACP role)
  markdown/          # editor & note UX (docs role)
```

### Dependency arrows (allowed)

| From | To |
| --- | --- |
| `service` | `core` |
| `cli` | service protocol (+ bootstrap helper) |
| `desktop` | service protocol, `workbench-model` |
| `workbench-model` | shared types only (no Electron, no fs writes) |
| `adapters` | runtime port types; **not** core lifecycle modules |
| `markdown` | service Query/Command; **not** core internals |

### Reuse vs freeze (from current tree)

| Keep / evolve | Freeze (do not drive new architecture) |
| --- | --- |
| `src/core/*` domain ops, claim, manifest, task/report→delivery evolution, type registry + capabilities | `src/plugin/view.ts`, registry panes, Obsidian DOM UI as migration source |
| `src/fs/node-fs.ts` | `src/plugin/obsidian-fs.ts` as a product constraint |
| CLI thin-shell pattern (`src/cli/tent.ts`) | Expanding Obsidian plugin as primary product surface |
| Role worktree lane primitives in workspace ports | Second copy of lifecycle in desktop or adapters |
| Tests under `test/*core*` as regression base | Long-term dual path: vault-external tent **and** in-workspace tent |

**Obsidian plugin:** frozen as a product constraint. It is an optional legacy client at most; it must not dictate service shape, identity model, or UI architecture. No new product capability is designed “for plugin parity.”

---

## 7. One-shot migration (no dual-write)

### 7.1 From → to

| From (legacy) | To (desktop model) |
| --- | --- |
| External tent under vault/`_tents` + separate code root linkage | Tent **inside** the workspace at **`.tent/`** |
| `bx-` handles | `cx-` handles (full map in migration report) |
| `owner` fact on box | `assignee` projected from active task |
| temp `report` without id | `delivery` (`dl-`) under task (per Task API contract) |
| Dual mental model / dual UI | Single location model only |
| Product term “workspace pointer” | Retired; use **WorkspaceLane** (task) / **RuntimeWorkspace** (runtime) / in-workspace tent |

### 7.2 Process requirements

1. Toolized **dry-run** then migrate; staging copy + validation before atomic switch.
2. Require idle critical occupancy (or documented `--force` risks).
3. Single workspace path; refuse dirty multi-pointer tents.
4. Rewrite rewritable absolute paths; **do not** migrate machine-local runtime facts.
5. Write workspace `.gitignore` entries when applicable.
6. Emit a migration report (id map, skips, broken `ArtifactRef`s needing human reconnect).
7. Mark old external root with `MIGRATED.md`; user deletes—**no** bidirectional sync.
8. Land tent data under **`<workspace>/.tent/`** only (name fixed; no alternate system-dir product mode).

### 7.3 Explicit non-goals

- Long-term compatibility layer for external tents
- Dual-write between old and new locations
- Auto-delete of user workspace deliverables
- Silent “open old tent read-only forever” as a product mode (any temporary escape hatch needs explicit product decision)

---

## 8. Delivery order (B1 / B2 and beyond)

Contract freeze is **B0** (this document + peer B0 contracts). Implementation order that this architecture commits to:

| Batch | Name | Owner focus | Depends on | Outcome |
| --- | --- | --- | --- | --- |
| **B0** | Architecture + peer contracts | Desktop / collab / docs / ACP roles | — | Frozen boundaries & vocabulary |
| **B0-doc** | Concept/box document contract | Docs role | Glossary | `concept-model.md` |
| **B1** | Core location & identity | Desktop architecture | B0 field tables | In-workspace **`.tent/`** scaffold, `cx-`/capability migration, core tests green |
| **B2** | Local Service skeleton | Desktop architecture | B1 | Process model, attach protocol, watch, sole mutation entry |
| **B3** | Electron shell + workbench vertical slice | Desktop architecture | B2 protocol | Main window tree/attrs/dispatch/review; tray |
| **B4** | CLI attach service | Desktop architecture | B2 | CLI via service; bootstrap if missing （实现见 `docs/desktop/cli-service.md`，`tent task *`） |
| **B5** | Migration tool | Desktop architecture | B1 | dry-run / migrate / rollback report |
| **B6** | contextCard HTML5 text/plain drag (Windows MVP) | Desktop architecture | B3 | Cross-app text drag via Chromium; no file/clipboard fake |
| **B7** | Markdown MVP | Docs role | B2 Query API | Editor/links/search |
| **B8** | Task API + A2A hard gate | Collab role | B2 | States, delivery, allow\|ask\|deny in service |
| **B9** | ACP adapters | ACP role | B2 + B8 | Provider/session/supervisor |
| **B10** | Polish & open-source packaging | Shared | MVP acceptance | Installer, docs, versioning |

Dependency sketch:

```text
B0 ──┬── B1 ── B2 ──┬── B3 ── B6
     │              ├── B4
     │              ├── B5
     │              ├── B7
     │              ├── B8 ── feeds B3 UI / B9
     │              └── B9
     └── B0-doc ─────────────┘
```

**B1 before B2:** service must call an in-workspace-capable core, not re-encode the old external-tent layout.  
**B2 before B3/B4/B7/B8/B9:** all product clients and hard A2A share one host.

### MVP vertical slice (acceptance intent for later implementation)

A Windows user opens a workspace with an in-workspace tent, completes **create box → dispatch → (external agent via CLI claim/deliver) → review accept**, and after **closing the main window** the CLI still reaches the same service state. All writes go service→core. Full Markdown graph, multi-provider ACP, and non-Windows ports are out of MVP scope.

---

## 9. Interface freeze points with peer roles

| Peer | This architecture supplies | Peer supplies |
| --- | --- | --- |
| **Docs (Markdown)** | Concept query/save commands; hide system dir; event stream for invalidation | Editor, wiki-link, search index consumers |
| **Collaboration** | Service mount points for authorization hooks & operational storage | Task state machine, delivery fields, A2A policy semantics |
| **ACP** | Hosts **service-internal** `AgentRuntimePort` (start/stop/resume/events); clients use `task.*` only | Per-provider adapters; no lifecycle reimplementation |

Conflict rule: if a peer proposal violates **sole service mutation**, **in-workspace tent**, **no chat product**, or **one-shot migration**, parent product goal wins; escalate to the product owner rather than silently forking the model.

---

## 10. Non-goals (architecture)

- Replacing official agent chat clients or building a multi-agent conversation router
- Cross-project dashboard / source IDE inside Tent
- Deriving product UI from Obsidian application source
- Honor-based A2A spawn (must be service-hard `allow | ask | deny`)
- Long-term dual location model or dual-write migration
- Putting provider credentials or session tokens in workspace git history

---

## 11. Contract checklist (acceptance map)

| Requirement | Section |
| --- | --- |
| Service is the sole mutation entry | §1, §4 |
| External commands = `task.*` / `docs.*`; `AgentRuntimePort` internal only | §5 |
| Events = `concept.changed/removed` + task/runtime; no `box.changed` | §5 |
| System dir fixed as `<workspace>/.tent/` | §3.1 |
| WorkspaceLane ≠ RuntimeWorkspace; no “workspace pointer” product term | §3.5 |
| `ArtifactRef`, `EventEnvelope`, `A2APolicy`, machine-local `AgentProfile` | §5.2 |
| Active-task projections not bypassable via `docs.write` | §5.3 |
| Task stores `sessionId` only; session row/token/PID machine-local | §3.2–3.3 |
| Foreground single workspace; background multi-workspace | §2 |
| Closing the window does not stop tasks | §2 |
| Repo module boundaries | §6 |
| B1/B2 (and later) delivery order | §8 |
| Old Obsidian plugin frozen; not a new-architecture constraint | §6 |
| One-shot migration; no dual-write; no long-term dual model | §7 |

---

## Document control

- **Box:** B0 桌面与 Service 架构合同  
- **Role:** 桌面架构Grok  
- **Aligned plans:** desktop architecture plan, collaboration protocol plan, Markdown MVP plan, ACP adapter plan (Tent-side plan-only deliveries)  
- **Next implementation step after acceptance:** B1 core in-workspace location + identity/capability migration (product code), not further speculative redesign of this dependency graph.
