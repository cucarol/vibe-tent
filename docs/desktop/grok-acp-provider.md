# Grok ACP Provider（Desktop MVP）

The explicit live smoke test is `npm run test:grok-e2e`. It requires
`CPA_GROK_API_KEY` and `CPA_GROK_BASE_URL`, contacts the configured CPA service,
and exercises dispatch → managed ACP report → review accept. It is intentionally
excluded from the default offline `npm test` suite. The same command also stops
the first bridge process, restores its provider session through `session/load`,
and verifies that a second prompt can recover a nonce known only to the first turn.

Status: first **real** push-mode provider for Local Service  
Scope: machine-local `grok-acp` AgentProfile + ACP stdio adapter  
Non-scope: chat UI, universal provider router, implementing non-grok ACP bridges, storing secrets in workspace

## What Tent does (and does not)

| Tent owns | Provider owns |
| --- | --- |
| Task envelope / Context Card **pointers** | Model inference via Grok CLI + CPA |
| A2A gate → `task.startSession` | ACP stdio session lifecycle |
| `sessionId` reference on task only | Process PID, resume tokens (machine-local) |
| Runtime events (live / waiting / failed / exited) | Official Grok CLI UX for dialogue |

Tent is **not** a chat router. The adapter starts/observes/stops an external agent session; task context is driven by envelope + context pointers, not by pasting full box bodies into the session.

## Prerequisites (machine-local)

1. **Grok CLI** installed (typical Windows path: `%USERPROFILE%\.grok\bin\grok.exe`).
2. **CPA** reachable (local proxy / OpenAI-compatible endpoint).
3. **Environment variables** on the process that starts Local Service / Desktop (machine-local only):

| Env | Purpose | Default profile field |
| --- | --- | --- |
| `CPA_GROK_API_KEY` | API bearer for CPA | `acp.envKey` |
| `CPA_GROK_BASE_URL` | OpenAI-compatible base URL (e.g. `http://127.0.0.1:8317/v1`) | `acp.baseUrlEnvKey` |

Optional fallbacks (still **not** workspace):

- `~/.grok/config.toml` `[model."grok-4.5"]` `base_url` / `env_key` — Grok CLI native config when env base URL is unset.
- Machine-local `agent-profiles.json` may set `acp.baseUrl` (literal URL on **this machine only**) when the service cannot inherit a user shell env. Prefer env.

Pre-canonical on-disk field `grokAcp` is still **read** on load and migrated to canonical `acp` (atomic rewrite; no dual-write).

Tent **does not** store the API key, OAuth token, or CPA base URL in:

- workspace git / `.tent/`
- box / task / concept bodies
- committed repo files

`agent-profiles.json` lives under the **service data dir** (`%APPDATA%/Tent/`): only env key *names*, optional machine-local paths, and optionally a machine-local `baseUrl` — never commit this file with a workspace.

## Register machine-local profile

Profiles live under the service data dir (Windows default: `%APPDATA%/Tent/agent-profiles.json`).

On first service start, Tent ensures a `grok-acp-default` entry (alongside `fake-default` for tests):

```json
{
  "profiles": [
    {
      "id": "fake-default",
      "adapterId": "fake-cli",
      "displayNameKey": "profile.fake.default",
      "fake": { "waitForSignal": true, "emitStdout": true, "canResume": true }
    },
    {
      "id": "grok-acp-default",
      "adapterId": "grok-acp",
      "displayNameKey": "profile.grokAcp.default",
      "acp": {
        "model": "grok-4.5",
        "envKey": "CPA_GROK_API_KEY",
        "baseUrlEnvKey": "CPA_GROK_BASE_URL",
        "permissionPolicy": "deny"
      }
    }
  ]
}
```

Optional shared `acp` fields (canonical bag for all product `*-acp` profiles):

