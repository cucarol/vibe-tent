# Contributing

Thanks for helping improve Tent.

## Ground Rules

- Put behavioral and permission rules in `src/core/`.
- Keep the CLI and Obsidian plugin as thin clients of core.
- Keep manifest/readable/writable behavior in core and SPEC; do not redefine it only in UI.
- Do not place typed boxes under `temp/`; it is a system pipeline.
- Keep changes scoped and add tests for observable behavior.

## Development Workflow

```bash
npm ci
npm run check
```

### Test entry points

`npm test` is the **full regression gate**: it auto-discovers every `test/**/*.test.ts` via `scripts/run-tests.mjs` (no hand-maintained file list). Live e2e files (`*.e2e.ts`) stay opt-in.

| Script | Meaning |
| --- | --- |
| `npm test` / `npm run test` | **full** — every `*.test.ts` once (used by `check` / `prepack`) |
| `npm run test:fast` | **fast** — full minus the explicit slow/integration list (daily loop) |
| `npm run test:integration` | **integration** — only the short explicit list in `scripts/run-tests.mjs` (`package` + `open-source` today) |
| `npm run test:acp-images` | Targeted single-file entry (also covered by full) |
| `npm run test:renderer-next` | Targeted renderer-next entry (also covered by full) |
| `npm run test:grok-e2e` / `test:foreground-e2e` | Live ACP e2e (not part of full) |

New `*.test.ts` files are included in **full** and **fast** by default. Only add a path to the integration list when it is intentionally slow or environment-heavy. Do not compose full as `fast` then `integration` serially — that would re-run files and slow the gate.

List selected files without running: `node scripts/run-tests.mjs full --list` (also `fast` / `integration`).

Pull requests should explain the behavior change, tests added, and any compatibility impact on existing Tent directories.

## Design Changes

Changes to the data model, permission resolution, lifecycle actions, or manifest contracts should start as a design note or issue discussion. Implementation should follow an explicit decision rather than silently redefining the format in a frontend.
