# Desktop Contract · Task API & Delivery Protocol

Status: **B0 frozen contract** (implementation follows in B8a–B8f)
Scope: task / delivery entities, state machine, Task API, A2A hard authority, delivery policies, operational retention
Non-goals: AgentRuntime adapter details (`docs/desktop/agent-runtime.md`), OKF concept model (`docs/desktop/concept-model.md`), service process topology (`docs/desktop/architecture.md`)

This document freezes the collaboration semantics for the independent desktop Tent. CLI, MCP/tool, and GUI are transport clients only. ACP/CLI adapters connect processes; they do not define box/task lifecycle.

Canonical English names are API/schema truth. UI may localize labels via i18n; persisted enums never use localized values.

---

## 1. Entities and identity

| Entity | ID prefix | Space | Meaning |
| --- | --- | --- | --- |
| concept / box | `cx-` (migrated from `bx-`) | OKF concept space | box = concept whose type has `coordination: true` |
| role | stable name (MVP); optional `rl-` | project registry | durable identity, rules, workspace lane |
| session | `ss-` | local service / operational index | replaceable runtime instance |
| task | `tk-` | operational | one dispatch/execution attempt against a box |
| delivery | `dl-` | operational | one deliverable submission belonging to a task |

### 1.1 Core invariants

1. **box/concept is long-lived; task is one attempt.** The same box may host many tasks over time. By default at most **one active task** per box. Parallel work uses **fork box**, never concurrent active tasks on one box.
2. **delivery, commits, checks, and review outcomes belong to the task**, then project onto the box for UI. Box `status=doing` and `assignee` are **projections** of the active task—not independently writable facts that compete with the task.
3. A task targets exactly one box. A delivery targets exactly one task. At most one delivery per task may be in `ready` (awaiting review) at a time; rejected deliveries may remain as history under retention.
4. **role ≠ session.** Role is durable identity and lane relationship. Session is a recoverable, replaceable process binding. Changing session does not change role, queue, or box occupation.
5. Tasks may target a long-lived **role** or a one-shot **agentProfile**. Temporary subagents need not enter the durable role registry.
6. Operational records (`tk-` / `dl-` / `ss-` / handoff payloads) are **not** OKF concepts. They are excluded from concept index, OKF validation, and ordinary document trees. Durable conclusions must be written back or promoted into concept/box bodies.

### 1.2 Task fields (contract shape)

```yaml
id: tk-…
type: task
boxId: cx-…                      # target box
state: queued                    # see §2
assigneeKind: role | agentProfile   # missing → role (backward compatible; no historical migration)
# Persisted compatibility field: envelope frontmatter still uses `role` as the
# stable assignee label (role name OR profileId). API projections may also expose
# `assignee` as that same label.
role: <role-name|profile-id>
# V0.2 explicit parent/reviewer (replaces asSub+dispatchedBy inference for authority).
# reviewer is derived from parentActor — kind/id must match exactly (no Role A → Role B).
parentActor: { kind: user|role, id: user|<role> }
reviewer:    { kind: user|role, id: user|<role> }   # must equal parentActor; both persisted
asSub: true                      # optional Git-lane sub marker only; missing → false (peer).
                                 # Sub requires durable parent Role + Git lane.
sessionId: ss-…                  # optional until claim/start; **reference only**
manifest: temp/…                 # honor-contract snapshot path at dispatch
workspaceLane:                   # omit when tent has no Git/workspace lane (pure Tent task)
  workspace: …
  worktree: …
  branch: …                      # role: tent-role/<role>; profile: tent-task/<taskId>
  targetBranch: …                # peer → mainline; sub → parent role branch tent-role/<parent>
  roleBranchBase: <full-sha>      # captured once when managed execution acquires the lane slot
deliveryPolicy: review | bypass | agent-decide
# Elevated bypass|agent-decide only for durable Role user-facing (parent=user, assigneeKind=role).
# Downstream Task Agent → parent is always review.
lastOutcome: delivered | blocked | needs-input   # optional; managed final report
wait:
  reason: user-input | a2a-approval | review | external
  summary: …
activeDeliveryId: dl-…           # optional
createdAt / updatedAt: …
prompt: |                        # immutable after dispatch
  …
```

**Migration (one-time, deterministic):** envelopes that still carry legacy
`dispatchedBy` without `parentActor`/`reviewer` are rewritten on
`workspace.mount` (`migrateParentReviewerEnvelopes`): durable non-user
`dispatchedBy` → `{kind:role,id:<dispatcher>}` parent+reviewer; otherwise
user parent+reviewer. `dispatchedBy` is stripped. `asSub`, accepted Delivery
records, and audit bodies are preserved. **Only the disk migrator may read
`dispatchedBy`.** Ordinary load/create/RPC never dual-read it; unmigrated
envelopes fail loud on load until mount migration runs.

#### assigneeKind: role vs agentProfile

| | **role** (default) | **agentProfile** |
| --- | --- | --- |
| Assignee label | durable role name (`role` field) | machine-local `profileId` (stored in legacy `role` field) |
| Registry | may ensure role init under `temp/<role>/init.md` | **never** registers a role; no role init |
| Operational paths | `temp/<role>/tasks/…`, shared `temp/<role>/manifest.yml` | `temp/agent-profiles/<safe-profile-id>/tasks/…`, task-scoped `…/manifests/<taskId>.yml` |
| Git lane | durable `tent-role/<role>` worktree (created at dispatch when Git); **never auto-reclaimed** | task-scoped `tent-task/<taskId>` under sibling `<repo>-worktrees/task-<slug>/` (created at managed acquisition; **not** `tent-role/<profile>`); **auto-reclaimed** when terminal + settled + clean (see §4.6) |
| Concurrency | one live managed session per durable role | multiple concurrent tasks/sessions even with the same profile config |
| startSession | any authorized profileId | **must** equal envelope profileId / assignee label |
| A2A (role caller) | peer (parent=user): authority = task role’s `a2aPolicy` / `allowedProfiles`; **parent Role**: authority = **parentActor** role | authority = **parentActor** role (must be a real registry role); profile is not a role |
| Claim / delivery | submitter / box.assignee = role name | submitter / box.assignee = profileId |
| Reviewer | `reviewer` (user for user-direct; parent Role for Role-dispatched) | same — executor never self-accepts |

Missing `assigneeKind` on disk **reads as `role`**. Missing `asSub` **reads as `false` (peer Git lane)**. Legacy `dispatchedBy` migrates once to `parentActor`/`reviewer` (see above).

#### WorkspaceLane (task) vs RuntimeWorkspace (runtime)

| Term | Lives on | Meaning |
| --- | --- | --- |
| **WorkspaceLane** | Task operational record | Collaboration Git lane: workspace root, worktree, branch, targetBranch |
| **RuntimeWorkspace** | Machine-local session / AgentRuntime only | Process cwd and launch binding for a live `ss-` session |

Tasks **must not** embed RuntimeWorkspace, PIDs, resume tokens, or absolute path caches. Only `sessionId` may bind a task to a live session; the session row lives in the service data area (`agent-runtime.md`).

Do **not** use the legacy product phrase “workspace pointer” for either structure.

`roleBranchBase` scopes managed auto-delivery to commits created during this task's
execution window (`roleBranchBase..branch`). Queued tasks do not capture it at
dispatch: the service writes it only after managed execution acquires the lane slot
(role: no other active managed session for that role; profile: per-task lane), then
preserves it across restart, resume, and reject-resume. A rewritten or divergent
branch fails loud instead of widening the commit range.

#### sessionId reference rule

- Task may store `sessionId: ss-…` (optional until claim/start).
- Session registry rows, resume tokens, PIDs, credentials, and process handles are **machine-local only**.
- Copying a workspace must not require shipping those facts; rebinding sessions on a new machine is a reconnect problem, not a collaboration-data problem.

### 1.3 Delivery fields (contract shape)

