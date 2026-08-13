# Task, TaskResult, and Session API

## TaskRecord

TaskRecord stores a canonical id, non-empty `prompt`, work/context Node ids,
optional `assigneeRoleId`, optional current `executionSessionId`, exact
`requester`, `acceptMode`, state, WorkspaceLane facts, optional `statusDetail`,
and optional `currentResultId`.

`requester` is the sole return/review authority. Role responsibility and Session
execution are separate. For Session-only Tasks, the path's Session segment is an
immutable storage partition; it is never current execution or review authority.

## TaskResultRecord

`task.submit` creates a fresh `rs-` TaskResult. Immutable fields are identity,
`taskId`, non-empty report, ordered commits, checks, artifactRefs, integration
mode, target head, and creation time. The review projection transitions once:

```text
ready -> accepted | rejected
```

`Task.currentResultId` is the only review selector. Service never chooses a
result by latest file, directory order, or history scan. Accept/reject use exact
`workspaceId + resultId + actor`; a response-loss retry must prove the same
candidate.

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
