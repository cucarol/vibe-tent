#!/usr/bin/env node


// src/service/cli.ts
import * as path8 from "node:path";

// src/service/http-server.ts
import * as http from "node:http";

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
async function backupCorruptRegistry(fs9, path9) {
  const backupPath = `${path9}.corrupt-${timestamp()}`;
  await fs9.writeFile(backupPath, await fs9.readFile(path9));
  return backupPath;
}
function warnRegistryRecovered(path9, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path9} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
  );
}
function timestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}

// src/core/paths.ts
var TENT_SYSTEM_DIR = ".tent";
var TYPE_REGISTRY_PATH = "types.json";
var ROLES_REGISTRY_PATH = "roles.json";
var TAGS_REGISTRY_PATH = "tags.json";
var ORDER_PATH = "order.json";
var MUTATION_LOCK_PATH = "mutation.lock";
var RULES_PATH = "RULES.md";
var TEMP_DIR = "temp";
var ATTACHMENTS_DIR = "attachments";
var OPERATIONAL_TOP_LEVEL = /* @__PURE__ */ new Set([
  TEMP_DIR,
  ATTACHMENTS_DIR,
  // 历史残留：若仍见嵌套 .tent，视为系统区而非 concept
  TENT_SYSTEM_DIR
]);
var SYSTEM_REGISTRY_FILES = /* @__PURE__ */ new Set([
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
  ORDER_PATH,
  MUTATION_LOCK_PATH,
  RULES_PATH,
  "index.md",
  "log.md"
]);
function systemRootFromWorkspace(workspaceRoot) {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const sep2 = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${sep2}${TENT_SYSTEM_DIR}`;
}
function isOperationalPath(relativePath2) {
  const path9 = relativePath2.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path9) return false;
  const top = path9.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}

// src/core/order.ts
var ROOT_KEY = "__root__";
async function loadOrder(fs9) {
  if (!await fs9.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs9.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs9, ORDER_PATH);
    await saveOrder(fs9, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs9, map) {
  await fs9.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
var DEFAULT_TYPE_REGISTRY = {
  note: {
    readable: true,
    writable: true,
    color: "gray",
    tier: "base",
    coordination: false,
    description: "\u666E\u901A\u7B14\u8BB0 concept\uFF0C\u9ED8\u8BA4\u4E0D\u8FDB\u5165\u534F\u4F5C\u751F\u547D\u5468\u671F"
  },
  goal: {
    readable: true,
    writable: false,
    color: "blue",
    tier: "base",
    coordination: true,
    description: "\u5B9A\u4E49\u76EE\u6807\u3001\u610F\u56FE\u4E0E\u9A8C\u6536\u65B9\u5411"
  },
  prompt: {
    readable: true,
    writable: true,
    color: "purple",
    tier: "base",
    coordination: true,
    description: "\u63D0\u4F9B\u4EFB\u52A1\u8BF4\u660E\u4E0E\u5DE5\u4F5C\u4E0A\u4E0B\u6587"
  },
  artifact: {
    readable: true,
    writable: true,
    color: "cyan",
    tier: "base",
    coordination: true,
    description: "\u6620\u5C04\u771F\u5B9E\u4EA4\u4ED8\u7269\u4E0E ArtifactRef \u5173\u8054"
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
function canonicalTypeName(type) {
  if (type === "output") return "artifact";
  if (type.startsWith("output-")) return "artifact" + type.slice("output".length);
  return type;
}
function typeExists(type, registry) {
  const canonical = canonicalTypeName(type);
  if (registry[canonical] || registry[type]) return true;
  const { base, modifier } = splitType(canonical);
  return !!(registry[base] && (modifier === void 0 || !!registry[modifier]));
}
function resolveTypeAxis(type, axis, registry) {
  const canonical = canonicalTypeName(type);
  const exact = registry[canonical] ?? registry[type];
  if (exact) return exact[axis];
  const { base, modifier } = splitType(canonical);
  const baseVal = registry[base]?.[axis];
  const modVal = modifier ? registry[modifier]?.[axis] : void 0;
  return typeof modVal === "boolean" ? modVal : baseVal;
}
function typeHasCoordination(type, registry) {
  const canonical = canonicalTypeName(type);
  const { base } = splitType(canonical);
  return baseDefinitionCoordination(registry[base] ?? registry[canonical] ?? registry[type]) === true;
}
function baseDefinitionCoordination(definition) {
  if (!definition || definition.tier === "modifier") return void 0;
  return definition.coordination;
}
async function loadTypeRegistry(fs9) {
  if (!await fs9.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs9.readFile(TYPE_REGISTRY_PATH));
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
    applyLegacyOutputAlias(registry);
    return registry;
  }
  mergeDefinitions(registry, root);
  applyLegacyOutputAlias(registry);
  return registry;
}
function applyLegacyOutputAlias(registry) {
  if (registry.output && !isRecord(registry.output)) return;
  if (registry.output) {
    const out = registry.output;
    if (out.tier !== "modifier") {
      const artifact = registry.artifact;
      if (artifact && artifact.tier !== "modifier") {
        if (typeof out.readable === "boolean") artifact.readable = out.readable;
        if (typeof out.writable === "boolean") artifact.writable = out.writable;
        if (typeof out.coordination === "boolean") artifact.coordination = out.coordination;
        else if (out.coordination === void 0) artifact.coordination = true;
        if (out.color) artifact.color = out.color;
        if (out.description) artifact.description = out.description;
      }
    }
  }
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
    if (resolvedTier === "modifier") {
      registry[name] = {
        tier: "modifier",
        ...readable !== void 0 ? { readable } : {},
        ...writable !== void 0 ? { writable } : {},
        ...metadata
      };
      continue;
    }
    const coordination = resolveCoordinationFlag(name, raw, current);
    const entry = {
      tier: "base",
      readable,
      writable,
      ...metadata,
      ...coordination !== void 0 ? { coordination } : {}
    };
    delete entry.workspacePointer;
    registry[name] = entry;
  }
}
function resolveCoordinationFlag(name, raw, current) {
  if (typeof raw.coordination === "boolean") return raw.coordination;
  if (current && current.tier !== "modifier" && typeof current.coordination === "boolean") {
    return current.coordination;
  }
  if (name === "note") return false;
  if (name === "goal" || name === "prompt" || name === "artifact" || name === "output") return true;
  return void 0;
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
var ZONE_NAMES = ["goal", "prompt", "artifact", "output", "note"];
function boxNotePath(boxPath) {
  return join(boxPath, baseName(boxPath) + ".md");
}
async function loadTent(fs9) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs9);
  const top = await fs9.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadBoxInto(fs9, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs9);
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
async function loadBox(fs9, path9, parent, registry) {
  if (isOperationalPath(path9)) return null;
  const boxFile = boxNotePath(path9);
  if (!await fs9.exists(boxFile)) {
    return null;
  }
  const raw = await fs9.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path9);
  const zone = parent ? parent.zone : zoneOf(name);
  const { fm, tags } = normalizeIdentity(data);
  const box = {
    id: fm.id,
    type: fm.type,
    tags,
    coordination: false,
    // filled in resolveSubtree
    archived: false,
    invalid: !!parseError,
    path: path9,
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
    box.invalidRootId = path9;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs9.listDir(path9);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs9, join(path9, entry.name), box, registry, box.children);
  }
  return box;
}
function normalizeIdentity(data) {
  const rawType = typeof data.type === "string" && data.type ? data.type : "custom";
  const fm = {
    ...data,
    id: typeof data.id === "string" ? data.id : "",
    type: rawType
  };
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
async function loadBoxInto(fs9, path9, parent, registry, target) {
  if (isOperationalPath(path9)) return;
  const box = await loadBox(fs9, path9, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs9.listDir(path9);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs9, join(path9, entry.name), parent, registry, target);
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
  box.coordination = !box.invalid && typeHasCoordination(box.type, registry);
  if (box.fm.status !== "todo" && box.fm.status !== "doing" && box.fm.status !== "done") {
    delete box.fm.status;
  }
  if (!box.coordination) {
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
function baseName(path9) {
  const i = path9.lastIndexOf("/");
  return i === -1 ? path9 : path9.slice(i + 1);
}
function dirName(path9) {
  const i = path9.lastIndexOf("/");
  return i === -1 ? "" : path9.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs9, action) {
  return fs9.withLock ? fs9.withLock(MUTATION_LOCK_PATH, action) : action();
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
  readable.push({ path: "roles.json", note: "System registry: available roles and persistent prompts." });
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
  if (base === "artifact" || base === "output") return 2;
  if (base === "note") return 3;
  return 4;
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
var CONCEPT_ID_PREFIX = "cx-";
function makeConceptId(rand = Math.random, len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return CONCEPT_ID_PREFIX + s;
}
function makeUniqueConceptId(existing, rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeConceptId(rand);
    if (!existing.has(id)) return id;
  }
  return makeConceptId(rand, 10);
}

// src/core/claim.ts
function canClaim(box) {
  if (box.invalid) return { ok: false, blocker: box, reason: `Invalid subtree: ${box.invalidReason || "missing type definition"}` };
  if (box.archived) return { ok: false, blocker: box, reason: "Archived subtree cannot be claimed." };
  if (!box.coordination) {
    return {
      ok: false,
      blocker: box,
      reason: `Concept ${box.name} has coordination=false and cannot enter the task lifecycle.`
    };
  }
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
function normalizeTagName(name) {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}

// src/core/skillRoleRegistry.ts
var DEFAULT_ROLES_REGISTRY = {
  roles: []
};
async function loadRolesRegistry(fs9) {
  if (!await fs9.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs9.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs9, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs9, ROLES_REGISTRY_PATH, reset);
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
  const root = isRecord2(value) ? value : {};
  const roles = [];
  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord2(item)) continue;
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
  const a2a = normalizeA2APolicy(value.a2aPolicy);
  if (a2a) role.a2aPolicy = a2a;
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}
function roleA2APolicy(role) {
  return role?.a2aPolicy ?? "deny";
}
function normalizeA2APolicy(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return void 0;
}
function normalizeCliConfig(value) {
  if (value === void 0) return void 0;
  if (!isRecord2(value)) throw new Error("role.cli must be an object.");
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
async function writeJson(fs9, path9, value) {
  if (!await fs9.exists(".tent")) await fs9.mkdir(".tent");
  await fs9.writeFile(path9, JSON.stringify(value, null, 2) + "\n");
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/task-model.ts
function stateToLegacyStatus(state) {
  return state === "queued" ? "pending" : "taken";
}
function legacyStatusToState(status) {
  return status === "pending" ? "queued" : "running";
}
function makeTaskId(rand = Math.random, len = 8) {
  const stem = makeConceptId(rand, len).slice(3);
  return `tk-${stem}`;
}
function makeDeliveryId(rand = Math.random, len = 8) {
  const stem = makeConceptId(rand, len).slice(3);
  return `dl-${stem}`;
}
function isTaskId(id) {
  return id.startsWith("tk-") && id.length > 3;
}
function isDeliveryId(id) {
  return id.startsWith("dl-") && id.length > 3;
}
var TaskLifecycleError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "TaskLifecycleError";
  }
};
function assertTransition(from, event, to) {
  const ok = allowedTransitions(from).some((t) => t.event === event && t.to === to);
  if (!ok) {
    throw new TaskLifecycleError(
      "INVALID_TRANSITION",
      `Invalid task transition: ${from} --${event}\u2192 ${to}`
    );
  }
}
function allowedTransitions(from) {
  switch (from) {
    case "queued":
      return [
        { event: "claim", to: "running" },
        { event: "cancel", to: "interrupted" },
        { event: "interrupt", to: "interrupted" }
      ];
    case "running":
      return [
        { event: "wait", to: "waiting" },
        { event: "deliver", to: "delivered" },
        { event: "interrupt", to: "interrupted" },
        { event: "fail", to: "failed" }
      ];
    case "waiting":
      return [
        { event: "resume", to: "running" },
        { event: "interrupt", to: "interrupted" },
        { event: "fail", to: "failed" }
      ];
    case "delivered":
      return [
        { event: "accept", to: "accepted" },
        { event: "reject-resume", to: "running" },
        { event: "reject-terminal", to: "rejected" },
        { event: "interrupt", to: "interrupted" }
      ];
    case "rejected":
      return [];
    default:
      return [];
  }
}
function resolveDeliverRouting(policy, decision) {
  if (policy === "bypass") {
    return { autoIntegrate: true, integrationMode: "bypass-auto", enterDelivered: false };
  }
  if (policy === "manual") {
    if (decision === "integrate") {
      throw new TaskLifecycleError(
        "POLICY_FORBIDS_AUTO_INTEGRATE",
        "deliveryPolicy=manual forbids decision=integrate; use request-review or change policy."
      );
    }
    return { autoIntegrate: false, integrationMode: null, enterDelivered: true };
  }
  if (!decision) {
    throw new TaskLifecycleError(
      "DECISION_REQUIRED",
      "deliveryPolicy=agent-decide requires decision: integrate | request-review."
    );
  }
  if (decision === "integrate") {
    return {
      autoIntegrate: true,
      integrationMode: "agent-decided-integrate",
      enterDelivered: false
    };
  }
  return { autoIntegrate: false, integrationMode: null, enterDelivered: true };
}
function assertNotSelfAccept(actor, submitterRole) {
  if (actor.trim() === submitterRole.trim()) {
    throw new TaskLifecycleError(
      "SELF_ACCEPT_FORBIDDEN",
      `task.accept actor must not equal delivery submitter (${submitterRole}).`
    );
  }
}
function evaluateA2A(input) {
  if (input.callerKind === "user") return "allow";
  const policy = input.policy ?? "deny";
  if (policy === "deny") return "deny";
  if (policy === "ask") return "ask";
  if (input.profileAllowed === false) return "deny";
  return "allow";
}

// src/core/task.ts
async function loadTaskEnvelopes(fs9) {
  const tasks = [];
  if (!await fs9.exists("temp")) return tasks;
  for (const roleEntry of await fs9.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    const taskDir = join("temp", roleEntry.name, "tasks");
    if (!await fs9.exists(taskDir)) continue;
    for (const entry of await fs9.listDir(taskDir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path9 = join(taskDir, entry.name);
      try {
        tasks.push(await loadTaskEnvelope(fs9, path9));
      } catch {
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function loadTaskEnvelope(fs9, path9) {
  if (!await fs9.exists(path9)) throw new Error(`Task envelope not found: ${path9}.`);
  const { data, body } = parseFrontmatter(await fs9.readFile(path9));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
    throw new Error(`Invalid task envelope format: ${path9}.`);
  }
  const legacyStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);
  const task = {
    path: path9,
    role: data.role,
    claims: data.claims,
    manifest: data.manifest,
    status: stateToLegacyStatus(state),
    state,
    prompt: body.trim() || void 0
  };
  if (typeof data.id === "string" && isTaskId(data.id)) task.id = data.id;
  if (typeof data.dispatchedBy === "string") task.dispatchedBy = data.dispatchedBy;
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (isDeliveryPolicy(data.deliveryPolicy)) task.deliveryPolicy = data.deliveryPolicy;
  if (data.assigneeKind === "role" || data.assigneeKind === "agentProfile") {
    task.assigneeKind = data.assigneeKind;
  }
  if (typeof data.sessionId === "string") task.sessionId = data.sessionId;
  if (typeof data.activeDeliveryId === "string") task.activeDeliveryId = data.activeDeliveryId;
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}
function resolveTaskPromptRoots(roots) {
  if (typeof roots !== "string") {
    return {
      workspaceRoot: roots.workspaceRoot,
      systemRoot: roots.systemRoot
    };
  }
  const systemRoot = roots;
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  const workspaceRoot = base === ".tent" ? normalized.replace(/[\\/]+[^\\/]+$/, "") || systemRoot : systemRoot;
  return { workspaceRoot, systemRoot };
}
function formatTaskPathHints(task, roots) {
  const initCli = join("temp", task.role, "init.md");
  const initFile = join(".tent", "temp", task.role, "init.md");
  const taskFile = join(".tent", task.path);
  return `workspaceRoot: ${roots.workspaceRoot}
systemRoot: ${roots.systemRoot}
CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent), e.g. ${task.path}.
File reads: use ${taskFile} (workspace-relative) or ${roots.systemRoot.replace(/[\\/]+$/, "")}/${task.path} \u2014 never <workspaceRoot>/temp.
Role init file: ${initFile} (CLI path remains ${initCli}).`;
}
function relayPromptForTask(task, roots) {
  const resolved = resolveTaskPromptRoots(roots);
  return `A Tent task has been dispatched to role ${task.role}.
${formatTaskPathHints(task, resolved)}
1. Run \`tent task claim ${task.path}\` to take this task (Local Service RPC).
2. Inspect with \`tent task get ${task.path}\` (or read the envelope file), then open the claimed boxes; the box notes contain the task definition.
3. When finished, run \`tent task deliver ${task.path} --summary <text>\` (optional: --commits sha,sha).
4. If this is a new session for this role, complete role init first (read the init file above).`;
}
function extractTaskUserPrompt(task) {
  const body = task.prompt?.trim() || "";
  if (!body) return "";
  const match = body.match(/##\s*User Prompt\s*\r?\n+([\s\S]*?)\s*$/i);
  if (match) return match[1].trim();
  return body;
}
function sessionBootstrapPromptForTask(task, roots) {
  const resolved = resolveTaskPromptRoots(roots);
  const userPrompt = extractTaskUserPrompt(task);
  return `A Tent managed ACP session is ready for role ${task.role}.
${formatTaskPathHints(task, resolved)}
Service status: this task is already claimed (state=${task.state || "running"}).
Managed path: skip Local Service claim/get/deliver CLI steps (tool permissions may deny them).
Your final assistant reply is the report: Local Service will capture it and submit delivery automatically (manual review stays pending; no auto-accept).
Context Card / path pointers above identify the task; optional deeper reads only if tools are allowed.
` + (userPrompt ? `
## User Prompt

${userPrompt}
` : `
## User Prompt

(no user prompt on envelope)
`);
}
async function ensureRoleInit(fs9, role, tentName) {
  const path9 = join("temp", role.name, "init.md");
  const body = `# Role Init

- Tent: ${tentName}
- Rules (CLI / system-root relative): RULES.md
- Rules (workspace file read): .tent/RULES.md
- Role registry (workspace file read): .tent/roles.json (or run \`tent roles\` from workspace root)

## Role Prompt

${role.prompt?.trim() || "(no persistent role prompt)"}

## Operating Model

Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.
Task lifecycle uses \`tent task *\` (Local Service). Do not invent paths as <workspace>/temp \u2014 operational files live under .tent/temp.
`;
  await fs9.writeFile(path9, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path9;
}
async function writeTaskEnvelope(fs9, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs9, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path9 = await uniqueMarkdownPath(fs9, dir, stem);
  const now = clock.now();
  const data = {
    type: "task",
    id,
    status: "pending",
    state: "queued",
    role: input.role,
    assigneeKind: input.assigneeKind ?? "role",
    dispatchedBy: input.dispatchedBy?.trim() || "user",
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath,
    deliveryPolicy: input.deliveryPolicy ?? "manual",
    createdAt: now,
    updatedAt: now
  };
  if (input.sessionId) data.sessionId = input.sessionId;
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
` + (input.id || id ? `- Task id: ${id}
` : "") + `
## User Prompt

${userPrompt}
`;
  await fs9.writeFile(path9, serializeFrontmatter(data, body));
  return path9;
}
async function ackTaskEnvelope(fs9, path9) {
  await patchTaskEnvelope(fs9, path9, {
    status: "taken",
    state: "running"
  });
}
async function patchTaskEnvelope(fs9, path9, patch) {
  if (!await fs9.exists(path9)) throw new Error(`Task envelope not found: ${path9}.`);
  const raw = await fs9.readFile(path9);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path9}.`);
  if (patch.state) {
    data.state = patch.state;
    data.status = stateToLegacyStatus(patch.state);
  } else if (patch.status) {
    data.status = patch.status;
    if (!data.state) data.state = legacyStatusToState(patch.status);
  }
  if (patch.sessionId === null) delete data.sessionId;
  else if (typeof patch.sessionId === "string") data.sessionId = patch.sessionId;
  if (patch.wait === null) {
    delete data.waitReason;
    delete data.waitSummary;
  } else if (patch.wait) {
    data.waitReason = patch.wait.reason;
    data.waitSummary = patch.wait.summary;
  }
  if (patch.activeDeliveryId === null) delete data.activeDeliveryId;
  else if (typeof patch.activeDeliveryId === "string") data.activeDeliveryId = patch.activeDeliveryId;
  if (patch.deliveryPolicy) data.deliveryPolicy = patch.deliveryPolicy;
  if (patch.updatedAt) data.updatedAt = patch.updatedAt;
  for (const key of ["workspace", "worktree", "branch", "targetBranch"]) {
    const value = patch[key];
    if (value === null) delete data[key];
    else if (typeof value === "string") data[key] = value;
  }
  await fs9.writeFile(path9, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs9, path9);
}
function primaryBoxId(task) {
  return task.claims.find((c) => c !== "root");
}
function parseTaskState(value, legacy) {
  if (value === "queued" || value === "running" || value === "waiting" || value === "delivered" || value === "accepted" || value === "rejected" || value === "interrupted" || value === "failed") {
    return value;
  }
  return legacyStatusToState(legacy);
}
function isDeliveryPolicy(value) {
  return value === "manual" || value === "bypass" || value === "agent-decide";
}
function parseWaitFields(data) {
  const reason = data.waitReason;
  const summary = data.waitSummary;
  if ((reason === "user-input" || reason === "a2a-approval" || reason === "review" || reason === "external") && typeof summary === "string") {
    return { reason, summary };
  }
  return void 0;
}
function taskStem(now, claimId) {
  const stamp = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs9, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path9 = join(dir, `${stem}${suffix}.md`);
    if (!await fs9.exists(path9)) return path9;
  }
}
async function ensureDir(fs9, path9) {
  if (!await fs9.exists(path9)) await fs9.mkdir(path9);
}

