// 一次性 legacy schema migration（纯函数 + 可对 FsAdapter 执行）。
// 不做长期 alias / 双解析产品路径：迁移报告写出后，新写入只用 cx- / goal|prompt|output。
// 正常运行路径不得 dual-read 嵌套 `.tent/*`；本文件负责读旧布局并切断。
// 另：importExternalTentRoot 将旧独立帐根复制进 workspace 内 `.tent/`（B5）。

import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { NodeFs } from "../fs/node-fs.js";
import { FsAdapter } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { CONCEPT_ID_PREFIX, isLegacyBoxId, makeUniqueConceptId, type RandomSource } from "./id.js";
import {
  MUTATION_LOCK_PATH,
  ORDER_PATH,
  ROLES_REGISTRY_PATH,
  RULES_PATH,
  systemRootFromWorkspace,
  TAGS_REGISTRY_PATH,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
} from "./paths.js";
import { ensureWorkspaceGitignore } from "./scaffold.js";
import { boxNotePath, join, loadTent } from "./tree.js";
import {
  DEFAULT_TYPE_REGISTRY,
  normalizeRegistry,
  TYPE_REGISTRY_PATH,
  type TypeRegistry,
} from "./typeRegistry.js";

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

/** 嵌套旧布局下的注册表路径（相对 system root）。 */
const NESTED_REGISTRY_FILES = [
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
  ORDER_PATH,
  RULES_PATH,
] as const;

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

/**
 * 纯：V0.2 concept type rewrite (one-shot, no permanent alias).
 * - note → prompt (Core 数据与权威边界审计: ordinary text → prompt)
 * - artifact → output
 * - output stays output
 * - retired secondaries open/sealed → drop modifier (bare primary)
 * - unknown secondary → drop modifier when base is canonical
 * Returns undefined when already canonical / unchanged.
 */
export function rewriteCanonicalConceptType(type: string): string | undefined {
  const raw = type.trim();
  if (!raw) return undefined;
  const i = raw.indexOf("-");
  const base = i === -1 ? raw : raw.slice(0, i);
  const modifier = i === -1 ? undefined : raw.slice(i + 1);

  let nextBase = base;
  if (base === "note") nextBase = "prompt";
  else if (base === "artifact") nextBase = "output";
  // bare retired modifiers cannot stand alone as type
  else if (base === "open" || base === "sealed") nextBase = "prompt";

  let nextMod = modifier;
  if (modifier === "open" || modifier === "sealed") nextMod = undefined;
  // keep reference|asset; drop other secondaries only when primary is fixed canonical
  if (
    nextMod &&
    nextMod !== "reference" &&
    nextMod !== "asset" &&
    (nextBase === "goal" || nextBase === "prompt" || nextBase === "output")
  ) {
    // Custom secondary may still exist in registry; keep it if not retired built-in.
    // open/sealed already dropped above.
  }

  const next = nextMod ? `${nextBase}-${nextMod}` : nextBase;
  return next === raw ? undefined : next;
}

/**
 * @deprecated Prefer rewriteCanonicalConceptType. Historical name from output→artifact window;
 * now implements V0.2 note/artifact→canonical (identity for callers that still import this name).
 */
export function rewriteOutputType(type: string): string | undefined {
  return rewriteCanonicalConceptType(type);
}

/**
 * 纯：types.json → V0.2 slim registry (tier only).
 * - note → prompt, artifact → output keys
 * - drop open/sealed
 * - strip R/W, coordination, color, description, workspacePointer
 * - flatten legacy { primary, secondary }
 * Idempotent via normalizeRegistry.
 */
