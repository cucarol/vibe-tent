#!/usr/bin/env node


// src/service/cli.ts
import * as path14 from "node:path";

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
async function backupCorruptRegistry(fs13, path15) {
  const backupPath = `${path15}.corrupt-${timestamp()}`;
  await fs13.writeFile(backupPath, await fs13.readFile(path15));
  return backupPath;
}
function warnRegistryRecovered(path15, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path15} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
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
var WORKSPACE_SETTINGS_PATH = "settings.json";
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
  WORKSPACE_SETTINGS_PATH,
  "index.md",
  "log.md"
]);
function systemRootFromWorkspace(workspaceRoot) {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const sep2 = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${sep2}${TENT_SYSTEM_DIR}`;
}
function isOperationalPath(relativePath2) {
  const path15 = relativePath2.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path15) return false;
  const top = path15.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}

// src/core/order.ts
var ROOT_KEY = "__root__";
async function loadOrder(fs13) {
  if (!await fs13.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs13.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs13, ORDER_PATH);
    await saveOrder(fs13, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs13, map) {
  await fs13.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
async function loadTypeRegistry(fs13) {
  if (!await fs13.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs13.readFile(TYPE_REGISTRY_PATH));
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
async function loadTent(fs13) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs13);
  const top = await fs13.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadBoxInto(fs13, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs13);
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
async function loadBox(fs13, path15, parent, registry) {
  if (isOperationalPath(path15)) return null;
  const boxFile = boxNotePath(path15);
  if (!await fs13.exists(boxFile)) {
    return null;
  }
  const raw = await fs13.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path15);
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
    path: path15,
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
    box.invalidRootId = path15;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs13.listDir(path15);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs13, join(path15, entry.name), box, registry, box.children);
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
async function loadBoxInto(fs13, path15, parent, registry, target) {
  if (isOperationalPath(path15)) return;
  const box = await loadBox(fs13, path15, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs13.listDir(path15);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs13, join(path15, entry.name), parent, registry, target);
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
function baseName(path15) {
  const i = path15.lastIndexOf("/");
  return i === -1 ? path15 : path15.slice(i + 1);
}
function dirName(path15) {
  const i = path15.lastIndexOf("/");
  return i === -1 ? "" : path15.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs13, action) {
  return fs13.withLock ? fs13.withLock(MUTATION_LOCK_PATH, action) : action();
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
async function loadRolesRegistry(fs13) {
  if (!await fs13.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs13.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs13, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs13, ROLES_REGISTRY_PATH, reset);
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return reset;
  }
}
async function createRole(fs13, definition) {
  await withTentMutation(fs13, async () => {
    const role = normalizeRole(definition);
    if (!role.name) throw new Error("Role name cannot be empty.");
    const registry = await loadRolesRegistry(fs13);
    if (registry.roles.some((item) => item.name === role.name)) throw new Error(`Role already exists: ${role.name}.`);
    registry.roles.push(role);
    await writeJson(fs13, ROLES_REGISTRY_PATH, registry);
  });
}
async function updateRole(fs13, name, patch) {
  await withTentMutation(fs13, async () => {
    const registry = await loadRolesRegistry(fs13);
    const index = registry.roles.findIndex((role) => role.name === name);
    if (index === -1) throw new Error(`Role does not exist: ${name}.`);
    const next = normalizeRole({ ...registry.roles[index], ...patch, name });
    if (Object.prototype.hasOwnProperty.call(patch, "allowedProfiles")) {
      const normalized = normalizeAllowedProfiles(patch.allowedProfiles);
      if (normalized) next.allowedProfiles = normalized;
      else delete next.allowedProfiles;
    }
    registry.roles[index] = next;
    await writeJson(fs13, ROLES_REGISTRY_PATH, registry);
  });
}
async function deleteRole(fs13, name, confirmation) {
  await withTentMutation(fs13, async () => {
    if (confirmation !== name) throw new Error(`Confirmation mismatch; enter the role name ${name}.`);
    const registry = await loadRolesRegistry(fs13);
    const next = registry.roles.filter((role) => role.name !== name);
    if (next.length === registry.roles.length) throw new Error(`Role does not exist: ${name}.`);
    await writeJson(fs13, ROLES_REGISTRY_PATH, { roles: next });
  });
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
  const allowedProfiles = normalizeAllowedProfiles(value.allowedProfiles);
  if (allowedProfiles) role.allowedProfiles = allowedProfiles;
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}
function roleA2APolicy(role) {
  return role?.a2aPolicy ?? "deny";
}
function roleAllowsProfile(role, profileId) {
  const id = typeof profileId === "string" ? profileId.trim() : "";
  if (!id) return false;
  const allowed = role?.allowedProfiles;
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(id);
}
function normalizeAllowedProfiles(value) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value)) {
    return void 0;
  }
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : void 0;
}
function normalizeA2APolicy(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return void 0;
}
function normalizeRole(value) {
  return normalizeRoleDefinition(value);
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
async function writeJson(fs13, path15, value) {
  if (!await fs13.exists(".tent")) await fs13.mkdir(".tent");
  await fs13.writeFile(path15, JSON.stringify(value, null, 2) + "\n");
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/task-model.ts
var ACTIVE_TASK_STATES = /* @__PURE__ */ new Set([
  "queued",
  "running",
  "waiting",
  "delivered"
]);
var TERMINAL_TASK_STATES = /* @__PURE__ */ new Set([
  "accepted",
  "rejected",
  "interrupted",
  "failed"
]);
function isActiveTaskState(state) {
  return ACTIVE_TASK_STATES.has(state);
}
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
function projectBoxFromTask(input) {
  if (input.active) return { status: "doing", clearAssignee: false };
  if (input.terminalState === "accepted") return { status: "done", clearAssignee: true };
  return { status: "todo", clearAssignee: true };
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
async function loadTaskEnvelopes(fs13) {
  const tasks = [];
  if (!await fs13.exists("temp")) return tasks;
  for (const roleEntry of await fs13.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    const taskDir = join("temp", roleEntry.name, "tasks");
    if (!await fs13.exists(taskDir)) continue;
    for (const entry of await fs13.listDir(taskDir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path15 = join(taskDir, entry.name);
      try {
        tasks.push(await loadTaskEnvelope(fs13, path15));
      } catch {
      }
    }
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function loadTaskEnvelope(fs13, path15) {
  if (!await fs13.exists(path15)) throw new Error(`Task envelope not found: ${path15}.`);
  const { data, body } = parseFrontmatter(await fs13.readFile(path15));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
    throw new Error(`Invalid task envelope format: ${path15}.`);
  }
  const legacyStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);
  const task = {
    path: path15,
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
  if (typeof data.roleBranchBase === "string" && data.roleBranchBase.trim()) {
    task.roleBranchBase = data.roleBranchBase.trim();
  }
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
async function ensureRoleInit(fs13, role, tentName) {
  const path15 = join("temp", role.name, "init.md");
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
  await fs13.writeFile(path15, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path15;
}
async function writeTaskEnvelope(fs13, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs13, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path15 = await uniqueMarkdownPath(fs13, dir, stem);
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
  await fs13.writeFile(path15, serializeFrontmatter(data, body));
  return path15;
}
async function ackTaskEnvelope(fs13, path15) {
  await patchTaskEnvelope(fs13, path15, {
    status: "taken",
    state: "running"
  });
}
async function patchTaskEnvelope(fs13, path15, patch) {
  if (!await fs13.exists(path15)) throw new Error(`Task envelope not found: ${path15}.`);
  const raw = await fs13.readFile(path15);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path15}.`);
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
  if (patch.roleBranchBase === null) delete data.roleBranchBase;
  else if (typeof patch.roleBranchBase === "string" && patch.roleBranchBase.trim()) {
    data.roleBranchBase = patch.roleBranchBase.trim();
  }
  await fs13.writeFile(path15, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs13, path15);
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
async function uniqueMarkdownPath(fs13, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path15 = join(dir, `${stem}${suffix}.md`);
    if (!await fs13.exists(path15)) return path15;
  }
}
async function ensureDir(fs13, path15) {
  if (!await fs13.exists(path15)) await fs13.mkdir(path15);
}

