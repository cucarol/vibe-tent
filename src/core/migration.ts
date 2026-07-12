// 一次性 legacy schema migration（纯函数 + 可对 FsAdapter 执行）。
// 不做长期 alias / 双解析产品路径：迁移报告写出后，新写入只用 cx- / artifact。

import { FsAdapter } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { CONCEPT_ID_PREFIX, isLegacyBoxId, makeUniqueConceptId, type RandomSource } from "./id.js";
import { boxNotePath, join, loadTent } from "./tree.js";
import {
  DEFAULT_TYPE_REGISTRY,
  normalizeRegistry,
  TYPE_REGISTRY_PATH,
  type TypeRegistry,
} from "./typeRegistry.js";
import { TEMP_DIR } from "./paths.js";

export interface IdRemap {
  from: string;
  to: string;
  path: string;
}

export interface MigrationReport {
  dryRun: boolean;
  idMap: IdRemap[];
  typeRewrites: { path: string; from: string; to: string }[];
  registryChanges: string[];
  skipped: string[];
  warnings: string[];
}

export interface MigrateLegacySchemaOptions {
  dryRun?: boolean;
  rand?: RandomSource;
  /** 额外扫描 temp 内 envelope 的 box id 引用并改写。 */
  rewriteOperationalRefs?: boolean;
}

/**
 * 纯：给定 legacy id 集合，生成 bx- → cx- 映射（确定性取决于 rand）。
 * 优先同后缀：bx-abc123 → cx-abc123；冲突时再随机。
 */
export function planIdRemap(
  legacyIds: string[],
  existing: Set<string>,
  rand: RandomSource = Math.random
): Map<string, string> {
  const used = new Set(existing);
  const map = new Map<string, string>();
  for (const id of legacyIds) {
    if (!isLegacyBoxId(id)) continue;
    if (map.has(id)) continue;
    const suffix = id.slice(3);
    const preferred = CONCEPT_ID_PREFIX + suffix;
    let next = preferred;
    if (used.has(next)) next = makeUniqueConceptId(used, rand);
    used.add(next);
    map.set(id, next);
  }
  return map;
}

/** 纯：把 type 字符串中的 base `output` 改成 `artifact`（含 compound）。 */
export function rewriteOutputType(type: string): string | undefined {
  if (type === "output") return "artifact";
  if (type.startsWith("output-")) return "artifact" + type.slice("output".length);
  return undefined;
}

/**
 * 纯：从 types.json 对象去掉 workspacePointer，并把 output 键合并为 artifact。
 */
export function migrateTypeRegistryJson(value: unknown): { registry: TypeRegistry; changes: string[] } {
  const changes: string[] = [];
  const root: Record<string, unknown> = isRecord(value) ? { ...value } : {};

  const stripPointer = (def: unknown): unknown => {
    if (!isRecord(def)) return def;
    if (!("workspacePointer" in def)) return def;
    const next = { ...def };
    delete next.workspacePointer;
    changes.push("removed workspacePointer from a type definition");
    return next;
  };

  if (isRecord(root.primary) || isRecord(root.secondary)) {
    if (isRecord(root.primary)) {
      root.primary = Object.fromEntries(
        Object.entries(root.primary).map(([k, v]) => [k, stripPointer(v)])
      );
    }
    if (isRecord(root.secondary)) {
      root.secondary = Object.fromEntries(
        Object.entries(root.secondary).map(([k, v]) => [k, stripPointer(v)])
      );
    }
  } else {
    for (const key of Object.keys(root)) {
      root[key] = stripPointer(root[key]);
    }
    if (isRecord(root.output)) {
      if (!root.artifact) {
        const out = { ...root.output, coordination: true };
        delete (out as Record<string, unknown>).workspacePointer;
        root.artifact = out;
        changes.push("promoted output definition to artifact");
      }
      delete root.output;
      changes.push("removed legacy output type key");
    }
  }

  const registry = normalizeRegistry(root);
  // ensure no workspacePointer leaked into normalized objects
  for (const def of Object.values(registry)) {
    if (def && typeof def === "object" && "workspacePointer" in def) {
      delete (def as { workspacePointer?: boolean }).workspacePointer;
      changes.push("stripped workspacePointer after normalize");
    }
  }
  void DEFAULT_TYPE_REGISTRY;
  return { registry, changes };
}