```yaml
id: dl-…
type: delivery
taskId: tk-…
boxId: cx-…                      # denormalized for query
role: …                          # submitter (assignee at deliver time)
status: draft | ready | accepted | rejected
summary: |                       # human-readable delivery text (replaces “report” as entity name)
  …
commits: [ "…" ]
targetHead: <full-sha>           # optional; required for new commit-bearing ready rows
checks:
  - name: …
    command: …
    exitCode: 0
artifactRefs: []                 # ArtifactRef[] — see architecture §5.2
integrationMode: null | manual-accept | bypass-auto | agent-decided-integrate
review:
  by: user | <role>
  decision: accept | reject
  note: …
createdAt / updatedAt: …
```

```ts
// Shared with architecture / concept-model — structured real-world deliverable ref
type ArtifactRef = {
  kind: "path" | "dir" | "commit" | "url" | "other";
  target: string;
  label?: string;
};
```

**`targetHead` (review-time integration target tip):**

- For a **commit-bearing** ready Delivery, Service resolves the integration contract and durably stores the full SHA of the **target branch HEAD** at Delivery creation / review publish time.
- Zero-commit Deliveries omit `targetHead` (no Git integrate).
- Before `task.accept` or commit-bearing auto-integrate applies Git, Service re-resolves the contract and compares the current target HEAD to the snapshot.
  - **Same HEAD** → integrate proceeds (existing conflict rollback and target-branch-name validation unchanged).
  - **Different HEAD** (including a clean non-conflicting advance on the target) → fail-loud with stable retryable `RPC_LIFECYCLE` data `code: "TARGET_MOVED"`, **no Git mutation**, Task stays `delivered` and Delivery stays `ready` (manual accept) or Task stays `running` with **no** Delivery (auto-integrate failure before publish).
- **Legacy ready rows** written without `targetHead` are **not** migrated by guessing the current tip. Commit-bearing integrate fails with the same `TARGET_MOVED` code (`reason: "missing_snapshot"`); re-deliver to re-snapshot. Wire parse remains backward-compatible (missing field loads as absent).

Chat-facing narrative remains the primary presentation; `delivery.summary` is the same text persisted for review—not a second story.

---

## 2. Task state machine

### 2.1 States

| state | Meaning | Occupies box (active)? |
| --- | --- | --- |
| `queued` | Dispatched; waiting claim / optional start | **yes** (blocks overlapping dispatch) |
| `running` | Claimed; executing | yes |
| `waiting` | Blocked on user input, A2A approval, or external event (including recoverable managed-Session unavailability before Delivery) | yes |
| `delivered` | Delivery submitted; awaiting review (or auto-integrate path) | yes |
| `accepted` | Review accepted / integrated; occupation released | no (terminal) |
| `rejected` | Delivery rejected; default returns to rework | yes while reworking |
| `interrupted` | User/orchestrator stop without integrate | no (terminal) |
| `failed` | Unrecoverable failure (not used for unintentional pre-Delivery Session death) | no (terminal; may be configured) |

Active set (occupies box): `queued | running | waiting | delivered`, plus `rejected` when `reject({ resume: true })` keeps rework occupation.

### 2.2 Transitions

```text
dispatch
   │
   ▼
queued ──cancel──► interrupted          # queued only; no workspace side effects
   │
 claim
   ▼
running ◄──────────────────────────────┐
   │                                   │
   ├──wait──► waiting ──resume──► running
   │
   └──deliver──► delivered
                    │
                    ├── accept ──► accepted
                    ├── reject(resume:true) ──► running
                    └── reject(resume:false) ──► rejected (terminal)

running | waiting ──interrupt──► interrupted
unintentional managed Session death (pre-Delivery) ──► waiting(reason=external, code=session_unavailable)
  # durable waitCode + stable English summary; occupation + TaskInput/UserAsk/report draft preserved
  # explicit task.startSession to resume (no auto re-prompt)
  # or explicit task.replaceSession for a fresh ss- on the same Task (contextRestored=false)
adapter / launch unrecoverable (no recoverable Session binding) ──► failed
```

Rules:

- `cancel` is only valid in `queued`.
- `interrupt` is valid for `running | waiting` (and may apply to `queued` as an equivalent of cancel where UIs unify the verb). Once a Delivery is published, finalization has won: the reviewer must accept or reject it, and a later interrupt must not delete the Delivery or replace its terminal facts.
- Default reject path is **rework**: `delivered → running` with review note, matching current “reject keeps occupation”.
- Adapter process events never write box frontmatter; the service maps them into `running | waiting | failed`.

### 2.3 Node refs (non-exclusive) and collaboration projection (V0.2 / cx-tsw53f)

**Node is not a mutex.** Active Task envelopes reference Nodes via **`Task.contextCard.refs.nodes[]`** (durable `id` authoritative; `path` is a refreshable hint). Same Node, ancestor, descendant, and workspace/root context may be referenced by multiple active Tasks concurrently. Code isolation is Task worktree + Git integration — not a Node-tree lock. Authority remains parentActor / reviewer / roster (not asSub ancestor occupation).

| Source | Role |
| --- | --- |
| `Task.contextCard.refs.nodes[]` (+ lifecycle `state`) | **Node context refs + collaboration facts** (sole product truth for Node linkage) |
| Legacy `claims[]` | **One-shot `migrateLegacyTaskNodeRefs` → full Context Card**; new writes never persist `claims` |
| Empty `refs.nodes` (legacy `root` discarded on migrate) | Stable workspace context — **not** a fake Node ref and **not** a Tent-wide lock |
| Node frontmatter `owner` / `status` | **Retired** — stripped on migrate; never dual-written by claim/accept |

**Structural gates only for new dispatch:** `archived` / `invalid` still deny. Archive/purge fail **only** when the **exact** Node is **directly** referenced by an active Task; ancestor/descendant refs do not block. Rename/move with stable `nodeId` remain legal; Context re-resolves by id.

**V0.2 public read model:** `node.collaboration` / `node.collaborations` (not universal `todo|doing|done`).

| Condition | Wire |
| --- | --- |
| No **directly-referencing** active Task on this Node | `activeTasks: []`, `activeTaskCount: 0` |
| One or more direct active refs (`queued\|running\|waiting\|delivered`) | `activeTasks: NodeCollaborationActiveTask[]` ordered by `createdAt` / `id` / `path`; each item `{ task, session\|null, delivery\|null }` |
| Ancestor/descendant-only refs | **not** painted on this Node |
| Terminal Tasks | omitted from `activeTasks` |

**`activeTaskCount` (judge addendum):** projection-only derived data. Never persisted on Task/Node disk; never a second collaboration fact. With the current **unpaginated** `activeTasks` array it **must always equal `activeTasks.length`**. Do **not** pre-seed `totalCount` / pagination / truncation semantics on this wire.

Rules:

- Match is **direct** `contextCard.refs.nodes` id only — never ancestor/descendant-derived paint; residual `claims` are migrator-only.
- **Multiple** directly-referencing active Tasks on one Node are **legal** and all projected (deterministic order). No singular `task` / `session` / `delivery` or `activeTaskId` compatibility alias on the final wire.
- Project **raw Task.state** per entry (no Node-level todo/doing/done).
- Attach Session / Delivery **only** through explicit Task ids — never path/name/time inference. Stale ids → `session`/`delivery` null while keeping the Task pointer.
- Batch `node.collaborations({ ids })` preserves input order (including duplicate ids); empty `ids` → empty `items`.
- Load tent + tasks + deliveries **once** per batch. Session probe only unique `sessionId`s from selected active tasks.
- Missing / invalid Node ids fail loud (`-32004` / invalid concept).
- Entities stay separate: no Node owner/status/coordination fields on the wire.
- `activeTaskCount === activeTasks.length` on every item (derived mirror only).

**Forbidden:** UI or agents writing `assignee` / legacy `owner`/`status` on Nodes—including via ordinary **`docs.write`** / frontmatter body patches. Collaboration progress is Task/Session/Delivery (+ `node.collaboration`) only.

### 2.4 Parallelism and `docs.fork`

- Default: multiple active Tasks may reference the **same** Node (non-exclusive refs).
- Optional isolation: **`docs.fork(boxId | path)`** still copies a concept subtree when callers want a separate durable Node; it does **not** start a task or session by itself.
- Multi-role orchestration may dispatch concurrent refs on shared Nodes; write isolation is worktree/Git, not Node occupation.

---

## 3. Task API

