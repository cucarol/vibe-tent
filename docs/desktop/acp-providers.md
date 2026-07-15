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

`gemini-acp` is intentionally absent. Antigravity uses the official `agy` CLI, but `agy` currently has no native ACP entrypoint; Tent therefore launches the third-party `agy-acp` executable and never starts `agy` directly. The bridge remains responsible for its own local conversation state. In particular, verify the bridge supports the host platform before selecting the default profile.

The Claude Agent ACP npm bridge currently requires Node.js 22 or newer even though Tent itself supports Node.js 20. A machine running Node 20 can use the rest of Tent, but must upgrade Node or configure another executable before launching `claude-acp`.

## Profile Rules

- Profiles are machine-local and store only executable paths, model hints, env key names, and permission/time-out settings.
- Secret values are read from `LaunchPlan.env` or the Local Service process environment. They are never written to a workspace, task, box, report, or profile JSON.
- Omitting `envKey` means the adapter relies on the provider's existing local login/configuration.
- Configuring `envKey` makes it required; a missing value fails before spawn.
- Tool permission policy defaults to `deny`. `ask` uses the same machine-local approval store for every ACP provider.
- Provider resume is not advertised in this MVP. Role/session inheritance is handled separately from provider-native resume.

All adapter tests use `test/fixtures/mock-acp-server.mjs`; the test suite never launches provider binaries, `npx`, or a paid network request.
