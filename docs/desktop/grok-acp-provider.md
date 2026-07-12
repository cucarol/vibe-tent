# Grok ACP Provider（Desktop MVP）

Status: first **real** push-mode provider for Local Service  
Scope: machine-local `grok-acp` AgentProfile + ACP stdio adapter  
Non-scope: chat UI, multi-provider router, Codex/Claude adapters, storing secrets in workspace

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
| `CPA_GROK_API_KEY` | API bearer for CPA | `grokAcp.envKey` |
| `CPA_GROK_BASE_URL` | OpenAI-compatible base URL (e.g. `http://127.0.0.1:8317/v1`) | `grokAcp.baseUrlEnvKey` |

Optional fallbacks (still **not** workspace):

- `~/.grok/config.toml` `[model."grok-4.5"]` `base_url` / `env_key` — Grok CLI native config when env base URL is unset.
- Machine-local `agent-profiles.json` may set `grokAcp.baseUrl` (literal URL on **this machine only**) when the service cannot inherit a user shell env. Prefer env.

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
      "grokAcp": {
        "model": "grok-4.5",
        "envKey": "CPA_GROK_API_KEY",
        "baseUrlEnvKey": "CPA_GROK_BASE_URL",
        "permissionPolicy": "deny"
      }
    }
  ]
}
```

Optional `grokAcp` fields:

| Field | Default | Notes |
| --- | --- | --- |
| `executable` | `%USERPROFILE%\.grok\bin\grok.exe` (or `~/.grok/bin/grok`) | Absolute path on this machine |
| `model` | `grok-4.5` | Passed as `grok agent --model <model> stdio` |
| `envKey` | `CPA_GROK_API_KEY` | Read from **service process** env only |
| `baseUrlEnvKey` | `CPA_GROK_BASE_URL` | Env **name** for CPA base URL; value never written to workspace |
| `baseUrl` | _(unset)_ | Optional machine-local literal URL if env cannot be set; still not for git |
| `promptTimeoutMs` | 1800000 (30m) | ACP `session/prompt` wait |
| `permissionPolicy` | `deny` | `allow` \| `ask` \| `deny` — **never** unconditional yolo / `allow_always` |
| `permissionTimeoutMs` | 120000 | When `ask`, timeout → deny |

### How base URL is passed to Grok

When a base URL resolves (env or profile `baseUrl`), the adapter:

1. Adds `--xai-api-base-url <url>` on the `grok agent … stdio` argv (unless the launch plan already supplies a full custom argv without that flag shape).
2. Injects child env: `CPA_GROK_BASE_URL` (or configured key), `XAI_API_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `TENT_GROK_BASE_URL`.
3. Still injects API key as `CPA_GROK_API_KEY` + `XAI_API_KEY`.

Never hard-codes `api.x.ai`. Missing API key fails loud (Chinese error); missing base URL alone is allowed so `~/.grok/config.toml` can still own the endpoint.

`fake-default` remains available for **tests only** when harnesses pass `profileId: "fake-default"` explicitly. Product `task.startSession` / `task.dispatch` with `startSession: true` **requires** an explicit `profileId` — there is **no** silent fallback to fake or to a product default.

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
| `ask` | Emit `session.waiting_user`; without a UI grant, timeout → deny |

There is **no** “yolo / bypass all tools” mode in Tent’s adapter. Coding tasks that need tools may set machine-local profile `permissionPolicy: allow` (still `allow_once` only) or future UI `ask` — not unconditional always-allow.

## Fail-loud rules

If executable or `envKey` is missing / empty:

- Error is explicit (Chinese-capable message)
- **No** fallback to official xAI (`api.x.ai`)
- **No** fallback to `fake-cli`
- Session record → `failed`; bound task may project `failed`

CPA base URL misconfiguration: set `CPA_GROK_BASE_URL` (or profile `baseUrl` / `~/.grok/config.toml`). Tent does not invent `api.x.ai`.

## Lifecycle

| Event | Behavior |
| --- | --- |
| Desktop UI close | Does **not** stop agent sessions |
| Local Service stop / shutdown | Stops push children this service started |
| `task` interrupt / session stop | Graceful stop of ACP process; **no** forged delivery |
| `session.prompt_complete` | Service auto-deliver (see above) |
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
