# B0 · AgentRuntime Adapter Contract

Status: **frozen contract** for Local Service → agent adapter execution boundary.  
Scope: **service-internal** `AgentRuntimePort`, provider adapters, session registry, process supervision, push/pull host modes, first prototype selection, and per-agent verification discipline.  
Non-scope: Task/Delivery state machine (`docs/desktop/task-api.md`), service process topology and sole-mutation rules (`docs/desktop/architecture.md`), concept/box document model (`docs/desktop/concept-model.md`). Those contracts own collaboration semantics and stack topology; this document must not invert them.

This document freezes **who starts processes**, **what events adapters may emit**, and **how provider differences are handled**. Implementation batches B9a+ implement this contract; they do not reopen it without an explicit revision.

**Visibility:** `AgentRuntimePort.*` is **not** a client command surface. Desktop, CLI, and MCP call only `task.*` / `docs.*`. The service maps authorized `task.startSession` (or dispatch with `startSession: true`) onto this port after **A2APolicy** evaluation.

Canonical English names are API/schema truth. UI may localize labels via i18n; persisted enums never use localized values.

---

## 1. Separation of concerns

```text
Task API (external collaboration)        AgentRuntimePort (service-internal execution)
────────────────────────────────         ────────────────────────────────────────────
task.dispatch / claim / wait / resume    startSession / resumeSession / stopSession
task.deliver / accept / reject / interrupt   probe / subscribe(RuntimeEvent)
docs.fork + box occupation, review       process & session lifecycle only
A2APolicy allow|ask|deny (policy)        spawn only after service already authorized
```

### Hard rules

1. **Task API owns collaboration (external).** Adapters never implement box occupancy, claim topology, dispatch, deliver, accept, reject, or proposal review.
2. **AgentRuntimePort owns execution (internal).** Start, resume, stop, probe, and structured **runtime** events only. No chat message API. **Not** exposed to Desktop/CLI/MCP as a command group.
3. **Service maps events → task states.** Adapter process events never write concept/box frontmatter. Mapping into `running | waiting | failed` and binding optional **`task.sessionId`** (reference only) is a service responsibility aligned with the Task API contract.
4. **A2A hard gate lives only in the service** (`A2APolicy` = `allow | ask | deny` per Task API). When the runtime port is invoked, authorization is already decided. Adapters must not re-interpret skill text, RULES.md, or honor manifests as spawn authority.
5. **Adapters are injected by Local Service.** They must not open a second mutation path into tent operational files or core lifecycle modules (architecture: sole service mutation entry).

Forbidden reverse edges:

- Adapter / desktop / skill script → direct `spawn` of provider CLIs bypassing the service.
- Adapter → Task API verbs or box-tree writes.
- Task API / core → provider SDKs, credentials, or process supervision details.
- Any product path that routes “agent A’s chat reply” into “agent B’s conversation” (chat router).

---

## 2. Identity model: role ≠ session ≠ profile ≠ adapter

| Canonical | Space | Meaning | Durable? |
| --- | --- | --- | --- |
| **role** | project registry (under `.tent/`) | Stable collaboration identity: prompt, **A2APolicy**, WorkspaceLane relationship | yes (project) |
| **AgentProfile** | **machine-local** service config | How to launch a class of agent: binary/app path, default argv templates, auth reference, capability flags | yes on machine; **not** in workspace git |
| **session** (`ss-`) | **machine-local** session registry | One recoverable runtime instance bound to a profile (+ optional role), process handle, and **RuntimeWorkspace** | replaceable; machine-local |
| **ProviderAdapter** | `packages/adapters` (or staged `src/adapters`) | Provider-specific launch/resume/stop/probe/event normalization | code artifact |
| **ProcessSupervisor** | Local Service | Uniform child-process lifecycle; does **not** understand boxes | service component |
| **task.sessionId** | operational task record only | Optional **reference** of a task attempt to a live/external session—**no** session row fields | operational (id only) |

### WorkspaceLane vs RuntimeWorkspace

| Term | Owner | Meaning |
| --- | --- | --- |
| **WorkspaceLane** | Task / collaboration | Git lane on the task: workspace, worktree, branch, targetBranch |
| **RuntimeWorkspace** | This contract / session registry | Process launch binding: cwd, env handles, absolute path caches for a live session |

Do **not** call either a “workspace pointer.” Lane is prepared by service/core **before** internal `startSession`. RuntimeWorkspace may mirror the lane’s worktree path but is not stored on the task.

