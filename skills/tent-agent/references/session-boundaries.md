# Session boundaries

## Two session styles

| | Managed ACP | External / relay |
| --- | --- | --- |
| Start | Desktop / service `task.startSession` | Human clipboard, pull-host, manual terminal |
| Claim | Service claims first | Agent runs `tent task claim` |
| Deliver | Service captures final assistant reply → `task.deliver` | Agent runs `tent task deliver` |
| Session id | Service-owned `ss-…` | Optional via `claim --session` when the host provides one |
| Process | ACP child under Tent service | Host agent product process (Claude, Codex, Grok, …) |

## Delivery is not accept

```text
claim → work → deliver → [user review] → accept | reject
```

- **deliver** = agent submits a Delivery (`dl-…`) with summary/commits.
- **accept** = user (or authorized actor) accepts that delivery; only then is the attempt complete for collaboration purposes.
- `deliveryPolicy: manual` never auto-accepts on deliver.
- Managed auto-deliver still lands as a delivery awaiting policy/review — chat ending ≠ user accept.
- Agents must not flip box `status: done` to fake completion.

## Host tools stay with the host

1. Tent does **not** replace the host agent’s native tool-approval / permission UI.
2. External GUI sessions registered with Tent are orientation / metadata — they are not turned into ACP processes by this skill.
3. Do not read or write host “agent permission” stores from this skill.
4. There is no `tent agent leave` command on the current CLI. Ending a host session does **not** deliver, accept, reject, or cancel the task by implication — use `tent task deliver` (or leave the task running) explicitly.

## Manifest is a context pointer (not permission work)

- V0.2 tent-agent does **not** own permission projection.
- Open files the envelope / manifest / box point at; do not treat manifest `readable` / `writable` lists as an ACL or honor-permission sandbox taught by this skill.
- Host FS tools and product policy remain outside this document.

## Mid-task I/O directions

- **A2U:** agent `tent task ask-user` → user `user-ask reply|deny`.
- **U2A:** user `tent task send-input` → agent `task-input list|get|ack` (managed path may inject into the same ACP session).
- Agents never `send-input` to themselves.

## Managed bootstrap notes

When the first message is a Tent Context Card + user prompt:

- Service already claimed; final reply is the report.
- Prefer not to call `tent task claim|get|deliver` if tool policy denies them — the final text is enough for auto-deliver.
- Still fetch by id/path when you need box bodies; do not invent content from the card alone.

## Failure / unfinished exit

If you must stop mid-task:

1. Prefer an explicit summary in chat of what remains.
2. Do **not** deliver a fake “done” unless the work is actually ready for review.
3. A partial delivery is allowed only when the summary honestly states remaining work and commits match reality.