| Field | Default | Notes |
| --- | --- | --- |
| `executable` | `%USERPROFILE%\.grok\bin\grok.exe` (or `~/.grok/bin/grok`) | Absolute path on this machine |
| `model` | `grok-4.5` | Passed as `grok agent --model <model> stdio` |
| `envKey` | `CPA_GROK_API_KEY` | Read from **service process** env only |
| `baseUrlEnvKey` | `CPA_GROK_BASE_URL` | Env **name** for CPA base URL; value never written to workspace |
| `baseUrl` | _(unset)_ | Optional machine-local literal URL if env cannot be set; still not for git |
| `promptTimeoutMs` | 1800000 (30m) | ACP `session/prompt` wait |
| `permissionPolicy` | `deny` | `allow` \| `ask` \| `deny` — **never** unconditional yolo / `allow_always` |
| `permissionTimeoutMs` | 120000 | When `ask`, **store-authoritative** timeout → expire pending + ACP `cancelled`; late approve fails |

### How base URL is passed to Grok

When a base URL resolves (env or profile `baseUrl`), the adapter:

1. Adds `--xai-api-base-url <url>` on the `grok agent … stdio` argv (unless the launch plan already supplies a full custom argv without that flag shape).
2. Injects child env: `CPA_GROK_BASE_URL` (or configured key), `XAI_API_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `TENT_GROK_BASE_URL`.
3. Still injects API key as `CPA_GROK_API_KEY` + `XAI_API_KEY`.

Never hard-codes `api.x.ai`. Missing API key fails loud (Chinese error); missing base URL alone is allowed so `~/.grok/config.toml` can still own the endpoint.

`fake-default` remains available for **tests only** when harnesses pass `profileId: "fake-default"` explicitly. Product `task.startSession` / `task.dispatch` with `startSession: true` **requires** an explicit `profileId` — there is **no** silent fallback to fake or to a product default.

## Machine-local profile catalog CRUD (service)

Local Service owns a **single-process serial** catalog for `agent-profiles.json` (same path + atomic write as boot). Product CRUD accepts an **explicit ACP adapterId whitelist** only — **not** a universal provider router, no revision/etag, no profile change events in this version. All six listed adapters are registered and receive the same Local Service tool-approval bridge.

| RPC | Notes |
| --- | --- |
| `profile.list` | Editor-safe projection from the **injected catalog only** (no runtime/disk fallback); default hides `testOnly` (`includeTest: true` for harness) |
| `profile.get` | Same single-source projection for one id |
| `profile.create` | Top-level fields only (`{ id, adapterId?, displayName, … }`); default `adapterId=grok-acp` when omitted; **no** nested `profile` / `acp` / `grokAcp` object |
| `profile.update` | Top-level `{ id, …patch }` only; **id and adapterId immutable**; `null` clears optional fields; omitted/`undefined` keeps previous |
| `profile.delete` | Refuse if any **non-terminal** session uses the profile; terminal refs OK; built-in `*-default` ids are never deletable |

Successful profile mutations emit machine-local `profile.changed` events. Create/update
events carry the same safe profile projection returned by the RPC; delete carries only
the deleted id. Connected clients use the event as an invalidation signal and may
re-query `profile.list`; no secret value or raw environment map is included. Existing
sessions keep their launch-profile snapshot, while later starts use the updated catalog.

Machine-local A2A and tool-approval stores use persist-before-swap snapshots: a failed
atomic write leaves both the visible in-memory state and the prior disk state unchanged,
and cannot notify a tool waiter as approved/denied. Tool timeout is fail-closed: if its
expiry marker cannot be persisted, the live ACP request still resolves as expired rather
than hanging, while the stored row remains pending until a later successful expiry pass.

**Create `adapterId` whitelist:** `grok-acp` \| `codex-acp` \| `claude-acp` \| `antigravity-acp` \| `opencode-acp` \| `copilot-acp`. Unknown / `fake-cli` / `gemini-acp` → RpcError.

**Create defaults:** only `grok-acp` auto-fills `DEFAULT_GROK_MODEL` / `CPA_GROK_API_KEY` / `CPA_GROK_BASE_URL` env key names; other whitelist adapters default `permissionPolicy=deny` only (no invented model/envKey).

**Whitelist body fields:** `id` (create only), `adapterId` (create only), `displayName`, `model`, `executable`, `envKey`, `baseUrlEnvKey`, `baseUrl`, `permissionPolicy`, `promptTimeoutMs`, `permissionTimeoutMs`.

Unknown fields and dangerous keys (`apiKey` / `token` / `secret` / `env` / `command` / `args` / nested `acp` / `grokAcp` / …) are **rejected with RpcError** — never silently stripped and written. `baseUrl` must be absolute `http(s)` **without** username/password, query, or hash.

| Id | Create | Update | Delete |
| --- | --- | --- | --- |
| `fake-default` | no | no | no (tests only) |
| `*-acp-default` built-ins | n/a (only grok seeded today) | yes if present | **no** (even if not seeded) |
| other whitelist ACP profiles | yes | yes | yes (if no active session) |

**Mutation transaction:** build `next` from the previous snapshot → **atomic disk save(`next`)** (when persistence is enabled) → only then replace in-memory catalog + full runtime catalog. Write failure leaves disk, catalog, and runtime on the old values.

**When disk is written:** normal service boot (`ensureDefaultProfiles`) enables `persistToDisk`. Explicit `options.profiles` inject (tests / harness) sets `persistToDisk=false` — CRUD stays in-memory and **never** writes `dataDir/agent-profiles.json`.

New `startSession` sees the new config immediately; **live sessions are not hot-reconfigured**. Permission timeout lookup for `permissionPolicy=ask` reads the **current** runtime profile (not a boot-time closed-over array). Clearing a field with `null` removes it so adapter defaults apply again.

Editor projection may include non-secret fields above (including env **key names**, paths, timeouts). It must **not** return env maps or API key / token **values**.

## Role wiring

Roles stay in the **project** registry (`.tent/roles.json`). They do **not** embed provider secrets.

Optional machine-readable spawn authority on the role (default **deny**):

```json
{
  "name": "orchestrator",
  "prompt": "…",
  "a2aPolicy": "allow",
  "allowedProfiles": ["grok-acp-default"]
}
```

| Field | Role caller `task.startSession` |
| --- | --- |
| `a2aPolicy: allow` | May start only when `profileId` ∈ `allowedProfiles` |
| `a2aPolicy: ask` | Enters user confirmation (`a2a.ask`); user approve may override whitelist |
| `a2aPolicy: deny` (default / omitted) | Hard deny |
| `allowedProfiles` | Profile **ids** only (trim + de-dupe); never credentials |

User callers always allow (root authority; whitelist bypass). Ordinary RPC clients **cannot** elevate policy via an `a2aPolicy` param, and `a2aPolicyOverride` is rejected over RPC; service loads policy from the role registry. Mutate roles via user-only `registry.role.create|update|delete` (not by writing secrets into `roles.json`).

Example: use a role for collaboration identity; choose the machine profile at startSession:

```bash
# After dispatch + claim (or user startSession path)
# profileId is machine-local — not committed with the role
```

RPC sketch:

```json
{
  "method": "task.startSession",
  "params": {
    "workspaceId": "…",
    "taskPath": "temp/<role>/tasks/….md",
    "profileId": "grok-acp-default",
    "callerKind": "user"
  }
}
```

Optional `bootstrapPrompt` overrides the default **managed** bootstrap. If omitted, service builds:

1. Stable **Context Card** pointer (`workspaceRoot` / `systemRoot` / task path / id)
2. Near-field **user prompt** (envelope `## User Prompt` only — **not** box/manifest bodies)
3. Explicit managed instructions: **do not** run `tent task claim|get|deliver`; final assistant reply is auto-submitted as delivery

