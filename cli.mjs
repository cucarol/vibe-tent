#!/usr/bin/env node

// src/cli/tent.ts
import * as path from "node:path";
import * as fs2 from "node:fs/promises";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// src/fs/node-fs.ts
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
var NodeFs = class {
  constructor(root) {
    this.root = nodePath.resolve(root);
  }
  abs(p) {
    const resolved = nodePath.resolve(this.root, p);
    const root = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const candidate = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (candidate !== root && !candidate.startsWith(root + nodePath.sep)) {
      throw new Error(`Path escapes Tent root: ${p}`);
    }
    return resolved;
  }
  async listDir(dir) {
    const entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path2) {
    return fs.readFile(this.abs(path2), "utf8");
  }
  async writeFile(path2, content) {
    await fs.mkdir(nodePath.dirname(this.abs(path2)), { recursive: true });
    await fs.writeFile(this.abs(path2), content, "utf8");
  }
  async exists(path2) {
    try {
      await fs.access(this.abs(path2));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path2) {
    await fs.mkdir(this.abs(path2), { recursive: true });
  }
  async move(from, to) {
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }
  async remove(path2) {
    await fs.rm(this.abs(path2), { recursive: true, force: true });
  }
  async withLock(path2, action) {
    const lockPath = this.abs(path2);
    await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent \u6B63\u5728\u6267\u884C\u53E6\u4E00\u4E2A\u5199\u64CD\u4F5C,\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        await fs.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("\u65E0\u6CD5\u83B7\u53D6 Tent mutation lock");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
};
var SystemClock = class {
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
};
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function isStaleLock(path2) {
  try {
    const stat2 = await fs.stat(path2);
    return Date.now() - stat2.mtimeMs > 12e4;
  } catch {
    return true;
  }
}

// src/core/frontmatter.ts
var FENCE = "---";
var BOX_FRONTMATTER_KEY_ORDER = ["id", "type", "tags"];
function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n")) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const end = text.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const fmBlock = text.slice(FENCE.length + 1, end);
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);
  const data = {};
  const keyOrder = [];
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let valuePart = trimmed.slice(colon + 1).trim();
    valuePart = stripInlineComment(valuePart);
    if (valuePart === "" && isBlockSequenceStart(lines[i + 1])) {
      const { value, nextIndex } = readBlockSequence(lines, i + 1, key);
      data[key] = normalizeValueForKey(key, value);
      i = nextIndex - 1;
    } else {
      data[key] = normalizeValueForKey(key, coerceForKey(key, valuePart));
    }
    keyOrder.push(key);
  }
  return { data, body, keyOrder };
}
function stripInlineComment(v) {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const hash = v.indexOf(" #");
  return hash === -1 ? v : v.slice(0, hash).trim();
}
function coerce(v) {
  if (v === "") return void 0;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('"') && v.endsWith('"')) {
    return parseDoubleQuoted(v);
  }
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowArray(inner).map((item) => coerce(item.trim()));
  }
  return v;
}
function isBlockSequenceStart(line) {
  return line !== void 0 && /^\s*-\s*/.test(line);
}
function readBlockSequence(lines, startIndex, key) {
  const value = [];
  let i = startIndex;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*-\s*(.*)$/);
    if (!match) break;
    const item = stripInlineComment(match[1].trim());
    value.push(coerceForKey(key, item));
  }
  return { value, nextIndex: i };
}
function coerceForKey(key, raw) {
  if (key !== "commits") return coerce(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowArray(inner).map((item) => coerceCommitItem(item.trim()));
  }
  return coerceCommitItem(raw);
}
function coerceCommitItem(raw) {
  return /^\d+$/.test(raw) ? raw : coerce(raw);
}
function parseDoubleQuoted(v) {
  try {
    return JSON.parse(v);
  } catch {
    return unescapeYamlDoubleQuoted(v.slice(1, -1));
  }
}
function unescapeYamlDoubleQuoted(value) {
  const escapes = {
    "0": "\0",
    a: "\x07",
    b: "\b",
    t: "	",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    e: "\x1B",
    '"': '"',
    "/": "/",
    "\\": "\\"
  };
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\" || i === value.length - 1) {
      out += ch;
      continue;
    }
    const next = value[++i];
    out += escapes[next] ?? `\\${next}`;
  }
  return out;
}
function normalizeValueForKey(key, value) {
  if (key === "workspace" || key === "path" || key === "ref") {
    return normalizeWindowsPathValue(value);
  }
  if (key === "paths" && Array.isArray(value)) {
    return value.map((item) => normalizeWindowsPathValue(item));
  }
  return value;
}
function normalizeWindowsPathValue(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value)) return value;
  return value.replace(/\\{2,}/g, "\\");
}
function splitFlowArray(inner) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items;
}
function serializeFrontmatter(data, body, keyOrder = []) {
  const keys = orderedKeys(data, keyOrder);
  const lines = [FENCE];
  for (const k of keys) {
    const val = data[k];
    if (val === void 0) continue;
    lines.push(`${k}: ${emit(val)}`);
  }
  lines.push(FENCE);
  const out = lines.join("\n");
  return body ? out + "\n" + body : out + "\n";
}
function orderedKeys(data, keyOrder) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const k of keyOrder) {
    if (k in data && !seen.has(k)) {
      result.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(data)) {
    if (!seen.has(k)) {
      result.push(k);
      seen.add(k);
    }
  }
  return result;
}
function emit(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map((item) => emit(item)).join(", ") + "]";
  }
  const s = String(v);
  if (/^-?(?:\d+|\d*\.\d+)$/.test(s) || /[:,#\[\]]/.test(s) || s !== s.trim() || s === "") {
    return JSON.stringify(s);
  }
  return s;
}

// src/core/order.ts
var ROOT_KEY = "__root__";
var ORDER_PATH = ".tent/order.json";
async function loadOrder(fs3) {
  if (!await fs3.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs3.readFile(ORDER_PATH));
  } catch {
    return {};
  }
}
async function saveOrder(fs3, map) {
  if (!await fs3.exists(".tent")) await fs3.mkdir(".tent");
  await fs3.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
}
function sortByOrder(items, order, fallback) {
  const sorted = [...items];
  if (!order || order.length === 0) {
    sorted.sort(fallback);
    return sorted;
  }
  const idx = new Map(order.map((id, i) => [id, i]));
  sorted.sort((a, b) => {
    const ai = idx.has(a.id) ? idx.get(a.id) : Infinity;
    const bi = idx.has(b.id) ? idx.get(b.id) : Infinity;
    if (ai !== bi) return ai - bi;
    return fallback(a, b);
  });
  return sorted;
}

// src/core/typeRegistry.ts
var TYPE_REGISTRY_PATH = ".tent/types.json";
var DEFAULT_TYPE_REGISTRY = {
  goal: {
    readable: true,
    writable: false,
    color: "blue",
    tier: "base",
    description: "\u5B9A\u4E49\u76EE\u6807\u3001\u610F\u56FE\u4E0E\u9A8C\u6536\u65B9\u5411"
  },
  prompt: {
    readable: true,
    writable: true,
    color: "purple",
    tier: "base",
    description: "\u63D0\u4F9B\u4EFB\u52A1\u8BF4\u660E\u4E0E\u5DE5\u4F5C\u4E0A\u4E0B\u6587"
  },
  output: {
    readable: true,
    writable: true,
    color: "cyan",
    tier: "base",
    description: "\u6620\u5C04\u771F\u5B9E\u4EA4\u4ED8\u7269\u4E0E workspace"
  },
  open: {
    readable: true,
    writable: true,
    color: "green",
    tier: "modifier",
    description: "\u4ECD\u5728\u63A8\u8FDB\u3001\u53EF\u7EE7\u7EED\u5904\u7406"
  },
  reference: {
    readable: true,
    color: "blue",
    tier: "modifier",
    description: "\u4F5C\u4E3A\u80CC\u666F\u8D44\u6599\u4F9B\u67E5\u9605\u4E0E\u5F15\u7528"
  },
  asset: {
    writable: true,
    color: "purple",
    tier: "modifier",
    description: "\u4F5C\u4E3A\u5B9E\u9645\u4EA7\u7269\u6216\u53EF\u590D\u7528\u8D44\u6E90"
  },
  sealed: {
    readable: false,
    writable: false,
    color: "red",
    tier: "modifier",
    description: "\u5DF2\u5C01\u5B58\uFF0C\u4E0D\u518D\u53C2\u4E0E\u540E\u7EED\u5904\u7406"
  }
};
function splitType(type) {
  const i = type.indexOf("-");
  if (i === -1) return { base: type };
  return { base: type.slice(0, i), modifier: type.slice(i + 1) };
}
function joinType(base, modifier) {
  return modifier ? `${base}-${modifier}` : base;
}
function typeExists(type, registry) {
  if (registry[type]) return true;
  const { base, modifier } = splitType(type);
  return !!(registry[base] && (modifier === void 0 || !!registry[modifier]));
}
function resolveTypeAxis(type, axis, registry) {
  const exact = registry[type];
  if (exact) return exact[axis];
  const { base, modifier } = splitType(type);
  const baseVal = registry[base]?.[axis];
  const modVal = modifier ? registry[modifier]?.[axis] : void 0;
  return typeof modVal === "boolean" ? modVal : baseVal;
}
async function loadTypeRegistry(fs3) {
  if (!await fs3.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs3.readFile(TYPE_REGISTRY_PATH));
    return normalizeRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`types.json \u635F\u574F: ${detail}`);
  }
}
function normalizeRegistry(value) {
  const root = isRecord(value) ? value : {};
  const registry = cloneDefaults();
  if (isRecord(root.primary) || isRecord(root.secondary)) {
    mergeDefinitions(registry, root.primary, true, "base");
    mergeDefinitions(registry, root.secondary, false, "modifier");
    return registry;
  }
  mergeDefinitions(registry, root);
  return registry;
}
function mergeDefinitions(registry, source, legacyBase = false, defaultTier) {
  if (!isRecord(source)) return;
  for (const [name, raw] of Object.entries(source)) {
    if (!name.trim() || name === "temp" || !isRecord(raw)) continue;
    const current = registry[name];
    const tier = raw.tier === "base" || raw.tier === "modifier" ? raw.tier : current?.tier ?? defaultTier;
    const resolvedTier = tier ?? "base";
    const readable = typeof raw.readable === "boolean" ? raw.readable : void 0;
    const writable = typeof raw.writable === "boolean" ? raw.writable : void 0;
    if ((legacyBase || resolvedTier === "base") && (readable === void 0 || writable === void 0)) continue;
    const metadata = {
      ...typeof raw.color === "string" && raw.color ? { color: raw.color } : current?.color ? { color: current.color } : {},
      ...typeof raw.description === "string" && raw.description ? { description: raw.description } : current?.description ? { description: current.description } : {}
    };
    registry[name] = resolvedTier === "modifier" ? {
      tier: "modifier",
      ...readable !== void 0 ? { readable } : {},
      ...writable !== void 0 ? { writable } : {},
      ...metadata
    } : { tier: "base", readable, writable, ...metadata };
  }
}
function cloneDefaults() {
  return Object.fromEntries(
    Object.entries(DEFAULT_TYPE_REGISTRY).map(([name, def]) => [name, { ...def }])
  );
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/tree.ts
var ZONE_NAMES = ["goal", "prompt", "output"];
function boxNotePath(boxPath) {
  return join(boxPath, baseName(boxPath) + ".md");
}
async function loadTent(fs3) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs3);
  const top = await fs3.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (entry.name === "temp") continue;
    await loadBoxInto(fs3, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs3);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], (a, b) => zoneRank(a.name) - zoneRank(b.name) || a.name.localeCompare(b.name));
  for (const root of sortedRoots) sortChildren(root, order);
  for (const root of sortedRoots) resolveSubtree(root, typeRegistry);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
  resolveLocks(sortedRoots);
  for (const root of sortedRoots) indexSubtree(root, byId, byPath, duplicateIds);
  return { roots: sortedRoots, byId, byPath, typeRegistry };
}
function findDuplicateIds(roots) {
  const counts = /* @__PURE__ */ new Map();
  const visit = (box) => {
    if (box.id) counts.set(box.id, (counts.get(box.id) || 0) + 1);
    for (const child of box.children) visit(child);
  };
  for (const root of roots) visit(root);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}