export function migrateTypeRegistryJson(value: unknown): { registry: TypeRegistry; changes: string[] } {
  const changes: string[] = [];
  const root: Record<string, unknown> = isRecord(value) ? deepClone(value) : {};

  if (isRecord(root.primary) || isRecord(root.secondary)) {
    const flat: Record<string, unknown> = {};
    if (isRecord(root.primary)) {
      mergeLegacyKeysInto(flat, root.primary, changes, "primary");
    }
    if (isRecord(root.secondary)) {
      mergeLegacyKeysInto(flat, root.secondary, changes, "secondary");
    }
    const registry = normalizeRegistry(flat);
    changes.push("normalized primary/secondary registry to V0.2 slim shape");
    void DEFAULT_TYPE_REGISTRY;
    return { registry, changes: uniqueChanges(changes) };
  }

  const flat: Record<string, unknown> = {};
  mergeLegacyKeysInto(flat, root, changes, "root");
  const registry = normalizeRegistry(flat);
  if (!isRecord(value) || Object.keys(flat).length === 0) {
    changes.push("seeded default V0.2 type registry");
  } else {
    changes.push("normalized flat registry to V0.2 slim shape");
  }
  // Detect legacy field strip
  if (jsonHadRetiredFields(value)) {
    changes.push("stripped domain R/W, coordination, color, description, workspacePointer from type defs");
  }
  void DEFAULT_TYPE_REGISTRY;
  return { registry, changes: uniqueChanges(changes) };
}

function mergeLegacyKeysInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  changes: string[],
  label: string
): void {
  for (const [key, raw] of Object.entries(source)) {
    if (key === "primary" || key === "secondary") continue;
    if (key === "open" || key === "sealed") {
      changes.push(`dropped retired secondary key ${label}.${key}`);
      continue;
    }
    let nextKey = key;
    if (key === "note") {
      nextKey = "prompt";
      changes.push(`mapped ${label}.note → prompt`);
    } else if (key === "artifact") {
      nextKey = "output";
      changes.push(`mapped ${label}.artifact → output`);
    }
    if (target[nextKey] === undefined) {
      target[nextKey] = isRecord(raw) ? slimTypeDef(raw) : raw;
    }
  }
}

function slimTypeDef(raw: Record<string, unknown>): Record<string, unknown> {
  const tier = raw.tier === "modifier" ? "modifier" : "base";
  return { tier };
}

function jsonHadRetiredFields(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const walk = (node: unknown): boolean => {
    if (!isRecord(node)) return false;
    for (const [k, v] of Object.entries(node)) {
      if (
        k === "readable" ||
        k === "writable" ||
        k === "coordination" ||
        k === "color" ||
        k === "description" ||
        k === "workspacePointer"
      ) {
        return true;
      }
      if (walk(v)) return true;
    }
    return false;
  };
  return walk(value);
}

function uniqueChanges(changes: string[]): string[] {
  return [...new Set(changes)];
}