// src/core/report.ts
async function loadReports(fs13) {
  const reports = [];
  if (!await fs13.exists("temp")) return reports;
  for (const roleDir of await fs13.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!await fs13.exists(dir)) continue;
    for (const entry of await fs13.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path15 = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs13, path15));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs13, inputPath) {
  const path15 = normalizeReportPath(inputPath);
  if (!await fs13.exists(path15)) throw new Error(`Report not found: ${path15}.`);
  const { data, body } = parseFrontmatter(await fs13.readFile(path15));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`Invalid report format: ${path15}.`);
  }
  return {
    path: path15,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function removeReportsForBox(fs13, boxId) {
  for (const report of await loadReports(fs13)) {
    if (report.boxId === boxId && await fs13.exists(report.path)) await fs13.remove(report.path);
  }
}
function normalizeReportPath(input) {
  const path15 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/[bc]x-[^/]+\.md$/.test(path15)) {
    throw new Error("Report must point to temp/<role>/reports/<boxId>.md.");
  }
  return path15;
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
async function createDeliveryUnlocked(fs13, clock, input) {
  const summary = input.summary.trim();
  if (!summary) throw new Error("Delivery summary cannot be empty.");
  const now = clock.now();
  const id = input.id && isDeliveryId(input.id) ? input.id : makeDeliveryId();
  const dir = join("temp", input.role, "deliveries");
  await ensureDir2(fs13, dir);
  const path15 = join(dir, `${id}.md`);
  if (await fs13.exists(path15)) throw new Error(`Delivery already exists: ${path15}.`);
  const record = {
    path: path15,
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
  await writeDelivery(fs13, record);
  return record;
}
async function loadDelivery(fs13, inputPath) {
  const path15 = normalizeDeliveryPath(inputPath);
  if (!await fs13.exists(path15)) throw new Error(`Delivery not found: ${path15}.`);
  const { data, body } = parseFrontmatter(await fs13.readFile(path15));
  if (data.type !== "delivery" || typeof data.id !== "string" || !isDeliveryId(data.id)) {
    throw new Error(`Invalid delivery format: ${path15}.`);
  }
  if (typeof data.taskId !== "string" || typeof data.boxId !== "string" || typeof data.role !== "string") {
    throw new Error(`Invalid delivery format: ${path15}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : void 0;
  const reviewDecision = data.reviewDecision === "accept" || data.reviewDecision === "reject" ? data.reviewDecision : void 0;
  return {
    path: path15,
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
async function loadDeliveries(fs13, filter) {
  const out = [];
  if (!await fs13.exists("temp")) return out;
  for (const roleDir of await fs13.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "deliveries");
    if (!await fs13.exists(dir)) continue;
    for (const entry of await fs13.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      try {
        const d = await loadDelivery(fs13, join(dir, entry.name));
        if (filter?.taskId && d.taskId !== filter.taskId) continue;
        if (filter?.boxId && d.boxId !== filter.boxId) continue;
        out.push(d);
      } catch {
      }
    }
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
async function writeDelivery(fs13, record) {
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
  await fs13.writeFile(record.path, serializeFrontmatter(data, record.summary + "\n", KEY_ORDER));
}
function normalizeDeliveryPath(input) {
  const path15 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path15)) {
    throw new Error("Delivery must point to temp/<role>/deliveries/<dl-id>.md.");
  }
  return path15;
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
async function ensureDir2(fs13, path15) {
  if (!await fs13.exists(path15)) await fs13.mkdir(path15);
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
    if (task.state === "running" && !task.wait) return task;
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
async function taskFail(env, taskPath, options = {}) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.state === "failed") {
      await releaseOccupationForTask(env, task);
      return task;
    }
    assertTransition(task.state, "fail", "failed");
    await releaseOccupationForTask(env, task);
    void options.summary;
    return patchTaskEnvelope(env.fs, taskPath, {
      state: "failed",
      wait: null,
      updatedAt: env.clock.now()
    });
  });
}
async function releaseOccupationForTask(env, task) {
  const tent = await loadTent(env.fs);
  for (const claimId of task.claims) {
    if (claimId === "root") continue;
    const box = tent.byId.get(claimId);
    if (!box) continue;
    await projectAssignee(env.fs, box, void 0, "todo");
    await removeReportsForBox(env.fs, box.id);
  }
}
async function taskCancel(env, taskPath) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "cancel", "interrupted");
    await env.fs.remove(taskPath);
  });
}
async function findActiveTaskForBox(fs13, boxId) {
  const tasks = await loadTaskEnvelopes(fs13);
  return tasks.find((t) => t.claims.includes(boxId) && isActiveTaskState(t.state));
}
function boxProjectionOf(task) {
  if (!task) return { status: "todo" };
  const active = isActiveTaskState(task.state);
  const proj = projectBoxFromTask({
    active,
    terminalState: active ? void 0 : task.state
  });
  return {
    status: proj.status,
    assignee: proj.clearAssignee ? void 0 : task.role,
    activeTaskId: task.id || task.path
  };
}
async function requireActiveReadyDelivery(fs13, task) {
  if (task.activeDeliveryId) {
    const byId = (await loadDeliveries(fs13, { taskId: task.id || task.path })).find(
      (d) => d.id === task.activeDeliveryId
    );
    if (byId && byId.status === "ready") return byId;
    if (byId) {
    }
  }
  const ready = (await loadDeliveries(fs13, { taskId: task.id || task.path })).find((d) => d.status === "ready");
  if (!ready) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No ready delivery for this task.");
  }
  return ready;
}
async function projectAssignee(fs13, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs13, box, patch);
}
async function restoreProjection(fs13, box, owner, status, acceptedBy) {
  await patchFrontmatter(fs13, box, {
    owner: owner ?? void 0,
    status: status ?? void 0,
    acceptedBy: acceptedBy ?? void 0
  });
}
async function patchFrontmatter(fs13, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs13.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  const order = [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...keyOrder.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
  await fs13.writeFile(boxFile, serializeFrontmatter(data, body, order));
}
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs13, action) {
  return withTentMutation(fs13, action);
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
async function uniqueSiblingPath(fs13, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!await fs13.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs13, from, to) {
  await fs13.mkdir(to);
  for (const entry of await fs13.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs13, src, dst);
    else await fs13.writeFile(dst, await fs13.readFile(src));
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
async function ensureIdentityFileName(fs13, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs13.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs13.exists(copied)) await fs13.move(copied, expected);
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
  const path15 = join(input.parentPath, name);
  assertNotTempPath(path15);
  await ensureDir3(env.fs, path15);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path15), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path15);
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
async function ensureDir3(fs13, path15) {
  if (path15 && !await fs13.exists(path15)) await fs13.mkdir(path15);
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
function assertNotTempPath(path15) {
  if (path15 === "temp" || path15.startsWith("temp/")) {
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
async function withMutation2(fs13, action) {
  return withTentMutation(fs13, action);
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

// src/core/proposal.ts
async function submitProposal(fs13, clock, role, boxId, body) {
  return withTentMutation(fs13, async () => submitProposalUnlocked(fs13, clock, role, boxId, body));
}
async function submitProposalUnlocked(fs13, clock, roleInput, boxId, body) {
  const text = body.trim();
  if (!text) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole2(roleInput);
  const tent = await loadTent(fs13);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const path15 = proposalPath(role, box.id);
  if (await fs13.exists(path15)) {
    const current = await loadProposal(fs13, path15);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }
  const proposal = {
    path: path15,
    boxId: box.id,
    role,
    status: "pending",
    createdAt: clock.now(),
    body: text
  };
  await ensureDir4(fs13, join("temp", role, "proposals"));
  await writeProposal(fs13, proposal);
  return proposal;
}
async function loadProposals(fs13) {
  const proposals = [];
  if (!await fs13.exists("temp")) return proposals;
  for (const roleDir of await fs13.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "proposals");
    if (!await fs13.exists(dir)) continue;
    for (const entry of await fs13.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path15 = join(dir, entry.name);
      try {
        proposals.push(await loadProposal(fs13, path15));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs13, inputPath) {
  const path15 = normalizeProposalPath(inputPath);
  if (!await fs13.exists(path15)) throw new Error(`Proposal not found: ${path15}.`);
  const { data, body } = parseFrontmatter(await fs13.readFile(path15));
  if (data.type !== "proposal" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path15}.`);
  }
  return {
    path: path15,
    boxId: data.box,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    body: body.trim()
  };
}
async function acceptProposal(fs13, inputPath) {
  await withTentMutation(fs13, async () => {
    const proposal = await loadProposal(fs13, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be accepted.");
    proposal.status = "accepted";
    await writeProposal(fs13, proposal);
  });
}
async function rejectProposal(fs13, inputPath) {
  await withTentMutation(fs13, async () => {
    const proposal = await loadProposal(fs13, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be rejected.");
    proposal.status = "rejected";
    await writeProposal(fs13, proposal);
  });
}
function proposalPath(role, boxId) {
  return join("temp", role, "proposals", `${boxId}.md`);
}
function normalizeProposalPath(input) {
  const path15 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/[bc]x-[^/]+\.md$/.test(path15)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path15;
}
async function writeProposal(fs13, proposal) {
  const data = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
  await fs13.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}
async function ensureDir4(fs13, path15) {
  if (!await fs13.exists(path15)) await fs13.mkdir(path15);
}
function normalizeRole2(role) {
  const normalized = role.trim();
  if (!normalized) throw new Error("Proposal role cannot be empty; set TENT_ROLE before running tent propose.");
  if (normalized.includes("..") || /[\/\\\r\n]/.test(normalized)) throw new Error(`Invalid proposal role: ${role}`);
  return normalized;
}

// src/core/retention.ts
var DEFAULT_KEEP_TERMINAL_DAYS = 30;
var MAX_KEEP_TERMINAL_DAYS = 3650;
var MS_PER_DAY = 24 * 60 * 60 * 1e3;
var TERMINAL_DELIVERY_STATUSES = /* @__PURE__ */ new Set([
  "accepted",
  "rejected"
]);
var RetentionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RetentionError";
  }
};
function normalizeKeepTerminalTasksDays(raw) {
  if (raw === void 0 || raw === null) return DEFAULT_KEEP_TERMINAL_DAYS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new RetentionError(
      "INVALID_KEEP_DAYS",
      "keepTerminalTasksDays must be a non-negative integer"
    );
  }
  if (raw < 0) {
    throw new RetentionError(
      "INVALID_KEEP_DAYS",
      "keepTerminalTasksDays must be a non-negative integer"
    );
  }
  if (raw > MAX_KEEP_TERMINAL_DAYS) {
    throw new RetentionError(
      "INVALID_KEEP_DAYS",
      `keepTerminalTasksDays must be \u2264 ${MAX_KEEP_TERMINAL_DAYS}`
    );
  }
  return raw;
}
function isTerminalTaskState(state) {
  return TERMINAL_TASK_STATES.has(state);
}
function isPurgeableDeliveryStatus(status) {
  return TERMINAL_DELIVERY_STATUSES.has(status);
}
async function previewOperationalRetention(fs13, options = {}) {
  const keepTerminalTasksDays = normalizeKeepTerminalTasksDays(options.keepTerminalTasksDays);
  const nowMs = resolveNowMs(options.now);
  const cutoffMs = nowMs - keepTerminalTasksDays * MS_PER_DAY;
  const cutoff = new Date(cutoffMs).toISOString();
  const skipped = [];
  const warnings = [];
  const { tasks, skipped: taskSkipped } = await scanTasks(fs13);
  skipped.push(...taskSkipped);
  const { deliveries, skipped: deliverySkipped } = await scanDeliveries(fs13);
  skipped.push(...deliverySkipped);
  for (const s of skipped) {
    warnings.push(`skipped ${s.path}: ${s.reason}`);
  }
  const tasksById = /* @__PURE__ */ new Map();
  const taskIdCounts = /* @__PURE__ */ new Map();
  for (const t of tasks) {
    if (t.id) {
      tasksById.set(t.id, t);
      taskIdCounts.set(t.id, (taskIdCounts.get(t.id) ?? 0) + 1);
    }
  }
  const deliveriesByTaskId = /* @__PURE__ */ new Map();
  for (const d of deliveries) {
    const list = deliveriesByTaskId.get(d.taskId) ?? [];
    list.push(d);
    deliveriesByTaskId.set(d.taskId, list);
  }
  const candidates = [];
  const claimedDeliveryPaths = /* @__PURE__ */ new Set();
  for (const task of tasks) {
    if (!isTerminalTaskState(task.state)) continue;
    if (isActiveTaskState(task.state)) continue;
    if (task.id && (taskIdCounts.get(task.id) ?? 0) > 1) {
      const message = `duplicate task id ${task.id}; refusing ambiguous retention group`;
      skipped.push({ path: task.path, reason: message });
      warnings.push(`skipped ${task.path}: ${message}`);
      continue;
    }
    const related = task.id ? deliveriesByTaskId.get(task.id) ?? [] : [];
    const activityValues = [taskActivityMs(task), ...related.map(deliveryActivityMs)];
    if (activityValues.some((value) => value === void 0)) {
      if (keepTerminalTasksDays > 0) {
        skipped.push({
          path: task.path,
          reason: "task group has missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0"
        });
        warnings.push(
          `skipped ${task.path}: task group has missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0`
        );
        continue;
      }
    }
    const activityMs = Math.max(...activityValues.map((value) => value ?? 0));
    if (activityMs > cutoffMs) continue;
    const protectedDeliveries = related.filter((d) => !isPurgeableDeliveryStatus(d.status));
    if (protectedDeliveries.length > 0) {
      warnings.push(
        `task-group ${task.path} has ${protectedDeliveries.length} non-terminal delivery(ies); refusing group purge`
      );
      continue;
    }
    const ageDays = ageDaysFrom(activityMs, nowMs);
    const deliveryPaths = related.map((d) => d.path);
    for (const p of deliveryPaths) claimedDeliveryPaths.add(p);
    candidates.push({
      kind: "task-group",
      taskId: task.id,
      taskPath: task.path,
      taskState: task.state,
      deliveryPaths,
      ageDays,
      reason: `terminal task state=${task.state} ageDays=${ageDays} \u2265 keep=${keepTerminalTasksDays}`
    });
  }
  for (const d of deliveries) {
    if (claimedDeliveryPaths.has(d.path)) continue;
    if (!isPurgeableDeliveryStatus(d.status)) continue;
    const parent = tasksById.get(d.taskId);
    if (parent) {
      continue;
    }
    const activity = deliveryActivityMs(d);
    if (activity === void 0) {
      if (keepTerminalTasksDays > 0) {
        skipped.push({
          path: d.path,
          reason: "missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0"
        });
        warnings.push(
          `skipped ${d.path}: missing createdAt/updatedAt; not eligible while keepTerminalTasksDays > 0`
        );
        continue;
      }
    }
    const activityMs = activity ?? 0;
    if (activityMs > cutoffMs) continue;
    const ageDays = ageDaysFrom(activityMs, nowMs);
    candidates.push({
      kind: "orphan-delivery",
      taskId: d.taskId,
      deliveryPaths: [d.path],
      ageDays,
      reason: `orphan non-ready delivery status=${d.status} ageDays=${ageDays} \u2265 keep=${keepTerminalTasksDays}`
    });
  }
  candidates.sort((a, b) => {
    const ap = a.taskPath || a.deliveryPaths[0] || "";
    const bp = b.taskPath || b.deliveryPaths[0] || "";
    return ap.localeCompare(bp);
  });
  let candidateDeliveryCount = 0;
  let candidateTaskCount = 0;
  for (const c of candidates) {
    if (c.kind === "task-group") candidateTaskCount += 1;
    candidateDeliveryCount += c.deliveryPaths.length;
  }
  return {
    keepTerminalTasksDays,
    cutoff,
    candidates,
    skipped,
    warnings,
    candidateTaskCount,
    candidateDeliveryCount
  };
}
async function purgeOperationalRetention(fs13, options = {}) {
  return withTentMutation(fs13, async () => {
    const preview = await previewOperationalRetention(fs13, options);
    const purgedTaskPaths = [];
    const purgedDeliveryPaths = [];
    for (const c of preview.candidates) {
      if (c.kind === "task-group" && c.taskPath) {
        try {
          const live = await loadTaskEnvelope(fs13, c.taskPath);
          if (!isTerminalTaskState(live.state) || isActiveTaskState(live.state)) {
            preview.warnings.push(
              `refused purge of ${c.taskPath}: state is ${live.state} (not terminal)`
            );
            continue;
          }
        } catch (err) {
          preview.warnings.push(
            `refused purge of ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
        let deliveryValidationFailed = false;
        for (const dp of c.deliveryPaths) {
          try {
            const liveD = await loadDelivery(fs13, dp);
            if (!isPurgeableDeliveryStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of task group ${c.taskPath}: delivery ${dp} status=${liveD.status}`
              );
              deliveryValidationFailed = true;
              break;
            }
          } catch (err) {
            preview.warnings.push(
              `refused purge of task group ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
            );
            deliveryValidationFailed = true;
            break;
          }
        }
        if (deliveryValidationFailed) continue;
        try {
          if (await fs13.exists(c.taskPath)) {
            await fs13.remove(c.taskPath);
            purgedTaskPaths.push(c.taskPath);
          }
        } catch (err) {
          preview.warnings.push(
            `failed to purge task ${c.taskPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
        for (const dp of c.deliveryPaths) {
          try {
            if (await fs13.exists(dp)) {
              await fs13.remove(dp);
              purgedDeliveryPaths.push(dp);
            }
          } catch (err) {
            preview.warnings.push(
              `failed to purge orphaned delivery ${dp}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        continue;
      }
      if (c.kind === "orphan-delivery") {
        for (const dp of c.deliveryPaths) {
          try {
            const liveD = await loadDelivery(fs13, dp);
            if (!isPurgeableDeliveryStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of delivery ${dp}: status=${liveD.status}`
              );
              continue;
            }
            if (await fs13.exists(dp)) {
              await fs13.remove(dp);
              purgedDeliveryPaths.push(dp);
            }
          } catch (err) {
            preview.warnings.push(
              `failed to purge delivery ${dp}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }
    const deletedCount = purgedTaskPaths.length + purgedDeliveryPaths.length;
    return {
      ...preview,
      purged: {
        taskPaths: purgedTaskPaths,
        deliveryPaths: purgedDeliveryPaths
      },
      deletedCount
    };
  });
}
async function scanTasks(fs13) {
  const tasks = [];
  const skipped = [];
  if (!await fs13.exists("temp")) return { tasks, skipped };
  for (const roleEntry of await fs13.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    if (!isSafeRoleSegment(roleEntry.name)) {
      skipped.push({
        path: join("temp", roleEntry.name),
        reason: "unsafe role directory name"
      });
      continue;
    }
    const taskDir = join("temp", roleEntry.name, "tasks");
    if (!await fs13.exists(taskDir)) continue;
    for (const entry of await fs13.listDir(taskDir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path15 = join(taskDir, entry.name);
      try {
        tasks.push(await loadTaskEnvelope(fs13, path15));
      } catch (err) {
        skipped.push({
          path: path15,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  return { tasks, skipped };
}
async function scanDeliveries(fs13) {
  const deliveries = [];
  const skipped = [];
  if (!await fs13.exists("temp")) return { deliveries, skipped };
  for (const roleEntry of await fs13.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    if (!isSafeRoleSegment(roleEntry.name)) {
      skipped.push({
        path: join("temp", roleEntry.name),
        reason: "unsafe role directory name"
      });
      continue;
    }
    const dir = join("temp", roleEntry.name, "deliveries");
    if (!await fs13.exists(dir)) continue;
    for (const entry of await fs13.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path15 = join(dir, entry.name);
      try {
        deliveries.push(await loadDelivery(fs13, path15));
      } catch (err) {
        skipped.push({
          path: path15,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  return { deliveries, skipped };
}
function isSafeRoleSegment(name) {
  if (!name || name === "." || name === "..") return false;
  if (/[\\/]/.test(name)) return false;
  if (name.includes("\0")) return false;
  return true;
}
function taskActivityMs(task) {
  return parseIsoMs(task.updatedAt) ?? parseIsoMs(task.createdAt);
}
function deliveryActivityMs(d) {
  return parseIsoMs(d.updatedAt) ?? parseIsoMs(d.createdAt);
}
function parseIsoMs(value) {
  if (!value) return void 0;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return void 0;
  return ms;
}
function resolveNowMs(now) {
  if (now === void 0) return Date.now();
  if (now instanceof Date) {
    const ms2 = now.getTime();
    if (!Number.isFinite(ms2)) throw new RetentionError("INVALID_KEEP_DAYS", "Invalid now Date");
    return ms2;
  }
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) {
    throw new RetentionError("INVALID_KEEP_DAYS", "Invalid now ISO timestamp");
  }
  return ms;
}
function ageDaysFrom(activityMs, nowMs) {
  const delta = Math.max(0, nowMs - activityMs);
  return Math.floor(delta / MS_PER_DAY);
}

// src/core/workspace-settings.ts
var DEFAULT_DELIVERY_POLICY = "manual";
var DEFAULT_SETTINGS = {
  defaultDeliveryPolicy: DEFAULT_DELIVERY_POLICY
};
function isDeliveryPolicyValue(value) {
  return value === "manual" || value === "bypass" || value === "agent-decide";
}
function normalizeWorkspaceSettings(value) {
  if (!isRecord3(value)) {
    return { ...DEFAULT_SETTINGS };
  }
  const out = { ...value };
  if (!isDeliveryPolicyValue(out.defaultDeliveryPolicy)) {
    out.defaultDeliveryPolicy = DEFAULT_DELIVERY_POLICY;
  }
  return out;
}
function defaultWorkspaceSettings() {
  return { ...DEFAULT_SETTINGS };
}
async function loadWorkspaceSettings(fs13) {
  if (!await fs13.exists(WORKSPACE_SETTINGS_PATH)) {
    return defaultWorkspaceSettings();
  }
  try {
    const parsed = JSON.parse(await fs13.readFile(WORKSPACE_SETTINGS_PATH));
    return normalizeWorkspaceSettings(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs13, WORKSPACE_SETTINGS_PATH);
    const reset = defaultWorkspaceSettings();
    await writeSettingsUnlocked(fs13, reset);
    warnRegistryRecovered(
      WORKSPACE_SETTINGS_PATH,
      backupPath,
      "reset",
      "IMPORTANT: workspace settings cannot be inferred; restore needed keys from the backup."
    );
    return reset;
  }
}
async function updateWorkspaceSettings(fs13, patch) {
  return withTentMutation(fs13, async () => {
    if (!isRecord3(patch)) {
      throw new WorkspaceSettingsError(
        "INVALID_PATCH",
        "workspace.settings.update patch must be an object"
      );
    }
    const before = await loadWorkspaceSettings(fs13);
    const nextRaw = { ...before };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "defaultDeliveryPolicy") {
        if (value === void 0) continue;
        if (!isDeliveryPolicyValue(value)) {
          throw new WorkspaceSettingsError(
            "INVALID_DELIVERY_POLICY",
            `Invalid defaultDeliveryPolicy: ${String(value)}`
          );
        }
        nextRaw.defaultDeliveryPolicy = value;
        continue;
      }
      if (value === void 0) continue;
      nextRaw[key] = value;
    }
    const next = normalizeWorkspaceSettings(nextRaw);
    const changed = !settingsEqual(before, next);
    if (changed) {
      await writeSettingsUnlocked(fs13, next);
    }
    return { settings: next, changed };
  });
}
var WorkspaceSettingsError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "WorkspaceSettingsError";
  }
};
async function writeSettingsUnlocked(fs13, settings) {
  const known = ["defaultDeliveryPolicy"];
  const ordered = {};
  for (const key of known) {
    if (key in settings) ordered[key] = settings[key];
  }
  const rest = Object.keys(settings).filter((k) => !known.includes(k)).sort((a, b) => a.localeCompare(b));
  for (const key of rest) {
    ordered[key] = settings[key];
  }
  await fs13.writeFile(WORKSPACE_SETTINGS_PATH, JSON.stringify(ordered, null, 2) + "\n");
}
function settingsEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}
function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord3(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    out[key] = sortKeysDeep(value[key]);
  }
  return out;
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/workspace.ts
import * as nodePath from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
async function findIntegratedCommit(workspace, sourceRef, targetBranch) {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const full = await fullRef(root, sourceRef);
  const ancestor = await findAncestorIntegration(root, full, targetBranch);
  if (ancestor) return { integratedRef: full, reason: "ancestor" };
  const prior = await findCherryPick(root, full, targetBranch);
  if (prior) return { integratedRef: prior, reason: "cherry-pick" };
  return void 0;
}
async function readRoleBranchTip(workspace, branch) {
  const root = nodePath.resolve(workspace);
  await assertGitWorkspace(root);
  const name = branch.trim();
  if (!name) throw new Error("Role branch name is required.");
  const ref = (await git(root, ["rev-parse", `refs/heads/${name}`])).trim();
  if (!ref) throw new Error(`Cannot read role branch tip: ${name}.`);
  return ref;
}
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
async function listRoleCommitsSince(contract, base) {
  const since = base.trim();
  if (!since) throw new Error("listRoleCommitsSince requires a non-empty base SHA.");
  const branchRef = `refs/heads/${contract.branch}`;
  const fullBase = await fullRef(contract.workspace, since);
  if (!await gitOk(contract.workspace, ["merge-base", "--is-ancestor", fullBase, branchRef])) {
    throw new Error(
      `Role branch ${contract.branch} no longer descends from task baseline ${fullBase}.`
    );
  }
  const output = await git(contract.workspace, [
    "log",
    `${fullBase}..${branchRef}`,
    "--format=%H%x09%h%x09%s"
  ]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [ref = "", shortRef = "", ...subjectParts] = line.split("	");
    return { ref, shortRef, subject: subjectParts.join("	") };
  }).filter((item) => item.ref && item.shortRef);
}
async function listPendingRoleCommits(contract, base) {
  const candidates = await listRoleCommitsSince(contract, base);
  const pending = [];
  for (const item of candidates) {
    const integrated = await findIntegratedCommit(
      contract.workspace,
      item.ref,
      contract.targetBranch
    );
    if (!integrated) pending.push(item);
  }
  return pending.reverse();
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
async function pathExists(path15) {
  try {
    await nodeFs.access(path15);
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
  return new Promise((resolve10, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("close", (code) => {
      if (code === 0) resolve10(out);
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
import * as fs2 from "node:fs/promises";
import * as path2 from "node:path";

// src/machine-state.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
function isNotFoundError(err) {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}
function isRetryableRenameError(err) {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = err.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EEXIST";
}
async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, body, "utf8");
    await renameReplace(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
    }
    throw err;
  }
}
async function renameReplace(tmp, filePath) {
  const attempts = process.platform === "win32" ? 8 : 1;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRenameError(err) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 5 + i * 5));
    }
  }
  throw lastErr;
}
async function backupCorruptMachineFile(filePath) {
  const backupPath = `${filePath}.corrupt-${corruptTimestamp()}`;
  try {
    await fs.rename(filePath, backupPath);
    return backupPath;
  } catch {
    await fs.copyFile(filePath, backupPath);
    try {
      await fs.unlink(filePath);
    } catch {
    }
    return backupPath;
  }
}
function warnCorruptMachineState(filePath, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${filePath} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
  );
}
function corruptTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}

// src/runtime/session-registry.ts
function sessionsDir(dataDir) {
  return path2.join(dataDir, "sessions");
}
function sessionFilePath(dataDir, sessionId) {
  return path2.join(sessionsDir(dataDir), `${sessionId}.json`);
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
    await fs2.mkdir(sessionsDir(this.dataDir), { recursive: true });
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
      await writeJsonAtomic(file, record);
    });
  }
  async read(sessionId) {
    assertSessionId(sessionId);
    await this.writeChain;
    return this.readUnlocked(sessionId);
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
      await writeJsonAtomic(file, next);
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
      names = await fs2.readdir(dir);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      if (name.includes(".corrupt-") || name.endsWith(".tmp")) continue;
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
        await fs2.rm(sessionFilePath(this.dataDir, sessionId), { force: true });
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
      const raw = await fs2.readFile(file, "utf8");
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        await this.quarantineCorrupt(file);
        return null;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        await this.quarantineCorrupt(file);
        return null;
      }
      const rec = data;
      if (typeof rec.id !== "string" || typeof rec.state !== "string") {
        await this.quarantineCorrupt(file);
        return null;
      }
      if (rec.id !== sessionId) {
        await this.quarantineCorrupt(file);
        return null;
      }
      return rec;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }
  async quarantineCorrupt(file) {
    try {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "ignored");
    } catch {
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

// src/service/mutation-bus.ts
var MutationBus = class {
  constructor() {
    this.tails = /* @__PURE__ */ new Map();
  }
  async run(workspaceId, action) {
    const prev = this.tails.get(workspaceId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve10) => {
      release = resolve10;
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

// src/service/a2a-store.ts
import * as fs3 from "node:fs/promises";
import * as path3 from "node:path";
var A2AApprovalStore = class {
  constructor(dataDir) {
    this.items = /* @__PURE__ */ new Map();
    this.loaded = false;
    /** Serialize load + mutations + persist (same pattern as ToolApprovalStore). */
    this.chain = Promise.resolve();
    this.file = path3.join(dataDir, "a2a-approvals.json");
  }
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async ensureLoaded() {
    if (this.loaded) return;
    return this.enqueue(async () => {
      if (this.loaded) return;
      try {
        const raw = await fs3.readFile(this.file, "utf8");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          await this.quarantineCorrupt("reset");
          this.loaded = true;
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          await this.quarantineCorrupt("reset");
          this.loaded = true;
          return;
        }
        const items = parsed.items;
        if (items !== void 0 && !Array.isArray(items)) {
          await this.quarantineCorrupt("reset");
          this.loaded = true;
          return;
        }
        for (const item of items ?? []) {
          if (item?.id) this.items.set(item.id, item);
        }
        this.loaded = true;
      } catch (err) {
        if (isNotFoundError(err)) {
          this.loaded = true;
          return;
        }
        throw err;
      }
    });
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
    return this.enqueue(async () => {
      this.items.set(item.id, { ...item });
      await this.persistUnlocked();
      return this.items.get(item.id);
    });
  }
  async resolve(id, decision, resolvedBy) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item) throw new Error(`A2A approval not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`A2A approval already ${item.status}: ${id}`);
      }
      item.status = decision;
      item.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
      item.resolvedBy = resolvedBy;
      this.items.set(id, item);
      await this.persistUnlocked();
      return item;
    });
  }
  async quarantineCorrupt(action) {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, action);
    this.items.clear();
  }
  /** Call only under enqueue after ensureLoaded. */
  async persistUnlocked() {
    const items = [...this.items.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || "")).slice(0, 50);
    await writeJsonAtomic(this.file, { items: [...pending, ...terminal] });
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
  /**
   * Workspace collaboration settings (system-root settings.json).
   * settings is a read projection; settings.update is user-only MutationBus.
   * Successful actual mutation emits exactly one workspace.settings.updated; no-op emits none.
   */
  "workspace.settings",
  "workspace.settings.update",
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
  /**
   * User-only role registry mutations (MutationBus).
   * Persist name/prompt/description/color/a2aPolicy/allowedProfiles/cli only —
   * never provider secrets. Success emits exactly one registry.roles.updated.
   */
  "registry.role.create",
  "registry.role.update",
  "registry.role.delete",
  "profile.list",
  "profile.get",
  "profile.create",
  "profile.update",
  "profile.delete",
  /** Machine-local credential vault (user-only; never returns secret plaintext). */
  "credential.list",
  "credential.set",
  "credential.delete",
  /** Machine-local bundled skill list/install (user surface; no workspaceId). */
  "skill.list",
  "skill.install",
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
  /**
   * Stable box collaboration projection (task-api §2.3).
   * Params: workspaceId + id|path|boxId (same resolver as docs.get).
   * Result: { workspaceId, boxId, status, assignee?, activeTaskId? }.
   */
  "box.projection",
  /** Proposal triage — separate from task delivery review (task-api §3). */
  "proposal.list",
  "proposal.submit",
  "proposal.resolve",
  "session.list",
  "session.get",
  "a2a.listPending",
  "a2a.resolve",
  /** ACP tool permission approvals (permissionPolicy=ask) — distinct from a2a.* spawn gate. */
  "toolApproval.listPending",
  "toolApproval.get",
  "toolApproval.approveOnce",
  "toolApproval.deny",
  /**
   * Operational retention (task-api §6) — user-only.
   * preview is read-only; purge mutates via MutationBus and emits retention.purged only when files deleted.
   */
  "operationalRetention.preview",
  "operationalRetention.purge"
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
import * as fs6 from "node:fs/promises";
import * as path6 from "node:path";

// src/runtime/profile-config.ts
function normalizeProfileToCanonicalAcp(raw) {
  const legacy = raw.grokAcp;
  const hasLegacy = legacy !== void 0 && legacy !== null && typeof legacy === "object";
  const hasAcp = raw.acp !== void 0 && raw.acp !== null && typeof raw.acp === "object";
  const { grokAcp: _drop, ...rest } = raw;
  void _drop;
  if (hasAcp) {
    return {
      profile: { ...rest, acp: { ...raw.acp } },
      migrated: hasLegacy
    };
  }
  if (hasLegacy) {
    return {
      profile: { ...rest, acp: { ...legacy } },
      migrated: true
    };
  }
  return { profile: { ...rest }, migrated: false };
}
function cloneAgentProfileConfig(p) {
  const { profile: canonical } = normalizeProfileToCanonicalAcp(p);
  return {
    ...canonical,
    acp: canonical.acp ? { ...canonical.acp } : void 0,
    fake: canonical.fake ? { ...canonical.fake } : void 0,
    env: canonical.env ? { ...canonical.env } : void 0,
    args: canonical.args ? [...canonical.args] : void 0
  };
}

// src/adapters/fake/index.ts
import * as fs4 from "node:fs";
import * as os from "node:os";
import * as path4 from "node:path";
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
      bootstrapFile = path4.join(
        os.tmpdir(),
        `tent-bootstrap-${plan.sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.txt`
      );
      fs4.writeFileSync(bootstrapFile, plan.bootstrapPrompt, "utf8");
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
import * as fs5 from "node:fs";
import * as os2 from "node:os";
import * as path5 from "node:path";

// src/adapters/acp/client.ts
import { spawn as spawn2 } from "node:child_process";
import * as readline from "node:readline";

// src/adapters/acp/types.ts
var DEFAULT_PROMPT_TIMEOUT_MS = 30 * 6e4;
var DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;

// src/adapters/acp/client.ts
var PERMISSION_FAILSAFE_SLACK_MS = 5e3;
var LOAD_REPLAY_QUIET_MS = 100;
var LOAD_REPLAY_MAX_WAIT_MS = 2e3;
var AcpClient = class {
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
    /** Dedupe spontaneous exit vs prompt-failure / intentional stop terminal events. */
    this.terminalEmitted = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.exitWaiters = [];
    /**
     * Only chunks received while our own session/prompt request is pending belong
     * to the next delivery. Load replay (including notifications arriving after
     * the load response) and unsolicited provider updates stay diagnostic-only.
     */
    this.collectingPromptResponse = false;
    /** Defensive quarantine for bridges that resolve load before their final replay notification. */
    this.quarantiningLoadReplay = false;
    this.lastLoadReplayUpdateAt = 0;
    /** Cached from initialize agentCapabilities.loadSession (default false). */
    this.loadSessionSupported = false;
    this.label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : "ACP";
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
   * Spawn ACP process + initialize/authenticate, then session/new or session/load.
   * Emits session.live when the ACP session exists. Does not block on prompt.
   *
   * Load mode requires agentCapabilities.loadSession === true from this initialize
   * handshake (fail-loud otherwise). History notifications are isolated and never
   * accumulate into assistantText / prompt delivery.
   */
  async connect(options) {
    const mode = options?.mode === "load" ? "load" : "new";
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
      this.loadSessionSupported = init.agentCapabilities?.loadSession === true;
      if (this.options.authenticate) {
        const authParams = await this.options.authenticate(
          init.authMethods ?? []
        );
        const meta = authParams._meta && typeof authParams._meta === "object" && !Array.isArray(authParams._meta) ? { ...authParams._meta, headless: true } : { headless: true };
        await this.request("authenticate", {
          ...authParams,
          _meta: meta
        });
      }
      let providerSessionId;
      if (mode === "load") {
        if (!this.loadSessionSupported) {
          throw new Error(
            `${this.label} does not advertise agentCapabilities.loadSession; cannot session/load`
          );
        }
        const loadId = typeof options?.providerSessionId === "string" ? options.providerSessionId.trim() : "";
        if (!loadId) {
          throw new Error(
            `${this.label} session/load requires providerSessionId (resume token)`
          );
        }
        this.assistantText = "";
        this.quarantiningLoadReplay = true;
        this.lastLoadReplayUpdateAt = Date.now();
        try {
          await this.request(
            "session/load",
            {
              sessionId: loadId,
              cwd: this.options.cwd,
              mcpServers: []
            },
            6e4
          );
          await this.waitForLoadReplayQuiescence();
        } finally {
          this.quarantiningLoadReplay = false;
          this.assistantText = "";
        }
        this.providerSessionId = loadId;
        providerSessionId = loadId;
      } else {
        const session = await this.request(
          "session/new",
          { cwd: this.options.cwd, mcpServers: [] },
          6e4
        );
        if (!session.sessionId) {
          throw new Error(`${this.label} session/new \u672A\u8FD4\u56DE sessionId`);
        }
        this.providerSessionId = session.sessionId;
        providerSessionId = session.sessionId;
      }
      this.options.emit({
        type: "session.live",
        sessionId: this.options.sessionId,
        pid
      });
      return {
        pid,
        providerSessionId,
        loadSessionSupported: this.loadSessionSupported
      };
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
      throw new Error(`${this.label} session \u5C1A\u672A\u5EFA\u7ACB\uFF0C\u65E0\u6CD5 prompt`);
    }
    const pid = this.proc?.pid;
    if (pid == null) {
      throw new Error(`${this.label} \u8FDB\u7A0B\u4E0D\u53EF\u7528`);
    }
    this.assistantText = "";
    this.collectingPromptResponse = true;
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
    } finally {
      this.collectingPromptResponse = false;
    }
  }
  /** Keep process alive after bootstrap for probe/stop (caller owns lifecycle). */
  async stop(reason) {
    void reason;
    if (this.closed && this.stopRequested) return;
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
  /**
   * Emit session.failed once (prompt failure / logical error). Dedupes against
   * spontaneous child-exit terminal emission.
   */
  reportFailed(error) {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.options.emit({
      type: "session.failed",
      sessionId: this.options.sessionId,
      error
    });
  }
  /**
   * Emit session.exited once (clean managed completion path). Dedupes against
   * spontaneous child-exit and reportFailed.
   */
  reportExited(exitCode = 0) {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.options.emit({
      type: "session.exited",
      sessionId: this.options.sessionId,
      exitCode
    });
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
        `\u65E0\u6CD5\u542F\u52A8 ${this.label} \u8FDB\u7A0B: ${this.options.command} ${this.options.args.join(" ")}`
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
          signal ? `${this.label} \u8FDB\u7A0B\u4FE1\u53F7\u9000\u51FA: ${signal}` : `${this.label} \u8FDB\u7A0B\u9000\u51FA code=${code}`
        )
      );
      if (!this.stopRequested && !this.terminalEmitted) {
        this.terminalEmitted = true;
        if (signal && signal !== "SIGTERM" && signal !== "SIGINT" || code !== 0 && code != null) {
          this.options.emit({
            type: "session.failed",
            sessionId: this.options.sessionId,
            error: signal ? `${this.label} spontaneous exit signal:${signal}` : `${this.label} spontaneous exit code=${code}`
          });
        } else {
          this.options.emit({
            type: "session.exited",
            sessionId: this.options.sessionId,
            exitCode: code
          });
        }
      }
      for (const w of this.exitWaiters) w();
      this.exitWaiters = [];
    });
    child.on("error", (err) => {
      this.closed = true;
      this.rejectAllPending(
        new Error(`${this.label} \u8FDB\u7A0B\u9519\u8BEF: ${err.message}`)
      );
      if (!this.stopRequested && !this.terminalEmitted) {
        this.terminalEmitted = true;
        this.options.emit({
          type: "session.failed",
          sessionId: this.options.sessionId,
          error: `${this.label} \u8FDB\u7A0B\u9519\u8BEF: ${err.message}`
        });
      }
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
          message: `Client-side requests are disabled for Tent ${this.label} adapter.`
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
    if (this.quarantiningLoadReplay) {
      this.lastLoadReplayUpdateAt = Date.now();
      return;
    }
    if (!this.collectingPromptResponse) return;
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
  async waitForLoadReplayQuiescence() {
    const deadline = Date.now() + LOAD_REPLAY_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const observed = this.lastLoadReplayUpdateAt;
      await sleep(LOAD_REPLAY_QUIET_MS);
      if (this.lastLoadReplayUpdateAt === observed && Date.now() - observed >= LOAD_REPLAY_QUIET_MS) {
        return;
      }
    }
  }
  async handlePermissionRequest(id, params) {
    const options = params.options ?? [];
    const toolTitle = params.toolCall?.title || params.toolCall?.toolCallId || "tool";
    const toolCallId = typeof params.toolCall?.toolCallId === "string" ? params.toolCall.toolCallId : void 0;
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
        summary: `${this.label} \u8BF7\u6C42\u5DE5\u5177\u6743\u9650: ${toolTitle}\uFF08policy=ask\uFF09`
      });
      try {
        if (this.options.onPermissionAsk) {
          const timeoutMs = this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
          const askInfo = { toolTitle, toolCallId, options };
          let settled = false;
          const askPromise = this.options.onPermissionAsk(askInfo).then((d) => {
            settled = true;
            return d;
          });
          const failSafePromise = sleep(
            timeoutMs + PERMISSION_FAILSAFE_SLACK_MS
          ).then(async () => {
            if (settled) return "deny";
            if (this.options.onPermissionAskFailSafe) {
              try {
                await this.options.onPermissionAskFailSafe(askInfo);
              } catch {
              }
            }
            return "deny";
          });
          decision = await Promise.race([askPromise, failSafePromise]);
        } else {
          decision = "deny";
        }
      } catch {
        decision = "deny";
      }
      if (!this.stopRequested && !this.closed) {
        this.options.emit({
          type: "session.live",
          sessionId: this.options.sessionId,
          pid: this.proc?.pid
        });
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
      return Promise.reject(
        new Error(`${this.label} \u5DF2\u5173\u95ED\uFF0C\u65E0\u6CD5\u8C03\u7528 ${method}`)
      );
    }
    const id = this.nextId++;
    return new Promise((resolve10, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${method} \u8D85\u65F6\uFF08${timeoutMs}ms\uFF09`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve10, reject, timer });
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
    return new Promise((resolve10) => {
      this.exitWaiters.push(resolve10);
    });
  }
  async forceKill() {
    const proc = this.proc;
    const pid = proc?.pid;
    if (!proc || pid == null) return;
    if (process.platform === "win32") {
      await new Promise((resolve10) => {
        const killer = spawn2("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.on("exit", () => resolve10());
        killer.on("error", () => resolve10());
        setTimeout(resolve10, 1500);
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
  return new Promise((resolve10) => setTimeout(resolve10, ms));
}

// src/adapters/acp/managed-session.ts
var DEFAULT_BOOTSTRAP = "Tent session started. Read the task envelope via Tent Task API; do not invent missing content.";
var AcpManagedSession = class {
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
  /** Tests / callers may await bootstrap completion (prompt path finished). */
  async waitBootstrap() {
    await this.bootstrapDone;
  }
  async stop(reason) {
    this.stopRequested = true;
    await this.client.stop(
      reason === "user" || reason === "interrupt" || reason === "shutdown" ? reason : "interrupt"
    );
  }
};
async function stopAcpClientQuiet(client) {
  try {
    await client.stop("interrupt");
  } catch {
  }
}
function bindAcpPermissionHooks(sessionId, permissionPolicy, hooks) {
  const mapInfo = (info) => ({
    sessionId,
    toolTitle: info.toolTitle,
    toolCallId: info.toolCallId,
    options: (info.options ?? []).map((o) => ({
      optionId: o.optionId,
      kind: o.kind,
      name: o.name
    }))
  });
  return {
    onPermissionAsk: permissionPolicy === "ask" ? async (info) => {
      if (!hooks.onPermissionAsk) return "deny";
      return hooks.onPermissionAsk(mapInfo(info));
    } : void 0,
    onPermissionAskFailSafe: permissionPolicy === "ask" && hooks.onPermissionAskFailSafe ? async (info) => {
      await hooks.onPermissionAskFailSafe(mapInfo(info));
    } : void 0
  };
}
function runManagedBootstrapPrompt(plan, emit2, client, bootstrap) {
  return client.sendPrompt(bootstrap).then(async (result) => {
    const stopReason = (result.stopReason || "end_turn").toLowerCase();
    const assistantText = (result.assistantText || "").trim();
    if (stopReason !== "end_turn") {
      client.reportFailed(
        `ACP session/prompt stopReason=${result.stopReason || "unknown"} (no auto-delivery)`
      );
      await stopAcpClientQuiet(client);
      return;
    }
    if (!assistantText) {
      client.reportFailed("ACP assistant response empty (no auto-delivery)");
      await stopAcpClientQuiet(client);
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
      client.reportFailed(`session interrupted: ${message}`);
      await stopAcpClientQuiet(client);
      return;
    }
    client.reportFailed(message);
    await stopAcpClientQuiet(client);
  });
}
async function startManagedAcpSession(input) {
  const { plan, emit: emit2, client } = input;
  const bootstrap = plan.bootstrapPrompt?.trim() || input.defaultBootstrapPrompt?.trim() || DEFAULT_BOOTSTRAP;
  try {
    await client.connect({ mode: "new" });
  } catch (err) {
    await stopAcpClientQuiet(client);
    throw err;
  }
  const promptDone = runManagedBootstrapPrompt(plan, emit2, client, bootstrap);
  return new AcpManagedSession(plan.sessionId, client, promptDone);
}
async function resumeManagedAcpSession(input) {
  const { plan, emit: emit2, client, providerSessionId } = input;
  const loadId = providerSessionId.trim();
  if (!loadId) {
    throw new Error("resumeManagedAcpSession requires non-empty providerSessionId");
  }
  try {
    await client.connect({ mode: "load", providerSessionId: loadId });
  } catch (err) {
    await stopAcpClientQuiet(client);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message);
  }
  const bootstrap = input.bootstrapPrompt?.trim() || plan.bootstrapPrompt?.trim() || "";
  const promptDone = bootstrap ? runManagedBootstrapPrompt(plan, emit2, client, bootstrap) : Promise.resolve();
  return new AcpManagedSession(plan.sessionId, client, promptDone);
}
function parseAcpResumeToken(raw) {
  return { raw, providerSessionId: raw };
}
function loadSessionAcpCapabilities(authModel = "external-app") {
  return {
    canSpawn: true,
    canResume: true,
    canStopGraceful: true,
    needsTty: false,
    supportsWorktreeCwd: true,
    authModel,
    observeLevel: "structured"
  };
}
function mapAcpProcessExit(code, signal) {
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
function mainstreamAcpCapabilities() {
  return {
    canSpawn: true,
    canResume: false,
    canStopGraceful: true,
    needsTty: false,
    supportsWorktreeCwd: true,
    authModel: "external-app",
    observeLevel: "structured"
  };
}

// src/adapters/acp/profile.ts
function readAcpExtras(extras, legacyKeys = []) {
  if (!extras || typeof extras !== "object") return {};
  if (extras.acp !== void 0) return extras.acp;
  for (const key of legacyKeys) {
    if (extras[key] !== void 0) return extras[key];
  }
  return {};
}
function normalizeAcpPermissionPolicy(raw) {
  return raw === "allow" || raw === "ask" || raw === "deny" ? raw : "deny";
}
function normalizeSharedAcpOpts(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    executable: typeof o.executable === "string" && o.executable.trim() ? o.executable.trim() : void 0,
    model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : void 0,
    envKey: typeof o.envKey === "string" && o.envKey.trim() ? o.envKey.trim() : void 0,
    credentialRef: typeof o.credentialRef === "string" && o.credentialRef.trim() ? o.credentialRef.trim() : void 0,
    baseUrlEnvKey: typeof o.baseUrlEnvKey === "string" && o.baseUrlEnvKey.trim() ? o.baseUrlEnvKey.trim() : void 0,
    baseUrl: typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl.trim() : void 0,
    promptTimeoutMs: typeof o.promptTimeoutMs === "number" && o.promptTimeoutMs > 0 ? o.promptTimeoutMs : DEFAULT_PROMPT_TIMEOUT_MS,
    permissionPolicy: normalizeAcpPermissionPolicy(o.permissionPolicy),
    permissionTimeoutMs: typeof o.permissionTimeoutMs === "number" && o.permissionTimeoutMs > 0 ? o.permissionTimeoutMs : DEFAULT_PERMISSION_TIMEOUT_MS
  };
}
function resolvePlanOrProcessEnv(envKey, planEnv, resolve10) {
  if (resolve10) return resolve10(envKey, planEnv);
  const fromPlan = planEnv[envKey];
  if (typeof fromPlan === "string" && fromPlan.trim()) return fromPlan;
  const fromProc = process.env[envKey];
  if (typeof fromProc === "string" && fromProc.trim()) return fromProc;
  return void 0;
}
function defaultNpxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
function resolveNpxAcpLaunch(input) {
  const defaultArgs = ["--yes", input.defaultPackage];
  const command = (typeof input.planCommand === "string" && input.planCommand.trim() ? input.planCommand.trim() : void 0) || input.executable || defaultNpxCommand();
  const usingDefaultLauncher = !(typeof input.planCommand === "string" && input.planCommand.trim()) && !input.executable;
  const args = input.planArgs && input.planArgs.length > 0 ? [...input.planArgs] : usingDefaultLauncher ? [...defaultArgs] : [];
  return { command, args };
}

// src/adapters/grok-acp/client.ts
var GrokAcpClient = class {
  constructor(options) {
    void options.model;
    const acpOptions = {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      sessionId: options.sessionId,
      promptTimeoutMs: options.promptTimeoutMs,
      permissionPolicy: options.permissionPolicy,
      permissionTimeoutMs: options.permissionTimeoutMs,
      label: "Grok ACP",
      emit: options.emit,
      onPermissionAsk: options.onPermissionAsk,
      onPermissionAskFailSafe: options.onPermissionAskFailSafe,
      authenticate: async (authMethods) => {
        const ids = new Set(authMethods.map((m) => m.id));
        const methodId = ids.has("xai.api_key") ? "xai.api_key" : ids.has("cached_token") ? "cached_token" : null;
        if (!methodId) {
          throw new Error(
            "Grok ACP \u672A\u63D0\u4F9B\u53EF\u7528\u7684\u8BA4\u8BC1\u65B9\u5F0F\uFF08\u9700\u8981 xai.api_key \u6216 cached_token\uFF09\u3002\u8BF7\u786E\u8BA4 grok CLI \u4E0E CPA \u914D\u7F6E\u3002"
          );
        }
        return { methodId };
      }
    };
    this.inner = new AcpClient(acpOptions);
  }
  get pid() {
    return this.inner.pid;
  }
  get providerSession() {
    return this.inner.providerSession;
  }
  get lastAssistantText() {
    return this.inner.lastAssistantText;
  }
  get lastStderrTail() {
    return this.inner.lastStderrTail;
  }
  isAlive() {
    return this.inner.isAlive();
  }
  connect(options) {
    return this.inner.connect(options);
  }
  sendPrompt(bootstrapPrompt) {
    return this.inner.sendPrompt(bootstrapPrompt);
  }
  stop(reason) {
    return this.inner.stop(reason);
  }
  reportFailed(error) {
    this.inner.reportFailed(error);
  }
  reportExited(exitCode) {
    this.inner.reportExited(exitCode);
  }
};

// src/adapters/grok-acp/types.ts
var GROK_ACP_ADAPTER_ID = "grok-acp";
var DEFAULT_GROK_MODEL = "grok-4.5";
var DEFAULT_GROK_ENV_KEY = "CPA_GROK_API_KEY";
var DEFAULT_GROK_BASE_URL_ENV_KEY = "CPA_GROK_BASE_URL";

// src/adapters/grok-acp/index.ts
function defaultGrokExecutable() {
  if (process.platform === "win32") {
    const home2 = process.env.USERPROFILE || os2.homedir();
    return path5.join(home2, ".grok", "bin", "grok.exe");
  }
  const home = process.env.HOME || os2.homedir();
  return path5.join(home, ".grok", "bin", "grok");
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
var GrokAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = GROK_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.grokAcp.displayName";
    this.resolveApiKey = options.resolveApiKey ?? ((envKey, planEnv) => planEnv[envKey] ?? process.env[envKey]);
    this.resolveBaseUrl = options.resolveBaseUrl ?? ((baseUrlEnvKey, planEnv, profileBaseUrl) => normalizeCpaBaseUrl(
      planEnv[baseUrlEnvKey] ?? process.env[baseUrlEnvKey] ?? profileBaseUrl
    ));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
  }
  capabilities() {
    return loadSessionAcpCapabilities("env");
  }
  /**
   * Launch plan validation only. Real ACP needs bidirectional stdio —
   * AgentRuntime uses startManagedSession instead of ProcessSupervisor.
   */
  resolveLaunch(plan) {
    const opts = normalizeGrokOpts(readAcpExtras(plan.extras, ["grokAcp"]));
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
      if (!fs5.existsSync(opts.executable)) {
        throw new Error(
          `Grok \u53EF\u6267\u884C\u6587\u4EF6\u4E0D\u5B58\u5728: ${opts.executable}\u3002\u8BF7\u5728 machine-local AgentProfile.acp.executable \u4E2D\u914D\u7F6E\u6B63\u786E\u8DEF\u5F84\u3002`
        );
      }
    } else if (!plan.command) {
      if (!fs5.existsSync(command)) {
        throw new Error(
          `\u672A\u627E\u5230 Grok \u53EF\u6267\u884C\u6587\u4EF6: ${command}\u3002\u8BF7\u5B89\u88C5 grok CLI \u6216\u5728 AgentProfile \u4E2D\u8BBE\u7F6E acp.executable\u3002`
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
      env.GROK_HOME = path5.join(home, ".grok");
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
    const client = this.createClient(plan, emit2);
    return startManagedAcpSession({ plan, emit: emit2, client });
  }
  /**
   * Native ACP resume: new bridge process + session/load (never session/new).
   * Requires agentCapabilities.loadSession on the live initialize handshake.
   */
  async resumeManagedSession(plan, token, emit2) {
    const providerSessionId = (token.providerSessionId ?? token.raw).trim();
    if (!providerSessionId) {
      throw new Error("grok-acp resume requires non-empty provider session id");
    }
    const client = this.createClient(plan, emit2);
    return resumeManagedAcpSession({
      plan,
      emit: emit2,
      client,
      providerSessionId,
      bootstrapPrompt: plan.bootstrapPrompt
    });
  }
  createClient(plan, emit2) {
    const opts = normalizeGrokOpts(readAcpExtras(plan.extras, ["grokAcp"]));
    const launch = this.resolveLaunch(plan);
    const permHooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe
    });
    return new GrokAcpClient({
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
      onPermissionAsk: permHooks.onPermissionAsk,
      onPermissionAskFailSafe: permHooks.onPermissionAskFailSafe
    });
  }
  parseResumeToken(raw) {
    return parseAcpResumeToken(raw);
  }
  mapExit(code, signal) {
    return mapAcpProcessExit(code, signal);
  }
};
function createGrokAcpAdapter(options) {
  return new GrokAcpProviderAdapter(options);
}

// src/adapters/codex-acp/types.ts
var CODEX_ACP_ADAPTER_ID = "codex-acp";
var CODEX_ACP_NPX_PACKAGE = "@agentclientprotocol/codex-acp";
var CODEX_DEFAULT_AUTH_REQUEST_ENV = "DEFAULT_AUTH_REQUEST";

// src/adapters/codex-acp/index.ts
function buildCodexDefaultAuthRequest(apiKey) {
  return JSON.stringify({
    methodId: "api-key",
    _meta: {
      "api-key": {
        apiKey
      }
    }
  });
}
var CodexAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = CODEX_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.codexAcp.displayName";
    this.resolveEnvValue = options.resolveEnvValue ?? ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
  }
  capabilities() {
    return mainstreamAcpCapabilities();
  }
  /**
   * Launch plan validation / env injection only.
   * Real ACP needs bidirectional stdio — AgentRuntime uses startManagedSession.
   * Does not call ACP authenticate; injects DEFAULT_AUTH_REQUEST when envKey is set.
   */
  resolveLaunch(plan) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const { command, args } = resolveNpxAcpLaunch({
      planCommand: plan.command,
      planArgs: plan.args,
      executable: opts.executable,
      defaultPackage: CODEX_ACP_NPX_PACKAGE
    });
    const env = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (opts.envKey) {
      const secret = this.resolveEnvValue(opts.envKey, plan.env);
      if (!secret || !secret.trim()) {
        throw new Error(
          `\u672A\u914D\u7F6E\u73AF\u5883\u53D8\u91CF ${opts.envKey}\uFF1Acodex-acp \u5DF2\u5728 AgentProfile.acp.envKey \u4E2D\u660E\u786E\u8981\u6C42\u8BE5\u5BC6\u94A5\uFF08\u4EC5 service \u8FDB\u7A0B / LaunchPlan.env\uFF09\u3002\u8BF7\u8BBE\u7F6E ${opts.envKey} \u540E\u91CD\u8BD5\uFF1B\u5207\u52FF\u628A secret \u5199\u5165 workspace/box/task\u3002`
        );
      }
      env[opts.envKey] = secret;
      env[CODEX_DEFAULT_AUTH_REQUEST_ENV] = buildCodexDefaultAuthRequest(secret);
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
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const permHooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe
    });
    const client = new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      label: "Codex ACP",
      emit: emit2,
      onPermissionAsk: permHooks.onPermissionAsk,
      onPermissionAskFailSafe: permHooks.onPermissionAskFailSafe
    });
    return startManagedAcpSession({ plan, emit: emit2, client });
  }
  parseResumeToken(raw) {
    return parseAcpResumeToken(raw);
  }
  mapExit(code, signal) {
    return mapAcpProcessExit(code, signal);
  }
};
function createCodexAcpAdapter(options) {
  return new CodexAcpProviderAdapter(options);
}

// src/adapters/claude-acp/types.ts
var CLAUDE_ACP_ADAPTER_ID = "claude-acp";
var CLAUDE_ACP_NPX_PACKAGE = "@agentclientprotocol/claude-agent-acp";

// src/adapters/claude-acp/index.ts
var ClaudeAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = CLAUDE_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.claudeAcp.displayName";
    this.resolveEnvValue = options.resolveEnvValue ?? ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
  }
  capabilities() {
    return mainstreamAcpCapabilities();
  }
  /**
   * Launch plan validation / optional env injection only.
   * Real ACP needs bidirectional stdio — AgentRuntime uses startManagedSession.
   * Does not call ACP authenticate; depends on local Claude login or injected env.
   */
  resolveLaunch(plan) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const { command, args } = resolveNpxAcpLaunch({
      planCommand: plan.command,
      planArgs: plan.args,
      executable: opts.executable,
      defaultPackage: CLAUDE_ACP_NPX_PACKAGE
    });
    const env = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (opts.envKey) {
      const secret = this.resolveEnvValue(opts.envKey, plan.env);
      if (!secret || !secret.trim()) {
        throw new Error(
          `\u672A\u914D\u7F6E\u73AF\u5883\u53D8\u91CF ${opts.envKey}\uFF1Aclaude-acp \u5DF2\u5728 AgentProfile.acp.envKey \u4E2D\u660E\u786E\u8981\u6C42\u8BE5\u5BC6\u94A5\uFF08\u4EC5 service \u8FDB\u7A0B / LaunchPlan.env\uFF09\u3002\u8BF7\u8BBE\u7F6E ${opts.envKey} \u540E\u91CD\u8BD5\uFF1B\u5207\u52FF\u628A secret \u5199\u5165 workspace/box/task\u3002`
        );
      }
      env[opts.envKey] = secret;
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
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const permHooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe
    });
    const client = new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      label: "Claude ACP",
      emit: emit2,
      onPermissionAsk: permHooks.onPermissionAsk,
      onPermissionAskFailSafe: permHooks.onPermissionAskFailSafe
    });
    return startManagedAcpSession({ plan, emit: emit2, client });
  }
  parseResumeToken(raw) {
    return parseAcpResumeToken(raw);
  }
  mapExit(code, signal) {
    return mapAcpProcessExit(code, signal);
  }
};
function createClaudeAcpAdapter(options) {
  return new ClaudeAcpProviderAdapter(options);
}

// src/adapters/antigravity-acp/types.ts
var ANTIGRAVITY_ACP_ADAPTER_ID = "antigravity-acp";
var ANTIGRAVITY_ACP_BRIDGE = "agy-acp";

// src/adapters/antigravity-acp/index.ts
function defaultAntigravityAcpExecutable() {
  return process.platform === "win32" ? "agy-acp.exe" : ANTIGRAVITY_ACP_BRIDGE;
}
var AntigravityAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = ANTIGRAVITY_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.antigravityAcp.displayName";
    this.resolveEnvValue = options.resolveEnvValue ?? ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
  }
  capabilities() {
    return mainstreamAcpCapabilities();
  }
  resolveLaunch(plan) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const env = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (opts.envKey) {
      const value = this.resolveEnvValue(opts.envKey, plan.env);
      if (!value?.trim()) {
        throw new Error(
          `\u672A\u914D\u7F6E\u73AF\u5883\u53D8\u91CF ${opts.envKey}\uFF1Aantigravity-acp profile \u660E\u786E\u8981\u6C42\u8BE5\u503C\u3002Tent \u901A\u8FC7\u7B2C\u4E09\u65B9 agy-acp bridge \u8FDE\u63A5\u5B98\u65B9 agy CLI\uFF1Bsecret \u53EA\u80FD\u653E\u5728 service \u8FDB\u7A0B\u73AF\u5883\u3002`
        );
      }
      env[opts.envKey] = value;
    }
    return {
      command: plan.command?.trim() || opts.executable || defaultAntigravityAcpExecutable(),
      args: plan.args ? [...plan.args] : [],
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM"
    };
  }
  async startManagedSession(plan, emit2) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const hooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe
    });
    const client = new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      label: "Antigravity ACP (third-party agy-acp bridge)",
      emit: emit2,
      onPermissionAsk: hooks.onPermissionAsk,
      onPermissionAskFailSafe: hooks.onPermissionAskFailSafe
    });
    return startManagedAcpSession({ plan, emit: emit2, client });
  }
  parseResumeToken(raw) {
    return parseAcpResumeToken(raw);
  }
  mapExit(code, signal) {
    return mapAcpProcessExit(code, signal);
  }
};
function createAntigravityAcpAdapter(options) {
  return new AntigravityAcpProviderAdapter(options);
}

// src/adapters/opencode-acp/types.ts
var OPENCODE_ACP_ADAPTER_ID = "opencode-acp";

// src/adapters/opencode-acp/index.ts
function defaultOpenCodeExecutable() {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}
var OpenCodeAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = OPENCODE_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.openCodeAcp.displayName";
    this.resolveEnvValue = options.resolveEnvValue ?? ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
  }
  capabilities() {
    return loadSessionAcpCapabilities("external-app");
  }
  resolveLaunch(plan) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const env = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (opts.envKey) {
      const value = this.resolveEnvValue(opts.envKey, plan.env);
      if (!value?.trim()) {
        throw new Error(
          `\u672A\u914D\u7F6E\u73AF\u5883\u53D8\u91CF ${opts.envKey}\uFF1Aopencode-acp profile \u660E\u786E\u8981\u6C42\u8BE5\u503C\uFF08\u4EC5 service \u8FDB\u7A0B / LaunchPlan.env\uFF09\u3002`
        );
      }
      env[opts.envKey] = value;
    }
    return {
      command: plan.command?.trim() || opts.executable || defaultOpenCodeExecutable(),
      args: plan.args ? [...plan.args] : ["acp"],
      cwd: plan.cwd,
      env,
      stopSignal: "SIGTERM"
    };
  }
  async startManagedSession(plan, emit2) {
    const client = this.createClient(plan, emit2);
    return startManagedAcpSession({ plan, emit: emit2, client });
  }
  /**
   * Native ACP resume: new bridge process + session/load (never session/new).
   * Requires agentCapabilities.loadSession on the live initialize handshake.
   */
  async resumeManagedSession(plan, token, emit2) {
    const providerSessionId = (token.providerSessionId ?? token.raw).trim();
    if (!providerSessionId) {
      throw new Error(
        "opencode-acp resume requires non-empty provider session id"
      );
    }
    const client = this.createClient(plan, emit2);
    return resumeManagedAcpSession({
      plan,
      emit: emit2,
      client,
      providerSessionId,
      bootstrapPrompt: plan.bootstrapPrompt
    });
  }
  createClient(plan, emit2) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const hooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe
    });
    return new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      label: "OpenCode ACP",
      emit: emit2,
      onPermissionAsk: hooks.onPermissionAsk,
      onPermissionAskFailSafe: hooks.onPermissionAskFailSafe
    });
  }
  parseResumeToken(raw) {
    return parseAcpResumeToken(raw);
  }
  mapExit(code, signal) {
    return mapAcpProcessExit(code, signal);
  }
};
function createOpenCodeAcpAdapter(options) {
  return new OpenCodeAcpProviderAdapter(options);
}

// src/adapters/copilot-acp/types.ts
var COPILOT_ACP_ADAPTER_ID = "copilot-acp";
var COPILOT_ACP_NPX_PACKAGE = "@github/copilot";

// src/adapters/copilot-acp/index.ts
var CopilotAcpProviderAdapter = class {
  constructor(options = {}) {
    this.id = COPILOT_ACP_ADAPTER_ID;
    this.displayNameKey = "adapter.copilotAcp.displayName";
    this.resolveEnvValue = options.resolveEnvValue ?? ((envKey, planEnv) => resolvePlanOrProcessEnv(envKey, planEnv));
    this.onPermissionAsk = options.onPermissionAsk;
    this.onPermissionAskFailSafe = options.onPermissionAskFailSafe;
  }
  capabilities() {
    return mainstreamAcpCapabilities();
  }
  resolveLaunch(plan) {
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const hasCommandOverride = !!plan.command?.trim();
    const command = plan.command?.trim() || opts.executable || defaultNpxCommand();
    const defaultArgs = opts.executable ? ["--acp", "--stdio"] : ["--yes", COPILOT_ACP_NPX_PACKAGE, "--acp", "--stdio"];
    if (opts.model) defaultArgs.push("--model", opts.model);
    const args = plan.args ? [...plan.args] : hasCommandOverride ? [] : defaultArgs;
    const env = {
      ...plan.env,
      TENT_SESSION_ID: plan.sessionId,
      TENT_PROFILE_ID: plan.profileId
    };
    if (plan.roleName) env.TENT_ROLE_NAME = plan.roleName;
    if (opts.envKey) {
      const value = this.resolveEnvValue(opts.envKey, plan.env);
      if (!value?.trim()) {
        throw new Error(
          `\u672A\u914D\u7F6E\u73AF\u5883\u53D8\u91CF ${opts.envKey}\uFF1Acopilot-acp profile \u660E\u786E\u8981\u6C42\u8BE5\u503C\uFF08\u4EC5 service \u8FDB\u7A0B / LaunchPlan.env\uFF09\u3002\u7701\u7565 envKey \u53EF\u590D\u7528\u672C\u673A Copilot \u767B\u5F55\u3002`
        );
      }
      env[opts.envKey] = value;
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
    const opts = normalizeSharedAcpOpts(readAcpExtras(plan.extras));
    const launch = this.resolveLaunch(plan);
    const hooks = bindAcpPermissionHooks(plan.sessionId, opts.permissionPolicy, {
      onPermissionAsk: this.onPermissionAsk,
      onPermissionAskFailSafe: this.onPermissionAskFailSafe
    });
    const client = new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      sessionId: plan.sessionId,
      promptTimeoutMs: opts.promptTimeoutMs,
      permissionPolicy: opts.permissionPolicy,
      permissionTimeoutMs: opts.permissionTimeoutMs,
      label: "GitHub Copilot ACP",
      emit: emit2,
      onPermissionAsk: hooks.onPermissionAsk,
      onPermissionAskFailSafe: hooks.onPermissionAskFailSafe
    });
    return startManagedAcpSession({ plan, emit: emit2, client });
  }
  parseResumeToken(raw) {
    return parseAcpResumeToken(raw);
  }
  mapExit(code, signal) {
    return mapAcpProcessExit(code, signal);
  }
};
function createCopilotAcpAdapter(options) {
  return new CopilotAcpProviderAdapter(options);
}

// src/service/profiles.ts
var FAKE_DEFAULT_PROFILE_ID = "fake-default";
var GROK_ACP_DEFAULT_PROFILE_ID = "grok-acp-default";
var CODEX_ACP_DEFAULT_PROFILE_ID = "codex-acp-default";
var CLAUDE_ACP_DEFAULT_PROFILE_ID = "claude-acp-default";
var ANTIGRAVITY_ACP_DEFAULT_PROFILE_ID = "antigravity-acp-default";
var OPENCODE_ACP_DEFAULT_PROFILE_ID = "opencode-acp-default";
var COPILOT_ACP_DEFAULT_PROFILE_ID = "copilot-acp-default";
var PRODUCT_ACP_ADAPTER_IDS = [
  "grok-acp",
  "codex-acp",
  "claude-acp",
  "antigravity-acp",
  "opencode-acp",
  "copilot-acp"
];
var PRODUCT_ACP_ADAPTER_SET = new Set(PRODUCT_ACP_ADAPTER_IDS);
function isProductAcpAdapterId(id) {
  return PRODUCT_ACP_ADAPTER_SET.has(id);
}
var BUILTIN_DEFAULT_PROFILE_IDS = /* @__PURE__ */ new Set([
  FAKE_DEFAULT_PROFILE_ID,
  GROK_ACP_DEFAULT_PROFILE_ID,
  CODEX_ACP_DEFAULT_PROFILE_ID,
  CLAUDE_ACP_DEFAULT_PROFILE_ID,
  ANTIGRAVITY_ACP_DEFAULT_PROFILE_ID,
  OPENCODE_ACP_DEFAULT_PROFILE_ID,
  COPILOT_ACP_DEFAULT_PROFILE_ID
]);
function isBuiltinDefaultProfileId(id) {
  return BUILTIN_DEFAULT_PROFILE_IDS.has(id);
}
var PROFILE_CREATE_FIELDS = [
  "id",
  "adapterId",
  "displayName",
  "model",
  "executable",
  "envKey",
  "credentialRef",
  "baseUrlEnvKey",
  "baseUrl",
  "permissionPolicy",
  "promptTimeoutMs",
  "permissionTimeoutMs"
];
var PROFILE_UPDATE_FIELDS = [
  "displayName",
  "model",
  "executable",
  "envKey",
  "credentialRef",
  "baseUrlEnvKey",
  "baseUrl",
  "permissionPolicy",
  "promptTimeoutMs",
  "permissionTimeoutMs"
];
function profilesPath(dataDir) {
  return path6.join(dataDir, "agent-profiles.json");
}
async function loadAgentProfilesWithMigration(dataDir) {
  const file = profilesPath(dataDir);
  try {
    const raw = await fs6.readFile(file, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return { profiles: [], migrated: false };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return { profiles: [], migrated: false };
    }
    const profiles = parsed.profiles;
    if (profiles !== void 0 && !Array.isArray(profiles)) {
      const backupPath = await backupCorruptMachineFile(file);
      warnCorruptMachineState(file, backupPath, "reset");
      return { profiles: [], migrated: false };
    }
    const list = Array.isArray(profiles) ? profiles : [];
    let migrated = false;
    const out = [];
    for (const p of list) {
      if (!p || typeof p.id !== "string" || typeof p.adapterId !== "string") continue;
      const n = normalizeProfileToCanonicalAcp(p);
      if (n.migrated) migrated = true;
      out.push(n.profile);
    }
    return { profiles: out, migrated };
  } catch (err) {
    if (isNotFoundError(err)) return { profiles: [], migrated: false };
    throw err;
  }
}
async function saveAgentProfiles(dataDir, profiles) {
  const canonical = profiles.map((p) => {
    const { profile } = normalizeProfileToCanonicalAcp(p);
    return profile;
  });
  await writeJsonAtomic(profilesPath(dataDir), { profiles: canonical });
}
function defaultAgentProfiles() {
  return [
    {
      id: FAKE_DEFAULT_PROFILE_ID,
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.default",
      fake: { waitForSignal: true, emitStdout: true, canResume: true }
    },
    {
      id: GROK_ACP_DEFAULT_PROFILE_ID,
      adapterId: GROK_ACP_ADAPTER_ID,
      displayNameKey: "profile.grokAcp.default",
      acp: {
        // executable omitted → %USERPROFILE%\.grok\bin\grok.exe (or ~/.grok/bin/grok)
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        // CPA base URL from process env (name only here). Optional machine-local baseUrl field.
        baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
        // Default deny tool permissions — never unconditional yolo.
        permissionPolicy: "deny"
      }
    },
    {
      id: CODEX_ACP_DEFAULT_PROFILE_ID,
      adapterId: CODEX_ACP_ADAPTER_ID,
      displayNameKey: "profile.codexAcp.default",
      acp: { permissionPolicy: "deny" }
    },
    {
      id: CLAUDE_ACP_DEFAULT_PROFILE_ID,
      adapterId: CLAUDE_ACP_ADAPTER_ID,
      displayNameKey: "profile.claudeAcp.default",
      acp: { permissionPolicy: "deny" }
    },
    {
      id: ANTIGRAVITY_ACP_DEFAULT_PROFILE_ID,
      adapterId: ANTIGRAVITY_ACP_ADAPTER_ID,
      displayNameKey: "profile.antigravityAcp.default",
      acp: { permissionPolicy: "deny" }
    },
    {
      id: OPENCODE_ACP_DEFAULT_PROFILE_ID,
      adapterId: OPENCODE_ACP_ADAPTER_ID,
      displayNameKey: "profile.openCodeAcp.default",
      acp: { permissionPolicy: "deny" }
    },
    {
      id: COPILOT_ACP_DEFAULT_PROFILE_ID,
      adapterId: COPILOT_ACP_ADAPTER_ID,
      displayNameKey: "profile.copilotAcp.default",
      acp: { permissionPolicy: "deny" }
    }
  ];
}
async function ensureDefaultProfiles(dataDir) {
  const loaded = await loadAgentProfilesWithMigration(dataDir);
  const existing = loaded.profiles;
  if (existing.length > 0) {
    let changed = loaded.migrated;
    let next = existing;
    for (const builtIn of defaultAgentProfiles()) {
      if (!next.some((p) => p.id === builtIn.id)) {
        next = [...next, builtIn];
        changed = true;
      }
    }
    next = next.map((p) => {
      if (p.adapterId !== GROK_ACP_ADAPTER_ID) return p;
      if (p.acp?.baseUrlEnvKey) return p;
      changed = true;
      return {
        ...p,
        acp: {
          ...p.acp ?? {},
          baseUrlEnvKey: p.acp?.baseUrlEnvKey ?? DEFAULT_GROK_BASE_URL_ENV_KEY
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
  "profile.grokAcp.default": "Grok ACP",
  "profile.codexAcp.default": "Codex ACP",
  "profile.claudeAcp.default": "Claude Agent ACP",
  "profile.antigravityAcp.default": "Antigravity ACP\uFF08agy-acp bridge\uFF09",
  "profile.openCodeAcp.default": "OpenCode ACP",
  "profile.copilotAcp.default": "GitHub Copilot ACP"
};
function projectAgentProfile(profile, opts) {
  const testOnly = isTestOnlyProfile(profile);
  const displayName = (typeof profile.displayName === "string" && profile.displayName.trim() ? profile.displayName.trim() : void 0) || profile.displayNameKey && DISPLAY_NAME_BY_KEY[profile.displayNameKey] || profile.id;
  const canonical = cloneAgentProfileConfig(profile);
  const g = canonical.acp;
  const credentialRef = typeof g?.credentialRef === "string" && g.credentialRef.trim() ? g.credentialRef.trim() : void 0;
  return {
    id: profile.id,
    adapterId: profile.adapterId,
    displayName,
    displayNameKey: profile.displayNameKey,
    model: g?.model,
    executable: g?.executable,
    envKey: g?.envKey,
    credentialRef,
    ...credentialRef !== void 0 && opts?.credentialExists !== void 0 ? { credentialExists: opts.credentialExists } : {},
    baseUrlEnvKey: g?.baseUrlEnvKey,
    baseUrl: g?.baseUrl,
    testOnly,
    permissionPolicy: g?.permissionPolicy,
    promptTimeoutMs: g?.promptTimeoutMs,
    permissionTimeoutMs: g?.permissionTimeoutMs
  };
}
function projectAgentProfiles(profiles, opts) {
  const existsMap = opts?.credentialExistsById;
  const lookup = (ref) => {
    if (!ref || !existsMap) return void 0;
    if (existsMap instanceof Map) return existsMap.get(ref);
    return existsMap[ref];
  };
  return profiles.map((p) => {
    const ref = p.acp?.credentialRef;
    const exists = typeof ref === "string" ? lookup(ref.trim()) : void 0;
    return projectAgentProfile(p, exists === void 0 ? void 0 : { credentialExists: exists });
  }).sort((a, b) => {
    if (a.testOnly !== b.testOnly) return a.testOnly ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

// src/service/rpc-error.ts
var RpcError = class extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
};

// src/machine/skills.ts
import * as fs7 from "node:fs/promises";
import * as os3 from "node:os";
import * as path7 from "node:path";
var SKILL_TARGET_IDS = ["shared-agents", "claude"];
var SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function isSkillTargetId(value) {
  return SKILL_TARGET_IDS.includes(value);
}
function skillTargetDir(target, home) {
  const root = home ?? os3.homedir();
  switch (target) {
    case "claude":
      return path7.join(root, ".claude", "skills");
    case "shared-agents":
      return path7.join(root, ".agents", "skills");
    default: {
      const _exhaustive = target;
      throw new Error(`Unknown skill target: ${String(_exhaustive)}`);
    }
  }
}
function assertSafeSkillName(name) {
  const trimmed = name.trim();
  if (!trimmed || !SAFE_SKILL_NAME.test(trimmed) || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || path7.basename(trimmed) !== trimmed) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return trimmed;
}
function parseSkillTargetId(value) {
  const trimmed = value.trim();
  if (!isSkillTargetId(trimmed)) {
    throw new Error(
      `Unknown skill target: ${value} (allowed: ${SKILL_TARGET_IDS.join(", ")})`
    );
  }
  return trimmed;
}
function bundledSkillsDir(packageRoot) {
  return path7.join(packageRoot, "skills");
}
async function listBundledSkillNames(packageRoot) {
  const sourceDir = bundledSkillsDir(packageRoot);
  let entries;
  try {
    entries = await fs7.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") {
      throw new Error(`No installable skills found in ${sourceDir}`);
    }
    throw err;
  }
  const skillNames = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!SAFE_SKILL_NAME.test(entry.name)) continue;
    if (await existsPath(path7.join(sourceDir, entry.name, "SKILL.md"))) {
      skillNames.push(entry.name);
    }
  }
  skillNames.sort();
  return skillNames;
}
async function listSkills(options) {
  const home = options.home ?? os3.homedir();
  const names = await listBundledSkillNames(options.packageRoot);
  const skills = [];
  for (const name of names) {
    const targets = [];
    for (const target of SKILL_TARGET_IDS) {
      const dir = skillTargetDir(target, home);
      const skillPath = path7.join(dir, name);
      assertChildPath(dir, skillPath);
      targets.push({
        target,
        path: skillPath,
        installed: await existsPath(skillPath)
      });
    }
    skills.push({ name, targets });
  }
  return { skills };
}
async function installSkills(options) {
  const home = options.home ?? os3.homedir();
  const force = options.force === true;
  const sourceDir = bundledSkillsDir(options.packageRoot);
  const allNames = await listBundledSkillNames(options.packageRoot);
  if (allNames.length === 0) {
    throw new Error(`No installable skills found in ${sourceDir}`);
  }
  const selectedNames = resolveSkillSelection(options.skills, allNames);
  const destinations = resolveInstallDestinations(options, home);
  if (destinations.length === 0) {
    throw new Error("skill-install requires at least one target directory");
  }
  const results = [];
  for (const dest of destinations) {
    await fs7.mkdir(dest.dir, { recursive: true });
    for (const name of selectedNames) {
      const source = path7.join(sourceDir, name);
      const target = path7.join(dest.dir, name);
      assertChildPath(sourceDir, source);
      assertChildPath(dest.dir, target);
      const exists = await existsPath(target);
      if (exists && !force) {
        results.push({
          targetDir: dest.dir,
          ...dest.target ? { target: dest.target } : {},
          skill: name,
          status: "skipped",
          reason: "already exists (use --force to overwrite)"
        });
        continue;
      }
      if (exists && force) {
        await fs7.rm(target, { recursive: true, force: true });
      }
      await fs7.cp(source, target, { recursive: true, errorOnExist: true });
      results.push({
        targetDir: dest.dir,
        ...dest.target ? { target: dest.target } : {},
        skill: name,
        status: "installed"
      });
    }
  }
  return results;
}
function resolveSkillSelection(requested, allNames) {
  if (!requested || requested.length === 0) return [...allNames];
  const known = new Set(allNames);
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of requested) {
    const name = assertSafeSkillName(raw);
    if (!known.has(name)) {
      throw new Error(`Unknown bundled skill: ${name}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(name);
  }
  selected.sort();
  return selected;
}
function resolveInstallDestinations(options, home) {
  if (options.targetDirs !== void 0) {
    if (options.targetDirs.length === 0) {
      throw new Error("skill-install requires at least one target directory");
    }
    return options.targetDirs.map((dir) => ({ dir: path7.resolve(dir) }));
  }
  const targetIds = options.targets && options.targets.length > 0 ? options.targets.map((t) => parseSkillTargetId(t)) : [...SKILL_TARGET_IDS];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const id of targetIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ dir: skillTargetDir(id, home), target: id });
  }
  return out;
}
function assertChildPath(parent, child) {
  const rel = path7.relative(path7.resolve(parent), path7.resolve(child));
  if (rel.startsWith("..") || path7.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
}
async function existsPath(target) {
  try {
    await fs7.access(target);
    return true;
  } catch {
    return false;
  }
}

// src/service/handlers.ts
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
      case "workspace.settings":
        return workspaceSettingsRpc(ctx, p);
      case "workspace.settings.update":
        return workspaceSettingsUpdateRpc(ctx, p);
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
      case "registry.role.create":
        return registryRoleCreate(ctx, p);
      case "registry.role.update":
        return registryRoleUpdate(ctx, p);
      case "registry.role.delete":
        return registryRoleDelete(ctx, p);
      case "profile.list":
        return profileList(ctx, p);
      case "profile.get":
        return profileGet(ctx, p);
      case "profile.create":
        return profileCreate(ctx, p);
      case "profile.update":
        return profileUpdate(ctx, p);
      case "profile.delete":
        return profileDelete(ctx, p);
      case "credential.list":
        return credentialList(ctx);
      case "credential.set":
        return credentialSet(ctx, p);
      case "credential.delete":
        return credentialDelete(ctx, p);
      case "skill.list":
        return skillList(ctx);
      case "skill.install":
        return skillInstall(ctx, p);
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
      case "box.projection":
        return boxProjectionRpc(ctx, p);
      case "proposal.list":
        return proposalList(ctx, p);
      case "proposal.submit":
        return proposalSubmit(ctx, p);
      case "proposal.resolve":
        return proposalResolve(ctx, p);
      case "session.list":
        return sessionList(ctx, p);
      case "session.get":
        return sessionGet(ctx, p);
      case "a2a.listPending":
        return a2aListPending(ctx, p);
      case "a2a.resolve":
        return a2aResolve(ctx, p);
      case "toolApproval.listPending":
        return toolApprovalListPending(ctx, p);
      case "toolApproval.get":
        return toolApprovalGet(ctx, p);
      case "toolApproval.approveOnce":
        return toolApprovalResolve(ctx, p, "approved");
      case "toolApproval.deny":
        return toolApprovalResolve(ctx, p, "denied");
      case "operationalRetention.preview":
        return operationalRetentionPreviewRpc(ctx, p);
      case "operationalRetention.purge":
        return operationalRetentionPurgeRpc(ctx, p);
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof RetentionError || error instanceof Error && error.name === "RetentionError") {
      const code = error instanceof RetentionError ? error.code : error.code ?? "INVALID_KEEP_DAYS";
      throw new RpcError(-32602, error.message, { code });
    }
    if (error instanceof WorkspaceSettingsError || error instanceof Error && error.name === "WorkspaceSettingsError") {
      const code = error instanceof WorkspaceSettingsError ? error.code : error.code ?? "INVALID_PATCH";
      throw new RpcError(-32602, error.message, { code });
    }
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
    const probe = await ctx.runtime.probe(sessionId);
    if (probe.alive) continue;
    const alreadyParked = task.state === "waiting" && task.wait?.reason === "external" && task.wait.summary === SESSION_UNAVAILABLE_WAIT_SUMMARY;
    if (alreadyParked) continue;
    await ctx.mutations.run(workspaceId, async () => {
      ctx.host.markSelfWrite(workspaceId);
      const current = await loadTaskEnvelope(mount.env.fs, task.path);
      if (current.state !== "running" && current.state !== "waiting") return;
      if (current.sessionId?.trim() !== sessionId) return;
      const probe2 = await ctx.runtime.probe(sessionId);
      if (probe2.alive) return;
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
async function workspaceSettingsRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const settings = await loadWorkspaceSettings(mount.env.fs);
  return {
    workspaceId,
    settings: projectWorkspaceSettings(settings)
  };
}
async function workspaceSettingsUpdateRpc(ctx, p) {
  requireUserActor(p, "workspace.settings.update");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const patch = parseWorkspaceSettingsPatch(p);
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    let result;
    try {
      result = await updateWorkspaceSettings(mount.env.fs, patch);
    } catch (err) {
      if (err instanceof WorkspaceSettingsError || err instanceof Error && err.name === "WorkspaceSettingsError") {
        const code = err instanceof WorkspaceSettingsError ? err.code : err.code ?? "INVALID_PATCH";
        throw new RpcError(-32602, err.message, { code });
      }
      throw err;
    }
    if (result.changed) {
      emitWorkspaceSettingsUpdated(ctx, workspaceId, result.settings);
    }
    return {
      workspaceId,
      settings: projectWorkspaceSettings(result.settings),
      changed: result.changed
    };
  });
}
function parseWorkspaceSettingsPatch(p) {
  if (typeof p.patch === "object" && p.patch !== null && !Array.isArray(p.patch)) {
    throw new RpcError(
      -32602,
      "workspace.settings.update does not accept nested patch; pass fields at the top level"
    );
  }
  const reserved = /* @__PURE__ */ new Set(["workspaceId", "actor", "patch"]);
  const supported = /* @__PURE__ */ new Set(["defaultDeliveryPolicy"]);
  const out = {};
  for (const [key, value] of Object.entries(p)) {
    if (reserved.has(key)) continue;
    if (!supported.has(key)) {
      throw new RpcError(-32602, `Unknown workspace setting: ${key}`);
    }
    if (value === void 0) continue;
    out[key] = value;
  }
  if ("defaultDeliveryPolicy" in out) {
    const v = out.defaultDeliveryPolicy;
    if (v !== "manual" && v !== "bypass" && v !== "agent-decide") {
      throw new RpcError(-32602, `Invalid defaultDeliveryPolicy: ${String(v)}`, {
        code: "INVALID_DELIVERY_POLICY"
      });
    }
  }
  return out;
}
function projectWorkspaceSettings(settings) {
  return { ...settings };
}
function emitWorkspaceSettingsUpdated(ctx, workspaceId, settings) {
  ctx.events.emit(
    "workspace.settings.updated",
    workspaceId,
    {
      settings: projectWorkspaceSettings(settings)
    },
    "self"
  );
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
  const roles = registry.roles.map((role) => projectRoleRegistryEntry(role)).sort((a, b) => a.name.localeCompare(b.name));
  return { workspaceId, roles };
}
function projectRoleRegistryEntry(role) {
  const proj = {
    name: role.name,
    description: role.description,
    color: role.color,
    prompt: role.prompt,
    a2aPolicy: roleA2APolicy(role)
  };
  if (role.allowedProfiles && role.allowedProfiles.length > 0) {
    proj.allowedProfiles = [...role.allowedProfiles];
  }
  return proj;
}
async function registryRoleCreate(ctx, p) {
  requireUserActor(p, "registry.role.create");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const definition = parseRoleDefinitionParams(p, { requireName: true });
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await createRole(mount.env.fs, definition);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.create");
    }
    const registry = await loadRolesRegistry(mount.env.fs);
    const role = registry.roles.find((r) => r.name === definition.name);
    if (!role) {
      throw new RpcError(-32e3, `Role create succeeded but role not found: ${definition.name}`);
    }
    emitRegistryRolesUpdated(ctx, workspaceId, {
      action: "create",
      name: role.name
    });
    return { workspaceId, role: projectRoleRegistryEntry(role) };
  });
}
async function registryRoleUpdate(ctx, p) {
  requireUserActor(p, "registry.role.update");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  if (p.rename !== void 0 || typeof p.newName === "string" && p.newName.trim() && p.newName.trim() !== name) {
    throw new RpcError(-32602, "registry.role.update cannot rename a role; name is immutable after create");
  }
  if (typeof p.patch === "object" && p.patch !== null && !Array.isArray(p.patch)) {
    throw new RpcError(
      -32602,
      "registry.role.update does not accept nested patch; pass fields at the top level with name"
    );
  }
  const patch = parseRoleDefinitionParams(p, { requireName: false, forUpdate: true });
  const { name: _ignored, ...fields } = patch;
  const updatePatch = { ...fields };
  for (const key of ["prompt", "description", "color"]) {
    if (key in p && (p[key] === null || typeof p[key] === "string" && !p[key].trim())) {
      updatePatch[key] = void 0;
    }
  }
  if ("a2aPolicy" in p && (p.a2aPolicy === null || p.a2aPolicy === "")) {
    updatePatch.a2aPolicy = void 0;
  }
  if ("allowedProfiles" in p) {
    updatePatch.allowedProfiles = normalizeAllowedProfiles(
      Array.isArray(p.allowedProfiles) ? p.allowedProfiles : []
    );
  }
  if ("cli" in p && p.cli === null) {
    updatePatch.cli = void 0;
  }
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await updateRole(mount.env.fs, name, updatePatch);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.update");
    }
    const registry = await loadRolesRegistry(mount.env.fs);
    const role = registry.roles.find((r) => r.name === name);
    if (!role) {
      throw new RpcError(-32004, `Role does not exist: ${name}`);
    }
    emitRegistryRolesUpdated(ctx, workspaceId, {
      action: "update",
      name: role.name
    });
    return { workspaceId, role: projectRoleRegistryEntry(role) };
  });
}
async function registryRoleDelete(ctx, p) {
  requireUserActor(p, "registry.role.delete");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  const confirmation = requireString(p, "confirmation");
  if (confirmation !== name) {
    throw new RpcError(
      -32602,
      `Confirmation mismatch; enter the role name ${name}.`,
      { name, confirmation }
    );
  }
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const tasks = await loadTaskEnvelopes(mount.env.fs);
    const activeTask = tasks.find(
      (t) => t.role === name && isActiveTaskState(t.state)
    );
    if (activeTask) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Cannot delete role "${name}": active task ${activeTask.path} (state=${activeTask.state})`,
        {
          role: name,
          taskPath: activeTask.path,
          taskState: activeTask.state
        }
      );
    }
    const activeSession = await findActiveManagedSessionForRole(ctx, workspaceId, name);
    if (activeSession) {
      throw new RpcError(
        RPC_LIFECYCLE,
        `Cannot delete role "${name}": active managed session ${activeSession.id} (state=${activeSession.state})`,
        {
          role: name,
          sessionId: activeSession.id,
          sessionState: activeSession.state
        }
      );
    }
    try {
      await deleteRole(mount.env.fs, name, confirmation);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.delete");
    }
    emitRegistryRolesUpdated(ctx, workspaceId, {
      action: "delete",
      name
    });
    return { workspaceId, deleted: name };
  });
}
function emitRegistryRolesUpdated(ctx, workspaceId, payload) {
  ctx.events.emit(
    "registry.roles.updated",
    workspaceId,
    {
      action: payload.action,
      name: payload.name
    },
    "self"
  );
}
function parseRoleDefinitionParams(p, opts) {
  for (const banned of [
    "secret",
    "secrets",
    "token",
    "apiKey",
    "api_key",
    "password",
    "credential",
    "credentials",
    "env"
  ]) {
    if (banned in p) {
      throw new RpcError(
        -32602,
        `registry.role.* does not accept ${banned}; roles store ids/policy only, never credentials`
      );
    }
  }
  if ("role" in p && typeof p.role === "object" && p.role !== null) {
    throw new RpcError(
      -32602,
      "registry.role.* does not accept nested role; pass fields at the top level"
    );
  }
  const raw = {};
  if (opts.requireName || typeof p.name === "string") {
    raw.name = requireString(p, "name");
  } else if (!opts.forUpdate) {
    throw new RpcError(-32602, "Missing string param: name");
  } else {
    raw.name = "";
  }
  if ("prompt" in p) {
    if (p.prompt !== void 0 && p.prompt !== null && typeof p.prompt !== "string") {
      throw new RpcError(-32602, "Invalid string param: prompt");
    }
    if (typeof p.prompt === "string") raw.prompt = p.prompt;
  }
  if ("description" in p) {
    if (p.description !== void 0 && p.description !== null && typeof p.description !== "string") {
      throw new RpcError(-32602, "Invalid string param: description");
    }
    if (typeof p.description === "string") raw.description = p.description;
  }
  if ("color" in p) {
    if (p.color !== void 0 && p.color !== null && typeof p.color !== "string") {
      throw new RpcError(-32602, "Invalid string param: color");
    }
    if (typeof p.color === "string") raw.color = p.color;
  }
  if ("a2aPolicy" in p) {
    if (p.a2aPolicy === null || p.a2aPolicy === "") {
    } else if (p.a2aPolicy === "allow" || p.a2aPolicy === "ask" || p.a2aPolicy === "deny") {
      raw.a2aPolicy = p.a2aPolicy;
    } else {
      throw new RpcError(-32602, `Invalid a2aPolicy: ${String(p.a2aPolicy)}`);
    }
  }
  if ("allowedProfiles" in p) {
    if (p.allowedProfiles === null) {
      raw.allowedProfiles = [];
    } else if (!Array.isArray(p.allowedProfiles)) {
      throw new RpcError(-32602, "allowedProfiles must be an array of profile id strings");
    } else {
      for (const item of p.allowedProfiles) {
        if (typeof item !== "string") {
          throw new RpcError(-32602, "allowedProfiles must be an array of profile id strings");
        }
      }
      raw.allowedProfiles = normalizeAllowedProfiles(p.allowedProfiles) ?? [];
    }
  }
  if ("cli" in p) {
    if (p.cli === null) {
    } else if (typeof p.cli !== "object" || Array.isArray(p.cli)) {
      throw new RpcError(-32602, "role.cli must be an object");
    } else {
      raw.cli = p.cli;
    }
  }
  try {
    const role = normalizeRoleDefinition(raw);
    if (opts.requireName && !role.name) {
      throw new RpcError(-32602, "Role name cannot be empty.");
    }
    if ("allowedProfiles" in p) {
      const normalized = normalizeAllowedProfiles(
        Array.isArray(p.allowedProfiles) ? p.allowedProfiles : []
      );
      if (normalized) role.allowedProfiles = normalized;
      else delete role.allowedProfiles;
    }
    return role;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : "Invalid role definition";
    throw new RpcError(-32602, message);
  }
}
function mapRoleRegistryError(err, surface) {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : `${surface} failed`;
  if (/already exists|does not exist|Confirmation mismatch|cannot be empty|cli\./i.test(message)) {
    if (/does not exist/i.test(message)) {
      return new RpcError(-32004, message);
    }
    return new RpcError(-32602, message);
  }
  return new RpcError(-32e3, message);
}
async function profileList(ctx, p) {
  const includeTest = p.includeTest === true;
  const catalog = ctx.profileCatalog.list();
  const existsMap = await credentialExistsLookup(ctx, catalog);
  let profiles = projectAgentProfiles(catalog, { credentialExistsById: existsMap });
  if (!includeTest) {
    profiles = profiles.filter((pr) => !pr.testOnly);
  }
  return { profiles };
}
async function profileGet(ctx, p) {
  const id = requireString(p, "id");
  const profile = ctx.profileCatalog.get(id);
  if (!profile) {
    throw new RpcError(-32004, `Profile not found: ${id}`);
  }
  return {
    profile: projectAgentProfile(
      profile,
      await profileCredentialExistsOpts(ctx, profile)
    )
  };
}
async function profileCreate(ctx, p) {
  if ("profile" in p) {
    throw new RpcError(
      -32602,
      "profile.create does not accept nested profile; pass fields at the top level"
    );
  }
  const created = await ctx.profileCatalog.create(p);
  return {
    profile: projectAgentProfile(
      created,
      await profileCredentialExistsOpts(ctx, created)
    )
  };
}
async function profileUpdate(ctx, p) {
  if ("profile" in p) {
    throw new RpcError(
      -32602,
      "profile.update does not accept nested profile; pass { id, ...patch }"
    );
  }
  const id = requireString(p, "id");
  const { id: _id, ...patch } = p;
  const updated = await ctx.profileCatalog.update(id, patch);
  return {
    profile: projectAgentProfile(
      updated,
      await profileCredentialExistsOpts(ctx, updated)
    )
  };
}
async function profileDelete(ctx, p) {
  const id = requireString(p, "id");
  return ctx.profileCatalog.delete(id);
}
async function credentialExistsLookup(ctx, profiles) {
  const map = /* @__PURE__ */ new Map();
  for (const p of profiles) {
    const ref = typeof p.acp?.credentialRef === "string" ? p.acp.credentialRef.trim() : "";
    if (ref && !map.has(ref)) {
      map.set(ref, await ctx.credentials.has(ref));
    }
  }
  return map;
}
async function profileCredentialExistsOpts(ctx, profile) {
  const ref = typeof profile.acp?.credentialRef === "string" && profile.acp.credentialRef.trim() ? profile.acp.credentialRef.trim() : void 0;
  if (!ref) return void 0;
  return { credentialExists: await ctx.credentials.has(ref) };
}
async function credentialList(ctx) {
  const credentials = await ctx.credentials.list();
  return { credentials };
}
async function credentialSet(ctx, p) {
  if ("credential" in p) {
    throw new RpcError(
      -32602,
      "credential.set does not accept nested credential; pass { id, secret, metadata? } or { id, secret, label? }"
    );
  }
  const id = requireString(p, "id");
  if (!("secret" in p) || typeof p.secret !== "string" || p.secret.length === 0) {
    throw new RpcError(-32602, "Missing or invalid string param: secret");
  }
  const secret = p.secret;
  let metadata;
  if ("metadata" in p && p.metadata !== void 0 && p.metadata !== null) {
    if (typeof p.metadata !== "object" || Array.isArray(p.metadata)) {
      throw new RpcError(-32602, "Invalid metadata: must be a plain object when set");
    }
    metadata = p.metadata;
  } else if ("label" in p && p.label !== void 0 && p.label !== null) {
    if (typeof p.label !== "string") {
      throw new RpcError(-32602, "Invalid string param: label");
    }
    metadata = { label: p.label };
  }
  try {
    const credential = await ctx.credentials.set(id, secret, metadata);
    ctx.events.emit(
      "credential.changed",
      "",
      {
        action: "set",
        id: credential.id,
        updatedAt: credential.updatedAt,
        ...credential.metadata ? { metadata: credential.metadata } : {}
      },
      "self"
    );
    return { credential };
  } catch (err) {
    const message = err instanceof Error ? err.message : "credential.set failed";
    if (secret && message.includes(secret)) {
      throw new RpcError(-32602, "credential.set failed");
    }
    if (/Invalid credential id|Missing or invalid credential|credential secret|metadata|must match/i.test(
      message
    )) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32e3, message);
  }
}
async function credentialDelete(ctx, p) {
  const id = requireString(p, "id");
  try {
    const result = await ctx.credentials.delete(id);
    ctx.events.emit(
      "credential.changed",
      "",
      { action: "delete", id: result.deleted },
      "self"
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "credential.delete failed";
    if (/not found/i.test(message)) {
      throw new RpcError(-32004, message);
    }
    if (/Invalid credential id|Missing or invalid credential/i.test(message)) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32e3, message);
  }
}
async function skillList(ctx) {
  try {
    return await listSkills({ packageRoot: ctx.packageRoot, home: ctx.home });
  } catch (err) {
    const message = err instanceof Error ? err.message : "skill.list failed";
    throw new RpcError(-32e3, message);
  }
}
async function skillInstall(ctx, p) {
  for (const banned of ["source", "destination", "dest", "dir", "targetDir", "targetDirs", "path"]) {
    if (banned in p) {
      throw new RpcError(
        -32602,
        `skill.install does not accept ${banned}; only skills[], targets[], force`
      );
    }
  }
  if ("workspaceId" in p && p.workspaceId !== void 0 && p.workspaceId !== null) {
    throw new RpcError(-32602, "skill.install is machine-local and does not accept workspaceId");
  }
  let skills;
  if ("skills" in p && p.skills !== void 0 && p.skills !== null) {
    if (!Array.isArray(p.skills) || !p.skills.every((s) => typeof s === "string")) {
      throw new RpcError(-32602, "Invalid skills: must be an array of strings when set");
    }
    skills = p.skills;
  }
  let targets;
  if ("targets" in p && p.targets !== void 0 && p.targets !== null) {
    if (!Array.isArray(p.targets) || !p.targets.every((t) => typeof t === "string")) {
      throw new RpcError(-32602, "Invalid targets: must be an array of strings when set");
    }
    try {
      targets = p.targets.map((t) => parseSkillTargetId(t));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid targets";
      throw new RpcError(-32602, message);
    }
  }
  let force = false;
  if ("force" in p && p.force !== void 0 && p.force !== null) {
    if (typeof p.force !== "boolean") {
      throw new RpcError(-32602, "Invalid force: must be a boolean when set");
    }
    force = p.force;
  }
  try {
    const results = await installSkills({
      packageRoot: ctx.packageRoot,
      home: ctx.home,
      skills,
      targets,
      force
    });
    ctx.events.emit(
      "skill.changed",
      "",
      {
        action: "install",
        installed: results.filter((r) => r.status === "installed").length,
        skipped: results.filter((r) => r.status === "skipped").length
      },
      "self"
    );
    return { results };
  } catch (err) {
    const message = err instanceof Error ? err.message : "skill.install failed";
    if (/Invalid skill name|Unknown skill target|Unknown bundled skill|escapes the destination/i.test(
      message
    )) {
      throw new RpcError(-32602, message);
    }
    throw new RpcError(-32e3, message);
  }
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
  const explicitDeliveryPolicy = parseDeliveryPolicy(optionalString(p, "deliveryPolicy"));
  const startSession = p.startSession === true;
  const profileId = optionalString(p, "profileId");
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }
  if (startSession && !profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with startSession requires explicit profileId (no fake-default fallback)"
    );
  }
  const result = await ctx.mutations.run(workspaceId, async () => {
    const roleLane2 = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, role);
    ctx.host.markSelfWrite(workspaceId);
    let deliveryPolicy = explicitDeliveryPolicy;
    if (deliveryPolicy === void 0) {
      const settings = await loadWorkspaceSettings(mount.env.fs);
      deliveryPolicy = settings.defaultDeliveryPolicy;
    }
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
      callerKind
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
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }
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
    if (approval.workspaceId !== workspaceId) {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval workspace mismatch", { approvalId });
    }
    if (approval.profileId !== profileId) {
      throw new RpcError(RPC_A2A_DENIED, "A2A approval profile mismatch", {
        approvalId,
        approvedProfileId: approval.profileId,
        requestedProfileId: profileId
      });
    }
  } else {
    const taskForPolicy = await loadTaskEnvelope(mount.env.fs, taskPath);
    const a2aPolicy = await resolveStartSessionA2APolicy(mount.env.fs, {
      callerKind,
      taskRole: taskForPolicy.role
    });
    const profileAllowed = callerKind === "user" ? true : await resolveRoleProfileAllowed(mount.env.fs, {
      taskRole: taskForPolicy.role,
      profileId,
      policy: a2aPolicy
    });
    const decision = evaluateA2A({
      callerKind,
      policy: a2aPolicy,
      profileAllowed
    });
    if (decision === "deny") {
      throw new RpcError(RPC_A2A_DENIED, "A2A policy denies starting a new runtime session", {
        policy: a2aPolicy,
        callerKind,
        role: taskForPolicy.role,
        profileId,
        profileAllowed
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
  task = await ensureTaskWorkspaceLane(ctx, workspaceId, task);
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
  const priorSessionId = task.sessionId?.trim() || "";
  let resumePrior = false;
  if (priorSessionId) {
    try {
      const probe = await ctx.runtime.probe(priorSessionId);
      if (probe.resumeCapable && !probe.alive) {
        const prior = await ctx.runtime.registry.read(priorSessionId);
        const recordedCwd = prior?.runtimeWorkspace?.cwd?.trim() || "";
        const cwdMatches = !!recordedCwd && isSameWorkspaceRoot(nodePath2.resolve(recordedCwd), nodePath2.resolve(cwd));
        const profileMatches = !prior?.profileId || prior.profileId === profileId;
        const workspaceMatches = prior?.workspace === workspaceId;
        const roleMatches = prior?.roleName === task.role;
        const taskMatches = prior?.lastTaskId === taskPath || !!task.id && prior?.lastTaskId === task.id;
        resumePrior = cwdMatches && profileMatches && workspaceMatches && roleMatches && taskMatches;
      }
    } catch (err) {
      if (!/Session not found/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
    }
  }
  let handle;
  try {
    if (resumePrior) {
      handle = await ctx.runtime.resumeSession({
        sessionId: priorSessionId,
        runtimeWorkspace: { cwd },
        cwd,
        bootstrapPrompt: sessionBootstrap
      });
    } else {
      handle = await ctx.runtime.startSession({
        sessionId: makeSessionId(),
        profileId,
        roleName: task.role,
        workspaceLane,
        runtimeWorkspace: { cwd },
        cwd,
        bootstrapPrompt: sessionBootstrap,
        lastTaskId: task.id || taskPath,
        workspace: workspaceId
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTaskFromRuntime(ctx, {
      workspaceId,
      taskPath,
      sessionId: void 0,
      reason: "session.failed",
      summary: message
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
        reason: resumePrior ? "task.startSession.resume" : "task.startSession"
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
async function boxProjectionRpc(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept3(tent, p);
  if (concept.invalid) {
    throw new RpcError(
      -32004,
      `Concept is invalid and has no collaboration projection: ${concept.path}`,
      { boxId: concept.id, path: concept.path, detail: concept.invalidReason }
    );
  }
  const activeTask = await findActiveTaskForBox(mount.env.fs, concept.id);
  if (activeTask) {
    const fromTask = boxProjectionOf(activeTask);
    const out = {
      workspaceId,
      boxId: concept.id,
      status: fromTask.status
    };
    if (fromTask.assignee) out.assignee = fromTask.assignee;
    if (fromTask.activeTaskId) out.activeTaskId = fromTask.activeTaskId;
    return out;
  }
  const status = concept.fm.status === "done" ? "done" : "todo";
  return {
    workspaceId,
    boxId: concept.id,
    status
  };
}
async function proposalList(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = optionalString(p, "boxId");
  const statusRaw = optionalString(p, "status") ?? "pending";
  if (statusRaw !== "pending" && statusRaw !== "accepted" && statusRaw !== "rejected" && statusRaw !== "all") {
    throw new RpcError(-32602, `Invalid proposal status filter: ${statusRaw}`);
  }
  let proposals = await loadProposals(mount.env.fs);
  if (boxId) proposals = proposals.filter((item) => item.boxId === boxId);
  if (statusRaw !== "all") {
    proposals = proposals.filter((item) => item.status === statusRaw);
  }
  return { proposals: proposals.map(projectProposal) };
}
async function proposalSubmit(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const boxId = requireString(p, "boxId");
  const role = requireString(p, "role");
  const body = requireString(p, "body");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const proposal = await submitProposal(mount.env.fs, mount.env.clock, role, boxId, body);
    emitProposalUpdated(ctx, workspaceId, proposal, "proposal.submit");
    return { proposal: projectProposal(proposal) };
  });
}
async function proposalResolve(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const proposalPath2 = requireString(p, "path");
  const decision = requireString(p, "decision");
  if (decision !== "accept" && decision !== "reject") {
    throw new RpcError(-32602, `Invalid proposal decision: ${decision}`);
  }
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "proposal resolve is user-only; agent self-resolve is forbidden",
      { actor: actorRaw }
    );
  }
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    if (decision === "accept") {
      await acceptProposal(mount.env.fs, proposalPath2);
    } else {
      await rejectProposal(mount.env.fs, proposalPath2);
    }
    const proposal = await loadProposal(mount.env.fs, proposalPath2);
    emitProposalUpdated(
      ctx,
      workspaceId,
      proposal,
      decision === "accept" ? "proposal.accept" : "proposal.reject"
    );
    return { proposal: projectProposal(proposal) };
  });
}
function projectProposal(proposal) {
  return {
    path: proposal.path,
    boxId: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt,
    body: proposal.body
  };
}
function emitProposalUpdated(ctx, workspaceId, proposal, reason) {
  ctx.events.emit(
    "proposal.updated",
    workspaceId,
    {
      path: proposal.path,
      boxId: proposal.boxId,
      role: proposal.role,
      status: proposal.status,
      reason
    },
    "self"
  );
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
  const actor = requireUserActor(p, "a2a.resolve");
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
async function toolApprovalListPending(ctx, p) {
  const workspaceId = optionalString(p, "workspaceId");
  const pending = await ctx.toolApprovals.listPending(workspaceId);
  return { approvals: pending.map(projectToolApproval) };
}
async function toolApprovalGet(ctx, p) {
  const approvalId = requireString(p, "approvalId");
  const item = await ctx.toolApprovals.get(approvalId);
  if (!item) throw new RpcError(-32004, `Tool approval not found: ${approvalId}`);
  return { approval: projectToolApproval(item) };
}
async function toolApprovalResolve(ctx, p, decision) {
  const approvalId = requireString(p, "approvalId");
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      "toolApproval resolve is user-only; agent self-approve is forbidden",
      { actor: actorRaw }
    );
  }
  const item = await ctx.toolApprovals.resolve(approvalId, decision, actorRaw);
  ctx.events.emit(
    "toolApproval.resolved",
    item.workspaceId,
    {
      approvalId: item.id,
      decision,
      actor: actorRaw,
      sessionId: item.sessionId,
      taskPath: item.taskPath,
      toolTitle: item.toolTitle
    },
    "self"
  );
  if (decision === "approved" && item.taskPath) {
    try {
      const mount = ctx.host.get(item.workspaceId);
      if (mount) {
        const task = await loadTaskEnvelope(mount.env.fs, item.taskPath);
        if (task.state === "waiting" && task.wait?.reason === "user-input") {
          await ctx.mutations.run(item.workspaceId, async () => {
            ctx.host.markSelfWrite(item.workspaceId);
            const resumed = await taskResume(mount.env, item.taskPath);
            emitTaskState(ctx, item.workspaceId, resumed, "toolApproval.approveOnce");
          });
        }
      }
    } catch {
    }
  }
  return { approval: projectToolApproval(item) };
}
function projectToolApproval(item) {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    sessionId: item.sessionId,
    taskId: item.taskId,
    taskPath: item.taskPath,
    role: item.role,
    toolTitle: item.toolTitle,
    toolCallId: item.toolCallId,
    options: item.options,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    resolvedAt: item.resolvedAt,
    resolvedBy: item.resolvedBy
  };
}
async function operationalRetentionPreviewRpc(ctx, p) {
  requireUserActor(p, "operationalRetention.preview");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const keepTerminalTasksDays = parseKeepTerminalTasksDays(p);
  const preview = await previewOperationalRetention(mount.env.fs, {
    keepTerminalTasksDays,
    now: mount.env.clock.now()
  });
  return { workspaceId, ...preview };
}
async function operationalRetentionPurgeRpc(ctx, p) {
  requireUserActor(p, "operationalRetention.purge");
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const keepTerminalTasksDays = parseKeepTerminalTasksDays(p);
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await purgeOperationalRetention(mount.env.fs, {
      keepTerminalTasksDays,
      now: mount.env.clock.now()
    });
    if (result.deletedCount > 0) {
      emitRetentionPurged(ctx, workspaceId, result);
    }
    return { workspaceId, ...result };
  });
}
function requireUserActor(p, surface) {
  const actorRaw = optionalString(p, "actor") ?? "user";
  if (actorRaw !== "user") {
    throw new RpcError(
      -32001,
      `${surface} is user-only; non-user actor is forbidden`,
      { actor: actorRaw }
    );
  }
  return actorRaw;
}
function parseKeepTerminalTasksDays(p) {
  const v = p.keepTerminalTasksDays;
  try {
    return normalizeKeepTerminalTasksDays(v);
  } catch (error) {
    if (error instanceof RetentionError || error instanceof Error && error.name === "RetentionError") {
      throw new RpcError(-32602, error.message, {
        code: error instanceof RetentionError ? error.code : "INVALID_KEEP_DAYS"
      });
    }
    throw error;
  }
}
function emitRetentionPurged(ctx, workspaceId, result) {
  ctx.events.emit(
    "retention.purged",
    workspaceId,
    {
      keepTerminalTasksDays: result.keepTerminalTasksDays,
      cutoff: result.cutoff,
      deletedCount: result.deletedCount,
      taskPaths: result.purged.taskPaths,
      deliveryPaths: result.purged.deliveryPaths,
      candidateTaskCount: result.candidateTaskCount,
      candidateDeliveryCount: result.candidateDeliveryCount,
      warnings: result.warnings
    },
    "self"
  );
}
var managedAutoDeliverInFlight = /* @__PURE__ */ new Set();
var managedAutoDeliverDone = /* @__PURE__ */ new Set();
var runtimeProjectionQueue = new MutationBus();
var PROJECTION_RETRY_DELAY_MS = 40;
var runtimeProjectionTestHooks = null;
function managedDeliverKey(sessionId, taskPath) {
  return `${sessionId}::${taskPath}`;
}
function projectionRetryDelayMs() {
  return runtimeProjectionTestHooks?.retryDelayMs ?? PROJECTION_RETRY_DELAY_MS;
}
function sleepMs(ms) {
  return new Promise((resolve10) => setTimeout(resolve10, ms));
}
function classifyProjectionError(err) {
  if (err instanceof TaskLifecycleError) {
    return { errorClass: "TaskLifecycleError", errorCode: err.code };
  }
  if (err instanceof RpcError) {
    return { errorClass: "RpcError", errorCode: err.code };
  }
  if (err && typeof err === "object") {
    const e = err;
    const errorClass = typeof e.name === "string" && e.name || e.constructor?.name || "Error";
    const errorCode = typeof e.code === "string" || typeof e.code === "number" ? e.code : void 0;
    return errorCode !== void 0 ? { errorClass, errorCode } : { errorClass };
  }
  return { errorClass: "UnknownError" };
}
function mapRuntimeEventToService(ctx, ev) {
  return runtimeProjectionQueue.run(ev.sessionId, async () => {
    try {
      await projectRuntimeEventWithRetry(ctx, ev);
    } catch (err) {
      await reportRuntimeProjectionFailure(ctx, ev, err);
    }
  });
}
async function projectRuntimeEventWithRetry(ctx, ev) {
  try {
    await projectRuntimeEventOnce(ctx, ev, 1);
  } catch {
    await sleepMs(projectionRetryDelayMs());
    await projectRuntimeEventOnce(ctx, ev, 2);
  }
}
async function reportRuntimeProjectionFailure(ctx, ev, err) {
  const classified = classifyProjectionError(err);
  let workspaceId = "";
  try {
    const rec = await ctx.runtime.registry.read(ev.sessionId);
    workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
  } catch {
    workspaceId = ctx.host.getForegroundId() ?? "";
  }
  console.error(
    `[tent-service] runtime projection failed sessionId=${ev.sessionId} event=${ev.type} class=${classified.errorClass}` + (classified.errorCode !== void 0 ? ` code=${classified.errorCode}` : "")
  );
  ctx.events.emit(
    "service.health",
    workspaceId,
    {
      action: "runtime-projection-failed",
      sessionId: ev.sessionId,
      runtimeEvent: ev.type,
      errorClass: classified.errorClass,
      ...classified.errorCode !== void 0 ? { errorCode: classified.errorCode } : {}
    },
    "service"
  );
}
async function projectRuntimeEventOnce(ctx, ev, attempt) {
  if (runtimeProjectionTestHooks?.beforeProject) {
    await runtimeProjectionTestHooks.beforeProject(ev, attempt);
  }
  if (runtimeProjectionTestHooks && typeof runtimeProjectionTestHooks.failAttemptsRemaining === "number" && runtimeProjectionTestHooks.failAttemptsRemaining > 0) {
    runtimeProjectionTestHooks.failAttemptsRemaining -= 1;
    const injected = new Error("injected runtime projection failure");
    injected.name = "ProjectionInjectedError";
    injected.code = "PROJECTION_INJECTED";
    throw injected;
  }
  const rec = await ctx.runtime.registry.read(ev.sessionId);
  if (ev.type === "session.prompt_complete" && !rec?.lastTaskId) {
    throw new Error(
      `Managed prompt completion has no task binding: ${ev.sessionId}`
    );
  }
  const workspaceId = rec?.workspace ?? ctx.host.getForegroundId() ?? "";
  if (ev.type === "session.stdout_tail") {
    return;
  }
  if (ev.type === "session.waiting_user") {
    if (rec && SessionRegistry.isNonTerminal(rec.state)) {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "waiting-user"
      });
    }
  } else if (ev.type === "session.live") {
    const current = await ctx.runtime.registry.read(ev.sessionId);
    if (current && current.state === "waiting-user") {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "live",
        ...ev.pid != null ? { pid: ev.pid } : {}
      });
    }
  } else if (ev.type === "session.failed" || ev.type === "session.exited") {
    await ctx.toolApprovals.cancelSession(ev.sessionId, "denied");
  }
  if (rec?.lastTaskId) {
    const mountInfos = ctx.host.list();
    for (const info of mountInfos) {
      if (rec.workspace && info.workspaceId !== rec.workspace) continue;
      const mount = ctx.host.get(info.workspaceId);
      if (!mount) continue;
      const tasks = await loadTaskEnvelopes(mount.env.fs);
      const task = tasks.find(
        (t) => t.sessionId === ev.sessionId || t.id === rec.lastTaskId || t.path === rec.lastTaskId
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
      } else if (ev.type === "session.live" && task.state === "waiting" && task.wait?.reason === "user-input") {
        await ctx.mutations.run(mount.workspaceId, async () => {
          ctx.host.markSelfWrite(mount.workspaceId);
          const resumed = await taskResume(mount.env, task.path);
          emitTaskState(ctx, mount.workspaceId, resumed, "session.live");
        });
      } else if ((ev.type === "session.failed" || ev.type === "session.exited") && (task.state === "running" || task.state === "waiting")) {
        await failTaskFromRuntime(ctx, {
          workspaceId: mount.workspaceId,
          taskPath: task.path,
          sessionId: ev.sessionId,
          reason: ev.type,
          summary: ev.type === "session.failed" ? ev.error : `Managed session exited before delivery (code=${ev.exitCode ?? "unknown"})`
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
}
async function failTaskFromRuntime(ctx, input) {
  const mount = ctx.host.get(input.workspaceId);
  if (!mount) return;
  if (input.sessionId) {
    try {
      await ctx.toolApprovals.cancelSession(input.sessionId, "denied");
    } catch {
    }
    try {
      const probe = await ctx.runtime.probe(input.sessionId);
      if (probe.alive || SessionRegistry.isNonTerminal(probe.state)) {
        await ctx.runtime.stopSession(input.sessionId, "interrupt");
      }
    } catch {
    }
  }
  await ctx.mutations.run(input.workspaceId, async () => {
    ctx.host.markSelfWrite(input.workspaceId);
    const current = await loadTaskEnvelope(mount.env.fs, input.taskPath);
    if (current.state !== "running" && current.state !== "waiting" && current.state !== "failed") {
      return;
    }
    const failed = await taskFail(mount.env, input.taskPath, {
      summary: input.summary
    });
    emitTaskState(ctx, input.workspaceId, failed, input.reason);
  });
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
  let deliveredOk = false;
  try {
    const mount = ctx.host.get(input.workspaceId);
    if (!mount) return;
    if (input.commits === void 0) {
      const pre = await loadTaskEnvelope(mount.env.fs, input.taskPath).catch(() => null);
      if (pre && pre.state === "running") {
        await ensureTaskWorkspaceLane(ctx, input.workspaceId, pre);
      }
    }
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
      let commits = input.commits;
      if (commits === void 0) {
        commits = await collectManagedDeliveryCommits(mount.workspaceRoot, task);
      }
      ctx.host.markSelfWrite(input.workspaceId);
      const integrate = makeCommitIntegrator(ctx, mount.workspaceRoot, task);
      const policy = task.deliveryPolicy ?? "manual";
      const decision = policy === "agent-decide" ? "request-review" : void 0;
      const result = await taskDeliver(mount.env, input.taskPath, {
        summary,
        decision,
        integrate,
        ...commits.length > 0 ? { commits } : {}
      });
      managedAutoDeliverDone.add(key);
      deliveredOk = true;
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
    if (deliveredOk) {
      await stopManagedSessionAfterDelivery(ctx, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        taskPath: input.taskPath
      });
    }
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
async function collectManagedDeliveryCommits(workspaceRoot, task) {
  const hasRecordedLane = Boolean(
    task.workspace || task.worktree || task.branch || task.targetBranch
  );
  if (!hasRecordedLane) {
    return [];
  }
  const base = task.roleBranchBase?.trim();
  if (!base) {
    throw new Error(
      `Managed delivery collection requires roleBranchBase on task ${task.id || task.path}; baseline must be captured at first Git lane bind (never fall back to all role commits).`
    );
  }
  const contract = await resolveIntegrationContract(workspaceRoot, task);
  const pending = await listPendingRoleCommits(contract, base);
  return pending.map((commit) => commit.ref);
}
async function stopManagedSessionAfterDelivery(ctx, input) {
  try {
    try {
      await ctx.toolApprovals.cancelSession(input.sessionId, "denied");
    } catch {
    }
    const probe = await ctx.runtime.probe(input.sessionId);
    if (probe.alive || SessionRegistry.isNonTerminal(probe.state)) {
      await ctx.runtime.stopSession(input.sessionId, "user");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await ctx.runtime.registry.update(input.sessionId, {
        lastError: `managed session stop after deliver failed: ${message}`
      });
    } catch {
    }
    ctx.events.emit(
      "session.state",
      input.workspaceId,
      {
        sessionId: input.sessionId,
        taskPath: input.taskPath,
        runtimeEvent: "session.stop_after_deliver.failed",
        error: message,
        // Delivery already succeeded; task must not be failed for stop issues.
        taskFailed: false
      },
      "service"
    );
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
async function resolveStartSessionA2APolicy(fs13, input) {
  if (input.callerKind === "user") return "allow";
  const registry = await loadRolesRegistry(fs13);
  const role = registry.roles.find((r) => r.name === input.taskRole);
  return roleA2APolicy(role);
}
async function resolveRoleProfileAllowed(fs13, input) {
  if (input.policy !== "allow") return true;
  const registry = await loadRolesRegistry(fs13);
  const role = registry.roles.find((r) => r.name === input.taskRole);
  return roleAllowsProfile(role, input.profileId);
}
function parseCallerKind(raw) {
  if (raw === "user" || raw === "role") return raw;
  throw new RpcError(-32602, `Invalid callerKind: ${raw}`);
}
function resolveConcept3(tent, p) {
  const id = optionalString(p, "id") ?? optionalString(p, "boxId");
  const path15 = optionalString(p, "path");
  if (id) {
    const byId = tent.byId.get(id);
    if (byId) return byId;
    throw new RpcError(-32004, `Concept not found: ${id}`);
  }
  if (path15) {
    const byPath = tent.byPath.get(path15);
    if (byPath) return byPath;
    throw new RpcError(-32004, `Concept not found: ${path15}`);
  }
  throw new RpcError(-32602, "Concept lookup requires id, boxId, or path");
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
  const laneComplete = Boolean(
    task.worktree && task.branch && task.workspace && task.targetBranch
  );
  if (laneComplete && task.roleBranchBase?.trim()) {
    return task;
  }
  const mount = ctx.host.require(workspaceId);
  return ctx.mutations.run(workspaceId, async () => {
    const current = await loadTaskEnvelope(mount.env.fs, task.path);
    const currentLaneComplete = Boolean(
      current.worktree && current.branch && current.workspace && current.targetBranch
    );
    if (currentLaneComplete && current.roleBranchBase?.trim()) {
      return current;
    }
    const lane = currentLaneComplete ? {
      workspace: current.workspace,
      worktree: current.worktree,
      branch: current.branch,
      targetBranch: current.targetBranch
    } : await ensureRoleWorkspaceIfGit(mount.workspaceRoot, current.role);
    if (!lane) return current;
    const patch = {
      updatedAt: mount.env.clock.now()
    };
    if (!currentLaneComplete) {
      patch.workspace = lane.workspace;
      patch.worktree = lane.worktree;
      patch.branch = lane.branch;
      patch.targetBranch = lane.targetBranch;
    }
    if (!current.roleBranchBase?.trim()) {
      patch.roleBranchBase = await readRoleBranchTip(lane.workspace, lane.branch);
    }
    ctx.host.markSelfWrite(workspaceId);
    return patchTaskEnvelope(mount.env.fs, current.path, patch);
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
var FETCH_BLOCKED_PORTS = /* @__PURE__ */ new Set([
  1,
  7,
  9,
  11,
  13,
  15,
  17,
  19,
  20,
  21,
  22,
  23,
  25,
  37,
  42,
  43,
  53,
  69,
  77,
  79,
  87,
  95,
  101,
  102,
  103,
  104,
  109,
  110,
  111,
  113,
  115,
  117,
  119,
  123,
  135,
  137,
  139,
  143,
  161,
  179,
  389,
  427,
  465,
  512,
  513,
  514,
  515,
  526,
  530,
  531,
  532,
  540,
  548,
  554,
  556,
  563,
  587,
  601,
  636,
  989,
  990,
  993,
  995,
  1719,
  1720,
  1723,
  2049,
  3659,
  4045,
  5060,
  5061,
  6e3,
  6566,
  6665,
  6666,
  6667,
  6668,
  6669,
  6697,
  10080
]);
function isFetchBlockedPort(port) {
  return FETCH_BLOCKED_PORTS.has(port);
}
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
  let port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    await listen(server, preferredPort, host);
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      await closeServer(server);
      throw new Error("Failed to bind Local Tent Service HTTP server");
    }
    port = addr.port;
    if (!isFetchBlockedPort(port)) break;
    await closeServer(server);
    if (preferredPort !== 0) {
      throw new Error(`Local Tent Service port ${port} is blocked by Fetch clients`);
    }
    port = 0;
  }
  if (!port) {
    throw new Error("Failed to allocate a Fetch-compatible Local Tent Service port");
  }
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve10, reject) => {
      server.close((err) => err ? reject(err) : resolve10());
    })
  };
}
function listen(server, port, host) {
  return new Promise((resolve10, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve10();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
function closeServer(server) {
  return new Promise((resolve10, reject) => {
    server.close((err) => err ? reject(err) : resolve10());
  });
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
  return new Promise((resolve10, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve10(Buffer.concat(chunks).toString("utf8")));
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

// src/service/workspace-host.ts
import { watch } from "node:fs";
import * as fs9 from "node:fs/promises";
import * as path8 from "node:path";

// src/fs/node-fs.ts
import * as fs8 from "node:fs/promises";
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
    const entries = await fs8.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path15) {
    return fs8.readFile(this.abs(path15), "utf8");
  }
  async writeFile(path15, content) {
    await fs8.mkdir(nodePath3.dirname(this.abs(path15)), { recursive: true });
    await fs8.writeFile(this.abs(path15), content, "utf8");
  }
  async exists(path15) {
    try {
      await fs8.access(this.abs(path15));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path15) {
    await fs8.mkdir(this.abs(path15), { recursive: true });
  }
  async move(from, to) {
    await fs8.mkdir(nodePath3.dirname(this.abs(to)), { recursive: true });
    await fs8.rename(this.abs(from), this.abs(to));
  }
  async remove(path15) {
    await fs8.rm(this.abs(path15), { recursive: true, force: true });
  }
  async withLock(path15, action) {
    const lockPath = this.abs(path15);
    await fs8.mkdir(nodePath3.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs8.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent is already running another write operation; try again later.");
        await fs8.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("Cannot acquire the Tent mutation lock.");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await fs8.rm(lockPath, { force: true });
    }
  }
};
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function isStaleLock(path15) {
  try {
    const stat2 = await fs8.stat(path15);
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
    const root = path8.resolve(workspaceRoot);
    const systemRoot = systemRootFromWorkspace(root);
    const rulesPath = path8.join(systemRoot, "RULES.md");
    try {
      await fs9.access(rulesPath);
    } catch {
      throw new Error(
        `No in-workspace Tent at ${systemRoot}. Expected ${TENT_SYSTEM_DIR}/RULES.md (B1 single-location model).`
      );
    }
    for (const existing of this.mounts.values()) {
      if (path8.resolve(existing.workspaceRoot) === root) {
        return this.toInfo(existing);
      }
    }
    const workspaceId = opts?.workspaceId?.trim() || makeWorkspaceId(root);
    if (this.mounts.has(workspaceId)) {
      throw new Error(`workspaceId already mounted: ${workspaceId}`);
    }
    const tentName = opts?.tentName?.trim() || path8.basename(root) || "tent";
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
  const base = path8.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "ws";
  const hash = Buffer.from(path8.resolve(workspaceRoot)).toString("base64url").slice(0, 10);
  return `ws-${base}-${hash}`;
}

// src/service/data-dir.ts
import * as fs10 from "node:fs/promises";
import * as os4 from "node:os";
import * as path9 from "node:path";
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path9.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path9.join(os4.homedir(), "AppData", "Roaming");
    return path9.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path9.join(os4.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path9.join(os4.homedir(), ".local", "state");
  return path9.join(xdg, "tent");
}
function serviceEndpointPath(dataDir) {
  return path9.join(dataDir, "service.json");
}
async function writeServiceEndpoint(dataDir, record) {
  const file = serviceEndpointPath(dataDir);
  await writeJsonAtomic(file, record);
  return file;
}
async function readServiceEndpoint(dataDir) {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs10.readFile(file, "utf8");
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
async function removeServiceEndpoint(dataDir) {
  try {
    await fs10.rm(serviceEndpointPath(dataDir), { force: true });
  } catch {
  }
}

// src/service/tool-approval-store.ts
import * as fs11 from "node:fs/promises";
import * as path10 from "node:path";
var ToolApprovalStore = class {
  constructor(dataDir) {
    this.items = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
    this.loaded = false;
    /** Serialize mutations + persist (same pattern as SessionRegistry write chain). */
    this.chain = Promise.resolve();
    this.file = path10.join(dataDir, "tool-approvals.json");
  }
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async ensureLoaded() {
    if (this.loaded) return;
    return this.enqueue(async () => {
      if (this.loaded) return;
      try {
        const raw = await fs11.readFile(this.file, "utf8");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        const items = parsed.items;
        if (items !== void 0 && !Array.isArray(items)) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        for (const item of items ?? []) {
          if (item?.id) this.items.set(item.id, item);
        }
        this.loaded = true;
      } catch (err) {
        if (isNotFoundError(err)) {
          this.loaded = true;
          return;
        }
        throw err;
      }
    });
  }
  async listPending(workspaceId) {
    await this.ensureLoaded();
    await this.expireStale();
    return [...this.items.values()].filter(
      (i) => i.status === "pending" && (!workspaceId || i.workspaceId === workspaceId)
    );
  }
  async get(id) {
    await this.ensureLoaded();
    await this.expireStale(id);
    return this.items.get(id);
  }
  async add(item) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      this.items.set(item.id, { ...item });
      await this.persistUnlocked();
      return this.items.get(item.id);
    });
  }
  /**
   * User-only resolve. Agent callers must not reach this via RPC auth (handlers enforce).
   * approve → allow_once at ACP layer; deny → cancelled.
   * Late approve after expire/deny/cancel fails (status !== pending).
   */
  async resolve(id, decision, resolvedBy) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      await this.expireStaleUnlocked(id);
      const item = this.items.get(id);
      if (!item) throw new Error(`Tool approval not found: ${id}`);
      if (item.status !== "pending") {
        throw new Error(`Tool approval already ${item.status}: ${id}`);
      }
      item.status = decision;
      item.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
      item.resolvedBy = resolvedBy;
      this.items.set(id, item);
      await this.persistUnlocked();
      this.notifyWaiters(id, decision);
      return item;
    });
  }
  /**
   * Wait until user resolves or store-authoritative expiry. Returns approved | denied | expired.
   * Used by adapter onPermissionAsk bridge (service-owned).
   * timeoutMs bounds the wait; expireOne mutates the same record so late approve fails.
   */
  waitForDecision(id, timeoutMs) {
    return new Promise((resolve10) => {
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const list = this.waiters.get(id);
        if (list) {
          this.waiters.set(
            id,
            list.filter((w) => w.resolve !== finish)
          );
          if ((this.waiters.get(id) ?? []).length === 0) this.waiters.delete(id);
        }
        resolve10(status);
      };
      void this.get(id).then((item) => {
        if (settled) return;
        if (!item) {
          finish("expired");
          return;
        }
        if (item.status === "approved" || item.status === "denied") {
          finish(item.status);
          return;
        }
        if (item.status === "expired") {
          finish("expired");
          return;
        }
        const list = this.waiters.get(id) ?? [];
        list.push({ resolve: finish });
        this.waiters.set(id, list);
      });
      const timer = setTimeout(() => {
        void this.expireOne(id).then((status) => {
          if (status === "approved" || status === "denied") {
            finish(status);
            return;
          }
          finish("expired");
        });
      }, Math.max(1, timeoutMs));
    });
  }
  /** Cancel all pending for a session (session stop / fail). */
  async cancelSession(sessionId, reason = "denied") {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      let changed = false;
      for (const item of this.items.values()) {
        if (item.sessionId !== sessionId || item.status !== "pending") continue;
        item.status = reason;
        item.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
        item.resolvedBy = "service";
        this.items.set(item.id, item);
        this.notifyWaiters(item.id, reason === "expired" ? "expired" : "denied");
        changed = true;
      }
      if (changed) await this.persistUnlocked();
    });
  }
  /**
   * Force-expire one pending item (timeout authority / fail-safe).
   * Idempotent: returns current terminal status if already resolved.
   */
  async expireOne(id) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item) return "expired";
      if (item.status !== "pending") return item.status;
      item.status = "expired";
      item.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
      item.resolvedBy = "timeout";
      this.items.set(id, item);
      await this.persistUnlocked();
      this.notifyWaiters(id, "expired");
      return "expired";
    });
  }
  notifyWaiters(id, status) {
    const list = this.waiters.get(id);
    if (!list?.length) return;
    this.waiters.delete(id);
    for (const w of list) w.resolve(status);
  }
  async expireStale(onlyId) {
    return this.enqueue(async () => {
      await this.expireStaleUnlocked(onlyId);
    });
  }
  async expireStaleUnlocked(onlyId) {
    const now = Date.now();
    let changed = false;
    for (const item of this.items.values()) {
      if (onlyId && item.id !== onlyId) continue;
      if (item.status !== "pending") continue;
      const exp = Date.parse(item.expiresAt);
      if (!Number.isFinite(exp) || exp > now) continue;
      item.status = "expired";
      item.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
      item.resolvedBy = "timeout";
      this.items.set(item.id, item);
      this.notifyWaiters(item.id, "expired");
      changed = true;
    }
    if (changed) await this.persistUnlocked();
  }
  /**
   * Atomic temp-file + rename so a crashed mid-write cannot leave a partial file,
   * and concurrent readers never observe a torn document. Call only under enqueue.
   */
  async persistUnlocked() {
    const items = [...this.items.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || "")).slice(0, 50);
    await writeJsonAtomic(this.file, { items: [...pending, ...terminal] });
  }
  async quarantineCorrupt() {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.items.clear();
  }
};
function makeToolApprovalId(rand = Math.random) {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "ta-";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

// src/service/credential-store.ts
import * as fs12 from "node:fs/promises";
import * as path11 from "node:path";

// src/service/credential-protector.ts
import { spawn as spawn3 } from "node:child_process";
var NON_WINDOWS_MSG = "CredentialStore requires Windows DPAPI (CurrentUser); non-Windows is not supported in this MVP (no weak-crypto fallback)";
function createPlatformCredentialProtector(platform = process.platform) {
  if (platform !== "win32") {
    return {
      protect: async () => {
        throw new Error(NON_WINDOWS_MSG);
      },
      unprotect: async () => {
        throw new Error(NON_WINDOWS_MSG);
      }
    };
  }
  return createWindowsDpapiProtector();
}
function createWindowsDpapiProtector() {
  return {
    protect: async (plaintext) => {
      const b64In = Buffer.from(plaintext, "utf8").toString("base64");
      const b64Out = await runPowerShellStdin(
        [
          "Add-Type -AssemblyName System.Security",
          "$b64 = [Console]::In.ReadToEnd().Trim()",
          "$plain = [Convert]::FromBase64String($b64)",
          "$prot = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[Convert]::ToBase64String($prot)"
        ].join("; "),
        b64In,
        "protect"
      );
      return b64Out.trim();
    },
    unprotect: async (ciphertext) => {
      const b64Out = await runPowerShellStdin(
        [
          "Add-Type -AssemblyName System.Security",
          "$b64 = [Console]::In.ReadToEnd().Trim()",
          "$prot = [Convert]::FromBase64String($b64)",
          "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
          "[Convert]::ToBase64String($plain)"
        ].join("; "),
        ciphertext.trim(),
        "unprotect"
      );
      return Buffer.from(b64Out.trim(), "base64").toString("utf8");
    }
  };
}
function runPowerShellStdin(command, stdinData, op) {
  return new Promise((resolve10, reject) => {
    const child = spawn3(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    let stdout = "";
    child.stderr?.on("data", () => {
    });
    child.stdout?.on("data", (chunk) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `DPAPI PowerShell ${op} failed to start: ${err instanceof Error ? err.message : "spawn error"}`
        )
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`DPAPI PowerShell ${op} failed (exit=${code ?? "null"})`));
        return;
      }
      resolve10(stdout.replace(/^\uFEFF/, "").replace(/\r?\n$/, ""));
    });
    child.stdin?.on("error", (err) => {
      reject(
        new Error(
          `DPAPI PowerShell ${op} stdin failed: ${err instanceof Error ? err.message : "stdin error"}`
        )
      );
    });
    child.stdin?.end(stdinData, "utf8");
  });
}

// src/service/credential-store.ts
var CREDENTIAL_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
var MAX_SECRET_BYTES = 64 * 1024;
var MAX_LABEL_LEN = 200;
function credentialsPath(dataDir) {
  return path11.join(dataDir, "credentials.json");
}
function assertCredentialId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Missing or invalid credential id");
  }
  const trimmed = id.trim();
  if (!CREDENTIAL_ID_RE.test(trimmed)) {
    throw new Error(
      `Invalid credential id: must match ${CREDENTIAL_ID_RE} (lowercase letter, then a-z0-9-, max 63)`
    );
  }
  return trimmed;
}
function project(rec) {
  const out = {
    id: rec.id,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt
  };
  if (rec.metadata?.label) {
    out.label = rec.metadata.label;
    out.metadata = { label: rec.metadata.label };
  }
  return out;
}
function normalizeSetOpts(opts) {
  if (opts === void 0) return void 0;
  if (opts === null) return null;
  if ("metadata" in opts && opts.metadata !== void 0) {
    return normalizeMetadata(opts.metadata);
  }
  if ("label" in opts) {
    if (opts.label === null) return null;
    if (opts.label === void 0) return void 0;
    return normalizeMetadata({ label: opts.label });
  }
  return normalizeMetadata(opts);
}
function normalizeMetadata(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid credential metadata: must be a plain object when set");
  }
  const obj = raw;
  const out = {};
  if ("label" in obj) {
    if (obj.label === void 0 || obj.label === null) {
    } else if (typeof obj.label !== "string") {
      throw new Error("Invalid credential metadata.label: must be a string");
    } else {
      const t = obj.label.trim();
      if (!t) throw new Error("Invalid credential metadata.label: must be non-empty when set");
      if (t.length > MAX_LABEL_LEN) {
        throw new Error(
          `Invalid credential metadata.label: exceeds ${MAX_LABEL_LEN} characters`
        );
      }
      out.label = t;
    }
  }
  for (const key of Object.keys(obj)) {
    if (key !== "label") {
      throw new Error(`Unknown credential metadata field: ${key}`);
    }
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
var CredentialStore = class {
  constructor(dataDir, options) {
    this.records = /* @__PURE__ */ new Map();
    this.loaded = false;
    this.chain = Promise.resolve();
    this.file = credentialsPath(dataDir);
    if (options && typeof options === "object" && "protect" in options && "unprotect" in options) {
      this.protector = options;
    } else if (options && typeof options === "object" && "protector" in options) {
      this.protector = options.protector ?? createPlatformCredentialProtector();
    } else {
      this.protector = createPlatformCredentialProtector();
    }
  }
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async ensureLoaded() {
    if (this.loaded) return;
    return this.enqueue(async () => {
      if (this.loaded) return;
      await this.loadFromDisk();
    });
  }
  async loadFromDisk() {
    try {
      const raw = await fs12.readFile(this.file, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      const list = parsed.credentials;
      if (list !== void 0 && !Array.isArray(list)) {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      this.records.clear();
      for (const item of list ?? []) {
        if (item && typeof item.id === "string" && typeof item.ciphertext === "string" && item.ciphertext.length > 0 && typeof item.createdAt === "string" && typeof item.updatedAt === "string") {
          const rec = {
            id: item.id,
            ciphertext: item.ciphertext,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          };
          let metaSrc = item.metadata;
          if (!metaSrc && typeof item.label === "string") {
            metaSrc = { label: item.label };
          }
          if (metaSrc) {
            try {
              const meta = normalizeMetadata(metaSrc);
              if (meta) rec.metadata = meta;
            } catch {
            }
          }
          this.records.set(item.id, rec);
        }
      }
      this.loaded = true;
    } catch (err) {
      if (isNotFoundError(err)) {
        this.loaded = true;
        return;
      }
      throw err;
    }
  }
  async quarantineCorrupt() {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.records.clear();
  }
  async persist() {
    const credentials = [...this.records.values()].map((r) => {
      const row = {
        id: r.id,
        ciphertext: r.ciphertext,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      };
      if (r.metadata) row.metadata = { ...r.metadata };
      return row;
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    await writeJsonAtomic(this.file, { credentials });
  }
  /**
   * Sync presence after ensureLoaded (projection helper).
   * Call ensureLoaded() first from async handlers when needed.
   */
  has(idRaw) {
    try {
      const id = assertCredentialId(idRaw);
      return this.records.has(id);
    } catch {
      return false;
    }
  }
  async list() {
    await this.ensureLoaded();
    return this.enqueue(
      async () => [...this.records.values()].map(project).sort((a, b) => a.id.localeCompare(b.id))
    );
  }
  /**
   * Store secret under id. Overwrites ciphertext if id exists.
   * Response is id/metadata only — never echoes secret or ciphertext.
   */
  async set(idRaw, secret, opts) {
    const id = assertCredentialId(idRaw);
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("credential secret must be a non-empty string");
    }
    if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
      throw new Error(`credential secret exceeds ${MAX_SECRET_BYTES} bytes`);
    }
    const metaNorm = normalizeSetOpts(opts);
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const ciphertext = await this.protector.protect(secret);
      if (typeof ciphertext !== "string" || !ciphertext.trim()) {
        throw new Error("credential protect() returned empty ciphertext");
      }
      if (ciphertext === secret) {
        throw new Error("credential protect() must not return plaintext");
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const prev = this.records.get(id);
      const record = {
        id,
        ciphertext: ciphertext.trim(),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now
      };
      if (opts !== void 0) {
        if (metaNorm === null) {
        } else if (metaNorm !== void 0) {
          record.metadata = metaNorm;
        }
      } else if (prev?.metadata) {
        record.metadata = { ...prev.metadata };
      }
      this.records.set(id, record);
      try {
        await this.persist();
      } catch (err) {
        if (prev) this.records.set(id, prev);
        else this.records.delete(id);
        throw err;
      }
      return project(record);
    });
  }
  async delete(idRaw) {
    const id = assertCredentialId(idRaw);
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (!this.records.has(id)) {
        throw new Error(`Credential not found: ${id}`);
      }
      const prev = this.records.get(id);
      this.records.delete(id);
      try {
        await this.persist();
      } catch (err) {
        this.records.set(id, prev);
        throw err;
      }
      return { deleted: id };
    });
  }
  /**
   * Service-internal only — returns plaintext for LaunchPlan.env injection.
   * Never exposed as client RPC. Fail-loud when missing.
   */
  async resolve(idRaw) {
    const id = assertCredentialId(idRaw);
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const rec = this.records.get(id);
      if (!rec) {
        throw new Error(`Credential not found: ${id}`);
      }
      const plain = await this.protector.unprotect(rec.ciphertext);
      if (typeof plain !== "string" || !plain) {
        throw new Error(`Credential unprotect failed for ${id}`);
      }
      return plain;
    });
  }
};

// src/service/profile-catalog.ts
var PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
var ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var MAX_TIMEOUT_MS = 24 * 60 * 6e4;
var PERMISSION_POLICIES = /* @__PURE__ */ new Set(["allow", "ask", "deny"]);
var DANGEROUS_FIELD_HINTS = [
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "authorization",
  "bearer",
  "env",
  "fake",
  "command",
  "args",
  "displayNameKey",
  "grokAcp",
  "acp"
];
function rejectUnknownAndDangerous(raw, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (allowedSet.has(key)) continue;
    const lower = key.toLowerCase();
    const dangerous = DANGEROUS_FIELD_HINTS.some(
      (d) => lower === d.toLowerCase() || lower.includes(d.toLowerCase())
    );
    if (dangerous || lower.includes("secret") || lower.includes("token") || lower.includes("apikey")) {
      throw new RpcError(
        -32602,
        `Rejected dangerous or unsupported profile field: ${key}`
      );
    }
    throw new RpcError(-32602, `Unknown profile field: ${key}`);
  }
}
function requireProfileId2(raw, field = "id") {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RpcError(-32602, `Missing or invalid string param: ${field}`);
  }
  const id = raw.trim();
  if (!PROFILE_ID_RE.test(id)) {
    throw new RpcError(
      -32602,
      `Invalid profile id: must match ${PROFILE_ID_RE} (lowercase letter, then a-z0-9-, max 63)`
    );
  }
  return id;
}
function optionalNonEmptyString(raw, key) {
  if (!(key in raw) || raw[key] === void 0 || raw[key] === null) return void 0;
  if (typeof raw[key] !== "string") {
    throw new RpcError(-32602, `Invalid string param: ${key}`);
  }
  const v = raw[key].trim();
  if (!v) {
    throw new RpcError(-32602, `Invalid string param: ${key} must be non-empty when set`);
  }
  return v;
}
function clearableNonEmptyString(raw, key) {
  if (!(key in raw) || raw[key] === void 0) return void 0;
  if (raw[key] === null) return null;
  if (typeof raw[key] !== "string") {
    throw new RpcError(-32602, `Invalid string param: ${key}`);
  }
  const v = raw[key].trim();
  if (!v) {
    throw new RpcError(-32602, `Invalid string param: ${key} must be non-empty when set`);
  }
  return v;
}
function optionalEnvKey(raw, key) {
  const v = optionalNonEmptyString(raw, key);
  if (v === void 0) return void 0;
  if (!ENV_KEY_RE.test(v)) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`
    );
  }
  return v;
}
function clearableEnvKey(raw, key) {
  const v = clearableNonEmptyString(raw, key);
  if (v === void 0 || v === null) return v;
  if (!ENV_KEY_RE.test(v)) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a process env name (A-Za-z_ then A-Za-z0-9_)`
    );
  }
  return v;
}
function optionalCredentialRef(raw) {
  const v = optionalNonEmptyString(raw, "credentialRef");
  if (v === void 0) return void 0;
  try {
    return assertCredentialId(v);
  } catch (err) {
    throw new RpcError(
      -32602,
      err instanceof Error ? err.message.replace(/^Invalid credential id/, "Invalid credentialRef") : `Invalid credentialRef: must match ${CREDENTIAL_ID_RE}`
    );
  }
}
function clearableCredentialRef(raw) {
  const v = clearableNonEmptyString(raw, "credentialRef");
  if (v === void 0 || v === null) return v;
  try {
    return assertCredentialId(v);
  } catch (err) {
    throw new RpcError(
      -32602,
      err instanceof Error ? err.message.replace(/^Invalid credential id/, "Invalid credentialRef") : `Invalid credentialRef: must match ${CREDENTIAL_ID_RE}`
    );
  }
}
function validateBaseUrl(v) {
  let parsed;
  try {
    parsed = new URL(v);
  } catch {
    throw new RpcError(-32602, "Invalid baseUrl: must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RpcError(-32602, "Invalid baseUrl: only http: and https: are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new RpcError(
      -32602,
      "Invalid baseUrl: username/password in URL are not allowed"
    );
  }
  if (parsed.search || parsed.hash) {
    throw new RpcError(
      -32602,
      "Invalid baseUrl: query string and hash fragment are not allowed"
    );
  }
  return v;
}
function optionalBaseUrl(raw) {
  const v = optionalNonEmptyString(raw, "baseUrl");
  if (v === void 0) return void 0;
  return validateBaseUrl(v);
}
function clearableBaseUrl(raw) {
  const v = clearableNonEmptyString(raw, "baseUrl");
  if (v === void 0 || v === null) return v;
  return validateBaseUrl(v);
}
function optionalPermissionPolicy(raw) {
  if (!("permissionPolicy" in raw) || raw.permissionPolicy === void 0 || raw.permissionPolicy === null) {
    return void 0;
  }
  if (typeof raw.permissionPolicy !== "string") {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  const v = raw.permissionPolicy;
  if (!PERMISSION_POLICIES.has(v)) {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  return v;
}
function clearablePermissionPolicy(raw) {
  if (!("permissionPolicy" in raw) || raw.permissionPolicy === void 0) return void 0;
  if (raw.permissionPolicy === null) return null;
  if (typeof raw.permissionPolicy !== "string") {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  const v = raw.permissionPolicy;
  if (!PERMISSION_POLICIES.has(v)) {
    throw new RpcError(-32602, "Invalid permissionPolicy: must be allow|ask|deny");
  }
  return v;
}
function optionalPositiveInt(raw, key) {
  if (!(key in raw) || raw[key] === void 0 || raw[key] === null) return void 0;
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_TIMEOUT_MS) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a positive integer no greater than ${MAX_TIMEOUT_MS}`
    );
  }
  return v;
}
function clearablePositiveInt(raw, key) {
  if (!(key in raw) || raw[key] === void 0) return void 0;
  if (raw[key] === null) return null;
  const v = raw[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > MAX_TIMEOUT_MS) {
    throw new RpcError(
      -32602,
      `Invalid ${key}: must be a positive integer no greater than ${MAX_TIMEOUT_MS}`
    );
  }
  return v;
}
function parseAcpFieldsCreate(raw) {
  const displayName = optionalNonEmptyString(raw, "displayName");
  const acp = {};
  const model = optionalNonEmptyString(raw, "model");
  if (model !== void 0) acp.model = model;
  const executable = optionalNonEmptyString(raw, "executable");
  if (executable !== void 0) acp.executable = executable;
  const envKey = optionalEnvKey(raw, "envKey");
  if (envKey !== void 0) acp.envKey = envKey;
  const credentialRef = optionalCredentialRef(raw);
  if (credentialRef !== void 0) acp.credentialRef = credentialRef;
  const baseUrlEnvKey = optionalEnvKey(raw, "baseUrlEnvKey");
  if (baseUrlEnvKey !== void 0) acp.baseUrlEnvKey = baseUrlEnvKey;
  const baseUrl = optionalBaseUrl(raw);
  if (baseUrl !== void 0) acp.baseUrl = baseUrl;
  const permissionPolicy = optionalPermissionPolicy(raw);
  if (permissionPolicy !== void 0) acp.permissionPolicy = permissionPolicy;
  const promptTimeoutMs = optionalPositiveInt(raw, "promptTimeoutMs");
  if (promptTimeoutMs !== void 0) acp.promptTimeoutMs = promptTimeoutMs;
  const permissionTimeoutMs = optionalPositiveInt(raw, "permissionTimeoutMs");
  if (permissionTimeoutMs !== void 0) acp.permissionTimeoutMs = permissionTimeoutMs;
  return { displayName, acp };
}
function parseAcpFieldsUpdate(raw) {
  return {
    displayName: clearableNonEmptyString(raw, "displayName"),
    model: clearableNonEmptyString(raw, "model"),
    executable: clearableNonEmptyString(raw, "executable"),
    envKey: clearableEnvKey(raw, "envKey"),
    credentialRef: clearableCredentialRef(raw),
    baseUrlEnvKey: clearableEnvKey(raw, "baseUrlEnvKey"),
    baseUrl: clearableBaseUrl(raw),
    permissionPolicy: clearablePermissionPolicy(raw),
    promptTimeoutMs: clearablePositiveInt(raw, "promptTimeoutMs"),
    permissionTimeoutMs: clearablePositiveInt(raw, "permissionTimeoutMs")
  };
}
function applyClearablePatch(current, patch) {
  const next = {
    ...current,
    acp: current.acp ? { ...current.acp } : {}
  };
  const g = next.acp;
  if (patch.displayName === null) {
    delete next.displayName;
  } else if (patch.displayName !== void 0) {
    next.displayName = patch.displayName;
  }
  const assign = (key, value) => {
    if (value === void 0) return;
    if (value === null) {
      delete g[key];
      return;
    }
    g[key] = value;
  };
  assign("model", patch.model);
  assign("executable", patch.executable);
  assign("envKey", patch.envKey);
  assign(
    "credentialRef",
    patch.credentialRef
  );
  assign(
    "baseUrlEnvKey",
    patch.baseUrlEnvKey
  );
  assign("baseUrl", patch.baseUrl);
  assign(
    "permissionPolicy",
    patch.permissionPolicy
  );
  assign(
    "promptTimeoutMs",
    patch.promptTimeoutMs
  );
  assign(
    "permissionTimeoutMs",
    patch.permissionTimeoutMs
  );
  return next;
}
function applyCreateDefaults(adapterId, acp) {
  if (!acp.permissionPolicy) acp.permissionPolicy = "deny";
  if (adapterId === GROK_ACP_ADAPTER_ID) {
    if (!acp.model) acp.model = DEFAULT_GROK_MODEL;
    if (!acp.envKey) acp.envKey = DEFAULT_GROK_ENV_KEY;
    if (!acp.baseUrlEnvKey) acp.baseUrlEnvKey = DEFAULT_GROK_BASE_URL_ENV_KEY;
  }
}
function parseCreateAdapterId(raw) {
  if (!("adapterId" in raw) || raw.adapterId === void 0 || raw.adapterId === null) {
    return GROK_ACP_ADAPTER_ID;
  }
  if (typeof raw.adapterId !== "string" || !raw.adapterId.trim()) {
    throw new RpcError(-32602, "Invalid string param: adapterId");
  }
  const id = raw.adapterId.trim();
  if (!isProductAcpAdapterId(id)) {
    throw new RpcError(
      -32602,
      `Unsupported adapterId for product profile CRUD: ${id}. Allowed: ${PRODUCT_ACP_ADAPTER_IDS.join(", ")} (not a universal provider router)`
    );
  }
  return id;
}
function assertProductCrudAdapter(adapterId, op) {
  if (!isProductAcpAdapterId(adapterId)) {
    throw new RpcError(
      -32602,
      `Product profile ${op} only supports adapterIds: ${PRODUCT_ACP_ADAPTER_IDS.join(", ")} (got ${adapterId})`
    );
  }
}
var AgentProfileCatalog = class {
  constructor(dataDir, runtime, initial, opts) {
    this.dataDir = dataDir;
    this.runtime = runtime;
    this.chain = Promise.resolve();
    const source = initial.some((p) => p.id === FAKE_DEFAULT_PROFILE_ID) ? initial : [
      ...initial,
      defaultAgentProfiles().find((p) => p.id === FAKE_DEFAULT_PROFILE_ID)
    ];
    this.profiles = source.map((p) => cloneAgentProfileConfig(p));
    this.persistToDisk = opts?.persistToDisk !== false;
    this.saveProfiles = opts?.saveProfiles ?? saveAgentProfiles;
    this.runtime.replaceProfileCatalog(this.profiles);
  }
  enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  list() {
    return this.profiles.map((p) => cloneAgentProfileConfig(p));
  }
  get(id) {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return void 0;
    return cloneAgentProfileConfig(p);
  }
  /**
   * Atomic commit: persist next first (when enabled); only then swap memory + runtime.
   * Write failure leaves this.profiles and runtime on the previous snapshot.
   */
  async commit(next) {
    if (this.persistToDisk) {
      await this.saveProfiles(this.dataDir, next);
    }
    this.profiles = next;
    this.runtime.replaceProfileCatalog(this.profiles);
  }
  async create(raw) {
    return this.enqueue(async () => {
      rejectUnknownAndDangerous(raw, PROFILE_CREATE_FIELDS);
      const id = requireProfileId2(raw.id);
      if (this.profiles.some((p) => p.id === id)) {
        throw new RpcError(-32009, `Profile already exists: ${id}`);
      }
      if (id === FAKE_DEFAULT_PROFILE_ID) {
        throw new RpcError(-32602, "Cannot create reserved test profile id: fake-default");
      }
      const adapterId = parseCreateAdapterId(raw);
      const { displayName, acp } = parseAcpFieldsCreate(raw);
      applyCreateDefaults(adapterId, acp);
      const profile = {
        id,
        adapterId,
        ...displayName !== void 0 ? { displayName } : {},
        acp
      };
      await this.commit([...this.profiles, profile]);
      return this.get(id);
    });
  }
  async update(idRaw, raw) {
    return this.enqueue(async () => {
      const id = requireProfileId2(idRaw);
      if ("id" in raw) {
        throw new RpcError(-32602, "id cannot be updated; omit id from profile body");
      }
      if ("adapterId" in raw) {
        throw new RpcError(-32602, "adapterId cannot be updated; omit adapterId from profile body");
      }
      rejectUnknownAndDangerous(raw, PROFILE_UPDATE_FIELDS);
      const idx = this.profiles.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new RpcError(-32004, `Profile not found: ${id}`);
      }
      const current = this.profiles[idx];
      if (isTestOnlyProfile(current) || current.id === FAKE_DEFAULT_PROFILE_ID) {
        throw new RpcError(
          -32602,
          "Test-only profile fake-default cannot be modified via product CRUD"
        );
      }
      assertProductCrudAdapter(current.adapterId, "update");
      const nextProfile = applyClearablePatch(current, parseAcpFieldsUpdate(raw));
      await this.commit(this.profiles.map((p, i) => i === idx ? nextProfile : p));
      return this.get(id);
    });
  }
  async delete(idRaw) {
    return this.enqueue(async () => {
      const id = requireProfileId2(idRaw);
      const idx = this.profiles.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new RpcError(-32004, `Profile not found: ${id}`);
      }
      const current = this.profiles[idx];
      if (isTestOnlyProfile(current) || current.id === FAKE_DEFAULT_PROFILE_ID) {
        throw new RpcError(
          -32602,
          "Test-only profile fake-default cannot be deleted via product CRUD"
        );
      }
      if (isBuiltinDefaultProfileId(current.id)) {
        throw new RpcError(
          -32602,
          `Built-in profile ${current.id} cannot be deleted`
        );
      }
      assertProductCrudAdapter(current.adapterId, "delete");
      const sessions = await this.runtime.registry.list();
      const active = sessions.filter(
        (s) => s.profileId === id && SessionRegistry.isNonTerminal(s.state)
      );
      if (active.length > 0) {
        throw new RpcError(
          -32022,
          `Cannot delete profile ${id}: ${active.length} non-terminal session(s) still use it`,
          { sessionIds: active.map((s) => s.id) }
        );
      }
      await this.commit(this.profiles.filter((p) => p.id !== id));
      return { deleted: id };
    });
  }
};

