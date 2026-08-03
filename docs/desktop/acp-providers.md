# ACP Providers (Desktop MVP)

Tent exposes a small, explicit set of coding-agent ACP adapters. It is not a universal CLI router: each provider owns its launch contract, while the shared ACP layer only handles stdio JSON-RPC, permission requests, lifecycle events, and the final report.

## Verification honesty

`provider.catalog` is the sole product badge source. Levels mean:

| Level | Meaning |
| --- | --- |
| `adapter-implemented` | Launch contract coded; no mock/live suite claim |
| `mock-tested` | Offline mock ACP suite covers launch/protocol |
| `opt-in-live-probe` | Checked-in opt-in live script/probe exists; **not** CI-always and **not** “this machine is certified” |
| `live-verified` | Durable proof on the **current** operator machine (catalog rarely uses this as a static badge) |

**Having a script is not full certification.** UI must not upgrade `opt-in-live-probe` to “live verified”.

| Adapter | Launch contract | Authentication | Repository verification |
| --- | --- | --- | --- |
| `grok-acp` | Local Grok executable in ACP stdio mode, using isolated Grok config plus Grok2API dual base-URL flags | Grok2API key and base URL from service process env | `opt-in-live-probe` — mock suite + `npm run test:grok-e2e` |
| `codex-acp` | `npx --yes @agentclientprotocol/codex-acp` | Agent-owned local authentication/configuration; optional Launch Secret injection | `opt-in-live-probe` — mock suite + `npm run test:foreground-e2e` |
| `claude-acp` | `npx --yes @agentclientprotocol/claude-agent-acp@0.62.0` | Agent-owned local authentication/configuration; optional Launch Secret injection | `opt-in-live-probe` — mock suite + `test:foreground-e2e` (bridge may need Node ≥22) |
| `opencode-acp` | Native `opencode acp` | Agent-owned local authentication/configuration; optional Launch Secret injection | `opt-in-live-probe` — mock suite + `test:foreground-e2e` |
| `copilot-acp` | `npx --yes @github/copilot --acp --stdio` | Agent-owned local authentication/configuration; optional Launch Secret injection | `opt-in-live-probe` — mock suite + `test:foreground-e2e` |
| `pi-acp` | `npx --yes pi-acp` (third-party bridge; spawns `pi --mode rpc`) | Agent-owned local authentication/configuration; optional Launch Secret injection | `mock-tested` — offline mock suite; initialize/`session/new` probe when `pi` is installed; no paid live E2E in default CI |

An adapter appearing in this table means its explicit launch contract is implemented;
it does **not** mean every provider binary, account flow, or host platform is live-certified
by the repository. The default suite is offline and mock-backed.

## Machine-local Launch Secrets

Tent does not manage provider accounts, switch logins, refresh OAuth, or infer an
Agent's authentication method. Authentication belongs to the Agent and the user's
local setup. When a launch contract explicitly needs one secret environment value,
the Local Service can resolve a non-secret `launchSecretRef` from its encrypted
machine-local Launch Secret store. This is a process-launch boundary, not an
account manager: plaintext is never returned by RPC or persisted in workspace
state, Connection JSON, Session records, events, or logs.

ACP v1 `agent` authentication remains Agent-owned even when Tent invokes the
advertised method id. Tent does not interpret it as OAuth or API-key auth. The
Local Service does not advertise preview terminal-auth capability and never sends
a `terminal` method through the in-band `authenticate` RPC.

Pi uses the third-party `pi-acp` npm bridge (not an official Earendil ACP binary). The bridge requires `pi` (`@earendil-works/pi-coding-agent`) on PATH and currently documents Node ≥22 for the pi CLI even though Tent itself supports Node.js 20.

The Claude Agent ACP npm bridge currently requires Node.js 22 or newer even though Tent itself supports Node.js 20. A machine running Node 20 can use the rest of Tent, but must upgrade Node or configure another executable before launching `claude-acp`.

## Agent Connection rules

- Connections are machine-local and store only non-secret launch metadata: provider/adapter, executable or command, model, endpoint identity, environment key names, Skills/MCP references, and permission/time-out settings.
- Secret values are read from `LaunchPlan.env` or the Local Service process environment. They are never written to a workspace, Node, Task, Delivery, Connection JSON, or Session record.
- Omitting `envKey` leaves authentication entirely to the Agent's local configuration.
- Pairing `envKey` with `launchSecretRef` injects that secret only into the child;
  a missing reference fails before spawn.
- Tool permission policy defaults to `deny`. `ask` uses the same machine-local approval store for every ACP provider.

## Provider-native session resume (`session/load` vs `session/resume`)

Tent only advertises `capabilities.canResume = true` for bridges whose ACP `initialize` has been verified to support a **native** restore path. Resume is **not** a re-wrapped `session/new`. The restore **transport** is provider-selectable:

| Transport | Wire method | Capability gate (live `initialize`) | History |
| --- | --- | --- | --- |
| **`load`** (default) | `session/load` | `agentCapabilities.loadSession === true` | May stream full transcript; Tent quarantines it and never delivers it |
| **`resume`** | `session/resume` | `agentCapabilities.sessionCapabilities.resume` is an object (including `{}`) | **No** history replay (Tent is not a transcript UI) |

