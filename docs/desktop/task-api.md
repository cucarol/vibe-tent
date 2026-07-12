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
assigneeKind: role | agentProfile
assignee: <role-name|profile-id>
dispatchedBy: user | <role>
sessionId: ss-…                  # optional until claim/start; **reference only**
manifestRef: …                   # honor-contract snapshot at dispatch
workspaceLane:                   # omit when tent has no Git/workspace lane (pure Tent task)
  workspace: …
  worktree: …
  branch: …
  targetBranch: …                # peer → mainline; sub → dispatcher role branch
deliveryPolicy: manual | bypass | agent-decide
wait:
  reason: user-input | a2a-approval | review | external
  summary: …
activeDeliveryId: dl-…           # optional
createdAt / updatedAt: …
prompt: |                        # immutable after dispatch
  …
```

#### WorkspaceLane (task) vs RuntimeWorkspace (runtime)

| Term | Lives on | Meaning |
| --- | --- | --- |
| **WorkspaceLane** | Task operational record | Collaboration Git lane: workspace root, role worktree, branch, targetBranch |
| **RuntimeWorkspace** | Machine-local session / AgentRuntime only | Process cwd and launch binding for a live `ss-` session |

Tasks **must not** embed RuntimeWorkspace, PIDs, resume tokens, or absolute path caches. Only `sessionId` may bind a task to a live session; the session row lives in the service data area (`agent-runtime.md`).

Do **not** use the legacy product phrase “workspace pointer” for either structure.

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

Chat-facing narrative remains the primary presentation; `delivery.summary` is the same text persisted for review—not a second story.

---

## 2. Task state machine

### 2.1 States

| state | Meaning | Occupies box (active)? |
| --- | --- | --- |
| `queued` | Dispatched; waiting claim / optional start | **yes** (blocks overlapping dispatch) |
| `running` | Claimed; executing | yes |
| `waiting` | Blocked on user input, A2A approval, or external event | yes |
| `delivered` | Delivery submitted; awaiting review (or auto-integrate path) | yes |
| `accepted` | Review accepted / integrated; occupation released | no (terminal) |
| `rejected` | Delivery rejected; default returns to rework | yes while reworking |
| `interrupted` | User/orchestrator stop without integrate | no (terminal) |
| `failed` | Unrecoverable failure | no (terminal; may be configured) |

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

running | waiting | delivered ──interrupt──► interrupted
adapter unrecoverable ──► failed | waiting(recoverable)
```

Rules:

- `cancel` is only valid in `queued`.
- `interrupt` is valid for `running | waiting | delivered` (and may apply to `queued` as an equivalent of cancel where UIs unify the verb).
- Default reject path is **rework**: `delivered → running` with review note, matching current “reject keeps occupation”.
- Adapter process events never write box frontmatter; the service maps them into `running | waiting | failed`.

### 2.3 Box projection

| Condition | `box.status` | `box.assignee` |
| --- | --- | --- |
| No active task; never completed | `todo` (or prior user-set non-doing value) | empty |
| Active task present | `doing` | task.assignee |
| Last terminal state `accepted`, no new task | `done` | empty |
| After `interrupt` / terminal `rejected` without rework | `todo` | empty |

**Forbidden:** UI or agents writing `assignee` / legacy `owner` in competition with the active task—including via ordinary **`docs.write`** / frontmatter body patches. While an active task occupies the box, service/core **must reject** competing writes to projected collaboration fields (`status` when service-owned as `doing`, `assignee`, legacy `owner`). Use Task API transitions only. Migration may synthesize a running task from orphan `owner` or force-idle before cutover.

### 2.4 Parallelism and `docs.fork`

- Default: second active task on the same box is rejected at dispatch (topology + active-task check).
- Parallelism: **`docs.fork(boxId | path)`** (canonical command) then `task.dispatch` on the fork root. Legacy CLI `tent fork` is an alias.
- `docs.fork` copies the concept/box subtree for parallel occupation; it does **not** start a task or session by itself.
- Multi-role orchestration: dispatch distinct child boxes; parent occupation follows existing ancestor/descendant mutual exclusion.

---

## 3. Task API

All mutations go through Local Tent Service → core. Logical verbs below; transport (HTTP / named pipe / in-proc) is an architecture concern.

**Canonical external command groups** for clients: **`task.*`** and **`docs.*`**.  
`AgentRuntimePort.*` is **service-internal only** (architecture §5). Clients never call the runtime port directly.

### 3.1 Commands

