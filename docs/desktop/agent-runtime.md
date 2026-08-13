# Agent runtime

Runtime executes one Session from an immutable Agent Connection snapshot. It
does not choose requester authority, review a TaskResult, or mutate Nodes.

## Start, resume, replace

- Start binds exact Task `executionSessionId`, Session `currentTaskId`, and
  Connection identity before provider work.
- Resume uses the same Session, snapshot, provider token, and recorded context.
- Replace is explicit fresh execution for the same eligible Task.
- A lost binding CAS stops the unbound child and leaves the Task recoverable.

A host or external Session may have no current Task and later enter a Role or
claim work. A Tent-managed ACP Session created for a Task stays exact-Task bound.

Connection creation materializes `command + args`; `args: []` is exact. Adapters
do not append hidden launch arguments. Secret values are resolved only into the
child environment and are redacted from bounded diagnostics.

## Inputs and decisions

TaskInput is exact-Task and at-most-once. An uncertain handoff is never
automatically reinjected; external poll/ack remains explicit. DecisionRequest is
the only user-choice authority.

## Final report

During an active prompt, ACP message segments produce one natural final report.
Service preserves one durable report draft and uses `task.submit` to create a
TaskResult. A committed Result candidate is recovered before any repeat seal or
stop. Blocked and failed exits use bounded Task status detail rather than a new
runtime product state.

## Failure boundary

Hard byte/frame/report limits, permission handling, secret redaction, and load
replay quiet remain resource/privacy boundaries. Stop succeeds only after the
actual child exits. Transient provider, adapter, or projection failure parks or
fails the Task through existing state plus bounded status detail; it does not
invent another queue, entity, or history scan.
