#!/usr/bin/env node

// src/cli/tent.ts
import * as path2 from "node:path";
import * as fs3 from "node:fs/promises";
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
  async readFile(path3) {
    return fs.readFile(this.abs(path3), "utf8");
  }
  async writeFile(path3, content) {
    await fs.mkdir(nodePath.dirname(this.abs(path3)), { recursive: true });
    await fs.writeFile(this.abs(path3), content, "utf8");
  }
  async exists(path3) {
    try {
      await fs.access(this.abs(path3));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path3) {
    await fs.mkdir(this.abs(path3), { recursive: true });
  }
  async move(from, to) {
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }
  async remove(path3) {
    await fs.rm(this.abs(path3), { recursive: true, force: true });
  }
  async withLock(path3, action) {
    const lockPath = this.abs(path3);
    await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent is already running another write operation; try again later.");
        await fs.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("Cannot acquire the Tent mutation lock.");
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
async function isStaleLock(path3) {
  try {
    const stat2 = await fs.stat(path3);
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
  if (v.startsWith('"') && !v.endsWith('"')) {
    throw new Error("Invalid frontmatter YAML: unterminated double-quoted string.");
  }
  if (v.startsWith('"') && v.endsWith('"')) {
    return parseDoubleQuoted(v);
  }
  if (v.startsWith("'") && !v.endsWith("'")) {
    throw new Error("Invalid frontmatter YAML: unterminated single-quoted string.");
  }
  if (v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith("[") && !v.endsWith("]")) {
    throw new Error("Invalid frontmatter YAML: unterminated flow array.");
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

// src/core/registryRecovery.ts
async function backupCorruptRegistry(fs4, path3) {
  const backupPath = `${path3}.corrupt-${timestamp()}`;
  await fs4.writeFile(backupPath, await fs4.readFile(path3));
  return backupPath;
}
function warnRegistryRecovered(path3, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path3} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
  );
}
function timestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}

// src/core/order.ts
var ROOT_KEY = "__root__";
var ORDER_PATH = ".tent/order.json";
async function loadOrder(fs4) {
  if (!await fs4.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs4.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs4, ORDER_PATH);
    await saveOrder(fs4, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs4, map) {
  if (!await fs4.exists(".tent")) await fs4.mkdir(".tent");
  await fs4.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
async function loadTypeRegistry(fs4) {
  if (!await fs4.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs4.readFile(TYPE_REGISTRY_PATH));
    return normalizeRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`types.json is corrupt: ${detail}.`);
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
async function loadTent(fs4) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs4);
  const top = await fs4.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (entry.name === "temp") continue;
    await loadBoxInto(fs4, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs4);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], (a, b) => zoneRank(a.name) - zoneRank(b.name) || a.name.localeCompare(b.name));
  for (const root of sortedRoots) sortChildren(root, order);
  for (const root of sortedRoots) resolveSubtree(root, typeRegistry);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
  resolveLocks(sortedRoots);
  for (const root of sortedRoots) indexSubtree(root, byId, byPath, duplicateIds);
  return { roots: sortedRoots, byId, byPath, duplicateIds, typeRegistry };
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
  const direct = duplicateIds.has(box.id) ? { rootId: box.id, reason: `Duplicate id: ${box.id}; native copies must be converted to forks.` } : void 0;
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
async function loadBox(fs4, path3, parent, registry) {
  const boxFile = boxNotePath(path3);
  if (!await fs4.exists(boxFile)) {
    return null;
  }
  const raw = await fs4.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path3);
  const zone = parent ? parent.zone : zoneOf(name);
  const { fm, tags } = normalizeIdentity(data);
  const box = {
    id: fm.id,
    type: fm.type,
    kind: fm.kind,
    tags,
    archived: false,
    invalid: !!parseError,
    path: path3,
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
  if (parseError) {
    box.invalidRootId = path3;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs4.listDir(path3);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    await loadBoxInto(fs4, join(path3, entry.name), box, registry, box.children);
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
async function loadBoxInto(fs4, path3, parent, registry, target) {
  const box = await loadBox(fs4, path3, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs4.listDir(path3);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    await loadBoxInto(fs4, join(path3, entry.name), parent, registry, target);
  }
}
function zoneOf(name) {
  return ZONE_NAMES.includes(name) ? name : null;
}
function resolveSubtree(box, registry, inheritedInvalid, inheritedArchived = false) {
  const directInvalid = box.invalid ? { rootId: box.invalidRootId || box.path, reason: box.invalidReason || "Invalid frontmatter." } : invalidTypeReference(box, registry);
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
    return { rootId: box.path, reason: "Missing id: likely a manually created orphan box; use tent new-box or repair." };
  }
  if (!typeExists(box.type, registry)) {
    return { rootId: box.id, reason: `Unknown type: ${box.type}.` };
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
function baseName(path3) {
  const i = path3.lastIndexOf("/");
  return i === -1 ? path3 : path3.slice(i + 1);
}
function dirName(path3) {
  const i = path3.lastIndexOf("/");
  return i === -1 ? "" : path3.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs4, action) {
  return fs4.withLock ? fs4.withLock(".tent/mutation.lock", action) : action();
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
  readable.push({ path: ".tent/roles.json", note: "System registry: available roles and persistent prompts." });
  readable.push({ path: "temp/", note: "System pipeline: read all role temp state." });
  for (const box of claimScope) {
    if (isUsableBox(box) && box.writable.value) {
      writable.push({ id: box.id, path: box.path });
    }
  }
  if (input.claimRoot) {
    writable.push({ path: "./", note: "Structural permission: may create/move top-level boxes at the Tent root." });
  }
  for (const box of claimScope) {
    writable.push({ id: box.id, path: `${box.path}/`, note: "Structural permission: may create/move/delete child boxes under this box." });
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
  }).map((box) => `${box.path} body`);
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
  if (!input.claimBoxes || input.claimBoxes.length === 0) throw new Error("Missing claim boxes.");
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
  if (box.invalid) return { ok: false, blocker: box, reason: `Invalid subtree: ${box.invalidReason || "missing type definition"}` };
  if (box.archived) return { ok: false, blocker: box, reason: "Archived subtree cannot be claimed." };
  if (box.fm.owner) {
    return { ok: false, blocker: box, reason: `Already claimed by ${box.fm.owner}.` };
  }
  let anc = box.parent;
  while (anc) {
    if (anc.fm.owner) {
      return { ok: false, blocker: anc, reason: `Ancestor ${anc.name} is already claimed by ${anc.fm.owner}.` };
    }
    anc = anc.parent;
  }
  const occupiedChild = findOccupied(box.children);
  if (occupiedChild) {
    return {
      ok: false,
      blocker: occupiedChild,
      reason: `Descendant ${occupiedChild.name} is already claimed by ${occupiedChild.fm.owner}.`
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
var DEFAULT_TAG_REGISTRY = { tags: [] };
async function loadTagRegistry(fs4) {
  if (!await fs4.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs4.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    const backupPath = await backupCorruptRegistry(fs4, TAGS_REGISTRY_PATH);
    const recovered = await recoverTagRegistryFromBoxes(fs4);
    await saveTagRegistryUnlocked(fs4, recovered);
    warnRegistryRecovered(TAGS_REGISTRY_PATH, backupPath, "recovered");
    return recovered;
  }
}
async function saveTagRegistryUnlocked(fs4, registry) {
  if (!await fs4.exists(".tent")) await fs4.mkdir(".tent");
  await fs4.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
async function addRegistryTag(fs4, name) {
  await withTentMutation(fs4, async () => addRegistryTagUnlocked(fs4, name));
}
async function addRegistryTagUnlocked(fs4, name) {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs4);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs4, registry);
  }
}
async function addTag(fs4, boxId, name) {
  await withTentMutation(fs4, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs4);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    await addRegistryTagUnlocked(fs4, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs4, box, tags);
  });
}
async function removeTag(fs4, boxId, name) {
  await withTentMutation(fs4, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs4);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    await writeBoxTags(fs4, box, box.tags.filter((item) => item !== tag));
  });
}
async function removeRegistryTag(fs4, name) {
  await withTentMutation(fs4, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs4);
    await saveTagRegistryUnlocked(fs4, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs4);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs4, box, box.tags.filter((item) => item !== tag));
      }
    }
  });
}
function findBoxesByTag(tent, name) {
  const tag = normalizeTagName(name);
  return [...tent.byId.values()].filter((box) => box.tags.includes(tag)).sort((a, b) => a.path.localeCompare(b.path));
}
function normalizeTagName(name) {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}
async function writeBoxTags(fs4, box, tags) {
  const path3 = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs4.readFile(path3));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs4.writeFile(path3, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
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
async function recoverTagRegistryFromBoxes(fs4) {
  const tent = await loadTent(fs4);
  const tags = [];
  for (const box of tent.byPath.values()) {
    tags.push(...box.tags);
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
async function loadRolesRegistry(fs4) {
  if (!await fs4.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs4.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs4, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs4, ROLES_REGISTRY_PATH, reset);
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return reset;
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
  if (!isRecord3(value)) throw new Error("role.cli must be an object.");
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) throw new Error("role.cli.command must be a non-empty string.");
  const cli = { command };
  if (value.resume !== void 0) {
    const resume = typeof value.resume === "string" ? value.resume.trim() : "";
    if (!resume) throw new Error("role.cli.resume must be a non-empty string.");
    cli.resume = resume;
  }
  return cli;
}
function cloneDefaultRoles() {
  return {
    roles: DEFAULT_ROLES_REGISTRY.roles.map((role) => ({ ...role }))
  };
}
async function writeJson(fs4, path3, value) {
  if (!await fs4.exists(".tent")) await fs4.mkdir(".tent");
  await fs4.writeFile(path3, JSON.stringify(value, null, 2) + "\n");
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/task.ts
async function loadTaskEnvelopes(fs4) {
  const tasks = [];
  if (!await fs4.exists("temp")) return tasks;
  for (const roleEntry of await fs4.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    const taskDir = join("temp", roleEntry.name, "tasks");
    if (!await fs4.exists(taskDir)) continue;
    for (const entry of await fs4.listDir(taskDir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path3 = join(taskDir, entry.name);
      try {
        const { data } = parseFrontmatter(await fs4.readFile(path3));
        if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
          continue;
        }
        const task = {
          path: path3,
          role: data.role,
          claims: data.claims,
          manifest: data.manifest,
          status: data.status === "taken" ? "taken" : "pending"
        };
        if (typeof data.dispatchedBy === "string") task.dispatchedBy = data.dispatchedBy;
        if (typeof data.workspace === "string") task.workspace = data.workspace;
        if (typeof data.worktree === "string") task.worktree = data.worktree;
        if (typeof data.branch === "string") task.branch = data.branch;
        if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
        tasks.push(task);
      } catch {
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
function relayPromptForTask(task, tentRoot) {
  const initPath = join("temp", task.role, "init.md");
  return `A Tent task has been dispatched to role ${task.role}.
Tent root: ${tentRoot}
1. Run \`tent task-ack ${task.path}\` to take this task.
2. Read the envelope, then open the claimed boxes; the box notes contain the task definition.
3. If this is a new session for this role, complete role init first: ${initPath}.`;
}
async function ensureRoleInit(fs4, role, tentName) {
  const path3 = join("temp", role.name, "init.md");
  const body = `# Role Init

- Tent: ${tentName}
- Rules: RULES.md
- Role registry: .tent/roles.json (or run \`tent roles\`)

## Role Prompt

${role.prompt?.trim() || "(no persistent role prompt)"}

## Operating Model

Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.
`;
  await fs4.writeFile(path3, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path3;
}
async function writeTaskEnvelope(fs4, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs4, dir);
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path3 = await uniqueMarkdownPath(fs4, dir, stem);
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
  await fs4.writeFile(path3, serializeFrontmatter(data, body));
  return path3;
}
async function ackTaskEnvelope(fs4, path3) {
  if (!await fs4.exists(path3)) throw new Error(`Task envelope not found: ${path3}.`);
  const raw = await fs4.readFile(path3);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path3}.`);
  data.status = "taken";
  await fs4.writeFile(path3, serializeFrontmatter(data, body, keyOrder));
}
function taskStem(now, claimId) {
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp2}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs4, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path3 = join(dir, `${stem}${suffix}.md`);
    if (!await fs4.exists(path3)) return path3;
  }
}
async function ensureDir(fs4, path3) {
  if (!await fs4.exists(path3)) await fs4.mkdir(path3);
}

// src/core/report.ts
async function submitReport(fs4, clock, boxId, body, commits) {
  return withTentMutation(fs4, async () => submitReportUnlocked(fs4, clock, boxId, body, commits));
}
async function submitReportUnlocked(fs4, clock, boxId, body, commits) {
  const text = body.trim();
  if (!text) throw new Error("Report body cannot be empty.");
  const tent = await loadTent(fs4);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const role = box.fm.owner;
  if (!role) throw new Error("Only claimed boxes with a direct owner can submit reports.");
  const path3 = reportPath(role, box.id);
  if (await fs4.exists(path3)) {
    const current = await loadReport(fs4, path3);
    if (current.status === "ready") throw new Error("A report is already pending triage; the user must confirm or reject it first.");
  }
  const report = {
    path: path3,
    boxId: box.id,
    role,
    status: "ready",
    commits: uniqueCommits(commits),
    timestamp: clock.now(),
    body: text
  };
  await ensureDir2(fs4, join("temp", role, "reports"));
  await writeReport(fs4, report);
  return report;
}
async function loadReports(fs4) {
  const reports = [];
  if (!await fs4.exists("temp")) return reports;
  for (const roleDir of await fs4.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!await fs4.exists(dir)) continue;
    for (const entry of await fs4.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path3 = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs4, path3));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs4, inputPath) {
  const path3 = normalizeReportPath(inputPath);
  if (!await fs4.exists(path3)) throw new Error(`Report not found: ${path3}.`);
  const { data, body } = parseFrontmatter(await fs4.readFile(path3));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`Invalid report format: ${path3}.`);
  }
  return {
    path: path3,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function removeReportsForBox(fs4, boxId) {
  for (const report of await loadReports(fs4)) {
    if (report.boxId === boxId && await fs4.exists(report.path)) await fs4.remove(report.path);
  }
}
function reportPath(role, boxId) {
  return join("temp", role, "reports", `${boxId}.md`);
}
function normalizeReportPath(input) {
  const path3 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/bx-[^/]+\.md$/.test(path3)) {
    throw new Error("Report must point to temp/<role>/reports/<boxId>.md.");
  }
  return path3;
}
async function writeReport(fs4, report) {
  const data = {
    type: "report",
    box: report.boxId,
    role: report.role,
    status: report.status,
    commits: report.commits,
    ts: report.timestamp,
    review: report.review
  };
  await fs4.writeFile(
    report.path,
    serializeFrontmatter(data, report.body + "\n", ["type", "box", "role", "status", "commits", "ts", "review"])
  );
}
async function ensureDir2(fs4, path3) {
  if (!await fs4.exists(path3)) await fs4.mkdir(path3);
}
function uniqueCommits(commits) {
  return [...new Set(commits.map((item) => item.trim()).filter(Boolean))];
}

// src/core/scaffold.ts
async function scaffoldTent(fs4, options) {
  const name = options.name.trim();
  if (!name) throw new Error("Tent name cannot be empty.");
  if (!options.rules.trim()) throw new Error("RULES.md content cannot be empty.");
  const usedIds = /* @__PURE__ */ new Set();
  for (const box of options.boxes ?? []) {
    const boxName = validateBoxName(box.name);
    const type = box.kind?.trim() || box.type.trim();
    if (!type) throw new Error(`Box ${boxName} is missing a primary type.`);
    const id = box.id?.trim() || makeUniqueBoxId(usedIds);
    usedIds.add(id);
    const frontmatter = { id, type };
    await writeBox(fs4, boxName, frontmatter, box.body ?? `# ${boxName}
`);
  }
  await fs4.mkdir("temp");
  await fs4.mkdir(".tent");
  await fs4.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(options.typeRegistry ?? DEFAULT_TYPE_REGISTRY, null, 2) + "\n");
  await fs4.writeFile(ROLES_REGISTRY_PATH, JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n");
  await fs4.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n");
  await fs4.writeFile("RULES.md", options.rules);
}
function validateBoxName(value) {
  const name = value.trim();
  if (!name) throw new Error("Box name cannot be empty.");
  if (name.length > 200) throw new Error("Box name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Box name cannot contain path separators.");
  if (/[\r\n]/.test(name)) throw new Error("Box name cannot contain newlines.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) throw new Error("Box name cannot contain control characters.");
  return name;
}
async function writeBox(fs4, path3, frontmatter, body) {
  await fs4.mkdir(path3);
  await fs4.writeFile(boxNotePath(path3), serializeFrontmatter(frontmatter, `
${body}
`, BOX_FRONTMATTER_KEY_ORDER));
}

// src/core/forkOps.ts
async function forkNode(env, boxId) {
  return withTentMutation(env.fs, async () => forkNodeUnlocked(env, boxId));
}
async function forkNodeUnlocked(env, boxId) {
  const tent = await loadTent(env.fs);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const source = tent.byId.get(boxId);
  if (!source) throw new Error(`Box not found: ${boxId}.`);
  if (!isUsableBox(source)) throw new Error("Invalid or archived boxes cannot be forked.");
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
async function uniqueSiblingPath(fs4, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!await fs4.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs4, from, to) {
  await fs4.mkdir(to);
  for (const entry of await fs4.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs4, src, dst);
    else await fs4.writeFile(dst, await fs4.readFile(src));
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
async function ensureIdentityFileName(fs4, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs4.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs4.exists(copied)) await fs4.move(copied, expected);
}

// src/core/ops.ts
async function dispatch(env, claimId, role, promptOrOptions) {
  return withMutation(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}
async function dispatchUnlocked(env, claimId, role, promptOrOptions) {
  const tent = await loadTent(env.fs);
  const roleName = assertRoleName(role);
  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const options = typeof promptOrOptions === "string" ? { userPrompt: promptOrOptions } : promptOrOptions;
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const previousOwner = claim.root ? void 0 : claim.box.fm.owner;
  const previousStatus = claim.root ? void 0 : claim.box.fm.status;
  const previousAcceptedBy = claim.root ? void 0 : claim.box.fm.acceptedBy;
  const roleTempPath = join("temp", roleName);
  const roleTempExisted = await env.fs.exists(roleTempPath);
  if (claim.root) {
    const occupied = occupiedBoxes(tent);
    if (occupied.length > 0) {
      throw new Error(`Cannot dispatch: Tent root already has an active claim ${occupied[0].name} (${occupied[0].fm.owner}).`);
    }
  } else {
    const existingOwner = ownerCovering(claim.box);
    if (existingOwner) {
      throw new Error(`Cannot dispatch: ${existingOwner.name} is already claimed by ${existingOwner.fm.owner}.`);
    }
    const claimable = canClaim(claim.box);
    if (!claimable.ok) throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    await setOwner(env.fs, claim.box, roleName, "doing");
    claim.box.fm.owner = roleName;
    claim.box.fm.status = "doing";
  }
  try {
    const ownedClaims = claim.root ? [] : [...tent.byPath.values()].filter((box) => box.fm.owner === roleName);
    const input = claim.root ? { tentName: env.tentName, role: roleName, claimRoot: true, ...options.workspace } : { tentName: env.tentName, role: roleName, claimBoxes: ownedClaims, ...options.workspace };
    const manifest = buildManifest(tent, input);
    const yaml = manifestToYaml(manifest);
    const manifestPath = join("temp", roleName, "manifest.yml");
    await ensureDir3(env.fs, dirName(manifestPath));
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
  } catch (error) {
    if (!claim.root) {
      await restoreOwnerState(env.fs, claim.box, previousOwner, previousStatus, previousAcceptedBy);
      claim.box.fm.owner = previousOwner;
      claim.box.fm.status = previousStatus;
      claim.box.fm.acceptedBy = previousAcceptedBy;
    }
    if (!roleTempExisted && await env.fs.exists(roleTempPath)) {
      await env.fs.remove(roleTempPath);
    }
    throw error;
  }
}
function resolveDispatchClaim(tent, claimId, tentName) {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) {
    throw new Error("Cannot dispatch the whole Tent directly; dispatch a specific box (boxId cannot be ., root, or the Tent name).");
  }
  const box = requireBoxById(tent, id);
  return { root: false, id: box.id, name: box.name, box };
}
async function stamp(env, boxId, acceptedBy = "user") {
  await completeClaim(env, boxId, void 0, acceptedBy);
}
async function completeClaim(env, boxId, integrate, acceptedBy = "user") {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    if (integrate) await integrate();
    await setOwner(env.fs, box, void 0, "done", acceptedBy);
  });
}
async function acceptReport(env, reportPath2, options = {}) {
  await withMutation(env.fs, async () => {
    const report = await loadReport(env.fs, reportPath2);
    if (report.status !== "ready") throw new Error("Only ready reports can be confirmed.");
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, report.boxId);
    if (box.fm.owner !== report.role) throw new Error("Report role does not match the current owner.");
    const commits = options.commits ?? report.commits;
    if (commits.length > 0) {
      if (!options.integrate) throw new Error("Report contains commits; workspace integration is required.");
      await options.integrate(commits);
    }
    await setOwner(env.fs, box, void 0, "done", options.acceptedBy ?? "user");
    await env.fs.remove(report.path);
  });
}
async function grantReadable(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be made readable.");
    await patchFrontmatter(env.fs, box, { readable: true });
  });
}
async function cleanTemp(env, role) {
  const roleName = role === void 0 ? void 0 : assertRoleName(role);
  await withMutation(env.fs, async () => {
    const target = roleName ? join("temp", roleName) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!roleName) await ensureDir3(env.fs, "temp");
  });
}
async function forceRelease(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, boxId);
    if (!box.fm.owner) throw new Error("Only claim roots with a direct owner can be force-released.");
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
  const name = validateBoxName(input.name);
  const tent = await loadTent(env.fs);
  if (!typeExists(input.type, tent.typeRegistry)) throw new Error(`Unknown type: ${input.type}.`);
  if (input.parentPath) {
    const parent2 = tent.byPath.get(input.parentPath);
    if (!parent2 || !isUsableBox(parent2)) throw new Error("Target parent box is invalid or archived.");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueBoxId(existing, env.rand);
  const path3 = join(input.parentPath, name);
  assertNotTempPath(path3);
  await ensureDir3(env.fs, path3);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path3), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path3);
    throw error;
  }
  return id;
}
async function setOwner(fs4, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs4, box, patch);
}
async function restoreOwnerState(fs4, box, owner, status, acceptedBy) {
  await patchFrontmatter(fs4, box, {
    owner: owner ?? void 0,
    status: status ?? void 0,
    acceptedBy: acceptedBy ?? void 0
  });
}
async function patchFrontmatter(fs4, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs4.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await fs4.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
}
async function ensureDir3(fs4, path3) {
  if (path3 && !await fs4.exists(path3)) await fs4.mkdir(path3);
}
function boxKeyOrder2(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function assertNotTempPath(path3) {
  if (path3 === "temp" || path3.startsWith("temp/")) {
    throw new Error("temp/ is a system pipeline; typed boxes cannot be created or moved there.");
  }
}
function assertRoleName(role) {
  const name = role.trim();
  if (!name) throw new Error("Role name cannot be empty.");
  if (/[\/\\\r\n]/.test(name)) throw new Error("Role name cannot contain path separators or newlines.");
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
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs4, action) {
  return withTentMutation(fs4, action);
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
async function migrateKindToType(fs4) {
  return withTentMutation(fs4, async () => {
    const tent = await loadTent(fs4);
    const touched = [];
    for (const box of tent.byPath.values()) {
      const kind = typeof box.fm.kind === "string" ? box.fm.kind.trim() : "";
      if (!kind) continue;
      const path3 = boxNotePath(box.path);
      const { data, body, keyOrder } = parseFrontmatter(await fs4.readFile(path3));
      const base = typeof data.type === "string" && data.type.trim() ? data.type.trim() : "custom";
      data.type = joinType(base, kind);
      delete data.kind;
      await fs4.writeFile(path3, serializeFrontmatter(data, body, boxKeyOrder3(keyOrder)));
      touched.push(path3);
    }
    if (touched.length === 0) return touched;
    const registry = await loadTypeRegistry(fs4);
    await writeTypeRegistryUnlocked(fs4, registry);
    touched.push(TYPE_REGISTRY_PATH);
    return touched;
  });
}
async function writeTypeRegistryUnlocked(fs4, registry) {
  if (!await fs4.exists(".tent")) await fs4.mkdir(".tent");
  await fs4.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}
function boxKeyOrder3(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}

// src/core/okf.ts
async function syncOkfBundle(fs4) {
  return withTentMutation(fs4, async () => syncOkfBundleUnlocked(fs4));
}
async function syncOkfBundleUnlocked(fs4) {
  const tent = await loadTent(fs4);
  const concepts = [...tent.byPath.values()];
  const index = buildConceptIndex(concepts);
  const generatedFiles = await writeIndexes(fs4, concepts);
  const projection = await projectWikiLinks(fs4, concepts, index);
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
async function projectWikiLinks(fs4, boxes, index) {
  const projectedFiles = [];
  const unresolved = [];
  for (const box of boxes) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs4.readFile(notePath));
    const projected = projectMarkdownLinks(body, notePath, index);
    if (projected.unresolved.length > 0) {
      unresolved.push(...projected.unresolved.map((target) => ({ file: notePath, target })));
    }
    if (!projected.changed) continue;
    await fs4.writeFile(notePath, serializeFrontmatter(data, projected.body, keyOrder));
    projectedFiles.push(notePath);
  }
  return { projectedFiles, unresolved };
}
async function writeIndexes(fs4, boxes) {
  const generated = /* @__PURE__ */ new Set();
  const byDir = /* @__PURE__ */ new Map();
  for (const box of boxes) {
    const dir = dirName(boxNotePath(box.path));
    const list = byDir.get(dir) ?? [];
    list.push(box);
    byDir.set(dir, list);
  }
  const roots = boxes.filter((box) => !box.parent);
  await fs4.writeFile(
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
    await fs4.writeFile(
      indexPath,
      serializeFrontmatter(
        { type: "index" },
        "# Index\n\n" + siblings.map((box) => `- [${box.name}](${markdownLinkDestination(`${box.name}.md`)})`).join("\n") + "\n"
      )
    );
    generated.add(indexPath);
  }
  await fs4.writeFile("log.md", serializeFrontmatter({ type: "log" }, "# Log\n\n_No log entries._\n"));
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

// src/core/proposal.ts
async function submitProposal(fs4, clock, role, boxId, body) {
  return withTentMutation(fs4, async () => submitProposalUnlocked(fs4, clock, role, boxId, body));
}
async function submitProposalUnlocked(fs4, clock, roleInput, boxId, body) {
  const text = body.trim();
  if (!text) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole(roleInput);
  const tent = await loadTent(fs4);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const path3 = proposalPath(role, box.id);
  if (await fs4.exists(path3)) {
    const current = await loadProposal(fs4, path3);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }
  const proposal = {
    path: path3,
    boxId: box.id,
    role,
    status: "pending",
    createdAt: clock.now(),
    body: text
  };
  await ensureDir4(fs4, join("temp", role, "proposals"));
  await writeProposal(fs4, proposal);
  return proposal;
}
async function loadProposals(fs4) {
  const proposals = [];
  if (!await fs4.exists("temp")) return proposals;
  for (const roleDir of await fs4.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "proposals");
    if (!await fs4.exists(dir)) continue;
    for (const entry of await fs4.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path3 = join(dir, entry.name);
      try {
        proposals.push(await loadProposal(fs4, path3));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs4, inputPath) {
  const path3 = normalizeProposalPath(inputPath);
  if (!await fs4.exists(path3)) throw new Error(`Proposal not found: ${path3}.`);
  const { data, body } = parseFrontmatter(await fs4.readFile(path3));
  if (data.type !== "proposal" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path3}.`);
  }
  return {
    path: path3,
    boxId: data.box,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    body: body.trim()
  };
}
function proposalPath(role, boxId) {
  return join("temp", role, "proposals", `${boxId}.md`);
}
function normalizeProposalPath(input) {
  const path3 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/bx-[^/]+\.md$/.test(path3)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path3;
}
async function writeProposal(fs4, proposal) {
  const data = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
  await fs4.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}
async function ensureDir4(fs4, path3) {
  if (!await fs4.exists(path3)) await fs4.mkdir(path3);
}
function normalizeRole(role) {
  const normalized = role.trim();
  if (!normalized) throw new Error("Proposal role cannot be empty; set TENT_ROLE before running tent propose.");
  if (normalized.includes("..") || /[\/\\\r\n]/.test(normalized)) throw new Error(`Invalid proposal role: ${role}`);
  return normalized;
}

// src/core/status.ts
import * as fs2 from "node:fs/promises";
import * as path from "node:path";

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
    throw new Error(`A Tent can reference only one workspace; found: ${[...workspaces].join(", ")}.`);
  }
  return [...workspaces][0];
}
async function runWorkspaceCheck(workspace, command) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const script = command.trim();
  if (!script) throw new Error("--require-check requires a non-empty command.");
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
    throw new Error(`Role worktree path exists but is not registered to ${branch}: ${worktree}.`);
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
    throw new Error(`Workspace must have ${contract.targetBranch} checked out; current branch is ${current || "(detached)"}.`);
  }
  const dirty = (await git(root, ["status", "--porcelain"])).trim();
  if (dirty) throw new Error("Workspace has uncommitted changes; cannot integrate commits.");
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
  if (!isSameWorkspaceRoot(realTop, realRoot)) {
    throw new Error(`Workspace must be a Git root: ${root}.`);
  }
}
function isSameWorkspaceRoot(realTop, realRoot, platform = process.platform) {
  const top = platform === "win32" ? realTop.toLowerCase() : realTop;
  const root = platform === "win32" ? realRoot.toLowerCase() : realRoot;
  return top === root;
}
async function resolveTargetBranch(root) {
  for (const name of ["main", "master"]) {
    if (await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  const current = (await git(root, ["branch", "--show-current"])).trim();
  if (!current) throw new Error("Cannot identify the workspace main branch.");
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
      `Workspace integration failed and rollback also failed: ${errorMessage(cause)}; rollback: ${errorMessage(rollbackError)}`
    );
  }
  throw new Error(`Workspace integration conflicted and was rolled back: ${errorMessage(cause)}`);
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
async function pathExists(path3) {
  try {
    await nodeFs.access(path3);
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
  return new Promise((resolve5, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => {
      if (code === 0) resolve5(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}
function runShell(cwd, command) {
  return new Promise((resolve5, reject) => {
    const { shell, args } = workspaceCheckShell(command);
    const child = spawn(shell, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => {
      if (code === 0) {
        resolve5({ command, stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
      reject(new Error(`--require-check failed (${code}): ${command}
${detail}`));
    });
    child.on("error", (error) => {
      reject(new Error(`--require-check failed to start: ${command}
${error.message}`));
    });
  });
}
function workspaceCheckShell(command, platform = process.platform, comSpec = process.env.ComSpec) {
  const windows = platform === "win32";
  return {
    shell: windows ? comSpec || "cmd.exe" : "/bin/sh",
    args: windows ? ["/d", "/s", "/c", command] : ["-c", command]
  };
}

// src/core/status.ts
var NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/RULES.md found).";
async function renderTentStatus(cwd = process.cwd(), role = process.env.TENT_ROLE) {
  const root = path.resolve(cwd);
  if (!await isTentRoot(root)) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const fsAdapter = new NodeFs(root);
  const tent = await loadTent(fsAdapter);
  const workspace = resolveTentWorkspace(tent);
  const lines = [
    `Tent: ${root}`,
    `Workspace: ${workspace || "(none)"}`,
    ""
  ];
  const proposals = (await loadProposals(fsAdapter)).filter((proposal) => proposal.status === "pending");
  if (proposals.length === 0) {
    lines.push("Pending proposals: none");
  } else {
    lines.push("Pending proposals:");
    for (const proposal of proposals) {
      const box = tent.byId.get(proposal.boxId);
      const first = proposal.body.split("\n").map((line) => line.trim()).find(Boolean) || "(empty proposal)";
      lines.push(`- ${proposal.boxId}: ${box?.name ?? "(missing box)"} (${proposal.role}) - ${first}`);
    }
  }
  const tasks = (await loadTaskEnvelopes(fsAdapter)).filter((task) => task.status === "pending").filter((task) => hasUndoneClaim(tent, task.claims)).filter((task) => !role || task.role === role);
  lines.push("");
  if (tasks.length === 0) {
    lines.push("Pending tasks (task-ack): none");
  } else {
    lines.push("Pending tasks (task-ack):");
    for (const task of tasks) {
      lines.push(`- ${task.role}/${path.posix.basename(task.path)} -> ${task.claims.join(", ")}`);
    }
  }
  const claims = activeClaimBoxes(tent);
  lines.push("");
  if (claims.length === 0) {
    lines.push("Active claims: none");
  } else {
    lines.push("Active claims:");
    for (const box of claims) {
      lines.push(`- ${box.id}: ${box.name} (owner: ${box.fm.owner}, status: ${box.fm.status || "none"})`);
    }
  }
  return lines.join("\n") + "\n";
}
async function isTentRoot(root) {
  return await exists(path.join(root, ".tent")) && await exists(path.join(root, "RULES.md"));
}
async function exists(target) {
  try {
    await fs2.access(target);
    return true;
  } catch {
    return false;
  }
}
function activeClaimBoxes(tent) {
  return [...tent.byId.values()].filter((box) => !!box.fm.owner).sort((a, b) => a.path.localeCompare(b.path));
}
function hasUndoneClaim(tent, claims) {
  if (claims.length === 0 || claims.includes("root")) return true;
  return claims.some((claim) => tent.byId.get(claim)?.fm.status !== "done");
}

// src/cli/tent.ts
function makeEnv() {
  const root = process.cwd();
  return {
    fs: new NodeFs(root),
    clock: new SystemClock(),
    tentName: path2.basename(root),
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
      if (positionals.length > 1) return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
      await newTent(positionals[0], flags.vault);
      break;
    }
    case "dispatch": {
      const { positionals, flags } = parseFlags(args);
      const [boxId, role, ...promptParts] = positionals;
      if (!boxId || !role) {
        return fail("Usage: tent dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--as-sub --by <role>]");
      }
      if (Object.prototype.hasOwnProperty.call(flags, "prompt") && promptParts.length > 0) {
        return fail("Usage: tent dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--as-sub --by <role>]");
      }
      if (isUnsafeRoleSegment(role)) return fail(`Invalid role for dispatch: ${role}`);
      let localPrompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
      if (localPrompt === "-") localPrompt = await readStdin();
      const requestedDispatcher = flags.by || flags.from || flags["dispatched-by"] || process.env.TENT_ROLE;
      if (flags["as-sub"]) {
        if (!requestedDispatcher) return fail("--as-sub requires --by <dispatching-role> or TENT_ROLE");
        if (isUnsafeRoleSegment(requestedDispatcher)) {
          return fail(`Invalid dispatching role for --as-sub: ${requestedDispatcher}`);
        }
      }
      const tent = await loadTent(env.fs);
      const workspacePath = resolveTentWorkspace(tent);
      const dispatcher = requestedDispatcher || "user";
      let workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, role) : void 0;
      if (!workspacePath) {
        console.log("Note: this Tent has no workspace output box; the task envelope has no workspace contract.");
      }
      if (flags["as-sub"]) {
        if (!workspacePath) return fail("--as-sub requires a workspace output pointer");
        if (!dispatcher || dispatcher === "user") return fail("--as-sub requires --by <dispatching-role> or TENT_ROLE");
        const dispatcherWorkspace = await ensureRoleWorkspace(workspacePath, dispatcher);
        workspace = { ...workspace ?? await ensureRoleWorkspace(workspacePath, role), targetBranch: dispatcherWorkspace.branch };
      }
      const r = await dispatch(env, boxId, role, {
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
      if (args.length > 1) return fail("Usage: tent task-ack <taskPath>");
      await withTentMutation(env.fs, () => ackTaskEnvelope(env.fs, taskPath));
      console.log(`\u2713 Task acknowledged: ${taskPath}`);
      break;
    }
    case "role-init": {
      const roleName = args[0];
      if (!roleName) return fail("Usage: tent role-init <role>");
      if (args.length > 1) return fail("Usage: tent role-init <role>");
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
      if (args.length > 0) return fail("Usage: tent roles");
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
      if (positionals.length > 2) return fail("Usage: tent report <boxId> <bodyFile|-> [--commits <sha,sha>]");
      const body = bodySource === "-" ? await readStdin() : await readBodyFile(bodySource);
      const commits = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      const report = await submitReport(env.fs, env.clock, boxId, body, commits);
      console.log(`\u2713 Report ready for review: ${report.path}`);
      break;
    }
    case "propose": {
      const { positionals } = parseFlags(args);
      const [boxId, bodySource] = positionals;
      if (!boxId || !bodySource) {
        return fail("Usage: tent propose <boxId> <bodyFile|->");
      }
      if (positionals.length > 2) return fail("Usage: tent propose <boxId> <bodyFile|->");
      const role = process.env.TENT_ROLE;
      if (!role) return fail("tent propose requires TENT_ROLE to identify the submitting role");
      const body = bodySource === "-" ? await readStdin() : await readBodyFile(bodySource);
      const proposal = await submitProposal(env.fs, env.clock, role, boxId, body);
      console.log(`\u2713 Proposal submitted for triage: ${proposal.path}`);
      break;
    }
    case "complete": {
      const { positionals, flags } = parseFlags(args);
      const boxId = positionals[0];
      if (!boxId) return fail("Usage: tent complete <boxId> [--commits <sha,sha>] [--require-check <command>] [--by <role>]");
      if (positionals.length > 1) return fail("Usage: tent complete <boxId> [--commits <sha,sha>] [--require-check <command>] [--by <role>]");
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
      if (positionals.length > 1) return fail("Usage: tent stamp <boxId> [--by <role>]");
      const acceptedBy = flags.by || process.env.TENT_ROLE || "user";
      await stamp(env, positionals[0], acceptedBy);
      console.log(`\u2713 Stamped ${positionals[0]} (done and owner cleared)`);
      break;
    }
    case "status": {
      if (args.length > 0) return fail("Usage: tent status");
      try {
        process.stdout.write(await renderTentStatus(process.cwd(), process.env.TENT_ROLE));
      } catch (error) {
        if (error instanceof Error && error.message === NOT_INSIDE_TENT_MESSAGE) return fail(error.message);
        throw error;
      }
      break;
    }
    case "grant-readable": {
      if (!args[0]) return fail("Usage: tent grant-readable <boxId>");
      if (args.length > 1) return fail("Usage: tent grant-readable <boxId>");
      await grantReadable(env, args[0]);
      console.log(`\u2713 ${args[0]} readable=true`);
      break;
    }
    case "new-box": {
      const [name, type, parentId] = args;
      if (!name || !type) return fail("Usage: tent new-box <name> <type> [parentId]");
      if (args.length > 3) return fail("Usage: tent new-box <name> <type> [parentId]");
      try {
        validateBoxName(name);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
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
      if (args.length > 2) return fail("Usage: tent tag <boxId> <name>");
      await tagBox(env, boxId, name);
      console.log(`\u2713 Added tag to ${boxId}: ${name}`);
      break;
    }
    case "untag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("Usage: tent untag <boxId> <name>");
      if (args.length > 2) return fail("Usage: tent untag <boxId> <name>");
      await untagBox(env, boxId, name);
      console.log(`\u2713 Removed tag from ${boxId}: ${name}`);
      break;
    }
    case "tag-new": {
      if (!args[0]) return fail("Usage: tent tag-new <name>");
      if (args.length > 1) return fail("Usage: tent tag-new <name>");
      await createTag(env, args[0]);
      console.log(`\u2713 Registered tag: ${args[0]}`);
      break;
    }
    case "tag-rm": {
      const { positionals, flags } = parseFlags(args);
      const [name, confirmation] = positionals;
      if (!name) return fail("Usage: tent tag-rm <name> --yes OR tent tag-rm <name> <name>");
      if (positionals.length > 2) return fail("Usage: tent tag-rm <name> --yes OR tent tag-rm <name> <name>");
      if (!flags.yes && confirmation !== name) {
        return fail(`Deleting a tag removes it from every box. Add --yes or repeat the tag name to confirm: tent tag-rm ${name} ${name}`);
      }
      await deleteTag(env, name);
      console.log(`\u2713 Deleted tag from registry and all boxes: ${name}`);
      break;
    }
    case "tags": {
      if (args.length > 0) return fail("Usage: tent tags");
      const registry = await loadTagRegistry(env.fs);
      if (registry.tags.length === 0) console.log("(no tags)");
      else for (const tag of registry.tags) console.log(tag);
      break;
    }
    case "find": {
      if (!args[0]) return fail("Usage: tent find <name>");
      if (args.length > 1) return fail("Usage: tent find <name>");
      try {
        normalizeTagName(args[0]);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
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
    case "fork": {
      if (!args[0]) return fail("Usage: tent fork <boxId>");
      if (args.length > 1) return fail("Usage: tent fork <boxId>");
      const id = await forkNode(env, args[0]);
      console.log(`\u2713 Forked ${args[0]} \u2192 ${id}`);
      break;
    }
    case "clean-temp": {
      if (args.length > 1) return fail("Usage: tent clean-temp [role]");
      if (args[0] && isUnsafeRoleSegment(args[0])) return fail(`Invalid role for clean-temp: ${args[0]}`);
      await cleanTemp(env, args[0]);
      console.log(`\u2713 Cleared temp/${args[0] || "(all)"}`);
      break;
    }
    case "force-release": {
      if (!args[0]) return fail("Usage: tent force-release <boxId>");
      if (args.length > 1) return fail("Usage: tent force-release <boxId>");
      await forceRelease(env, args[0]);
      console.log(`\u2713 Force-released owner: ${args[0]}`);
      break;
    }
    case "migrate-kind-to-type": {
      if (args.length > 0) return fail("Usage: tent migrate-kind-to-type");
      const touched = await migrateKindToType(env.fs);
      if (touched.length === 0) console.log("\u2713 No migration needed: no legacy kind fields found");
      else console.log(`\u2713 Migrated legacy kind \u2192 type:
${touched.map((p) => `- ${p}`).join("\n")}`);
      break;
    }
    case "okf-sync": {
      if (args.length > 0) return fail("Usage: tent okf-sync");
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
      const { positionals, flags } = parseFlags(args);
      if (positionals.length > 0) return fail("Usage: tent skill-install [--target claude] [--force]");
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
      if (args.length > 0) return fail("Usage: tent tree");
      const tent = await loadTent(env.fs);
      for (const r of tent.roots) printBox(r, 0);
      break;
    }
    default:
      fail(
        `Unknown command: ${cmd || "(empty)"}
Commands: new role-init roles dispatch task-ack report propose complete stamp status grant-readable new-box tag untag tag-new tag-rm tags find fork clean-temp force-release migrate-kind-to-type okf-sync skill-install tree`
      );
  }
}
function readStdin() {
  return new Promise((resolve5, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve5(data));
    process.stdin.on("error", reject);
  });
}
async function readBodyFile(bodySource) {
  const resolved = path2.resolve(bodySource);
  if (!await existsPath(resolved)) throw new Error(`Body file not found: ${bodySource}.`);
  return fs3.readFile(resolved, "utf8");
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
  return value.includes("..") || /[\/\\\r\n]/.test(value);
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
  return path2.join(os.homedir(), ".claude", "skills");
}
async function installSkills(targetDir, options) {
  if (options.target !== "claude") defaultSkillInstallDir(options.target);
  const sourceDir = path2.join(packageRoot(), "skills");
  const entries = await fs3.readdir(sourceDir, { withFileTypes: true });
  const skillNames = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await existsPath(path2.join(sourceDir, entry.name, "SKILL.md"))) skillNames.push(entry.name);
  }
  if (skillNames.length === 0) throw new Error(`No installable skills found in ${sourceDir}`);
  const conflicts = [];
  for (const name of skillNames) {
    if (await existsPath(path2.join(targetDir, name))) conflicts.push(name);
  }
  if (conflicts.length > 0 && !options.force) {
    throw new Error(`Skills already exist: ${conflicts.join(", ")}. Add --force to overwrite them.`);
  }
  await fs3.mkdir(targetDir, { recursive: true });
  const installed = [];
  for (const name of skillNames) {
    const source = path2.join(sourceDir, name);
    const target = path2.join(targetDir, name);
    assertChildPath(targetDir, target);
    if (options.force) await fs3.rm(target, { recursive: true, force: true });
    await fs3.cp(source, target, { recursive: true, errorOnExist: true });
    installed.push(name);
  }
  return installed.sort();
}
function packageRoot() {
  const here = path2.dirname(fileURLToPath(import.meta.url));
  if (path2.basename(here) === "cli" && path2.basename(path2.dirname(here)) === "src") {
    return path2.resolve(here, "../..");
  }
  return here;
}
function assertChildPath(parent, child) {
  const rel = path2.relative(path2.resolve(parent), path2.resolve(child));
  if (rel.startsWith("..") || path2.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
}
async function existsPath(target) {
  try {
    await fs3.access(target);
    return true;
  } catch {
    return false;
  }
}
async function packageVersion() {
  const pkg = JSON.parse(await fs3.readFile(path2.join(packageRoot(), "package.json"), "utf8"));
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
  dispatch <boxId> <role> <prompt>   Claim a box and create a task envelope.
  task-ack <taskPath>                Mark a task envelope as taken.
  report <boxId> <file|->            Submit a delivery report for triage.
  propose <boxId> <file|->           Submit a proposal prompt for triage.
  complete <boxId> [options]         Confirm completion and release owner.
  stamp <boxId> [--by <role>]        Mark done without workspace commits.
  status                             Print a read-only Tent status summary.
  force-release <boxId>              Release owner without accepting delivery.
  grant-readable <boxId>             Mark a box readable.
  new-box <name> <type> [parentId]   Create a box.
  tag|untag <boxId> <tag>            Add or remove a tag.
  tags | tag-new | tag-rm            Manage the tag registry.
  find <tag>                         Find boxes by tag.
  fork <boxId>                       Copy a box subtree with new ids.
  clean-temp [role]                  Remove temp state for one role or all roles.
  migrate-kind-to-type               Rewrite legacy kind fields to type.
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
  const dataPath = path2.join(path2.resolve(vault), ".obsidian", "plugins", "tent", "data.json");
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
    target = path2.join(path2.resolve(vault), pluginSettings.tentsRoot, target);
  }
  const fsa = new NodeFs(target);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${target}`);
  await fsmod.mkdir(target, { recursive: true });
  const name = path2.basename(path2.resolve(target));
  const fallbackRules = `# ${name} - Project Rules

> Local project rules for this Tent. Created by tent-genesis; edit freely.
> Mechanism-level rules live in the Tent repository docs/SPEC.md; the agent operation protocol lives in the tent-role skill.

- Output workspace: <real code repository path>
- Commit / naming conventions: <fill in>
- Other project rules: <fill in>
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
The root starts empty; add boxes in the panel or create a folder that contains a same-named Markdown note.`
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
