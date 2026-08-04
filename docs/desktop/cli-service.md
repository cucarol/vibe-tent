# CLI And Local Service Contract

The `tent` CLI is a thin Local Service client. Run it from the workspace root
that contains `.tent/`. CLI exit never stops the Service, and CLI commands never
fall back to direct operational-file writes.

## Attach and protocol

The CLI discovers the machine-local endpoint and token, performs the
`protocolVersion=5` handshake, mounts the requested workspace, then calls the
typed RPC. A missing, legacy, or incompatible endpoint fails loud; the CLI does
not bypass Service or call an ACP adapter directly.

`--workspace <path>` selects a workspace explicitly. Without it, the CLI walks
from the current directory to the nearest `.tent/index.md` marker.

## Public command groups

```text
tent node list|get|create|write|move|archive|restore|...
tent role list|show|config
tent session enter|status|leave
tent task list|get|dispatch|claim|deliver|accept|reject|interrupt|cancel|...
tent role-checkpoint set|show|clear
tent status|tree|tags|find
```

The public collaboration nouns are Node, Role, Session, Task, and Delivery.
Machine Agent Connections are launch configuration, not collaboration objects.

## Direct Role ownership and downstream dispatch

A durable Role creates and immediately claims its own Task directly:

```text
tent task claim \
  --work-node <nodeId> [--work-node <nodeId> ...] \
  [--context-node <nodeId> ...] \
  --prompt <text>|-
```

This form has no `--target`; it is execution ownership, not delegation. An
optional `--from-task <taskPath>` names the active persisted responsibility to
inherit. Otherwise Tent uses the exact open Role Session when available and
keeps its persisted chain, including a terminal last Task.

`task dispatch` is only for assigning work to another durable Role or a machine
Agent Connection:

```text
tent task dispatch \
  --target role:<roleId>|connection:<connectionId> \
  --work-node <nodeId> [--work-node <nodeId> ...] \
  [--context-node <nodeId> ...] \
  --prompt <text>|-
```

- `--work-node` is required and repeatable; `--context-node` is shared read-only
  context. Context Card v2 keeps these sets distinct.
- `role:*` creates a queued durable Role handoff and never starts managed ACP at
  dispatch.
- `connection:*` snapshots machine Settings into the exact temporary managed
  Session and binds the formal Task to that `sessionId`.
- Tent derives equal persisted `parentActor` and `reviewer`; the
  executor cannot select or elevate them.
- prompt is explicit through `--prompt`; there is no positional dispatch form.

Connection dispatch does not register a worker, mutate a Role, or create a
reusable bookmark. Missing Connection configuration fails before Task mutation.

## Role and managed flows

### Durable Role handoff

```text
task dispatch --target role:planning ... -> queued
tent task claim <taskPath>                -> running
tent task deliver <taskPath> --summary ...
reviewer accept | reject
```

The Role claim captures its execution lane base once. A pure Tent Task may have
no Git lane and may deliver with zero commits.

### Temporary managed ACP

```text
task dispatch --target connection:grok-core ...
  -> Service creates and claims Task
  -> snapshots Agent Connection into exact Session
  -> starts/binds managed Session
  -> preserves every non-empty final report before outcome handling
  -> publishes Delivery after settle gates
```

The managed executor does not run `claim` or `deliver` itself. A valid optional
`blocked` or `needs-input` control outcome parks; ordinary final prose defaults
to Delivery.

### Durable Role executor

A Role claims its own queued work and explicitly calls `tent task deliver`.
Host integration may supply the verified Role execution context, but it cannot
deliver, accept, or rewrite Task responsibility on the Role's behalf.

## Interaction commands

```text
tent task send-input <taskPath> ...
tent task task-input list|get|ack ...
tent task request-decision <taskPath> --question <text>|- [--options id=label,...]
tent task decision list|get|respond|escalate ...
```

TaskInput is exact-Task scoped. `uncertain` input is visible attention state,
blocks Delivery, and is never automatically reinjected. Decision response
authority is derived from authenticated transport rather than caller-provided text.

## Review and Git

`task deliver` creates a Delivery; it never accepts it. The exact persisted
reviewer acts on the exact ready Delivery shown for the Task:

```text
tent task accept <taskPath> --delivery-id <deliveryId> --actor <user|role> ...
tent task reject <taskPath> --delivery-id <deliveryId> --actor <user|role> [--note ...] [--resume|--no-resume] ...
```

The Delivery id is required and prevents a stale review card from accepting or
rejecting a newer Delivery for the same Task. `DELIVERY_CHANGED` requires the
client to refresh before retrying. Commit-bearing Delivery validates every
reported SHA against the Task lane and snapshots the target head.
`TARGET_MOVED` requires reject/resume and a new Delivery; clients never rewrite
the snapshot.

The CLI never pushes a remote, deletes a worktree, prunes Git registrations, or
edits Task envelopes to simulate lifecycle.

## Errors and output

Human output is concise; `--json` returns the typed Service projection. A
non-zero exit is required for attach failure, invalid grammar, authority
mismatch, stale etag/path, Node occupation conflict, Task lifecycle conflict,
provider failure, dirty lane, or Git integration conflict.

Tests and automation must check process exit code and the authoritative runner
summary. Truncated, tailed, or grepped output is not success evidence.
