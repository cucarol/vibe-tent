# Desktop Contract · Task, Session, And Delivery API

This document defines collaboration lifecycle semantics. Desktop, CLI, Skills,
and ACP adapters are clients of this contract; they do not create alternate
state machines.

## 1. Entities and authority

| Entity | Stable id | Purpose |
| --- | --- | --- |
| Node | `cx-…` | durable product context and knowledge |
| Task | `tk-…` | one work and review attempt over exact Nodes |
| Session | `ss-…` | temporary managed ACP execution binding |
| Delivery | `dl-…` | formal result submitted to the exact reviewer |
| TaskInput | `ti-…` | parent/user input scoped to one Task |
| DecisionRequest | `dr-…` | exact Session question to a frozen user or Role authority |

The Task envelope owns the immutable raw prompt, lifecycle authority, optional
`roleId`, exact `sessionId` when executing, and WorkspaceLane. Context Card v2
owns structured context and durable refs.
Node bodies provide durable context. Session state is runtime authority.
Delivery is review evidence. No one object substitutes for another.

Every Task persists exact `parentActor` as the sole parent responsibility and
review authority. Downstream executors cannot self-accept, rewrite that authority,
or elevate Role-to-user delivery policy.

## 2. Direct claim and dispatch contract

A durable Role creates and immediately claims its own execution Task:

```text
tent task claim --work-node <nodeId> [--work-node <nodeId> ...] \
  [--context-node <nodeId> ...] \
  --prompt <text>|- [--from-task <taskPath>]
```

This is one create-and-claim Service mutation, not dispatch. It has no target
or caller-authored authority fields. An explicit `--from-task` must be an active
claimed Task for the same Role. Otherwise Tent may continue the persisted
`parentActor` chain from a verified current Role execution context; missing
history falls back to the Role's user-facing root.

Dispatch is only downstream assignment. Its public target grammar is
`role:<roleId>|connection:<connectionId>`. CLI form:

```text
tent task dispatch --target role:<roleId>|connection:<connectionId> \
  --work-node <nodeId> [--work-node <nodeId> ...] \
  [--context-node <nodeId> ...] --prompt <text>|-
```

There is no positional source form and no alternate public Node selector. The
typed client carries mutually exclusive Role/Connection target fields plus
ordered work and context Node refs. Internal transport discriminants are not a
second user-facing target grammar.

Targets:

- `role:*` creates a queued durable Role handoff. It does not start managed ACP.
- `connection:*` snapshots one machine Agent Connection into a reserved Session,
  creates and claims the formal Task with that exact `sessionId` atomically,
  then starts the provider outside the lifecycle mutation.

The temporary Session remains execution state of the dispatched Task. Durable
responsibility and review authority remain with the persisted `parentActor` chain.

## 3. Exact Node occupation

Dispatch acquires every requested exact Node in the same workspace mutation:

- if any Node already has an active Task, dispatch creates nothing;
- successful dispatch occupies every requested Node;
- parent/child and sibling Nodes remain independently occupiable;
- structural move/archive/delete checks the actual affected source and target
  subtrees;
- occupation is derived from Task envelopes, never copied into Node files.

Active states are `queued`, `running`, `waiting`, and `delivered`. Terminal
`accepted`, `rejected`, `interrupted`, and `failed` release occupation.

## 4. Context Card

Context Card v2 persists:

- separate exact work/context Node ids and their frozen Node snapshots;
- optional `contextGeneration` written when an actual Session computes it.

The Task envelope, not the Card, persists the raw prompt, `parentActor`,
Role/Session binding, and optional WorkspaceLane.

Node id is authoritative; snapshot paths are refreshable hints. Referenced Nodes
are resolved before provider launch and fail loud when missing or invalid.

The stable managed prompt contains Task protocol, project instruction pointers,
Skills, Role prompt where applicable, and immutable Connection snapshot facts. The
dynamic tail contains the current Context Card, one raw User Prompt projection,
Task authority/state, and TaskInput/review delta.

## 5. Task states

```text
queued -> running -> waiting -> running
running|waiting -> delivered
delivered -> accepted
delivered -> rejected
rejected --resume--> running
queued -> interrupted
running|waiting -> interrupted|failed
```

Core validates every transition. Clients never patch `state`, `sessionId`,
`activeDeliveryId`, wait reason, or outcome directly.