function applyDuplicateInvalid(box, duplicateIds, inherited) {
  const direct = duplicateIds.has(box.id) ? { rootId: box.id, reason: `\u91CD\u590D id: ${box.id};\u539F\u751F\u590D\u5236\u9700\u8F6C\u4E3A fork` } : void 0;
  const invalid = inherited || direct;
  if (invalid) {
    box.invalid = true;
    box.invalidRootId = invalid.rootId;
    box.invalidReason = invalid.reason;
    box.readable = { value: false, source: "invalid" };
    box.writable = { value: false, source: "invalid" };
  }
  for (const child of box.children) applyDuplicateInvalid(child, duplicateIds, invalid);
}
function sortChildren(box, order) {
  box.children = sortByOrder(box.children, order[box.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of box.children) sortChildren(c, order);
}
function zoneRank(name) {
  const i = ZONE_NAMES.indexOf(name);
  return i === -1 ? 99 : i;
}
async function loadBox(fs3, path2, parent, registry) {
  const boxFile = boxNotePath(path2);
  if (!await fs3.exists(boxFile)) {
    return null;
  }
  const raw = await fs3.readFile(boxFile);
  const { data, body } = parseFrontmatter(raw);
  const name = baseName(path2);
  const zone = parent ? parent.zone : zoneOf(name);
  const { fm, tags } = normalizeIdentity(data);
  const box = {
    id: fm.id,
    type: fm.type,
    kind: fm.kind,
    tags,
    archived: false,
    invalid: false,
    path: path2,
    name,
    fm,
    body,
    children: [],
    parent,
    zone,
    locked: false,
    readable: { value: false, source: "type" },
    writable: { value: false, source: "type" }
  };
  const sub = await fs3.listDir(path2);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    await loadBoxInto(fs3, join(path2, entry.name), box, registry, box.children);
  }
  return box;
}
function normalizeIdentity(data) {
  const rawType = typeof data.type === "string" && data.type ? data.type : "custom";
  const rawKind = typeof data.kind === "string" && data.kind ? data.kind : "";
  const effectiveType = rawKind ? joinType(rawType, rawKind) : rawType;
  const fm = {
    ...data,
    id: typeof data.id === "string" ? data.id : "",
    type: effectiveType
  };
  if (rawKind) fm.kind = rawKind;
  else delete fm.kind;
  const tags = normalizeTags(data.tags);
  if (tags.length > 0) fm.tags = tags;
  else delete fm.tags;
  if (typeof data.readable === "boolean") fm.readable = data.readable;
  else delete fm.readable;
  if (typeof data.writable === "boolean") fm.writable = data.writable;
  else delete fm.writable;
  return { fm, tags };
}
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}
async function loadBoxInto(fs3, path2, parent, registry, target) {
  const box = await loadBox(fs3, path2, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs3.listDir(path2);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    await loadBoxInto(fs3, join(path2, entry.name), parent, registry, target);
  }
}
function zoneOf(name) {
  return ZONE_NAMES.includes(name) ? name : null;
}
function resolveSubtree(box, registry, inheritedInvalid, inheritedArchived = false) {
  const directInvalid = invalidTypeReference(box, registry);
  const invalid = inheritedInvalid || directInvalid;
  box.invalid = !!invalid;
  box.invalidRootId = invalid?.rootId;
  box.invalidReason = invalid?.reason;
  box.archived = inheritedArchived || box.fm.archived === true;
  if (box.fm.status !== "todo" && box.fm.status !== "doing" && box.fm.status !== "done") {
    delete box.fm.status;
  }
  box.readable = resolveAxis(box, "readable", registry);
  box.writable = resolveAxis(box, "writable", registry);
  for (const c of box.children) resolveSubtree(c, registry, invalid, box.archived);
}
function resolveLocks(roots) {
  for (const root of roots) clearLocks(root);
  for (const root of roots) resolveLockSubtree(root);
}
function clearLocks(box) {
  box.locked = false;
  delete box.lockSource;
  delete box.lockOwner;
  for (const child of box.children) clearLocks(child);
}
function resolveLockSubtree(box) {
  let descendantOwner;
  for (const child of box.children) {
    const occupied = resolveLockSubtree(child);
    if (!descendantOwner && occupied) descendantOwner = occupied;
  }
  if (box.fm.owner) {
    applyAncestorLock(box, box.fm.owner);
    box.locked = true;
    box.lockSource = "self";
    box.lockOwner = box.fm.owner;
    return { owner: box.fm.owner, box };
  }
  if (descendantOwner) {
    box.locked = true;
    box.lockSource = "descendant";
    box.lockOwner = descendantOwner.owner;
    return descendantOwner;
  }
  return void 0;
}
function applyAncestorLock(box, owner) {
  for (const child of box.children) {
    if (!child.fm.owner) {
      child.locked = true;
      child.lockSource = "ancestor";
      child.lockOwner = owner;
    }
    applyAncestorLock(child, child.fm.owner || owner);
  }
}
function resolveAxis(box, axis, registry) {
  if (box.invalid) return { value: false, source: "invalid" };
  if (box.archived) return { value: false, source: "archived" };
  const declared = box.fm[axis];
  if (typeof declared === "boolean") {
    return { value: declared, source: "self" };
  }
  const fallback = resolveTypeAxis(box.type, axis, registry);
  return { value: typeof fallback === "boolean" ? fallback : false, source: "type" };
}
function invalidTypeReference(box, registry) {
  if (!box.id) {
    return { rootId: box.path, reason: "\u7F3A\u5C11 id:\u7591\u4F3C\u624B\u5DE5\u521B\u5EFA\u7684\u5B64\u513F\u6846,\u8BF7\u7528 tent new-box \u6216 repair" };
  }
  if (!typeExists(box.type, registry)) {
    return { rootId: box.id, reason: `\u672A\u77E5 type: ${box.type}` };
  }
  return void 0;
}
function isUsableBox(box) {
  return !box.invalid && !box.archived;
}
function indexSubtree(box, byId, byPath, duplicateIds) {
  if (box.id && !duplicateIds.has(box.id)) byId.set(box.id, box);
  byPath.set(box.path, box);
  for (const c of box.children) indexSubtree(c, byId, byPath, duplicateIds);
}
function join(...parts) {
  return parts.filter((p) => p !== "").join("/");
}
function baseName(path2) {
  const i = path2.lastIndexOf("/");
  return i === -1 ? path2 : path2.slice(i + 1);
}
function dirName(path2) {
  const i = path2.lastIndexOf("/");
  return i === -1 ? "" : path2.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs3, action) {
  return fs3.withLock ? fs3.withLock(".tent/mutation.lock", action) : action();
}

// src/core/manifest.ts
function buildManifest(tent, input) {
  const { role } = input;
  const claimBoxes = input.claimRoot ? tent.roots : requireClaimBoxes(input);
  const claimScope = input.claimRoot ? allBoxes(tent).filter(isUsableBox) : claimBoxes.flatMap(subtree);
  const readable = [];
  const writable = [];
  for (const box of allBoxes(tent)) {
    if (isUsableBox(box) && box.readable.value) {
      readable.push({ id: box.id, path: box.path, note: oneLineNote(box) });
    }
  }
  readable.push({ path: ".tent/roles.json", note: "\u7CFB\u7EDF\u6CE8\u518C\u8868:\u53EF\u7528 role \u4E0E\u957F\u671F prompt" });
  readable.push({ path: "temp/", note: "\u7CFB\u7EDF\u7BA1\u9053:\u53EF\u8BFB\u5168\u90E8\u89D2\u8272\u4EFB\u52A1\u3001\u63D0\u8BAE\u4E0E\u4EA4\u4ED8" });
  for (const box of claimScope) {
    if (isUsableBox(box) && box.writable.value) {
      writable.push({ id: box.id, path: box.path });
    }
  }
  if (input.claimRoot) {
    writable.push({ path: "./", note: "\u7ED3\u6784\u6743:\u53EF\u5728\u5E10\u6839\u521B\u5EFA/\u79FB\u52A8\u9876\u5C42\u6846" });
  }
  for (const box of claimScope) {
    writable.push({ id: box.id, path: `${box.path}/`, note: "\u7ED3\u6784\u6743:\u53EF\u5728\u6B64\u6846\u4E0B\u521B\u5EFA/\u79FB\u52A8/\u5220\u9664\u5B50\u6846" });
  }
  writable.push({ path: join("temp", role) + "/" });
  return {
    tent: input.tentName,
    role,
    claims: input.claimRoot ? ["root"] : claimBoxes.map((box) => box.id),
    ...input.workspace ? { workspace: input.workspace } : {},
    ...input.worktree ? { worktree: input.worktree } : {},
    ...input.branch ? { branch: input.branch } : {},
    ...input.targetBranch ? { targetBranch: input.targetBranch } : {},
    readable: dedupe(readable),
    writable: dedupe(writable),
    preloaded: buildPreloaded(tent)
  };
}
function manifestToYaml(m) {
  const lines = [];
  lines.push(`tent: ${m.tent}`);
  lines.push(`role: ${m.role}`);
  lines.push(`claims: [${m.claims.join(", ")}]`);
  if (m.workspace) lines.push(`workspace: ${yamlStr(m.workspace)}`);
  if (m.worktree) lines.push(`worktree: ${yamlStr(m.worktree)}`);
  if (m.branch) lines.push(`branch: ${yamlStr(m.branch)}`);
  if (m.targetBranch) lines.push(`targetBranch: ${yamlStr(m.targetBranch)}`);
  lines.push(`readable:`);
  for (const e of m.readable) lines.push(`  - ${entryLine(e)}`);
  lines.push(`writable:`);
  for (const e of m.writable) lines.push(`  - ${entryLine(e)}`);
  lines.push(`preloaded:`);
  for (const p of m.preloaded) lines.push(`  - ${p}`);
  return lines.join("\n") + "\n";
}
function entryLine(e) {
  const parts = [];
  if (e.id) parts.push(`id: ${e.id}`);
  parts.push(`path: ${yamlStr(e.path)}`);
  if (e.note) parts.push(`note: ${yamlStr(e.note)}`);
  return `{${parts.join(", ")}}`;
}
function yamlStr(s) {
  return /[:#{}\[\],]/.test(s) ? JSON.stringify(s) : s;
}
function oneLineNote(box) {
  const firstLine = box.body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return firstLine ? firstLine.slice(0, 40) : box.type;
}
function allBoxes(tent) {
  return [...tent.byPath.values()];
}
function buildPreloaded(tent) {
  const order = treeOrder(tent);
  const entries = allBoxes(tent).filter((box) => isUsableBox(box) && box.readable.value).sort((a, b) => {
    const stable = preloadStabilityRank(a) - preloadStabilityRank(b);
    if (stable !== 0) return stable;
    const type = preloadTypeRank(a) - preloadTypeRank(b);
    if (type !== 0) return type;
    return (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
  }).map((box) => `${box.path} \u6B63\u6587`);
  return ["RULES.md", ...entries];
}
function preloadStabilityRank(box) {
  const status = box.fm.status || "todo";
  if (box.writable.value || box.fm.owner || status === "doing") return 1;
  return 0;
}
function preloadTypeRank(box) {
  const base = splitType(box.type).base;
  if (base === "goal") return 0;
  if (base === "prompt") return 1;
  if (base === "output") return 2;
  return 3;
}
function treeOrder(tent) {
  const order = /* @__PURE__ */ new Map();
  let n = 0;
  const visit = (box) => {
    order.set(box.id, n++);
    for (const child of box.children) visit(child);
  };
  for (const root of tent.roots) visit(root);
  return order;
}
function subtree(box) {
  const out = [box];
  for (const c of box.children) out.push(...subtree(c));
  return out;
}
function requireClaimBoxes(input) {
  if (!input.claimBoxes || input.claimBoxes.length === 0) throw new Error("\u7F3A\u5C11\u8BA4\u9886\u6846");
  return input.claimBoxes;
}
function dedupe(entries) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(e);
  }
  return out;
}

