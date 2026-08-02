# Temporary managed ACP Session boundaries

Service starts a temporary managed ACP Session only for a Task assigned to a
machine Settings route. The route is a non-secret launch reference; durable
responsibility remains with the Task's Role and parent reviewer chain.

| Boundary | Contract |
| --- | --- |
| Start | Service resolves the Task's persisted route and claims the Task before provider launch |
| Binding | One exact Task `sessionId`; final bind uses Task lifecycle snapshot/CAS |
| Delivery | Service captures the natural non-empty final report and preserves its durable draft before publication |
| Resume | Same Session, immutable route snapshot, recorded provider token, and native provider conversation |
| Replacement | Explicit `task.replaceSession`; fresh execution for the same eligible Task |

## Recover a bound Task

1. Re-query the exact Task and Session after restart, compaction, provider exit,
   or replacement.
2. Never use a remembered process id, live route edit, or caller-supplied token
   as continuity authority.
3. Resume only the Session already bound to that exact Task. Native load uses
   its immutable non-secret route snapshot and recorded provider token.
4. Context-generation equality only permits stable-prefix omission. A mismatch
   resumes the same provider conversation with the full current prefix.
5. Missing or failed native recovery parks the Task at
   `waiting(session_unavailable)` and preserves occupation, lane, TaskInput,
   UserAsk, and report draft. It never starts fresh while claiming continuity.
6. Use `task.replaceSession` only for a turn-idle eligible Task. Replacement is
   explicitly fresh and uses the same lifecycle/binding CAS.

Provider startup runs outside the Task lifecycle lock. If a terminal transition
wins before final binding, Service stops the unbound child and reports
`TASK_SESSION_BIND_CAS_FAILED`; never hand-bind it or overwrite the Task.

## Protocol, limits, and host boundary

- A CLI/Service protocol mismatch fails before Task mutation. Do not bypass
  Service or invoke a provider adapter directly.
- `ACP_OUTPUT_LIMIT` and `ACP_REQUEST_LIMIT` stop the provider and cannot
  produce truncated `prompt_complete`, Delivery, or delivered outcome.
- Diagnostic tails are bounded and redacted evidence, never lifecycle
  authority.
- Tent does not replace the host application's tool-approval UI. Managed ACP
  tool approval remains a separate runtime path.

The Context Card supplies Task refs; authority comes from the persisted parent
reviewer, exact Node occupation, Task lifecycle, and integration lane. A valid
Settings route proves machine availability only.
