# Session boundaries

## Two session styles

| | Managed ACP | External / relay |
| --- | --- | --- |
| Start | Desktop / service `task.startSession` | Human clipboard, pull-host, `tent agent enter` |
| Claim | Service claims first | Agent runs `tent task claim` |
| Deliver | Service captures final assistant reply → `task.deliver` | Agent runs `tent task deliver` |
| Session id | Service-owned `ss-…` | `tent agent enter` (optional `--session` / `--key`) or `claim --session` |
| Process | ACP child under Tent service | Host agent product process (Claude, Codex, Grok, …) |

## External session CLI (verified)

```text
tent agent enter   → state=external registry row; no ACP spawn; idempotent
tent agent status  → open? + incompleteTasks
tent agent leave   → unbind only; delivered=false, accepted=false
```

- **leave never deliver/accept.** Finish work with `tent task deliver` / user accept as needed.
- Hook aliases: `tent agent session-start|session-status|session-end --host <agent>` (stable externalKey; non-Tent silent exit 0).
- External GUI sessions are metadata / orientation — not turned into ACP processes by this skill.

## Delivery is not accept

```text
claim → work → deliver → [user review] → accept | reject
```

- **deliver** = agent submits a Delivery (`dl-…`) with summary/commits.
- **accept** = user (or authorized actor) accepts that delivery.
- `deliveryPolicy: review` never auto-accepts on deliver.
- Managed auto-deliver still awaits policy/review — chat ending ≠ user accept.
- Agents must not flip box `status: done` to fake completion.

## Host tools stay with the host

1. Tent does **not** replace the host agent’s native tool-approval / permission UI.
2. Do not read or write host “agent permission” stores from this skill.
3. Tool allow/deny stays with the host product (managed ACP has a separate tool-approval path when applicable).

## Manifest is a context pointer (not permission work)

- V0.2 tent-agent does **not** own permission projection.
- Open files the envelope / manifest / box point at; do not treat manifest lists as an ACL taught by this skill.

## Mid-task I/O directions

- **A2U:** agent `tent task ask-user` → user `user-ask reply|deny`.
- **U2A:** user **or dispatcher** `tent task send-input` → executor `task-input list|get|ack`.
- Executor of task T must not self-`send-input` on T; a dispatcher may write U2A into a subordinate task.

## Managed bootstrap notes

When the first message is a Tent Context Card + user prompt:

- Service already claimed; final reply is the report.
- Prefer not to call `tent task claim|get|deliver` if tool policy denies them — the final text is enough for auto-deliver.
- Still fetch by id/path when you need box bodies; do not invent content from the card alone.

## Failure / unfinished leave

If you must leave mid-task:

1. Prefer an explicit summary in chat of what remains.
2. `tent agent leave` (if bound) — does not deliver.
3. Do **not** deliver a fake “done” unless the work is actually ready for review.
4. A partial delivery is allowed only when the summary honestly states remaining work and commits match reality.
