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

For a focused core change, run `npm run test:core`. For CLI, packaging, or portability work, also run `npm run test:integration`.

Pull requests should explain the behavior change, tests added, and any compatibility impact on existing Tent directories.

## Design Changes

Changes to the data model, permission resolution, lifecycle actions, or manifest contracts should start as a documented proposal. Implementation should follow an explicit decision rather than silently redefining the format in a frontend.