All mutations go through Local Tent Service → core. Logical verbs below; transport (HTTP / named pipe / in-proc) is an architecture concern.

**Canonical external command groups** for clients: **`task.*`** and **`docs.*`**.
`AgentRuntimePort.*` is **service-internal only** (architecture §5). Clients never call the runtime port directly.

### 3.1 Commands

| API | Default callers | Effect |
| --- | --- | --- |
| `task.dispatch` | user; authorized orchestrator role | Create `queued` task + manifest snapshot. Params: required explicit `parentActor` + `reviewer` (`{ kind: user\|role, id }`), `assigneeKind` (default `role`), `role` (required for role), `profileId` (required for agentProfile and must exist in the machine-local profile catalog), optional `asSub` (Git-lane only), optional `startSession` + same `profileId`. **Rejects** legacy `dispatchedBy` fail-loud (migration-only on disk). Does **not** start a session unless `startSession: true` and A2A allows. **Combined convenience only** (`startSession: true`): claim then `task.startSession`; if start fails before any Session bind while the Task is still `running` without `sessionId`, release via existing `task.interrupt` (preserve audit; no deletion) and rethrow the original RPC error. The running/no-session precondition and interrupt share one workspace MutationBus section so a concurrent Session bind is never interrupted or stopped. Leave honest `waiting(a2a-approval)` / provider `failed` alone. Separate `task.claim` / `task.startSession` are unchanged. `asSub: true` fails before envelope creation without a durable registry parent Role, real Git workspace, and parent Role lane. |
| `task.claim` | target assignee/session (or user on behalf) | `queued → running`; bind `sessionId` reference; project assignee (role name or profileId) |
| `task.startSession` | authorized orchestration / user | Resolve **machine-local AgentProfile**, enforce **A2APolicy**, then service calls **internal** `AgentRuntimePort`. For agentProfile tasks, `profileId` must match the envelope assignee. **Authorized per-Task managed-session execution slot** (`workspaceId`+`taskPath`, shared with `task.replaceSession`): every caller independently passes A2A/approval/policy/profile and task-state gates **before** joining any provider-launch flight (unauthorized callers never piggyback). After authorization, concurrent same-operation+profile callers coalesce to one launch until the envelope `sessionId` bind completes; a different `profileId` or concurrent `replaceSession` while a launch is in flight fails with stable retryable `RPC_LIFECYCLE` (`managed session operation already in progress for this task`). If a usable bound Session already exists (non-terminal managed), return/reuse it without starting another provider. Late events from a prior `sessionId` remain harmless after rebind. Does **not** add a Task state; does **not** define force-fresh Session replacement as a public contract (use explicit `task.replaceSession`). |
| `task.replaceSession` | same A2A authority as `task.startSession` | **Explicit** fresh managed Session when the bound provider context is unusable. Preserves the **same** Task (id, claims, worktree/branch/lane, deliveryPolicy, occupation) and open pending TaskInputs. Fully stops/terminalizes the old managed Session (`stopReason=user`) **before** allocating a new `ss-*` with the **same** authorized `profileId`. New Session always projects `contextRestored=false` with stable `restoreReason=task.replaceSession.fresh` and audit linkage (`replacedSessionId` / `replacedBySessionId`). Late events from the retired session must not mutate the rebound Task (sessionId binding + intentional stop). **Not** a silent fallback from `task.startSession` (that path keeps its own idempotency / resume rules). Shares the per-Task managed-session execution slot with `startSession` (authorize first, then flight; concurrent replacements coalesce when same profile, otherwise fail deterministically). Eligibility: `running` + turn-idle, or `waiting` only with durable `waitCode=session_unavailable` — never unresolved user-input / a2a / tool waits. When the old turn is still busy (`probe.turnBusy=true`): fail-loud `TURN_BUSY` (retryable) — no `force` flag. Once old Session retirement begins, every subsequent failure (including RpcError / identity drift) parks `waiting(session_unavailable)` with occupation held and **one unambiguous bound Session** (the prior `ss-`; never a stopped replacement orphan) — never leaves `running` bound to the dead prior Session. Open TaskInputs rebind via one atomic `TaskInputStore` batch mutation on the same per-task managed U2A FIFO as inject (validate every scoped open row, persist one snapshot once, all-or-none); queued pre-replace managed inject workers re-derive the Task-bound session at execution and must never rebind/inject the retired session. Ordinary A2A ask/deny applies. |
| `task.wait` | executing session / service | `running → waiting` with reason + summary |
| `task.resume` | user confirmation / external event | `waiting → running` |
| `task.askUser` | executing session / external agent | Create one **machine-local UserAsk** (business question) and `running → waiting(user-input)`. Not chat; at most one pending business ask per task. Distinct from `toolApproval.*` and `a2a.*`. |
| `task.sendInput` | **user only** | One-shot **U2A append** of `text` and/or `contextRefs` (stable entity ids) to a **running or waiting** managed task. Not chat; not conversation history; not profile mutation. Fail-loud if a pending UserAsk exists (use `userAsk.reply`). **Task-state validation + durable TaskInput.add are serialized on the same workspace MutationBus as Delivery publish** so either ordering is honest: input first → `PENDING_TASK_INPUT` blocks ready Delivery; Delivery first → sendInput rechecks state and refuses (cannot slip a pending row between the final gate and `taskDeliver`). **RPC returns after durable accept only** (`accepted: true`, `input.status` typically `pending`; `continued: false`) — it does **not** wait for the provider Agent turn (avoids CLI false timeouts). Managed inject is scheduled **after** durable accept, outside the mutation, on a **per-task FIFO** background worker (`processing` → `delivered` \| `failed` with `lastError` \| `uncertain` when provider accepted but durable delivered mark failed). True inject failures are retained and retryable; **`uncertain` is durable at-most-once evidence** (never an inject/recovery source) and blocks Delivery until explicit `taskInput.ack`. Explicit retry creates a **new** TaskInput before acknowledging the old uncertain id. Unrelated tasks stay concurrent. External agents poll + `taskInput.ack`. |
| `task.deliver` | assignee **or Local Service** (managed ACP auto-deliver) | Create/update delivery; enter `delivered` (or auto-integrate path per policy). Managed path: service seals the turn then calls the same lifecycle with `summary` = final assistant reply — never auto-accept beyond existing deliveryPolicy. **Public** `task.deliver` / `task.requestReview` fail-loud (`TURN_BUSY`) when the task is bound to a managed session with `runtime.probe(sessionId).turnBusy=true`; task stays `running` and no ready Delivery is published. Idle managed turns and external (no busy) sessions still allow manual deliver. **Shared authority with managed auto-deliver:** any TaskInput on this task still `pending`, `processing`, `failed`, or `uncertain` fails-loud with stable code `PENDING_TASK_INPUT` (structured `inputIds` / `statuses` / `firstInputId` / `firstStatus` for UI invalidation); task stays non-terminal and **no** ready `dl-` is created, including bypass/auto-accept. `uncertain` remains at-most-once and is never re-injected; only authorized `taskInput.ack` lifts its blocker. Terminal `delivered` / `consumed` / `cancelled` rows do not block. **Managed ordering:** assert blockers **before** seal so refusal leaves the managed Session live and rows intact; re-assert under the final publish mutation (TOCTOU). Managed turn seal **must not** cancel blocker rows. Report draft is preserved; acknowledging uncertain requests exactly one draft-only retry without prompting the provider. |
| `task.requestReview` | assignee | Explicit review queue (used when `agent-decide` chooses upgrade). Same turnBusy + `PENDING_TASK_INPUT` gates as `task.deliver`. |
| `task.accept` | user; authorized orchestrator **≠ deliverer** | Integrate commits if any → `accepted`; clear occupation. Commit-bearing path re-checks Delivery `targetHead` against the current integration target HEAD before Git (`TARGET_MOVED` leaves Task `delivered` + Delivery `ready`). Optional `outputNodeIds`: bind Output Nodes to the accepted Delivery via reserved FM `deliveryId` (all-or-nothing inside the final accept mutation; same Delivery idempotent; other Delivery fail-loud). |
| `task.reject` | same as accept | Reject delivery; default resume rework. `resume: false` / `--no-resume` is terminal collaboration only (no session restore, no review U2A). When `resume: true`: (1) core reject → `running`, (2) persist lifecycle **review-feedback** TaskInput, (3) if the task already has a managed `sessionId`, restore/bind a live session: rebind when still alive (`contextRestored=true`); native `runtime.resumeSession` / `session/load` with the **same Tent `sessionId` and provider token** when stopped and `probe.resumeCapable` (`contextRestored=true`); when native resume **explicitly fails** or prior is not resumeCapable, allocate a trackable new `ss-` on the same task/workspace lane with recovery orientation (`contextRestored=false` — never silently claim cache continuity). Recovery bootstrap carries Task/Node refs, rejected Delivery summary, durable review feedback text, and workspace lane; feedback is still injected **exactly once** as `## Review Feedback`. Registry/profile identity failures still park `waiting(external)`, retain the review TaskInput, and fail the RPC — never leave `running` with a dead managed process. **Late `session.failed` after park must not demote** `waiting(external)` or cancel that review-feedback (`resolvedBy=task.fail`). (4) **RPC returns after durable accept + restore only** (`accepted: true`, `enqueued: true` when managed, `input.status` typically `pending`, `continued: false`) — it does **not** wait for the provider Agent turn. Managed injection of `## Review Feedback` runs on the per-task FIFO background worker (`processing` → `delivered` \| `failed` with `lastError` \| `uncertain` at-most-once); failed rows stay retryable/poll-visible and terminal rows skip re-inject. Tasks without `sessionId` keep core-only rework + pending review-feedback for poll+ack. Delivery remains single-track. **Session vs Task authority:** after a managed task is already `delivered` (or later accepted/rejected), Session terminal state is diagnostic only and must not demote the published Delivery. Empty `taskInput.listPending` after a successful managed turn is normal when U2A rows are `delivered`/`consumed` — not evidence of erroneous cancellation (`cancelled` + `resolvedBy=task.fail` is the bug signal). |
| `task.interrupt` | user; authorized orchestrator | No integrate; `interrupted`; clear occupation; temporary agentProfile Task worktree may auto-reclaim when clean/unambiguous (Role lanes stay) |
| `task.cancel` | user; `queued` only | Drop unclaimed task; same Task worktree reclaim rules as interrupt when a lane was recorded |
| `docs.fork` | user; authorized orchestration | Fork box/concept subtree for parallel work (see §2.4); not a task transition |
| `proposal.submit` | submitting role (CLI `TENT_ROLE`) | Create/replace proposal file under `temp/<role>/proposals/<boxId>.md` as `pending`. Core rejects empty body, missing/duplicate box, unsafe role, and a second concurrent pending. Does **not** auto-apply body to the box. |
| `proposal.resolve` | **user only** (`actor` default `user`; non-user → RPC deny) | Accept or reject a **pending** proposal; reload and return terminal projection. Separate from delivery review. |

