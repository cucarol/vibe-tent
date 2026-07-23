# ACP Providers (Desktop MVP)

Tent exposes a small, explicit set of coding-agent ACP adapters. It is not a universal CLI router: each provider owns its launch contract, while the shared ACP layer only handles stdio JSON-RPC, permission requests, lifecycle events, and the final report.

| Adapter | Launch contract | Authentication | Repository verification |
| --- | --- | --- | --- |
| `grok-acp` | Local Grok executable in ACP stdio mode | CPA/Grok key and base URL from service process env | Mock suite + opt-in live E2E |
| `codex-acp` | `npx --yes @agentclientprotocol/codex-acp` | Existing Codex/ChatGPT login, or explicit `envKey` injected through `DEFAULT_AUTH_REQUEST` | Mock launch/protocol suite; local loadSession initialize evidence below |
| `claude-acp` | `npx --yes @agentclientprotocol/claude-agent-acp` | Existing Claude login, or an explicitly configured process `envKey` | Mock launch/protocol suite; local loadSession initialize evidence below |
| `antigravity-acp` | Separately installed third-party `agy-acp` bridge | Bridge/`agy` local authentication, plus optional explicit process `envKey` | Mock launch/protocol suite |
| `opencode-acp` | Native `opencode acp` | OpenCode's local provider configuration, plus optional explicit process `envKey` | Mock suite; local resume handshake evidence below |
| `copilot-acp` | `npx --yes @github/copilot --acp --stdio` | Existing Copilot/`gh` login, plus optional explicit process `envKey` | Mock launch/protocol suite; local loadSession initialize evidence below |

An adapter appearing in this table means its explicit launch contract is implemented;
it does **not** mean every provider binary, account flow, or host platform is live-certified
by the repository. The default suite is offline and mock-backed. Grok is currently the only
provider with a checked-in opt-in live E2E command; other providers require machine-local
verification before being advertised as live-tested.

## Machine-local credentials (Windows MVP)

The Local Service exposes `credential.list`, `credential.set`, and
`credential.delete`. Secret values are protected with Windows CurrentUser DPAPI
and stored only as ciphertext under the service data directory. There is no RPC
that returns plaintext. An ACP profile may store a non-secret `credentialRef`
alongside its `envKey`; the runtime resolves that reference only while building
the child process environment. Secrets never enter the workspace, profile JSON,
session records, events, or logs. Missing references fail the session launch
loudly. Non-Windows hosts do not use a weak fallback.

`gemini-acp` is intentionally absent. Antigravity uses the official `agy` CLI, but `agy` currently has no native ACP entrypoint; Tent therefore launches the third-party `agy-acp` executable and never starts `agy` directly. The bridge remains responsible for its own local conversation state. In particular, verify the bridge supports the host platform before selecting the default profile.

The Claude Agent ACP npm bridge currently requires Node.js 22 or newer even though Tent itself supports Node.js 20. A machine running Node 20 can use the rest of Tent, but must upgrade Node or configure another executable before launching `claude-acp`.

## Profile Rules

- Profiles are machine-local and store only executable paths, model hints, env key names, and permission/time-out settings.
- Secret values are read from `LaunchPlan.env` or the Local Service process environment. They are never written to a workspace, task, box, report, or profile JSON.
- Omitting `envKey` means the adapter relies on the provider's existing local login/configuration.
- Configuring `envKey` makes it required; a missing value fails before spawn.
- Tool permission policy defaults to `deny`. `ask` uses the same machine-local approval store for every ACP provider.

## Provider-native session resume (`session/load`)

Tent only advertises `capabilities.canResume = true` for bridges whose ACP `initialize` has been verified to set `agentCapabilities.loadSession: true`. Resume is **not** a re-wrapped `session/new`.

