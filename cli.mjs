#!/usr/bin/env node

// src/cli/tent.ts
import * as path6 from "node:path";
import * as fs6 from "node:fs/promises";
import * as os2 from "node:os";
import { fileURLToPath as fileURLToPath2 } from "node:url";

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
  async readFile(path7) {
    return fs.readFile(this.abs(path7), "utf8");
  }
  async writeFile(path7, content) {
    await fs.mkdir(nodePath.dirname(this.abs(path7)), { recursive: true });
    await fs.writeFile(this.abs(path7), content, "utf8");
  }
  async exists(path7) {
    try {
      await fs.access(this.abs(path7));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path7) {
    await fs.mkdir(this.abs(path7), { recursive: true });
  }
  async move(from, to) {
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }
  async remove(path7) {
    await fs.rm(this.abs(path7), { recursive: true, force: true });
  }
  async withLock(path7, action) {
    const lockPath = this.abs(path7);
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
async function isStaleLock(path7) {
  try {
    const stat2 = await fs.stat(path7);
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
async function backupCorruptRegistry(fs7, path7) {
  const backupPath = `${path7}.corrupt-${timestamp()}`;
  await fs7.writeFile(backupPath, await fs7.readFile(path7));
  return backupPath;
}
function warnRegistryRecovered(path7, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path7} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
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
function workspaceRootFromSystemRoot(systemRoot) {
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  if (base !== TENT_SYSTEM_DIR) return void 0;
  const parent = normalized.replace(/[\\/]+[^\\/]+$/, "");
  return parent || void 0;
}
function systemRootFromWorkspace(workspaceRoot) {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const sep2 = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${sep2}${TENT_SYSTEM_DIR}`;
}
function isOperationalPath(relativePath2) {
  const path7 = relativePath2.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path7) return false;
  const top = path7.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}

// src/core/order.ts
var ROOT_KEY = "__root__";
async function loadOrder(fs7) {
  if (!await fs7.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs7.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs7, ORDER_PATH);
    await saveOrder(fs7, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs7, map) {
  await fs7.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
async function loadTypeRegistry(fs7) {
  if (!await fs7.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs7.readFile(TYPE_REGISTRY_PATH));
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
async function loadTent(fs7) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs7);
  const top = await fs7.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadBoxInto(fs7, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs7);
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
async function loadBox(fs7, path7, parent, registry) {
  if (isOperationalPath(path7)) return null;
  const boxFile = boxNotePath(path7);
  if (!await fs7.exists(boxFile)) {
    return null;
  }
  const raw = await fs7.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path7);
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
    path: path7,
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
    box.invalidRootId = path7;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs7.listDir(path7);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs7, join(path7, entry.name), box, registry, box.children);
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
async function loadBoxInto(fs7, path7, parent, registry, target) {
  if (isOperationalPath(path7)) return;
  const box = await loadBox(fs7, path7, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs7.listDir(path7);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs7, join(path7, entry.name), parent, registry, target);
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
function baseName(path7) {
  const i = path7.lastIndexOf("/");
  return i === -1 ? path7 : path7.slice(i + 1);
}
function dirName(path7) {
  const i = path7.lastIndexOf("/");
  return i === -1 ? "" : path7.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs7, action) {
  return fs7.withLock ? fs7.withLock(MUTATION_LOCK_PATH, action) : action();
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
var LEGACY_BOX_ID_PREFIX = "bx-";
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
function isLegacyBoxId(id) {
  return id.startsWith(LEGACY_BOX_ID_PREFIX) && id.length > LEGACY_BOX_ID_PREFIX.length;
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
var DEFAULT_TAG_REGISTRY = { tags: [] };
async function loadTagRegistry(fs7) {
  if (!await fs7.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs7.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    const backupPath = await backupCorruptRegistry(fs7, TAGS_REGISTRY_PATH);
    const recovered = await recoverTagRegistryFromBoxes(fs7);
    await saveTagRegistryUnlocked(fs7, recovered);
    warnRegistryRecovered(TAGS_REGISTRY_PATH, backupPath, "recovered");
    return recovered;
  }
}
async function saveTagRegistryUnlocked(fs7, registry) {
  await fs7.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
async function addRegistryTag(fs7, name) {
  await withTentMutation(fs7, async () => addRegistryTagUnlocked(fs7, name));
}
async function addRegistryTagUnlocked(fs7, name) {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs7);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs7, registry);
  }
}
async function addTag(fs7, boxId, name) {
  await withTentMutation(fs7, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs7);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    await addRegistryTagUnlocked(fs7, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs7, box, tags);
  });
}
async function removeTag(fs7, boxId, name) {
  await withTentMutation(fs7, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs7);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    await writeBoxTags(fs7, box, box.tags.filter((item) => item !== tag));
  });
}
async function removeRegistryTag(fs7, name) {
  await withTentMutation(fs7, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs7);
    await saveTagRegistryUnlocked(fs7, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs7);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs7, box, box.tags.filter((item) => item !== tag));
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
async function writeBoxTags(fs7, box, tags) {
  const path7 = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs7.readFile(path7));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs7.writeFile(path7, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
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
async function recoverTagRegistryFromBoxes(fs7) {
  const tent = await loadTent(fs7);
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
var DEFAULT_ROLES_REGISTRY = {
  roles: []
};
async function loadRolesRegistry(fs7) {
  if (!await fs7.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs7.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs7, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs7, ROLES_REGISTRY_PATH, reset);
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
  const a2a = normalizeA2APolicy(value.a2aPolicy);
  if (a2a) role.a2aPolicy = a2a;
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}
function normalizeA2APolicy(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return void 0;
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
async function writeJson(fs7, path7, value) {
  if (!await fs7.exists(".tent")) await fs7.mkdir(".tent");
  await fs7.writeFile(path7, JSON.stringify(value, null, 2) + "\n");
}
function isRecord3(value) {
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
function isTaskId(id) {
  return id.startsWith("tk-") && id.length > 3;
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

// src/core/task.ts
async function loadTaskEnvelopes(fs7) {
  const tasks = [];
  if (!await fs7.exists("temp")) return tasks;
  for (const roleEntry of await fs7.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    const taskDir = join("temp", roleEntry.name, "tasks");
    if (!await fs7.exists(taskDir)) continue;
    for (const entry of await fs7.listDir(taskDir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path7 = join(taskDir, entry.name);
      try {
        tasks.push(await loadTaskEnvelope(fs7, path7));
      } catch {
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function loadTaskEnvelope(fs7, path7) {
  if (!await fs7.exists(path7)) throw new Error(`Task envelope not found: ${path7}.`);
  const { data, body } = parseFrontmatter(await fs7.readFile(path7));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
    throw new Error(`Invalid task envelope format: ${path7}.`);
  }
  const legacyStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);
  const task = {
    path: path7,
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
async function ensureRoleInit(fs7, role, tentName) {
  const path7 = join("temp", role.name, "init.md");
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
  await fs7.writeFile(path7, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path7;
}
async function writeTaskEnvelope(fs7, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs7, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path7 = await uniqueMarkdownPath(fs7, dir, stem);
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
  await fs7.writeFile(path7, serializeFrontmatter(data, body));
  return path7;
}
async function ackTaskEnvelope(fs7, path7) {
  await patchTaskEnvelope(fs7, path7, {
    status: "taken",
    state: "running"
  });
}
async function cancelTaskEnvelope(fs7, path7) {
  const task = await loadTaskEnvelope(fs7, path7);
  if (task.state !== "queued" && task.status !== "pending") {
    throw new Error("Only queued (pending) task envelopes can be cancelled.");
  }
  await fs7.remove(path7);
}
async function patchTaskEnvelope(fs7, path7, patch) {
  if (!await fs7.exists(path7)) throw new Error(`Task envelope not found: ${path7}.`);
  const raw = await fs7.readFile(path7);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path7}.`);
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
  await fs7.writeFile(path7, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs7, path7);
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
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp2}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs7, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path7 = join(dir, `${stem}${suffix}.md`);
    if (!await fs7.exists(path7)) return path7;
  }
}
async function ensureDir(fs7, path7) {
  if (!await fs7.exists(path7)) await fs7.mkdir(path7);
}

// src/core/report.ts
async function submitReport(fs7, clock, boxId, body, commits) {
  return withTentMutation(fs7, async () => submitReportUnlocked(fs7, clock, boxId, body, commits));
}
async function submitReportUnlocked(fs7, clock, boxId, body, commits) {
  const text = body.trim();
  if (!text) throw new Error("Report body cannot be empty.");
  const tent = await loadTent(fs7);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const role = box.fm.owner;
  if (!role) throw new Error("Only claimed boxes with a direct owner can submit reports.");
  const path7 = reportPath(role, box.id);
  if (await fs7.exists(path7)) {
    const current = await loadReport(fs7, path7);
    if (current.status === "ready") throw new Error("A report is already pending triage; the user must confirm or reject it first.");
  }
  const report = {
    path: path7,
    boxId: box.id,
    role,
    status: "ready",
    commits: uniqueCommits(commits),
    timestamp: clock.now(),
    body: text
  };
  await ensureDir2(fs7, join("temp", role, "reports"));
  await writeReport(fs7, report);
  return report;
}
async function loadReports(fs7) {
  const reports = [];
  if (!await fs7.exists("temp")) return reports;
  for (const roleDir of await fs7.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!await fs7.exists(dir)) continue;
    for (const entry of await fs7.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path7 = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs7, path7));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs7, inputPath) {
  const path7 = normalizeReportPath(inputPath);
  if (!await fs7.exists(path7)) throw new Error(`Report not found: ${path7}.`);
  const { data, body } = parseFrontmatter(await fs7.readFile(path7));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`Invalid report format: ${path7}.`);
  }
  return {
    path: path7,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function removeReportsForBox(fs7, boxId) {
  for (const report of await loadReports(fs7)) {
    if (report.boxId === boxId && await fs7.exists(report.path)) await fs7.remove(report.path);
  }
}
function reportPath(role, boxId) {
  return join("temp", role, "reports", `${boxId}.md`);
}
function normalizeReportPath(input) {
  const path7 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/[bc]x-[^/]+\.md$/.test(path7)) {
    throw new Error("Report must point to temp/<role>/reports/<boxId>.md.");
  }
  return path7;
}
async function writeReport(fs7, report) {
  const data = {
    type: "report",
    box: report.boxId,
    role: report.role,
    status: report.status,
    commits: report.commits,
    ts: report.timestamp,
    review: report.review
  };
  await fs7.writeFile(
    report.path,
    serializeFrontmatter(data, report.body + "\n", ["type", "box", "role", "status", "commits", "ts", "review"])
  );
}
async function ensureDir2(fs7, path7) {
  if (!await fs7.exists(path7)) await fs7.mkdir(path7);
}
function uniqueCommits(commits) {
  return [...new Set(commits.map((item) => item.trim()).filter(Boolean))];
}

