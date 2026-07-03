# Tent / 帷幄

Tent is an open-source harness for managing intent, context, permissions, and handoffs between a user and coding agents. A Tent is an OKF v0.1 bundle with a governance overlay; the Obsidian plugin and CLI are two clients of the same core rules.

The project is early (`0.1.x`) and the data format may still evolve. The behavioral contract lives in [`docs/SPEC.md`](docs/SPEC.md).

## Why

A project is split into two spaces:

- **Code workspace**: source code and real deliverables.
- **Tent**: goals, prompts, box state, manifests, proposals, and temporary task pointers.

The user remains the final decision maker. Agents receive deterministic readable/writable scopes and work in role-specific branches/worktrees. Their chat report and workspace commits are accepted only when the user confirms completion.

## Components

| Component | Purpose |
|---|---|
| `src/core/` | Framework-agnostic rules and filesystem contracts |
| `src/cli/` | `tent` command for user-authority actions |
| `src/plugin/` | Optional Obsidian structure editor |
| `skills/` | Agent-side skills: `tent-genesis` (create a tent) + `tent-role` (orient an agent into a role) |

Rules belong in core. Frontends render and invoke them; they must not invent their own permission semantics.

## Requirements

- Node.js 20 or newer
- Git
- Obsidian 1.5 or newer for the optional desktop plugin

## Development

```bash
npm ci
npm run check
```

`npm run check` runs TypeScript validation, production builds for `main.js` and `cli.mjs`, unit/integration tests, and the OKF conformance gate.

Useful focused commands:

```bash
npm run test:core
npm run test:integration
npm run build
npm run okf:check
npm run okf:check:strict
```

## Use From A Checkout

Build and expose the CLI on your PATH:

```bash
npm ci
npm run build
npm link
```

Create a new Tent in any empty destination:

```bash
tent new "<path-to-your-tent>"
cd "<path-to-your-tent>"
tent tree
```

Without `npm link`, the equivalent checkout-only command is `node ./cli.mjs new "<path-to-your-tent>"` after `npm run build`.

The new Tent is a self-contained skeleton: `RULES.md`, `.tent/types.json`, `.tent/roles.json`, `.tent/tags.json`, and a temp pipeline. It does not initialize Git or copy the mechanism `SPEC.md` and agent configuration files into the Tent.

## Syncing

Tent files do not use Git and may follow the vault's normal synchronization policy. The real workspace remains a normal Git repository and uses its own remote/push workflow.

## CLI

Run commands from the Tent root:

```text
tent role-init <role>
tent roles
tent dispatch <claimId> <role> [prompt...] [--handoff <path>]
tent report <boxId> <bodyFile|-> [--commits <sha,sha>]
tent complete <boxId> [--commits <sha,sha>]
tent stamp <boxId>
tent new-box <name> <type> [parentId]
tent propose <targetId> <role> <bodyFile|->
tent proposal <path> accept|reject [note]
tent grant-readable <boxId>
tent apply <proposalPath>
tent apply-done <proposalPath>
tent fork <boxId>
tent handoff <fromBoxId> <targetId> <targetRole> <promptFile|->
tent clean-temp [role]
tent force-release <boxId>
tent migrate-kind-to-type
tent okf-sync
tent tree
```

## Obsidian Plugin

After `npm run build`, copy these files into `<vault>/.obsidian/plugins/tent/`:

```text
main.js
manifest.json
styles.css
```

Then enable **Tent / 帷幄** in Obsidian's community plugin settings.

## Project Status

- Core, CLI, and the agent skills are implemented.
- The type system is a flat OKF-aligned registry with user-defined types.
- Legacy `kind` is load-compatible and can be migrated with `tent migrate-kind-to-type`.
- OKF index/log generation and wiki-link projection are available via `tent okf-sync`.
- `temp/` is a system pipeline, not a semantic node or type.
- The Obsidian UI is under active iteration.
- Package publication and Obsidian community-store submission have not happened yet.

## Contributing And Security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development rules and [`SECURITY.md`](SECURITY.md) for private vulnerability reporting guidance.

## License

[MIT](LICENSE)