/**
 * 对当前 system root 执行一次性 legacy migration。
 */
export async function migrateLegacySchema(
  fs: FsAdapter,
  options: MigrateLegacySchemaOptions = {}
): Promise<MigrationReport> {
  const dryRun = options.dryRun === true;
  const rewriteOps = options.rewriteOperationalRefs !== false;
  const report: MigrationReport = {
    dryRun,
    idMap: [],
    typeRewrites: [],
    registryChanges: [],
    skipped: [],
    warnings: [],
  };

  if (await fs.exists(TYPE_REGISTRY_PATH)) {
    try {
      const raw = JSON.parse(await fs.readFile(TYPE_REGISTRY_PATH)) as unknown;
      const { registry, changes } = migrateTypeRegistryJson(raw);
      report.registryChanges.push(...changes);
      if (!dryRun && changes.length > 0) {
        await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
      }
    } catch (error) {
      report.warnings.push(`types.json migration skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const tent = await loadTent(fs);
  const legacyIds = [...tent.byId.keys()].filter(isLegacyBoxId);
  const existing = new Set(tent.byId.keys());
  const idMap = planIdRemap(legacyIds, existing, options.rand);

  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(notePath));
    let dirty = false;

    const oldId = typeof data.id === "string" ? data.id : "";
    if (isLegacyBoxId(oldId)) {
      let next = idMap.get(oldId);
      if (!next) {
        const extra = planIdRemap([oldId], new Set([...existing, ...idMap.values()]), options.rand);
        next = extra.get(oldId)!;
        idMap.set(oldId, next);
      }
      data.id = next;
      dirty = true;
      report.idMap.push({ from: oldId, to: next, path: box.path });
      existing.add(next);
    }

    if (typeof data.type === "string") {
      const rewritten = rewriteOutputType(data.type);
      if (rewritten) {
        report.typeRewrites.push({ path: box.path, from: data.type, to: rewritten });
        data.type = rewritten;
        dirty = true;
      }
    }

    if (dirty && !dryRun) {
      await fs.writeFile(
        notePath,
        serializeFrontmatter(data, body, keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER)
      );
    }
  }

  if (await fs.exists("order.json")) {
    try {
      const order = JSON.parse(await fs.readFile("order.json")) as Record<string, string[]>;
      let dirty = false;
      const next: Record<string, string[]> = {};
      for (const [key, list] of Object.entries(order)) {
        const newKey = idMap.get(key) ?? key;
        if (newKey !== key) dirty = true;
        next[newKey] = list.map((id) => {
          const mapped = idMap.get(id);
          if (mapped) {
            dirty = true;
            return mapped;
          }
          return id;
        });
      }
      if (dirty) {
        report.registryChanges.push(dryRun ? "would rewrite order.json ids" : "rewrote order.json ids");
        if (!dryRun) await fs.writeFile("order.json", JSON.stringify(next, null, 2) + "\n");
      }
    } catch (error) {
      report.warnings.push(`order.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (rewriteOps && (await fs.exists(TEMP_DIR))) {
    await rewriteOperationalTree(fs, idMap, report, dryRun);
  }

  const seen = new Set<string>();
  report.idMap = report.idMap.filter((entry) => {
    const key = `${entry.from}->${entry.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return report;
}

async function rewriteOperationalTree(
  fs: FsAdapter,
  idMap: Map<string, string>,
  report: MigrationReport,
  dryRun: boolean
): Promise<void> {
  if (idMap.size === 0) return;
  const walk = async (dir: string): Promise<void> => {
    if (!(await fs.exists(dir))) return;
    for (const entry of await fs.listDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDir) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith(".md") && !entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) {
        continue;
      }
      const text = await fs.readFile(path);
      let next = text;
      for (const [from, to] of idMap) next = next.split(from).join(to);
      let targetPath = path;
      for (const [from, to] of idMap) {
        if (entry.name.includes(from)) targetPath = join(dir, entry.name.split(from).join(to));
      }
      if (next !== text || targetPath !== path) {
        report.registryChanges.push(`operational rewrite: ${path}`);
        if (!dryRun) {
          if (targetPath !== path) {
            await fs.writeFile(targetPath, next);
            await fs.remove(path);
          } else {
            await fs.writeFile(path, next);
          }
        }
      }
    }
  };
  await walk(TEMP_DIR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