// src/core/report.ts
async function loadReports(fs9) {
  const reports = [];
  if (!await fs9.exists("temp")) return reports;
  for (const roleDir of await fs9.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!await fs9.exists(dir)) continue;
    for (const entry of await fs9.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path9 = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs9, path9));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs9, inputPath) {
  const path9 = normalizeReportPath(inputPath);
  if (!await fs9.exists(path9)) throw new Error(`Report not found: ${path9}.`);
  const { data, body } = parseFrontmatter(await fs9.readFile(path9));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`Invalid report format: ${path9}.`);
  }
  return {
    path: path9,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function removeReportsForBox(fs9, boxId) {
  for (const report of await loadReports(fs9)) {
    if (report.boxId === boxId && await fs9.exists(report.path)) await fs9.remove(report.path);
  }
}
function normalizeReportPath(input) {
  const path9 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/[bc]x-[^/]+\.md$/.test(path9)) {
    throw new Error("Report must point to temp/<role>/reports/<boxId>.md.");
  }
  return path9;
}
function uniqueCommits(commits) {
  return [...new Set(commits.map((item) => item.trim()).filter(Boolean))];
}

// src/core/scaffold.ts
function validateBoxName(value) {
  const name = value.trim();
  if (!name) throw new Error("Box name cannot be empty.");
  if (name.length > 200) throw new Error("Box name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Box name cannot contain path separators.");
  if (/[\r\n]/.test(name)) throw new Error("Box name cannot contain newlines.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) throw new Error("Box name cannot contain control characters.");
  return name;
}

// src/core/delivery.ts
var KEY_ORDER = [
  "type",
  "id",
  "taskId",
  "boxId",
  "role",
  "status",
  "commits",
  "checksJson",
  "artifactRefsJson",
  "integrationMode",
  "reviewBy",
  "reviewDecision",
  "reviewNote",
  "createdAt",
  "updatedAt"
];
async function createDeliveryUnlocked(fs9, clock, input) {
  const summary = input.summary.trim();
  if (!summary) throw new Error("Delivery summary cannot be empty.");
  const now = clock.now();
  const id = input.id && isDeliveryId(input.id) ? input.id : makeDeliveryId();
  const dir = join("temp", input.role, "deliveries");
  await ensureDir2(fs9, dir);
  const path9 = join(dir, `${id}.md`);
  if (await fs9.exists(path9)) throw new Error(`Delivery already exists: ${path9}.`);
  const record = {
    path: path9,
    id,
    taskId: input.taskId,
    boxId: input.boxId,
    role: input.role,
    status: input.status ?? "ready",
    summary,
    commits: uniqueCommits2(input.commits ?? []),
    checks: input.checks ?? [],
    artifactRefs: input.artifactRefs ?? [],
    integrationMode: input.integrationMode ?? null,
    createdAt: now,
    updatedAt: now
  };
  await writeDelivery(fs9, record);
  return record;
}
async function loadDelivery(fs9, inputPath) {
  const path9 = normalizeDeliveryPath(inputPath);
  if (!await fs9.exists(path9)) throw new Error(`Delivery not found: ${path9}.`);
  const { data, body } = parseFrontmatter(await fs9.readFile(path9));
  if (data.type !== "delivery" || typeof data.id !== "string" || !isDeliveryId(data.id)) {
    throw new Error(`Invalid delivery format: ${path9}.`);
  }
  if (typeof data.taskId !== "string" || typeof data.boxId !== "string" || typeof data.role !== "string") {
    throw new Error(`Invalid delivery format: ${path9}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : void 0;
  const reviewDecision = data.reviewDecision === "accept" || data.reviewDecision === "reject" ? data.reviewDecision : void 0;
  return {
    path: path9,
    id: data.id,
    taskId: data.taskId,
    boxId: data.boxId,
    role: data.role,
    status,
    summary: body.trim(),
    commits: Array.isArray(data.commits) ? uniqueCommits2(data.commits.filter((c) => typeof c === "string")) : [],
    checks: parseJsonArrayField(data.checksJson, parseChecks),
    artifactRefs: parseJsonArrayField(data.artifactRefsJson, parseArtifactRefs),
    integrationMode: parseIntegrationMode(data.integrationMode),
    review: reviewBy && reviewDecision ? {
      by: reviewBy,
      decision: reviewDecision,
      note: typeof data.reviewNote === "string" ? data.reviewNote : void 0
    } : void 0,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : void 0
  };
}
async function loadDeliveries(fs9, filter) {
  const out = [];
  if (!await fs9.exists("temp")) return out;
  for (const roleDir of await fs9.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "deliveries");
    if (!await fs9.exists(dir)) continue;
    for (const entry of await fs9.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      try {
        const d = await loadDelivery(fs9, join(dir, entry.name));
        if (filter?.taskId && d.taskId !== filter.taskId) continue;
        if (filter?.boxId && d.boxId !== filter.boxId) continue;
        out.push(d);
      } catch {
      }
    }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
async function writeDelivery(fs9, record) {
  const data = {
    type: "delivery",
    id: record.id,
    taskId: record.taskId,
    boxId: record.boxId,
    role: record.role,
    status: record.status,
    commits: record.commits,
    checksJson: record.checks.length ? JSON.stringify(record.checks) : void 0,
    artifactRefsJson: record.artifactRefs.length ? JSON.stringify(record.artifactRefs) : void 0,
    integrationMode: record.integrationMode,
    reviewBy: record.review?.by,
    reviewDecision: record.review?.decision,
    reviewNote: record.review?.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
  await fs9.writeFile(record.path, serializeFrontmatter(data, record.summary + "\n", KEY_ORDER));
}
function normalizeDeliveryPath(input) {
  const path9 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path9)) {
    throw new Error("Delivery must point to temp/<role>/deliveries/<dl-id>.md.");
  }
  return path9;
}
function parseDeliveryStatus(value) {
  if (value === "draft" || value === "ready" || value === "accepted" || value === "rejected") return value;
  throw new Error(`Invalid delivery status: ${String(value)}`);
}
function parseIntegrationMode(value) {
  if (value === void 0 || value === null || value === "null") return null;
  if (value === "manual-accept" || value === "bypass-auto" || value === "agent-decided-integrate") {
    return value;
  }
  return null;
}
function parseJsonArrayField(value, parse) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return parse(JSON.parse(value));
  } catch {
    return [];
  }
}
function parseChecks(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item;
    if (typeof o.name !== "string" || typeof o.command !== "string" || typeof o.exitCode !== "number") continue;
    out.push({ name: o.name, command: o.command, exitCode: o.exitCode });
  }
  return out;
}
function parseArtifactRefs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const o = item;
    if (typeof o.kind !== "string" || typeof o.target !== "string") continue;
    if (!["path", "dir", "commit", "url", "other"].includes(o.kind)) continue;
    out.push({
      kind: o.kind,
      target: o.target,
      label: typeof o.label === "string" ? o.label : void 0
    });
  }
  return out;
}
async function ensureDir2(fs9, path9) {
  if (!await fs9.exists(path9)) await fs9.mkdir(path9);
}
function uniqueCommits2(commits) {
  return [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
}

// src/core/task-lifecycle.ts
async function taskClaim(env, taskPath, options = {}) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state === "running" && task.status === "taken") {
      if (options.sessionId) {
        return patchTaskEnvelope(env.fs, taskPath, {
          sessionId: options.sessionId,
          updatedAt: env.clock.now()
        });
      }
      return task;
    }
    assertTransition(task.state, "claim", "running");
    const tent = await loadTent(env.fs);
    const claimedBoxes = task.claims.filter((claimId) => claimId !== "root").map((claimId) => requireBoxById(tent, claimId));
    const previous = claimedBoxes.map((box) => ({
      box,
      owner: box.fm.owner,
      status: box.fm.status,
      acceptedBy: box.fm.acceptedBy
    }));
    for (const box of claimedBoxes) {
      if (!box.coordination) {
        throw new Error(
          `Cannot claim task: ${box.name} has coordination=false (type ${box.type}); ordinary notes cannot enter the task lifecycle.`
        );
      }
      const claimable = canClaim(box);
      if (!claimable.ok) throw new Error(`Cannot claim task: ${claimable.reason || "box cannot be claimed"}`);
    }
    try {
      for (const box of claimedBoxes) {
        await projectAssignee(env.fs, box, task.role, "doing");
      }
      await ackTaskEnvelope(env.fs, taskPath);
      if (options.sessionId) {
        return patchTaskEnvelope(env.fs, taskPath, {
          sessionId: options.sessionId,
          updatedAt: env.clock.now()
        });
      }
      return loadTaskEnvelope(env.fs, taskPath);
    } catch (error) {
      for (const item of previous) {
        await restoreProjection(env.fs, item.box, item.owner, item.status, item.acceptedBy);
      }
      throw error;
    }
  });
}
async function taskWait(env, taskPath, options) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "wait", "waiting");
    const summary = options.summary.trim();
    if (!summary) throw new Error("task.wait requires a non-empty summary.");
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "waiting",
      wait: { reason: options.reason, summary },
      updatedAt: env.clock.now()
    });
  });
}
async function taskResume(env, taskPath) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "resume", "running");
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "running",
      wait: null,
      updatedAt: env.clock.now()
    });
  });
}
async function taskDeliver(env, taskPath, options) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state !== "running") {
      throw new TaskLifecycleError(
        "INVALID_TRANSITION",
        `task.deliver requires state=running (got ${task.state}).`
      );
    }
    const boxId = primaryBoxId(task);
    if (!boxId) throw new Error("task.deliver requires a non-root box claim.");
    const existing = await loadDeliveries(env.fs, { taskId: task.id || taskPath });
    if (existing.some((d) => d.status === "ready")) {
      throw new Error("A delivery is already ready for review; accept or reject it first.");
    }
    const policy = task.deliveryPolicy ?? "manual";
    const routing = resolveDeliverRouting(policy, options.decision);
    const taskId = task.id || taskPath;
    if (routing.autoIntegrate) {
      const pendingCommits = [...new Set((options.commits ?? []).map((c) => c.trim()).filter(Boolean))];
      if (pendingCommits.length > 0) {
        if (!options.integrate) {
          throw new Error("Auto-integrate path requires integrate() when commits are present.");
        }
        await options.integrate(pendingCommits);
      }
      const delivery2 = await createDeliveryUnlocked(env.fs, env.clock, {
        taskId,
        boxId,
        role: task.role,
        summary: options.summary,
        commits: options.commits,
        checks: options.checks,
        artifactRefs: options.artifactRefs,
        status: "accepted",
        integrationMode: routing.integrationMode
      });
      const tent = await loadTent(env.fs);
      const box = requireBoxById(tent, boxId);
      await projectAssignee(env.fs, box, void 0, "done", "service");
      const next2 = await patchTaskEnvelope(env.fs, taskPath, {
        state: "accepted",
        activeDeliveryId: delivery2.id,
        wait: null,
        updatedAt: env.clock.now()
      });
      return { task: next2, delivery: delivery2, autoIntegrated: true };
    }
    const delivery = await createDeliveryUnlocked(env.fs, env.clock, {
      taskId,
      boxId,
      role: task.role,
      summary: options.summary,
      commits: options.commits,
      checks: options.checks,
      artifactRefs: options.artifactRefs,
      status: "ready",
      integrationMode: routing.integrationMode
    });
    assertTransition(task.state, "deliver", "delivered");
    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "delivered",
      activeDeliveryId: delivery.id,
      updatedAt: env.clock.now()
    });
    return { task: next, delivery, autoIntegrated: false };
  });
}
async function taskAccept(env, taskPath, options) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    assertNotSelfAccept(options.actor, delivery.role);
    const commits = options.commits ?? delivery.commits;
    if (commits.length > 0) {
      if (!options.integrate) throw new Error("Delivery contains commits; workspace integration is required.");
      await options.integrate(commits);
    }
    delivery.status = "accepted";
    delivery.integrationMode = "manual-accept";
    delivery.review = { by: options.actor, decision: "accept" };
    delivery.updatedAt = env.clock.now();
    await writeDelivery(env.fs, delivery);
    const tent = await loadTent(env.fs);
    const box = requireBoxById(tent, delivery.boxId);
    await projectAssignee(env.fs, box, void 0, "done", options.actor);
    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: "accepted",
      wait: null,
      updatedAt: env.clock.now()
    });
    return { task: next, delivery };
  });
}
async function taskReject(env, taskPath, options) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    const resume = options.resume !== false;
    const event = resume ? "reject-resume" : "reject-terminal";
    const to = resume ? "running" : "rejected";
    assertTransition(task.state, event, to);
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    if (options.actor.trim() === delivery.role.trim()) {
      throw new TaskLifecycleError(
        "SELF_ACCEPT_FORBIDDEN",
        `task.reject actor must not equal delivery submitter (${delivery.role}).`
      );
    }
    delivery.status = "rejected";
    delivery.review = {
      by: options.actor,
      decision: "reject",
      note: options.note?.trim() || "Rejected; waiting for resubmission."
    };
    delivery.updatedAt = env.clock.now();
    await writeDelivery(env.fs, delivery);
    if (!resume) {
      const tent = await loadTent(env.fs);
      const box = requireBoxById(tent, delivery.boxId);
      await projectAssignee(env.fs, box, void 0, "todo");
    }
    const next = await patchTaskEnvelope(env.fs, taskPath, {
      state: to,
      // Keep activeDeliveryId for history; new deliver checks ready-only.
      updatedAt: env.clock.now()
    });
    return { task: next, delivery };
  });
}
async function taskInterrupt(env, taskPath) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state === "queued") {
      assertTransition(task.state, "interrupt", "interrupted");
      await env.fs.remove(taskPath);
      return { ...task, state: "interrupted", status: "taken" };
    }
    assertTransition(task.state, "interrupt", "interrupted");
    const tent = await loadTent(env.fs);
    for (const claimId of task.claims) {
      if (claimId === "root") continue;
      const box = tent.byId.get(claimId);
      if (!box) continue;
      await projectAssignee(env.fs, box, void 0, "todo");
      await removeReportsForBox(env.fs, box.id);
    }
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "interrupted",
      wait: null,
      updatedAt: env.clock.now()
    });
  });
}
async function taskCancel(env, taskPath) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "cancel", "interrupted");
    await env.fs.remove(taskPath);
  });
}
async function requireActiveReadyDelivery(fs9, task) {
  if (task.activeDeliveryId) {
    const byId = (await loadDeliveries(fs9, { taskId: task.id || task.path })).find(
      (d) => d.id === task.activeDeliveryId
    );
    if (byId && byId.status === "ready") return byId;
    if (byId) {
    }
  }
  const ready = (await loadDeliveries(fs9, { taskId: task.id || task.path })).find((d) => d.status === "ready");
  if (!ready) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No ready delivery for this task.");
  }
  return ready;
}
async function projectAssignee(fs9, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs9, box, patch);
}
async function restoreProjection(fs9, box, owner, status, acceptedBy) {
  await patchFrontmatter(fs9, box, {
    owner: owner ?? void 0,
    status: status ?? void 0,
    acceptedBy: acceptedBy ?? void 0
  });
}
async function patchFrontmatter(fs9, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs9.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  const order = [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...keyOrder.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
  await fs9.writeFile(boxFile, serializeFrontmatter(data, body, order));
}
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs9, action) {
  return withTentMutation(fs9, action);
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
    const nextId = makeUniqueConceptId(usedIds, env.rand);
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
async function uniqueSiblingPath(fs9, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!await fs9.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs9, from, to) {
  await fs9.mkdir(to);
  for (const entry of await fs9.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs9, src, dst);
    else await fs9.writeFile(dst, await fs9.readFile(src));
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
async function ensureIdentityFileName(fs9, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs9.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs9.exists(copied)) await fs9.move(copied, expected);
}

// src/core/ops.ts
async function dispatch(env, claimId, role, promptOrOptions) {
  return withMutation2(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}
async function dispatchUnlocked(env, claimId, role, promptOrOptions) {
  const tent = await loadTent(env.fs);
  const roleName = assertRoleName(role);
  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const options = typeof promptOrOptions === "string" ? { userPrompt: promptOrOptions } : promptOrOptions;
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const tasks = await loadTaskEnvelopes(env.fs);
  const roleTempPath = join("temp", roleName);
  const roleTempExisted = await env.fs.exists(roleTempPath);
  if (claim.root) {
    const occupied = occupiedBoxes(tent);
    if (occupied.length > 0) {
      throw new Error(`Cannot dispatch: Tent root already has an active claim ${occupied[0].name} (${occupied[0].fm.owner}).`);
    }
  } else {
    if (!claim.box.coordination) {
      throw new Error(
        `Cannot dispatch: ${claim.box.name} has coordination=false (type ${claim.box.type}); only coordination-enabled concepts may enter the task lifecycle.`
      );
    }
    const existingOwner = ownerCovering(claim.box);
    if (existingOwner) {
      throw new Error(`Cannot dispatch: ${existingOwner.name} is already claimed by ${existingOwner.fm.owner}.`);
    }
    const claimable = canClaim(claim.box);
    if (!claimable.ok) throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    const pendingBlocker = pendingClaimCovering(tent, claim.box, tasks);
    if (pendingBlocker) throw new Error(`Cannot dispatch: ${pendingBlocker.reason}`);
  }
  try {
    const roleClaims = claim.root ? [] : roleManifestClaims(tent, roleName, claim.box, tasks);
    const input = claim.root ? { tentName: env.tentName, role: roleName, claimRoot: true, ...options.workspace } : { tentName: env.tentName, role: roleName, claimBoxes: roleClaims, ...options.workspace };
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
      dispatchedBy: options.dispatchedBy,
      deliveryPolicy: options.deliveryPolicy
    });
    const relayPrompt = relayPromptForTask(
      {
        path: taskPath,
        role: roleName,
        claims: taskClaims.map((taskClaim2) => taskClaim2.id),
        manifest: manifestPath,
        status: "pending",
        state: "queued"
      },
      env.tentRoot || env.tentName
    );
    return { manifestPath, manifestYaml: yaml, initPath, taskPath, relayPrompt };
  } catch (error) {
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
  const box = requireBoxById2(tent, id);
  return { root: false, id: box.id, name: box.name, box };
}
async function createBox(env, input) {
  return withMutation2(env.fs, async () => createBoxUnlocked(env, input));
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
  const id = makeUniqueConceptId(existing, env.rand);
  const path9 = join(input.parentPath, name);
  assertNotTempPath(path9);
  await ensureDir3(env.fs, path9);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path9), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path9);
    throw error;
  }
  return id;
}
async function patchBox(env, boxPath, patch, loadedTent) {
  await withMutation2(env.fs, async () => patchBoxUnlocked(env, boxPath, patch, loadedTent));
}
async function patchBoxUnlocked(env, boxPath, patch, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box) throw new Error(`Box not found: ${boxPath}.`);
  const reserved = ["id", "owner", "archived"].filter((key) => key in patch);
  if (reserved.length > 0) throw new Error(`Reserved fields cannot be edited here: ${reserved.join(", ")}.`);
  if (box.archived) throw new Error("Archived boxes can only be restored or permanently deleted.");
  if (box.invalid) {
    const keys = Object.keys(patch);
    if (box.id !== box.invalidRootId || keys.some((key) => key !== "type")) {
      throw new Error("Invalid subtrees can only be repaired by changing the type at the invalid root.");
    }
  }
  if ("type" in patch) {
    if (typeof patch.type !== "string" || !patch.type) throw new Error("Primary type cannot be cleared.");
    if (!typeExists(patch.type, tent.typeRegistry)) throw new Error(`Unknown type: ${patch.type}.`);
  }
  if ("status" in patch) {
    if (box.fm.owner) throw new Error("Status for claimed boxes can only be changed by completing or force-releasing.");
    if (patch.status !== void 0 && !["todo", "doing", "done"].includes(String(patch.status))) {
      throw new Error("Status must be todo, doing, or done.");
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
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}
async function patchBody(env, boxPath, newBody, loadedTent) {
  await withMutation2(env.fs, async () => patchBodyUnlocked(env, boxPath, newBody, loadedTent));
}
async function patchBodyUnlocked(env, boxPath, newBody, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box || !isUsableBox(box)) throw new Error("Invalid or archived boxes cannot have their body edited.");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}
async function ensureDir3(fs9, path9) {
  if (path9 && !await fs9.exists(path9)) await fs9.mkdir(path9);
}
function normalizeTagPatch(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new Error("Tags must be a string array.");
  const tags = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Tags must be a string array.");
    const tag = normalizeTagName(item);
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.length > 0 ? tags.sort((a, b) => a.localeCompare(b)) : void 0;
}
function boxKeyOrder(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function assertNotTempPath(path9) {
  if (path9 === "temp" || path9.startsWith("temp/")) {
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
function pendingClaimCovering(tent, box, tasks) {
  for (const task of tasks) {
    const active = task.state ? task.state === "queued" || task.state === "running" || task.state === "waiting" || task.state === "delivered" : task.status === "pending" || task.status === "taken";
    if (!active) continue;
    for (const claimId of task.claims) {
      if (claimId === "root") {
        return { reason: `Tent root is awaiting delivery to ${task.role}.` };
      }
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (claimed.id === box.id) {
        return { reason: `${box.name} is already awaiting delivery to ${task.role}.` };
      }
      if (isAncestor(claimed, box)) {
        return { reason: `Ancestor ${claimed.name} is awaiting delivery to ${task.role}.` };
      }
      if (isAncestor(box, claimed)) {
        return { reason: `Descendant ${claimed.name} is awaiting delivery to ${task.role}.` };
      }
    }
  }
  return void 0;
}
function roleManifestClaims(tent, role, current, tasks) {
  const claims = /* @__PURE__ */ new Map();
  for (const box of tent.byPath.values()) {
    if (box.fm.owner === role) claims.set(box.id, box);
  }
  for (const task of tasks) {
    if (task.status !== "pending" || task.role !== role) continue;
    for (const claimId of task.claims) {
      const box = tent.byId.get(claimId);
      if (box) claims.set(box.id, box);
    }
  }
  claims.set(current.id, current);
  return [...claims.values()];
}
function isAncestor(ancestor, child) {
  let parent = child.parent;
  while (parent) {
    if (parent.id === ancestor.id) return true;
    parent = parent.parent;
  }
  return false;
}
function requireBoxById2(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation2(fs9, action) {
  return withTentMutation(fs9, action);
}

// src/core/concept.ts
async function promoteConcept(env, conceptIdOrPath, toType) {
  return withTentMutation(env.fs, async () => promoteConceptUnlocked(env, conceptIdOrPath, toType));
}
async function promoteConceptUnlocked(env, conceptIdOrPath, toType) {
  const tent = await loadTent(env.fs);
  const concept = resolveConcept(tent, conceptIdOrPath);
  if (!isUsableBox(concept)) throw new Error("Invalid or archived concepts cannot be promoted.");
  const target = toType.trim();
  if (!target) throw new Error("Promote requires a non-empty target type.");
  if (!typeHasCoordination(target, tent.typeRegistry)) {
    throw new Error(`Target type must have coordination capability: ${target}.`);
  }
  if (concept.coordination && concept.type === target) {
    return { id: concept.id, path: concept.path, fromType: concept.type, toType: target };
  }
  if (concept.coordination && concept.type !== target) {
    await assertPromoteWriteAllowed(env, tent, concept);
  }
  const notePath = boxNotePath(concept.path);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(notePath));
  const fromType = typeof data.type === "string" ? data.type : concept.type;
  data.type = target;
  if (data.status !== "todo" && data.status !== "doing" && data.status !== "done") {
    data.status = "todo";
  }
  await env.fs.writeFile(notePath, serializeFrontmatter(data, body, keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER));
  return { id: concept.id, path: concept.path, fromType, toType: target };
}
async function assertPromoteWriteAllowed(env, tent, concept) {
  if (concept.fm.owner || concept.locked) {
    throw new Error(
      `Cannot promote ${concept.name}: active claim/owner write-protects type changes; stamp or force-release first.`
    );
  }
  const tasks = await loadTaskEnvelopes(env.fs);
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "taken") continue;
    if (task.claims.includes(concept.id) || task.claims.includes("root")) {
      throw new Error(
        `Cannot promote ${concept.name}: active task ${task.path} write-protects type changes.`
      );
    }
    for (const claimId of task.claims) {
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (isAncestorPath(claimed.path, concept.path) || isAncestorPath(concept.path, claimed.path)) {
        throw new Error(
          `Cannot promote ${concept.name}: overlapping active task ${task.path} write-protects type changes.`
        );
      }
    }
  }
}
function isAncestorPath(ancestor, child) {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}
function resolveConcept(tent, conceptIdOrPath) {
  const key = conceptIdOrPath.trim();
  const byId = tent.byId.get(key);
  if (byId) return byId;
  const byPath = tent.byPath.get(key.replace(/\\/g, "/"));
  if (byPath) return byPath;
  throw new Error(`Concept not found: ${conceptIdOrPath}.`);
}

// src/core/context-card.ts
var CONTEXT_CARD_TEMPLATE_VERSION = "v1";
function buildContextCard(ref, options) {
  const kind = ref.kind;
  const id = ref.id.trim();
  if (!id) throw new Error("ContextRef.id cannot be empty.");
  if (!kind) throw new Error("ContextRef.kind is required.");
  const label = options?.label?.trim() || (ref.path ? `${kind}:${ref.path}` : `${kind}:${id}`);
  const prompt = formatContextCardPrompt(ref, options);
  return {
    contextRef: {
      kind,
      id,
      path: ref.path,
      fragment: ref.fragment
    },
    prompt,
    label,
    templateVersion: CONTEXT_CARD_TEMPLATE_VERSION
  };
}
function formatContextCardPrompt(ref, hints) {
  const opts = typeof hints === "string" ? { tentRootHint: hints } : hints ?? {};
  const systemRoot = opts.systemRoot?.trim() || opts.tentRootHint?.trim() || "";
  const workspaceRoot = opts.workspaceRoot?.trim() || "";
  const lines = [
    "Tent contextCard v1",
    `contextRef: ${ref.kind}/${ref.id}`
  ];
  if (ref.path) lines.push(`path: ${ref.path}`);
  if (ref.fragment) lines.push(`fragment: ${ref.fragment}`);
  if (workspaceRoot) lines.push(`workspaceRoot: ${workspaceRoot}`);
  if (systemRoot) {
    lines.push(`systemRoot: ${systemRoot}`);
    lines.push(`tentRoot: ${systemRoot}`);
  }
  if (ref.path) {
    const rel = ref.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (rel && !rel.startsWith(".tent/")) {
      lines.push(`fileRead: .tent/${rel} (relative to workspaceRoot) or \${systemRoot}/${rel}`);
    }
  }
  lines.push(
    "CLI: run tent from workspaceRoot; taskPath/docs paths are relative to systemRoot (.tent)."
  );
  lines.push("Read this entity via Tent Task API / docs API (or CLI aliases).");
  lines.push("Do not invent missing content; fetch by id before answering.");
  lines.push("Do not resolve operational files as <workspaceRoot>/temp \u2014 use .tent/temp.");
  return lines.join("\n");
}
function taskContextCard(taskId, opts) {
  return buildContextCard({ kind: "task", id: taskId, path: opts?.path }, opts);
}

// src/core/workspace.ts
import * as nodePath from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
async function isGitWorkspace(workspace) {
  try {
    await assertGitWorkspace(nodePath.resolve(workspace));
    return true;
  } catch {
    return false;
  }
}
async function ensureRoleWorkspaceIfGit(workspace, role) {
  if (!await isGitWorkspace(workspace)) return void 0;
  return ensureRoleWorkspace(workspace, role);
}
async function ensureRoleWorkspace(workspace, role) {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const targetBranch = await resolveTargetBranch(root);
  const roleSlug = safeComponent(role);
  const branch = `tent-role/${roleSlug}`;
  const worktree = nodePath.join(
    nodePath.dirname(root),
    `${nodePath.basename(root)}-worktrees`,
    roleSlug
  );
  const existing = await worktreeForBranch(root, branch);
  if (existing) {
    return { workspace: root, worktree: await nodeFs.realpath(nodePath.resolve(existing)), branch, targetBranch };
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
      const prior = await findCherryPick(root, sourceRef, contract.targetBranch);
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
    nodeFs.realpath(nodePath.resolve(top)),
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
async function findCherryPick(root, sourceRef, targetBranch) {
  const full = await fullRef(root, sourceRef);
  const needle = `(cherry picked from commit ${full})`;
  const targetRef = `refs/heads/${targetBranch}`;
  const output = await git(root, ["log", targetRef, "--format=%H%x00%B%x00", "-n", "5000"]);
  const parts = output.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const body = parts[i + 1] ?? "";
    if (body.includes(needle)) return parts[i].trim();
  }
  return void 0;
}
async function findAncestorIntegration(root, sourceRef, targetBranch) {
  const targetRef = `refs/heads/${targetBranch}`;
  const full = await fullRef(root, sourceRef);
  if (await gitOk(root, ["merge-base", "--is-ancestor", full, targetRef])) {
    return full;
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
async function pathExists(path9) {
  try {
    await nodeFs.access(path9);
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
  return new Promise((resolve7, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => {
      if (code === 0) resolve7(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}

// src/runtime/types.ts
var SESSION_ID_PREFIX = "ss-";
var SESSION_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function makeSessionId(rand = Math.random, len = 8) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += SESSION_ALPHABET[Math.floor(rand() * SESSION_ALPHABET.length)];
  }
  return SESSION_ID_PREFIX + s;
}
function isSessionId(id) {
  return id.startsWith(SESSION_ID_PREFIX) && id.length > SESSION_ID_PREFIX.length;
}

// src/runtime/session-registry.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
function sessionsDir(dataDir) {
  return path.join(dataDir, "sessions");
}
function sessionFilePath(dataDir, sessionId) {
  return path.join(sessionsDir(dataDir), `${sessionId}.json`);
}
function assertSessionId(sessionId) {
  if (!isSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}
var SessionRegistry = class {
  constructor(dataDir) {
    this.dataDir = dataDir;
    /** Serialize disk mutations so stop + exit handlers cannot race rename. */
    this.writeChain = Promise.resolve();
  }
  get dataRoot() {
    return this.dataDir;
  }
  async ensureDir() {
    await fs.mkdir(sessionsDir(this.dataDir), { recursive: true });
  }
  enqueue(fn) {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async write(record) {
    assertSessionId(record.id);
    return this.enqueue(async () => {
      await this.ensureDir();
      const file = sessionFilePath(this.dataDir, record.id);
      await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    });
  }
  async read(sessionId) {
    assertSessionId(sessionId);
    const file = sessionFilePath(this.dataDir, sessionId);
    try {
      const raw = await fs.readFile(file, "utf8");
      const data = JSON.parse(raw);
      if (data.id !== sessionId) return null;
      return data;
    } catch {
      return null;
    }
  }
  async update(sessionId, patch) {
    return this.enqueue(async () => {
      const current = await this.readUnlocked(sessionId);
      if (!current) throw new Error(`Session not found: ${sessionId}`);
      const next = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.ensureDir();
      const file = sessionFilePath(this.dataDir, sessionId);
      await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
      return next;
    });
  }
  async setState(sessionId, state, extra = {}) {
    return this.update(sessionId, { ...extra, state });
  }
  async list() {
    await this.ensureDir();
    const dir = sessionsDir(this.dataDir);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!isSessionId(id)) continue;
      const rec = await this.read(id);
      if (rec) out.push(rec);
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }
  async remove(sessionId) {
    assertSessionId(sessionId);
    return this.enqueue(async () => {
      try {
        await fs.rm(sessionFilePath(this.dataDir, sessionId), { force: true });
      } catch {
      }
    });
  }
  /** Non-terminal states that should be probed after service restart. */
  static isNonTerminal(state) {
    return state === "starting" || state === "live" || state === "waiting-user";
  }
  async readUnlocked(sessionId) {
    const file = sessionFilePath(this.dataDir, sessionId);
    try {
      const raw = await fs.readFile(file, "utf8");
      const data = JSON.parse(raw);
      if (data.id !== sessionId) return null;
      return data;
    } catch {
      return null;
    }
  }
};

// src/service/handlers.ts
import * as nodePath2 from "node:path";

// src/core/okf.ts
function resolveConcept2(index, target) {
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
function normalizeLookupKey(value) {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}

// src/markdown/links.ts
var WIKI_RE = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
var MD_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
function extractOutLinks(body) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const match of body.matchAll(WIKI_RE)) {
    const raw = match[1].trim();
    const label = match[2]?.trim();
    const key = `wiki:${raw}|${label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, kind: "wiki", label });
  }
  for (const match of body.matchAll(MD_LINK_RE)) {
    const label = match[1]?.trim() || void 0;
    const href = match[2].trim();
    if (/^(https?:|mailto:|tent-artifact:)/i.test(href)) {
      const key2 = `artifact:${href}`;
      if (seen.has(key2)) continue;
      seen.add(key2);
      out.push({ raw: href, kind: "artifact", label });
      continue;
    }
    const key = `md:${href}|${label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: href, kind: "md", label });
  }
  return out;
}
function resolveOutLink(index, link, fromNotePath) {
  if (link.kind === "artifact") {
    return { raw: link.raw, kind: "artifact", label: link.label };
  }
  const target = normalizeTarget(link.raw, fromNotePath);
  const concept = resolveConcept2(index, target) ?? resolveConcept2(index, link.raw);
  if (!concept) {
    return { raw: link.raw, kind: "unresolved", label: link.label };
  }
  return {
    raw: link.raw,
    kind: link.kind,
    targetCx: concept.id,
    targetPath: concept.path,
    label: link.label ?? concept.name
  };
}
function buildBacklinkIndex(concepts) {
  const boxesAsConcepts = [];
  const byId = /* @__PURE__ */ new Map();
  const list = [...concepts];
  for (const c of list) byId.set(c.id, c);
  const index = /* @__PURE__ */ new Map();
  for (const c of list) {
    const concept = {
      id: c.id,
      boxId: c.id,
      path: c.path,
      notePath: c.notePath,
      name: c.name,
      type: "note"
    };
    add(index, concept.id, concept);
    add(index, concept.path, concept);
    add(index, concept.notePath, concept);
    add(index, concept.name, concept);
  }
  const reverse = /* @__PURE__ */ new Map();
  for (const c of list) {
    for (const link of extractOutLinks(c.body)) {
      if (link.kind === "artifact") continue;
      const resolved = resolveOutLink(index, link, c.notePath);
      if (!resolved.targetCx) continue;
      const hit = {
        fromCx: c.id,
        fromPath: c.path,
        fromName: c.name,
        raw: link.raw,
        kind: link.kind === "wiki" ? "wiki" : "md"
      };
      const arr = reverse.get(resolved.targetCx) ?? [];
      arr.push(hit);
      reverse.set(resolved.targetCx, arr);
    }
  }
  return reverse;
}
function add(index, key, concept) {
  if (!key) return;
  const list = index.get(key) ?? [];
  if (!list.some((c) => c.id === concept.id)) list.push(concept);
  index.set(key, list);
  const all = index.get("__all__") ?? [];
  if (!all.some((c) => c.id === concept.id)) all.push(concept);
  index.set("__all__", all);
}
function normalizeTarget(raw, fromNotePath) {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("./") || t.startsWith("../")) {
    if (fromNotePath) {
      const base = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
      for (const part of t.split("/")) {
        if (part === "." || part === "") continue;
        if (part === "..") base.pop();
        else base.push(part);
      }
      t = base.join("/");
    }
  }
  return t.replace(/\.md$/i, "");
}

// src/service/etag.ts
import { createHash } from "node:crypto";
function contentEtag(content) {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);
}

// src/service/a2a-store.ts
import * as fs2 from "node:fs/promises";
import * as path2 from "node:path";
var A2AApprovalStore = class {
  constructor(dataDir) {
    this.items = /* @__PURE__ */ new Map();
    this.loaded = false;
    this.file = path2.join(dataDir, "a2a-approvals.json");
  }
  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs2.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      for (const item of parsed.items ?? []) {
        if (item?.id) this.items.set(item.id, item);
      }
    } catch {
    }
  }
  async listPending(workspaceId) {
    await this.ensureLoaded();
    return [...this.items.values()].filter(
      (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
    );
  }
  async get(id) {
    await this.ensureLoaded();
    return this.items.get(id);
  }
  async add(item) {
    await this.ensureLoaded();
    this.items.set(item.id, item);
    await this.persist();
    return item;
  }
  async resolve(id, decision, resolvedBy) {
    await this.ensureLoaded();
    const item = this.items.get(id);
    if (!item) throw new Error(`A2A approval not found: ${id}`);
    if (item.status !== "pending") {
      throw new Error(`A2A approval already ${item.status}: ${id}`);
    }
    item.status = decision;
    item.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
    item.resolvedBy = resolvedBy;
    this.items.set(id, item);
    await this.persist();
    return item;
  }
  async persist() {
    await fs2.mkdir(path2.dirname(this.file), { recursive: true });
    const items = [...this.items.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || "")).slice(0, 50);
    await fs2.writeFile(
      this.file,
      JSON.stringify({ items: [...pending, ...terminal] }, null, 2) + "\n",
      "utf8"
    );
  }
};
function makeApprovalId(rand = Math.random) {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ap-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

// src/service/types.ts
var CLIENT_METHODS = [
  "service.health",
  "service.subscribe",
  "workspace.mount",
  "workspace.unmount",
  "workspace.list",
  "workspace.setForeground",
  "docs.list",
  "docs.get",
  "docs.readForEdit",
  "docs.write",
  "docs.createNote",
  "docs.promote",
  "docs.fork",
  "docs.search",
  "docs.backlinks",
  "registry.types",
  "registry.roles",
  "profile.list",
  "task.dispatch",
  "task.claim",
  "task.wait",
  "task.resume",
  "task.deliver",
  "task.requestReview",
  "task.accept",
  "task.reject",
  "task.interrupt",
  "task.cancel",
  "task.startSession",
  "task.list",
  "task.get",
  "delivery.list",
  "delivery.get",
  "session.list",
  "session.get",
  "a2a.listPending",
  "a2a.resolve"
];
function isClientMethod(method) {
  return CLIENT_METHODS.includes(method);
}
var PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"];
var RPC_UNAUTHORIZED = -32001;
var RPC_A2A_DENIED = -32020;
var RPC_A2A_ASK = -32021;
var RPC_LIFECYCLE = -32022;

// src/service/profiles.ts
import * as fs5 from "node:fs/promises";
import * as path5 from "node:path";

// src/adapters/fake/index.ts
import * as fs3 from "node:fs";
import * as os from "node:os";
import * as path3 from "node:path";
var FAKE_ADAPTER_ID = "fake-cli";
function buildInlineScript(opts) {
  return `
const fs = require('fs');
const sleepMs = ${opts.sleepMs};
const exitCode = ${opts.exitCode};
const waitForSignal = ${opts.waitForSignal ? "true" : "false"};
const emitStdout = ${opts.emitStdout ? "true" : "false"};
const promptFile = process.env.TENT_BOOTSTRAP_FILE || '';
if (emitStdout) {
  let prompt = '';
  try { if (promptFile) prompt = fs.readFileSync(promptFile, 'utf8').slice(0, 200); } catch {}
  process.stdout.write('fake-adapter live' + (prompt ? ' prompt=' + JSON.stringify(prompt) : '') + '\\n');
}
function shutdown(code) {
  try { if (promptFile) fs.unlinkSync(promptFile); } catch {}
  process.exit(code);
}
if (waitForSignal) {
  const onStop = () => shutdown(0);
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  // Windows: taskkill / SIGTERM via child.kill maps here when possible.
  setInterval(() => {}, 1 << 30);
} else {
  setTimeout(() => shutdown(exitCode), sleepMs);
}
`.trim();
}
function normalizeFakeOpts(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    sleepMs: typeof o.sleepMs === "number" ? o.sleepMs : 3e4,
    exitCode: typeof o.exitCode === "number" ? o.exitCode : 0,
    waitForSignal: o.waitForSignal !== false,
    emitStdout: o.emitStdout !== false,
    failLaunch: o.failLaunch,
    canResume: o.canResume === true
  };
}
var FakeProviderAdapter = class {
  constructor(options = {}) {
    this.id = FAKE_ADAPTER_ID;
    this.displayNameKey = "adapter.fake.displayName";
    this.nodePath = options.nodePath ?? process.execPath;
  }
  capabilities() {
    return {
      canSpawn: true,
      canResume: false,
      // default; profile may store resumeToken separately
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "process"
    };
  }
  resolveLaunch(plan) {
    const fake = normalizeFakeOpts(plan.extras?.fake ?? plan.extras);
    if (fake.failLaunch) {
      throw new Error(fake.failLaunch);
    }
    let bootstrapFile;
    if (plan.bootstrapPrompt != null && plan.bootstrapPrompt.length > 0) {
      bootstrapFile = path3.join(
        os.tmpdir(),
        `tent-bootstrap-${plan.sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.txt`
      );
      fs3.writeFileSync(bootstrapFile, plan.bootstrapPrompt, "utf8");
    }
    const script = buildInlineScript(fake);
    const env = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId
    };
    if (bootstrapFile) env.TENT_BOOTSTRAP_FILE = bootstrapFile;
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (plan.command) {
      return {
        command: plan.command,
        args: plan.args ?? [],
        cwd: plan.cwd,
        env,
        bootstrapFile,
        stopSignal: "SIGTERM"
      };
    }
    return {
      command: this.nodePath,
      args: ["-e", script],
      cwd: plan.cwd,
      env,
      bootstrapFile,
      stopSignal: "SIGTERM"
    };
  }
  parseResumeToken(raw) {
    return { raw, providerSessionId: raw };
  }
  mapExit(code, signal) {
    if (signal && signal !== "SIGTERM" && signal !== "SIGINT") {
      return { type: "session.failed", sessionId: "", error: `signal:${signal}` };
    }
    if (code === 0 || code === null && (signal === "SIGTERM" || signal === "SIGINT")) {
      return { type: "session.exited", sessionId: "", exitCode: code };
    }
    if (code !== 0 && code != null) {
      return {
        type: "session.failed",
        sessionId: "",
        error: `exit:${code}`
      };
    }
    return { type: "session.exited", sessionId: "", exitCode: code };
  }
};
function createFakeAdapter(options) {
  return new FakeProviderAdapter(options);
}

// src/adapters/grok-acp/index.ts
import * as fs4 from "node:fs";
import * as os2 from "node:os";
import * as path4 from "node:path";

// src/adapters/grok-acp/client.ts
import { spawn as spawn2 } from "node:child_process";
import * as readline from "node:readline";

// src/adapters/grok-acp/types.ts
var GROK_ACP_ADAPTER_ID = "grok-acp";
var DEFAULT_GROK_MODEL = "grok-4.5";
var DEFAULT_GROK_ENV_KEY = "CPA_GROK_API_KEY";
var DEFAULT_GROK_BASE_URL_ENV_KEY = "CPA_GROK_BASE_URL";
var DEFAULT_PROMPT_TIMEOUT_MS = 30 * 6e4;
var DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;

// src/adapters/grok-acp/client.ts
var GrokAcpClient = class {
  constructor(options) {
    this.options = options;
    this.proc = null;
    this.lines = null;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    /** Accumulated agent_message_chunk only — used as managed delivery report. */
    this.assistantText = "";
    this.stderrTail = "";
    this.closed = false;
    this.stopRequested = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.exitWaiters = [];
  }
  get pid() {
    return this.proc?.pid ?? void 0;
  }
  get providerSession() {
    return this.providerSessionId;
  }
  get lastAssistantText() {
    return this.assistantText;
  }
  get lastStderrTail() {
    return this.stderrTail;
  }
  isAlive() {
    const pid = this.proc?.pid;
    if (pid == null || pid <= 0 || this.closed) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Spawn ACP process + initialize/authenticate/session/new.
   * Emits session.live when the ACP session exists. Does not block on prompt.
   */
  async connect() {
    this.spawnProcess();
    const pid = this.proc.pid;
    this.options.emit({
      type: "session.starting",
      sessionId: this.options.sessionId
    });
    try {
      const init = await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        }
      });
      const authMethods = new Set((init.authMethods ?? []).map((m) => m.id));
      const methodId = authMethods.has("xai.api_key") ? "xai.api_key" : authMethods.has("cached_token") ? "cached_token" : null;
      if (!methodId) {
        throw new Error(
          "Grok ACP \u672A\u63D0\u4F9B\u53EF\u7528\u7684\u8BA4\u8BC1\u65B9\u5F0F\uFF08\u9700\u8981 xai.api_key \u6216 cached_token\uFF09\u3002\u8BF7\u786E\u8BA4 grok CLI \u4E0E CPA \u914D\u7F6E\u3002"
        );
      }
      await this.request("authenticate", {
        methodId,
        _meta: { headless: true }
      });
      const session = await this.request(
        "session/new",
        { cwd: this.options.cwd, mcpServers: [] },
        6e4
      );
      if (!session.sessionId) {
        throw new Error("Grok ACP session/new \u672A\u8FD4\u56DE sessionId");
      }
      this.providerSessionId = session.sessionId;
      this.options.emit({
        type: "session.live",
        sessionId: this.options.sessionId,
        pid
      });
      return { pid, providerSessionId: session.sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.stderrTail ? `${message} (stderr: ${this.stderrTail.slice(-500)})` : message;
      throw new Error(detail);
    }
  }
  /**
   * Send session/prompt with managed bootstrap (Context Card + user prompt).
   * Accumulates agent_message_chunk only for the final report text.
   * Safe to call after connect(); failures throw (caller emits session.failed).
   */
  async sendPrompt(bootstrapPrompt) {
    if (!this.providerSessionId) {
      throw new Error("Grok ACP session \u5C1A\u672A\u5EFA\u7ACB\uFF0C\u65E0\u6CD5 prompt");
    }
    const pid = this.proc?.pid;
    if (pid == null) {
      throw new Error("Grok ACP \u8FDB\u7A0B\u4E0D\u53EF\u7528");
    }
    this.assistantText = "";
    try {
      const promptTimeout = this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
      const result = await this.request(
        "session/prompt",
        {
          sessionId: this.providerSessionId,
          prompt: [{ type: "text", text: bootstrapPrompt }]
        },
        promptTimeout
      );
      if (this.stopRequested) {
        throw new Error("session interrupted before prompt completed");
      }
      return {
        pid,
        providerSessionId: this.providerSessionId,
        stopReason: result.stopReason,
        assistantText: this.assistantText.trim()
      };
    } catch (err) {
      if (this.stopRequested) {
        throw new Error("session interrupted before prompt completed");
      }
      const message = err instanceof Error ? err.message : String(err);
      const detail = this.stderrTail ? `${message} (stderr: ${this.stderrTail.slice(-500)})` : message;
      throw new Error(detail);
    }
  }
  /** Keep process alive after bootstrap for probe/stop (caller owns lifecycle). */
  async stop(reason) {
    void reason;
    if (this.closed) return;
    this.stopRequested = true;
    this.closed = true;
    this.rejectAllPending(new Error("session stopped"));
    const proc = this.proc;
    if (!proc || proc.killed) {
      this.cleanupStreams();
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
    }
    await Promise.race([
      this.waitExit(),
      sleep(1500).then(() => this.forceKill())
    ]);
    this.cleanupStreams();
  }
  spawnProcess() {
    const child = spawn2(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false
    });
    if (child.pid == null) {
      throw new Error(
        `\u65E0\u6CD5\u542F\u52A8 Grok ACP \u8FDB\u7A0B: ${this.options.command} ${this.options.args.join(" ")}`
      );
    }
    this.proc = child;
    this.lines = readline.createInterface({ input: child.stdout });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4e3);
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text
      });
    });
    this.lines.on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.closed = true;
      this.rejectAllPending(
        new Error(
          signal ? `Grok ACP \u8FDB\u7A0B\u4FE1\u53F7\u9000\u51FA: ${signal}` : `Grok ACP \u8FDB\u7A0B\u9000\u51FA code=${code}`
        )
      );
      for (const w of this.exitWaiters) w();
      this.exitWaiters = [];
    });
    child.on("error", (err) => {
      this.closed = true;
      this.rejectAllPending(
        new Error(`Grok ACP \u8FDB\u7A0B\u9519\u8BEF: ${err.message}`)
      );
    });
  }
  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if ("method" in message && message.method === "session/update") {
      this.handleSessionUpdate(
        message.params?.update
      );
      return;
    }
    if ("method" in message && message.method === "session/request_permission" && message.id !== void 0) {
      void this.handlePermissionRequest(
        message.id,
        message.params
      );
      return;
    }
    if ("method" in message && message.id !== void 0 && message.method) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: "Client-side requests are disabled for Tent grok-acp adapter."
        }
      });
      return;
    }
    if (!("id" in message) || message.id === void 0) return;
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in message && message.error) {
      pending.reject(
        new Error(message.error.message || JSON.stringify(message.error))
      );
    } else {
      pending.resolve(("result" in message ? message.result : void 0) ?? {});
    }
  }
  handleSessionUpdate(update) {
    if (!update) return;
    const kind = update.sessionUpdate ?? "";
    if (kind === "agent_message_chunk" && update.content?.text) {
      this.assistantText += update.content.text;
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${update.content.text}`
      });
      return;
    }
    if (kind === "agent_thought_chunk" && update.content?.text) {
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${update.content.text}`
      });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const title = typeof update.title === "string" && update.title || update.toolCallId || "tool";
      const status = typeof update.status === "string" ? update.status : "";
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[${kind}] ${title}${status ? ` (${status})` : ""}
`
      });
      return;
    }
    if (kind) {
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: `[session/update] ${kind}
`
      });
    }
  }
  async handlePermissionRequest(id, params) {
    const options = params.options ?? [];
    const toolTitle = params.toolCall?.title || params.toolCall?.toolCallId || "tool";
    const policy = this.options.permissionPolicy;
    let decision = "deny";
    if (policy === "allow") {
      decision = "allow";
    } else if (policy === "deny") {
      decision = "deny";
    } else {
      this.options.emit({
        type: "session.waiting_user",
        sessionId: this.options.sessionId,
        summary: `Grok ACP \u8BF7\u6C42\u5DE5\u5177\u6743\u9650: ${toolTitle}\uFF08policy=ask\uFF09`
      });
      try {
        if (this.options.onPermissionAsk) {
          decision = await Promise.race([
            this.options.onPermissionAsk({ toolTitle, options }),
            sleep(
              this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
            ).then(() => "deny")
          ]);
        } else {
          decision = "deny";
        }
      } catch {
        decision = "deny";
      }
    }
    const outcome = decision === "allow" ? selectAllowOnce(options) : { outcome: "cancelled" };
    this.write({
      jsonrpc: "2.0",
      id,
      result: { outcome }
    });
    this.options.emit({
      type: "session.stdout_tail",
      sessionId: this.options.sessionId,
      text: `[permission] ${toolTitle} \u2192 ${decision === "allow" ? "allow_once" : "deny/cancelled"}
`
    });
  }
  request(method, params, timeoutMs = 3e4) {
    if (this.closed || !this.proc?.stdin) {
      return Promise.reject(new Error(`Grok ACP \u5DF2\u5173\u95ED\uFF0C\u65E0\u6CD5\u8C03\u7528 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve7, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP ${method} \u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve7, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  write(payload) {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(JSON.stringify(payload) + "\n");
  }
  rejectAllPending(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
  waitExit() {
    if (!this.proc || this.closed) return Promise.resolve();
    return new Promise((resolve7) => {
      this.exitWaiters.push(resolve7);
    });
  }
  async forceKill() {
    const proc = this.proc;
    const pid = proc?.pid;
    if (!proc || pid == null) return;
    if (process.platform === "win32") {
      await new Promise((resolve7) => {
        const killer = spawn2("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.on("exit", () => resolve7());
        killer.on("error", () => resolve7());
        setTimeout(resolve7, 1500);
      });
    } else {
      try {
        proc.kill("SIGKILL");
      } catch {
      }
    }
  }
  cleanupStreams() {
    try {
      this.lines?.close();
    } catch {
    }
    this.lines = null;
  }
};
function selectAllowOnce(options) {
  const once = options.find((o) => o.kind === "allow_once") || options.find((o) => o.optionId === "allow_once");
  if (once?.optionId) {
    return { outcome: "selected", optionId: once.optionId };
  }
  return { outcome: "cancelled" };
}
function sleep(ms) {
  return new Promise((resolve7) => setTimeout(resolve7, ms));
}

// src/adapters/grok-acp/index.ts
function defaultGrokExecutable() {
  if (process.platform === "win32") {
    const home2 = process.env.USERPROFILE || os2.homedir();
    return path4.join(home2, ".grok", "bin", "grok.exe");
  }
  const home = process.env.HOME || os2.homedir();
  return path4.join(home, ".grok", "bin", "grok");
}
function normalizeGrokOpts(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const policy = o.permissionPolicy;
  const permissionPolicy = policy === "allow" || policy === "ask" || policy === "deny" ? policy : "deny";
  return {
    executable: o.executable,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : DEFAULT_GROK_MODEL,
    envKey: typeof o.envKey === "string" && o.envKey.trim() ? o.envKey.trim() : DEFAULT_GROK_ENV_KEY,
    baseUrlEnvKey: typeof o.baseUrlEnvKey === "string" && o.baseUrlEnvKey.trim() ? o.baseUrlEnvKey.trim() : DEFAULT_GROK_BASE_URL_ENV_KEY,
    baseUrl: typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl.trim() : void 0,
    promptTimeoutMs: typeof o.promptTimeoutMs === "number" && o.promptTimeoutMs > 0 ? o.promptTimeoutMs : DEFAULT_PROMPT_TIMEOUT_MS,
    permissionPolicy,
    permissionTimeoutMs: typeof o.permissionTimeoutMs === "number" && o.permissionTimeoutMs > 0 ? o.permissionTimeoutMs : DEFAULT_PERMISSION_TIMEOUT_MS
  };
}
function normalizeCpaBaseUrl(raw) {
  if (!raw || typeof raw !== "string") return void 0;
  const t = raw.trim().replace(/\/+$/, "");
  return t || void 0;
}
var GrokManagedSession = class {
  constructor(sessionId, client, bootstrapDone, stopRequested = false) {
    this.sessionId = sessionId;
    this.client = client;
    this.bootstrapDone = bootstrapDone;
    this.stopRequested = stopRequested;
  }
  get pid() {
    return this.client.pid;
  }
  get providerSessionId() {
    return this.client.providerSession;
  }
  isAlive() {
    return !this.stopRequested && this.client.isAlive();
  }
  async waitBootstrap() {
    await this.bootstrapDone;
  }
  async stop(reason) {
    this.stopRequested = true;
    await this.client.stop(reason);
  }
};
var GrokAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = GROK_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.grokAcp.displayName";
    this.resolveApiKey = options.resolveApiKey ?? ((envKey, planEnv) => planEnv[envKey] ?? process.env[envKey]);
    this.resolveBaseUrl = options.resolveBaseUrl ?? ((baseUrlEnvKey, planEnv, profileBaseUrl) => normalizeCpaBaseUrl(
      planEnv[baseUrlEnvKey] ?? process.env[baseUrlEnvKey] ?? profileBaseUrl
    ));
    this.onPermissionAsk = options.onPermissionAsk;
  }
  capabilities() {
    return {
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "env",
      observeLevel: "structured"
    };
  }
  /**
   * Launch plan validation only. Real ACP needs bidirectional stdio —
   * AgentRuntime uses startManagedSession instead of ProcessSupervisor.
   */
  resolveLaunch(plan) {
    const opts = normalizeGrokOpts(plan.extras?.grokAcp ?? plan.extras);
    const command = plan.command || opts.executable || defaultGrokExecutable();
    const model = opts.model;
    const envKey = opts.envKey;
    const baseUrlEnvKey = opts.baseUrlEnvKey;
    const apiKey = this.resolveApiKey(envKey, plan.env);
    const baseUrl = this.resolveBaseUrl(baseUrlEnvKey, plan.env, opts.baseUrl);
    if (!apiKey || !apiKey.trim()) {
      throw new Error(
        `\u672A\u914D\u7F6E\u73AF\u5883\u53D8\u91CF ${envKey}\uFF1Agrok-acp \u9700\u8981\u672C\u673A CPA Grok API key\uFF08\u4EC5 service \u8FDB\u7A0B\u73AF\u5883\uFF09\u3002\u4E0D\u4F1A\u56DE\u9000\u5B98\u65B9 xAI\uFF08api.x.ai\uFF09\uFF0C\u4E5F\u4E0D\u4F1A\u56DE\u9000 fake provider\u3002\u8BF7\u5728\u542F\u52A8 Local Service \u524D\u8BBE\u7F6E ${envKey}` + (baseUrlEnvKey ? `\uFF08\u53EF\u9009 ${baseUrlEnvKey}=CPA base URL\uFF09` : "") + `\uFF1B\u5207\u52FF\u628A key/URL \u5199\u5165 workspace/box/task\u3002`
      );
    }
    if (!plan.command && opts.executable) {
      if (!fs4.existsSync(opts.executable)) {
        throw new Error(
          `Grok \u53EF\u6267\u884C\u6587\u4EF6\u4E0D\u5B58\u5728: ${opts.executable}\u3002\u8BF7\u5728 machine-local AgentProfile.grokAcp.executable \u4E2D\u914D\u7F6E\u6B63\u786E\u8DEF\u5F84\u3002`
        );
      }
    } else if (!plan.command) {
      if (!fs4.existsSync(command)) {
        throw new Error(
          `\u672A\u627E\u5230 Grok \u53EF\u6267\u884C\u6587\u4EF6: ${command}\u3002\u8BF7\u5B89\u88C5 grok CLI \u6216\u5728 AgentProfile \u4E2D\u8BBE\u7F6E grokAcp.executable\u3002`
        );
      }
    }
    let args;
    if (plan.args && plan.args.length > 0) {
      args = [...plan.args];
      if (baseUrl && !args.includes("--xai-api-base-url") && args.includes("agent") && args.includes("stdio")) {
        const stdioIdx = args.indexOf("stdio");
        args.splice(stdioIdx, 0, "--xai-api-base-url", baseUrl);
      }
    } else {
      args = ["agent", "--model", model];
      if (baseUrl) {
        args.push("--xai-api-base-url", baseUrl);
      }
      args.push("stdio");
    }
    const env = {
      ...plan.env,
      [envKey]: apiKey,
      // Grok CLI auth method may read XAI_API_KEY; value is the CPA key, not a second secret store.
      XAI_API_KEY: apiKey,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId,
      TENT_GROK_MODEL: model
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (baseUrl) {
      env[baseUrlEnvKey] = baseUrl;
      env.XAI_API_BASE_URL = baseUrl;
      env.OPENAI_BASE_URL = baseUrl;
      env.OPENAI_API_BASE = baseUrl;
      env.TENT_GROK_BASE_URL = baseUrl;
    }
    const home = process.env.USERPROFILE || process.env.HOME || os2.homedir();
    if (!env.GROK_HOME) {
      env.GROK_HOME = path4.join(home, ".grok");
    }
    return {
      command,
      args,
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM"
    };
  }
  async startManagedSession(plan, emit2) {
    const opts = normalizeGrokOpts(plan.extras?.grokAcp ?? plan.extras);
    const launch = this.resolveLaunch(plan);
    const bootstrap = plan.bootstrapPrompt?.trim() || "Tent session started. Read the task envelope via Tent Task API; do not invent missing content.";
    const client = new GrokAcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      model: opts.model,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      emit: emit2,
      onPermissionAsk: opts.permissionPolicy === "ask" ? async (info) => {
        if (!this.onPermissionAsk) return "deny";
        return this.onPermissionAsk({
          sessionId: plan.sessionId,
          toolTitle: info.toolTitle
        });
      } : void 0
    });
    await client.connect();
    const promptDone = client.sendPrompt(bootstrap).then((result) => {
      const stopReason = (result.stopReason || "end_turn").toLowerCase();
      const assistantText = (result.assistantText || "").trim();
      if (stopReason !== "end_turn") {
        emit2({
          type: "session.failed",
          sessionId: plan.sessionId,
          error: `ACP session/prompt stopReason=${result.stopReason || "unknown"} (no auto-delivery)`
        });
        return;
      }
      if (!assistantText) {
        emit2({
          type: "session.failed",
          sessionId: plan.sessionId,
          error: "ACP assistant response empty (no auto-delivery)"
        });
        return;
      }
      emit2({
        type: "session.prompt_complete",
        sessionId: plan.sessionId,
        assistantText,
        stopReason: result.stopReason || "end_turn"
      });
    }).catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/interrupted|session stopped/i.test(message)) {
        emit2({
          type: "session.failed",
          sessionId: plan.sessionId,
          error: `session interrupted: ${message}`
        });
        return;
      }
      emit2({ type: "session.failed", sessionId: plan.sessionId, error: message });
      try {
        await client.stop("interrupt");
      } catch {
      }
    });
    return new GrokManagedSession(plan.sessionId, client, promptDone);
  }
  parseResumeToken(raw) {
    return { raw, providerSessionId: raw };
  }
  mapExit(code, signal) {
    if (signal && signal !== "SIGTERM" && signal !== "SIGINT") {
      return { type: "session.failed", sessionId: "", error: `signal:${signal}` };
    }
    if (code === 0 || code === null && (signal === "SIGTERM" || signal === "SIGINT")) {
      return { type: "session.exited", sessionId: "", exitCode: code };
    }
    if (code !== 0 && code != null) {
      return { type: "session.failed", sessionId: "", error: `exit:${code}` };
    }
    return { type: "session.exited", sessionId: "", exitCode: code };
  }
};
function createGrokAcpAdapter(options) {
  return new GrokAcpProviderAdapter(options);
}

// src/service/profiles.ts
function profilesPath(dataDir) {
  return path5.join(dataDir, "agent-profiles.json");
}
async function loadAgentProfiles(dataDir) {
  const file = profilesPath(dataDir);
  try {
    const raw = await fs5.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    return list.filter((p) => p && typeof p.id === "string" && typeof p.adapterId === "string");
  } catch {
    return [];
  }
}
async function saveAgentProfiles(dataDir, profiles) {
  await fs5.mkdir(dataDir, { recursive: true });
  await fs5.writeFile(
    profilesPath(dataDir),
    JSON.stringify({ profiles }, null, 2) + "\n",
    "utf8"
  );
}
function defaultAgentProfiles() {
  return [
    {
      id: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.default",
      fake: { waitForSignal: true, emitStdout: true, canResume: true }
    },
    {
      id: "grok-acp-default",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayNameKey: "profile.grokAcp.default",
      grokAcp: {
        // executable omitted → %USERPROFILE%\.grok\bin\grok.exe (or ~/.grok/bin/grok)
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        // CPA base URL from process env (name only here). Optional machine-local baseUrl field.
        baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
        // Default deny tool permissions — never unconditional yolo.
        permissionPolicy: "deny"
      }
    }
  ];
}
async function ensureDefaultProfiles(dataDir) {
  const existing = await loadAgentProfiles(dataDir);
  if (existing.length > 0) {
    let changed = false;
    let next = existing;
    if (!existing.some((p) => p.id === "grok-acp-default")) {
      const grok = defaultAgentProfiles().find((p) => p.id === "grok-acp-default");
      next = [...existing, grok];
      changed = true;
    }
    next = next.map((p) => {
      if (p.adapterId !== GROK_ACP_ADAPTER_ID) return p;
      if (p.grokAcp?.baseUrlEnvKey) return p;
      changed = true;
      return {
        ...p,
        grokAcp: {
          ...p.grokAcp ?? {},
          baseUrlEnvKey: p.grokAcp?.baseUrlEnvKey ?? DEFAULT_GROK_BASE_URL_ENV_KEY
        }
      };
    });
    if (changed) await saveAgentProfiles(dataDir, next);
    return next;
  }
  const defaults = defaultAgentProfiles();
  await saveAgentProfiles(dataDir, defaults);
  return defaults;
}
function isTestOnlyProfile(profile) {
  return profile.adapterId === FAKE_ADAPTER_ID || !!profile.fake;
}
var DISPLAY_NAME_BY_KEY = {
  "profile.fake.default": "fake-default\uFF08\u6D4B\u8BD5\uFF09",
  "profile.grokAcp.default": "Grok ACP"
};
function projectAgentProfile(profile) {
  const testOnly = isTestOnlyProfile(profile);
  const displayName = profile.displayNameKey && DISPLAY_NAME_BY_KEY[profile.displayNameKey] || profile.id;
  return {
    id: profile.id,
    adapterId: profile.adapterId,
    displayName,
    displayNameKey: profile.displayNameKey,
    // Model id only — never env values, keys, or executable paths.
    model: profile.grokAcp?.model,
    testOnly,
    permissionPolicy: profile.grokAcp?.permissionPolicy
  };
}
function projectAgentProfiles(profiles) {
  return profiles.map(projectAgentProfile).sort((a, b) => {
    if (a.testOnly !== b.testOnly) return a.testOnly ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

// src/service/handlers.ts
var RpcError = class extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
};
async function dispatchMethod(ctx, method, params) {
  if (method.startsWith("AgentRuntimePort.") || method.startsWith("AgentRuntime.")) {
    throw new RpcError(
      -32601,
      `Method not found (AgentRuntimePort is service-internal): ${method}`
    );
  }
  if (!isClientMethod(method)) {
    throw new RpcError(-32601, `Method not found: ${method}`);
  }
  const p = params ?? {};
  try {
    switch (method) {
      case "service.health":
        return health(ctx);
      case "service.subscribe":
        return { ok: true, transport: "sse", path: "/events" };
      case "workspace.mount":
        return workspaceMount(ctx, p);
      case "workspace.unmount":
        return workspaceUnmount(ctx, p);
      case "workspace.list":
        return { workspaces: ctx.host.list() };
      case "workspace.setForeground":
        return workspaceSetForeground(ctx, p);
      case "docs.list":
        return docsList(ctx, p);
      case "docs.get":
        return docsGet(ctx, p);
      case "docs.readForEdit":
        return docsReadForEdit(ctx, p);
      case "docs.write":
        return docsWrite(ctx, p);
      case "docs.createNote":
        return docsCreateNote(ctx, p);
      case "docs.promote":
        return docsPromote(ctx, p);
      case "docs.fork":
        return docsFork(ctx, p);
      case "docs.search":
        return docsSearch(ctx, p);
      case "docs.backlinks":
        return docsBacklinks(ctx, p);
      case "registry.types":
        return registryTypes(ctx, p);
      case "registry.roles":
        return registryRoles(ctx, p);
      case "profile.list":
        return profileList(ctx, p);
      case "task.dispatch":
        return taskDispatch(ctx, p);
      case "task.claim":
        return taskClaimRpc(ctx, p);
      case "task.wait":
        return taskWaitRpc(ctx, p);
      case "task.resume":
        return taskResumeRpc(ctx, p);
      case "task.deliver":
        return taskDeliverRpc(ctx, p);
      case "task.requestReview":
        return taskRequestReviewRpc(ctx, p);
      case "task.accept":
        return taskAcceptRpc(ctx, p);
      case "task.reject":
        return taskRejectRpc(ctx, p);
      case "task.interrupt":
        return taskInterruptRpc(ctx, p);
      case "task.cancel":
        return taskCancelRpc(ctx, p);
      case "task.startSession":
        return taskStartSessionRpc(ctx, p);
      case "task.list":
        return taskList(ctx, p);
      case "task.get":
        return taskGet(ctx, p);
      case "delivery.list":
        return deliveryList(ctx, p);
      case "delivery.get":
        return deliveryGet(ctx, p);
      case "session.list":
        return sessionList(ctx, p);
      case "session.get":
        return sessionGet(ctx, p);
      case "a2a.listPending":
        return a2aListPending(ctx, p);
      case "a2a.resolve":
        return a2aResolve(ctx, p);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof TaskLifecycleError) {
      throw new RpcError(RPC_LIFECYCLE, error.message, { code: error.code });
    }
    throw error;
  }
}
function health(ctx) {
  return {
    status: "ok",
    pid: ctx.getPid(),
    version: ctx.version,
    startedAt: ctx.startedAt,
    workspaceCount: ctx.host.list().length,
    foregroundWorkspaceId: ctx.host.getForegroundId()
  };
}
async function workspaceMount(ctx, p) {
  const workspaceRoot = requireString(p, "workspaceRoot");
  const info = await ctx.host.mount(workspaceRoot, {
    workspaceId: optionalString(p, "workspaceId"),
    tentName: optionalString(p, "tentName")
  });
  await reconcileTaskSessionsOnMount(ctx, info.workspaceId);
  return info;
}
var SESSION_UNAVAILABLE_WAIT_SUMMARY = "\u7ED1\u5B9A\u7684 session \u5DF2\u4E0D\u53EF\u7528\uFF08\u670D\u52A1\u91CD\u542F\u6216 session \u5DF2\u7ED3\u675F\uFF09\u3002\u53EF\u91CD\u65B0\u542F\u52A8 session\uFF0C\u6216 interrupt \u4EFB\u52A1\uFF1Boccupation \u4FDD\u6301\u3002";
async function reconcileTaskSessionsOnMount(ctx, workspaceId) {
  const mount = ctx.host.require(workspaceId);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  const reconciled = [];
  for (const task of tasks) {
    if (task.state !== "running" && task.state !== "waiting") continue;
    const sessionId = task.sessionId?.trim();
    if (!sessionId) continue;
    const record = await ctx.runtime.registry.read(sessionId);
    const sessionGone = !record || record.state === "stopped" || record.state === "failed";
    if (!sessionGone) continue;
    const alreadyParked = task.state === "waiting" && task.wait?.reason === "external" && task.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
    if (alreadyParked) continue;
    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      const current = await loadTaskEnvelope(mount.env.fs, task.path);
      if (current.state !== "running" && current.state !== "waiting") return;
      if (current.sessionId?.trim() !== sessionId) return;
      const rec2 = await ctx.runtime.registry.read(sessionId);
      if (rec2 && rec2.state !== "stopped" && rec2.state !== "failed") return;
      const parkedAlready = current.state === "waiting" && current.wait?.reason === "external" && current.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
      if (parkedAlready) return;
      let next = current;
      if (current.state === "running") {
        next = await taskWait(mount.env, task.path, {
          reason: "external",
          summary: SESSION_UNAVAILABLE_WAIT_SUMMARY
        });
      } else {
        next = await patchTaskEnvelope(mount.env.fs, task.path, {
          state: "waiting",
          wait: { reason: "external", summary: SESSION_UNAVAILABLE_WAIT_SUMMARY },
          updatedAt: mount.env.clock.now()
        });
      }
      emitTaskState(ctx, workspaceId, next, "session.reconcile");
      reconciled.push(task.path);
    });
  }
  return { reconciled };
}
async function workspaceUnmount(ctx, p) {
  const workspaceId = requireString(p, "workspaceId");
  await ctx.host.unmount(workspaceId);
  return { ok: true };
}
function workspaceSetForeground(ctx, p) {
  const workspaceId = requireString(p, "workspaceId");
  return ctx.host.setForeground(workspaceId);
}
async function docsList(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const includeBody = p.includeBody === true;
  return {
    workspaceId,
    concepts: tent.roots.map((root) => projectConcept(root, includeBody, true))
  };
}
async function docsGet(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept3(tent, p);
  return {
    workspaceId,
    concept: projectConcept(concept, true, false)
  };
}
async function docsReadForEdit(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept3(tent, p);
  const notePath = boxNotePath(concept.path);
  const raw = await mount.env.fs.readFile(notePath);
  const { data, body } = parseFrontmatter(raw);
  return {
    workspaceId,
    id: concept.id,
    cx: concept.id,
    path: concept.path,
    name: concept.name,
    type: concept.type,
    coordination: concept.coordination,
    body,
    raw,
    etag: contentEtag(raw),
    frontmatter: data,
    artifactRefs: parseArtifactRefs2(data)
  };
}
async function docsWrite(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");
  const rawInput = typeof p.raw === "string" ? p.raw : void 0;
  const body = typeof p.body === "string" ? p.body : void 0;
  const frontmatter = p.frontmatter && typeof p.frontmatter === "object" && !Array.isArray(p.frontmatter) ? p.frontmatter : void 0;
  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept3(tent, p);
    const notePath = boxNotePath(concept.path);
    const diskRaw = await mount.env.fs.readFile(notePath);
    const currentEtag = contentEtag(diskRaw);
    if (baseEtag && baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag,
        baseEtag,
        path: concept.path
      });
    }
    if (rawInput !== void 0) {
      const diskParsed = parseFrontmatter(diskRaw);
      const nextParsed = parseFrontmatter(rawInput);
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      const changed = {};
      for (const field of PROTECTED_COLLAB_FIELDS) {
        if (String(nextParsed.data[field] ?? "") !== String(diskParsed.data[field] ?? "")) {
          changed[field] = nextParsed.data[field];
        }
      }
      if (Object.keys(changed).length > 0) {
        assertDocsWriteAllowed(tent, concept.id, changed, tasks);
      }
      ctx.host.markSelfWrite(workspaceId);
      await mount.env.fs.writeFile(notePath, rawInput);
    } else {
      if (frontmatter) {
        assertDocsWriteAllowed(tent, concept.id, frontmatter, await loadTaskEnvelopes(mount.env.fs));
      }
      ctx.host.markSelfWrite(workspaceId);
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        await patchBox(mount.env, concept.path, frontmatter, tent);
      }
      if (body !== void 0) {
        await patchBody(mount.env, concept.path, body, tent);
      }
      if (body === void 0 && (!frontmatter || Object.keys(frontmatter).length === 0)) {
        throw new RpcError(-32602, "docs.write requires raw, body, and/or frontmatter");
      }
    }
    const afterRaw = await mount.env.fs.readFile(notePath);
    const after = parseFrontmatter(afterRaw);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: concept.id, path: concept.path, reason: "docs.write" },
      "self"
    );
    return {
      workspaceId,
      id: concept.id,
      cx: concept.id,
      path: concept.path,
      etag: contentEtag(afterRaw),
      body: after.body,
      raw: afterRaw
    };
  });
}
async function docsSearch(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const query = optionalString(p, "query") ?? optionalString(p, "q") ?? "";
  const q = query.trim().toLowerCase();
  if (!q) return { workspaceId, hits: [] };
  const tent = await loadTent(mount.env.fs);
  const hits = [];
  for (const box of tent.byId.values()) {
    if (box.archived || box.invalid) continue;
    const title = typeof box.fm.title === "string" ? box.fm.title : box.name;
    if (box.name.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      hits.push({
        cx: box.id,
        path: box.path,
        name: box.name,
        title,
        snippet: title,
        match: "title"
      });
      continue;
    }
    if (box.path.toLowerCase().includes(q)) {
      hits.push({
        cx: box.id,
        path: box.path,
        name: box.name,
        title,
        snippet: box.path,
        match: "path"
      });
      continue;
    }
    const body = box.body ?? "";
    const idx = body.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + q.length + 40);
      hits.push({
        cx: box.id,
        path: box.path,
        name: box.name,
        title,
        snippet: body.slice(start, end).replace(/\s+/g, " ").trim(),
        match: "body"
      });
    }
  }
  return { workspaceId, hits: hits.slice(0, 50) };
}
async function docsBacklinks(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept3(tent, p);
  const concepts = [...tent.byId.values()].map((b) => ({
    id: b.id,
    path: b.path,
    name: b.name,
    body: b.body,
    notePath: boxNotePath(b.path)
  }));
  const reverse = buildBacklinkIndex(concepts);
  return {
    workspaceId,
    cx: concept.id,
    backlinks: reverse.get(concept.id) ?? []
  };
}
async function registryTypes(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const registry = await loadTypeRegistry(mount.env.fs);
  const types = Object.entries(registry).map(([name, def]) => {
    const tier = def.tier === "modifier" ? "modifier" : "base";
    const coordination = tier === "base" && "coordination" in def ? def.coordination === true : false;
    return {
      name,
      tier,
      readable: def.readable,
      writable: def.writable,
      coordination,
      color: def.color,
      description: def.description
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, types };
}
async function registryRoles(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const registry = await loadRolesRegistry(mount.env.fs);
  const roles = registry.roles.map((role) => ({
    name: role.name,
    description: role.description,
    color: role.color,
    prompt: role.prompt,
    a2aPolicy: roleA2APolicy(role)
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, roles };
}
async function profileList(ctx, p) {
  const includeTest = p.includeTest === true;
  const fromRuntime = ctx.runtime.listProfiles();
  const source = fromRuntime.length > 0 ? fromRuntime : await loadAgentProfiles(ctx.dataDir);
  let profiles = projectAgentProfiles(source);
  if (!includeTest) {
    profiles = profiles.filter((pr) => !pr.testOnly);
  }
  return { profiles };
}
async function docsCreateNote(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  const type = optionalString(p, "type") ?? "note";
  const parentPath = optionalString(p, "parentPath") ?? "";
  const body = typeof p.body === "string" ? p.body : void 0;
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const id = await createBox(mount.env, { parentPath, name, type });
    const notePath = parentPath ? `${parentPath}/${name}` : name;
    if (body !== void 0) {
      await patchBody(mount.env, notePath, body.endsWith("\n") ? body : body + "\n");
    }
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id, path: notePath, reason: "docs.createNote" },
      "self"
    );
    return { workspaceId, id, path: notePath, type };
  });
}
async function docsPromote(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const toType = requireString(p, "toType");
  const idOrPath = optionalString(p, "id") ?? optionalString(p, "path") ?? requireString(p, "concept");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await promoteConcept(mount.env, idOrPath, toType);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: result.id, path: result.path, reason: "docs.promote", toType },
      "self"
    );
    return { workspaceId, ...result };
  });
}
async function docsFork(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "id") ?? optionalString(p, "boxId") ?? requireString(p, "path");
  return ctx.mutations.run(workspaceId, async () => {
    let id = boxId;
    if (!id.startsWith("cx-") && !id.startsWith("bx-")) {
      const tent = await loadTent(mount.env.fs);
      const box = tent.byPath.get(boxId);
      if (!box) throw new RpcError(-32004, `Concept not found: ${boxId}`);
      id = box.id;
    }
    ctx.host.markSelfWrite(workspaceId);
    const forkRootId = await forkNode(mount.env, id);
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id: forkRootId, reason: "docs.fork", forkOf: id },
      "self"
    );
    return { workspaceId, id: forkRootId, forkOf: id };
  });
}
async function taskDispatch(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "boxId") ?? optionalString(p, "id") ?? requireString(p, "claimId");
  const role = requireString(p, "role");
  const prompt = requireString(p, "prompt");
  const dispatchedBy = optionalString(p, "dispatchedBy");
  const deliveryPolicy = parseDeliveryPolicy(optionalString(p, "deliveryPolicy"));
  const startSession = p.startSession === true;
  const profileId = optionalString(p, "profileId");
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  const a2aPolicyOverride = parseOptionalA2APolicy(optionalString(p, "a2aPolicyOverride"));
  if (startSession && !profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with startSession requires explicit profileId (no fake-default fallback)"
    );
  }
  const result = await ctx.mutations.run(workspaceId, async () => {
    const roleLane2 = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, role);
    ctx.host.markSelfWrite(workspaceId);
    const dispatched2 = await dispatch(mount.env, boxId, role, {
      userPrompt: prompt,
      dispatchedBy,
      deliveryPolicy,
      workspace: roleLane2
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: dispatched2.taskPath,
        state: "queued",
        role,
        boxId,
        reason: "task.dispatch"
      },
      "self"
    );
    return { dispatched: dispatched2, roleLane: roleLane2 };
  });
  const roleLane = result.roleLane;
  const dispatched = result.dispatched;
  let session = void 0;
  if (startSession) {
    await taskClaimRpc(ctx, {
      workspaceId,
      taskPath: dispatched.taskPath
    });
    session = await taskStartSessionRpc(ctx, {
      workspaceId,
      taskPath: dispatched.taskPath,
      profileId,
      callerKind,
      ...a2aPolicyOverride !== void 0 ? { a2aPolicyOverride } : {}
    });
  }
  const taskAfter = await loadTaskEnvelope(mount.env.fs, dispatched.taskPath).catch(() => null);
  return {
    workspaceId,
    taskPath: dispatched.taskPath,
    manifestPath: dispatched.manifestPath,
    initPath: dispatched.initPath,
    relayPrompt: dispatched.relayPrompt,
    state: startSession ? "running" : "queued",
    session,
    workspaceLane: taskAfter ? projectTask(taskAfter).workspaceLane : roleLane ? {
      workspace: roleLane.workspace,
      worktree: roleLane.worktree,
      branch: roleLane.branch,
      targetBranch: roleLane.targetBranch
    } : void 0
  };
}
async function taskClaimRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const sessionId = optionalString(p, "sessionId");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskClaim(mount.env, taskPath, { sessionId });
    emitTaskState(ctx, workspaceId, task, "task.claim");
    for (const claimId of task.claims) {
      if (claimId === "root") continue;
      ctx.events.emit(
        "concept.changed",
        workspaceId,
        { id: claimId, reason: "task.claim-projection" },
        "self"
      );
    }
    return {
      workspaceId,
      taskPath,
      task: projectTask(task),
      state: task.state,
      role: task.role,
      claims: task.claims,
      sessionId: task.sessionId
    };
  });
}
async function taskWaitRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const reason = requireString(p, "reason");
  const summary = requireString(p, "summary");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskWait(mount.env, taskPath, { reason, summary });
    emitTaskState(ctx, workspaceId, task, "task.wait");
    return { workspaceId, taskPath, task: projectTask(task), state: task.state };
  });
}
async function taskResumeRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskResume(mount.env, taskPath);
    emitTaskState(ctx, workspaceId, task, "task.resume");
    return { workspaceId, taskPath, task: projectTask(task), state: task.state };
  });
}
async function taskDeliverRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const summary = requireString(p, "summary");
  const commits = optionalStringArray(p, "commits");
  const decision = optionalString(p, "decision");
  const checks = Array.isArray(p.checks) ? p.checks : void 0;
  const artifactRefs = Array.isArray(p.artifactRefs) ? p.artifactRefs : void 0;
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
    const integrate = makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate);
    const result = await taskDeliver(mount.env, taskPath, {
      summary,
      commits,
      checks,
      artifactRefs,
      decision,
      integrate
    });
    emitTaskState(ctx, workspaceId, result.task, "task.deliver");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: result.delivery.id,
        taskId: result.delivery.taskId,
        status: result.delivery.status,
        reason: "task.deliver"
      },
      "self"
    );
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      autoIntegrated: result.autoIntegrated,
      state: result.task.state
    };
  });
}
async function taskRequestReviewRpc(ctx, p) {
  return taskDeliverRpc(ctx, { ...p, decision: p.decision ?? "request-review" });
}
async function taskAcceptRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const actor = requireString(p, "actor");
  const commits = optionalStringArray(p, "commits");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const taskForIntegrate = await loadTaskEnvelope(mount.env.fs, taskPath);
    const result = await taskAccept(mount.env, taskPath, {
      actor,
      commits,
      // Core requires integrate whenever delivery commits are non-empty.
      // Failure must not reach accepted/done/occupation release (lifecycle orders integrate first).
      integrate: makeCommitIntegrator(ctx, mount.workspaceRoot, taskForIntegrate)
    });
    emitTaskState(ctx, workspaceId, result.task, "task.accept");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: result.delivery.id,
        taskId: result.delivery.taskId,
        status: result.delivery.status,
        reason: "task.accept"
      },
      "self"
    );
    for (const claimId of result.task.claims) {
      if (claimId === "root") continue;
      ctx.events.emit(
        "concept.changed",
        workspaceId,
        { id: claimId, reason: "task.accept-projection" },
        "self"
      );
    }
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      state: result.task.state
    };
  });
}
async function taskRejectRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const actor = requireString(p, "actor");
  const note = optionalString(p, "note");
  const resume = p.resume !== false;
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await taskReject(mount.env, taskPath, { actor, note, resume });
    emitTaskState(ctx, workspaceId, result.task, "task.reject");
    ctx.events.emit(
      "delivery.updated",
      workspaceId,
      {
        id: result.delivery.id,
        taskId: result.delivery.taskId,
        status: result.delivery.status,
        reason: "task.reject"
      },
      "self"
    );
    return {
      workspaceId,
      taskPath,
      task: projectTask(result.task),
      delivery: projectDelivery(result.delivery),
      state: result.task.state
    };
  });
}
async function taskInterruptRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  return ctx.mutations.run(workspaceId, async () => {
    const before = await loadTaskEnvelope(mount.env.fs, taskPath).catch(() => null);
    const sessionId = before?.sessionId;
    ctx.host.markSelfWrite(workspaceId);
    const task = await taskInterrupt(mount.env, taskPath);
    emitTaskState(ctx, workspaceId, task, "task.interrupt");
    if (sessionId) {
      try {
        await ctx.runtime.stopSession(sessionId, "interrupt");
      } catch {
      }
    }
    return { workspaceId, taskPath, task: projectTask(task), state: task.state };
  });
}
async function taskCancelRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    await taskCancel(mount.env, taskPath);
    ctx.events.emit(
      "task.state",
      workspaceId,
      { path: taskPath, state: "interrupted", reason: "task.cancel" },
      "self"
    );
    return { workspaceId, taskPath, state: "interrupted", cancelled: true };
  });
}
async function taskStartSessionRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const profileId = requireProfileId(p);
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  const trustedOverride = parseOptionalA2APolicy(optionalString(p, "a2aPolicyOverride"));
  const bootstrapPrompt = optionalString(p, "bootstrapPrompt");
  const approvalId = optionalString(p, "approvalId");
  if (approvalId) {
    const approval = await ctx.a2a.get(approvalId);
    if (!approval || approval.status !== "approved") {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval is missing or not approved", {
        approvalId,
        status: approval?.status
      });
    }
    if (approval.taskPath !== taskPath) {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval taskPath mismatch", { approvalId });
    }
  } else {
    const taskForPolicy = await loadTaskEnvelope(mount.env.fs, taskPath);
    const a2aPolicy = await resolveStartSessionA2APolicy(mount.env.fs, {
      callerKind,
      taskRole: taskForPolicy.role,
      trustedOverride
    });
    const decision = evaluateA2A({
      callerKind,
      policy: a2aPolicy,
      profileAllowed: true
    });
    if (decision === "deny") {
      throw new RpcError(RPC_A2A_DENIED, "A2A policy denies starting a new runtime session", {
        policy: a2aPolicy,
        callerKind,
        role: taskForPolicy.role
      });
    }
    if (decision === "ask") {
      const task2 = taskForPolicy;
      const item = await ctx.a2a.add({
        id: makeApprovalId(),
        workspaceId,
        taskPath,
        taskId: task2.id,
        role: task2.role,
        profileId,
        policy: "ask",
        callerKind,
        bootstrapPrompt,
        status: "pending",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      ctx.events.emit(
        "a2a.ask",
        workspaceId,
        {
          approvalId: item.id,
          taskPath,
          role: task2.role,
          profileId,
          summary: `Role ${task2.role} requests startSession on profile ${profileId}`
        },
        "service"
      );
      if (task2.state === "running") {
        await ctx.mutations.run(workspaceId, async () => {
          ctx.host.markSelfWrite(workspaceId);
          const waited = await taskWait(mount.env, taskPath, {
            reason: "a2a-approval",
            summary: `Awaiting user A2A approval ${item.id}`
          });
          emitTaskState(ctx, workspaceId, waited, "a2a.ask");
        });
      }
      throw new RpcError(RPC_A2A_ASK, "A2A policy requires user approval before startSession", {
        approvalId: item.id,
        policy: "ask"
      });
    }
  }
  let task = await loadTaskEnvelope(mount.env.fs, taskPath);
  if (task.state === "queued" && callerKind === "user") {
    await taskClaimRpc(ctx, { workspaceId, taskPath });
    task = await loadTaskEnvelope(mount.env.fs, taskPath);
  }
  if (task.state !== "running" && task.state !== "waiting") {
    throw new RpcError(
      RPC_LIFECYCLE,
      `task.startSession requires running (or waiting after approval); got ${task.state}`
    );
  }
  if (task.state === "waiting") {
    await taskResumeRpc(ctx, { workspaceId, taskPath });
    task = await loadTaskEnvelope(mount.env.fs, taskPath);
  }
  task = await ensureTaskWorkspaceLane(ctx, workspaceId, task);
  const activeForRole = await findActiveManagedSessionForRole(ctx, workspaceId, task.role);
  if (activeForRole) {
    const boundToThisTask = task.sessionId === activeForRole.id || !!task.id && activeForRole.lastTaskId === task.id || activeForRole.lastTaskId === taskPath;
    if (boundToThisTask) {
      const boundTask = task.sessionId === activeForRole.id ? task : await ctx.mutations.run(workspaceId, async () => {
        ctx.host.markSelfWrite(workspaceId);
        return patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: activeForRole.id,
          updatedAt: mount.env.clock.now()
        });
      });
      return projectStartSessionResult(workspaceId, taskPath, boundTask, activeForRole, {
        cwd: boundTask.worktree || mount.workspaceRoot
      });
    }
    throw new RpcError(
      RPC_LIFECYCLE,
      `Role "${task.role}" already has an active managed session: ${activeForRole.id}`,
      {
        role: task.role,
        existingSessionId: activeForRole.id,
        existingState: activeForRole.state,
        existingTaskId: activeForRole.lastTaskId
      }
    );
  }
  const sessionId = makeSessionId();
  const cwd = task.worktree || mount.workspaceRoot;
  const workspaceLane = task.workspace || task.worktree || task.branch ? {
    workspace: task.workspace || mount.workspaceRoot,
    worktree: task.worktree || mount.workspaceRoot,
    branch: task.branch || "HEAD",
    targetBranch: task.targetBranch
  } : void 0;
  const sessionBootstrap = bootstrapPrompt?.trim() || buildSessionBootstrapPrompt(task, {
    workspaceRoot: mount.workspaceRoot,
    systemRoot: mount.systemRoot
  });
  let handle;
  try {
    handle = await ctx.runtime.startSession({
      sessionId,
      profileId,
      roleName: task.role,
      workspaceLane,
      runtimeWorkspace: { cwd },
      cwd,
      bootstrapPrompt: sessionBootstrap,
      lastTaskId: task.id || taskPath,
      workspace: workspaceId
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      const failed = await patchTaskEnvelope(mount.env.fs, taskPath, {
        state: "failed",
        wait: null,
        updatedAt: mount.env.clock.now()
      });
      emitTaskState(ctx, workspaceId, failed, "session.failed");
    });
    throw new RpcError(-32e3, message);
  }
  const bound = await ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const next = await patchTaskEnvelope(mount.env.fs, taskPath, {
      sessionId: handle.sessionId,
      updatedAt: mount.env.clock.now()
    });
    emitTaskState(ctx, workspaceId, next, "task.startSession");
    ctx.events.emit(
      "session.state",
      workspaceId,
      {
        sessionId: handle.sessionId,
        state: handle.state,
        profileId: handle.profileId,
        taskPath,
        reason: "task.startSession"
      },
      "self"
    );
    return next;
  });
  return projectStartSessionResult(workspaceId, taskPath, bound, {
    id: handle.sessionId,
    profileId: handle.profileId,
    adapterId: handle.adapterId,
    state: handle.state,
    roleName: handle.roleName,
    runtimeWorkspace: handle.runtimeWorkspace
  }, { cwd });
}
async function taskList(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tasks = await loadTaskEnvelopes(mount.env.fs);
  return {
    workspaceId,
    tasks: tasks.map(projectTask)
  };
}
async function taskGet(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  const task = await loadTaskEnvelope(mount.env.fs, taskPath);
  return { workspaceId, task: projectTask(task) };
}
async function deliveryList(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskId = optionalString(p, "taskId");
  const boxId = optionalString(p, "boxId");
  const role = optionalString(p, "role");
  let deliveries = await loadDeliveries(mount.env.fs, { taskId, boxId });
  if (role) deliveries = deliveries.filter((d) => d.role === role);
  return { workspaceId, deliveries: deliveries.map(projectDelivery) };
}
async function deliveryGet(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const id = requireString(p, "id");
  const deliveries = await loadDeliveries(mount.env.fs);
  const found = deliveries.find((d) => d.id === id);
  if (!found) throw new RpcError(-32004, `Delivery not found: ${id}`);
  return { workspaceId, delivery: projectDelivery(found) };
}
async function sessionList(ctx, p) {
  const workspaceId = optionalString(p, "workspaceId");
  const all = await ctx.runtime.registry.list();
  const projections = [];
  for (const rec of all) {
    if (workspaceId && rec.workspace && rec.workspace !== workspaceId) continue;
    const probe = await ctx.runtime.probe(rec.id);
    projections.push({
      sessionId: rec.id,
      profileId: rec.profileId,
      adapterId: rec.adapterId,
      state: probe.state,
      roleName: rec.roleName,
      alive: probe.alive,
      resumeCapable: probe.resumeCapable,
      lastTaskId: rec.lastTaskId,
      workspace: rec.workspace,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt
    });
  }
  return { sessions: projections };
}
async function sessionGet(ctx, p) {
  const sessionId = requireString(p, "sessionId");
  const rec = await ctx.runtime.registry.read(sessionId);
  if (!rec) throw new RpcError(-32004, `Session not found: ${sessionId}`);
  const probe = await ctx.runtime.probe(sessionId);
  const projection = {
    sessionId: rec.id,
    profileId: rec.profileId,
    adapterId: rec.adapterId,
    state: probe.state,
    roleName: rec.roleName,
    alive: probe.alive,
    resumeCapable: probe.resumeCapable,
    lastTaskId: rec.lastTaskId,
    workspace: rec.workspace,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt
  };
  return { session: projection };
}
async function a2aListPending(ctx, p) {
  const workspaceId = optionalString(p, "workspaceId");
  const pending = await ctx.a2a.listPending(workspaceId);
  return { approvals: pending };
}
async function a2aResolve(ctx, p) {
  const approvalId = requireString(p, "approvalId");
  const decisionRaw = requireString(p, "decision");
  const actor = optionalString(p, "actor") ?? "user";
  const decision = decisionRaw === "approve" || decisionRaw === "approved" ? "approved" : decisionRaw === "deny" || decisionRaw === "denied" ? "denied" : null;
  if (!decision) {
    throw new RpcError(-32602, "decision must be approve|deny");
  }
  const item = await ctx.a2a.resolve(approvalId, decision, actor);
  ctx.events.emit(
    "a2a.resolved",
    item.workspaceId,
    { approvalId, decision, actor, taskPath: item.taskPath },
    "self"
  );
  if (decision === "approved") {
    const started = await taskStartSessionRpc(ctx, {
      workspaceId: item.workspaceId,
      taskPath: item.taskPath,
      profileId: item.profileId,
      callerKind: "user",
      bootstrapPrompt: item.bootstrapPrompt,
      approvalId: item.id
    });
    return { approval: item, started };
  }
  return { approval: item, started: null };
}
var managedAutoDeliverInFlight = /* @__PURE__ */ new Set();
var managedAutoDeliverDone = /* @__PURE__ */ new Set();
function managedDeliverKey(sessionId, taskPath) {
  return `${sessionId}::${taskPath}`;
}
function mapRuntimeEventToService(ctx, ev) {
  void (async () => {
    try {
      const rec = await ctx.runtime.registry.read(ev.sessionId);
      const workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
      if (ev.type === "session.stdout_tail") {
        return;
      }
      ctx.events.emit(
        "session.state",
        workspaceId,
        {
          sessionId: ev.sessionId,
          runtimeEvent: ev.type,
          ..."pid" in ev ? { pid: ev.pid } : {},
          ..."exitCode" in ev ? { exitCode: ev.exitCode } : {},
          ..."error" in ev ? { error: ev.error } : {},
          ..."summary" in ev ? { summary: ev.summary } : {},
          ...ev.type === "session.prompt_complete" ? { assistantChars: ev.assistantText.length, stopReason: ev.stopReason } : {}
        },
        "service"
      );
      if (!rec?.lastTaskId) return;
      const mountInfos = ctx.host.list();
      for (const info of mountInfos) {
        if (rec.workspace && info.workspaceId !== rec.workspace) continue;
        const mount = ctx.host.get(info.workspaceId);
        if (!mount) continue;
        const tasks = await loadTaskEnvelopes(mount.env.fs);
        const task = tasks.find(
          (t) => t.sessionId === ev.sessionId || t.id === rec.lastTaskId
        );
        if (!task) continue;
        if (ev.type === "session.waiting_user" && task.state === "running") {
          await ctx.mutations.run(mount.workspaceId, async () => {
            ctx.host.markSelfWrite(mount.workspaceId);
            const waited = await taskWait(mount.env, task.path, {
              reason: "user-input",
              summary: ev.summary
            });
            emitTaskState(ctx, mount.workspaceId, waited, "session.waiting_user");
          });
        } else if (ev.type === "session.failed" && (task.state === "running" || task.state === "waiting")) {
          await ctx.mutations.run(mount.workspaceId, async () => {
            ctx.host.markSelfWrite(mount.workspaceId);
            const failed = await patchTaskEnvelope(mount.env.fs, task.path, {
              state: "failed",
              wait: null,
              updatedAt: mount.env.clock.now()
            });
            emitTaskState(ctx, mount.workspaceId, failed, "session.failed");
          });
        } else if (ev.type === "session.prompt_complete") {
          await tryManagedAutoDeliver(ctx, {
            workspaceId: mount.workspaceId,
            taskPath: task.path,
            sessionId: ev.sessionId,
            assistantText: ev.assistantText
          });
        }
      }
    } catch {
    }
  })();
}
async function tryManagedAutoDeliver(ctx, input) {
  const summary = input.assistantText.trim();
  if (!summary) {
    return;
  }
  const key = managedDeliverKey(input.sessionId, input.taskPath);
  if (managedAutoDeliverDone.has(key) || managedAutoDeliverInFlight.has(key)) {
    return;
  }
  managedAutoDeliverInFlight.add(key);
  try {
    const mount = ctx.host.get(input.workspaceId);
    if (!mount) return;
    await ctx.mutations.run(input.workspaceId, async () => {
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);
      if (task.state !== "running") {
        return;
      }
      if (task.sessionId && task.sessionId !== input.sessionId) {
        return;
      }
      const existing = await loadDeliveries(mount.env.fs, {
        taskId: task.id || input.taskPath
      });
      if (existing.some((d) => d.status === "ready")) {
        managedAutoDeliverDone.add(key);
        return;
      }
      ctx.host.markSelfWrite(input.workspaceId);
      const integrate = makeCommitIntegrator(ctx, mount.workspaceRoot, task);
      const policy = task.deliveryPolicy ?? "manual";
      const decision = policy === "agent-decide" ? "request-review" : void 0;
      const result = await taskDeliver(mount.env, input.taskPath, {
        summary,
        decision,
        integrate,
        // Never invent commits here — only forward an explicit list when provided.
        ...input.commits && input.commits.length > 0 ? { commits: input.commits } : {}
      });
      managedAutoDeliverDone.add(key);
      emitTaskState(ctx, input.workspaceId, result.task, "session.prompt_complete");
      ctx.events.emit(
        "delivery.updated",
        input.workspaceId,
        {
          id: result.delivery.id,
          taskId: result.delivery.taskId,
          status: result.delivery.status,
          reason: "session.prompt_complete",
          managedAuto: true
        },
        "self"
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const mount = ctx.host.get(input.workspaceId);
      if (!mount) return;
      const task = await loadTaskEnvelope(mount.env.fs, input.taskPath);
      if (task.state === "running" || task.state === "waiting") {
        try {
          await ctx.runtime.registry.update(input.sessionId, {
            lastError: `managed auto-deliver failed: ${message}`
          });
        } catch {
        }
        ctx.events.emit(
          "session.state",
          input.workspaceId,
          {
            sessionId: input.sessionId,
            taskPath: input.taskPath,
            taskState: task.state,
            runtimeEvent: "session.prompt_complete.failed",
            error: message,
            // Explicit: task remains non-terminal for retry.
            taskFailed: false
          },
          "service"
        );
      }
    } catch {
    }
  } finally {
    managedAutoDeliverInFlight.delete(key);
  }
}
function emitTaskState(ctx, workspaceId, task, reason) {
  ctx.events.emit(
    "task.state",
    workspaceId,
    {
      path: task.path,
      id: task.id,
      state: task.state,
      role: task.role,
      claims: task.claims,
      sessionId: task.sessionId,
      reason
    },
    "self"
  );
}
function requireWorkspaceId(ctx, p) {
  const explicit = optionalString(p, "workspaceId");
  if (explicit) return explicit;
  const fg = ctx.host.getForegroundId();
  if (fg) return fg;
  throw new RpcError(-32602, "workspaceId is required when no foreground workspace is set");
}
function requireString(p, key) {
  const v = p[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new RpcError(-32602, `Missing or invalid string param: ${key}`);
  }
  return v.trim();
}
function optionalString(p, key) {
  const v = p[key];
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "string") throw new RpcError(-32602, `Invalid string param: ${key}`);
  const t = v.trim();
  return t || void 0;
}
function optionalStringArray(p, key) {
  const v = p[key];
  if (v === void 0 || v === null) return void 0;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new RpcError(-32602, `Invalid string[] param: ${key}`);
  }
  return v;
}
function parseDeliveryPolicy(raw) {
  if (!raw) return void 0;
  if (raw === "manual" || raw === "bypass" || raw === "agent-decide") return raw;
  throw new RpcError(-32602, `Invalid deliveryPolicy: ${raw}`);
}
function parseOptionalA2APolicy(raw) {
  if (!raw) return void 0;
  if (raw === "allow" || raw === "ask" || raw === "deny") return raw;
  throw new RpcError(-32602, `Invalid a2aPolicy: ${raw}`);
}
function requireProfileId(p) {
  const profileId = optionalString(p, "profileId");
  if (!profileId) {
    throw new RpcError(
      -32602,
      "task.startSession requires explicit profileId (no fake-default or product-profile fallback)"
    );
  }
  return profileId;
}
async function resolveStartSessionA2APolicy(fs9, input) {
  if (input.callerKind === "user") return "allow";
  if (input.trustedOverride !== void 0) return input.trustedOverride;
  const registry = await loadRolesRegistry(fs9);
  const role = registry.roles.find((r) => r.name === input.taskRole);
  return roleA2APolicy(role);
}
function parseCallerKind(raw) {
  if (raw === "user" || raw === "role") return raw;
  throw new RpcError(-32602, `Invalid callerKind: ${raw}`);
}
function resolveConcept3(tent, p) {
  const id = optionalString(p, "id") ?? optionalString(p, "boxId");
  const path9 = optionalString(p, "path");
  if (id) {
    const byId = tent.byId.get(id);
    if (byId) return byId;
    throw new RpcError(-32004, `Concept not found: ${id}`);
  }
  if (path9) {
    const byPath = tent.byPath.get(path9);
    if (byPath) return byPath;
    throw new RpcError(-32004, `Concept not found: ${path9}`);
  }
  throw new RpcError(-32602, "docs.* requires id or path");
}
function projectConcept(box, includeBody, withChildren) {
  const title = typeof box.fm.title === "string" ? box.fm.title : void 0;
  const proj = {
    id: box.id,
    path: box.path,
    name: box.name,
    type: box.type,
    tags: box.tags,
    coordination: box.coordination,
    status: box.fm.status,
    assignee: typeof box.fm.owner === "string" ? box.fm.owner : void 0,
    archived: box.archived,
    invalid: box.invalid
  };
  if (title) proj.title = title;
  if (includeBody) {
    proj.bodyPreview = box.body.slice(0, 500);
  }
  if (withChildren) {
    proj.children = box.children.map((c) => projectConcept(c, includeBody, true));
  }
  return proj;
}
function parseArtifactRefs2(data) {
  const raw = data.artifactRefs;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item;
    const kind = rec.kind;
    const target = rec.target;
    if ((kind === "path" || kind === "dir" || kind === "commit" || kind === "url" || kind === "other") && typeof target === "string") {
      out.push({
        kind,
        target,
        label: typeof rec.label === "string" ? rec.label : void 0
      });
    }
  }
  return out;
}
function makeCommitIntegrator(ctx, workspaceRoot, task) {
  return async (commits) => {
    const refs = [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
    if (refs.length === 0) return;
    if (ctx.integrateCommits) {
      await ctx.integrateCommits(workspaceRoot, refs, task.role);
      return;
    }
    await integrateWorkspaceCommitsForTask(workspaceRoot, task, refs);
  };
}
async function integrateWorkspaceCommitsForTask(workspaceRoot, task, commits) {
  const contract = await resolveIntegrationContract(workspaceRoot, task);
  await integrateWorkspaceCommits(contract, commits);
}
async function resolveIntegrationContract(workspaceRoot, task) {
  const mountedRoot = nodePath2.resolve(workspaceRoot);
  if (task.workspace) {
    const claimed = nodePath2.resolve(task.workspace);
    if (!isSameWorkspaceRoot(claimed, mountedRoot)) {
      throw new Error(
        `Task envelope workspace mismatch: envelope=${task.workspace} mounted=${workspaceRoot}`
      );
    }
  }
  const real = await ensureRoleWorkspace(mountedRoot, task.role);
  if (task.branch && task.branch !== real.branch) {
    throw new Error(
      `Task envelope branch mismatch for role ${task.role}: envelope=${task.branch} expected=${real.branch}`
    );
  }
  if (task.targetBranch && task.targetBranch !== real.targetBranch) {
    throw new Error(
      `Task envelope targetBranch mismatch for role ${task.role}: envelope=${task.targetBranch} expected=${real.targetBranch}`
    );
  }
  if (task.worktree) {
    const claimedWt = nodePath2.resolve(task.worktree);
    const realWt = nodePath2.resolve(real.worktree);
    if (!isSameWorkspaceRoot(claimedWt, realWt)) {
      throw new Error(
        `Task envelope worktree mismatch for role ${task.role}: envelope=${task.worktree} expected=${real.worktree}`
      );
    }
  }
  return real;
}
async function ensureTaskWorkspaceLane(ctx, workspaceId, task) {
  if (task.worktree && task.branch && task.workspace && task.targetBranch) {
    return task;
  }
  const mount = ctx.host.require(workspaceId);
  return ctx.mutations.run(workspaceId, async () => {
    const lane = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, task.role);
    if (!lane) return task;
    ctx.host.markSelfWrite(workspaceId);
    return patchTaskEnvelope(mount.env.fs, task.path, {
      workspace: lane.workspace,
      worktree: lane.worktree,
      branch: lane.branch,
      targetBranch: lane.targetBranch,
      updatedAt: mount.env.clock.now()
    });
  });
}
async function findActiveManagedSessionForRole(ctx, workspaceId, roleName) {
  if (!roleName) return void 0;
  const all = await ctx.runtime.registry.list();
  return all.find(
    (rec) => rec.workspace === workspaceId && rec.roleName === roleName && SessionRegistry.isNonTerminal(rec.state) && rec.state !== "external"
  );
}
function projectStartSessionResult(workspaceId, taskPath, task, session, extra) {
  const cwd = extra?.cwd ?? session.runtimeWorkspace?.cwd ?? task.worktree ?? void 0;
  return {
    workspaceId,
    taskPath,
    task: projectTask(task),
    session: {
      sessionId: session.id,
      profileId: session.profileId,
      adapterId: session.adapterId,
      state: session.state,
      cwd
      // Do not expose pid in client projection by default — probe is internal.
    }
  };
}
function buildSessionBootstrapPrompt(task, roots) {
  const systemRoot = roots.systemRoot || systemRootFromWorkspace(roots.workspaceRoot);
  const card = taskContextCard(task.id || task.path, {
    path: task.path,
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
    label: `task:${task.role}`
  });
  const sessionSteps = sessionBootstrapPromptForTask(task, {
    workspaceRoot: roots.workspaceRoot,
    systemRoot
  });
  const aux = [];
  if (task.role) aux.push(`role: ${task.role}`);
  if (task.claims?.length) aux.push(`claims: ${task.claims.join(", ")}`);
  if (task.deliveryPolicy) aux.push(`deliveryPolicy: ${task.deliveryPolicy}`);
  return `${card.prompt}

--- Tent managed session bootstrap ---
` + (aux.length ? `${aux.join("\n")}
` : "") + `${sessionSteps}
`;
}
function projectTask(task) {
  const lane = task.workspace || task.worktree || task.branch || task.targetBranch ? {
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch
  } : void 0;
  return {
    path: task.path,
    id: task.id,
    role: task.role,
    claims: task.claims,
    status: task.status,
    state: task.state,
    manifest: task.manifest,
    dispatchedBy: task.dispatchedBy,
    deliveryPolicy: task.deliveryPolicy,
    assigneeKind: task.assigneeKind,
    sessionId: task.sessionId,
    wait: task.wait,
    activeDeliveryId: task.activeDeliveryId,
    workspaceLane: lane,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    prompt: task.prompt
  };
}
function projectDelivery(d) {
  return {
    path: d.path,
    id: d.id,
    taskId: d.taskId,
    boxId: d.boxId,
    role: d.role,
    status: d.status,
    summary: d.summary,
    commits: d.commits,
    integrationMode: d.integrationMode,
    review: d.review,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt
  };
}
function assertDocsWriteAllowed(tent, conceptId, frontmatter, tasks) {
  const protectedHit = PROTECTED_COLLAB_FIELDS.filter((k) => k in frontmatter);
  if (protectedHit.length === 0) return;
  const concept = tent.byId.get(conceptId);
  if (!concept) return;
  const active = hasActiveTaskForConcept(tent, conceptId, concept.path, tasks);
  const occupied = active || !!concept.fm.owner || concept.locked;
  if (!occupied) return;
  throw new RpcError(
    -32010,
    `docs.write cannot change collaboration projection fields while box has an active task: ${protectedHit.join(", ")}. Use task.* transitions.`,
    { fields: protectedHit, conceptId }
  );
}
function hasActiveTaskForConcept(tent, conceptId, conceptPath, tasks) {
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "taken") continue;
    const state = task.state;
    if (state && state !== "queued" && state !== "running" && state !== "waiting" && state !== "delivered") {
      if (state === "accepted" || state === "interrupted" || state === "failed" || state === "rejected") {
        continue;
      }
    }
    if (task.claims.includes(conceptId) || task.claims.includes("root")) return true;
    for (const claimId of task.claims) {
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (isAncestorPath2(claimed.path, conceptPath) || isAncestorPath2(conceptPath, claimed.path)) {
        return true;
      }
    }
  }
  return false;
}
function isAncestorPath2(ancestor, child) {
  if (!ancestor) return true;
  return child === ancestor || child.startsWith(ancestor + "/");
}

// src/service/auth.ts
import * as crypto from "node:crypto";
var AUTH_HEADER = "authorization";
var AUTH_TOKEN_HEADER = "x-tent-token";
function generateServiceToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function extractRequestToken(headers) {
  const auth = headerValue(headers, AUTH_HEADER) ?? headerValue(headers, "Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const direct = headerValue(headers, AUTH_TOKEN_HEADER) ?? headerValue(headers, "X-Tent-Token");
  if (direct) return direct.trim() || void 0;
  return void 0;
}
function tokensEqual(expected, provided) {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function headerValue(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (Array.isArray(v)) return v[0];
    return v;
  }
  return void 0;
}

// src/service/http-server.ts
async function createServiceHttpServer(options) {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 0;
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
  });
  await new Promise((resolve7, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, host, () => resolve7());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind Local Tent Service HTTP server");
  }
  const port = addr.port;
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve7, reject) => {
      server.close((err) => err ? reject(err) : resolve7());
    })
  };
}
async function handleRequest(req, res, options) {
  const { ctx, events, token } = options;
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    const body = await dispatchMethod(ctx, "service.health", {});
    writeJson2(res, 200, body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    if (!authorize(req, token)) {
      writeJson2(res, 401, { error: "Unauthorized: invalid or missing service token" });
      return;
    }
    handleSse(req, res, events);
    return;
  }
  if (req.method === "POST" && (url.pathname === "/rpc" || url.pathname === "/")) {
    if (!authorize(req, token)) {
      writeJson2(res, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_UNAUTHORIZED, message: "Unauthorized: invalid or missing service token" }
      });
      return;
    }
    const raw = await readBody(req);
    let message;
    try {
      message = JSON.parse(raw || "{}");
    } catch {
      writeJson2(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
      return;
    }
    const id = message.id ?? null;
    if (!message.method || typeof message.method !== "string") {
      writeJson2(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: method required" }
      });
      return;
    }
    const params = message.params === void 0 ? void 0 : Array.isArray(message.params) ? Object.fromEntries(
      message.params.map((v, i) => [String(i), v])
    ) : typeof message.params === "object" && message.params ? message.params : void 0;
    try {
      const result = await dispatchMethod(ctx, message.method, params);
      writeJson2(res, 200, { jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof RpcError) {
        writeJson2(res, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: error.code, message: error.message, data: error.data }
        });
        return;
      }
      const messageText = error instanceof Error ? error.message : String(error);
      writeJson2(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32e3, message: messageText }
      });
    }
    return;
  }
  writeJson2(res, 404, { error: "not found" });
}
function authorize(req, expectedToken) {
  const provided = extractRequestToken(req.headers);
  return tokensEqual(expectedToken, provided);
}
function handleSse(req, res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  res.write(": ok\n\n");
  const onEvent = (event) => {
    res.write(`event: ${event.type}
`);
    res.write(`data: ${JSON.stringify(event)}

`);
  };
  const unsubscribe = events.subscribe(onEvent);
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15e3);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}
function writeJson2(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve7, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve7(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// src/service/events.ts
import { randomBytes as randomBytes2 } from "node:crypto";
var EventBus = class {
  constructor() {
    this.listeners = /* @__PURE__ */ new Set();
    this.seq = 0;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(type, workspaceId, payload, source = "service") {
    const event = {
      id: `ev-${Date.now().toString(36)}-${(++this.seq).toString(36)}-${randomBytes2(3).toString("hex")}`,
      type,
      workspaceId,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      source,
      payload
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
    return event;
  }
  listenerCount() {
    return this.listeners.size;
  }
};

// src/service/mutation-bus.ts
var MutationBus = class {
  constructor() {
    this.tails = /* @__PURE__ */ new Map();
  }
  async run(workspaceId, action) {
    const prev = this.tails.get(workspaceId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve7) => {
      release = resolve7;
    });
    const chain = prev.catch(() => void 0).then(() => gate);
    this.tails.set(workspaceId, chain);
    await prev.catch(() => void 0);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(workspaceId) === chain) {
        this.tails.delete(workspaceId);
      }
    }
  }
};

// src/service/workspace-host.ts
import { watch } from "node:fs";
import * as fs7 from "node:fs/promises";
import * as path6 from "node:path";

// src/fs/node-fs.ts
import * as fs6 from "node:fs/promises";
import * as nodePath3 from "node:path";
var NodeFs = class {
  constructor(root) {
    this.root = nodePath3.resolve(root);
  }
  abs(p) {
    const resolved = nodePath3.resolve(this.root, p);
    const root = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const candidate = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (candidate !== root && !candidate.startsWith(root + nodePath3.sep)) {
      throw new Error(`Path escapes Tent root: ${p}`);
    }
    return resolved;
  }
  async listDir(dir) {
    const entries = await fs6.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path9) {
    return fs6.readFile(this.abs(path9), "utf8");
  }
  async writeFile(path9, content) {
    await fs6.mkdir(nodePath3.dirname(this.abs(path9)), { recursive: true });
    await fs6.writeFile(this.abs(path9), content, "utf8");
  }
  async exists(path9) {
    try {
      await fs6.access(this.abs(path9));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path9) {
    await fs6.mkdir(this.abs(path9), { recursive: true });
  }
  async move(from, to) {
    await fs6.mkdir(nodePath3.dirname(this.abs(to)), { recursive: true });
    await fs6.rename(this.abs(from), this.abs(to));
  }
  async remove(path9) {
    await fs6.rm(this.abs(path9), { recursive: true, force: true });
  }
  async withLock(path9, action) {
    const lockPath = this.abs(path9);
    await fs6.mkdir(nodePath3.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs6.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent is already running another write operation; try again later.");
        await fs6.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("Cannot acquire the Tent mutation lock.");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await fs6.rm(lockPath, { force: true });
    }
  }
};
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function isStaleLock(path9) {
  try {
    const stat2 = await fs6.stat(path9);
    return Date.now() - stat2.mtimeMs > 12e4;
  } catch {
    return true;
  }
}

// src/service/workspace-host.ts
var WorkspaceHost = class {
  constructor(options) {
    this.mounts = /* @__PURE__ */ new Map();
    this.foregroundId = null;
    this.watchTimers = /* @__PURE__ */ new Map();
    this.events = options.events;
    this.clock = options.clock ?? { now: () => (/* @__PURE__ */ new Date()).toISOString() };
    this.watchFn = options.watchFn ?? watch;
    this.watchDebounceMs = options.watchDebounceMs ?? 50;
  }
  list() {
    return [...this.mounts.values()].map((m) => this.toInfo(m));
  }
  get(workspaceId) {
    return this.mounts.get(workspaceId);
  }
  require(workspaceId) {
    const m = this.mounts.get(workspaceId);
    if (!m) throw new Error(`Workspace not mounted: ${workspaceId}`);
    return m;
  }
  getForegroundId() {
    return this.foregroundId;
  }
  async mount(workspaceRoot, opts) {
    const root = path6.resolve(workspaceRoot);
    const systemRoot = systemRootFromWorkspace(root);
    const rulesPath = path6.join(systemRoot, "RULES.md");
    try {
      await fs7.access(rulesPath);
    } catch {
      throw new Error(
        `No in-workspace Tent at ${systemRoot}. Expected ${TENT_SYSTEM_DIR}/RULES.md (B1 single-location model).`
      );
    }
    for (const existing of this.mounts.values()) {
      if (path6.resolve(existing.workspaceRoot) === root) {
        return this.toInfo(existing);
      }
    }
    const workspaceId = opts?.workspaceId?.trim() || makeWorkspaceId(root);
    if (this.mounts.has(workspaceId)) {
      throw new Error(`workspaceId already mounted: ${workspaceId}`);
    }
    const tentName = opts?.tentName?.trim() || path6.basename(root) || "tent";
    const fsa = new NodeFs(systemRoot);
    const env = {
      fs: fsa,
      clock: this.clock,
      tentName,
      tentRoot: systemRoot
    };
    const mount = {
      workspaceId,
      workspaceRoot: root,
      systemRoot,
      tentName,
      env,
      suppressWatchUntil: 0
    };
    mount.watcher = this.startWatch(mount);
    this.mounts.set(workspaceId, mount);
    if (!this.foregroundId) {
      this.foregroundId = workspaceId;
      this.events.emit("workspace.switched", workspaceId, {
        workspaceId,
        workspaceRoot: root,
        reason: "mount-default-foreground"
      });
    }
    this.events.emit("service.health", workspaceId, {
      action: "workspace.mounted",
      workspaceId,
      workspaceRoot: root
    });
    return this.toInfo(mount);
  }
  async unmount(workspaceId) {
    const mount = this.mounts.get(workspaceId);
    if (!mount) return;
    this.stopWatch(mount);
    this.mounts.delete(workspaceId);
    if (this.foregroundId === workspaceId) {
      const next = this.mounts.keys().next();
      this.foregroundId = next.done ? null : next.value;
      if (this.foregroundId) {
        this.events.emit("workspace.switched", this.foregroundId, {
          workspaceId: this.foregroundId,
          reason: "unmount-reselect"
        });
      }
    }
    this.events.emit("service.health", workspaceId, {
      action: "workspace.unmounted",
      workspaceId
    });
  }
  setForeground(workspaceId) {
    const mount = this.require(workspaceId);
    if (this.foregroundId !== workspaceId) {
      this.foregroundId = workspaceId;
      this.events.emit("workspace.switched", workspaceId, {
        workspaceId,
        workspaceRoot: mount.workspaceRoot,
        reason: "setForeground"
      });
    }
    return this.toInfo(mount);
  }
  /** Call before service-originated disk writes to reduce watch self-echo noise. */
  markSelfWrite(workspaceId, holdMs = 200) {
    const mount = this.mounts.get(workspaceId);
    if (!mount) return;
    mount.suppressWatchUntil = Date.now() + holdMs;
  }
  async dispose() {
    for (const id of [...this.mounts.keys()]) {
      await this.unmount(id);
    }
    for (const timer of this.watchTimers.values()) clearTimeout(timer);
    this.watchTimers.clear();
  }
  toInfo(m) {
    return {
      workspaceId: m.workspaceId,
      workspaceRoot: m.workspaceRoot,
      systemRoot: m.systemRoot,
      tentName: m.tentName,
      foreground: this.foregroundId === m.workspaceId
    };
  }
  startWatch(mount) {
    const watcher = this.watchFn(
      mount.systemRoot,
      { recursive: true },
      (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        if (rel === "mutation.lock" || rel.endsWith("/mutation.lock")) return;
        if (Date.now() < mount.suppressWatchUntil) return;
        const prev = this.watchTimers.get(mount.workspaceId);
        if (prev) clearTimeout(prev);
        this.watchTimers.set(
          mount.workspaceId,
          setTimeout(() => {
            this.watchTimers.delete(mount.workspaceId);
            if (rel.startsWith("temp/") || rel === "temp") {
              this.events.emit("task.state", mount.workspaceId, {
                reason: "watch",
                path: rel
              });
              return;
            }
            this.events.emit("concept.changed", mount.workspaceId, {
              reason: "watch",
              path: rel
            });
          }, this.watchDebounceMs)
        );
      }
    );
    watcher.on("error", () => {
    });
    return watcher;
  }
  stopWatch(mount) {
    const timer = this.watchTimers.get(mount.workspaceId);
    if (timer) {
      clearTimeout(timer);
      this.watchTimers.delete(mount.workspaceId);
    }
    try {
      mount.watcher?.close();
    } catch {
    }
    mount.watcher = void 0;
  }
};
function makeWorkspaceId(workspaceRoot) {
  const base = path6.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "ws";
  const hash = Buffer.from(path6.resolve(workspaceRoot)).toString("base64url").slice(0, 10);
  return `ws-${base}-${hash}`;
}

// src/service/data-dir.ts
import * as fs8 from "node:fs/promises";
import * as os3 from "node:os";
import * as path7 from "node:path";
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path7.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path7.join(os3.homedir(), "AppData", "Roaming");
    return path7.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path7.join(os3.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path7.join(os3.homedir(), ".local", "state");
  return path7.join(xdg, "tent");
}
function serviceEndpointPath(dataDir) {
  return path7.join(dataDir, "service.json");
}
async function writeServiceEndpoint(dataDir, record) {
  await fs8.mkdir(dataDir, { recursive: true });
  const file = serviceEndpointPath(dataDir);
  await fs8.writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return file;
}
async function readServiceEndpoint(dataDir) {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs8.readFile(file, "utf8");
    const data = JSON.parse(raw);
    if (typeof data.pid !== "number" || typeof data.port !== "number" || typeof data.host !== "string") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
async function removeServiceEndpoint(dataDir) {
  try {
    await fs8.rm(serviceEndpointPath(dataDir), { force: true });
  } catch {
  }
}

// src/runtime/process-supervisor.ts
import { spawn as spawn3 } from "node:child_process";
var ProcessSupervisor = class {
  constructor(options = {}) {
    this.children = /* @__PURE__ */ new Map();
    this.gracefulMs = options.gracefulMs ?? 2e3;
    this.stdoutRingBytes = options.stdoutRingBytes ?? 0;
    this.onExit = options.onExit;
    this.onStdout = options.onStdout;
  }
  listLive() {
    return [...this.children.entries()].filter(([, c]) => !c.exited).map(([id]) => id);
  }
  get(sessionId) {
    const live = this.children.get(sessionId);
    if (!live) return null;
    return {
      sessionId,
      pid: live.child.pid ?? -1,
      startedAt: live.startedAt,
      exitCode: live.exitCode,
      signal: live.signal,
      exited: live.exited
    };
  }
  isAlive(sessionId) {
    const live = this.children.get(sessionId);
    if (!live || live.exited) return false;
    const pid = live.child.pid;
    if (pid == null || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  async start(sessionId, launch) {
    if (this.children.has(sessionId) && this.isAlive(sessionId)) {
      throw new Error(`Process already live for session ${sessionId}`);
    }
    const env = {
      ...process.env,
      ...launch.env
    };
    for (const key of Object.keys(env)) {
      if (/^(.*_)?(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) && launch.env[key] === void 0) {
        delete env[key];
      }
    }
    const child = spawn3(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Detached false so service shutdown can reap children as a group.
      detached: false
    });
    if (child.pid == null) {
      throw new Error(`Failed to spawn process for session ${sessionId}`);
    }
    const live = {
      sessionId,
      child,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      exited: false,
      stdoutBuf: ""
    };
    this.children.set(sessionId, live);
    const appendRing = (chunk) => {
      if (this.stdoutRingBytes <= 0) return;
      live.stdoutBuf = (live.stdoutBuf + chunk.toString("utf8")).slice(-this.stdoutRingBytes);
    };
    child.stdout?.on("data", (chunk) => {
      appendRing(chunk);
      this.onStdout?.(sessionId, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      appendRing(chunk);
      this.onStdout?.(sessionId, chunk.toString("utf8"));
    });
    child.on("exit", (code, signal) => {
      live.exited = true;
      live.exitCode = code;
      live.signal = signal;
      if (live.killTimer) {
        clearTimeout(live.killTimer);
        live.killTimer = void 0;
      }
      this.onExit?.({
        sessionId,
        exitCode: code,
        signal: signal ?? void 0
      });
    });
    child.on("error", () => {
      if (!live.exited) {
        live.exited = true;
        live.exitCode = null;
        live.signal = "error";
        this.onExit?.({ sessionId, exitCode: null, signal: "error" });
      }
    });
    return {
      sessionId,
      pid: child.pid,
      startedAt: live.startedAt,
      exitCode: null,
      signal: null,
      exited: false
    };
  }
  /**
   * Graceful stop → timeout → force kill (Windows: taskkill tree).
   */
  async stop(sessionId, options) {
    const live = this.children.get(sessionId);
    if (!live || live.exited) {
      this.children.delete(sessionId);
      return;
    }
    const gracefulMs = options?.gracefulMs ?? this.gracefulMs;
    const signal = options?.signal ?? "SIGTERM";
    const pid = live.child.pid;
    try {
      live.child.kill(signal);
    } catch {
    }
    if (live.exited) {
      this.children.delete(sessionId);
      return;
    }
    await new Promise((resolve7) => {
      const done = () => {
        if (live.killTimer) {
          clearTimeout(live.killTimer);
          live.killTimer = void 0;
        }
        resolve7();
      };
      if (live.exited) {
        done();
        return;
      }
      const onExit = () => done();
      live.child.once("exit", onExit);
      live.killTimer = setTimeout(() => {
        live.child.removeListener("exit", onExit);
        void this.forceKill(live).finally(done);
      }, gracefulMs);
    });
    this.children.delete(sessionId);
  }
  /** Stop every live child (service shutdown default for push-mode). */
  async stopAll(reason = "shutdown") {
    void reason;
    const ids = this.listLive();
    await Promise.all(ids.map((id) => this.stop(id)));
  }
  getStdoutTail(sessionId) {
    return this.children.get(sessionId)?.stdoutBuf ?? "";
  }
  async forceKill(live) {
    if (live.exited) return;
    const pid = live.child.pid;
    if (pid == null) return;
    if (process.platform === "win32") {
      await new Promise((resolve7) => {
        const killer = spawn3("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.on("exit", () => resolve7());
        killer.on("error", () => resolve7());
        setTimeout(resolve7, 1500);
      });
    } else {
      try {
        live.child.kill("SIGKILL");
      } catch {
      }
    }
    if (!live.exited) {
      await new Promise((resolve7) => {
        const t = setTimeout(resolve7, 500);
        live.child.once("exit", () => {
          clearTimeout(t);
          resolve7();
        });
      });
    }
  }
};

// src/runtime/agent-runtime.ts
function handleFrom(record) {
  return {
    sessionId: record.id,
    profileId: record.profileId,
    adapterId: record.adapterId,
    state: record.state,
    pid: record.pid,
    roleName: record.roleName,
    runtimeWorkspace: record.runtimeWorkspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
var AgentRuntime = class {
  constructor(options) {
    this.profiles = /* @__PURE__ */ new Map();
    this.adapters = /* @__PURE__ */ new Map();
    this.managed = /* @__PURE__ */ new Map();
    this.sinks = /* @__PURE__ */ new Map();
    this.globalSinks = /* @__PURE__ */ new Set();
    this.closed = false;
    this.registry = new SessionRegistry(options.dataDir);
    for (const p of options.profiles ?? []) {
      this.profiles.set(p.id, p);
    }
    if (!this.profiles.has("fake-default")) {
      this.profiles.set("fake-default", {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true }
      });
    }
    const adapterList = options.adapters ?? [createFakeAdapter(), createGrokAcpAdapter()];
    for (const a of adapterList) {
      this.adapters.set(a.id, a);
    }
    if (!this.adapters.has(FAKE_ADAPTER_ID)) {
      this.adapters.set(FAKE_ADAPTER_ID, createFakeAdapter());
    }
    if (!this.adapters.has(GROK_ACP_ADAPTER_ID)) {
      this.adapters.set(GROK_ACP_ADAPTER_ID, createGrokAcpAdapter());
    }
    this.supervisor = new ProcessSupervisor({
      gracefulMs: options.gracefulMs ?? 2e3,
      stdoutRingBytes: options.captureStdout === false ? 0 : 4096,
      onExit: (info) => {
        void this.onChildExit(info.sessionId, info.exitCode, info.signal);
      },
      onStdout: (sessionId, text) => {
        if (options.captureStdout === false) return;
        this.emit({ type: "session.stdout_tail", sessionId, text });
      }
    });
  }
  registerProfile(profile) {
    this.profiles.set(profile.id, profile);
  }
  /** Machine-local catalog snapshot (for profile.list projection). */
  listProfiles() {
    return [...this.profiles.values()];
  }
  registerAdapter(adapter) {
    this.adapters.set(adapter.id, adapter);
  }
  /** Subscribe to all runtime events (service fan-out helper). */
  subscribeAll(sink) {
    this.globalSinks.add(sink);
    return () => this.globalSinks.delete(sink);
  }
  subscribe(sessionId, sink) {
    let set = this.sinks.get(sessionId);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.sinks.set(sessionId, set);
    }
    set.add(sink);
    return () => {
      set.delete(sink);
      if (set.size === 0) this.sinks.delete(sessionId);
    };
  }
  async startSession(req) {
    this.assertOpen();
    if (!isSessionId(req.sessionId)) {
      throw new Error(`Invalid session id: ${req.sessionId}`);
    }
    const existing = await this.registry.read(req.sessionId);
    if (existing && SessionRegistry.isNonTerminal(existing.state)) {
      throw new Error(`Session already active: ${req.sessionId}`);
    }
    const profile = this.profiles.get(req.profileId);
    if (!profile) {
      throw new Error(`Unknown AgentProfile: ${req.profileId}`);
    }
    const adapter = this.adapters.get(profile.adapterId);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${profile.adapterId}`);
    }
    const caps = adapter.capabilities();
    if (!caps.canSpawn) {
      throw new Error(`Adapter ${adapter.id} cannot spawn (pull-host only)`);
    }
    const cwd = req.runtimeWorkspace?.cwd ?? req.cwd ?? req.workspaceLane?.worktree;
    if (!cwd) {
      throw new Error("startSession requires runtimeWorkspace.cwd, cwd, or workspaceLane.worktree");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const record = {
      id: req.sessionId,
      profileId: profile.id,
      adapterId: adapter.id,
      roleName: req.roleName,
      state: "starting",
      runtimeWorkspace: { cwd },
      workspace: req.workspace ?? req.workspaceLane?.workspace,
      workspaceLane: req.workspaceLane,
      createdAt: now,
      updatedAt: now,
      lastTaskId: req.lastTaskId
    };
    await this.registry.write(record);
    this.emit({ type: "session.starting", sessionId: req.sessionId });
    try {
      const plan = {
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: req.roleName,
        cwd,
        env: { ...profile.env ?? {}, ...req.env ?? {} },
        bootstrapPrompt: req.bootstrapPrompt,
        command: profile.command,
        args: profile.args,
        extras: {
          fake: profile.fake,
          grokAcp: profile.grokAcp
        }
      };
      let pid;
      let resumeToken;
      let sawLive = false;
      if (typeof adapter.startManagedSession === "function") {
        const managed = await adapter.startManagedSession(plan, (ev) => {
          if (ev.type === "session.live") sawLive = true;
          this.emit(ev);
        });
        this.managed.set(req.sessionId, managed);
        pid = managed.pid;
        if (managed.providerSessionId) {
          resumeToken = managed.providerSessionId;
        }
      } else {
        const launch = await adapter.resolveLaunch(plan);
        const proc = await this.supervisor.start(req.sessionId, launch);
        pid = proc.pid;
        resumeToken = profile.fake?.canResume || adapter.capabilities().canResume ? `fake-resume:${req.sessionId}` : void 0;
        this.emit({ type: "session.live", sessionId: req.sessionId, pid: proc.pid });
        sawLive = true;
      }
      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken,
        lastError: void 0,
        exitCode: void 0,
        stopReason: void 0
      });
      if (!sawLive) {
        this.emit({ type: "session.live", sessionId: req.sessionId, pid });
      }
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.registry.update(req.sessionId, {
        state: "failed",
        lastError: message,
        pid: void 0
      });
      this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
      throw Object.assign(new Error(message), { session: handleFrom(failed) });
    }
  }
  async resumeSession(req) {
    this.assertOpen();
    const record = await this.registry.read(req.sessionId);
    if (!record) throw new Error(`Session not found: ${req.sessionId}`);
    const profile = this.profiles.get(record.profileId);
    if (!profile) throw new Error(`Unknown AgentProfile: ${record.profileId}`);
    const adapter = this.adapters.get(record.adapterId);
    if (!adapter) throw new Error(`Unknown adapter: ${record.adapterId}`);
    const token = req.resumeToken ?? record.resumeToken;
    if (!token) {
      throw new Error(`Session ${req.sessionId} has no resume token`);
    }
    if (!adapter.capabilities().canResume && !profile.fake?.canResume) {
      throw new Error(`Adapter ${adapter.id} cannot resume`);
    }
    const cwd = req.runtimeWorkspace?.cwd ?? req.cwd ?? record.runtimeWorkspace?.cwd;
    if (!cwd) throw new Error("resumeSession requires a cwd");
    return this.startSession({
      sessionId: req.sessionId,
      profileId: record.profileId,
      roleName: record.roleName,
      workspaceLane: record.workspaceLane,
      runtimeWorkspace: { cwd },
      workspace: record.workspace,
      lastTaskId: record.lastTaskId,
      env: req.env,
      bootstrapPrompt: void 0
    });
  }
  async stopSession(sessionId, reason) {
    this.assertOpen();
    const record = await this.registry.read(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);
    const managed = this.managed.get(sessionId);
    if (managed) {
      try {
        await managed.stop(reason);
      } finally {
        this.managed.delete(sessionId);
      }
    } else if (this.supervisor.isAlive(sessionId)) {
      await this.supervisor.stop(sessionId, { signal: "SIGTERM" });
    }
    const current = await this.registry.read(sessionId);
    if (!current) return;
    if (SessionRegistry.isNonTerminal(current.state)) {
      await this.registry.update(sessionId, {
        state: "stopped",
        stopReason: reason,
        pid: void 0
      });
      this.emit({
        type: "session.exited",
        sessionId,
        exitCode: current.exitCode ?? 0
      });
    } else {
      await this.registry.update(sessionId, {
        stopReason: reason,
        pid: void 0,
        state: current.state === "failed" ? "failed" : "stopped"
      });
    }
  }
  async probe(sessionId) {
    const record = await this.registry.read(sessionId);
    if (!record) {
      return {
        sessionId,
        state: "failed",
        alive: false,
        resumeCapable: false,
        lastError: "session not found"
      };
    }
    const managed = this.managed.get(sessionId);
    const alive = managed ? managed.isAlive() : this.supervisor.isAlive(sessionId);
    const profile = this.profiles.get(record.profileId);
    const adapter = this.adapters.get(record.adapterId);
    const resumeCapable = Boolean(
      record.resumeToken && (adapter?.capabilities().canResume || profile?.fake?.canResume)
    );
    if (SessionRegistry.isNonTerminal(record.state) && !alive) {
      if (managed) this.managed.delete(sessionId);
      const nextState = resumeCapable ? "stopped" : "failed";
      const updated = await this.registry.update(sessionId, {
        state: nextState,
        pid: void 0,
        lastError: record.lastError ?? (resumeCapable ? "process not alive; resume token retained" : "process not alive and not resume-capable")
      });
      return {
        sessionId,
        state: updated.state,
        alive: false,
        resumeCapable,
        lastError: updated.lastError,
        exitCode: updated.exitCode
      };
    }
    return {
      sessionId,
      state: record.state,
      alive,
      resumeCapable,
      pid: alive ? record.pid : void 0,
      lastError: record.lastError,
      exitCode: record.exitCode
    };
  }
  /**
   * On service start: probe all non-terminal sessions and reconcile.
   * Dead PID + not resume-capable → failed/stopped; resume-capable → keep metadata.
   * Note: managed ACP clients do not survive process restart — probe marks them dead.
   */
  async reconcileOnBoot() {
    const all = await this.registry.list();
    const results = [];
    for (const rec of all) {
      if (!SessionRegistry.isNonTerminal(rec.state)) continue;
      results.push(await this.probe(rec.id));
    }
    return results;
  }
  /** Service shutdown: stop push children this runtime started (window close does not call this). */
  async shutdown() {
    if (this.closed) return;
    const managedIds = [...this.managed.keys()];
    const live = /* @__PURE__ */ new Set([...this.supervisor.listLive(), ...managedIds]);
    for (const id of live) {
      try {
        await this.stopSession(id, "shutdown");
      } catch {
        const m = this.managed.get(id);
        if (m) {
          try {
            await m.stop("shutdown");
          } catch {
          }
          this.managed.delete(id);
        } else {
          await this.supervisor.stop(id);
        }
      }
    }
    await this.supervisor.stopAll("shutdown");
    this.closed = true;
  }
  async onChildExit(sessionId, exitCode, signal) {
    const record = await this.registry.read(sessionId);
    if (!record) return;
    const adapter = this.adapters.get(record.adapterId);
    let event;
    if (adapter) {
      event = adapter.mapExit(exitCode, signal);
      event = { ...event, sessionId };
    } else if (exitCode === 0 || signal === "SIGTERM" || signal === "SIGINT") {
      event = { type: "session.exited", sessionId, exitCode };
    } else {
      event = {
        type: "session.failed",
        sessionId,
        error: signal ? `signal:${signal}` : `exit:${exitCode}`
      };
    }
    const terminalState = event.type === "session.failed" ? "failed" : "stopped";
    if (SessionRegistry.isNonTerminal(record.state) || record.state === "starting") {
      await this.registry.update(sessionId, {
        state: terminalState,
        pid: void 0,
        exitCode,
        lastError: event.type === "session.failed" ? event.error : record.lastError
      });
    } else {
      await this.registry.update(sessionId, {
        pid: void 0,
        exitCode
      });
    }
    this.emit(event);
  }
  emit(ev) {
    for (const sink of this.globalSinks) {
      try {
        sink(ev);
      } catch {
      }
    }
    const set = this.sinks.get(ev.sessionId);
    if (!set) return;
    for (const sink of set) {
      try {
        sink(ev);
      } catch {
      }
    }
  }
  assertOpen() {
    if (this.closed) throw new Error("AgentRuntime is shut down");
  }
};
function createAgentRuntime(options) {
  return new AgentRuntime(options);
}

