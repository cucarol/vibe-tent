# Vibe Tent V0.2 Specification

Protocol 9 is the only current public contract. Retired public commands and wire fields are removed rather than kept as aliases.

## 1. Product vocabulary

The core product entities are Node, Role, Task, and TaskResult. A Session records optional host execution continuity. An Agent Connection is optional machine configuration for Tent-managed ACP launch. TaskInput, DecisionRequest, and Proposal are interactions. Canvas and Inbox are views, never Core authorities.

Host conversations are external continuity sources for Sessions. Tent has no Subagent entity: native host sub-collaboration stays host-local, while Tent-managed ACP execution is represented by its Task plus execution Session and never by a second Role.

## 2. Node

A Node is durable Markdown context with a canonical `cx-` id, parent/child placement, body, tags, relations, mode, and one optional arbitrary `type` marker. Missing type is valid. Unknown or hyphenated markers remain exact strings and never imply composite semantics.

Node bodies hold facts that remain useful across Tasks or Sessions. Operational Task, Session, and TaskResult records stay outside the Node tree. Updating an existing relevant Node or deriving an Output Node is an explicit Node-authority action after a TaskResult is accepted; review itself never mutates a Node.

Project instructions live in the workspace `AGENTS.md`. Tent does not copy that authority into another rules file.

## 3. Role and execution carriers

Role and Session are different. A Role has durable responsibility and can continue across replaceable host Sessions. A Session is a bounded execution record with a canonical `ss-` id, not a prerequisite for Task Package generation or Result submission. An Agent Connection is optional machine-local, non-secret ACP launch configuration with an arbitrary stable `connectionId`; it is availability, not identity or authorization.

Connection creation materializes canonical `command` plus complete `args` once. A Session stores an immutable Connection snapshot and uses it for start/resume. Public Connection projection uses `endpoint`; secrets are resolved only at the launch boundary and are never persisted or projected.

Session `currentTaskId`, `isAlive`, `canResume`, `isTurnActive`, and `providerContextRestored` describe current execution truth. Session diagnostics never replace Task authority.

A host or external Session may exist without a current Task and later enter a Role or claim work. A Tent-managed ACP Session created for one Task is exact-Task bound.

## 4. Task

A Task is one work package and one review unit. Its TaskRecord contains:

- canonical Task id and non-empty `prompt`;
- `workNodeIds[]` and `contextNodeIds[]`;
- optional `assigneeRoleId` and `executionSessionId`;
- exact `requester` (`user` or Role), which receives the result and owns review authority;
- `acceptMode`, WorkspaceLane facts, state, wait/status detail, and optional `currentResultId`.

The Service derives execution and authority from canonical fields. The same work Node cannot be occupied by another active Task. Occupation is per exact work Node: parent and child Nodes are independent and never imply a subtree lock. Context Card v2 and incremental TaskInput/review deltas are persisted host-injected facts, not chat memory.

Every Task exposes one canonical Task Package derived from its TaskRecord and frozen Context Card. The Package preserves ordered work/context Node snapshots and the near-field prompt, excludes Session/Connection runtime state, and is byte-stable for the same Task facts. Native Harnesses and Tent-managed ACP consume the same Package; adapters may wrap transport but cannot rewrite its authority semantics.

Task state uses the existing lifecycle. An explicit blocked return is `waiting` with `statusDetail.kind=blocked`; a clear terminal failure is `failed` with bounded `statusDetail`. Needs-input is represented by a DecisionRequest rather than a Task state or result wrapper.

## 5. TaskResult

A TaskResult is an executor's formal result for one Task. A fresh logical submission creates a new canonical `rs-` record. An exact retry must match every immutable candidate field; it reuses or converges to the persisted candidate and `resultId` and never creates a second Result. `currentResultId` is the only review selector. There is no directory-latest or history scan for review authority.

The immutable candidate contains exact identity, non-empty report, ordered canonical commits, checks, artifactRefs, integration mode, creation time, and target-head snapshot when commits exist. Only the review projection may transition once from `ready` to `accepted` or `rejected`.

Zero-commit TaskResults are valid formal successes. Commit-bearing results require an exact recorded Git lane, canonical full object ids, clean Task worktree, and target-head protection. Artifact references, rather than commit fields, describe external files, directories, or URLs.