### 3.2 Queries and events

- `task.get` / `task.list({ boxId, role, state })`
- `delivery.get` / `delivery.list`
- `proposal.list({ workspaceId, boxId?, status? })` — `status` = `pending` (default) \| `accepted` \| `rejected` \| `all`; returns `{ proposals }` projections (`path`, `boxId`, `role`, `status`, `createdAt?`, `body`)
- `session.get` / `session.list` (projections; no secrets/tokens in client payloads)
- `a2a.listPending` / `a2a.resolve` — **spawn** gate only (role `a2aPolicy` + `allowedProfiles`); resolve is user-only; not tool permissions
- `registry.roles` / `registry.role.create` / `registry.role.update` / `registry.role.delete` — role registry read + user-only mutations (see §4.3.1); success event `registry.roles.updated`
- `toolApproval.listPending` / `toolApproval.get` / `toolApproval.approveOnce` / `toolApproval.deny` — ACP **tool** permission (`permissionPolicy=ask`); user-only; machine-local; distinct from A2A
- `userAsk.listPending` / `userAsk.get` / `userAsk.reply` / `userAsk.deny` — **A2U business UserAsk** (machine-local); reply/deny are **user-only**; answer + task resume are atomic (answer is never dropped if managed continue fails). Managed ACP continues the **same session** with a fixed-format `## User Answer` prompt (live follow-up or provider resume when capable). External agents poll `userAsk.get` — no chat transcript. Interrupt/fail/session cleanup cancel pending asks. Events: `userAsk.pending` / `userAsk.resolved` (plus existing `task.state`)
- `interaction.listPending({ workspaceId })` — **unified A2U pending read projection** for one workspace. Aggregates four domain sources only: pending UserAsk, pending A2A spawn approval, pending ACP tool approval, and `status=ready` Delivery. Returns `{ workspaceId, items, counts }` where each item has stable `kind` / `id` / `workspaceId` / `createdAt`, optional entity pointers (`taskPath` / `taskId` / `boxId` / `role` / `sessionId`), and a **safe** kind-specific summary (question+choices; profileId/policy; toolTitle+options; delivery path/status). **Never** projects secrets, tool raw args, or Delivery summary body. Sort is stable: `createdAt` ASC, then `kind`, then `id`. `counts` is per-kind plus `total`. **Fail-loud**: any single source failure fails the whole RPC — clients must not treat a partial list as an authoritative inbox. **No** `interaction.resolve` and **no** new store/state machine; resolve stays on domain RPCs (`userAsk.reply|deny`, `a2a.resolve`, `toolApproval.approveOnce|deny`, `task.accept|reject|interrupt`). Events remain domain invalidation only (`userAsk.*`, `a2a.*`, `toolApproval.*`, `delivery.updated`, `task.state`) — no copied inbox events.
- `taskInput.listPending` / `taskInput.get` / `taskInput.ack` — **U2A one-shot task input** (machine-local companion to UserAsk). `task.sendInput` is **user-only** and requires `workspaceId` + `taskPath` plus non-empty `text` and/or `contextRefs`. Status projection: `pending` (accepted/enqueued) → `processing` (managed inject in flight) → `delivered` (managed inject ok + durable mark) or `failed` (inject error retained with `lastError`, retryable) or `uncertain` (**provider may already have received it** but durable confirmation failed — persistent at-most-once evidence, never retry/recovery/inject source) or `consumed` (authorized `ack`) / `cancelled` (**pending|failed only** on interrupt/fail/session cleanup). Restart reloads in-flight `processing` as `uncertain`. Internal retry/inject queries return only `pending|failed`; the public exact-task `listPending` compatibility projection is an **attention list** returning `pending|failed|uncertain` with `status` / `lastError` / `uncertainAt` and must never feed a worker. `pending|processing|failed|uncertain` block Delivery. `ack` on uncertain means acknowledge ambiguity and continue without re-inject; it preserves ambiguity diagnostics and triggers only durable report-draft retry. Omit `actor` for the Local Service user path (allowed only when persisted parent/reviewer is user); explicit actor must match exact Task role, persisted parent/reviewer Role, or a Service-verified bound Session. Explicit caller text `actor=user` is not authority. No new resolve RPC/entity, conversation history, generic chat bus, or profile mutation. Events remain `taskInput.pending` / `taskInput.delivered` / `taskInput.uncertain` / `taskInput.consumed` / `taskInput.cancelled`.
- `operationalRetention.preview` / `operationalRetention.purge` — user-only terminal operational heat cleanup (see §6); preview read-only; purge via MutationBus; event `retention.purged` only when files deleted
- `task.worktreeReclaim.preview({ workspaceId, taskPath })` — **read-only** diagnostic for one Task's temporary Git worktree reclaim eligibility (see §4.6). Does **not** mass-scan historical inventory and does **not** require user confirmation for ordinary safe auto-reclaim. Event `task.worktreeReclaim` is emitted after auto attempts (including refuse / already-gone).
- `workspace.settings` / `workspace.settings.update` — workspace collaboration settings (see §5.3); read projection + user-only MutationBus update; event `workspace.settings.updated` only on successful actual change (no-op / failure emit none)
- `annotation.list` / `annotation.create` / `annotation.resolve` / `annotation.reopen` / `annotation.delete` — Node Markdown **underline annotations** (划线注释). First-class records under system root (`annotations.json`), keyed by `nodeId` (not path). Mutations are **user-only** via MutationBus. Create validates body range/quote + `documentEtag` (docs etag family). List projects live relocate (`anchored` \| `relocated` \| `orphan`) without rewriting stored anchors or the document. Events: `annotation.changed` (invalidation only; payload `action`, `id`, `nodeId`). Not chat, not Task, not auto Agent inject — UI may later map a comment to `task.sendInput` explicitly.
- `node.collaboration({ workspaceId, id | path | boxId })` → `{ workspaceId, nodeId, activeTasks, activeTaskCount }`
  - **V0.2 truth** for Canvas / UI collab chips (cx-tsw53f multi-Task). Same concept selector conventions as `docs.get`; missing or invalid concepts fail cleanly.
  - `activeTasks` lists **all** directly-referencing active Tasks (raw state + assignee + optional session/delivery ids per entry), ordered by `createdAt`/`id`/`path`. Idle → `[]` / `activeTaskCount: 0`. No singular `task`/`session`/`delivery` alias.
  - Per entry, `session` / `delivery` are nullable summaries attached **only** via that Task’s `sessionId` / `activeDeliveryId`.