Clipboard / dispatch **relayPrompt** is separate: external manual agents still `tent task claim` then `tent task deliver`.

### Managed final response → delivery

| Step | Owner |
| --- | --- |
| Segment `agent_message_chunk` during `session/prompt`; delivery text = last non-empty segment after tool/status/thought seals | Shared `AcpClient` / assistant-report contract (thoughts & tools are diagnostics only) |
| On successful `end_turn` with non-empty final segment | Adapter emits `session.prompt_complete` |
| On empty / ACP error / timeout / stop / interrupt / non-`end_turn` | Emit `session.failed` or leave interrupted — **no** delivery |
| Map `session.prompt_complete` → `task.deliver` | Local Service (`mapRuntimeEventToService`) — same lifecycle as CLI deliver |
| Dedup | In-process key `sessionId::taskPath` + lifecycle authority (ready delivery / non-running state) |

`deliveryPolicy` wire values: **review** → pending independent accept/reject; **bypass** → auto-integrate; **agent-decide** without an integrate decision → **request-review** (never forge accept). Product terms: Review / Bypass / Agent Decide.

## Permission policy (tools)

ACP may send `session/request_permission`. Mapping:

| `permissionPolicy` | Behavior |
| --- | --- |
| `deny` (default) | Reply `cancelled` — tools not auto-approved; **tool-less managed tasks still complete** via final reply auto-deliver |
| `allow` | Select **`allow_once` only**; never `allow_always` |
| `ask` | Emit `session.waiting_user`; Local Service stores a **machine-local tool approval**; user must `approve once` / `deny`; **store** timeout → `expired` + ACP `cancelled` |