### Invariants

1. **role ≠ session.** Changing or replacing a session does not change role identity, queue membership, or box occupation. Role may cache `currentSessionId` as a projection only.
2. **AgentProfile ≠ role.** Temporary one-shot agents may use a profile without entering the durable role registry (Task API already allows `assigneeKind: agentProfile`). **AgentProfile** configs never enter workspace git.
3. **ProviderAdapter ≠ Generic “supports all CLIs”.** A shared process skeleton is allowed; each shippable provider still needs its own adapter class (or explicit profile + verified capability set) and verification checklist.
4. **Legacy `role.cli` is input, not runtime.** Existing `RoleCliConfig { command, resume? }` and SPEC “never spawn” hints are **migration sources for AgentProfile drafts**. They are not a second supervisor and must not be invoked by skills as spawn authority.
5. **WorkspaceLane is orthogonal to session.** Role worktree/branch (`ensureRoleWorkspace`) is prepared by service/core **before** internal `startSession`. Replacing a session reuses the same lane conventions unless the task explicitly targets another lane; the new session gets a fresh RuntimeWorkspace binding.
6. **Task stores `sessionId` only.** Session rows, PIDs, resume tokens, and RuntimeWorkspace absolute paths stay machine-local.

---

## 3. Credentials and machine-local data

| Data | Location | Forbidden |
| --- | --- | --- |
| Provider API keys, OAuth tokens, CLI auth blobs | OS credential store / machine-local service data area only | Workspace files, box bodies, git history, tent operational envelopes |
| Session resume tokens, PIDs, absolute worktree caches | Session registry under service data area (e.g. `%APPDATA%/Tent/sessions/`) | Shipping with workspace copy; treating as collaboration facts |
| **AgentProfile** binary paths | Machine-local config | Assuming identical absolute paths on another machine; writing profiles into `.tent/` / git |
| RuntimeWorkspace absolute paths | Session registry | Treating as collaboration facts on the task |
| Capability / support matrix documentation | Repo docs (honest, versioned) | Claiming support without checklist pass |

Rules:

1. Agents and adapters **never** read raw provider credentials from tent files. Service injects auth via OS-backed slots or provider-native login already present on the machine.
2. `StartSessionRequest.env` must not carry secret plaintext intended for persistence; any env injection is process-scoped and redacted from logs.
3. Copying a workspace must preserve collaboration semantics **without** requiring old PIDs, credentials, session rows, or absolute session paths (architecture data-placement rule). Task files may retain a stale `sessionId` string that no longer resolves.
4. Logs and `session.stdout_tail` diagnostics must be treated as potentially sensitive; default UI must not render them as product chat.

---

## 4. AgentRuntimePort (logical IDL · **service-internal**)

Transport between **service components** is an architecture concern (B2: loopback / in-proc). This port is **not** part of the external client command surface. Field names below are English canonical.

```ts
/** Service-internal only — clients use task.startSession / task.* instead. */
interface AgentRuntimePort {
  /** Create and start a session. Caller (service) has already passed A2APolicy. */
  startSession(req: StartSessionRequest): Promise<SessionHandle>;

  /** Resume using machine-local resume token / provider-specific id. */
  resumeSession(req: ResumeSessionRequest): Promise<SessionHandle>;

  stopSession(
    sessionId: string,
    reason: "user" | "interrupt" | "shutdown"
  ): Promise<void>;

  /** Alive? resume-capable? */
  probe(sessionId: string): Promise<SessionProbe>;

  /** Subscribe to runtime events (not chat token streams). */
  subscribe(sessionId: string, sink: (ev: RuntimeEvent) => void): Unsubscribe;
}

interface StartSessionRequest {
  sessionId: string; // service-preallocated ss-
  profileId: string; // machine-local AgentProfile id
  roleName?: string;
  /** Collaboration lane already prepared by service/core (from task.workspaceLane). */
  workspaceLane?: {
    workspace: string;
    worktree: string;
    branch: string;
  };
  /**
   * RuntimeWorkspace for this process — machine-local launch binding.
   * Usually cwd mirrors workspaceLane.worktree absolute path; not a task field.
   */
  runtimeWorkspace?: {
    cwd: string;
    // env handles / absolute path caches stay in session registry
  };
  /** Initial text for the agent (relay prompt / task pointer). Not a multi-turn chat API. */
  bootstrapPrompt?: string;
  cwd?: string; // alias of runtimeWorkspace.cwd when set; worktree absolute path from core
  env?: Record<string, string>; // no secret plaintext for disk
}

type RuntimeEvent =
  | { type: "session.starting"; sessionId: string }
  | { type: "session.live"; sessionId: string; pid?: number }
  | { type: "session.waiting_user"; sessionId: string; summary: string }
  | { type: "session.exited"; sessionId: string; exitCode: number | null }
  | { type: "session.failed"; sessionId: string; error: string }
  | { type: "session.stdout_tail"; sessionId: string; text: string }; // optional diagnostics only
```