- `node.collaborations({ workspaceId, ids })` → `{ workspaceId, items }` with multi-Task item semantics; `items` ordered as `ids`; empty `ids` → empty `items`; one tent/task/delivery load; session probes only unique explicit ids from selected tasks.
- `output.provenance({ workspaceId, id | outputId | path })` → Output → Delivery → Task → sourceNode chain (see §2.5). Not occupation; not folded into `node.collaboration`.
- `subscribe` (via common **EventEnvelope** — architecture §5.2): `task.state`, `delivery.updated`, `session.state`, `proposal.updated` (after successful submit/resolve only; payload `path`, `boxId`, `role`, `status`, `reason`), `a2a.ask`, `registry.roles.updated` (after successful role create/update/delete only; payload `action`, `name`), `toolApproval.pending` / `toolApproval.resolved`, `userAsk.pending` / `userAsk.resolved`, `taskInput.pending` / `taskInput.delivered` / `taskInput.consumed` / `taskInput.cancelled`, `retention.purged` (after successful purge that deleted files), `workspace.settings.updated` (after successful settings mutation that actually changed the projection; payload `settings`), `annotation.changed` (after successful annotation create/resolve/reopen/delete; payload `action`, `id`, `nodeId`), plus document events `concept.changed` / `concept.removed` from the docs group

**Event invalidation:** `task.*` / `delivery.*` / `session.*` invalidate `node.collaboration` / `node.collaborations` (and task/session list bags). Successful Output provenance bind emits `concept.changed` for Output ids (`reason: output.provenance-bind`). Events are never a second truth source.

**No** separate Node-collab event channel. Concept identity changes use `concept.*` only.

### 2.5 Output provenance (V0.2 minimal)

**Entities stay separate.** Output is an ordinary primary `type=output` Node. Unbound Output is legal. Provenance is **not** collab occupation and is **not** a generic `relation.*`.

| Rule | Contract |
| --- | --- |
| Authority | Output frontmatter reserved field **`deliveryId`** only. No redundant `taskId` / `sourceNodeId` on Output; no Delivery-side authoritative reverse list in minimal P0. |
| Bind path | Formal **`task.accept`** may pass `outputNodeIds`. Inside the final accept mutation (after delivery revalidation): (1) snapshot Delivery+Task raw, (2) bind Outputs with per-file raw snapshots + compensating rollback, (3) persist accepted Delivery/Task (compensate with 1+2 on failure). Snapshot reads happen **before any Output write** so a failed operational snapshot cannot leave Outputs bound. Fail loud if rollback itself fails. Any failure → Task, Delivery, and Outputs stay unchanged (no partial accept / partial provenance publish). |
| Output eligibility | Exists, valid, not archived, primary type base = `output`. Same `deliveryId` → idempotent success. Different `deliveryId` already present → fail loud. |
| Client writes | `docs.write` / raw / semantic patch **cannot** set or change `deliveryId` (reserved with `id`/`mode`/`archived`). |
| Query | `output.provenance({ workspaceId, id \| outputId \| path })` → `{ workspaceId, outputId, path, bound, deliveryId, delivery, task, sourceNode, incomplete }`. Stable Node id preferred; path compatible. Unbound → `bound: false`, nulls, empty `incomplete`. Missing heat records → live halves null + `incomplete` reasons (`delivery_missing` / `task_missing` / `source_missing` / `mismatch`). **Never** infer by path/name/time/text. Archived Output remains readable. |
| Retention | Operational retention **pins** any Delivery (and its Task group) referenced by a live Output.`deliveryId`, including archived Outputs. Not a general permanent history system. |
| Events | Bind success: `concept.changed` on Output ids. Task/Delivery events keep existing collab semantics. |

CLI: `tent task accept <taskPath> --actor <user\|role> [--outputs id,id]`.

### 3.3 CLI surface

The CLI exposes canonical `tent task *` commands only. There are no legacy
aliases or direct-core Task mutations. Formal delivery is Delivery-only through
`tent task deliver`.

### 3.4 Decoupling from runtime

```text
Task API (external, collaboration)     AgentRuntimePort (service-internal execution)
──────────────────────────────────     ────────────────────────────────────────────
task.dispatch / claim / wait           startSession / resumeSession / stopSession
task.deliver / accept / interrupt      process / session events only
docs.fork + box occupation & review    no box-tree writes; no client exposure
```

Agents submit task targets (role / **AgentProfile** id / capability). They never read provider credentials. The service resolves authorized machine-local profiles and starts adapters **after** A2A.

### 3.5 Managed ACP vs external manual agent (two paths)

| Path | Who starts | Bootstrap | Claim | Report / deliver |
| --- | --- | --- | --- | --- |
| **Managed ACP** (`task.startSession`) | Local Service after A2A | Context Card **pointer** + near-field **user prompt** (task envelope `## User Prompt` only — not box/manifest bodies) | Service claims (user path) before spawn; agent must **not** claim | Service captures the **final** ACP assistant reply (last non-empty contiguous `agent_message_chunk` segment after tool/status/thought separators; not intermediate narrations) and calls **the same** `task.deliver` with `summary` = that reply. Agent does **not** need `tent task deliver`. |
| **External / relay** (clipboard, pull-host) | Human / external session | `relayPrompt` (claim → get → deliver CLI steps) | Agent runs `tent task claim` | Agent runs `tent task deliver --summary …` |

**Managed invariants:**

1. **Report ≡ final assistant reply.** Tent does not invent a second “report” channel; delivery.summary is that text only — not intermediate assistant updates, thoughts, or tool/status diagnostics concatenated into one blob.
2. **No auto-accept.** `deliveryPolicy=review` → `delivered` + ready delivery pending user review. `bypass` / `agent-decide` use existing policy routing only (`agent-decide` without an integrate decision defaults to **request-review**).
3. **No forge on failure.** Empty assistant text, ACP error, timeout, stop, or interrupt → **no** delivery; task/session projects `failed` or `interrupted` with recoverable semantics where applicable.
4. **No double delivery.** Reconnect / duplicate `session.prompt_complete` / already `delivered|accepted|…` is ignored or fails loudly at lifecycle authority — never two ready deliveries.
5. **Tool permissionPolicy** remains `deny|ask|allow` (default **deny**). Tool-less tasks must still complete via the managed report path.
6. **Turn settle before Delivery.** `session.prompt_complete` is only the visible end-of-prompt signal. Local Service must **seal** the managed turn (stop process / clear turn-busy; cancel pending tool asks) **before** publishing Delivery. Session `live` alone is not turn-done; post-response tool/write/commit must not race dispatcher rebase or user accept. `stop-after-deliver` semantics remain (role slot free; resume metadata retained), ordered as seal-then-deliver. Public `task.deliver` / `task.requestReview` (CLI/agent manual path) enforce the same boundary: if the bound managed session reports `turnBusy`, refuse with a lifecycle error and leave the task running — do not rely on the caller to honor turn settle.

---

## 4. A2A hard authority (`A2APolicy` = `allow` | `ask` | `deny`)

### 4.1 Policy type

