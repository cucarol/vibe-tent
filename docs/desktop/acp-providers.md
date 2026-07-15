# ACP Providers (Desktop MVP)

Tent exposes a small, explicit set of coding-agent ACP adapters. It is not a universal CLI router: each provider owns its launch contract, while the shared ACP layer only handles stdio JSON-RPC, permission requests, lifecycle events, and the final report.

| Adapter | Launch contract | Authentication |
| --- | --- | --- |
| `grok-acp` | Local Grok executable in ACP stdio mode | CPA/Grok key and base URL from service process env |
| `codex-acp` | `npx --yes @agentclientprotocol/codex-acp` | Existing Codex/ChatGPT login, or explicit `envKey` injected through `DEFAULT_AUTH_REQUEST` |
| `claude-acp` | `npx --yes @agentclientprotocol/claude-agent-acp` | Existing Claude login, or an explicitly configured process `envKey` |
| `antigravity-acp` | Separately installed third-party `agy-acp` bridge | Bridge/`agy` local authentication, plus optional explicit process `envKey` |
| `opencode-acp` | Native `opencode acp` | OpenCode's local provider configuration, plus optional explicit process `envKey` |
| `copilot-acp` | `npx --yes @github/copilot --acp --stdio` | Existing Copilot/`gh` login, plus optional explicit process `envKey` |

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
| `codex-acp` | **false** | none | Tent default package not claimed as verified load; do not invent resume |
| `claude-acp` | **false** | none | Not verified on this host |
| `antigravity-acp` | **false** | none | Not verified |
| `copilot-acp` | **false** | none | Not verified |

Rules:

1. **Runtime gate:** each load call checks **this** process’s `initialize` result for `agentCapabilities.loadSession === true`. Missing capability fails loud; Tent never falls back to `session/new` while pretending to resume.
2. **RPC shape:** `session/load` always sends required `{ sessionId, cwd, mcpServers }` (`mcpServers: []` today, same as `session/new`).
3. **Token:** machine-local `SessionRecord.resumeToken` is the provider ACP `sessionId` from `session/new`. Tasks still store only Tent `ss-` ids.
4. **History isolation:** load may stream full conversation history via `session/update`. Those notifications are quarantined until replay is quiet, are not projected as transcript diagnostics, and **must not** enter the next prompt’s `assistantText` or trigger `session.prompt_complete` / auto-`task.deliver`.
5. **Process model:** resume always spawns a **new** bridge process (managed handles do not survive service restart). `AgentRuntime.resumeSession` reuses the same Tent `sessionId` + original provider token.
6. **Service reuse:** after restart, a waiting task may resume only when its old machine-local session matches the requested profile, workspace, role, task binding, and lane cwd. A missing or mismatched row uses the established create-new path; a verified load failure remains fail-loud rather than silently losing context.
7. **Concurrency and privacy:** concurrent resume calls for one Tent session share one in-flight operation. Provider session ids are redacted from projected errors and never enter task/box/UI payloads.
8. **Honest non-support:** adapters with `canResume: false` keep failing `resumeSession` with “cannot resume”; dead processes without resume capability become `failed` on probe (unchanged).

The default test suite uses `test/fixtures/mock-acp-server.mjs` and never launches provider binaries, `npx`, or a paid network request. `npm run test:grok-e2e` is the explicit opt-in live path; it covers both ordinary dispatch/delivery and stop → native load → prior-context recovery.