// src/runtime/agent-runtime.ts
import * as path12 from "node:path";

// src/runtime/process-supervisor.ts
import { spawn as spawn4 } from "node:child_process";
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
    const child = spawn4(launch.command, launch.args, {
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
    await new Promise((resolve10) => {
      const done = () => {
        if (live.killTimer) {
          clearTimeout(live.killTimer);
          live.killTimer = void 0;
        }
        resolve10();
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
      await new Promise((resolve10) => {
        const killer = spawn4("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.on("exit", () => resolve10());
        killer.on("error", () => resolve10());
        setTimeout(resolve10, 1500);
      });
    } else {
      try {
        live.child.kill("SIGKILL");
      } catch {
      }
    }
    if (!live.exited) {
      await new Promise((resolve10) => {
        const t = setTimeout(resolve10, 500);
        live.child.once("exit", () => {
          clearTimeout(t);
          resolve10();
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
function cloneProfileConfig(p) {
  return cloneAgentProfileConfig(p);
}
var AgentRuntime = class {
  constructor(options) {
    this.profiles = /* @__PURE__ */ new Map();
    this.adapters = /* @__PURE__ */ new Map();
    this.managed = /* @__PURE__ */ new Map();
    this.resumeInFlight = /* @__PURE__ */ new Map();
    this.sinks = /* @__PURE__ */ new Map();
    this.globalSinks = /* @__PURE__ */ new Set();
    this.closed = false;
    this.registry = new SessionRegistry(options.dataDir);
    this.resolveProfileEnv = options.resolveProfileEnv;
    for (const p of options.profiles ?? []) {
      this.profiles.set(p.id, cloneProfileConfig(p));
    }
    if (!this.profiles.has("fake-default")) {
      this.profiles.set("fake-default", {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true }
      });
    }
    const adapterList = options.adapters ?? [
      createFakeAdapter(),
      createGrokAcpAdapter(),
      createCodexAcpAdapter(),
      createClaudeAcpAdapter(),
      createAntigravityAcpAdapter(),
      createOpenCodeAcpAdapter(),
      createCopilotAcpAdapter()
    ];
    for (const a of adapterList) {
      this.adapters.set(a.id, a);
    }
    if (!this.adapters.has(FAKE_ADAPTER_ID)) {
      this.adapters.set(FAKE_ADAPTER_ID, createFakeAdapter());
    }
    if (!this.adapters.has(GROK_ACP_ADAPTER_ID)) {
      this.adapters.set(GROK_ACP_ADAPTER_ID, createGrokAcpAdapter());
    }
    if (!this.adapters.has(CODEX_ACP_ADAPTER_ID)) {
      this.adapters.set(CODEX_ACP_ADAPTER_ID, createCodexAcpAdapter());
    }
    if (!this.adapters.has(CLAUDE_ACP_ADAPTER_ID)) {
      this.adapters.set(CLAUDE_ACP_ADAPTER_ID, createClaudeAcpAdapter());
    }
    if (!this.adapters.has(ANTIGRAVITY_ACP_ADAPTER_ID)) {
      this.adapters.set(ANTIGRAVITY_ACP_ADAPTER_ID, createAntigravityAcpAdapter());
    }
    if (!this.adapters.has(OPENCODE_ACP_ADAPTER_ID)) {
      this.adapters.set(OPENCODE_ACP_ADAPTER_ID, createOpenCodeAcpAdapter());
    }
    if (!this.adapters.has(COPILOT_ACP_ADAPTER_ID)) {
      this.adapters.set(COPILOT_ACP_ADAPTER_ID, createCopilotAcpAdapter());
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
    this.profiles.set(profile.id, cloneProfileConfig(profile));
  }
  /**
   * Full replace of the in-memory profile catalog (machine-local CRUD sync).
   * Does not touch live sessions — only new startSession sees the new map.
   * Always re-ensures fake-default for harness (same rule as constructor).
   * Stores shallow clones of profile + acp so callers cannot mutate the map.
   */
  replaceProfileCatalog(profiles) {
    this.profiles.clear();
    for (const p of profiles) {
      if (p && typeof p.id === "string") {
        this.profiles.set(p.id, cloneProfileConfig(p));
      }
    }
    if (!this.profiles.has("fake-default")) {
      this.profiles.set("fake-default", {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true }
      });
    }
  }
  /** Lookup a single machine-local profile (cloned; mutating the return does not corrupt the Map). */
  getProfile(profileId) {
    const p = this.profiles.get(profileId);
    return p ? cloneProfileConfig(p) : void 0;
  }
  /** Machine-local catalog snapshot (cloned entries). */
  listProfiles() {
    return [...this.profiles.values()].map(cloneProfileConfig);
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
      const resolvedEnv = await this.resolveCredentialEnv(profile);
      const plan = {
        sessionId: req.sessionId,
        profileId: profile.id,
        roleName: req.roleName,
        cwd,
        env: { ...profile.env ?? {}, ...req.env ?? {}, ...resolvedEnv },
        bootstrapPrompt: req.bootstrapPrompt,
        command: profile.command,
        args: profile.args,
        extras: {
          fake: profile.fake,
          acp: profile.acp
        }
      };
      let pid;
      let resumeToken;
      let sawLive = false;
      let terminalDuringManagedStart;
      if (typeof adapter.startManagedSession === "function") {
        const managed = await adapter.startManagedSession(plan, (ev) => {
          if (ev.type === "session.live") sawLive = true;
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            void this.onManagedTerminal(req.sessionId, "failed", ev.error);
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode
            };
            void this.onManagedTerminal(req.sessionId, "stopped", void 0, ev.exitCode);
          } else if (ev.type === "session.waiting_user") {
            void this.registry.update(req.sessionId, { state: "waiting-user" }).catch(() => void 0);
          } else if (ev.type === "session.live") {
            void this.registry.update(req.sessionId, {
              state: "live",
              ...ev.pid != null ? { pid: ev.pid } : {}
            }).catch(() => void 0);
          }
          this.emit(ev);
        });
        if (terminalDuringManagedStart) {
          const terminal = terminalDuringManagedStart;
          await this.onManagedTerminal(
            req.sessionId,
            terminal.state,
            terminal.state === "failed" ? terminal.error : void 0,
            terminal.state === "stopped" ? terminal.exitCode : void 0
          );
          throw Object.assign(
            new Error(
              terminal.state === "failed" ? terminal.error : `Managed session exited during startup (code=${terminal.exitCode})`
            ),
            { terminalAlreadyEmitted: true }
          );
        }
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
      if (!err?.terminalAlreadyEmitted) {
        this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
      }
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
    const tokenRaw = req.resumeToken ?? record.resumeToken;
    if (!tokenRaw) {
      throw new Error(`Session ${req.sessionId} has no resume token`);
    }
    if (!adapter.capabilities().canResume && !profile.fake?.canResume) {
      throw new Error(`Adapter ${adapter.id} cannot resume`);
    }
    const recordedCwd = record.runtimeWorkspace?.cwd;
    const requestedCwd = req.runtimeWorkspace?.cwd ?? req.cwd;
    if (recordedCwd && requestedCwd && !sameRuntimeCwd(recordedCwd, requestedCwd)) {
      throw new Error(
        `resumeSession cwd mismatch: recorded=${recordedCwd} requested=${requestedCwd}`
      );
    }
    const cwd = recordedCwd ?? requestedCwd;
    if (!cwd) throw new Error("resumeSession requires a cwd");
    if (profile.fake?.canResume && typeof adapter.resumeManagedSession !== "function") {
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
    if (typeof adapter.resumeManagedSession !== "function") {
      throw new Error(
        `Adapter ${adapter.id} advertises canResume but does not implement resumeManagedSession`
      );
    }
    const resumeManagedSession = adapter.resumeManagedSession.bind(adapter);
    const existingResume = this.resumeInFlight.get(req.sessionId);
    if (existingResume) return existingResume;
    const operation = (async () => {
      let resumedManaged;
      if (SessionRegistry.isNonTerminal(record.state)) {
        const managed = this.managed.get(req.sessionId);
        if (managed?.isAlive()) {
          throw new Error(`Session already active: ${req.sessionId}`);
        }
        this.managed.delete(req.sessionId);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await this.registry.update(req.sessionId, {
        state: "starting",
        pid: void 0,
        lastError: void 0,
        exitCode: void 0,
        stopReason: void 0,
        runtimeWorkspace: { cwd },
        updatedAt: now
      });
      this.emit({ type: "session.starting", sessionId: req.sessionId });
      try {
        const resolvedEnv = await this.resolveCredentialEnv(profile);
        const plan = {
          sessionId: req.sessionId,
          profileId: profile.id,
          roleName: record.roleName,
          cwd,
          env: { ...profile.env ?? {}, ...req.env ?? {}, ...resolvedEnv },
          bootstrapPrompt: req.bootstrapPrompt,
          command: profile.command,
          args: profile.args,
          extras: {
            fake: profile.fake,
            acp: profile.acp
          }
        };
        const resumeToken = adapter.parseResumeToken ? adapter.parseResumeToken(tokenRaw) : { raw: tokenRaw, providerSessionId: tokenRaw };
        let sawLive = false;
        let terminalDuringManagedStart;
        const managed = await resumeManagedSession(
          plan,
          resumeToken,
          (ev) => {
            if (ev.type === "session.live") sawLive = true;
            if (ev.type === "session.failed") {
              terminalDuringManagedStart = { state: "failed", error: ev.error };
              void this.onManagedTerminal(req.sessionId, "failed", ev.error);
            } else if (ev.type === "session.exited") {
              terminalDuringManagedStart = {
                state: "stopped",
                exitCode: ev.exitCode
              };
              void this.onManagedTerminal(
                req.sessionId,
                "stopped",
                void 0,
                ev.exitCode
              );
            } else if (ev.type === "session.waiting_user") {
              void this.registry.update(req.sessionId, { state: "waiting-user" }).catch(() => void 0);
            } else if (ev.type === "session.live") {
              void this.registry.update(req.sessionId, {
                state: "live",
                ...ev.pid != null ? { pid: ev.pid } : {}
              }).catch(() => void 0);
            }
            this.emit(ev);
          }
        );
        resumedManaged = managed;
        if (terminalDuringManagedStart) {
          const terminal = terminalDuringManagedStart;
          await this.onManagedTerminal(
            req.sessionId,
            terminal.state,
            terminal.state === "failed" ? terminal.error : void 0,
            terminal.state === "stopped" ? terminal.exitCode : void 0
          );
          throw Object.assign(
            new Error(
              terminal.state === "failed" ? terminal.error : `Managed session exited during resume (code=${terminal.exitCode})`
            ),
            { terminalAlreadyEmitted: true }
          );
        }
        this.managed.set(req.sessionId, managed);
        const pid = managed.pid;
        const nextToken = managed.providerSessionId?.trim() || tokenRaw;
        const live = await this.registry.update(req.sessionId, {
          state: "live",
          pid,
          resumeToken: nextToken,
          lastError: void 0,
          exitCode: void 0,
          stopReason: void 0,
          runtimeWorkspace: { cwd }
        });
        if (!sawLive) {
          this.emit({ type: "session.live", sessionId: req.sessionId, pid });
        }
        return handleFrom(live);
      } catch (err) {
        this.managed.delete(req.sessionId);
        if (resumedManaged) {
          await resumedManaged.stop("interrupt").catch(() => void 0);
        }
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message = redactRuntimeValue(rawMessage, tokenRaw);
        const failed = await this.registry.update(req.sessionId, {
          state: "failed",
          lastError: message,
          pid: void 0
        });
        if (!err?.terminalAlreadyEmitted) {
          this.emit({ type: "session.failed", sessionId: req.sessionId, error: message });
        }
        throw Object.assign(new Error(message), { session: handleFrom(failed) });
      }
    })();
    this.resumeInFlight.set(req.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.resumeInFlight.get(req.sessionId) === operation) {
        this.resumeInFlight.delete(req.sessionId);
      }
    }
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
  /**
   * Managed ACP terminal path (no ProcessSupervisor exit). Idempotent:
   * second failure/exit does not illegal-transition the session row.
   */
  async onManagedTerminal(sessionId, terminalState, lastError, exitCode) {
    this.managed.delete(sessionId);
    const record = await this.registry.read(sessionId);
    if (!record) return;
    if (!SessionRegistry.isNonTerminal(record.state) && record.state !== "starting") {
      await this.registry.update(sessionId, {
        pid: void 0,
        ...lastError ? { lastError } : {},
        ...exitCode !== void 0 ? { exitCode } : {}
      });
      return;
    }
    await this.registry.update(sessionId, {
      state: terminalState,
      pid: void 0,
      lastError: lastError ?? record.lastError,
      ...exitCode !== void 0 ? { exitCode } : {}
    });
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
  /**
   * When profile.acp.credentialRef is set, call resolveProfileEnv and require
   * a non-empty value for profile.acp.envKey. Fail-loud otherwise.
   * Never persists secrets onto SessionRecord.
   */
  async resolveCredentialEnv(profile) {
    const ref = typeof profile.acp?.credentialRef === "string" ? profile.acp.credentialRef.trim() : "";
    if (!ref) return {};
    const envKey = typeof profile.acp?.envKey === "string" ? profile.acp.envKey.trim() : "";
    if (!envKey) {
      throw new Error(
        `Profile ${profile.id} has credentialRef but no acp.envKey (cannot inject secret into process env)`
      );
    }
    if (!this.resolveProfileEnv) {
      throw new Error(
        `Profile ${profile.id} references credential ${ref} but AgentRuntime has no resolveProfileEnv hook`
      );
    }
    const resolved = { ...await this.resolveProfileEnv(profile) };
    const secret = resolved[envKey];
    if (typeof secret !== "string" || !secret) {
      throw new Error(
        `Credential not found or empty for profile ${profile.id} (credentialRef=${ref})`
      );
    }
    return { [envKey]: secret };
  }
  assertOpen() {
    if (this.closed) throw new Error("AgentRuntime is shut down");
  }
};
function sameRuntimeCwd(left, right) {
  const a = path12.resolve(left);
  const b = path12.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function redactRuntimeValue(message, value) {
  return value ? message.split(value).join("[provider-session]") : message;
}
function createAgentRuntime(options) {
  return new AgentRuntime(options);
}

// src/service/service.ts
import * as os5 from "node:os";
import * as path13 from "node:path";
import { fileURLToPath } from "node:url";
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
  const toolApprovals = new ToolApprovalStore(dataDir);
  await toolApprovals.ensureLoaded();
  const credentials = new CredentialStore(dataDir, {
    protector: options.credentialProtector
  });
  await credentials.ensureLoaded();
  const profilesInjected = options.profiles !== void 0;
  const profiles = profilesInjected ? options.profiles : await ensureDefaultProfiles(dataDir);
  const runtimeHolder = { current: null };
  const openToolApprovalBySession = /* @__PURE__ */ new Map();
  const acpPermissionHooks = {
    onPermissionAsk: async (info) => {
      const runtime2 = runtimeHolder.current;
      if (!runtime2) return "deny";
      const rec = await runtime2.registry.read(info.sessionId);
      const workspaceId = rec?.workspace ?? workspaceHost.getForegroundId() ?? "";
      if (!workspaceId) return "deny";
      let taskPath;
      let taskId;
      let role = rec?.roleName;
      try {
        const mount = workspaceHost.get(workspaceId);
        if (mount) {
          const tasks = await loadTaskEnvelopes(mount.env.fs);
          const task = tasks.find(
            (t) => t.sessionId === info.sessionId || !!rec?.lastTaskId && (t.id === rec.lastTaskId || t.path === rec.lastTaskId)
          );
          if (task) {
            taskPath = task.path;
            taskId = task.id || task.path;
            role = task.role || role;
          }
        }
      } catch {
      }
      const profile = rec?.profileId ? runtime2.getProfile(rec.profileId) : void 0;
      const timeoutMs = typeof profile?.acp?.permissionTimeoutMs === "number" && profile.acp.permissionTimeoutMs > 0 ? profile.acp.permissionTimeoutMs : DEFAULT_PERMISSION_TIMEOUT_MS;
      const createdAt = /* @__PURE__ */ new Date();
      const expiresAt = new Date(createdAt.getTime() + timeoutMs);
      const item = await toolApprovals.add({
        id: makeToolApprovalId(),
        workspaceId,
        sessionId: info.sessionId,
        taskId,
        taskPath,
        role,
        toolTitle: info.toolTitle || "tool",
        toolCallId: info.toolCallId,
        options: (info.options ?? []).map((o) => ({
          optionId: o.optionId,
          kind: o.kind,
          name: o.name
        })),
        status: "pending",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      });
      openToolApprovalBySession.set(info.sessionId, item.id);
      events.emit(
        "toolApproval.pending",
        workspaceId,
        {
          approvalId: item.id,
          sessionId: item.sessionId,
          taskPath: item.taskPath,
          role: item.role,
          toolTitle: item.toolTitle,
          expiresAt: item.expiresAt
        },
        "service"
      );
      try {
        const decision = await toolApprovals.waitForDecision(item.id, timeoutMs);
        return decision === "approved" ? "allow" : "deny";
      } finally {
        if (openToolApprovalBySession.get(info.sessionId) === item.id) {
          openToolApprovalBySession.delete(info.sessionId);
        }
      }
    },
    onPermissionAskFailSafe: async (info) => {
      const openId = openToolApprovalBySession.get(info.sessionId);
      if (openId) {
        try {
          await toolApprovals.expireOne(openId);
        } catch {
        }
        openToolApprovalBySession.delete(info.sessionId);
      }
      try {
        await toolApprovals.cancelSession(info.sessionId, "expired");
      } catch {
      }
    }
  };
  const runtime = createAgentRuntime({
    dataDir,
    profiles,
    adapters: [
      createFakeAdapter(),
      createGrokAcpAdapter(acpPermissionHooks),
      createCodexAcpAdapter(acpPermissionHooks),
      createClaudeAcpAdapter(acpPermissionHooks),
      createAntigravityAcpAdapter(acpPermissionHooks),
      createOpenCodeAcpAdapter(acpPermissionHooks),
      createCopilotAcpAdapter(acpPermissionHooks)
    ],
    resolveProfileEnv: async (profile) => {
      const ref = typeof profile.acp?.credentialRef === "string" ? profile.acp.credentialRef.trim() : "";
      if (!ref) return {};
      const envKey = typeof profile.acp?.envKey === "string" ? profile.acp.envKey.trim() : "";
      if (!envKey) {
        throw new Error(
          `Profile ${profile.id} has credentialRef but no acp.envKey (cannot inject secret into process env)`
        );
      }
      const secret = await credentials.resolve(ref);
      if (!secret) {
        throw new Error(
          `Credential not found or empty for profile ${profile.id} (credentialRef=${ref})`
        );
      }
      return { [envKey]: secret };
    }
  });
  runtimeHolder.current = runtime;
  const profileCatalog = new AgentProfileCatalog(dataDir, runtime, profiles, {
    // Normal boot: persist CRUD to this service dataDir.
    // options.profiles inject: in-memory only — no agent-profiles.json writes.
    persistToDisk: !profilesInjected
  });
  await runtime.reconcileOnBoot();
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const home = options.home ?? os5.homedir();
  const ctx = {
    host: workspaceHost,
    mutations,
    events,
    version,
    startedAt,
    getPid,
    runtime,
    a2a,
    toolApprovals,
    credentials,
    dataDir,
    profileCatalog,
    packageRoot,
    home,
    integrateCommits: options.integrateCommits
  };
  runtime.subscribeAll((ev) => {
    void mapRuntimeEventToService(ctx, ev);
  });
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
    credentials,
    ctx,
    endpoint,
    stop
  };
}
function defaultPackageRoot() {
  const here = path13.dirname(fileURLToPath(import.meta.url));
  if (path13.basename(here) === "service" && path13.basename(path13.dirname(here)) === "src") {
    return path13.resolve(here, "../..");
  }
  return path13.resolve(here);
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
    dataDir: dataDir ? path14.resolve(dataDir) : void 0
  });
  if (mountPath) {
    const info = await service.hostApi.mount(path14.resolve(mountPath));
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