| Adapter | `canResume` | Resume path | Evidence |
| --- | --- | --- | --- |
| `grok-acp` | **true** | `resumeManagedSession` → new bridge process → `initialize` → optional `authenticate` → **`session/load`** | Local `grok agent stdio` initialize handshake |
| `opencode-acp` | **true** | same | Local `opencode acp` initialize handshake |
| `codex-acp` | **true** | same (no ACP `authenticate` RPC; auth via env/`DEFAULT_AUTH_REQUEST` or local login) | 2026-07-21 initialize-only probe: `@agentclientprotocol/codex-acp@1.1.5` advertises `agentCapabilities.loadSession=true`; native CLI has resume; bridge source shows ACP `sessionId` homologous with CLI resume |
| `claude-acp` | **true** | same (no ACP `authenticate` RPC; local Claude login and/or injected env) | 2026-07-21 initialize-only probe: `@agentclientprotocol/claude-agent-acp@0.60.0` advertises `agentCapabilities.loadSession=true`; native CLI has resume; bridge source shows ACP `sessionId` homologous with CLI resume |
| `copilot-acp` | **true** | same (local Copilot/`gh` login and/or injected env) | 2026-07-21 initialize-only probe: GitHub Copilot CLI/ACP **1.0.73** advertises `agentCapabilities.loadSession=true`; native CLI has resume; high confidence ACP `sessionId` is homologous with CLI resume |
| `antigravity-acp` | **false** | none | Not verified — third-party `agy-acp` loadSession still unproven on this host |

Rules:

1. **Runtime gate:** each load call checks **this** process’s `initialize` result for `agentCapabilities.loadSession === true`. Missing capability fails loud; Tent never falls back to `session/new` while pretending to resume.
2. **RPC shape:** `session/load` always sends required `{ sessionId, cwd, mcpServers }`. `mcpServers` comes from the session start/resume **profile snapshot** (AgentProfile `mcpServers` resolved with envKey/credentialRef at launch). Empty list when the profile has no enabled MCP servers. Optional skill name/path refs go under `_meta.tent.skills` as **Tent metadata only** (never SKILL.md bodies; not a claim that every provider activates skills from this field). Enabled skill path refs are validated at start/resume and fail loud when missing; name-only refs remain allowed. Running sessions do not hot-reload profile edits.
3. **Token:** machine-local `SessionRecord.resumeToken` is the provider ACP `sessionId` from `session/new`. Tasks still store only Tent `ss-` ids.
4. **History isolation:** load may stream full conversation history via `session/update`. Those notifications are quarantined until replay is quiet, are not projected as transcript diagnostics, and **must not** enter the next prompt’s `assistantText` or trigger `session.prompt_complete` / auto-`task.deliver`.
5. **Final-report segment contract:** during an in-flight `session/prompt`, contiguous `agent_message_chunk` text forms one segment; tool/status/thought (and any other non-message update) seals the open segment. `session.prompt_complete.assistantText` / Delivery.summary is the **last non-empty segment**. A single uninterrupted stream falls back to that full body so summary is never empty when real final text exists. Providers share this contract in `AcpClient` — do not re-implement fragile string cleaning in the Delivery store.
5. **Process model:** resume always spawns a **new** bridge process (managed handles do not survive service restart). `AgentRuntime.resumeSession` reuses the same Tent `sessionId` + original provider token.
6. **Service reuse:** after restart, a waiting task may resume only when its old machine-local session matches the requested profile, workspace, role, task binding, and lane cwd. A missing or mismatched row uses the established create-new path; a verified load failure remains fail-loud rather than silently losing context.
7. **Concurrency and privacy:** concurrent resume calls for one Tent session share one in-flight operation. Provider session ids are redacted from projected errors and never enter task/box/UI payloads.
8. **Honest non-support:** adapters with `canResume: false` keep failing `resumeSession` with “cannot resume”; dead processes without resume capability become `failed` on probe (unchanged).

The default test suite uses `test/fixtures/mock-acp-server.mjs` and never launches provider binaries, `npx`, or a paid network request. `npm run test:grok-e2e` is the explicit opt-in live path; it covers both ordinary dispatch/delivery and stop → native load → prior-context recovery.
