// 加载帐 → concept 树 → 解析 mode / type validity。
// V0.2: no domain R/W axes, no coordination capability, no read-only mode.
// operational pipeline（temp/ 等）永不进入 concept 索引。

import { FsAdapter } from "./adapter.js";
import {
  Box,
  BoxFrontmatter,
  NodeMode,
} from "./types.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadOrder, sortByOrder, OrderMap, ROOT_KEY } from "./order.js";
import {
  loadTypeRegistry,
  TypeRegistry,
  typeExists,
} from "./typeRegistry.js";
import { isOperationalPath, isSystemNoteName, OPERATIONAL_TOP_LEVEL } from "./paths.js";

/** concept 身份文件路径 = <文件夹名>.md */
export function boxNotePath(boxPath: string): string {
  return join(boxPath, baseName(boxPath) + ".md");
}

export interface LoadedTent {
  /** 顶层 concept，order.json 优先，缺省按稳定名称排序。temp 等 operational 不在树内。 */
  roots: Box[];
  /** id → concept 索引（仅 user-facing concepts）。 */
  byId: Map<string, Box>;
  /** path → concept 索引。 */
  byPath: Map<string, Box>;
  duplicateIds: Set<string>;
  typeRegistry: TypeRegistry;
}

export async function loadTent(fs: FsAdapter): Promise<LoadedTent> {
  const byId = new Map<string, Box>();
  const byPath = new Map<string, Box>();
  const roots: Box[] = [];
  const typeRegistry = await loadTypeRegistry(fs);

  const top = await fs.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadBoxInto(fs, entry.name, null, typeRegistry, roots);
  }

  // 排序:隐藏 order 表优先;缺省时根与子框均按稳定名称排序
  const order = await loadOrder(fs);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], (a, b) => a.name.localeCompare(b.name));
  for (const root of sortedRoots) sortChildren(root, order);

  // 解析隔离状态 + 建索引
  for (const root of sortedRoots) resolveSubtree(root, typeRegistry);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
  resolveLocks(sortedRoots);
  for (const root of sortedRoots) indexSubtree(root, byId, byPath, duplicateIds);

  return { roots: sortedRoots, byId, byPath, duplicateIds, typeRegistry };
}