```ts
/** Canonical spawn authority enum — evaluated only inside Local Service. */
type A2APolicy = "allow" | "ask" | "deny";
```

Persisted on durable **role** (and optional per-profile override). UI may localize labels; stored values are always English enum strings above.

### 4.2 Policy meanings

| Policy | Behavior |
| --- | --- |
| `allow` | Role may autonomously start authorized **AgentProfile**s / subagent sessions |
| `ask` | Start request enters user confirmation (`waiting` + `reason=a2a-approval`); service spawns only after grant |
| `deny` | Must not create a new runtime instance. Pull-mode file envelopes may still exist for a user-woken existing session |

### 4.3 Hard enforcement (service only)

Before any of:

1. `task.dispatch` with `startSession: true`
2. `task.startSession` / internal adapter spawn / resume that creates a new process
3. A role creating a session for another role (peer or sub)

the service MUST:

```text
1. Authenticate caller (user token | role session token)
2. Require explicit profileId (no fake-default / product-profile silent fallback)
3. user caller → allow (user is root; user-direct one-shot profile path stays separate)
4. Role-agent path (Task.agentId present): roster membership is standing authorization —
   out-of-roster fails loud; in-roster proceeds without a2aPolicy ask/deny and without
   creating A2A approvals. Launch uses AgentDefinition→profileId only.
5. Other role callers (no Task.agentId): load role.a2aPolicy (default deny);
   ignore client-supplied a2aPolicy; reject a2aPolicyOverride over RPC
6. allow (non-standing) → may require roster-resolvable launch target → startSession
7. ask  → enqueue a2a.ask; task.wait; do not spawn (not used for standing Role-agent path)
8. deny → return A2A_DENIED; leave no half-started process state
```

An approval is bound to its exact `workspaceId`, `taskPath`, and `profileId`; it cannot be replayed for another launch target. `a2a.resolve` is user-only. Role-agent standing roster paths never enqueue approvals.

**Prohibited:** using skill text, workspace `AGENTS.md`, or an honor manifest alone as spawn authorization; trusting ordinary RPC `a2aPolicy` to raise authority; re-inferring Role authorization from profileId history when Task.agentId is present.
**Orthogonal:** manifest readable/writable remains an honor contract for file edits after claim; it does not authorize process start.
**Clients** call `task.startSession` (or dispatch with `startSession: true`); they never call `AgentRuntimePort` directly.
**Roles** may store `a2aPolicy` and `roster` (**agentIds** only) — never provider secrets, model, or tokens.
**AgentDefinition** (machine-local `agent-definitions.json`) binds `agentId` → `profileId` for launch resolution only; it is not Role authorization.
**Task.agentId** is persisted on Role-agent dispatch and projected on task reads/startSession; user-direct profile Tasks omit it.
**Legacy:** on-disk `allowedProfiles` is migrated one-time to `roster` (agentId defaults to former profileId). Public Service/client mutations reject `allowedProfiles` fail-loud.

### 4.3.1 Role registry mutations (user-only)

| Method | Notes |
| --- | --- |
| `registry.roles` | Read projection: name, description, color, prompt, effective `a2aPolicy`, `roster` only (no `allowedProfiles` dual-read) |
| `registry.role.create` | User actor only; MutationBus; name immutable after create; accept `roster` only — `allowedProfiles` rejected fail-loud |
| `registry.role.update` | User actor only; cannot rename; `null`/empty clears optional text, policy, CLI, or roster; `allowedProfiles` rejected fail-loud |
| `registry.role.delete` | User actor only; `confirmation` must equal `name`; refuses **durable role** active task or live/starting/waiting-user managed session (`assigneeKind=role`). One-shot agentProfile sessions (even if `roleName` equals the role name) do **not** block delete. |
| `agent.list/get/create/update/delete` | Machine-local AgentDefinition CRUD (agentId ↔ profileId); never secrets |

Successful create/update/delete emits **exactly one** `registry.roles.updated` (`action`, `name`). Failures emit nothing.

### 4.4 Self-accept ban + reviewer authority

- `task.accept` / `task.reject` actor **must not** equal the delivery submitter (self-review ban). Executor never self-accepts.
- Ordinary accept/reject authority equals the **exact persisted Task.`reviewer`** only — never a different actor and never the submitter.
- **`reviewer` is derived from `parentActor`:** on every new write, `reviewer.kind/id` must equal `parentActor.kind/id` (callers may omit `reviewer` and Core/Service derive it once; both fields are still persisted). An explicit mismatched pair fails loud — Role A cannot assign reviewer Role B.
- User-reviewed tasks (`reviewer.kind=user`, user-direct): only `actor=user`.
- Role-reviewed tasks (`reviewer.kind=role`, Role-dispatched child): only exact `reviewer.id` parent Role. **User must not bypass the parent Role via ordinary review.**
- Recording `review.by = submitter` is a hard error.
- Soft policy only — self-declared `actor` rides the shared service token (not cryptographic auth).

### 4.5 Peer vs sub (hardened) + parent/reviewer

| | Peer (parent often user) | Sub (`asSub: true`, parent Role) |
| --- | --- | --- |
| Target | first-class role or **AgentProfile** | tool-like helper of parent Role (role **or** agentProfile assignee) |
| `targetBranch` | workspace mainline (e.g. `main`) | parent role branch `tent-role/<parent>` |
| Execution lane | role: `tent-role/<assignee>` at dispatch; profile: deferred to `startSession` as `tent-task/<taskId>` | role: `tent-role/<assignee>`; profile: `tent-task/<taskId>` allocated at dispatch (taskId before lane) |
| Default accept authority | exact Task.`reviewer` (user for user-direct) | exact parent Role in `reviewer` only (not user ordinary-bypass; still not self) |
| A2A (`callerKind=role`) | role assignee → task role; profile assignee → parent Role | **always** parent Role (role and profile assignees) |
| **WorkspaceLane** | optional (pure Tent tasks legal—no code lane) | required (dispatch rejected without Git + parent Role lane) |
| Integrate cwd | worktree that already has target (usually main workspace on mainline) | parent worktree (already on `tent-role/<parent>`); **never** auto-switch branches |
| deliveryPolicy elevate | Role user-facing only (`bypass`/`agent-decide`) | **always `review`** — no downstream bypass/agent-decide |
| Create wire | explicit `parentActor`+`reviewer` required; `dispatchedBy` rejected (migration-only) | same — CLI `--by` translates locally to actors, never sends `dispatchedBy` |

### 4.6 Explicit Task outcome (managed final report)

Managed ACP final assistant replies must lead with an explicit outcome wire:

```text
outcome: delivered | blocked | needs-input

<report body>
```

| Outcome | Service behavior |
| --- | --- |
| `delivered` | After turn seal + worktree clean + TaskInput gates, publish ready Delivery (or auto-integrate when policy allows). Summary = report body only. |
| `blocked` | No ready Delivery. Park via `task.wait` (`reason=external`, `code=blocked`). |
| `needs-input` | No ready Delivery. Park via `task.wait` (`reason=user-input`, `code=needs_input`). Prefer existing UserAsk/`task.askUser` when a structured question is needed. |
| missing/invalid | No ready Delivery. Session diagnostic; task stays retryable. |

Public `task.deliver` remains an explicit Delivery publish API (external/relay). It does not invent outcome from free text.

### 4.6 Terminal Task worktree reclaim (V0.2)

**Problem:** Role worktrees are long-lived integration lines; code Task worktrees are short isolation lanes. After a Task becomes terminal, Tent historically cleaned only operational records and left Git worktree registrations/directories behind.

**Frozen boundary:**

