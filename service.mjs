#!/usr/bin/env node
#!/usr/bin/env node


// src/service/cli.ts
import * as path3 from "node:path";

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
async function backupCorruptRegistry(fs4, path4) {
  const backupPath = `${path4}.corrupt-${timestamp()}`;
  await fs4.writeFile(backupPath, await fs4.readFile(path4));
  return backupPath;
}
function warnRegistryRecovered(path4, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path4} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
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
  const path4 = relativePath2.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path4) return false;
  const top = path4.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}

// src/core/order.ts
var ROOT_KEY = "__root__";
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
async function loadTent(fs4) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs4);
  const top = await fs4.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
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
async function loadBox(fs4, path4, parent, registry) {
  if (isOperationalPath(path4)) return null;
  const boxFile = boxNotePath(path4);
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
  const name = baseName(path4);
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
    path: path4,
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
    box.invalidRootId = path4;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs4.listDir(path4);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs4, join(path4, entry.name), box, registry, box.children);
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
async function loadBoxInto(fs4, path4, parent, registry, target) {
  if (isOperationalPath(path4)) return;
  const box = await loadBox(fs4, path4, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs4.listDir(path4);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs4, join(path4, entry.name), parent, registry, target);
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
function baseName(path4) {
  const i = path4.lastIndexOf("/");
  return i === -1 ? path4 : path4.slice(i + 1);
}
function dirName(path4) {
  const i = path4.lastIndexOf("/");
  return i === -1 ? "" : path4.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs4, action) {
  return fs4.withLock ? fs4.withLock(MUTATION_LOCK_PATH, action) : action();
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
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
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
async function writeJson(fs4, path4, value) {
  if (!await fs4.exists(".tent")) await fs4.mkdir(".tent");
  await fs4.writeFile(path4, JSON.stringify(value, null, 2) + "\n");
}
function isRecord2(value) {
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
      const path4 = join(taskDir, entry.name);
      try {
        const { data } = parseFrontmatter(await fs4.readFile(path4));
        if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
          continue;
        }
        const task = {
          path: path4,
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
async function loadTaskEnvelope(fs4, path4) {
  if (!await fs4.exists(path4)) throw new Error(`Task envelope not found: ${path4}.`);
  const { data } = parseFrontmatter(await fs4.readFile(path4));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
    throw new Error(`Invalid task envelope format: ${path4}.`);
  }
  const task = {
    path: path4,
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
  return task;
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
  const path4 = join("temp", role.name, "init.md");
  const body = `# Role Init

- Tent: ${tentName}
- Rules: RULES.md
- Role registry: .tent/roles.json (or run \`tent roles\`)

## Role Prompt

${role.prompt?.trim() || "(no persistent role prompt)"}

## Operating Model

Manifest readable/writable entries are an honor-system contract, not a security sandbox. If prompts conflict or a boundary cannot be followed, stop and ask the user.
`;
  await fs4.writeFile(path4, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path4;
}
async function writeTaskEnvelope(fs4, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const dir = join("temp", input.role, "tasks");
  await ensureDir(fs4, dir);
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path4 = await uniqueMarkdownPath(fs4, dir, stem);
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
  await fs4.writeFile(path4, serializeFrontmatter(data, body));
  return path4;
}
async function ackTaskEnvelope(fs4, path4) {
  if (!await fs4.exists(path4)) throw new Error(`Task envelope not found: ${path4}.`);
  const raw = await fs4.readFile(path4);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path4}.`);
  data.status = "taken";
  await fs4.writeFile(path4, serializeFrontmatter(data, body, keyOrder));
}
function taskStem(now, claimId) {
  const stamp = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs4, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path4 = join(dir, `${stem}${suffix}.md`);
    if (!await fs4.exists(path4)) return path4;
  }
}
async function ensureDir(fs4, path4) {
  if (!await fs4.exists(path4)) await fs4.mkdir(path4);
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
      userPrompt,
      workspace: options.workspace,
      dispatchedBy: options.dispatchedBy
    });
    const relayPrompt = relayPromptForTask(
      {
        path: taskPath,
        role: roleName,
        claims: taskClaims.map((taskClaim2) => taskClaim2.id),
        manifest: manifestPath,
        status: "pending"
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
  await withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    if (task.status === "taken") {
      await ackTaskEnvelope(env.fs, taskPath);
      return;
    }
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
          `Cannot acknowledge task: ${box.name} has coordination=false (type ${box.type}); ordinary notes cannot enter the task lifecycle.`
        );
      }
      const claimable = canClaim(box);
      if (!claimable.ok) throw new Error(`Cannot acknowledge task: ${claimable.reason || "box cannot be claimed"}`);
    }
    try {
      for (const box of claimedBoxes) {
        await setOwner(env.fs, box, task.role, "doing");
        box.fm.owner = task.role;
        box.fm.status = "doing";
        box.fm.acceptedBy = void 0;
      }
      await ackTaskEnvelope(env.fs, taskPath);
    } catch (error) {
      for (const item of previous) {
        await restoreOwnerState(env.fs, item.box, item.owner, item.status, item.acceptedBy);
      }
      throw error;
    }
  });
}
function resolveDispatchClaim(tent, claimId, tentName) {
  const id = claimId.trim();
  if (id === "." || id === "root" || id === tentName) {
    throw new Error("Cannot dispatch the whole Tent directly; dispatch a specific box (boxId cannot be ., root, or the Tent name).");
  }
  const box = requireBoxById(tent, id);
  return { root: false, id: box.id, name: box.name, box };
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
  const id = makeUniqueConceptId(existing, env.rand);
  const path4 = join(input.parentPath, name);
  assertNotTempPath(path4);
  await ensureDir2(env.fs, path4);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path4), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path4);
    throw error;
  }
  return id;
}
async function patchBox(env, boxPath, patch, loadedTent) {
  await withMutation(env.fs, async () => patchBoxUnlocked(env, boxPath, patch, loadedTent));
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
  await withMutation(env.fs, async () => patchBodyUnlocked(env, boxPath, newBody, loadedTent));
}
async function patchBodyUnlocked(env, boxPath, newBody, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box || !isUsableBox(box)) throw new Error("Invalid or archived boxes cannot have their body edited.");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
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
  await fs4.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}
async function ensureDir2(fs4, path4) {
  if (path4 && !await fs4.exists(path4)) await fs4.mkdir(path4);
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
function assertNotTempPath(path4) {
  if (path4 === "temp" || path4.startsWith("temp/")) {
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
    if (task.status !== "pending") continue;
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

// src/service/etag.ts
import { createHash } from "node:crypto";
function contentEtag(content) {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);
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
  "task.dispatch",
  "task.claim",
  "task.list",
  "task.get"
];
function isClientMethod(method) {
  return CLIENT_METHODS.includes(method);
}
var PROTECTED_COLLAB_FIELDS = ["status", "owner", "assignee"];

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
    case "task.dispatch":
      return taskDispatch(ctx, p);
    case "task.claim":
      return taskClaim(ctx, p);
    case "task.list":
      return taskList(ctx, p);
    case "task.get":
      return taskGet(ctx, p);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
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
  return info;
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
  const concept = resolveConcept2(tent, p);
  return {
    workspaceId,
    concept: projectConcept(concept, true, false)
  };
}
async function docsReadForEdit(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const tent = await loadTent(mount.env.fs);
  const concept = resolveConcept2(tent, p);
  const notePath = boxNotePath(concept.path);
  const raw = await mount.env.fs.readFile(notePath);
  const { body } = parseFrontmatter(raw);
  return {
    workspaceId,
    id: concept.id,
    path: concept.path,
    body,
    etag: contentEtag(raw),
    frontmatter: concept.fm
  };
}
async function docsWrite(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const baseEtag = optionalString(p, "baseEtag") ?? optionalString(p, "etag");
  const body = typeof p.body === "string" ? p.body : void 0;
  const frontmatter = p.frontmatter && typeof p.frontmatter === "object" && !Array.isArray(p.frontmatter) ? p.frontmatter : void 0;
  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept2(tent, p);
    const notePath = boxNotePath(concept.path);
    const raw = await mount.env.fs.readFile(notePath);
    const currentEtag = contentEtag(raw);
    if (baseEtag && baseEtag !== currentEtag) {
      throw new RpcError(-32009, "etag conflict", {
        currentEtag,
        baseEtag,
        path: concept.path
      });
    }
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
      path: concept.path,
      etag: contentEtag(afterRaw),
      body: after.body
    };
  });
}
async function docsCreateNote(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const name = requireString(p, "name");
  const type = optionalString(p, "type") ?? "note";
  const parentPath = optionalString(p, "parentPath") ?? "";
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const id = await createBox(mount.env, { parentPath, name, type });
    ctx.events.emit(
      "concept.changed",
      workspaceId,
      { id, path: parentPath ? `${parentPath}/${name}` : name, reason: "docs.createNote" },
      "self"
    );
    return { workspaceId, id, path: parentPath ? `${parentPath}/${name}` : name, type };
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
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    const result = await dispatch(mount.env, boxId, role, {
      userPrompt: prompt,
      dispatchedBy
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: result.taskPath,
        state: "queued",
        role,
        boxId,
        reason: "task.dispatch"
      },
      "self"
    );
    return {
      workspaceId,
      taskPath: result.taskPath,
      manifestPath: result.manifestPath,
      initPath: result.initPath,
      relayPrompt: result.relayPrompt,
      state: "queued"
    };
  });
}
async function taskClaim(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const taskPath = requireString(p, "taskPath");
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    await taskAck(mount.env, taskPath);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: taskPath,
        state: "running",
        role: task.role,
        claims: task.claims,
        reason: "task.claim"
      },
      "self"
    );
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
      state: "running",
      role: task.role,
      claims: task.claims
    };
  });
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
function resolveConcept2(tent, p) {
  const id = optionalString(p, "id") ?? optionalString(p, "boxId");
  const path4 = optionalString(p, "path");
  if (id) {
    const byId = tent.byId.get(id);
    if (byId) return byId;
    throw new RpcError(-32004, `Concept not found: ${id}`);
  }
  if (path4) {
    const byPath = tent.byPath.get(path4);
    if (byPath) return byPath;
    throw new RpcError(-32004, `Concept not found: ${path4}`);
  }
  throw new RpcError(-32602, "docs.* requires id or path");
}
function projectConcept(box, includeBody, withChildren) {
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
  if (includeBody) {
    proj.bodyPreview = box.body.slice(0, 500);
  }
  if (withChildren) {
    proj.children = box.children.map((c) => projectConcept(c, includeBody, true));
  }
  return proj;
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
    role: task.role,
    claims: task.claims,
    status: task.status,
    manifest: task.manifest,
    dispatchedBy: task.dispatchedBy,
    workspaceLane: lane
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

// src/service/http-server.ts
async function createServiceHttpServer(options) {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 0;
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options.ctx, options.events);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
  });
  await new Promise((resolve5, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, host, () => resolve5());
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
    close: () => new Promise((resolve5, reject) => {
      server.close((err) => err ? reject(err) : resolve5());
    })
  };
}
async function handleRequest(req, res, ctx, events) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    const body = await dispatchMethod(ctx, "service.health", {});
    writeJson2(res, 200, body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/events") {
    handleSse(req, res, events);
    return;
  }
  if (req.method === "POST" && (url.pathname === "/rpc" || url.pathname === "/")) {
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
  return new Promise((resolve5, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve5(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// src/service/events.ts
import { randomBytes } from "node:crypto";
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
      id: `ev-${Date.now().toString(36)}-${(++this.seq).toString(36)}-${randomBytes(3).toString("hex")}`,
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
    const gate = new Promise((resolve5) => {
      release = resolve5;
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
import * as fs2 from "node:fs/promises";
import * as path from "node:path";

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
  async readFile(path4) {
    return fs.readFile(this.abs(path4), "utf8");
  }
  async writeFile(path4, content) {
    await fs.mkdir(nodePath.dirname(this.abs(path4)), { recursive: true });
    await fs.writeFile(this.abs(path4), content, "utf8");
  }
  async exists(path4) {
    try {
      await fs.access(this.abs(path4));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path4) {
    await fs.mkdir(this.abs(path4), { recursive: true });
  }
  async move(from, to) {
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }
  async remove(path4) {
    await fs.rm(this.abs(path4), { recursive: true, force: true });
  }
  async withLock(path4, action) {
    const lockPath = this.abs(path4);
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
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function isStaleLock(path4) {
  try {
    const stat2 = await fs.stat(path4);
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
    const root = path.resolve(workspaceRoot);
    const systemRoot = systemRootFromWorkspace(root);
    const rulesPath = path.join(systemRoot, "RULES.md");
    try {
      await fs2.access(rulesPath);
    } catch {
      throw new Error(
        `No in-workspace Tent at ${systemRoot}. Expected ${TENT_SYSTEM_DIR}/RULES.md (B1 single-location model).`
      );
    }
    for (const existing of this.mounts.values()) {
      if (path.resolve(existing.workspaceRoot) === root) {
        return this.toInfo(existing);
      }
    }
    const workspaceId = opts?.workspaceId?.trim() || makeWorkspaceId(root);
    if (this.mounts.has(workspaceId)) {
      throw new Error(`workspaceId already mounted: ${workspaceId}`);
    }
    const tentName = opts?.tentName?.trim() || path.basename(root) || "tent";
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
  const base = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "ws";
  const hash = Buffer.from(path.resolve(workspaceRoot)).toString("base64url").slice(0, 10);
  return `ws-${base}-${hash}`;
}

// src/service/data-dir.ts
import * as fs3 from "node:fs/promises";
import * as os from "node:os";
import * as path2 from "node:path";
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path2.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path2.join(os.homedir(), "AppData", "Roaming");
    return path2.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path2.join(os.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path2.join(os.homedir(), ".local", "state");
  return path2.join(xdg, "tent");
}
function serviceEndpointPath(dataDir) {
  return path2.join(dataDir, "service.json");
}
async function writeServiceEndpoint(dataDir, record) {
  await fs3.mkdir(dataDir, { recursive: true });
  const file = serviceEndpointPath(dataDir);
  await fs3.writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return file;
}
async function readServiceEndpoint(dataDir) {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs3.readFile(file, "utf8");
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
    await fs3.rm(serviceEndpointPath(dataDir), { force: true });
  } catch {
  }
}

// src/service/service.ts
var SERVICE_VERSION = "0.1.0-b2";
async function startLocalTentService(options = {}) {
  const dataDir = options.dataDir ?? defaultServiceDataDir();
  const version = options.version ?? SERVICE_VERSION;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const getPid = options.getPid ?? (() => process.pid);
  const events = new EventBus();
  const mutations = new MutationBus();
  const workspaceHost = new WorkspaceHost({ events });
  const ctx = {
    host: workspaceHost,
    mutations,
    events,
    version,
    startedAt,
    getPid
  };
  const httpServer = await createServiceHttpServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    ctx,
    events
  });
  let endpoint = null;
  if (options.writeEndpoint !== false) {
    endpoint = {
      pid: getPid(),
      host: httpServer.host,
      port: httpServer.port,
      startedAt,
      version
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
    events,
    hostApi: workspaceHost,
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
        "tent-service \u2014 Local Tent Service (B2)",
        "",
        "Usage:",
        "  tent-service start [--port <n>] [--data-dir <path>] [--mount <workspace>]",
        "  tent-service status",
        "",
        "Environment:",
        "  TENT_SERVICE_DATA_DIR  machine-local data area (default: %APPDATA%/Tent)",
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
    dataDir: dataDir ? path3.resolve(dataDir) : void 0
  });
  if (mountPath) {
    const info = await service.hostApi.mount(path3.resolve(mountPath));
    process.stdout.write(`Mounted ${info.workspaceRoot} as ${info.workspaceId}
`);
  }
  process.stdout.write(
    `Local Tent Service listening on ${service.url}
dataDir: ${service.dataDir}
pid: ${process.pid}
Attach: POST ${service.url}/rpc  |  events: GET ${service.url}/events
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