// src/core/scaffold.ts
async function scaffoldInWorkspace(workspaceFs, options) {
  const systemRelative = TENT_SYSTEM_DIR;
  if (await workspaceFs.exists(systemRelative)) {
    throw new Error(`Target already has a Tent system dir: ${systemRelative}`);
  }
  await workspaceFs.mkdir(systemRelative);
  const nested = (p) => `${systemRelative}/${p}`.replace(/\\/g, "/");
  const usedIds = /* @__PURE__ */ new Set();
  for (const box of options.boxes ?? []) {
    const boxName = validateBoxName(box.name);
    const type = box.type.trim();
    if (!type) throw new Error(`Box ${boxName} is missing a primary type.`);
    const id = box.id?.trim() || makeUniqueConceptId(usedIds);
    usedIds.add(id);
    const frontmatter = { id, type };
    const path7 = nested(boxName);
    await workspaceFs.mkdir(path7);
    await workspaceFs.writeFile(
      `${path7}/${boxName}.md`,
      serializeFrontmatter(frontmatter, `
${box.body ?? `# ${boxName}
`}
`, BOX_FRONTMATTER_KEY_ORDER)
    );
  }
  await workspaceFs.mkdir(nested(TEMP_DIR));
  await workspaceFs.mkdir(nested(ATTACHMENTS_DIR));
  await workspaceFs.writeFile(
    nested(TYPE_REGISTRY_PATH),
    JSON.stringify(options.typeRegistry ?? DEFAULT_TYPE_REGISTRY, null, 2) + "\n"
  );
  await workspaceFs.writeFile(
    nested(ROLES_REGISTRY_PATH),
    JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n"
  );
  await workspaceFs.writeFile(
    nested(TAGS_REGISTRY_PATH),
    JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n"
  );
  await workspaceFs.writeFile(nested(RULES_PATH), options.rules);
  await ensureWorkspaceGitignore(workspaceFs);
  return { systemRootRelative: systemRelative };
}
async function ensureWorkspaceGitignore(workspaceFs) {
  const path7 = ".gitignore";
  const entry = `${TENT_SYSTEM_DIR}/`;
  if (!await workspaceFs.exists(path7)) {
    await workspaceFs.writeFile(path7, `${entry}
`);
    return;
  }
  const text = await workspaceFs.readFile(path7);
  const lines = text.split(/\r?\n/);
  const has = lines.some((line) => {
    const t = line.trim();
    return t === entry || t === TENT_SYSTEM_DIR || t === `/${entry}` || t === `/${TENT_SYSTEM_DIR}`;
  });
  if (has) return;
  const next = text.endsWith("\n") || text === "" ? `${text}${entry}
` : `${text}
${entry}
`;
  await workspaceFs.writeFile(path7, next);
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
async function projectAssignee(fs7, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs7, box, patch);
}
async function restoreProjection(fs7, box, owner, status, acceptedBy) {
  await patchFrontmatter(fs7, box, {
    owner: owner ?? void 0,
    status: status ?? void 0,
    acceptedBy: acceptedBy ?? void 0
  });
}
async function patchFrontmatter(fs7, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs7.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  const order = [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...keyOrder.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
  await fs7.writeFile(boxFile, serializeFrontmatter(data, body, order));
}
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs7, action) {
  return withTentMutation(fs7, action);
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
async function uniqueSiblingPath(fs7, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!await fs7.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs7, from, to) {
  await fs7.mkdir(to);
  for (const entry of await fs7.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs7, src, dst);
    else await fs7.writeFile(dst, await fs7.readFile(src));
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
async function ensureIdentityFileName(fs7, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs7.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs7.exists(copied)) await fs7.move(copied, expected);
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
async function taskAck(env, taskPath) {
  await taskClaim(env, taskPath);
}
async function cancelPendingTask(env, taskPath) {
  await withMutation2(env.fs, () => cancelTaskEnvelope(env.fs, taskPath));
}
function resolveDispatchClaim(tent, claimId, tentName) {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) {
    throw new Error("Cannot dispatch the whole Tent directly; dispatch a specific box (boxId cannot be ., root, or the Tent name).");
  }
  const box = requireBoxById2(tent, id);
  return { root: false, id: box.id, name: box.name, box };
}
async function stamp(env, boxId, acceptedBy = "user") {
  await completeClaim(env, boxId, void 0, acceptedBy);
}
async function completeClaim(env, boxId, integrate, acceptedBy = "user") {
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById2(tent, boxId);
    if (integrate) await integrate();
    await setOwner(env.fs, box, void 0, "done", acceptedBy);
  });
}
async function acceptReport(env, reportPath2, options = {}) {
  await withMutation2(env.fs, async () => {
    const report = await loadReport(env.fs, reportPath2);
    if (report.status !== "ready") throw new Error("Only ready reports can be confirmed.");
    const tent = await loadTent(env.fs);
    const box = requireBoxById2(tent, report.boxId);
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
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById2(tent, boxId);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be made readable.");
    await patchFrontmatter2(env.fs, box, { readable: true });
  });
}
async function cleanTemp(env, role) {
  const roleName = role === void 0 ? void 0 : assertRoleName(role);
  await withMutation2(env.fs, async () => {
    const target = roleName ? join("temp", roleName) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!roleName) await ensureDir3(env.fs, "temp");
  });
}
async function forceRelease(env, boxId) {
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById2(tent, boxId);
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
  const path7 = join(input.parentPath, name);
  assertNotTempPath(path7);
  await ensureDir3(env.fs, path7);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path7), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path7);
    throw error;
  }
  return id;
}
async function setOwner(fs7, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter2(fs7, box, patch);
}
async function patchFrontmatter2(fs7, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs7.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await fs7.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
}
async function ensureDir3(fs7, path7) {
  if (path7 && !await fs7.exists(path7)) await fs7.mkdir(path7);
}
function boxKeyOrder2(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function assertNotTempPath(path7) {
  if (path7 === "temp" || path7.startsWith("temp/")) {
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
async function withMutation2(fs7, action) {
  return withTentMutation(fs7, action);
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

// src/core/okf.ts
async function syncOkfBundle(fs7) {
  return withTentMutation(fs7, async () => syncOkfBundleUnlocked(fs7));
}
async function syncOkfBundleUnlocked(fs7) {
  const tent = await loadTent(fs7);
  const concepts = [...tent.byPath.values()];
  const index = buildConceptIndex(concepts);
  const generatedFiles = await writeIndexes(fs7, concepts);
  const projection = await projectWikiLinks(fs7, concepts, index);
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
async function projectWikiLinks(fs7, boxes, index) {
  const projectedFiles = [];
  const unresolved = [];
  for (const box of boxes) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs7.readFile(notePath));
    const projected = projectMarkdownLinks(body, notePath, index);
    if (projected.unresolved.length > 0) {
      unresolved.push(...projected.unresolved.map((target) => ({ file: notePath, target })));
    }
    if (!projected.changed) continue;
    await fs7.writeFile(notePath, serializeFrontmatter(data, projected.body, keyOrder));
    projectedFiles.push(notePath);
  }
  return { projectedFiles, unresolved };
}
async function writeIndexes(fs7, boxes) {
  const generated = /* @__PURE__ */ new Set();
  const byDir = /* @__PURE__ */ new Map();
  for (const box of boxes) {
    const dir = dirName(boxNotePath(box.path));
    const list = byDir.get(dir) ?? [];
    list.push(box);
    byDir.set(dir, list);
  }
  const roots = boxes.filter((box) => !box.parent);
  await fs7.writeFile(
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
    await fs7.writeFile(
      indexPath,
      serializeFrontmatter(
        { type: "index" },
        "# Index\n\n" + siblings.map((box) => `- [${box.name}](${markdownLinkDestination(`${box.name}.md`)})`).join("\n") + "\n"
      )
    );
    generated.add(indexPath);
  }
  await fs7.writeFile("log.md", serializeFrontmatter({ type: "log" }, "# Log\n\n_No log entries._\n"));
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
async function submitProposal(fs7, clock, role, boxId, body) {
  return withTentMutation(fs7, async () => submitProposalUnlocked(fs7, clock, role, boxId, body));
}
async function submitProposalUnlocked(fs7, clock, roleInput, boxId, body) {
  const text = body.trim();
  if (!text) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole(roleInput);
  const tent = await loadTent(fs7);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const path7 = proposalPath(role, box.id);
  if (await fs7.exists(path7)) {
    const current = await loadProposal(fs7, path7);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }
  const proposal = {
    path: path7,
    boxId: box.id,
    role,
    status: "pending",
    createdAt: clock.now(),
    body: text
  };
  await ensureDir4(fs7, join("temp", role, "proposals"));
  await writeProposal(fs7, proposal);
  return proposal;
}
async function loadProposals(fs7) {
  const proposals = [];
  if (!await fs7.exists("temp")) return proposals;
  for (const roleDir of await fs7.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "proposals");
    if (!await fs7.exists(dir)) continue;
    for (const entry of await fs7.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path7 = join(dir, entry.name);
      try {
        proposals.push(await loadProposal(fs7, path7));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs7, inputPath) {
  const path7 = normalizeProposalPath(inputPath);
  if (!await fs7.exists(path7)) throw new Error(`Proposal not found: ${path7}.`);
  const { data, body } = parseFrontmatter(await fs7.readFile(path7));
  if (data.type !== "proposal" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path7}.`);
  }
  return {
    path: path7,
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
  const path7 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/[bc]x-[^/]+\.md$/.test(path7)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path7;
}
async function writeProposal(fs7, proposal) {
  const data = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
  await fs7.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}
async function ensureDir4(fs7, path7) {
  if (!await fs7.exists(path7)) await fs7.mkdir(path7);
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
function resolveTentWorkspace(_tent, systemRoot) {
  void _tent;
  if (!systemRoot) return void 0;
  const fromLayout = workspaceRootFromSystemRoot(systemRoot);
  return fromLayout ? nodePath2.resolve(fromLayout) : void 0;
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
async function pathExists(path7) {
  try {
    await nodeFs.access(path7);
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
  return new Promise((resolve9, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => {
      if (code === 0) resolve9(out);
      else reject(new Error(err.trim() || `git ${args.join(" ")} exit ${code}`));
    });
    child.on("error", reject);
  });
}
function runShell(cwd, command) {
  return new Promise((resolve9, reject) => {
    const { shell, args } = workspaceCheckShell(command);
    const child = spawn(shell, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => {
      if (code === 0) {
        resolve9({ command, stdout, stderr });
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
var NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/ system root with RULES.md found).";
async function renderTentStatus(cwd = process.cwd(), role = process.env.TENT_ROLE) {
  const systemRoot = await findTentSystemRoot(cwd);
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const fsAdapter = new NodeFs(systemRoot);
  const tent = await loadTent(fsAdapter);
  const workspace = resolveTentWorkspace(tent, systemRoot);
  const lines = [
    `Tent: ${systemRoot}`,
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
async function findTentSystemRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (; ; ) {
    if (await isSystemRoot(dir)) return dir;
    const nested = path.join(dir, ".tent");
    if (await isSystemRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
async function isSystemRoot(root) {
  if (!await exists(path.join(root, "RULES.md"))) return false;
  return await exists(path.join(root, "types.json")) || await exists(path.join(root, "temp")) || await exists(path.join(root, ".tent"));
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

// src/core/migration.ts
import * as nodeFs2 from "node:fs/promises";
import * as nodePath3 from "node:path";
var NESTED_REGISTRY_FILES = [
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
  ORDER_PATH,
  RULES_PATH
];
function planIdRemap(legacyIds, existing, rand = Math.random) {
  const used = new Set(existing);
  const map = /* @__PURE__ */ new Map();
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
function rewriteOutputType(type) {
  if (type === "output") return "artifact";
  if (type.startsWith("output-")) return "artifact" + type.slice("output".length);
  return void 0;
}
function migrateTypeRegistryJson(value) {
  const changes = [];
  const root = isRecord4(value) ? deepClone(value) : {};
  const stripPointer = (def) => {
    if (!isRecord4(def)) return def;
    if (!("workspacePointer" in def)) return def;
    const next = { ...def };
    delete next.workspacePointer;
    changes.push("removed workspacePointer from a type definition");
    return next;
  };
  if (isRecord4(root.primary) || isRecord4(root.secondary)) {
    if (isRecord4(root.primary)) {
      root.primary = migratePrimarySecondaryBucket(root.primary, stripPointer, changes, "primary");
    }
    if (isRecord4(root.secondary)) {
      root.secondary = migratePrimarySecondaryBucket(root.secondary, stripPointer, changes, "secondary");
    }
  } else {
    for (const key of Object.keys(root)) {
      root[key] = stripPointer(root[key]);
    }
    promoteOutputKey(root, changes);
  }
  const registry = normalizeRegistry(root);
  for (const def of Object.values(registry)) {
    if (def && typeof def === "object" && "workspacePointer" in def) {
      delete def.workspacePointer;
      changes.push("stripped workspacePointer after normalize");
    }
  }
  if ("output" in registry) {
    delete registry.output;
    changes.push("removed residual output key after normalize");
  }
  void DEFAULT_TYPE_REGISTRY;
  return { registry, changes };
}
function migratePrimarySecondaryBucket(bucket, stripPointer, changes, label) {
  const next = {};
  for (const [key, raw] of Object.entries(bucket)) {
    const stripped = stripPointer(raw);
    if (key === "output") {
      if (next.artifact === void 0) {
        if (isRecord4(stripped)) {
          const out = { ...stripped };
          if (out.coordination === void 0 && label === "primary") out.coordination = true;
          delete out.workspacePointer;
          next.artifact = out;
        } else {
          next.artifact = stripped;
        }
        changes.push(`promoted ${label}.output definition to ${label}.artifact`);
      } else {
        changes.push(`dropped duplicate ${label}.output; kept existing ${label}.artifact`);
      }
      changes.push(`removed legacy ${label}.output type key`);
      continue;
    }
    next[key] = stripped;
  }
  return next;
}
function promoteOutputKey(root, changes) {
  if (!isRecord4(root.output)) return;
  if (!root.artifact) {
    const out = { ...root.output, coordination: root.output.coordination ?? true };
    delete out.workspacePointer;
    root.artifact = out;
    changes.push("promoted output definition to artifact");
  } else {
    changes.push("dropped duplicate output; kept existing artifact");
  }
  delete root.output;
  changes.push("removed legacy output type key");
}
async function migrateLegacySchema(fs7, options = {}) {
  const dryRun = options.dryRun === true;
  const rewriteOps = options.rewriteOperationalRefs !== false;
  const report = {
    dryRun,
    idMap: [],
    typeRewrites: [],
    registryChanges: [],
    skipped: [],
    warnings: []
  };
  await liftNestedRegistries(fs7, report, dryRun);
  await migrateFlatTypeRegistry(fs7, report, dryRun);
  await unifyMutationLock(fs7, report, dryRun);
  const tent = await loadTent(fs7);
  const legacyIds = [...tent.byId.keys()].filter(isLegacyBoxId);
  const existing = new Set(tent.byId.keys());
  const idMap = planIdRemap(legacyIds, existing, options.rand);
  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs7.readFile(notePath));
    let dirty = false;
    const oldId = typeof data.id === "string" ? data.id : "";
    if (isLegacyBoxId(oldId)) {
      let next = idMap.get(oldId);
      if (!next) {
        const extra = planIdRemap([oldId], /* @__PURE__ */ new Set([...existing, ...idMap.values()]), options.rand);
        next = extra.get(oldId);
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
      await fs7.writeFile(
        notePath,
        serializeFrontmatter(data, body, keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER)
      );
    }
  }
  if (await fs7.exists(ORDER_PATH)) {
    try {
      const order = JSON.parse(await fs7.readFile(ORDER_PATH));
      let dirty = false;
      const next = {};
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
        if (!dryRun) await fs7.writeFile(ORDER_PATH, JSON.stringify(next, null, 2) + "\n");
      }
    } catch (error) {
      report.warnings.push(`order.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rewriteOps && await fs7.exists(TEMP_DIR)) {
    await rewriteOperationalTree(fs7, idMap, report, dryRun);
  }
  const seen = /* @__PURE__ */ new Set();
  report.idMap = report.idMap.filter((entry) => {
    const key = `${entry.from}->${entry.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return report;
}
async function liftNestedRegistries(fs7, report, dryRun) {
  if (!await fs7.exists(TENT_SYSTEM_DIR)) return;
  for (const name of NESTED_REGISTRY_FILES) {
    const nested = join(TENT_SYSTEM_DIR, name);
    if (!await fs7.exists(nested)) continue;
    const flatExists = await fs7.exists(name);
    if (!flatExists) {
      report.registryChanges.push(
        dryRun ? `would lift nested ${nested} \u2192 ${name}` : `lifted nested ${nested} \u2192 ${name}`
      );
      if (!dryRun) {
        const text = await fs7.readFile(nested);
        await fs7.writeFile(name, text);
      }
    } else {
      report.registryChanges.push(`nested ${nested} ignored; flat ${name} already present`);
    }
    report.registryChanges.push(dryRun ? `would remove nested ${nested}` : `removed nested ${nested}`);
    if (!dryRun) await fs7.remove(nested);
  }
  const nestedLock = join(TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  if (await fs7.exists(nestedLock)) {
    report.registryChanges.push(
      dryRun ? `would remove nested ${nestedLock}` : `removed nested ${nestedLock}`
    );
    if (!dryRun) await fs7.remove(nestedLock);
  }
}
async function migrateFlatTypeRegistry(fs7, report, dryRun) {
  if (!await fs7.exists(TYPE_REGISTRY_PATH)) return;
  try {
    const raw = JSON.parse(await fs7.readFile(TYPE_REGISTRY_PATH));
    const { registry, changes } = migrateTypeRegistryJson(raw);
    report.registryChanges.push(...changes);
    if (!dryRun && changes.length > 0) {
      await fs7.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
    }
  } catch (error) {
    report.warnings.push(
      `types.json migration skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function unifyMutationLock(fs7, report, dryRun) {
  const nestedLock = join(TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  if (await fs7.exists(nestedLock)) {
    report.registryChanges.push(
      dryRun ? `would remove nested lock ${nestedLock}` : `removed nested lock ${nestedLock}`
    );
    if (!dryRun) await fs7.remove(nestedLock);
  }
  if (!report.registryChanges.some((c) => c.includes(MUTATION_LOCK_PATH))) {
    report.registryChanges.push(`unique lock path: ${MUTATION_LOCK_PATH}`);
  }
}
async function rewriteOperationalTree(fs7, idMap, report, dryRun) {
  if (idMap.size === 0) return;
  const walk = async (dir) => {
    if (!await fs7.exists(dir)) return;
    for (const entry of await fs7.listDir(dir)) {
      const path7 = join(dir, entry.name);
      if (entry.isDir) {
        await walk(path7);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".md") && !lower.endsWith(".yml") && !lower.endsWith(".yaml")) continue;
      const text = await fs7.readFile(path7);
      const rewritten = rewriteOperationalText(text, idMap);
      let targetName = entry.name;
      for (const [from, to] of idMap) {
        if (targetName.includes(from)) {
          targetName = replaceExactIdTokens(targetName, from, to);
        }
      }
      const targetPath = join(dir, targetName);
      if (rewritten === text && targetPath === path7) continue;
      report.registryChanges.push(`operational rewrite: ${path7}`);
      if (!dryRun) {
        if (targetPath !== path7) {
          await fs7.writeFile(targetPath, rewritten);
          await fs7.remove(path7);
        } else {
          await fs7.writeFile(path7, rewritten);
        }
      }
    }
  };
  await walk(TEMP_DIR);
}
function rewriteOperationalText(text, idMap) {
  if (idMap.size === 0) return text;
  let next = text;
  next = next.replace(
    /^([ \t]*(?:claims|box|id|claim|parent|from|to|root)[ \t]*:[ \t]*)(.+)$/gim,
    (full, prefix, value) => {
      return prefix + replaceIdsInStructuredValue(value, idMap);
    }
  );
  for (const [from, to] of idMap) {
    next = replaceExactIdTokens(next, from, to);
  }
  return next;
}
function replaceIdsInStructuredValue(value, idMap) {
  let next = value;
  for (const [from, to] of idMap) {
    next = replaceExactIdTokens(next, from, to);
  }
  return next;
}
function replaceExactIdTokens(text, from, to) {
  if (!from || from === to) return text;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g");
  return text.replace(re, to);
}
var IMPORT_SKIP_DIR_NAMES = /* @__PURE__ */ new Set([".git", "node_modules"]);
var IMPORT_STAGING_DIR_PREFIX = `${TENT_SYSTEM_DIR}.import-staging-`;
async function isLegacyTentRoot(root) {
  const rules = nodePath3.join(root, RULES_PATH);
  if (!await pathExists2(rules)) return false;
  return await pathExists2(nodePath3.join(root, TYPE_REGISTRY_PATH)) || await pathExists2(nodePath3.join(root, TEMP_DIR)) || await pathExists2(nodePath3.join(root, TENT_SYSTEM_DIR)) || await pathExists2(nodePath3.join(root, ORDER_PATH)) || await pathExists2(nodePath3.join(root, "index.md"));
}
async function importExternalTentRoot(options) {
  const dryRun = options.dryRun === true;
  const sourceRoot = nodePath3.resolve(options.sourceRoot);
  const workspaceRoot = nodePath3.resolve(options.workspaceRoot);
  const systemRoot = systemRootFromWorkspace(workspaceRoot);
  const warnings = [];
  const skipped = [];
  if (!await pathExists2(sourceRoot)) {
    throw new Error(`Source tent root does not exist: ${sourceRoot}`);
  }
  const sourceStat = await nodeFs2.lstat(sourceRoot);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Source tent root must not be a symbolic link: ${sourceRoot}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source tent root is not a directory: ${sourceRoot}`);
  }
  if (!await isLegacyTentRoot(sourceRoot)) {
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
  if (await pathExists2(systemRoot)) {
    throw new Error(
      `Refusing to import: target already has ${TENT_SYSTEM_DIR} at ${systemRoot}. No silent overwrite. Move/rename the existing system dir first if you intend to replace it.`
    );
  }
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
      `Could not fully load source tent for occupancy check: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await collectSymlinkSkips(sourceRoot, skipped, warnings);
  const plannedSchema = await migrateLegacySchema(sourceFs, {
    dryRun: true,
    rand: options.rand,
    rewriteOperationalRefs: options.rewriteOperationalRefs
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
        "dry-run: source not marked with MIGRATED.md"
      ]
    };
  }
  await nodeFs2.mkdir(workspaceRoot, { recursive: true });
  const stagingRoot = await allocateImportStagingDir(workspaceRoot);
  let renamedToFinal = false;
  try {
    await copyHostTree(sourceRoot, stagingRoot, skipped, warnings);
    if (options._testHooks?.afterCopy) await options._testHooks.afterCopy(stagingRoot);
    const destFs = new NodeFs(stagingRoot);
    const schema = await migrateLegacySchema(destFs, {
      dryRun: false,
      rand: options.rand,
      rewriteOperationalRefs: options.rewriteOperationalRefs
    });
    if (options._testHooks?.afterSchema) await options._testHooks.afterSchema(stagingRoot);
    const workspaceFs = new NodeFs(workspaceRoot);
    await ensureWorkspaceGitignore(workspaceFs);
    if (options._testHooks?.beforeRename) {
      await options._testHooks.beforeRename(stagingRoot, systemRoot);
    }
    if (await pathExists2(systemRoot)) {
      throw new Error(
        `Refusing to import: target already has ${TENT_SYSTEM_DIR} at ${systemRoot}. No silent overwrite. Move/rename the existing system dir first if you intend to replace it.`
      );
    }
    await nodeFs2.rename(stagingRoot, systemRoot);
    renamedToFinal = true;
    await writeMigratedMarker(sourceRoot, {
      workspaceRoot,
      systemRoot,
      idMapCount: schema.idMap.length
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
      skipped: [...skipped, ...schema.skipped]
    };
  } catch (error) {
    if (!renamedToFinal) {
      await removeHostTreeBestEffort(stagingRoot);
    }
    throw error;
  }
}
async function writeMigratedMarker(sourceRoot, info) {
  const when = (/* @__PURE__ */ new Date()).toISOString();
  const body = `# Migrated

This external Tent root was **copied** into an in-workspace system dir.

- When: ${when}
- Workspace: \`${info.workspaceRoot.replace(/\\/g, "/")}\`
- System root: \`${info.systemRoot.replace(/\\/g, "/")}\`
- Id remaps applied on the **copy**: ${info.idMapCount}

The source tree was **not** deleted. There is no bidirectional sync.
After verifying the workspace tent, you may delete this directory manually.
Do not continue writing collaboration facts here.
`;
  await nodeFs2.writeFile(nodePath3.join(sourceRoot, "MIGRATED.md"), body, "utf8");
}
function noteSkippedSymlink(relPosix, skipped, warnings) {
  const msg = `skipped symlink (not followed): ${relPosix}`;
  if (!skipped.includes(msg)) skipped.push(msg);
  if (!warnings.includes(msg)) warnings.push(msg);
}
async function collectSymlinkSkips(root, skipped, warnings, relBase = "") {
  let entries;
  try {
    entries = await nodeFs2.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IMPORT_SKIP_DIR_NAMES.has(entry.name)) continue;
    if (entry.name === "MIGRATED.md") continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const relPosix = rel.replace(/\\/g, "/");
    const abs = nodePath3.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      noteSkippedSymlink(relPosix, skipped, warnings);
      continue;
    }
    if (entry.isDirectory()) {
      await collectSymlinkSkips(abs, skipped, warnings, relPosix);
    }
  }
}
async function copyHostTree(from, to, skipped, warnings, relBase = "") {
  await nodeFs2.mkdir(to, { recursive: true });
  const entries = await nodeFs2.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (IMPORT_SKIP_DIR_NAMES.has(entry.name)) continue;
    if (entry.name === "MIGRATED.md") continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const relPosix = rel.replace(/\\/g, "/");
    const src = nodePath3.join(from, entry.name);
    const dst = nodePath3.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      noteSkippedSymlink(relPosix, skipped, warnings);
      continue;
    }
    if (entry.isDirectory()) {
      await copyHostTree(src, dst, skipped, warnings, relPosix);
    } else if (entry.isFile()) {
      await nodeFs2.mkdir(nodePath3.dirname(dst), { recursive: true });
      const st = await nodeFs2.lstat(src);
      if (st.isSymbolicLink()) {
        noteSkippedSymlink(relPosix, skipped, warnings);
        continue;
      }
      await nodeFs2.copyFile(src, dst);
    }
  }
}
async function allocateImportStagingDir(workspaceRoot) {
  for (let i = 0; i < 8; i++) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const stagingRoot = nodePath3.join(workspaceRoot, `${IMPORT_STAGING_DIR_PREFIX}${id}`);
    if (await pathExists2(stagingRoot)) continue;
    await nodeFs2.mkdir(stagingRoot, { recursive: false });
    return stagingRoot;
  }
  throw new Error(`Could not allocate unique import staging directory under ${workspaceRoot}`);
}
async function removeHostTreeBestEffort(root) {
  try {
    await nodeFs2.rm(root, { recursive: true, force: true });
  } catch {
  }
}
async function pathExists2(p) {
  try {
    await nodeFs2.access(p);
    return true;
  } catch {
    return false;
  }
}
function samePath(a, b) {
  const na = nodePath3.resolve(a);
  const nb = nodePath3.resolve(b);
  if (process.platform === "win32") return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/cli/service-attach.ts
import * as fs5 from "node:fs/promises";
import * as path4 from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/service/data-dir.ts
import * as fs4 from "node:fs/promises";
import * as os from "node:os";
import * as path3 from "node:path";

// src/machine-state.ts
import * as fs3 from "node:fs/promises";
import * as path2 from "node:path";
function isNotFoundError(err) {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

// src/service/data-dir.ts
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path3.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path3.join(os.homedir(), "AppData", "Roaming");
    return path3.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path3.join(os.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path3.join(os.homedir(), ".local", "state");
  return path3.join(xdg, "tent");
}
function serviceEndpointPath(dataDir) {
  return path3.join(dataDir, "service.json");
}
async function readServiceEndpoint(dataDir) {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs4.readFile(file, "utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof data.pid !== "number" || typeof data.port !== "number" || typeof data.host !== "string") {
      return null;
    }
    return data;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

// src/service/auth.ts
import * as crypto from "node:crypto";
var AUTH_TOKEN_HEADER = "x-tent-token";

// src/service/client.ts
var ServiceClient = class {
  constructor(options) {
    this.idSeq = 1;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async health() {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health HTTP ${res.status}`);
    return res.json();
  }
  async call(method, params) {
    const rpc = await this.rpcRaw(method, params);
    if (rpc.error) {
      const err = new Error(rpc.error.message);
      err.code = rpc.error.code;
      err.data = rpc.error.data;
      throw err;
    }
    return rpc.result;
  }
  async tryCall(method, params) {
    const rpc = await this.rpcRaw(method, params);
    if (rpc.error) {
      return { ok: false, error: rpc.error };
    }
    return { ok: true, result: rpc.result };
  }
  async rpcRaw(method, params) {
    const id = this.idSeq++;
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AUTH_TOKEN_HEADER]: this.token
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });
    if (res.status === 401) {
      return { error: { code: -32001, message: "Unauthorized: invalid or missing service token" } };
    }
    return await res.json();
  }
  // ---- convenience: workspace ----
  mount(workspaceRoot, opts) {
    return this.call("workspace.mount", { workspaceRoot, ...opts });
  }
  unmount(workspaceId) {
    return this.call("workspace.unmount", { workspaceId });
  }
  listWorkspaces() {
    return this.call("workspace.list", {});
  }
  setForeground(workspaceId) {
    return this.call("workspace.setForeground", { workspaceId });
  }
  // ---- convenience: docs ----
  docsList(workspaceId, includeBody = false) {
    return this.call("docs.list", { workspaceId, includeBody });
  }
  docsGet(workspaceId, idOrPath) {
    return this.call("docs.get", { workspaceId, ...idOrPath });
  }
  docsWrite(workspaceId, args) {
    return this.call("docs.write", { workspaceId, ...args });
  }
  docsCreateNote(workspaceId, args) {
    return this.call("docs.createNote", { workspaceId, ...args });
  }
  docsFork(workspaceId, idOrPath) {
    return this.call("docs.fork", { workspaceId, ...idOrPath });
  }
  docsPromote(workspaceId, idOrPath, toType) {
    return this.call("docs.promote", { workspaceId, ...idOrPath, toType });
  }
  // ---- convenience: registry (read-only) ----
  registryTypes(workspaceId) {
    return this.call("registry.types", { workspaceId });
  }
  registryRoles(workspaceId) {
    return this.call("registry.roles", { workspaceId });
  }
  // ---- convenience: machine-local profiles (safe metadata only) ----
  profileList(opts) {
    return this.call("profile.list", opts ?? {});
  }
  // ---- convenience: task ----
  taskDispatch(workspaceId, args) {
    return this.call("task.dispatch", { workspaceId, ...args });
  }
  taskClaim(workspaceId, taskPath, sessionId) {
    return this.call("task.claim", { workspaceId, taskPath, sessionId });
  }
  taskWait(workspaceId, taskPath, reason, summary) {
    return this.call("task.wait", { workspaceId, taskPath, reason, summary });
  }
  taskResume(workspaceId, taskPath) {
    return this.call("task.resume", { workspaceId, taskPath });
  }
  taskDeliver(workspaceId, taskPath, args) {
    return this.call("task.deliver", { workspaceId, taskPath, ...args });
  }
  taskAccept(workspaceId, taskPath, actor, commits) {
    return this.call("task.accept", { workspaceId, taskPath, actor, commits });
  }
  taskReject(workspaceId, taskPath, actor, opts) {
    return this.call("task.reject", { workspaceId, taskPath, actor, ...opts });
  }
  taskInterrupt(workspaceId, taskPath) {
    return this.call("task.interrupt", { workspaceId, taskPath });
  }
  taskCancel(workspaceId, taskPath) {
    return this.call("task.cancel", { workspaceId, taskPath });
  }
  taskStartSession(workspaceId, args) {
    return this.call("task.startSession", { workspaceId, ...args });
  }
  taskList(workspaceId) {
    return this.call("task.list", { workspaceId });
  }
  taskGet(workspaceId, taskPath) {
    return this.call("task.get", { workspaceId, taskPath });
  }
  sessionList(workspaceId) {
    return this.call("session.list", workspaceId ? { workspaceId } : {});
  }
  sessionGet(sessionId) {
    return this.call("session.get", { sessionId });
  }
  a2aListPending(workspaceId) {
    return this.call("a2a.listPending", workspaceId ? { workspaceId } : {});
  }
  a2aResolve(approvalId, decision, actor = "user") {
    return this.call("a2a.resolve", { approvalId, decision, actor });
  }
  /** ACP tool permission pending list (permissionPolicy=ask). Not A2A spawn. */
  toolApprovalListPending(workspaceId) {
    return this.call("toolApproval.listPending", workspaceId ? { workspaceId } : {});
  }
  toolApprovalGet(approvalId) {
    return this.call("toolApproval.get", { approvalId });
  }
  /** User-only: allow_once for one ACP tool request. */
  toolApprovalApproveOnce(approvalId, actor = "user") {
    return this.call("toolApproval.approveOnce", { approvalId, actor });
  }
  /** User-only: deny/cancel one ACP tool request. */
  toolApprovalDeny(approvalId, actor = "user") {
    return this.call("toolApproval.deny", { approvalId, actor });
  }
  /**
   * Subscribe to SSE events. Returns an abort handle.
   * Requires a global EventSource-compatible environment; for Node tests prefer
   * fetch streaming or EventBus in-process.
   */
  subscribeEvents(onEvent, onError) {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/events`, {
          headers: { [AUTH_TOKEN_HEADER]: this.token, accept: "text/event-stream" },
          signal: ac.signal
        });
        if (!res.ok || !res.body) {
          onError?.(new Error(`SSE HTTP ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6));
              onEvent(payload);
            } catch {
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) onError?.(err);
      }
    })();
    return { close: () => ac.abort() };
  }
};
function createServiceClient(options) {
  return new ServiceClient(options);
}

// src/cli/service-attach.ts
async function attachOrBootstrapService(options = {}) {
  const dataDir = options.dataDir ?? defaultServiceDataDir(options.env);
  const readyTimeoutMs = options.readyTimeoutMs ?? 15e3;
  const pollMs = options.pollMs ?? 200;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnFn = options.spawnFn ?? spawn2;
  const existing = await tryAttachService(dataDir, fetchImpl);
  if (existing) {
    return { ...existing, started: false, child: null, dataDir };
  }
  if (options.attachOnly) {
    throw new Error(
      `No healthy Local Tent Service endpoint in ${dataDir}. Start tent-service, or omit --attach-only to let CLI bootstrap one.`
    );
  }
  const entry = options.serviceEntry ?? await resolveDefaultServiceEntry(options.packageRoot);
  const entryAbs = path4.resolve(entry);
  const child = spawnFn(process.execPath, [entryAbs, "start", "--data-dir", dataDir], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: cliServiceChildEnv(options.env, dataDir),
    windowsHide: true,
    cwd: path4.dirname(entryAbs)
  });
  let spawnLog = "";
  child.stdout?.on("data", (c) => {
    spawnLog += c.toString("utf8");
  });
  child.stderr?.on("data", (c) => {
    spawnLog += c.toString("utf8");
  });
  child.on("error", (err) => {
    spawnLog += String(err);
  });
  child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(
        `Local Tent Service exited early (code=${child.exitCode}). entry=${entryAbs}
${spawnLog}`
      );
    }
    const attached = await tryAttachService(dataDir, fetchImpl);
    if (attached) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { ...attached, started: true, child, dataDir };
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for Local Tent Service after spawn (entry=${entryAbs}, dataDir=${dataDir})
${spawnLog}`
  );
}
function cliServiceChildEnv(overrides, dataDir) {
  return {
    ...process.env,
    ...overrides,
    TENT_SERVICE_DATA_DIR: dataDir,
    // Harmless for plain Node; required when parent is Electron-as-node.
    ELECTRON_RUN_AS_NODE: "1"
  };
}
async function tryAttachService(dataDir, fetchImpl = fetch) {
  const endpoint = await readServiceEndpoint(dataDir);
  if (!endpoint) return null;
  if (!endpoint.token || typeof endpoint.token !== "string" || !endpoint.token.trim()) {
    return null;
  }
  const url = `http://${endpoint.host}:${endpoint.port}`;
  const client = createServiceClient({ baseUrl: url, token: endpoint.token, fetchImpl });
  try {
    const health = await client.health();
    if (health.status !== "ok") return null;
    return { url, endpoint, client };
  } catch {
    return null;
  }
}
async function resolveDefaultServiceEntry(packageRootHint) {
  const roots = [];
  if (packageRootHint) roots.push(packageRootHint);
  roots.push(process.cwd());
  try {
    const here = path4.dirname(fileURLToPath(import.meta.url));
    if (path4.basename(here) === "cli" && path4.basename(path4.dirname(here)) === "src") {
      roots.push(path4.resolve(here, "../.."));
    } else {
      roots.push(here);
    }
  } catch {
  }
  const relativeCandidates = [
    "service.mjs",
    path4.join("dist", "service.mjs"),
    path4.join("desktop", "service.mjs"),
    path4.join("src", "service", "cli.ts")
  ];
  for (const root of roots) {
    for (const rel of relativeCandidates) {
      const candidate = path4.join(root, rel);
      try {
        await fs5.access(candidate);
        return candidate;
      } catch {
      }
    }
  }
  return path4.join(roots[0] ?? process.cwd(), "service.mjs");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/cli/workspace-context.ts
import * as path5 from "node:path";
async function ensureMountedWorkspace(client, options = {}) {
  const { workspaceRoot, systemRoot } = await resolveWorkspacePaths(options);
  const listed = await client.listWorkspaces();
  const existing = (listed.workspaces ?? []).find(
    (w) => path5.resolve(w.workspaceRoot) === path5.resolve(workspaceRoot)
  );
  if (existing) {
    return {
      workspaceRoot,
      systemRoot,
      workspaceId: existing.workspaceId
    };
  }
  const mounted = await client.mount(workspaceRoot);
  return {
    workspaceRoot: mounted.workspaceRoot ?? workspaceRoot,
    systemRoot: mounted.systemRoot ?? systemRoot,
    workspaceId: mounted.workspaceId
  };
}
async function resolveWorkspacePaths(options) {
  const start = path5.resolve(options.workspace || options.cwd || process.cwd());
  const systemRoot = await findTentSystemRoot(start);
  if (!systemRoot) {
    throw new Error(
      NOT_INSIDE_TENT_MESSAGE + (options.workspace ? ` (searched from --workspace ${start})` : "")
    );
  }
  const workspaceRoot = workspaceRootFromSystemRoot(systemRoot);
  if (!workspaceRoot) {
    throw new Error(
      `Tent system root is not an in-workspace .tent layout: ${systemRoot}. Service path requires <workspace>/.tent/ (architecture \xA73.1). Legacy pure-system-root fixtures still use direct CLI commands, not task RPC.`
    );
  }
  return { workspaceRoot: path5.resolve(workspaceRoot), systemRoot: path5.resolve(systemRoot) };
}

// src/cli/task-rpc.ts
async function runTaskCommand(sub, args, globals = {}) {
  try {
    const { positionals, flags } = parseTaskFlags(args);
    const json = globals.json === true || flags.json === "true";
    const workspaceFlag = flags.workspace || globals.workspace;
    const attachOpts = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const ctx = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: workspaceFlag
    });
    const workspaceId = ctx.workspaceId;
    switch (sub) {
      case "list": {
        if (positionals.length > 0) {
          return failUsage("Usage: tent task list [--workspace <path>] [--json]");
        }
        const result = await client.taskList(workspaceId);
        return okPrint(result, json, formatTaskList);
      }
      case "get": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task get <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskGet(workspaceId, taskPath);
        return okPrint(result, json, (r) => formatTaskGet(r));
      }
      case "claim": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task claim <taskPath> [--session <sessionId>] [--workspace <path>] [--json]"
          );
        }
        const sessionId = flags.session || flags["session-id"];
        const result = await client.taskClaim(workspaceId, taskPath, sessionId);
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Claimed via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "running"}
` + (row.sessionId ? `sessionId: ${row.sessionId}
` : "");
        });
      }
      case "deliver": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        if (positionals.length > 1) {
          return failUsage(
            "Usage: tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "summary")) {
          return failUsage("tent task deliver requires --summary <text> or --summary -");
        }
        let summary = flags.summary ?? "";
        if (summary === "-") summary = await readStdinText();
        if (!summary.trim()) {
          return failUsage("tent task deliver: --summary must be non-empty");
        }
        const commits = parseCommitsFlag(flags.commits);
        const result = await client.taskDeliver(workspaceId, taskPath, {
          summary,
          commits,
          decision: flags.decision
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Delivered via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "delivered"}
` + (row.delivery?.id ? `deliveryId: ${row.delivery.id}
` : "") + (row.delivery?.status ? `deliveryStatus: ${row.delivery.status}
` : "") + (row.autoIntegrated != null ? `autoIntegrated: ${row.autoIntegrated}
` : "");
        });
      }
      case "dispatch": {
        const boxId = positionals[0];
        const role = positionals[1];
        const promptParts = positionals.slice(2);
        if (!boxId || !role) {
          return failUsage(
            "Usage: tent task dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--workspace <path>] [--json]"
          );
        }
        if (Object.prototype.hasOwnProperty.call(flags, "prompt") && promptParts.length > 0) {
          return failUsage(
            "Usage: tent task dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--workspace <path>] [--json]"
          );
        }
        let prompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
        if (prompt === "-") prompt = await readStdinText();
        const result = await client.taskDispatch(workspaceId, {
          boxId,
          role,
          prompt,
          dispatchedBy: flags.by || flags.from || flags["dispatched-by"] || process.env.TENT_ROLE || "user",
          deliveryPolicy: flags["delivery-policy"] || flags.deliveryPolicy
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Dispatched via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "queued"}
` + (row.relayPrompt ? `
--- Relay prompt ---
${row.relayPrompt}` : "");
        });
      }
      case "accept": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task accept requires --actor <user|role>");
        const commits = parseCommitsFlag(flags.commits);
        const result = await client.taskAccept(workspaceId, taskPath, actor, commits);
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Accepted via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "accepted"}
`;
        });
      }
      case "reject": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task reject requires --actor <user|role>");
        const resume = flags.resume === "true" ? true : flags["no-resume"] === "true" ? false : void 0;
        const result = await client.taskReject(workspaceId, taskPath, actor, {
          note: flags.note,
          resume
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Rejected via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "?"}
`;
        });
      }
      case "cancel": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage("Usage: tent task cancel <taskPath> [--workspace <path>] [--json]");
        }
        const result = await client.taskCancel(workspaceId, taskPath);
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 Cancelled via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "interrupted"}
`;
        });
      }
      case "help":
      case "--help":
      case "-h":
        return { exitCode: 0, stdout: taskHelpText(), stderr: "" };
      default:
        return failUsage(
          `Unknown task subcommand: ${sub || "(empty)"}
` + taskHelpText()
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
function formatTaskList(result) {
  const row = result;
  const tasks = row.tasks ?? [];
  if (tasks.length === 0) {
    return `workspaceId: ${row.workspaceId ?? "?"}
tasks: (none)
`;
  }
  const lines = [`workspaceId: ${row.workspaceId ?? "?"}`, `tasks: ${tasks.length}`, ""];
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? t.id ?? "?"}	state=${t.state ?? t.status ?? "?"}	role=${t.role ?? "?"}	claims=${(t.claims ?? []).join(",") || "-"}` + (t.sessionId ? `	session=${t.sessionId}` : "")
    );
  }
  return lines.join("\n") + "\n";
}
function formatTaskGet(result) {
  const t = result.task;
  const lines = [
    `path: ${t.path ?? "?"}`,
    `id: ${t.id ?? "?"}`,
    `role: ${t.role ?? "?"}`,
    `state: ${t.state ?? t.status ?? "?"}`,
    `status: ${t.status ?? "?"}`,
    `claims: ${(t.claims ?? []).join(", ") || "-"}`
  ];
  if (t.sessionId) lines.push(`sessionId: ${t.sessionId}`);
  if (t.prompt) {
    lines.push("", "--- prompt ---", t.prompt.trimEnd());
  }
  return lines.join("\n") + "\n";
}
function okPrint(result, json, human) {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}
function failUsage(msg) {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}
function parseCommitsFlag(raw) {
  if (raw === void 0) return void 0;
  const commits = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return commits;
}
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set([
  "json",
  "attach-only",
  "resume",
  "no-resume",
  "yes"
]);
function parseTaskFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
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
function readStdinText() {
  return new Promise((resolve9, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve9(data));
    process.stdin.on("error", reject);
  });
}
function taskHelpText() {
  return `tent task \u2014 collaboration lifecycle via Local Service (RPC)

New-architecture path: attach \u2192 mount workspace \u2192 task.* RPC.
Local Service is the sole mutation entry; CLI does not kill the service on exit.

Commands:
  tent task list [--workspace <path>] [--json]
  tent task get <taskPath> [--workspace <path>] [--json]
  tent task claim <taskPath> [--session <sessionId>] [--workspace <path>] [--json]
  tent task deliver <taskPath> --summary <text>|- [--commits sha,sha] [--workspace <path>] [--json]
  tent task dispatch <boxId> <role> [prompt...] [--prompt <text>|-] [--workspace <path>] [--json]
  tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]
  tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]
  tent task cancel <taskPath> [--workspace <path>] [--json]

