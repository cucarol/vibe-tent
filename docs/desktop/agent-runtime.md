# Managed Agent Runtime Contract

This document describes the Local Service execution boundary for managed ACP
and external Sessions. Collaboration semantics remain in
[task-api.md](task-api.md); adapters never implement Node occupation, review, or
Git integration.

## 1. Runtime responsibilities

The runtime may:

- resolve one machine Settings route into a private launch plan;
- start, resume, prompt, observe, and stop a provider process;
- normalize ACP updates into Session events;
- enforce input, output, frame, update, and diagnostic bounds;
- project safe runtime state to Service.

The runtime may not:

- create or claim a Task on its own;
- acquire or edit Nodes;
- select a reviewer or accept a Delivery;
- turn route availability into collaboration authority;
- persist provider credentials or conversation tokens in a workspace.

## 2. Settings route and launch plan

A public `routeId` is a stable, non-secret reference stored in machine
Settings. Service resolves it immediately before launch into an internal plan:

```ts
type LaunchPlan = {
  routeId: string;
  adapter: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  model?: string;
  endpoint?: string;
};
```

The plan is runtime-only. Public Task and Session projections may expose the
route id and safe compatibility facts, never secret values. A missing or
invalid route fails before provider launch.

Managed children receive a minimal environment allowlist plus reserved Core
keys such as workspace, Task, Session, protocol, and owning Service data-dir.
Route configuration cannot override reserved keys.

## 3. Session kinds

### Managed ACP Session

Service owns the child process and ACP transport. It binds the Session to one
Task before prompting and keeps the registry authoritative for state, turn
busy status, provider resume capability, and Task linkage.

### External Session

An external host enters with `tent session enter`, may bind during Task claim,
and leaves with `tent session leave`. Enter/leave never spawns or kills the host
process and never delivers or accepts a Task.

## 4. Session states and events

Runtime state is intentionally smaller than provider-specific state:

```text
starting -> live <-> waiting-user
starting|live|waiting-user -> stopping -> stopped
starting|live|waiting-user|stopping -> failed
```

Session events are invalidations. Consumers re-read the Session registry and
Task projection; they do not derive authority from event order.

Late updates from a retired or replaced Session are ignored when the exact Task
binding no longer matches.

## 5. Start and bind CAS

Provider launch can be slow and therefore runs outside the exact Task lifecycle
lock:

1. under the lifecycle boundary, Service reloads the authoritative Task and
   captures its identity, state, binding, and version snapshot;
2. runtime starts the provider outside the lock;
3. Service re-enters the lifecycle and workspace mutation boundary;
4. it binds only when the Task is still non-terminal and the snapshot still
   matches;
5. on CAS failure, it stops the new Session and reports
   `TASK_SESSION_BIND_CAS_FAILED` without changing Task outcome or Delivery.

`task.startSession` and `task.replaceSession` share the same exact-Task
operation flight. Concurrent identical calls may coalesce; conflicting
operations fail deterministically.

## 6. Resume, reattach, and fresh replacement

Resume means reconnecting to the same provider conversation for the bound Task
or durable Role. Core must prove route/adapter, workspace, parent Role, purpose,
Skills, context generation, lane, exclusive idle lease, settled turn,
TaskInput, and Delivery compatibility. Temporary route Sessions have no public
cross-Task reuse promise.

If the provider conversation is no longer recoverable, it is not silently
relabeled as the old Session. `task.replaceSession` is an explicit fresh
execution for the same Task and remains subject to turn-idle, Task-state, CAS,
and cleanup rules. A different work contract should be a new Task.

Reusable Session bookmarks and general consultation/Advisor behavior are not
part of the current runtime contract.

## 7. Bootstrap and context

Service assembles the official bootstrap. Caller text may append a dynamic
section but cannot replace the stable prefix.

The stable prefix contains:

- Task protocol and installed Skill contract;
- workspace identity and project instruction pointers;
- Role prompt when applicable;
- live Settings route compatibility snapshot;
- authoritative context generation.

The dynamic tail contains the current Context Card, Node refs, Task state,
TaskInput, review feedback, and optional Role checkpoint. Reuse may omit the
stable prefix only after the live generation and every compatibility gate
match. Collector failure fails loud and never creates reusable placeholder
facts.

## 8. TaskInput and UserAsk

Managed input delivery is at-most-once. `pending` and `failed` rows are
retryable; `processing` is in flight; `uncertain` is durable ambiguity and is
never automatically retried or injected again.

All four open states block Delivery. Successful authorized acknowledgement of
`uncertain` records that ambiguity is accepted and schedules exactly one retry
of the existing durable Delivery draft. It never prompts the provider again,
and background retry failure does not reverse the acknowledgement.

UserAsk is the separate Agent-to-user question path. It parks the Task until
the exact answer or denial returns through Service.

## 9. Final report and Delivery

The adapter accumulates the final assistant report separately from diagnostics.
A natural non-empty final report is deliverable by default. A valid optional
leading `blocked` or `needs-input` control outcome parks the Task. Missing or
malformed control text does not discard the report; an empty report never
creates Delivery.

Before outcome handling or publication, Service preserves every non-empty final
report in the durable managed report-draft store. A control outcome may park,
but cannot discard its full body. Publication proceeds only after the turn,
TaskInputs, Session, worktree, commits, and history settle. Publication and Task
terminal facts use the Task lifecycle boundary; a pointer is never published
before its Delivery exists.

## 10. Bounded ACP transport

The adapter enforces independent bounds:

- inbound JSON-RPC frame bytes before parsing;
- assistant report bytes, update count, and segment count;
- bootstrap bytes and serialized outbound request bytes;
- diagnostic event and ring-buffer bytes.

Report or frame overflow fails loud as `ACP_OUTPUT_LIMIT`; outbound overflow is
`ACP_REQUEST_LIMIT`. The provider is stopped, and no truncated content may
become `prompt_complete`, a ready Delivery, or a delivered outcome.

Diagnostic bounding is redaction-aware across chunk and UTF-8 boundaries.
Known secrets are removed before final byte bounding, including overlapping or
split occurrences.

## 11. Failure and recovery

An unintentional managed process exit before Delivery parks an eligible Task in
the existing recoverable `session_unavailable` path. It preserves Node
occupation, TaskInput/UserAsk records, worktree, and report draft. Recovery is
explicit start/resume or replacement; Service does not re-prompt in the
background.

Registry and Task disagreement is reconciled from persisted facts at mount.
Unreadable facts fail loud. The runtime never repairs them by guessing from a
working directory, process id, or remembered conversation token.