// src/core/id.ts
var ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function makeBoxId(rand = Math.random, len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return "bx-" + s;
}
function makeUniqueBoxId(existing, rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeBoxId(rand);
    if (!existing.has(id)) return id;
  }
  return makeBoxId(rand, 10);
}

// src/core/claim.ts
function canClaim(box) {
  if (box.invalid) return { ok: false, blocker: box, reason: `\u5931\u6548\u5B50\u6811:${box.invalidReason || "\u7C7B\u578B\u5B9A\u4E49\u7F3A\u5931"}` };
  if (box.archived) return { ok: false, blocker: box, reason: "\u5F52\u6863\u5B50\u6811\u4E0D\u53EF\u8BA4\u9886" };
  if (box.fm.owner) {
    return { ok: false, blocker: box, reason: `\u5DF2\u88AB ${box.fm.owner} \u8BA4\u9886` };
  }
  let anc = box.parent;
  while (anc) {
    if (anc.fm.owner) {
      return { ok: false, blocker: anc, reason: `\u7956\u5148\u300C${anc.name}\u300D\u5DF2\u88AB ${anc.fm.owner} \u8BA4\u9886` };
    }
    anc = anc.parent;
  }
  const occupiedChild = findOccupied(box.children);
  if (occupiedChild) {
    return {
      ok: false,
      blocker: occupiedChild,
      reason: `\u5B50\u5B59\u300C${occupiedChild.name}\u300D\u5DF2\u88AB ${occupiedChild.fm.owner} \u8BA4\u9886`
    };
  }
  return { ok: true };
}
function findOccupied(boxes) {
  for (const b of boxes) {
    if (b.fm.owner) return b;
    const deep = findOccupied(b.children);
    if (deep) return deep;
  }
  return void 0;
}
function occupiedBoxes(tent) {
  const out = [];
  for (const root of tent.roots) collect(root, out);
  return out;
}
function collect(box, out) {
  if (box.fm.owner) out.push(box);
  for (const c of box.children) collect(c, out);
}

// src/core/tags.ts
var TAGS_REGISTRY_PATH = ".tent/tags.json";
async function loadTagRegistry(fs3) {
  if (!await fs3.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs3.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    return { tags: [] };
  }
}
async function saveTagRegistryUnlocked(fs3, registry) {
  if (!await fs3.exists(".tent")) await fs3.mkdir(".tent");
  await fs3.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
async function addRegistryTag(fs3, name) {
  await withTentMutation(fs3, async () => addRegistryTagUnlocked(fs3, name));
}
async function addRegistryTagUnlocked(fs3, name) {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs3);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs3, registry);
  }
}
async function addTag(fs3, boxId, name) {
  await withTentMutation(fs3, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs3);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    await addRegistryTagUnlocked(fs3, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs3, box, tags);
  });
}
async function removeTag(fs3, boxId, name) {
  await withTentMutation(fs3, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs3);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    await writeBoxTags(fs3, box, box.tags.filter((item) => item !== tag));
  });
}
async function removeRegistryTag(fs3, name) {
  await withTentMutation(fs3, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs3);
    await saveTagRegistryUnlocked(fs3, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs3);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs3, box, box.tags.filter((item) => item !== tag));
      }
    }
  });
}
function findBoxesByTag(tent, name) {
  let tag;
  try {
    tag = normalizeTagName(name);
  } catch {
    return [];
  }
  return [...tent.byId.values()].filter((box) => box.tags.includes(tag)).sort((a, b) => a.path.localeCompare(b.path));
}
function normalizeTagName(name) {
  const tag = name.trim();
  if (!tag) throw new Error("tag \u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("tag \u540D\u4E0D\u80FD\u5305\u542B\u8DEF\u5F84\u5206\u9694\u7B26\u6216\u6362\u884C");
  return tag;
}
async function writeBoxTags(fs3, box, tags) {
  const path2 = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs3.readFile(path2));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs3.writeFile(path2, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}
function normalizeRegistry2(value) {
  if (!isRecord2(value) || !Array.isArray(value.tags)) return { tags: [] };
  const tags = [];
  for (const valueTag of value.tags) {
    if (typeof valueTag !== "string") continue;
    try {
      tags.push(normalizeTagName(valueTag));
    } catch {
    }
  }
  return { tags: uniqueSorted(tags) };
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
function boxKeyOrder(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/skillRoleRegistry.ts
var ROLES_REGISTRY_PATH = ".tent/roles.json";
var DEFAULT_ROLES_REGISTRY = {
  roles: []
};
async function loadRolesRegistry(fs3) {
  if (!await fs3.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs3.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`roles.json \u635F\u574F: ${detail}`);
  }
}
function normalizeRolesRegistry(value) {
  const root = isRecord3(value) ? value : {};
  const roles = [];
  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord3(item)) continue;
      const role = normalizeRoleDefinition(item);
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      roles.push(role);
    }
  }
  return { roles };
}
function normalizeRoleDefinition(value) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const role = { name };
  if (typeof value.prompt === "string" && value.prompt.trim()) role.prompt = value.prompt.trim();
  if (typeof value.description === "string" && value.description.trim()) role.description = value.description.trim();
  if (typeof value.color === "string" && value.color.trim()) role.color = value.color.trim();
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}
function normalizeCliConfig(value) {
  if (value === void 0) return void 0;
  if (!isRecord3(value)) throw new Error("role cli \u5FC5\u987B\u662F\u5BF9\u8C61");
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) throw new Error("role cli.command \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
  const cli = { command };
  if (value.resume !== void 0) {
    const resume = typeof value.resume === "string" ? value.resume.trim() : "";
    if (!resume) throw new Error("role cli.resume \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
    cli.resume = resume;
  }
  return cli;
}
function cloneDefaultRoles() {
  return {
    roles: DEFAULT_ROLES_REGISTRY.roles.map((role) => ({ ...role }))
  };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/task.ts
function relayPromptForTask(task, tentRoot) {
  const initPath = join("temp", task.role, "init.md");
  return `Tent task dispatched to role ${task.role}.
Tent root: ${tentRoot}
1. Run \`tent task-ack ${task.path}\` to take this task.
2. Read the envelope, then open the claimed box(es) \u2014 the box note is the task definition.
3. If this is a new session for this role, complete role init first: ${initPath}.`;
}
async function ensureRoleInit(fs3, role, tentName) {
  const path2 = join("temp", role.name, "init.md");
  const body = `# Role Init

- Tent: ${tentName}
- Rules: RULES.md
- Role registry: .tent/roles.json (or run \`tent roles\`)

## Role Prompt

${role.prompt?.trim() || "(\u65E0\u957F\u671F role prompt)"}

## Operating Model

Manifest \u7684 readable/writable \u662F honor contract\uFF0C\u4E0D\u662F\u5B89\u5168\u6C99\u7BB1\u3002\u9047\u5230 prompt \u51B2\u7A81\u6216\u65E0\u6CD5\u9075\u5B88\u7684\u8FB9\u754C\u65F6\uFF0C\u505C\u6B62\u5E76\u8BE2\u95EE user\u3002
`;
  await fs3.writeFile(path2, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path2;
}
async function writeTaskEnvelope(fs3, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("\u6D3E\u6D3B\u5FC5\u987B\u63D0\u4F9B user prompt");
  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs3, dir);
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path2 = await uniqueMarkdownPath(fs3, dir, stem);
  const data = {
    type: "task",
    status: "pending",
    role: input.role,
    dispatchedBy: input.dispatchedBy?.trim() || "user",
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath
  };
  if (input.workspace) {
    data.workspace = input.workspace.workspace;
    data.worktree = input.workspace.worktree;
    data.branch = input.workspace.branch;
    data.targetBranch = input.workspace.targetBranch;
  }
  const pointers = input.claims.map((claim) => `- ${claim.id}: ${claim.path}`).join("\n");
  const body = `# Task

## Context Pointers

${pointers}

- Manifest: ${input.manifestPath}

## User Prompt

${userPrompt}
`;
  await fs3.writeFile(path2, serializeFrontmatter(data, body));
  return path2;
}
async function ackTaskEnvelope(fs3, path2) {
  const raw = await fs3.readFile(path2);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`task envelope \u683C\u5F0F\u65E0\u6548: ${path2}`);
  data.status = "taken";
  await fs3.writeFile(path2, serializeFrontmatter(data, body, keyOrder));
}
function taskStem(now, claimId) {
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp2}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs3, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path2 = join(dir, `${stem}${suffix}.md`);
    if (!await fs3.exists(path2)) return path2;
  }
}
async function ensureDir(fs3, path2) {
  if (!await fs3.exists(path2)) await fs3.mkdir(path2);
}