| Rule | Behavior |
| --- | --- |
| Role lanes | **Never** enter Task worktree GC. `tent-role/<role>` stays durable. |
| Code Task lanes | Only `assigneeKind=agentProfile` lanes (`tent-task/<taskId>`, directory `task-<slug>`) are reclaim candidates. |
| Pure Tent / docs | No Git lane → `NOT_APPLICABLE` (no-op). |
| Auto-reclaim when | Task is terminal (`accepted` \| `rejected` \| `interrupted` \| `failed`), required integrate/settle is complete, worktree is **clean**, no live/busy/external Session is still bound to the Task, and ownership/path/branch are unambiguous. |
| Fail closed | Dirty, unintegrated (Delivery commits **or** exclusive Task-branch tips not on `targetBranch` via ancestor/-x), conflicted registration, running/active Session, externally owned, or ambiguous path/branch → refuse with stable diagnostic code; **keep the scene**. |
| Remove only | Exact Task worktree **directory** + Git **worktree registration**. Never `git worktree remove --force` while the directory still exists. Immediately before remove, revalidate fresh registration: exact path, `tent-task/*` branch, and branch-tip/HEAD ownership (dirtiness alone is insufficient). If the directory is already gone, drop **only** that exact path's verified registration after the same ownership proof (`git worktree remove --force <exact-path>` only). **Never** repository-global `git worktree prune` in auto-GC. Preserve commits, branch refs (audit), and every Tent Task / Session / Delivery record. |
| Idempotent | Repeated reclaim / already-absent directory+registration → `ALREADY_GONE` success. |
| Restart | Terminal transitions observed by this feature enqueue a narrow pending marker under `temp/task-worktree-reclaim-pending.json`. `workspace.mount` only registers one Service-owned runner and returns; the runner retries existing queue rows at most once that boot, then performs a **one-pass** bounded historical scan over Task envelopes in stable `taskPath` order (cursor + completion on the same queue file). Only terminal agentProfile lanes with recorded worktree/branch are enqueued. Refused rows persist diagnosable `needs-attention` (code/reason/attemptedAt) and are not spun in the same boot. Never free-form worktree inventory crawl; never repository-global `git worktree prune`. |
| UI | No UI surface in this slice. Daily safe reclaim does not require user confirmation. |

**Triggers (Service, best-effort after lifecycle; Git outside MutationBus):**

- `task.accept` / auto-integrate `task.deliver` when state becomes `accepted` (after Session settle gate)
- Managed auto-deliver: **after** `stopManagedSessionAfterDelivery` when state is `accepted`
- Terminal `task.reject` (`resume: false`)
- `task.interrupt` / `task.cancel` / `task.fail` (and equivalent runtime fail path)
- `workspace.mount` recovery pass over **pending queue** (restart-safe retry), then Service-owned bounded **historical one-pass** background batches (non-blocking; drainable on unmount/shutdown)

**Session settle:** reclaim refuses with `SESSION_ACTIVE` while any bound managed/external Session is alive, non-terminal, or `turnBusy`. The final settle re-probe + clean/ownership revalidation + exact remove run under the same per-Task lifecycle lock as accept/reject/interrupt/rebind; the bound Session is re-probed **immediately before** `git worktree remove`. A terminal Task with Delivery published but `turnBusy`/`alive`, or a late write/commit before settle, fails closed and retries after session settle / mount recovery. External accepted Tasks enqueue pending while the Session is open; `session.leave` retries **only** the exact queued/`lastTaskId` terminal Task (unrelated pending rows untouched). Leave never delivers/accepts. Also: managed `session.exited`/`session.failed` on collaboration-terminal Tasks, and `workspace.mount` pending recovery.

**Diagnostic codes:** `RECLAIMABLE` / `RECLAIMED` / `ALREADY_GONE` / `NOT_APPLICABLE` / `NOT_TERMINAL` / `DIRTY` / `UNINTEGRATED` / `SESSION_ACTIVE` / `AMBIGUOUS_OWNERSHIP` / `EXTERNAL_OR_UNEXPECTED_PATH` / `CONFLICTED_REGISTRATION` / `REMOVE_FAILED`.

**Not in this slice:** bulk deletion of pre-existing historical worktrees; UI; any change to operational retention (§6) Task/Delivery file purge.

---

## 5. Delivery policies: `review` / `bypass` / `agent-decide`

### 5.1 Definitions

| Policy | Behavior |
| --- | --- |
| `review` | After `deliver`, task stays `delivered` until human/authorized review `accept` or `reject` |
| `bypass` | After `deliver`, service **automatically** integrates and `accept`s, still writing a full delivery audit record |
| `agent-decide` | Executing agent chooses, at deliver time, either **direct integrate** or **upgrade to review**—it does **not** impersonate an independent reviewer |

MVP default for tent/box/task inheritance: **`review`**.

### 5.2 Corrected `agent-decide` semantics (normative)

`agent-decide` is **not** “agent plays reviewer and stamps accept on itself.”

It is a **routing decision by the executor**:

```text
task.deliver({
  summary,
  commits?,
  checks?,
  decision: "integrate" | "request-review"   # required when deliveryPolicy=agent-decide
})
```

| `decision` | Service behavior |
| --- | --- |
| `integrate` | Service runs the **auto-integrate** path (same mechanical integrate as bypass). Audit: `integrationMode: agent-decided-integrate`. **No** `review.by=submitter`. Actor for integrate is the **service policy engine**, not a fake peer review. |
| `request-review` | Identical to `review`: task → `delivered` / delivery `ready`; only a non-submitter may `accept`/`reject`. Equivalent explicit call: `task.requestReview`. |

Hard rules:

1. If `deliveryPolicy=review` and caller passes `decision=integrate` → error `POLICY_FORBIDS_AUTO_INTEGRATE`.
2. If `deliveryPolicy=bypass` → ignore `decision`; always attempt auto-integrate; audit `integrationMode: bypass-auto`.
3. If `deliveryPolicy=agent-decide` and `decision` missing/invalid → error `DECISION_REQUIRED`.
4. **Never** allow the deliverer to call `task.accept` on its own delivery, including under `agent-decide`. Auto-integrate is a policy action, not self-review.
5. All integrates (manual accept, bypass, agent-decided) keep git commits for rollback; accept/delivery records list commit SHAs.
6. Ordinary agents must not grant themselves `bypass` / `agent-decide` on dispatch; service should reject unauthorized policy elevation. Prefer user or `allow`-class orchestrator for elevated policies.
7. **Authority gap (current service token contract):** loopback RPC auth is a single machine-local bearer token shared by Desktop, CLI, and agents. Self-declared `actor` / `callerKind` / `parentActor` / `reviewer` are **not** cryptographically bound to the caller. Until a stronger identity is available, `task.dispatch` does **not** enforce elevation checks beyond accepting an explicit `deliveryPolicy` from any token-holder (and still refuses elevated policy for downstream Task Agents). Workspace default changes remain **user-only** via `workspace.settings.update` (`actor` default `user`; non-user rejected). Do not treat cosmetic `actor` checks as a full auth model.

### 5.3 Policy placement

- Workspace setting `defaultDeliveryPolicy` lives in **`.tent/settings.json`** (system-root relative `settings.json`; registered system file).
- Values: `review` | `bypass` | `agent-decide`. Product-facing terms (not localized): **Review** / **Bypass** / **Agent Decide**. Missing file or field → **`review`**. Corrupt file → backup + reset + warning (same registry recovery convention).
- **Terminology migration (V0.2):** historical on-disk `manual` is normalized to `review` only at the narrow task-envelope / workspace-settings **read** boundary so existing development tents remain readable. New RPC writes (`task.dispatch`, `workspace.settings.update`) and new serialization **reject** `manual` and **write** `review`. Projections never expose `manual`. Do not build a broad compatibility shell.
- Schema is **extensible**: core preserves unknown on-disk keys and clients must tolerate extra fields. The current update RPC accepts only explicitly defined fields (`defaultDeliveryPolicy`); future settings extend the schema deliberately.
- RPCs:
  | API | Auth | Effect |
  | --- | --- | --- |
  | `workspace.settings` | any client with service token | Read normalized projection `{ workspaceId, settings }` |
  | `workspace.settings.update` | **user only** (`actor` default `user`) | Patch via **MutationBus**. Emits **exactly one** `workspace.settings.updated` **only when** the normalized projection actually changes. No-op success and failures emit **no** event. |
- `task.dispatch` with **omitted** `deliveryPolicy` **snapshots** the current workspace `defaultDeliveryPolicy` into the task envelope at dispatch time. Explicit `deliveryPolicy` still overrides. Changing settings later **never** rewrites existing tasks.
- Box-level default override is reserved for a later batch (not in this MVP).

---

## 6. Operational retention

### 6.1 Classes

