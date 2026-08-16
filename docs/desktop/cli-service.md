# CLI and Local Service contract

The CLI attaches to Local Service, verifies Protocol 9, mounts the workspace,
then calls typed RPC. It never edits `.tent/temp` directly.

## Task lifecycle

```text
tent task list
tent task get <taskPath>
tent task package <taskPath>
tent task claim <taskPath>
tent task claim --work-node <nodeId> ... --prompt <text>|-
tent task dispatch --target role:<roleId>|connection:<connectionId> ...
tent task submit <taskPath> --report <text>|- [--commits sha,sha] [--decision integrate|request-review]
tent task accept <resultId> --actor <user|roleId>
tent task bind-output <resultId> --output-node <nodeId> ... --actor <user|roleId>
tent task reject <resultId> --actor <user|roleId> [--note ...] [--resume|--no-resume]
tent task request-decision <taskPath> --question <text>|- [--options id=label,id=label]
tent task decision respond <requestId> (--option <id> | --text <text>|- | --deny)
```

`task.submit` first creates a ready TaskResult; the frozen accept mode determines
whether review follows automatically. A zero-commit TaskResult is valid.
Commit-bearing results require canonical full object ids
from the exact recorded WorkspaceLane. `TARGET_MOVED` requires a new execution
decision; clients never rewrite immutable result payload.

`review-required` waits for requester review; `auto-accept` runs exact automatic
accept/integration; `agent-decide` requires `--decision integrate|request-review`.
Review targets the exact positional `resultId`. Service resolves only the Task's
`currentResultId`, validates requester authority, and applies the existing Git
and review lifecycle. A review-required executor never accepts its own result.

`task package` prints the canonical frozen execution input without mutating the
Task. After acceptance, `task bind-output` explicitly records Result provenance
on existing `type: output` Nodes; Node content and creation remain ordinary Node actions.

## Role and Connection targets

`role:<roleId>` creates queued work for that durable Role. A Role requester is
valid only from its exact authenticated Role Session. `connection:<connectionId>`
is the optional managed-ACP path and creates a Session from the immutable Connection
snapshot. Agent Connection is launch configuration, not Task identity or authorization.

## Inputs and host actions

TaskInput stays exact-Task scoped and at-most-once. DecisionRequest is the only
needs-input authority. `session status` inspects the exact binding and incomplete
Tasks. `session leave` ends the exact Tent host binding, reports incomplete Tasks,
and never submits or reviews a TaskResult.