/**
 * 对当前 system root 执行一次性 legacy migration：
 * 1) 嵌套 `.tent/*` 注册表 → 扁平 system root 并切断 dual-read
 * 2) types.json → V0.2 slim (note→prompt, artifact→output, strip R/W/chrome)
 * 3) bx-→cx- + concept type rewrite + strip domain R/W + read-only→editable
 * 4) 有界 operational 引用改写（非全局 split/join）
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

  await liftNestedRegistries(fs, report, dryRun);
  await migrateFlatTypeRegistry(fs, report, dryRun);
  await unifyMutationLock(fs, report, dryRun);

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
      const rewritten = rewriteCanonicalConceptType(data.type);
      if (rewritten) {
        report.typeRewrites.push({ path: box.path, from: data.type, to: rewritten });
        data.type = rewritten;
        dirty = true;
      }
    }

    // Strip domain R/W axes from concept frontmatter (one-shot; no dual-write).
    if ("readable" in data) {
      delete data.readable;
      dirty = true;
      report.registryChanges.push(
        dryRun ? `would strip readable at ${box.path}` : `stripped readable at ${box.path}`
      );
    }
    if ("writable" in data) {
      delete data.writable;
      dirty = true;
      report.registryChanges.push(
        dryRun ? `would strip writable at ${box.path}` : `stripped writable at ${box.path}`
      );
    }

    // read-only mode → editable default (delete key). Archive preserved separately.
    if (data.mode === "read-only") {
      delete data.mode;
      dirty = true;
      report.registryChanges.push(
        dryRun
          ? `would clear read-only mode at ${box.path}`
          : `cleared read-only mode at ${box.path}`
      );
    }

    // One-shot: explicit archive roots archived:true → mode:archived; strip legacy key.
    // No permanent dual-read/write of archived + mode after cutover.
    if (data.archived === true) {
      if (data.mode !== "archived") {
        data.mode = "archived";
        report.registryChanges.push(
          dryRun
            ? `would migrate archived→mode at ${box.path}`
            : `migrated archived→mode at ${box.path}`
        );
      }
      delete data.archived;
      dirty = true;
    } else if ("archived" in data) {
      delete data.archived;
      dirty = true;
      report.registryChanges.push(
        dryRun
          ? `would strip legacy archived key at ${box.path}`
          : `stripped legacy archived key at ${box.path}`
      );
    }

    // Do not strip legacy owner/status here — Judge defers field removal until UI cutover.
    // New writes already omit them; migration only rewrites type domain fields.

    if (dirty && !dryRun) {
      await fs.writeFile(
        notePath,
        serializeFrontmatter(data, body, keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER)
      );
    }
  }

  if (await fs.exists(ORDER_PATH)) {
    try {
      const order = JSON.parse(await fs.readFile(ORDER_PATH)) as Record<string, string[]>;
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
        if (!dryRun) await fs.writeFile(ORDER_PATH, JSON.stringify(next, null, 2) + "\n");
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

/**
 * 读取旧的嵌套 `.tent/*` 后写入扁平布局，并删除嵌套副本以切断 dual-read。
 * 幂等：扁平已存在且内容一致时仅清理嵌套；扁平不存在则搬迁。
 */