| Class | Examples | Retention |
| --- | --- | --- |
| Collaboration facts | box body conclusions, artifactRefs, accepted commit pointers | durable until user deletes |
| Active operational | active task, ready delivery, waiting records | until terminal |
| Terminal operational | accepted / rejected / interrupted / failed tasks, accepted / rejected deliveries | **short heat retention** then purge (default **30 days**, RPC-overridable) |
| Local runtime only | PID, session registry rows, resume tokens, absolute worktree paths, AgentProfile paths | clear with process / stay machine-local; never ship in repo |
| Rebuildable | relay prompt copies, redundant manifest dumps | drop after terminal; rebuild from task fields if needed |

### 6.2 Promotion to OKF

- Terminal payloads are **not** a permanent audit product.
- Conclusions that matter long-term must be written into box/concept body, or **promoted** by the user (e.g. left-click elevate handoff/delivery summary → OKF concept).
- Do not assume temp/operational files survive forever.

### 6.3 MVP API (implemented)

Explicit user-only RPCs (successor of blunt `clean-temp` for operational heat). No UI and **no machine timer** in this MVP.

| API | Auth | Effect |
| --- | --- | --- |
| `operationalRetention.preview` | **user only** (`actor` default `user`; non-user → deny) | Scan `temp/<role>/{tasks,deliveries}/` and nested `temp/agent-profiles/<id>/{tasks,deliveries}/` via FsAdapter; return candidates / skipped / warnings. **Read-only**. |
| `operationalRetention.purge` | **user only** | Same selection as preview; delete via **MutationBus**. Emit **exactly one** `retention.purged` event **only when** files were actually deleted. |

**Params (both):**

| Param | Type | Notes |
| --- | --- | --- |
| `workspaceId` | string | Required when no foreground workspace |
| `keepTerminalTasksDays` | non-negative integer | Default **30**. Max **3650**. **`0`** = immediately eligible (explicit cleanup / tests). Not a free-form path. |
| `actor` | string | Default `user`; any other value is rejected |

**Safety rules (hard):**

1. **Never delete** tasks in `queued` / `running` / `waiting` / `delivered`, or deliveries in `ready`.
1b. **Never delete** a Delivery (or its Task group) while any concept Node still holds `deliveryId` pointing at that Delivery — including **archived** Output Nodes. This pins lightweight Output → Delivery → Task provenance without inventing a general permanent history system.
1c. **Fail closed on pin scan:** if `loadTent` / Output provenance pin scan fails, `operationalRetention.preview` and `purge` must **refuse** (error) rather than select candidates without pin knowledge.
2. **Terminal tasks** eligible for purge: `accepted` / `rejected` / `interrupted` / `failed` whose `updatedAt || createdAt` is on or before the cutoff.
3. **Task-group cleanup:** purge a terminal task **together with** its terminal deliveries so no dangling delivery references remain. If any related delivery is still `draft` or `ready`, refuse the whole group. Group age uses the most recent task/delivery activity timestamp.
4. **Orphan terminal deliveries** (unknown / missing `taskId` parent, status `accepted` / `rejected`) may be purged independently when past retention.
5. **Bad files** stay on disk; they appear in `skipped` / `warnings` and are never silently swallowed.
6. Paths are discovered only under operational `temp/`; clients **must not** pass arbitrary filesystem paths. All IO goes through **FsAdapter** (path-escape safe).

**Age / cutoff:**

- Activity timestamp = `updatedAt` if present, else `createdAt`.
- When `keepTerminalTasksDays > 0` and both timestamps are missing / unparseable, the record is **not** eligible (reported in `skipped`).
- When `keepTerminalTasksDays === 0`, missing timestamps are treated as immediately eligible.

**Return shape (preview & purge):**

```ts
{
  workspaceId,
  keepTerminalTasksDays,
  cutoff,                 // ISO cutoff used for age comparison
  candidates: [{
    kind: "task-group" | "orphan-delivery",
    taskId?, taskPath?, taskState?,
    deliveryPaths: string[],
    ageDays: number,
    reason: string,
  }],
  skipped: [{ path, reason }],
  warnings: string[],
  candidateTaskCount,
  candidateDeliveryCount,
  // purge only:
  purged?: { taskPaths: string[]; deliveryPaths: string[] },
  deletedCount?: number,
}
```

**Event** `retention.purged` (only after a purge that deleted ≥1 file):

```ts
{
  keepTerminalTasksDays, cutoff, deletedCount,
  taskPaths, deliveryPaths,
  candidateTaskCount, candidateDeliveryCount,
  warnings,
}
```

Suggested future knobs (not all implemented in MVP):

```yaml
operationalRetention:
  keepTerminalTasksDays: 30
  keepRejectedDeliveries: 5      # future finer delivery policy
  purgeQueuedCancelImmediately: true
  alwaysPersistAcceptedSummaryToBox: false
```

### 6.4 Cleanup triggers (product roadmap)

1. Explicit purge API — **MVP done** (`operationalRetention.preview` / `purge`).
2. After `accept` / `interrupt` / `cancel`, optional scheduled retention pass — **not in MVP**.
3. Service start + periodic scan (e.g. daily) — **not in MVP** (no machine timer).

---

## 7. Migration notes (semantic only)

One-shot cutover; no long-lived dual aliases.

| Legacy | New |
| --- | --- |
| `bx-*` | `cx-*` |
| `box.fm.owner` / `status` | **stripped on migrate**; collab chips from `node.collaboration` (raw Task + Session/Delivery pointers) |
| envelope `pending` / `taken` | task `queued` / `running` |
| `temp/.../reports/<boxId>.md` + `DeliveryReport` | **removed** — only `delivery` (`dl-`) on the task |
| `task.interrupt` | interrupt an active Task and stop its managed Session |
| `complete` / `stamp` | **retired** (no Node dual-write); review path is `task.accept` |
| honor-only A2A spawn | service **`A2APolicy`** `allow|ask|deny` gate |
| “workspace pointer” product term | **WorkspaceLane** on task; tent lives in-workspace at `.tent/` |

Active claims, pending tasks, and ready deliveries must migrate or block cutover. Other temp may be discarded after dry-run inventory.

---

## 8. Explicit non-goals

- Long-term dual-write of `owner` and `assignee`.
- Long-term dual entities `report` and `delivery`.
- Multiple concurrent active tasks on one box.
- Agent self-accept / self-review masquerading as independent review.
- Tent-hosted chat replacing official agent clients.
- Automatic model router (MVP).
- Adapters interpreting box trees or performing accept.

---

## 9. Acceptance checklist (for implementers / reviewers)

This B0 document is satisfied when later implementation matches:

1. Box/concept longevity vs task-as-attempt; box projects active task state only.
2. Full state machine including `waiting` for user input and A2A ask.
3. Task API surface above; CLI aliases do not redefine semantics.
4. **`A2APolicy`** `allow` / `ask` / `deny` enforced only in service at spawn/start; clients use `task.*` only.
5. Delivery policies (product terms: Review / Bypass / Agent Decide):
   - `review` always waits for non-submitter accept/reject;
   - `bypass` auto-integrates with audit;
   - `agent-decide` chooses **integrate vs request-review**, never pretends the executor is an independent reviewer, never self-`accept`.
6. Operational terminal data short-retained then cleaned; promotable to OKF concepts.
7. Runtime port remains **service-internal**; outside this contract’s external collaboration verbs.
8. Task holds `sessionId` reference only; active-task projections cannot be bypassed via `docs.write`.
9. Parallelism uses **`docs.fork`**; `ArtifactRef` is the structured deliverable association type.

---

## 10. Document control

| Field | Value |
| --- | --- |
| Contract id | B0 Task & Delivery Protocol |
| Tent box (dogfood) | `bx-nxxzcj` (migrates to `cx-…`) |
| Primary owner role | collaboration protocol |
| Depends on | concept & naming vocabulary; desktop architecture service write path |
| Supersedes for A2A spawn | honor-based spawn claims in `docs/plans/2026-07-03-a2a-authority.md` (peer/sub + targetBranch intent retained) |
| Next implementation batches | B8a model → B8b API → B8c A2A → B8d policies → B8e retention/migration → B8f skill/SPEC/UI |
