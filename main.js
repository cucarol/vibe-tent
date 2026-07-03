"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/core/typeRegistry.ts
function splitType(type) {
  const i = type.indexOf("-");
  if (i === -1) return { base: type };
  return { base: type.slice(0, i), modifier: type.slice(i + 1) };
}
function joinType(base2, modifier) {
  return modifier ? `${base2}-${modifier}` : base2;
}
function typeExists(type, registry) {
  if (registry[type]) return true;
  const { base: base2, modifier } = splitType(type);
  return !!(registry[base2] && (modifier === void 0 || !!registry[modifier]));
}
function resolveTypeAxis(type, axis, registry) {
  const exact = registry[type];
  if (exact) return exact[axis];
  const { base: base2, modifier } = splitType(type);
  const baseVal = registry[base2]?.[axis];
  const modVal = modifier ? registry[modifier]?.[axis] : void 0;
  return typeof modVal === "boolean" ? modVal : baseVal;
}
async function loadTypeRegistry(fs) {
  if (!await fs.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs.readFile(TYPE_REGISTRY_PATH));
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
var TYPE_REGISTRY_PATH, TYPE_COLOR_PALETTE, DEFAULT_TYPE_REGISTRY;
var init_typeRegistry = __esm({
  "src/core/typeRegistry.ts"() {
    "use strict";
    TYPE_REGISTRY_PATH = ".tent/types.json";
    TYPE_COLOR_PALETTE = ["gray", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "brown"];
    DEFAULT_TYPE_REGISTRY = {
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
  }
});

// src/core/adapter.ts
function withTentMutation(fs, action) {
  return fs.withLock ? fs.withLock(".tent/mutation.lock", action) : action();
}
var init_adapter = __esm({
  "src/core/adapter.ts"() {
    "use strict";
  }
});

// src/core/frontmatter.ts
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
  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let valuePart = trimmed.slice(colon + 1).trim();
    valuePart = stripInlineComment(valuePart);
    data[key] = coerce(valuePart);
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
  if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1);
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowArray(inner).map((item) => coerce(item.trim()));
  }
  return v;
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
  if (/[:,#\[\]]/.test(s) || s !== s.trim() || s === "") return JSON.stringify(s);
  return s;
}
var FENCE, BOX_FRONTMATTER_KEY_ORDER;
var init_frontmatter = __esm({
  "src/core/frontmatter.ts"() {
    "use strict";
    FENCE = "---";
    BOX_FRONTMATTER_KEY_ORDER = ["id", "type", "tags"];
  }
});

// src/core/order.ts
async function loadOrder(fs) {
  if (!await fs.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs.readFile(ORDER_PATH));
  } catch {
    return {};
  }
}
async function saveOrder(fs, map) {
  if (!await fs.exists(".tent")) await fs.mkdir(".tent");
  await fs.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
var ROOT_KEY, ORDER_PATH;
var init_order = __esm({
  "src/core/order.ts"() {
    "use strict";
    ROOT_KEY = "__root__";
    ORDER_PATH = ".tent/order.json";
  }
});

// src/core/tree.ts
function boxNotePath(boxPath) {
  return join2(boxPath, baseName(boxPath) + ".md");
}
async function loadTent(fs) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs);
  const top = await fs.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (entry.name === "temp") continue;
    await loadBoxInto(fs, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs);
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
async function reloadLoadedBox(fs, tent, path) {
  const box = tent.byPath.get(path);
  if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${path}`);
  const { data, body } = parseFrontmatter(await fs.readFile(boxNotePath(path)));
  const identity = normalizeIdentity(data);
  if (identity.fm.id !== box.id) throw new Error("\u589E\u91CF\u91CD\u8F7D\u4E0D\u5141\u8BB8\u4FEE\u6539 box id");
  box.type = identity.fm.type;
  box.kind = identity.fm.kind;
  box.tags = identity.tags;
  box.fm = identity.fm;
  box.body = body;
  for (const root of tent.roots) resolveSubtree(root, tent.typeRegistry);
  resolveLocks(tent.roots);
  return box;
}
function sortChildren(box, order) {
  box.children = sortByOrder(box.children, order[box.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of box.children) sortChildren(c, order);
}
function zoneRank(name) {
  const i = ZONE_NAMES.indexOf(name);
  return i === -1 ? 99 : i;
}
async function loadBox(fs, path, parent, registry) {
  const boxFile = boxNotePath(path);
  if (!await fs.exists(boxFile)) {
    return null;
  }
  const raw = await fs.readFile(boxFile);
  const { data, body } = parseFrontmatter(raw);
  const name = baseName(path);
  const zone = parent ? parent.zone : zoneOf(name);
  const { fm, tags } = normalizeIdentity(data);
  const box = {
    id: fm.id,
    type: fm.type,
    kind: fm.kind,
    tags,
    archived: false,
    invalid: false,
    path,
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
  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    await loadBoxInto(fs, join2(path, entry.name), box, registry, box.children);
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
async function loadBoxInto(fs, path, parent, registry, target) {
  const box = await loadBox(fs, path, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    await loadBoxInto(fs, join2(path, entry.name), parent, registry, target);
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
function join2(...parts) {
  return parts.filter((p) => p !== "").join("/");
}
function baseName(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
function dirName(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
var ZONE_NAMES;
var init_tree = __esm({
  "src/core/tree.ts"() {
    "use strict";
    init_frontmatter();
    init_order();
    init_typeRegistry();
    ZONE_NAMES = ["goal", "prompt", "output"];
  }
});

// src/core/tags.ts
async function loadTagRegistry(fs) {
  if (!await fs.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    return { tags: [] };
  }
}
async function saveTagRegistryUnlocked(fs, registry) {
  if (!await fs.exists(".tent")) await fs.mkdir(".tent");
  await fs.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
async function addRegistryTag(fs, name) {
  await withTentMutation(fs, async () => addRegistryTagUnlocked(fs, name));
}
async function addRegistryTagUnlocked(fs, name) {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs, registry);
  }
}
async function addTag(fs, boxId, name) {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    await addRegistryTagUnlocked(fs, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs, box, tags);
  });
}
async function removeTag(fs, boxId, name) {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    await writeBoxTags(fs, box, box.tags.filter((item) => item !== tag));
  });
}
async function removeRegistryTag(fs, name) {
  await withTentMutation(fs, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs);
    await saveTagRegistryUnlocked(fs, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs, box, box.tags.filter((item) => item !== tag));
      }
    }
  });
}
function normalizeTagName(name) {
  const tag = name.trim();
  if (!tag) throw new Error("tag \u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("tag \u540D\u4E0D\u80FD\u5305\u542B\u8DEF\u5F84\u5206\u9694\u7B26\u6216\u6362\u884C");
  return tag;
}
async function writeBoxTags(fs, box, tags) {
  const path = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(path));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs.writeFile(path, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
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
var TAGS_REGISTRY_PATH;
var init_tags = __esm({
  "src/core/tags.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_tree();
    TAGS_REGISTRY_PATH = ".tent/tags.json";
  }
});

// src/core/skillRoleRegistry.ts
async function loadRolesRegistry(fs) {
  if (!await fs.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`roles.json \u635F\u574F: ${detail}`);
  }
}
async function createRole(fs, definition) {
  await withTentMutation(fs, async () => {
    const role = normalizeRole(definition);
    if (!role.name) throw new Error("role \u540D\u4E0D\u80FD\u4E3A\u7A7A");
    const registry = await loadRolesRegistry(fs);
    if (registry.roles.some((item) => item.name === role.name)) throw new Error(`role \u5DF2\u5B58\u5728: ${role.name}`);
    registry.roles.push(role);
    await writeJson(fs, ROLES_REGISTRY_PATH, registry);
  });
}
async function updateRole(fs, name, patch) {
  await withTentMutation(fs, async () => {
    const registry = await loadRolesRegistry(fs);
    const index = registry.roles.findIndex((role) => role.name === name);
    if (index === -1) throw new Error(`role \u4E0D\u5B58\u5728: ${name}`);
    const next = normalizeRole({ ...registry.roles[index], ...patch, name });
    registry.roles[index] = next;
    await writeJson(fs, ROLES_REGISTRY_PATH, registry);
  });
}
async function deleteRole(fs, name, confirmation) {
  await withTentMutation(fs, async () => {
    if (confirmation !== name) throw new Error(`\u4E8C\u6B21\u786E\u8BA4\u4E0D\u5339\u914D;\u8BF7\u8F93\u5165 role \u540D ${name}`);
    const registry = await loadRolesRegistry(fs);
    const next = registry.roles.filter((role) => role.name !== name);
    if (next.length === registry.roles.length) throw new Error(`role \u4E0D\u5B58\u5728: ${name}`);
    await writeJson(fs, ROLES_REGISTRY_PATH, { roles: next });
  });
}
function normalizeRolesRegistry(value) {
  const root = isRecord3(value) ? value : {};
  const roles = [];
  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord3(item)) continue;
      const role = normalizeRole(item);
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      roles.push(role);
    }
  }
  return { roles };
}
function normalizeRole(value) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const role = { name };
  if (typeof value.prompt === "string" && value.prompt.trim()) role.prompt = value.prompt.trim();
  if (typeof value.description === "string" && value.description.trim()) role.description = value.description.trim();
  if (typeof value.color === "string" && value.color.trim()) role.color = value.color.trim();
  return role;
}
function cloneDefaultRoles() {
  return {
    roles: DEFAULT_ROLES_REGISTRY.roles.map((role) => ({ ...role }))
  };
}
async function writeJson(fs, path, value) {
  if (!await fs.exists(".tent")) await fs.mkdir(".tent");
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var ROLES_REGISTRY_PATH, DEFAULT_ROLES_REGISTRY;
var init_skillRoleRegistry = __esm({
  "src/core/skillRoleRegistry.ts"() {
    "use strict";
    init_adapter();
    ROLES_REGISTRY_PATH = ".tent/roles.json";
    DEFAULT_ROLES_REGISTRY = {
      roles: []
    };
  }
});

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
function isFrozen(box) {
  return box.invalid || box.archived || box.locked;
}
var init_claim = __esm({
  "src/core/claim.ts"() {
    "use strict";
  }
});

// src/core/proposal.ts
async function loadProposals(fs) {
  const out = [];
  if (!await fs.exists("temp")) return out;
  const roles = await fs.listDir("temp");
  for (const r of roles) {
    if (!r.isDir) continue;
    const propDir = join2("temp", r.name, "proposals");
    if (!await fs.exists(propDir)) continue;
    const files = await fs.listDir(propDir);
    for (const f of files) {
      if (f.isDir || !f.name.endsWith(".md")) continue;
      const path = join2(propDir, f.name);
      const { data, body } = parseFrontmatter(await fs.readFile(path));
      if (typeof data.target !== "string") continue;
      out.push({
        path,
        target: data.target,
        status: data.status || "open",
        from: typeof data.from === "string" ? data.from : r.name,
        note: typeof data.note === "string" ? data.note : void 0,
        body
      });
    }
  }
  return out;
}
function countByTarget(proposals) {
  const m = /* @__PURE__ */ new Map();
  for (const p of proposals) {
    if (p.status !== "open") continue;
    m.set(p.target, (m.get(p.target) || 0) + 1);
  }
  return m;
}
async function buildInbox(_fs, tent, proposals) {
  const items = [];
  for (const p of proposals) {
    if (p.status !== "open") continue;
    const check = validateProposalTarget(tent, p.target);
    if (check.ok) items.push({ kind: "proposal", proposal: p });
    else items.push({ kind: "invalid-proposal", proposal: p, reason: check.reason || "\u76EE\u6807\u4E0D\u53EF\u7528" });
  }
  for (const box of tent.byId.values()) {
    if (box.invalid || box.archived) continue;
    const role = box.fm.owner;
    if (!role) continue;
    items.push({ kind: "stale", role, boxPath: box.path, boxId: box.id });
  }
  return items;
}
function validateProposalTarget(tent, targetId) {
  const target = tent.byId.get(targetId);
  if (!target) return { ok: false, reason: `\u627E\u4E0D\u5230\u76EE\u6807\u6846 ${targetId}` };
  if (target.invalid || target.archived) return { ok: false, reason: `\u76EE\u6807\u6846\u4E0D\u53EF\u63D0 proposal:${target.invalidReason || "\u5DF2\u5F52\u6863"}` };
  if (!target.readable.value) return { ok: false, reason: `\u76EE\u6807\u6846\u4E0D\u53EF\u8BFB,\u4E0D\u80FD\u63D0 proposal: ${targetId}` };
  return { ok: true, target };
}
function pendingCount(items) {
  return items.filter((i) => i.kind === "proposal" || i.kind === "invalid-proposal").length;
}
var init_proposal = __esm({
  "src/core/proposal.ts"() {
    "use strict";
    init_frontmatter();
    init_tree();
  }
});

// src/core/handoff.ts
async function loadHandoffs(fs) {
  const handoffs = [];
  if (!await fs.exists("temp")) return handoffs;
  const roleDirs = await fs.listDir("temp");
  for (const roleDir of roleDirs) {
    if (!roleDir.isDir) continue;
    const dir = join2("temp", roleDir.name, "handoffs");
    if (!await fs.exists(dir)) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join2(dir, entry.name);
      const handoff2 = parseHandoff(path, await fs.readFile(path), roleDir.name);
      if (handoff2) handoffs.push(handoff2);
    }
  }
  return handoffs.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "") || a.path.localeCompare(b.path));
}
async function loadHandoff(fs, inputPath) {
  const path = normalizeHandoffPath(inputPath);
  if (!await fs.exists(path)) throw new Error(`\u627E\u4E0D\u5230 handoff: ${path}`);
  const sourceRole = path.split("/")[1] || "";
  const handoff2 = parseHandoff(path, await fs.readFile(path), sourceRole);
  if (!handoff2) throw new Error(`handoff \u683C\u5F0F\u65E0\u6548: ${path}`);
  return handoff2;
}
async function validateDispatchHandoff(fs, inputPath, targetId, targetRole) {
  const handoff2 = await loadHandoff(fs, inputPath);
  if (handoff2.targetId !== targetId) {
    throw new Error(`handoff \u76EE\u6807\u662F ${handoff2.targetId},\u4E0D\u80FD\u6D3E\u5230 ${targetId}`);
  }
  if (handoff2.targetRole !== targetRole) {
    throw new Error(`handoff \u6307\u5B9A role ${handoff2.targetRole},\u4E0D\u80FD\u6D3E\u7ED9 ${targetRole}`);
  }
  return handoff2;
}
function parseHandoff(path, raw, sourceRole) {
  const { data, body } = parseFrontmatter(raw);
  if (data.type !== "handoff") return null;
  if (typeof data.from !== "string" || typeof data.target !== "string" || typeof data.role !== "string") {
    return null;
  }
  return {
    path,
    fromBoxId: data.from,
    targetId: data.target,
    targetRole: data.role,
    fromRole: typeof data.by === "string" && data.by ? data.by : sourceRole,
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    body: body.trim()
  };
}
function normalizeHandoffPath(input) {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/handoffs\/[^/]+\.md$/.test(path)) {
    throw new Error("handoff \u5FC5\u987B\u6307\u5411 temp/<role>/handoffs/*.md");
  }
  return path;
}
var init_handoff = __esm({
  "src/core/handoff.ts"() {
    "use strict";
    init_frontmatter();
    init_tree();
  }
});

// src/core/report.ts
async function loadReports(fs) {
  const reports = [];
  if (!await fs.exists("temp")) return reports;
  for (const roleDir of await fs.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join2("temp", roleDir.name, "reports");
    if (!await fs.exists(dir)) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join2(dir, entry.name);
      try {
        reports.push(await loadReport(fs, path));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs, inputPath) {
  const path = normalizeReportPath(inputPath);
  if (!await fs.exists(path)) throw new Error(`\u627E\u4E0D\u5230 report: ${path}`);
  const { data, body } = parseFrontmatter(await fs.readFile(path));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`report \u683C\u5F0F\u65E0\u6548: ${path}`);
  }
  return {
    path,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function rejectReport(fs, inputPath, review) {
  await withTentMutation(fs, async () => {
    const report = await loadReport(fs, inputPath);
    if (report.status !== "ready") throw new Error("\u53EA\u6709 ready report \u53EF\u4EE5\u9A73\u56DE");
    report.status = "rejected";
    report.review = review?.trim() || "user \u9A73\u56DE\uFF0C\u7B49\u5F85\u91CD\u65B0\u4EA4\u4ED8";
    await writeReport(fs, report);
  });
}
async function removeReportsForBox(fs, boxId) {
  for (const report of await loadReports(fs)) {
    if (report.boxId === boxId && await fs.exists(report.path)) await fs.remove(report.path);
  }
}
function normalizeReportPath(input) {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/bx-[^/]+\.md$/.test(path)) {
    throw new Error("report \u5FC5\u987B\u6307\u5411 temp/<role>/reports/<boxId>.md");
  }
  return path;
}
async function writeReport(fs, report) {
  const data = {
    type: "report",
    box: report.boxId,
    role: report.role,
    status: report.status,
    commits: report.commits,
    ts: report.timestamp,
    review: report.review
  };
  await fs.writeFile(
    report.path,
    serializeFrontmatter(data, report.body + "\n", ["type", "box", "role", "status", "commits", "ts", "review"])
  );
}
function uniqueCommits(commits) {
  return [...new Set(commits.map((item) => item.trim()).filter(Boolean))];
}
var init_report = __esm({
  "src/core/report.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_tree();
  }
});

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
  readable.push({ path: "temp/", note: "\u7CFB\u7EDF\u7BA1\u9053:\u53EF\u8BFB\u5168\u90E8\u89D2\u8272\u4EA4\u4ED8\u4E0E handoff" });
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
  writable.push({ path: join2("temp", role) + "/" });
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
  const base2 = splitType(box.type).base;
  if (base2 === "goal") return 0;
  if (base2 === "prompt") return 1;
  if (base2 === "output") return 2;
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
var init_manifest = __esm({
  "src/core/manifest.ts"() {
    "use strict";
    init_tree();
    init_typeRegistry();
  }
});

// src/core/id.ts
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
var ALPHABET;
var init_id = __esm({
  "src/core/id.ts"() {
    "use strict";
    ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
  }
});

// src/core/task.ts
async function ensureRoleInit(fs, role, tentName) {
  const path = join2("temp", role.name, "init.md");
  const body = `# Role Init

- Tent: ${tentName}
- Rules: RULES.md
- Role registry: .tent/roles.json (or run \`tent roles\`)

## Role Prompt

${role.prompt?.trim() || "(\u65E0\u957F\u671F role prompt)"}

## Operating Model

Manifest \u7684 readable/writable \u662F honor contract\uFF0C\u4E0D\u662F\u5B89\u5168\u6C99\u7BB1\u3002\u9047\u5230 prompt \u51B2\u7A81\u6216\u65E0\u6CD5\u9075\u5B88\u7684\u8FB9\u754C\u65F6\uFF0C\u505C\u6B62\u5E76\u8BE2\u95EE user\u3002
`;
  await fs.writeFile(path, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path;
}
async function writeTaskEnvelope(fs, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  const handoffPath = input.handoffPath?.trim() || "";
  if (!userPrompt && !handoffPath) throw new Error("\u6D3E\u6D3B\u81F3\u5C11\u9700\u8981 user prompt \u6216 handoff prompt");
  const dir = join2("temp", input.role, "tasks");
  await ensureDir(fs, dir);
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path = await uniqueMarkdownPath(fs, dir, stem);
  const data = {
    type: "task",
    role: input.role,
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath
  };
  if (handoffPath) data.handoff = handoffPath;
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
` + (handoffPath ? `- Handoff: ${handoffPath}
` : "") + (userPrompt ? `
## User Prompt

${userPrompt}
` : "");
  await fs.writeFile(path, serializeFrontmatter(data, body));
  return path;
}
function taskStem(now, claimId) {
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp2}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join2(dir, `${stem}${suffix}.md`);
    if (!await fs.exists(path)) return path;
  }
}
async function ensureDir(fs, path) {
  if (!await fs.exists(path)) await fs.mkdir(path);
}
var init_task = __esm({
  "src/core/task.ts"() {
    "use strict";
    init_frontmatter();
    init_tree();
  }
});

// src/core/ops.ts
var ops_exports = {};
__export(ops_exports, {
  acceptReport: () => acceptReport,
  adoptCopiedSubtree: () => adoptCopiedSubtree,
  applyProposal: () => applyProposal,
  archiveBox: () => archiveBox,
  cleanTemp: () => cleanTemp,
  completeClaim: () => completeClaim,
  createBox: () => createBox,
  createTag: () => createTag,
  deleteArchivedBox: () => deleteArchivedBox,
  deleteTag: () => deleteTag,
  dispatch: () => dispatch,
  finishApply: () => finishApply,
  forceRelease: () => forceRelease,
  forkNode: () => forkNode,
  grantReadable: () => grantReadable,
  handoff: () => handoff,
  patchBody: () => patchBody,
  patchBox: () => patchBox,
  placeBox: () => placeBox,
  propose: () => propose,
  restoreBox: () => restoreBox,
  stamp: () => stamp,
  startApply: () => startApply,
  tagBox: () => tagBox,
  untagBox: () => untagBox
});
async function dispatch(env, claimId, role, promptOrOptions) {
  return withMutation(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}
async function dispatchUnlocked(env, claimId, role, promptOrOptions) {
  const tent = await loadTent(env.fs);
  const roleName = assertRoleName(role);
  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const options = typeof promptOrOptions === "string" ? { userPrompt: promptOrOptions } : promptOrOptions;
  const userPrompt = options.userPrompt?.trim() || "";
  const handoffPath = options.handoffPath?.trim() || "";
  let resolvedHandoffPath = handoffPath;
  if (!userPrompt && !handoffPath) {
    throw new Error("\u6D3E\u6D3B\u81F3\u5C11\u9700\u8981 user prompt \u6216 handoff prompt");
  }
  if (handoffPath) {
    if (claim.root) throw new Error("handoff \u5FC5\u987B\u6D3E\u5230\u5176\u6307\u5B9A box,\u4E0D\u80FD\u6D3E\u5230\u5E10\u6839");
    resolvedHandoffPath = (await validateDispatchHandoff(env.fs, handoffPath, claim.box.id, roleName)).path;
  }
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
  const manifestPath = join2("temp", roleName, "manifest.yml");
  await ensureDir2(env.fs, dirName(manifestPath));
  await env.fs.writeFile(manifestPath, yaml);
  const registry = await loadRolesRegistry(env.fs);
  const roleDefinition = registry.roles.find((item) => item.name === roleName) ?? { name: roleName };
  const initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
  const taskClaims = claim.root ? [{ id: "root", path: "./" }] : [{ id: claim.box.id, path: claim.box.path }];
  const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
    role: roleName,
    claims: taskClaims,
    manifestPath,
    userPrompt: options.userPrompt,
    handoffPath: resolvedHandoffPath || void 0,
    workspace: options.workspace
  });
  const relayPrompt = `\u8BFB\u53D6 ${taskPath} \u5E76\u6267\u884C\u3002\u82E5\u8FD9\u662F\u8BE5 role \u7684\u65B0\u4F1A\u8BDD,\u5148\u6309 ${initPath} \u5B8C\u6210 role init\uFF1B\u662F\u5426\u590D\u7528\u65E7\u4F1A\u8BDD\u7531 user \u51B3\u5B9A\u3002`;
  return { manifestPath, manifestYaml: yaml, initPath, taskPath, relayPrompt };
}
function resolveDispatchClaim(tent, claimId, tentName) {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) return { root: true, id: "root", name: "\u5E10\u6839" };
  const box = tent.byId.get(id);
  if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${claimId}`);
  return { root: false, id: box.id, name: box.name, box };
}
async function stamp(env, boxId) {
  await completeClaim(env, boxId);
}
async function completeClaim(env, boxId, integrate) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (integrate) await integrate();
    await setOwner(env.fs, box, void 0, "done");
  });
}
async function acceptReport(env, reportPath, integrate) {
  await withMutation(env.fs, async () => {
    const report = await loadReport(env.fs, reportPath);
    if (report.status !== "ready") throw new Error("\u53EA\u6709 ready report \u53EF\u4EE5\u786E\u8BA4");
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(report.boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${report.boxId}`);
    if (box.fm.owner !== report.role) throw new Error("report role \u4E0E\u5F53\u524D owner \u4E0D\u4E00\u81F4");
    if (report.commits.length > 0) {
      if (!integrate) throw new Error("report \u542B commits,\u5FC5\u987B\u5B8C\u6210 workspace \u5408\u5165");
      await integrate(report.commits);
    }
    await setOwner(env.fs, box, void 0, "done");
    await env.fs.remove(report.path);
  });
}
async function propose(env, targetId, role, body) {
  return withMutation(env.fs, async () => {
    const roleName = assertRoleName(role);
    const tent = await loadTent(env.fs);
    const check = validateProposalTarget(tent, targetId);
    if (!check.ok) throw new Error(check.reason || "proposal target \u4E0D\u53EF\u7528");
    const content = body.trim();
    if (!content) throw new Error("proposal \u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
    const dir = join2("temp", roleName, "proposals");
    await ensureDir2(env.fs, dir);
    const proposalPath = await uniqueProposalPath(env.fs, dir, targetId, env.clock.now());
    const data = {
      type: "proposal",
      target: targetId,
      status: "open",
      from: roleName
    };
    await env.fs.writeFile(
      proposalPath,
      serializeFrontmatter(data, content + "\n", ["type", "target", "status", "from", "note"])
    );
    return { proposalPath };
  });
}
async function applyProposal(env, proposalPath, accept, note) {
  await withMutation(env.fs, async () => {
    const raw = await env.fs.readFile(proposalPath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (accept) {
      const targetId = typeof data.target === "string" ? data.target : String(data.target || "");
      const check = validateProposalTarget(await loadTent(env.fs), targetId);
      if (!check.ok) throw new Error(check.reason || "proposal target \u4E0D\u53EF\u7528");
    }
    data.status = accept ? "accepted" : "rejected";
    if (note) data.note = note;
    await env.fs.writeFile(proposalPath, serializeFrontmatter(data, body, keyOrder));
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
async function startApply(env, proposalPath) {
  const { data, body } = parseFrontmatter(await env.fs.readFile(proposalPath));
  if (data.status !== "accepted") {
    throw new Error(`proposal \u4E0D\u662F accepted \u72B6\u6001(\u5F53\u524D ${data.status});\u53EA\u6709 user \u6279\u51C6\u8FC7\u7684\u624D\u80FD\u843D\u5730`);
  }
  const targetId = String(data.target);
  const tent = await loadTent(env.fs);
  const check = validateProposalTarget(tent, targetId);
  if (!check.ok || !check.target) throw new Error(check.reason || `\u627E\u4E0D\u5230\u76EE\u6807\u6846 ${targetId}`);
  const target = check.target;
  if (!isUsableBox(target)) throw new Error(`\u76EE\u6807\u6846\u4E0D\u53EF\u843D\u5730:${target.invalidReason || "\u5DF2\u5F52\u6863"}`);
  return { targetId, targetPath: target.path, instructions: body.trim() };
}
async function finishApply(env, proposalPath) {
  await withMutation(env.fs, async () => {
    const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(proposalPath));
    if (data.status !== "accepted") {
      throw new Error(`proposal \u4E0D\u662F accepted \u72B6\u6001,\u65E0\u6CD5\u6536\u5C3E`);
    }
    data.status = "applied";
    await env.fs.writeFile(proposalPath, serializeFrontmatter(data, body, keyOrder));
  });
}
async function forkNode(env, boxId) {
  return withMutation(env.fs, async () => forkNodeUnlocked(env, boxId));
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
    const nextPath = rel ? join2(forkPath, rel) : forkPath;
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
async function adoptCopiedSubtree(env, boxPath) {
  return withMutation(env.fs, async () => {
    await normalizeCopiedRootIdentity(env.fs, boxPath);
    const tent = await loadTent(env.fs);
    const root = tent.byPath.get(boxPath);
    if (!root) throw new Error(`\u627E\u4E0D\u5230\u590D\u5236\u6846 ${boxPath}`);
    const copied = collectSubtree(root);
    const copiedPaths = new Set(copied.map((box) => box.path));
    const outsideIds = new Set(
      [...tent.byPath.values()].filter((box) => !copiedPaths.has(box.path) && box.id).map((box) => box.id)
    );
    const hasDuplicate = copied.some((box) => outsideIds.has(box.id));
    if (!hasDuplicate) return [];
    const idMap = /* @__PURE__ */ new Map();
    for (const box of copied) {
      const next = makeUniqueBoxId(outsideIds, env.rand);
      outsideIds.add(next);
      idMap.set(box.id, next);
    }
    for (const box of copied) {
      const path = boxNotePath(box.path);
      const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(path));
      data.id = idMap.get(box.id);
      delete data.owner;
      delete data.status;
      delete data.forkOf;
      delete data.forkBase;
      await env.fs.writeFile(path, serializeFrontmatter(data, body, keyOrder));
    }
    const order = await loadOrder(env.fs);
    for (const box of copied) {
      const children = order[box.id];
      const nextId = idMap.get(box.id);
      if (children && nextId) {
        order[nextId] = children.map((id) => idMap.get(id)).filter((id) => !!id);
      }
    }
    await saveOrder(env.fs, order);
    return copied.map((box) => idMap.get(box.id));
  });
}
async function normalizeCopiedRootIdentity(fs, boxPath) {
  const expected = boxNotePath(boxPath);
  if (await fs.exists(expected) || !await fs.exists(boxPath)) return;
  const candidates = [];
  for (const entry of await fs.listDir(boxPath)) {
    if (entry.isDir || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
    const candidate = join2(boxPath, entry.name);
    const { data } = parseFrontmatter(await fs.readFile(candidate));
    if (typeof data.id === "string" && data.id.startsWith("bx-") && typeof data.type === "string") {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 1) await fs.move(candidates[0], expected);
}
async function handoff(env, fromBoxId, targetId, targetRole, prompt) {
  return withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const from = tent.byId.get(fromBoxId);
    if (!from) throw new Error(`\u627E\u4E0D\u5230\u6846 ${fromBoxId}`);
    if (!isUsableBox(from)) throw new Error("\u4EA4\u63A5\u6765\u6E90\u6846\u4E0D\u53EF\u7528");
    const target = tent.byId.get(targetId);
    if (!target) throw new Error(`\u627E\u4E0D\u5230\u6846 ${targetId}`);
    if (!isUsableBox(target)) throw new Error("\u4EA4\u63A5\u76EE\u6807\u6846\u4E0D\u53EF\u7528");
    const role = assertRoleName(targetRole);
    const body = prompt.trim();
    if (!body) throw new Error("handoff prompt \u4E0D\u80FD\u4E3A\u7A7A");
    const fromRole = from.fm.owner || "_";
    const dir = join2("temp", fromRole, "handoffs");
    await ensureDir2(env.fs, dir);
    const handoffPath = await uniqueHandoffPath(env.fs, dir, targetId, env.clock.now());
    const data = {
      type: "handoff",
      from: fromBoxId,
      target: targetId,
      role,
      by: from.fm.owner || "",
      ts: env.clock.now()
    };
    await env.fs.writeFile(
      handoffPath,
      serializeFrontmatter(data, body + "\n", ["type", "from", "target", "role", "by", "ts"])
    );
    return handoffPath;
  });
}
async function cleanTemp(env, role) {
  await withMutation(env.fs, async () => {
    const target = role ? join2("temp", role) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!role) await ensureDir2(env.fs, "temp");
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
    const parent = tent.byPath.get(input.parentPath);
    if (!parent || !isUsableBox(parent)) throw new Error("\u76EE\u6807\u7236\u6846\u5931\u6548\u6216\u5DF2\u5F52\u6863");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueBoxId(existing, env.rand);
  const path = join2(input.parentPath, input.name);
  assertNotTempPath(path);
  await ensureDir2(env.fs, path);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${input.name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path), content);
  return id;
}
async function placeBox(env, fromPath, newParentPath, position) {
  await withMutation(env.fs, async () => placeBoxUnlocked(env, fromPath, newParentPath, position));
}
async function placeBoxUnlocked(env, fromPath, newParentPath, position) {
  assertNotTempPath(newParentPath);
  const before = await loadTent(env.fs);
  const moved = before.byPath.get(fromPath);
  if (!moved) throw new Error(`\u627E\u4E0D\u5230\u6846 ${fromPath}`);
  if (!isUsableBox(moved)) throw new Error("\u5931\u6548\u6216\u5F52\u6863\u6846\u4E0D\u53EF\u79FB\u52A8");
  if (isFrozen(moved)) throw new Error("\u8BA4\u9886\u8303\u56F4\u4E0D\u80FD\u79FB\u52A8;\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05 owner");
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
  const parentBox = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentBox || !isUsableBox(parentBox))) throw new Error("\u76EE\u6807\u7236\u6846\u5931\u6548\u6216\u5DF2\u5F52\u6863");
  if (parentBox && isFrozen(parentBox)) throw new Error("\u4E0D\u80FD\u79FB\u5165\u8BA4\u9886\u8303\u56F4;\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05 owner");
  if (newParentPath === fromPath || newParentPath.startsWith(fromPath + "/")) {
    throw new Error("\u4E0D\u80FD\u628A\u6846\u79FB\u5165\u81EA\u5DF1\u7684\u5B50\u6811");
  }
  const parentKey = parentBox ? parentBox.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;
  const siblings = (parentBox ? parentBox.children : before.roots).filter((b) => b.id !== movedId).map((b) => b.id);
  let insertAt;
  if (position.mode === "inside") {
    insertAt = siblings.length;
  } else {
    const idx = siblings.indexOf(position.siblingId);
    insertAt = idx === -1 ? siblings.length : position.mode === "before" ? idx : idx + 1;
  }
  siblings.splice(insertAt, 0, movedId);
  const order = await loadOrder(env.fs);
  if (dirName(fromPath) !== newParentPath) {
    const destination = join2(newParentPath, movedName);
    await env.fs.move(fromPath, destination);
    if (order[oldParentKey]) order[oldParentKey] = order[oldParentKey].filter((id) => id !== movedId);
    try {
      order[parentKey] = siblings;
      await saveOrder(env.fs, order);
    } catch (error) {
      try {
        await env.fs.move(destination, fromPath);
      } catch {
        throw new Error(`\u79FB\u52A8\u540E order \u4FDD\u5B58\u5931\u8D25,\u4E14\u56DE\u6EDA\u5931\u8D25: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    return;
  }
  order[parentKey] = siblings;
  await saveOrder(env.fs, order);
}
async function patchBox(env, boxPath, patch, loadedTent) {
  await withMutation(env.fs, async () => patchBoxUnlocked(env, boxPath, patch, loadedTent));
}
async function patchBoxUnlocked(env, boxPath, patch, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxPath}`);
  const reserved = ["id", "owner", "archived", "kind"].filter((key) => key in patch);
  if (reserved.length > 0) throw new Error(`\u4FDD\u7559\u5B57\u6BB5\u53EA\u80FD\u8D70\u4E13\u7528 core API: ${reserved.join(", ")}`);
  if (box.archived) throw new Error("\u5F52\u6863\u6846\u53EA\u80FD\u6062\u590D\u6216\u6C38\u4E45\u5220\u9664");
  if (box.invalid) {
    const keys = Object.keys(patch);
    if (box.id !== box.invalidRootId || keys.some((key) => key !== "type")) {
      throw new Error("\u5931\u6548\u5B50\u6811\u53EA\u5141\u8BB8\u5728\u5931\u6548\u6839\u4FEE\u6539 type \u4EE5\u6551\u6D3B");
    }
  }
  if ("type" in patch) {
    if (typeof patch.type !== "string" || !patch.type) throw new Error("\u4E00\u7EA7 type \u4E0D\u5141\u8BB8\u6E05\u7A7A");
    if (!typeExists(patch.type, tent.typeRegistry)) throw new Error(`\u672A\u77E5 type: ${patch.type}`);
  }
  if ("status" in patch) {
    if (box.fm.owner) throw new Error("\u8BA4\u9886\u4E2D\u7684 status \u53EA\u80FD\u901A\u8FC7\u5B8C\u6210\u6216\u4E2D\u65AD\u52A8\u4F5C\u4FEE\u6539");
    if (patch.status !== void 0 && !["todo", "doing", "done"].includes(String(patch.status))) {
      throw new Error("status \u5FC5\u987B\u662F todo/doing/done");
    }
  }
  if ("tags" in patch) {
    patch = { ...patch, tags: normalizeTagPatch(patch.tags) };
  }
  const boxFile = boxNotePath(boxPath);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
}
async function patchBody(env, boxPath, newBody, loadedTent) {
  await withMutation(env.fs, async () => patchBodyUnlocked(env, boxPath, newBody, loadedTent));
}
async function patchBodyUnlocked(env, boxPath, newBody, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box || !isUsableBox(box)) throw new Error("\u5931\u6548\u6216\u5F52\u6863\u6846\u4E0D\u53EF\u7F16\u8F91\u6B63\u6587");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}
async function archiveBox(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (!isUsableBox(box)) throw new Error("\u5931\u6548\u6216\u5DF2\u5F52\u6863\u6846\u4E0D\u80FD\u5F52\u6863");
    if (isFrozen(box)) throw new Error("\u8BA4\u9886\u8303\u56F4\u4E0D\u80FD\u5F52\u6863;\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05 owner");
    await patchFrontmatter(env.fs, box, { archived: true });
  });
}
async function restoreBox(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (box.fm.archived !== true) throw new Error("\u53EA\u80FD\u4ECE\u663E\u5F0F\u5F52\u6863\u6839\u6062\u590D\u6574\u68F5\u5B50\u6811");
    await patchFrontmatter(env.fs, box, { archived: void 0 });
  });
}
async function deleteArchivedBox(env, boxId) {
  await withMutation(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`\u627E\u4E0D\u5230\u6846 ${boxId}`);
    if (box.fm.archived !== true) throw new Error("node \u5FC5\u987B\u5148\u5F52\u6863\u624D\u80FD\u6C38\u4E45\u5220\u9664");
    if (hasOwnerInSubtree(box)) throw new Error("\u5F52\u6863\u5B50\u6811\u4ECD\u6709 owner,\u4E0D\u80FD\u5220\u9664");
    const removedIds = collectSubtreeIds(box);
    await env.fs.remove(box.path);
    const order = await loadOrder(env.fs);
    for (const key of Object.keys(order)) {
      if (removedIds.has(key)) delete order[key];
      else order[key] = order[key].filter((id) => !removedIds.has(id));
    }
    await saveOrder(env.fs, order);
  });
}
async function setOwner(fs, box, owner, status) {
  const patch = { owner: owner ?? void 0 };
  if (status) patch.status = status;
  await patchFrontmatter(fs, box, patch);
}
async function patchFrontmatter(fs, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
}
async function ensureDir2(fs, path) {
  if (path && !await fs.exists(path)) await fs.mkdir(path);
}
function normalizeTagPatch(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new Error("tags \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
  const tags = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("tags \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    const tag = normalizeTagName(item);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.length > 0 ? tags.sort((a, b) => a.localeCompare(b)) : void 0;
}
function boxKeyOrder2(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function assertNotTempPath(path) {
  if (path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp \u662F\u7CFB\u7EDF\u7BA1\u9053,\u4E0D\u5141\u8BB8\u521B\u5EFA\u6216\u79FB\u52A8 typed box");
  }
}
function hasOwnerInSubtree(box) {
  if (box.fm.owner) return true;
  return box.children.some(hasOwnerInSubtree);
}
function collectSubtreeIds(box, ids = /* @__PURE__ */ new Set()) {
  ids.add(box.id);
  for (const child of box.children) collectSubtreeIds(child, ids);
  return ids;
}
function assertRoleName(role) {
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
async function withMutation(fs, action) {
  return withTentMutation(fs, action);
}
async function uniqueProposalPath(fs, dir, targetId, now) {
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 18) || "proposal";
  const safeTarget = targetId.replace(/[^0-9A-Za-z_-]+/g, "-") || "target";
  let n = 1;
  while (true) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join2(dir, `pr-${stamp2}-${safeTarget}${suffix}.md`);
    if (!await fs.exists(path)) return path;
    n += 1;
  }
}
async function uniqueHandoffPath(fs, dir, targetId, now) {
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 18) || "handoff";
  const safeTarget = targetId.replace(/[^0-9A-Za-z_-]+/g, "-") || "target";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join2(dir, `hf-${stamp2}-${safeTarget}${suffix}.md`);
    if (!await fs.exists(path)) return path;
  }
}
async function uniqueSiblingPath(fs, parentPath, base2) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base2 : `${base2.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join2(parentPath, name);
    if (!await fs.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs, from, to) {
  await fs.mkdir(to);
  for (const entry of await fs.listDir(from)) {
    const src = join2(from, entry.name);
    const dst = join2(to, entry.name);
    if (entry.isDir) await copyTree(fs, src, dst);
    else await fs.writeFile(dst, await fs.readFile(src));
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
async function ensureIdentityFileName(fs, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join2(newBoxPath, oldName);
  if (await fs.exists(copied)) await fs.move(copied, expected);
}
var init_ops = __esm({
  "src/core/ops.ts"() {
    "use strict";
    init_adapter();
    init_tree();
    init_manifest();
    init_id();
    init_frontmatter();
    init_order();
    init_claim();
    init_tree();
    init_proposal();
    init_tags();
    init_typeRegistry();
    init_skillRoleRegistry();
    init_task();
    init_handoff();
    init_report();
  }
});

// src/plugin/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TentPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian5 = require("obsidian");

// src/plugin/view.ts
var import_obsidian4 = require("obsidian");
var nodePath3 = __toESM(require("node:path"), 1);

// src/plugin/obsidian-fs.ts
var import_obsidian = require("obsidian");
var nodePath = __toESM(require("node:path"), 1);
var nodeFs = __toESM(require("node:fs/promises"), 1);
var ObsidianFs = class {
  constructor(app, tentRoot) {
    this.app = app;
    this.tentRoot = tentRoot;
  }
  get a() {
    return this.app.vault.adapter;
  }
  vp(p) {
    return p ? `${this.tentRoot}/${p}` : this.tentRoot;
  }
  async listDir(dir) {
    const listing = await this.a.list(this.vp(dir));
    const out = [];
    for (const f of listing.folders) out.push({ name: base(f), isDir: true });
    for (const f of listing.files) out.push({ name: base(f), isDir: false });
    return out;
  }
  async readFile(path) {
    return this.a.read(this.vp(path));
  }
  // 逐级建目录,对齐 node-fs 的 { recursive: true }(Obsidian adapter.mkdir 不保证递归)。
  async ensureDirAbs(vaultPath) {
    if (!vaultPath) return;
    const parts = vaultPath.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!await this.a.exists(cur)) await this.a.mkdir(cur);
    }
  }
  async writeFile(path, content) {
    await this.ensureDirAbs(parentOf(this.vp(path)));
    await this.a.write(this.vp(path), content);
  }
  async exists(path) {
    return this.a.exists(this.vp(path));
  }
  async mkdir(path) {
    await this.ensureDirAbs(this.vp(path));
  }
  async move(from, to) {
    await this.ensureDirAbs(parentOf(this.vp(to)));
    await this.a.rename(this.vp(from), this.vp(to));
  }
  async remove(path) {
    const vp = this.vp(path);
    const stat2 = await this.a.stat(vp);
    if (stat2?.type === "folder") await this.a.rmdir(vp, true);
    else await this.a.remove(vp);
  }
  async withLock(path, action) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian.FileSystemAdapter)) return action();
    const lockPath = nodePath.join(adapter.getBasePath(), this.vp(path));
    await nodeFs.mkdir(nodePath.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await nodeFs.open(lockPath, "wx");
        break;
      } catch (error) {
        const exists = typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
        if (!exists) throw error;
        const stat2 = await nodeFs.stat(lockPath).catch(() => void 0);
        if (!stat2 || Date.now() - stat2.mtimeMs > 12e4) {
          await nodeFs.rm(lockPath, { force: true });
          continue;
        }
        throw new Error("Tent \u6B63\u5728\u6267\u884C\u53E6\u4E00\u4E2A\u5199\u64CD\u4F5C,\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
    }
    if (!handle) throw new Error("\u65E0\u6CD5\u83B7\u53D6 Tent mutation lock");
    try {
      await handle.writeFile(JSON.stringify({ createdAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await nodeFs.rm(lockPath, { force: true });
    }
  }
};
var SystemClock = class {
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
};
function base(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// src/plugin/colors.ts
init_typeRegistry();
var TYPE_COLORS = TYPE_COLOR_PALETTE;
var FALLBACK_COLORS = {
  gray: "#8a8678",
  red: "#c14f3c",
  orange: "#d17f2e",
  yellow: "#cba61a",
  green: "#5a9e4f",
  cyan: "#2f9e93",
  blue: "#4f74c4",
  purple: "#8a6bc0",
  pink: "#c8589a",
  brown: "#8a5a34"
};
function typeColorValue(color) {
  const value = color?.trim();
  if (!value) return FALLBACK_COLORS.gray;
  if (value in FALLBACK_COLORS) return `var(--color-${value}, ${FALLBACK_COLORS[value]})`;
  return value;
}

// src/plugin/view.ts
init_tags();
init_tree();
init_typeRegistry();
init_skillRoleRegistry();
init_claim();
init_proposal();
init_handoff();
init_report();

// src/core/canvas.ts
init_tree();
init_typeRegistry();
var CARD_W = 230;
var CARD_H = 56;
var PAD = 18;
var HEADER = 36;
var GAP = 12;
var COL_GAP = 48;
var ZONE_COLOR = {
  goal: "5",
  prompt: "6",
  output: "4",
  temp: "",
  custom: "2"
};
function buildCanvas(tent, pathPrefix) {
  const nodes = [];
  let cursorX = 0;
  for (const zone of tent.roots) {
    const s = sizeOf(zone);
    layout(zone, cursorX, 0, nodes, pathPrefix, true);
    cursorX += s.w + COL_GAP;
  }
  return { nodes, edges: [] };
}
function sizeOf(box) {
  if (box.children.length === 0) return { w: CARD_W, h: CARD_H };
  let innerW = 0;
  let innerH = 0;
  const sizes = box.children.map(sizeOf);
  for (const s of sizes) {
    innerW = Math.max(innerW, s.w);
    innerH += s.h;
  }
  innerH += GAP * (box.children.length - 1);
  return { w: innerW + PAD * 2, h: innerH + HEADER + PAD };
}
function layout(box, x, y, out, prefix, isZone) {
  const s = sizeOf(box);
  if (box.children.length === 0) {
    out.push({
      id: nodeId(box),
      type: "file",
      x,
      y,
      width: CARD_W,
      height: CARD_H,
      file: filePath(box, prefix),
      color: colorFor(box, isZone)
    });
    return s;
  }
  out.push({
    id: nodeId(box),
    type: "group",
    x,
    y,
    width: s.w,
    height: s.h,
    label: labelFor(box, isZone),
    color: colorFor(box, isZone)
  });
  let cy = y + HEADER;
  for (const c of box.children) {
    const cs = layout(c, x + PAD, cy, out, prefix, false);
    cy += cs.h + GAP;
  }
  return s;
}
function nodeId(box) {
  return box.id || box.path.replace(/[^a-z0-9]/gi, "-");
}
function filePath(box, prefix) {
  const p = boxNotePath(box.path);
  return prefix ? `${prefix}/${p}` : p;
}
function labelFor(box, isZone) {
  const tag = isZone ? "" : ` \xB7 ${box.type}`;
  const owner = box.fm.owner ? ` \u2691${box.fm.owner}` : "";
  return `${box.name}${tag}${owner}`;
}
function colorFor(box, isZone) {
  if (isZone) return ZONE_COLOR[box.name] || void 0;
  const { base: base2, modifier } = splitType(box.type);
  if (base2 === "goal") return "5";
  if (base2 === "prompt") return "6";
  if (base2 === "output") return "4";
  if (modifier === "asset" || box.type === "asset") return "";
  return void 0;
}
function preservePositions(fresh, old, tent) {
  if (!old) return fresh;
  const oldById = new Map(old.nodes.map((n) => [n.id, n]));
  for (const zone of tent.roots) {
    const zid = zone.id || zone.path;
    const freshZone = fresh.nodes.find((n) => n.id === zid);
    const oldZone = oldById.get(zid);
    if (!freshZone || !oldZone) continue;
    const dx = oldZone.x - freshZone.x;
    const dy = oldZone.y - freshZone.y;
    if (dx === 0 && dy === 0) continue;
    const subtreeIds = collectIds(zone);
    for (const n of fresh.nodes) {
      if (subtreeIds.has(n.id)) {
        n.x += dx;
        n.y += dy;
      }
    }
  }
  return fresh;
}
function collectIds(box) {
  const ids = /* @__PURE__ */ new Set();
  const walk = (b) => {
    ids.add(b.id || b.path);
    for (const c of b.children) walk(c);
  };
  walk(box);
  return ids;
}
function canvasToJson(data) {
  return JSON.stringify(data, null, 2);
}
function parseCanvas(raw) {
  try {
    const d = JSON.parse(raw);
    if (Array.isArray(d.nodes)) return d;
  } catch {
  }
  return null;
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

// src/core/workspace.ts
var nodePath2 = __toESM(require("node:path"), 1);
var nodeFs2 = __toESM(require("node:fs/promises"), 1);
var import_node_child_process = require("node:child_process");
init_typeRegistry();
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
async function readWorkspaceHead(workspace) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const branch = await resolveTargetBranch(root);
  const ref = (await git(root, ["rev-parse", `refs/heads/${branch}`])).trim();
  const shortRef = (await git(root, ["rev-parse", "--short", ref])).trim();
  if (!ref || !shortRef) throw new Error("\u65E0\u6CD5\u8BFB\u53D6 workspace HEAD");
  return { ref, shortRef, branch };
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
    return { workspace: root, worktree: await nodeFs2.realpath(nodePath2.resolve(existing)), branch, targetBranch };
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
  return { workspace: root, worktree: await nodeFs2.realpath(worktree), branch, targetBranch };
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
  const results = [];
  for (const sourceRef of commits) {
    await git(root, ["cat-file", "-e", `${sourceRef}^{commit}`]);
    const prior = await findCherryPick(root, sourceRef);
    if (prior) {
      results.push({ sourceRef, integratedRef: prior, alreadyIntegrated: true });
      continue;
    }
    try {
      await git(root, ["cherry-pick", "-x", sourceRef]);
    } catch (error) {
      await git(root, ["cherry-pick", "--abort"]).catch(() => "");
      throw new Error(`workspace \u5408\u5165\u51B2\u7A81: ${error instanceof Error ? error.message : String(error)}`);
    }
    const integratedRef = (await git(root, ["rev-parse", "HEAD"])).trim();
    results.push({ sourceRef, integratedRef, alreadyIntegrated: false });
  }
  return results;
}
async function listRoleCommits(contract) {
  try {
    const output = await git(contract.workspace, [
      "log",
      `${contract.targetBranch}..${contract.branch}`,
      "--format=%H%x09%h%x09%s"
    ]);
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [ref = "", shortRef = "", ...subjectParts] = line.split("	");
      return { ref, shortRef, subject: subjectParts.join("	") };
    }).filter((item) => item.ref && item.shortRef);
  } catch {
    return [];
  }
}
async function listRoleCommitsFor(workspace, role) {
  try {
    const root = nodePath2.resolve(workspace);
    await assertGitWorkspace(root);
    const targetBranch = await resolveTargetBranch(root);
    const branch = `tent-role/${safeComponent(role)}`;
    const exists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (!exists) return [];
    return listRoleCommits({ workspace: root, worktree: "", branch, targetBranch });
  } catch {
    return [];
  }
}
async function assertGitWorkspace(root) {
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const [realTop, realRoot] = await Promise.all([
    nodeFs2.realpath(nodePath2.resolve(top)),
    nodeFs2.realpath(root)
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
async function pathExists(path) {
  try {
    await nodeFs2.access(path);
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
  return new Promise((resolve3, reject) => {
    const child = (0, import_node_child_process.spawn)("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => {
      if (code === 0) resolve3(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}

// src/plugin/ui-controls.ts
var import_obsidian2 = require("obsidian");
function createChevronSelect(parent, options) {
  const wrap = parent.createDiv({ cls: "tent-select-wrap" });
  const select = wrap.createEl("select", { cls: options.cls ?? "" });
  for (const item of options.options) {
    const opt = select.createEl("option", { text: item.label ?? item.value, value: item.value });
    if (item.selected) opt.selected = true;
  }
  const icon = wrap.createSpan({ cls: "tent-select-chevron" });
  (0, import_obsidian2.setIcon)(icon, "chevron-down");
  return select;
}
function drawRwSegment(parent, key, declared, onChange, allowInherit = true, readonly = false) {
  const segment = parent.createDiv({
    cls: "tent-status-segment tent-rw-seg" + (readonly ? " is-readonly" : "")
  });
  segment.createSpan({ cls: "tent-seg-key", text: key === "readable" ? "R" : "W" });
  const states = allowInherit ? [
    { label: "\u7EE7\u627F", value: void 0 },
    { label: "\u5F00", value: true },
    { label: "\u5173", value: false }
  ] : [
    { label: "\u5F00", value: true },
    { label: "\u5173", value: false }
  ];
  for (const state of states) {
    const option = segment.createDiv({
      cls: "tent-status-segment-option" + (declared === state.value ? " is-active" : ""),
      text: state.label
    });
    if (!readonly) option.onclick = () => onChange(state.value);
  }
}
function roleColorValue(role) {
  if (role.color) return typeColorValue(role.color);
  const normalized = role.name.toLowerCase();
  if (normalized.includes("planner")) return typeColorValue("purple");
  if (normalized.includes("executor")) return typeColorValue("cyan");
  if (normalized.includes("ui")) return typeColorValue("orange");
  const hash = [...role.name].reduce((total, character) => total + character.charCodeAt(0), 0);
  return typeColorValue(TYPE_COLORS[hash % TYPE_COLORS.length]);
}

// src/plugin/registry-pane.ts
var import_obsidian3 = require("obsidian");
init_skillRoleRegistry();

// src/core/typeManagement.ts
init_adapter();
init_tree();
init_frontmatter();
init_typeRegistry();
async function createType(fs, name, definition) {
  await withTentMutation(fs, async () => {
    assertTypeName(name);
    if (definition.tier !== "modifier" && (typeof definition.readable !== "boolean" || typeof definition.writable !== "boolean")) {
      throw new Error("base type \u5FC5\u987B\u6307\u5B9A readable \u548C writable");
    }
    const registry = await loadTypeRegistry(fs);
    if (registry[name]) throw new Error(`\u7C7B\u578B\u5DF2\u5B58\u5728: ${name}`);
    registry[name] = withDefaultColor(registry, definition);
    await writeTypeRegistryUnlocked(fs, registry);
  });
}
var createPrimaryType = createType;
async function updateTypeMetadata(fs, level, name, patch) {
  await withTentMutation(fs, async () => {
    void level;
    assertTypeName(name);
    const registry = await loadTypeRegistry(fs);
    const current = registry[name];
    if (!current) throw new Error(`\u7C7B\u578B\u4E0D\u5B58\u5728: ${name}`);
    if (patch.color !== void 0) {
      const color = patch.color.trim();
      if (color) current.color = color;
      else delete current.color;
    }
    if (patch.description !== void 0) {
      const description = patch.description.trim();
      if (description) current.description = description;
      else delete current.description;
    }
    updateAxis(current, "readable", patch.readable);
    updateAxis(current, "writable", patch.writable);
    await writeTypeRegistryUnlocked(fs, registry);
  });
}
async function inspectTypeDeletion(fs, level, name) {
  void level;
  const tent = await loadTent(fs);
  const registry = tent.typeRegistry;
  const boxes = [...tent.byId.values()];
  const referenced = boxes.filter((box) => {
    const { base: base2, modifier } = splitType(box.type);
    return box.type === name || base2 === name || modifier === name;
  });
  const ownerMap = /* @__PURE__ */ new Map();
  for (const reference of referenced) {
    for (const box of relatedBoxes(reference, boxes)) {
      if (!box.fm.owner) continue;
      ownerMap.set(box.id, { id: box.id, path: box.path, owner: box.fm.owner });
    }
  }
  return {
    level: "type",
    name,
    builtIn: name in DEFAULT_TYPE_REGISTRY,
    exists: name in registry,
    references: referenced.map(({ id, path, name: boxName }) => ({ id, path, name: boxName })),
    activeOwners: [...ownerMap.values()]
  };
}
async function deleteCustomType(fs, level, name, confirmation) {
  return withTentMutation(fs, async () => {
    if (confirmation !== name) throw new Error(`\u4E8C\u6B21\u786E\u8BA4\u4E0D\u5339\u914D;\u8BF7\u8F93\u5165\u7C7B\u578B\u540D ${name}`);
    const inspection = await inspectTypeDeletion(fs, level, name);
    if (!inspection.exists) throw new Error(`\u7C7B\u578B\u4E0D\u5B58\u5728: ${name}`);
    if (inspection.builtIn) throw new Error(`\u5185\u7F6E\u7C7B\u578B\u4E0D\u53EF\u5220\u9664: ${name}`);
    if (inspection.activeOwners.length > 0) {
      throw new Error(`\u5173\u8054\u8303\u56F4\u4ECD\u6709 owner,\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05: ${inspection.activeOwners.map((x) => x.path).join(", ")}`);
    }
    const registry = await loadTypeRegistry(fs);
    delete registry[name];
    await writeTypeRegistryUnlocked(fs, registry);
    return inspection;
  });
}
async function writeTypeRegistryUnlocked(fs, registry) {
  if (!await fs.exists(".tent")) await fs.mkdir(".tent");
  await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}
function assertTypeName(name) {
  if (!name.trim()) throw new Error("\u7C7B\u578B\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (name === "temp") throw new Error("temp \u662F\u7CFB\u7EDF\u7BA1\u9053,\u4E0D\u80FD\u4F5C\u4E3A type");
}
function updateAxis(definition, axis, value) {
  if (value === void 0) return;
  if (value === "inherit") {
    if (definition.tier !== "modifier") throw new Error("base type \u7684 R/W \u4E0D\u80FD\u7EE7\u627F");
    delete definition[axis];
    return;
  }
  definition[axis] = value;
}
function relatedBoxes(reference, boxes) {
  return boxes.filter(
    (box) => box.path === reference.path || box.path.startsWith(reference.path + "/") || reference.path.startsWith(box.path + "/")
  );
}
function withDefaultColor(registry, definition) {
  const color = definition.color?.trim();
  if (color) return { ...definition, color };
  const used = Object.keys(registry).length;
  return { ...definition, color: TYPE_COLOR_PALETTE[used % TYPE_COLOR_PALETTE.length] };
}

// src/plugin/registry-pane.ts
function createRegistryPaneState() {
  return {
    markedRoles: /* @__PURE__ */ new Set(),
    markedTypes: /* @__PURE__ */ new Set(),
    collapsed: { type: false, kind: false, roles: false },
    typeCollapsed: false,
    newFormOpen: null,
    openEditor: null
  };
}
function drawRegistryPane(host, context, state) {
  host.createDiv({ cls: "registry-title", text: "\u7C7B\u578B / \u89D2\u8272 \u6CE8\u518C\u8868" });
  const list = host.createDiv({ cls: "registry-list" });
  const entries = Object.entries(context.registry);
  const primary = entries.filter(([, definition]) => definition.tier !== "modifier");
  const secondary = entries.filter(([, definition]) => definition.tier === "modifier");
  drawVisibilityPanel(list, context, state, primary, secondary);
  const typeBlock = list.createDiv({ cls: "reg-block" });
  drawBlockHead(typeBlock, context, "\u7C7B\u578B", state.typeCollapsed, () => {
    state.typeCollapsed = !state.typeCollapsed;
  });
  if (!state.typeCollapsed) {
    drawTypeSection(typeBlock, context, state, "type", "base", "\u4E00\u7EA7", primary);
    drawTypeSection(typeBlock, context, state, "kind", "modifier", "\u4E8C\u7EA7", secondary);
  }
  const roleBlock = list.createDiv({ cls: "reg-block" });
  drawBlockHead(
    roleBlock,
    context,
    "\u89D2\u8272",
    state.collapsed.roles,
    () => {
      state.collapsed.roles = !state.collapsed.roles;
    },
    state,
    "roles"
  );
  if (state.collapsed.roles) return;
  const roleContent = roleBlock.createDiv({ cls: "group-content roles-list" });
  if (state.newFormOpen === "roles") drawNewRoleForm(roleContent, context, state);
  if (context.roles.length === 0) {
    roleContent.createDiv({ cls: "registry-empty", text: "\u6682\u65E0 roles" });
    return;
  }
  for (const role of context.roles) drawRoleRow(roleContent, context, state, role);
}
function drawVisibilityPanel(host, context, state, primary, secondary) {
  const panel = host.createDiv({ cls: "reg-visibility" });
  panel.createDiv({ cls: "reg-vis-title", text: "\u6811\u5185\u663E\u9690" });
  const drawChip = (parent, label, enabled, color, toggle) => {
    const chip = parent.createSpan({
      cls: "tent-mark-chip" + (enabled ? " is-on" : ""),
      text: label
    });
    chip.style.setProperty("--mark-color", color);
    chip.onclick = () => {
      toggle();
      context.redraw();
    };
  };
  const drawRow = (label, build) => {
    const row = panel.createDiv({ cls: "reg-vis-row" });
    row.createSpan({ cls: "reg-vis-label", text: label });
    build(row.createDiv({ cls: "reg-vis-chips" }));
  };
  const drawTypeChips = (chips, definitions) => {
    if (definitions.length === 0) {
      chips.createSpan({ cls: "reg-vis-empty", text: "\u2014" });
      return;
    }
    for (const [name, definition] of definitions) {
      drawChip(
        chips,
        name,
        state.markedTypes.has(name),
        typeColorValue(definition.color),
        () => toggleSetValue(state.markedTypes, name)
      );
    }
  };
  drawRow("\u4E00\u7EA7", (chips) => drawTypeChips(chips, primary));
  drawRow("\u4E8C\u7EA7", (chips) => drawTypeChips(chips, secondary));
  drawRow("\u89D2\u8272", (chips) => {
    if (context.roles.length === 0) {
      chips.createSpan({ cls: "reg-vis-empty", text: "\u2014" });
      return;
    }
    for (const role of context.roles) {
      drawChip(
        chips,
        role.name,
        state.markedRoles.has(role.name),
        roleColorValue(role),
        () => toggleSetValue(state.markedRoles, role.name)
      );
    }
  });
}
function drawBlockHead(block, context, title, collapsed, toggle, state, addKey) {
  const head = block.createDiv({ cls: "reg-block-head" });
  const chevron = head.createSpan({ cls: "reg-chev" });
  (0, import_obsidian3.setIcon)(chevron, collapsed ? "chevron-right" : "chevron-down");
  head.createSpan({ cls: "reg-block-title", text: title });
  head.createSpan({ cls: "reg-head-rule" });
  if (state && addKey) drawAddButton(head, context, state, addKey);
  head.onclick = () => {
    toggle();
    context.redraw();
  };
}
function drawTypeSection(block, context, state, key, tier, label, entries) {
  const section = block.createDiv({ cls: "reg-sub" });
  const collapsed = state.collapsed[key];
  const head = section.createDiv({ cls: "reg-sub-head" });
  const chevron = head.createSpan({ cls: "reg-chev reg-chev-sm" });
  (0, import_obsidian3.setIcon)(chevron, collapsed ? "chevron-right" : "chevron-down");
  head.createSpan({ cls: "reg-sub-label", text: label });
  drawAddButton(head, context, state, key);
  head.onclick = () => {
    state.collapsed[key] = !state.collapsed[key];
    context.redraw();
  };
  if (collapsed) return;
  const content = section.createDiv({ cls: "group-content" });
  if (state.newFormOpen === key) drawNewTypeForm(content, context, state, tier);
  if (entries.length === 0) {
    content.createDiv({
      cls: "registry-empty",
      text: tier === "modifier" ? "\u6682\u65E0\u4E8C\u7EA7" : "\u6682\u65E0\u4E00\u7EA7"
    });
    return;
  }
  for (const [name, definition] of entries) {
    drawTypeRow(content, context, state, key, name, definition);
  }
}
function drawAddButton(head, context, state, key) {
  const add = head.createEl("button", {
    cls: "registry-add-btn" + (state.newFormOpen === key ? " is-open" : "")
  });
  add.setAttr("type", "button");
  (0, import_obsidian3.setIcon)(add.createSpan({ cls: "rab-ico" }), "plus");
  add.setAttr("aria-label", "\u65B0\u5EFA");
  addTooltip(add, "\u65B0\u5EFA");
  add.onclick = (event) => {
    event.stopPropagation();
    state.newFormOpen = state.newFormOpen === key ? null : key;
    if (state.newFormOpen === key) {
      state.collapsed[key] = false;
      if (key === "type" || key === "kind") state.typeCollapsed = false;
    }
    context.redraw();
  };
}
function drawTypeRow(content, context, state, section, name, definition) {
  const editKey = `${section}:${name}`;
  const open2 = state.openEditor === editKey;
  const wrapper = content.createDiv({
    cls: "registry-item-wrapper" + (open2 ? " drawer-open" : "")
  });
  const row = wrapper.createDiv({ cls: "reg-card" });
  row.style.setProperty("--accent-color", typeColorValue(definition.color));
  row.createSpan({ cls: "item-name", text: name });
  row.createSpan({ cls: "reg-desc", text: definition.description || "" });
  const rightArea = row.createDiv({ cls: "row-right-area" });
  drawRwCapsule(
    rightArea.createDiv({ cls: "item-indicators" }),
    definition.readable,
    definition.writable
  );
  const actions = rightArea.createDiv({ cls: "row-actions" });
  const edit = actions.createEl("button", {
    cls: "registry-edit-btn" + (open2 ? " active" : "")
  });
  edit.setAttr("type", "button");
  (0, import_obsidian3.setIcon)(edit, "settings");
  addTooltip(edit, "\u7F16\u8F91\u989C\u8272 / \u8BFB\u5199");
  edit.onclick = (event) => {
    event.stopPropagation();
    state.openEditor = open2 ? null : editKey;
    context.redraw();
  };
  const deleteKey = `type:${section}:${name}`;
  const deletePending = context.getPendingDelete() === deleteKey;
  const remove = actions.createEl("button", {
    cls: "registry-del-btn" + (deletePending ? " is-confirm" : "")
  });
  remove.setAttr("type", "button");
  if (deletePending) remove.setText("\u786E\u8BA4\u5220\u9664");
  else (0, import_obsidian3.setIcon)(remove, "trash-2");
  addTooltip(remove, deletePending ? "\u518D\u6B21\u70B9\u51FB\u786E\u8BA4\u5220\u9664" : "\u5220\u9664");
  remove.onclick = async (event) => {
    event.stopPropagation();
    const inspection = await inspectTypeDeletion(context.fs, "type", name);
    if (inspection.builtIn) {
      new import_obsidian3.Notice(`\u5185\u7F6E\u7C7B\u578B\u300C${name}\u300D\u4E0D\u53EF\u5220\u9664`);
      return;
    }
    if (inspection.activeOwners.length > 0) {
      new import_obsidian3.Notice(
        `\u5173\u8054\u8303\u56F4\u4ECD\u6709 owner,\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05:${inspection.activeOwners.map((item) => item.path).join(", ")}`
      );
      return;
    }
    if (context.getPendingDelete() === deleteKey) {
      await deleteCustomType(context.fs, "type", name, name);
      await context.refresh();
      return;
    }
    context.setPendingDelete(deleteKey);
    context.redraw();
  };
  if (open2) drawTypeEditDrawer(wrapper, context, name, definition);
}
function drawRwCapsule(host, readable, writable) {
  const capsule = host.createSpan({ cls: "rw-cap" });
  const label = (state) => state === void 0 ? "\u7EE7\u627F" : state ? "\u5F00" : "\u5173";
  addTooltip(capsule, `readable:${label(readable)} \xB7 writable:${label(writable)}`);
  const drawPart = (key, value) => {
    const className = value === void 0 ? "is-inherit" : value ? "is-on" : "is-off";
    const symbol = value === void 0 ? "\u2014" : value ? "\u221A" : "\u2715";
    const part = capsule.createSpan({ cls: `rw-part ${className}` });
    part.createSpan({ cls: "rw-k", text: key });
    part.createSpan({ cls: "rw-s", text: symbol });
  };
  drawPart("R", readable);
  capsule.createSpan({ cls: "rw-dot", text: "\xB7" });
  drawPart("W", writable);
}
function drawPalette(host, selected, onSelect) {
  const palette = host.createDiv({ cls: "tent-color-palette" });
  for (const color of TYPE_COLORS) {
    const swatch = palette.createEl("button", {
      cls: "tent-color-swatch" + (color === selected ? " is-selected" : "")
    });
    swatch.setAttr("type", "button");
    addTooltip(swatch, color);
    swatch.style.setProperty("--tent-swatch-color", typeColorValue(color));
    swatch.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      palette.findAll(".tent-color-swatch").forEach((element) => {
        element.removeClass("is-selected");
      });
      swatch.addClass("is-selected");
      void onSelect(color);
    };
  }
  return palette;
}
function drawLabelRow(host, label, extraClass = "") {
  const normalized = label === "\u540D\u5B57" ? "name" : label === "\u989C\u8272" ? "color" : label === "\u63CF\u8FF0" ? "description" : label === "R/W" ? "r-w" : label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const row = host.createDiv({
    cls: `tent-newform-row tent-newform-row-${normalized}${extraClass ? ` ${extraClass}` : ""}`
  });
  row.createSpan({ cls: "tent-newform-label", text: label });
  return row;
}
function autoGrowTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}
function drawTypeEditDrawer(wrapper, context, name, definition) {
  const drawer = wrapper.createDiv({
    cls: "registry-item-edit-drawer type-drawer"
  });
  const isModifier = definition.tier === "modifier";
  drawPalette(drawLabelRow(drawer, "\u989C\u8272"), definition.color || "", async (color) => {
    await updateTypeMetadata(context.fs, "type", name, { color });
    await context.refresh();
  });
  const rw = drawLabelRow(drawer, "R/W").createDiv({ cls: "tent-drawer-rw" });
  drawRwSegment(rw, "readable", definition.readable, async (value) => {
    await updateTypeMetadata(context.fs, "type", name, {
      readable: isModifier ? value ?? "inherit" : value ?? false
    });
    await context.refresh();
  }, isModifier);
  drawRwSegment(rw, "writable", definition.writable, async (value) => {
    await updateTypeMetadata(context.fs, "type", name, {
      writable: isModifier ? value ?? "inherit" : value ?? false
    });
    await context.refresh();
  }, isModifier);
  const description = drawLabelRow(drawer, "\u63CF\u8FF0").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" }
  });
  description.value = definition.description || "";
  description.oninput = () => autoGrowTextarea(description);
  description.onblur = async () => {
    const value = description.value.trim();
    if (value === (definition.description || "")) return;
    await updateTypeMetadata(context.fs, "type", name, { description: value });
    await context.refresh();
  };
  window.setTimeout(() => autoGrowTextarea(description), 0);
}
function drawNewTypeForm(section, context, state, tier) {
  const card = section.createDiv({ cls: "tent-newform" });
  const form = {
    name: "",
    description: "",
    readable: tier === "modifier" ? void 0 : true,
    writable: tier === "modifier" ? void 0 : false,
    color: "gray"
  };
  const isModifier = tier === "modifier";
  const name = drawLabelRow(card, "\u540D\u5B57").createEl("input", {
    cls: "tent-newform-input",
    attr: { type: "text" }
  });
  name.oninput = () => {
    form.name = name.value.trim();
  };
  window.setTimeout(() => name.focus(), 0);
  drawPalette(drawLabelRow(card, "\u989C\u8272"), form.color, (color) => {
    form.color = color;
  });
  const rw = drawLabelRow(card, "R/W").createDiv({ cls: "tent-drawer-rw" });
  drawRwSegment(rw, "readable", form.readable, (value) => {
    form.readable = value;
  }, isModifier);
  drawRwSegment(rw, "writable", form.writable, (value) => {
    form.writable = value;
  }, isModifier);
  const description = drawLabelRow(card, "\u63CF\u8FF0").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" }
  });
  description.oninput = () => {
    form.description = description.value.trim();
    autoGrowTextarea(description);
  };
  drawFormActions(card, context, state, async () => {
    if (!form.name || form.name === "temp") {
      new import_obsidian3.Notice("\u8BF7\u586B\u5199\u6709\u6548\u7684 type \u540D");
      return;
    }
    if (context.registry[form.name]) {
      new import_obsidian3.Notice(`\u7C7B\u578B\u300C${form.name}\u300D\u5DF2\u5B58\u5728`);
      return;
    }
    const definition = isModifier ? {
      tier: "modifier",
      ...form.readable !== void 0 ? { readable: form.readable } : {},
      ...form.writable !== void 0 ? { writable: form.writable } : {}
    } : {
      tier: "base",
      readable: form.readable,
      writable: form.writable
    };
    if (form.color) definition.color = form.color;
    if (form.description) definition.description = form.description;
    await createPrimaryType(context.fs, form.name, definition);
    state.newFormOpen = null;
    await context.refresh();
  });
}
function drawNewRoleForm(section, context, state) {
  const card = section.createDiv({ cls: "tent-newform" });
  const form = { name: "", description: "", prompt: "", color: "purple" };
  const name = drawLabelRow(card, "\u540D\u5B57").createEl("input", {
    cls: "tent-newform-input",
    attr: { type: "text" }
  });
  name.oninput = () => {
    form.name = name.value.trim();
  };
  window.setTimeout(() => name.focus(), 0);
  drawPalette(drawLabelRow(card, "\u989C\u8272"), form.color, (color) => {
    form.color = color;
  });
  const description = drawLabelRow(card, "\u63CF\u8FF0").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" }
  });
  description.oninput = () => {
    form.description = description.value.trim();
    autoGrowTextarea(description);
  };
  const prompt = drawLabelRow(card, "prompt", "tent-newform-textarea-row").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-prompt-textarea",
    attr: { rows: "2" }
  });
  prompt.oninput = () => {
    form.prompt = prompt.value.trim();
    autoGrowTextarea(prompt);
  };
  drawFormActions(card, context, state, async () => {
    if (!form.name) {
      new import_obsidian3.Notice("\u8BF7\u586B\u5199 role \u540D");
      return;
    }
    const definition = { name: form.name };
    if (form.description) definition.description = form.description;
    if (form.prompt) definition.prompt = form.prompt;
    if (form.color) definition.color = form.color;
    await createRole(context.fs, definition);
    state.newFormOpen = null;
    await context.refresh();
  });
}
function drawFormActions(card, context, state, submit) {
  const actions = card.createDiv({ cls: "tent-newform-acts" });
  const create = actions.createEl("button", { cls: "mod-cta", text: "\u65B0\u5EFA" });
  create.setAttr("type", "button");
  create.onclick = async (event) => {
    event.preventDefault();
    try {
      await submit();
    } catch (error) {
      new import_obsidian3.Notice("\u65B0\u5EFA\u5931\u8D25:" + (error instanceof Error ? error.message : error));
    }
  };
  const cancel = actions.createEl("button", { text: "\u53D6\u6D88" });
  cancel.setAttr("type", "button");
  cancel.onclick = (event) => {
    event.preventDefault();
    state.newFormOpen = null;
    context.redraw();
  };
}
function drawRoleRow(content, context, state, role) {
  const editKey = `role:${role.name}`;
  const open2 = state.openEditor === editKey;
  const wrapper = content.createDiv({
    cls: "registry-item-wrapper" + (open2 ? " drawer-open" : "")
  });
  const row = wrapper.createDiv({ cls: "reg-card role-row" });
  row.style.setProperty("--accent-color", roleColorValue(role));
  row.createSpan({ cls: "item-name", text: role.name });
  row.createSpan({ cls: "reg-desc", text: role.description || "" });
  const actions = row.createDiv({ cls: "row-right-area role-right" }).createDiv({ cls: "row-actions" });
  const edit = actions.createEl("button", {
    cls: "registry-edit-btn" + (open2 ? " active" : "")
  });
  edit.setAttr("type", "button");
  (0, import_obsidian3.setIcon)(edit, "settings");
  addTooltip(edit, "\u7F16\u8F91\u63CF\u8FF0 / prompt / \u989C\u8272");
  edit.onclick = (event) => {
    event.stopPropagation();
    state.openEditor = open2 ? null : editKey;
    context.redraw();
  };
  const deleteKey = `role:${role.name}`;
  const deletePending = context.getPendingDelete() === deleteKey;
  const remove = actions.createEl("button", {
    cls: "registry-del-btn" + (deletePending ? " is-confirm" : "")
  });
  remove.setAttr("type", "button");
  if (deletePending) remove.setText("\u786E\u8BA4\u5220\u9664");
  else (0, import_obsidian3.setIcon)(remove, "trash-2");
  addTooltip(remove, deletePending ? "\u518D\u6B21\u70B9\u51FB\u786E\u8BA4\u5220\u9664" : "\u5220\u9664");
  remove.onclick = async (event) => {
    event.stopPropagation();
    if (context.getPendingDelete() === deleteKey) {
      await deleteRole(context.fs, role.name, role.name);
      await context.refresh();
      return;
    }
    context.setPendingDelete(deleteKey);
    context.redraw();
  };
  if (open2) drawRoleEditDrawer(wrapper, context, role);
}
function drawRoleEditDrawer(wrapper, context, role) {
  const drawer = wrapper.createDiv({
    cls: "registry-item-edit-drawer role-drawer"
  });
  drawPalette(drawLabelRow(drawer, "\u989C\u8272"), role.color || "", async (color) => {
    await updateRole(context.fs, role.name, { color });
    await context.refresh();
  });
  const description = drawLabelRow(drawer, "\u63CF\u8FF0").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-desc-textarea",
    attr: { rows: "1" }
  });
  description.value = role.description || "";
  description.oninput = () => autoGrowTextarea(description);
  description.onblur = async () => {
    const value = description.value.trim();
    if (value === (role.description || "")) return;
    await updateRole(context.fs, role.name, { description: value });
    await context.refresh();
  };
  window.setTimeout(() => autoGrowTextarea(description), 0);
  const prompt = drawLabelRow(drawer, "prompt", "tent-newform-textarea-row").createEl("textarea", {
    cls: "tent-newform-input tent-newform-textarea tent-newform-prompt-textarea",
    attr: { rows: "2" }
  });
  prompt.value = role.prompt || "";
  prompt.oninput = () => autoGrowTextarea(prompt);
  prompt.onblur = async () => {
    const value = prompt.value.trim();
    if (value === (role.prompt || "")) return;
    await updateRole(context.fs, role.name, { prompt: value });
    await context.refresh();
  };
  window.setTimeout(() => autoGrowTextarea(prompt), 0);
}
function toggleSetValue(values, value) {
  if (values.has(value)) values.delete(value);
  else values.add(value);
}
function addTooltip(element, text) {
  element.removeAttribute("title");
  if (!text) return;
  (0, import_obsidian3.setTooltip)(element, text, {
    placement: "top",
    delay: 150
  });
}