async function liftNestedRegistries(
  fs: FsAdapter,
  report: MigrationReport,
  dryRun: boolean
): Promise<void> {
  if (!(await fs.exists(TENT_SYSTEM_DIR))) return;
  for (const name of NESTED_REGISTRY_FILES) {
    const nested = join(TENT_SYSTEM_DIR, name);
    if (!(await fs.exists(nested))) continue;
    const flatExists = await fs.exists(name);
    if (!flatExists) {
      report.registryChanges.push(
        dryRun ? `would lift nested ${nested} → ${name}` : `lifted nested ${nested} → ${name}`
      );
      if (!dryRun) {
        const text = await fs.readFile(nested);
        await fs.writeFile(name, text);
      }
    } else {
      report.registryChanges.push(`nested ${nested} ignored; flat ${name} already present`);
    }
    report.registryChanges.push(dryRun ? `would remove nested ${nested}` : `removed nested ${nested}`);
    if (!dryRun) await fs.remove(nested);
  }

  // 嵌套 mutation.lock 一律删除，统一到扁平唯一锁
  const nestedLock = join(TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  if (await fs.exists(nestedLock)) {
    report.registryChanges.push(
      dryRun ? `would remove nested ${nestedLock}` : `removed nested ${nestedLock}`
    );
    if (!dryRun) await fs.remove(nestedLock);
  }
}

async function migrateFlatTypeRegistry(
  fs: FsAdapter,
  report: MigrationReport,
  dryRun: boolean
): Promise<void> {
  if (!(await fs.exists(TYPE_REGISTRY_PATH))) return;
  try {
    const raw = JSON.parse(await fs.readFile(TYPE_REGISTRY_PATH)) as unknown;
    const { registry, changes } = migrateTypeRegistryJson(raw);
    report.registryChanges.push(...changes);
    if (!dryRun && changes.length > 0) {
      await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
    }
  } catch (error) {
    report.warnings.push(
      `types.json migration skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** 若仅有嵌套锁残留，确保扁平唯一锁路径可用（不创建活跃锁文件）。 */
async function unifyMutationLock(
  fs: FsAdapter,
  report: MigrationReport,
  dryRun: boolean
): Promise<void> {
  const nestedLock = join(TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  if (await fs.exists(nestedLock)) {
    report.registryChanges.push(
      dryRun ? `would remove nested lock ${nestedLock}` : `removed nested lock ${nestedLock}`
    );
    if (!dryRun) await fs.remove(nestedLock);
  }
  // 文档/报告：唯一锁路径固定为 system root mutation.lock
  if (!report.registryChanges.some((c) => c.includes(MUTATION_LOCK_PATH))) {
    report.registryChanges.push(`unique lock path: ${MUTATION_LOCK_PATH}`);
  }
}

/**
 * 有界 operational 引用改写：只改 frontmatter/YAML 结构化字段与精确 token，
 * 禁止无边界全局 split/join。重跑幂等。
 */
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
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".md") && !lower.endsWith(".yml") && !lower.endsWith(".yaml")) continue;

      const text = await fs.readFile(path);
      const rewritten = rewriteOperationalText(text, idMap);
      let targetName = entry.name;
      for (const [from, to] of idMap) {
        // 文件名中的精确 id token（如 task-…-bx-xxx.md）
        if (targetName.includes(from)) {
          targetName = replaceExactIdTokens(targetName, from, to);
        }
      }
      const targetPath = join(dir, targetName);

      if (rewritten === text && targetPath === path) continue;
      report.registryChanges.push(`operational rewrite: ${path}`);
      if (!dryRun) {
        if (targetPath !== path) {
          await fs.writeFile(targetPath, rewritten);
          await fs.remove(path);
        } else {
          await fs.writeFile(path, rewritten);
        }
      }
    }
  };
  await walk(TEMP_DIR);
}

/**
 * 改写 operational 文本中的 id 引用：
 * - YAML/frontmatter 行：`claims: [bx-…]`、`box: bx-…`、`id: bx-…` 等
 * - 独立 token（词边界），避免把 `bx-abc` 嵌在更长字符串里误伤
 */
export function rewriteOperationalText(text: string, idMap: Map<string, string>): string {
  if (idMap.size === 0) return text;
  let next = text;
  // 1) 结构化 frontmatter / yaml 标量与列表项
  next = next.replace(
    /^([ \t]*(?:claims|box|id|claim|parent|from|to|root)[ \t]*:[ \t]*)(.+)$/gim,
    (full, prefix: string, value: string) => {
      return prefix + replaceIdsInStructuredValue(value, idMap);
    }
  );
  // 2) claims 行内数组与 body 中的精确 token
  for (const [from, to] of idMap) {
    next = replaceExactIdTokens(next, from, to);
  }
  return next;
}

function replaceIdsInStructuredValue(value: string, idMap: Map<string, string>): string {
  let next = value;
  for (const [from, to] of idMap) {
    next = replaceExactIdTokens(next, from, to);
  }
  return next;
}

/**
 * 仅替换完整 id token。
 * 边界用「非字母数字」：允许 `task-…-bx-xxx.md` 文件名中的 `-` 分隔，
 * 同时拒绝 `bx-abc` 嵌在 `bx-abc1234` / `mybx-abc` 等更长串中。
 */
export function replaceExactIdTokens(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g");
  return text.replace(re, to);
}

/**
 * 将旧的独立 Tent 根（vault/_tents/… 等）安全导入到 workspace 内 `.tent/`。
 *
 * 合同（architecture §7）：
 * - 目标已有最终 `.tent` 时硬拒绝（无静默覆盖）
 * - live：复制 + schema migration 只在 workspace 下唯一 staging 目录进行，成功后原子 rename 为 `.tent`
 * - 任一步失败：best-effort 删除 staging；最终 `.tent` 不存在；源不写 `MIGRATED.md`（可重试）
 * - 成功后不删除旧源；仅写 `MIGRATED.md` 标记
 * - 不跟随/不复制符号链接（跳过并记入 skipped/warnings），避免带入 source root 外内容
 * - dry-run 只报告，不写目标、不标记旧源
 */
export interface ImportExternalTentOptions {
  /** Absolute or relative path to legacy tent root (contains RULES.md + boxes/temp/…). */
  sourceRoot: string;
  /** Absolute or relative path to target workspace root (receives `.tent/`). */
  workspaceRoot: string;
  dryRun?: boolean;
  rand?: RandomSource;
  rewriteOperationalRefs?: boolean;
  /**
   * When true, proceed even if source has active claims / pending tasks.
   * Never enables overwrite of an existing destination `.tent`.
   */
  force?: boolean;
  /**
   * @internal Test-only hooks for mid-import failure injection.
   * Not part of the stable product API surface.
   */
  _testHooks?: ImportExternalTentTestHooks;
}

/** @internal */
export interface ImportExternalTentTestHooks {
  afterCopy?: (stagingRoot: string) => void | Promise<void>;
  afterSchema?: (stagingRoot: string) => void | Promise<void>;
  beforeRename?: (stagingRoot: string, systemRoot: string) => void | Promise<void>;
}

export interface ImportExternalTentReport {
  dryRun: boolean;
  sourceRoot: string;
  workspaceRoot: string;
  systemRoot: string;
  copied: boolean;
  sourceMarked: boolean;
  schema: MigrationReport;
  warnings: string[];
  skipped: string[];
}

const IMPORT_SKIP_DIR_NAMES = new Set([".git", "node_modules"]);

/** Staging dir prefix under workspace: `.tent.import-staging-<id>` (never the final `.tent`). */
export const IMPORT_STAGING_DIR_PREFIX = `${TENT_SYSTEM_DIR}.import-staging-`;

/**
 * Detect a usable legacy (or flat) tent system root directory.
 * Accepts both flat layout (RULES.md + types/temp) and roots that still nest registries under `.tent/`.
 */
export async function isLegacyTentRoot(root: string): Promise<boolean> {
  const rules = nodePath.join(root, RULES_PATH);
  if (!(await pathExists(rules))) return false;
  return (
    (await pathExists(nodePath.join(root, TYPE_REGISTRY_PATH))) ||
    (await pathExists(nodePath.join(root, TEMP_DIR))) ||
    (await pathExists(nodePath.join(root, TENT_SYSTEM_DIR))) ||
    (await pathExists(nodePath.join(root, ORDER_PATH))) ||
    (await pathExists(nodePath.join(root, "index.md")))
  );
}

/**
 * Import an external/legacy tent root into `<workspace>/.tent`.
 * Pure orchestration around host fs + `migrateLegacySchema`; safe for CLI and service callers.
 */
export async function importExternalTentRoot(
  options: ImportExternalTentOptions
): Promise<ImportExternalTentReport> {
  const dryRun = options.dryRun === true;
  const sourceRoot = nodePath.resolve(options.sourceRoot);
  const workspaceRoot = nodePath.resolve(options.workspaceRoot);
  const systemRoot = systemRootFromWorkspace(workspaceRoot);
  const warnings: string[] = [];
  const skipped: string[] = [];

  if (!(await pathExists(sourceRoot))) {
    throw new Error(`Source tent root does not exist: ${sourceRoot}`);
  }
  // lstat: refuse to treat a symlink as the source root (would pull external content).
  const sourceStat = await nodeFs.lstat(sourceRoot);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Source tent root must not be a symbolic link: ${sourceRoot}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source tent root is not a directory: ${sourceRoot}`);
  }
  if (!(await isLegacyTentRoot(sourceRoot))) {
    throw new Error(
      `Source does not look like a Tent root (need RULES.md and types/temp/.tent/order/index): ${sourceRoot}`
    );
  }

  if (samePath(sourceRoot, systemRoot)) {
    throw new Error(`Source is already the target system root: ${systemRoot}`);
  }
  if (samePath(sourceRoot, workspaceRoot)) {
    throw new Error(
      `Source equals workspace root. Point --source at the legacy tent directory (e.g. vault/_tents/tent-dev), not the workspace.`
    );
  }

  if (await pathExists(systemRoot)) {
    // Hard refuse — never overwrite existing in-workspace tent (even with --force).
    throw new Error(
      `Refusing to import: target already has ${TENT_SYSTEM_DIR} at ${systemRoot}. ` +
        `No silent overwrite. Move/rename the existing system dir first if you intend to replace it.`
    );
  }

  // Pre-flight occupancy on source (informational; --force continues).
  const sourceFs = new NodeFs(sourceRoot);
  try {
    const tent = await loadTent(sourceFs);
    const claimed = [...tent.byId.values()].filter(
      (b) => typeof b.fm.owner === "string" && b.fm.owner.trim() && b.fm.status === "doing"
    );
    if (claimed.length > 0) {
      const msg = `Source has ${claimed.length} active claim(s) (owner+doing). Prefer idle cutover.`;
      if (options.force) warnings.push(msg + " (--force: continuing)");
      else {
        throw new Error(
          msg + ` Re-run with --force to import anyway (still will not overwrite an existing .tent).`
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("active claim")) throw error;
    warnings.push(
      `Could not fully load source tent for occupancy check: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Inventory symlinks (skipped, never followed) for dry-run and live reports.
  await collectSymlinkSkips(sourceRoot, skipped, warnings);

  // Dry-run schema plan against source (no writes).
  const plannedSchema = await migrateLegacySchema(sourceFs, {
    dryRun: true,
    rand: options.rand,
    rewriteOperationalRefs: options.rewriteOperationalRefs,
  });

  if (dryRun) {
    return {
      dryRun: true,
      sourceRoot,
      workspaceRoot,
      systemRoot,
      copied: false,
      sourceMarked: false,
      schema: plannedSchema,
      warnings,
      skipped: [
        ...skipped,
        "dry-run: no files copied",
        "dry-run: source not marked with MIGRATED.md",
      ],
    };
  }

  await nodeFs.mkdir(workspaceRoot, { recursive: true });
  const stagingRoot = await allocateImportStagingDir(workspaceRoot);
  let renamedToFinal = false;

  try {
    await copyHostTree(sourceRoot, stagingRoot, skipped, warnings);
    if (options._testHooks?.afterCopy) await options._testHooks.afterCopy(stagingRoot);

    const destFs = new NodeFs(stagingRoot);
    const schema = await migrateLegacySchema(destFs, {
      dryRun: false,
      rand: options.rand,
      rewriteOperationalRefs: options.rewriteOperationalRefs,
    });
    if (options._testHooks?.afterSchema) await options._testHooks.afterSchema(stagingRoot);

    // Workspace gitignore for `.tent/` (idempotent) — before atomic switch.
    const workspaceFs = new NodeFs(workspaceRoot);
    await ensureWorkspaceGitignore(workspaceFs);

    if (options._testHooks?.beforeRename) {
      await options._testHooks.beforeRename(stagingRoot, systemRoot);
    }

    // Re-check final target right before rename (hard refuse if it appeared).
    if (await pathExists(systemRoot)) {
      throw new Error(
        `Refusing to import: target already has ${TENT_SYSTEM_DIR} at ${systemRoot}. ` +
          `No silent overwrite. Move/rename the existing system dir first if you intend to replace it.`
      );
    }

    await nodeFs.rename(stagingRoot, systemRoot);
    renamedToFinal = true;

    await writeMigratedMarker(sourceRoot, {
      workspaceRoot,
      systemRoot,
      idMapCount: schema.idMap.length,
    });

    return {
      dryRun: false,
      sourceRoot,
      workspaceRoot,
      systemRoot,
      copied: true,
      sourceMarked: true,
      schema,
      warnings: [...warnings, ...schema.warnings],
      skipped: [...skipped, ...schema.skipped],
    };
  } catch (error) {
    if (!renamedToFinal) {
      await removeHostTreeBestEffort(stagingRoot);
    }
    throw error;
  }
}

async function writeMigratedMarker(
  sourceRoot: string,
  info: { workspaceRoot: string; systemRoot: string; idMapCount: number }
): Promise<void> {
  const when = new Date().toISOString();
  const body =
    `# Migrated\n\n` +
    `This external Tent root was **copied** into an in-workspace system dir.\n\n` +
    `- When: ${when}\n` +
    `- Workspace: \`${info.workspaceRoot.replace(/\\/g, "/")}\`\n` +
    `- System root: \`${info.systemRoot.replace(/\\/g, "/")}\`\n` +
    `- Id remaps applied on the **copy**: ${info.idMapCount}\n\n` +
    `The source tree was **not** deleted. There is no bidirectional sync.\n` +
    `After verifying the workspace tent, you may delete this directory manually.\n` +
    `Do not continue writing collaboration facts here.\n`;
  await nodeFs.writeFile(nodePath.join(sourceRoot, "MIGRATED.md"), body, "utf8");
}

function noteSkippedSymlink(
  relPosix: string,
  skipped: string[],
  warnings: string[]
): void {
  const msg = `skipped symlink (not followed): ${relPosix}`;
  if (!skipped.includes(msg)) skipped.push(msg);
  if (!warnings.includes(msg)) warnings.push(msg);
}

/** Walk source and record every symlink path (relative, posix). Does not follow links. */
async function collectSymlinkSkips(
  root: string,
  skipped: string[],
  warnings: string[],
  relBase = ""
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await nodeFs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IMPORT_SKIP_DIR_NAMES.has(entry.name)) continue;
    if (entry.name === "MIGRATED.md") continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const relPosix = rel.replace(/\\/g, "/");
    const abs = nodePath.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      noteSkippedSymlink(relPosix, skipped, warnings);
      continue;
    }
    if (entry.isDirectory()) {
      await collectSymlinkSkips(abs, skipped, warnings, relPosix);
    }
  }
}

/**
 * Recursive host copy into staging.
 * - Skips VCS/deps noise and prior MIGRATED.md
 * - Never follows or copies symbolic links (file or directory); records skipped/warnings
 * - Preserves nested real `.tent` registry residue for later schema lift
 */
async function copyHostTree(
  from: string,
  to: string,
  skipped: string[],
  warnings: string[],
  relBase = ""
): Promise<void> {
  await nodeFs.mkdir(to, { recursive: true });
  const entries = await nodeFs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (IMPORT_SKIP_DIR_NAMES.has(entry.name)) continue;
    // Never copy a prior migration marker into the new system root as content.
    if (entry.name === "MIGRATED.md") continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const relPosix = rel.replace(/\\/g, "/");
    const src = nodePath.join(from, entry.name);
    const dst = nodePath.join(to, entry.name);

    // Dirent type checks do not follow symlinks; check links first.
    if (entry.isSymbolicLink()) {
      noteSkippedSymlink(relPosix, skipped, warnings);
      continue;
    }
    if (entry.isDirectory()) {
      await copyHostTree(src, dst, skipped, warnings, relPosix);
    } else if (entry.isFile()) {
      await nodeFs.mkdir(nodePath.dirname(dst), { recursive: true });
      // copyFile would follow a symlink if we mis-detected; lstat guard is belt-and-suspenders.
      const st = await nodeFs.lstat(src);
      if (st.isSymbolicLink()) {
        noteSkippedSymlink(relPosix, skipped, warnings);
        continue;
      }
      await nodeFs.copyFile(src, dst);
    }
  }
}

async function allocateImportStagingDir(workspaceRoot: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const stagingRoot = nodePath.join(workspaceRoot, `${IMPORT_STAGING_DIR_PREFIX}${id}`);
    if (await pathExists(stagingRoot)) continue;
    await nodeFs.mkdir(stagingRoot, { recursive: false });
    return stagingRoot;
  }
  throw new Error(`Could not allocate unique import staging directory under ${workspaceRoot}`);
}

async function removeHostTreeBestEffort(root: string): Promise<void> {
  try {
    await nodeFs.rm(root, { recursive: true, force: true });
  } catch {
    // best-effort only
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await nodeFs.access(p);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const na = nodePath.resolve(a);
  const nb = nodePath.resolve(b);
  if (process.platform === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function deepClone(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