`delivered` means a ready Delivery exists and review is pending. It remains
active. `accepted` means review and any required integration succeeded.
`rejected` is terminal unless the same review mutation explicitly resumes the
Task.

## 6. Claim and execution lane

An external executor or durable Role claims a queued Task. Claim reloads the
authoritative envelope and captures the Role lane base once within the Task and
workspace mutation boundary. Repeated claim is idempotent; it never recomputes
the base after the Role branch moves.

A Connection-launched Task is created and bound through Service's managed lifecycle. Pure
Tent work may have no Git lane and can legitimately deliver zero commits.

WorkspaceLane records:

```text
workspace, worktree, branch, targetBranch, baseCommit,
integrationAuthority { actor, mutator: service }
```

Executors use only the persisted lane. Missing code-lane facts fail loud; they
are never guessed from cwd or branch names.

## 7. Managed Session start and replacement

Service snapshots the selected Agent Connection into the exact Session before
Task creation. Provider startup never reinterprets Task identity from Settings.
Provider startup runs outside the exact Task lifecycle lock. Before launch it
captures an authoritative Task snapshot; after launch it binds only when Task
identity, state, binding, responsibility, and version still match.

If interrupt, accept, cancel, or finalization wins the race, binding CAS fails.
Service stops the new Session, records a stable diagnostic, and does not publish
a Delivery or false outcome.

`task.startSession` is idempotent for an already usable Task binding.
`task.replaceSession` explicitly creates fresh execution for the same Task when
the prior context is unusable. It requires a turn-idle eligible Task, preserves
TaskInput and lane facts, and uses the same start/bind CAS. It is never a force
flag or an implicit fallback.

Resume/reattach is different from replacement: it must preserve the same
recoverable provider conversation and pass the live context-generation and
exclusive-lease gates.

## 8. TaskInput

TaskInput is user/parent-to-executor input scoped to one exact Task.

Open states:

| State | Meaning | Retryable for managed injection | Blocks Delivery |
| --- | --- | --- | --- |
| `pending` | queued for delivery | yes | yes |
| `processing` | injection in flight | no | yes |
| `failed` | known not delivered | yes | yes |
| `uncertain` | injection may have succeeded | never | yes |

`uncertain` is durable at-most-once evidence. It never returns to an injection
source. Successful authorized acknowledgement records that ambiguity is
accepted, preserves its diagnostic history, and schedules exactly one retry
from the existing durable Delivery draft. It never prompts the provider again,
and background retry failure does not reverse the acknowledgement.

An explicit user retry creates a new TaskInput first, then acknowledges the old
uncertain row. If either mutation fails, at least one blocker remains.

## 9. DecisionRequest and tool approval

DecisionRequest is an exact requester Session question to the frozen parent
user or Role authority. Creation parks the Task at `waiting(user-input)`.
Response authority comes only from authenticated transport, never actor text.
Service persists one deterministic `decision-response` TaskInput before marking
the same `dr-*` answered; Role targets may escalate that same id to user.

Provider tool approval is runtime-scoped and does not change Task authority.
Tent does not replace the host's native permission UI or copy raw secret tool
arguments into public projections.

## 10. Managed final report

Service treats a natural non-empty managed ACP final report as deliverable by
default. Optional leading controls are:

```text
outcome: blocked
outcome: needs-input
```

Those controls park the Task and do not publish Delivery. An explicit
`outcome: delivered` remains accepted but is redundant. Missing, unknown, or
malformed outcome text is preserved as report content rather than discarded.
An empty report never invents success.

Before outcome handling or any publish attempt, Service saves every non-empty
final report to the durable managed report-draft store. A valid control outcome
changes the Task state but does not discard its full body. Draft retry reuses
those exact bytes and never asks the provider to answer again.

## 11. Delivery gate and publication

A ready Delivery may publish only when:

- the producing turn is complete and Session is settled;
- no blocking TaskInput, DecisionRequest, or review feedback remains;
- the worktree and Git history are settled;
- reported commits pass lane ancestry checks;
- no conflicting ready Delivery exists;
- the durable report draft is available for managed publication.

Delivery is persisted before `activeDeliveryId` and delivered Task outcome are
published through the Task lifecycle mutation. Interrupt cannot preserve a
pointer to a Delivery that does not exist.

