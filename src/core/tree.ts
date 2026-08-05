// 加载帐 → Node 树 → 解析 mode / type validity。
// V0.2: no domain R/W axes, no coordination capability, no read-only mode.
// operational pipeline（temp/ 等）永不进入 Node 索引。

import { FsAdapter } from "./adapter.js";
import {
  Node,
  NodeFrontmatter,
  NodeMode,
  RelationRecord,
} from "./types.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadOrder, sortByOrder, OrderMap, ROOT_KEY } from "./order.js";
import {
  loadTypeRegistry,
  TypeRegistry,
  typeExists,
} from "./typeRegistry.js";
import {
  isOperationalPath,
  isSystemNoteName,
  nodeNotePath,
  OPERATIONAL_TOP_LEVEL,
} from "./paths.js";
import {
  normalizeRelationsList,
  relationsToFrontmatterValue,
} from "./relations.js";
import { isNodeId } from "./id.js";
import { contentEtag } from "./etag.js";

export { nodeNotePath } from "./paths.js";

export interface LoadedTent {
  /** 顶层 Node，order.json 优先，缺省按稳定名称排序。temp 等 operational 不在树内。 */
  roots: Node[];
  /** id → Node 索引（仅 user-facing Nodes）。 */
  byId: Map<string, Node>;
  /** path → Node 索引。 */
  byPath: Map<string, Node>;
  duplicateIds: Set<string>;
  typeRegistry: TypeRegistry;
}

export async function loadTent(fs: FsAdapter): Promise<LoadedTent> {
  const byId = new Map<string, Node>();
  const byPath = new Map<string, Node>();
  const roots: Node[] = [];
  const typeRegistry = await loadTypeRegistry(fs);

  const top = await fs.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadNodeInto(fs, entry.name, null, typeRegistry, roots);
  }

  // 排序:隐藏 order 表优先;缺省时根与子框均按稳定名称排序
  const order = await loadOrder(fs);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], (a, b) => a.name.localeCompare(b.name));
  for (const root of sortedRoots) sortChildren(root, order);

  // 解析隔离状态 + 建索引
  for (const root of sortedRoots) resolveSubtree(root, typeRegistry);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
  for (const root of sortedRoots) indexSubtree(root, byId, byPath, duplicateIds);

  return { roots: sortedRoots, byId, byPath, duplicateIds, typeRegistry };
}

