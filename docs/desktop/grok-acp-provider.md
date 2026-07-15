# Grok ACP Provider（Desktop MVP）

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
  "a2aPolicy": "ask"
}
```

| `a2aPolicy` | Role caller `task.startSession` |
| --- | --- |
| `allow` | May start authorized AgentProfiles |
| `ask` | Enters user confirmation (`a2a.ask`) |
| `deny` (default / omitted) | Hard deny |

User callers always allow. Ordinary RPC clients **cannot** elevate policy via an `a2aPolicy` param; service loads policy from the role registry. Trusted harness may pass `a2aPolicyOverride` only.

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
| Accumulate `agent_message_chunk` during `session/prompt` | `GrokAcpClient` (thoughts are diagnostics only) |
| On successful `end_turn` with non-empty text | Adapter emits `session.prompt_complete` |
| On empty / ACP error / timeout / stop / interrupt / non-`end_turn` | Emit `session.failed` or leave interrupted — **no** delivery |
| Map `session.prompt_complete` → `task.deliver` | Local Service (`mapRuntimeEventToService`) — same lifecycle as CLI deliver |
| Dedup | In-process key `sessionId::taskPath` + lifecycle authority (ready delivery / non-running state) |

`deliveryPolicy` is unchanged: **manual** → pending review; **bypass** → auto-integrate; **agent-decide** without an integrate decision → **request-review** (never forge accept).

## Permission policy (tools)

ACP may send `session/request_permission`. Mapping:

| `permissionPolicy` | Behavior |
| --- | --- |
| `deny` (default) | Reply `cancelled` — tools not auto-approved; **tool-less managed tasks still complete** via final reply auto-deliver |
| `allow` | Select **`allow_once` only**; never `allow_always` |
| `ask` | Emit `session.waiting_user`; Local Service stores a **machine-local tool approval**; user must `approve once` / `deny`; **store** timeout → `expired` + ACP `cancelled` |

There is **no** “yolo / bypass all tools” mode in Tent’s adapter. Coding tasks that need tools may set machine-local profile `permissionPolicy: allow` (still `allow_once` only) or `ask` with user RPC — not unconditional always-allow.

### Tool approval timeout authority

There is **one** authoritative expiry: the Local Service `ToolApprovalStore` record (`expiresAt` / `waitForDecision` / `expireOne`).

| Layer | Role |
| --- | --- |
| `ToolApprovalStore` | Sole mutation authority for pending → approved / denied / expired. Mutations + `tool-approvals.json` persistence are **serialized**; persist uses **temp-file + rename**. Concurrent resolve/cancel/expire cannot resurrect a pending row. |
| `onPermissionAsk` bridge | Adds pending, waits on store, maps `approved` → allow else deny. |
| `GrokAcpClient` fail-safe | Only if the service bridge hangs past `permissionTimeoutMs + slack` (default +5s). Must **expire/cancel the same store item** — never leave an approvable pending while ACP already cancelled. |
| Late `toolApproval.approveOnce` | **Fails** after expire/deny/cancel (`already expired` / `already …`). |

Do **not** invent a second client-side timeout outcome that can disagree with the store (e.g. client denies while store still pending, or client allows after store expired).

### A2A spawn approval vs tool permission approval

These are **two different gates**. Do not merge them.

| Gate | When | Store (machine-local) | RPC | Effect |
| --- | --- | --- | --- | --- |
| **A2A spawn** | Role caller `task.startSession` with `roles.json` `a2aPolicy: ask` | `a2a-approvals.json` under service data dir | `a2a.listPending` / `a2a.resolve` | Whether a **new** managed session may start |
| **Tool permission** | Live ACP session, profile `permissionPolicy: ask`, agent sends `session/request_permission` | `tool-approvals.json` under service data dir | `toolApproval.listPending` / `get` / `approveOnce` / `deny` | Whether **one tool call** is `allow_once` or `cancelled` |

Rules:

1. Tool approvals are **user-only** (`actor` must be `user`). Agents cannot self-approve.
2. Pending tool approval projects task → `waiting` (`reason: user-input`) and session → `waiting-user`. Approve once → ACP `allow_once` + resume `running` / `live`. Deny or timeout → ACP `cancelled` + pending cleared (timeout status is **`expired`**).
3. Neither store is workspace collaboration data: **never** written into `.tent/` or git.
4. Default remains safe: no user decision never becomes auto-`allow`; missing bridge still denies.

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
2. Service maps `session.failed` through core **`taskFail`**: `running|waiting → failed`, clears `wait`, and **releases box occupation** (`owner`/`assignee` cleared, service-owned `doing` → `todo`).
3. `failed` is terminal non-active: the **same box** can be re-dispatched without manual frontmatter edits or `docs.fork`.
4. Duplicate failure/exit events are **idempotent** (no illegal second transition / double-release error). Prompt-failure and spontaneous child-exit share a single terminal emission (deduped in `GrokAcpClient`).
5. **Spontaneous Grok child exit** (process dies with no intentional `stop`, even when no JSON-RPC request is pending) still emits a managed terminal runtime event (`session.failed` for non-zero / abnormal signal). Service maps that to `taskFail` + occupation release — probe must not claim a live orphan.
6. Diagnostics may mention error class; never persist stdout dumps, resume tokens, API keys, or absolute secrets into task/box/approval UI.

## Lifecycle

| Event | Behavior |
| --- | --- |
| Desktop UI close | Does **not** stop agent sessions |
| Local Service stop / shutdown | Stops push children this service started |
| `task` interrupt / session stop | Graceful stop of ACP process; **no** forged delivery |
| `session.waiting_user` (tool ask) | Task `waiting(user-input)`; pending tool approval in service data dir |
| Tool approve once / deny / timeout | Resume or cancel tool; clear pending (timeout → store `expired`; late approve fails) |
| `session.prompt_complete` | Service auto-deliver (see above) |
| Spontaneous child exit | Terminal runtime event even with no pending RPC; deduped vs prompt failure / intentional stop |
| `session.failed` | Stop process (idempotent) → `taskFail` + occupation release |
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
