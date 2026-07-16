#!/usr/bin/env node

var __defProp = Object.defineProperty;
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};

// src/service/cli.ts
import * as path15 from "node:path";

// src/service/http-server.ts
import * as http from "node:http";

// src/core/frontmatter.ts
var FENCE = "---";
var BOX_FRONTMATTER_KEY_ORDER = ["id", "type", "tags"];
function parseFrontmatter(raw) {
  const text3 = raw.replace(/\r\n/g, "\n");
  if (!text3.startsWith(FENCE + "\n")) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const end = text3.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const fmBlock = text3.slice(FENCE.length + 1, end);
  const afterFence = text3.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text3.slice(afterFence + 1);
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
async function backupCorruptRegistry(fs14, path16) {
  const backupPath = `${path16}.corrupt-${timestamp()}`;
  await fs14.writeFile(backupPath, await fs14.readFile(path16));
  return backupPath;
}
function warnRegistryRecovered(path16, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path16} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
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
var AGENT_PROFILES_TEMP_DIR = "agent-profiles";
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
  const path16 = relativePath2.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path16) return false;
  const top = path16.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}
function safeOperationalSegment(value, emptyPrefix = "id") {
  const source = value.trim();
  if (!source) throw new Error("Operational segment cannot be empty.");
  const normalized = source.normalize("NFKC");
  let clean = normalized.replace(/[<>:"/\\|?*\x00-\x1f~^:[\]@{}]+/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 40);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean);
  if (reserved) clean = `${emptyPrefix}-${clean}`;
  if (!clean) {
    let h = 0;
    for (let i = 0; i < source.length; i++) h = h * 31 + source.charCodeAt(i) >>> 0;
    return `${emptyPrefix}-${h.toString(36)}`;
  }
  if (clean !== normalized || normalized !== source || reserved) {
    let h = 0;
    for (let i = 0; i < source.length; i++) h = h * 31 + source.charCodeAt(i) >>> 0;
    return `${clean}-${h.toString(36)}`;
  }
  return clean;
}
function agentProfileTempRoot(profileId) {
  return `${TEMP_DIR}/${AGENT_PROFILES_TEMP_DIR}/${safeOperationalSegment(profileId, "profile")}`;
}
function agentProfileTasksDir(profileId) {
  return `${agentProfileTempRoot(profileId)}/tasks`;
}
function agentProfileDeliveriesDir(profileId) {
  return `${agentProfileTempRoot(profileId)}/deliveries`;
}
function agentProfileManifestPath(profileId, taskId) {
  const safeTask = safeOperationalSegment(taskId, "task");
  return `${agentProfileTempRoot(profileId)}/manifests/${safeTask}.yml`;
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}

// src/core/order.ts
var ROOT_KEY = "__root__";
async function loadOrder(fs14) {
  if (!await fs14.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs14.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs14, ORDER_PATH);
    await saveOrder(fs14, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs14, map) {
  await fs14.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
function baseDefinitionCoordination(definition2) {
  if (!definition2 || definition2.tier === "modifier") return void 0;
  return definition2.coordination;
}
async function loadTypeRegistry(fs14) {
  if (!await fs14.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs14.readFile(TYPE_REGISTRY_PATH));
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
async function loadTent(fs14) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs14);
  const top = await fs14.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadBoxInto(fs14, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs14);
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
async function loadBox(fs14, path16, parent, registry) {
  if (isOperationalPath(path16)) return null;
  const boxFile = boxNotePath(path16);
  if (!await fs14.exists(boxFile)) {
    return null;
  }
  const raw = await fs14.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path16);
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
    path: path16,
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
    box.invalidRootId = path16;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs14.listDir(path16);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs14, join(path16, entry.name), box, registry, box.children);
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
async function loadBoxInto(fs14, path16, parent, registry, target) {
  if (isOperationalPath(path16)) return;
  const box = await loadBox(fs14, path16, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs14.listDir(path16);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs14, join(path16, entry.name), parent, registry, target);
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
function baseName(path16) {
  const i = path16.lastIndexOf("/");
  return i === -1 ? path16 : path16.slice(i + 1);
}
function dirName(path16) {
  const i = path16.lastIndexOf("/");
  return i === -1 ? "" : path16.slice(0, i);
}

// src/core/adapter.ts
function withTentMutation(fs14, action) {
  return fs14.withLock ? fs14.withLock(MUTATION_LOCK_PATH, action) : action();
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
async function loadRolesRegistry(fs14) {
  if (!await fs14.exists(ROLES_REGISTRY_PATH)) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs14.readFile(ROLES_REGISTRY_PATH));
    return normalizeRolesRegistry(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs14, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs14, ROLES_REGISTRY_PATH, reset);
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return reset;
  }
}
async function createRole(fs14, definition2) {
  await withTentMutation(fs14, async () => {
    const role = normalizeRole(definition2);
    if (!role.name) throw new Error("Role name cannot be empty.");
    assertRoleNameAvailable(role.name);
    const registry = await loadRolesRegistry(fs14);
    if (registry.roles.some((item) => item.name === role.name)) throw new Error(`Role already exists: ${role.name}.`);
    registry.roles.push(role);
    await writeJson(fs14, ROLES_REGISTRY_PATH, registry);
  });
}
function assertRoleNameAvailable(name) {
  if (name.trim().toLowerCase() === AGENT_PROFILES_TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${AGENT_PROFILES_TEMP_DIR}.`);
  }
}
async function updateRole(fs14, name, patch) {
  await withTentMutation(fs14, async () => {
    const registry = await loadRolesRegistry(fs14);
    const index2 = registry.roles.findIndex((role) => role.name === name);
    if (index2 === -1) throw new Error(`Role does not exist: ${name}.`);
    const next = normalizeRole({ ...registry.roles[index2], ...patch, name });
    if (Object.prototype.hasOwnProperty.call(patch, "allowedProfiles")) {
      const normalized = normalizeAllowedProfiles(patch.allowedProfiles);
      if (normalized) next.allowedProfiles = normalized;
      else delete next.allowedProfiles;
    }
    registry.roles[index2] = next;
    await writeJson(fs14, ROLES_REGISTRY_PATH, registry);
  });
}
async function deleteRole(fs14, name, confirmation) {
  await withTentMutation(fs14, async () => {
    if (confirmation !== name) throw new Error(`Confirmation mismatch; enter the role name ${name}.`);
    const registry = await loadRolesRegistry(fs14);
    const next = registry.roles.filter((role) => role.name !== name);
    if (next.length === registry.roles.length) throw new Error(`Role does not exist: ${name}.`);
    await writeJson(fs14, ROLES_REGISTRY_PATH, { roles: next });
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
async function writeJson(fs14, path16, value) {
  if (!await fs14.exists(".tent")) await fs14.mkdir(".tent");
  await fs14.writeFile(path16, JSON.stringify(value, null, 2) + "\n");
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
function assertReviewAuthority(input) {
  const actor = input.actor.trim();
  const submitter = input.submitterRole.trim();
  const action = input.action ?? "accept";
  if (!actor) {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} requires a non-empty actor.`
    );
  }
  if (actor === submitter) {
    throw new TaskLifecycleError(
      "SELF_ACCEPT_FORBIDDEN",
      `task.${action} actor must not equal delivery submitter (${submitter}).`
    );
  }
  if (input.asSub !== true) return;
  const dispatcher = (input.dispatchedBy || "").trim();
  if (actor === "user") return;
  if (dispatcher && actor === dispatcher) return;
  throw new TaskLifecycleError(
    "REVIEW_FORBIDDEN",
    `task.${action} on sub task requires actor user or dispatchedBy role` + (dispatcher ? ` (${dispatcher})` : "") + `; got ${actor}.`
  );
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
async function loadTaskEnvelopes(fs14) {
  const tasks = [];
  if (!await fs14.exists(TEMP_DIR)) return tasks;
  for (const entry of await fs14.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs14.exists(profilesRoot)) continue;
      for (const profileEntry of await fs14.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectTaskFiles(fs14, join(profilesRoot, profileEntry.name, "tasks"), tasks);
      }
      continue;
    }
    await collectTaskFiles(fs14, join(TEMP_DIR, entry.name, "tasks"), tasks);
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function collectTaskFiles(fs14, taskDir, tasks) {
  if (!await fs14.exists(taskDir)) return;
  for (const entry of await fs14.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path16 = join(taskDir, entry.name);
    try {
      tasks.push(await loadTaskEnvelope(fs14, path16));
    } catch {
    }
  }
}
function taskAssigneeKind(task) {
  return task.assigneeKind === "agentProfile" ? "agentProfile" : "role";
}
function taskAsSub(task) {
  return task.asSub === true;
}
async function loadTaskEnvelope(fs14, path16) {
  if (!await fs14.exists(path16)) throw new Error(`Task envelope not found: ${path16}.`);
  const { data, body } = parseFrontmatter(await fs14.readFile(path16));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
    throw new Error(`Invalid task envelope format: ${path16}.`);
  }
  const legacyStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);
  const task = {
    path: path16,
    role: data.role,
    claims: data.claims,
    manifest: data.manifest,
    status: stateToLegacyStatus(state),
    state,
    prompt: body.trim() || void 0
  };
  if (typeof data.id === "string" && isTaskId(data.id)) task.id = data.id;
  if (typeof data.dispatchedBy === "string") task.dispatchedBy = data.dispatchedBy;
  if (data.asSub === true) task.asSub = true;
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
  const kind = taskAssigneeKind(task);
  const taskFile = join(".tent", task.path);
  const lines = [
    `workspaceRoot: ${roots.workspaceRoot}`,
    `systemRoot: ${roots.systemRoot}`,
    `CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent), e.g. ${task.path}.`,
    `File reads: use ${taskFile} (workspace-relative) or ${roots.systemRoot.replace(/[\\/]+$/, "")}/${task.path} \u2014 never <workspaceRoot>/temp.`,
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`
  ];
  if (kind === "role") {
    const initCli = join("temp", task.role, "init.md");
    const initFile = join(".tent", "temp", task.role, "init.md");
    lines.push(`Role init file: ${initFile} (CLI path remains ${initCli}).`);
  } else {
    lines.push(
      `Assignee: agentProfile ${task.role} (one-shot; no durable role init / tent-role lane).`
    );
  }
  return lines.join("\n");
}
function relayPromptForTask(task, roots) {
  const resolved = resolveTaskPromptRoots(roots);
  const kind = taskAssigneeKind(task);
  const assigneeLine = kind === "agentProfile" ? `A Tent task has been dispatched to agentProfile ${task.role}.
` : `A Tent task has been dispatched to role ${task.role}.
`;
  const initStep = kind === "agentProfile" ? `4. Read the task envelope and task-scoped manifest pointers above; do not look for a role init file.` : `4. If this is a new session for this role, complete role init first (read the init file above).`;
  return assigneeLine + `${formatTaskPathHints(task, resolved)}
1. Run \`tent task claim ${task.path}\` to take this task (Local Service RPC).
2. Inspect with \`tent task get ${task.path}\` (or read the envelope file), then open the claimed boxes; the box notes contain the task definition.
3. When finished, run \`tent task deliver ${task.path} --summary <text>\` (optional: --commits sha,sha).
` + initStep;
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
  const kind = taskAssigneeKind(task);
  const readyLine = kind === "agentProfile" ? `A Tent managed ACP session is ready for agentProfile ${task.role}.
` : `A Tent managed ACP session is ready for role ${task.role}.
`;
  return readyLine + `${formatTaskPathHints(task, resolved)}
Service status: this task is already claimed (state=${task.state || "running"}).
Managed path: skip Local Service claim/get/deliver CLI steps (tool permissions may deny them).
Your final assistant reply is the report: Local Service will capture it and submit delivery automatically (manual review stays pending; no auto-accept).
Context Card / path pointers above identify the task; optional deeper reads only if tools are allowed.
` + (kind === "agentProfile" ? `One-shot agentProfile task: rely on task/manifest pointers only \u2014 no role init.
` : "") + (userPrompt ? `
## User Prompt

${userPrompt}
` : `
## User Prompt

(no user prompt on envelope)
`);
}
async function ensureRoleInit(fs14, role, tentName) {
  const path16 = join("temp", role.name, "init.md");
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
  await fs14.writeFile(path16, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path16;
}
async function writeTaskEnvelope(fs14, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const assigneeKind = input.assigneeKind ?? "role";
  const dir = input.tasksDir?.trim() || (assigneeKind === "agentProfile" ? agentProfileTasksDir(input.role) : join(TEMP_DIR, input.role, "tasks"));
  await ensureDir(fs14, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path16 = await uniqueMarkdownPath(fs14, dir, stem);
  const now = clock.now();
  const data = {
    type: "task",
    id,
    status: "pending",
    state: "queued",
    role: input.role,
    assigneeKind,
    dispatchedBy: input.dispatchedBy?.trim() || "user",
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath,
    deliveryPolicy: input.deliveryPolicy ?? "manual",
    createdAt: now,
    updatedAt: now
  };
  if (input.asSub === true) data.asSub = true;
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
  await fs14.writeFile(path16, serializeFrontmatter(data, body));
  return path16;
}
async function ackTaskEnvelope(fs14, path16) {
  await patchTaskEnvelope(fs14, path16, {
    status: "taken",
    state: "running"
  });
}
async function patchTaskEnvelope(fs14, path16, patch) {
  if (!await fs14.exists(path16)) throw new Error(`Task envelope not found: ${path16}.`);
  const raw = await fs14.readFile(path16);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path16}.`);
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
  await fs14.writeFile(path16, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs14, path16);
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
async function uniqueMarkdownPath(fs14, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path16 = join(dir, `${stem}${suffix}.md`);
    if (!await fs14.exists(path16)) return path16;
  }
}
async function ensureDir(fs14, path16) {
  if (!await fs14.exists(path16)) await fs14.mkdir(path16);
}

// src/core/report.ts
async function loadReports(fs14) {
  const reports = [];
  if (!await fs14.exists("temp")) return reports;
  for (const roleDir of await fs14.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "reports");
    if (!await fs14.exists(dir)) continue;
    for (const entry of await fs14.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path16 = join(dir, entry.name);
      try {
        reports.push(await loadReport(fs14, path16));
      } catch {
      }
    }
  }
  return reports.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}
async function loadReport(fs14, inputPath) {
  const path16 = normalizeReportPath(inputPath);
  if (!await fs14.exists(path16)) throw new Error(`Report not found: ${path16}.`);
  const { data, body } = parseFrontmatter(await fs14.readFile(path16));
  if (data.type !== "report" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "ready" && data.status !== "rejected") {
    throw new Error(`Invalid report format: ${path16}.`);
  }
  return {
    path: path16,
    boxId: data.box,
    role: data.role,
    status: data.status,
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((item) => typeof item === "string")) : [],
    timestamp: typeof data.ts === "string" ? data.ts : void 0,
    review: typeof data.review === "string" ? data.review : void 0,
    body: body.trim()
  };
}
async function removeReportsForBox(fs14, boxId) {
  for (const report of await loadReports(fs14)) {
    if (report.boxId === boxId && await fs14.exists(report.path)) await fs14.remove(report.path);
  }
}
function normalizeReportPath(input) {
  const path16 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/reports\/[bc]x-[^/]+\.md$/.test(path16)) {
    throw new Error("Report must point to temp/<role>/reports/<boxId>.md.");
  }
  return path16;
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
async function createDeliveryUnlocked(fs14, clock, input) {
  const summary = input.summary.trim();
  if (!summary) throw new Error("Delivery summary cannot be empty.");
  const now = clock.now();
  const id = input.id && isDeliveryId(input.id) ? input.id : makeDeliveryId();
  const deliveriesDir = input.deliveriesDir?.trim() || join(TEMP_DIR, input.role, "deliveries");
  await ensureDir2(fs14, deliveriesDir);
  const path16 = join(deliveriesDir, `${id}.md`);
  if (await fs14.exists(path16)) throw new Error(`Delivery already exists: ${path16}.`);
  const record = {
    path: path16,
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
  await writeDelivery(fs14, record);
  return record;
}
async function loadDelivery(fs14, inputPath) {
  const path16 = normalizeDeliveryPath(inputPath);
  if (!await fs14.exists(path16)) throw new Error(`Delivery not found: ${path16}.`);
  const { data, body } = parseFrontmatter(await fs14.readFile(path16));
  if (data.type !== "delivery" || typeof data.id !== "string" || !isDeliveryId(data.id)) {
    throw new Error(`Invalid delivery format: ${path16}.`);
  }
  if (typeof data.taskId !== "string" || typeof data.boxId !== "string" || typeof data.role !== "string") {
    throw new Error(`Invalid delivery format: ${path16}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : void 0;
  const reviewDecision = data.reviewDecision === "accept" || data.reviewDecision === "reject" ? data.reviewDecision : void 0;
  return {
    path: path16,
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
async function loadDeliveries(fs14, filter) {
  const out = [];
  if (!await fs14.exists(TEMP_DIR)) return out;
  for (const entry of await fs14.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs14.exists(profilesRoot)) continue;
      for (const profileEntry of await fs14.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectDeliveryFiles(
          fs14,
          join(profilesRoot, profileEntry.name, "deliveries"),
          filter,
          out
        );
      }
      continue;
    }
    await collectDeliveryFiles(fs14, join(TEMP_DIR, entry.name, "deliveries"), filter, out);
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
async function collectDeliveryFiles(fs14, dir, filter, out) {
  if (!await fs14.exists(dir)) return;
  for (const entry of await fs14.listDir(dir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    try {
      const d = await loadDelivery(fs14, join(dir, entry.name));
      if (filter?.taskId && d.taskId !== filter.taskId) continue;
      if (filter?.boxId && d.boxId !== filter.boxId) continue;
      out.push(d);
    } catch {
    }
  }
}
async function writeDelivery(fs14, record) {
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
  await fs14.writeFile(record.path, serializeFrontmatter(data, record.summary + "\n", KEY_ORDER));
}
function normalizeDeliveryPath(input) {
  const path16 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path16) && !/^temp\/agent-profiles\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path16)) {
    throw new Error(
      "Delivery must point to temp/<role>/deliveries/<dl-id>.md or temp/agent-profiles/<profile>/deliveries/<dl-id>.md."
    );
  }
  return path16;
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
function parseJsonArrayField(value, parse2) {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return parse2(JSON.parse(value));
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
async function ensureDir2(fs14, path16) {
  if (!await fs14.exists(path16)) await fs14.mkdir(path16);
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
    const previous2 = claimedBoxes.map((box) => ({
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
      for (const item of previous2) {
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
        integrationMode: routing.integrationMode,
        deliveriesDir: deliveryDirForTask(task)
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
      integrationMode: routing.integrationMode,
      deliveriesDir: deliveryDirForTask(task)
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
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      asSub: taskAsSub(task),
      dispatchedBy: task.dispatchedBy,
      action: "accept"
    });
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
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      asSub: taskAsSub(task),
      dispatchedBy: task.dispatchedBy,
      action: "reject"
    });
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
async function findActiveTaskForBox(fs14, boxId) {
  const tasks = await loadTaskEnvelopes(fs14);
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
    // assignee is the stable label (role name or profileId).
    assignee: proj.clearAssignee ? void 0 : task.role,
    activeTaskId: task.id || task.path
  };
}
function deliveryDirForTask(task) {
  if (taskAssigneeKind(task) === "agentProfile") {
    return agentProfileDeliveriesDir(task.role);
  }
  return void 0;
}
async function requireActiveReadyDelivery(fs14, task) {
  if (task.activeDeliveryId) {
    const byId = (await loadDeliveries(fs14, { taskId: task.id || task.path })).find(
      (d) => d.id === task.activeDeliveryId
    );
    if (byId && byId.status === "ready") return byId;
    if (byId) {
    }
  }
  const ready = (await loadDeliveries(fs14, { taskId: task.id || task.path })).find((d) => d.status === "ready");
  if (!ready) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No ready delivery for this task.");
  }
  return ready;
}
async function projectAssignee(fs14, box, owner, status, acceptedBy) {
  const patch = { owner: owner ?? void 0 };
  if (owner) patch.acceptedBy = void 0;
  else if (acceptedBy) patch.acceptedBy = acceptedBy;
  if (status) patch.status = status;
  await patchFrontmatter(fs14, box, patch);
}
async function restoreProjection(fs14, box, owner, status, acceptedBy) {
  await patchFrontmatter(fs14, box, {
    owner: owner ?? void 0,
    status: status ?? void 0,
    acceptedBy: acceptedBy ?? void 0
  });
}
async function patchFrontmatter(fs14, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs14.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  const order = [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...keyOrder.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
  await fs14.writeFile(boxFile, serializeFrontmatter(data, body, order));
}
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs14, action) {
  return withTentMutation(fs14, action);
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
async function uniqueSiblingPath(fs14, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join(parentPath, name);
    if (!await fs14.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs14, from, to) {
  await fs14.mkdir(to);
  for (const entry of await fs14.listDir(from)) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDir) await copyTree(fs14, src, dst);
    else await fs14.writeFile(dst, await fs14.readFile(src));
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
async function ensureIdentityFileName(fs14, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs14.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join(newBoxPath, oldName);
  if (await fs14.exists(copied)) await fs14.move(copied, expected);
}

// src/core/ops.ts
async function dispatch(env, claimId, role, promptOrOptions) {
  return withMutation2(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}
async function dispatchUnlocked(env, claimId, role, promptOrOptions) {
  const tent = await loadTent(env.fs);
  const options = typeof promptOrOptions === "string" ? { userPrompt: promptOrOptions } : promptOrOptions;
  const assigneeKind = options.assigneeKind === "agentProfile" ? "agentProfile" : "role";
  const userPrompt = options.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  let assigneeLabel;
  if (assigneeKind === "agentProfile") {
    const profileId = options.profileId?.trim() || "";
    if (!profileId) {
      throw new Error("Dispatch with assigneeKind=agentProfile requires profileId.");
    }
    if (role?.trim() && role.trim() !== profileId) {
      throw new Error(
        "Dispatch with assigneeKind=agentProfile must not pass a different role; use profileId as the assignee label."
      );
    }
    assigneeLabel = assertProfileId(profileId);
  } else {
    const roleName = role?.trim() || "";
    if (!roleName) throw new Error("Dispatch with assigneeKind=role requires role.");
    assigneeLabel = assertRoleName(roleName);
  }
  const claim = resolveDispatchClaim(tent, claimId, env.tentName);
  const tasks = await loadTaskEnvelopes(env.fs);
  const createdRoot = assigneeKind === "agentProfile" ? agentProfileTempRoot(assigneeLabel) : join("temp", assigneeLabel);
  const createdRootExisted = await env.fs.exists(createdRoot);
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
    const roleClaims = claim.root ? [] : assigneeKind === "role" ? roleManifestClaims(tent, assigneeLabel, claim.box, tasks) : [claim.box];
    const input = claim.root ? { tentName: env.tentName, role: assigneeLabel, claimRoot: true, ...options.workspace } : { tentName: env.tentName, role: assigneeLabel, claimBoxes: roleClaims, ...options.workspace };
    const manifest = buildManifest(tent, input);
    const yaml = manifestToYaml(manifest);
    const taskId = options.taskId && options.taskId.trim() ? options.taskId.trim() : makeTaskId();
    let manifestPath;
    let initPath;
    if (assigneeKind === "agentProfile") {
      manifestPath = agentProfileManifestPath(assigneeLabel, taskId);
      await ensureDir3(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
    } else {
      manifestPath = join("temp", assigneeLabel, "manifest.yml");
      await ensureDir3(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
      const registry = await loadRolesRegistry(env.fs);
      const roleDefinition = registry.roles.find((item) => item.name === assigneeLabel) ?? { name: assigneeLabel };
      initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
    }
    const taskClaims = claim.root ? [{ id: "root", path: "./" }] : [{ id: claim.box.id, path: claim.box.path }];
    const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
      role: assigneeLabel,
      claims: taskClaims,
      manifestPath,
      userPrompt,
      workspace: options.workspace,
      dispatchedBy: options.dispatchedBy,
      asSub: options.asSub === true,
      deliveryPolicy: options.deliveryPolicy,
      assigneeKind,
      id: taskId,
      tasksDir: assigneeKind === "agentProfile" ? agentProfileTasksDir(assigneeLabel) : void 0
    });
    const relayPrompt = relayPromptForTask(
      {
        path: taskPath,
        role: assigneeLabel,
        claims: taskClaims.map((taskClaim2) => taskClaim2.id),
        manifest: manifestPath,
        status: "pending",
        state: "queued",
        assigneeKind,
        id: taskId
      },
      env.tentRoot || env.tentName
    );
    return {
      manifestPath,
      manifestYaml: yaml,
      initPath,
      taskPath,
      relayPrompt,
      assigneeKind,
      assignee: assigneeLabel
    };
  } catch (error) {
    if (!createdRootExisted && await env.fs.exists(createdRoot)) {
      await env.fs.remove(createdRoot);
    }
    throw error;
  }
}
function assertProfileId(profileId) {
  const id = profileId.trim();
  if (!id) throw new Error("profileId cannot be empty.");
  if (/[\/\\\r\n]/.test(id)) {
    throw new Error("profileId cannot contain path separators or newlines.");
  }
  return id;
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
  const path16 = join(input.parentPath, name);
  assertNotTempPath(path16);
  await ensureDir3(env.fs, path16);
  const fm = { id, type: input.type };
  const content3 = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path16), content3);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path16);
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
async function ensureDir3(fs14, path16) {
  if (path16 && !await fs14.exists(path16)) await fs14.mkdir(path16);
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
function assertNotTempPath(path16) {
  if (path16 === "temp" || path16.startsWith("temp/")) {
    throw new Error("temp/ is a system pipeline; typed boxes cannot be created or moved there.");
  }
}
function assertRoleName(role) {
  const name = role.trim();
  if (!name) throw new Error("Role name cannot be empty.");
  if (/[\/\\\r\n]/.test(name)) throw new Error("Role name cannot contain path separators or newlines.");
  assertRoleNameAvailable(name);
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
    if (taskAssigneeKind(task) !== "role") continue;
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
async function withMutation2(fs14, action) {
  return withTentMutation(fs14, action);
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

// src/markdown/attachments.ts
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function sanitizeAttachmentFileName(fileName) {
  const source = fileName.normalize("NFKC");
  if (!source.trim()) throw new Error("Attachment file name is required");
  if (source.includes("/") || source.includes("\\") || source === "." || source === "..") {
    throw new Error("Attachment file name must be a single path segment");
  }
  let clean = source.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  if (!clean || clean === "." || clean === "..") clean = "file";
  if (clean.length > 120) {
    const ext2 = nodePath.posix.extname(clean).slice(0, 20);
    const stem2 = clean.slice(0, Math.max(1, 120 - ext2.length));
    clean = `${stem2}${ext2}`;
  }
  const ext = nodePath.posix.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) {
    clean = `file-${clean}`;
  }
  return clean;
}
function decodeBase64Strict(b64) {
  const compact = b64.replace(/\s+/g, "");
  if (!compact) throw new Error("Invalid base64: empty payload");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error("Invalid base64: non-alphabet characters");
  }
  if (compact.length % 4 !== 0) {
    throw new Error("Invalid base64: length must be a multiple of 4");
  }
  let buf;
  try {
    buf = Buffer.from(compact, "base64");
  } catch {
    throw new Error("Invalid base64: decode failed");
  }
  const reencoded = buf.toString("base64");
  if (reencoded !== compact) {
    throw new Error("Invalid base64: strict decode mismatch");
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
function assertAttachmentSize(byteLength) {
  if (byteLength < 0 || !Number.isFinite(byteLength)) {
    throw new Error("Invalid attachment size");
  }
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes (${byteLength} bytes)`
    );
  }
}
function contentId(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex").slice(0, 12);
}
function attachmentRelativePath(conceptId, safeName, bytes) {
  const id = contentId(bytes);
  const ext = nodePath.posix.extname(safeName);
  const base = nodePath.posix.basename(safeName, ext) || "file";
  return `${ATTACHMENTS_DIR}/${conceptId}/${base}-${id}${ext}`;
}
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
async function storeAttachmentBytes(fs14, conceptId, fileName, bytes, sourceNotePath) {
  if (!conceptId.trim()) throw new Error("Concept id is required");
  const safe = sanitizeAttachmentFileName(fileName);
  assertAttachmentSize(bytes.byteLength);
  const rel = attachmentRelativePath(conceptId, safe, bytes);
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.includes("..") || !normalized.startsWith(`${ATTACHMENTS_DIR}/${conceptId}/`) || normalized.split("/").some((p) => p === ".." || p === "")) {
    throw new Error(`Attachment path rejected: ${rel}`);
  }
  if (await fs14.exists(rel)) {
    const existing = await fs14.readBinary(rel);
    if (!bytesEqual(existing, bytes)) {
      throw new Error(`Attachment content-address collision at ${rel}`);
    }
    return attachmentResult(rel, safe, sourceNotePath);
  }
  await fs14.writeBinary(rel, bytes);
  return attachmentResult(rel, safe, sourceNotePath);
}
function attachmentResult(relativePath2, label, sourceNotePath) {
  const target = sourceNotePath ? nodePath.posix.relative(nodePath.posix.dirname(sourceNotePath.replace(/\\/g, "/")), relativePath2) : relativePath2;
  return {
    relativePath: relativePath2,
    markdown: `![](${target})`,
    artifactRef: { kind: "path", target: relativePath2, label }
  };
}

// src/core/proposal.ts
async function submitProposal(fs14, clock, role, boxId, body) {
  return withTentMutation(fs14, async () => submitProposalUnlocked(fs14, clock, role, boxId, body));
}
async function submitProposalUnlocked(fs14, clock, roleInput, boxId, body) {
  const text3 = body.trim();
  if (!text3) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole2(roleInput);
  const tent = await loadTent(fs14);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const path16 = proposalPath(role, box.id);
  if (await fs14.exists(path16)) {
    const current = await loadProposal(fs14, path16);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }
  const proposal = {
    path: path16,
    boxId: box.id,
    role,
    status: "pending",
    createdAt: clock.now(),
    body: text3
  };
  await ensureDir4(fs14, join("temp", role, "proposals"));
  await writeProposal(fs14, proposal);
  return proposal;
}
async function loadProposals(fs14) {
  const proposals = [];
  if (!await fs14.exists("temp")) return proposals;
  for (const roleDir of await fs14.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "proposals");
    if (!await fs14.exists(dir)) continue;
    for (const entry of await fs14.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path16 = join(dir, entry.name);
      try {
        proposals.push(await loadProposal(fs14, path16));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs14, inputPath) {
  const path16 = normalizeProposalPath(inputPath);
  if (!await fs14.exists(path16)) throw new Error(`Proposal not found: ${path16}.`);
  const { data, body } = parseFrontmatter(await fs14.readFile(path16));
  if (data.type !== "proposal" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path16}.`);
  }
  return {
    path: path16,
    boxId: data.box,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    body: body.trim()
  };
}
async function acceptProposal(fs14, inputPath) {
  await withTentMutation(fs14, async () => {
    const proposal = await loadProposal(fs14, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be accepted.");
    proposal.status = "accepted";
    await writeProposal(fs14, proposal);
  });
}
async function rejectProposal(fs14, inputPath) {
  await withTentMutation(fs14, async () => {
    const proposal = await loadProposal(fs14, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be rejected.");
    proposal.status = "rejected";
    await writeProposal(fs14, proposal);
  });
}
function proposalPath(role, boxId) {
  return join("temp", role, "proposals", `${boxId}.md`);
}
function normalizeProposalPath(input) {
  const path16 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/[bc]x-[^/]+\.md$/.test(path16)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path16;
}
async function writeProposal(fs14, proposal) {
  const data = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
  await fs14.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}
async function ensureDir4(fs14, path16) {
  if (!await fs14.exists(path16)) await fs14.mkdir(path16);
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
async function previewOperationalRetention(fs14, options = {}) {
  const keepTerminalTasksDays = normalizeKeepTerminalTasksDays(options.keepTerminalTasksDays);
  const nowMs = resolveNowMs(options.now);
  const cutoffMs = nowMs - keepTerminalTasksDays * MS_PER_DAY;
  const cutoff = new Date(cutoffMs).toISOString();
  const skipped = [];
  const warnings = [];
  const { tasks, skipped: taskSkipped } = await scanTasks(fs14);
  skipped.push(...taskSkipped);
  const { deliveries, skipped: deliverySkipped } = await scanDeliveries(fs14);
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
    const list2 = deliveriesByTaskId.get(d.taskId) ?? [];
    list2.push(d);
    deliveriesByTaskId.set(d.taskId, list2);
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
async function purgeOperationalRetention(fs14, options = {}) {
  return withTentMutation(fs14, async () => {
    const preview = await previewOperationalRetention(fs14, options);
    const purgedTaskPaths = [];
    const purgedDeliveryPaths = [];
    for (const c of preview.candidates) {
      if (c.kind === "task-group" && c.taskPath) {
        try {
          const live = await loadTaskEnvelope(fs14, c.taskPath);
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
            const liveD = await loadDelivery(fs14, dp);
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
          if (await fs14.exists(c.taskPath)) {
            await fs14.remove(c.taskPath);
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
            if (await fs14.exists(dp)) {
              await fs14.remove(dp);
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
            const liveD = await loadDelivery(fs14, dp);
            if (!isPurgeableDeliveryStatus(liveD.status)) {
              preview.warnings.push(
                `refused purge of delivery ${dp}: status=${liveD.status}`
              );
              continue;
            }
            if (await fs14.exists(dp)) {
              await fs14.remove(dp);
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
async function scanTasks(fs14) {
  const tasks = [];
  const skipped = [];
  if (!await fs14.exists("temp")) return { tasks, skipped };
  for (const roleEntry of await fs14.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    if (!isSafeRoleSegment(roleEntry.name)) {
      skipped.push({
        path: join("temp", roleEntry.name),
        reason: "unsafe role directory name"
      });
      continue;
    }
    if (roleEntry.name === "agent-profiles") {
      const profilesRoot = join("temp", "agent-profiles");
      for (const profileEntry of await fs14.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        if (!isSafeRoleSegment(profileEntry.name)) {
          skipped.push({
            path: join(profilesRoot, profileEntry.name),
            reason: "unsafe profile directory name"
          });
          continue;
        }
        await scanTaskDir(fs14, join(profilesRoot, profileEntry.name, "tasks"), tasks, skipped);
      }
      continue;
    }
    await scanTaskDir(fs14, join("temp", roleEntry.name, "tasks"), tasks, skipped);
  }
  return { tasks, skipped };
}
async function scanTaskDir(fs14, taskDir, tasks, skipped) {
  if (!await fs14.exists(taskDir)) return;
  for (const entry of await fs14.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path16 = join(taskDir, entry.name);
    try {
      tasks.push(await loadTaskEnvelope(fs14, path16));
    } catch (err) {
      skipped.push({
        path: path16,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
async function scanDeliveries(fs14) {
  const deliveries = [];
  const skipped = [];
  if (!await fs14.exists("temp")) return { deliveries, skipped };
  for (const roleEntry of await fs14.listDir("temp")) {
    if (!roleEntry.isDir) continue;
    if (!isSafeRoleSegment(roleEntry.name)) {
      skipped.push({
        path: join("temp", roleEntry.name),
        reason: "unsafe role directory name"
      });
      continue;
    }
    if (roleEntry.name === "agent-profiles") {
      const profilesRoot = join("temp", "agent-profiles");
      for (const profileEntry of await fs14.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        if (!isSafeRoleSegment(profileEntry.name)) {
          skipped.push({
            path: join(profilesRoot, profileEntry.name),
            reason: "unsafe profile directory name"
          });
          continue;
        }
        await scanDeliveryDir(
          fs14,
          join(profilesRoot, profileEntry.name, "deliveries"),
          deliveries,
          skipped
        );
      }
      continue;
    }
    await scanDeliveryDir(fs14, join("temp", roleEntry.name, "deliveries"), deliveries, skipped);
  }
  return { deliveries, skipped };
}
async function scanDeliveryDir(fs14, dir, deliveries, skipped) {
  if (!await fs14.exists(dir)) return;
  for (const entry of await fs14.listDir(dir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path16 = join(dir, entry.name);
    try {
      deliveries.push(await loadDelivery(fs14, path16));
    } catch (err) {
      skipped.push({
        path: path16,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }
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
async function loadWorkspaceSettings(fs14) {
  if (!await fs14.exists(WORKSPACE_SETTINGS_PATH)) {
    return defaultWorkspaceSettings();
  }
  try {
    const parsed = JSON.parse(await fs14.readFile(WORKSPACE_SETTINGS_PATH));
    return normalizeWorkspaceSettings(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs14, WORKSPACE_SETTINGS_PATH);
    const reset = defaultWorkspaceSettings();
    await writeSettingsUnlocked(fs14, reset);
    warnRegistryRecovered(
      WORKSPACE_SETTINGS_PATH,
      backupPath,
      "reset",
      "IMPORTANT: workspace settings cannot be inferred; restore needed keys from the backup."
    );
    return reset;
  }
}
async function updateWorkspaceSettings(fs14, patch) {
  return withTentMutation(fs14, async () => {
    if (!isRecord3(patch)) {
      throw new WorkspaceSettingsError(
        "INVALID_PATCH",
        "workspace.settings.update patch must be an object"
      );
    }
    const before = await loadWorkspaceSettings(fs14);
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
      await writeSettingsUnlocked(fs14, next);
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
async function writeSettingsUnlocked(fs14, settings) {
  const known = ["defaultDeliveryPolicy"];
  const ordered = {};
  for (const key of known) {
    if (key in settings) ordered[key] = settings[key];
  }
  const rest = Object.keys(settings).filter((k) => !known.includes(k)).sort((a, b) => a.localeCompare(b));
  for (const key of rest) {
    ordered[key] = settings[key];
  }
  await fs14.writeFile(WORKSPACE_SETTINGS_PATH, JSON.stringify(ordered, null, 2) + "\n");
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
import * as nodePath2 from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
async function findIntegratedCommit(workspace, sourceRef, targetBranch) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const full = await fullRef(root, sourceRef);
  const ancestor = await findAncestorIntegration(root, full, targetBranch);
  if (ancestor) return { integratedRef: full, reason: "ancestor" };
  const prior = await findCherryPick(root, full, targetBranch);
  if (prior) return { integratedRef: prior, reason: "cherry-pick" };
  return void 0;
}
async function readRoleBranchTip(workspace, branch) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const name = branch.trim();
  if (!name) throw new Error("Role branch name is required.");
  const ref = (await git(root, ["rev-parse", `refs/heads/${name}`])).trim();
  if (!ref) throw new Error(`Cannot read role branch tip: ${name}.`);
  return ref;
}
async function isGitWorkspace(workspace) {
  try {
    await assertGitWorkspace(nodePath2.resolve(workspace));
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
async function ensureTaskWorkspaceIfGit(workspace, taskId) {
  if (!await isGitWorkspace(workspace)) return void 0;
  return ensureTaskWorkspace(workspace, taskId);
}
async function ensureTaskWorkspace(workspace, taskId) {
  const root = nodePath2.resolve(workspace);
  await assertGitWorkspace(root);
  const id = taskId.trim();
  if (!id) throw new Error("Task id is required for task-scoped workspace lane.");
  const targetBranch = await resolveTargetBranch(root);
  const taskSlug = safeComponent(id);
  const branch = `tent-task/${taskSlug}`;
  const worktree = nodePath2.join(
    nodePath2.dirname(root),
    `${nodePath2.basename(root)}-worktrees`,
    `task-${taskSlug}`
  );
  const existing = await worktreeForBranch(root, branch);
  if (existing) {
    return {
      workspace: root,
      worktree: await nodeFs.realpath(nodePath2.resolve(existing)),
      branch,
      targetBranch
    };
  }
  if (await pathExists(worktree)) {
    throw new Error(`Task worktree path exists but is not registered to ${branch}: ${worktree}.`);
  }
  const branchExists = await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (branchExists) {
    await git(root, ["worktree", "add", worktree, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, worktree, targetBranch]);
  }
  return {
    workspace: root,
    worktree: await nodeFs.realpath(worktree),
    branch,
    targetBranch
  };
}
async function integrateWorkspaceCommits(contract, refs) {
  const commits = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (commits.length === 0) return [];
  const root = contract.workspace;
  const target = contract.targetBranch;
  const integrationCwd = await resolveIntegrationCwd(root, target);
  const current = (await git(integrationCwd, ["branch", "--show-current"])).trim();
  if (current !== target) {
    throw new Error(
      `No worktree has ${target} checked out for integration; found current branch ${current || "(detached)"} at ${integrationCwd}. Never auto-switch branches \u2014 ensure the target lane worktree exists and stays on ${target}.`
    );
  }
  const dirty = (await git(integrationCwd, ["status", "--porcelain"])).trim();
  if (dirty) {
    throw new Error(
      `Integration worktree has uncommitted changes; cannot integrate commits (${integrationCwd}).`
    );
  }
  const originalRef = (await git(root, ["rev-parse", `refs/heads/${target}`])).trim();
  const resolved = [];
  for (const sourceRef of commits) {
    await git(root, ["cat-file", "-e", `${sourceRef}^{commit}`]);
    resolved.push({ sourceRef, fullRef: await fullRef(root, sourceRef) });
  }
  const fastForwardRef = await completeFastForwardRef(
    root,
    originalRef,
    resolved.map((item) => item.fullRef)
  );
  if (fastForwardRef) {
    try {
      await git(integrationCwd, ["merge", "--ff-only", fastForwardRef]);
      return resolved.map(({ sourceRef, fullRef: integratedRef }) => ({
        sourceRef,
        integratedRef,
        alreadyIntegrated: false
      }));
    } catch (error) {
      await rollbackIntegration(integrationCwd, originalRef, error);
    }
  }
  const results = [];
  try {
    for (const { sourceRef } of resolved) {
      const ancestor = await findAncestorIntegration(root, sourceRef, target);
      if (ancestor) {
        results.push({ sourceRef, integratedRef: ancestor, alreadyIntegrated: true });
        continue;
      }
      const prior = await findCherryPick(root, sourceRef, target);
      if (prior) {
        results.push({ sourceRef, integratedRef: prior, alreadyIntegrated: true });
        continue;
      }
      await git(integrationCwd, ["cherry-pick", "-x", sourceRef]);
      const integratedRef = (await git(integrationCwd, ["rev-parse", "HEAD"])).trim();
      results.push({ sourceRef, integratedRef, alreadyIntegrated: false });
    }
  } catch (error) {
    await rollbackIntegration(integrationCwd, originalRef, error);
  }
  return results;
}
async function resolveIntegrationCwd(root, targetBranch) {
  const mainCurrent = (await git(root, ["branch", "--show-current"])).trim();
  if (mainCurrent === targetBranch) {
    return root;
  }
  const existing = await worktreeForBranch(root, targetBranch);
  if (existing) {
    const wt = await nodeFs.realpath(nodePath2.resolve(existing));
    const wtCurrent = (await git(wt, ["branch", "--show-current"])).trim();
    if (wtCurrent === targetBranch) return wt;
    throw new Error(
      `Worktree for ${targetBranch} exists at ${wt} but current branch is ${wtCurrent || "(detached)"}; never auto-switch.`
    );
  }
  throw new Error(
    `No worktree has ${targetBranch} checked out. Main workspace is on ${mainCurrent || "(detached)"}. For sub tasks ensure the dispatcher role lane (tent-role/<dispatcher>) exists.`
  );
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
async function pathExists(path16) {
  try {
    await nodeFs.access(path16);
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
import * as nodePath3 from "node:path";

// node_modules/mdast-util-to-string/lib/index.js
var emptyOptions = {};
function toString(value, options) {
  const settings = options || emptyOptions;
  const includeImageAlt = typeof settings.includeImageAlt === "boolean" ? settings.includeImageAlt : true;
  const includeHtml = typeof settings.includeHtml === "boolean" ? settings.includeHtml : true;
  return one(value, includeImageAlt, includeHtml);
}
function one(value, includeImageAlt, includeHtml) {
  if (node(value)) {
    if ("value" in value) {
      return value.type === "html" && !includeHtml ? "" : value.value;
    }
    if (includeImageAlt && "alt" in value && value.alt) {
      return value.alt;
    }
    if ("children" in value) {
      return all(value.children, includeImageAlt, includeHtml);
    }
  }
  if (Array.isArray(value)) {
    return all(value, includeImageAlt, includeHtml);
  }
  return "";
}
function all(values, includeImageAlt, includeHtml) {
  const result = [];
  let index2 = -1;
  while (++index2 < values.length) {
    result[index2] = one(values[index2], includeImageAlt, includeHtml);
  }
  return result.join("");
}
function node(value) {
  return Boolean(value && typeof value === "object");
}

// node_modules/character-entities/index.js
var characterEntities = {
  AElig: "\xC6",
  AMP: "&",
  Aacute: "\xC1",
  Abreve: "\u0102",
  Acirc: "\xC2",
  Acy: "\u0410",
  Afr: "\u{1D504}",
  Agrave: "\xC0",
  Alpha: "\u0391",
  Amacr: "\u0100",
  And: "\u2A53",
  Aogon: "\u0104",
  Aopf: "\u{1D538}",
  ApplyFunction: "\u2061",
  Aring: "\xC5",
  Ascr: "\u{1D49C}",
  Assign: "\u2254",
  Atilde: "\xC3",
  Auml: "\xC4",
  Backslash: "\u2216",
  Barv: "\u2AE7",
  Barwed: "\u2306",
  Bcy: "\u0411",
  Because: "\u2235",
  Bernoullis: "\u212C",
  Beta: "\u0392",
  Bfr: "\u{1D505}",
  Bopf: "\u{1D539}",
  Breve: "\u02D8",
  Bscr: "\u212C",
  Bumpeq: "\u224E",
  CHcy: "\u0427",
  COPY: "\xA9",
  Cacute: "\u0106",
  Cap: "\u22D2",
  CapitalDifferentialD: "\u2145",
  Cayleys: "\u212D",
  Ccaron: "\u010C",
  Ccedil: "\xC7",
  Ccirc: "\u0108",
  Cconint: "\u2230",
  Cdot: "\u010A",
  Cedilla: "\xB8",
  CenterDot: "\xB7",
  Cfr: "\u212D",
  Chi: "\u03A7",
  CircleDot: "\u2299",
  CircleMinus: "\u2296",
  CirclePlus: "\u2295",
  CircleTimes: "\u2297",
  ClockwiseContourIntegral: "\u2232",
  CloseCurlyDoubleQuote: "\u201D",
  CloseCurlyQuote: "\u2019",
  Colon: "\u2237",
  Colone: "\u2A74",
  Congruent: "\u2261",
  Conint: "\u222F",
  ContourIntegral: "\u222E",
  Copf: "\u2102",
  Coproduct: "\u2210",
  CounterClockwiseContourIntegral: "\u2233",
  Cross: "\u2A2F",
  Cscr: "\u{1D49E}",
  Cup: "\u22D3",
  CupCap: "\u224D",
  DD: "\u2145",
  DDotrahd: "\u2911",
  DJcy: "\u0402",
  DScy: "\u0405",
  DZcy: "\u040F",
  Dagger: "\u2021",
  Darr: "\u21A1",
  Dashv: "\u2AE4",
  Dcaron: "\u010E",
  Dcy: "\u0414",
  Del: "\u2207",
  Delta: "\u0394",
  Dfr: "\u{1D507}",
  DiacriticalAcute: "\xB4",
  DiacriticalDot: "\u02D9",
  DiacriticalDoubleAcute: "\u02DD",
  DiacriticalGrave: "`",
  DiacriticalTilde: "\u02DC",
  Diamond: "\u22C4",
  DifferentialD: "\u2146",
  Dopf: "\u{1D53B}",
  Dot: "\xA8",
  DotDot: "\u20DC",
  DotEqual: "\u2250",
  DoubleContourIntegral: "\u222F",
  DoubleDot: "\xA8",
  DoubleDownArrow: "\u21D3",
  DoubleLeftArrow: "\u21D0",
  DoubleLeftRightArrow: "\u21D4",
  DoubleLeftTee: "\u2AE4",
  DoubleLongLeftArrow: "\u27F8",
  DoubleLongLeftRightArrow: "\u27FA",
  DoubleLongRightArrow: "\u27F9",
  DoubleRightArrow: "\u21D2",
  DoubleRightTee: "\u22A8",
  DoubleUpArrow: "\u21D1",
  DoubleUpDownArrow: "\u21D5",
  DoubleVerticalBar: "\u2225",
  DownArrow: "\u2193",
  DownArrowBar: "\u2913",
  DownArrowUpArrow: "\u21F5",
  DownBreve: "\u0311",
  DownLeftRightVector: "\u2950",
  DownLeftTeeVector: "\u295E",
  DownLeftVector: "\u21BD",
  DownLeftVectorBar: "\u2956",
  DownRightTeeVector: "\u295F",
  DownRightVector: "\u21C1",
  DownRightVectorBar: "\u2957",
  DownTee: "\u22A4",
  DownTeeArrow: "\u21A7",
  Downarrow: "\u21D3",
  Dscr: "\u{1D49F}",
  Dstrok: "\u0110",
  ENG: "\u014A",
  ETH: "\xD0",
  Eacute: "\xC9",
  Ecaron: "\u011A",
  Ecirc: "\xCA",
  Ecy: "\u042D",
  Edot: "\u0116",
  Efr: "\u{1D508}",
  Egrave: "\xC8",
  Element: "\u2208",
  Emacr: "\u0112",
  EmptySmallSquare: "\u25FB",
  EmptyVerySmallSquare: "\u25AB",
  Eogon: "\u0118",
  Eopf: "\u{1D53C}",
  Epsilon: "\u0395",
  Equal: "\u2A75",
  EqualTilde: "\u2242",
  Equilibrium: "\u21CC",
  Escr: "\u2130",
  Esim: "\u2A73",
  Eta: "\u0397",
  Euml: "\xCB",
  Exists: "\u2203",
  ExponentialE: "\u2147",
  Fcy: "\u0424",
  Ffr: "\u{1D509}",
  FilledSmallSquare: "\u25FC",
  FilledVerySmallSquare: "\u25AA",
  Fopf: "\u{1D53D}",
  ForAll: "\u2200",
  Fouriertrf: "\u2131",
  Fscr: "\u2131",
  GJcy: "\u0403",
  GT: ">",
  Gamma: "\u0393",
  Gammad: "\u03DC",
  Gbreve: "\u011E",
  Gcedil: "\u0122",
  Gcirc: "\u011C",
  Gcy: "\u0413",
  Gdot: "\u0120",
  Gfr: "\u{1D50A}",
  Gg: "\u22D9",
  Gopf: "\u{1D53E}",
  GreaterEqual: "\u2265",
  GreaterEqualLess: "\u22DB",
  GreaterFullEqual: "\u2267",
  GreaterGreater: "\u2AA2",
  GreaterLess: "\u2277",
  GreaterSlantEqual: "\u2A7E",
  GreaterTilde: "\u2273",
  Gscr: "\u{1D4A2}",
  Gt: "\u226B",
  HARDcy: "\u042A",
  Hacek: "\u02C7",
  Hat: "^",
  Hcirc: "\u0124",
  Hfr: "\u210C",
  HilbertSpace: "\u210B",
  Hopf: "\u210D",
  HorizontalLine: "\u2500",
  Hscr: "\u210B",
  Hstrok: "\u0126",
  HumpDownHump: "\u224E",
  HumpEqual: "\u224F",
  IEcy: "\u0415",
  IJlig: "\u0132",
  IOcy: "\u0401",
  Iacute: "\xCD",
  Icirc: "\xCE",
  Icy: "\u0418",
  Idot: "\u0130",
  Ifr: "\u2111",
  Igrave: "\xCC",
  Im: "\u2111",
  Imacr: "\u012A",
  ImaginaryI: "\u2148",
  Implies: "\u21D2",
  Int: "\u222C",
  Integral: "\u222B",
  Intersection: "\u22C2",
  InvisibleComma: "\u2063",
  InvisibleTimes: "\u2062",
  Iogon: "\u012E",
  Iopf: "\u{1D540}",
  Iota: "\u0399",
  Iscr: "\u2110",
  Itilde: "\u0128",
  Iukcy: "\u0406",
  Iuml: "\xCF",
  Jcirc: "\u0134",
  Jcy: "\u0419",
  Jfr: "\u{1D50D}",
  Jopf: "\u{1D541}",
  Jscr: "\u{1D4A5}",
  Jsercy: "\u0408",
  Jukcy: "\u0404",
  KHcy: "\u0425",
  KJcy: "\u040C",
  Kappa: "\u039A",
  Kcedil: "\u0136",
  Kcy: "\u041A",
  Kfr: "\u{1D50E}",
  Kopf: "\u{1D542}",
  Kscr: "\u{1D4A6}",
  LJcy: "\u0409",
  LT: "<",
  Lacute: "\u0139",
  Lambda: "\u039B",
  Lang: "\u27EA",
  Laplacetrf: "\u2112",
  Larr: "\u219E",
  Lcaron: "\u013D",
  Lcedil: "\u013B",
  Lcy: "\u041B",
  LeftAngleBracket: "\u27E8",
  LeftArrow: "\u2190",
  LeftArrowBar: "\u21E4",
  LeftArrowRightArrow: "\u21C6",
  LeftCeiling: "\u2308",
  LeftDoubleBracket: "\u27E6",
  LeftDownTeeVector: "\u2961",
  LeftDownVector: "\u21C3",
  LeftDownVectorBar: "\u2959",
  LeftFloor: "\u230A",
  LeftRightArrow: "\u2194",
  LeftRightVector: "\u294E",
  LeftTee: "\u22A3",
  LeftTeeArrow: "\u21A4",
  LeftTeeVector: "\u295A",
  LeftTriangle: "\u22B2",
  LeftTriangleBar: "\u29CF",
  LeftTriangleEqual: "\u22B4",
  LeftUpDownVector: "\u2951",
  LeftUpTeeVector: "\u2960",
  LeftUpVector: "\u21BF",
  LeftUpVectorBar: "\u2958",
  LeftVector: "\u21BC",
  LeftVectorBar: "\u2952",
  Leftarrow: "\u21D0",
  Leftrightarrow: "\u21D4",
  LessEqualGreater: "\u22DA",
  LessFullEqual: "\u2266",
  LessGreater: "\u2276",
  LessLess: "\u2AA1",
  LessSlantEqual: "\u2A7D",
  LessTilde: "\u2272",
  Lfr: "\u{1D50F}",
  Ll: "\u22D8",
  Lleftarrow: "\u21DA",
  Lmidot: "\u013F",
  LongLeftArrow: "\u27F5",
  LongLeftRightArrow: "\u27F7",
  LongRightArrow: "\u27F6",
  Longleftarrow: "\u27F8",
  Longleftrightarrow: "\u27FA",
  Longrightarrow: "\u27F9",
  Lopf: "\u{1D543}",
  LowerLeftArrow: "\u2199",
  LowerRightArrow: "\u2198",
  Lscr: "\u2112",
  Lsh: "\u21B0",
  Lstrok: "\u0141",
  Lt: "\u226A",
  Map: "\u2905",
  Mcy: "\u041C",
  MediumSpace: "\u205F",
  Mellintrf: "\u2133",
  Mfr: "\u{1D510}",
  MinusPlus: "\u2213",
  Mopf: "\u{1D544}",
  Mscr: "\u2133",
  Mu: "\u039C",
  NJcy: "\u040A",
  Nacute: "\u0143",
  Ncaron: "\u0147",
  Ncedil: "\u0145",
  Ncy: "\u041D",
  NegativeMediumSpace: "\u200B",
  NegativeThickSpace: "\u200B",
  NegativeThinSpace: "\u200B",
  NegativeVeryThinSpace: "\u200B",
  NestedGreaterGreater: "\u226B",
  NestedLessLess: "\u226A",
  NewLine: "\n",
  Nfr: "\u{1D511}",
  NoBreak: "\u2060",
  NonBreakingSpace: "\xA0",
  Nopf: "\u2115",
  Not: "\u2AEC",
  NotCongruent: "\u2262",
  NotCupCap: "\u226D",
  NotDoubleVerticalBar: "\u2226",
  NotElement: "\u2209",
  NotEqual: "\u2260",
  NotEqualTilde: "\u2242\u0338",
  NotExists: "\u2204",
  NotGreater: "\u226F",
  NotGreaterEqual: "\u2271",
  NotGreaterFullEqual: "\u2267\u0338",
  NotGreaterGreater: "\u226B\u0338",
  NotGreaterLess: "\u2279",
  NotGreaterSlantEqual: "\u2A7E\u0338",
  NotGreaterTilde: "\u2275",
  NotHumpDownHump: "\u224E\u0338",
  NotHumpEqual: "\u224F\u0338",
  NotLeftTriangle: "\u22EA",
  NotLeftTriangleBar: "\u29CF\u0338",
  NotLeftTriangleEqual: "\u22EC",
  NotLess: "\u226E",
  NotLessEqual: "\u2270",
  NotLessGreater: "\u2278",
  NotLessLess: "\u226A\u0338",
  NotLessSlantEqual: "\u2A7D\u0338",
  NotLessTilde: "\u2274",
  NotNestedGreaterGreater: "\u2AA2\u0338",
  NotNestedLessLess: "\u2AA1\u0338",
  NotPrecedes: "\u2280",
  NotPrecedesEqual: "\u2AAF\u0338",
  NotPrecedesSlantEqual: "\u22E0",
  NotReverseElement: "\u220C",
  NotRightTriangle: "\u22EB",
  NotRightTriangleBar: "\u29D0\u0338",
  NotRightTriangleEqual: "\u22ED",
  NotSquareSubset: "\u228F\u0338",
  NotSquareSubsetEqual: "\u22E2",
  NotSquareSuperset: "\u2290\u0338",
  NotSquareSupersetEqual: "\u22E3",
  NotSubset: "\u2282\u20D2",
  NotSubsetEqual: "\u2288",
  NotSucceeds: "\u2281",
  NotSucceedsEqual: "\u2AB0\u0338",
  NotSucceedsSlantEqual: "\u22E1",
  NotSucceedsTilde: "\u227F\u0338",
  NotSuperset: "\u2283\u20D2",
  NotSupersetEqual: "\u2289",
  NotTilde: "\u2241",
  NotTildeEqual: "\u2244",
  NotTildeFullEqual: "\u2247",
  NotTildeTilde: "\u2249",
  NotVerticalBar: "\u2224",
  Nscr: "\u{1D4A9}",
  Ntilde: "\xD1",
  Nu: "\u039D",
  OElig: "\u0152",
  Oacute: "\xD3",
  Ocirc: "\xD4",
  Ocy: "\u041E",
  Odblac: "\u0150",
  Ofr: "\u{1D512}",
  Ograve: "\xD2",
  Omacr: "\u014C",
  Omega: "\u03A9",
  Omicron: "\u039F",
  Oopf: "\u{1D546}",
  OpenCurlyDoubleQuote: "\u201C",
  OpenCurlyQuote: "\u2018",
  Or: "\u2A54",
  Oscr: "\u{1D4AA}",
  Oslash: "\xD8",
  Otilde: "\xD5",
  Otimes: "\u2A37",
  Ouml: "\xD6",
  OverBar: "\u203E",
  OverBrace: "\u23DE",
  OverBracket: "\u23B4",
  OverParenthesis: "\u23DC",
  PartialD: "\u2202",
  Pcy: "\u041F",
  Pfr: "\u{1D513}",
  Phi: "\u03A6",
  Pi: "\u03A0",
  PlusMinus: "\xB1",
  Poincareplane: "\u210C",
  Popf: "\u2119",
  Pr: "\u2ABB",
  Precedes: "\u227A",
  PrecedesEqual: "\u2AAF",
  PrecedesSlantEqual: "\u227C",
  PrecedesTilde: "\u227E",
  Prime: "\u2033",
  Product: "\u220F",
  Proportion: "\u2237",
  Proportional: "\u221D",
  Pscr: "\u{1D4AB}",
  Psi: "\u03A8",
  QUOT: '"',
  Qfr: "\u{1D514}",
  Qopf: "\u211A",
  Qscr: "\u{1D4AC}",
  RBarr: "\u2910",
  REG: "\xAE",
  Racute: "\u0154",
  Rang: "\u27EB",
  Rarr: "\u21A0",
  Rarrtl: "\u2916",
  Rcaron: "\u0158",
  Rcedil: "\u0156",
  Rcy: "\u0420",
  Re: "\u211C",
  ReverseElement: "\u220B",
  ReverseEquilibrium: "\u21CB",
  ReverseUpEquilibrium: "\u296F",
  Rfr: "\u211C",
  Rho: "\u03A1",
  RightAngleBracket: "\u27E9",
  RightArrow: "\u2192",
  RightArrowBar: "\u21E5",
  RightArrowLeftArrow: "\u21C4",
  RightCeiling: "\u2309",
  RightDoubleBracket: "\u27E7",
  RightDownTeeVector: "\u295D",
  RightDownVector: "\u21C2",
  RightDownVectorBar: "\u2955",
  RightFloor: "\u230B",
  RightTee: "\u22A2",
  RightTeeArrow: "\u21A6",
  RightTeeVector: "\u295B",
  RightTriangle: "\u22B3",
  RightTriangleBar: "\u29D0",
  RightTriangleEqual: "\u22B5",
  RightUpDownVector: "\u294F",
  RightUpTeeVector: "\u295C",
  RightUpVector: "\u21BE",
  RightUpVectorBar: "\u2954",
  RightVector: "\u21C0",
  RightVectorBar: "\u2953",
  Rightarrow: "\u21D2",
  Ropf: "\u211D",
  RoundImplies: "\u2970",
  Rrightarrow: "\u21DB",
  Rscr: "\u211B",
  Rsh: "\u21B1",
  RuleDelayed: "\u29F4",
  SHCHcy: "\u0429",
  SHcy: "\u0428",
  SOFTcy: "\u042C",
  Sacute: "\u015A",
  Sc: "\u2ABC",
  Scaron: "\u0160",
  Scedil: "\u015E",
  Scirc: "\u015C",
  Scy: "\u0421",
  Sfr: "\u{1D516}",
  ShortDownArrow: "\u2193",
  ShortLeftArrow: "\u2190",
  ShortRightArrow: "\u2192",
  ShortUpArrow: "\u2191",
  Sigma: "\u03A3",
  SmallCircle: "\u2218",
  Sopf: "\u{1D54A}",
  Sqrt: "\u221A",
  Square: "\u25A1",
  SquareIntersection: "\u2293",
  SquareSubset: "\u228F",
  SquareSubsetEqual: "\u2291",
  SquareSuperset: "\u2290",
  SquareSupersetEqual: "\u2292",
  SquareUnion: "\u2294",
  Sscr: "\u{1D4AE}",
  Star: "\u22C6",
  Sub: "\u22D0",
  Subset: "\u22D0",
  SubsetEqual: "\u2286",
  Succeeds: "\u227B",
  SucceedsEqual: "\u2AB0",
  SucceedsSlantEqual: "\u227D",
  SucceedsTilde: "\u227F",
  SuchThat: "\u220B",
  Sum: "\u2211",
  Sup: "\u22D1",
  Superset: "\u2283",
  SupersetEqual: "\u2287",
  Supset: "\u22D1",
  THORN: "\xDE",
  TRADE: "\u2122",
  TSHcy: "\u040B",
  TScy: "\u0426",
  Tab: "	",
  Tau: "\u03A4",
  Tcaron: "\u0164",
  Tcedil: "\u0162",
  Tcy: "\u0422",
  Tfr: "\u{1D517}",
  Therefore: "\u2234",
  Theta: "\u0398",
  ThickSpace: "\u205F\u200A",
  ThinSpace: "\u2009",
  Tilde: "\u223C",
  TildeEqual: "\u2243",
  TildeFullEqual: "\u2245",
  TildeTilde: "\u2248",
  Topf: "\u{1D54B}",
  TripleDot: "\u20DB",
  Tscr: "\u{1D4AF}",
  Tstrok: "\u0166",
  Uacute: "\xDA",
  Uarr: "\u219F",
  Uarrocir: "\u2949",
  Ubrcy: "\u040E",
  Ubreve: "\u016C",
  Ucirc: "\xDB",
  Ucy: "\u0423",
  Udblac: "\u0170",
  Ufr: "\u{1D518}",
  Ugrave: "\xD9",
  Umacr: "\u016A",
  UnderBar: "_",
  UnderBrace: "\u23DF",
  UnderBracket: "\u23B5",
  UnderParenthesis: "\u23DD",
  Union: "\u22C3",
  UnionPlus: "\u228E",
  Uogon: "\u0172",
  Uopf: "\u{1D54C}",
  UpArrow: "\u2191",
  UpArrowBar: "\u2912",
  UpArrowDownArrow: "\u21C5",
  UpDownArrow: "\u2195",
  UpEquilibrium: "\u296E",
  UpTee: "\u22A5",
  UpTeeArrow: "\u21A5",
  Uparrow: "\u21D1",
  Updownarrow: "\u21D5",
  UpperLeftArrow: "\u2196",
  UpperRightArrow: "\u2197",
  Upsi: "\u03D2",
  Upsilon: "\u03A5",
  Uring: "\u016E",
  Uscr: "\u{1D4B0}",
  Utilde: "\u0168",
  Uuml: "\xDC",
  VDash: "\u22AB",
  Vbar: "\u2AEB",
  Vcy: "\u0412",
  Vdash: "\u22A9",
  Vdashl: "\u2AE6",
  Vee: "\u22C1",
  Verbar: "\u2016",
  Vert: "\u2016",
  VerticalBar: "\u2223",
  VerticalLine: "|",
  VerticalSeparator: "\u2758",
  VerticalTilde: "\u2240",
  VeryThinSpace: "\u200A",
  Vfr: "\u{1D519}",
  Vopf: "\u{1D54D}",
  Vscr: "\u{1D4B1}",
  Vvdash: "\u22AA",
  Wcirc: "\u0174",
  Wedge: "\u22C0",
  Wfr: "\u{1D51A}",
  Wopf: "\u{1D54E}",
  Wscr: "\u{1D4B2}",
  Xfr: "\u{1D51B}",
  Xi: "\u039E",
  Xopf: "\u{1D54F}",
  Xscr: "\u{1D4B3}",
  YAcy: "\u042F",
  YIcy: "\u0407",
  YUcy: "\u042E",
  Yacute: "\xDD",
  Ycirc: "\u0176",
  Ycy: "\u042B",
  Yfr: "\u{1D51C}",
  Yopf: "\u{1D550}",
  Yscr: "\u{1D4B4}",
  Yuml: "\u0178",
  ZHcy: "\u0416",
  Zacute: "\u0179",
  Zcaron: "\u017D",
  Zcy: "\u0417",
  Zdot: "\u017B",
  ZeroWidthSpace: "\u200B",
  Zeta: "\u0396",
  Zfr: "\u2128",
  Zopf: "\u2124",
  Zscr: "\u{1D4B5}",
  aacute: "\xE1",
  abreve: "\u0103",
  ac: "\u223E",
  acE: "\u223E\u0333",
  acd: "\u223F",
  acirc: "\xE2",
  acute: "\xB4",
  acy: "\u0430",
  aelig: "\xE6",
  af: "\u2061",
  afr: "\u{1D51E}",
  agrave: "\xE0",
  alefsym: "\u2135",
  aleph: "\u2135",
  alpha: "\u03B1",
  amacr: "\u0101",
  amalg: "\u2A3F",
  amp: "&",
  and: "\u2227",
  andand: "\u2A55",
  andd: "\u2A5C",
  andslope: "\u2A58",
  andv: "\u2A5A",
  ang: "\u2220",
  ange: "\u29A4",
  angle: "\u2220",
  angmsd: "\u2221",
  angmsdaa: "\u29A8",
  angmsdab: "\u29A9",
  angmsdac: "\u29AA",
  angmsdad: "\u29AB",
  angmsdae: "\u29AC",
  angmsdaf: "\u29AD",
  angmsdag: "\u29AE",
  angmsdah: "\u29AF",
  angrt: "\u221F",
  angrtvb: "\u22BE",
  angrtvbd: "\u299D",
  angsph: "\u2222",
  angst: "\xC5",
  angzarr: "\u237C",
  aogon: "\u0105",
  aopf: "\u{1D552}",
  ap: "\u2248",
  apE: "\u2A70",
  apacir: "\u2A6F",
  ape: "\u224A",
  apid: "\u224B",
  apos: "'",
  approx: "\u2248",
  approxeq: "\u224A",
  aring: "\xE5",
  ascr: "\u{1D4B6}",
  ast: "*",
  asymp: "\u2248",
  asympeq: "\u224D",
  atilde: "\xE3",
  auml: "\xE4",
  awconint: "\u2233",
  awint: "\u2A11",
  bNot: "\u2AED",
  backcong: "\u224C",
  backepsilon: "\u03F6",
  backprime: "\u2035",
  backsim: "\u223D",
  backsimeq: "\u22CD",
  barvee: "\u22BD",
  barwed: "\u2305",
  barwedge: "\u2305",
  bbrk: "\u23B5",
  bbrktbrk: "\u23B6",
  bcong: "\u224C",
  bcy: "\u0431",
  bdquo: "\u201E",
  becaus: "\u2235",
  because: "\u2235",
  bemptyv: "\u29B0",
  bepsi: "\u03F6",
  bernou: "\u212C",
  beta: "\u03B2",
  beth: "\u2136",
  between: "\u226C",
  bfr: "\u{1D51F}",
  bigcap: "\u22C2",
  bigcirc: "\u25EF",
  bigcup: "\u22C3",
  bigodot: "\u2A00",
  bigoplus: "\u2A01",
  bigotimes: "\u2A02",
  bigsqcup: "\u2A06",
  bigstar: "\u2605",
  bigtriangledown: "\u25BD",
  bigtriangleup: "\u25B3",
  biguplus: "\u2A04",
  bigvee: "\u22C1",
  bigwedge: "\u22C0",
  bkarow: "\u290D",
  blacklozenge: "\u29EB",
  blacksquare: "\u25AA",
  blacktriangle: "\u25B4",
  blacktriangledown: "\u25BE",
  blacktriangleleft: "\u25C2",
  blacktriangleright: "\u25B8",
  blank: "\u2423",
  blk12: "\u2592",
  blk14: "\u2591",
  blk34: "\u2593",
  block: "\u2588",
  bne: "=\u20E5",
  bnequiv: "\u2261\u20E5",
  bnot: "\u2310",
  bopf: "\u{1D553}",
  bot: "\u22A5",
  bottom: "\u22A5",
  bowtie: "\u22C8",
  boxDL: "\u2557",
  boxDR: "\u2554",
  boxDl: "\u2556",
  boxDr: "\u2553",
  boxH: "\u2550",
  boxHD: "\u2566",
  boxHU: "\u2569",
  boxHd: "\u2564",
  boxHu: "\u2567",
  boxUL: "\u255D",
  boxUR: "\u255A",
  boxUl: "\u255C",
  boxUr: "\u2559",
  boxV: "\u2551",
  boxVH: "\u256C",
  boxVL: "\u2563",
  boxVR: "\u2560",
  boxVh: "\u256B",
  boxVl: "\u2562",
  boxVr: "\u255F",
  boxbox: "\u29C9",
  boxdL: "\u2555",
  boxdR: "\u2552",
  boxdl: "\u2510",
  boxdr: "\u250C",
  boxh: "\u2500",
  boxhD: "\u2565",
  boxhU: "\u2568",
  boxhd: "\u252C",
  boxhu: "\u2534",
  boxminus: "\u229F",
  boxplus: "\u229E",
  boxtimes: "\u22A0",
  boxuL: "\u255B",
  boxuR: "\u2558",
  boxul: "\u2518",
  boxur: "\u2514",
  boxv: "\u2502",
  boxvH: "\u256A",
  boxvL: "\u2561",
  boxvR: "\u255E",
  boxvh: "\u253C",
  boxvl: "\u2524",
  boxvr: "\u251C",
  bprime: "\u2035",
  breve: "\u02D8",
  brvbar: "\xA6",
  bscr: "\u{1D4B7}",
  bsemi: "\u204F",
  bsim: "\u223D",
  bsime: "\u22CD",
  bsol: "\\",
  bsolb: "\u29C5",
  bsolhsub: "\u27C8",
  bull: "\u2022",
  bullet: "\u2022",
  bump: "\u224E",
  bumpE: "\u2AAE",
  bumpe: "\u224F",
  bumpeq: "\u224F",
  cacute: "\u0107",
  cap: "\u2229",
  capand: "\u2A44",
  capbrcup: "\u2A49",
  capcap: "\u2A4B",
  capcup: "\u2A47",
  capdot: "\u2A40",
  caps: "\u2229\uFE00",
  caret: "\u2041",
  caron: "\u02C7",
  ccaps: "\u2A4D",
  ccaron: "\u010D",
  ccedil: "\xE7",
  ccirc: "\u0109",
  ccups: "\u2A4C",
  ccupssm: "\u2A50",
  cdot: "\u010B",
  cedil: "\xB8",
  cemptyv: "\u29B2",
  cent: "\xA2",
  centerdot: "\xB7",
  cfr: "\u{1D520}",
  chcy: "\u0447",
  check: "\u2713",
  checkmark: "\u2713",
  chi: "\u03C7",
  cir: "\u25CB",
  cirE: "\u29C3",
  circ: "\u02C6",
  circeq: "\u2257",
  circlearrowleft: "\u21BA",
  circlearrowright: "\u21BB",
  circledR: "\xAE",
  circledS: "\u24C8",
  circledast: "\u229B",
  circledcirc: "\u229A",
  circleddash: "\u229D",
  cire: "\u2257",
  cirfnint: "\u2A10",
  cirmid: "\u2AEF",
  cirscir: "\u29C2",
  clubs: "\u2663",
  clubsuit: "\u2663",
  colon: ":",
  colone: "\u2254",
  coloneq: "\u2254",
  comma: ",",
  commat: "@",
  comp: "\u2201",
  compfn: "\u2218",
  complement: "\u2201",
  complexes: "\u2102",
  cong: "\u2245",
  congdot: "\u2A6D",
  conint: "\u222E",
  copf: "\u{1D554}",
  coprod: "\u2210",
  copy: "\xA9",
  copysr: "\u2117",
  crarr: "\u21B5",
  cross: "\u2717",
  cscr: "\u{1D4B8}",
  csub: "\u2ACF",
  csube: "\u2AD1",
  csup: "\u2AD0",
  csupe: "\u2AD2",
  ctdot: "\u22EF",
  cudarrl: "\u2938",
  cudarrr: "\u2935",
  cuepr: "\u22DE",
  cuesc: "\u22DF",
  cularr: "\u21B6",
  cularrp: "\u293D",
  cup: "\u222A",
  cupbrcap: "\u2A48",
  cupcap: "\u2A46",
  cupcup: "\u2A4A",
  cupdot: "\u228D",
  cupor: "\u2A45",
  cups: "\u222A\uFE00",
  curarr: "\u21B7",
  curarrm: "\u293C",
  curlyeqprec: "\u22DE",
  curlyeqsucc: "\u22DF",
  curlyvee: "\u22CE",
  curlywedge: "\u22CF",
  curren: "\xA4",
  curvearrowleft: "\u21B6",
  curvearrowright: "\u21B7",
  cuvee: "\u22CE",
  cuwed: "\u22CF",
  cwconint: "\u2232",
  cwint: "\u2231",
  cylcty: "\u232D",
  dArr: "\u21D3",
  dHar: "\u2965",
  dagger: "\u2020",
  daleth: "\u2138",
  darr: "\u2193",
  dash: "\u2010",
  dashv: "\u22A3",
  dbkarow: "\u290F",
  dblac: "\u02DD",
  dcaron: "\u010F",
  dcy: "\u0434",
  dd: "\u2146",
  ddagger: "\u2021",
  ddarr: "\u21CA",
  ddotseq: "\u2A77",
  deg: "\xB0",
  delta: "\u03B4",
  demptyv: "\u29B1",
  dfisht: "\u297F",
  dfr: "\u{1D521}",
  dharl: "\u21C3",
  dharr: "\u21C2",
  diam: "\u22C4",
  diamond: "\u22C4",
  diamondsuit: "\u2666",
  diams: "\u2666",
  die: "\xA8",
  digamma: "\u03DD",
  disin: "\u22F2",
  div: "\xF7",
  divide: "\xF7",
  divideontimes: "\u22C7",
  divonx: "\u22C7",
  djcy: "\u0452",
  dlcorn: "\u231E",
  dlcrop: "\u230D",
  dollar: "$",
  dopf: "\u{1D555}",
  dot: "\u02D9",
  doteq: "\u2250",
  doteqdot: "\u2251",
  dotminus: "\u2238",
  dotplus: "\u2214",
  dotsquare: "\u22A1",
  doublebarwedge: "\u2306",
  downarrow: "\u2193",
  downdownarrows: "\u21CA",
  downharpoonleft: "\u21C3",
  downharpoonright: "\u21C2",
  drbkarow: "\u2910",
  drcorn: "\u231F",
  drcrop: "\u230C",
  dscr: "\u{1D4B9}",
  dscy: "\u0455",
  dsol: "\u29F6",
  dstrok: "\u0111",
  dtdot: "\u22F1",
  dtri: "\u25BF",
  dtrif: "\u25BE",
  duarr: "\u21F5",
  duhar: "\u296F",
  dwangle: "\u29A6",
  dzcy: "\u045F",
  dzigrarr: "\u27FF",
  eDDot: "\u2A77",
  eDot: "\u2251",
  eacute: "\xE9",
  easter: "\u2A6E",
  ecaron: "\u011B",
  ecir: "\u2256",
  ecirc: "\xEA",
  ecolon: "\u2255",
  ecy: "\u044D",
  edot: "\u0117",
  ee: "\u2147",
  efDot: "\u2252",
  efr: "\u{1D522}",
  eg: "\u2A9A",
  egrave: "\xE8",
  egs: "\u2A96",
  egsdot: "\u2A98",
  el: "\u2A99",
  elinters: "\u23E7",
  ell: "\u2113",
  els: "\u2A95",
  elsdot: "\u2A97",
  emacr: "\u0113",
  empty: "\u2205",
  emptyset: "\u2205",
  emptyv: "\u2205",
  emsp13: "\u2004",
  emsp14: "\u2005",
  emsp: "\u2003",
  eng: "\u014B",
  ensp: "\u2002",
  eogon: "\u0119",
  eopf: "\u{1D556}",
  epar: "\u22D5",
  eparsl: "\u29E3",
  eplus: "\u2A71",
  epsi: "\u03B5",
  epsilon: "\u03B5",
  epsiv: "\u03F5",
  eqcirc: "\u2256",
  eqcolon: "\u2255",
  eqsim: "\u2242",
  eqslantgtr: "\u2A96",
  eqslantless: "\u2A95",
  equals: "=",
  equest: "\u225F",
  equiv: "\u2261",
  equivDD: "\u2A78",
  eqvparsl: "\u29E5",
  erDot: "\u2253",
  erarr: "\u2971",
  escr: "\u212F",
  esdot: "\u2250",
  esim: "\u2242",
  eta: "\u03B7",
  eth: "\xF0",
  euml: "\xEB",
  euro: "\u20AC",
  excl: "!",
  exist: "\u2203",
  expectation: "\u2130",
  exponentiale: "\u2147",
  fallingdotseq: "\u2252",
  fcy: "\u0444",
  female: "\u2640",
  ffilig: "\uFB03",
  fflig: "\uFB00",
  ffllig: "\uFB04",
  ffr: "\u{1D523}",
  filig: "\uFB01",
  fjlig: "fj",
  flat: "\u266D",
  fllig: "\uFB02",
  fltns: "\u25B1",
  fnof: "\u0192",
  fopf: "\u{1D557}",
  forall: "\u2200",
  fork: "\u22D4",
  forkv: "\u2AD9",
  fpartint: "\u2A0D",
  frac12: "\xBD",
  frac13: "\u2153",
  frac14: "\xBC",
  frac15: "\u2155",
  frac16: "\u2159",
  frac18: "\u215B",
  frac23: "\u2154",
  frac25: "\u2156",
  frac34: "\xBE",
  frac35: "\u2157",
  frac38: "\u215C",
  frac45: "\u2158",
  frac56: "\u215A",
  frac58: "\u215D",
  frac78: "\u215E",
  frasl: "\u2044",
  frown: "\u2322",
  fscr: "\u{1D4BB}",
  gE: "\u2267",
  gEl: "\u2A8C",
  gacute: "\u01F5",
  gamma: "\u03B3",
  gammad: "\u03DD",
  gap: "\u2A86",
  gbreve: "\u011F",
  gcirc: "\u011D",
  gcy: "\u0433",
  gdot: "\u0121",
  ge: "\u2265",
  gel: "\u22DB",
  geq: "\u2265",
  geqq: "\u2267",
  geqslant: "\u2A7E",
  ges: "\u2A7E",
  gescc: "\u2AA9",
  gesdot: "\u2A80",
  gesdoto: "\u2A82",
  gesdotol: "\u2A84",
  gesl: "\u22DB\uFE00",
  gesles: "\u2A94",
  gfr: "\u{1D524}",
  gg: "\u226B",
  ggg: "\u22D9",
  gimel: "\u2137",
  gjcy: "\u0453",
  gl: "\u2277",
  glE: "\u2A92",
  gla: "\u2AA5",
  glj: "\u2AA4",
  gnE: "\u2269",
  gnap: "\u2A8A",
  gnapprox: "\u2A8A",
  gne: "\u2A88",
  gneq: "\u2A88",
  gneqq: "\u2269",
  gnsim: "\u22E7",
  gopf: "\u{1D558}",
  grave: "`",
  gscr: "\u210A",
  gsim: "\u2273",
  gsime: "\u2A8E",
  gsiml: "\u2A90",
  gt: ">",
  gtcc: "\u2AA7",
  gtcir: "\u2A7A",
  gtdot: "\u22D7",
  gtlPar: "\u2995",
  gtquest: "\u2A7C",
  gtrapprox: "\u2A86",
  gtrarr: "\u2978",
  gtrdot: "\u22D7",
  gtreqless: "\u22DB",
  gtreqqless: "\u2A8C",
  gtrless: "\u2277",
  gtrsim: "\u2273",
  gvertneqq: "\u2269\uFE00",
  gvnE: "\u2269\uFE00",
  hArr: "\u21D4",
  hairsp: "\u200A",
  half: "\xBD",
  hamilt: "\u210B",
  hardcy: "\u044A",
  harr: "\u2194",
  harrcir: "\u2948",
  harrw: "\u21AD",
  hbar: "\u210F",
  hcirc: "\u0125",
  hearts: "\u2665",
  heartsuit: "\u2665",
  hellip: "\u2026",
  hercon: "\u22B9",
  hfr: "\u{1D525}",
  hksearow: "\u2925",
  hkswarow: "\u2926",
  hoarr: "\u21FF",
  homtht: "\u223B",
  hookleftarrow: "\u21A9",
  hookrightarrow: "\u21AA",
  hopf: "\u{1D559}",
  horbar: "\u2015",
  hscr: "\u{1D4BD}",
  hslash: "\u210F",
  hstrok: "\u0127",
  hybull: "\u2043",
  hyphen: "\u2010",
  iacute: "\xED",
  ic: "\u2063",
  icirc: "\xEE",
  icy: "\u0438",
  iecy: "\u0435",
  iexcl: "\xA1",
  iff: "\u21D4",
  ifr: "\u{1D526}",
  igrave: "\xEC",
  ii: "\u2148",
  iiiint: "\u2A0C",
  iiint: "\u222D",
  iinfin: "\u29DC",
  iiota: "\u2129",
  ijlig: "\u0133",
  imacr: "\u012B",
  image: "\u2111",
  imagline: "\u2110",
  imagpart: "\u2111",
  imath: "\u0131",
  imof: "\u22B7",
  imped: "\u01B5",
  in: "\u2208",
  incare: "\u2105",
  infin: "\u221E",
  infintie: "\u29DD",
  inodot: "\u0131",
  int: "\u222B",
  intcal: "\u22BA",
  integers: "\u2124",
  intercal: "\u22BA",
  intlarhk: "\u2A17",
  intprod: "\u2A3C",
  iocy: "\u0451",
  iogon: "\u012F",
  iopf: "\u{1D55A}",
  iota: "\u03B9",
  iprod: "\u2A3C",
  iquest: "\xBF",
  iscr: "\u{1D4BE}",
  isin: "\u2208",
  isinE: "\u22F9",
  isindot: "\u22F5",
  isins: "\u22F4",
  isinsv: "\u22F3",
  isinv: "\u2208",
  it: "\u2062",
  itilde: "\u0129",
  iukcy: "\u0456",
  iuml: "\xEF",
  jcirc: "\u0135",
  jcy: "\u0439",
  jfr: "\u{1D527}",
  jmath: "\u0237",
  jopf: "\u{1D55B}",
  jscr: "\u{1D4BF}",
  jsercy: "\u0458",
  jukcy: "\u0454",
  kappa: "\u03BA",
  kappav: "\u03F0",
  kcedil: "\u0137",
  kcy: "\u043A",
  kfr: "\u{1D528}",
  kgreen: "\u0138",
  khcy: "\u0445",
  kjcy: "\u045C",
  kopf: "\u{1D55C}",
  kscr: "\u{1D4C0}",
  lAarr: "\u21DA",
  lArr: "\u21D0",
  lAtail: "\u291B",
  lBarr: "\u290E",
  lE: "\u2266",
  lEg: "\u2A8B",
  lHar: "\u2962",
  lacute: "\u013A",
  laemptyv: "\u29B4",
  lagran: "\u2112",
  lambda: "\u03BB",
  lang: "\u27E8",
  langd: "\u2991",
  langle: "\u27E8",
  lap: "\u2A85",
  laquo: "\xAB",
  larr: "\u2190",
  larrb: "\u21E4",
  larrbfs: "\u291F",
  larrfs: "\u291D",
  larrhk: "\u21A9",
  larrlp: "\u21AB",
  larrpl: "\u2939",
  larrsim: "\u2973",
  larrtl: "\u21A2",
  lat: "\u2AAB",
  latail: "\u2919",
  late: "\u2AAD",
  lates: "\u2AAD\uFE00",
  lbarr: "\u290C",
  lbbrk: "\u2772",
  lbrace: "{",
  lbrack: "[",
  lbrke: "\u298B",
  lbrksld: "\u298F",
  lbrkslu: "\u298D",
  lcaron: "\u013E",
  lcedil: "\u013C",
  lceil: "\u2308",
  lcub: "{",
  lcy: "\u043B",
  ldca: "\u2936",
  ldquo: "\u201C",
  ldquor: "\u201E",
  ldrdhar: "\u2967",
  ldrushar: "\u294B",
  ldsh: "\u21B2",
  le: "\u2264",
  leftarrow: "\u2190",
  leftarrowtail: "\u21A2",
  leftharpoondown: "\u21BD",
  leftharpoonup: "\u21BC",
  leftleftarrows: "\u21C7",
  leftrightarrow: "\u2194",
  leftrightarrows: "\u21C6",
  leftrightharpoons: "\u21CB",
  leftrightsquigarrow: "\u21AD",
  leftthreetimes: "\u22CB",
  leg: "\u22DA",
  leq: "\u2264",
  leqq: "\u2266",
  leqslant: "\u2A7D",
  les: "\u2A7D",
  lescc: "\u2AA8",
  lesdot: "\u2A7F",
  lesdoto: "\u2A81",
  lesdotor: "\u2A83",
  lesg: "\u22DA\uFE00",
  lesges: "\u2A93",
  lessapprox: "\u2A85",
  lessdot: "\u22D6",
  lesseqgtr: "\u22DA",
  lesseqqgtr: "\u2A8B",
  lessgtr: "\u2276",
  lesssim: "\u2272",
  lfisht: "\u297C",
  lfloor: "\u230A",
  lfr: "\u{1D529}",
  lg: "\u2276",
  lgE: "\u2A91",
  lhard: "\u21BD",
  lharu: "\u21BC",
  lharul: "\u296A",
  lhblk: "\u2584",
  ljcy: "\u0459",
  ll: "\u226A",
  llarr: "\u21C7",
  llcorner: "\u231E",
  llhard: "\u296B",
  lltri: "\u25FA",
  lmidot: "\u0140",
  lmoust: "\u23B0",
  lmoustache: "\u23B0",
  lnE: "\u2268",
  lnap: "\u2A89",
  lnapprox: "\u2A89",
  lne: "\u2A87",
  lneq: "\u2A87",
  lneqq: "\u2268",
  lnsim: "\u22E6",
  loang: "\u27EC",
  loarr: "\u21FD",
  lobrk: "\u27E6",
  longleftarrow: "\u27F5",
  longleftrightarrow: "\u27F7",
  longmapsto: "\u27FC",
  longrightarrow: "\u27F6",
  looparrowleft: "\u21AB",
  looparrowright: "\u21AC",
  lopar: "\u2985",
  lopf: "\u{1D55D}",
  loplus: "\u2A2D",
  lotimes: "\u2A34",
  lowast: "\u2217",
  lowbar: "_",
  loz: "\u25CA",
  lozenge: "\u25CA",
  lozf: "\u29EB",
  lpar: "(",
  lparlt: "\u2993",
  lrarr: "\u21C6",
  lrcorner: "\u231F",
  lrhar: "\u21CB",
  lrhard: "\u296D",
  lrm: "\u200E",
  lrtri: "\u22BF",
  lsaquo: "\u2039",
  lscr: "\u{1D4C1}",
  lsh: "\u21B0",
  lsim: "\u2272",
  lsime: "\u2A8D",
  lsimg: "\u2A8F",
  lsqb: "[",
  lsquo: "\u2018",
  lsquor: "\u201A",
  lstrok: "\u0142",
  lt: "<",
  ltcc: "\u2AA6",
  ltcir: "\u2A79",
  ltdot: "\u22D6",
  lthree: "\u22CB",
  ltimes: "\u22C9",
  ltlarr: "\u2976",
  ltquest: "\u2A7B",
  ltrPar: "\u2996",
  ltri: "\u25C3",
  ltrie: "\u22B4",
  ltrif: "\u25C2",
  lurdshar: "\u294A",
  luruhar: "\u2966",
  lvertneqq: "\u2268\uFE00",
  lvnE: "\u2268\uFE00",
  mDDot: "\u223A",
  macr: "\xAF",
  male: "\u2642",
  malt: "\u2720",
  maltese: "\u2720",
  map: "\u21A6",
  mapsto: "\u21A6",
  mapstodown: "\u21A7",
  mapstoleft: "\u21A4",
  mapstoup: "\u21A5",
  marker: "\u25AE",
  mcomma: "\u2A29",
  mcy: "\u043C",
  mdash: "\u2014",
  measuredangle: "\u2221",
  mfr: "\u{1D52A}",
  mho: "\u2127",
  micro: "\xB5",
  mid: "\u2223",
  midast: "*",
  midcir: "\u2AF0",
  middot: "\xB7",
  minus: "\u2212",
  minusb: "\u229F",
  minusd: "\u2238",
  minusdu: "\u2A2A",
  mlcp: "\u2ADB",
  mldr: "\u2026",
  mnplus: "\u2213",
  models: "\u22A7",
  mopf: "\u{1D55E}",
  mp: "\u2213",
  mscr: "\u{1D4C2}",
  mstpos: "\u223E",
  mu: "\u03BC",
  multimap: "\u22B8",
  mumap: "\u22B8",
  nGg: "\u22D9\u0338",
  nGt: "\u226B\u20D2",
  nGtv: "\u226B\u0338",
  nLeftarrow: "\u21CD",
  nLeftrightarrow: "\u21CE",
  nLl: "\u22D8\u0338",
  nLt: "\u226A\u20D2",
  nLtv: "\u226A\u0338",
  nRightarrow: "\u21CF",
  nVDash: "\u22AF",
  nVdash: "\u22AE",
  nabla: "\u2207",
  nacute: "\u0144",
  nang: "\u2220\u20D2",
  nap: "\u2249",
  napE: "\u2A70\u0338",
  napid: "\u224B\u0338",
  napos: "\u0149",
  napprox: "\u2249",
  natur: "\u266E",
  natural: "\u266E",
  naturals: "\u2115",
  nbsp: "\xA0",
  nbump: "\u224E\u0338",
  nbumpe: "\u224F\u0338",
  ncap: "\u2A43",
  ncaron: "\u0148",
  ncedil: "\u0146",
  ncong: "\u2247",
  ncongdot: "\u2A6D\u0338",
  ncup: "\u2A42",
  ncy: "\u043D",
  ndash: "\u2013",
  ne: "\u2260",
  neArr: "\u21D7",
  nearhk: "\u2924",
  nearr: "\u2197",
  nearrow: "\u2197",
  nedot: "\u2250\u0338",
  nequiv: "\u2262",
  nesear: "\u2928",
  nesim: "\u2242\u0338",
  nexist: "\u2204",
  nexists: "\u2204",
  nfr: "\u{1D52B}",
  ngE: "\u2267\u0338",
  nge: "\u2271",
  ngeq: "\u2271",
  ngeqq: "\u2267\u0338",
  ngeqslant: "\u2A7E\u0338",
  nges: "\u2A7E\u0338",
  ngsim: "\u2275",
  ngt: "\u226F",
  ngtr: "\u226F",
  nhArr: "\u21CE",
  nharr: "\u21AE",
  nhpar: "\u2AF2",
  ni: "\u220B",
  nis: "\u22FC",
  nisd: "\u22FA",
  niv: "\u220B",
  njcy: "\u045A",
  nlArr: "\u21CD",
  nlE: "\u2266\u0338",
  nlarr: "\u219A",
  nldr: "\u2025",
  nle: "\u2270",
  nleftarrow: "\u219A",
  nleftrightarrow: "\u21AE",
  nleq: "\u2270",
  nleqq: "\u2266\u0338",
  nleqslant: "\u2A7D\u0338",
  nles: "\u2A7D\u0338",
  nless: "\u226E",
  nlsim: "\u2274",
  nlt: "\u226E",
  nltri: "\u22EA",
  nltrie: "\u22EC",
  nmid: "\u2224",
  nopf: "\u{1D55F}",
  not: "\xAC",
  notin: "\u2209",
  notinE: "\u22F9\u0338",
  notindot: "\u22F5\u0338",
  notinva: "\u2209",
  notinvb: "\u22F7",
  notinvc: "\u22F6",
  notni: "\u220C",
  notniva: "\u220C",
  notnivb: "\u22FE",
  notnivc: "\u22FD",
  npar: "\u2226",
  nparallel: "\u2226",
  nparsl: "\u2AFD\u20E5",
  npart: "\u2202\u0338",
  npolint: "\u2A14",
  npr: "\u2280",
  nprcue: "\u22E0",
  npre: "\u2AAF\u0338",
  nprec: "\u2280",
  npreceq: "\u2AAF\u0338",
  nrArr: "\u21CF",
  nrarr: "\u219B",
  nrarrc: "\u2933\u0338",
  nrarrw: "\u219D\u0338",
  nrightarrow: "\u219B",
  nrtri: "\u22EB",
  nrtrie: "\u22ED",
  nsc: "\u2281",
  nsccue: "\u22E1",
  nsce: "\u2AB0\u0338",
  nscr: "\u{1D4C3}",
  nshortmid: "\u2224",
  nshortparallel: "\u2226",
  nsim: "\u2241",
  nsime: "\u2244",
  nsimeq: "\u2244",
  nsmid: "\u2224",
  nspar: "\u2226",
  nsqsube: "\u22E2",
  nsqsupe: "\u22E3",
  nsub: "\u2284",
  nsubE: "\u2AC5\u0338",
  nsube: "\u2288",
  nsubset: "\u2282\u20D2",
  nsubseteq: "\u2288",
  nsubseteqq: "\u2AC5\u0338",
  nsucc: "\u2281",
  nsucceq: "\u2AB0\u0338",
  nsup: "\u2285",
  nsupE: "\u2AC6\u0338",
  nsupe: "\u2289",
  nsupset: "\u2283\u20D2",
  nsupseteq: "\u2289",
  nsupseteqq: "\u2AC6\u0338",
  ntgl: "\u2279",
  ntilde: "\xF1",
  ntlg: "\u2278",
  ntriangleleft: "\u22EA",
  ntrianglelefteq: "\u22EC",
  ntriangleright: "\u22EB",
  ntrianglerighteq: "\u22ED",
  nu: "\u03BD",
  num: "#",
  numero: "\u2116",
  numsp: "\u2007",
  nvDash: "\u22AD",
  nvHarr: "\u2904",
  nvap: "\u224D\u20D2",
  nvdash: "\u22AC",
  nvge: "\u2265\u20D2",
  nvgt: ">\u20D2",
  nvinfin: "\u29DE",
  nvlArr: "\u2902",
  nvle: "\u2264\u20D2",
  nvlt: "<\u20D2",
  nvltrie: "\u22B4\u20D2",
  nvrArr: "\u2903",
  nvrtrie: "\u22B5\u20D2",
  nvsim: "\u223C\u20D2",
  nwArr: "\u21D6",
  nwarhk: "\u2923",
  nwarr: "\u2196",
  nwarrow: "\u2196",
  nwnear: "\u2927",
  oS: "\u24C8",
  oacute: "\xF3",
  oast: "\u229B",
  ocir: "\u229A",
  ocirc: "\xF4",
  ocy: "\u043E",
  odash: "\u229D",
  odblac: "\u0151",
  odiv: "\u2A38",
  odot: "\u2299",
  odsold: "\u29BC",
  oelig: "\u0153",
  ofcir: "\u29BF",
  ofr: "\u{1D52C}",
  ogon: "\u02DB",
  ograve: "\xF2",
  ogt: "\u29C1",
  ohbar: "\u29B5",
  ohm: "\u03A9",
  oint: "\u222E",
  olarr: "\u21BA",
  olcir: "\u29BE",
  olcross: "\u29BB",
  oline: "\u203E",
  olt: "\u29C0",
  omacr: "\u014D",
  omega: "\u03C9",
  omicron: "\u03BF",
  omid: "\u29B6",
  ominus: "\u2296",
  oopf: "\u{1D560}",
  opar: "\u29B7",
  operp: "\u29B9",
  oplus: "\u2295",
  or: "\u2228",
  orarr: "\u21BB",
  ord: "\u2A5D",
  order: "\u2134",
  orderof: "\u2134",
  ordf: "\xAA",
  ordm: "\xBA",
  origof: "\u22B6",
  oror: "\u2A56",
  orslope: "\u2A57",
  orv: "\u2A5B",
  oscr: "\u2134",
  oslash: "\xF8",
  osol: "\u2298",
  otilde: "\xF5",
  otimes: "\u2297",
  otimesas: "\u2A36",
  ouml: "\xF6",
  ovbar: "\u233D",
  par: "\u2225",
  para: "\xB6",
  parallel: "\u2225",
  parsim: "\u2AF3",
  parsl: "\u2AFD",
  part: "\u2202",
  pcy: "\u043F",
  percnt: "%",
  period: ".",
  permil: "\u2030",
  perp: "\u22A5",
  pertenk: "\u2031",
  pfr: "\u{1D52D}",
  phi: "\u03C6",
  phiv: "\u03D5",
  phmmat: "\u2133",
  phone: "\u260E",
  pi: "\u03C0",
  pitchfork: "\u22D4",
  piv: "\u03D6",
  planck: "\u210F",
  planckh: "\u210E",
  plankv: "\u210F",
  plus: "+",
  plusacir: "\u2A23",
  plusb: "\u229E",
  pluscir: "\u2A22",
  plusdo: "\u2214",
  plusdu: "\u2A25",
  pluse: "\u2A72",
  plusmn: "\xB1",
  plussim: "\u2A26",
  plustwo: "\u2A27",
  pm: "\xB1",
  pointint: "\u2A15",
  popf: "\u{1D561}",
  pound: "\xA3",
  pr: "\u227A",
  prE: "\u2AB3",
  prap: "\u2AB7",
  prcue: "\u227C",
  pre: "\u2AAF",
  prec: "\u227A",
  precapprox: "\u2AB7",
  preccurlyeq: "\u227C",
  preceq: "\u2AAF",
  precnapprox: "\u2AB9",
  precneqq: "\u2AB5",
  precnsim: "\u22E8",
  precsim: "\u227E",
  prime: "\u2032",
  primes: "\u2119",
  prnE: "\u2AB5",
  prnap: "\u2AB9",
  prnsim: "\u22E8",
  prod: "\u220F",
  profalar: "\u232E",
  profline: "\u2312",
  profsurf: "\u2313",
  prop: "\u221D",
  propto: "\u221D",
  prsim: "\u227E",
  prurel: "\u22B0",
  pscr: "\u{1D4C5}",
  psi: "\u03C8",
  puncsp: "\u2008",
  qfr: "\u{1D52E}",
  qint: "\u2A0C",
  qopf: "\u{1D562}",
  qprime: "\u2057",
  qscr: "\u{1D4C6}",
  quaternions: "\u210D",
  quatint: "\u2A16",
  quest: "?",
  questeq: "\u225F",
  quot: '"',
  rAarr: "\u21DB",
  rArr: "\u21D2",
  rAtail: "\u291C",
  rBarr: "\u290F",
  rHar: "\u2964",
  race: "\u223D\u0331",
  racute: "\u0155",
  radic: "\u221A",
  raemptyv: "\u29B3",
  rang: "\u27E9",
  rangd: "\u2992",
  range: "\u29A5",
  rangle: "\u27E9",
  raquo: "\xBB",
  rarr: "\u2192",
  rarrap: "\u2975",
  rarrb: "\u21E5",
  rarrbfs: "\u2920",
  rarrc: "\u2933",
  rarrfs: "\u291E",
  rarrhk: "\u21AA",
  rarrlp: "\u21AC",
  rarrpl: "\u2945",
  rarrsim: "\u2974",
  rarrtl: "\u21A3",
  rarrw: "\u219D",
  ratail: "\u291A",
  ratio: "\u2236",
  rationals: "\u211A",
  rbarr: "\u290D",
  rbbrk: "\u2773",
  rbrace: "}",
  rbrack: "]",
  rbrke: "\u298C",
  rbrksld: "\u298E",
  rbrkslu: "\u2990",
  rcaron: "\u0159",
  rcedil: "\u0157",
  rceil: "\u2309",
  rcub: "}",
  rcy: "\u0440",
  rdca: "\u2937",
  rdldhar: "\u2969",
  rdquo: "\u201D",
  rdquor: "\u201D",
  rdsh: "\u21B3",
  real: "\u211C",
  realine: "\u211B",
  realpart: "\u211C",
  reals: "\u211D",
  rect: "\u25AD",
  reg: "\xAE",
  rfisht: "\u297D",
  rfloor: "\u230B",
  rfr: "\u{1D52F}",
  rhard: "\u21C1",
  rharu: "\u21C0",
  rharul: "\u296C",
  rho: "\u03C1",
  rhov: "\u03F1",
  rightarrow: "\u2192",
  rightarrowtail: "\u21A3",
  rightharpoondown: "\u21C1",
  rightharpoonup: "\u21C0",
  rightleftarrows: "\u21C4",
  rightleftharpoons: "\u21CC",
  rightrightarrows: "\u21C9",
  rightsquigarrow: "\u219D",
  rightthreetimes: "\u22CC",
  ring: "\u02DA",
  risingdotseq: "\u2253",
  rlarr: "\u21C4",
  rlhar: "\u21CC",
  rlm: "\u200F",
  rmoust: "\u23B1",
  rmoustache: "\u23B1",
  rnmid: "\u2AEE",
  roang: "\u27ED",
  roarr: "\u21FE",
  robrk: "\u27E7",
  ropar: "\u2986",
  ropf: "\u{1D563}",
  roplus: "\u2A2E",
  rotimes: "\u2A35",
  rpar: ")",
  rpargt: "\u2994",
  rppolint: "\u2A12",
  rrarr: "\u21C9",
  rsaquo: "\u203A",
  rscr: "\u{1D4C7}",
  rsh: "\u21B1",
  rsqb: "]",
  rsquo: "\u2019",
  rsquor: "\u2019",
  rthree: "\u22CC",
  rtimes: "\u22CA",
  rtri: "\u25B9",
  rtrie: "\u22B5",
  rtrif: "\u25B8",
  rtriltri: "\u29CE",
  ruluhar: "\u2968",
  rx: "\u211E",
  sacute: "\u015B",
  sbquo: "\u201A",
  sc: "\u227B",
  scE: "\u2AB4",
  scap: "\u2AB8",
  scaron: "\u0161",
  sccue: "\u227D",
  sce: "\u2AB0",
  scedil: "\u015F",
  scirc: "\u015D",
  scnE: "\u2AB6",
  scnap: "\u2ABA",
  scnsim: "\u22E9",
  scpolint: "\u2A13",
  scsim: "\u227F",
  scy: "\u0441",
  sdot: "\u22C5",
  sdotb: "\u22A1",
  sdote: "\u2A66",
  seArr: "\u21D8",
  searhk: "\u2925",
  searr: "\u2198",
  searrow: "\u2198",
  sect: "\xA7",
  semi: ";",
  seswar: "\u2929",
  setminus: "\u2216",
  setmn: "\u2216",
  sext: "\u2736",
  sfr: "\u{1D530}",
  sfrown: "\u2322",
  sharp: "\u266F",
  shchcy: "\u0449",
  shcy: "\u0448",
  shortmid: "\u2223",
  shortparallel: "\u2225",
  shy: "\xAD",
  sigma: "\u03C3",
  sigmaf: "\u03C2",
  sigmav: "\u03C2",
  sim: "\u223C",
  simdot: "\u2A6A",
  sime: "\u2243",
  simeq: "\u2243",
  simg: "\u2A9E",
  simgE: "\u2AA0",
  siml: "\u2A9D",
  simlE: "\u2A9F",
  simne: "\u2246",
  simplus: "\u2A24",
  simrarr: "\u2972",
  slarr: "\u2190",
  smallsetminus: "\u2216",
  smashp: "\u2A33",
  smeparsl: "\u29E4",
  smid: "\u2223",
  smile: "\u2323",
  smt: "\u2AAA",
  smte: "\u2AAC",
  smtes: "\u2AAC\uFE00",
  softcy: "\u044C",
  sol: "/",
  solb: "\u29C4",
  solbar: "\u233F",
  sopf: "\u{1D564}",
  spades: "\u2660",
  spadesuit: "\u2660",
  spar: "\u2225",
  sqcap: "\u2293",
  sqcaps: "\u2293\uFE00",
  sqcup: "\u2294",
  sqcups: "\u2294\uFE00",
  sqsub: "\u228F",
  sqsube: "\u2291",
  sqsubset: "\u228F",
  sqsubseteq: "\u2291",
  sqsup: "\u2290",
  sqsupe: "\u2292",
  sqsupset: "\u2290",
  sqsupseteq: "\u2292",
  squ: "\u25A1",
  square: "\u25A1",
  squarf: "\u25AA",
  squf: "\u25AA",
  srarr: "\u2192",
  sscr: "\u{1D4C8}",
  ssetmn: "\u2216",
  ssmile: "\u2323",
  sstarf: "\u22C6",
  star: "\u2606",
  starf: "\u2605",
  straightepsilon: "\u03F5",
  straightphi: "\u03D5",
  strns: "\xAF",
  sub: "\u2282",
  subE: "\u2AC5",
  subdot: "\u2ABD",
  sube: "\u2286",
  subedot: "\u2AC3",
  submult: "\u2AC1",
  subnE: "\u2ACB",
  subne: "\u228A",
  subplus: "\u2ABF",
  subrarr: "\u2979",
  subset: "\u2282",
  subseteq: "\u2286",
  subseteqq: "\u2AC5",
  subsetneq: "\u228A",
  subsetneqq: "\u2ACB",
  subsim: "\u2AC7",
  subsub: "\u2AD5",
  subsup: "\u2AD3",
  succ: "\u227B",
  succapprox: "\u2AB8",
  succcurlyeq: "\u227D",
  succeq: "\u2AB0",
  succnapprox: "\u2ABA",
  succneqq: "\u2AB6",
  succnsim: "\u22E9",
  succsim: "\u227F",
  sum: "\u2211",
  sung: "\u266A",
  sup1: "\xB9",
  sup2: "\xB2",
  sup3: "\xB3",
  sup: "\u2283",
  supE: "\u2AC6",
  supdot: "\u2ABE",
  supdsub: "\u2AD8",
  supe: "\u2287",
  supedot: "\u2AC4",
  suphsol: "\u27C9",
  suphsub: "\u2AD7",
  suplarr: "\u297B",
  supmult: "\u2AC2",
  supnE: "\u2ACC",
  supne: "\u228B",
  supplus: "\u2AC0",
  supset: "\u2283",
  supseteq: "\u2287",
  supseteqq: "\u2AC6",
  supsetneq: "\u228B",
  supsetneqq: "\u2ACC",
  supsim: "\u2AC8",
  supsub: "\u2AD4",
  supsup: "\u2AD6",
  swArr: "\u21D9",
  swarhk: "\u2926",
  swarr: "\u2199",
  swarrow: "\u2199",
  swnwar: "\u292A",
  szlig: "\xDF",
  target: "\u2316",
  tau: "\u03C4",
  tbrk: "\u23B4",
  tcaron: "\u0165",
  tcedil: "\u0163",
  tcy: "\u0442",
  tdot: "\u20DB",
  telrec: "\u2315",
  tfr: "\u{1D531}",
  there4: "\u2234",
  therefore: "\u2234",
  theta: "\u03B8",
  thetasym: "\u03D1",
  thetav: "\u03D1",
  thickapprox: "\u2248",
  thicksim: "\u223C",
  thinsp: "\u2009",
  thkap: "\u2248",
  thksim: "\u223C",
  thorn: "\xFE",
  tilde: "\u02DC",
  times: "\xD7",
  timesb: "\u22A0",
  timesbar: "\u2A31",
  timesd: "\u2A30",
  tint: "\u222D",
  toea: "\u2928",
  top: "\u22A4",
  topbot: "\u2336",
  topcir: "\u2AF1",
  topf: "\u{1D565}",
  topfork: "\u2ADA",
  tosa: "\u2929",
  tprime: "\u2034",
  trade: "\u2122",
  triangle: "\u25B5",
  triangledown: "\u25BF",
  triangleleft: "\u25C3",
  trianglelefteq: "\u22B4",
  triangleq: "\u225C",
  triangleright: "\u25B9",
  trianglerighteq: "\u22B5",
  tridot: "\u25EC",
  trie: "\u225C",
  triminus: "\u2A3A",
  triplus: "\u2A39",
  trisb: "\u29CD",
  tritime: "\u2A3B",
  trpezium: "\u23E2",
  tscr: "\u{1D4C9}",
  tscy: "\u0446",
  tshcy: "\u045B",
  tstrok: "\u0167",
  twixt: "\u226C",
  twoheadleftarrow: "\u219E",
  twoheadrightarrow: "\u21A0",
  uArr: "\u21D1",
  uHar: "\u2963",
  uacute: "\xFA",
  uarr: "\u2191",
  ubrcy: "\u045E",
  ubreve: "\u016D",
  ucirc: "\xFB",
  ucy: "\u0443",
  udarr: "\u21C5",
  udblac: "\u0171",
  udhar: "\u296E",
  ufisht: "\u297E",
  ufr: "\u{1D532}",
  ugrave: "\xF9",
  uharl: "\u21BF",
  uharr: "\u21BE",
  uhblk: "\u2580",
  ulcorn: "\u231C",
  ulcorner: "\u231C",
  ulcrop: "\u230F",
  ultri: "\u25F8",
  umacr: "\u016B",
  uml: "\xA8",
  uogon: "\u0173",
  uopf: "\u{1D566}",
  uparrow: "\u2191",
  updownarrow: "\u2195",
  upharpoonleft: "\u21BF",
  upharpoonright: "\u21BE",
  uplus: "\u228E",
  upsi: "\u03C5",
  upsih: "\u03D2",
  upsilon: "\u03C5",
  upuparrows: "\u21C8",
  urcorn: "\u231D",
  urcorner: "\u231D",
  urcrop: "\u230E",
  uring: "\u016F",
  urtri: "\u25F9",
  uscr: "\u{1D4CA}",
  utdot: "\u22F0",
  utilde: "\u0169",
  utri: "\u25B5",
  utrif: "\u25B4",
  uuarr: "\u21C8",
  uuml: "\xFC",
  uwangle: "\u29A7",
  vArr: "\u21D5",
  vBar: "\u2AE8",
  vBarv: "\u2AE9",
  vDash: "\u22A8",
  vangrt: "\u299C",
  varepsilon: "\u03F5",
  varkappa: "\u03F0",
  varnothing: "\u2205",
  varphi: "\u03D5",
  varpi: "\u03D6",
  varpropto: "\u221D",
  varr: "\u2195",
  varrho: "\u03F1",
  varsigma: "\u03C2",
  varsubsetneq: "\u228A\uFE00",
  varsubsetneqq: "\u2ACB\uFE00",
  varsupsetneq: "\u228B\uFE00",
  varsupsetneqq: "\u2ACC\uFE00",
  vartheta: "\u03D1",
  vartriangleleft: "\u22B2",
  vartriangleright: "\u22B3",
  vcy: "\u0432",
  vdash: "\u22A2",
  vee: "\u2228",
  veebar: "\u22BB",
  veeeq: "\u225A",
  vellip: "\u22EE",
  verbar: "|",
  vert: "|",
  vfr: "\u{1D533}",
  vltri: "\u22B2",
  vnsub: "\u2282\u20D2",
  vnsup: "\u2283\u20D2",
  vopf: "\u{1D567}",
  vprop: "\u221D",
  vrtri: "\u22B3",
  vscr: "\u{1D4CB}",
  vsubnE: "\u2ACB\uFE00",
  vsubne: "\u228A\uFE00",
  vsupnE: "\u2ACC\uFE00",
  vsupne: "\u228B\uFE00",
  vzigzag: "\u299A",
  wcirc: "\u0175",
  wedbar: "\u2A5F",
  wedge: "\u2227",
  wedgeq: "\u2259",
  weierp: "\u2118",
  wfr: "\u{1D534}",
  wopf: "\u{1D568}",
  wp: "\u2118",
  wr: "\u2240",
  wreath: "\u2240",
  wscr: "\u{1D4CC}",
  xcap: "\u22C2",
  xcirc: "\u25EF",
  xcup: "\u22C3",
  xdtri: "\u25BD",
  xfr: "\u{1D535}",
  xhArr: "\u27FA",
  xharr: "\u27F7",
  xi: "\u03BE",
  xlArr: "\u27F8",
  xlarr: "\u27F5",
  xmap: "\u27FC",
  xnis: "\u22FB",
  xodot: "\u2A00",
  xopf: "\u{1D569}",
  xoplus: "\u2A01",
  xotime: "\u2A02",
  xrArr: "\u27F9",
  xrarr: "\u27F6",
  xscr: "\u{1D4CD}",
  xsqcup: "\u2A06",
  xuplus: "\u2A04",
  xutri: "\u25B3",
  xvee: "\u22C1",
  xwedge: "\u22C0",
  yacute: "\xFD",
  yacy: "\u044F",
  ycirc: "\u0177",
  ycy: "\u044B",
  yen: "\xA5",
  yfr: "\u{1D536}",
  yicy: "\u0457",
  yopf: "\u{1D56A}",
  yscr: "\u{1D4CE}",
  yucy: "\u044E",
  yuml: "\xFF",
  zacute: "\u017A",
  zcaron: "\u017E",
  zcy: "\u0437",
  zdot: "\u017C",
  zeetrf: "\u2128",
  zeta: "\u03B6",
  zfr: "\u{1D537}",
  zhcy: "\u0436",
  zigrarr: "\u21DD",
  zopf: "\u{1D56B}",
  zscr: "\u{1D4CF}",
  zwj: "\u200D",
  zwnj: "\u200C"
};

// node_modules/decode-named-character-reference/index.js
var own = {}.hasOwnProperty;
function decodeNamedCharacterReference(value) {
  return own.call(characterEntities, value) ? characterEntities[value] : false;
}

// node_modules/micromark-util-chunked/index.js
function splice(list2, start, remove, items) {
  const end = list2.length;
  let chunkStart = 0;
  let parameters;
  if (start < 0) {
    start = -start > end ? 0 : end + start;
  } else {
    start = start > end ? end : start;
  }
  remove = remove > 0 ? remove : 0;
  if (items.length < 1e4) {
    parameters = Array.from(items);
    parameters.unshift(start, remove);
    list2.splice(...parameters);
  } else {
    if (remove) list2.splice(start, remove);
    while (chunkStart < items.length) {
      parameters = items.slice(chunkStart, chunkStart + 1e4);
      parameters.unshift(start, 0);
      list2.splice(...parameters);
      chunkStart += 1e4;
      start += 1e4;
    }
  }
}
function push(list2, items) {
  if (list2.length > 0) {
    splice(list2, list2.length, 0, items);
    return list2;
  }
  return items;
}

// node_modules/micromark-util-combine-extensions/index.js
var hasOwnProperty = {}.hasOwnProperty;
function combineExtensions(extensions) {
  const all2 = {};
  let index2 = -1;
  while (++index2 < extensions.length) {
    syntaxExtension(all2, extensions[index2]);
  }
  return all2;
}
function syntaxExtension(all2, extension2) {
  let hook;
  for (hook in extension2) {
    const maybe = hasOwnProperty.call(all2, hook) ? all2[hook] : void 0;
    const left = maybe || (all2[hook] = {});
    const right = extension2[hook];
    let code;
    if (right) {
      for (code in right) {
        if (!hasOwnProperty.call(left, code)) left[code] = [];
        const value = right[code];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}
function constructs(existing, list2) {
  let index2 = -1;
  const before = [];
  while (++index2 < list2.length) {
    ;
    (list2[index2].add === "after" ? existing : before).push(list2[index2]);
  }
  splice(existing, 0, 0, before);
}

// node_modules/micromark-util-decode-numeric-character-reference/index.js
function decodeNumericCharacterReference(value, base) {
  const code = Number.parseInt(value, base);
  if (
    // C0 except for HT, LF, FF, CR, space.
    code < 9 || code === 11 || code > 13 && code < 32 || // Control character (DEL) of C0, and C1 controls.
    code > 126 && code < 160 || // Lone high surrogates and low surrogates.
    code > 55295 && code < 57344 || // Noncharacters.
    code > 64975 && code < 65008 || /* eslint-disable no-bitwise */
    (code & 65535) === 65535 || (code & 65535) === 65534 || /* eslint-enable no-bitwise */
    // Out of range
    code > 1114111
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code);
}

// node_modules/micromark-util-normalize-identifier/index.js
function normalizeIdentifier(value) {
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

// node_modules/micromark-util-character/index.js
var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code) {
  return (
    // Special whitespace codes (which have negative values), C0 and Control
    // character DEL
    code !== null && (code < 32 || code === 127)
  );
}
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code) {
  return code !== null && code < -2;
}
function markdownLineEndingOrSpace(code) {
  return code !== null && (code < 0 || code === 32);
}
function markdownSpace(code) {
  return code === -2 || code === -1 || code === 32;
}
var unicodePunctuation = regexCheck(/\p{P}|\p{S}/u);
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check;
  function check(code) {
    return code !== null && code > -1 && regex.test(String.fromCharCode(code));
  }
}

// node_modules/micromark-factory-space/index.js
function factorySpace(effects, ok, type, max) {
  const limit = max ? max - 1 : Number.POSITIVE_INFINITY;
  let size = 0;
  return start;
  function start(code) {
    if (markdownSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return ok(code);
  }
  function prefix(code) {
    if (markdownSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }
    effects.exit(type);
    return ok(code);
  }
}

// node_modules/micromark/lib/initialize/content.js
var content = {
  tokenize: initializeContent
};
function initializeContent(effects) {
  const contentStart = effects.attempt(this.parser.constructs.contentInitial, afterContentStartConstruct, paragraphInitial);
  let previous2;
  return contentStart;
  function afterContentStartConstruct(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, contentStart, "linePrefix");
  }
  function paragraphInitial(code) {
    effects.enter("paragraph");
    return lineStart(code);
  }
  function lineStart(code) {
    const token = effects.enter("chunkText", {
      contentType: "text",
      previous: previous2
    });
    if (previous2) {
      previous2.next = token;
    }
    previous2 = token;
    return data(code);
  }
  function data(code) {
    if (code === null) {
      effects.exit("chunkText");
      effects.exit("paragraph");
      effects.consume(code);
      return;
    }
    if (markdownLineEnding(code)) {
      effects.consume(code);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code);
    return data;
  }
}

// node_modules/micromark/lib/initialize/document.js
var document = {
  tokenize: initializeDocument
};
var containerConstruct = {
  tokenize: tokenizeContainer
};
function initializeDocument(effects) {
  const self = this;
  const stack = [];
  let continued = 0;
  let childFlow;
  let childToken;
  let lineStartOffset;
  return start;
  function start(code) {
    if (continued < stack.length) {
      const item = stack[continued];
      self.containerState = item[1];
      return effects.attempt(item[0].continuation, documentContinue, checkNewContainers)(code);
    }
    return checkNewContainers(code);
  }
  function documentContinue(code) {
    continued++;
    if (self.containerState._closeFlow) {
      self.containerState._closeFlow = void 0;
      if (childFlow) {
        closeFlow();
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          point3 = self.events[indexBeforeFlow][1].end;
          break;
        }
      }
      exitContainers(continued);
      let index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      splice(self.events, indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      self.events.length = index2;
      return checkNewContainers(code);
    }
    return start(code);
  }
  function checkNewContainers(code) {
    if (continued === stack.length) {
      if (!childFlow) {
        return documentContinued(code);
      }
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code);
      }
      self.interrupt = Boolean(childFlow.currentConstruct && !childFlow._gfmTableDynamicInterruptHack);
    }
    self.containerState = {};
    return effects.check(containerConstruct, thereIsANewContainer, thereIsNoNewContainer)(code);
  }
  function thereIsANewContainer(code) {
    if (childFlow) closeFlow();
    exitContainers(continued);
    return documentContinued(code);
  }
  function thereIsNoNewContainer(code) {
    self.parser.lazy[self.now().line] = continued !== stack.length;
    lineStartOffset = self.now().offset;
    return flowStart(code);
  }
  function documentContinued(code) {
    self.containerState = {};
    return effects.attempt(containerConstruct, containerContinue, flowStart)(code);
  }
  function containerContinue(code) {
    continued++;
    stack.push([self.currentConstruct, self.containerState]);
    return documentContinued(code);
  }
  function flowStart(code) {
    if (code === null) {
      if (childFlow) closeFlow();
      exitContainers(0);
      effects.consume(code);
      return;
    }
    childFlow = childFlow || self.parser.flow(self.now());
    effects.enter("chunkFlow", {
      _tokenizer: childFlow,
      contentType: "flow",
      previous: childToken
    });
    return flowContinue(code);
  }
  function flowContinue(code) {
    if (code === null) {
      writeToChild(effects.exit("chunkFlow"), true);
      exitContainers(0);
      effects.consume(code);
      return;
    }
    if (markdownLineEnding(code)) {
      effects.consume(code);
      writeToChild(effects.exit("chunkFlow"));
      continued = 0;
      self.interrupt = void 0;
      return start;
    }
    effects.consume(code);
    return flowContinue;
  }
  function writeToChild(token, endOfFile) {
    const stream = self.sliceStream(token);
    if (endOfFile) stream.push(null);
    token.previous = childToken;
    if (childToken) childToken.next = token;
    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    if (self.parser.lazy[token.start.line]) {
      let index2 = childFlow.events.length;
      while (index2--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index2][1].start.offset < lineStartOffset && // …and either is not ended yet…
          (!childFlow.events[index2][1].end || // …or ends after it.
          childFlow.events[index2][1].end.offset > lineStartOffset)
        ) {
          return;
        }
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          if (seen) {
            point3 = self.events[indexBeforeFlow][1].end;
            break;
          }
          seen = true;
        }
      }
      exitContainers(continued);
      index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      splice(self.events, indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      self.events.length = index2;
    }
  }
  function exitContainers(size) {
    let index2 = stack.length;
    while (index2-- > size) {
      const entry = stack[index2];
      self.containerState = entry[1];
      entry[0].exit.call(self, effects);
    }
    stack.length = size;
  }
  function closeFlow() {
    childFlow.write([null]);
    childToken = void 0;
    childFlow = void 0;
    self.containerState._closeFlow = void 0;
  }
}
function tokenizeContainer(effects, ok, nok) {
  return factorySpace(effects, effects.attempt(this.parser.constructs.document, ok, nok), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}

// node_modules/micromark-util-classify-character/index.js
function classifyCharacter(code) {
  if (code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)) {
    return 1;
  }
  if (unicodePunctuation(code)) {
    return 2;
  }
}

// node_modules/micromark-util-resolve-all/index.js
function resolveAll(constructs2, events, context) {
  const called = [];
  let index2 = -1;
  while (++index2 < constructs2.length) {
    const resolve10 = constructs2[index2].resolveAll;
    if (resolve10 && !called.includes(resolve10)) {
      events = resolve10(events, context);
      called.push(resolve10);
    }
  }
  return events;
}

// node_modules/micromark-core-commonmark/lib/attention.js
var attention = {
  name: "attention",
  resolveAll: resolveAllAttention,
  tokenize: tokenizeAttention
};
function resolveAllAttention(events, context) {
  let index2 = -1;
  let open2;
  let group;
  let text3;
  let openingSequence;
  let closingSequence;
  let use;
  let nextEvents;
  let offset;
  while (++index2 < events.length) {
    if (events[index2][0] === "enter" && events[index2][1].type === "attentionSequence" && events[index2][1]._close) {
      open2 = index2;
      while (open2--) {
        if (events[open2][0] === "exit" && events[open2][1].type === "attentionSequence" && events[open2][1]._open && // If the markers are the same:
        context.sliceSerialize(events[open2][1]).charCodeAt(0) === context.sliceSerialize(events[index2][1]).charCodeAt(0)) {
          if ((events[open2][1]._close || events[index2][1]._open) && (events[index2][1].end.offset - events[index2][1].start.offset) % 3 && !((events[open2][1].end.offset - events[open2][1].start.offset + events[index2][1].end.offset - events[index2][1].start.offset) % 3)) {
            continue;
          }
          use = events[open2][1].end.offset - events[open2][1].start.offset > 1 && events[index2][1].end.offset - events[index2][1].start.offset > 1 ? 2 : 1;
          const start = {
            ...events[open2][1].end
          };
          const end = {
            ...events[index2][1].start
          };
          movePoint(start, -use);
          movePoint(end, use);
          openingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start,
            end: {
              ...events[open2][1].end
            }
          };
          closingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: {
              ...events[index2][1].start
            },
            end
          };
          text3 = {
            type: use > 1 ? "strongText" : "emphasisText",
            start: {
              ...events[open2][1].end
            },
            end: {
              ...events[index2][1].start
            }
          };
          group = {
            type: use > 1 ? "strong" : "emphasis",
            start: {
              ...openingSequence.start
            },
            end: {
              ...closingSequence.end
            }
          };
          events[open2][1].end = {
            ...openingSequence.start
          };
          events[index2][1].start = {
            ...closingSequence.end
          };
          nextEvents = [];
          if (events[open2][1].end.offset - events[open2][1].start.offset) {
            nextEvents = push(nextEvents, [["enter", events[open2][1], context], ["exit", events[open2][1], context]]);
          }
          nextEvents = push(nextEvents, [["enter", group, context], ["enter", openingSequence, context], ["exit", openingSequence, context], ["enter", text3, context]]);
          nextEvents = push(nextEvents, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open2 + 1, index2), context));
          nextEvents = push(nextEvents, [["exit", text3, context], ["enter", closingSequence, context], ["exit", closingSequence, context], ["exit", group, context]]);
          if (events[index2][1].end.offset - events[index2][1].start.offset) {
            offset = 2;
            nextEvents = push(nextEvents, [["enter", events[index2][1], context], ["exit", events[index2][1], context]]);
          } else {
            offset = 0;
          }
          splice(events, open2 - 1, index2 - open2 + 3, nextEvents);
          index2 = open2 + nextEvents.length - offset - 2;
          break;
        }
      }
    }
  }
  index2 = -1;
  while (++index2 < events.length) {
    if (events[index2][1].type === "attentionSequence") {
      events[index2][1].type = "data";
    }
  }
  return events;
}
function tokenizeAttention(effects, ok) {
  const attentionMarkers2 = this.parser.constructs.attentionMarkers.null;
  const previous2 = this.previous;
  const before = classifyCharacter(previous2);
  let marker;
  return start;
  function start(code) {
    marker = code;
    effects.enter("attentionSequence");
    return inside(code);
  }
  function inside(code) {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code);
    const open2 = !after || after === 2 && before || attentionMarkers2.includes(code);
    const close = !before || before === 2 && after || attentionMarkers2.includes(previous2);
    token._open = Boolean(marker === 42 ? open2 : open2 && (before || !close));
    token._close = Boolean(marker === 42 ? close : close && (after || !open2));
    return ok(code);
  }
}
function movePoint(point3, offset) {
  point3.column += offset;
  point3.offset += offset;
  point3._bufferIndex += offset;
}

// node_modules/micromark-core-commonmark/lib/autolink.js
var autolink = {
  name: "autolink",
  tokenize: tokenizeAutolink
};
function tokenizeAutolink(effects, ok, nok) {
  let size = 0;
  return start;
  function start(code) {
    effects.enter("autolink");
    effects.enter("autolinkMarker");
    effects.consume(code);
    effects.exit("autolinkMarker");
    effects.enter("autolinkProtocol");
    return open2;
  }
  function open2(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return schemeOrEmailAtext;
    }
    if (code === 64) {
      return nok(code);
    }
    return emailAtext(code);
  }
  function schemeOrEmailAtext(code) {
    if (code === 43 || code === 45 || code === 46 || asciiAlphanumeric(code)) {
      size = 1;
      return schemeInsideOrEmailAtext(code);
    }
    return emailAtext(code);
  }
  function schemeInsideOrEmailAtext(code) {
    if (code === 58) {
      effects.consume(code);
      size = 0;
      return urlInside;
    }
    if ((code === 43 || code === 45 || code === 46 || asciiAlphanumeric(code)) && size++ < 32) {
      effects.consume(code);
      return schemeInsideOrEmailAtext;
    }
    size = 0;
    return emailAtext(code);
  }
  function urlInside(code) {
    if (code === 62) {
      effects.exit("autolinkProtocol");
      effects.enter("autolinkMarker");
      effects.consume(code);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok;
    }
    if (code === null || code === 32 || code === 60 || asciiControl(code)) {
      return nok(code);
    }
    effects.consume(code);
    return urlInside;
  }
  function emailAtext(code) {
    if (code === 64) {
      effects.consume(code);
      return emailAtSignOrDot;
    }
    if (asciiAtext(code)) {
      effects.consume(code);
      return emailAtext;
    }
    return nok(code);
  }
  function emailAtSignOrDot(code) {
    return asciiAlphanumeric(code) ? emailLabel(code) : nok(code);
  }
  function emailLabel(code) {
    if (code === 46) {
      effects.consume(code);
      size = 0;
      return emailAtSignOrDot;
    }
    if (code === 62) {
      effects.exit("autolinkProtocol").type = "autolinkEmail";
      effects.enter("autolinkMarker");
      effects.consume(code);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok;
    }
    return emailValue(code);
  }
  function emailValue(code) {
    if ((code === 45 || asciiAlphanumeric(code)) && size++ < 63) {
      const next = code === 45 ? emailValue : emailLabel;
      effects.consume(code);
      return next;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/blank-line.js
var blankLine = {
  partial: true,
  tokenize: tokenizeBlankLine
};
function tokenizeBlankLine(effects, ok, nok) {
  return start;
  function start(code) {
    return markdownSpace(code) ? factorySpace(effects, after, "linePrefix")(code) : after(code);
  }
  function after(code) {
    return code === null || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/block-quote.js
var blockQuote = {
  continuation: {
    tokenize: tokenizeBlockQuoteContinuation
  },
  exit,
  name: "blockQuote",
  tokenize: tokenizeBlockQuoteStart
};
function tokenizeBlockQuoteStart(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (code === 62) {
      const state = self.containerState;
      if (!state.open) {
        effects.enter("blockQuote", {
          _container: true
        });
        state.open = true;
      }
      effects.enter("blockQuotePrefix");
      effects.enter("blockQuoteMarker");
      effects.consume(code);
      effects.exit("blockQuoteMarker");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    if (markdownSpace(code)) {
      effects.enter("blockQuotePrefixWhitespace");
      effects.consume(code);
      effects.exit("blockQuotePrefixWhitespace");
      effects.exit("blockQuotePrefix");
      return ok;
    }
    effects.exit("blockQuotePrefix");
    return ok(code);
  }
}
function tokenizeBlockQuoteContinuation(effects, ok, nok) {
  const self = this;
  return contStart;
  function contStart(code) {
    if (markdownSpace(code)) {
      return factorySpace(effects, contBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code);
    }
    return contBefore(code);
  }
  function contBefore(code) {
    return effects.attempt(blockQuote, ok, nok)(code);
  }
}
function exit(effects) {
  effects.exit("blockQuote");
}

// node_modules/micromark-core-commonmark/lib/character-escape.js
var characterEscape = {
  name: "characterEscape",
  tokenize: tokenizeCharacterEscape
};
function tokenizeCharacterEscape(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("characterEscape");
    effects.enter("escapeMarker");
    effects.consume(code);
    effects.exit("escapeMarker");
    return inside;
  }
  function inside(code) {
    if (asciiPunctuation(code)) {
      effects.enter("characterEscapeValue");
      effects.consume(code);
      effects.exit("characterEscapeValue");
      effects.exit("characterEscape");
      return ok;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/character-reference.js
var characterReference = {
  name: "characterReference",
  tokenize: tokenizeCharacterReference
};
function tokenizeCharacterReference(effects, ok, nok) {
  const self = this;
  let size = 0;
  let max;
  let test;
  return start;
  function start(code) {
    effects.enter("characterReference");
    effects.enter("characterReferenceMarker");
    effects.consume(code);
    effects.exit("characterReferenceMarker");
    return open2;
  }
  function open2(code) {
    if (code === 35) {
      effects.enter("characterReferenceMarkerNumeric");
      effects.consume(code);
      effects.exit("characterReferenceMarkerNumeric");
      return numeric;
    }
    effects.enter("characterReferenceValue");
    max = 31;
    test = asciiAlphanumeric;
    return value(code);
  }
  function numeric(code) {
    if (code === 88 || code === 120) {
      effects.enter("characterReferenceMarkerHexadecimal");
      effects.consume(code);
      effects.exit("characterReferenceMarkerHexadecimal");
      effects.enter("characterReferenceValue");
      max = 6;
      test = asciiHexDigit;
      return value;
    }
    effects.enter("characterReferenceValue");
    max = 7;
    test = asciiDigit;
    return value(code);
  }
  function value(code) {
    if (code === 59 && size) {
      const token = effects.exit("characterReferenceValue");
      if (test === asciiAlphanumeric && !decodeNamedCharacterReference(self.sliceSerialize(token))) {
        return nok(code);
      }
      effects.enter("characterReferenceMarker");
      effects.consume(code);
      effects.exit("characterReferenceMarker");
      effects.exit("characterReference");
      return ok;
    }
    if (test(code) && size++ < max) {
      effects.consume(code);
      return value;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-fenced.js
var nonLazyContinuation = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
};
var codeFenced = {
  concrete: true,
  name: "codeFenced",
  tokenize: tokenizeCodeFenced
};
function tokenizeCodeFenced(effects, ok, nok) {
  const self = this;
  const closeStart = {
    partial: true,
    tokenize: tokenizeCloseStart
  };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker;
  return start;
  function start(code) {
    return beforeSequenceOpen(code);
  }
  function beforeSequenceOpen(code) {
    const tail = self.events[self.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    marker = code;
    effects.enter("codeFenced");
    effects.enter("codeFencedFence");
    effects.enter("codeFencedFenceSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === marker) {
      sizeOpen++;
      effects.consume(code);
      return sequenceOpen;
    }
    if (sizeOpen < 3) {
      return nok(code);
    }
    effects.exit("codeFencedFenceSequence");
    return markdownSpace(code) ? factorySpace(effects, infoBefore, "whitespace")(code) : infoBefore(code);
  }
  function infoBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFencedFence");
      return self.interrupt ? ok(code) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }
    effects.enter("codeFencedFenceInfo");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return info(code);
  }
  function info(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return infoBefore(code);
    }
    if (markdownSpace(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return factorySpace(effects, metaBefore, "whitespace")(code);
    }
    if (code === 96 && code === marker) {
      return nok(code);
    }
    effects.consume(code);
    return info;
  }
  function metaBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      return infoBefore(code);
    }
    effects.enter("codeFencedFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code);
  }
  function meta(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceMeta");
      return infoBefore(code);
    }
    if (code === 96 && code === marker) {
      return nok(code);
    }
    effects.consume(code);
    return meta;
  }
  function atNonLazyBreak(code) {
    return effects.attempt(closeStart, after, contentBefore)(code);
  }
  function contentBefore(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return contentStart;
  }
  function contentStart(code) {
    return initialPrefix > 0 && markdownSpace(code) ? factorySpace(effects, beforeContentChunk, "linePrefix", initialPrefix + 1)(code) : beforeContentChunk(code);
  }
  function beforeContentChunk(code) {
    if (code === null || markdownLineEnding(code)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
    }
    effects.enter("codeFlowValue");
    return contentChunk(code);
  }
  function contentChunk(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFlowValue");
      return beforeContentChunk(code);
    }
    effects.consume(code);
    return contentChunk;
  }
  function after(code) {
    effects.exit("codeFenced");
    return ok(code);
  }
  function tokenizeCloseStart(effects2, ok2, nok2) {
    let size = 0;
    return startBefore;
    function startBefore(code) {
      effects2.enter("lineEnding");
      effects2.consume(code);
      effects2.exit("lineEnding");
      return start2;
    }
    function start2(code) {
      effects2.enter("codeFencedFence");
      return markdownSpace(code) ? factorySpace(effects2, beforeSequenceClose, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code) : beforeSequenceClose(code);
    }
    function beforeSequenceClose(code) {
      if (code === marker) {
        effects2.enter("codeFencedFenceSequence");
        return sequenceClose(code);
      }
      return nok2(code);
    }
    function sequenceClose(code) {
      if (code === marker) {
        size++;
        effects2.consume(code);
        return sequenceClose;
      }
      if (size >= sizeOpen) {
        effects2.exit("codeFencedFenceSequence");
        return markdownSpace(code) ? factorySpace(effects2, sequenceCloseAfter, "whitespace")(code) : sequenceCloseAfter(code);
      }
      return nok2(code);
    }
    function sequenceCloseAfter(code) {
      if (code === null || markdownLineEnding(code)) {
        effects2.exit("codeFencedFence");
        return ok2(code);
      }
      return nok2(code);
    }
  }
}
function tokenizeNonLazyContinuation(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (code === null) {
      return nok(code);
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return lineStart;
  }
  function lineStart(code) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-indented.js
var codeIndented = {
  name: "codeIndented",
  tokenize: tokenizeCodeIndented
};
var furtherStart = {
  partial: true,
  tokenize: tokenizeFurtherStart
};
function tokenizeCodeIndented(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    effects.enter("codeIndented");
    return factorySpace(effects, afterPrefix, "linePrefix", 4 + 1)(code);
  }
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4 ? atBreak(code) : nok(code);
  }
  function atBreak(code) {
    if (code === null) {
      return after(code);
    }
    if (markdownLineEnding(code)) {
      return effects.attempt(furtherStart, atBreak, after)(code);
    }
    effects.enter("codeFlowValue");
    return inside(code);
  }
  function inside(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("codeFlowValue");
      return atBreak(code);
    }
    effects.consume(code);
    return inside;
  }
  function after(code) {
    effects.exit("codeIndented");
    return ok(code);
  }
}
function tokenizeFurtherStart(effects, ok, nok) {
  const self = this;
  return furtherStart2;
  function furtherStart2(code) {
    if (self.parser.lazy[self.now().line]) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return furtherStart2;
    }
    return factorySpace(effects, afterPrefix, "linePrefix", 4 + 1)(code);
  }
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4 ? ok(code) : markdownLineEnding(code) ? furtherStart2(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/code-text.js
var codeText = {
  name: "codeText",
  previous,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText
};
function resolveCodeText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index2;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index2 = headEnterIndex;
    while (++index2 < tailExitIndex) {
      if (events[index2][1].type === "codeTextData") {
        events[headEnterIndex][1].type = "codeTextPadding";
        events[tailExitIndex][1].type = "codeTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index2 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index2 <= tailExitIndex) {
    if (enter === void 0) {
      if (index2 !== tailExitIndex && events[index2][1].type !== "lineEnding") {
        enter = index2;
      }
    } else if (index2 === tailExitIndex || events[index2][1].type === "lineEnding") {
      events[enter][1].type = "codeTextData";
      if (index2 !== enter + 2) {
        events[enter][1].end = events[index2 - 1][1].end;
        events.splice(enter + 2, index2 - enter - 2);
        tailExitIndex -= index2 - enter - 2;
        index2 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
function previous(code) {
  return code !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
function tokenizeCodeText(effects, ok, nok) {
  const self = this;
  let sizeOpen = 0;
  let size;
  let token;
  return start;
  function start(code) {
    effects.enter("codeText");
    effects.enter("codeTextSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === 96) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    effects.exit("codeTextSequence");
    return between(code);
  }
  function between(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 32) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      return between;
    }
    if (code === 96) {
      token = effects.enter("codeTextSequence");
      size = 0;
      return sequenceClose(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("codeTextData");
    return data(code);
  }
  function data(code) {
    if (code === null || code === 32 || code === 96 || markdownLineEnding(code)) {
      effects.exit("codeTextData");
      return between(code);
    }
    effects.consume(code);
    return data;
  }
  function sequenceClose(code) {
    if (code === 96) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      effects.exit("codeTextSequence");
      effects.exit("codeText");
      return ok(code);
    }
    token.type = "codeTextData";
    return data(code);
  }
}

// node_modules/micromark-util-subtokenize/lib/splice-buffer.js
var SpliceBuffer = class {
  /**
   * @param {ReadonlyArray<T> | null | undefined} [initial]
   *   Initial items (optional).
   * @returns
   *   Splice buffer.
   */
  constructor(initial) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }
  /**
   * Array access;
   * does not move the cursor.
   *
   * @param {number} index
   *   Index.
   * @return {T}
   *   Item.
   */
  get(index2) {
    if (index2 < 0 || index2 >= this.left.length + this.right.length) {
      throw new RangeError("Cannot access index `" + index2 + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
    }
    if (index2 < this.left.length) return this.left[index2];
    return this.right[this.right.length - index2 + this.left.length - 1];
  }
  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length() {
    return this.left.length + this.right.length;
  }
  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  shift() {
    this.setCursor(0);
    return this.right.pop();
  }
  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param {number} start
   *   Start.
   * @param {number | null | undefined} [end]
   *   End (optional).
   * @returns {Array<T>}
   *   Array of items.
   */
  slice(start, end) {
    const stop = end === null || end === void 0 ? Number.POSITIVE_INFINITY : end;
    if (stop < this.left.length) {
      return this.left.slice(start, stop);
    }
    if (start > this.left.length) {
      return this.right.slice(this.right.length - stop + this.left.length, this.right.length - start + this.left.length).reverse();
    }
    return this.left.slice(start).concat(this.right.slice(this.right.length - stop + this.left.length).reverse());
  }
  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param {number} start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param {number | null | undefined} [deleteCount=0]
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param {Array<T> | null | undefined} [items=[]]
   *   Items to include in place of the deleted items (default: `[]`).
   * @return {Array<T>}
   *   Any removed items.
   */
  splice(start, deleteCount, items) {
    const count = deleteCount || 0;
    this.setCursor(Math.trunc(start));
    const removed = this.right.splice(this.right.length - count, Number.POSITIVE_INFINITY);
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }
  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  pop() {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }
  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  push(item) {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }
  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  pushMany(items) {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }
  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  unshift(item) {
    this.setCursor(0);
    this.right.push(item);
  }
  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  unshiftMany(items) {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }
  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param {number} n
   *   Position.
   * @return {undefined}
   *   Nothing.
   */
  setCursor(n) {
    if (n === this.left.length || n > this.left.length && this.right.length === 0 || n < 0 && this.left.length === 0) return;
    if (n < this.left.length) {
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      const removed = this.right.splice(this.left.length + this.right.length - n, Number.POSITIVE_INFINITY);
      chunkedPush(this.left, removed.reverse());
    }
  }
};
function chunkedPush(list2, right) {
  let chunkStart = 0;
  if (right.length < 1e4) {
    list2.push(...right);
  } else {
    while (chunkStart < right.length) {
      list2.push(...right.slice(chunkStart, chunkStart + 1e4));
      chunkStart += 1e4;
    }
  }
}

// node_modules/micromark-util-subtokenize/index.js
function subtokenize(eventsArray) {
  const jumps = {};
  let index2 = -1;
  let event;
  let lineIndex;
  let otherIndex;
  let otherEvent;
  let parameters;
  let subevents;
  let more;
  const events = new SpliceBuffer(eventsArray);
  while (++index2 < events.length) {
    while (index2 in jumps) {
      index2 = jumps[index2];
    }
    event = events.get(index2);
    if (index2 && event[1].type === "chunkFlow" && events.get(index2 - 1)[1].type === "listItemPrefix") {
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "lineEndingBlank") {
        otherIndex += 2;
      }
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "content") {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === "content") {
            break;
          }
          if (subevents[otherIndex][1].type === "chunkText") {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }
    if (event[0] === "enter") {
      if (event[1].contentType) {
        Object.assign(jumps, subcontent(events, index2));
        index2 = jumps[index2];
        more = true;
      }
    } else if (event[1]._container) {
      otherIndex = index2;
      lineIndex = void 0;
      while (otherIndex--) {
        otherEvent = events.get(otherIndex);
        if (otherEvent[1].type === "lineEnding" || otherEvent[1].type === "lineEndingBlank") {
          if (otherEvent[0] === "enter") {
            if (lineIndex) {
              events.get(lineIndex)[1].type = "lineEndingBlank";
            }
            otherEvent[1].type = "lineEnding";
            lineIndex = otherIndex;
          }
        } else if (otherEvent[1].type === "linePrefix" || otherEvent[1].type === "listItemIndent") {
        } else {
          break;
        }
      }
      if (lineIndex) {
        event[1].end = {
          ...events.get(lineIndex)[1].start
        };
        parameters = events.slice(lineIndex, index2);
        parameters.unshift(event);
        events.splice(lineIndex, index2 - lineIndex + 1, parameters);
      }
    }
  }
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}
function subcontent(events, eventIndex) {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions = [];
  let tokenizer = token._tokenizer;
  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);
    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }
  const childEvents = tokenizer.events;
  const jumps = [];
  const gaps = {};
  let stream;
  let previous2;
  let index2 = -1;
  let current = token;
  let adjust = 0;
  let start = 0;
  const breaks = [start];
  while (current) {
    while (events.get(++startPosition)[1] !== current) {
    }
    startPositions.push(startPosition);
    if (!current._tokenizer) {
      stream = context.sliceStream(current);
      if (!current.next) {
        stream.push(null);
      }
      if (previous2) {
        tokenizer.defineSkip(current.start);
      }
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }
      tokenizer.write(stream);
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = void 0;
      }
    }
    previous2 = current;
    current = current.next;
  }
  current = token;
  while (++index2 < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index2][0] === "exit" && childEvents[index2 - 1][0] === "enter" && childEvents[index2][1].type === childEvents[index2 - 1][1].type && childEvents[index2][1].start.line !== childEvents[index2][1].end.line
    ) {
      start = index2 + 1;
      breaks.push(start);
      current._tokenizer = void 0;
      current.previous = void 0;
      current = current.next;
    }
  }
  tokenizer.events = [];
  if (current) {
    current._tokenizer = void 0;
    current.previous = void 0;
  } else {
    breaks.pop();
  }
  index2 = breaks.length;
  while (index2--) {
    const slice = childEvents.slice(breaks[index2], breaks[index2 + 1]);
    const start2 = startPositions.pop();
    jumps.push([start2, start2 + slice.length - 1]);
    events.splice(start2, 2, slice);
  }
  jumps.reverse();
  index2 = -1;
  while (++index2 < jumps.length) {
    gaps[adjust + jumps[index2][0]] = adjust + jumps[index2][1];
    adjust += jumps[index2][1] - jumps[index2][0] - 1;
  }
  return gaps;
}

// node_modules/micromark-core-commonmark/lib/content.js
var content2 = {
  resolve: resolveContent,
  tokenize: tokenizeContent
};
var continuationConstruct = {
  partial: true,
  tokenize: tokenizeContinuation
};
function resolveContent(events) {
  subtokenize(events);
  return events;
}
function tokenizeContent(effects, ok) {
  let previous2;
  return chunkStart;
  function chunkStart(code) {
    effects.enter("content");
    previous2 = effects.enter("chunkContent", {
      contentType: "content"
    });
    return chunkInside(code);
  }
  function chunkInside(code) {
    if (code === null) {
      return contentEnd(code);
    }
    if (markdownLineEnding(code)) {
      return effects.check(continuationConstruct, contentContinue, contentEnd)(code);
    }
    effects.consume(code);
    return chunkInside;
  }
  function contentEnd(code) {
    effects.exit("chunkContent");
    effects.exit("content");
    return ok(code);
  }
  function contentContinue(code) {
    effects.consume(code);
    effects.exit("chunkContent");
    previous2.next = effects.enter("chunkContent", {
      contentType: "content",
      previous: previous2
    });
    previous2 = previous2.next;
    return chunkInside;
  }
}
function tokenizeContinuation(effects, ok, nok) {
  const self = this;
  return startLookahead;
  function startLookahead(code) {
    effects.exit("chunkContent");
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, prefixed, "linePrefix");
  }
  function prefixed(code) {
    if (code === null || markdownLineEnding(code)) {
      return nok(code);
    }
    const tail = self.events[self.events.length - 1];
    if (!self.parser.constructs.disable.null.includes("codeIndented") && tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4) {
      return ok(code);
    }
    return effects.interrupt(self.parser.constructs.flow, nok, ok)(code);
  }
}

// node_modules/micromark-factory-destination/index.js
function factoryDestination(effects, ok, nok, type, literalType, literalMarkerType, rawType, stringType, max) {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;
  return start;
  function start(code) {
    if (code === 60) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }
    if (code === null || code === 32 || code === 41 || asciiControl(code)) {
      return nok(code);
    }
    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return raw(code);
  }
  function enclosedBefore(code) {
    if (code === 62) {
      effects.enter(literalMarkerType);
      effects.consume(code);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return enclosed(code);
  }
  function enclosed(code) {
    if (code === 62) {
      effects.exit("chunkString");
      effects.exit(stringType);
      return enclosedBefore(code);
    }
    if (code === null || code === 60 || markdownLineEnding(code)) {
      return nok(code);
    }
    effects.consume(code);
    return code === 92 ? enclosedEscape : enclosed;
  }
  function enclosedEscape(code) {
    if (code === 60 || code === 62 || code === 92) {
      effects.consume(code);
      return enclosed;
    }
    return enclosed(code);
  }
  function raw(code) {
    if (!balance && (code === null || code === 41 || markdownLineEndingOrSpace(code))) {
      effects.exit("chunkString");
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok(code);
    }
    if (balance < limit && code === 40) {
      effects.consume(code);
      balance++;
      return raw;
    }
    if (code === 41) {
      effects.consume(code);
      balance--;
      return raw;
    }
    if (code === null || code === 32 || code === 40 || asciiControl(code)) {
      return nok(code);
    }
    effects.consume(code);
    return code === 92 ? rawEscape : raw;
  }
  function rawEscape(code) {
    if (code === 40 || code === 41 || code === 92) {
      effects.consume(code);
      return raw;
    }
    return raw(code);
  }
}

// node_modules/micromark-factory-label/index.js
function factoryLabel(effects, ok, nok, type, markerType, stringType) {
  const self = this;
  let size = 0;
  let seen;
  return start;
  function start(code) {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }
  function atBreak(code) {
    if (size > 999 || code === null || code === 91 || code === 93 && !seen || // To do: remove in the future once we’ve switched from
    // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
    // which doesn’t need this.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    code === 94 && !size && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code);
    }
    if (code === 93) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return atBreak;
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return labelInside(code);
  }
  function labelInside(code) {
    if (code === null || code === 91 || code === 93 || markdownLineEnding(code) || size++ > 999) {
      effects.exit("chunkString");
      return atBreak(code);
    }
    effects.consume(code);
    if (!seen) seen = !markdownSpace(code);
    return code === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code) {
    if (code === 91 || code === 92 || code === 93) {
      effects.consume(code);
      size++;
      return labelInside;
    }
    return labelInside(code);
  }
}

// node_modules/micromark-factory-title/index.js
function factoryTitle(effects, ok, nok, type, markerType, stringType) {
  let marker;
  return start;
  function start(code) {
    if (code === 34 || code === 39 || code === 40) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      marker = code === 40 ? 41 : code;
      return begin;
    }
    return nok(code);
  }
  function begin(code) {
    if (code === marker) {
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    return atBreak(code);
  }
  function atBreak(code) {
    if (code === marker) {
      effects.exit(stringType);
      return begin(marker);
    }
    if (code === null) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return factorySpace(effects, atBreak, "linePrefix");
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return inside(code);
  }
  function inside(code) {
    if (code === marker || code === null || markdownLineEnding(code)) {
      effects.exit("chunkString");
      return atBreak(code);
    }
    effects.consume(code);
    return code === 92 ? escape : inside;
  }
  function escape(code) {
    if (code === marker || code === 92) {
      effects.consume(code);
      return inside;
    }
    return inside(code);
  }
}

// node_modules/micromark-factory-whitespace/index.js
function factoryWhitespace(effects, ok) {
  let seen;
  return start;
  function start(code) {
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      seen = true;
      return start;
    }
    if (markdownSpace(code)) {
      return factorySpace(effects, start, seen ? "linePrefix" : "lineSuffix")(code);
    }
    return ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/definition.js
var definition = {
  name: "definition",
  tokenize: tokenizeDefinition
};
var titleBefore = {
  partial: true,
  tokenize: tokenizeTitleBefore
};
function tokenizeDefinition(effects, ok, nok) {
  const self = this;
  let identifier;
  return start;
  function start(code) {
    effects.enter("definition");
    return before(code);
  }
  function before(code) {
    return factoryLabel.call(
      self,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionLabel",
      "definitionLabelMarker",
      "definitionLabelString"
    )(code);
  }
  function labelAfter(code) {
    identifier = normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1));
    if (code === 58) {
      effects.enter("definitionMarker");
      effects.consume(code);
      effects.exit("definitionMarker");
      return markerAfter;
    }
    return nok(code);
  }
  function markerAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, destinationBefore)(code) : destinationBefore(code);
  }
  function destinationBefore(code) {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionDestination",
      "definitionDestinationLiteral",
      "definitionDestinationLiteralMarker",
      "definitionDestinationRaw",
      "definitionDestinationString"
    )(code);
  }
  function destinationAfter(code) {
    return effects.attempt(titleBefore, after, after)(code);
  }
  function after(code) {
    return markdownSpace(code) ? factorySpace(effects, afterWhitespace, "whitespace")(code) : afterWhitespace(code);
  }
  function afterWhitespace(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("definition");
      self.parser.defined.push(identifier);
      return ok(code);
    }
    return nok(code);
  }
}
function tokenizeTitleBefore(effects, ok, nok) {
  return titleBefore2;
  function titleBefore2(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, beforeMarker)(code) : nok(code);
  }
  function beforeMarker(code) {
    return factoryTitle(effects, titleAfter, nok, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(code);
  }
  function titleAfter(code) {
    return markdownSpace(code) ? factorySpace(effects, titleAfterOptionalWhitespace, "whitespace")(code) : titleAfterOptionalWhitespace(code);
  }
  function titleAfterOptionalWhitespace(code) {
    return code === null || markdownLineEnding(code) ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/hard-break-escape.js
var hardBreakEscape = {
  name: "hardBreakEscape",
  tokenize: tokenizeHardBreakEscape
};
function tokenizeHardBreakEscape(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("hardBreakEscape");
    effects.consume(code);
    return after;
  }
  function after(code) {
    if (markdownLineEnding(code)) {
      effects.exit("hardBreakEscape");
      return ok(code);
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/heading-atx.js
var headingAtx = {
  name: "headingAtx",
  resolve: resolveHeadingAtx,
  tokenize: tokenizeHeadingAtx
};
function resolveHeadingAtx(events, context) {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  let content3;
  let text3;
  if (events[contentStart][1].type === "whitespace") {
    contentStart += 2;
  }
  if (contentEnd - 2 > contentStart && events[contentEnd][1].type === "whitespace") {
    contentEnd -= 2;
  }
  if (events[contentEnd][1].type === "atxHeadingSequence" && (contentStart === contentEnd - 1 || contentEnd - 4 > contentStart && events[contentEnd - 2][1].type === "whitespace")) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }
  if (contentEnd > contentStart) {
    content3 = {
      type: "atxHeadingText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end
    };
    text3 = {
      type: "chunkText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: "text"
    };
    splice(events, contentStart, contentEnd - contentStart + 1, [["enter", content3, context], ["enter", text3, context], ["exit", text3, context], ["exit", content3, context]]);
  }
  return events;
}
function tokenizeHeadingAtx(effects, ok, nok) {
  let size = 0;
  return start;
  function start(code) {
    effects.enter("atxHeading");
    return before(code);
  }
  function before(code) {
    effects.enter("atxHeadingSequence");
    return sequenceOpen(code);
  }
  function sequenceOpen(code) {
    if (code === 35 && size++ < 6) {
      effects.consume(code);
      return sequenceOpen;
    }
    if (code === null || markdownLineEndingOrSpace(code)) {
      effects.exit("atxHeadingSequence");
      return atBreak(code);
    }
    return nok(code);
  }
  function atBreak(code) {
    if (code === 35) {
      effects.enter("atxHeadingSequence");
      return sequenceFurther(code);
    }
    if (code === null || markdownLineEnding(code)) {
      effects.exit("atxHeading");
      return ok(code);
    }
    if (markdownSpace(code)) {
      return factorySpace(effects, atBreak, "whitespace")(code);
    }
    effects.enter("atxHeadingText");
    return data(code);
  }
  function sequenceFurther(code) {
    if (code === 35) {
      effects.consume(code);
      return sequenceFurther;
    }
    effects.exit("atxHeadingSequence");
    return atBreak(code);
  }
  function data(code) {
    if (code === null || code === 35 || markdownLineEndingOrSpace(code)) {
      effects.exit("atxHeadingText");
      return atBreak(code);
    }
    effects.consume(code);
    return data;
  }
}

// node_modules/micromark-util-html-tag-name/index.js
var htmlBlockNames = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
];
var htmlRawNames = ["pre", "script", "style", "textarea"];

// node_modules/micromark-core-commonmark/lib/html-flow.js
var htmlFlow = {
  concrete: true,
  name: "htmlFlow",
  resolveTo: resolveToHtmlFlow,
  tokenize: tokenizeHtmlFlow
};
var blankLineBefore = {
  partial: true,
  tokenize: tokenizeBlankLineBefore
};
var nonLazyContinuationStart = {
  partial: true,
  tokenize: tokenizeNonLazyContinuationStart
};
function resolveToHtmlFlow(events) {
  let index2 = events.length;
  while (index2--) {
    if (events[index2][0] === "enter" && events[index2][1].type === "htmlFlow") {
      break;
    }
  }
  if (index2 > 1 && events[index2 - 2][1].type === "linePrefix") {
    events[index2][1].start = events[index2 - 2][1].start;
    events[index2 + 1][1].start = events[index2 - 2][1].start;
    events.splice(index2 - 2, 2);
  }
  return events;
}
function tokenizeHtmlFlow(effects, ok, nok) {
  const self = this;
  let marker;
  let closingTag;
  let buffer;
  let index2;
  let markerB;
  return start;
  function start(code) {
    return before(code);
  }
  function before(code) {
    effects.enter("htmlFlow");
    effects.enter("htmlFlowData");
    effects.consume(code);
    return open2;
  }
  function open2(code) {
    if (code === 33) {
      effects.consume(code);
      return declarationOpen;
    }
    if (code === 47) {
      effects.consume(code);
      closingTag = true;
      return tagCloseStart;
    }
    if (code === 63) {
      effects.consume(code);
      marker = 3;
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === 45) {
      effects.consume(code);
      marker = 2;
      return commentOpenInside;
    }
    if (code === 91) {
      effects.consume(code);
      marker = 5;
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      marker = 4;
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    return nok(code);
  }
  function commentOpenInside(code) {
    if (code === 45) {
      effects.consume(code);
      return self.interrupt ? ok : continuationDeclarationInside;
    }
    return nok(code);
  }
  function cdataOpenInside(code) {
    const value = "CDATA[";
    if (code === value.charCodeAt(index2++)) {
      effects.consume(code);
      if (index2 === value.length) {
        return self.interrupt ? ok : continuation;
      }
      return cdataOpenInside;
    }
    return nok(code);
  }
  function tagCloseStart(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      buffer = String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function tagName(code) {
    if (code === null || code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      const slash = code === 47;
      const name = buffer.toLowerCase();
      if (!slash && !closingTag && htmlRawNames.includes(name)) {
        marker = 1;
        return self.interrupt ? ok(code) : continuation(code);
      }
      if (htmlBlockNames.includes(buffer.toLowerCase())) {
        marker = 6;
        if (slash) {
          effects.consume(code);
          return basicSelfClosing;
        }
        return self.interrupt ? ok(code) : continuation(code);
      }
      marker = 7;
      return self.interrupt && !self.parser.lazy[self.now().line] ? nok(code) : closingTag ? completeClosingTagAfter(code) : completeAttributeNameBefore(code);
    }
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return tagName;
    }
    return nok(code);
  }
  function basicSelfClosing(code) {
    if (code === 62) {
      effects.consume(code);
      return self.interrupt ? ok : continuation;
    }
    return nok(code);
  }
  function completeClosingTagAfter(code) {
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeClosingTagAfter;
    }
    return completeEnd(code);
  }
  function completeAttributeNameBefore(code) {
    if (code === 47) {
      effects.consume(code);
      return completeEnd;
    }
    if (code === 58 || code === 95 || asciiAlpha(code)) {
      effects.consume(code);
      return completeAttributeName;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeNameBefore;
    }
    return completeEnd(code);
  }
  function completeAttributeName(code) {
    if (code === 45 || code === 46 || code === 58 || code === 95 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return completeAttributeName;
    }
    return completeAttributeNameAfter(code);
  }
  function completeAttributeNameAfter(code) {
    if (code === 61) {
      effects.consume(code);
      return completeAttributeValueBefore;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeNameAfter;
    }
    return completeAttributeNameBefore(code);
  }
  function completeAttributeValueBefore(code) {
    if (code === null || code === 60 || code === 61 || code === 62 || code === 96) {
      return nok(code);
    }
    if (code === 34 || code === 39) {
      effects.consume(code);
      markerB = code;
      return completeAttributeValueQuoted;
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAttributeValueBefore;
    }
    return completeAttributeValueUnquoted(code);
  }
  function completeAttributeValueQuoted(code) {
    if (code === markerB) {
      effects.consume(code);
      markerB = null;
      return completeAttributeValueQuotedAfter;
    }
    if (code === null || markdownLineEnding(code)) {
      return nok(code);
    }
    effects.consume(code);
    return completeAttributeValueQuoted;
  }
  function completeAttributeValueUnquoted(code) {
    if (code === null || code === 34 || code === 39 || code === 47 || code === 60 || code === 61 || code === 62 || code === 96 || markdownLineEndingOrSpace(code)) {
      return completeAttributeNameAfter(code);
    }
    effects.consume(code);
    return completeAttributeValueUnquoted;
  }
  function completeAttributeValueQuotedAfter(code) {
    if (code === 47 || code === 62 || markdownSpace(code)) {
      return completeAttributeNameBefore(code);
    }
    return nok(code);
  }
  function completeEnd(code) {
    if (code === 62) {
      effects.consume(code);
      return completeAfter;
    }
    return nok(code);
  }
  function completeAfter(code) {
    if (code === null || markdownLineEnding(code)) {
      return continuation(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return completeAfter;
    }
    return nok(code);
  }
  function continuation(code) {
    if (code === 45 && marker === 2) {
      effects.consume(code);
      return continuationCommentInside;
    }
    if (code === 60 && marker === 1) {
      effects.consume(code);
      return continuationRawTagOpen;
    }
    if (code === 62 && marker === 4) {
      effects.consume(code);
      return continuationClose;
    }
    if (code === 63 && marker === 3) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    if (code === 93 && marker === 5) {
      effects.consume(code);
      return continuationCdataInside;
    }
    if (markdownLineEnding(code) && (marker === 6 || marker === 7)) {
      effects.exit("htmlFlowData");
      return effects.check(blankLineBefore, continuationAfter, continuationStart)(code);
    }
    if (code === null || markdownLineEnding(code)) {
      effects.exit("htmlFlowData");
      return continuationStart(code);
    }
    effects.consume(code);
    return continuation;
  }
  function continuationStart(code) {
    return effects.check(nonLazyContinuationStart, continuationStartNonLazy, continuationAfter)(code);
  }
  function continuationStartNonLazy(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return continuationBefore;
  }
  function continuationBefore(code) {
    if (code === null || markdownLineEnding(code)) {
      return continuationStart(code);
    }
    effects.enter("htmlFlowData");
    return continuation(code);
  }
  function continuationCommentInside(code) {
    if (code === 45) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationRawTagOpen(code) {
    if (code === 47) {
      effects.consume(code);
      buffer = "";
      return continuationRawEndTag;
    }
    return continuation(code);
  }
  function continuationRawEndTag(code) {
    if (code === 62) {
      const name = buffer.toLowerCase();
      if (htmlRawNames.includes(name)) {
        effects.consume(code);
        return continuationClose;
      }
      return continuation(code);
    }
    if (asciiAlpha(code) && buffer.length < 8) {
      effects.consume(code);
      buffer += String.fromCharCode(code);
      return continuationRawEndTag;
    }
    return continuation(code);
  }
  function continuationCdataInside(code) {
    if (code === 93) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationDeclarationInside(code) {
    if (code === 62) {
      effects.consume(code);
      return continuationClose;
    }
    if (code === 45 && marker === 2) {
      effects.consume(code);
      return continuationDeclarationInside;
    }
    return continuation(code);
  }
  function continuationClose(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("htmlFlowData");
      return continuationAfter(code);
    }
    effects.consume(code);
    return continuationClose;
  }
  function continuationAfter(code) {
    effects.exit("htmlFlow");
    return ok(code);
  }
}
function tokenizeNonLazyContinuationStart(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}
function tokenizeBlankLineBefore(effects, ok, nok) {
  return start;
  function start(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return effects.attempt(blankLine, ok, nok);
  }
}

// node_modules/micromark-core-commonmark/lib/html-text.js
var htmlText = {
  name: "htmlText",
  tokenize: tokenizeHtmlText
};
function tokenizeHtmlText(effects, ok, nok) {
  const self = this;
  let marker;
  let index2;
  let returnState;
  return start;
  function start(code) {
    effects.enter("htmlText");
    effects.enter("htmlTextData");
    effects.consume(code);
    return open2;
  }
  function open2(code) {
    if (code === 33) {
      effects.consume(code);
      return declarationOpen;
    }
    if (code === 47) {
      effects.consume(code);
      return tagCloseStart;
    }
    if (code === 63) {
      effects.consume(code);
      return instruction;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return tagOpen;
    }
    return nok(code);
  }
  function declarationOpen(code) {
    if (code === 45) {
      effects.consume(code);
      return commentOpenInside;
    }
    if (code === 91) {
      effects.consume(code);
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code)) {
      effects.consume(code);
      return declaration;
    }
    return nok(code);
  }
  function commentOpenInside(code) {
    if (code === 45) {
      effects.consume(code);
      return commentEnd;
    }
    return nok(code);
  }
  function comment(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 45) {
      effects.consume(code);
      return commentClose;
    }
    if (markdownLineEnding(code)) {
      returnState = comment;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return comment;
  }
  function commentClose(code) {
    if (code === 45) {
      effects.consume(code);
      return commentEnd;
    }
    return comment(code);
  }
  function commentEnd(code) {
    return code === 62 ? end(code) : code === 45 ? commentClose(code) : comment(code);
  }
  function cdataOpenInside(code) {
    const value = "CDATA[";
    if (code === value.charCodeAt(index2++)) {
      effects.consume(code);
      return index2 === value.length ? cdata : cdataOpenInside;
    }
    return nok(code);
  }
  function cdata(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 93) {
      effects.consume(code);
      return cdataClose;
    }
    if (markdownLineEnding(code)) {
      returnState = cdata;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return cdata;
  }
  function cdataClose(code) {
    if (code === 93) {
      effects.consume(code);
      return cdataEnd;
    }
    return cdata(code);
  }
  function cdataEnd(code) {
    if (code === 62) {
      return end(code);
    }
    if (code === 93) {
      effects.consume(code);
      return cdataEnd;
    }
    return cdata(code);
  }
  function declaration(code) {
    if (code === null || code === 62) {
      return end(code);
    }
    if (markdownLineEnding(code)) {
      returnState = declaration;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return declaration;
  }
  function instruction(code) {
    if (code === null) {
      return nok(code);
    }
    if (code === 63) {
      effects.consume(code);
      return instructionClose;
    }
    if (markdownLineEnding(code)) {
      returnState = instruction;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return instruction;
  }
  function instructionClose(code) {
    return code === 62 ? end(code) : instruction(code);
  }
  function tagCloseStart(code) {
    if (asciiAlpha(code)) {
      effects.consume(code);
      return tagClose;
    }
    return nok(code);
  }
  function tagClose(code) {
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagClose;
    }
    return tagCloseBetween(code);
  }
  function tagCloseBetween(code) {
    if (markdownLineEnding(code)) {
      returnState = tagCloseBetween;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagCloseBetween;
    }
    return end(code);
  }
  function tagOpen(code) {
    if (code === 45 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagOpen;
    }
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    return nok(code);
  }
  function tagOpenBetween(code) {
    if (code === 47) {
      effects.consume(code);
      return end;
    }
    if (code === 58 || code === 95 || asciiAlpha(code)) {
      effects.consume(code);
      return tagOpenAttributeName;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenBetween;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenBetween;
    }
    return end(code);
  }
  function tagOpenAttributeName(code) {
    if (code === 45 || code === 46 || code === 58 || code === 95 || asciiAlphanumeric(code)) {
      effects.consume(code);
      return tagOpenAttributeName;
    }
    return tagOpenAttributeNameAfter(code);
  }
  function tagOpenAttributeNameAfter(code) {
    if (code === 61) {
      effects.consume(code);
      return tagOpenAttributeValueBefore;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeNameAfter;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenAttributeNameAfter;
    }
    return tagOpenBetween(code);
  }
  function tagOpenAttributeValueBefore(code) {
    if (code === null || code === 60 || code === 61 || code === 62 || code === 96) {
      return nok(code);
    }
    if (code === 34 || code === 39) {
      effects.consume(code);
      marker = code;
      return tagOpenAttributeValueQuoted;
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeValueBefore;
      return lineEndingBefore(code);
    }
    if (markdownSpace(code)) {
      effects.consume(code);
      return tagOpenAttributeValueBefore;
    }
    effects.consume(code);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuoted(code) {
    if (code === marker) {
      effects.consume(code);
      marker = void 0;
      return tagOpenAttributeValueQuotedAfter;
    }
    if (code === null) {
      return nok(code);
    }
    if (markdownLineEnding(code)) {
      returnState = tagOpenAttributeValueQuoted;
      return lineEndingBefore(code);
    }
    effects.consume(code);
    return tagOpenAttributeValueQuoted;
  }
  function tagOpenAttributeValueUnquoted(code) {
    if (code === null || code === 34 || code === 39 || code === 60 || code === 61 || code === 96) {
      return nok(code);
    }
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    effects.consume(code);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuotedAfter(code) {
    if (code === 47 || code === 62 || markdownLineEndingOrSpace(code)) {
      return tagOpenBetween(code);
    }
    return nok(code);
  }
  function end(code) {
    if (code === 62) {
      effects.consume(code);
      effects.exit("htmlTextData");
      effects.exit("htmlText");
      return ok;
    }
    return nok(code);
  }
  function lineEndingBefore(code) {
    effects.exit("htmlTextData");
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return lineEndingAfter;
  }
  function lineEndingAfter(code) {
    return markdownSpace(code) ? factorySpace(effects, lineEndingAfterPrefix, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code) : lineEndingAfterPrefix(code);
  }
  function lineEndingAfterPrefix(code) {
    effects.enter("htmlTextData");
    return returnState(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-end.js
var labelEnd = {
  name: "labelEnd",
  resolveAll: resolveAllLabelEnd,
  resolveTo: resolveToLabelEnd,
  tokenize: tokenizeLabelEnd
};
var resourceConstruct = {
  tokenize: tokenizeResource
};
var referenceFullConstruct = {
  tokenize: tokenizeReferenceFull
};
var referenceCollapsedConstruct = {
  tokenize: tokenizeReferenceCollapsed
};
function resolveAllLabelEnd(events) {
  let index2 = -1;
  const newEvents = [];
  while (++index2 < events.length) {
    const token = events[index2][1];
    newEvents.push(events[index2]);
    if (token.type === "labelImage" || token.type === "labelLink" || token.type === "labelEnd") {
      const offset = token.type === "labelImage" ? 4 : 2;
      token.type = "data";
      index2 += offset;
    }
  }
  if (events.length !== newEvents.length) {
    splice(events, 0, events.length, newEvents);
  }
  return events;
}
function resolveToLabelEnd(events, context) {
  let index2 = events.length;
  let offset = 0;
  let token;
  let open2;
  let close;
  let media;
  while (index2--) {
    token = events[index2][1];
    if (open2) {
      if (token.type === "link" || token.type === "labelLink" && token._inactive) {
        break;
      }
      if (events[index2][0] === "enter" && token.type === "labelLink") {
        token._inactive = true;
      }
    } else if (close) {
      if (events[index2][0] === "enter" && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
        open2 = index2;
        if (token.type !== "labelLink") {
          offset = 2;
          break;
        }
      }
    } else if (token.type === "labelEnd") {
      close = index2;
    }
  }
  const group = {
    type: events[open2][1].type === "labelLink" ? "link" : "image",
    start: {
      ...events[open2][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  const label = {
    type: "label",
    start: {
      ...events[open2][1].start
    },
    end: {
      ...events[close][1].end
    }
  };
  const text3 = {
    type: "labelText",
    start: {
      ...events[open2 + offset + 2][1].end
    },
    end: {
      ...events[close - 2][1].start
    }
  };
  media = [["enter", group, context], ["enter", label, context]];
  media = push(media, events.slice(open2 + 1, open2 + offset + 3));
  media = push(media, [["enter", text3, context]]);
  media = push(media, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open2 + offset + 4, close - 3), context));
  media = push(media, [["exit", text3, context], events[close - 2], events[close - 1], ["exit", label, context]]);
  media = push(media, events.slice(close + 1));
  media = push(media, [["exit", group, context]]);
  splice(events, open2, events.length, media);
  return events;
}
function tokenizeLabelEnd(effects, ok, nok) {
  const self = this;
  let index2 = self.events.length;
  let labelStart;
  let defined;
  while (index2--) {
    if ((self.events[index2][1].type === "labelImage" || self.events[index2][1].type === "labelLink") && !self.events[index2][1]._balanced) {
      labelStart = self.events[index2][1];
      break;
    }
  }
  return start;
  function start(code) {
    if (!labelStart) {
      return nok(code);
    }
    if (labelStart._inactive) {
      return labelEndNok(code);
    }
    defined = self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    })));
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return after;
  }
  function after(code) {
    if (code === 40) {
      return effects.attempt(resourceConstruct, labelEndOk, defined ? labelEndOk : labelEndNok)(code);
    }
    if (code === 91) {
      return effects.attempt(referenceFullConstruct, labelEndOk, defined ? referenceNotFull : labelEndNok)(code);
    }
    return defined ? labelEndOk(code) : labelEndNok(code);
  }
  function referenceNotFull(code) {
    return effects.attempt(referenceCollapsedConstruct, labelEndOk, labelEndNok)(code);
  }
  function labelEndOk(code) {
    return ok(code);
  }
  function labelEndNok(code) {
    labelStart._balanced = true;
    return nok(code);
  }
}
function tokenizeResource(effects, ok, nok) {
  return resourceStart;
  function resourceStart(code) {
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code);
    effects.exit("resourceMarker");
    return resourceBefore;
  }
  function resourceBefore(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceOpen)(code) : resourceOpen(code);
  }
  function resourceOpen(code) {
    if (code === 41) {
      return resourceEnd(code);
    }
    return factoryDestination(effects, resourceDestinationAfter, resourceDestinationMissing, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(code);
  }
  function resourceDestinationAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceBetween)(code) : resourceEnd(code);
  }
  function resourceDestinationMissing(code) {
    return nok(code);
  }
  function resourceBetween(code) {
    if (code === 34 || code === 39 || code === 40) {
      return factoryTitle(effects, resourceTitleAfter, nok, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(code);
    }
    return resourceEnd(code);
  }
  function resourceTitleAfter(code) {
    return markdownLineEndingOrSpace(code) ? factoryWhitespace(effects, resourceEnd)(code) : resourceEnd(code);
  }
  function resourceEnd(code) {
    if (code === 41) {
      effects.enter("resourceMarker");
      effects.consume(code);
      effects.exit("resourceMarker");
      effects.exit("resource");
      return ok;
    }
    return nok(code);
  }
}
function tokenizeReferenceFull(effects, ok, nok) {
  const self = this;
  return referenceFull;
  function referenceFull(code) {
    return factoryLabel.call(self, effects, referenceFullAfter, referenceFullMissing, "reference", "referenceMarker", "referenceString")(code);
  }
  function referenceFullAfter(code) {
    return self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1))) ? ok(code) : nok(code);
  }
  function referenceFullMissing(code) {
    return nok(code);
  }
}
function tokenizeReferenceCollapsed(effects, ok, nok) {
  return referenceCollapsedStart;
  function referenceCollapsedStart(code) {
    effects.enter("reference");
    effects.enter("referenceMarker");
    effects.consume(code);
    effects.exit("referenceMarker");
    return referenceCollapsedOpen;
  }
  function referenceCollapsedOpen(code) {
    if (code === 93) {
      effects.enter("referenceMarker");
      effects.consume(code);
      effects.exit("referenceMarker");
      effects.exit("reference");
      return ok;
    }
    return nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-image.js
var labelStartImage = {
  name: "labelStartImage",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartImage
};
function tokenizeLabelStartImage(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    effects.enter("labelImage");
    effects.enter("labelImageMarker");
    effects.consume(code);
    effects.exit("labelImageMarker");
    return open2;
  }
  function open2(code) {
    if (code === 91) {
      effects.enter("labelMarker");
      effects.consume(code);
      effects.exit("labelMarker");
      effects.exit("labelImage");
      return after;
    }
    return nok(code);
  }
  function after(code) {
    return code === 94 && "_hiddenFootnoteSupport" in self.parser.constructs ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-link.js
var labelStartLink = {
  name: "labelStartLink",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink
};
function tokenizeLabelStartLink(effects, ok, nok) {
  const self = this;
  return start;
  function start(code) {
    effects.enter("labelLink");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    effects.exit("labelLink");
    return after;
  }
  function after(code) {
    return code === 94 && "_hiddenFootnoteSupport" in self.parser.constructs ? nok(code) : ok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/line-ending.js
var lineEnding = {
  name: "lineEnding",
  tokenize: tokenizeLineEnding
};
function tokenizeLineEnding(effects, ok) {
  return start;
  function start(code) {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return factorySpace(effects, ok, "linePrefix");
  }
}

// node_modules/micromark-core-commonmark/lib/thematic-break.js
var thematicBreak = {
  name: "thematicBreak",
  tokenize: tokenizeThematicBreak
};
function tokenizeThematicBreak(effects, ok, nok) {
  let size = 0;
  let marker;
  return start;
  function start(code) {
    effects.enter("thematicBreak");
    return before(code);
  }
  function before(code) {
    marker = code;
    return atBreak(code);
  }
  function atBreak(code) {
    if (code === marker) {
      effects.enter("thematicBreakSequence");
      return sequence(code);
    }
    if (size >= 3 && (code === null || markdownLineEnding(code))) {
      effects.exit("thematicBreak");
      return ok(code);
    }
    return nok(code);
  }
  function sequence(code) {
    if (code === marker) {
      effects.consume(code);
      size++;
      return sequence;
    }
    effects.exit("thematicBreakSequence");
    return markdownSpace(code) ? factorySpace(effects, atBreak, "whitespace")(code) : atBreak(code);
  }
}

// node_modules/micromark-core-commonmark/lib/list.js
var list = {
  continuation: {
    tokenize: tokenizeListContinuation
  },
  exit: tokenizeListEnd,
  name: "list",
  tokenize: tokenizeListStart
};
var listItemPrefixWhitespaceConstruct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace
};
var indentConstruct = {
  partial: true,
  tokenize: tokenizeIndent
};
function tokenizeListStart(effects, ok, nok) {
  const self = this;
  const tail = self.events[self.events.length - 1];
  let initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  return start;
  function start(code) {
    const kind = self.containerState.type || (code === 42 || code === 43 || code === 45 ? "listUnordered" : "listOrdered");
    if (kind === "listUnordered" ? !self.containerState.marker || code === self.containerState.marker : asciiDigit(code)) {
      if (!self.containerState.type) {
        self.containerState.type = kind;
        effects.enter(kind, {
          _container: true
        });
      }
      if (kind === "listUnordered") {
        effects.enter("listItemPrefix");
        return code === 42 || code === 45 ? effects.check(thematicBreak, nok, atMarker)(code) : atMarker(code);
      }
      if (!self.interrupt || code === 49) {
        effects.enter("listItemPrefix");
        effects.enter("listItemValue");
        return inside(code);
      }
    }
    return nok(code);
  }
  function inside(code) {
    if (asciiDigit(code) && ++size < 10) {
      effects.consume(code);
      return inside;
    }
    if ((!self.interrupt || size < 2) && (self.containerState.marker ? code === self.containerState.marker : code === 41 || code === 46)) {
      effects.exit("listItemValue");
      return atMarker(code);
    }
    return nok(code);
  }
  function atMarker(code) {
    effects.enter("listItemMarker");
    effects.consume(code);
    effects.exit("listItemMarker");
    self.containerState.marker = self.containerState.marker || code;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self.interrupt ? nok : onBlank,
      effects.attempt(listItemPrefixWhitespaceConstruct, endOfPrefix, otherPrefix)
    );
  }
  function onBlank(code) {
    self.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code);
  }
  function otherPrefix(code) {
    if (markdownSpace(code)) {
      effects.enter("listItemPrefixWhitespace");
      effects.consume(code);
      effects.exit("listItemPrefixWhitespace");
      return endOfPrefix;
    }
    return nok(code);
  }
  function endOfPrefix(code) {
    self.containerState.size = initialSize + self.sliceSerialize(effects.exit("listItemPrefix"), true).length;
    return ok(code);
  }
}
function tokenizeListContinuation(effects, ok, nok) {
  const self = this;
  self.containerState._closeFlow = void 0;
  return effects.check(blankLine, onBlank, notBlank);
  function onBlank(code) {
    self.containerState.furtherBlankLines = self.containerState.furtherBlankLines || self.containerState.initialBlankLine;
    return factorySpace(effects, ok, "listItemIndent", self.containerState.size + 1)(code);
  }
  function notBlank(code) {
    if (self.containerState.furtherBlankLines || !markdownSpace(code)) {
      self.containerState.furtherBlankLines = void 0;
      self.containerState.initialBlankLine = void 0;
      return notInCurrentItem(code);
    }
    self.containerState.furtherBlankLines = void 0;
    self.containerState.initialBlankLine = void 0;
    return effects.attempt(indentConstruct, ok, notInCurrentItem)(code);
  }
  function notInCurrentItem(code) {
    self.containerState._closeFlow = true;
    self.interrupt = void 0;
    return factorySpace(effects, effects.attempt(list, ok, nok), "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code);
  }
}
function tokenizeIndent(effects, ok, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemIndent", self.containerState.size + 1);
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "listItemIndent" && tail[2].sliceSerialize(tail[1], true).length === self.containerState.size ? ok(code) : nok(code);
  }
}
function tokenizeListEnd(effects) {
  effects.exit(this.containerState.type);
}
function tokenizeListItemPrefixWhitespace(effects, ok, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemPrefixWhitespace", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4 + 1);
  function afterPrefix(code) {
    const tail = self.events[self.events.length - 1];
    return !markdownSpace(code) && tail && tail[1].type === "listItemPrefixWhitespace" ? ok(code) : nok(code);
  }
}

// node_modules/micromark-core-commonmark/lib/setext-underline.js
var setextUnderline = {
  name: "setextUnderline",
  resolveTo: resolveToSetextUnderline,
  tokenize: tokenizeSetextUnderline
};
function resolveToSetextUnderline(events, context) {
  let index2 = events.length;
  let content3;
  let text3;
  let definition2;
  while (index2--) {
    if (events[index2][0] === "enter") {
      if (events[index2][1].type === "content") {
        content3 = index2;
        break;
      }
      if (events[index2][1].type === "paragraph") {
        text3 = index2;
      }
    } else {
      if (events[index2][1].type === "content") {
        events.splice(index2, 1);
      }
      if (!definition2 && events[index2][1].type === "definition") {
        definition2 = index2;
      }
    }
  }
  const heading = {
    type: "setextHeading",
    start: {
      ...events[content3][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  events[text3][1].type = "setextHeadingText";
  if (definition2) {
    events.splice(text3, 0, ["enter", heading, context]);
    events.splice(definition2 + 1, 0, ["exit", events[content3][1], context]);
    events[content3][1].end = {
      ...events[definition2][1].end
    };
  } else {
    events[content3][1] = heading;
  }
  events.push(["exit", heading, context]);
  return events;
}
function tokenizeSetextUnderline(effects, ok, nok) {
  const self = this;
  let marker;
  return start;
  function start(code) {
    let index2 = self.events.length;
    let paragraph;
    while (index2--) {
      if (self.events[index2][1].type !== "lineEnding" && self.events[index2][1].type !== "linePrefix" && self.events[index2][1].type !== "content") {
        paragraph = self.events[index2][1].type === "paragraph";
        break;
      }
    }
    if (!self.parser.lazy[self.now().line] && (self.interrupt || paragraph)) {
      effects.enter("setextHeadingLine");
      marker = code;
      return before(code);
    }
    return nok(code);
  }
  function before(code) {
    effects.enter("setextHeadingLineSequence");
    return inside(code);
  }
  function inside(code) {
    if (code === marker) {
      effects.consume(code);
      return inside;
    }
    effects.exit("setextHeadingLineSequence");
    return markdownSpace(code) ? factorySpace(effects, after, "lineSuffix")(code) : after(code);
  }
  function after(code) {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("setextHeadingLine");
      return ok(code);
    }
    return nok(code);
  }
}

// node_modules/micromark/lib/initialize/flow.js
var flow = {
  tokenize: initializeFlow
};
function initializeFlow(effects) {
  const self = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(this.parser.constructs.flowInitial, afterConstruct, factorySpace(effects, effects.attempt(this.parser.constructs.flow, afterConstruct, effects.attempt(content2, afterConstruct)), "linePrefix"))
  );
  return initial;
  function atBlankEnding(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEndingBlank");
    effects.consume(code);
    effects.exit("lineEndingBlank");
    self.currentConstruct = void 0;
    return initial;
  }
  function afterConstruct(code) {
    if (code === null) {
      effects.consume(code);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    self.currentConstruct = void 0;
    return initial;
  }
}

// node_modules/micromark/lib/initialize/text.js
var resolver = {
  resolveAll: createResolver()
};
var string = initializeFactory("string");
var text = initializeFactory("text");
function initializeFactory(field) {
  return {
    resolveAll: createResolver(field === "text" ? resolveAllLineSuffixes : void 0),
    tokenize: initializeText
  };
  function initializeText(effects) {
    const self = this;
    const constructs2 = this.parser.constructs[field];
    const text3 = effects.attempt(constructs2, start, notText);
    return start;
    function start(code) {
      return atBreak(code) ? text3(code) : notText(code);
    }
    function notText(code) {
      if (code === null) {
        effects.consume(code);
        return;
      }
      effects.enter("data");
      effects.consume(code);
      return data;
    }
    function data(code) {
      if (atBreak(code)) {
        effects.exit("data");
        return text3(code);
      }
      effects.consume(code);
      return data;
    }
    function atBreak(code) {
      if (code === null) {
        return true;
      }
      const list2 = constructs2[code];
      let index2 = -1;
      if (list2) {
        while (++index2 < list2.length) {
          const item = list2[index2];
          if (!item.previous || item.previous.call(self, self.previous)) {
            return true;
          }
        }
      }
      return false;
    }
  }
}
function createResolver(extraResolver) {
  return resolveAllText;
  function resolveAllText(events, context) {
    let index2 = -1;
    let enter;
    while (++index2 <= events.length) {
      if (enter === void 0) {
        if (events[index2] && events[index2][1].type === "data") {
          enter = index2;
          index2++;
        }
      } else if (!events[index2] || events[index2][1].type !== "data") {
        if (index2 !== enter + 2) {
          events[enter][1].end = events[index2 - 1][1].end;
          events.splice(enter + 2, index2 - enter - 2);
          index2 = enter + 2;
        }
        enter = void 0;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
}
function resolveAllLineSuffixes(events, context) {
  let eventIndex = 0;
  while (++eventIndex <= events.length) {
    if ((eventIndex === events.length || events[eventIndex][1].type === "lineEnding") && events[eventIndex - 1][1].type === "data") {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index2 = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs;
      while (index2--) {
        const chunk = chunks[index2];
        if (typeof chunk === "string") {
          bufferIndex = chunk.length;
          while (chunk.charCodeAt(bufferIndex - 1) === 32) {
            size++;
            bufferIndex--;
          }
          if (bufferIndex) break;
          bufferIndex = -1;
        } else if (chunk === -2) {
          tabs = true;
          size++;
        } else if (chunk === -1) {
        } else {
          index2++;
          break;
        }
      }
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }
      if (size) {
        const token = {
          type: eventIndex === events.length || tabs || size < 2 ? "lineSuffix" : "hardBreakTrailing",
          start: {
            _bufferIndex: index2 ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index2,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size
          },
          end: {
            ...data.end
          }
        };
        data.end = {
          ...token.start
        };
        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          events.splice(eventIndex, 0, ["enter", token, context], ["exit", token, context]);
          eventIndex += 2;
        }
      }
      eventIndex++;
    }
  }
  return events;
}

// node_modules/micromark/lib/constructs.js
var constructs_exports = {};
__export(constructs_exports, {
  attentionMarkers: () => attentionMarkers,
  contentInitial: () => contentInitial,
  disable: () => disable,
  document: () => document2,
  flow: () => flow2,
  flowInitial: () => flowInitial,
  insideSpan: () => insideSpan,
  string: () => string2,
  text: () => text2
});
var document2 = {
  [42]: list,
  [43]: list,
  [45]: list,
  [48]: list,
  [49]: list,
  [50]: list,
  [51]: list,
  [52]: list,
  [53]: list,
  [54]: list,
  [55]: list,
  [56]: list,
  [57]: list,
  [62]: blockQuote
};
var contentInitial = {
  [91]: definition
};
var flowInitial = {
  [-2]: codeIndented,
  [-1]: codeIndented,
  [32]: codeIndented
};
var flow2 = {
  [35]: headingAtx,
  [42]: thematicBreak,
  [45]: [setextUnderline, thematicBreak],
  [60]: htmlFlow,
  [61]: setextUnderline,
  [95]: thematicBreak,
  [96]: codeFenced,
  [126]: codeFenced
};
var string2 = {
  [38]: characterReference,
  [92]: characterEscape
};
var text2 = {
  [-5]: lineEnding,
  [-4]: lineEnding,
  [-3]: lineEnding,
  [33]: labelStartImage,
  [38]: characterReference,
  [42]: attention,
  [60]: [autolink, htmlText],
  [91]: labelStartLink,
  [92]: [hardBreakEscape, characterEscape],
  [93]: labelEnd,
  [95]: attention,
  [96]: codeText
};
var insideSpan = {
  null: [attention, resolver]
};
var attentionMarkers = {
  null: [42, 95]
};
var disable = {
  null: []
};

// node_modules/micromark/lib/create-tokenizer.js
function createTokenizer(parser, initialize, from) {
  let point3 = {
    _bufferIndex: -1,
    _index: 0,
    line: from && from.line || 1,
    column: from && from.column || 1,
    offset: from && from.offset || 0
  };
  const columnStart = {};
  const resolveAllConstructs = [];
  let chunks = [];
  let stack = [];
  let consumed = true;
  const effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit: exit2,
    interrupt: constructFactory(onsuccessfulcheck, {
      interrupt: true
    })
  };
  const context = {
    code: null,
    containerState: {},
    defineSkip,
    events: [],
    now,
    parser,
    previous: null,
    sliceSerialize,
    sliceStream,
    write
  };
  let state = initialize.tokenize.call(context, effects);
  let expectedCode;
  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }
  return context;
  function write(slice) {
    chunks = push(chunks, slice);
    main2();
    if (chunks[chunks.length - 1] !== null) {
      return [];
    }
    addResult(initialize, 0);
    context.events = resolveAll(resolveAllConstructs, context.events, context);
    return context.events;
  }
  function sliceSerialize(token, expandTabs) {
    return serializeChunks(sliceStream(token), expandTabs);
  }
  function sliceStream(token) {
    return sliceChunks(chunks, token);
  }
  function now() {
    const {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    } = point3;
    return {
      _bufferIndex,
      _index,
      line,
      column,
      offset
    };
  }
  function defineSkip(value) {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
  }
  function main2() {
    let chunkIndex;
    while (point3._index < chunks.length) {
      const chunk = chunks[point3._index];
      if (typeof chunk === "string") {
        chunkIndex = point3._index;
        if (point3._bufferIndex < 0) {
          point3._bufferIndex = 0;
        }
        while (point3._index === chunkIndex && point3._bufferIndex < chunk.length) {
          go(chunk.charCodeAt(point3._bufferIndex));
        }
      } else {
        go(chunk);
      }
    }
  }
  function go(code) {
    consumed = void 0;
    expectedCode = code;
    state = state(code);
  }
  function consume(code) {
    if (markdownLineEnding(code)) {
      point3.line++;
      point3.column = 1;
      point3.offset += code === -3 ? 2 : 1;
      accountForPotentialSkip();
    } else if (code !== -1) {
      point3.column++;
      point3.offset++;
    }
    if (point3._bufferIndex < 0) {
      point3._index++;
    } else {
      point3._bufferIndex++;
      if (point3._bufferIndex === // Points w/ non-negative `_bufferIndex` reference
      // strings.
      /** @type {string} */
      chunks[point3._index].length) {
        point3._bufferIndex = -1;
        point3._index++;
      }
    }
    context.previous = code;
    consumed = true;
  }
  function enter(type, fields) {
    const token = fields || {};
    token.type = type;
    token.start = now();
    context.events.push(["enter", token, context]);
    stack.push(token);
    return token;
  }
  function exit2(type) {
    const token = stack.pop();
    token.end = now();
    context.events.push(["exit", token, context]);
    return token;
  }
  function onsuccessfulconstruct(construct, info) {
    addResult(construct, info.from);
  }
  function onsuccessfulcheck(_, info) {
    info.restore();
  }
  function constructFactory(onreturn, fields) {
    return hook;
    function hook(constructs2, returnState, bogusState) {
      let listOfConstructs;
      let constructIndex;
      let currentConstruct;
      let info;
      return Array.isArray(constructs2) ? (
        /* c8 ignore next 1 */
        handleListOfConstructs(constructs2)
      ) : "tokenize" in constructs2 ? (
        // Looks like a construct.
        handleListOfConstructs([
          /** @type {Construct} */
          constructs2
        ])
      ) : handleMapOfConstructs(constructs2);
      function handleMapOfConstructs(map) {
        return start;
        function start(code) {
          const left = code !== null && map[code];
          const all2 = code !== null && map.null;
          const list2 = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...Array.isArray(left) ? left : left ? [left] : [],
            ...Array.isArray(all2) ? all2 : all2 ? [all2] : []
          ];
          return handleListOfConstructs(list2)(code);
        }
      }
      function handleListOfConstructs(list2) {
        listOfConstructs = list2;
        constructIndex = 0;
        if (list2.length === 0) {
          return bogusState;
        }
        return handleConstruct(list2[constructIndex]);
      }
      function handleConstruct(construct) {
        return start;
        function start(code) {
          info = store();
          currentConstruct = construct;
          if (!construct.partial) {
            context.currentConstruct = construct;
          }
          if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) {
            return nok(code);
          }
          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok,
            nok
          )(code);
        }
      }
      function ok(code) {
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }
      function nok(code) {
        consumed = true;
        info.restore();
        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }
        return bogusState;
      }
    }
  }
  function addResult(construct, from2) {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }
    if (construct.resolve) {
      splice(context.events, from2, context.events.length - from2, construct.resolve(context.events.slice(from2), context));
    }
    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }
  }
  function store() {
    const startPoint = now();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);
    return {
      from: startEventsIndex,
      restore
    };
    function restore() {
      point3 = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
    }
  }
  function accountForPotentialSkip() {
    if (point3.line in columnStart && point3.column < 2) {
      point3.column = columnStart[point3.line];
      point3.offset += columnStart[point3.line] - 1;
    }
  }
}
function sliceChunks(chunks, token) {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view;
  if (startIndex === endIndex) {
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);
    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === "string") {
        view[0] = head.slice(startBufferIndex);
      } else {
        view.shift();
      }
    }
    if (endBufferIndex > 0) {
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }
  return view;
}
function serializeChunks(chunks, expandTabs) {
  let index2 = -1;
  const result = [];
  let atTab;
  while (++index2 < chunks.length) {
    const chunk = chunks[index2];
    let value;
    if (typeof chunk === "string") {
      value = chunk;
    } else switch (chunk) {
      case -5: {
        value = "\r";
        break;
      }
      case -4: {
        value = "\n";
        break;
      }
      case -3: {
        value = "\r\n";
        break;
      }
      case -2: {
        value = expandTabs ? " " : "	";
        break;
      }
      case -1: {
        if (!expandTabs && atTab) continue;
        value = " ";
        break;
      }
      default: {
        value = String.fromCharCode(chunk);
      }
    }
    atTab = chunk === -2;
    result.push(value);
  }
  return result.join("");
}

// node_modules/micromark/lib/parse.js
function parse(options) {
  const settings = options || {};
  const constructs2 = (
    /** @type {FullNormalizedExtension} */
    combineExtensions([constructs_exports, ...settings.extensions || []])
  );
  const parser = {
    constructs: constructs2,
    content: create(content),
    defined: [],
    document: create(document),
    flow: create(flow),
    lazy: {},
    string: create(string),
    text: create(text)
  };
  return parser;
  function create(initial) {
    return creator;
    function creator(from) {
      return createTokenizer(parser, initial, from);
    }
  }
}

// node_modules/micromark/lib/postprocess.js
function postprocess(events) {
  while (!subtokenize(events)) {
  }
  return events;
}

// node_modules/micromark/lib/preprocess.js
var search = /[\0\t\n\r]/g;
function preprocess() {
  let column = 1;
  let buffer = "";
  let start = true;
  let atCarriageReturn;
  return preprocessor;
  function preprocessor(value, encoding, end) {
    const chunks = [];
    let match;
    let next;
    let startPosition;
    let endPosition;
    let code;
    value = buffer + (typeof value === "string" ? value.toString() : new TextDecoder(encoding || void 0).decode(value));
    startPosition = 0;
    buffer = "";
    if (start) {
      if (value.charCodeAt(0) === 65279) {
        startPosition++;
      }
      start = void 0;
    }
    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      match = search.exec(value);
      endPosition = match && match.index !== void 0 ? match.index : value.length;
      code = value.charCodeAt(endPosition);
      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }
      if (code === 10 && startPosition === endPosition && atCarriageReturn) {
        chunks.push(-3);
        atCarriageReturn = void 0;
      } else {
        if (atCarriageReturn) {
          chunks.push(-5);
          atCarriageReturn = void 0;
        }
        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }
        switch (code) {
          case 0: {
            chunks.push(65533);
            column++;
            break;
          }
          case 9: {
            next = Math.ceil(column / 4) * 4;
            chunks.push(-2);
            while (column++ < next) chunks.push(-1);
            break;
          }
          case 10: {
            chunks.push(-4);
            column = 1;
            break;
          }
          default: {
            atCarriageReturn = true;
            column = 1;
          }
        }
      }
      startPosition = endPosition + 1;
    }
    if (end) {
      if (atCarriageReturn) chunks.push(-5);
      if (buffer) chunks.push(buffer);
      chunks.push(null);
    }
    return chunks;
  }
}

// node_modules/micromark-util-decode-string/index.js
var characterEscapeOrReference = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function decodeString(value) {
  return value.replace(characterEscapeOrReference, decode);
}
function decode($0, $1, $2) {
  if ($1) {
    return $1;
  }
  const head = $2.charCodeAt(0);
  if (head === 35) {
    const head2 = $2.charCodeAt(1);
    const hex = head2 === 120 || head2 === 88;
    return decodeNumericCharacterReference($2.slice(hex ? 2 : 1), hex ? 16 : 10);
  }
  return decodeNamedCharacterReference($2) || $0;
}

// node_modules/unist-util-stringify-position/lib/index.js
function stringifyPosition(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("position" in value || "type" in value) {
    return position(value.position);
  }
  if ("start" in value || "end" in value) {
    return position(value);
  }
  if ("line" in value || "column" in value) {
    return point(value);
  }
  return "";
}
function point(point3) {
  return index(point3 && point3.line) + ":" + index(point3 && point3.column);
}
function position(pos) {
  return point(pos && pos.start) + "-" + point(pos && pos.end);
}
function index(value) {
  return value && typeof value === "number" ? value : 1;
}

// node_modules/mdast-util-from-markdown/lib/index.js
var own2 = {}.hasOwnProperty;
function fromMarkdown(value, encoding, options) {
  if (encoding && typeof encoding === "object") {
    options = encoding;
    encoding = void 0;
  }
  return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));
}
function compiler(options) {
  const config = {
    transforms: [],
    canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
    enter: {
      autolink: opener(link2),
      autolinkProtocol: onenterdata,
      autolinkEmail: onenterdata,
      atxHeading: opener(heading),
      blockQuote: opener(blockQuote2),
      characterEscape: onenterdata,
      characterReference: onenterdata,
      codeFenced: opener(codeFlow),
      codeFencedFenceInfo: buffer,
      codeFencedFenceMeta: buffer,
      codeIndented: opener(codeFlow, buffer),
      codeText: opener(codeText2, buffer),
      codeTextData: onenterdata,
      data: onenterdata,
      codeFlowValue: onenterdata,
      definition: opener(definition2),
      definitionDestinationString: buffer,
      definitionLabelString: buffer,
      definitionTitleString: buffer,
      emphasis: opener(emphasis),
      hardBreakEscape: opener(hardBreak),
      hardBreakTrailing: opener(hardBreak),
      htmlFlow: opener(html, buffer),
      htmlFlowData: onenterdata,
      htmlText: opener(html, buffer),
      htmlTextData: onenterdata,
      image: opener(image),
      label: buffer,
      link: opener(link2),
      listItem: opener(listItem),
      listItemValue: onenterlistitemvalue,
      listOrdered: opener(list2, onenterlistordered),
      listUnordered: opener(list2),
      paragraph: opener(paragraph),
      reference: onenterreference,
      referenceString: buffer,
      resourceDestinationString: buffer,
      resourceTitleString: buffer,
      setextHeading: opener(heading),
      strong: opener(strong),
      thematicBreak: opener(thematicBreak2)
    },
    exit: {
      atxHeading: closer(),
      atxHeadingSequence: onexitatxheadingsequence,
      autolink: closer(),
      autolinkEmail: onexitautolinkemail,
      autolinkProtocol: onexitautolinkprotocol,
      blockQuote: closer(),
      characterEscapeValue: onexitdata,
      characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
      characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
      characterReferenceValue: onexitcharacterreferencevalue,
      characterReference: onexitcharacterreference,
      codeFenced: closer(onexitcodefenced),
      codeFencedFence: onexitcodefencedfence,
      codeFencedFenceInfo: onexitcodefencedfenceinfo,
      codeFencedFenceMeta: onexitcodefencedfencemeta,
      codeFlowValue: onexitdata,
      codeIndented: closer(onexitcodeindented),
      codeText: closer(onexitcodetext),
      codeTextData: onexitdata,
      data: onexitdata,
      definition: closer(),
      definitionDestinationString: onexitdefinitiondestinationstring,
      definitionLabelString: onexitdefinitionlabelstring,
      definitionTitleString: onexitdefinitiontitlestring,
      emphasis: closer(),
      hardBreakEscape: closer(onexithardbreak),
      hardBreakTrailing: closer(onexithardbreak),
      htmlFlow: closer(onexithtmlflow),
      htmlFlowData: onexitdata,
      htmlText: closer(onexithtmltext),
      htmlTextData: onexitdata,
      image: closer(onexitimage),
      label: onexitlabel,
      labelText: onexitlabeltext,
      lineEnding: onexitlineending,
      link: closer(onexitlink),
      listItem: closer(),
      listOrdered: closer(),
      listUnordered: closer(),
      paragraph: closer(),
      referenceString: onexitreferencestring,
      resourceDestinationString: onexitresourcedestinationstring,
      resourceTitleString: onexitresourcetitlestring,
      resource: onexitresource,
      setextHeading: closer(onexitsetextheading),
      setextHeadingLineSequence: onexitsetextheadinglinesequence,
      setextHeadingText: onexitsetextheadingtext,
      strong: closer(),
      thematicBreak: closer()
    }
  };
  configure(config, (options || {}).mdastExtensions || []);
  const data = {};
  return compile;
  function compile(events) {
    let tree = {
      type: "root",
      children: []
    };
    const context = {
      stack: [tree],
      tokenStack: [],
      config,
      enter,
      exit: exit2,
      buffer,
      resume,
      data
    };
    const listStack = [];
    let index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][1].type === "listOrdered" || events[index2][1].type === "listUnordered") {
        if (events[index2][0] === "enter") {
          listStack.push(index2);
        } else {
          const tail = listStack.pop();
          index2 = prepareList(events, tail, index2);
        }
      }
    }
    index2 = -1;
    while (++index2 < events.length) {
      const handler = config[events[index2][0]];
      if (own2.call(handler, events[index2][1].type)) {
        handler[events[index2][1].type].call(Object.assign({
          sliceSerialize: events[index2][2].sliceSerialize
        }, context), events[index2][1]);
      }
    }
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1];
      const handler = tail[1] || defaultOnError;
      handler.call(context, void 0, tail[0]);
    }
    tree.position = {
      start: point2(events.length > 0 ? events[0][1].start : {
        line: 1,
        column: 1,
        offset: 0
      }),
      end: point2(events.length > 0 ? events[events.length - 2][1].end : {
        line: 1,
        column: 1,
        offset: 0
      })
    };
    index2 = -1;
    while (++index2 < config.transforms.length) {
      tree = config.transforms[index2](tree) || tree;
    }
    return tree;
  }
  function prepareList(events, start, length) {
    let index2 = start - 1;
    let containerBalance = -1;
    let listSpread = false;
    let listItem2;
    let lineIndex;
    let firstBlankLineIndex;
    let atMarker;
    while (++index2 <= length) {
      const event = events[index2];
      switch (event[1].type) {
        case "listUnordered":
        case "listOrdered":
        case "blockQuote": {
          if (event[0] === "enter") {
            containerBalance++;
          } else {
            containerBalance--;
          }
          atMarker = void 0;
          break;
        }
        case "lineEndingBlank": {
          if (event[0] === "enter") {
            if (listItem2 && !atMarker && !containerBalance && !firstBlankLineIndex) {
              firstBlankLineIndex = index2;
            }
            atMarker = void 0;
          }
          break;
        }
        case "linePrefix":
        case "listItemValue":
        case "listItemMarker":
        case "listItemPrefix":
        case "listItemPrefixWhitespace": {
          break;
        }
        default: {
          atMarker = void 0;
        }
      }
      if (!containerBalance && event[0] === "enter" && event[1].type === "listItemPrefix" || containerBalance === -1 && event[0] === "exit" && (event[1].type === "listUnordered" || event[1].type === "listOrdered")) {
        if (listItem2) {
          let tailIndex = index2;
          lineIndex = void 0;
          while (tailIndex--) {
            const tailEvent = events[tailIndex];
            if (tailEvent[1].type === "lineEnding" || tailEvent[1].type === "lineEndingBlank") {
              if (tailEvent[0] === "exit") continue;
              if (lineIndex) {
                events[lineIndex][1].type = "lineEndingBlank";
                listSpread = true;
              }
              tailEvent[1].type = "lineEnding";
              lineIndex = tailIndex;
            } else if (tailEvent[1].type === "linePrefix" || tailEvent[1].type === "blockQuotePrefix" || tailEvent[1].type === "blockQuotePrefixWhitespace" || tailEvent[1].type === "blockQuoteMarker" || tailEvent[1].type === "listItemIndent") {
            } else {
              break;
            }
          }
          if (firstBlankLineIndex && (!lineIndex || firstBlankLineIndex < lineIndex)) {
            listItem2._spread = true;
          }
          listItem2.end = Object.assign({}, lineIndex ? events[lineIndex][1].start : event[1].end);
          events.splice(lineIndex || index2, 0, ["exit", listItem2, event[2]]);
          index2++;
          length++;
        }
        if (event[1].type === "listItemPrefix") {
          const item = {
            type: "listItem",
            _spread: false,
            start: Object.assign({}, event[1].start),
            // @ts-expect-error: we’ll add `end` in a second.
            end: void 0
          };
          listItem2 = item;
          events.splice(index2, 0, ["enter", item, event[2]]);
          index2++;
          length++;
          firstBlankLineIndex = void 0;
          atMarker = true;
        }
      }
    }
    events[start][1]._spread = listSpread;
    return length;
  }
  function opener(create, and) {
    return open2;
    function open2(token) {
      enter.call(this, create(token), token);
      if (and) and.call(this, token);
    }
  }
  function buffer() {
    this.stack.push({
      type: "fragment",
      children: []
    });
  }
  function enter(node2, token, errorHandler) {
    const parent = this.stack[this.stack.length - 1];
    const siblings = parent.children;
    siblings.push(node2);
    this.stack.push(node2);
    this.tokenStack.push([token, errorHandler || void 0]);
    node2.position = {
      start: point2(token.start),
      // @ts-expect-error: `end` will be patched later.
      end: void 0
    };
  }
  function closer(and) {
    return close;
    function close(token) {
      if (and) and.call(this, token);
      exit2.call(this, token);
    }
  }
  function exit2(token, onExitError) {
    const node2 = this.stack.pop();
    const open2 = this.tokenStack.pop();
    if (!open2) {
      throw new Error("Cannot close `" + token.type + "` (" + stringifyPosition({
        start: token.start,
        end: token.end
      }) + "): it\u2019s not open");
    } else if (open2[0].type !== token.type) {
      if (onExitError) {
        onExitError.call(this, token, open2[0]);
      } else {
        const handler = open2[1] || defaultOnError;
        handler.call(this, token, open2[0]);
      }
    }
    node2.position.end = point2(token.end);
  }
  function resume() {
    return toString(this.stack.pop());
  }
  function onenterlistordered() {
    this.data.expectingFirstListItemValue = true;
  }
  function onenterlistitemvalue(token) {
    if (this.data.expectingFirstListItemValue) {
      const ancestor = this.stack[this.stack.length - 2];
      ancestor.start = Number.parseInt(this.sliceSerialize(token), 10);
      this.data.expectingFirstListItemValue = void 0;
    }
  }
  function onexitcodefencedfenceinfo() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.lang = data2;
  }
  function onexitcodefencedfencemeta() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.meta = data2;
  }
  function onexitcodefencedfence() {
    if (this.data.flowCodeInside) return;
    this.buffer();
    this.data.flowCodeInside = true;
  }
  function onexitcodefenced() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    this.data.flowCodeInside = void 0;
  }
  function onexitcodeindented() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/(\r?\n|\r)$/g, "");
  }
  function onexitdefinitionlabelstring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  }
  function onexitdefinitiontitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitdefinitiondestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitatxheadingsequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    if (!node2.depth) {
      const depth = this.sliceSerialize(token).length;
      node2.depth = depth;
    }
  }
  function onexitsetextheadingtext() {
    this.data.setextHeadingSlurpLineEnding = true;
  }
  function onexitsetextheadinglinesequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    node2.depth = this.sliceSerialize(token).codePointAt(0) === 61 ? 1 : 2;
  }
  function onexitsetextheading() {
    this.data.setextHeadingSlurpLineEnding = void 0;
  }
  function onenterdata(token) {
    const node2 = this.stack[this.stack.length - 1];
    const siblings = node2.children;
    let tail = siblings[siblings.length - 1];
    if (!tail || tail.type !== "text") {
      tail = text3();
      tail.position = {
        start: point2(token.start),
        // @ts-expect-error: we’ll add `end` later.
        end: void 0
      };
      siblings.push(tail);
    }
    this.stack.push(tail);
  }
  function onexitdata(token) {
    const tail = this.stack.pop();
    tail.value += this.sliceSerialize(token);
    tail.position.end = point2(token.end);
  }
  function onexitlineending(token) {
    const context = this.stack[this.stack.length - 1];
    if (this.data.atHardBreak) {
      const tail = context.children[context.children.length - 1];
      tail.position.end = point2(token.end);
      this.data.atHardBreak = void 0;
      return;
    }
    if (!this.data.setextHeadingSlurpLineEnding && config.canContainEols.includes(context.type)) {
      onenterdata.call(this, token);
      onexitdata.call(this, token);
    }
  }
  function onexithardbreak() {
    this.data.atHardBreak = true;
  }
  function onexithtmlflow() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexithtmltext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitcodetext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitlink() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitimage() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitlabeltext(token) {
    const string3 = this.sliceSerialize(token);
    const ancestor = this.stack[this.stack.length - 2];
    ancestor.label = decodeString(string3);
    ancestor.identifier = normalizeIdentifier(string3).toLowerCase();
  }
  function onexitlabel() {
    const fragment = this.stack[this.stack.length - 1];
    const value = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    this.data.inReference = true;
    if (node2.type === "link") {
      const children = fragment.children;
      node2.children = children;
    } else {
      node2.alt = value;
    }
  }
  function onexitresourcedestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitresourcetitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitresource() {
    this.data.inReference = void 0;
  }
  function onenterreference() {
    this.data.referenceType = "collapsed";
  }
  function onexitreferencestring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
    this.data.referenceType = "full";
  }
  function onexitcharacterreferencemarker(token) {
    this.data.characterReferenceType = token.type;
  }
  function onexitcharacterreferencevalue(token) {
    const data2 = this.sliceSerialize(token);
    const type = this.data.characterReferenceType;
    let value;
    if (type) {
      value = decodeNumericCharacterReference(data2, type === "characterReferenceMarkerNumeric" ? 10 : 16);
      this.data.characterReferenceType = void 0;
    } else {
      const result = decodeNamedCharacterReference(data2);
      value = result;
    }
    const tail = this.stack[this.stack.length - 1];
    tail.value += value;
  }
  function onexitcharacterreference(token) {
    const tail = this.stack.pop();
    tail.position.end = point2(token.end);
  }
  function onexitautolinkprotocol(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = this.sliceSerialize(token);
  }
  function onexitautolinkemail(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = "mailto:" + this.sliceSerialize(token);
  }
  function blockQuote2() {
    return {
      type: "blockquote",
      children: []
    };
  }
  function codeFlow() {
    return {
      type: "code",
      lang: null,
      meta: null,
      value: ""
    };
  }
  function codeText2() {
    return {
      type: "inlineCode",
      value: ""
    };
  }
  function definition2() {
    return {
      type: "definition",
      identifier: "",
      label: null,
      title: null,
      url: ""
    };
  }
  function emphasis() {
    return {
      type: "emphasis",
      children: []
    };
  }
  function heading() {
    return {
      type: "heading",
      // @ts-expect-error `depth` will be set later.
      depth: 0,
      children: []
    };
  }
  function hardBreak() {
    return {
      type: "break"
    };
  }
  function html() {
    return {
      type: "html",
      value: ""
    };
  }
  function image() {
    return {
      type: "image",
      title: null,
      url: "",
      alt: null
    };
  }
  function link2() {
    return {
      type: "link",
      title: null,
      url: "",
      children: []
    };
  }
  function list2(token) {
    return {
      type: "list",
      ordered: token.type === "listOrdered",
      start: null,
      spread: token._spread,
      children: []
    };
  }
  function listItem(token) {
    return {
      type: "listItem",
      spread: token._spread,
      checked: null,
      children: []
    };
  }
  function paragraph() {
    return {
      type: "paragraph",
      children: []
    };
  }
  function strong() {
    return {
      type: "strong",
      children: []
    };
  }
  function text3() {
    return {
      type: "text",
      value: ""
    };
  }
  function thematicBreak2() {
    return {
      type: "thematicBreak"
    };
  }
}
function point2(d) {
  return {
    line: d.line,
    column: d.column,
    offset: d.offset
  };
}
function configure(combined, extensions) {
  let index2 = -1;
  while (++index2 < extensions.length) {
    const value = extensions[index2];
    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}
function extension(combined, extension2) {
  let key;
  for (key in extension2) {
    if (own2.call(extension2, key)) {
      switch (key) {
        case "canContainEols": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "transforms": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "enter":
        case "exit": {
          const right = extension2[key];
          if (right) {
            Object.assign(combined[key], right);
          }
          break;
        }
      }
    }
  }
}
function defaultOnError(left, right) {
  if (left) {
    throw new Error("Cannot close `" + left.type + "` (" + stringifyPosition({
      start: left.start,
      end: left.end
    }) + "): a different token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is open");
  } else {
    throw new Error("Cannot close document, a token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is still open");
  }
}

// src/core/okf.ts
function resolveConcept2(index2, target) {
  const clean = target.trim().replace(/^\.\//, "").replace(/\.md$/i, "");
  const matches = index2.get(clean) ?? index2.get(`${clean}.md`) ?? index2.get(normalizeLookupKey(clean));
  if (matches?.length === 1) return matches[0];
  const normalized = normalizeLookupKey(clean);
  if (normalized.length >= 4) {
    const all2 = index2.get("__all__") ?? [];
    const fuzzy = all2.filter((concept) => normalizeLookupKey(concept.name).includes(normalized));
    if (fuzzy.length === 1) return fuzzy[0];
  }
  return matches?.length === 1 ? matches[0] : void 0;
}
function normalizeLookupKey(value) {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}

// src/markdown/links.ts
var EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
var ARTIFACT_SCHEME_RE = /^(https?:|mailto:|tent-artifact:)/i;
function extractOutLinksDetailed(body) {
  const tree = fromMarkdown(body);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const definitions = collectDefinitions(tree);
  walk(tree, (node2) => {
    if (node2.type === "link") {
      const link2 = outLinkFromMdast(node2);
      if (link2) pushLink(out, seen, link2);
      return "skip";
    }
    if (node2.type === "linkReference") {
      const definition2 = definitions.get(normalizeIdentifier2(node2.identifier));
      const link2 = definition2 ? outLinkFromReference(node2, definition2) : null;
      if (link2) pushLink(out, seen, link2);
      return "skip";
    }
    if (node2.type === "image") return "skip";
    if (node2.type === "text") {
      const start = node2.position?.start?.offset;
      const end = node2.position?.end?.offset;
      const text3 = start != null && end != null ? body.slice(start, end) : node2.value;
      scanWikiInProse(text3, out, seen);
    }
  });
  return out;
}
function resolveOutLink(index2, link2, fromNotePath) {
  if (link2.kind === "artifact") {
    return { raw: link2.raw, kind: "artifact", label: link2.label };
  }
  const meta = link2;
  const resolutionRaw = meta.conceptTarget ?? (link2.kind === "wiki" ? stripWikiSuffix(link2.raw).target : splitHref(link2.raw).pathPart);
  const target = normalizeTarget(resolutionRaw, fromNotePath);
  if (!isConceptCandidate(target) && !isConceptCandidate(resolutionRaw)) {
    return { raw: link2.raw, kind: "unresolved", label: link2.label };
  }
  const concept = resolveConcept2(index2, target) ?? resolveConcept2(index2, resolutionRaw);
  if (!concept) return { raw: link2.raw, kind: "unresolved", label: link2.label };
  return {
    raw: link2.raw,
    kind: link2.kind,
    targetCx: concept.id,
    targetPath: concept.path,
    label: link2.label ?? concept.name
  };
}
function buildBacklinkIndex(concepts) {
  const list2 = [...concepts];
  const index2 = /* @__PURE__ */ new Map();
  for (const c of list2) {
    const concept = {
      id: c.id,
      boxId: c.id,
      path: c.path,
      notePath: c.notePath,
      name: c.name,
      type: "note"
    };
    add(index2, concept.id, concept);
    add(index2, concept.path, concept);
    add(index2, concept.notePath, concept);
    add(index2, concept.name, concept);
  }
  const reverse = /* @__PURE__ */ new Map();
  for (const c of list2) {
    for (const link2 of extractOutLinksDetailed(c.body)) {
      if (link2.kind === "artifact") continue;
      const resolved = resolveOutLink(index2, link2, c.notePath);
      if (!resolved.targetCx) continue;
      const arr = reverse.get(resolved.targetCx) ?? [];
      arr.push({
        fromCx: c.id,
        fromPath: c.path,
        fromName: c.name,
        raw: link2.raw,
        kind: link2.kind === "wiki" ? "wiki" : "md"
      });
      reverse.set(resolved.targetCx, arr);
    }
  }
  return reverse;
}
function normalizeTarget(raw, fromNotePath) {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  t = safePercentDecode(t);
  t = (t.split("#")[0]?.split("?")[0] ?? t).trim();
  if ((t.startsWith("./") || t.startsWith("../")) && fromNotePath) {
    const base = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
    for (const part of t.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    t = base.join("/");
  }
  return t.replace(/\.md$/i, "");
}
function walk(node2, visit) {
  if (visit(node2) === "skip") return;
  if ("children" in node2 && Array.isArray(node2.children)) {
    for (const child of node2.children) walk(child, visit);
  }
}
function outLinkFromMdast(node2) {
  return outLinkFromHref(node2.url, collectText(node2));
}
function outLinkFromReference(node2, definition2) {
  return outLinkFromHref(definition2.url, collectText(node2));
}
function outLinkFromHref(url, rawLabel) {
  const href = (url ?? "").trim();
  if (!href) return null;
  const label = rawLabel.replace(/\s+/g, " ").trim() || void 0;
  if (ARTIFACT_SCHEME_RE.test(href) || isExternalHref(href)) {
    return { raw: href, kind: "artifact", label, conceptTarget: href };
  }
  if (isPureAnchor(href)) return null;
  const { pathPart, fragment } = splitHref(href);
  if (!pathPart || isAttachmentPath(pathPart)) return null;
  return { raw: href, kind: "md", label, fragment, conceptTarget: pathPart };
}
function collectDefinitions(tree) {
  const definitions = /* @__PURE__ */ new Map();
  walk(tree, (node2) => {
    if (node2.type === "definition") {
      const key = normalizeIdentifier2(node2.identifier);
      if (!definitions.has(key)) definitions.set(key, node2);
    }
  });
  return definitions;
}
function normalizeIdentifier2(identifier) {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}
function collectText(node2) {
  if ("value" in node2 && typeof node2.value === "string") return node2.value;
  if ("children" in node2 && Array.isArray(node2.children)) {
    return node2.children.map(collectText).join("");
  }
  return "";
}
function scanWikiInProse(text3, out, seen) {
  let i = 0;
  while (i < text3.length) {
    if (text3[i] === "\\" && i + 1 < text3.length) {
      i += 2;
      continue;
    }
    if (text3[i] === "!" && text3[i + 1] === "[" && text3[i + 2] === "[") {
      const embedEnd = findWikiEnd(text3, i + 2);
      i = embedEnd === -1 ? i + 3 : embedEnd + 1;
      continue;
    }
    if (text3[i] === "[" && text3[i + 1] === "[") {
      const parsed = tryParseWikiLink(text3, i);
      if (parsed) {
        if (parsed.link) pushLink(out, seen, parsed.link);
        i = parsed.next;
        continue;
      }
    }
    i += 1;
  }
}
function tryParseWikiLink(text3, start) {
  if (text3[start] !== "[" || text3[start + 1] !== "[" || isEscaped(text3, start)) return null;
  const end = findWikiEnd(text3, start + 2);
  if (end === -1) return null;
  const next = end + 1;
  const inner = text3.slice(start + 2, end);
  if (!inner) return { link: null, next };
  let targetPart = inner;
  let label;
  const pipe = findUnescapedChar(inner, "|");
  if (pipe !== -1) {
    targetPart = inner.slice(0, pipe);
    label = inner.slice(pipe + 1).trim() || void 0;
  }
  const rawTarget = targetPart.trim();
  if (!rawTarget) return { link: null, next };
  const { target, fragment, blockRef } = stripWikiSuffix(rawTarget);
  if (!target || isAttachmentPath(target) || isPureAnchor(target) || isExternalHref(target)) {
    return { link: null, next };
  }
  return {
    link: { raw: rawTarget, kind: "wiki", label, fragment, blockRef, conceptTarget: target },
    next
  };
}
function findWikiEnd(text3, from) {
  for (let i = from; i < text3.length - 1; i++) {
    if (text3[i] === "]" && text3[i + 1] === "]" && !isEscaped(text3, i)) return i;
    if (text3[i] === "[" && text3[i + 1] === "[" && !isEscaped(text3, i)) return -1;
  }
  return -1;
}
function pushLink(out, seen, link2) {
  const key = `${link2.kind}:${link2.raw}|${link2.label ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(link2);
}
function stripWikiSuffix(raw) {
  const t = raw.trim();
  const caret = t.lastIndexOf("^");
  if (caret > 0) {
    const blockRef = t.slice(caret + 1).trim() || void 0;
    const before = t.slice(0, caret);
    const hash2 = before.indexOf("#");
    if (hash2 >= 0) {
      return {
        target: before.slice(0, hash2).trim(),
        fragment: before.slice(hash2 + 1).trim() || void 0,
        blockRef
      };
    }
    return { target: before.trim(), blockRef };
  }
  const hash = t.indexOf("#");
  if (hash >= 0) {
    return { target: t.slice(0, hash).trim(), fragment: t.slice(hash + 1).trim() || void 0 };
  }
  return { target: t };
}
function splitHref(href) {
  const t = href.trim();
  const q = t.indexOf("?");
  const h = t.indexOf("#");
  let pathEnd = t.length;
  if (q >= 0) pathEnd = Math.min(pathEnd, q);
  if (h >= 0) pathEnd = Math.min(pathEnd, h);
  return {
    pathPart: t.slice(0, pathEnd),
    fragment: h >= 0 ? t.slice(h + 1).split("?")[0] || void 0 : void 0
  };
}
function isConceptCandidate(target) {
  const t = target.trim();
  return Boolean(t) && !isPureAnchor(t) && !isExternalHref(t) && !isAttachmentPath(t);
}
function isPureAnchor(href) {
  const t = href.trim();
  return t.startsWith("#") || t === "";
}
function isExternalHref(href) {
  const t = href.trim();
  return t.startsWith("//") || ARTIFACT_SCHEME_RE.test(t) || EXTERNAL_SCHEME_RE.test(t);
}
function isAttachmentPath(href) {
  const t = href.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!t) return false;
  if (t === ATTACHMENTS_DIR || t.startsWith(`${ATTACHMENTS_DIR}/`)) return true;
  if (t.includes(`/${ATTACHMENTS_DIR}/`)) return true;
  const stack = [];
  for (const p of t.split("/")) {
    if (p === "." || p === "") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack[0] === ATTACHMENTS_DIR;
}
function safePercentDecode(value) {
  try {
    if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function isEscaped(text3, index2) {
  let bs = 0;
  for (let i = index2 - 1; i >= 0 && text3[i] === "\\"; i--) bs += 1;
  return bs % 2 === 1;
}
function findUnescapedChar(text3, ch) {
  for (let i = 0; i < text3.length; i++) {
    if (text3[i] === ch && !isEscaped(text3, i)) return i;
  }
  return -1;
}
function add(index2, key, concept) {
  if (!key) return;
  const list2 = index2.get(key) ?? [];
  if (!list2.some((c) => c.id === concept.id)) list2.push(concept);
  index2.set(key, list2);
  const all2 = index2.get("__all__") ?? [];
  if (!all2.some((c) => c.id === concept.id)) all2.push(concept);
  index2.set("__all__", all2);
}

// src/service/etag.ts
import { createHash as createHash2 } from "node:crypto";
function contentEtag(content3) {
  return createHash2("sha256").update(content3, "utf8").digest("hex").slice(0, 24);
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
function cloneApproval(item) {
  return { ...item };
}
var A2AApprovalStore = class {
  constructor(dataDir, options) {
    this.items = /* @__PURE__ */ new Map();
    this.loaded = false;
    /** Serialize load + mutations + persist (same pattern as ToolApprovalStore). */
    this.chain = Promise.resolve();
    this.file = path3.join(dataDir, "a2a-approvals.json");
    this.writeState = options?.writeState ?? writeJsonAtomic;
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
          if (item?.id) this.items.set(item.id, cloneApproval(item));
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
    ).map(cloneApproval);
  }
  async get(id) {
    await this.ensureLoaded();
    const item = this.items.get(id);
    return item ? cloneApproval(item) : void 0;
  }
  async add(item) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const stored = cloneApproval(item);
      const next = new Map(this.items);
      next.set(stored.id, stored);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneApproval(stored);
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
      const resolved = {
        ...item,
        status: decision,
        resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
        resolvedBy
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneApproval(resolved);
    });
  }
  async quarantineCorrupt(action) {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, action);
    this.items.clear();
  }
  /** Persist a candidate snapshot before making it visible in memory. */
  async persistSnapshot(snapshot) {
    const items = [...snapshot.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || "")).slice(0, 50);
    await this.writeState(this.file, { items: [...pending, ...terminal] });
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
  /**
   * Import binary attachment for a concept.
   * Wire: base64 string in `bytesBase64` (or legacy `contentBase64`).
   * Disk: original bytes under attachments/<cx>/… — never a .b64 text companion.
   */
  "docs.importAttachment",
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
    /** Concurrent ask-policy requests keep the session waiting until all resolve. */
    this.permissionAsksInFlight = 0;
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
      const text3 = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text3).slice(-4e3);
      this.options.emit({
        type: "session.stdout_tail",
        sessionId: this.options.sessionId,
        text: text3
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
    const tracksAsk = policy === "ask";
    if (tracksAsk) this.permissionAsksInFlight += 1;
    try {
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
    } finally {
      if (tracksAsk) {
        this.permissionAsksInFlight = Math.max(0, this.permissionAsksInFlight - 1);
        if (this.permissionAsksInFlight === 0 && !this.stopRequested && !this.closed) {
          this.options.emit({
            type: "session.live",
            sessionId: this.options.sessionId,
            pid: this.proc?.pid
          });
        }
      }
    }
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
    const list2 = Array.isArray(profiles) ? profiles : [];
    let migrated = false;
    const out = [];
    for (const p of list2) {
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
      case "docs.importAttachment":
        return docsImportAttachment(ctx, p);
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
  const definition2 = parseRoleDefinitionParams(p, { requireName: true });
  return ctx.mutations.run(workspaceId, async () => {
    ctx.host.markSelfWrite(workspaceId);
    try {
      await createRole(mount.env.fs, definition2);
    } catch (err) {
      throw mapRoleRegistryError(err, "registry.role.create");
    }
    const registry = await loadRolesRegistry(mount.env.fs);
    const role = registry.roles.find((r) => r.name === definition2.name);
    if (!role) {
      throw new RpcError(-32e3, `Role create succeeded but role not found: ${definition2.name}`);
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
      (t) => t.role === name && taskAssigneeKind(t) === "role" && isActiveTaskState(t.state)
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
  const profile = projectAgentProfile(
    created,
    await profileCredentialExistsOpts(ctx, created)
  );
  ctx.events.emit(
    "profile.changed",
    "",
    { action: "create", id: created.id, profile },
    "self"
  );
  return {
    profile
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
  const profile = projectAgentProfile(
    updated,
    await profileCredentialExistsOpts(ctx, updated)
  );
  ctx.events.emit(
    "profile.changed",
    "",
    { action: "update", id: updated.id, profile },
    "self"
  );
  return {
    profile
  };
}
async function profileDelete(ctx, p) {
  const id = requireString(p, "id");
  const result = await ctx.profileCatalog.delete(id);
  ctx.events.emit(
    "profile.changed",
    "",
    { action: "delete", id: result.deleted },
    "self"
  );
  return result;
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
async function docsImportAttachment(ctx, p) {
  const workspaceId = requireWorkspaceId(ctx, p);
  const mount = ctx.host.require(workspaceId);
  const fileName = requireString(p, "fileName");
  const rawBase64 = typeof p.bytesBase64 === "string" ? p.bytesBase64 : typeof p.contentBase64 === "string" ? p.contentBase64 : typeof p.bytes === "string" ? p.bytes : void 0;
  if (rawBase64 === void 0) {
    throw new RpcError(
      -32602,
      "docs.importAttachment requires bytesBase64 (base64-encoded file bytes)"
    );
  }
  let bytes;
  try {
    bytes = rawBase64 === "" ? new Uint8Array() : decodeBase64Strict(rawBase64);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid base64";
    throw new RpcError(-32602, message);
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RpcError(
      -32602,
      `Attachment exceeds max size of ${MAX_ATTACHMENT_BYTES} bytes (${bytes.byteLength} bytes)`,
      { maxBytes: MAX_ATTACHMENT_BYTES, byteLength: bytes.byteLength }
    );
  }
  return ctx.mutations.run(workspaceId, async () => {
    const tent = await loadTent(mount.env.fs);
    const concept = resolveConcept3(tent, p);
    ctx.host.markSelfWrite(workspaceId);
    try {
      const result = await storeAttachmentBytes(
        mount.env.fs,
        concept.id,
        fileName,
        bytes,
        boxNotePath(concept.path)
      );
      return {
        workspaceId,
        id: concept.id,
        cx: concept.id,
        relativePath: result.relativePath,
        markdown: result.markdown,
        artifactRef: result.artifactRef
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "importAttachment failed";
      if (/exceeds max size|Invalid base64|path rejected|file name/i.test(message)) {
        throw new RpcError(-32602, message);
      }
      throw new RpcError(-32e3, message);
    }
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
  const assigneeKindRaw = optionalString(p, "assigneeKind");
  const assigneeKind = assigneeKindRaw === "agentProfile" ? "agentProfile" : assigneeKindRaw === "role" || !assigneeKindRaw ? "role" : (() => {
    throw new RpcError(-32602, `Invalid assigneeKind: ${assigneeKindRaw}`);
  })();
  const role = optionalString(p, "role");
  const profileId = optionalString(p, "profileId");
  const prompt = requireString(p, "prompt");
  const dispatchedBy = optionalString(p, "dispatchedBy");
  const asSub = p.asSub === true;
  const explicitDeliveryPolicy = parseDeliveryPolicy(optionalString(p, "deliveryPolicy"));
  const startSession = p.startSession === true;
  const callerKind = parseCallerKind(optionalString(p, "callerKind") ?? "user");
  if ("a2aPolicyOverride" in p) {
    throw new RpcError(-32602, "a2aPolicyOverride is service-internal and unavailable over RPC");
  }
  if (assigneeKind === "role" && !role) {
    throw new RpcError(-32602, "task.dispatch with assigneeKind=role requires role");
  }
  if (assigneeKind === "agentProfile" && !profileId) {
    throw new RpcError(-32602, "task.dispatch with assigneeKind=agentProfile requires profileId");
  }
  if (assigneeKind === "agentProfile" && role && role !== profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with assigneeKind=agentProfile must not pass a different role; profileId is the assignee label"
    );
  }
  if (assigneeKind === "agentProfile" && !ctx.profileCatalog.get(profileId)) {
    throw new RpcError(-32004, `Profile not found: ${profileId}`);
  }
  if (startSession && !profileId) {
    throw new RpcError(
      -32602,
      "task.dispatch with startSession requires explicit profileId (no fake-default fallback)"
    );
  }
  const result = await ctx.mutations.run(workspaceId, async () => {
    const assigneeLabel = assigneeKind === "agentProfile" ? profileId : role;
    if (asSub) {
      await assertSubDispatchPreconditions(mount.env.fs, {
        workspaceRoot: mount.workspaceRoot,
        dispatcher: dispatchedBy,
        assigneeKind,
        assigneeLabel
      });
    }
    let workspaceLane2;
    let preallocatedTaskId;
    if (asSub) {
      const dispatcherLane = await ensureRoleWorkspace(mount.workspaceRoot, dispatchedBy.trim());
      if (assigneeKind === "role") {
        const assigneeLane = await ensureRoleWorkspace(mount.workspaceRoot, assigneeLabel);
        workspaceLane2 = { ...assigneeLane, targetBranch: dispatcherLane.branch };
      } else {
        preallocatedTaskId = makeTaskId();
        const taskLane = await ensureTaskWorkspace(mount.workspaceRoot, preallocatedTaskId);
        workspaceLane2 = { ...taskLane, targetBranch: dispatcherLane.branch };
      }
    } else if (assigneeKind === "role") {
      workspaceLane2 = await ensureRoleWorkspaceIfGit(mount.workspaceRoot, assigneeLabel);
    }
    ctx.host.markSelfWrite(workspaceId);
    let deliveryPolicy = explicitDeliveryPolicy;
    if (deliveryPolicy === void 0) {
      const settings = await loadWorkspaceSettings(mount.env.fs);
      deliveryPolicy = settings.defaultDeliveryPolicy;
    }
    const dispatched2 = await dispatch(mount.env, boxId, assigneeKind === "role" ? role : void 0, {
      userPrompt: prompt,
      dispatchedBy,
      asSub,
      deliveryPolicy,
      workspace: workspaceLane2,
      assigneeKind,
      profileId: assigneeKind === "agentProfile" ? profileId : void 0,
      ...preallocatedTaskId ? { taskId: preallocatedTaskId } : {}
    });
    ctx.events.emit(
      "task.state",
      workspaceId,
      {
        path: dispatched2.taskPath,
        state: "queued",
        role: dispatched2.assignee,
        assigneeKind: dispatched2.assigneeKind,
        boxId,
        reason: "task.dispatch"
      },
      "self"
    );
    return { dispatched: dispatched2, workspaceLane: workspaceLane2 };
  });
  const workspaceLane = result.workspaceLane;
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
    assigneeKind: dispatched.assigneeKind,
    assignee: dispatched.assignee,
    asSub: taskAfter ? taskAsSub(taskAfter) : asSub,
    state: startSession ? "running" : "queued",
    session,
    workspaceLane: taskAfter ? projectTask(taskAfter).workspaceLane : workspaceLane ? {
      workspace: workspaceLane.workspace,
      worktree: workspaceLane.worktree,
      branch: workspaceLane.branch,
      targetBranch: workspaceLane.targetBranch
    } : void 0
  };
}
async function assertSubDispatchPreconditions(fs14, input) {
  const dispatcher = (input.dispatcher || "").trim();
  if (!dispatcher || dispatcher === "user") {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires dispatchedBy naming a real durable registry role (not user)"
    );
  }
  if (dispatcher === input.assigneeLabel) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub dispatchedBy must not equal the assignee itself",
      { dispatchedBy: dispatcher, assignee: input.assigneeLabel }
    );
  }
  const registry = await loadRolesRegistry(fs14);
  const role = registry.roles.find((r) => r.name === dispatcher);
  if (!role) {
    throw new RpcError(
      -32602,
      `task.dispatch asSub dispatchedBy role not found in registry: ${dispatcher}`,
      { dispatchedBy: dispatcher }
    );
  }
  if (!await isGitWorkspace(input.workspaceRoot)) {
    throw new RpcError(
      -32602,
      "task.dispatch asSub requires a real Git workspace lane; pure Tent / non-Git workspaces cannot host sub dispatch"
    );
  }
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
    const authorityRole = resolveA2AAuthorityRole(taskForPolicy, callerKind);
    const a2aPolicy = await resolveStartSessionA2APolicy(mount.env.fs, {
      callerKind,
      taskRole: authorityRole,
      requireRegisteredRole: callerKind === "role" && (taskAsSub(taskForPolicy) || taskAssigneeKind(taskForPolicy) === "agentProfile")
    });
    const profileAllowed = callerKind === "user" ? true : await resolveRoleProfileAllowed(mount.env.fs, {
      taskRole: authorityRole,
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
        role: authorityRole,
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
        role: authorityRole || task2.role,
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
          role: authorityRole || task2.role,
          profileId,
          summary: `Role ${authorityRole || task2.role} requests startSession on profile ${profileId}`
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
  if (taskAssigneeKind(task) === "agentProfile" && task.role !== profileId) {
    throw new RpcError(
      -32602,
      `task.startSession profileId must match agentProfile task assignee (${task.role}); got ${profileId}`,
      { taskAssignee: task.role, profileId }
    );
  }
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
  const isProfileTask = taskAssigneeKind(task) === "agentProfile";
  if (!isProfileTask) {
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
  } else if (task.sessionId) {
    const prior = await ctx.runtime.registry.read(task.sessionId);
    if (prior && SessionRegistry.isNonTerminal(prior.state) && prior.state !== "external") {
      return projectStartSessionResult(workspaceId, taskPath, task, prior, {
        cwd: task.worktree || mount.workspaceRoot
      });
    }
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
        const cwdMatches = !!recordedCwd && isSameWorkspaceRoot(nodePath3.resolve(recordedCwd), nodePath3.resolve(cwd));
        const profileMatches = !prior?.profileId || prior.profileId === profileId;
        const workspaceMatches = prior?.workspace === workspaceId;
        const roleMatches = prior?.roleName === task.role;
        const assigneeKindMatches = (prior?.assigneeKind ?? "role") === taskAssigneeKind(task);
        const taskMatches = prior?.lastTaskId === taskPath || !!task.id && prior?.lastTaskId === task.id;
        resumePrior = cwdMatches && profileMatches && workspaceMatches && roleMatches && assigneeKindMatches && taskMatches;
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
        assigneeKind: taskAssigneeKind(task),
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
  const all2 = await ctx.runtime.registry.list();
  const projections = [];
  for (const rec of all2) {
    if (workspaceId && rec.workspace && rec.workspace !== workspaceId) continue;
    const probe = await ctx.runtime.probe(rec.id);
    projections.push({
      sessionId: rec.id,
      profileId: rec.profileId,
      adapterId: rec.adapterId,
      state: probe.state,
      roleName: rec.roleName,
      assigneeKind: rec.assigneeKind ?? "role",
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
    assigneeKind: rec.assigneeKind ?? "role",
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
  const hasPendingForSession = await ctx.toolApprovals.hasPendingForSession(
    item.sessionId
  );
  if (decision === "approved" && !hasPendingForSession && item.taskPath) {
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
  const hasPendingToolApproval = ev.type === "session.live" ? await ctx.toolApprovals.hasPendingForSession(ev.sessionId) : false;
  if (ev.type === "session.waiting_user") {
    if (rec && SessionRegistry.isNonTerminal(rec.state)) {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "waiting-user"
      });
    }
  } else if (ev.type === "session.live") {
    const current = await ctx.runtime.registry.read(ev.sessionId);
    if (current && SessionRegistry.isNonTerminal(current.state) && hasPendingToolApproval) {
      await ctx.runtime.registry.update(ev.sessionId, {
        state: "waiting-user"
      });
    } else if (current && current.state === "waiting-user") {
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
      } else if (ev.type === "session.live" && !hasPendingToolApproval && task.state === "waiting" && task.wait?.reason === "user-input") {
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
async function resolveStartSessionA2APolicy(fs14, input) {
  if (input.callerKind === "user") return "allow";
  const registry = await loadRolesRegistry(fs14);
  const role = registry.roles.find((r) => r.name === input.taskRole);
  if (input.requireRegisteredRole && !role) {
    throw new RpcError(
      -32602,
      `A2A authority role not found in registry: ${input.taskRole}`,
      { role: input.taskRole }
    );
  }
  return roleA2APolicy(role);
}
async function resolveRoleProfileAllowed(fs14, input) {
  if (input.policy !== "allow") return true;
  const registry = await loadRolesRegistry(fs14);
  const role = registry.roles.find((r) => r.name === input.taskRole);
  return roleAllowsProfile(role, input.profileId);
}
function parseCallerKind(raw) {
  if (raw === "user" || raw === "role") return raw;
  throw new RpcError(-32602, `Invalid callerKind: ${raw}`);
}
function resolveConcept3(tent, p) {
  const id = optionalString(p, "id") ?? optionalString(p, "boxId");
  const path16 = optionalString(p, "path");
  if (id) {
    const byId = tent.byId.get(id);
    if (byId) return byId;
    throw new RpcError(-32004, `Concept not found: ${id}`);
  }
  if (path16) {
    const byPath = tent.byPath.get(path16);
    if (byPath) return byPath;
    throw new RpcError(-32004, `Concept not found: ${path16}`);
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
  const mountedRoot = nodePath3.resolve(workspaceRoot);
  if (task.workspace) {
    const claimed = nodePath3.resolve(task.workspace);
    if (!isSameWorkspaceRoot(claimed, mountedRoot)) {
      throw new Error(
        `Task envelope workspace mismatch: envelope=${task.workspace} mounted=${workspaceRoot}`
      );
    }
  }
  const isProfile = taskAssigneeKind(task) === "agentProfile";
  const real = isProfile ? await ensureTaskWorkspace(mountedRoot, task.id || task.path) : await ensureRoleWorkspace(mountedRoot, task.role);
  const label = isProfile ? `task ${task.id || task.path}` : `role ${task.role}`;
  if (task.branch && task.branch !== real.branch) {
    throw new Error(
      `Task envelope branch mismatch for ${label}: envelope=${task.branch} expected=${real.branch}`
    );
  }
  if (task.worktree) {
    const claimedWt = nodePath3.resolve(task.worktree);
    const realWt = nodePath3.resolve(real.worktree);
    if (!isSameWorkspaceRoot(claimedWt, realWt)) {
      throw new Error(
        `Task envelope worktree mismatch for ${label}: envelope=${task.worktree} expected=${real.worktree}`
      );
    }
  }
  if (taskAsSub(task)) {
    const dispatcher = (task.dispatchedBy || "").trim();
    if (!dispatcher || dispatcher === "user") {
      throw new Error(
        `Sub task envelope missing durable dispatchedBy for ${label}; cannot resolve targetBranch`
      );
    }
    const dispatcherLane = await ensureRoleWorkspace(mountedRoot, dispatcher);
    if (task.targetBranch && task.targetBranch !== dispatcherLane.branch) {
      throw new Error(
        `Task envelope targetBranch mismatch for ${label}: envelope=${task.targetBranch} expected=${dispatcherLane.branch}`
      );
    }
    if (dispatcherLane.branch === real.branch) {
      throw new Error(
        `Sub task targetBranch must not equal assignee branch for ${label}: ${dispatcherLane.branch}`
      );
    }
    return { ...real, targetBranch: dispatcherLane.branch };
  }
  if (task.targetBranch && task.targetBranch !== real.targetBranch) {
    throw new Error(
      `Task envelope targetBranch mismatch for ${label}: envelope=${task.targetBranch} expected=${real.targetBranch}`
    );
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
    const isProfile = taskAssigneeKind(current) === "agentProfile";
    const lane = currentLaneComplete ? {
      workspace: current.workspace,
      worktree: current.worktree,
      branch: current.branch,
      targetBranch: current.targetBranch
    } : isProfile ? await ensureTaskWorkspaceIfGit(
      mount.workspaceRoot,
      current.id || current.path
    ) : await ensureRoleWorkspaceIfGit(mount.workspaceRoot, current.role);
    if (!lane) return current;
    let targetBranch = lane.targetBranch;
    if (taskAsSub(current)) {
      const existingTarget = (current.targetBranch || "").trim();
      if (existingTarget) {
        targetBranch = existingTarget;
      } else {
        const dispatcher = (current.dispatchedBy || "").trim();
        if (dispatcher && dispatcher !== "user") {
          const dispatcherLane = await ensureRoleWorkspace(mount.workspaceRoot, dispatcher);
          targetBranch = dispatcherLane.branch;
        }
      }
    }
    const patch = {
      updatedAt: mount.env.clock.now()
    };
    if (!currentLaneComplete) {
      patch.workspace = lane.workspace;
      patch.worktree = lane.worktree;
      patch.branch = lane.branch;
      patch.targetBranch = targetBranch;
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
  const all2 = await ctx.runtime.registry.list();
  return all2.find(
    (rec) => rec.workspace === workspaceId && rec.roleName === roleName && (rec.assigneeKind ?? "role") !== "agentProfile" && SessionRegistry.isNonTerminal(rec.state) && rec.state !== "external"
  );
}
function resolveA2AAuthorityRole(task, callerKind) {
  if (callerKind === "user") return task.role;
  if (taskAsSub(task) || taskAssigneeKind(task) === "agentProfile") {
    const dispatcher = (task.dispatchedBy || "").trim();
    if (!dispatcher || dispatcher === "user") {
      throw new RpcError(
        -32602,
        taskAsSub(task) ? "callerKind=role startSession on sub task requires dispatchedBy to name a real dispatcher role" : "callerKind=role startSession on agentProfile task requires dispatchedBy to name a real dispatcher role",
        { dispatchedBy: task.dispatchedBy, assignee: task.role, asSub: taskAsSub(task) }
      );
    }
    if (dispatcher === task.role) {
      throw new RpcError(
        -32602,
        "callerKind=role startSession must not use the assignee label as dispatcher role",
        { dispatchedBy: dispatcher, assignee: task.role }
      );
    }
    return dispatcher;
  }
  return task.role;
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
  const kind = taskAssigneeKind(task);
  const card = taskContextCard(task.id || task.path, {
    path: task.path,
    workspaceRoot: roots.workspaceRoot,
    systemRoot,
    label: kind === "agentProfile" ? `task:profile:${task.role}` : `task:${task.role}`
  });
  const sessionSteps = sessionBootstrapPromptForTask(task, {
    workspaceRoot: roots.workspaceRoot,
    systemRoot
  });
  const aux = [];
  if (kind === "agentProfile") {
    aux.push(`assigneeKind: agentProfile`);
    aux.push(`profileId: ${task.role}`);
  } else if (task.role) {
    aux.push(`role: ${task.role}`);
  }
  if (task.claims?.length) aux.push(`claims: ${task.claims.join(", ")}`);
  if (task.deliveryPolicy) aux.push(`deliveryPolicy: ${task.deliveryPolicy}`);
  if (task.manifest) aux.push(`manifest: ${task.manifest}`);
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
    // Missing asSub on disk reads as false (peer).
    asSub: taskAsSub(task),
    deliveryPolicy: task.deliveryPolicy,
    // Missing assigneeKind on disk reads as role (backward compatible).
    assigneeKind: taskAssigneeKind(task),
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

// src/service/data-dir.ts
import * as fs8 from "node:fs/promises";
import { isIP } from "node:net";
import * as os4 from "node:os";
import * as path8 from "node:path";
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path8.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path8.join(os4.homedir(), "AppData", "Roaming");
    return path8.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path8.join(os4.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path8.join(os4.homedir(), ".local", "state");
  return path8.join(xdg, "tent");
}
function serviceEndpointPath(dataDir) {
  return path8.join(dataDir, "service.json");
}
function serviceBaseUrl(host, port) {
  const authorityHost = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${authorityHost}:${port}`;
}
function isLoopbackServiceHost(host) {
  const normalized = host.trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || /^::ffff:127\./.test(normalized);
  }
  return false;
}
async function writeServiceEndpoint(dataDir, record) {
  const file = serviceEndpointPath(dataDir);
  await writeJsonAtomic(file, record);
  return file;
}
async function readServiceEndpoint(dataDir) {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs8.readFile(file, "utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Number.isInteger(data.pid) || data.pid <= 0 || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535 || typeof data.host !== "string" || !isLoopbackServiceHost(data.host) || typeof data.startedAt !== "string" || typeof data.version !== "string" || data.token !== void 0 && typeof data.token !== "string" || data.instanceId !== void 0 && (typeof data.instanceId !== "string" || !data.instanceId)) {
      return null;
    }
    return data;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}
async function removeServiceEndpoint(dataDir, expectedInstanceId) {
  try {
    if (expectedInstanceId) {
      const endpoint = await readServiceEndpoint(dataDir);
      if (endpoint?.instanceId !== expectedInstanceId) return;
    }
    await fs8.rm(serviceEndpointPath(dataDir), { force: true });
  } catch {
  }
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
var MAX_RPC_BODY_BYTES = 36 * 1024 * 1024;
var MAX_SSE_QUEUE_BYTES = 1024 * 1024;
var RequestBodyTooLargeError = class extends Error {
  constructor(maxBytes) {
    super(`RPC request body exceeds ${maxBytes} bytes`);
    this.maxBytes = maxBytes;
    this.name = "RequestBodyTooLargeError";
  }
};
function isFetchBlockedPort(port) {
  return FETCH_BLOCKED_PORTS.has(port);
}
async function createServiceHttpServer(options) {
  const host = options.host ?? "127.0.0.1";
  const preferredPort = options.port ?? 0;
  if (!isLoopbackServiceHost(host)) {
    throw new Error(
      `Local Tent Service host must be a literal loopback address (127.0.0.0/8 or ::1), got: ${host}`
    );
  }
  const closeSseConnections = /* @__PURE__ */ new Set();
  const activeResponses = /* @__PURE__ */ new Set();
  const server = http.createServer(async (req, res) => {
    activeResponses.add(res);
    const releaseResponse = () => activeResponses.delete(res);
    res.once("finish", releaseResponse);
    res.once("close", releaseResponse);
    try {
      await handleRequest(req, res, options, closeSseConnections);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      } else {
        res.destroy();
      }
    }
  });
  server.requestTimeout = 6e4;
  server.headersTimeout = 1e4;
  server.keepAliveTimeout = 5e3;
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
  let closePromise = null;
  return {
    server,
    host,
    port,
    url: serviceBaseUrl(host, port),
    close: () => {
      if (closePromise) return closePromise;
      closePromise = closeServer(server);
      for (const response of activeResponses) {
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      for (const closeSse of [...closeSseConnections]) closeSse();
      server.closeIdleConnections?.();
      return closePromise;
    }
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
async function handleRequest(req, res, options, closeSseConnections) {
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
    handleSse(req, res, events, closeSseConnections);
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
    let raw;
    try {
      raw = await readBody(req, MAX_RPC_BODY_BYTES);
    } catch (error) {
      res.setHeader("connection", "close");
      if (error instanceof RequestBodyTooLargeError) {
        writeJson2(res, 413, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32013,
            message: "RPC request body too large",
            data: { maxBytes: error.maxBytes }
          }
        });
      } else {
        writeJson2(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Request body read failed" }
        });
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      writeJson2(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      writeJson2(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      });
      return;
    }
    const message = parsed;
    const id = isRpcId(message.id) ? message.id ?? null : null;
    if (message.jsonrpc !== "2.0" || !message.method || typeof message.method !== "string" || !isRpcId(message.id)) {
      writeJson2(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: method required" }
      });
      return;
    }
    if (message.params !== void 0 && (!message.params || typeof message.params !== "object")) {
      writeJson2(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid params: expected object or array" }
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
function handleSse(req, res, events, closeSseConnections) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  let closed = false;
  let blocked = false;
  let queuedBytes = 0;
  const queue = [];
  let unsubscribe = () => {
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    queue.length = 0;
    queuedBytes = 0;
    closeSseConnections.delete(close);
    req.off("close", cleanup);
    res.off("close", cleanup);
    res.off("drain", flush);
  };
  const close = () => {
    if (closed) return;
    cleanup();
    res.destroy();
  };
  const send = (payload) => {
    if (closed) return;
    const bytes = Buffer.byteLength(payload);
    if (bytes > MAX_SSE_QUEUE_BYTES || blocked && queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
      close();
      return;
    }
    if (blocked) {
      queue.push({ payload, bytes });
      queuedBytes += bytes;
      return;
    }
    try {
      blocked = !res.write(payload);
    } catch {
      close();
    }
  };
  function flush() {
    if (closed) return;
    blocked = false;
    while (queue.length > 0) {
      const next = queue.shift();
      queuedBytes -= next.bytes;
      try {
        if (!res.write(next.payload)) {
          blocked = true;
          return;
        }
      } catch {
        close();
        return;
      }
    }
  }
  const onEvent = (event) => {
    send(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
  };
  unsubscribe = events.subscribe(onEvent);
  const heartbeat = setInterval(() => send(": ping\n\n"), 15e3);
  closeSseConnections.add(close);
  req.once("close", cleanup);
  res.once("close", cleanup);
  res.on("drain", flush);
  send(": ok\n\n");
}
function writeJson2(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readBody(req, maxBytes) {
  return new Promise((resolve10, reject) => {
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(new RequestBodyTooLargeError(maxBytes));
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      action();
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        finish(() => reject(new RequestBodyTooLargeError(maxBytes)));
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish(() => resolve10(Buffer.concat(chunks, total).toString("utf8")));
    const onError = (error) => finish(() => reject(error));
    const onAborted = () => finish(() => reject(new Error("request aborted")));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}
function isRpcId(id) {
  return id === void 0 || id === null || typeof id === "string" || typeof id === "number";
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
import * as fs10 from "node:fs/promises";
import * as path9 from "node:path";

// src/fs/node-fs.ts
import * as fs9 from "node:fs/promises";
import * as nodePath4 from "node:path";
var NodeFs = class {
  constructor(root) {
    this.root = nodePath4.resolve(root);
  }
  abs(p) {
    const resolved = nodePath4.resolve(this.root, p);
    const root = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const candidate = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (candidate !== root && !candidate.startsWith(root + nodePath4.sep)) {
      throw new Error(`Path escapes Tent root: ${p}`);
    }
    return resolved;
  }
  async listDir(dir) {
    const entries = await fs9.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path16) {
    return fs9.readFile(this.abs(path16), "utf8");
  }
  async writeFile(path16, content3) {
    await fs9.mkdir(nodePath4.dirname(this.abs(path16)), { recursive: true });
    await fs9.writeFile(this.abs(path16), content3, "utf8");
  }
  async readBinary(path16) {
    const buf = await fs9.readFile(this.abs(path16));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async writeBinary(path16, data) {
    const abs = this.abs(path16);
    await fs9.mkdir(nodePath4.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      await fs9.writeFile(tmp, payload);
      await fs9.rename(tmp, abs);
    } catch (err) {
      await fs9.rm(tmp, { force: true }).catch(() => void 0);
      throw err;
    }
  }
  async exists(path16) {
    try {
      await fs9.access(this.abs(path16));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path16) {
    await fs9.mkdir(this.abs(path16), { recursive: true });
  }
  async move(from, to) {
    await fs9.mkdir(nodePath4.dirname(this.abs(to)), { recursive: true });
    await fs9.rename(this.abs(from), this.abs(to));
  }
  async remove(path16) {
    await fs9.rm(this.abs(path16), { recursive: true, force: true });
  }
  async withLock(path16, action) {
    const lockPath = this.abs(path16);
    await fs9.mkdir(nodePath4.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs9.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent is already running another write operation; try again later.");
        await fs9.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("Cannot acquire the Tent mutation lock.");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await fs9.rm(lockPath, { force: true });
    }
  }
};
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function isStaleLock(path16) {
  try {
    const stat2 = await fs9.stat(path16);
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
    const root = path9.resolve(workspaceRoot);
    const systemRoot = systemRootFromWorkspace(root);
    const rulesPath = path9.join(systemRoot, "RULES.md");
    try {
      await fs10.access(rulesPath);
    } catch {
      throw new Error(
        `No in-workspace Tent at ${systemRoot}. Expected ${TENT_SYSTEM_DIR}/RULES.md (B1 single-location model).`
      );
    }
    for (const existing of this.mounts.values()) {
      if (path9.resolve(existing.workspaceRoot) === root) {
        return this.toInfo(existing);
      }
    }
    const workspaceId = opts?.workspaceId?.trim() || makeWorkspaceId(root);
    if (this.mounts.has(workspaceId)) {
      throw new Error(`workspaceId already mounted: ${workspaceId}`);
    }
    const tentName = opts?.tentName?.trim() || path9.basename(root) || "tent";
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
  const base = path9.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "ws";
  const hash = Buffer.from(path9.resolve(workspaceRoot)).toString("base64url").slice(0, 10);
  return `ws-${base}-${hash}`;
}

// src/service/tool-approval-store.ts
import * as fs11 from "node:fs/promises";
import * as path10 from "node:path";
function cloneApproval2(item) {
  return {
    ...item,
    options: item.options.map((option) => ({ ...option }))
  };
}
var ToolApprovalStore = class {
  constructor(dataDir, options) {
    this.items = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
    this.loaded = false;
    /** Serialize mutations + persist (same pattern as SessionRegistry write chain). */
    this.chain = Promise.resolve();
    this.file = path10.join(dataDir, "tool-approvals.json");
    this.writeState = options?.writeState ?? writeJsonAtomic;
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
          if (item?.id) this.items.set(item.id, cloneApproval2(item));
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
    ).map(cloneApproval2);
  }
  async get(id) {
    await this.ensureLoaded();
    await this.expireStale(id);
    const item = this.items.get(id);
    return item ? cloneApproval2(item) : void 0;
  }
  /**
   * Session-level wait barrier for concurrent ACP permission requests.
   * Serialized with add/resolve/expire so callers never resume a session from
   * a stale snapshot while another request for that session is still pending.
   */
  async hasPendingForSession(sessionId) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      await this.expireStaleUnlocked();
      return [...this.items.values()].some(
        (item) => item.sessionId === sessionId && item.status === "pending"
      );
    });
  }
  async add(item) {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const stored = cloneApproval2(item);
      const next = new Map(this.items);
      next.set(stored.id, stored);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneApproval2(stored);
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
      const resolved = {
        ...item,
        status: decision,
        resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
        resolvedBy
      };
      const next = new Map(this.items);
      next.set(id, resolved);
      await this.persistSnapshot(next);
      this.items = next;
      this.notifyWaiters(id, decision);
      return cloneApproval2(resolved);
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
        const list2 = this.waiters.get(id);
        if (list2) {
          this.waiters.set(
            id,
            list2.filter((w) => w.resolve !== finish)
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
        const list2 = this.waiters.get(id) ?? [];
        list2.push({ resolve: finish });
        this.waiters.set(id, list2);
      }).catch(() => {
      });
      const timer = setTimeout(() => {
        void this.expireOne(id).then((status) => {
          if (status === "approved" || status === "denied") {
            finish(status);
            return;
          }
          finish("expired");
        }).catch(() => {
          finish("expired");
        });
      }, Math.max(1, timeoutMs));
    });
  }
  /** Cancel all pending for a session (session stop / fail). */
  async cancelSession(sessionId, reason = "denied") {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      const next = new Map(this.items);
      const resolvedIds = [];
      for (const item of this.items.values()) {
        if (item.sessionId !== sessionId || item.status !== "pending") continue;
        next.set(item.id, {
          ...item,
          status: reason,
          resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
          resolvedBy: "service"
        });
        resolvedIds.push(item.id);
      }
      if (resolvedIds.length > 0) {
        await this.persistSnapshot(next);
        this.items = next;
        for (const id of resolvedIds) {
          this.notifyWaiters(id, reason === "expired" ? "expired" : "denied");
        }
      }
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
      const expired = {
        ...item,
        status: "expired",
        resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
        resolvedBy: "timeout"
      };
      const next = new Map(this.items);
      next.set(id, expired);
      await this.persistSnapshot(next);
      this.items = next;
      this.notifyWaiters(id, "expired");
      return "expired";
    });
  }
  notifyWaiters(id, status) {
    const list2 = this.waiters.get(id);
    if (!list2?.length) return;
    this.waiters.delete(id);
    for (const w of list2) w.resolve(status);
  }
  async expireStale(onlyId) {
    return this.enqueue(async () => {
      await this.expireStaleUnlocked(onlyId);
    });
  }
  async expireStaleUnlocked(onlyId) {
    const now = Date.now();
    const next = new Map(this.items);
    const expiredIds = [];
    for (const item of this.items.values()) {
      if (onlyId && item.id !== onlyId) continue;
      if (item.status !== "pending") continue;
      const exp = Date.parse(item.expiresAt);
      if (!Number.isFinite(exp) || exp > now) continue;
      next.set(item.id, {
        ...item,
        status: "expired",
        resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
        resolvedBy: "timeout"
      });
      expiredIds.push(item.id);
    }
    if (expiredIds.length > 0) {
      await this.persistSnapshot(next);
      this.items = next;
      for (const id of expiredIds) this.notifyWaiters(id, "expired");
    }
  }
  /**
   * Atomic temp-file + rename so a crashed mid-write cannot leave a partial file,
   * and concurrent readers never observe a torn document. Call only under enqueue.
   */
  async persistSnapshot(snapshot) {
    const items = [...snapshot.values()];
    const pending = items.filter((i) => i.status === "pending");
    const terminal = items.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || "")).slice(0, 50);
    await this.writeState(this.file, { items: [...pending, ...terminal] });
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
      const list2 = parsed.credentials;
      if (list2 !== void 0 && !Array.isArray(list2)) {
        await this.quarantineCorrupt();
        this.loaded = true;
        return;
      }
      this.records.clear();
      for (const item of list2 ?? []) {
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
    let spawned = false;
    let exitNotified = false;
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
    const notifyExit = () => {
      if (!spawned || exitNotified) return;
      exitNotified = true;
      this.onExit?.({
        sessionId,
        exitCode: live.exitCode,
        signal: live.signal ?? void 0
      });
    };
    child.on("exit", (code, signal) => {
      live.exited = true;
      live.exitCode = code;
      live.signal = signal;
      if (live.killTimer) {
        clearTimeout(live.killTimer);
        live.killTimer = void 0;
      }
      notifyExit();
    });
    child.on("error", () => {
      if (!live.exited) {
        live.exited = true;
        live.exitCode = null;
        live.signal = "error";
      }
      notifyExit();
    });
    try {
      await new Promise((resolve10, reject) => {
        const onSpawn = () => {
          child.off("error", onStartError);
          spawned = true;
          resolve10();
        };
        const onStartError = (error) => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onStartError);
      });
    } catch (error) {
      this.children.delete(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to spawn process for session ${sessionId}: ${message}`);
    }
    if (child.pid == null) {
      this.children.delete(sessionId);
      throw new Error(`Failed to spawn process for session ${sessionId}: missing pid`);
    }
    return {
      sessionId,
      pid: child.pid,
      startedAt: live.startedAt,
      exitCode: live.exitCode,
      signal: live.signal,
      exited: live.exited
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
    assigneeKind: record.assigneeKind,
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
    this.startInFlight = /* @__PURE__ */ new Map();
    this.resumeInFlight = /* @__PURE__ */ new Map();
    this.childExitInFlight = /* @__PURE__ */ new Map();
    this.managedTerminalInFlight = /* @__PURE__ */ new Map();
    this.sinks = /* @__PURE__ */ new Map();
    this.globalSinks = /* @__PURE__ */ new Set();
    this.closing = false;
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
        const projection = this.onChildExit(info.sessionId, info.exitCode, info.signal);
        this.childExitInFlight.set(info.sessionId, projection);
        void projection.finally(() => {
          if (this.childExitInFlight.get(info.sessionId) === projection) {
            this.childExitInFlight.delete(info.sessionId);
          }
        }).catch(() => void 0);
      },
      onStdout: (sessionId, text3) => {
        if (options.captureStdout === false) return;
        this.emit({ type: "session.stdout_tail", sessionId, text: text3 });
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
    if (this.startInFlight.has(req.sessionId)) {
      throw new Error(`Session start already in progress: ${req.sessionId}`);
    }
    if (this.resumeInFlight.has(req.sessionId)) {
      throw new Error(`Session resume already in progress: ${req.sessionId}`);
    }
    const operation = this.startSessionExclusive(req);
    this.startInFlight.set(req.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.startInFlight.get(req.sessionId) === operation) {
        this.startInFlight.delete(req.sessionId);
      }
    }
  }
  async startSessionExclusive(req) {
    const existing = await this.registry.read(req.sessionId);
    if (existing && SessionRegistry.isNonTerminal(existing.state)) {
      throw new Error(`Session already active: ${req.sessionId}`);
    }
    const profile = this.profiles.get(req.profileId);
    if (!profile) {
      throw new Error(`Unknown AgentProfile: ${req.profileId}`);
    }
    return this.startSessionWithProfile(req, cloneProfileConfig(profile));
  }
  async startSessionWithProfile(req, profile) {
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
      profileSnapshot: cloneProfileConfig(profile),
      roleName: req.roleName,
      assigneeKind: req.assigneeKind,
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
    let startedManaged;
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
      let startupCommitted = false;
      let startupLivePid;
      let terminalProjection;
      let terminalDuringManagedStart;
      if (typeof adapter.startManagedSession === "function") {
        const managed = await adapter.startManagedSession(plan, (ev) => {
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            terminalProjection = this.trackManagedTerminal(
              req.sessionId,
              "failed",
              ev.error
            );
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode
            };
            terminalProjection = this.trackManagedTerminal(
              req.sessionId,
              "stopped",
              void 0,
              ev.exitCode
            );
          } else if (ev.type === "session.waiting_user") {
            void this.registry.update(req.sessionId, { state: "waiting-user" }).catch(() => void 0);
          } else if (ev.type === "session.live") {
            if (!startupCommitted) {
              startupLivePid = ev.pid;
              return;
            }
            void this.registry.update(req.sessionId, {
              state: "live",
              ...ev.pid != null ? { pid: ev.pid } : {}
            }).catch(() => void 0);
          }
          this.emit(ev);
        });
        startedManaged = managed;
        if (terminalDuringManagedStart) {
          const terminal = terminalDuringManagedStart;
          await (terminalProjection ?? this.trackManagedTerminal(
            req.sessionId,
            terminal.state,
            terminal.state === "failed" ? terminal.error : void 0,
            terminal.state === "stopped" ? terminal.exitCode : void 0
          ));
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
      }
      const live = await this.registry.update(req.sessionId, {
        state: "live",
        pid,
        resumeToken,
        lastError: void 0,
        exitCode: void 0,
        stopReason: void 0
      });
      startupCommitted = true;
      this.emit({
        type: "session.live",
        sessionId: req.sessionId,
        pid: startupLivePid ?? pid
      });
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      if (startedManaged) {
        await startedManaged.stop("interrupt").catch(() => void 0);
        await this.waitForManagedTerminal(req.sessionId, true);
      } else if (this.supervisor.isAlive(req.sessionId)) {
        await this.supervisor.stop(req.sessionId).catch(() => void 0);
        await this.waitForChildExit(req.sessionId, true);
      }
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
    if (this.startInFlight.has(req.sessionId)) {
      throw new Error(`Session start already in progress: ${req.sessionId}`);
    }
    const existingResume = this.resumeInFlight.get(req.sessionId);
    if (existingResume) return existingResume;
    const operation = this.resumeSessionExclusive(req);
    this.resumeInFlight.set(req.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.resumeInFlight.get(req.sessionId) === operation) {
        this.resumeInFlight.delete(req.sessionId);
      }
    }
  }
  async resumeSessionExclusive(req) {
    const record = await this.registry.read(req.sessionId);
    if (!record) throw new Error(`Session not found: ${req.sessionId}`);
    const profile = this.profileForResume(record);
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
      return this.startSessionWithProfile({
        sessionId: req.sessionId,
        profileId: record.profileId,
        roleName: record.roleName,
        assigneeKind: record.assigneeKind,
        workspaceLane: record.workspaceLane,
        runtimeWorkspace: { cwd },
        workspace: record.workspace,
        lastTaskId: record.lastTaskId,
        env: req.env,
        bootstrapPrompt: void 0
      }, profile);
    }
    if (typeof adapter.resumeManagedSession !== "function") {
      throw new Error(
        `Adapter ${adapter.id} advertises canResume but does not implement resumeManagedSession`
      );
    }
    const resumeManagedSession = adapter.resumeManagedSession.bind(adapter);
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
      let startupCommitted = false;
      let startupLivePid;
      let terminalProjection;
      let terminalDuringManagedStart;
      const managed = await resumeManagedSession(
        plan,
        resumeToken,
        (ev) => {
          if (ev.type === "session.failed") {
            terminalDuringManagedStart = { state: "failed", error: ev.error };
            terminalProjection = this.trackManagedTerminal(
              req.sessionId,
              "failed",
              ev.error
            );
          } else if (ev.type === "session.exited") {
            terminalDuringManagedStart = {
              state: "stopped",
              exitCode: ev.exitCode
            };
            terminalProjection = this.trackManagedTerminal(
              req.sessionId,
              "stopped",
              void 0,
              ev.exitCode
            );
          } else if (ev.type === "session.waiting_user") {
            void this.registry.update(req.sessionId, { state: "waiting-user" }).catch(() => void 0);
          } else if (ev.type === "session.live") {
            if (!startupCommitted) {
              startupLivePid = ev.pid;
              return;
            }
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
        await (terminalProjection ?? this.trackManagedTerminal(
          req.sessionId,
          terminal.state,
          terminal.state === "failed" ? terminal.error : void 0,
          terminal.state === "stopped" ? terminal.exitCode : void 0
        ));
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
      startupCommitted = true;
      this.emit({
        type: "session.live",
        sessionId: req.sessionId,
        pid: startupLivePid ?? pid
      });
      return handleFrom(live);
    } catch (err) {
      this.managed.delete(req.sessionId);
      if (resumedManaged) {
        await resumedManaged.stop("interrupt").catch(() => void 0);
        await this.waitForManagedTerminal(req.sessionId, true);
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
  }
  /**
   * New rows resume from their immutable launch snapshot. Legacy rows without a
   * snapshot use the current catalog as a bounded read fallback.
   */
  profileForResume(record) {
    const snapshot = record.profileSnapshot;
    if (snapshot) {
      if (snapshot.id !== record.profileId) {
        throw new Error(
          `Session profile snapshot id mismatch: row=${record.profileId} snapshot=${snapshot.id}`
        );
      }
      if (snapshot.adapterId !== record.adapterId) {
        throw new Error(
          `Session profile snapshot adapter mismatch: row=${record.adapterId} snapshot=${snapshot.adapterId}`
        );
      }
      return cloneProfileConfig(snapshot);
    }
    const current = this.profiles.get(record.profileId);
    if (!current) throw new Error(`Unknown AgentProfile: ${record.profileId}`);
    if (current.adapterId !== record.adapterId) {
      throw new Error(
        `Legacy session adapter mismatch: row=${record.adapterId} profile=${current.adapterId}`
      );
    }
    return cloneProfileConfig(current);
  }
  async stopSession(sessionId, reason) {
    this.assertOpen();
    await this.stopSessionInternal(sessionId, reason);
  }
  async stopSessionInternal(sessionId, reason) {
    const record = await this.registry.read(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);
    const managed = this.managed.get(sessionId);
    if (managed) {
      try {
        await managed.stop(reason);
      } finally {
        this.managed.delete(sessionId);
      }
      await this.waitForManagedTerminal(sessionId);
    } else if (this.supervisor.isAlive(sessionId)) {
      await this.supervisor.stop(sessionId, { signal: "SIGTERM" });
    }
    await this.waitForChildExit(sessionId);
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
    const all2 = await this.registry.list();
    const results = [];
    for (const rec of all2) {
      if (!SessionRegistry.isNonTerminal(rec.state)) continue;
      results.push(await this.probe(rec.id));
    }
    return results;
  }
  /** Service shutdown: stop push children this runtime started (window close does not call this). */
  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.closed) return;
    this.closing = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }
  async shutdownInternal() {
    try {
      await Promise.allSettled([
        ...this.startInFlight.values(),
        ...this.resumeInFlight.values()
      ]);
      const managedIds = [...this.managed.keys()];
      const live = /* @__PURE__ */ new Set([...this.supervisor.listLive(), ...managedIds]);
      for (const id of live) {
        try {
          await this.stopSessionInternal(id, "shutdown");
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
    } finally {
      this.closed = true;
    }
  }
  /**
   * Managed ACP terminal path (no ProcessSupervisor exit). Idempotent:
   * second failure/exit does not illegal-transition the session row.
   */
  trackManagedTerminal(sessionId, terminalState, lastError, exitCode) {
    const projection = this.onManagedTerminal(
      sessionId,
      terminalState,
      lastError,
      exitCode
    ).catch(
      () => this.onManagedTerminal(sessionId, terminalState, lastError, exitCode)
    );
    let pending = this.managedTerminalInFlight.get(sessionId);
    if (!pending) {
      pending = /* @__PURE__ */ new Set();
      this.managedTerminalInFlight.set(sessionId, pending);
    }
    pending.add(projection);
    void projection.finally(() => {
      pending.delete(projection);
      if (pending.size === 0 && this.managedTerminalInFlight.get(sessionId) === pending) {
        this.managedTerminalInFlight.delete(sessionId);
      }
    }).catch(() => void 0);
    return projection;
  }
  async waitForManagedTerminal(sessionId, suppressError = false) {
    let firstError;
    while (true) {
      const pending = this.managedTerminalInFlight.get(sessionId);
      if (!pending?.size) {
        if (!suppressError && firstError !== void 0) throw firstError;
        return;
      }
      const snapshot = [...pending];
      const results = await Promise.allSettled(snapshot);
      if (!suppressError && firstError === void 0) {
        const rejected = results.find(
          (result) => result.status === "rejected"
        );
        if (rejected) firstError = rejected.reason;
      }
    }
  }
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
  async waitForChildExit(sessionId, suppressError = false) {
    const projection = this.childExitInFlight.get(sessionId);
    if (!projection) return;
    if (suppressError) {
      await projection.catch(() => void 0);
      return;
    }
    await projection;
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
    if (this.closed || this.closing) throw new Error("AgentRuntime is shut down");
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
import * as path14 from "node:path";
import { fileURLToPath } from "node:url";

// src/service/service-lease.ts
import { randomUUID } from "node:crypto";
import * as fs13 from "node:fs/promises";
import * as path13 from "node:path";
var ServiceDataDirBusyError = class extends Error {
  constructor(dataDir, owner) {
    super(
      `Local Tent Service data directory is already owned by pid ${owner.pid} (instance ${owner.instanceId}): ${dataDir}`
    );
    this.name = "ServiceDataDirBusyError";
    this.owner = owner;
  }
};
function serviceLeasePath(dataDir) {
  return path13.join(dataDir, "service.lock");
}
async function acquireServiceDataDirLease(dataDir, options = {}) {
  const pid = options.pid ?? process.pid;
  const instanceId = options.makeInstanceId?.() ?? randomUUID();
  const startedAt = (options.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const record = { instanceId, pid, startedAt };
  const lockPath = serviceLeasePath(dataDir);
  await fs13.mkdir(dataDir, { recursive: true });
  const candidate = `${lockPath}.candidate-${instanceId}`;
  await fs13.writeFile(candidate, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx"
  });
  try {
    for (; ; ) {
      try {
        await fs13.link(candidate, lockPath);
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const owner = await readLeaseRecord(lockPath);
        if (owner && isProcessAlive(owner.pid)) {
          throw new ServiceDataDirBusyError(dataDir, owner);
        }
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await fs13.rename(lockPath, stalePath);
          try {
            await fs13.rm(stalePath, { force: true });
          } catch {
          }
        } catch (error2) {
          if (hasCode(error2, "ENOENT")) continue;
          throw error2;
        }
      }
    }
  } finally {
    try {
      await fs13.rm(candidate, { force: true });
    } catch {
    }
  }
  let released = false;
  return {
    ...record,
    path: lockPath,
    release: async () => {
      if (released) return;
      const owner = await readLeaseRecord(lockPath);
      if (owner?.instanceId === instanceId) {
        await fs13.rm(lockPath, { force: true });
      }
      released = true;
    }
  };
}
async function readLeaseRecord(file) {
  try {
    const value = JSON.parse(await fs13.readFile(file, "utf8"));
    if (typeof value.instanceId !== "string" || !value.instanceId || typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.startedAt !== "string") {
      return null;
    }
    return value;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}
function hasCode(error, code) {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

// src/service/service.ts
var SERVICE_VERSION = "0.1.0-b5";
async function startLocalTentService(options = {}) {
  const dataDir = options.dataDir ?? defaultServiceDataDir();
  const serviceLease = await acquireServiceDataDirLease(dataDir);
  const startupCleanups = [];
  try {
    return await startOwnedLocalTentService(
      options,
      dataDir,
      serviceLease,
      (phase, action) => startupCleanups.push({ phase, action })
    );
  } catch (error) {
    startupCleanups.sort((a, b) => a.phase - b.phase);
    for (const cleanup of startupCleanups) {
      try {
        await cleanup.action();
      } catch {
      }
    }
    await serviceLease.release();
    throw error;
  }
}
async function startOwnedLocalTentService(options, dataDir, serviceLease, registerStartupCleanup) {
  const version = options.version ?? SERVICE_VERSION;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const getPid = options.getPid ?? (() => process.pid);
  const token = options.token ?? generateServiceToken();
  const events = new EventBus();
  const mutations = new MutationBus();
  const workspaceHost = new WorkspaceHost({ events });
  registerStartupCleanup(30, () => workspaceHost.dispose());
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
  registerStartupCleanup(10, async () => {
    try {
      await runtime.shutdown();
    } catch {
    }
  });
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
  const runtimeProjections = /* @__PURE__ */ new Set();
  const unsubscribeRuntimeEvents = runtime.subscribeAll((ev) => {
    const projection = mapRuntimeEventToService(ctx, ev);
    runtimeProjections.add(projection);
    void projection.then(
      () => runtimeProjections.delete(projection),
      () => runtimeProjections.delete(projection)
    );
  });
  const drainRuntimeProjections = async () => {
    while (runtimeProjections.size > 0) {
      await Promise.allSettled([...runtimeProjections]);
    }
  };
  registerStartupCleanup(20, async () => {
    await drainRuntimeProjections();
    unsubscribeRuntimeEvents();
  });
  const httpServer = await createServiceHttpServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    ctx,
    events,
    token
  });
  registerStartupCleanup(5, () => httpServer.close());
  let endpoint = null;
  if (options.writeEndpoint !== false) {
    endpoint = {
      instanceId: serviceLease.instanceId,
      pid: getPid(),
      host: httpServer.host,
      port: httpServer.port,
      startedAt,
      version,
      token
    };
    await writeServiceEndpoint(dataDir, endpoint);
    registerStartupCleanup(
      50,
      () => removeServiceEndpoint(dataDir, serviceLease.instanceId)
    );
  }
  events.emit("service.health", "", {
    action: "started",
    url: httpServer.url,
    pid: getPid()
  });
  let stopPromise = null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      let firstError;
      const attempt = async (action, bestEffort = false) => {
        try {
          await action();
        } catch (error) {
          if (!bestEffort && firstError === void 0) firstError = error;
        }
      };
      try {
        events.emit("service.health", "", { action: "stopping" });
        await attempt(() => httpServer.close());
        await attempt(() => runtime.shutdown(), true);
        await attempt(() => drainRuntimeProjections());
        unsubscribeRuntimeEvents();
        await attempt(() => workspaceHost.dispose());
      } finally {
        if (options.writeEndpoint !== false) {
          await attempt(() => removeServiceEndpoint(dataDir, serviceLease.instanceId));
        }
        await attempt(() => serviceLease.release());
      }
      if (firstError !== void 0) throw firstError;
    })();
    return stopPromise;
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
  const here = path14.dirname(fileURLToPath(import.meta.url));
  if (path14.basename(here) === "service" && path14.basename(path14.dirname(here)) === "src") {
    return path14.resolve(here, "../..");
  }
  return path14.resolve(here);
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
    dataDir: dataDir ? path15.resolve(dataDir) : void 0
  });
  if (mountPath) {
    const info = await service.hostApi.mount(path15.resolve(mountPath));
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