| API | Default callers | Effect |
| --- | --- | --- |
| `task.dispatch` | user; authorized orchestrator role | Create `queued` task + manifest snapshot. Does **not** start a session unless `startSession: true` and A2A allows. |
| `task.claim` | target role/session (or user on behalf) | `queued → running`; bind `sessionId` reference; project assignee |
| `task.startSession` | authorized orchestration / user | Resolve **machine-local AgentProfile**, enforce **A2APolicy**, then service calls **internal** `AgentRuntimePort` |
| `task.wait` | executing session / service | `running → waiting` with reason + summary |
| `task.resume` | user confirmation / external event | `waiting → running` |
| `task.deliver` | assignee | Create/update delivery; enter `delivered` (or auto-integrate path per policy) |
| `task.requestReview` | assignee | Explicit review queue (used when `agent-decide` chooses upgrade) |
| `task.accept` | user; authorized orchestrator **≠ deliverer** | Integrate commits if any → `accepted`; clear occupation |
| `task.reject` | same as accept | Reject delivery; default resume rework |
| `task.interrupt` | user; authorized orchestrator | No integrate; `interrupted`; clear occupation; keep git lane |
| `task.cancel` | user; `queued` only | Drop unclaimed task |
| `docs.fork` | user; authorized orchestration | Fork box/concept subtree for parallel work (see §2.4); not a task transition |
| `proposal.submit` / `proposal.resolve` | existing semantics | **Separate** from delivery review |

### 3.2 Queries and events

- `task.get` / `task.list({ boxId, role, state })`
- `delivery.get` / `delivery.list`
- `session.get` / `session.list` (projections; no secrets/tokens in client payloads)
- `box.projection` → `{ status, assignee, activeTaskId }`
- `subscribe` (via common **EventEnvelope** — architecture §5.2): `task.state`, `delivery.updated`, `session.state`, `a2a.ask`, plus document events `concept.changed` / `concept.removed` from the docs group

**No** separate `box.changed` event channel. Concept identity changes use `concept.*` only.

### 3.3 CLI compatibility aliases

| Legacy CLI | Canonical API |
| --- | --- |
| `tent dispatch` | `task.dispatch` |
| `tent task-ack` | `task.claim` |
| `tent task-cancel` | `task.cancel` |
| `tent report` | `task.deliver` |
| `tent complete` / `tent stamp` | `task.accept` |
| `tent force-release` | `task.interrupt` |
| `tent fork` | `docs.fork` |
| `tent propose` | `proposal.submit` |
| `tent status` | aggregate query |

Aliases may remain for dogfood; SPEC and skills use canonical names.

### 3.4 Decoupling from runtime

```text
Task API (external, collaboration)     AgentRuntimePort (service-internal execution)
──────────────────────────────────     ────────────────────────────────────────────
task.dispatch / claim / wait           startSession / resumeSession / stopSession
task.deliver / accept / interrupt      process / session events only
docs.fork + box occupation & review    no box-tree writes; no client exposure
```

Agents submit task targets (role / **AgentProfile** id / capability). They never read provider credentials. The service resolves authorized machine-local profiles and starts adapters **after** A2A.

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
3. user caller → allow (user is root authority)
4. role caller → load role.a2aPolicy from .tent/roles.json (default deny);
   ignore client-supplied a2aPolicy; only trusted a2aPolicyOverride (internal/harness)