Client-visible session projections may be wrapped in the shared **EventEnvelope** (architecture §5.2) as `session.state` events. Adapters emit `RuntimeEvent` only to the service; they do not publish concept or task events.

### Explicitly outside the port

- External client RPCs (`task.*` / `docs.*` are the client surface; this port is not)
- `sendChatMessage` / assistant token streaming / cross-session message routing
- `dispatch` / `claim` / `deliver` / `accept` / box frontmatter writes
- Model auto-selection or “pick the best agent” router
- Git integrate / worktree creation (service calls core before start)
- **A2APolicy** evaluation (already completed before port entry)

### Event → task mapping (service-owned)

| RuntimeEvent | Typical task projection (Task API) |
| --- | --- |
| `session.live` | keep/ensure `running` when bound; bind **`task.sessionId`** (id reference only) |
| `session.waiting_user` | `task.wait` with reason + summary (user-input / external) |
| `session.exited` (expected) | no auto-accept; collaboration ends via deliver/interrupt |
| `session.failed` / dead probe unrecoverable | `failed` or recoverable `waiting` per service policy |
| `session.stdout_tail` | diagnostics only; **never** product chat transcript |

Adapters do not choose these mappings; the service does, consistent with Task API §2. Session row / PID / token updates never land in concept frontmatter or task YAML beyond `sessionId`.

---

## 5. ProviderAdapter layering

```ts
interface ProviderAdapter {
  readonly id: string; // e.g. "codex-cli"
  readonly displayNameKey: string; // i18n key only
  capabilities(): ProviderCapabilities;
  resolveLaunch(plan: LaunchPlan): ResolvedLaunch;
  parseResumeToken?(raw: string): ResumeToken;
  mapExit(code: number | null, signal?: string): RuntimeEvent;
  discoverSessions?(): Promise<DiscoveredSession[]>;
}

interface ProviderCapabilities {
  canSpawn: boolean; // false → pull-host only
  canResume: boolean;
  canStopGraceful: boolean;
  needsTty: boolean;
  supportsWorktreeCwd: boolean;
  authModel: "none" | "env" | "os-keychain" | "external-app";
  observeLevel: "process" | "log" | "structured";
}
```

### Package layout (target)

```text
packages/adapters/
  codex/           # first push prototype
  claude-code/     # later, after its own checklist
  generic-cli/     # supervisor skeleton + user templates (not “supports everything”)
  pull-host/       # cannot spawn: register external session metadata + jump/relay only
```

Dependency rule (architecture): `adapters` depend on runtime port types only—**not** core lifecycle modules.

### Generic CLI adapter limits

- Implements spawn skeleton + user-configured command/args/resume templates + exit mapping.
- Template variables are a **whitelist** (e.g. `{worktree}`, `{branch}`, `{relay_file}`)—no free-form shell expansion of tent secrets.
- **Must not** auto-detect “this is Codex/Claude” and upgrade capabilities.
- Without resume support: each start creates a new session; UI must not pretend continuity.

---

## 6. SessionRegistry (machine-local)

Suggested on-disk shape (final path fixed with architecture B2):

```yaml
id: ss-…
profileId: codex-default          # machine-local AgentProfile
adapterId: codex-cli
roleName: … # optional
state: live # starting | live | waiting-user | stopped | failed | external
pid: 12345 # omit for pull/external
resumeToken: … # provider-specific; OS-protect if sensitive
runtimeWorkspace:
  cwd: …                          # absolute; not stored on task
workspace: …                      # mounted workspace key
createdAt / updatedAt: …
lastTaskId: tk-… # optional projection
```

Rules:

