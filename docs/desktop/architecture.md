# Desktop architecture

Desktop is a Protocol 9 client of one process-independent Local Service. It
does not open operational files directly and never becomes a second mutation
authority.

```text
Renderer -> typed preload bridge -> Desktop main -> authenticated Local Service
                                                   -> Core / runtime / adapters
                                                   -> mounted workspace + Git
```

## Authority boundaries

- Core owns Node, Role, Task, TaskResult, and exact lifecycle rules. Session and
  Agent Connection are supporting execution records, not peer responsibility models.
- Local Service owns workspace mounting, authenticated RPC, runtime orchestration,
  filesystem mutation, Git integration, and projection events.
- Desktop main holds the endpoint token and exposes a narrow typed bridge.
- Renderer displays graph, collaboration, Canvas, Inbox, document, and settings
  projections. It does not receive secrets, provider tokens, task paths for review,
  or mutable runtime handles.

TaskResult review uses exact `resultId`. Decision response uses exact `requestId`.
Task submission and review do not mutate Nodes; a later explicit Node action may
update durable context or bind an accepted result to an Output Node.

## Attach and events

Desktop attaches only when health reports Protocol 9. An incompatible endpoint
is rejected before business RPC. The endpoint token remains in main/preload
boundaries.

SSE events such as `node.changed`, `task.state`, `taskResult.updated`,
`session.state`, `decisionRequest.updated`, and `workspace.switched` invalidate
typed projections. Events do not contain a parallel authority model.

## Process lifetime

Closing a window does not stop Local Service or provider processes. Explicit
Session stop/leave and controlled Service stop are separate host actions. A stop
is reported successful only after the child process actually exits.
