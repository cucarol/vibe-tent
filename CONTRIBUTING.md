# Contributing

Thanks for helping improve Tent.

## Ground Rules

- Put behavioral and permission rules in `src/core/`.
- Keep the CLI and Obsidian plugin as thin clients of core.
- Keep Node/Type domain and manifest context-pointer behavior in core and SPEC; do not redefine them only in UI.
- Do not place typed boxes under `temp/`; it is a system pipeline.
- Keep changes scoped and add tests for observable behavior.

## Development Workflow

```bash
npm ci
npm run check
```

### Test entry points

`npm test` is the **full regression gate**: it auto-discovers every `test/**/*.test.ts` via `scripts/run-tests.ts` (no hand-maintained file list). Live e2e files (`*.e2e.ts`) stay opt-in.

| Script | Meaning |
| --- | --- |
| `npm test` / `npm run test` | **full** — every `*.test.ts` once (used by `check` / `prepack`) |
| `npm run test:fast` | **fast** — full minus the explicit slow/integration list (daily loop) |
| `npm run test:integration` | **integration** — process-heavy CLI, Service, packaging, and end-to-end task-chain tests listed in `scripts/run-tests.ts` |
| `npm run test:acp-images` | Targeted single-file entry (also covered by full) |
| `npm run test:renderer-next` | Targeted renderer-next entry (also covered by full) |
| `npm run test:grok-e2e` / `test:foreground-e2e` | Live ACP e2e (not part of full) |

New `*.test.ts` files are included in **full** and **fast** by default. Move one to the integration list only when it starts real child processes, Service instances, packaging, or a complete task lifecycle and is measurably slow. Do not compose full as `fast` then `integration` serially — that would re-run files and slow the gate.

List selected files without running: `node --import tsx scripts/run-tests.ts full --list` (also `fast` / `integration`).

Pull requests should explain the behavior change, tests added, and any compatibility impact on existing Tent directories.

## Design Changes

Changes to the data model, permission resolution, lifecycle actions, or manifest contracts should start as a design note or issue discussion. Implementation should follow an explicit decision rather than silently redefining the format in a frontend.