There is **no** “yolo / bypass all tools” mode in Tent’s adapter. Coding tasks that need tools may set machine-local profile `permissionPolicy: allow` (still `allow_once` only) or `ask` with user RPC — not unconditional always-allow.

### Tool approval timeout authority

There is **one** authoritative expiry: the Local Service `ToolApprovalStore` record (`expiresAt` / `waitForDecision` / `expireOne`). Profile `permissionTimeoutMs` is read **live** when the service opens a pending row — not snapshotted by the ACP client at session start.

| Layer | Role |
| --- | --- |
| `ToolApprovalStore` | Sole mutation authority for pending → approved / denied / expired. Mutations + `tool-approvals.json` persistence are **serialized**; persist uses **temp-file + rename**. Concurrent resolve/cancel/expire cannot resurrect a pending row. |
| `onPermissionAsk` bridge | Adds pending with live-profile `permissionTimeoutMs`, waits on store, maps `approved` → allow else deny. |
| ACP client (`AcpClient`) | Awaits the bridge callback only. **No** second permission timer / fail-safe deny. Stop / process exit still cancels hung waiters immediately so they do not leak. |
| Late `toolApproval.approveOnce` | **Fails** after expire/deny/cancel (`already expired` / `already …`). |

`pending` is durable only for crash-safe state accounting, not as a resumable tool
request. The ACP request, waiter, and provider process do not survive a Local Service
restart. On store recovery, every persisted `pending` row is therefore atomically
rewritten to `expired` with `resolvedBy: service-restart`; it remains queryable as
machine-local history but is never listed as pending or accepted by `approveOnce`.
During an orderly Local Service shutdown, the store first stops accepting new asks,
rewrites live pending rows to `denied` with `resolvedBy: service-shutdown`, and wakes
their waiters before ACP children stop. If that final persistence write fails, the
live waiters are still denied and their timers cleared; restart recovery then expires
the unchanged disk rows.

Do **not** invent a second client-side timeout outcome that can disagree with the store (e.g. client denies while store still pending, or client allows after store expired). Mid-session profile timeout changes must not cause an early client deny ahead of the store.

### A2A spawn approval vs tool permission approval

These are **two different gates**. Do not merge them.

| Gate | When | Store (machine-local) | RPC | Effect |
| --- | --- | --- | --- | --- |
| **A2A spawn** | Role caller `task.startSession` with `roles.json` `a2aPolicy: ask` | `a2a-approvals.json` under service data dir | `a2a.listPending` / user-only `a2a.resolve` | Whether a **new** managed session may start |
| **Tool permission** | Live ACP session, profile `permissionPolicy: ask`, agent sends `session/request_permission` | `tool-approvals.json` under service data dir | `toolApproval.listPending` / `get` / `approveOnce` / `deny` | Whether **one tool call** is `allow_once` or `cancelled` |

Rules:

1. Tool approvals are **user-only** (`actor` must be `user`). Agents cannot self-approve.
2. Pending tool approval projects task → `waiting` (`reason: user-input`) and session → `waiting-user`. Approve once → ACP `allow_once` + resume `running` / `live`. Deny or timeout → ACP `cancelled` + pending cleared (timeout status is **`expired`**).
3. Concurrent tool requests form a session-level wait barrier: resolving one request does **not** resume the task/session while another request for the same session remains pending.
4. Neither store is workspace collaboration data: **never** written into `.tent/` or git.
5. Default remains safe: no user decision never becomes auto-`allow`; missing bridge still denies.