// src/core/report.ts
async function submitReport(fs3, clock, boxId, body, commits) {
  return withTentMutation(fs3, async () => submitReportUnlocked(fs3, clock, boxId, body, commits));
}
async function submitReportUnlocked(fs3, clock, boxId, body, commits) {
  const text = body.trim();
  if (!text) throw new Error("report \u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
  const tent = await loadTent(fs3);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
  const role = box.fm.owner;
  if (!role) throw new Error("\u53EA\u6709\u76F4\u63A5\u5E26 owner \u7684\u8BA4\u9886\u6846\u53EF\u4EE5\u63D0\u4EA4 report");
  const path2 = reportPath(role, box.id);
  if (await fs3.exists(path2)) {
    const current = await loadReport(fs3, path2);
    if (current.status === "ready") throw new Error("\u5DF2\u6709\u5F85\u88C1 report;\u9700\u5148\u7531 user \u786E\u8BA4\u6216\u9A73\u56DE");
  }
  const report = {
    path: path2,
    boxId: box.id,
    role,
    status: "ready",
    commits: uniqueCommits(commits),
    timestamp: clock.now(),
    body: text
  };
  await ensureDir2(fs3, join("temp", role, "reports"));
  await writeReport(fs3, report);
  return report;
}
async function loadReports(fs3) {
  const reports = [];
  if (!await fs3.exists("temp")) return reports;
  for (const roleDir of await fs3.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!await fs3.exists(dir)) continue;
    for (const entry of await fs3.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path2 = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs3, path2));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs3, inputPath) {
  const path2 = normalizeReportPath(inputPath);
  if (!await fs3.exists(path2)) throw new Error(`\u627E\u4E0D\u5230 report: ${path2}`);
  const { data, body } = parseFrontmatter(await fs3.readFile(path2));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`report \u683C\u5F0F\u65E0\u6548: ${path2}`);
  }
  return {
    path: path2,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function removeReportsForBox(fs3, boxId) {
  for (const report of await loadReports(fs3)) {
    if (report.boxId === boxId && await fs3.exists(report.path)) await fs3.remove(report.path);
  }
}
function reportPath(role, boxId) {
  return join("temp", role, "reports", `${boxId}.md`);
}
function normalizeReportPath(input) {
  const path2 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/bx-[^/]+\.md$/.test(path2)) {
    throw new Error("report \u5FC5\u987B\u6307\u5411 temp/<role>/reports/<boxId>.md");
  }
  return path2;
}
async function writeReport(fs3, report) {
  const data = {
    type: "report",
    box: report.boxId,
    role: report.role,
    status: report.status,
    commits: report.commits,
    ts: report.timestamp,
    review: report.review
  };
  await fs3.writeFile(
    report.path,
    serializeFrontmatter(data, report.body + "\n", ["type", "box", "role", "status", "commits", "ts", "review"])
  );
}
async function ensureDir2(fs3, path2) {
  if (!await fs3.exists(path2)) await fs3.mkdir(path2);
}
function uniqueCommits(commits) {
  return [...new Set(commits.map((item) => item.trim()).filter(Boolean))];
}

// src/core/proposal.ts
function validateProposalTarget(tent, targetId) {
  const target = tent.byId.get(targetId);
  if (!target) return { ok: false, reason: `\u627E\u4E0D\u5230\u76EE\u6807\u6846 ${targetId}` };
  if (target.invalid || target.archived) return { ok: false, reason: `\u76EE\u6807\u6846\u4E0D\u53EF\u63D0 proposal:${target.invalidReason || "\u5DF2\u5F52\u6863"}` };
  if (!target.readable.value) return { ok: false, reason: `\u76EE\u6807\u6846\u4E0D\u53EF\u8BFB,\u4E0D\u80FD\u63D0 proposal: ${targetId}` };
  return { ok: true, target };
}

// src/core/collaborationOps.ts
async function propose(env, targetId, role, body) {
  return withTentMutation(env.fs, async () => {
    const roleName = assertRoleName(role);
    const tent = await loadTent(env.fs);
    const check = validateProposalTarget(tent, targetId);
    if (!check.ok) throw new Error(check.reason || "proposal target \u4E0D\u53EF\u7528");
    const content = body.trim();
    if (!content) throw new Error("proposal \u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
    const dir = join("temp", roleName, "proposals");
    await ensureDir3(env.fs, dir);
    const proposalPath = await uniqueProposalPath(
      env.fs,
      dir,
      targetId,
      env.clock.now()
    );
    const data = {
      type: "proposal",
      target: targetId,
      status: "open",
      from: roleName
    };
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(
        data,
        content + "\n",
        ["type", "target", "status", "from", "note"]
      )
    );
    return { proposalPath };
  });
}
async function applyProposal(env, proposalPath, accept, note) {
  await withTentMutation(env.fs, async () => {
    const raw = await env.fs.readFile(proposalPath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (accept) {
      const targetId = typeof data.target === "string" ? data.target : String(data.target || "");
      const check = validateProposalTarget(await loadTent(env.fs), targetId);
      if (!check.ok) throw new Error(check.reason || "proposal target \u4E0D\u53EF\u7528");
    }
    data.status = accept ? "accepted" : "rejected";
    if (note) data.note = note;
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(data, body, keyOrder)
    );
  });
}
async function startApply(env, proposalPath) {
  const { data, body } = parseFrontmatter(await env.fs.readFile(proposalPath));
  if (data.status !== "accepted") {
    throw new Error(
      `proposal \u4E0D\u662F accepted \u72B6\u6001(\u5F53\u524D ${data.status});\u53EA\u6709 user \u6279\u51C6\u8FC7\u7684\u624D\u80FD\u843D\u5730`
    );
  }
  const targetId = String(data.target);
  const tent = await loadTent(env.fs);
  const check = validateProposalTarget(tent, targetId);
  if (!check.ok || !check.target) {
    throw new Error(check.reason || `\u627E\u4E0D\u5230\u76EE\u6807\u6846 ${targetId}`);
  }
  const target = check.target;
  if (!isUsableBox(target)) {
    throw new Error(`\u76EE\u6807\u6846\u4E0D\u53EF\u843D\u5730:${target.invalidReason || "\u5DF2\u5F52\u6863"}`);
  }
  return {
    targetId,
    targetPath: target.path,
    instructions: body.trim()
  };
}
async function finishApply(env, proposalPath) {
  await withTentMutation(env.fs, async () => {
    const { data, body, keyOrder } = parseFrontmatter(
      await env.fs.readFile(proposalPath)
    );
    if (data.status !== "accepted") {
      throw new Error("proposal \u4E0D\u662F accepted \u72B6\u6001,\u65E0\u6CD5\u6536\u5C3E");
    }
    data.status = "applied";
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(data, body, keyOrder)
    );
  });
}
async function ensureDir3(fs3, path2) {
  if (path2 && !await fs3.exists(path2)) await fs3.mkdir(path2);
}
function assertRoleName(role) {
  const name = role.trim();
  if (!name) throw new Error("role \u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (/[\/\\\r\n]/.test(name)) {
    throw new Error("role \u540D\u4E0D\u80FD\u5305\u542B\u8DEF\u5F84\u5206\u9694\u7B26\u6216\u6362\u884C");
  }
  return name;
}
async function uniqueProposalPath(fs3, dir, targetId, now) {
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 18) || "proposal";
  const safeTarget = targetId.replace(/[^0-9A-Za-z_-]+/g, "-") || "target";
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `-${index}`;
    const path2 = join(dir, `pr-${stamp2}-${safeTarget}${suffix}.md`);
    if (!await fs3.exists(path2)) return path2;
    index += 1;
  }
}

// src/core/forkOps.ts
async function forkNode(env, boxId) {
  return withTentMutation(env.fs, async () => forkNodeUnlocked(env, boxId));
}
async function forkNodeUnlocked(env, boxId) {
  const tent = await loadTent(env.fs);
  const source = tent.byId.get(boxId);
  if (!source) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
  if (!isUsableBox(source)) throw new Error("\u5931\u6548\u6216\u5F52\u6863\u6846\u4E0D\u80FD fork");
  const parentPath = dirName(source.path);
  const forkPath = await uniqueSiblingPath(env.fs, parentPath, `${source.name} (fork)`);
  await copyTree(env.fs, source.path, forkPath);
  const sourceBoxes = collectSubtree(source);
  const usedIds = new Set(tent.byId.keys());
  const idMap = /* @__PURE__ */ new Map();
  for (const box of sourceBoxes) {
    const nextId = makeUniqueBoxId(usedIds, env.rand);
    usedIds.add(nextId);
    idMap.set(box.id, nextId);
  }
  const forkRootId = idMap.get(source.id);
  for (const box of sourceBoxes) {
    const rel = relativePath(source.path, box.path);
    const nextPath = rel ? join(forkPath, rel) : forkPath;
    const notePath = boxNotePath(nextPath);
    await ensureIdentityFileName(env.fs, nextPath, box.path);
    const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(notePath));
    data.id = idMap.get(box.id);
    delete data.owner;
    delete data.status;
    delete data.forkOf;
    delete data.forkBase;
    await env.fs.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
  }
  const order = await loadOrder(env.fs);
  const parentKey = source.parent ? source.parent.id : ROOT_KEY;
  const siblings = (source.parent ? source.parent.children : tent.roots).map((box) => box.id);
  const idx = siblings.indexOf(source.id);
  siblings.splice(idx === -1 ? siblings.length : idx + 1, 0, forkRootId);
  order[parentKey] = siblings;
  for (const box of sourceBoxes) {
    const oldChildren = order[box.id];
    const newId = idMap.get(box.id);
    if (oldChildren && newId) {
      order[newId] = oldChildren.map((id) => idMap.get(id)).filter((id) => !!id);
    }
  }
  await saveOrder(env.fs, order);
  return forkRootId;
}
async function uniqueSiblingPath(fs3, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!await fs3.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs3, from, to) {
  await fs3.mkdir(to);
  for (const entry of await fs3.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs3, src, dst);
    else await fs3.writeFile(dst, await fs3.readFile(src));
  }
}
function collectSubtree(box, out = []) {
  out.push(box);
  for (const child of box.children) collectSubtree(child, out);
  return out;
}
function relativePath(root, child) {
  if (child === root) return "";
  return child.slice(root.length + 1);
}
async function ensureIdentityFileName(fs3, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs3.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs3.exists(copied)) await fs3.move(copied, expected);
}