| Adapter | `canResume` | Resume path | Evidence |
| --- | --- | --- | --- |
| `grok-acp` | **true** | `resumeManagedSession` → new bridge process → `initialize` → optional `authenticate` → **`session/load`** | Local `grok agent stdio` initialize handshake |
| `opencode-acp` | **true** | same (`session/load`) | Local `opencode acp` initialize handshake |
| `codex-acp` | **true** | same (`session/load`; no ACP `authenticate` RPC; auth via env/`DEFAULT_AUTH_REQUEST` or local login) | 2026-07-21 initialize-only probe: `@agentclientprotocol/codex-acp@1.1.5` advertises `agentCapabilities.loadSession=true`; native CLI has resume; bridge source shows ACP `sessionId` homologous with CLI resume |
| `claude-acp` | **true** | **`session/resume`** (not `session/load`; no ACP `authenticate` RPC; local Claude login and/or injected env) | `@agentclientprotocol/claude-agent-acp@0.62.0` advertises `sessionCapabilities.resume` and implements `session/resume` via `getOrCreateSession` **without** `replaySessionHistory`; `session/load` additionally replays the full transcript and has failed large Opus sessions with opaque Internal error |
| `copilot-acp` | **true** | `session/load` (local Copilot/`gh` login and/or injected env) | 2026-07-21 initialize-only probe: GitHub Copilot CLI/ACP **1.0.73** advertises `agentCapabilities.loadSession=true`; native CLI has resume; high confidence ACP `sessionId` is homologous with CLI resume |
| `pi-acp` | **true** | `session/load` (no ACP `authenticate` RPC required for local pi login; optional Launch Secret injection) | 2026-07-23: `pi-acp@0.0.31` initialize advertises `agentCapabilities.loadSession=true`; `session/new` returns ACP sessionId when `pi` (`@earendil-works/pi-coding-agent`) is on PATH; bridge stores map under `~/.pi/pi-acp/` |

Rules:

1. **Runtime gate:** each restore call checks **this** process’s `initialize` result for the transport it selected (`loadSession` or `sessionCapabilities.resume`). Missing capability fails loud; Tent never falls back to `session/new` (or the other transport) while pretending to resume.
2. **RPC shape:** both `session/load` and `session/resume` send `{ sessionId, cwd, mcpServers }` from the immutable non-secret Connection snapshot captured at start. Empty MCP and Skill lists stay canonical. Optional Skill refs go under `_meta.tent.skills` as Tent metadata only; this is provider-dependent and never embeds Skill bodies. Enabled path refs are validated and fail loud when missing. Editing the live Connection never reinterprets an already-started Session.
3. **Token:** machine-local `SessionRecord.resumeToken` is the provider ACP `sessionId` from `session/new`. After restore, Tent keeps the **same** `providerSessionId`. Tasks still store only Tent `ss-` ids.
4. **History isolation:** `session/load` may stream full conversation history via `session/update`. Those notifications are quarantined until replay is quiet, are not projected as transcript diagnostics, and **must not** enter the next prompt’s `assistantText` or trigger `session.prompt_complete` / auto-`task.deliver`. `session/resume` must not replay history; Tent does not wait for load-style quiescence on that path.
5. **Final-report segment contract:** during an in-flight `session/prompt`, contiguous `agent_message_chunk` text forms one segment; tool/status/thought (and any other non-message update) seals the open segment. `session.prompt_complete.assistantText` / Delivery.summary is the **last non-empty segment**. A single uninterrupted stream falls back to that full body so summary is never empty when real final text exists. Providers share this contract in `AcpClient` — do not re-implement fragile string cleaning in the Delivery store.
6. **Process model:** resume always spawns a **new** bridge process (managed handles do not survive service restart). `AgentRuntime.resumeSession` reuses the same Tent `sessionId` + original provider token.
7. **Exact-Task continuity:** only the Session already bound to the exact Task may resume. Resume uses its immutable Connection snapshot, recorded provider token, Task lane, and native load capability. Missing or corrupt identity parks the Task at `session_unavailable`; it never starts fresh while claiming continuity. `task.replaceSession` is the explicit fresh path for an eligible Task.
8. **Concurrency and privacy:** concurrent resume calls for one Tent Session share one in-flight operation. Provider session ids are redacted from projected errors and never enter Task, Node, Delivery, or UI payloads. Safe RPC diagnostics may retain bounded scalar details so an opaque provider error still carries a usable reason.
9. **Honest support surface:** only adapters in `provider.catalog` are supported. Retired or unknown adapter ids are rejected instead of being retained as compatibility aliases.

The default test suite uses `test/fixtures/mock-acp-server.mjs` and never launches provider binaries, `npx`, or a paid network request. Opt-in live paths:

- `npm run test:grok-e2e` — Grok dispatch/delivery and stop → native load → prior-context recovery
- `npm run test:foreground-e2e` — multi-provider native CLI roundtrip (`TENT_LIVE_PROVIDERS=…`)

Tool permission policy `ask` records pending approvals only when the managed session row has a non-empty `workspace` id. Missing session workspace **fails closed** (`deny`); Tent never binds the approval to the Desktop **foreground** workspace as a guess.

`gemini-acp` remains intentionally absent from the product whitelist.