### Tool approval RPC sketch

```json
{ "method": "toolApproval.listPending", "params": { "workspaceId": "…" } }
{ "method": "toolApproval.get", "params": { "approvalId": "ta-…" } }
{ "method": "toolApproval.approveOnce", "params": { "approvalId": "ta-…", "actor": "user" } }
{ "method": "toolApproval.deny", "params": { "approvalId": "ta-…", "actor": "user" } }
```

Pending item fields (projection only): `id`, `workspaceId`, `sessionId`, `taskId`/`taskPath`, `role`, `toolTitle`, optional `options`, `createdAt`/`expiresAt`. No stdout tails, tokens, or secrets.

## Fail-loud rules

If executable or `envKey` is missing / empty:

- Error is explicit (Chinese-capable message)
- **No** fallback to official xAI (`api.x.ai`)
- **No** fallback to `fake-cli`
- Session record → `failed`; bound task may project `failed`

CPA base URL misconfiguration: set `CPA_GROK_BASE_URL` (or profile `baseUrl` / `~/.grok/config.toml`). Tent does not invent `api.x.ai`.

## Failure cleanup & occupation release

Prompt/provider failure paths must leave **task / session / process** consistent:

1. Adapter stops the managed ACP child **before** (or as part of) emitting `session.failed` so no live orphan remains.
2. Service maps `session.failed` through core **`taskFail` only while the bound task is still pre-delivery active** (`running` / non-parked `waiting`): clears `wait` and **releases box occupation** (`owner`/`assignee` cleared, service-owned `doing` → `todo`).
3. **Session terminal is diagnostic** once Task is already `delivered` / `accepted` / `rejected`, after intentional seal/post-deliver stop (`stopReason=user`, including adapter `session.failed` "interrupted"), or after reject-resume park `waiting(external)`. Do not demote a published Delivery or cancel durable review-feedback.
4. `failed` is terminal non-active: the **same box** can be re-dispatched without manual frontmatter edits or `docs.fork`.
5. Duplicate failure/exit events are **idempotent** (no illegal second transition / double-release error). Prompt-failure and spontaneous child-exit share a single terminal emission (deduped in `GrokAcpClient`).
6. **Spontaneous Grok child exit** (process dies with no intentional `stop`, even when no JSON-RPC request is pending) still emits a managed terminal runtime event (`session.failed` for non-zero / abnormal signal). Service maps that to `taskFail` + occupation release when still pre-delivery — probe must not claim a live orphan.
7. Diagnostics may mention error class; never persist stdout dumps, resume tokens, API keys, or absolute secrets into task/box/approval UI.

## Lifecycle

| Event | Behavior |
| --- | --- |
| Desktop UI close | Does **not** stop agent sessions |
| Local Service stop / shutdown | Denies pending tool asks, clears their waiters/timers, then stops push children this service started |
| `task` interrupt / session stop | Graceful stop of ACP process; **no** forged delivery |
| `session.waiting_user` (tool ask) | Task `waiting(user-input)`; pending tool approval in service data dir |
| Tool approve once / deny / timeout | Resume or cancel tool; clear pending (timeout → store `expired`; late approve fails) |
| `session.prompt_complete` | Service auto-deliver (see above) |
| Spontaneous child exit | Terminal runtime event even with no pending RPC; deduped vs prompt failure / intentional stop |
| `session.failed` | Stop process (idempotent) → `taskFail` + occupation release **only** for pre-delivery active tasks; otherwise Session diagnostic only |
| PID / provider session id | Machine-local session registry only — **never** written into workspace task YAML beyond `sessionId` |

## Verification (dev)

```bash
# Offline unit/integration (mock ACP fixture — no CPA):
npx tsx --test test/grok-acp-adapter.test.ts

# Full suite:
npm run check
```

Do not point tests at real CPA or `api.x.ai`.

## Related contracts

- `docs/desktop/agent-runtime.md` — AgentRuntimePort, profiles, credentials
- `docs/desktop/task-api.md` — `task.startSession`, A2APolicy, `sessionId` reference only
- `docs/desktop/architecture.md` — sole service mutation, machine-local data placement
