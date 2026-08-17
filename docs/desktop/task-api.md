# Task, TaskResult, and Session API

## TaskRecord

TaskRecord stores a canonical id, non-empty `prompt`, ordered deduped `nodeIds[]`
(which may be empty),
optional `assigneeRoleId`, optional current `executionSessionId`, exact
`requester`, `acceptMode`, state, WorkspaceLane facts, optional `statusDetail`,
and optional `currentResultId`.

`requester` is the sole return/review authority. Role responsibility and Session
execution are separate. For Session-only Tasks, the path's Session segment is an
immutable storage partition; it is never current execution or review authority.

## Task Package

`task.package` returns the canonical Task Package and `tent task package` exports
its bytes directly. Ordinary `task.get` remains a lightweight lifecycle read. The
Package is derived from TaskRecord plus the frozen Context Card, keeps ordered
root `nodeIds[]` plus their frozen subtree snapshots, and excludes Session/Connection runtime state.
Every Harness receives this same contract; transport wrappers are not authority.

## TaskResultRecord

One fresh logical `task.submit` creates a new `rs-` TaskResult. An exact retry
must match every immutable candidate field; it reuses or converges to the
persisted candidate and `resultId` and never creates a second Result. Immutable fields are identity,
`taskId`, non-empty report, ordered commits, checks, artifactRefs, integration
mode, target head, and creation time. The review projection transitions once:

```text
ready -> accepted | rejected
```

`Task.currentResultId` is the only review selector. Service never chooses a
result by latest file, directory order, or history scan. Accept/reject use exact
`workspaceId + resultId + actor`; an accepted Result never auto-enters later
Task context, and a response-loss retry must prove the same candidate.

## Accept mode

- `review-required`: ready result waits for exact requester review; executor
  never self-accepts.
- `auto-accept`: Service runs the exact accept and Git integration lifecycle.
- `agent-decide`: `task.submit` must choose `integrate` or `request-review`.

The Task's mode is frozen authority, not a caller-selected shortcut.
Non-review modes are legal only when requester is user; downstream
executor-to-parent-Role Tasks are forced `review-required`.

## Status and interactions

Normal non-empty final prose submits a TaskResult. A blocked return parks the
Task in `waiting` with `statusDetail.kind=blocked`. Explicit terminal failure is
`failed` with bounded status detail. DecisionRequest represents needs-input.

TaskInput states are internal handoff facts. All access is exact-workspace and
exact-Task; the provider boundary is at-most-once, uncertain handoff is never
automatically reinjected, and external poll/ack remains explicit.

## Managed publication

Service preserves one durable report draft and one exact Session/Task in-flight
Promise. A committed Result candidate is recovered before any new provider seal.
Successful publication clears the draft; a reversible publication failure keeps
it and records bounded status detail. Duplicate completion cannot create a second
result for the same candidate.

## Explicit durable output

Review never edits a Node. After an exact Result is accepted, ordinary Node
create/write remains the content-authority path. `task.bindOutput` may then bind
that Result id to one or more existing `type: output` Nodes. Same-id retries are
idempotent; unaccepted Results and non-Output Nodes fail without partial writes.

## Collaboration projection

`workspace.collaboration` accepts optional `nodeId`. It returns selected-node
collaboration plus the actionable user Inbox. Inbox joins only exact current
ready TaskResults requested by user and exact actionable user DecisionRequests.
It exposes ids needed by mutations, not task paths, Session liveness, transport,
tokens, or provider state.

## Events

`task.state`, `taskResult.updated`, `session.state`, `taskInput.updated`, and
`decisionRequest.updated` invalidate projections. Durable records remain the
authority.