Service options:
  --data-dir <path>       Machine-local service data area (default: %APPDATA%/Tent)
  --attach-only           Fail if no healthy service (do not bootstrap)
  --service-entry <path>  Path to service.mjs when bootstrapping

Legacy CLI direct core write is blocked on in-workspace <workspace>/.tent
(fail-loud; use tent task * / Desktop Service). External tent roots keep
dispatch / task-ack / report / complete / stamp \u2026 for the migration window only.
Derived role-init remains available because it regenerates bootstrap context only.
`;
}

// src/cli/tent.ts
var LEGACY_MUTATION_COMMANDS = /* @__PURE__ */ new Set([
  "dispatch",
  "task-ack",
  "task-cancel",
  "report",
  "propose",
  "complete",
  "stamp",
  "grant-readable",
  "new-box",
  "tag",
  "untag",
  "tag-new",
  "tag-rm",
  "fork",
  "clean-temp",
  "force-release",
  "okf-sync"
]);
var LEGACY_READONLY_COMMANDS = /* @__PURE__ */ new Set(["tree", "status", "roles", "find", "tags"]);
function isInWorkspaceSystemRoot(systemRoot) {
  return workspaceRootFromSystemRoot(systemRoot) !== void 0;
}
function isLegacyMutationCommand(cmd) {
  return LEGACY_MUTATION_COMMANDS.has(cmd);
}
function listLegacyMutationCommands() {
  return [...LEGACY_MUTATION_COMMANDS].sort();
}
function inWorkspaceLegacyMutationMessage(cmd, systemRoot) {
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  return `Legacy CLI command "${cmd}" refuses to direct-write an in-workspace Tent at ${systemRoot}.
Desktop co-located collaboration must go through Local Service (tent task * / Desktop).
systemRoot is <workspace>/${TENT_SYSTEM_DIR}` + (workspace ? ` (workspace: ${workspace})` : "") + `.
Allowed without Service: read-only tree/status/roles/find/tags; init/derived new/migrate/role-init/skill-install.
External (non-${TENT_SYSTEM_DIR}) Tent roots still accept legacy mutation commands during the migration window.`;
}
async function makeEnv() {
  const systemRoot = await findTentSystemRoot(process.cwd());
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  return {
    fs: new NodeFs(systemRoot),
    clock: new SystemClock(),
    tentName: path6.basename(workspace ?? systemRoot),
    tentRoot: systemRoot
  };
}
function assertLegacyDirectWriteAllowed(cmd, systemRoot) {
  if (!LEGACY_MUTATION_COMMANDS.has(cmd)) return;
  if (!isInWorkspaceSystemRoot(systemRoot)) return;
  throw new Error(inWorkspaceLegacyMutationMessage(cmd, systemRoot));
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(await packageVersion());
    return;
  }
  if (cmd === "new") {
    const { positionals, flags } = parseFlags(args);
    if (!positionals[0]) {
      return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
    }
    if (positionals.length > 1) return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
    await newTent(positionals[0], flags.vault);
    return;
  }
  if (cmd === "skill-install") {
    const { positionals, flags } = parseFlags(args);
    if (positionals.length > 0) return fail("Usage: tent skill-install [--target claude] [--force]");
    const target = flags.target || "claude";
    const force = flags.force === "true";
    const targetDirs = flags.dir ? [flags.dir] : defaultSkillInstallDirs(target);
    const results = await installSkills(targetDirs, { force, target });
    console.log(formatSkillInstallResults(target, results));
    return;
  }
  if (cmd === "migrate" || cmd === "import") {
    const { positionals, flags } = parseFlags(args);
    if (positionals.length > 0) {
      return fail(
        `Usage: tent ${cmd} --source <legacy-tent-root> --workspace <workspace-root> [--dry-run] [--force] [--json]`
      );
    }
    const source = flags.source || flags.from || flags.src;
    const workspace = flags.workspace || flags.to || flags.dest || flags.target;
    if (!source || !workspace) {
      return fail(
        `Usage: tent ${cmd} --source <legacy-tent-root> --workspace <workspace-root> [--dry-run] [--force] [--json]`
      );
    }
    const dryRun = flags["dry-run"] === "true" || flags.dryRun === "true";
    const force = flags.force === "true";
    const asJson = flags.json === "true";
    try {
      const report = await importExternalTentRoot({
        sourceRoot: path6.resolve(source),
        workspaceRoot: path6.resolve(workspace),
        dryRun,
        force
      });
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatImportReport(report));
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (cmd === "task") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(taskHelpText());
      return;
    }
    const result = await runTaskCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  const tentCommands = /* @__PURE__ */ new Set([
    ...LEGACY_MUTATION_COMMANDS,
    ...LEGACY_READONLY_COMMANDS,
    "role-init"
  ]);
  if (!tentCommands.has(cmd)) {
    return fail(
      `Unknown command: ${cmd || "(empty)"}