// src/core/ops.ts
async function dispatch(env, claimId, role, promptOrOptions) {
  return withMutation(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}
async function dispatchUnlocked(env, claimId, role, promptOrOptions) {
  const tent = await loadTent(env.fs);
  const roleName = assertRoleName2(role);
  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const options = typeof promptOrOptions === "string" ? { userPrompt: promptOrOptions } : promptOrOptions;
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("\u6D3E\u6D3B\u5FC5\u987B\u63D0\u4F9B user prompt");
  if (claim.root) {
    const occupied = occupiedBoxes(tent);
    if (occupied.length > 0) {
      throw new Error(`\u4E0D\u80FD\u6D3E\u6D3B:\u5E10\u6839\u4E0B\u5DF2\u6709\u8BA4\u9886\u300C${occupied[0].name}\u300D(${occupied[0].fm.owner})`);
    }
  } else {
    const existingOwner = ownerCovering(claim.box);
    if (existingOwner) {
      throw new Error(`\u4E0D\u80FD\u6D3E\u6D3B:${existingOwner.name} \u5DF2\u88AB ${existingOwner.fm.owner} \u8BA4\u9886`);
    }
    const claimable = canClaim(claim.box);
    if (!claimable.ok) throw new Error(`\u4E0D\u80FD\u6D3E\u6D3B:${claimable.reason || "\u6846\u4E0D\u53EF\u8BA4\u9886"}`);
    await setOwner(env.fs, claim.box, roleName, "doing");
    claim.box.fm.owner = roleName;
    claim.box.fm.status = "doing";
  }
  const ownedClaims = claim.root ? [] : [...tent.byPath.values()].filter((box) => box.fm.owner === roleName);
  const input = claim.root ? { tentName: env.tentName, role: roleName, claimRoot: true, ...options.workspace } : { tentName: env.tentName, role: roleName, claimBoxes: ownedClaims, ...options.workspace };
  const manifest = buildManifest(tent, input);
  const yaml = manifestToYaml(manifest);
  const manifestPath = join("temp", roleName, "manifest.yml");
  await ensureDir4(env.fs, dirName(manifestPath));
  await env.fs.writeFile(manifestPath, yaml);
  const registry = await loadRolesRegistry(env.fs);
  const roleDefinition = registry.roles.find((item) => item.name === roleName) ?? { name: roleName };
  const initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
  const taskClaims = claim.root ? [{ id: "root", path: "./" }] : [{ id: claim.box.id, path: claim.box.path }];
  const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
    role: roleName,
    claims: taskClaims,
    manifestPath,
    userPrompt,
    workspace: options.workspace,
    dispatchedBy: options.dispatchedBy
  });
  const relayPrompt = relayPromptForTask(
    {
      path: taskPath,
      role: roleName,
      claims: taskClaims.map((taskClaim) => taskClaim.id),
      manifest: manifestPath,
      status: "pending"
    },
    env.tentRoot || env.tentName
  );
  return { manifestPath, manifestYaml: yaml, initPath, taskPath, relayPrompt };
}
function resolveDispatchClaim(tent, claimId, tentName) {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) return { root: true, id: "root", name: "\u5E10\u6839" };
  const box = tent.byId.get(id);
  if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${claimId}`);
  return { root: false, id: box.id, name: box.name, box };
}
async function stamp(env, boxId, acceptedBy = "user") {
  await completeClaim(env, boxId, void 0, acceptedBy);
}
async function completeClaim(env, boxId, integrate, acceptedBy = "user") {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (integrate) await integrate();
    await setOwner(env.fs, box, void 0, "done", acceptedBy);
  });
}
async function acceptReport(env, reportPath2, options = {}) {
  await withMutation(env.fs, async () => {
    const report = await loadReport(env.fs, reportPath2);
    if (report.status !== "ready") throw new Error("\u53EA\u6709 ready report \u53EF\u4EE5\u786E\u8BA4");
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(report.boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${report.boxId}`);
    if (box.fm.owner !== report.role) throw new Error("report role \u4E0E\u5F53\u524D owner \u4E0D\u4E00\u81F4");
    const commits = options.commits ?? report.commits;
    if (commits.length > 0) {
      if (!options.integrate) throw new Error("report \u542B commits,\u5FC5\u987B\u5B8C\u6210 workspace \u5408\u5165");
      await options.integrate(commits);
    }
    await setOwner(env.fs, box, void 0, "done", options.acceptedBy ?? "user");
    await env.fs.remove(report.path);
  });
}
async function grantReadable(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (!isUsableBox(box)) throw new Error("\u5931\u6548\u6216\u5F52\u6863\u6846\u4E0D\u80FD\u7FFB\u53EF\u8BFB");
    await patchFrontmatter(env.fs, box, { readable: true });
  });
}
async function cleanTemp(env, role) {
  await withMutation(env.fs, async () => {
    const target = role ? join("temp", role) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!role) await ensureDir4(env.fs, "temp");
  });
}
async function forceRelease(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (!box.fm.owner) throw new Error("\u53EA\u80FD\u4E2D\u65AD\u76F4\u63A5\u5E26 owner \u7684\u8BA4\u9886\u6839");
    await setOwner(env.fs, box, void 0, "todo");
    await removeReportsForBox(env.fs, box.id);
  });
}
async function tagBox(env, boxId, name) {
  await addTag(env.fs, boxId, normalizeTagName(name));
}
async function untagBox(env, boxId, name) {
  await removeTag(env.fs, boxId, normalizeTagName(name));
}
async function createTag(env, name) {
  await addRegistryTag(env.fs, normalizeTagName(name));
}
async function deleteTag(env, name) {
  await removeRegistryTag(env.fs, normalizeTagName(name));
}
async function createBox(env, input) {
  return withMutation(env.fs, async () => createBoxUnlocked(env, input));
}
async function createBoxUnlocked(env, input) {
  assertNotTempPath(input.parentPath);
  const tent = await loadTent(env.fs);
  if (!typeExists(input.type, tent.typeRegistry)) throw new Error(`\u672A\u77E5 type: ${input.type}`);
  if (input.parentPath) {
    const parent2 = tent.byPath.get(input.parentPath);
    if (!parent2 || !isUsableBox(parent2)) throw new Error("\u76EE\u6807\u7236\u6846\u5931\u6548\u6216\u5DF2\u5F52\u6863");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueBoxId(existing, env.rand);
  const path2 = join(input.parentPath, input.name);
  assertNotTempPath(path2);
  await ensureDir4(env.fs, path2);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${input.name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path2), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path2);
    throw error;
  }
  return id;
}
async function setOwner(fs3, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs3, box, patch);
}
async function patchFrontmatter(fs3, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs3.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await fs3.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
}
async function ensureDir4(fs3, path2) {
  if (path2 && !await fs3.exists(path2)) await fs3.mkdir(path2);
}
function boxKeyOrder2(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function assertNotTempPath(path2) {
  if (path2 === "temp" || path2.startsWith("temp/")) {
    throw new Error("temp \u662F\u7CFB\u7EDF\u7BA1\u9053,\u4E0D\u5141\u8BB8\u521B\u5EFA\u6216\u79FB\u52A8 typed box");
  }
}
function assertRoleName2(role) {
  const name = role.trim();
  if (!name) throw new Error("role \u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (/[\/\\\r\n]/.test(name)) throw new Error("role \u540D\u4E0D\u80FD\u5305\u542B\u8DEF\u5F84\u5206\u9694\u7B26\u6216\u6362\u884C");
  return name;
}
function ownerCovering(box) {
  if (box.fm.owner) return box;
  let parent = box.parent;
  while (parent) {
    if (parent.fm.owner) return parent;
    parent = parent.parent;
  }
  return void 0;
}
async function withMutation(fs3, action) {
  return withTentMutation(fs3, action);
}

// src/core/scaffold.ts
async function scaffoldTent(fs3, options) {
  const name = options.name.trim();
  if (!name) throw new Error("\u5E10\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (!options.rules.trim()) throw new Error("RULES.md \u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
  const usedIds = /* @__PURE__ */ new Set();
  for (const box of options.boxes ?? []) {
    const boxName = box.name.trim();
    if (!boxName || boxName.includes("/") || boxName.includes("\\")) {
      throw new Error(`\u65E0\u6548\u6846\u540D: ${box.name}`);
    }
    const type = box.kind?.trim() || box.type.trim();
    if (!type) throw new Error(`\u6846\u300C${boxName}\u300D\u7F3A\u4E00\u7EA7 type`);
    const id = box.id?.trim() || makeUniqueBoxId(usedIds);
    usedIds.add(id);
    const frontmatter = { id, type };
    await writeBox(fs3, boxName, frontmatter, box.body ?? `# ${boxName}
`);
  }
  await fs3.mkdir("temp");
  await fs3.mkdir(".tent");
  await fs3.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(options.typeRegistry ?? DEFAULT_TYPE_REGISTRY, null, 2) + "\n");
  await fs3.writeFile(ROLES_REGISTRY_PATH, JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n");
  await fs3.writeFile(TAGS_REGISTRY_PATH, JSON.stringify({ tags: [] }, null, 2) + "\n");
  await fs3.writeFile("RULES.md", options.rules);
}
async function writeBox(fs3, path2, frontmatter, body) {
  await fs3.mkdir(path2);
  await fs3.writeFile(boxNotePath(path2), serializeFrontmatter(frontmatter, `
${body}
`, BOX_FRONTMATTER_KEY_ORDER));
}

// src/core/output.ts
function parseOutputPointer(fm, body) {
  const result = {};
  const fmWorkspace = fieldString(fm.workspace);
  if (fmWorkspace) result.workspace = fmWorkspace;
  const fmRef = fieldString(fm.ref);
  if (fmRef) result.ref = fmRef;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = normalizeLabelLine(rawLine);
    if (!result.workspace) {
      const workspace = matchField(line, ["workspace", "workspace \u8DEF\u5F84", "repo", "pointer", "\u8DEF\u5F84"]);
      if (workspace) result.workspace = workspace;
    }
    if (!result.ref) {
      const ref = matchField(line, ["git ref", "git-ref", "\u5F53\u524D ref", "commit", "ref"]);
      if (ref) result.ref = ref;
    }
  }
  return result;
}
function fieldString(value) {
  return typeof value === "string" && value.trim() ? cleanValue(value) : void 0;
}
function normalizeLabelLine(line) {
  return line.trim().replace(/^[-*]\s+/, "").replace(/\*\*/g, "").replace(/`([^`]+)`/g, "$1").trim();
}
function matchField(line, fields) {
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}\\s*[:\uFF1A]\\s*(.+)$`, "i").exec(line);
    if (match) return cleanValue(match[1]);
  }
  return void 0;
}
function cleanValue(value) {
  return value.trim().replace(/^`|`$/g, "").trim();
}

// src/core/typeManagement.ts
async function migrateKindToType(fs3) {
  return withTentMutation(fs3, async () => {
    const tent = await loadTent(fs3);
    const touched = [];
    for (const box of tent.byPath.values()) {
      const kind = typeof box.fm.kind === "string" ? box.fm.kind.trim() : "";
      if (!kind) continue;
      const path2 = boxNotePath(box.path);
      const { data, body, keyOrder } = parseFrontmatter(await fs3.readFile(path2));
      const base = typeof data.type === "string" && data.type.trim() ? data.type.trim() : "custom";
      data.type = joinType(base, kind);
      delete data.kind;
      await fs3.writeFile(path2, serializeFrontmatter(data, body, boxKeyOrder3(keyOrder)));
      touched.push(path2);
    }
    const registry = await loadTypeRegistry(fs3);
    await writeTypeRegistryUnlocked(fs3, registry);
    touched.push(TYPE_REGISTRY_PATH);
    return touched;
  });
}
async function writeTypeRegistryUnlocked(fs3, registry) {
  if (!await fs3.exists(".tent")) await fs3.mkdir(".tent");
  await fs3.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}
function boxKeyOrder3(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}