1. **Workspace copy does not carry** session files (including RuntimeWorkspace absolute paths).
2. On service start, `probe` all non-terminal sessions: dead PID and not resume-capable → `failed`/`stopped`; resume-capable → keep metadata until explicit resume.
3. Concurrent live sessions must not cross-contaminate cwd/env; stop validates `sessionId` (+ workspace id when multi-mount).
4. `external` sessions (pull-host) have no supervised PID; state advances primarily via Task API claim/deliver, not process exit.
5. Tasks that referenced a purged session keep only a dangling `sessionId` string until rebound—never a partial session row in operational task YAML.

---

## 7. ProcessSupervisor boundary

### Responsible for

- Creating child processes (Windows: `windowsHide`; ConPTY when `needsTty`)
- Recording pid, start time, exit code/signal
- Graceful stop via adapter-provided signal/command → timeout → force kill (Job Object / taskkill on Windows)
- Optional stdout/stderr ring buffer for diagnostics (default: not product UI chat)
- Crash callbacks → `RuntimeEvent` → service

### Not responsible for

- Deciding whether the agent “finished the task” (that is deliver/claim/review)
- Creating git worktrees or integrating commits
- A2A allow/ask/deny decisions
- Interpreting box trees or manifests

### Lifecycle vs Desktop window

| Event | Push-mode child processes | Pull/external sessions |
| --- | --- | --- |
| Close main window | **Continue** (architecture: window ≠ stop tasks) | unchanged |
| Stop Local Service | **Default: stop** children this service started | no supervised children; metadata may remain until purge |
| Detach policy | Optional only for `authModel: external-app` / documented pull-host cases—not default for Codex prototype | N/A |

---

## 8. Push vs Pull host modes

| Mode | When | Behavior |
| --- | --- | --- |
| **Push** | `capabilities.canSpawn === true` and **A2APolicy** allows (or user grants `ask`) | Service calls **internal** `AgentRuntimePort.startSession`; bootstrapPrompt delivered to process (prefer stdin/temp file over giant Windows cmdline) |
| **Pull** | GUI hosts, no CLI, `deny` policy, or user-woken existing session | Write task envelope + relay prompt only; session may be `external`; Tent shows waiting/claim; optional deep-link/jump to official client—no fake spawn |

MVP requirement:

- **One** push-mode provider prototype (Codex CLI—§10).
- Pull path remains first-class (current dogfood: user wake + claim).
- Not every role must be spawnable.

`task.dispatch` does **not** start a session by default. Session start is explicit external **`task.startSession`** / `startSession: true` with A2A, which the service maps to this port—clients never call the port themselves.

---

## 9. No chat router; no false capability equality

### Product prohibitions

1. **No unified conversation product** that aggregates or relays multi-agent chat inside Tent.
2. **No automatic model/agent router** that picks providers based on “who is smarter.”
3. **No claiming “supports agent X”** in UI, docs, or release notes without that provider’s verification checklist recorded as passed on a real machine.
4. **No** treating `session.stdout_tail` or log tails as assistant messages for end users.
5. When dialogue is required, **jump to the official client / terminal**; Tent shows lifecycle and task state.

### Per-agent verification discipline

Every provider ships with:

1. Filled **general checklist** (G\*) results for the target OS.
2. Filled **provider-specific checklist** (C\*, L\*, D\*, …).
3. Recorded binary/app version, sample argv, failure modes, and resume model honesty (`canResume=false` when unproven).

Merging a provider adapter without checklist evidence is a contract violation.

---

## 10. First prototype: Codex CLI push

### Selection (normative for B9b)

| Decision | Value |
| --- | --- |
| First **push** prototype | **Codex CLI** process adapter |
| Pre-prototype skeleton | **B9a** mock adapter + supervisor + registry (no real Codex required) |
| Explicit non-prototypes | Claude Desktop (pull), “universal CLI”, multi-provider ACP matrix, chat relay |

Rationale (repo-local, not network research):

1. Existing SPEC / roles examples already describe Codex-shaped `cli.command` + `cli.resume` hints—cheap migration into **AgentProfile**.
2. Matches current dogfood: role worktree + `tent` CLI claim/deliver from an agent process.
3. Clear process boundary for supervisor validation without GUI automation.
4. Parent desktop goal treats Codex as a primary external agent surface.

### Prototype success criteria

1. Service (or B9a harness later attached to service) can `startSession` Codex with cwd = role worktree.
2. `probe` / `stopSession` satisfy general checklist G3–G5.
3. Manual path works: dispatch → startSession (A2A allow) → agent claim → file edits + commit → deliver → (user) accept; Tent observes lifecycle only—no chat UI.
4. After service restart: session metadata listable; if resume unavailable, state is honestly `failed`/`stopped`, not zombie `live`.
5. A2A `deny` yields **zero** spawn (unit/integration test).
6. No chat-router code path in adapters or service runtime layer.

