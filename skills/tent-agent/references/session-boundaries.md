# Session boundaries and permissions

## Two session styles

| | Managed ACP | External / relay |
| --- | --- | --- |
| Start | Desktop / service `task.startSession` | Human clipboard, pull-host, manual terminal |
| Claim | Service claims first | Agent runs `tent task claim` |
| Deliver | Service captures final assistant reply → `task.deliver` | Agent runs `tent task deliver` |
| Session id | Service-owned `ss-…` | Optional bind via `tent agent enter` / claim `--session` |
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

## External session is not permission takeover

1. Tent does **not** replace the host agent’s native permission / tool-approval UI.
2. External GUI sessions registered with Tent are **metadata / orientation** — they do not become ACP processes through `tent agent *`.
3. Do not read or write host “agent permission” stores from this skill. Tool allow/deny stays with the host product (and, for managed ACP, Tent’s separate tool-approval path when that session is managed).
4. `tent agent leave` only ends or unbinds the external session binding and may report unfinished tasks. It never:
   - delivers
   - accepts
   - rejects
   - cancels the task by implication

## Manifest is honor, not sandbox

- `readable` / `writable` on the task manifest are an honor contract for Tent files.
- Host FS tools may still see more; agents should still respect the contract.
- If the user prompt asks for writes outside writable, stop and ask.

## Managed bootstrap notes

When the first message is a Tent Context Card + user prompt:

- Service already claimed; final reply is the report.
- Prefer not to call `tent task claim|get|deliver` if tool policy denies them — the final text is enough for auto-deliver.
- Still fetch by id/path when you need box bodies; do not invent content from the card alone.

## Failure / unfinished leave

If you must leave mid-task:

1. Prefer an explicit summary in chat of what remains.
2. `tent agent leave` (if bound).
3. Do **not** deliver a fake “done” unless the work is actually ready for review.
4. A partial delivery is allowed only when the summary honestly states remaining work and commits match reality.