// src/core/okf.ts
async function syncOkfBundle(fs3) {
  return withTentMutation(fs3, async () => syncOkfBundleUnlocked(fs3));
}
async function syncOkfBundleUnlocked(fs3) {
  const tent = await loadTent(fs3);
  const concepts = [...tent.byPath.values()];
  const index = buildConceptIndex(concepts);
  const generatedFiles = await writeIndexes(fs3, concepts);
  const projection = await projectWikiLinks(fs3, concepts, index);
  return { generatedFiles, ...projection };
}
function buildConceptIndex(boxes) {
  const index = /* @__PURE__ */ new Map();
  for (const box of boxes) {
    const concept = toConcept(box);
    addIndex(index, concept.boxId, concept);
    addIndex(index, concept.id, concept);
    addIndex(index, concept.path, concept);
    addIndex(index, concept.notePath, concept);
    addIndex(index, concept.name, concept);
  }
  return index;
}
function resolveConcept(index, target) {
  const clean = target.trim().replace(/^\.\//, "").replace(/\.md$/i, "");
  const matches = index.get(clean) ?? index.get(`${clean}.md`) ?? index.get(normalizeLookupKey(clean));
  if (matches?.length === 1) return matches[0];
  const normalized = normalizeLookupKey(clean);
  if (normalized.length >= 4) {
    const all = index.get("__all__") ?? [];
    const fuzzy = all.filter((concept) => normalizeLookupKey(concept.name).includes(normalized));
    if (fuzzy.length === 1) return fuzzy[0];
  }
  return matches?.length === 1 ? matches[0] : void 0;
}
function projectMarkdownLinks(body, fromNotePath, index) {
  const unresolved = [];
  let changed = false;
  const next = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (full, rawTarget, rawLabel, offset) => {
    if (offset > 0 && body[offset - 1] === "!") return full;
    const target = rawTarget.trim();
    const concept = resolveConcept(index, target);
    if (!concept) {
      unresolved.push(target);
      return full;
    }
    const label = (rawLabel ?? concept.name).trim();
    const href = relativeMarkdownPath(fromNotePath, concept.notePath);
    changed = true;
    return `[${label}](${markdownLinkDestination(href)})`;
  });
  return { body: next, unresolved, changed };
}
async function projectWikiLinks(fs3, boxes, index) {
  const projectedFiles = [];
  const unresolved = [];
  for (const box of boxes) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs3.readFile(notePath));
    const projected = projectMarkdownLinks(body, notePath, index);
    if (projected.unresolved.length > 0) {
      unresolved.push(...projected.unresolved.map((target) => ({ file: notePath, target })));
    }
    if (!projected.changed) continue;
    await fs3.writeFile(notePath, serializeFrontmatter(data, projected.body, keyOrder));
    projectedFiles.push(notePath);
  }
  return { projectedFiles, unresolved };
}
async function writeIndexes(fs3, boxes) {
  const generated = /* @__PURE__ */ new Set();
  const byDir = /* @__PURE__ */ new Map();
  for (const box of boxes) {
    const dir = dirName(boxNotePath(box.path));
    const list = byDir.get(dir) ?? [];
    list.push(box);
    byDir.set(dir, list);
  }
  const roots = boxes.filter((box) => !box.parent);
  await fs3.writeFile(
    "index.md",
    serializeFrontmatter(
      { type: "index", okf_version: "0.1" },
      "# Index\n\n" + roots.map((box) => `- [${box.name}](${markdownLinkDestination(boxNotePath(box.path))})`).join("\n") + "\n"
    )
  );
  generated.add("index.md");
  for (const [dir, siblings] of byDir.entries()) {
    if (!dir) continue;
    const indexPath = join(dir, "index.md");
    await fs3.writeFile(
      indexPath,
      serializeFrontmatter(
        { type: "index" },
        "# Index\n\n" + siblings.map((box) => `- [${box.name}](${markdownLinkDestination(`${box.name}.md`)})`).join("\n") + "\n"
      )
    );
    generated.add(indexPath);
  }
  await fs3.writeFile("log.md", serializeFrontmatter({ type: "log" }, "# Log\n\n_No log entries._\n"));
  generated.add("log.md");
  return [...generated].sort();
}
function toConcept(box) {
  const notePath = boxNotePath(box.path);
  const id = notePath.replace(/\.md$/i, "");
  return {
    id,
    boxId: box.id,
    path: box.path,
    notePath,
    name: box.name,
    type: box.type
  };
}
function addIndex(index, key, concept) {
  const clean = key.trim();
  if (!clean) return;
  addRawIndex(index, clean, concept);
  addRawIndex(index, normalizeLookupKey(clean), concept);
  addRawIndex(index, "__all__", concept);
}
function addRawIndex(index, key, concept) {
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.some((item) => item.id === concept.id)) list.push(concept);
  index.set(key, list);
}
function normalizeLookupKey(value) {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}
function relativeMarkdownPath(fromNotePath, toNotePath) {
  const fromParts = dirName(fromNotePath).split("/").filter(Boolean);
  const toParts = toNotePath.split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  const up = fromParts.map(() => "..");
  const rel = [...up, ...toParts].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
function markdownLinkDestination(destination) {
  if (!/[\s<>()]/.test(destination)) return destination;
  return `<${destination.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}

// src/core/workspace.ts
import * as nodePath2 from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
function resolveTentWorkspace(tent) {
  const workspaces = /* @__PURE__ */ new Set();
  for (const box of tent.byPath.values()) {
    if (splitType(box.type).base !== "output") continue;
    const workspace = parseOutputPointer(box.fm, box.body).workspace;
    if (workspace) workspaces.add(nodePath2.resolve(workspace));
  }
  if (workspaces.size > 1) {
    throw new Error(`\u4E00\u9876 Tent \u53EA\u80FD\u5BF9\u5E94\u4E00\u4E2A workspace,\u5F53\u524D\u53D1\u73B0: ${[...workspaces].join(", ")}`);
  }
  return [...workspaces][0];
}
async function runWorkspaceCheck(workspace, command) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const script = command.trim();
  if (!script) throw new Error("--require-check \u5FC5\u987B\u63D0\u4F9B\u975E\u7A7A\u547D\u4EE4");
  return runShell(root, script);
}
async function ensureRoleWorkspace(workspace, role) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const targetBranch = await resolveTargetBranch(root);
  const roleSlug = safeComponent(role);
  const branch = `tent-role/${roleSlug}`;
  const worktree = nodePath2.join(
    nodePath2.dirname(root),
    `${nodePath2.basename(root)}-worktrees`,
    roleSlug
  );
  const existing = await worktreeForBranch(root, branch);
  if (existing) {
    return { workspace: root, worktree: await nodeFs.realpath(nodePath2.resolve(existing)), branch, targetBranch };
  }
  if (await pathExists(worktree)) {
    throw new Error(`role worktree \u8DEF\u5F84\u5DF2\u5B58\u5728\u4F46\u672A\u767B\u8BB0\u7ED9 ${branch}: ${worktree}`);
  }
  const branchExists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists) {
    await git(root, ["worktree", "add", worktree, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, worktree, targetBranch]);
  }
  return { workspace: root, worktree: await nodeFs.realpath(worktree), branch, targetBranch };
}
async function integrateWorkspaceCommits(contract, refs) {
  const commits = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (commits.length === 0) return [];
  const root = contract.workspace;
  const current = (await git(root, ["branch", "--show-current"])).trim();
  if (current !== contract.targetBranch) {
    throw new Error(`workspace \u5FC5\u987B checkout ${contract.targetBranch},\u5F53\u524D\u662F ${current || "(detached)"}`);
  }
  const dirty = (await git(root, ["status", "--porcelain"])).trim();
  if (dirty) throw new Error("workspace \u6709\u672A\u63D0\u4EA4\u6539\u52A8,\u4E0D\u80FD\u9A8C\u6536\u5408\u5165");
  const originalRef = (await git(root, ["rev-parse", `refs/heads/${contract.targetBranch}`])).trim();
  const resolved = [];
  for (const sourceRef of commits) {
    await git(root, ["cat-file", "-e", `${sourceRef}^{commit}`]);
    resolved.push({ sourceRef, fullRef: await fullRef(root, sourceRef) });
  }
  const fastForwardRef = await completeFastForwardRef(root, originalRef, resolved.map((item) => item.fullRef));
  if (fastForwardRef) {
    try {
      await git(root, ["merge", "--ff-only", fastForwardRef]);
      return resolved.map(({ sourceRef, fullRef: integratedRef }) => ({
        sourceRef,
        integratedRef,
        alreadyIntegrated: false
      }));
    } catch (error) {
      await rollbackIntegration(root, originalRef, error);
    }
  }
  const results = [];
  try {
    for (const { sourceRef } of resolved) {
      const ancestor = await findAncestorIntegration(root, sourceRef, contract.targetBranch);
      if (ancestor) {
        results.push({ sourceRef, integratedRef: ancestor, alreadyIntegrated: true });
        continue;
      }
      const prior = await findCherryPick(root, sourceRef);
      if (prior) {
        results.push({ sourceRef, integratedRef: prior, alreadyIntegrated: true });
        continue;
      }
      await git(root, ["cherry-pick", "-x", sourceRef]);
      const integratedRef = (await git(root, ["rev-parse", "HEAD"])).trim();
      results.push({ sourceRef, integratedRef, alreadyIntegrated: false });
    }
  } catch (error) {
    await rollbackIntegration(root, originalRef, error);
  }
  return results;
}
async function assertGitWorkspace(root) {
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const [realTop, realRoot] = await Promise.all([
    nodeFs.realpath(nodePath2.resolve(top)),
    nodeFs.realpath(root)
  ]);
  if (realTop.toLowerCase() !== realRoot.toLowerCase()) {
    throw new Error(`workspace \u5FC5\u987B\u662F Git \u6839\u76EE\u5F55: ${root}`);
  }
}
async function resolveTargetBranch(root) {
  for (const name of ["main", "master"]) {
    if (await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  const current = (await git(root, ["branch", "--show-current"])).trim();
  if (!current) throw new Error("\u65E0\u6CD5\u8BC6\u522B workspace \u6B63\u5F0F\u5206\u652F");
  return current;
}
async function worktreeForBranch(root, branch) {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  let currentPath = "";
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return currentPath;
  }
  return void 0;
}
async function findCherryPick(root, sourceRef) {
  const needle = `(cherry picked from commit ${await fullRef(root, sourceRef)})`;
  const output = await git(root, ["log", "--format=%H%x00%B%x00", contractRange()]);
  const parts = output.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i + 1].includes(needle)) return parts[i].trim();
  }
  return void 0;
}
async function findAncestorIntegration(root, sourceRef, targetBranch) {
  const targetRef = `refs/heads/${targetBranch}`;
  if (await gitOk(root, ["merge-base", "--is-ancestor", sourceRef, targetRef])) {
    return (await git(root, ["rev-parse", targetRef])).trim();
  }
  return void 0;
}
async function completeFastForwardRef(root, targetRef, commits) {
  const lastRef = commits.at(-1);
  if (!lastRef || lastRef === targetRef) return void 0;
  if (!await gitOk(root, ["merge-base", "--is-ancestor", targetRef, lastRef])) return void 0;
  const range = (await git(root, ["rev-list", "--reverse", `${targetRef}..${lastRef}`])).split(/\r?\n/).map((ref) => ref.trim()).filter(Boolean);
  if (range.length !== commits.length) return void 0;
  const supplied = new Set(commits);
  return range.every((ref) => supplied.has(ref)) ? lastRef : void 0;
}
async function rollbackIntegration(root, originalRef, cause) {
  await git(root, ["cherry-pick", "--abort"]).catch(() => "");
  try {
    await git(root, ["reset", "--hard", originalRef]);
  } catch (rollbackError) {
    throw new Error(
      `workspace \u5408\u5165\u5931\u8D25\u4E14\u56DE\u6EDA\u5931\u8D25: ${errorMessage(cause)}; rollback: ${errorMessage(rollbackError)}`
    );
  }
  throw new Error(`workspace \u5408\u5165\u51B2\u7A81,\u5DF2\u56DE\u6EDA: ${errorMessage(cause)}`);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function contractRange() {
  return "-n1000";
}
async function fullRef(root, ref) {
  return (await git(root, ["rev-parse", ref])).trim();
}
function safeComponent(value) {
  const source = value.trim();
  const normalized = source.normalize("NFKC");
  let clean = normalized.replace(/[<>:"/\\|?*\x00-\x1f~^:[\]@{}]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 40);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean);
  if (reserved) clean = `role-${clean}`;
  if (!clean) return `role-${shortHash(source)}`;
  return clean !== normalized || normalized !== source || reserved ? `${clean}-${shortHash(source)}` : clean;
}
function shortHash(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}
async function pathExists(path2) {
  try {
    await nodeFs.access(path2);
    return true;
  } catch {
    return false;
  }
}
async function gitOk(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
function git(cwd, args) {
  return new Promise((resolve4, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => {
      if (code === 0) resolve4(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}
function runShell(cwd, command) {
  return new Promise((resolve4, reject) => {
    const windows = process.platform === "win32";
    const shell = windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = windows ? ["/d", "/s", "/c", command] : ["-lc", command];
    const child = spawn(shell, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => {
      if (code === 0) {
        resolve4({ command, stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
      reject(new Error(`require-check failed (${code}): ${command}
${detail}`));
    });
    child.on("error", (error) => {
      reject(new Error(`require-check failed to start: ${command}
${error.message}`));
    });
  });
}

// src/cli/tent.ts
function makeEnv() {
  const root = process.cwd();
  return {
    fs: new NodeFs(root),
    clock: new SystemClock(),
    tentName: path.basename(root),
    tentRoot: root
  };
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const env = makeEnv();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(await packageVersion());
    return;
  }
  switch (cmd) {
    case "new": {
      const { positionals, flags } = parseFlags(args);
      if (!positionals[0]) {
        return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
      }
      await newTent(positionals[0], flags.vault);
      break;
    }
    case "dispatch": {
      const { positionals, flags } = parseFlags(args);
      const [claimId, role, ...promptParts] = positionals;
      if (!claimId || !role) {
        return fail("Usage: tent dispatch <claimId> <role> [localPrompt...] [--prompt <text>|-] [--as-sub --by <role>]");
      }
      let localPrompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
      if (localPrompt === "-") localPrompt = await readStdin();
      const tent = await loadTent(env.fs);
      const workspacePath = resolveTentWorkspace(tent);
      const dispatcher = flags.by || flags.from || flags["dispatched-by"] || process.env.TENT_ROLE || "user";
      let workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, role) : void 0;
      if (!workspacePath) {
        console.log("Note: this tent has no workspace pointer box \u2014 the envelope carries no workspace contract (Tent-only task).");
      }
      if (flags["as-sub"]) {
        if (!workspacePath) return fail("--as-sub requires a workspace output pointer");
        if (!dispatcher || dispatcher === "user") return fail("--as-sub requires --by <dispatching-role> or TENT_ROLE");
        const dispatcherWorkspace = await ensureRoleWorkspace(workspacePath, dispatcher);
        workspace = { ...workspace ?? await ensureRoleWorkspace(workspacePath, role), targetBranch: dispatcherWorkspace.branch };
      }
      const r = await dispatch(env, claimId, role, {
        userPrompt: localPrompt,
        workspace,
        dispatchedBy: dispatcher
      });
      console.log(`\u2713 Dispatched. Task: ${r.taskPath}

--- Relay prompt ---
${r.relayPrompt}`);
      break;
    }
    case "task-ack": {
      const taskPath = args[0];
      if (!taskPath) return fail("Usage: tent task-ack <taskPath>");
      await withTentMutation(env.fs, () => ackTaskEnvelope(env.fs, taskPath));
      console.log(`\u2713 Task acknowledged: ${taskPath}`);
      break;
    }
    case "role-init": {
      const roleName = args[0];
      if (!roleName) return fail("Usage: tent role-init <role>");
      const roles = await loadRolesRegistry(env.fs);
      const role = roles.roles.find((item) => item.name === roleName) ?? { name: roleName };
      const initPath = await withTentMutation(
        env.fs,
        () => ensureRoleInit(env.fs, role, env.tentName)
      );
      console.log(`Read ${initPath} to complete role initialization.`);
      break;
    }
    case "roles": {
      const registry = await loadRolesRegistry(env.fs);
      console.log(JSON.stringify(registry, null, 2));
      break;
    }
    case "report": {
      const { positionals, flags } = parseFlags(args);
      const [boxId, bodySource] = positionals;
      if (!boxId || !bodySource) {
        return fail("Usage: tent report <boxId> <bodyFile|-> [--commits <sha,sha>]");
      }
      const body = bodySource === "-" ? await readStdin() : await (await import("node:fs/promises")).readFile(path.resolve(bodySource), "utf8");
      const commits = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      const report = await submitReport(env.fs, env.clock, boxId, body, commits);
      console.log(`\u2713 Report ready for review: ${report.path}`);
      break;
    }
    case "complete": {
      const { positionals, flags } = parseFlags(args);
      const boxId = positionals[0];
      if (!boxId) return fail("Usage: tent complete <boxId> [--commits <sha,sha>] [--require-check <command>] [--by <role>]");
      const tent = await loadTent(env.fs);
      const box = tent.byId.get(boxId);
      if (!box) return fail(`Box not found: ${boxId}`);
      const owner = ownerFor(box);
      const reports = (await loadReports(env.fs)).filter((report) => report.boxId === boxId);
      const readyReport = reports.find((report) => report.status === "ready");
      const rejectedReport = reports.find((report) => report.status === "rejected");
      if (!readyReport && rejectedReport) {
        return fail(`Report for ${boxId} was rejected; submit a revised report before completing`);
      }
      const hasExplicitCommits = Object.prototype.hasOwnProperty.call(flags, "commits");
      const explicitRefs = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (hasExplicitCommits && explicitRefs.length === 0) {
        return fail("--commits requires at least one commit ref");
      }
      const refs = hasExplicitCommits ? explicitRefs : readyReport?.commits ?? [];
      if (refs.length > 0 && !owner) return fail("Completing with workspace commits requires an owner");
      let integrationLines = [];
      const workspacePath = resolveTentWorkspace(tent);
      if (flags["require-check"]) {
        if (!workspacePath) return fail("--require-check requires a workspace output pointer");
        await runWorkspaceCheck(workspacePath, flags["require-check"]);
      }
      const acceptedBy = flags.by || process.env.TENT_ROLE || "user";
      const integrate = async (commitRefs) => {
        if (!workspacePath) throw new Error("The Tent has no workspace output pointer");
        const contract = await ensureRoleWorkspace(workspacePath, owner);
        const integrated = await integrateWorkspaceCommits(contract, commitRefs);
        integrationLines = integrated.map(
          (item) => `${item.sourceRef} \u2192 ${item.integratedRef}${item.alreadyIntegrated ? " (already)" : ""}`
        );
      };
      if (readyReport) {
        await acceptReport(env, readyReport.path, {
          commits: refs,
          integrate: refs.length > 0 ? integrate : void 0,
          acceptedBy
        });
      } else {
        await completeClaim(env, boxId, refs.length > 0 ? () => integrate(refs) : void 0, acceptedBy);
      }
      for (const line of integrationLines) console.log(line);
      console.log(`\u2713 Completed ${boxId}`);
      break;
    }
    case "stamp": {
      const { positionals, flags } = parseFlags(args);
      if (!positionals[0]) return fail("Usage: tent stamp <boxId> [--by <role>]");
      const acceptedBy = flags.by || process.env.TENT_ROLE || "user";
      await stamp(env, positionals[0], acceptedBy);
      console.log(`\u2713 Stamped ${positionals[0]} (done and owner cleared)`);
      break;
    }
    case "propose": {
      const [targetId, role, bodySource] = args;
      if (!targetId || !role || !bodySource) return fail("Usage: tent propose <targetId> <role> <bodyFile|->");
      const body = bodySource === "-" ? await readStdin() : await (await import("node:fs/promises")).readFile(path.resolve(bodySource), "utf8");
      const r = await propose(env, targetId, role, body);
      console.log(`\u2713 Proposal written: ${r.proposalPath}`);
      break;
    }
    case "proposal": {
      const [p, verb, ...noteParts] = args;
      if (!p || verb !== "accept" && verb !== "reject") return fail("Usage: tent proposal <path> accept|reject [note]");
      await applyProposal(env, p, verb === "accept", noteParts.join(" ") || void 0);
      console.log(`\u2713 proposal ${verb}: ${p}`);
      break;
    }
    case "grant-readable": {
      if (!args[0]) return fail("Usage: tent grant-readable <boxId>");
      await grantReadable(env, args[0]);
      console.log(`\u2713 ${args[0]} readable=true`);
      break;
    }
    case "new-box": {
      const [name, type, parentId] = args;
      if (!name || !type) return fail("Usage: tent new-box <name> <type> [parentId]");
      let parentPath = "";
      if (parentId) {
        const tent = await loadTent(env.fs);
        const parent = tent.byId.get(parentId);
        if (!parent) return fail(`Parent box not found: ${parentId}`);
        parentPath = parent.path;
      }
      const id = await createBox(env, { parentPath, name, type });
      console.log(`\u2713 Created box ${name} (${id})`);
      break;
    }
    case "tag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("Usage: tent tag <boxId> <name>");
      await tagBox(env, boxId, name);
      console.log(`\u2713 Added tag to ${boxId}: ${name}`);
      break;
    }
    case "untag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("Usage: tent untag <boxId> <name>");
      await untagBox(env, boxId, name);
      console.log(`\u2713 Removed tag from ${boxId}: ${name}`);
      break;
    }
    case "tag-new": {
      if (!args[0]) return fail("Usage: tent tag-new <name>");
      await createTag(env, args[0]);
      console.log(`\u2713 Registered tag: ${args[0]}`);
      break;
    }
    case "tag-rm": {
      const [name, confirmation] = args;
      if (!name) return fail("Usage: tent tag-rm <name> --yes OR tent tag-rm <name> <name>");
      if (!args.includes("--yes") && confirmation !== name) {
        return fail(`Deleting a tag removes it from every box. Add --yes or repeat the tag name to confirm: tent tag-rm ${name} ${name}`);
      }
      await deleteTag(env, name);
      console.log(`\u2713 Deleted tag from registry and all boxes: ${name}`);
      break;
    }
    case "tags": {
      const registry = await loadTagRegistry(env.fs);
      if (registry.tags.length === 0) console.log("(no tags)");
      else for (const tag of registry.tags) console.log(tag);
      break;
    }
    case "find": {
      if (!args[0]) return fail("Usage: tent find <name>");
      const tent = await loadTent(env.fs);
      const boxes = findBoxesByTag(tent, args[0]);
      if (boxes.length === 0) {
        console.log("(no matches)");
        break;
      }
      for (const box of boxes) {
        const pointer = splitType(box.type).base === "output" ? outputPointer(box.fm, box.body) : "";
        console.log(`${box.id}	${box.path}	${box.type}${pointer ? `	${pointer}` : ""}`);
      }
      break;
    }
    case "apply": {
      if (!args[0]) return fail("Usage: tent apply <proposal-path>");
      const g = await startApply(env, args[0]);
      console.log(
        `\u2713 Proposal is ready to apply. Target: ${g.targetPath}

--- Requested change ---
${g.instructions || "(The proposal body is empty; see the source file.)"}

After updating the target box note, run: tent apply-done ${args[0]}`
      );
      break;
    }
    case "apply-done": {
      if (!args[0]) return fail("Usage: tent apply-done <proposal-path>");
      await finishApply(env, args[0]);
      console.log("\u2713 Proposal marked as applied.");
      break;
    }
    case "fork": {
      if (!args[0]) return fail("Usage: tent fork <boxId>");
      const id = await forkNode(env, args[0]);
      console.log(`\u2713 Forked ${args[0]} \u2192 ${id}`);
      break;
    }
    case "clean-temp": {
      if (args[0] && isUnsafeRoleSegment(args[0])) return fail(`Invalid role for clean-temp: ${args[0]}`);
      await cleanTemp(env, args[0]);
      console.log(`\u2713 Cleared temp/${args[0] || "(all)"}`);
      break;
    }
    case "force-release": {
      if (!args[0]) return fail("Usage: tent force-release <boxId>");
      await forceRelease(env, args[0]);
      console.log(`\u2713 Force-released owner: ${args[0]}`);
      break;
    }
    case "migrate-kind-to-type": {
      const touched = await migrateKindToType(env.fs);
      if (touched.length === 0) console.log("\u2713 No migration needed: no legacy kind fields found");
      else console.log(`\u2713 Migrated legacy kind \u2192 type:
${touched.map((p) => `- ${p}`).join("\n")}`);
      break;
    }
    case "okf-sync": {
      const result = await syncOkfBundle(env.fs);
      console.log(
        `\u2713 OKF synchronized
generated: ${result.generatedFiles.length}
projected: ${result.projectedFiles.length}
unresolved wiki links: ${result.unresolved.length}`
      );
      if (result.unresolved.length > 0) {
        for (const item of result.unresolved) console.log(`! ${item.file}: [[${item.target}]]`);
      }
      break;
    }
    case "skill-install": {
      const { flags } = parseFlags(args);
      const target = flags.target || "claude";
      const force = flags.force === "true";
      const dir = flags.dir || defaultSkillInstallDir(target);
      const installed = await installSkills(dir, { force, target });
      console.log(
        `\u2713 Installed ${target} skills in ${dir}
` + installed.map((name) => `- ${name}`).join("\n")
      );
      break;
    }
    case "tree": {
      const tent = await loadTent(env.fs);
      for (const r of tent.roots) printBox(r, 0);
      break;
    }
    default:
      fail(
        `Unknown command: ${cmd || "(empty)"}
Commands: new role-init roles dispatch task-ack report complete stamp propose proposal grant-readable new-box tag untag tag-new tag-rm tags find apply apply-done fork clean-temp force-release migrate-kind-to-type okf-sync skill-install tree`
      );
  }
}
function readStdin() {
  return new Promise((resolve4, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve4(data));
    process.stdin.on("error", reject);
  });
}
function printBox(box, depth) {
  const ind = "  ".repeat(depth);
  const rw = `R${box.readable.value ? "\u2713" : "\u2717"}/W${box.writable.value ? "\u2713" : "\u2717"}`;
  const owner = box.fm.owner ? ` \u2691${box.fm.owner}` : "";
  const type = box.type;
  const id = box.id || "missing-id";
  const invalid = box.invalid ? ` invalid:${box.invalidReason || "invalid"}` : "";
  console.log(`${ind}${box.name} [${type} ${id}] ${rw}${owner}${invalid}`);
  for (const c of box.children) printBox(c, depth + 1);
}
function outputPointer(fm, body) {
  const { workspace, ref } = parseOutputPointer(fm, body);
  return [workspace ? `workspace=${workspace}` : "", ref ? `ref=${ref}` : ""].filter(Boolean).join(" ");
}
function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}
function isUnsafeRoleSegment(value) {
  return value.includes("..") || value.includes("/") || value.includes("\\");
}
function parseFlags(args) {
  const positionals = [];
  const flags = {};
  const booleanFlags = /* @__PURE__ */ new Set(["force", "yes", "as-sub"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (booleanFlags.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
function defaultSkillInstallDir(target) {
  if (target !== "claude") {
    throw new Error("skill-install currently supports only --target claude; Codex uses a different skill format.");
  }
  return path.join(os.homedir(), ".claude", "skills");
}
async function installSkills(targetDir, options) {
  if (options.target !== "claude") defaultSkillInstallDir(options.target);
  const sourceDir = path.join(packageRoot(), "skills");
  const entries = await fs2.readdir(sourceDir, { withFileTypes: true });
  const skillNames = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await existsPath(path.join(sourceDir, entry.name, "SKILL.md"))) skillNames.push(entry.name);
  }
  if (skillNames.length === 0) throw new Error(`No installable skills found in ${sourceDir}`);
  const conflicts = [];
  for (const name of skillNames) {
    if (await existsPath(path.join(targetDir, name))) conflicts.push(name);
  }
  if (conflicts.length > 0 && !options.force) {
    throw new Error(`Skills already exist: ${conflicts.join(", ")}. Add --force to overwrite them.`);
  }
  await fs2.mkdir(targetDir, { recursive: true });
  const installed = [];
  for (const name of skillNames) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    assertChildPath(targetDir, target);
    if (options.force) await fs2.rm(target, { recursive: true, force: true });
    await fs2.cp(source, target, { recursive: true, errorOnExist: true });
    installed.push(name);
  }
  return installed.sort();
}
function packageRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(here) === "cli" && path.basename(path.dirname(here)) === "src") {
    return path.resolve(here, "../..");
  }
  return here;
}
function assertChildPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
}
async function existsPath(target) {
  try {
    await fs2.access(target);
    return true;
  } catch {
    return false;
  }
}
async function packageVersion() {
  const pkg = JSON.parse(await fs2.readFile(path.join(packageRoot(), "package.json"), "utf8"));
  return String(pkg.version ?? "0.0.0");
}
function helpText() {
  return `Tent CLI

Usage:
  tent <command> [args]

Run commands from a Tent root unless noted.

Commands:
  new <path>                         Create an empty Tent.
  new <name> --vault <vault>         Create a Tent under the vault's configured tents root.
  role-init <role>                   Prepare stable role init context.
  roles                              Print the role registry.
  dispatch <boxId> <role> <prompt>   Claim a box and create a task pointer.
  task-ack <taskPath>                Mark a task envelope as taken.
  report <boxId> <file|->            Submit a delivery report for triage.
  complete <boxId> [options]         Confirm completion and release owner.
  stamp <boxId> [--by <role>]        Mark done without workspace commits.
  force-release <boxId>              Release owner without accepting delivery.
  new-box <name> <type> [parentId]   Create a box.
  tag|untag <boxId> <tag>            Add or remove a tag.
  tags | tag-new | tag-rm            Manage the tag registry.
  find <tag>                         Find boxes by tag.
  propose | proposal                 Create or review a proposal.
  fork <boxId>                       Copy a box subtree with new ids.
  okf-sync                           Regenerate OKF indexes and projected links.
  skill-install [--force]            Install bundled Tent skills for Claude Code.
  tree                               Print the box tree.

Options:
  -h, --help                         Show this help.
  -v, --version                      Show the package version.
`;
}
async function readVaultPluginSettings(vault) {
  const fsmod = await import("node:fs/promises");
  const dataPath = path.join(path.resolve(vault), ".obsidian", "plugins", "tent", "data.json");
  try {
    const data = JSON.parse(await fsmod.readFile(dataPath, "utf8"));
    const root = typeof data?.tentsRoot === "string" ? data.tentsRoot.trim() : "";
    const defaults = data?.newTentDefaults ?? data?.newTentTemplate;
    return {
      tentsRoot: root || "tents",
      ...defaults?.typeRegistry ? { typeRegistry: normalizeRegistry(defaults.typeRegistry) } : {},
      ...defaults?.rolesRegistry ? { rolesRegistry: normalizeTemplateRoles(defaults.rolesRegistry) } : {},
      ...typeof defaults?.rulesTemplate === "string" && defaults.rulesTemplate.trim() ? { rulesTemplate: defaults.rulesTemplate } : {}
    };
  } catch {
    return { tentsRoot: "tents" };
  }
}
async function newTent(target, vault) {
  const fsmod = await import("node:fs/promises");
  let pluginSettings;
  if (vault) {
    if (target.includes("/") || target.includes("\\")) {
      return fail(`In --vault mode, <name> cannot contain path separators: ${target}`);
    }
    pluginSettings = await readVaultPluginSettings(vault);
    target = path.join(path.resolve(vault), pluginSettings.tentsRoot, target);
  }
  const fsa = new NodeFs(target);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${target}`);
  await fsmod.mkdir(target, { recursive: true });
  const name = path.basename(path.resolve(target));
  const fallbackRules = `# ${name} \xB7 \u9879\u76EE\u7EA6\u5B9A

> \u8FD9\u9876\u5E10\u7684\u672C\u5730\u89C4\u77E9(global rule):genesis \u5EFA\u3001\u968F\u4FBF\u6539\u3002
> \u673A\u5236\u89C4\u8303\u4E0D\u5728\u8FD9(\u89C1 Tent \u4ED3\u5E93 docs/SPEC.md);agent \u7684\u64CD\u4F5C\u534F\u8BAE\u5728 tent-role skill\u3002

- \u4EA7\u51FA workspace:<\u586B\u771F\u5B9E\u4EE3\u7801\u4ED3\u8DEF\u5F84>
- \u63D0\u4EA4 / \u547D\u540D\u7EA6\u5B9A:<\u586B>
- \u5176\u5B83\u672C\u9879\u76EE\u89C4\u77E9:<\u586B>
`;
  const rules = pluginSettings?.rulesTemplate ? pluginSettings.rulesTemplate.replaceAll("{tent}", name) : fallbackRules;
  await scaffoldTent(fsa, {
    name,
    rules,
    typeRegistry: pluginSettings?.typeRegistry,
    rolesRegistry: pluginSettings?.rolesRegistry
  });
  console.log(
    `\u2713 Created Tent: ${target}
The root starts empty; add boxes in the panel or create a folder with a same-named Markdown note.`
  );
}
function normalizeTemplateRoles(value) {
  if (typeof value !== "object" || value === null) return { roles: [] };
  const raw = value;
  if (!Array.isArray(raw.roles)) return { roles: [] };
  const roles = [];
  for (const item of raw.roles) {
    if (typeof item !== "object" || item === null) continue;
    const role = normalizeRoleDefinition(item);
    if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
    roles.push(role);
  }
  return { roles };
}
function ownerFor(box) {
  if (box.fm.owner) return box.fm.owner;
  let parent = box.parent;
  while (parent) {
    if (parent.fm.owner) return parent.fm.owner;
    parent = parent.parent;
  }
  return void 0;
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
