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
2. **CPA custom model** in `~/.grok/config.toml` (example shape — managed by Grok/CPA, not Tent):
   - model id `grok-4.5` → base URL `http://127.0.0.1:8317/v1`
   - `env_key = "CPA_GROK_API_KEY"`
3. **Environment variable** on the process that starts Local Service:
   - `CPA_GROK_API_KEY=<your key>`
4. CPA proxy / local adapter reachable at the URL in config.toml.

Tent **does not** store the API key, OAuth token, or CPA base URL in:

- workspace git / `.tent/`
- box / task / concept bodies
- `agent-profiles.json` values (only the env key *name* and paths)

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
| `promptTimeoutMs` | 1800000 (30m) | ACP `session/prompt` wait |
| `permissionPolicy` | `deny` | `allow` \| `ask` \| `deny` — **never** unconditional yolo / `allow_always` |
| `permissionTimeoutMs` | 120000 | When `ask`, timeout → deny |

`fake-default` remains the **test** default for harnesses. Product `task.startSession` should pass `profileId: "grok-acp-default"` (or your custom id) when you want the real provider.

## Role wiring

Roles stay in the **project** registry (`.tent/roles.json`). They do **not** embed provider secrets.

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
    "callerKind": "user",
    "a2aPolicy": "allow"
  }
}
```

Optional `bootstrapPrompt` overrides the default **pointer** bootstrap (Context Card + relay). If omitted, service builds a short pointer text — it does **not** copy the full task/box body.

## Permission policy (tools)

ACP may send `session/request_permission`. Mapping:

| `permissionPolicy` | Behavior |
| --- | --- |
| `deny` (default) | Reply `cancelled` — tools not auto-approved |
| `allow` | Select **`allow_once` only**; never `allow_always` |
| `ask` | Emit `session.waiting_user`; without a UI grant, timeout → deny |

There is **no** “yolo / bypass all tools” mode in Tent’s adapter.

## Fail-loud rules

If executable or `envKey` is missing / empty:

- Error is explicit (Chinese-capable message)
- **No** fallback to official xAI (`api.x.ai`)
- **No** fallback to `fake-cli`
- Session record → `failed`; bound task may project `failed`

CPA base URL misconfiguration is owned by `~/.grok/config.toml`, not Tent.

## Lifecycle

| Event | Behavior |
| --- | --- |
| Desktop UI close | Does **not** stop agent sessions |
| Local Service stop / shutdown | Stops push children this service started |
| `task` interrupt / session stop | Graceful stop of ACP process |
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