### Explicit unknowns for real-machine spike (must resolve in B9b, not invent here)

These are **known unknowns**. Spike results update adapter capabilities and runbooks; they do **not** reopen this boundary contract.

| ID | Unknown | Why it matters | Spike outcome must set |
| --- | --- | --- | --- |
| U-C1 | Actual headless/non-interactive argv for installed Codex versions | Launch plan templates | `resolveLaunch` + version probe |
| U-C2 | Whether a TTY/ConPTY is required | Supervisor path | `needsTty` |
| U-C3 | Where resume identity lives (file, session id, terminal-only) | ResumeToken design | `canResume` + parseResumeToken |
| U-C4 | Global single-instance lock across concurrent sessions | Multi-role concurrency | serialize starts or reject second live |
| U-C5 | Windows cmdline length / escaping for bootstrapPrompt | Delivery channel | stdin vs temp file vs argv |
| U-C6 | Interaction with co-located `tent` CLI attach-to-service | Agent-side claim/deliver | documented attach requirements |
| U-C7 | Upgrade breakage surface across Codex major versions | Support matrix honesty | probe error messages + version pin guidance |
| U-C8 | Job Object / orphan behavior on abnormal service kill | Shutdown hooks | supervisor kill policy verification |

If the spike proves Codex cannot be a reliable push host, the product **falls back to pull** for that profile and documents `canSpawn=false`. It must **not** invent GUI click-automation as a substitute under this contract.

---

## 11. Verification checklists (normative templates)

> **Rule:** unchecked items mean “not supported,” not “probably fine.”

### 11.1 General (all providers)

| # | Item | Pass criteria |
| --- | --- | --- |
| G1 | Install/version probe | Detect presence and version string |
| G2 | Working directory | Writes land in role worktree, not wrong cwd |
| G3 | Start errors | Distinguish missing binary / auth failure / bad argv |
| G4 | Stop | Graceful exit; timeout force-kill; no zombies |
| G5 | Crash | Kill process → probe dead; service maps failed/waiting |
| G6 | Resume | Cross service restart if claimed; else `canResume=false` |
| G7 | Task binding | `task.sessionId` reference set only; interrupt stops session and releases occupation via Task API |
| G8 | Credentials | No secrets written into tent/workspace; logs redacted |
| G9 | Concurrency | Two live sessions do not cross cwd/env; lanes isolated |
| G10 | Non-router | No product path relays chat between agents |
| G11 | Windows | Spaces in paths, Unicode role slug via core paths, `windowsHide`, kill APIs |
| G12 | Observability | Tent shows lifecycle; dialogue in official UI/terminal |

### 11.2 Codex CLI (first prototype)

| # | Item | Notes |
| --- | --- | --- |
| C1 | command/resume vs legacy SPEC examples | Record real argv per version |
| C2 | Headless stability | Sets `needsTty` if required |
| C3 | Resume token location | Drives ResumeToken |
| C4 | Multi-session / global lock | Queue or reject |
| C5 | Coexistence with `tent` CLI | Service attach from agent |
| C6 | bootstrapPrompt delivery | Prefer non-argv channels on Windows |
| C7 | Upgrade breakage | Readable probe failures |

### 11.3 Claude Code CLI (later)

| # | Item |
| --- | --- |
| L1 | Entry + auth model classification |
| L2 | cwd / project trust prompts under headless |
| L3 | resume/continue vs long-lived role lane |
| L4 | structured vs process/log observeLevel |
| L5 | Conflict with Claude Desktop backend state |

### 11.4 Claude Desktop / GUI hosts

| # | Item |
| --- | --- |
| D1 | Default **pull**; `canSpawn=false` |
| D2 | Deep-link/activate is best-effort jump only |
| D3 | Minimal observeLevel; state from task claim/deliver |
| D4 | contextCard drag is desktop shell concern—not a second adapter payload format |

### 11.5 Other CLIs (Grok, etc.)

| # | Item |
| --- | --- |
| X1 | Stable automatable CLI exists? else pull only |
| X2 | Dogfood file-inbox success ≠ RuntimePort support |
| X3 | No fake push adapter for schedule pressure |

**Desktop MVP note:** `grok-acp` is the first real push provider (ACP stdio). Setup, machine-local profile, env key rules, and permission policy: `docs/desktop/grok-acp-provider.md`. `fake-cli` remains test/harness only.