// src/service/service.ts
var SERVICE_VERSION = "0.1.0-b5";
async function startLocalTentService(options = {}) {
  const dataDir = options.dataDir ?? defaultServiceDataDir();
  const version = options.version ?? SERVICE_VERSION;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const getPid = options.getPid ?? (() => process.pid);
  const token = options.token ?? generateServiceToken();
  const events = new EventBus();
  const mutations = new MutationBus();
  const workspaceHost = new WorkspaceHost({ events });
  const a2a = new A2AApprovalStore(dataDir);
  await a2a.ensureLoaded();
  const profiles = options.profiles ?? await ensureDefaultProfiles(dataDir);
  const runtime = createAgentRuntime({ dataDir, profiles });
  await runtime.reconcileOnBoot();
  const ctx = {
    host: workspaceHost,
    mutations,
    events,
    version,
    startedAt,
    getPid,
    runtime,
    a2a,
    dataDir,
    integrateCommits: options.integrateCommits
  };
  runtime.subscribeAll((ev) => mapRuntimeEventToService(ctx, ev));
  const httpServer = await createServiceHttpServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    ctx,
    events,
    token
  });
  let endpoint = null;
  if (options.writeEndpoint !== false) {
    endpoint = {
      pid: getPid(),
      host: httpServer.host,
      port: httpServer.port,
      startedAt,
      version,
      token
    };
    await writeServiceEndpoint(dataDir, endpoint);
  }
  events.emit("service.health", "", {
    action: "started",
    url: httpServer.url,
    pid: getPid()
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    events.emit("service.health", "", { action: "stopping" });
    try {
      await runtime.shutdown();
    } catch {
    }
    await workspaceHost.dispose();
    await httpServer.close();
    if (options.writeEndpoint !== false) {
      await removeServiceEndpoint(dataDir);
    }
  };
  return {
    url: httpServer.url,
    host: httpServer.host,
    port: httpServer.port,
    dataDir,
    token,
    events,
    hostApi: workspaceHost,
    runtime,
    ctx,
    endpoint,
    stop
  };
}