// src/plugin/view.ts
init_ops();
var TENT_VIEW_TYPE = "tent-structure-editor";
var STATUSES = ["todo", "doing", "done"];
var MIN_TREE_COLUMN = 250;
var MIN_PROPERTY_COLUMN = 320;
var COLUMN_DIVIDER = 6;
var GIT_UI_CACHE_TTL_MS = 6e3;
var TentView = class extends import_obsidian4.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tentName = "";
    this.selectedId = null;
    this.tent = null;
    this.proposals = [];
    this.handoffs = [];
    this.reports = [];
    this.inbox = [];
    this.draggedPath = null;
    this.collapsed = /* @__PURE__ */ new Set();
    this.selectedSystem = null;
    this.bottomTab = "note";
    // 左树热切换:全部 / 只看有待处理(proposal 或 owner)的框
    this.treeFilter = "all";
    this.registryUi = createRegistryPaneState();
    this.colRatio = 0.58;
    this.tentsCache = [];
    this.rightPane = "property";
    this.newBoxParentPath = null;
    // tags 行的内联挑选区是否展开
    this.tagPickerOpen = false;
    // 属性面板:二级编辑区是否展开(一级=note+摘要;二级=可编辑控件)
    this.propEditExpanded = false;
    // 哪个条目正展开内联删除二次确认(就地,不弹居中浮层);key 唯一标识那条
    this.pendingDelete = null;
    this.roles = [];
    this.registryTags = [];
    // 每个 box 的待裁数(open proposal 按 target 聚合),树行角标用
    this.pendingByTarget = /* @__PURE__ */ new Map();
    this.loadError = null;
    this.refreshTimer = null;
    this.ignoredVaultChanges = /* @__PURE__ */ new Map();
    this.recentCreates = /* @__PURE__ */ new Set();
    this.columnResizeObserver = null;
    this.workspaceHeadCache = /* @__PURE__ */ new Map();
    this.roleCommitsCache = /* @__PURE__ */ new Map();
  }
  getViewType() {
    return TENT_VIEW_TYPE;
  }
  getDisplayText() {
    return "\u5E37\u5E44 \xB7 Tent";
  }
  getIcon() {
    return "tent";
  }
  async onOpen() {
    this.tentName = this.plugin.settings.activeTent || await this.firstTent() || "";
    this.register(() => this.columnResizeObserver?.disconnect());
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => {
      this.recentCreates.add(f.path);
      this.onVaultChange(f.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f.path)));
    this.registerEvent(this.app.vault.on("rename", (f) => this.onVaultChange(f.path)));
    await this.refresh();
  }
  // 外部文件变动 → 刷新面板,但避开"正在面板里打字"与非本帐变动。
  onVaultChange(path) {
    if (!this.tentName) return;
    const root = this.tentRootPath();
    if (path !== root && !path.startsWith(root + "/")) return;
    const ignoreUntil = this.ignoredVaultChanges.get(path);
    if (ignoreUntil !== void 0) {
      this.ignoredVaultChanges.delete(path);
      if (ignoreUntil >= Date.now()) return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.contentEl.contains(active) && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      return;
    }
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 300);
  }
  // ---- 数据 ----
  get tentsRoot() {
    return this.plugin.settings.tentsRoot;
  }
  tentRootPath() {
    return (0, import_obsidian4.normalizePath)(`${this.tentsRoot}/${this.tentName}`);
  }
  env() {
    return {
      fs: new ObsidianFs(this.app, this.tentRootPath()),
      clock: new SystemClock(),
      tentName: this.tentName,
      rand: Math.random
    };
  }
  async listTents() {
    const a = this.app.vault.adapter;
    if (!await a.exists(this.tentsRoot)) return [];
    const listing = await a.list(this.tentsRoot);
    return listing.folders.map((f) => f.slice(f.lastIndexOf("/") + 1));
  }
  async firstTent() {
    const ts = await this.listTents();
    return ts[0] ?? null;
  }
  async refresh() {
    this.tentsCache = await this.listTents();
    if (this.tentName) {
      try {
        const fs = this.env().fs;
        await this.adoptNativeCopies(fs);
        this.tent = await loadTent(fs);
        this.proposals = await loadProposals(fs);
        this.handoffs = await loadHandoffs(fs);
        this.reports = await loadReports(fs);
        this.inbox = await buildInbox(fs, this.tent, this.proposals);
        this.roles = (await loadRolesRegistry(fs)).roles;
        this.registryTags = (await loadTagRegistry(fs)).tags;
        this.loadError = null;
      } catch (e) {
        this.tent = null;
        this.proposals = [];
        this.handoffs = [];
        this.reports = [];
        this.inbox = [];
        this.roles = [];
        this.registryTags = [];
        this.loadError = e instanceof Error ? e.message : String(e);
      }
    }
    this.plugin.updateStatus(
      pendingCount(this.inbox) + this.reports.filter((report) => report.status === "ready").length
    );
    this.draw();
  }
  async adoptNativeCopies(fs) {
    if (this.recentCreates.size === 0) return;
    const root = this.tentRootPath();
    const candidates = [...this.recentCreates].map((path) => path.startsWith(root + "/") ? path.slice(root.length + 1) : "").filter(Boolean).map((path) => path.endsWith(".md") ? path.slice(0, path.lastIndexOf("/")) : path);
    this.recentCreates.clear();
    if (candidates.length === 0) return;
    const roots = [...new Set(candidates)].sort((a, b) => a.length - b.length).filter((path, index, all) => !all.slice(0, index).some((parent) => path.startsWith(parent + "/")));
    for (const path of roots) {
      try {
        await adoptCopiedSubtree(this.env(), path);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("\u627E\u4E0D\u5230\u590D\u5236\u6846")) throw error;
      }
    }
  }
  async patchBoxIncremental(box, patch) {
    if (!this.tent) return;
    const notePath = (0, import_obsidian4.normalizePath)(`${this.tentRootPath()}/${boxNotePath(box.path)}`);
    this.ignoredVaultChanges.set(notePath, Date.now() + 2e3);
    try {
      await patchBox(this.env(), box.path, patch, this.tent);
      await reloadLoadedBox(this.env().fs, this.tent, box.path);
      this.draw();
    } catch (error) {
      this.ignoredVaultChanges.delete(notePath);
      throw error;
    }
  }
  async patchBodyIncremental(box, body) {
    if (!this.tent) return;
    const notePath = (0, import_obsidian4.normalizePath)(`${this.tentRootPath()}/${boxNotePath(box.path)}`);
    this.ignoredVaultChanges.set(notePath, Date.now() + 2e3);
    try {
      await patchBody(this.env(), box.path, body, this.tent);
      await reloadLoadedBox(this.env().fs, this.tent, box.path);
      this.draw();
    } catch (error) {
      this.ignoredVaultChanges.delete(notePath);
      throw error;
    }
  }
  // ---- 绘制 ----
  draw() {
    const root = this.contentEl;
    root.empty();
    root.addClass("tent-view");
    root.onclick = (event) => {
      if (!this.pendingDelete) return;
      const target = event.target;
      if (target?.closest(".is-confirm, .is-confirm-del")) return;
      this.pendingDelete = null;
      this.draw();
    };
    this.applyAppearance(root);
    const header = root.createDiv({ cls: "tent-header" });
    this.drawTopbar(header);
    if (!this.tentName) {
      root.createDiv({ cls: "tent-empty", text: "\u8FD8\u6CA1\u6709\u5E10\u3002\u5728\u8BBE\u7F6E\u91CC\u914D\u597D\u5E10\u6839\u76EE\u5F55,\u5E76\u5728\u5176\u4E0B\u5EFA\u4E00\u4E2A\u5E10\u6587\u4EF6\u5939\u3002" });
      return;
    }
    if (!this.tent) {
      const detail = this.loadError ? `:${this.loadError}` : `\u3002\u68C0\u67E5\u5B83\u662F\u5426\u5728 ${this.tentsRoot}/ \u4E0B\u3002`;
      root.createDiv({ cls: "tent-empty", text: `\u65E0\u6CD5\u8BFB\u53D6\u5E10\u300C${this.tentName}\u300D${detail}` });
      return;
    }
    const cols = root.createDiv({ cls: "tent-cols" });
    const tree = cols.createDiv({ cls: "tent-tree" });
    const divider = cols.createDiv({ cls: "tent-divider" });
    const prop = cols.createDiv({ cls: "tent-prop" });
    this.applyColumnRatio(cols, this.colRatio);
    this.columnResizeObserver?.disconnect();
    this.columnResizeObserver = new ResizeObserver(() => this.applyColumnRatio(cols, this.colRatio));
    this.columnResizeObserver.observe(cols);
    this.wireDivider(cols, divider);
    this.drawTree(tree);
    if (this.rightPane === "registry") {
      drawRegistryPane(prop, {
        fs: this.env().fs,
        registry: this.tent.typeRegistry,
        roles: this.roles,
        redraw: () => this.draw(),
        refresh: () => this.refresh(),
        getPendingDelete: () => this.pendingDelete,
        setPendingDelete: (value) => {
          this.pendingDelete = value;
        }
      }, this.registryUi);
    } else this.drawProperty(prop);
  }
  wireDivider(cols, divider) {
    divider.onmousedown = (e) => {
      e.preventDefault();
      const rect = cols.getBoundingClientRect();
      const style = getComputedStyle(cols);
      const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const available = Math.max(0, rect.width - horizontalPadding - COLUMN_DIVIDER);
      const onMove = (ev) => {
        const rawTreeWidth = ev.clientX - rect.left - parseFloat(style.paddingLeft);
        this.applyColumnRatio(cols, available > 0 ? rawTreeWidth / available : this.colRatio);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
  }
  applyColumnRatio(cols, desiredRatio) {
    if (getComputedStyle(cols).display !== "grid") return;
    const style = getComputedStyle(cols);
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const available = cols.clientWidth - horizontalPadding - COLUMN_DIVIDER;
    if (available <= 0) return;
    const minRatio = MIN_TREE_COLUMN / available;
    const maxRatio = (available - MIN_PROPERTY_COLUMN) / available;
    if (maxRatio < minRatio) return;
    const ratio = Math.max(minRatio, Math.min(maxRatio, desiredRatio));
    this.colRatio = ratio;
    cols.style.gridTemplateColumns = `${ratio}fr ${COLUMN_DIVIDER}px ${1 - ratio}fr`;
  }
  drawTopbar(host) {
    const bar = host.createDiv({ cls: "tent-topbar" });
    const left = bar.createDiv({ cls: "tent-topbar-left" });
    this.drawAccountSelect(left);
    if (this.tent) this.drawToolbarInline(bar);
    const right = bar.createDiv({ cls: "tent-topbar-right" });
    const typesBtn = right.createEl("button", { cls: "tent-types-btn" });
    typesBtn.setAttr("type", "button");
    (0, import_obsidian4.setIcon)(typesBtn, "settings");
    tentTooltip(typesBtn, "\u7C7B\u578B\u7BA1\u7406");
    typesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.rightPane = this.rightPane === "registry" ? "property" : "registry";
      this.draw();
    });
    const themeBtn = right.createEl("button", { cls: "tent-theme-btn" });
    themeBtn.setAttr("type", "button");
    const appearance = this.plugin.settings.appearance;
    (0, import_obsidian4.setIcon)(themeBtn, appearance === "follow" ? "monitor" : appearance === "dark" ? "moon" : "sun");
    tentTooltip(themeBtn, appearance === "follow" ? "\u8DDF\u968F Obsidian" : appearance === "dark" ? "\u6DF1\u8272" : "\u6D45\u8272");
    themeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.plugin.settings.appearance = appearance === "follow" ? "light" : appearance === "light" ? "dark" : "follow";
      await this.plugin.saveSettings();
      this.draw();
    });
  }
  refreshAppearance() {
    this.draw();
  }
  applyAppearance(root) {
    root.removeClass("tent-theme-follow");
    root.removeClass("tent-theme-light");
    root.removeClass("tent-theme-dark");
    root.removeClass("theme-light");
    root.removeClass("theme-dark");
    root.removeClass("theme-claude");
    const mode = this.plugin.settings.appearance;
    if (mode === "follow") {
      root.addClass("tent-theme-follow");
      return;
    }
    root.addClass(`tent-theme-${mode}`);
  }
  // 帐选择器:挪到左栏「帐结构」标题位。空帐态也复用它,保证还能切/建帐。
  drawAccountSelect(parent) {
    const control = parent.createDiv({ cls: "tent-account-control" });
    const select = control.createEl("select", { cls: "tent-select dropdown tent-account-select" });
    const icon = control.createSpan({ cls: "tent-account-chevron" });
    (0, import_obsidian4.setIcon)(icon, "chevron-down");
    if (this.tentsCache.length === 0) {
      select.createEl("option", { text: "(\u65E0\u5E10)", value: "" });
    }
    for (const t of this.tentsCache) {
      const opt = select.createEl("option", { text: t, value: t });
      if (t === this.tentName) opt.selected = true;
    }
    select.createEl("option", { text: "\uFF0B \u65B0\u5EFA\u5E10", value: "__genesis__" });
    select.onchange = async () => {
      if (select.value === "__genesis__") {
        await this.copyGenesisPrompt();
        select.value = this.tentName;
        return;
      }
      this.tentName = select.value;
      this.plugin.settings.activeTent = this.tentName;
      await this.plugin.saveSettings();
      this.selectedId = null;
      this.selectedSystem = null;
      this.tagPickerOpen = false;
      this.registryUi.newFormOpen = null;
      this.newBoxParentPath = null;
      this.pendingDelete = null;
      await this.refresh();
    };
  }
  async copyGenesisPrompt() {
    const prompt = "\u8BF7\u4F7F\u7528 tent-genesis \u5E2E\u6211\u521B\u5EFA\u4E00\u9876\u65B0\u7684 Tent / \u5E37\u5E44\u5E10\u3002\u5148 grill \u6211:\u5E10\u540D\u3001\u76EE\u6807\u3001workspace \u6307\u9488\u3001\u9996\u6279\u9876\u5C42\u6846\u3001\u9996\u6279 role(name + prompt),\u7136\u540E scaffold \u5E10\u5E76\u521D\u59CB\u5316\u771F\u5B9E workspace\u3002Tent \u672C\u8EAB\u4E0D\u4F7F\u7528 Git\u3002";
    await navigator.clipboard.writeText(prompt);
    new import_obsidian4.Notice("\u5DF2\u590D\u5236 tent-genesis \u8D77\u624B prompt");
  }
  // ---- 树 ----
  drawTree(el) {
    this.pendingByTarget = countByTarget(this.proposals);
    const rows = el.createDiv({ cls: "tent-rows" });
    if (this.treeFilter === "pending") rows.addClass("is-pending-filter");
    for (const r of this.tent.roots) {
      this.drawNode(rows, r, 0);
    }
    if (this.treeFilter !== "pending") {
      if (this.newBoxParentPath === "") {
        this.drawInlineNewBoxForm(rows, "");
      } else {
        const addRow = rows.createDiv({ cls: "tent-add-top" });
        (0, import_obsidian4.setIcon)(addRow.createSpan({ cls: "tent-add-top-ico" }), "plus");
        addRow.createSpan({ cls: "tent-add-top-label", text: "\u65B0\u5EFA\u9876\u5C42\u6846" });
        addRow.onclick = () => this.openNewBoxForm("");
      }
      this.drawTempSystem(rows);
    } else if (!rows.hasChildNodes()) {
      rows.createDiv({ cls: "tent-prop-empty", text: "\u6CA1\u6709\u5F85\u5904\u7406\u7684\u6846" });
    }
    this.wireDragDelegation(rows);
  }
  // 顶部工具条(内联在 header 浮卡):全部 / 待处理 过滤 + role/一级type/二级type(modifier) 常驻标记
  drawToolbarInline(host) {
    if (!this.tent) return;
    const bar = host.createDiv({ cls: "tent-toolbar" });
    const seg = bar.createDiv({ cls: "tent-tree-filter" });
    const mk = (key, label) => {
      const o = seg.createDiv({
        cls: "tent-tree-filter-opt" + (this.treeFilter === key ? " is-active" : ""),
        text: label
      });
      o.onclick = () => {
        this.treeFilter = key;
        this.draw();
      };
    };
    mk("all", "\u5168\u90E8");
    mk("pending", "\u5F85\u5904\u7406");
  }
  boxHasPending(box) {
    return (this.pendingByTarget.get(box.id) ?? 0) > 0 || !!box.fm.owner;
  }
  subtreeHasPending(box) {
    if (this.boxHasPending(box)) return true;
    return box.children.some((c) => this.subtreeHasPending(c));
  }
  // 拖拽事件委托到行容器:根除子元素反复触发 dragover/dragleave 的闪烁。
  // 落点三段:上缘=插到前面(同级换序)/ 中段=成为子框(换爹)/ 下缘=插到后面。
  wireDragDelegation(rows) {
    const ZONE_CLS = ["tent-drop-before", "tent-drop-inside", "tent-drop-after"];
    const clearHover = () => {
      for (const cls of ZONE_CLS) rows.findAll("." + cls).forEach((r) => r.removeClass(cls));
      rows.removeClass("tent-drop-root");
    };
    const intentFor = (row, clientY) => {
      const dragged = this.draggedPath;
      if (dragged === null || !this.tent) return null;
      const invalid = (parentPath) => parentPath === dragged || parentPath.startsWith(dragged + "/");
      if (row && row.dataset.path !== void 0) {
        const box = this.tent.byPath.get(row.dataset.path);
        if (!box) return null;
        const rect = row.getBoundingClientRect();
        const rel = (clientY - rect.top) / rect.height;
        const parentOfBox = box.parent ? box.parent.path : "";
        if (rel < 0.3) {
          if (invalid(parentOfBox)) return null;
          return { zone: "before", row, parentPath: parentOfBox, position: { mode: "before", siblingId: box.id } };
        }
        if (rel > 0.7) {
          if (invalid(parentOfBox)) return null;
          return { zone: "after", row, parentPath: parentOfBox, position: { mode: "after", siblingId: box.id } };
        }
        if (invalid(box.path)) return null;
        return { zone: "inside", row, parentPath: box.path, position: { mode: "inside" } };
      }
      if (row?.dataset.system === "temp") return null;
      return { zone: "root", parentPath: "", position: { mode: "inside" } };
    };
    rows.addEventListener("dragover", (e) => {
      if (this.draggedPath === null) return;
      e.preventDefault();
      const row = e.target.closest(".tent-node");
      clearHover();
      const intent = intentFor(row, e.clientY);
      if (!intent) return;
      if (intent.zone === "root") rows.addClass("tent-drop-root");
      else intent.row.addClass("tent-drop-" + intent.zone);
    });
    rows.addEventListener("drop", async (e) => {
      if (this.draggedPath === null) return;
      e.preventDefault();
      const row = e.target.closest(".tent-node");
      const intent = intentFor(row, e.clientY);
      const from = this.draggedPath;
      clearHover();
      this.draggedPath = null;
      if (!intent) return;
      try {
        await placeBox(this.env(), from, intent.parentPath, intent.position);
        await this.refresh();
      } catch (err) {
        new import_obsidian4.Notice("\u79FB\u52A8\u5931\u8D25:" + (err instanceof Error ? err.message : err));
      }
    });
    rows.addEventListener("dragend", () => {
      clearHover();
      rows.removeClass("tent-dragging");
      rows.findAll(".tent-drag-source").forEach((r) => r.removeClass("tent-drag-source"));
      this.draggedPath = null;
    });
  }
  drawNode(parent, box, depth) {
    if (this.treeFilter === "pending" && !this.subtreeHasPending(box)) return;
    const wrap = parent.createDiv({ cls: "tent-box" });
    const isTop = depth === 0;
    const hasKids = box.children.length > 0;
    if (isTop) {
      wrap.addClass("tent-zone");
      const known = ["goal", "prompt", "output"].includes(box.name);
      wrap.addClass("tent-zone-" + (known ? box.name : "custom"));
      const topTypeDef = this.tent.typeRegistry[box.type];
      wrap.style.setProperty("--zone-color", typeColorValue(topTypeDef?.color));
    } else if (hasKids) {
      wrap.addClass("tent-subframe");
    }
    const row = wrap.createDiv({ cls: "tent-node" });
    row.dataset.path = box.path;
    if (isTop) row.addClass("tent-node-header");
    if (box.id === this.selectedId) row.addClass("is-selected");
    if (this.treeFilter === "pending" && !this.boxHasPending(box)) row.addClass("tent-node-ghost");
    if (box.archived) row.addClass("tent-node-archived");
    if (box.invalid) {
      row.addClass("tent-node-invalid");
      tentTooltip(row, box.invalidReason || "\u5931\u6548\u6846");
    }
    const frozen = isFrozen(box);
    const isCollapsed = this.treeFilter === "pending" ? false : this.collapsed.has(box.id);
    if (hasKids) {
      const chev = row.createSpan({ cls: "tent-chev" });
      (0, import_obsidian4.setIcon)(chev, isCollapsed ? "chevron-right" : "chevron-down");
      chev.onclick = (e) => {
        e.stopPropagation();
        if (isCollapsed) this.collapsed.delete(box.id);
        else this.collapsed.add(box.id);
        this.draw();
      };
    } else {
      row.createSpan({ cls: "tent-chev tent-chev-spacer" });
    }
    row.draggable = !frozen;
    row.ondragstart = (e) => {
      this.draggedPath = box.path;
      row.addClass("tent-drag-source");
      row.closest(".tent-rows")?.addClass("tent-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/tent", box.path);
        e.dataTransfer.setDragImage(makeDragLabel(box.name), 8, 8);
      }
    };
    row.createSpan({ cls: "tent-name", text: box.name });
    const split = splitType(box.type);
    const showType = this.registryUi.markedTypes.has(box.type) || this.registryUi.markedTypes.has(split.base) || !!split.modifier && this.registryUi.markedTypes.has(split.modifier) || box.id === this.selectedId;
    const owner = box.fm.owner;
    const showRole = !!owner && (this.registryUi.markedRoles.has(owner) || box.id === this.selectedId);
    if (showType || showRole) {
      const meta = row.createSpan({ cls: "tent-node-meta" });
      meta.createSpan({ cls: "tent-meta-sep", text: "\u2502" });
      if (showType) {
        const showBase = box.id === this.selectedId || this.registryUi.markedTypes.has(box.type) || this.registryUi.markedTypes.has(split.base);
        const showModifier = !!split.modifier && (box.id === this.selectedId || this.registryUi.markedTypes.has(box.type) || this.registryUi.markedTypes.has(split.modifier));
        if (showBase) {
          const baseDef = this.tent.typeRegistry[split.base];
          const tw = meta.createSpan({ cls: "tent-meta-type", text: split.base });
          tw.style.setProperty("--tent-type-color", typeColorValue(baseDef?.color));
        }
        if (showModifier && split.modifier) {
          if (showBase) meta.createSpan({ cls: "tent-meta-type-join", text: "-" });
          const modDef = this.tent.typeRegistry[split.modifier];
          const tw = meta.createSpan({ cls: "tent-meta-type", text: split.modifier });
          tw.style.setProperty("--tent-type-color", typeColorValue(modDef?.color));
        }
      }
      if (showRole && owner) {
        const role = this.roles.find((r) => r.name === owner);
        const rl = meta.createSpan({ cls: "tent-meta-role", text: owner });
        rl.style.setProperty("--role-color", roleColorValue(role ?? { name: owner }));
      }
    }
    const slot = row.createSpan({ cls: "tent-slot" });
    const rest = slot.createSpan({ cls: "tent-slot-rest" });
    const pend = this.boxTriageCount(box);
    if (pend > 0) {
      const nb = rest.createSpan({ cls: "tent-slot-notif", text: String(pend) });
      tentTooltip(nb, `${pend} \u5F85\u88C1`);
    }
    const st = box.fm.status;
    if (box.invalid) {
      const pill = rest.createSpan({ cls: "tent-slot-status tent-spill tent-spill-invalid" });
      const ico = pill.createSpan();
      (0, import_obsidian4.setIcon)(ico, "triangle-alert");
      tentTooltip(pill, box.invalidReason || "\u5931\u6548\u6846");
    } else if (box.fm.owner) {
      const pill = rest.createSpan({ cls: "tent-slot-status tent-spill tent-spill-lock" });
      const ico = pill.createSpan();
      (0, import_obsidian4.setIcon)(ico, "lock");
      tentTooltip(pill, `\u9501\u5B9A:${box.fm.owner} \u8BA4\u9886\u4E2D`);
    } else if (st && st !== "todo") {
      const pill = rest.createSpan({ cls: `tent-slot-status tent-spill tent-spill-${st}` });
      const ico = pill.createSpan();
      if (st === "doing") (0, import_obsidian4.setIcon)(ico, "circle-dashed");
      else if (st === "done") (0, import_obsidian4.setIcon)(ico, "circle-check");
      tentTooltip(pill, st);
    }
    const actionBlocked = hasActiveOwnerInScope(box);
    if (!frozen || box.archived) {
      const ops = slot.createSpan({ cls: "tent-slot-ops" });
      if (actionBlocked) ops.addClass("is-disabled");
      if (box.archived) {
        const restoreBtn = ops.createSpan({ cls: "tent-slot-btn" });
        (0, import_obsidian4.setIcon)(restoreBtn, "rotate-ccw");
        tentTooltip(restoreBtn, actionBlocked ? "\u8BA4\u9886\u8303\u56F4\u5185\u4E0D\u80FD\u6062\u590D" : "\u6062\u590D");
        restoreBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          try {
            if (actionBlocked) {
              new import_obsidian4.Notice("\u8BA4\u9886\u8303\u56F4\u5185\u4E0D\u80FD\u6062\u590D;\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05 owner");
              return;
            }
            const root = this.requireExplicitArchiveRoot(box, "\u6062\u590D");
            if (!root) return;
            const { restoreBox: restoreBox2 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            await restoreBox2(this.env(), root.id);
            await this.refresh();
            new import_obsidian4.Notice(`\u5DF2\u6062\u590D\u300C${root.name}\u300D`);
          } catch (err) {
            new import_obsidian4.Notice("\u6062\u590D\u5931\u8D25:" + (err instanceof Error ? err.message : err));
          }
        });
        const deleteKey = `box:${box.id}`;
        const deletePending = this.pendingDelete === deleteKey;
        const deleteBtn = ops.createSpan({ cls: "tent-slot-btn tent-slot-delete" + (deletePending ? " is-confirm" : "") });
        if (deletePending) deleteBtn.setText("\u786E\u8BA4\u5220\u9664");
        else (0, import_obsidian4.setIcon)(deleteBtn, "trash-2");
        tentTooltip(deleteBtn, actionBlocked ? "\u8BA4\u9886\u8303\u56F4\u5185\u4E0D\u80FD\u5220\u9664" : deletePending ? "\u518D\u6B21\u70B9\u51FB\u786E\u8BA4\u6C38\u4E45\u5220\u9664" : "\u6C38\u4E45\u5220\u9664");
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (actionBlocked) {
            new import_obsidian4.Notice("\u8BA4\u9886\u8303\u56F4\u5185\u4E0D\u80FD\u5220\u9664;\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05 owner");
            return;
          }
          const root = this.requireExplicitArchiveRoot(box, "\u5220\u9664");
          if (!root) return;
          const key = `box:${root.id}`;
          if (this.pendingDelete === key) {
            const { deleteArchivedBox: deleteArchivedBox2 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            await deleteArchivedBox2(this.env(), root.id);
            await this.refresh();
            new import_obsidian4.Notice(`\u5DF2\u5220\u9664\u300C${root.name}\u300D`);
            return;
          }
          this.pendingDelete = key;
          this.selectedId = root.id;
          this.selectedSystem = null;
          this.draw();
        });
      } else {
        const archBtn = ops.createSpan({ cls: "tent-slot-btn" });
        (0, import_obsidian4.setIcon)(archBtn, "archive");
        tentTooltip(archBtn, actionBlocked ? "\u8BA4\u9886\u8303\u56F4\u5185\u4E0D\u80FD\u5F52\u6863" : "\u5F52\u6863");
        archBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (actionBlocked) {
            new import_obsidian4.Notice("\u8BA4\u9886\u8303\u56F4\u5185\u4E0D\u80FD\u5F52\u6863;\u5148\u76D6\u7AE0\u6216\u5F3A\u6E05 owner");
            return;
          }
          try {
            const { archiveBox: archiveBox2 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            await archiveBox2(this.env(), box.id);
            await this.refresh();
            new import_obsidian4.Notice(`\u5DF2\u5F52\u6863\u300C${box.name}\u300D`);
          } catch (err) {
            new import_obsidian4.Notice("\u5F52\u6863\u5931\u8D25:" + (err instanceof Error ? err.message : err));
          }
        });
        const plus = ops.createSpan({ cls: "tent-slot-btn tent-slot-plus" });
        (0, import_obsidian4.setIcon)(plus, "plus");
        tentTooltip(plus, "\u65B0\u5EFA\u5B50\u6846");
        plus.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.openNewBoxForm(box.path);
        });
      }
    }
    row.onclick = () => {
      if (this.selectedId !== box.id) this.tagPickerOpen = false;
      this.selectedId = box.id;
      this.selectedSystem = null;
      this.draw();
    };
    row.oncontextmenu = (e) => this.nodeMenu(e, box);
    if (this.newBoxParentPath === box.path) this.drawInlineNewBoxForm(wrap, box.path);
    if (hasKids && !isCollapsed) {
      const kids = wrap.createDiv({ cls: "tent-children" });
      for (const c of box.children) this.drawNode(kids, c, depth + 1);
    }
  }
  drawTempSystem(parent) {
    const wrap = parent.createDiv({ cls: "tent-box tent-zone tent-zone-temp tent-zone-sys" });
    const row = wrap.createDiv({ cls: "tent-node tent-node-header tent-system" });
    row.dataset.system = "temp";
    if (this.selectedSystem === "temp") row.addClass("is-selected");
    row.createSpan({ cls: "tent-chev tent-chev-spacer" });
    row.createSpan({ cls: "tent-zdot" });
    row.createSpan({ cls: "tent-name", text: "temp" });
    row.createSpan({ cls: "tent-chip", text: "\u7CFB\u7EDF\u7BA1\u9053" });
    const slot = row.createSpan({ cls: "tent-slot" });
    const lock = slot.createSpan({ cls: "tent-slot-status tent-system-status" });
    (0, import_obsidian4.setIcon)(lock, "lock");
    tentTooltip(lock, "\u7CFB\u7EDF\u53EA\u8BFB\u7BA1\u9053");
    row.onclick = () => {
      this.selectedId = null;
      this.selectedSystem = "temp";
      this.draw();
    };
  }
  nodeMenu(e, box) {
    e.preventDefault();
    const menu = new import_obsidian4.Menu();
    menu.addItem((i) => i.setTitle("\u6253\u5F00\u7B14\u8BB0").setIcon("file-text").onClick(() => this.openBoxFile(box)));
    if (!box.archived && !box.invalid && box.fm.owner) {
      menu.addItem(
        (i) => i.setTitle(`\u4E2D\u65AD\u91CA\u653E (${box.fm.owner})`).setIcon("unlock").onClick(() => void this.requestForceRelease(box))
      );
    } else if (!box.archived && !box.invalid) {
      const check = canClaim(box);
      menu.addItem(
        (i) => i.setTitle("\u6D3E\u6D3B").setIcon("send").setDisabled(!check.ok).onClick(() => {
          this.selectedId = box.id;
          this.selectedSystem = null;
          this.rightPane = "property";
          this.bottomTab = "dispatch";
          this.draw();
        })
      );
    }
    if (!box.archived && !box.invalid) {
      menu.addItem(
        (i) => i.setTitle("Fork \u526F\u672C").setIcon("git-fork").onClick(async () => {
          try {
            const { forkNode: forkNode2 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            const forkId = await forkNode2(this.env(), box.id);
            this.selectedId = forkId;
            this.selectedSystem = null;
            this.rightPane = "property";
            await this.refresh();
            new import_obsidian4.Notice(`\u5DF2 Fork\u300C${box.name}\u300D`);
          } catch (err) {
            new import_obsidian4.Notice("Fork \u5931\u8D25:" + (err instanceof Error ? err.message : err));
          }
        })
      );
      menu.addSeparator();
      const structureBlocked = hasActiveOwnerInScope(box);
      menu.addItem(
        (i) => i.setTitle("\u65B0\u5EFA\u5B50\u6846").setIcon("folder-plus").setDisabled(structureBlocked).onClick(() => this.openNewBoxForm(box.path))
      );
      menu.addItem(
        (i) => i.setTitle("\u5F52\u6863").setIcon("archive").setDisabled(structureBlocked).onClick(async () => {
          try {
            const { archiveBox: archiveBox2 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            await archiveBox2(this.env(), box.id);
            await this.refresh();
            new import_obsidian4.Notice(`\u5DF2\u5F52\u6863\u300C${box.name}\u300D`);
          } catch (err) {
            new import_obsidian4.Notice("\u5F52\u6863\u5931\u8D25:" + (err instanceof Error ? err.message : err));
          }
        })
      );
    }
    menu.showAtMouseEvent(e);
  }
  // ---- 属性面板 ----
  drawProperty(el) {
    if (this.selectedSystem === "temp") {
      el.createDiv({ cls: "tent-sect", text: "\u7CFB\u7EDF\u7BA1\u9053" });
      el.createDiv({ cls: "tent-prop-title", text: "temp/" });
      el.createDiv({ cls: "tent-prop-empty", text: "\u7CFB\u7EDF\u7BA1\u9053\u3002agent \u53EF\u8BFB\u5168\u90E8 temp,\u53EA\u53EF\u5199\u81EA\u5DF1\u7684 temp/<role>/\uFF1Buser \u53EF\u76F4\u63A5\u8BFB\u5199\u3002" });
      return;
    }
    const box = this.selectedId ? this.tent.byId.get(this.selectedId) : null;
    if (!box) {
      el.createDiv({ cls: "tent-prop-empty", text: "\u9009\u4E00\u4E2A\u6846\u67E5\u770B / \u7F16\u8F91\u5C5E\u6027" });
      return;
    }
    const card = el.createDiv({ cls: "tent-prop-card style-a-view" });
    const titleRow = card.createDiv({ cls: "tent-prop-titlerow" });
    titleRow.createSpan({ cls: "tent-card-title", text: box.name });
    titleRow.createSpan({ cls: "tent-prop-id", text: box.id });
    const ownerWrap = titleRow.createDiv({ cls: "tent-titlerow-owner" });
    ownerWrap.createSpan({ cls: "owner-label", text: "owner" });
    const ownerHas = !!box.fm.owner;
    const ownerBadge = ownerWrap.createSpan({ cls: "owner-badge" + (ownerHas ? " active" : " empty") });
    if (ownerHas) {
      const role = this.roles.find((r) => r.name === box.fm.owner);
      ownerBadge.style.setProperty("--role-color", roleColorValue(role ?? { name: box.fm.owner }));
    }
    ownerBadge.setText(ownerHas ? box.fm.owner : "\u2014");
    const expandBtn = titleRow.createEl("button", { cls: "tent-prop-expand" });
    expandBtn.setAttr("type", "button");
    (0, import_obsidian4.setIcon)(expandBtn, this.propEditExpanded ? "chevron-up" : "chevron-down");
    tentTooltip(expandBtn, this.propEditExpanded ? "\u6536\u8D77\u5C5E\u6027" : "\u5C55\u5F00\u5C5E\u6027");
    expandBtn.onclick = () => {
      this.propEditExpanded = !this.propEditExpanded;
      this.draw();
    };
    if (splitType(box.type).base === "output") this.drawOutputSummary(card, box);
    const reg = this.tent.typeRegistry;
    if (this.propEditExpanded) {
      const editor = card.createDiv({ cls: "tent-prop-editor" });
      const { base: curBase, modifier: curMod } = splitType(box.fm.type || "");
      const bases = Object.keys(reg).filter((n) => reg[n].tier !== "modifier");
      const mods = Object.keys(reg).filter((n) => reg[n].tier === "modifier");
      const applyType = async (b, m) => {
        await this.patchBoxIncremental(box, { type: joinType(b, m || void 0) });
      };
      const tItem = editor.createDiv({ cls: "tent-prop-item tent-type-item" });
      tItem.createSpan({ cls: "tent-item-label", text: "type" });
      const tCtrl = tItem.createDiv({ cls: "tent-type-ctrl" });
      const baseSel = createChevronSelect(tCtrl, {
        cls: "dropdown tent-prop-select",
        options: bases.map((o) => ({ value: o, selected: o === curBase }))
      });
      tCtrl.createSpan({ cls: "tent-tk-dash", text: "\u2014" });
      const modSel = createChevronSelect(tCtrl, {
        cls: "dropdown tent-prop-select",
        options: [
          { value: "", label: "\u65E0", selected: !curMod },
          ...mods.map((o) => ({ value: o, selected: o === curMod }))
        ]
      });
      baseSel.onchange = () => applyType(baseSel.value, modSel.value);
      modSel.onchange = () => applyType(baseSel.value, modSel.value);
      const rwItem = editor.createDiv({ cls: "tent-prop-item" });
      rwItem.createSpan({ cls: "tent-item-label", text: "R/W" });
      const rwWrap = rwItem.createDiv({ cls: "tent-rw-mini-wrap" });
      drawRwSegment(rwWrap, "readable", box.fm.readable, async (v) => {
        await this.patchBoxIncremental(box, { readable: v });
      });
      drawRwSegment(rwWrap, "writable", box.fm.writable, async (v) => {
        await this.patchBoxIncremental(box, { writable: v });
      });
      const soItem = editor.createDiv({ cls: "tent-prop-item" });
      soItem.createSpan({ cls: "tent-item-label", text: "status" });
      const seg = soItem.createDiv({ cls: "tent-status-segment" });
      const curStatus = box.fm.status || "todo";
      for (const o of STATUSES) {
        const opt = seg.createDiv({ cls: "tent-status-segment-option" + (o === curStatus ? " is-active" : ""), text: o });
        opt.onclick = async () => {
          await this.patchBoxIncremental(box, { status: o });
        };
      }
      this.drawTagsRow(editor, box);
      if (this.tagPickerOpen) this.drawTagPicker(editor, box);
    }
    this.drawBottom(card, box);
  }
  withTentRootPointer(relayPrompt) {
    const abs = this.tentRootAbsolutePath();
    return abs ? relayPrompt.replace("\u8FD9\u9876\u5E10\u7684\u6839\u76EE\u5F55", `\u8FD9\u9876\u5E10\u7684\u6839\u76EE\u5F55(${abs})`) : relayPrompt;
  }
  async dispatchBox(box, roleName, userPrompt, handoffPath) {
    const workspacePath = this.tent ? resolveTentWorkspace(this.tent) : void 0;
    const workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, roleName) : void 0;
    return dispatch(this.env(), box.id, roleName, { userPrompt, handoffPath, workspace });
  }
  tentRootAbsolutePath() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian4.FileSystemAdapter)) return null;
    return nodePath3.join(adapter.getBasePath(), this.tentRootPath());
  }
  drawOutputSummary(el, box) {
    const pointer = parseOutputPointer(box.fm, box.body);
    const card = el.createDiv({ cls: "tent-output-summary" });
    card.createSpan({ cls: "tent-output-pill", text: (box.fm.status || "todo") === "done" ? "\u5DF2\u4EA4\u4ED8" : "\u672A\u76D6\u7AE0" });
    card.createSpan({ cls: "tent-output-line", text: pointer.workspace ? `workspace: ${pointer.workspace}` : "workspace: \u672A\u8BB0\u5F55" });
    const refLine = card.createSpan({
      cls: "tent-output-line",
      text: pointer.workspace ? "workspace HEAD: \u8BFB\u53D6\u4E2D" : pointer.ref ? `\u8BB0\u5F55 ref: ${pointer.ref}` : "workspace HEAD: \u4E0D\u53EF\u7528"
    });
    if (pointer.workspace) {
      void this.loadWorkspaceHead(pointer.workspace).then((head) => {
        if (!head) {
          refLine.setText(pointer.ref ? `\u8BB0\u5F55 ref: ${pointer.ref}\uFF08HEAD \u4E0D\u53EF\u7528\uFF09` : "workspace HEAD: \u4E0D\u53EF\u7528");
          return;
        }
        refLine.setText(`workspace HEAD: ${head.shortRef} \xB7 ${head.branch}`);
        refLine.title = head.ref;
      }).catch(() => {
        refLine.setText(pointer.ref ? `\u8BB0\u5F55 ref: ${pointer.ref}\uFF08HEAD \u4E0D\u53EF\u7528\uFF09` : "workspace HEAD: \u4E0D\u53EF\u7528");
      });
    }
  }
  requireExplicitArchiveRoot(box, action) {
    const root = this.findExplicitArchiveRoot(box);
    if (!root) {
      new import_obsidian4.Notice(`\u65E0\u6CD5${action}:\u627E\u4E0D\u5230\u663E\u5F0F\u5F52\u6863\u6839`);
      return null;
    }
    if (root.id !== box.id) {
      this.selectedId = root.id;
      this.selectedSystem = null;
      new import_obsidian4.Notice(`\u300C${box.name}\u300D\u7EE7\u627F\u81EA\u5F52\u6863\u6839\u300C${root.name}\u300D;\u8BF7\u5728\u5F52\u6863\u6839\u4E0A${action}`);
      this.draw();
      return null;
    }
    return root;
  }
  findExplicitArchiveRoot(box) {
    let cur = box;
    while (cur) {
      if (cur.fm.archived === true) return cur;
      cur = cur.parent;
    }
    return null;
  }
  // tags 行:当前 tag chips(读 box.fm.tags)+ 末尾 ＋,＋ 内联展开挑选区
  drawTagsRow(el, box) {
    const item = el.createDiv({ cls: "tent-prop-item-tags" });
    item.createSpan({ cls: "tent-item-label", text: "tags" });
    const ctrl = item.createDiv({ cls: "tent-item-control" });
    const container = ctrl.createDiv({ cls: "tent-tags-container" });
    const current = box.fm.tags ?? [];
    for (const tag of current) {
      const chip = container.createSpan({ cls: "tent-tag-chip-selected" });
      chip.createSpan({ text: tag });
      const x = chip.createEl("i");
      (0, import_obsidian4.setIcon)(x, "x");
      tentTooltip(x, `\u79FB\u9664 #${tag}`);
      x.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await removeTag(this.env().fs, box.id, tag);
          await this.refresh();
        } catch (err) {
          new import_obsidian4.Notice("\u79FB\u9664 tag \u5931\u8D25:" + (err instanceof Error ? err.message : err));
        }
      };
    }
    const trigger = container.createSpan({ cls: "tent-tag-trigger-btn" });
    (0, import_obsidian4.setIcon)(trigger, this.tagPickerOpen ? "chevron-up" : "plus");
    trigger.createSpan({ text: this.tagPickerOpen ? "\u6536\u8D77" : "tag" });
    trigger.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.tagPickerOpen = !this.tagPickerOpen;
      this.draw();
    };
  }
  // 展开挑选器(图二):已登记但本框没有的 tag 列成虚线 chip(点即加)+ 新建输入
  drawTagPicker(host, box) {
    const current = box.fm.tags ?? [];
    const candidates = this.registryTags.filter((t) => !current.includes(t));
    const picker = host.createDiv({ cls: "tent-tag-picker" });
    picker.createDiv({ cls: "tent-tag-picker-title", text: "\u9009\u62E9\u5DF2\u6709\u6807\u7B7E" });
    const list = picker.createDiv({ cls: "tent-tag-picker-list" });
    if (candidates.length === 0) {
      list.createSpan({ cls: "tent-tag-picker-empty", text: "\u6CA1\u6709\u66F4\u591A\u5DF2\u6709\u6807\u7B7E" });
    } else {
      for (const tag of candidates) {
        const pendKey = `regtag:${tag}`;
        const pending = this.pendingDelete === pendKey;
        const chip = list.createSpan({ cls: "tent-tag-chip-selectable" + (pending ? " is-confirm-del" : "") });
        chip.createSpan({ cls: "ttc-label", text: pending ? "\u786E\u8BA4\u5220\u9664" : tag });
        const confirmDelete = async () => {
          try {
            await removeRegistryTag(this.env().fs, tag);
            this.pendingDelete = null;
            await this.refresh();
          } catch (err) {
            new import_obsidian4.Notice("\u5220\u9664\u5931\u8D25:" + (err instanceof Error ? err.message : err));
          }
        };
        chip.onclick = async (e) => {
          e.preventDefault();
          if (pending) {
            await confirmDelete();
            return;
          }
          try {
            await addTag(this.env().fs, box.id, tag);
            await this.refresh();
          } catch (err) {
            new import_obsidian4.Notice("\u52A0 tag \u5931\u8D25:" + (err instanceof Error ? err.message : err));
          }
        };
        if (!pending) {
          const x = chip.createEl("i", { cls: "tent-tag-chip-del" });
          (0, import_obsidian4.setIcon)(x, "x");
          tentTooltip(x, `\u4ECE\u6CE8\u518C\u8868\u5220\u9664 #${tag}`);
          x.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.pendingDelete = pendKey;
            this.draw();
          };
        }
      }
    }
    const newRow = picker.createDiv({ cls: "tent-tag-picker-new-row" });
    const input = newRow.createEl("input", { cls: "tent-tag-inline-input", attr: { type: "text", placeholder: "\u8F93\u5165\u65B0\u5EFA\u6807\u7B7E" } });
    const submit = newRow.createEl("button", { cls: "tent-tag-new-submit", text: "\u65B0\u5EFA" });
    const create = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        await addTag(this.env().fs, box.id, name);
        await this.refresh();
      } catch (err) {
        new import_obsidian4.Notice("\u52A0 tag \u5931\u8D25:" + (err instanceof Error ? err.message : err));
      }
    };
    submit.onclick = (e) => {
      e.preventDefault();
      void create();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void create();
      } else if (e.key === "Escape") {
        this.tagPickerOpen = false;
        this.draw();
      }
    });
  }
  // status 小圆 chip:与左树同套 icon,色随状态。todo 用空心圈(仅面板,左树不显 todo)。
  // 底部:左上 笔记/派活/待裁 tab 切内容,右上对应动作键
  drawBottom(el, box) {
    const wrap = el.createDiv({ cls: "tent-bottom" });
    const head = wrap.createDiv({ cls: "tent-bottom-head" });
    const tabs = head.createDiv({ cls: "tent-bottom-tabs" });
    const mkTab = (key, label) => {
      const t = tabs.createDiv({ cls: "tent-bottom-tab" + (this.bottomTab === key ? " is-active" : "") });
      t.createSpan({ text: label });
      t.onclick = () => {
        this.bottomTab = key;
        this.draw();
      };
    };
    mkTab("note", "\u7B14\u8BB0");
    mkTab("dispatch", "\u6D3E\u6D3B");
    mkTab("triage", "\u5F85\u88C1");
    const actSlot = head.createDiv({ cls: "tent-bottom-act" });
    const body = wrap.createDiv({ cls: "tent-bottom-body" });
    if (this.bottomTab === "dispatch") {
      this.drawDispatchInline(body, actSlot, box);
    } else if (this.bottomTab === "triage") {
      this.drawTriageInline(body, actSlot, box);
    } else {
      const open2 = actSlot.createEl("button", { cls: "tent-bottom-action", text: "\u6253\u5F00\u7B14\u8BB0" });
      open2.onclick = () => this.openBoxFile(box);
      this.drawNote(body, box);
    }
  }
  boxTriageCount(box) {
    const props = this.proposals.filter((p) => p.target === box.id && p.status === "open").length;
    const reports = this.reports.filter((report) => report.boxId === box.id && report.status === "ready").length;
    return props + reports;
  }
  // 待裁 tab:本框的 proposal 待裁(采纳/驳回/打开)+ 完成待确认(中断释放 / 确认完成)
  drawTriageInline(body, actSlot, box) {
    const proposalItems = this.inbox.filter((item) => {
      if (item.kind !== "proposal" && item.kind !== "invalid-proposal") return false;
      return item.proposal.target === box.id;
    });
    const owner = box.fm.owner;
    const report = this.reports.find((item) => item.boxId === box.id && item.status === "ready");
    const rejectedReport = this.reports.find((item) => item.boxId === box.id && item.status === "rejected");
    if (owner) {
      const releasePending = this.pendingDelete === `release:${box.id}`;
      const rel = actSlot.createEl("button", {
        cls: "tent-bottom-action tent-bottom-danger" + (releasePending ? " is-confirm" : ""),
        text: releasePending ? "\u786E\u8BA4\u91CA\u653E" : "\u4E2D\u65AD\u91CA\u653E"
      });
      rel.setAttr("type", "button");
      rel.onclick = (event) => {
        event.stopPropagation();
        void this.requestForceRelease(box);
      };
    }
    if (proposalItems.length === 0 && !owner && !report) {
      body.createDiv({ cls: "tent-bottom-empty", text: "\u65E0\u5F85\u5904\u7406" });
      return;
    }
    if (report) {
      body.createDiv({ cls: "tent-triage-sec", text: "\u5F85\u786E\u8BA4\u4EA4\u4ED8" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      const first = report.body.split("\n").map((line) => line.trim()).find(Boolean) || "(\u65E0\u8BF4\u660E)";
      main.createDiv({ cls: "tent-triage-name", text: first });
      main.createDiv({
        cls: "tent-triage-meta",
        text: `${report.role} \xB7 ${report.commits.length === 0 ? "\u65E0\u4EE3\u7801\u63D0\u4EA4" : `${report.commits.length} \u4E2A\u4EE3\u7801\u63D0\u4EA4`}`
      });
      const acts = item.createDiv({ cls: "tent-triage-acts" });
      const open2 = acts.createEl("button", { text: "\u6253\u5F00" });
      open2.setAttr("type", "button");
      open2.onclick = () => this.openVaultFile(report.path);
      const reject = acts.createEl("button", { text: "\u9A73\u56DE" });
      reject.setAttr("type", "button");
      reject.onclick = async () => {
        try {
          await rejectReport(this.env().fs, report.path);
          await this.refresh();
          new import_obsidian4.Notice("\u5DF2\u9A73\u56DE\uFF0Cowner \u4FDD\u7559\uFF0C\u7B49\u5F85 agent \u91CD\u65B0\u4EA4\u4ED8");
        } catch (e) {
          new import_obsidian4.Notice("\u9A73\u56DE\u5931\u8D25:" + (e instanceof Error ? e.message : e));
        }
      };
      const done = acts.createEl("button", { cls: "mod-cta", text: "\u786E\u8BA4" });
      done.setAttr("type", "button");
      if (report.commits.length > 0) {
        const pick = body.createDiv({ cls: "tent-commit-pick" });
        pick.createDiv({ cls: "tent-commit-note", text: "\u8BFB\u53D6 report commits\u2026" });
        this.loadRoleCommits(report.role).then((commits) => {
          pick.empty();
          pick.createDiv({ cls: "tent-commit-head", text: "\u786E\u8BA4\u540E\u5C06\u5168\u90E8\u5408\u5165:" });
          const byRef = new Map((commits || []).map((commit) => [commit.ref, commit]));
          for (const ref of report.commits) {
            const commit = byRef.get(ref);
            const row = pick.createDiv({ cls: "tent-commit-row" });
            row.createSpan({ cls: "tent-commit-sha", text: commit?.shortRef || ref.slice(0, 8) });
            row.createSpan({ cls: "tent-commit-sub", text: commit?.subject || ref });
          }
        }).catch(() => {
          pick.empty();
          for (const ref of report.commits) {
            const row = pick.createDiv({ cls: "tent-commit-row" });
            row.createSpan({ cls: "tent-commit-sha", text: ref.slice(0, 8) });
            row.createSpan({ cls: "tent-commit-sub", text: ref });
          }
        });
      }
      done.onclick = async () => {
        done.setAttr("disabled", "true");
        try {
          await acceptReport(
            this.env(),
            report.path,
            async (refs) => {
              const wp = this.tent ? resolveTentWorkspace(this.tent) : void 0;
              if (!wp) throw new Error("\u5E10\u5185\u6CA1\u6709 workspace output \u6307\u9488");
              const contract = await ensureRoleWorkspace(wp, report.role);
              await integrateWorkspaceCommits(contract, refs);
            }
          );
          this.clearGitUiCache();
          await this.refresh();
          new import_obsidian4.Notice(report.commits.length ? `\u5DF2\u786E\u8BA4(\u5408\u5165 ${report.commits.length} commit + \u6E05 owner)` : "\u5DF2\u786E\u8BA4(done + \u6E05 owner)");
        } catch (e) {
          done.removeAttribute("disabled");
          new import_obsidian4.Notice("\u786E\u8BA4\u5931\u8D25:" + (e instanceof Error ? e.message : e));
        }
      };
    } else if (owner) {
      body.createDiv({ cls: "tent-triage-sec", text: "\u5904\u7406\u4E2D" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      main.createDiv({ cls: "tent-triage-name", text: `${owner} \u6B63\u5728\u5904\u7406\u6B64\u6846` });
      main.createDiv({
        cls: "tent-triage-meta",
        text: rejectedReport ? "\u4E0A\u4E00\u4EFD\u4EA4\u4ED8\u5DF2\u9A73\u56DE\uFF0C\u7B49\u5F85\u91CD\u65B0\u4EA4\u4ED8" : "report \u5230\u8FBE\u540E\u53EF\u5728\u6B64\u786E\u8BA4\u4EA4\u4ED8"
      });
    }
    if (proposalItems.length > 0) {
      body.createDiv({ cls: "tent-triage-sec", text: "\u5F85\u88C1\u63D0\u8BAE" });
      for (const itemData of proposalItems) {
        const p = itemData.proposal;
        const invalidReason = itemData.kind === "invalid-proposal" ? itemData.reason : "";
        const item = body.createDiv({ cls: "tent-triage-item" });
        const main = item.createDiv({ cls: "tent-triage-main" });
        const first = p.body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) || "(\u65E0\u8BF4\u660E)";
        main.createDiv({ cls: "tent-triage-name", text: `${invalidReason ? "\u26A0 " : ""}${first}` });
        main.createDiv({ cls: "tent-triage-meta", text: `${p.from} \u63D0\u4EA4` });
        if (invalidReason) main.createDiv({ cls: "tent-triage-meta is-warn", text: invalidReason });
        const acts = item.createDiv({ cls: "tent-triage-acts" });
        const open2 = acts.createEl("button", { text: "\u6253\u5F00" });
        open2.setAttr("type", "button");
        open2.onclick = () => this.openVaultFile(p.path);
        const rej = acts.createEl("button", { text: "\u9A73\u56DE" });
        rej.setAttr("type", "button");
        rej.onclick = async () => {
          try {
            const { applyProposal: applyProposal3 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            await applyProposal3(this.env(), p.path, false);
            await this.refresh();
          } catch (e) {
            new import_obsidian4.Notice("\u9A73\u56DE\u5931\u8D25:" + (e instanceof Error ? e.message : e));
          }
        };
        const acc = acts.createEl("button", { cls: "mod-cta", text: "\u91C7\u7EB3" });
        acc.setAttr("type", "button");
        const canGrantReadable = !!invalidReason && (box.type === "asset" || splitType(box.type).modifier === "asset") && /不可读/.test(invalidReason);
        acc.disabled = !!invalidReason && !canGrantReadable;
        tentTooltip(acc, canGrantReadable ? "\u91C7\u7EB3\u5E76\u7FFB\u53EF\u8BFB" : invalidReason ? "\u76EE\u6807\u4E0D\u53EF\u7528,\u53EA\u80FD\u9A73\u56DE" : "\u91C7\u7EB3");
        acc.onclick = async () => {
          try {
            const { applyProposal: applyProposal3 } = await Promise.resolve().then(() => (init_ops(), ops_exports));
            if (canGrantReadable) await grantReadable(this.env(), box.id);
            else if (invalidReason) return;
            await applyProposal3(this.env(), p.path, true);
            await this.refresh();
            new import_obsidian4.Notice("\u5DF2\u91C7\u7EB3");
          } catch (e) {
            new import_obsidian4.Notice("\u91C7\u7EB3\u5931\u8D25:" + (e instanceof Error ? e.message : e));
          }
        };
      }
    }
  }
  loadWorkspaceHead(workspace) {
    const key = nodePath3.resolve(workspace);
    return this.loadCached(this.workspaceHeadCache, key, async () => {
      try {
        return await readWorkspaceHead(key);
      } catch {
        return null;
      }
    });
  }
  // 读取某 role lane 尚未合入正式分支的 commit;无 workspace 指针返回 null
  async loadRoleCommits(owner) {
    let wp;
    try {
      wp = this.tent ? resolveTentWorkspace(this.tent) : void 0;
    } catch {
      return null;
    }
    if (!wp) return null;
    const workspace = nodePath3.resolve(wp);
    return this.loadCached(this.roleCommitsCache, `${workspace}\0${owner}`, () => listRoleCommitsFor(workspace, owner));
  }
  loadCached(cache, key, loader) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit?.hasValue && hit.expiresAt > now) return Promise.resolve(hit.value);
    if (hit?.promise) return hit.promise;
    const promise = loader().then((value) => {
      cache.set(key, {
        value,
        hasValue: true,
        expiresAt: Date.now() + GIT_UI_CACHE_TTL_MS
      });
      return value;
    }).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { expiresAt: now + GIT_UI_CACHE_TTL_MS, hasValue: false, promise });
    return promise;
  }
  clearGitUiCache() {
    this.workspaceHeadCache.clear();
    this.roleCommitsCache.clear();
  }
  // 派活内联:目标 role + user prompt + 可选 handoff 指针,右上「派活接力」执行
  drawDispatchInline(body, actSlot, box) {
    if (box.fm.owner) {
      const state = body.createDiv({ cls: "tent-content-intro is-stacked" });
      state.createDiv({ cls: "tent-content-title", text: `${box.fm.owner} \u6B63\u5728\u5904\u7406\u6B64\u6846` });
      state.createDiv({ cls: "tent-content-meta", text: "\u53EF\u5728\u300C\u5F85\u88C1\u300D\u4E2D\u67E5\u770B\u4EA4\u4ED8\u6216\u4E2D\u65AD\u4EFB\u52A1" });
      return;
    }
    const form = body.createDiv({ cls: "tent-dispatch-form style-a-view" });
    const roleRow = form.createDiv({ cls: "tent-dispatch-row tent-dispatch-role-row" });
    roleRow.createSpan({ cls: "tent-prop-key", text: "\u76EE\u6807 role" });
    const roleControl = roleRow.createDiv({ cls: "tent-dispatch-control" });
    const roleSelect = createChevronSelect(roleControl, {
      cls: "dropdown tent-prop-select tent-dispatch-select tent-dispatch-role-select",
      options: [
        { value: "", label: this.roles.length ? "(\u9009\u62E9)" : "(\u624B\u52A8\u8F93\u5165)" },
        ...this.roles.map((role) => ({ value: role.name, label: role.name }))
      ]
    });
    const manualRole = roleControl.createEl("input", { cls: "tent-dispatch-role-input", attr: { type: "text" } });
    manualRole.toggleClass("is-hidden", this.roles.length > 0);
    roleSelect.onchange = () => {
      manualRole.toggleClass("is-hidden", !!roleSelect.value || this.roles.length > 0);
    };
    const userSection = form.createDiv({ cls: "tent-dispatch-row tent-dispatch-prompt-row" });
    userSection.createSpan({ cls: "tent-prop-key", text: "user prompt" });
    const prompt = userSection.createEl("textarea", {
      cls: "tent-dispatch-prompt",
      attr: { rows: "1" }
    });
    const resizePrompt = () => {
      prompt.style.height = "auto";
      prompt.style.height = `${Math.max(30, prompt.scrollHeight)}px`;
    };
    prompt.oninput = resizePrompt;
    const handoffSection = form.createDiv({ cls: "tent-dispatch-row tent-dispatch-handoff-row" });
    const handoffTitle = handoffSection.createSpan({ cls: "tent-prop-key", text: "handoff" });
    const handoffControl = handoffSection.createDiv({ cls: "tent-dispatch-control tent-dispatch-handoff-control" });
    handoffControl.createSpan({ cls: "tent-dispatch-from", text: "from" });
    const availableHandoffs = this.handoffs.filter((handoff2) => handoff2.targetId === box.id);
    let handoffSelect = null;
    if (availableHandoffs.length === 0) {
      handoffControl.createSpan({ cls: "tent-dispatch-readonly", text: "\u2014" });
    } else {
      handoffSelect = createChevronSelect(handoffControl, {
        cls: "dropdown tent-prop-select tent-dispatch-select tent-dispatch-handoff-select",
        options: [
          { value: "", label: "(\u4E0D\u4F7F\u7528)" },
          ...availableHandoffs.map((handoff2) => ({ value: handoff2.path, label: handoff2.fromRole }))
        ]
      });
    }
    const handoffPreview = handoffSection.createDiv({ cls: "tent-dispatch-handoff-preview is-hidden" });
    const syncHandoffRole = () => {
      const selected = availableHandoffs.find((handoff2) => handoff2.path === handoffSelect?.value);
      handoffTitle.setText("handoff");
      handoffPreview.setText(selected?.body || "");
      handoffPreview.toggleClass("is-hidden", !selected);
      roleSelect.disabled = !!selected;
      manualRole.disabled = !!selected;
      if (selected) {
        const registered = this.roles.some((role) => role.name === selected.targetRole);
        roleSelect.value = registered ? selected.targetRole : "";
        manualRole.value = registered ? "" : selected.targetRole;
        manualRole.toggleClass("is-hidden", registered);
      } else {
        manualRole.value = "";
        manualRole.toggleClass("is-hidden", this.roles.length > 0);
      }
    };
    if (handoffSelect) handoffSelect.onchange = syncHandoffRole;
    const claim = canClaim(box);
    const run = actSlot.createEl("button", { cls: "tent-bottom-action", text: "\u6D3E\u6D3B\u63A5\u529B" });
    run.setAttr("type", "button");
    run.disabled = !claim.ok;
    if (!claim.ok) tentTooltip(run, claim.reason || "");
    run.onclick = async () => {
      const selectedHandoff = availableHandoffs.find((handoff3) => handoff3.path === handoffSelect?.value);
      const roleName = selectedHandoff?.targetRole || roleSelect.value.trim() || manualRole.value.trim();
      if (!roleName) {
        new import_obsidian4.Notice("\u8BF7\u9009\u62E9\u6216\u8F93\u5165 role");
        return;
      }
      const localPrompt = prompt.value.trim();
      const handoff2 = selectedHandoff?.path || "";
      if (!localPrompt && !handoff2) {
        new import_obsidian4.Notice("\u8BF7\u586B\u5199 user prompt \u6216 handoff \u6307\u9488");
        return;
      }
      try {
        const r = await this.dispatchBox(box, roleName, localPrompt, handoff2 || void 0);
        if (this.plugin.settings.dispatchPrefs.copyPromptToClipboard) {
          await navigator.clipboard.writeText(this.withTentRootPointer(r.relayPrompt));
          new import_obsidian4.Notice("\u5DF2\u6D3E\u6D3B\u3002\u5DF2\u590D\u5236\u63A5\u529B prompt,\u53BB\u76EE\u6807 agent \u4F1A\u8BDD\u7C98\u8D34\u3002", 6e3);
        } else {
          new import_obsidian4.Notice("\u5DF2\u6D3E\u6D3B\u3002\u63A5\u529B prompt \u5DF2\u751F\u6210\u3002", 6e3);
        }
        await this.refresh();
      } catch (e) {
        new import_obsidian4.Notice("\u6D3E\u6D3B\u5931\u8D25:" + (e instanceof Error ? e.message : e));
      }
    };
  }
  // 正文:可编辑 textarea,blur 落盘。支持拖 Obsidian 文件进来转成帐根相对路径。
  drawNote(el, box) {
    const intro = el.createDiv({ cls: "tent-content-intro" });
    intro.createDiv({ cls: "tent-content-title", text: "\u7B14\u8BB0\u6B63\u6587" });
    intro.createDiv({
      cls: "tent-content-meta",
      text: box.readable.value ? "\u6D3E\u6D3B\u65F6\u4F5C\u4E3A\u6B64\u6846\u4E0A\u4E0B\u6587\u63D0\u4F9B\u7ED9 agent" : "\u4EC5\u4F9B user \u67E5\u770B"
    });
    const ta = el.createEl("textarea", { cls: "tent-notebox" });
    ta.value = box.body.trim();
    ta.onblur = async () => {
      if (ta.value.trim() === box.body.trim()) return;
      await this.patchBodyIncremental(box, ta.value.trim() + "\n");
    };
    ta.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData("text/plain") || "";
      const uriM = raw.match(/[?&]file=([^&\s]+)/);
      const wikiM = raw.match(/^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/);
      const name = uriM ? decodeURIComponent(uriM[1]) : wikiM ? wikiM[1] : null;
      if (!name) return;
      e.preventDefault();
      e.stopPropagation();
      const vaultPath = /\.\w+$/.test(name) ? name : name + ".md";
      const up = "../".repeat(this.tentRootPath().split("/").filter(Boolean).length);
      const rel = up + vaultPath;
      const s = ta.selectionStart ?? ta.value.length;
      const en = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + rel + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + rel.length;
      ta.focus();
    });
  }
  // ---- 动作处理 ----
  openNewBoxForm(parentPath) {
    this.newBoxParentPath = this.newBoxParentPath === parentPath ? null : parentPath;
    this.pendingDelete = null;
    this.draw();
  }
  drawInlineNewBoxForm(parent, parentPath) {
    const card = parent.createDiv({ cls: "tent-newform tent-inline-newbox" });
    const reg = this.tent.typeRegistry;
    const bases = Object.keys(reg).filter((n) => reg[n].tier !== "modifier");
    const mods = Object.keys(reg).filter((n) => reg[n].tier === "modifier");
    const defaultType = parentPath ? this.tent.byPath.get(parentPath)?.type : void 0;
    const sp = defaultType ? splitType(defaultType) : { base: "", modifier: "" };
    const state = {
      name: "",
      base: sp.base && bases.includes(sp.base) ? sp.base : bases[0] ?? "",
      kind: sp.modifier && mods.includes(sp.modifier) ? sp.modifier : ""
    };
    const row = card.createDiv({ cls: "tent-newbox-row" });
    row.createSpan({ cls: "tent-newform-label", text: "\u540D\u5B57" });
    const nameInput = row.createEl("input", {
      cls: "tent-newform-input",
      attr: { type: "text" }
    });
    nameInput.oninput = () => state.name = nameInput.value.trim();
    row.createSpan({ cls: "tent-newform-label", text: "type" });
    const baseSel = row.createEl("select", { cls: "dropdown tent-newbox-type" });
    for (const b of bases) {
      const o = baseSel.createEl("option", { text: b, value: b });
      if (b === state.base) o.selected = true;
    }
    baseSel.onchange = () => state.base = baseSel.value;
    row.createSpan({ cls: "tent-tk-dash", text: "\u2014" });
    const kindSel = row.createEl("select", { cls: "dropdown tent-newbox-type" });
    const none = kindSel.createEl("option", { text: "\u65E0", value: "" });
    if (!state.kind) none.selected = true;
    for (const m of mods) {
      const o = kindSel.createEl("option", { text: m, value: m });
      if (m === state.kind) o.selected = true;
    }
    kindSel.onchange = () => state.kind = kindSel.value;
    const create = row.createEl("button", { cls: "mod-cta", text: "\u65B0\u5EFA" });
    create.setAttr("type", "button");
    create.onclick = async () => {
      if (!state.name) {
        new import_obsidian4.Notice("\u8BF7\u586B\u5199\u6846\u540D");
        return;
      }
      const type = joinType(state.base, state.kind || void 0);
      await createBox(this.env(), { parentPath, name: state.name, type });
      this.newBoxParentPath = null;
      await this.refresh();
      new import_obsidian4.Notice(`\u5DF2\u5EFA\u6846\u300C${state.name}\u300D`);
    };
    const cancel = row.createEl("button", { text: "\u53D6\u6D88" });
    cancel.setAttr("type", "button");
    cancel.onclick = () => {
      this.newBoxParentPath = null;
      this.draw();
    };
    nameInput.focus();
  }
  async requestForceRelease(box) {
    const key = `release:${box.id}`;
    if (this.pendingDelete === key) {
      this.pendingDelete = null;
      try {
        await forceRelease(this.env(), box.id);
        await this.refresh();
        new import_obsidian4.Notice(`\u5DF2\u4E2D\u65AD\u300C${box.name}\u300D\u5E76\u91CA\u653E owner`);
      } catch (error) {
        new import_obsidian4.Notice("\u91CA\u653E\u5931\u8D25:" + (error instanceof Error ? error.message : error));
      }
      return;
    }
    this.pendingDelete = key;
    this.selectedId = box.id;
    this.selectedSystem = null;
    this.rightPane = "property";
    this.bottomTab = "triage";
    this.draw();
  }
  // ---- 白板:生成原生 .canvas 并打开 ----
  async openBoard() {
    if (!this.tent) {
      new import_obsidian4.Notice("\u5148\u9009\u4E00\u4E2A\u5E10");
      return;
    }
    const fs = this.env().fs;
    const canvasRel = "_tent.canvas";
    try {
      const old = await fs.exists(canvasRel) ? parseCanvas(await fs.readFile(canvasRel)) : null;
      const fresh = buildCanvas(this.tent, this.tentRootPath());
      preservePositions(fresh, old, this.tent);
      await fs.writeFile(canvasRel, canvasToJson(fresh));
      await this.openVaultFile(canvasRel, 200);
      new import_obsidian4.Notice("\u767D\u677F\u5DF2\u5237\u65B0");
    } catch (e) {
      new import_obsidian4.Notice("\u751F\u6210\u767D\u677F\u5931\u8D25:" + (e instanceof Error ? e.message : e));
    }
  }
  // ---- 打开文件 ----
  async openBoxFile(box) {
    await this.openVaultFile(boxNotePath(box.path));
  }
  async openVaultFile(tentRelPath, retryMs = 0) {
    const vaultPath = (0, import_obsidian4.normalizePath)(`${this.tentRootPath()}/${tentRelPath}`);
    let file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!file && retryMs > 0) {
      await new Promise((r) => window.setTimeout(r, retryMs));
      file = this.app.vault.getAbstractFileByPath(vaultPath);
    }
    if (file instanceof import_obsidian4.TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file);
    } else {
      new import_obsidian4.Notice("\u627E\u4E0D\u5230\u6587\u4EF6:" + vaultPath);
    }
  }
};
function hasActiveOwnerInScope(box) {
  let current = box;
  while (current) {
    if (current.fm.owner) return true;
    current = current.parent;
  }
  return subtreeHasOwner(box);
}
function subtreeHasOwner(box) {
  if (box.fm.owner) return true;
  return box.children.some(subtreeHasOwner);
}
function tentTooltip(el, text, placement = "top") {
  el.removeAttribute("title");
  if (!text) return;
  (0, import_obsidian4.setTooltip)(el, text, {
    placement,
    delay: 300,
    gap: 6,
    classes: ["tent-tooltip"]
  });
}
function makeDragLabel(name) {
  const el = document.body.createDiv({ cls: "tent-drag-label", text: name });
  el.style.position = "absolute";
  el.style.top = "-1000px";
  el.style.left = "-1000px";
  window.setTimeout(() => el.remove(), 0);
  return el;
}