---

## 12. Implementation batches (B9)

Aligned with architecture delivery order; collaboration B8 supplies task mapping and A2A gate.

| Batch | Name | Depends on | Outcome |
| --- | --- | --- | --- |
| **B9-0** | Runtime contract freeze | B0 architecture + Task API | **This document** |
| **B9a** | Supervisor + Registry + Mock | B2 service skeleton (harness allowed first) | mock adapter tests; disk sessions; shutdown hooks |
| **B9b** | **Codex CLI prototype** | B9a; A2A deny-default at least | C\* spike record; start/stop/probe |
| **B9c** | Task binding | B8b/c | claim/startSession/interrupt end-to-end |
| **B9d** | Pull-host normalization | B9a | external session type; relay unchanged; jump hooks |
| **B9e** | Claude Code specialty | B9b stable | L\* + adapter |
| **B9f** | Generic CLI profile | B9a | template whitelist; honest no-resume |
| **B9g** | Further providers | per agent | new checklist + version matrix |
| **B9-docs** | SPEC §Runtime | B9-0+ | Replace “never spawn / role≈session” product wording; service is sole spawn authority |

```text
B2 ── B9a ──┬── B9b ── B9e/g
            ├── B9d
            └── B9f
B8 ─────────── feeds B9c (task binding + A2A)
```

---

## 13. Interface freeze with peer contracts

| Peer contract | This document requires | This document supplies |
| --- | --- | --- |
| **architecture.md** | Sole service mutation; adapters under service; close window ≠ stop; machine-local credentials; external cmds = `task.*`/`docs.*` | **Internal** `AgentRuntimePort` shape; RuntimeWorkspace; supervisor/session placement; B9 batching |
| **task-api.md** | Task states, **A2APolicy**, `task.sessionId` reference only, no adapter accept, WorkspaceLane on task | Runtime events only; start after gate; push/pull modes |
| **concept-model.md** | No operational `ss-` as OKF concepts; no `box.changed`; active-task docs.write guard | Sessions stay machine-local / operational |

**Conflict rule:** If a proposal reintroduces chat routing, honor-only spawn, dual supervisors, credentials-in-git, client-exposed `AgentRuntimePort`, or “one generic adapter supports all agents,” parent product goal and these B0 contracts win; escalate to the product owner rather than silently forking.

---

## 14. Non-goals

- Multi-agent conversation rooms, message buses, or automatic model routers
- Replacing official agent clients’ full UX
- MVP claim of “supports all CLIs”
- GUI accessibility click-driving of Claude Desktop as a push host
- Merging `FsAdapter` and agent adapters into one type
- Implementing Task lifecycle inside adapters
- Network research as a substitute for on-machine checklist evidence
- Changing peer B0 documents from this workstream

---

## 15. Contract checklist (acceptance map)

| Requirement | Section |
| --- | --- |
| Task API = external collaboration; AgentRuntimePort = **internal** start/resume/stop + runtime events | §1, §4 |
| role / session / **AgentProfile** / ProviderAdapter separation | §2 |
| WorkspaceLane (task) ≠ RuntimeWorkspace (session); no “workspace pointer” | §2 |
| Task holds `sessionId` only; rows/tokens/PIDs machine-local | §2, §3, §6 |
| Credentials and resume tokens only on local service / OS store | §3 |
| No chat router; no false cross-agent capability equality; per-agent checklists | §9, §11 |
| First push prototype = Codex CLI; B9a mock before B9b; explicit spike unknowns | §10 |
| Push vs pull; dispatch does not imply spawn; clients use `task.startSession` | §8 |
| Service stop default kills push children; window close does not | §7 |
| Adapters never write box occupancy or accept deliveries | §1, §4, §14 |

---

## Document control

| Field | Value |
| --- | --- |
| Contract id | B0 AgentRuntime Adapter |
| Tent box (dogfood) | `bx-wbedaf` (migrates to `cx-…`) |
| Primary owner role | ACP / agent runtime adapters |
| Depends on | `docs/desktop/architecture.md`, `docs/desktop/task-api.md` (read-only peers) |
| Supersedes for product intent | “Tent never spawns” as permanent architecture; “role ≈ permanent agent session” wording—replaced by service-gated spawn + role≠session |
| Next implementation step after acceptance | B9a mock supervisor + SessionRegistry harness, then B9b Codex spike against §10 unknowns |
