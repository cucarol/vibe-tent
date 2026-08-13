# Task CLI reference

All commands attach to Protocol 9 Local Service. Use the exact `taskPath`,
`resultId`, or `requestId` returned by an authoritative projection.

```text
tent task list [--json]
tent task get <taskPath> [--json]
tent task claim <taskPath> [--json]
tent task claim --work-node <nodeId> ... --prompt <text>|-
tent task dispatch --target role:<roleId>|connection:<connectionId> --work-node <nodeId> ... --prompt <text>|-
tent task submit <taskPath> --report <text>|- [--commits sha,sha] [--decision integrate|request-review] [--json]
tent task accept <resultId> --actor <user|role> [--json]
tent task reject <resultId> --actor <user|role> [--note ...] [--resume|--no-resume] [--json]
tent task request-decision <taskPath> --question <text>|- [--options id=label,id=label]
tent task decision respond <requestId> (--option <id> | --text <text>|- | --deny)
tent task send-input <taskPath> --text <text>|-
tent task task-input list (<taskPath> | --task <taskPath>)
tent task task-input get <inputId> --task <taskPath>
tent task task-input ack <inputId> --task <taskPath> [--actor <role|sessionId>]
```

## Claim and dispatch

Claim re-reads the persisted Task. Direct Role claim requires the current trusted
Role Session plus at least one work Node. Dispatch targets a durable Role or an
Agent Connection. The caller supplies prompt and Node refs; Service derives
requester, responsibility, execution, lane, and review authority.

## Submit and review

One fresh logical submission creates a new ready TaskResult with a non-empty
report. An exact retry must match every immutable candidate field; it reuses or
converges to the persisted candidate and `resultId` and never creates a second
Result. A zero-commit
TaskResult is a valid formal success. Commit-bearing results use ordered canonical
full object ids from the exact WorkspaceLane and snapshot target head.

Accept/reject target exact `resultId`; Task `currentResultId` is the sole selector.
In `review-required`, the executor never self-accepts. `auto-accept` runs the exact
automatic lifecycle, and `agent-decide` requires submit decision `integrate` or
`request-review`.
`TARGET_MOVED` or a changed immutable candidate requires a fresh authoritative
decision rather than rewriting the record.

Managed ACP preserves one durable report draft, then submits natural non-empty
final prose without a wrapper. A blocked control parks; needs-input uses
DecisionRequest. TaskInput terminal/ack may schedule one draft retry, but never a
provider prompt.

## Inputs and Decisions

Never self-`send-input` to the same Task you execute. The dispatcher sends
cross-Task input. An uncertain handoff is never automatically reinjected;
external poll/ack remains explicit. Decision response is idempotent for the same
exact request/response.

## Durable record

Task and TaskResult are the default record. After acceptance, an explicit actor
may promote durable facts into an existing relevant writable Node. If none exists,
report to requester. Node promotion is optional and separate from review.