Commands: new migrate import task role-init roles dispatch task-ack task-cancel report propose complete stamp status grant-readable new-box tag untag tag-new tag-rm tags find fork clean-temp force-release okf-sync skill-install tree`
    );
  }
  const env = await makeEnv();
  if (!cmd) return fail("Unknown command: (empty)");
  const systemRoot = env.tentRoot;
  if (!systemRoot) return fail(NOT_INSIDE_TENT_MESSAGE);
  try {
    assertLegacyDirectWriteAllowed(cmd, systemRoot);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  switch (cmd) {
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
      const workspacePath = resolveTentWorkspace(tent, env.tentRoot);
      const dispatcher = requestedDispatcher || "user";
      let workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, role) : void 0;
      if (!workspacePath) {
        console.log("Note: this Tent has no in-workspace .tent layout; the task envelope has no workspace contract.");
      }
      if (flags["as-sub"]) {
        if (!workspacePath) {
          return fail(
            "--as-sub requires a workspace contract. Scaffold an in-workspace tent at <workspace>/.tent/."
          );
        }
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
      await taskAck(env, taskPath);
      console.log(`\u2713 Task acknowledged: ${taskPath}`);
      break;
    }
    case "task-cancel": {
      const taskPath = args[0];
      if (!taskPath) return fail("Usage: tent task-cancel <taskPath>");
      if (args.length > 1) return fail("Usage: tent task-cancel <taskPath>");
      await cancelPendingTask(env, taskPath);
      console.log(`\u2713 Task cancelled: ${taskPath}`);
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
      const workspacePath = resolveTentWorkspace(tent, env.tentRoot);
      if (flags["require-check"]) {
        if (!workspacePath) return fail("--require-check requires a workspace pointer");
        await runWorkspaceCheck(workspacePath, flags["require-check"]);
      }
      const acceptedBy = flags.by || process.env.TENT_ROLE || "user";
      const integrate = async (commitRefs) => {
        if (!workspacePath) throw new Error("The Tent has no workspace pointer");
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
        const pointer = outputPointer(box.fm, box.body);
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
    case "tree": {
      if (args.length > 0) return fail("Usage: tent tree");
      const tent = await loadTent(env.fs);
      for (const r of tent.roots) printBox(r, 0);
      break;
    }
    default:
      return fail(`Unknown command: ${cmd || "(empty)"}`);
  }
}
function readStdin() {
  return new Promise((resolve9, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve9(data));
    process.stdin.on("error", reject);
  });
}
async function readBodyFile(bodySource) {
  const resolved = path6.resolve(bodySource);
  if (!await existsPath(resolved)) throw new Error(`Body file not found: ${bodySource}.`);
  return fs6.readFile(resolved, "utf8");
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
  const booleanFlags = /* @__PURE__ */ new Set(["force", "yes", "as-sub", "dry-run", "json"]);
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
function defaultSkillInstallDirs(target) {
  if (target !== "claude") {
    throw new Error("skill-install currently supports only --target claude; Codex uses a different skill format.");
  }
  const home = os2.homedir();
  return [
    path6.join(home, ".claude", "skills"),
    path6.join(home, ".agents", "skills")
  ];
}
async function installSkills(targetDirs, options) {
  if (options.target !== "claude") defaultSkillInstallDirs(options.target);
  if (targetDirs.length === 0) throw new Error("skill-install requires at least one target directory");
  const sourceDir = path6.join(packageRoot(), "skills");
  const entries = await fs6.readdir(sourceDir, { withFileTypes: true });
  const skillNames = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await existsPath(path6.join(sourceDir, entry.name, "SKILL.md"))) skillNames.push(entry.name);
  }
  skillNames.sort();
  if (skillNames.length === 0) throw new Error(`No installable skills found in ${sourceDir}`);
  const results = [];
  for (const targetDir of targetDirs) {
    await fs6.mkdir(targetDir, { recursive: true });
    for (const name of skillNames) {
      const source = path6.join(sourceDir, name);
      const target = path6.join(targetDir, name);
      assertChildPath(targetDir, target);
      const exists2 = await existsPath(target);
      if (exists2 && !options.force) {
        results.push({
          targetDir,
          skill: name,
          status: "skipped",
          reason: "already exists (use --force to overwrite)"
        });
        continue;
      }
      if (exists2 && options.force) {
        await fs6.rm(target, { recursive: true, force: true });
      }
      await fs6.cp(source, target, { recursive: true, errorOnExist: true });
      results.push({ targetDir, skill: name, status: "installed" });
    }
  }
  return results;
}
function formatSkillInstallResults(target, results) {
  const byDir = /* @__PURE__ */ new Map();
  for (const item of results) {
    const list = byDir.get(item.targetDir) ?? [];
    list.push(item);
    byDir.set(item.targetDir, list);
  }
  const lines = [`\u2713 skill-install (${target} format)`];
  for (const [dir, items] of byDir) {
    lines.push(`  ${dir}`);
    for (const item of items) {
      const suffix = item.status === "skipped" && item.reason ? ` (${item.reason})` : "";
      lines.push(`    - ${item.skill}: ${item.status}${suffix}`);
    }
  }
  return lines.join("\n");
}
function packageRoot() {
  const here = path6.dirname(fileURLToPath2(import.meta.url));
  if (path6.basename(here) === "cli" && path6.basename(path6.dirname(here)) === "src") {
    return path6.resolve(here, "../..");
  }
  return here;
}
function assertChildPath(parent, child) {
  const rel = path6.relative(path6.resolve(parent), path6.resolve(child));
  if (rel.startsWith("..") || path6.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
}
async function existsPath(target) {
  try {
    await fs6.access(target);
    return true;
  } catch {
    return false;
  }
}
async function packageVersion() {
  const pkg = JSON.parse(await fs6.readFile(path6.join(packageRoot(), "package.json"), "utf8"));
  return String(pkg.version ?? "0.0.0");
}
function helpText() {
  return `Tent CLI