5. allow → target AgentProfile ∈ allowedProfiles / auth table → internal AgentRuntimePort.startSession
6. ask  → enqueue a2a.ask; task.wait; do not spawn
7. deny → return A2A_DENIED; leave no half-started process state
```

**Prohibited:** using skill text, RULES.md, or honor manifest alone as spawn authorization; trusting ordinary RPC `a2aPolicy` to raise authority.
**Orthogonal:** manifest readable/writable remains an honor contract for file edits after claim; it does not authorize process start.  
**Clients** call `task.startSession` (or dispatch with `startSession: true`); they never call `AgentRuntimePort` directly.
**Roles** may store `a2aPolicy` only — never provider secrets or tokens.

### 4.4 Self-accept ban

- `task.accept` actor **must not** equal the delivery submitter role.
- An authorized orchestrator may accept deliveries it dispatched (sub chain) subject to service policy; peer deliveries default to user final accept unless explicitly delegated.
- Recording `review.by = submitter` is a hard error.

### 4.5 Peer vs sub (hardened)

| | Peer | Sub (`asSub: true`) |
| --- | --- | --- |
| Target | first-class role or **AgentProfile** | tool-like helper of dispatcher |
| `targetBranch` | workspace mainline (e.g. `main`) | dispatcher role branch |
| Default accept authority | user (or user-delegated orchestrator) | dispatcher role (still not self) |
| **WorkspaceLane** | optional (pure Tent tasks legal—no code lane) | required (dispatch rejected without lane) |

---

## 5. Delivery policies: `manual` / `bypass` / `agent-decide`

### 5.1 Definitions

| Policy | Behavior |
| --- | --- |
| `manual` | After `deliver`, task stays `delivered` until human/authorized review `accept` or `reject` |
| `bypass` | After `deliver`, service **automatically** integrates and `accept`s, still writing a full delivery audit record |
| `agent-decide` | Executing agent chooses, at deliver time, either **direct integrate** or **upgrade to review**—it does **not** impersonate an independent reviewer |

MVP default for tent/box/task inheritance: **`manual`**.

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
| `request-review` | Identical to `manual`: task → `delivered` / delivery `ready`; only a non-submitter may `accept`/`reject`. Equivalent explicit call: `task.requestReview`. |

Hard rules:

1. If `deliveryPolicy=manual` and caller passes `decision=integrate` → error `POLICY_FORBIDS_AUTO_INTEGRATE`.
2. If `deliveryPolicy=bypass` → ignore `decision`; always attempt auto-integrate; audit `integrationMode: bypass-auto`.
3. If `deliveryPolicy=agent-decide` and `decision` missing/invalid → error `DECISION_REQUIRED`.
4. **Never** allow the deliverer to call `task.accept` on its own delivery, including under `agent-decide`. Auto-integrate is a policy action, not self-review.
5. All integrates (manual accept, bypass, agent-decided) keep git commits for rollback; accept/delivery records list commit SHAs.
6. Ordinary agents must not grant themselves `bypass` on dispatch; service rejects unauthorized policy elevation. Prefer user or `allow`-class orchestrator for `bypass`.

### 5.3 Policy placement

- Tent setting `defaultDeliveryPolicy` (MVP: `manual`).
- Box may override default for its tasks.
- `task.dispatch` may set per-task policy within caller authority.

---

## 6. Operational retention

### 6.1 Classes

| Class | Examples | Retention |
| --- | --- | --- |
| Collaboration facts | box body conclusions, artifactRefs, accepted commit pointers | durable until user deletes |
| Active operational | active task, ready delivery, waiting records | until terminal |
| Terminal operational | accepted / interrupted / failed tasks, old deliveries | **short heat retention** then purge (suggested **30 days**, configurable) |
| Local runtime only | PID, session registry rows, resume tokens, absolute worktree paths, AgentProfile paths | clear with process / stay machine-local; never ship in repo |
| Rebuildable | relay prompt copies, redundant manifest dumps | drop after terminal; rebuild from task fields if needed |

### 6.2 Promotion to OKF

- Terminal payloads are **not** a permanent audit product.
- Conclusions that matter long-term must be written into box/concept body, or **promoted** by the user (e.g. left-click elevate handoff/delivery summary → OKF concept).
- Do not assume temp/operational files survive forever.

### 6.3 Cleanup triggers

1. After `accept` / `interrupt` / `cancel`, schedule a retention pass.
2. Service start + periodic scan (e.g. daily).
3. Explicit purge API (successor of blunt `clean-temp`); must refuse to delete non-terminal active work.

Suggested knobs:

```yaml
operationalRetention:
  keepTerminalTasksDays: 30
  keepRejectedDeliveries: 5
  purgeQueuedCancelImmediately: true
  alwaysPersistAcceptedSummaryToBox: false
```

---

## 7. Migration notes (semantic only)

One-shot cutover; no long-lived dual aliases.

| Legacy | New |
| --- | --- |
| `bx-*` | `cx-*` |
| `box.fm.owner` | active task `assignee` projection (synthesize running task or idle first) |
| envelope `pending` / `taken` | task `queued` / `running` |
| `temp/.../reports/<boxId>.md` | `delivery` (`dl-`) on the task |
| `force-release` | `interrupt` |
| `complete` / `stamp` | `accept` |
| honor-only A2A spawn | service **`A2APolicy`** `allow|ask|deny` gate |
| “workspace pointer” product term | **WorkspaceLane** on task; tent lives in-workspace at `.tent/` |

Active claims, pending tasks, and ready reports must migrate or block cutover. Other temp may be discarded after dry-run inventory.

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
5. Delivery policies:
   - `manual` always waits for non-submitter review;
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