Managed draft retry after TaskInput acknowledgement is Service-owned tracked
background work. A successful durable acknowledgement returns immediately; a
slow or failed draft retry cannot reverse it.

## 12. Review

The authority derived from exact persisted `parentActor` accepts or rejects:

- accept validates the ready Delivery, integrates declared commits when
  required, then publishes accepted Task/Delivery state;
- reject records review feedback and either ends the Task or atomically resumes
  it;
- executors never accept their own Delivery;
- `review-required` uses the frozen `parentActor` authority; `auto-accept` still persists a
  ready Delivery before Core integration; `agent-decide` is available to an
  executor Session and is not a Role identity test.

Accepted conclusions are deliberately promoted into the relevant Node by the
accountable Role or user through an etag-checked Node mutation. Tent does not
automatically copy a full report or conversation into Node content.

## 13. Git integration

Commit-bearing Delivery records exact SHAs and a target-head snapshot. Service
validates that every SHA is a commit in the Task lane range and that no foreign
or unauthorized ancestry is introduced.

Integration serialization uses canonical repository/common-dir plus fully
resolved target ref, not workspace id alone. Immediately before writing,
Service re-reads target head. `TARGET_MOVED` requires reject/resume and a new
Delivery.

Rollback is CAS: it may restore the pre-write head only while target head still
equals this operation's expected post-write head. If another operation advanced
the target, rollback fails loud and preserves the new state.

Service never pushes a remote as part of accept.

## 14. Interrupt, cancel, and failure

- `cancel` applies to queued work.
- `interrupt` applies to running/waiting work and stops the exact managed
  Session through Service ownership.
- once a ready Delivery exists, reviewer accept/reject preserves that published
  fact; interrupt does not erase it.
- failure or interrupt cannot retain `lastOutcome=delivered` or a dangling
  Delivery pointer.

Do not kill provider PIDs, edit envelopes, or delete lanes as lifecycle
substitutes.

## 15. Worktree reclaim

Only terminal, clean, fully integrated, unambiguous managed Task worktrees may be
reclaimed automatically. Service revalidates exact registration, branch/tip,
dirty state, Session settle, and ownership before removal.

On Windows, Service removes the exact Task lane with the Node filesystem API so
junction targets are not followed, verifies the lane path is absent, then
cleans exact Git worktree metadata. Any partial or unreadable condition remains
pending/needs-attention. Role lanes, user content, branches, commits, and audit
records are never mass-pruned.

## 16. Read projections and events

Useful projections include:

```text
task.list | task.get
workspace.collaboration
node.collaboration | node.collaborations
session.list | session.get
delivery.list | delivery.get
taskInput.listPending
interaction.listPending
```

`workspace.collaboration(workspaceId,nodeId)` is the product read boundary. It
joins existing Task, Delivery, DecisionRequest, Role, Connection, and Node
identity facts without persisting a second source. `selectedNode` is exactly
`{nodeId,activeTask}`; graph remains the only Node title/type/mode authority.
The active Task separates immutable parent responsibility (`user|role`) from
execution (`role|connection|null`) and may expose only its exact ready Delivery
summary and actionable user Decision. Its Inbox includes user-responsibility
ready Deliveries and actionable user-targeted Decisions only, in stable order.
No Task path, Session/runtime/provider fact, commit, or target head crosses this
wire.

During the source sequence, legacy `node.collaboration(s)` and
`interaction.listPending` reads remain for the existing Desktop. UI batch J
must move review/decision actions to the exact ids in this projection without
exposing `taskPath`; the final protocol-7 release then removes those legacy
reads rather than retaining a compatibility path.

Events such as `node.changed`, `task.state`, `session.state`, `delivery.updated`,
`taskInput.*`, and `decisionRequest.*` only invalidate cached views. Consumers re-query
the owning projection.

## 17. Stable failure classes

Public failures distinguish at least:

- invalid Node refs or exact occupation conflict;
- parent/review authority mismatch;
- unavailable Agent Connection;
- Task lifecycle or Session binding CAS conflict;
- pending interaction or unresolved Delivery;
- oversized ACP input/output;
- dirty, foreign, or ambiguous Git lane;
- target moved or integration rollback CAS refusal;
- unreadable persisted fact.

Unreadable or corrupt state fails loud. Clients must not reinterpret a partial
projection as success or repair persisted facts by guesswork.