function findDuplicateIds(roots: Box[]): Set<string> {
  const counts = new Map<string, number>();
  const visit = (box: Box) => {
    if (box.id) counts.set(box.id, (counts.get(box.id) || 0) + 1);
    for (const child of box.children) visit(child);
  };
  for (const root of roots) visit(root);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function applyDuplicateInvalid(
  box: Box,
  duplicateIds: Set<string>,
  inherited?: { rootId: string; reason: string }
): void {
  const direct = duplicateIds.has(box.id)
    ? { rootId: box.id, reason: `Duplicate id: ${box.id}; native copies must be converted to forks.` }
    : undefined;
  const invalid = inherited || direct;
  if (invalid) {
    box.invalid = true;
    box.invalidRootId = invalid.rootId;
    box.invalidReason = invalid.reason;
  }
  for (const child of box.children) applyDuplicateInvalid(child, duplicateIds, invalid);
}

/** 单框内容落盘后的增量重载。结构与 id 不变时避免重扫整顶帐。 */
export async function reloadLoadedBox(fs: FsAdapter, tent: LoadedTent, path: string): Promise<Box> {
  const box = tent.byPath.get(path);
  if (!box) throw new Error(`Box not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs.readFile(boxNotePath(path)));
  const identity = normalizeIdentity(data);
  if (identity.fm.id !== box.id) throw new Error("Incremental reload cannot change box id.");
  box.type = identity.fm.type;
  box.tags = identity.tags;
  box.fm = identity.fm;
  box.body = body;
  for (const root of tent.roots) resolveSubtree(root, tent.typeRegistry);
  resolveLocks(tent.roots);
  return box;
}

function sortChildren(box: Box, order: OrderMap): void {
  box.children = sortByOrder(box.children, order[box.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of box.children) sortChildren(c, order);
}

async function loadBox(fs: FsAdapter, path: string, parent: Box | null, registry: TypeRegistry): Promise<Box | null> {
  if (isOperationalPath(path)) return null;
  const boxFile = boxNotePath(path);
  if (!(await fs.exists(boxFile))) {
    // 没有同名 .md 的文件夹不是 concept(普通分组)。但其子孙里可能有 —— 透传扫描。
    return null;
  }
  const raw = await fs.readFile(boxFile);
  let parsed: ReturnType<typeof parseFrontmatter>;
  let parseError: string | undefined;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path);

  const { fm, tags } = normalizeIdentity(data);
  const box: Box = {
    id: fm.id,
    type: fm.type,
    tags,
    mode: "editable",
    archived: false,
    invalid: !!parseError,
    path,
    name,
    fm,
    body,
    children: [],
    parent,
    locked: false,
  };
  if (parseError) {
    box.invalidRootId = path;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }

  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs, join(path, entry.name), box, registry, box.children);
  }
  return box;
}

function normalizeIdentity(data: Record<string, unknown>): { fm: BoxFrontmatter; tags: string[] } {
  const rawType = typeof data.type === "string" && data.type ? data.type : "custom";
  const fm: BoxFrontmatter = {
    ...data,
    id: typeof data.id === "string" ? data.id : "",
    type: rawType,
  } as BoxFrontmatter;
  // Legacy keys stripped from memory projection (disk may still hold until migrate).
  delete (fm as Record<string, unknown>).archived;
  delete (fm as Record<string, unknown>).readable;
  delete (fm as Record<string, unknown>).writable;
  const tags = normalizeTags(data.tags);
  if (tags.length > 0) fm.tags = tags;
  else delete fm.tags;
  const mode = parseNodeMode(data.mode);
  if (mode && mode !== "editable") fm.mode = mode;
  else delete fm.mode;
  return { fm, tags };
}

/**
 * Parse persisted mode.
 * V0.2: only editable (default) and archived. Legacy "read-only" is treated as editable
 * at load (one-shot migration deletes the key from disk).
 */
export function parseNodeMode(value: unknown): NodeMode | undefined {
  if (value === "archived") return "archived";
  if (value === "editable") return "editable";
  // Legacy read-only → editable default (do not re-persist as a third mode).
  if (value === "read-only") return "editable";
  return undefined;
}

/** Explicit archive root on disk (mode: archived only; no legacy dual-read). */
export function isExplicitArchiveRoot(box: Pick<Box, "fm">): boolean {
  return box.fm.mode === "archived";
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// 普通分组文件夹:自己不是框,但把其下的框作为"虚拟同级"上浮给 parent。
async function loadBoxInto(
  fs: FsAdapter,
  path: string,
  parent: Box | null,
  registry: TypeRegistry,
  target: Box[]
): Promise<void> {
  if (isOperationalPath(path)) return;
  const box = await loadBox(fs, path, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs, join(path, entry.name), parent, registry, target);
  }
}

function resolveSubtree(
  box: Box,
  registry: TypeRegistry,
  inheritedInvalid?: { rootId: string; reason: string },
  inheritedArchived = false
): void {
  const directInvalid = box.invalid
    ? { rootId: box.invalidRootId || box.path, reason: box.invalidReason || "Invalid frontmatter." }
    : invalidTypeReference(box, registry);
  const invalid = inheritedInvalid || directInvalid;
  box.invalid = !!invalid;
  box.invalidRootId = invalid?.rootId;
  box.invalidReason = invalid?.reason;
  // archived cascades; editable is the only other mode.
  const localMode = parseNodeMode(box.fm.mode) ?? "editable";
  box.archived = inheritedArchived || localMode === "archived";
  box.mode = box.archived ? "archived" : "editable";
  // Keep fm.mode only for explicit archive roots.
  if (localMode === "archived" && !inheritedArchived) box.fm.mode = "archived";
  else delete box.fm.mode;
  // Legacy status may remain on disk for lifecycle dual-write; do not invent projection here.
  if (box.fm.status !== "todo" && box.fm.status !== "doing" && box.fm.status !== "done") {
    delete box.fm.status;
  }

  for (const c of box.children) resolveSubtree(c, registry, invalid, box.archived);
}

function resolveLocks(roots: Box[]): void {
  for (const root of roots) clearLocks(root);
  for (const root of roots) resolveLockSubtree(root);
}

function clearLocks(box: Box): void {
  box.locked = false;
  delete box.lockSource;
  delete box.lockOwner;
  for (const child of box.children) clearLocks(child);
}

function resolveLockSubtree(box: Box): void {
  for (const child of box.children) {
    resolveLockSubtree(child);
  }

  if (box.fm.owner) {
    applyAncestorLock(box, box.fm.owner);
    box.locked = true;
    box.lockSource = "self";
    box.lockOwner = box.fm.owner;
  }
}

function applyAncestorLock(box: Box, owner: string): void {
  for (const child of box.children) {
    if (!child.fm.owner) {
      child.locked = true;
      child.lockSource = "ancestor";
      child.lockOwner = owner;
    }
    applyAncestorLock(child, child.fm.owner || owner);
  }
}

function invalidTypeReference(
  box: Box,
  registry: TypeRegistry
): { rootId: string; reason: string } | undefined {
  if (!box.id) {
    return { rootId: box.path, reason: "Missing id: likely a manually created orphan box; use tent new-box or repair." };
  }
  if (!typeExists(box.type, registry)) {
    return { rootId: box.id, reason: `Unknown type: ${box.type}.` };
  }
  return undefined;
}

/** Normal collaboration exit: invalid or archived-mode. */
export function isUsableBox(box: Box): boolean {
  return !box.invalid && !box.archived;
}

/**
 * Core/Service content & structure mutation gate.
 * Hard deny only for invalid or archived — never a third "read-only" mode.
 */
export function assertContentMutable(box: Box, action = "modified"): void {
  if (box.invalid) throw new Error(`Invalid boxes cannot be ${action}.`);
  if (box.archived || box.mode === "archived") {
    throw new Error(`Archived boxes cannot be ${action}.`);
  }
}

/** True when Core/Service may mutate content/structure (mode + invalid only). */
export function isContentMutable(box: Box): boolean {
  return !box.invalid && box.mode === "editable" && !box.archived;
}

function indexSubtree(
  box: Box,
  byId: Map<string, Box>,
  byPath: Map<string, Box>,
  duplicateIds: Set<string>
): void {
  if (box.id && !duplicateIds.has(box.id)) byId.set(box.id, box);
  byPath.set(box.path, box);
  for (const c of box.children) indexSubtree(c, byId, byPath, duplicateIds);
}

// ---- 路径工具(纯字符串,不依赖 node:path,核心层保持可移植) ----

export function join(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
