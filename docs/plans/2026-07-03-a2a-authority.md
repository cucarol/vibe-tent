# A2A Delegated Authority — Design And SPEC Revision Draft

Status: awaiting user approval · Target: 0.1.x (folded into first release) · Owner: 规划型老大 · Box: bx-vy2h0t

Agents gain two delegated abilities: dispatching work to other roles and
accepting deliveries. Authority stays a chain — user accepts the
orchestrator, the orchestrator accepts its delegates — so no role ever
accepts its own delivery. Authorization is honor-based, written in the
role prompt or `RULES.md`, consistent with the manifest contract. No
mandate framework.

## 1. Dual Mode

One primitive set, two parameter choices:

| | Peer mode (default) | Sub mode (`--as-sub`) |
|---|---|---|
| Delegate is | a registered first-class role | a tool-like helper of the dispatcher |
| Accepted by | user | dispatching role |
| Integrates into | `main` (current default) | the dispatcher's own branch |
| Responsibility | delegate owns its delivery | dispatcher owns the result |

Sub-mode integration maps the authority chain onto branch structure:
user keeps the final gate on `main` because sub work reaches `main` only
inside the dispatcher's own accepted delivery.

## 2. Dispatch Halves And The Mailbox

Dispatch has two halves. The **state half** (owner, manifest, envelope,
worktree) is identical to today's dispatch and may be performed by an
authorized role. The **delivery half** depends on the target's host:

- Host with a `cli` config in `.tent/roles.json`: the orchestrator
  spawns the process directly (push).
- Host without one (GUI session): delivery degrades to pull. The
  envelope under `temp/<role>/tasks/` is the inbox; the user wakes the
  target agent, which acknowledges the task on pickup.

The pending-delivery triage entry, relay-prompt copy action, and
notification counting already shipped (bx-93txhd). This design adds the
durable lifecycle underneath them.

## 3. SPEC Amendments (Draft Text)

### Section 4 — Roles, Claims, And Dispatch

- A role entry in `.tent/roles.json` MAY carry a `cli` host config:
  `{ "cli": { "command": "...", "resume": "..." } }`. It tells an
  orchestrating agent how to start or resume that role's session. Tent
  itself never spawns processes.
- Dispatch MAY be initiated by a role the user has authorized in that
  role's prompt or `RULES.md`. The task envelope records `dispatchedBy`.
- The task envelope keeps an immutable prompt body; its frontmatter
  gains `status: pending -> taken`. `tent task-ack <taskPath>` marks
  consumption (precedent: proposal state transitions on an otherwise
  immutable document).
- `tent dispatch --as-sub` sets the task's `targetBranch` to the
  dispatcher's own branch instead of the workspace default.

### Section 5 — Completion And Interruption

- Completion MAY be performed by an authorized role for boxes it
  dispatched (never for its own deliveries). The acceptance records
  `acceptedBy`.
- `tent complete --require-check "<command>"` runs the command in the
  integration workspace first; a non-zero exit aborts before any
  workspace or Tent mutation.

### Section 10 — UI Contract

- Agent-initiated dispatches appear as pending-delivery triage entries
  showing target role, box, and initiator, with a relay-prompt copy
  action; they count toward triage notifications and clear on `taken`.
  (Shipped in bx-93txhd; lifecycle source of truth moves from
  plugin-local acknowledgment to envelope status.)

## 4. Implementation Breakdown

**Batch A — core semantics** (box: A2A 核心语义):
envelope `status: pending -> taken` + `tent task-ack`; `dispatchedBy` /
`acceptedBy` attribution; `dispatch --as-sub` targetBranch rule;
reconcile the plugin's local acknowledgment store (bx-93txhd) to read
and write envelope status instead.

**Batch B — supporting rails** (box: A2A 配套):
`cli` host config schema + validation in the roles registry;
`tent complete --require-check`; sync `docs/SPEC.md` amendments and the
`tent-role` skill protocol (inbox check on wake, task-ack on pickup,
orchestrator manual: dispatch → spawn/wake → review → complete).

Batch A before B; SPEC text lands with Batch B once behavior exists.

## 5. Out Of Scope

MCP server wrapping of tent verbs (revisit when an external
orchestrator integrates); mandate/capability frameworks; CLI locale.

## 6. Rollout

User approves this draft → handoffs (already created under bx-vy2h0t)
are dispatched to 规划型老二 → dogfood on tent-dev: user dispatches the
orchestrator one parent box, orchestrator dispatches and wakes the
delegate, pre-reviews, user accepts once.