// src/service/cli.ts
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "start";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      [
        "tent-service \u2014 Local Tent Service (B5)",
        "",
        "Usage:",
        "  tent-service start [--port <n>] [--data-dir <path>] [--mount <workspace>]",
        "  tent-service status",
        "",
        "Environment:",
        "  TENT_SERVICE_DATA_DIR  machine-local data area (default: %APPDATA%/Tent)",
        "",
        "Auth:",
        "  Loopback token is written to <dataDir>/service.json and required on /rpc + /events.",
        "  GET /health remains open for attach discovery (no mutation).",
        ""
      ].join("\n")
    );
    return;
  }
  if (cmd === "status") {
    const dataDir2 = flagValue(args, "--data-dir") ?? defaultServiceDataDir();
    const ep = await readServiceEndpoint(dataDir2);
    if (!ep) {
      process.stdout.write(`No service endpoint in ${dataDir2}
`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify(ep, null, 2) + "\n");
    return;
  }
  if (cmd !== "start") {
    process.stderr.write(`Unknown command: ${cmd}
`);
    process.exitCode = 2;
    return;
  }
  const portRaw = flagValue(args, "--port");
  const dataDir = flagValue(args, "--data-dir");
  const mountPath = flagValue(args, "--mount");
  const service = await startLocalTentService({
    port: portRaw ? Number(portRaw) : 0,
    dataDir: dataDir ? path8.resolve(dataDir) : void 0
  });
  if (mountPath) {
    const info = await service.hostApi.mount(path8.resolve(mountPath));
    process.stdout.write(`Mounted ${info.workspaceRoot} as ${info.workspaceId}
`);
  }
  process.stdout.write(
    `Local Tent Service listening on ${service.url}
dataDir: ${service.dataDir}
pid: ${process.pid}
token: (written to service.json under dataDir; required on /rpc and /events)
Attach: POST ${service.url}/rpc  |  events: GET ${service.url}/events  |  health: GET ${service.url}/health
`
  );
  const shutdown = async (signal) => {
    process.stdout.write(`
Stopping (${signal})...
`);
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return void 0;
  return args[i + 1];
}
main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack || error.message : String(error)) + "\n");
  process.exit(1);
});