Usage:
  tent <command> [args]

Run commands from a workspace with <workspace>/.tent/ (or legacy external tent root) unless noted.

Service-backed task lifecycle (required for Desktop / in-workspace collaboration mutates):
  tent task list|get|claim|deliver|\u2026  Attach Local Service \u2192 mount \u2192 task.* RPC
  tent task --help                    Full task subcommand help
  CLI exit does not stop Local Service. Token stays in machine-local service.json.

Init / machine config (always allowed):
  new <path>                         Create an empty in-workspace Tent at <path>/.tent.
  new <name> --vault <vault>         Create a Tent under the vault's configured tents root.
  migrate --source <root> --workspace <ws>
                                     Copy legacy external tent root into <ws>/.tent (alias: import).
                                     Refuses if <ws>/.tent exists. Never deletes source.
                                     Options: --dry-run --force --json
  skill-install [--force]            Install bundled skills to ~/.claude/skills and ~/.agents/skills.
  role-init <role>                   Regenerate the derived stable role init document.

Read-only (allowed on in-workspace .tent):
  status                             Print a read-only Tent status summary.
  roles                              Print the role registry.
  tags                               List registered tags.
  find <tag>                         Find boxes by tag.
  tree                               Print the box tree.

Legacy direct-core mutations (external / non-.tent system root only \u2014 migration window):
  On <workspace>/.tent these fail-loud; use tent task * or Desktop Service instead.
  dispatch <boxId> <role> <prompt>   Create a pending task envelope.
  task-ack <taskPath>                Mark a task taken and claim its box (legacy claim).
  task-cancel <taskPath>             Delete a pending task envelope.
  report <boxId> <file|->            Submit a delivery report for triage.
  propose <boxId> <file|->           Submit a proposal prompt for triage.
  complete <boxId> [options]         Confirm completion and release owner.
  stamp <boxId> [--by <role>]        Mark done without workspace commits.
  force-release <boxId>              Release owner without accepting delivery.
  grant-readable <boxId>             Mark a box readable.
  new-box <name> <type> [parentId]   Create a box.
  tag|untag <boxId> <tag>            Add or remove a tag.
  tag-new | tag-rm                   Manage the tag registry.
  fork <boxId>                       Copy a box subtree with new ids.
  clean-temp [role]                  Remove temp state for one role or all roles.
  okf-sync                           Regenerate OKF indexes and projected links.

