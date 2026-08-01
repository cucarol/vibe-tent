# CLI And Local Service Contract

The `tent` CLI is a thin Local Service client. Run it from the workspace root
that contains `.tent/`. CLI exit never stops the Service, and CLI commands never
fall back to direct operational-file writes.

## Attach and protocol

The CLI discovers the machine-local endpoint and token, performs the
`protocolVersion=1` handshake, mounts the requested workspace, then calls the
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
Machine Settings routes are execution selectors, not collaboration objects.

## Dispatch

```text
tent task dispatch \
  --target role:<roleIdOrName>|route:<routeId> \
  --node <nodeId> [--node <nodeId> ...] \
  --prompt <text>|-
```

- `--node` is required and repeatable. It maps to the authoritative ordered
  `Task.contextCard.refs.nodes[]` set.
- `role:*` creates a queued durable Role handoff and never starts managed ACP at
  dispatch.
- `route:*` resolves the selected machine Settings route and starts a temporary
  managed ACP Session for the formal Task.
- caller identity supplies equal persisted `parentActor` and `reviewer`; the
  executor cannot select or elevate them.
- prompt is explicit through `--prompt`; there is no positional dispatch form.

Route dispatch does not register a worker, mutate a Role, or create a reusable
bookmark. Missing route configuration fails before provider launch.

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
task dispatch --target route:grok-core ...
  -> Service creates and claims Task
  -> resolves Settings route
  -> starts/binds managed Session
  -> preserves every non-empty final report before outcome handling
  -> publishes Delivery after settle gates
```

The managed executor does not run `claim` or `deliver` itself. A valid optional
`blocked` or `needs-input` control outcome parks; ordinary final prose defaults
to Delivery.

### External executor

An external process enters through `tent session enter`, claims a queued Task,
and explicitly calls `tent task deliver`. `session leave` only unbinds the
external Session; it does not deliver, accept, or kill the host.

## Interaction commands

```text
tent task send-input <taskPath> ...
tent task task-input list|get|ack ...
tent task ask-user <taskPath> ...
tent task user-ask list|get|reply|deny ...
```

TaskInput is exact-Task scoped. `uncertain` input is visible attention state,
blocks Delivery, and is never automatically reinjected. User authority is
derived from the authenticated local boundary rather than caller-provided text.

## Review and Git

`task deliver` creates a Delivery; it never accepts it. The exact persisted
reviewer uses `task accept` or `task reject`. Commit-bearing Delivery validates
every reported SHA against the Task lane and snapshots the target head.
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