Exact Result accept/reject is an irreversible boundary. Private submit/review intents only converge their exact candidate; they are not public states, queues, scanners, or compatibility APIs.

## 6. Submit and review

The public lifecycle is:

```text
Task running
  -> task.submit(report, commits?, checks?, artifactRefs?)
  -> TaskResult ready; Task submitted; currentResultId exact
  -> task.accept(resultId) | task.reject(resultId)
```

Review authority comes from `requester`. The user path and exact Role Session authority are transport-bound. Accept integrates exact commits when required, then records accepted review and Task state. Reject records rejected review and may resume the same Task. Accept/reject never bind an Output Node or edit any Node.

After acceptance, an explicit actor may update an existing Node through ordinary etag-safe Node mutation. To derive an Output, the actor creates an ordinary `type: output` Node and explicitly calls `task.bindOutput` with the accepted exact `resultId`. Binding only records provenance; it does not generate or rewrite Node content.

`acceptMode` is a hard Task policy: `review-required` leaves the ready result for
the requester and the executor never self-accepts; `auto-accept` runs the exact
accept/integration lifecycle automatically; `agent-decide` requires submit
decision `integrate` or `request-review`. Callers cannot change the frozen mode
or bypass its review authority. Non-review modes are legal only for a Task
directly accountable to user; downstream executor-to-parent-Role Tasks are
forced `review-required`.

A response-loss retry proves the same immutable candidate and converges forward. A different candidate or stale result id fails loud with zero extra authority mutation.

## 7. Managed final reports and status detail

A natural, non-empty managed ACP final report defaults to a TaskResult. Service first preserves one durable report draft, then performs the exact submit lifecycle. One per-Session/Task in-flight Promise deduplicates concurrent completion; there is no success cache or provider re-prompt.

`outcome: blocked` parks the Task with bounded status detail. User input is requested through DecisionRequest. Publication failure keeps the report draft and records bounded `statusDetail`; successful TaskResult publication clears both. A committed TaskResult always outranks fallback status detail.

Provider crash, transient adapter failure, projection refresh failure, or an unclassified format problem does not create a special entity or public state. Tent preserves Task/context/worktree, stops or releases execution when safe, and uses the existing waiting/failed exit with bounded diagnostic evidence.

## 8. Interactions

TaskInput is exact-workspace and exact-Task scoped and preserves an at-most-once provider boundary. External poll/ack remains explicit; an uncertain handoff is never automatically reinjected. TaskInput state is interaction authority, not a second result path.

DecisionRequest is the only needs-input authority. A same-response retry is idempotent. Proposal captures a suggested Node mutation; applying it remains an explicit Node-authority action.

## 9. Views

Graph is the sole Node identity/title/type/mode projection. `workspace.collaboration` joins authoritative Tasks, TaskResults, Decisions, Roles, Connections, and exact Session binding into selected-node collaboration plus the actionable user Inbox. It does not create authority, cache lifecycle state, or expose provider transport details.

Inbox contains only actions the user can take now: exact current ready TaskResults whose requester is user and actionable user DecisionRequests. Canvas is a visual composition of Node facts.

## 10. Storage, paths, and Git

The workspace root contains `.tent/`; operational paths are relative to its system root. Role Tasks live in the Role partition. Session-only Task paths retain their creation Session as a physical partition only; `executionSessionId` is the sole current runtime identity.

WorkspaceLane records branch, base commit, target branch, worktree, and integration authority. Git integration, Node writes, deletion, secret handling, cross-Task input isolation, byte/frame limits, and exact TaskResult review retain hard protection. Reversible failures use the ordinary waiting/failed fallback rather than new recovery products.

## 11. Local Service and Protocol 9

Local Service is the only mounted-workspace mutation authority. Clients attach, verify Protocol 9, send typed RPC, and re-read projections. Any incompatible protocol is rejected before business RPC.

Core owns authority semantics; Service owns transport, exact caller binding, runtime orchestration, and events. Events invalidate projections but are not facts by themselves. Generated CLI/Service/Desktop artifacts are rebuilt only in a dedicated release task after source integration.
