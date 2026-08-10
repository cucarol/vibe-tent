# Desktop And Local Service Architecture

This document defines the production boundary shared by Desktop, CLI, Core,
Local Service, and ACP adapters. Task and Delivery details live
in [task-api.md](task-api.md); Node storage lives in
[node-model.md](node-model.md); provider process behavior lives in
[agent-runtime.md](agent-runtime.md).

## 1. One workspace, one mutation authority

A mounted project has one workspace root and one `.tent/` system root. The
Local Service is the sole writer for Tent collaboration state. Desktop, CLI,
and managed ACP processes are clients; none may create a second
direct-write path into `.tent/temp/`.

The workspace keeps project files and Git history. `.tent/` keeps Nodes,
registries, Tasks, Sessions, Deliveries, interaction records, and operational
indexes. It is ignored by the project repository.

## 2. Product objects

- **Node** is durable project context and knowledge.
- **Role** is a durable responsibility to the user.
- **Task** is one exact work and review attempt over one or more Nodes.
- **Session** is an execution binding, managed by ACP or entered by an external
  host.
- **Delivery** is the formal result submitted to reviewer authority derived from
  persisted `parentActor`.
- **Agent Connection** is machine-local non-secret launch configuration for provider,
  model, endpoint, command, and optional Launch Secret reference.

Only the first five are collaboration objects. A Connection is machine
configuration, not an identity, Role, ACL, or durable worker record.

## 3. Process topology

```text
Desktop / CLI
              |
              | authenticated local RPC, protocolVersion=6
              v
        Local Service process
          |             |
          |             +-- machine Settings + Launch Secret references
          |
          +-- WorkspaceHost per mounted workspace
          |      +-- Core mutations and projections
          |      +-- filesystem watcher
          |      +-- Git lane integration/reclaim
          |
          +-- AgentRuntime
                 +-- ACP adapters
                 +-- managed child processes
```

Closing a window does not stop the Service. CLI exit does not stop it either.
Service data-dir ownership, endpoint publication, protocol handshake, and the
workspace mutation lease prevent two writers from claiming the same state.

## 4. Layer responsibilities

### Core

Core owns Node identity and structure, exact Node occupation, Task and Delivery
state transitions, authority checks, Git lane rules, and pure projections. It
does not spawn providers or own windows.

### Local Service

Service mounts workspaces, serializes mutations, snapshots Agent Connections,
starts and binds managed Sessions, persists interaction state, supervises Git
integration/reclaim, and emits invalidation events.

### Desktop and CLI

Clients issue RPC, render projections, and ask the user for decisions. They do
not infer lifecycle state from files or events and do not treat cached views as
authority.

### ACP adapters

Adapters translate the managed Session contract to a provider protocol. They
may start, resume, prompt, stream, and stop a child process. They never claim
Nodes, accept Deliveries, edit Node content, or decide Task authority.

## 5. Claim, dispatch, and execution

A durable Role creates and immediately claims its own execution Task without a
target:

```text
tent task claim --work-node <nodeId> ... [--context-node <nodeId> ...] --prompt <text>|-
```

Tent derives the responsibility chain from persisted Task/Session facts. This
is execution ownership, not delegation, and never creates a sub lane.

Public dispatch is only for assigning work downstream. It accepts repeated
exact Node references and one target:

```text
tent task dispatch --target role:<roleId> --work-node <nodeId> ... --prompt <text>|-
tent task dispatch --target connection:<connectionId> --work-node <nodeId> ... --prompt <text>|-
```

`role:*` creates a queued durable handoff. The Role claims it in its existing
lane. `connection:*` snapshots machine Settings into a reserved Session,
creates the formal Task already bound to that Session, and starts ACP outside
the lifecycle mutation. The temporary Session is not
registered as a separate durable worker.

Task Node refs are acquired atomically. An exact Node may have at most one
active Task; parent and child Nodes do not imply subtree occupation. Structural
mutations check the exact affected source and target subtrees.

## 6. Mutation and events

All workspace mutations run through the WorkspaceHost mutation boundary.
Task-specific lifecycle operations additionally serialize on the exact Task.
Git integration serializes by canonical repository/common-dir and fully
resolved target ref.

Events are invalidation signals:

```text
node.changed | node.removed
task.state | delivery.updated | session.state
taskInput.* | decisionRequest.* | toolApproval.*
workspace.settings.updated | service.health
```

An event is never a second fact store. Clients re-query the relevant projection
after receiving it. Watcher self-write suppression is scoped at ingress so a
later Service write cannot retroactively drop an external change.

## 7. Machine Settings and Launch Secrets

Agent Connections are stored under the Service data directory, not in a
workspace. Public projections expose only safe Connection metadata and availability.
An optional encrypted Launch Secret is only a process/MCP injection primitive,
not a provider account, login, or OAuth object. Secret values are supplied to
the launch plan at process start and are redacted from stderr, RPC errors,
events, and diagnostic rings.

Reserved Service environment keys override Connection-provided values. Managed
children receive a minimal allowlist plus the exact Core overlay. They do not
inherit the entire Service environment.

## 8. Session and shutdown safety

Provider startup runs outside the exact Task lifecycle lock. Binding the
returned Session uses an authoritative Task snapshot and CAS; if a terminal
transition wins, Service stops the unbound Session and preserves a stable
diagnostic rather than writing an orphan binding.

Service stop first prevents new work, then drains tracked background work and
managed turns. If a bounded drain times out while a workspace runner can still
write, endpoint and writer lease ownership remain fail-closed until process
exit.

## 9. Generated artifacts

Tracked bundles are release artifacts, not source-of-truth contracts. Build
configuration must produce byte-identical output from the shared repository and
independent worktree topologies and must not embed absolute or worktree-specific
paths. Generated files are rebuilt from one accepted shared source head and are
never hand-edited.

## 10. Production vertical slice

The minimum honest flow is:

```text
mount workspace
  -> read or create Node
  -> dispatch exact Node Task to Role or Agent Connection
  -> execute through Role or managed Session
  -> publish Delivery
  -> exact reviewer accepts or rejects
  -> accepted conclusions are deliberately written back to the relevant Node
```

The same flow remains reachable after closing the Desktop window because the
Local Service, not the renderer, owns collaboration state.