// src/plugin/main.ts
init_typeRegistry();
var DEFAULT_RULES_TEMPLATE = "# {tent} \xB7 \u9879\u76EE\u7EA6\u5B9A\n\n> \u8FD9\u9876\u5E10\u7684\u672C\u5730\u89C4\u77E9\uFF1B\u673A\u5236\u89C4\u8303\u7531 Tent \u4E0E tent-role skill \u63D0\u4F9B\u3002\n\n- \u4EA7\u51FA workspace\uFF1A<\u586B\u771F\u5B9E\u4EE3\u7801\u4ED3\u8DEF\u5F84>\n- \u63D0\u4EA4 / \u547D\u540D\u7EA6\u5B9A\uFF1A<\u586B>\n- \u5176\u4ED6\u9879\u76EE\u7EA6\u5B9A\uFF1A<\u586B>\n";
var DEFAULT_ROLES_REGISTRY2 = { roles: [] };
var DEFAULT_SETTINGS = {
  tentsRoot: "tents",
  activeTent: "",
  appearance: "follow",
  dispatchPrefs: {
    copyPromptToClipboard: true
  },
  triageReminder: "status",
  newTentDefaults: {
    typeRegistry: cloneTypeRegistry(DEFAULT_TYPE_REGISTRY),
    rolesRegistry: { roles: [] },
    rulesTemplate: DEFAULT_RULES_TEMPLATE
  }
};
var TENT_ICON = `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M50 14 88 82H12L50 14Z"/><path d="M50 14v68"/><path d="M50 82 35 56"/><path d="M50 82l15-26"/><path d="M22 82h56"/><circle cx="50" cy="14" r="4" fill="currentColor" stroke="none"/><circle cx="22" cy="82" r="4" fill="currentColor" stroke="none"/><circle cx="78" cy="82" r="4" fill="currentColor" stroke="none"/></svg>`;
var TentPlugin = class extends import_obsidian5.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.lastPending = null;
  }
  async onload() {
    await this.loadSettings();
    (0, import_obsidian5.addIcon)("tent", TENT_ICON);
    this.registerView(TENT_VIEW_TYPE, (leaf) => new TentView(leaf, this));
    this.addRibbonIcon("tent", "\u6253\u5F00\u5E37\u5E44\u9762\u677F", () => this.activateView());
    this.addCommand({
      id: "open-tent-panel",
      name: "\u6253\u5F00\u5E37\u5E44\u9762\u677F",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "open-tent-board-experimental",
      name: "\u6253\u5F00/\u5237\u65B0\u767D\u677F(\u5B9E\u9A8C)",
      callback: async () => {
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(TENT_VIEW_TYPE)[0];
        const view = leaf?.view;
        if (view) await view.openBoard();
      }
    });
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("tent-status");
    this.statusEl.onClickEvent(() => this.activateView());
    this.updateStatus(0);
    this.addSettingTab(new TentSettingTab(this.app, this));
  }
  onunload() {
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(TENT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: TENT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
  updateStatus(pending) {
    if (!this.statusEl) return;
    const previous = this.lastPending;
    this.lastPending = pending;
    if (this.settings.triageReminder === "off") {
      this.statusEl.hide();
      return;
    }
    this.statusEl.show();
    this.statusEl.empty();
    this.statusEl.createSpan({ text: "\u26FA " });
    this.statusEl.createSpan({
      text: pending > 0 ? `${pending} \u5F85\u88C1` : "\u5E10\u5185\u65E0\u4E8B",
      cls: pending > 0 ? "tent-status-hot" : "tent-status-calm"
    });
    if (this.settings.triageReminder === "notice" && previous !== null && pending > previous) {
      new import_obsidian5.Notice(`Tent \u65B0\u589E ${pending - previous} \u9879\u5F85\u88C1`);
    }
  }
  refreshStatusPreference() {
    this.updateStatus(this.lastPending ?? 0);
  }
  async loadSettings() {
    this.settings = mergeSettings(await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(TENT_VIEW_TYPE)) {
      leaf.view.refreshAppearance();
    }
  }
};
var TentSettingTab = class extends import_obsidian5.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.openType = null;
    this.openRole = null;
    this.pendingReset = null;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("tent-settings");
    containerEl.createEl("h2", { text: "\u5E37\u5E44 / Tent" });
    containerEl.createEl("h3", { text: "\u5E10" });
    new import_obsidian5.Setting(containerEl).setName("\u5E10\u6839\u76EE\u5F55").setDesc("vault \u5185\u5B58\u653E\u5404\u5E10\u7684\u6587\u4EF6\u5939\u3002Tent \u4FDD\u5B58\u4E0A\u4E0B\u6587\u4E0E\u72B6\u6001\uFF0C\u672C\u8EAB\u4E0D\u4F7F\u7528 Git\u3002").addText(
      (t) => t.setValue(this.plugin.settings.tentsRoot).onChange(async (v) => {
        this.plugin.settings.tentsRoot = v.trim() || "tents";
        await this.plugin.saveSettings();
      })
    );
    this.drawNewTentDefaults(containerEl);
    containerEl.createEl("h3", { text: "\u5916\u89C2" });
    new import_obsidian5.Setting(containerEl).setName("\u914D\u8272\u6A21\u5F0F").setDesc("\u8DDF\u968F Obsidian\uFF0C\u6216\u56FA\u5B9A\u4F7F\u7528 Tent \u7684\u6D45\u8272 / \u6DF1\u8272\u914D\u8272\u3002").addDropdown(
      (dropdown) => dropdown.addOption("follow", "\u8DDF\u968F Obsidian").addOption("light", "\u6D45\u8272").addOption("dark", "\u6DF1\u8272").setValue(this.plugin.settings.appearance).onChange(async (value) => {
        this.plugin.settings.appearance = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
    containerEl.createEl("h3", { text: "\u4EA4\u4E92" });
    new import_obsidian5.Setting(containerEl).setName("\u6D3E\u6D3B\u81EA\u52A8\u590D\u5236 prompt").setDesc("dispatch \u6210\u529F\u540E\u628A\u63A5\u529B prompt \u590D\u5236\u5230\u526A\u8D34\u677F\u3002").addToggle(
      (t) => t.setValue(this.plugin.settings.dispatchPrefs.copyPromptToClipboard).onChange(async (v) => {
        this.plugin.settings.dispatchPrefs.copyPromptToClipboard = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("\u5F85\u88C1\u63D0\u9192").setDesc("\u63A7\u5236\u662F\u5426\u5728 Obsidian \u72B6\u6001\u680F\u663E\u793A\u5F85\u88C1\u6570\uFF0C\u4EE5\u53CA\u65B0\u589E\u5F85\u88C1\u65F6\u662F\u5426\u901A\u77E5\u3002").addDropdown(
      (dropdown) => dropdown.addOption("off", "\u5173\u95ED").addOption("status", "\u4EC5\u72B6\u6001\u680F").addOption("notice", "\u72B6\u6001\u680F\u4E0E\u901A\u77E5").setValue(this.plugin.settings.triageReminder).onChange(async (value) => {
        this.plugin.settings.triageReminder = value;
        await this.plugin.saveSettings();
        this.plugin.refreshStatusPreference();
      })
    );
  }
  drawNewTentDefaults(parent) {
    parent.createEl("h3", { text: "\u65B0\u5EFA Tent \u9ED8\u8BA4\u503C" });
    parent.createEl("p", {
      cls: "setting-item-description tent-settings-intro",
      text: "\u7528\u4E8E\u4E4B\u540E\u65B0\u5EFA\u7684 Tent\uFF0C\u4E0D\u8986\u76D6\u5DF2\u6709 Tent\u3002"
    });
    this.drawDefaultTypes(parent);
    this.drawDefaultRoles(parent);
    parent.createEl("h4", { text: "\u9ED8\u8BA4 RULES.md" });
    new import_obsidian5.Setting(parent).setName("\u89C4\u5219\u6A21\u677F").setDesc("\u65B0\u5EFA Tent \u65F6\u5199\u5165 RULES.md\uFF1B{tent} \u4F1A\u66FF\u6362\u4E3A\u5E10\u540D\u3002").addTextArea((textarea) => {
      textarea.setValue(this.plugin.settings.newTentDefaults.rulesTemplate).onChange(async (value) => {
        this.plugin.settings.newTentDefaults.rulesTemplate = value || DEFAULT_RULES_TEMPLATE;
        await this.plugin.saveSettings();
      });
      textarea.inputEl.addClass("tent-settings-rules");
    });
  }
  drawDefaultTypes(parent) {
    const registry = this.plugin.settings.newTentDefaults.typeRegistry;
    const title = new import_obsidian5.Setting(parent).setName("\u9ED8\u8BA4 Type");
    title.setDesc("\u5185\u7F6E\u540D\u79F0\u56FA\u5B9A\uFF1B\u989C\u8272\u3001R/W \u4E0E\u63CF\u8FF0\u53EF\u6539\u3002");
    title.addButton((button) => {
      const pending = this.pendingReset === "types";
      button.setButtonText(pending ? "\u786E\u8BA4\u6062\u590D" : "\u6062\u590D\u9ED8\u8BA4").setWarning().onClick(async () => {
        if (!pending) {
          this.pendingReset = "types";
          this.display();
          return;
        }
        this.plugin.settings.newTentDefaults.typeRegistry = cloneTypeRegistry(DEFAULT_TYPE_REGISTRY);
        this.pendingReset = null;
        this.openType = null;
        await this.plugin.saveSettings();
        this.display();
      });
    });
    this.drawTypeTier(parent, registry, "base", "\u4E00\u7EA7");
    this.drawTypeTier(parent, registry, "modifier", "\u4E8C\u7EA7");
  }
  drawTypeTier(parent, registry, tier, label) {
    const section = parent.createDiv({ cls: "tent-settings-registry" });
    new import_obsidian5.Setting(section).setName(label);
    this.drawAddType(section, tier, label);
    for (const [name, definition] of Object.entries(registry)) {
      if ((definition.tier ?? "base") !== tier) continue;
      const row = section.createDiv({ cls: "tent-settings-registry-item" });
      const summary = new import_obsidian5.Setting(row).setName(name).setDesc(definition.description || "");
      const color = summary.controlEl.createSpan({ cls: "tent-settings-color-dot" });
      color.style.backgroundColor = typeColorValue(definition.color);
      summary.controlEl.createSpan({
        cls: "tent-settings-rw-summary",
        text: `${axisSummary("R", definition.readable)} \xB7 ${axisSummary("W", definition.writable)}`
      });
      summary.addButton(
        (button) => button.setIcon("settings").setTooltip(`\u7F16\u8F91 ${name}`).onClick(() => {
          this.openType = this.openType === name ? null : name;
          this.display();
        })
      );
      if (this.openType === name) this.drawTypeEditor(row, name, definition);
    }
  }
  drawTypeEditor(parent, name, definition) {
    const editor = parent.createDiv({ cls: "tent-settings-editor" });
    new import_obsidian5.Setting(editor).setName("\u63CF\u8FF0").addText(
      (text) => text.setValue(definition.description || "").onChange(async (value) => {
        setOptionalText(definition, "description", value);
        await this.plugin.saveSettings();
      })
    );
    this.drawColorControl(editor, definition.color, async (color) => {
      definition.color = color;
      await this.plugin.saveSettings();
      this.display();
    });
    this.drawAxisControl(editor, definition);
    if (!BUILTIN_TYPES.has(name)) {
      new import_obsidian5.Setting(editor).setName("\u5220\u9664\u9ED8\u8BA4 type").setDesc("\u53EA\u5F71\u54CD\u4E4B\u540E\u65B0\u5EFA\u7684 Tent\u3002").addButton(
        (button) => button.setButtonText("\u5220\u9664").setWarning().onClick(async () => {
          delete this.plugin.settings.newTentDefaults.typeRegistry[name];
          this.openType = null;
          await this.plugin.saveSettings();
          this.display();
        })
      );
    }
  }
  drawAxisControl(parent, definition) {
    const tier = definition.tier ?? "base";
    const setting = new import_obsidian5.Setting(parent).setName("R/W");
    for (const [axis, label] of [["readable", "R"], ["writable", "W"]]) {
      setting.controlEl.createSpan({ cls: "tent-settings-axis-label", text: label });
      setting.addDropdown((dropdown) => {
        if (tier === "modifier") dropdown.addOption("inherit", "\u7EE7\u627F");
        dropdown.addOption("on", "\u5F00").addOption("off", "\u5173").setValue(axisValue(definition[axis], tier)).onChange(async (value) => {
          setTypeAxis(definition, axis, value);
          await this.plugin.saveSettings();
          this.display();
        });
      });
    }
  }
  drawAddType(parent, tier, label) {
    let name = "";
    const form = new import_obsidian5.Setting(parent).setName(`\u65B0\u5EFA${label}`).setDesc("\u521B\u5EFA\u540E\u540D\u79F0\u4E0D\u53EF\u4FEE\u6539\u3002");
    form.settingEl.addClass("tent-settings-add-row");
    form.addText((text) => text.setPlaceholder("name").onChange((value) => {
      name = value;
    }));
    form.addButton(
      (button) => button.setButtonText("\u65B0\u5EFA").setCta().onClick(async () => {
        const normalized = name.trim();
        if (!validRegistryName(normalized)) {
          new import_obsidian5.Notice("type \u540D\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u4E14\u4E0D\u80FD\u5305\u542B\u7A7A\u683C\u6216\u8FDE\u5B57\u7B26");
          return;
        }
        const registry = this.plugin.settings.newTentDefaults.typeRegistry;
        if (registry[normalized]) {
          new import_obsidian5.Notice(`type \u5DF2\u5B58\u5728\uFF1A${normalized}`);
          return;
        }
        registry[normalized] = tier === "base" ? { tier: "base", readable: true, writable: false, color: "gray" } : { tier: "modifier", color: "gray" };
        this.openType = normalized;
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
  drawDefaultRoles(parent) {
    const roles = this.plugin.settings.newTentDefaults.rolesRegistry.roles;
    const title = new import_obsidian5.Setting(parent).setName("\u9ED8\u8BA4 Role");
    title.setDesc("\u65B0\u5E10\u521D\u59CB\u53EF\u7528\u7684 role\uFF1B\u540D\u79F0\u521B\u5EFA\u540E\u4E0D\u53EF\u4FEE\u6539\u3002");
    title.addButton((button) => {
      const pending = this.pendingReset === "roles";
      button.setButtonText(pending ? "\u786E\u8BA4\u6E05\u7A7A" : "\u6E05\u7A7A").setWarning().onClick(async () => {
        if (!pending) {
          this.pendingReset = "roles";
          this.display();
          return;
        }
        this.plugin.settings.newTentDefaults.rolesRegistry = { roles: [] };
        this.pendingReset = null;
        this.openRole = null;
        await this.plugin.saveSettings();
        this.display();
      });
    });
    const section = parent.createDiv({ cls: "tent-settings-registry" });
    this.drawAddRole(section);
    for (const role of roles) {
      const row = section.createDiv({ cls: "tent-settings-registry-item" });
      const summary = new import_obsidian5.Setting(row).setName(role.name).setDesc(role.description || "");
      const color = summary.controlEl.createSpan({ cls: "tent-settings-color-dot" });
      color.style.backgroundColor = typeColorValue(role.color);
      summary.addButton(
        (button) => button.setIcon("settings").setTooltip(`\u7F16\u8F91 ${role.name}`).onClick(() => {
          this.openRole = this.openRole === role.name ? null : role.name;
          this.display();
        })
      );
      if (this.openRole === role.name) this.drawRoleEditor(row, role);
    }
  }
  drawRoleEditor(parent, role) {
    const editor = parent.createDiv({ cls: "tent-settings-editor" });
    new import_obsidian5.Setting(editor).setName("\u63CF\u8FF0").addText(
      (text) => text.setValue(role.description || "").onChange(async (value) => {
        setOptionalText(role, "description", value);
        await this.plugin.saveSettings();
      })
    );
    this.drawColorControl(editor, role.color, async (color) => {
      role.color = color;
      await this.plugin.saveSettings();
      this.display();
    });
    new import_obsidian5.Setting(editor).setName("prompt").addTextArea((textarea) => {
      textarea.setValue(role.prompt || "").onChange(async (value) => {
        setOptionalText(role, "prompt", value);
        await this.plugin.saveSettings();
      });
      textarea.inputEl.addClass("tent-settings-role-prompt");
    });
    new import_obsidian5.Setting(editor).setName("\u5220\u9664\u9ED8\u8BA4 role").addButton(
      (button) => button.setButtonText("\u5220\u9664").setWarning().onClick(async () => {
        const roles = this.plugin.settings.newTentDefaults.rolesRegistry.roles;
        this.plugin.settings.newTentDefaults.rolesRegistry.roles = roles.filter((item) => item.name !== role.name);
        this.openRole = null;
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
  drawAddRole(parent) {
    let name = "";
    const form = new import_obsidian5.Setting(parent).setName("\u65B0\u5EFA Role").setDesc("\u521B\u5EFA\u540E\u540D\u79F0\u4E0D\u53EF\u4FEE\u6539\u3002");
    form.settingEl.addClass("tent-settings-add-row");
    form.addText((text) => text.setPlaceholder("name").onChange((value) => {
      name = value;
    }));
    form.addButton(
      (button) => button.setButtonText("\u65B0\u5EFA").setCta().onClick(async () => {
        const normalized = name.trim();
        if (!validRegistryName(normalized)) {
          new import_obsidian5.Notice("role \u540D\u4E0D\u80FD\u4E3A\u7A7A\uFF0C\u4E14\u4E0D\u80FD\u5305\u542B\u7A7A\u683C\u6216\u8FDE\u5B57\u7B26");
          return;
        }
        const roles = this.plugin.settings.newTentDefaults.rolesRegistry.roles;
        if (roles.some((role) => role.name === normalized)) {
          new import_obsidian5.Notice(`role \u5DF2\u5B58\u5728\uFF1A${normalized}`);
          return;
        }
        roles.push({ name: normalized, color: "gray" });
        this.openRole = normalized;
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
  drawColorControl(parent, current, onChange) {
    const setting = new import_obsidian5.Setting(parent).setName("\u989C\u8272");
    const palette = setting.controlEl.createDiv({ cls: "tent-settings-palette" });
    for (const color of TYPE_COLOR_PALETTE) {
      const swatch = palette.createEl("button", {
        cls: `tent-settings-swatch${color === current ? " is-active" : ""}`,
        attr: { type: "button", "aria-label": color }
      });
      swatch.style.backgroundColor = typeColorValue(color);
      swatch.onclick = () => void onChange(color);
    }
  }
};
var BUILTIN_TYPES = new Set(Object.keys(DEFAULT_TYPE_REGISTRY));
function cloneTypeRegistry(registry) {
  return Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, { ...definition }]));
}
function cloneRolesRegistry(registry) {
  return { roles: registry.roles.map((role) => ({ ...role })) };
}
function normalizeRoles(value) {
  if (typeof value !== "object" || value === null) return cloneRolesRegistry(DEFAULT_ROLES_REGISTRY2);
  const raw = value;
  if (!Array.isArray(raw.roles)) return cloneRolesRegistry(DEFAULT_ROLES_REGISTRY2);
  const roles = [];
  for (const item of raw.roles) {
    if (typeof item !== "object" || item === null) continue;
    const source = item;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name || roles.some((role2) => role2.name === name)) continue;
    const role = { name };
    if (typeof source.color === "string" && source.color.trim()) role.color = source.color.trim();
    if (typeof source.description === "string" && source.description.trim()) role.description = source.description.trim();
    if (typeof source.prompt === "string" && source.prompt.trim()) role.prompt = source.prompt.trim();
    roles.push(role);
  }
  return { roles };
}
function axisSummary(label, value) {
  return `${label}${value === void 0 ? "\u7EE7\u627F" : value ? "\u5F00" : "\u5173"}`;
}
function axisValue(value, tier) {
  if (tier === "modifier" && value === void 0) return "inherit";
  return value ? "on" : "off";
}
function setTypeAxis(definition, axis, value) {
  const record = definition;
  if (value === "inherit" && definition.tier === "modifier") delete record[axis];
  else record[axis] = value === "on";
}
function setOptionalText(target, key, value) {
  const text = value.trim();
  if (text) target[key] = text;
  else delete target[key];
}
function validRegistryName(name) {
  return !!name && name !== "temp" && !/[\s/\\-]/.test(name);
}
function mergeSettings(raw) {
  const saved = typeof raw === "object" && raw !== null ? raw : {};
  const appearance = saved.appearance === "follow" || saved.appearance === "light" || saved.appearance === "dark" ? saved.appearance : saved.appearance === "warm" ? "light" : DEFAULT_SETTINGS.appearance;
  const legacyDefaults = saved.newTentTemplate;
  const defaults = saved.newTentDefaults;
  const typeRegistry = normalizeRegistry(defaults?.typeRegistry ?? legacyDefaults?.typeRegistry ?? DEFAULT_TYPE_REGISTRY);
  const rolesRegistry = normalizeRoles(defaults?.rolesRegistry ?? legacyDefaults?.rolesRegistry ?? DEFAULT_ROLES_REGISTRY2);
  const rulesCandidate = defaults?.rulesTemplate ?? legacyDefaults?.rulesTemplate;
  const rulesTemplate = typeof rulesCandidate === "string" && rulesCandidate.trim() ? rulesCandidate : DEFAULT_RULES_TEMPLATE;
  const triageReminder = saved.triageReminder === "off" || saved.triageReminder === "status" || saved.triageReminder === "notice" ? saved.triageReminder : DEFAULT_SETTINGS.triageReminder;
  return {
    tentsRoot: typeof saved.tentsRoot === "string" && saved.tentsRoot.trim() ? saved.tentsRoot : DEFAULT_SETTINGS.tentsRoot,
    activeTent: typeof saved.activeTent === "string" ? saved.activeTent : "",
    appearance,
    dispatchPrefs: {
      ...DEFAULT_SETTINGS.dispatchPrefs,
      ...saved.dispatchPrefs ?? {}
    },
    triageReminder,
    newTentDefaults: {
      typeRegistry,
      rolesRegistry,
      rulesTemplate
    }
  };
}