function findDuplicateIds(roots: Node[]): Set<string> {
  const counts = new Map<string, number>();
  const visit = (node: Node) => {
    if (node.id) counts.set(node.id, (counts.get(node.id) || 0) + 1);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function applyDuplicateInvalid(
  node: Node,
  duplicateIds: Set<string>,
  inherited?: { rootId: string; reason: string }
): void {
  const direct = duplicateIds.has(node.id)
    ? { rootId: node.id, reason: `Duplicate id: ${node.id}; native copies must be converted to forks.` }
    : undefined;
  const invalid = inherited || direct;
  if (invalid) {
    node.invalid = true;
    node.invalidRootId = invalid.rootId;
    node.invalidReason = invalid.reason;
  }
  for (const child of node.children) applyDuplicateInvalid(child, duplicateIds, invalid);
}

/** 单框内容落盘后的增量重载。结构与 id 不变时避免重扫整顶帐。 */
export async function reloadLoadedNode(fs: FsAdapter, tent: LoadedTent, path: string): Promise<Node> {
  const node = tent.byPath.get(path);
  if (!node) throw new Error(`Node not found: ${path}.`);
  const raw = await fs.readFile(nodeNotePath(path));
  const { data, body } = parseFrontmatter(raw);
  const schemaError = canonicalIdentityError(data);
  if (schemaError) throw new Error(schemaError);
  const identity = normalizeIdentity(data);
  if (identity.fm.id !== node.id) throw new Error("Incremental reload cannot change node id.");
  node.type = identity.fm.type;
  node.tags = identity.tags;
  node.relations = identity.relations;
  node.fm = identity.fm;
  node.etag = contentEtag(raw);
  node.body = body;
  for (const root of tent.roots) resolveSubtree(root, tent.typeRegistry);
  return node;
}

function sortChildren(node: Node, order: OrderMap): void {
  node.children = sortByOrder(node.children, order[node.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of node.children) sortChildren(c, order);
}

async function loadNode(fs: FsAdapter, path: string, parent: Node | null, registry: TypeRegistry): Promise<Node | null> {
  if (isOperationalPath(path)) return null;
  const boxFile = nodeNotePath(path);
  if (!(await fs.exists(boxFile))) {
    // 没有同名 .md 的文件夹不是 Node（普通分组）。但其子孙里可能有 —— 透传扫描。
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
  const schemaError = canonicalIdentityError(data);

  const { fm, tags, relations } = normalizeIdentity(data);
  const node: Node = {
    id: fm.id,
    type: fm.type,
    tags,
    relations,
    mode: "editable",
    archived: false,
    invalid: !!parseError || !!schemaError,
    path,
    name,
    fm,
    etag: contentEtag(raw),
    body,
    children: [],
    parent,
  };
  if (parseError || schemaError) {
    node.invalidRootId = path;
    node.invalidReason = parseError ? `Invalid frontmatter: ${parseError}` : schemaError;
  }

  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadNodeInto(fs, join(path, entry.name), node, registry, node.children);
  }
  return node;
}

function canonicalIdentityError(data: Record<string, unknown>): string | undefined {
  if (typeof data.id !== "string" || !isNodeId(data.id)) {
    return `Invalid Node id: ${typeof data.id === "string" && data.id ? data.id : "<missing>"}; canonical Node ids must start with cx-.`;
  }
  if (data.mode !== undefined && parseNodeMode(data.mode) === undefined) {
    return `Invalid Node mode: ${String(data.mode)}.`;
  }
  return undefined;
}

function normalizeIdentity(data: Record<string, unknown>): {
  fm: NodeFrontmatter;
  tags: string[];
  relations: RelationRecord[];
} {
  const rawType = typeof data.type === "string" && data.type ? data.type : "custom";
  const fm: NodeFrontmatter = {
    ...data,
    id: typeof data.id === "string" ? data.id : "",
    type: rawType,
  } as NodeFrontmatter;
  // Unknown frontmatter remains opaque user metadata. Runtime never translates
  // retired collaboration keys into canonical Node or Task state.
  const tags = normalizeTags(data.tags);
  if (tags.length > 0) fm.tags = tags;
  else delete fm.tags;
  const mode = parseNodeMode(data.mode);
  if (mode && mode !== "editable") fm.mode = mode;
  else delete fm.mode;
  const relations = normalizeRelationsList(data.relations);
  const fmRelations = relationsToFrontmatterValue(relations);
  if (fmRelations) fm.relations = fmRelations;
  else delete fm.relations;
  return { fm, tags, relations };
}

/**
 * Parse persisted mode.
 * Only editable (default) and archived are valid canonical values.
 */
export function parseNodeMode(value: unknown): NodeMode | undefined {
  if (value === "archived") return "archived";
  if (value === "editable") return "editable";
  return undefined;
}

/** Explicit archive root on disk (mode: archived only; no legacy dual-read). */
export function isExplicitArchiveRoot(node: Pick<Node, "fm">): boolean {
  return node.fm.mode === "archived";
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
async function loadNodeInto(
  fs: FsAdapter,
  path: string,
  parent: Node | null,
  registry: TypeRegistry,
  target: Node[]
): Promise<void> {
  if (isOperationalPath(path)) return;
  const node = await loadNode(fs, path, parent, registry);
  if (node) {
    target.push(node);
    return;
  }
  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadNodeInto(fs, join(path, entry.name), parent, registry, target);
  }
}

function resolveSubtree(
  node: Node,
  registry: TypeRegistry,
  inheritedInvalid?: { rootId: string; reason: string },
  inheritedArchived = false
): void {
  const directInvalid = node.invalid
    ? { rootId: node.invalidRootId || node.path, reason: node.invalidReason || "Invalid frontmatter." }
    : invalidTypeReference(node, registry);
  const invalid = inheritedInvalid || directInvalid;
  node.invalid = !!invalid;
  node.invalidRootId = invalid?.rootId;
  node.invalidReason = invalid?.reason;
  // archived cascades; editable is the only other mode.
  const localMode = parseNodeMode(node.fm.mode) ?? "editable";
  node.archived = inheritedArchived || localMode === "archived";
  node.mode = node.archived ? "archived" : "editable";
  // Keep fm.mode only for explicit archive roots.
  if (localMode === "archived" && !inheritedArchived) node.fm.mode = "archived";
  else delete node.fm.mode;

  for (const c of node.children) resolveSubtree(c, registry, invalid, node.archived);
}

function invalidTypeReference(
  node: Node,
  registry: TypeRegistry
): { rootId: string; reason: string } | undefined {
  if (!isNodeId(node.id)) {
    return {
      rootId: node.path,
      reason: `Invalid Node id: ${node.id || "<missing>"}; canonical Node ids must start with cx-.`,
    };
  }
  if (node.fm.mode !== undefined && parseNodeMode(node.fm.mode) === undefined) {
    return { rootId: node.id, reason: `Invalid Node mode: ${String(node.fm.mode)}.` };
  }
  if (!typeExists(node.type, registry)) {
    return { rootId: node.id, reason: `Unknown type: ${node.type}.` };
  }
  return undefined;
}

/** Normal collaboration exit: invalid or archived-mode. */
export function isUsableNode(node: Node): boolean {
  return !node.invalid && !node.archived;
}

/**
 * Core/Service content & structure mutation gate.
 * Hard deny only for invalid or archived — never a third "read-only" mode.
 */
export function assertContentMutable(node: Node, action = "modified"): void {
  if (node.invalid) throw new Error(`Invalid nodes cannot be ${action}.`);
  if (node.archived || node.mode === "archived") {
    throw new Error(`Archived nodes cannot be ${action}.`);
  }
}

/** True when Core/Service may mutate content/structure (mode + invalid only). */
export function isContentMutable(node: Node): boolean {
  return !node.invalid && node.mode === "editable" && !node.archived;
}

function indexSubtree(
  node: Node,
  byId: Map<string, Node>,
  byPath: Map<string, Node>,
  duplicateIds: Set<string>
): void {
  if (!node.invalid && isNodeId(node.id) && !duplicateIds.has(node.id)) byId.set(node.id, node);
  byPath.set(node.path, node);
  for (const c of node.children) indexSubtree(c, byId, byPath, duplicateIds);
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
