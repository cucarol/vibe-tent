# External tent → in-workspace `.tent` migration（B5）

Status: implementation note for Desktop / CLI  
Scope: one-shot import of a **legacy independent tent root** into a workspace’s `.tent/`  
Non-scope: long-term dual-write, Obsidian plugin as product path, auto-delete of deliverables

## From → to

| From | To |
| --- | --- |
| External tent root (e.g. `Vault/_tents/tent-dev`) with current `index.md` or retired `RULES.md`, registries, `temp/`, Node tree, and optional nested `.tent/*` residue | `<workspace>/.tent/` (system root with `index.md`) |
| Nested registry dual-layout under source `.tent/` | Flat registries on system root (via `migrateLegacySchema`) |
| `bx-` ids / legacy `note`·`artifact` types | `cx-` / `prompt`·`output` on the **copy** only |

## Hard rules

1. **Refuse if final `<workspace>/.tent` already exists.** No silent overwrite, even with `--force`.
2. **Live work is staging-only.** Copy + schema migration run under a unique `<workspace>/.tent.import-staging-*` directory; success **atomically renames** staging → `.tent`. Any failure best-effort deletes staging: final `.tent` is absent, source has no `MIGRATED.md`, import is retryable.
3. **Source is never deleted.** After a successful live import, write `MIGRATED.md` on the source root only.
4. **No symlink follow/copy.** File or directory symlinks under the source are skipped (recorded in `skipped` / `warnings`) so content outside the source root cannot be pulled in. The source root itself must not be a symlink.
5. **Dry-run** plans schema remaps against the source and reports paths; does not create `.tent` or staging, does not mark source.
6. **No machine-local secrets** are migrated (API keys, session PIDs, AgentProfiles).
7. Prefer idle cutover: active Task envelopes block unless `--force` (still never overwrites destination).

## CLI

```bash
# Preview
tent migrate --source "D:/ObsidianVault/_tents/tent-dev" --workspace "D:/code/my-repo" --dry-run

# Live copy + schema migration on the copy
tent migrate --source "D:/ObsidianVault/_tents/tent-dev" --workspace "D:/code/my-repo"

# Alias
tent import --source <legacyRoot> --workspace <ws> [--dry-run] [--force] [--json]
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--source` / `--from` | Absolute or relative path to legacy tent root |
| `--workspace` / `--to` | Workspace root that will receive `.tent/` |
| `--dry-run` | Report only |
| `--force` | Allow import when source has active claims |
| `--json` | Machine-readable `ImportExternalTentReport` |

## Core API

```ts
import { importExternalTentRoot, isLegacyTentRoot } from "./core/migration.js";

const report = await importExternalTentRoot({
  sourceRoot: "...",
  workspaceRoot: "...",
  dryRun: false,
  force: false,
});
// report.systemRoot === <workspace>/.tent
// report.schema.idMap / typeRewrites / registryChanges
// report.sourceMarked === true after live success
```

Pipeline on live import:

1. Validate source looks like a Tent root (`index.md`, or retired `RULES.md` for one-shot v0.1 import, plus registries/temp/order); refuse if source root is a symlink.
2. Refuse existing final destination `.tent`.
3. Occupancy preflight (optional `--force`).
4. Inventory + recursive copy into unique staging (skips `.git`, `node_modules`, prior `MIGRATED.md`, retired `RULES.md`, and all symlinks).
5. Ensure `index.md`, then run `migrateLegacySchema` on the **staging** system root (lift nested registries, id/type rewrites, operational refs).
6. Ensure workspace `.gitignore` contains `.tent/`.
7. Atomic `rename(staging → .tent)`.
8. Write source `MIGRATED.md` only after the final `.tent` exists.

## Related

- `docs/desktop/architecture.md` §7 — one-shot migration contract  
- `src/core/migration.ts` — `migrateLegacySchema` + `importExternalTentRoot`  
- Desktop: open the **workspace** folder after import (not the old vault tent path)