Options:
  -h, --help                         Show this help.
  -v, --version                      Show the package version.
`;
}
async function readVaultPluginSettings(vault) {
  const fsmod = await import("node:fs/promises");
  const dataPath = path6.join(path6.resolve(vault), ".obsidian", "plugins", "tent", "data.json");
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
    target = path6.join(path6.resolve(vault), pluginSettings.tentsRoot, target);
  }
  const workspaceRoot = path6.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${workspaceRoot}`);
  await fsmod.mkdir(workspaceRoot, { recursive: true });
  const name = path6.basename(workspaceRoot);
  const fallbackRules = `# ${name} - Project Rules

> Local project rules for this Tent. Created by tent-genesis; edit freely.
> Mechanism-level rules live in the Tent repository docs/SPEC.md; the agent operation protocol lives in the tent-role skill.

- Output workspace: ${workspaceRoot.replaceAll("\\", "/")}
- Commit / naming conventions: <fill in>
- Other project rules: <fill in>
`;
  const rules = pluginSettings?.rulesTemplate ? pluginSettings.rulesTemplate.replaceAll("{tent}", name) : fallbackRules;
  await scaffoldInWorkspace(fsa, {
    name,
    rules,
    typeRegistry: pluginSettings?.typeRegistry,
    rolesRegistry: pluginSettings?.rolesRegistry
  });
  console.log(
    `\u2713 Created Tent: ${path6.join(workspaceRoot, ".tent")}
In-workspace layout: collaboration facts live under <workspace>/.tent/.
The concept tree starts empty; add notes/boxes as folder + same-named Markdown.`
  );
}
function formatImportReport(report) {
  const lines = [
    report.dryRun ? "Tent migrate (dry-run)" : "Tent migrate",
    `  source:     ${report.sourceRoot}`,
    `  workspace:  ${report.workspaceRoot}`,
    `  systemRoot: ${report.systemRoot}`,
    `  copied:     ${report.copied}`,
    `  sourceMarked (MIGRATED.md): ${report.sourceMarked}`,
    `  id remaps:  ${report.schema.idMap.length}`,
    `  type rewrites: ${report.schema.typeRewrites.length}`
  ];
  if (report.schema.registryChanges.length) {
    lines.push("  registry:");
    for (const c of report.schema.registryChanges.slice(0, 40)) {
      lines.push(`    - ${c}`);
    }
    if (report.schema.registryChanges.length > 40) {
      lines.push(`    \u2026 +${report.schema.registryChanges.length - 40} more`);
    }
  }
  if (report.schema.idMap.length) {
    lines.push("  id map (sample):");
    for (const e of report.schema.idMap.slice(0, 12)) {
      lines.push(`    - ${e.from} \u2192 ${e.to} (${e.path})`);
    }
    if (report.schema.idMap.length > 12) {
      lines.push(`    \u2026 +${report.schema.idMap.length - 12} more`);
    }
  }
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  for (const s of report.skipped) lines.push(`  skipped: ${s}`);
  if (!report.dryRun) {
    lines.push(
      "Source was not deleted. Verify <workspace>/.tent then remove the old root manually if desired."
    );
  }
  return lines.join("\n");
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
export {
  inWorkspaceLegacyMutationMessage,
  isInWorkspaceSystemRoot,
  isLegacyMutationCommand,
  listLegacyMutationCommands
};
