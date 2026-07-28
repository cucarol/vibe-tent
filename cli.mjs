#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^-\s*/.test(trimmed)) continue;
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
  if (v.startsWith("{")) {
    if (!v.endsWith("}")) {
      throw new Error("Invalid frontmatter YAML: unterminated flow mapping.");
    }
    return parseFlowMapping(v);
  }
  if (v.startsWith("[") && !v.endsWith("]")) {
    throw new Error("Invalid frontmatter YAML: unterminated flow array.");
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowCollection(inner).map((item) => coerce(item.trim()));
  }
  return v;
}
function isBlockSequenceStart(line) {
  return line !== void 0 && /^\s*-\s*/.test(line);
}
function leadingIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}
function readBlockSequence(lines, startIndex, key) {
  const value = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    const itemMatch = line.match(/^(\s*)-\s*(.*)$/);
    if (!itemMatch) break;
    const itemIndent = itemMatch[1].length;
    const rest = stripInlineComment(itemMatch[2].trim());
    i += 1;
    const inlineMap = rest.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (inlineMap && !(rest.startsWith("{") || rest.startsWith("["))) {
      const obj = {};
      const firstKey = inlineMap[1];
      const firstVal = stripInlineComment(inlineMap[2].trim());
      obj[firstKey] = firstVal === "" ? void 0 : coerceForKey(key, firstVal);
      while (i < lines.length) {
        const cont = lines[i];
        if (!cont.trim() || cont.trim().startsWith("#")) {
          i += 1;
          continue;
        }
        if (leadingIndent(cont) <= itemIndent) break;
        if (/^\s*-\s*/.test(cont)) break;
        const trimmed = cont.trim();
        const colon = trimmed.indexOf(":");
        if (colon === -1) break;
        const fieldKey = trimmed.slice(0, colon).trim();
        const fieldVal = stripInlineComment(trimmed.slice(colon + 1).trim());
        obj[fieldKey] = fieldVal === "" ? void 0 : coerceForKey(key, fieldVal);
        i += 1;
      }
      for (const k of Object.keys(obj)) {
        if (obj[k] === void 0) delete obj[k];
      }
      value.push(obj);
      continue;
    }
    value.push(rest === "" ? null : coerceForKey(key, rest));
  }
  return { value, nextIndex: i };
}
function parseFlowMapping(raw) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return {};
  const parts = splitFlowCollection(inner);
  const out = {};
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = findTopLevelColon(trimmed);
    if (colon === -1) {
      throw new Error(`Invalid frontmatter YAML: flow mapping entry missing colon: ${trimmed}`);
    }
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (!k) throw new Error("Invalid frontmatter YAML: empty flow mapping key.");
    out[k] = v === "" ? null : coerce(v);
  }
  return out;
}
function findTopLevelColon(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === ":" && depth === 0) return i;
  }
  return -1;
}
function splitFlowCollection(inner) {
  const items = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        current += inner[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items;
}
function coerceForKey(key, raw) {
  if (key !== "commits") return coerce(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowCollection(inner).map((item) => coerceCommitItem(item.trim()));
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
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function serializeFrontmatter(data, body, keyOrder = []) {
  const keys = orderedKeys(data, keyOrder);
  const lines = [FENCE];
  for (const k of keys) {
    const val = data[k];
    if (val === void 0) continue;
    if (Array.isArray(val) && val.some(isPlainObject)) {
      lines.push(`${k}:`);
      if (val.length === 0) {
        lines[lines.length - 1] = `${k}: []`;
      } else {
        for (const item of val) {
          lines.push(`  - ${emit(item)}`);
        }
      }
      continue;
    }
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
  if (isPlainObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== void 0);
    if (keys.length === 0) return "{}";
    return "{" + keys.map((k) => `${k}: ${emit(v[k])}`).join(", ") + "}";
  }
  const s = String(v);
  if (/^-?(?:\d+|\d*\.\d+)$/.test(s) || /[:,#\[\]{}]/.test(s) || s !== s.trim() || s === "") {
    return JSON.stringify(s);
  }
  return s;
}
var FENCE, BOX_FRONTMATTER_KEY_ORDER;
var init_frontmatter = __esm({
  "src/core/frontmatter.ts"() {
    "use strict";
    FENCE = "---";
    BOX_FRONTMATTER_KEY_ORDER = ["id", "type", "tags", "mode", "relations"];
  }
});

// src/core/registryRecovery.ts
async function backupCorruptRegistry(fs10, path9) {
  const backupPath = `${path9}.corrupt-${timestamp()}`;
  await fs10.writeFile(backupPath, await fs10.readFile(path9));
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
var init_registryRecovery = __esm({
  "src/core/registryRecovery.ts"() {
    "use strict";
  }
});

// src/core/paths.ts
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
  const path9 = relativePath2.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path9) return false;
  const top = path9.split("/")[0] ?? "";
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
function agentProfileManifestPath(profileId, taskId) {
  const safeTask = safeOperationalSegment(taskId, "task");
  return `${agentProfileTempRoot(profileId)}/manifests/${safeTask}.yml`;
}
function isSystemNoteName(fileName) {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}
var TENT_SYSTEM_DIR, TYPE_REGISTRY_PATH, ROLES_REGISTRY_PATH, TAGS_REGISTRY_PATH, ORDER_PATH, MUTATION_LOCK_PATH, RULES_PATH, WORKSPACE_SETTINGS_PATH, ANNOTATIONS_PATH, TEMP_DIR, ATTACHMENTS_DIR, AGENT_PROFILES_TEMP_DIR, OPERATIONAL_TOP_LEVEL, SYSTEM_REGISTRY_FILES;
var init_paths = __esm({
  "src/core/paths.ts"() {
    "use strict";
    TENT_SYSTEM_DIR = ".tent";
    TYPE_REGISTRY_PATH = "types.json";
    ROLES_REGISTRY_PATH = "roles.json";
    TAGS_REGISTRY_PATH = "tags.json";
    ORDER_PATH = "order.json";
    MUTATION_LOCK_PATH = "mutation.lock";
    RULES_PATH = "RULES.md";
    WORKSPACE_SETTINGS_PATH = "settings.json";
    ANNOTATIONS_PATH = "annotations.json";
    TEMP_DIR = "temp";
    ATTACHMENTS_DIR = "attachments";
    AGENT_PROFILES_TEMP_DIR = "agent-profiles";
    OPERATIONAL_TOP_LEVEL = /* @__PURE__ */ new Set([
      TEMP_DIR,
      ATTACHMENTS_DIR,
      // 历史残留：若仍见嵌套 .tent，视为系统区而非 concept
      TENT_SYSTEM_DIR
    ]);
    SYSTEM_REGISTRY_FILES = /* @__PURE__ */ new Set([
      TYPE_REGISTRY_PATH,
      ROLES_REGISTRY_PATH,
      TAGS_REGISTRY_PATH,
      ORDER_PATH,
      MUTATION_LOCK_PATH,
      RULES_PATH,
      WORKSPACE_SETTINGS_PATH,
      ANNOTATIONS_PATH,
      "index.md",
      "log.md"
    ]);
  }
});

// src/core/order.ts
async function loadOrder(fs10) {
  if (!await fs10.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs10.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs10, ORDER_PATH);
    await saveOrder(fs10, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs10, map) {
  await fs10.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
var ROOT_KEY;
var init_order = __esm({
  "src/core/order.ts"() {
    "use strict";
    init_registryRecovery();
    init_paths();
    ROOT_KEY = "__root__";
  }
});

// src/core/typeRegistry.ts
function splitType(type) {
  const i = type.indexOf("-");
  if (i === -1) return { base: type };
  return { base: type.slice(0, i), modifier: type.slice(i + 1) };
}
function isCanonicalPrimary(name) {
  return CANONICAL_PRIMARY_TYPES.includes(name);
}
function isBuiltinSecondary(name) {
  return BUILTIN_SECONDARY_TYPES.includes(name);
}
function typeExists(type, registry) {
  if (registry[type]) return true;
  const { base, modifier } = splitType(type);
  const baseOk = !!registry[base] && (registry[base].tier ?? "base") !== "modifier";
  if (!baseOk) return false;
  if (modifier === void 0) return true;
  const mod = registry[modifier];
  return !!mod && mod.tier === "modifier";
}
async function loadTypeRegistry(fs10) {
  if (!await fs10.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs10.readFile(TYPE_REGISTRY_PATH));
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
    mergeDefinitions(registry, mapLegacyBucketKeys(root.primary));
    mergeDefinitions(registry, mapLegacyBucketKeys(root.secondary), "modifier");
    finalizeRegistry(registry);
    return registry;
  }
  mergeDefinitions(registry, mapLegacyBucketKeys(root));
  finalizeRegistry(registry);
  return registry;
}
function mapLegacyBucketKeys(source) {
  if (!isRecord(source)) return {};
  const out = {};
  for (const [rawName, raw] of Object.entries(source)) {
    const name = mapLegacyTypeKey(rawName);
    if (!name) continue;
    if (out[name] === void 0) out[name] = raw;
  }
  return out;
}
function mapLegacyTypeKey(name) {
  if (name === "note") return "prompt";
  if (name === "artifact") return "output";
  if (name === "open" || name === "sealed") return "";
  return name;
}
function mergeDefinitions(registry, source, defaultTier) {
  if (!isRecord(source)) return;
  for (const [name, raw] of Object.entries(source)) {
    if (!name.trim() || name === "temp" || !isRecord(raw)) continue;
    const current = registry[name];
    const tier = raw.tier === "base" || raw.tier === "modifier" ? raw.tier : current?.tier ?? defaultTier ?? (isCanonicalPrimary(name) ? "base" : "modifier");
    if (isCanonicalPrimary(name)) {
      registry[name] = { tier: "base" };
      continue;
    }
    if (isBuiltinSecondary(name)) {
      registry[name] = { tier: "modifier" };
      continue;
    }
    if (tier === "base") {
      continue;
    }
    registry[name] = { tier: "modifier" };
  }
}
function finalizeRegistry(registry) {
  for (const p of CANONICAL_PRIMARY_TYPES) {
    registry[p] = { tier: "base" };
  }
  for (const s of BUILTIN_SECONDARY_TYPES) {
    registry[s] = { tier: "modifier" };
  }
  delete registry.note;
  delete registry.artifact;
  delete registry.open;
  delete registry.sealed;
}
function cloneDefaults() {
  return Object.fromEntries(
    Object.entries(DEFAULT_TYPE_REGISTRY).map(([name, def]) => [name, { ...def }])
  );
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var CANONICAL_PRIMARY_TYPES, BUILTIN_SECONDARY_TYPES, DEFAULT_TYPE_REGISTRY;
var init_typeRegistry = __esm({
  "src/core/typeRegistry.ts"() {
    "use strict";
    init_paths();
    CANONICAL_PRIMARY_TYPES = ["goal", "prompt", "output"];
    BUILTIN_SECONDARY_TYPES = ["reference", "asset"];
    DEFAULT_TYPE_REGISTRY = {
      goal: { tier: "base" },
      prompt: { tier: "base" },
      output: { tier: "base" },
      reference: { tier: "modifier" },
      asset: { tier: "modifier" }
    };
  }
});

// src/core/adapter.ts
function withTentMutation(fs10, action) {
  return fs10.withLock ? fs10.withLock(MUTATION_LOCK_PATH, action) : action();
}
var init_adapter = __esm({
  "src/core/adapter.ts"() {
    "use strict";
    init_paths();
  }
});

// src/core/relations.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRelationId(id) {
  return id.startsWith(RELATION_ID_PREFIX) && id.length > RELATION_ID_PREFIX.length;
}
function normalizeRelationTarget(raw) {
  if (!isRecord2(raw)) {
    throw new RelationError("INVALID_INPUT", "relation target must be an object");
  }
  const hasNodeId = Object.prototype.hasOwnProperty.call(raw, "nodeId");
  const hasUnresolved = Object.prototype.hasOwnProperty.call(raw, "unresolved");
  if (hasNodeId && hasUnresolved) {
    throw new RelationError(
      "INVALID_INPUT",
      "relation target must be exactly one of { nodeId } or { unresolved }"
    );
  }
  if (hasNodeId) {
    if (typeof raw.nodeId !== "string" || !raw.nodeId.trim()) {
      throw new RelationError("INVALID_INPUT", "relation target.nodeId must be a non-empty string");
    }
    return { nodeId: raw.nodeId.trim() };
  }
  if (hasUnresolved) {
    if (typeof raw.unresolved !== "string" || !raw.unresolved.trim()) {
      throw new RelationError(
        "INVALID_INPUT",
        "relation target.unresolved must be a non-empty string"
      );
    }
    return { unresolved: raw.unresolved.trim() };
  }
  throw new RelationError(
    "INVALID_INPUT",
    "relation target must be exactly one of { nodeId } or { unresolved }"
  );
}
function normalizeRelationDirection(raw) {
  if (raw === "directed" || raw === "bidirectional") return raw;
  throw new RelationError(
    "INVALID_INPUT",
    'relation direction must be "directed" or "bidirectional"'
  );
}
function normalizeRelationKind(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RelationError("INVALID_INPUT", "relation kind must be a non-empty string");
  }
  const kind = raw.trim();
  if (/[\r\n]/.test(kind)) {
    throw new RelationError("INVALID_INPUT", "relation kind cannot contain newlines");
  }
  return kind;
}
function normalizeRelationLabel(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw !== "string") {
    throw new RelationError("INVALID_INPUT", "relation label must be a string when present");
  }
  const label = raw.trim();
  return label.length > 0 ? label : void 0;
}
function parseRelationRecord(raw) {
  if (!isRecord2(raw)) return null;
  if (typeof raw.id !== "string" || !isRelationId(raw.id)) return null;
  let kind;
  let direction;
  let target;
  let label;
  try {
    kind = normalizeRelationKind(raw.kind);
    direction = normalizeRelationDirection(raw.direction);
    label = normalizeRelationLabel(raw.label);
    if (isRecord2(raw.target)) {
      target = normalizeRelationTarget(raw.target);
    } else if (Object.prototype.hasOwnProperty.call(raw, "nodeId") || Object.prototype.hasOwnProperty.call(raw, "unresolved")) {
      target = normalizeRelationTarget({
        ...Object.prototype.hasOwnProperty.call(raw, "nodeId") ? { nodeId: raw.nodeId } : {},
        ...Object.prototype.hasOwnProperty.call(raw, "unresolved") ? { unresolved: raw.unresolved } : {}
      });
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const out = { id: raw.id, kind, direction, target };
  if (label !== void 0) out.label = label;
  return out;
}
function normalizeRelationsList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    const parsed = parseRelationRecord(item);
    if (!parsed) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}
function relationToFrontmatterItem(record) {
  const item = {
    id: record.id,
    kind: record.kind,
    direction: record.direction
  };
  if (record.label !== void 0) item.label = record.label;
  if ("nodeId" in record.target) item.nodeId = record.target.nodeId;
  else item.unresolved = record.target.unresolved;
  return item;
}
function relationsToFrontmatterValue(records) {
  if (records.length === 0) return void 0;
  return records.map(relationToFrontmatterItem);
}
var RELATION_ID_PREFIX, RelationError;
var init_relations = __esm({
  "src/core/relations.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_tree();
    RELATION_ID_PREFIX = "rl-";
    RelationError = class extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "RelationError";
      }
    };
  }
});

// src/core/tree.ts
function boxNotePath(boxPath) {
  return join3(boxPath, baseName(boxPath) + ".md");
}
async function loadTent(fs10) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs10);
  const top = await fs10.listDir("");
  for (const entry2 of top) {
    if (!entry2.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry2.name)) continue;
    if (isSystemNoteName(entry2.name)) continue;
    await loadBoxInto(fs10, entry2.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs10);
  const sortedRoots = sortByOrder(roots, order[ROOT_KEY], (a, b) => a.name.localeCompare(b.name));
  for (const root of sortedRoots) sortChildren(root, order);
  for (const root of sortedRoots) resolveSubtree(root, typeRegistry);
  const duplicateIds = findDuplicateIds(sortedRoots);
  for (const root of sortedRoots) applyDuplicateInvalid(root, duplicateIds);
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
  }
  for (const child of box.children) applyDuplicateInvalid(child, duplicateIds, invalid);
}
function sortChildren(box, order) {
  box.children = sortByOrder(box.children, order[box.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of box.children) sortChildren(c, order);
}
async function loadBox(fs10, path9, parent, registry) {
  if (isOperationalPath(path9)) return null;
  const boxFile = boxNotePath(path9);
  if (!await fs10.exists(boxFile)) {
    return null;
  }
  const raw = await fs10.readFile(boxFile);
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
  const { fm, tags, relations } = normalizeIdentity(data);
  const box = {
    id: fm.id,
    type: fm.type,
    tags,
    relations,
    mode: "editable",
    archived: false,
    invalid: !!parseError,
    path: path9,
    name,
    fm,
    body,
    children: [],
    parent
  };
  if (parseError) {
    box.invalidRootId = path9;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs10.listDir(path9);
  for (const entry2 of sub) {
    if (!entry2.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry2.name)) continue;
    await loadBoxInto(fs10, join3(path9, entry2.name), box, registry, box.children);
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
  delete fm.archived;
  delete fm.readable;
  delete fm.writable;
  delete fm.owner;
  delete fm.status;
  delete fm.acceptedBy;
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
function parseNodeMode(value) {
  if (value === "archived") return "archived";
  if (value === "editable") return "editable";
  if (value === "read-only") return "editable";
  return void 0;
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
async function loadBoxInto(fs10, path9, parent, registry, target) {
  if (isOperationalPath(path9)) return;
  const box = await loadBox(fs10, path9, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs10.listDir(path9);
  for (const entry2 of sub) {
    if (!entry2.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry2.name)) continue;
    await loadBoxInto(fs10, join3(path9, entry2.name), parent, registry, target);
  }
}
function resolveSubtree(box, registry, inheritedInvalid, inheritedArchived = false) {
  const directInvalid = box.invalid ? { rootId: box.invalidRootId || box.path, reason: box.invalidReason || "Invalid frontmatter." } : invalidTypeReference(box, registry);
  const invalid = inheritedInvalid || directInvalid;
  box.invalid = !!invalid;
  box.invalidRootId = invalid?.rootId;
  box.invalidReason = invalid?.reason;
  const localMode = parseNodeMode(box.fm.mode) ?? "editable";
  box.archived = inheritedArchived || localMode === "archived";
  box.mode = box.archived ? "archived" : "editable";
  if (localMode === "archived" && !inheritedArchived) box.fm.mode = "archived";
  else delete box.fm.mode;
  for (const c of box.children) resolveSubtree(c, registry, invalid, box.archived);
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
function assertContentMutable(box, action = "modified") {
  if (box.invalid) throw new Error(`Invalid boxes cannot be ${action}.`);
  if (box.archived || box.mode === "archived") {
    throw new Error(`Archived boxes cannot be ${action}.`);
  }
}
function indexSubtree(box, byId, byPath, duplicateIds) {
  if (box.id && !duplicateIds.has(box.id)) byId.set(box.id, box);
  byPath.set(box.path, box);
  for (const c of box.children) indexSubtree(c, byId, byPath, duplicateIds);
}
function join3(...parts) {
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
var init_tree = __esm({
  "src/core/tree.ts"() {
    "use strict";
    init_frontmatter();
    init_order();
    init_typeRegistry();
    init_paths();
    init_relations();
  }
});

// src/core/id.ts
function deterministicDigest(input, byteLen = 32) {
  const out = new Uint8Array(byteLen);
  for (let offset = 0; offset < byteLen; offset += 4) {
    let h = (2166136261 ^ Math.imul(offset + 1, 2654435769)) >>> 0;
    const salted = `${offset}\0${input}`;
    for (let i = 0; i < salted.length; i++) {
      h ^= salted.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    out[offset] = h & 255;
    if (offset + 1 < byteLen) out[offset + 1] = h >>> 8 & 255;
    if (offset + 2 < byteLen) out[offset + 2] = h >>> 16 & 255;
    if (offset + 3 < byteLen) out[offset + 3] = h >>> 24 & 255;
  }
  return out;
}
function encodeAlphabetBytes(bytes, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    const b = bytes[i % bytes.length] ^ i * 17 & 255;
    s += ALPHABET[b % ALPHABET.length];
  }
  return s;
}
function makePrefixedId(prefix, rand = Math.random, len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return prefix + s;
}
function makeUniquePrefixedId(prefix, existing, rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makePrefixedId(prefix, rand);
    if (!existing.has(id)) return id;
  }
  return makePrefixedId(prefix, rand, 10);
}
function makeConceptId(rand = Math.random, len = 6) {
  return makePrefixedId(CONCEPT_ID_PREFIX, rand, len);
}
function makeUniqueConceptId(existing, rand = Math.random) {
  return makeUniquePrefixedId(CONCEPT_ID_PREFIX, existing, rand);
}
function makeUniqueRoleId(existing, rand = Math.random) {
  return makeUniquePrefixedId(ROLE_ID_PREFIX, existing, rand);
}
function deterministicRoleIdFromName(name, existing = /* @__PURE__ */ new Set()) {
  const key = name.trim();
  const digest = deterministicDigest(`tent.role.id.v1:${key}`, 32);
  for (let len = 6; len <= 16; len++) {
    const id = ROLE_ID_PREFIX + encodeAlphabetBytes(digest, len);
    if (!existing.has(id)) return id;
  }
  const fallback = deterministicDigest(
    `tent.role.id.v1.fallback:${key}:${[...existing].sort().join(",")}`,
    32
  );
  return ROLE_ID_PREFIX + encodeAlphabetBytes(fallback, 12);
}
function isRoleId(id) {
  return id.startsWith(ROLE_ID_PREFIX) && id.length > ROLE_ID_PREFIX.length;
}
function isLegacyBoxId(id) {
  return id.startsWith(LEGACY_BOX_ID_PREFIX) && id.length > LEGACY_BOX_ID_PREFIX.length;
}
var ALPHABET, CONCEPT_ID_PREFIX, ROLE_ID_PREFIX, LEGACY_BOX_ID_PREFIX;
var init_id = __esm({
  "src/core/id.ts"() {
    "use strict";
    ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
    CONCEPT_ID_PREFIX = "cx-";
    ROLE_ID_PREFIX = "rl-";
    LEGACY_BOX_ID_PREFIX = "bx-";
  }
});

// src/core/task-model.ts
function isTaskActorKind(value) {
  return value === "user" || value === "role";
}
function parseTaskActorRef(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} must be an object { kind, id }.`
    );
  }
  const raw = value;
  const kind = raw.kind;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!isTaskActorKind(kind)) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label}.kind must be user|role; got ${String(kind)}.`
    );
  }
  if (!id) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label}.id must be a non-empty string.`
    );
  }
  if (kind === "user" && id !== "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} with kind=user requires id "user"; got ${id}.`
    );
  }
  if (kind === "role" && id === "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task ${label} with kind=role must name a durable role (not user).`
    );
  }
  return { kind, id };
}
function assertParentReviewerEqual(parentActor, reviewer) {
  if (parentActor.kind !== reviewer.kind || parentActor.id !== reviewer.id) {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      `Task reviewer must equal parentActor (no arbitrary delegation); got parentActor=${parentActor.kind}:${parentActor.id} reviewer=${reviewer.kind}:${reviewer.id}.`
    );
  }
}
function resolveParentReviewerPair(input) {
  const parentActor = parseTaskActorRef(input.parentActor, "parentActor");
  const reviewer = input.reviewer ? parseTaskActorRef(input.reviewer, "reviewer") : { ...parentActor };
  assertParentReviewerEqual(parentActor, reviewer);
  return { parentActor, reviewer };
}
function userTaskActors() {
  const parentActor = { kind: "user", id: "user" };
  return { parentActor, reviewer: { ...parentActor } };
}
function roleTaskActors(roleName) {
  const id = roleName.trim();
  if (!id || id === "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      "Role parent/reviewer requires a durable role name (not user)."
    );
  }
  const parentActor = { kind: "role", id };
  return { parentActor, reviewer: { ...parentActor } };
}
function migrateParentReviewerFromLegacy(input) {
  const dispatcher = (input.dispatchedBy || "").trim();
  if (dispatcher && dispatcher !== "user") {
    return roleTaskActors(dispatcher);
  }
  return userTaskActors();
}
function mayElevateDeliveryPolicy(input) {
  const parent = input.parentActor;
  if (!parent || parent.kind !== "user") return false;
  return (input.assigneeKind ?? "role") === "role";
}
function isDeliveryPolicy(value) {
  return value === "review" || value === "bypass" || value === "agent-decide";
}
function normalizeDeliveryPolicyRead(value) {
  if (value === "manual") return "review";
  if (isDeliveryPolicy(value)) return value;
  return void 0;
}
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
function isTaskId(id) {
  return id.startsWith("tk-") && id.length > 3;
}
function isDeliveryId(id) {
  return id.startsWith("dl-") && id.length > 3;
}
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
var DEFAULT_DELIVERY_POLICY, TaskLifecycleError, ACTIVE_TASK_STATES;
var init_task_model = __esm({
  "src/core/task-model.ts"() {
    "use strict";
    init_id();
    DEFAULT_DELIVERY_POLICY = "review";
    TaskLifecycleError = class extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "TaskLifecycleError";
      }
    };
    ACTIVE_TASK_STATES = /* @__PURE__ */ new Set([
      "queued",
      "running",
      "waiting",
      "delivered"
    ]);
  }
});

// src/core/task.ts
var task_exports = {};
__export(task_exports, {
  ackTaskEnvelope: () => ackTaskEnvelope,
  cancelTaskEnvelope: () => cancelTaskEnvelope,
  ensureRoleInit: () => ensureRoleInit,
  extractTaskUserPrompt: () => extractTaskUserPrompt,
  loadTaskEnvelope: () => loadTaskEnvelope,
  loadTaskEnvelopes: () => loadTaskEnvelopes,
  migrateParentReviewerEnvelopes: () => migrateParentReviewerEnvelopes,
  patchTaskEnvelope: () => patchTaskEnvelope,
  primaryBoxId: () => primaryBoxId,
  relayPromptForTask: () => relayPromptForTask,
  resolveDispatchActors: () => resolveDispatchActors,
  resolveTaskPromptRoots: () => resolveTaskPromptRoots,
  serializeTaskActorRef: () => serializeTaskActorRef,
  sessionBootstrapPromptForTask: () => sessionBootstrapPromptForTask,
  taskAsSub: () => taskAsSub,
  taskAssigneeKind: () => taskAssigneeKind,
  taskParentIsRole: () => taskParentIsRole,
  taskParentRoleId: () => taskParentRoleId,
  workspaceLaneOf: () => workspaceLaneOf,
  writeTaskEnvelope: () => writeTaskEnvelope
});
async function loadTaskEnvelopes(fs10) {
  const tasks = [];
  if (!await fs10.exists(TEMP_DIR)) return tasks;
  for (const entry2 of await fs10.listDir(TEMP_DIR)) {
    if (!entry2.isDir) continue;
    if (entry2.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join3(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs10.exists(profilesRoot)) continue;
      for (const profileEntry of await fs10.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectTaskFiles(fs10, join3(profilesRoot, profileEntry.name, "tasks"), tasks);
      }
      continue;
    }
    await collectTaskFiles(fs10, join3(TEMP_DIR, entry2.name, "tasks"), tasks);
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function migrateParentReviewerEnvelopes(fs10, clock, options) {
  const dryRun = options?.dryRun === true;
  const report = {
    scanned: 0,
    rewritten: [],
    skipped: [],
    warnings: []
  };
  if (!await fs10.exists(TEMP_DIR)) return report;
  const paths = [];
  for (const entry2 of await fs10.listDir(TEMP_DIR)) {
    if (!entry2.isDir) continue;
    if (entry2.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join3(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs10.exists(profilesRoot)) continue;
      for (const profileEntry of await fs10.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        const taskDir2 = join3(profilesRoot, profileEntry.name, "tasks");
        if (!await fs10.exists(taskDir2)) continue;
        for (const f of await fs10.listDir(taskDir2)) {
          if (!f.isDir && f.name.endsWith(".md")) paths.push(join3(taskDir2, f.name));
        }
      }
      continue;
    }
    const taskDir = join3(TEMP_DIR, entry2.name, "tasks");
    if (!await fs10.exists(taskDir)) continue;
    for (const f of await fs10.listDir(taskDir)) {
      if (!f.isDir && f.name.endsWith(".md")) paths.push(join3(taskDir, f.name));
    }
  }
  for (const path9 of paths.sort((a, b) => a.localeCompare(b))) {
    report.scanned += 1;
    try {
      const raw = await fs10.readFile(path9);
      const { data, body, keyOrder } = parseFrontmatter(raw);
      if (data.type !== "task") {
        report.skipped.push(path9);
        continue;
      }
      const hasParent = data.parentActor !== void 0 && data.parentActor !== null;
      const hasReviewer = data.reviewer !== void 0 && data.reviewer !== null;
      const hasLegacyDispatcher = typeof data.dispatchedBy === "string" && data.dispatchedBy.trim() !== "";
      if (hasParent && hasReviewer && !hasLegacyDispatcher) {
        try {
          resolveParentReviewerPair({
            parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
            reviewer: parseTaskActorRef(data.reviewer, "reviewer")
          });
          report.skipped.push(path9);
        } catch (err) {
          report.warnings.push(
            `${path9}: ${err instanceof Error ? err.message : String(err)}`
          );
          report.skipped.push(path9);
        }
        continue;
      }
      let parentActor;
      let reviewer;
      if (hasParent && hasReviewer) {
        const pair = resolveParentReviewerPair({
          parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
          reviewer: parseTaskActorRef(data.reviewer, "reviewer")
        });
        parentActor = pair.parentActor;
        reviewer = pair.reviewer;
      } else if (hasParent || hasReviewer) {
        report.warnings.push(
          `${path9}: partial parentActor/reviewer pair; refusing silent repair`
        );
        report.skipped.push(path9);
        continue;
      } else {
        const migrated = migrateParentReviewerFromLegacy({
          asSub: data.asSub === true,
          dispatchedBy: typeof data.dispatchedBy === "string" ? data.dispatchedBy : void 0
        });
        parentActor = migrated.parentActor;
        reviewer = migrated.reviewer;
      }
      const next = { ...data };
      next.parentActor = serializeTaskActorRef(parentActor);
      next.reviewer = serializeTaskActorRef(reviewer);
      delete next.dispatchedBy;
      const nextRaw = serializeFrontmatter(next, body, keyOrder);
      if (nextRaw === raw) {
        report.skipped.push(path9);
        continue;
      }
      if (!dryRun) {
        next.updatedAt = clock.now();
        await fs10.writeFile(path9, serializeFrontmatter(next, body, keyOrder));
      }
      report.rewritten.push(path9);
    } catch (err) {
      report.warnings.push(
        `${path9}: ${err instanceof Error ? err.message : String(err)}`
      );
      report.skipped.push(path9);
    }
  }
  return report;
}
async function collectTaskFiles(fs10, taskDir, tasks) {
  if (!await fs10.exists(taskDir)) return;
  for (const entry2 of await fs10.listDir(taskDir)) {
    if (entry2.isDir || !entry2.name.endsWith(".md")) continue;
    const path9 = join3(taskDir, entry2.name);
    try {
      tasks.push(await loadTaskEnvelope(fs10, path9));
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
function taskParentIsRole(task) {
  return task.parentActor?.kind === "role";
}
function taskParentRoleId(task) {
  return task.parentActor?.kind === "role" ? task.parentActor.id : void 0;
}
function serializeTaskActorRef(actor) {
  return { kind: actor.kind, id: actor.id };
}
function resolveDispatchActors(input) {
  if (!input.parentActor) {
    throw new Error(
      "task.dispatch requires explicit parentActor { kind, id } (legacy dispatchedBy is migration-only)."
    );
  }
  return resolveParentReviewerPair({
    parentActor: input.parentActor,
    reviewer: input.reviewer
  });
}
async function loadTaskEnvelope(fs10, path9) {
  if (!await fs10.exists(path9)) throw new Error(`Task envelope not found: ${path9}.`);
  const { data, body } = parseFrontmatter(await fs10.readFile(path9));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string") {
    throw new Error(`Invalid task envelope format: ${path9}.`);
  }
  const legacyStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);
  const actors = resolveActorsFromDisk(data);
  const contextCard = loadTaskContextCardFromFrontmatter(data) ?? void 0;
  const hasClaimsKey = Array.isArray(data.claims) && data.claims.every((claim) => typeof claim === "string");
  if (!contextCard && !hasClaimsKey) {
    throw new Error(
      `Invalid task envelope format: ${path9} (missing Task.contextCard.refs.nodes; run claims\u2192refs migration).`
    );
  }
  const task = {
    path: path9,
    role: data.role,
    manifest: data.manifest,
    status: stateToLegacyStatus(state),
    state,
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    prompt: body.trim() || void 0
  };
  if (typeof data.id === "string" && isTaskId(data.id)) task.id = data.id;
  if (data.asSub === true) task.asSub = true;
  if (typeof data.workspace === "string") task.workspace = data.workspace;
  if (typeof data.worktree === "string") task.worktree = data.worktree;
  if (typeof data.branch === "string") task.branch = data.branch;
  if (typeof data.targetBranch === "string") task.targetBranch = data.targetBranch;
  if (typeof data.roleBranchBase === "string" && data.roleBranchBase.trim()) {
    task.roleBranchBase = data.roleBranchBase.trim();
  }
  if (typeof data.baseCommit === "string" && data.baseCommit.trim()) {
    task.baseCommit = data.baseCommit.trim();
  }
  if (data.integrationAuthority !== void 0 && data.integrationAuthority !== null && task.parentActor && task.reviewer) {
    task.integrationAuthority = assertIntegrationAuthorityMatchesParent(
      data.integrationAuthority,
      task.parentActor,
      task.reviewer
    );
  }
  if (contextCard) {
    task.contextCard = contextCard;
    task.contextGeneration = contextCard.contextGeneration;
    task.taskDeltaDigest = contextCard.taskDeltaDigest;
  } else if (typeof data.contextGeneration === "string" && data.contextGeneration.trim()) {
    task.contextGeneration = data.contextGeneration.trim();
  }
  if (!task.taskDeltaDigest && typeof data.taskDeltaDigest === "string" && data.taskDeltaDigest.trim()) {
    task.taskDeltaDigest = data.taskDeltaDigest.trim();
  }
  const deliveryPolicy = normalizeDeliveryPolicyRead(data.deliveryPolicy);
  if (deliveryPolicy) task.deliveryPolicy = deliveryPolicy;
  if (data.assigneeKind === "role" || data.assigneeKind === "agentProfile") {
    task.assigneeKind = data.assigneeKind;
  }
  if (typeof data.agentId === "string" && data.agentId.trim()) {
    task.agentId = data.agentId.trim();
  }
  if (typeof data.sessionId === "string") task.sessionId = data.sessionId;
  if (typeof data.activeDeliveryId === "string") task.activeDeliveryId = data.activeDeliveryId;
  if (data.lastOutcome === "delivered" || data.lastOutcome === "blocked" || data.lastOutcome === "needs-input") {
    task.lastOutcome = data.lastOutcome;
  }
  if (typeof data.createdAt === "string") task.createdAt = data.createdAt;
  if (typeof data.updatedAt === "string") task.updatedAt = data.updatedAt;
  const wait = parseWaitFields(data);
  if (wait) task.wait = wait;
  return task;
}
function resolveActorsFromDisk(data) {
  const hasParent = data.parentActor !== void 0 && data.parentActor !== null;
  const hasReviewer = data.reviewer !== void 0 && data.reviewer !== null;
  if (hasParent || hasReviewer) {
    if (!hasParent || !hasReviewer) {
      throw new Error(
        "Invalid task envelope: parentActor and reviewer must both be present when either is set."
      );
    }
    return resolveParentReviewerPair({
      parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
      reviewer: parseTaskActorRef(data.reviewer, "reviewer")
    });
  }
  const hasLegacy = typeof data.dispatchedBy === "string" && data.dispatchedBy.trim() !== "";
  throw new Error(
    hasLegacy ? "Invalid task envelope: legacy dispatchedBy present without parentActor/reviewer; run workspace.mount migration (migrateParentReviewerEnvelopes) before load." : "Invalid task envelope: missing parentActor/reviewer."
  );
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
function formatTaskPointers(task) {
  const kind = taskAssigneeKind(task);
  const lines = [
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`
  ];
  if (task.contextCard) {
    const nodeIds = taskReferencedNodeIds(task);
    if (nodeIds.length) {
      lines.push(`contextCard.refs.nodes: ${nodeIds.join(", ")}`);
    } else {
      lines.push(`workspace context: true (no direct Node refs)`);
    }
  }
  if (task.parentActor) {
    lines.push(
      `parentActor: ${task.parentActor.kind}:${task.parentActor.id}`
    );
  }
  if (task.reviewer) {
    lines.push(`reviewer: ${task.reviewer.kind}:${task.reviewer.id}`);
  }
  if (task.deliveryPolicy) {
    lines.push(`deliveryPolicy: ${task.deliveryPolicy}`);
  }
  if (kind === "role") {
    const initCli = join3("temp", task.role, "init.md");
    const initFile = join3(".tent", "temp", task.role, "init.md");
    lines.push(`role: ${task.role}`);
    lines.push(`Role init file: ${initFile} (CLI path remains ${initCli}).`);
  } else {
    lines.push(`assigneeKind: agentProfile`);
    lines.push(`profileId: ${task.role}`);
    lines.push(
      `Assignee: agentProfile ${task.role} (one-shot; no durable role init / tent-role lane).`
    );
  }
  return lines.join("\n");
}
function formatExternalPathBlock(task, roots) {
  const taskFile = join3(".tent", task.path);
  const systemRoot = roots.systemRoot.replace(/[\\/]+$/, "");
  return [
    `workspaceRoot: ${roots.workspaceRoot}`,
    `systemRoot: ${roots.systemRoot}`,
    `CLI: run tent from workspaceRoot; taskPath is relative to systemRoot (.tent), e.g. ${task.path}.`,
    `File reads: use ${taskFile} (workspace-relative) or ${systemRoot}/${task.path} \u2014 never <workspaceRoot>/temp.`
  ].join("\n");
}
function relayPromptForTask(task, roots) {
  const resolved = resolveTaskPromptRoots(roots);
  const kind = taskAssigneeKind(task);
  const assigneeLine = kind === "agentProfile" ? `A Tent task has been dispatched to agentProfile ${task.role}.
` : `A Tent task has been dispatched to role ${task.role}.
`;
  const initStep = kind === "agentProfile" ? `4. Read the task envelope and task-scoped manifest pointers above; do not look for a role init file.` : `4. If this is a new session for this role, complete role init first (read the init file above).`;
  return assigneeLine + `${formatExternalPathBlock(task, resolved)}
${formatTaskPointers(task)}
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
function sessionBootstrapPromptForTask(task, _roots) {
  const userPrompt = extractTaskUserPrompt(task);
  const kind = taskAssigneeKind(task);
  const readyLine = kind === "agentProfile" ? `A Tent managed ACP session is ready for agentProfile ${task.role}.
` : `A Tent managed ACP session is ready for role ${task.role}.
`;
  return readyLine + `${formatTaskPointers(task)}
Service status: this task is already claimed (state=${task.state || "running"}).
Managed path: Local Service already claimed this task; end with an explicit outcome wire (\`outcome: delivered|blocked|needs-input\`) then the report body. Only \`delivered\` may become a ready Delivery after turn settle; blocker/question must use needs-input/blocked or ask-user \u2014 never self-accept.
` + (kind === "agentProfile" ? `One-shot agentProfile task: rely on task/manifest pointers only \u2014 no role init.
` : "") + (userPrompt ? `
## User Prompt

${userPrompt}
` : `
## User Prompt

(no user prompt on envelope)
`);
}
async function ensureRoleInit(fs10, role, tentName) {
  const path9 = join3("temp", role.name, "init.md");
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
  await fs10.writeFile(path9, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path9;
}
async function writeTaskEnvelope(fs10, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const assigneeKind = input.assigneeKind ?? "role";
  const dir = input.tasksDir?.trim() || (assigneeKind === "agentProfile" ? agentProfileTasksDir(input.role) : join3(TEMP_DIR, input.role, "tasks"));
  await ensureDir(fs10, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const isRootToken = (id2) => id2.trim() === "root";
  const workspaceOnly = input.claims.length > 0 && input.claims.every((c) => isRootToken(c.id));
  const nodeRefs = input.claims.filter((c) => !isRootToken(c.id)).map((c) => normalizeContextCardNodeRef({ id: c.id, path: c.path }));
  const primaryRef = nodeRefs[0]?.id || (workspaceOnly ? "root" : "node");
  const stem = taskStem(clock.now(), primaryRef);
  const path9 = await uniqueMarkdownPath(fs10, dir, stem);
  const now = clock.now();
  const actors = resolveDispatchActors({
    parentActor: input.parentActor,
    reviewer: input.reviewer
  });
  const deliveryPolicy = input.deliveryPolicy ?? DEFAULT_DELIVERY_POLICY;
  if (deliveryPolicy !== "review" && !mayElevateDeliveryPolicy({
    parentActor: actors.parentActor,
    assigneeKind
  })) {
    throw new Error(
      `deliveryPolicy=${deliveryPolicy} is only legal for a durable Role's user-facing delivery; downstream Task Agent \u2192 parent must use review (parent=${actors.parentActor.kind}:${actors.parentActor.id}).`
    );
  }
  const objective = (input.objective?.trim() || userPrompt).trim();
  if (!objective) throw new Error("Dispatch requires a non-empty objective (user prompt).");
  const acceptance = input.acceptance && input.acceptance.length > 0 ? input.acceptance.map((s) => s.trim()).filter(Boolean) : [objective];
  if (acceptance.length === 0) {
    throw new Error("Dispatch requires non-empty acceptance (or objective).");
  }
  const contextGeneration = input.contextGeneration?.trim() || computeContextGeneration({
    workspaceIdentity: input.workspace?.workspace || "local-workspace",
    rulesPointerDigest: "dispatch-default-rules",
    agentsPointerDigest: "dispatch-default-agents",
    extraStable: {
      assigneeKind,
      assignee: input.role,
      taskId: id
    }
  });
  const assignee = projectAssigneeFromTask({
    role: input.role,
    assigneeKind,
    agentId: input.agentId
  });
  const contextCard = buildTaskContextCard({
    objective,
    acceptance,
    refs: {
      nodes: nodeRefs,
      tasks: [],
      deliveries: [],
      git: []
    },
    parentActor: actors.parentActor,
    reviewer: actors.reviewer,
    assignee,
    contextGeneration,
    userPrompt
  });
  const data = {
    type: "task",
    id,
    status: "pending",
    state: "queued",
    role: input.role,
    assigneeKind,
    parentActor: serializeTaskActorRef(actors.parentActor),
    reviewer: serializeTaskActorRef(actors.reviewer),
    // Sole new persisted source wire — do not write claims[].
    contextCard: serializeTaskContextCardForFrontmatter(contextCard),
    contextGeneration: contextCard.contextGeneration,
    taskDeltaDigest: contextCard.taskDeltaDigest,
    manifest: input.manifestPath,
    deliveryPolicy,
    createdAt: now,
    updatedAt: now
  };
  if (input.asSub === true) data.asSub = true;
  if (input.agentId?.trim()) data.agentId = input.agentId.trim();
  if (input.sessionId) data.sessionId = input.sessionId;
  if (input.workspace) {
    data.workspace = input.workspace.workspace;
    data.worktree = input.workspace.worktree;
    data.branch = input.workspace.branch;
    data.targetBranch = input.workspace.targetBranch;
  }
  const pointers = [
    ...workspaceOnly || nodeRefs.length === 0 ? [`- workspace: ./ (stable workspace context; not a Node ref)`] : [],
    ...nodeRefs.map((claim) => `- ${claim.id}: ${claim.path || "(path hint pending)"}`)
  ].join("\n");
  const body = `# Task

## Context Pointers

${pointers || "(none)"}

- Manifest: ${input.manifestPath}
` + (input.id || id ? `- Task id: ${id}
` : "") + `
## User Prompt

${userPrompt}
`;
  await fs10.writeFile(path9, serializeFrontmatter(data, body));
  return path9;
}
async function ackTaskEnvelope(fs10, path9) {
  await patchTaskEnvelope(fs10, path9, {
    status: "taken",
    state: "running"
  });
}
async function cancelTaskEnvelope(fs10, path9) {
  const task = await loadTaskEnvelope(fs10, path9);
  if (task.state !== "queued" && task.status !== "pending") {
    throw new Error("Only queued (pending) task envelopes can be cancelled.");
  }
  await fs10.remove(path9);
}
async function patchTaskEnvelope(fs10, path9, patch) {
  if (!await fs10.exists(path9)) throw new Error(`Task envelope not found: ${path9}.`);
  const raw = await fs10.readFile(path9);
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
    delete data.waitCode;
  } else if (patch.wait) {
    data.waitReason = patch.wait.reason;
    data.waitSummary = patch.wait.summary;
    const code = patch.wait.code?.trim();
    if (code) data.waitCode = code;
    else delete data.waitCode;
  }
  if (patch.activeDeliveryId === null) delete data.activeDeliveryId;
  else if (typeof patch.activeDeliveryId === "string") data.activeDeliveryId = patch.activeDeliveryId;
  if (patch.deliveryPolicy) data.deliveryPolicy = patch.deliveryPolicy;
  if (patch.parentActor || patch.reviewer) {
    const nextParent = patch.parentActor ? parseTaskActorRef(patch.parentActor, "parentActor") : data.parentActor !== void 0 && data.parentActor !== null ? parseTaskActorRef(data.parentActor, "parentActor") : void 0;
    if (!nextParent) {
      throw new Error(
        "patchTaskEnvelope parentActor/reviewer requires an existing or explicit parentActor."
      );
    }
    const nextReviewer = patch.reviewer ? parseTaskActorRef(patch.reviewer, "reviewer") : patch.parentActor ? void 0 : data.reviewer !== void 0 && data.reviewer !== null ? parseTaskActorRef(data.reviewer, "reviewer") : void 0;
    const pair = resolveParentReviewerPair({
      parentActor: nextParent,
      reviewer: nextReviewer
    });
    data.parentActor = serializeTaskActorRef(pair.parentActor);
    data.reviewer = serializeTaskActorRef(pair.reviewer);
    const derived = deriveIntegrationAuthority({
      parentActor: pair.parentActor,
      reviewer: pair.reviewer
    });
    data.integrationAuthority = {
      actor: { kind: derived.actor.kind, id: derived.actor.id },
      mutator: "service"
    };
  }
  if (patch.clearLegacyDispatchedBy) {
    delete data.dispatchedBy;
  }
  if (patch.lastOutcome === null) delete data.lastOutcome;
  else if (patch.lastOutcome === "delivered" || patch.lastOutcome === "blocked" || patch.lastOutcome === "needs-input") {
    data.lastOutcome = patch.lastOutcome;
  }
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
  if (patch.baseCommit === null) delete data.baseCommit;
  else if (typeof patch.baseCommit === "string" && patch.baseCommit.trim()) {
    data.baseCommit = patch.baseCommit.trim();
  }
  if (patch.integrationAuthority === null) delete data.integrationAuthority;
  else if (patch.integrationAuthority) {
    if (data.parentActor === void 0 || data.parentActor === null) {
      throw new Error(
        "patchTaskEnvelope integrationAuthority requires parentActor/reviewer on the envelope."
      );
    }
    const parentForAuth = parseTaskActorRef(data.parentActor, "parentActor");
    const reviewerForAuth = data.reviewer !== void 0 && data.reviewer !== null ? parseTaskActorRef(data.reviewer, "reviewer") : parentForAuth;
    const validated = assertIntegrationAuthorityMatchesParent(
      patch.integrationAuthority,
      parentForAuth,
      reviewerForAuth
    );
    data.integrationAuthority = {
      actor: { kind: validated.actor.kind, id: validated.actor.id },
      mutator: "service"
    };
  }
  if (patch.contextCard === null) {
    delete data.contextCard;
    delete data.contextGeneration;
    delete data.taskDeltaDigest;
  } else if (patch.contextCard) {
    data.contextCard = serializeTaskContextCardForFrontmatter(patch.contextCard);
    data.contextGeneration = patch.contextCard.contextGeneration;
    data.taskDeltaDigest = patch.contextCard.taskDeltaDigest;
  }
  if (patch.contextGeneration === null) delete data.contextGeneration;
  else if (typeof patch.contextGeneration === "string" && patch.contextGeneration.trim()) {
    data.contextGeneration = patch.contextGeneration.trim();
  }
  if (patch.taskDeltaDigest === null) delete data.taskDeltaDigest;
  else if (typeof patch.taskDeltaDigest === "string" && patch.taskDeltaDigest.trim()) {
    data.taskDeltaDigest = patch.taskDeltaDigest.trim();
  }
  await fs10.writeFile(path9, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs10, path9);
}
function workspaceLaneOf(task) {
  if (!task.workspace && !task.worktree && !task.branch && !task.targetBranch && !task.baseCommit && !task.integrationAuthority) {
    return void 0;
  }
  const integrationAuthority = task.integrationAuthority ? task.integrationAuthority : task.parentActor && task.reviewer ? deriveIntegrationAuthority({
    parentActor: task.parentActor,
    reviewer: task.reviewer
  }) : void 0;
  return {
    workspace: task.workspace,
    worktree: task.worktree,
    branch: task.branch,
    targetBranch: task.targetBranch,
    ...task.baseCommit ? { baseCommit: task.baseCommit } : {},
    ...integrationAuthority ? { integrationAuthority } : {}
  };
}
function primaryBoxId(task) {
  if (task.contextCard == null) return void 0;
  return taskReferencedNodeIds(task)[0];
}
function parseTaskState(value, legacy) {
  if (value === "queued" || value === "running" || value === "waiting" || value === "delivered" || value === "accepted" || value === "rejected" || value === "interrupted" || value === "failed") {
    return value;
  }
  return legacyStatusToState(legacy);
}
function parseWaitFields(data) {
  const reason = data.waitReason;
  const summary = data.waitSummary;
  if ((reason === "user-input" || reason === "a2a-approval" || reason === "review" || reason === "external") && typeof summary === "string") {
    const code = typeof data.waitCode === "string" && data.waitCode.trim() ? data.waitCode.trim() : void 0;
    return { reason, summary, ...code ? { code } : {} };
  }
  return void 0;
}
function taskStem(now, claimId) {
  const stamp = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs10, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path9 = join3(dir, `${stem}${suffix}.md`);
    if (!await fs10.exists(path9)) return path9;
  }
}
async function ensureDir(fs10, path9) {
  if (!await fs10.exists(path9)) await fs10.mkdir(path9);
}
var init_task = __esm({
  "src/core/task.ts"() {
    "use strict";
    init_frontmatter();
    init_paths();
    init_tree();
    init_task_model();
    init_task_context_card();
    init_task_node_refs();
  }
});

// src/core/task-context-card.ts
import { createHash } from "node:crypto";
function canonicalJson(value) {
  return JSON.stringify(sortForCanonical(value));
}
function sortForCanonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortForCanonical);
  const obj = value;
  const out = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    const v = obj[key];
    if (v === void 0) continue;
    out[key] = sortForCanonical(v);
  }
  return out;
}
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function formatContextGeneration(stableCanonicalBytes) {
  return `cg-${CONTEXT_GENERATION_VERSION}-${sha256Hex(stableCanonicalBytes)}`;
}
function isContextGenerationId(value) {
  return typeof value === "string" && /^cg-v1-[a-f0-9]{64}$/.test(value);
}
function computeContextGeneration(inputs) {
  const roster = [...inputs.rosterAgentIds ?? []].map((s) => s.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const payload = {
    v: CONTEXT_GENERATION_VERSION,
    workspaceIdentity: inputs.workspaceIdentity.trim(),
    rulesPointerDigest: inputs.rulesPointerDigest.trim(),
    agentsPointerDigest: inputs.agentsPointerDigest.trim(),
    tentRoleDigest: inputs.tentRoleDigest?.trim() || "",
    rolePrompt: inputs.rolePrompt?.trim() || "",
    roster,
    tentTaskDigest: inputs.tentTaskDigest?.trim() || "",
    profileAdapterCompatibility: inputs.profileAdapterCompatibility?.trim() || "",
    extraStable: inputs.extraStable ?? {}
  };
  return formatContextGeneration(canonicalJson(payload));
}
function computeTaskDeltaDigest(inputs) {
  const { card, taskInputDelta, checkpoint, userPrompt } = inputs;
  const payload = {
    v: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    objective: card.objective,
    frozenDecisions: card.frozenDecisions,
    scope: card.scope,
    acceptance: card.acceptance,
    refs: card.refs,
    parentActor: card.parentActor,
    reviewer: card.reviewer,
    assignee: card.assignee,
    taskInputDelta: taskInputDelta?.trim() || "",
    checkpoint: checkpoint?.trim() || "",
    userPrompt: userPrompt?.trim() || ""
  };
  return sha256Hex(canonicalJson(payload));
}
function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((s) => s.trim()).filter(Boolean);
}
function parseActorRef(value, label) {
  if (value === void 0 || value === null) {
    throw new TaskContextCardError(
      label === "parentActor" ? "MISSING_PARENT_ACTOR" : "MISSING_REVIEWER",
      `Context Card requires ${label} { kind, id } (canonical TaskActorRef).`,
      { label, value }
    );
  }
  try {
    return parseTaskActorRef(value, label);
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      const code = err.code === "INVALID_ACTOR" ? "INVALID_ACTOR" : label === "parentActor" ? "MISSING_PARENT_ACTOR" : "MISSING_REVIEWER";
      throw new TaskContextCardError(code, err.message, { label, value });
    }
    throw err;
  }
}
function parseAssignee(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskContextCardError(
      "MISSING_ASSIGNEE",
      "Context Card requires assignee { kind: role|agentId, id }."
    );
  }
  const raw = value;
  const kind = raw.kind;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (kind !== "role" && kind !== "agentId" || !id) {
    throw new TaskContextCardError(
      "MISSING_ASSIGNEE",
      "Context Card assignee must be { kind: role|agentId, id: non-empty }."
    );
  }
  return { kind, id };
}
function parseRefList(value, bucket) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TaskContextCardError(
      "INVALID_CARD",
      `Context Card refs.${bucket} must be an array of durable pointers.`,
      { bucket, value }
    );
  }
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") {
      const id2 = item.trim();
      if (!id2) {
        throw new TaskContextCardError(
          "UNRESOLVED_REF",
          `Context Card refs.${bucket}[${i}] id is empty.`,
          { bucket, index: i }
        );
      }
      out.push({ id: id2 });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TaskContextCardError(
        "UNRESOLVED_REF",
        `Context Card refs.${bucket}[${i}] is not a durable pointer.`,
        { bucket, index: i, value: item }
      );
    }
    const raw = item;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      throw new TaskContextCardError(
        "UNRESOLVED_REF",
        `Context Card refs.${bucket}[${i}] missing id.`,
        { bucket, index: i }
      );
    }
    const ref = { id };
    if (typeof raw.path === "string" && raw.path.trim()) ref.path = raw.path.trim();
    if (typeof raw.revision === "string" && raw.revision.trim()) {
      ref.revision = raw.revision.trim();
    }
    out.push(ref);
  }
  return out;
}
function buildTaskContextCard(input) {
  const objective = input.objective?.trim() || "";
  if (!objective) {
    throw new TaskContextCardError(
      "MISSING_OBJECTIVE",
      "Context Card requires objective (fail-loud to parent; do not invent from chat memory)."
    );
  }
  const acceptance = asStringList([...input.acceptance ?? []]);
  if (acceptance.length === 0) {
    throw new TaskContextCardError(
      "MISSING_ACCEPTANCE",
      "Context Card requires at least one acceptance criterion (fail-loud to parent)."
    );
  }
  const parentActor = parseActorRef(input.parentActor, "parentActor");
  const reviewer = parseActorRef(input.reviewer, "reviewer");
  try {
    assertParentReviewerEqual(parentActor, reviewer);
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, {
        parentActor,
        reviewer
      });
    }
    throw err;
  }
  const assignee = parseAssignee(input.assignee);
  if (!isContextGenerationId(input.contextGeneration)) {
    throw new TaskContextCardError(
      "INVALID_GENERATION",
      `contextGeneration must match cg-v1-<sha256>; got ${String(input.contextGeneration)}`
    );
  }
  const cardBody = {
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    objective,
    frozenDecisions: asStringList([...input.frozenDecisions ?? []]),
    scope: {
      include: asStringList([...input.scope?.include ?? []]),
      exclude: asStringList([...input.scope?.exclude ?? []])
    },
    acceptance,
    refs: {
      nodes: parseRefList(input.refs?.nodes ?? [], "nodes"),
      tasks: parseRefList(input.refs?.tasks ?? [], "tasks"),
      deliveries: parseRefList(input.refs?.deliveries ?? [], "deliveries"),
      git: parseRefList(input.refs?.git ?? [], "git")
    },
    parentActor,
    reviewer,
    assignee
  };
  const taskDeltaDigest = input.taskDeltaDigest?.trim() || computeTaskDeltaDigest({
    card: cardBody,
    taskInputDelta: input.taskInputDelta,
    checkpoint: input.checkpoint,
    userPrompt: input.userPrompt
  });
  return {
    ...cardBody,
    contextGeneration: input.contextGeneration,
    taskDeltaDigest
  };
}
function parseTaskContextCard(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TaskContextCardError(
      "INVALID_CARD",
      "Context Card payload must be a plain object."
    );
  }
  const raw = data;
  const scopeRaw = raw.scope && typeof raw.scope === "object" && !Array.isArray(raw.scope) ? raw.scope : {};
  const refsRaw = raw.refs && typeof raw.refs === "object" && !Array.isArray(raw.refs) ? raw.refs : {};
  return buildTaskContextCard({
    objective: typeof raw.objective === "string" ? raw.objective : "",
    frozenDecisions: asStringList(raw.frozenDecisions),
    scope: {
      include: asStringList(scopeRaw.include ?? raw.scopeInclude),
      exclude: asStringList(scopeRaw.exclude ?? raw.scopeExclude)
    },
    acceptance: asStringList(raw.acceptance),
    refs: {
      nodes: parseRefList(refsRaw.nodes ?? raw.refsNodes, "nodes"),
      tasks: parseRefList(refsRaw.tasks ?? raw.refsTasks, "tasks"),
      deliveries: parseRefList(refsRaw.deliveries ?? raw.refsDeliveries, "deliveries"),
      git: parseRefList(refsRaw.git ?? raw.refsGit, "git")
    },
    parentActor: raw.parentActor,
    reviewer: raw.reviewer,
    assignee: raw.assignee,
    contextGeneration: typeof raw.contextGeneration === "string" ? raw.contextGeneration : "",
    taskDeltaDigest: typeof raw.taskDeltaDigest === "string" ? raw.taskDeltaDigest : void 0
  });
}
function hasTaskContextCardBodyFields(data) {
  const keys = [
    "objective",
    "frozenDecisions",
    "acceptance",
    "scope",
    "scopeInclude",
    "scopeExclude",
    "refs",
    "refsNodes",
    "refsTasks",
    "refsDeliveries",
    "refsGit",
    "assignee",
    "contextCard"
  ];
  return keys.some((k) => data[k] !== void 0 && data[k] !== null);
}
function loadTaskContextCardFromFrontmatter(data) {
  if (data.contextCard !== void 0 && data.contextCard !== null) {
    return parseTaskContextCard(data.contextCard);
  }
  if (!hasTaskContextCardBodyFields(data)) return null;
  return parseTaskContextCard(data);
}
function serializeTaskContextCardForFrontmatter(card) {
  return {
    schemaVersion: card.schemaVersion,
    objective: card.objective,
    frozenDecisions: [...card.frozenDecisions],
    scope: {
      include: [...card.scope.include],
      exclude: [...card.scope.exclude]
    },
    acceptance: [...card.acceptance],
    refs: {
      nodes: card.refs.nodes.map((r) => ({ ...r })),
      tasks: card.refs.tasks.map((r) => ({ ...r })),
      deliveries: card.refs.deliveries.map((r) => ({ ...r })),
      git: card.refs.git.map((r) => ({ ...r }))
    },
    parentActor: { kind: card.parentActor.kind, id: card.parentActor.id },
    reviewer: { kind: card.reviewer.kind, id: card.reviewer.id },
    assignee: { kind: card.assignee.kind, id: card.assignee.id },
    contextGeneration: card.contextGeneration,
    taskDeltaDigest: card.taskDeltaDigest
  };
}
function projectAssigneeFromTask(task) {
  const agentId = typeof task.agentId === "string" ? task.agentId.trim() : "";
  if (agentId) {
    return { kind: "agentId", id: agentId };
  }
  const kind = taskAssigneeKind(task);
  if (kind === "agentProfile") {
    return { kind: "agentId", id: task.role };
  }
  return { kind: "role", id: task.role };
}
function deriveIntegrationAuthority(input) {
  try {
    const pair = resolveParentReviewerPair({
      parentActor: input.parentActor,
      reviewer: input.reviewer
    });
    return {
      actor: { kind: pair.parentActor.kind, id: pair.parentActor.id },
      mutator: INTEGRATION_MUTATOR_SERVICE
    };
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, {
        parentActor: input.parentActor,
        reviewer: input.reviewer
      });
    }
    throw err;
  }
}
function assertIntegrationAuthorityMatchesParent(authority, parentActor, reviewer) {
  const derived = deriveIntegrationAuthority({ parentActor, reviewer });
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      "integrationAuthority must be { actor, mutator: service } derived from parent/reviewer.",
      { authority }
    );
  }
  const raw = authority;
  if (raw.mutator !== INTEGRATION_MUTATOR_SERVICE) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      `integrationAuthority.mutator must be "${INTEGRATION_MUTATOR_SERVICE}" (Service only); got ${String(raw.mutator)}.`,
      { authority }
    );
  }
  let actor;
  try {
    actor = parseTaskActorRef(raw.actor, "parentActor");
  } catch (err) {
    if (err instanceof TaskLifecycleError) {
      throw new TaskContextCardError("INVALID_ACTOR", err.message, { authority });
    }
    throw err;
  }
  if (actor.kind !== derived.actor.kind || actor.id !== derived.actor.id) {
    throw new TaskContextCardError(
      "INVALID_ACTOR",
      `integrationAuthority.actor must equal Task parent/reviewer (${derived.actor.kind}:${derived.actor.id}); got ${actor.kind}:${actor.id}.`,
      { authority, derived }
    );
  }
  return derived;
}
var TASK_CONTEXT_CARD_SCHEMA_VERSION, CONTEXT_GENERATION_VERSION, INTEGRATION_MUTATOR_SERVICE, TaskContextCardError;
var init_task_context_card = __esm({
  "src/core/task-context-card.ts"() {
    "use strict";
    init_task_model();
    init_task();
    TASK_CONTEXT_CARD_SCHEMA_VERSION = "v1";
    CONTEXT_GENERATION_VERSION = "v1";
    INTEGRATION_MUTATOR_SERVICE = "service";
    TaskContextCardError = class extends Error {
      constructor(code, message, details) {
        super(message);
        this.name = "TaskContextCardError";
        this.code = code;
        this.details = details;
      }
    };
  }
});

// src/core/task-node-refs.ts
function normalizeContextCardNodeRef(raw) {
  const id = raw.id.trim();
  if (!id) throw new Error("Task node ref id cannot be empty.");
  if (id === "root") {
    throw new Error(
      'Task.contextCard.refs.nodes must not include fake "root" Node ref; workspace context is separate.'
    );
  }
  const out = { id };
  if (typeof raw.path === "string" && raw.path.trim()) {
    out.path = raw.path.trim().replace(/\\/g, "/");
  }
  if (typeof raw.revision === "string" && raw.revision.trim()) {
    out.revision = raw.revision.trim();
  }
  return out;
}
function taskReferencedNodeIds(task) {
  const label = task.id || task.path || "(unknown)";
  if (task.contextCard == null) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label}`);
  }
  const nodes = task.contextCard.refs?.nodes;
  if (nodes === void 0 || nodes === null) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label}`);
  }
  if (!Array.isArray(nodes)) {
    throw new Error(`${MISSING_CONTEXT_CARD_NODES} task=${label} (nodes must be an array)`);
  }
  return nodes.map((n) => n.id).filter((id) => id && id !== "root");
}
function taskHasWorkspaceOnlyContext(task) {
  return taskReferencedNodeIds(task).length === 0;
}
function taskDirectlyReferencesNode(task, nodeId) {
  const id = nodeId.trim();
  if (!id || id === "root") return false;
  return taskReferencedNodeIds(task).includes(id);
}
function taskIsActiveOccupation(task) {
  const state = task.state || (task.status === "pending" || task.status === "taken" ? legacyStatusToState(task.status) : "failed");
  return isActiveTaskState(state);
}
function listDirectActiveTasksForNode(nodeId, tasks) {
  const id = nodeId.trim();
  const matches = tasks.filter((t) => {
    if (!taskIsActiveOccupation(t)) return false;
    if (t.contextCard == null) return false;
    return taskDirectlyReferencesNode(t, id);
  });
  return sortTasksDeterministically(matches);
}
function sortTasksDeterministically(tasks) {
  return [...tasks].sort((a, b) => {
    const ca = a.createdAt || "";
    const cb = b.createdAt || "";
    if (ca !== cb) return ca.localeCompare(cb);
    const ia = a.id || "";
    const ib = b.id || "";
    if (ia !== ib) return ia.localeCompare(ib);
    return (a.path || "").localeCompare(b.path || "");
  });
}
var MISSING_CONTEXT_CARD_NODES;
var init_task_node_refs = __esm({
  "src/core/task-node-refs.ts"() {
    "use strict";
    init_frontmatter();
    init_paths();
    init_tree();
    init_task_model();
    init_task_context_card();
    MISSING_CONTEXT_CARD_NODES = "MISSING_CONTEXT_CARD: Task.contextCard.refs.nodes is required (run migrateLegacyTaskNodeRefs for legacy claims).";
  }
});

// src/core/claim.ts
var claim_exports = {};
__export(claim_exports, {
  boxHasDirectActiveTask: () => boxHasDirectActiveTask,
  canClaim: () => canClaim,
  envelopeIsActiveOccupation: () => envelopeIsActiveOccupation,
  findActiveOccupation: () => findActiveOccupation,
  findActiveRootTask: () => findActiveRootTask,
  findAnyActiveTask: () => findAnyActiveTask,
  isFrozen: () => isFrozen,
  occupiedBoxesFromTasks: () => occupiedBoxesFromTasks,
  structuralClaimGate: () => structuralClaimGate
});
function envelopeIsActiveOccupation(task) {
  const state = task.state || (task.status === "pending" || task.status === "taken" ? legacyStatusToState(task.status) : "failed");
  return isActiveTaskState(state);
}
function canClaim(box, _options) {
  return structuralClaimGate(box);
}
function structuralClaimGate(box) {
  if (box.invalid) {
    return { ok: false, blocker: box, reason: `Invalid subtree: ${box.invalidReason || "missing type definition"}` };
  }
  if (box.archived) {
    return { ok: false, blocker: box, reason: "Archived subtree cannot be claimed." };
  }
  return { ok: true };
}
function findActiveOccupation(tent, box, tasks, _options) {
  void tent;
  void _options;
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    if (taskDirectlyReferencesNode(task, box.id)) {
      return {
        blocker: box,
        task,
        relation: "self",
        reason: `${box.name} is directly referenced by active task ${task.id || task.path} (${task.role}).`
      };
    }
  }
  return void 0;
}
function boxHasDirectActiveTask(boxId, tasks) {
  return listDirectActiveTasksForNode(boxId, tasks).length > 0;
}
function findActiveRootTask(tasks) {
  return tasks.find((t) => {
    if (!envelopeIsActiveOccupation(t)) return false;
    if (t.contextCard == null) return false;
    return taskHasWorkspaceOnlyContext(t);
  });
}
function findAnyActiveTask(tasks) {
  return tasks.find((t) => envelopeIsActiveOccupation(t));
}
function occupiedBoxesFromTasks(tent, tasks) {
  const out = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    for (const nodeId of taskReferencedNodeIds(task)) {
      const box = tent.byId.get(nodeId);
      if (box) out.set(box.id, box);
    }
  }
  return [...out.values()];
}
function isFrozen(box) {
  return box.invalid || box.archived;
}
var init_claim = __esm({
  "src/core/claim.ts"() {
    "use strict";
    init_task_model();
    init_task_node_refs();
  }
});

// src/cli/tent.ts
import * as path8 from "node:path";
import * as fs9 from "node:fs/promises";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/fs/node-fs.ts
import * as fs2 from "node:fs/promises";
import * as nodePath from "node:path";

// src/fs/mutation-lock.ts
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
var MUTATION_LOCK_STALE_MS = 12e4;
async function withFileMutationLock(lockPath, action, options) {
  const now = options.now ?? Date.now;
  const makeOwnerToken = options.makeOwnerToken ?? randomUUID;
  const staleMs = options.staleMs ?? MUTATION_LOCK_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const ownerToken = makeOwnerToken();
  const record = {
    ownerToken,
    pid: process.pid,
    createdAt: new Date(now()).toISOString()
  };
  await fs.mkdir(dirnameOf(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const reclaimable = await mayReclaimLock(lockPath, now, staleMs, isProcessAlive);
      if (!reclaimable || attempt >= 2) {
        throw new Error(options.busyMessage);
      }
      const quarantine = `${lockPath}.stale-${randomUUID()}`;
      try {
        await fs.rename(lockPath, quarantine);
        await fs.rm(quarantine, { force: true }).catch(() => void 0);
      } catch (renameError) {
        if (isNotFound(renameError)) continue;
        throw renameError;
      }
    }
  }
  if (!handle) throw new Error(options.acquireFailedMessage);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    return await action();
  } finally {
    await handle.close().catch(() => void 0);
    await releaseMutationLockIfOwned(lockPath, ownerToken);
  }
}
async function releaseMutationLockIfOwned(lockPath, ownerToken) {
  const quarantine = `${lockPath}.releasing-${ownerToken}`;
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if (isNotFound(error)) return false;
    return false;
  }
  const current = await readMutationLockRecord(quarantine);
  if (current?.ownerToken === ownerToken) {
    await fs.rm(quarantine, { force: true }).catch(() => void 0);
    return true;
  }
  try {
    await fs.rename(quarantine, lockPath);
  } catch {
    await fs.rm(quarantine, { force: true }).catch(() => void 0);
  }
  return false;
}
async function readMutationLockRecord(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw);
    if (typeof value.ownerToken !== "string" || !value.ownerToken || typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.createdAt !== "string") {
      return null;
    }
    return value;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    return null;
  }
}
async function mayReclaimLock(lockPath, now = Date.now, staleMs = MUTATION_LOCK_STALE_MS, isProcessAliveFn = processIsAlive) {
  let mtimeMs;
  try {
    const stat2 = await fs.stat(lockPath);
    mtimeMs = stat2.mtimeMs;
  } catch (error) {
    if (isNotFound(error)) return false;
    return true;
  }
  if (now() - mtimeMs <= staleMs) {
    return false;
  }
  const pid = await readRecordedPid(lockPath);
  if (pid !== null && isProcessAliveFn(pid)) {
    return false;
  }
  return true;
}
async function readRecordedPid(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const value = JSON.parse(raw);
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) {
      return value.pid;
    }
    return null;
  } catch {
    return null;
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
function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}
function isAlreadyExists(error) {
  return hasCode(error, "EEXIST");
}
function isNotFound(error) {
  return hasCode(error, "ENOENT");
}
function hasCode(error, code) {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

// src/fs/node-fs.ts
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
    const entries = await fs2.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path9) {
    return fs2.readFile(this.abs(path9), "utf8");
  }
  async writeFile(path9, content) {
    const abs = this.abs(path9);
    await fs2.mkdir(nodePath.dirname(abs), { recursive: true });
    await this.atomicReplace(abs, content, "utf8");
  }
  async readBinary(path9) {
    const buf = await fs2.readFile(this.abs(path9));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async writeBinary(path9, data) {
    const abs = this.abs(path9);
    await fs2.mkdir(nodePath.dirname(abs), { recursive: true });
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.atomicReplace(abs, payload);
  }
  async atomicReplace(abs, data, encoding) {
    const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs2.writeFile(tmp, data, encoding);
      await this.renameReplacingWithRetry(tmp, abs);
    } catch (err) {
      await fs2.rm(tmp, { force: true }).catch(() => void 0);
      throw err;
    }
  }
  async renameReplacingWithRetry(from, to) {
    const attempts = process.platform === "win32" ? 10 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await fs2.rename(from, to);
        return;
      } catch (err) {
        const code = err.code;
        const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!transient || attempt === attempts - 1) throw err;
        const delayMs = Math.min(10 * 2 ** attempt, 100);
        await new Promise((resolve10) => setTimeout(resolve10, delayMs));
      }
    }
  }
  async exists(path9) {
    try {
      await fs2.access(this.abs(path9));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path9) {
    await fs2.mkdir(this.abs(path9), { recursive: true });
  }
  async move(from, to) {
    await fs2.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs2.rename(this.abs(from), this.abs(to));
  }
  async remove(path9) {
    await fs2.rm(this.abs(path9), { recursive: true, force: true });
  }
  async withLock(path9, action) {
    return withFileMutationLock(this.abs(path9), action, {
      busyMessage: "Tent is already running another write operation; try again later.",
      acquireFailedMessage: "Cannot acquire the Tent mutation lock."
    });
  }
};
var SystemClock = class {
  now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
};

// src/machine/skills.ts
import * as fs3 from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
var SKILL_TARGET_IDS = ["shared-agents", "claude"];
var SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function isSkillTargetId(value) {
  return SKILL_TARGET_IDS.includes(value);
}
function skillTargetDir(target, home) {
  const root = home ?? os.homedir();
  switch (target) {
    case "claude":
      return path.join(root, ".claude", "skills");
    case "shared-agents":
      return path.join(root, ".agents", "skills");
    default: {
      const _exhaustive = target;
      throw new Error(`Unknown skill target: ${String(_exhaustive)}`);
    }
  }
}
function defaultSkillInstallDirs(home) {
  return SKILL_TARGET_IDS.map((id) => skillTargetDir(id, home));
}
function resolveCliSkillInstallDirs(cliTarget, home) {
  const target = cliTarget.trim();
  if (target === "all") return defaultSkillInstallDirs(home);
  return [skillTargetDir(parseSkillTargetId(target), home)];
}
function assertSafeSkillName(name) {
  const trimmed = name.trim();
  if (!trimmed || !SAFE_SKILL_NAME.test(trimmed) || trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || path.basename(trimmed) !== trimmed) {
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
function bundledSkillsDir(packageRoot2) {
  return path.join(packageRoot2, "skills");
}
async function listBundledSkillNames(packageRoot2) {
  const sourceDir = bundledSkillsDir(packageRoot2);
  let entries;
  try {
    entries = await fs3.readdir(sourceDir, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") {
      throw new Error(`No installable skills found in ${sourceDir}`);
    }
    throw err;
  }
  const skillNames = [];
  for (const entry2 of entries) {
    if (!entry2.isDirectory()) continue;
    if (!SAFE_SKILL_NAME.test(entry2.name)) continue;
    if (await existsPath(path.join(sourceDir, entry2.name, "SKILL.md"))) {
      skillNames.push(entry2.name);
    }
  }
  skillNames.sort();
  return skillNames;
}
async function installSkills(options) {
  const home = options.home ?? os.homedir();
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
    await fs3.mkdir(dest.dir, { recursive: true });
    for (const name of selectedNames) {
      const source = path.join(sourceDir, name);
      const target = path.join(dest.dir, name);
      assertChildPath(sourceDir, source);
      assertChildPath(dest.dir, target);
      const exists2 = await existsPath(target);
      if (exists2 && !force) {
        results.push({
          targetDir: dest.dir,
          ...dest.target ? { target: dest.target } : {},
          skill: name,
          status: "skipped",
          reason: "already exists (use --force to overwrite)"
        });
        continue;
      }
      if (exists2 && force) {
        await fs3.rm(target, { recursive: true, force: true });
      }
      await fs3.cp(source, target, { recursive: true, errorOnExist: true });
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
    return options.targetDirs.map((dir) => ({ dir: path.resolve(dir) }));
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
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
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

// src/machine/agent-hooks.ts
import * as fs4 from "node:fs/promises";
import * as os2 from "node:os";
import * as path2 from "node:path";
var AGENT_HOOK_IDS = ["claude", "codex", "antigravity", "copilot"];
var AGENT_ALIASES = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  copilot: "copilot",
  "github-copilot": "copilot"
};
var TENT_HOOK_MARKER = "tent-managed-hook";
function parseAgentHookId(value) {
  const key = value.trim().toLowerCase();
  const id = AGENT_ALIASES[key];
  if (!id) {
    throw new Error(
      `Unknown agent: ${value} (allowed: all, ${AGENT_HOOK_IDS.join(", ")}, agy)`
    );
  }
  return id;
}
function resolveAgentHookSelection(raw) {
  if (!raw || raw.length === 0) return [...AGENT_HOOK_IDS];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed === "all") {
      return [...AGENT_HOOK_IDS];
    }
    const id = parseAgentHookId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
function claudeSettingsPath(home) {
  return path2.join(home ?? os2.homedir(), ".claude", "settings.json");
}
function codexHooksPath(home) {
  return path2.join(home ?? os2.homedir(), ".codex", "hooks.json");
}
function managedSessionStartCommand(agent, tentCommand) {
  const base = (tentCommand ?? "tent").trim() || "tent";
  const tent = base === "tent" ? "tent" : quoteIfNeeded(base);
  return `${tent} agent session-start --host ${agent}`;
}
function managedSessionEndCommand(agent, tentCommand) {
  const base = (tentCommand ?? "tent").trim() || "tent";
  const tent = base === "tent" ? "tent" : quoteIfNeeded(base);
  return `${tent} agent session-end --host ${agent}`;
}
function isManagedHookCommand(command) {
  if (!command || typeof command !== "string") return false;
  const c = command.trim();
  if (managedCommandHost(c) === null) return false;
  if (!/tent/i.test(c)) return false;
  return /\bagent\s+session-start\b/i.test(c) || /\bagent\s+session-end\b/i.test(c);
}
function isManagedEnterCommand(command) {
  if (!isManagedHookCommand(command)) return false;
  return /\bagent\s+session-start\b/i.test(String(command));
}
function isManagedLeaveCommand(command) {
  if (!isManagedHookCommand(command)) return false;
  return /\bagent\s+session-end\b/i.test(String(command));
}
function managedCommandHost(command) {
  if (!command || typeof command !== "string") return null;
  const m = command.match(/--host(?:\s+|=)([^\s"']+)/i);
  return m?.[1] ?? null;
}
function isManagedSessionStartForHost(command, agent) {
  if (!isManagedEnterCommand(command)) return false;
  return managedCommandHost(command) === agent;
}
function isManagedSessionEndForHost(command, agent) {
  if (!isManagedLeaveCommand(command)) return false;
  return managedCommandHost(command) === agent;
}
async function installAgentHooks(options = {}) {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os2.homedir();
  const results = [];
  for (const agent of agents) {
    results.push(await installOne(agent, home, options.tentCommand));
  }
  return { action: "install", results };
}
async function doctorAgentHooks(options = {}) {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os2.homedir();
  const results = [];
  for (const agent of agents) {
    results.push(await doctorOne(agent, home, options.tentCommand));
  }
  return { action: "doctor", results };
}
async function removeAgentHooks(options = {}) {
  const agents = resolveAgentHookSelection(options.agents);
  const home = options.home ?? os2.homedir();
  const results = [];
  for (const agent of agents) {
    results.push(await removeOne(agent, home));
  }
  return { action: "remove", results };
}
async function installOne(agent, home, tentCommand) {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "install",
        tentCommand,
        wrapRoot: true
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "install",
        tentCommand,
        wrapRoot: true,
        codexCommandShape: true
      });
    case "antigravity":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for Antigravity/agy; not guessed."
      );
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}
async function doctorOne(agent, home, tentCommand) {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "doctor",
        tentCommand,
        wrapRoot: true
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "doctor",
        tentCommand,
        wrapRoot: true,
        codexCommandShape: true
      });
    case "antigravity":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for Antigravity/agy; not guessed."
      );
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}
async function removeOne(agent, home) {
  switch (agent) {
    case "claude":
      return projectClaudeLike({
        agent,
        configPath: claudeSettingsPath(home),
        mode: "remove",
        wrapRoot: true
      });
    case "codex":
      return projectClaudeLike({
        agent,
        configPath: codexHooksPath(home),
        mode: "remove",
        wrapRoot: true,
        codexCommandShape: true
      });
    case "antigravity":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for Antigravity/agy; not guessed."
      );
    case "copilot":
      return unsupportedResult(
        agent,
        "No verified native SessionStart/Stop (or SessionEnd) lifecycle hook surface for GitHub Copilot CLI; not guessed."
      );
    default: {
      const _exhaustive = agent;
      throw new Error(`Unknown agent: ${String(_exhaustive)}`);
    }
  }
}
function unsupportedResult(agent, reason) {
  return {
    agent,
    support: "unsupported",
    status: "unsupported",
    reason
  };
}
async function projectClaudeLike(options) {
  const { agent, configPath, mode, tentCommand, wrapRoot, codexCommandShape } = options;
  const enterCmd = managedSessionStartCommand(agent, tentCommand);
  const leaveCmd = managedSessionEndCommand(agent, tentCommand);
  const matchEnter = (cmd) => isManagedSessionStartForHost(cmd, agent);
  const matchLeave = (cmd) => isManagedSessionEndForHost(cmd, agent);
  let root = {};
  let existed = false;
  try {
    const raw = await fs4.readFile(configPath, "utf8");
    existed = true;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Config is not a JSON object: ${configPath}`
      };
    }
    root = parsed;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
    if (code === "ENOENT") {
      root = {};
      existed = false;
    } else if (err instanceof SyntaxError) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Invalid JSON in ${configPath}: ${err.message}`
      };
    } else {
      throw err;
    }
  }
  const nextRoot = { ...root };
  const legacyCodexEvents = codexCommandShape ? migrateLegacyCodexEvents(nextRoot) : [];
  const hooksBag = wrapRoot ? asObject(nextRoot.hooks) : nextRoot;
  const hooks = wrapRoot ? { ...hooksBag } : { ...hooksBag };
  const presentBefore = detectManagedEvents(hooks, agent);
  if (mode === "doctor") {
    if (legacyCodexEvents.length > 0) {
      return {
        agent,
        support: "lifecycle",
        status: "error",
        path: configPath,
        reason: `Invalid Codex hooks.json: event keys must be nested under "hooks" (found ${legacyCodexEvents.join(",")})`,
        present: [],
        missing: ["SessionStart", "Stop"]
      };
    }
    return doctorFromPresent(agent, configPath, presentBefore, existed);
  }
  if (mode === "remove") {
    const changed = removeManagedFromHooks(hooks);
    if (!changed && presentBefore.length === 0) {
      return {
        agent,
        support: "lifecycle",
        status: "skipped",
        path: configPath,
        reason: existed ? "no managed hooks present" : "config file absent",
        present: [],
        missing: ["SessionStart", "Stop"]
      };
    }
    await writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, root);
    return {
      agent,
      support: "lifecycle",
      status: "removed",
      path: configPath,
      present: [],
      missing: ["SessionStart", "Stop"]
    };
  }
  const enterHandler = buildCommandHandler(enterCmd, codexCommandShape === true);
  const leaveHandler = buildCommandHandler(leaveCmd, codexCommandShape === true);
  const addedEnter = ensureManagedEvent(hooks, "SessionStart", enterHandler, matchEnter);
  const addedLeave = ensureManagedEvent(hooks, "Stop", leaveHandler, matchLeave);
  const normalizedCodexHandlers = codexCommandShape ? normalizeCodexManagedHandlers(hooks, agent) : false;
  const presentAfter = detectManagedEvents(hooks, agent);
  if (!addedEnter && !addedLeave && !normalizedCodexHandlers && presentAfter.length === 2 && legacyCodexEvents.length === 0) {
    return {
      agent,
      support: "lifecycle",
      status: "skipped",
      path: configPath,
      reason: "managed hooks already present",
      present: presentAfter,
      missing: missingEvents(presentAfter)
    };
  }
  await writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, root);
  return {
    agent,
    support: "lifecycle",
    status: "installed",
    path: configPath,
    present: presentAfter,
    missing: missingEvents(presentAfter)
  };
}
function normalizeCodexManagedHandlers(hooks, agent) {
  let changed = false;
  const matches = {
    SessionStart: (command) => isManagedSessionStartForHost(command, agent),
    Stop: (command) => isManagedSessionEndForHost(command, agent)
  };
  for (const event of ["SessionStart", "Stop"]) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.map((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return group;
      const nextGroup = { ...group };
      if (!Array.isArray(nextGroup.hooks)) return nextGroup;
      nextGroup.hooks = nextGroup.hooks.map((handler) => {
        if (!handler || typeof handler !== "object" || Array.isArray(handler)) return handler;
        const nextHandler = { ...handler };
        const command = typeof nextHandler.command === "string" ? nextHandler.command : null;
        if (!matches[event](command)) return handler;
        if ("async" in nextHandler) {
          delete nextHandler.async;
          changed = true;
        }
        if (nextHandler.timeout !== 60) {
          nextHandler.timeout = 60;
          changed = true;
        }
        if (nextHandler.statusMessage !== TENT_HOOK_MARKER) {
          nextHandler.statusMessage = TENT_HOOK_MARKER;
          changed = true;
        }
        return nextHandler;
      });
      return nextGroup;
    });
  }
  return changed;
}
var CODEX_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop"
];
function migrateLegacyCodexEvents(root) {
  const found = CODEX_HOOK_EVENTS.filter((event) => Array.isArray(root[event]));
  if (found.length === 0) return [];
  const hooks = { ...asObject(root.hooks) };
  for (const event of found) {
    const legacy = root[event];
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...current, ...legacy];
    delete root[event];
  }
  root.hooks = hooks;
  return found;
}
function doctorFromPresent(agent, configPath, present, existed) {
  const missing = missingEvents(present);
  if (present.length === 2) {
    return {
      agent,
      support: "lifecycle",
      status: "ok",
      path: configPath,
      present,
      missing: []
    };
  }
  if (present.length === 0) {
    return {
      agent,
      support: "lifecycle",
      status: "missing",
      path: configPath,
      reason: existed ? "managed hooks not found" : "config file absent",
      present: [],
      missing
    };
  }
  return {
    agent,
    support: "lifecycle",
    status: "partial",
    path: configPath,
    reason: `present=${present.join(",")} missing=${missing.join(",")}`,
    present,
    missing
  };
}
async function writeHooksRoot(configPath, nextRoot, hooks, wrapRoot, previousRoot) {
  pruneEmptyHookEvents(hooks);
  let toWrite;
  if (wrapRoot) {
    toWrite = { ...nextRoot };
    if (Object.keys(hooks).length === 0) {
      if ("hooks" in toWrite) delete toWrite.hooks;
    } else {
      toWrite.hooks = hooks;
    }
  } else {
    toWrite = hooks;
  }
  if (!wrapRoot && Object.keys(toWrite).length === 0) {
    try {
      await fs4.unlink(configPath);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
      if (code !== "ENOENT") throw err;
    }
    return;
  }
  void previousRoot;
  await fs4.mkdir(path2.dirname(configPath), { recursive: true });
  const body = `${JSON.stringify(toWrite, null, 2)}
`;
  await fs4.writeFile(configPath, body, "utf8");
}
function detectManagedEvents(hooks, agent) {
  const present = [];
  if (eventHasManaged(hooks, "SessionStart", (c) => isManagedSessionStartForHost(c, agent))) {
    present.push("SessionStart");
  }
  if (eventHasManaged(hooks, "Stop", (c) => isManagedSessionEndForHost(c, agent))) {
    present.push("Stop");
  }
  return present;
}
function missingEvents(present) {
  const set = new Set(present);
  const out = [];
  if (!set.has("SessionStart")) out.push("SessionStart");
  if (!set.has("Stop")) out.push("Stop");
  return out;
}
function eventHasManaged(hooks, event, match) {
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const handlers = group.hooks;
    if (!Array.isArray(handlers)) continue;
    for (const h of handlers) {
      if (!h || typeof h !== "object" || Array.isArray(h)) continue;
      const cmd = h.command;
      if (typeof cmd === "string" && match(cmd)) return true;
    }
  }
  return false;
}
function ensureManagedEvent(hooks, event, handler, match) {
  if (eventHasManaged(hooks, event, match)) return false;
  const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
  let placed = false;
  const nextGroups = groups.map((group) => {
    if (placed) return group;
    if (!group || typeof group !== "object" || Array.isArray(group)) return group;
    const g = { ...group };
    const handlers = Array.isArray(g.hooks) ? [...g.hooks] : [];
    handlers.push(handler);
    g.hooks = handlers;
    placed = true;
    return g;
  });
  if (!placed) {
    nextGroups.push({ hooks: [handler] });
  }
  hooks[event] = nextGroups;
  return true;
}
function removeManagedFromHooks(hooks) {
  let changed = false;
  for (const event of ["SessionStart", "Stop"]) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const nextGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        nextGroups.push(group);
        continue;
      }
      const g = { ...group };
      const handlers = Array.isArray(g.hooks) ? g.hooks : [];
      const kept = handlers.filter((h) => {
        if (!h || typeof h !== "object" || Array.isArray(h)) return true;
        const cmd = h.command;
        if (typeof cmd === "string" && isManagedHookCommand(cmd)) {
          changed = true;
          return false;
        }
        return true;
      });
      if (kept.length === 0) {
        if (handlers.length > 0) {
          continue;
        }
        nextGroups.push(g);
        continue;
      }
      g.hooks = kept;
      nextGroups.push(g);
    }
    if (nextGroups.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = nextGroups;
    }
  }
  return changed;
}
function pruneEmptyHookEvents(hooks) {
  for (const key of Object.keys(hooks)) {
    const val = hooks[key];
    if (Array.isArray(val) && val.length === 0) {
      delete hooks[key];
    }
  }
}
function buildCommandHandler(command, codexShape) {
  if (codexShape) {
    return {
      type: "command",
      command,
      timeout: 60,
      statusMessage: TENT_HOOK_MARKER
    };
  }
  return {
    type: "command",
    command,
    // timeout generous enough for Local Service attach; not a permission field.
    timeout: 60
  };
}
function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function quoteIfNeeded(command) {
  if (!/[\s"]/.test(command)) return command;
  if (command.includes('"')) return command;
  return `"${command}"`;
}
function formatAgentHooksResults(batch) {
  const lines = [`\u2713 agent-hooks ${batch.action}`];
  for (const r of batch.results) {
    const bits = [`  - ${r.agent}: ${r.status}`];
    if (r.path) bits.push(`path=${r.path}`);
    if (r.present && r.present.length > 0) bits.push(`present=${r.present.join(",")}`);
    if (r.missing && r.missing.length > 0) bits.push(`missing=${r.missing.join(",")}`);
    if (r.reason) bits.push(`(${r.reason})`);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}

// src/cli/tent.ts
init_tree();

// src/core/ops.ts
init_adapter();
init_tree();

// src/core/manifest.ts
init_tree();
function buildManifest(tent, input) {
  const { role } = input;
  const claimBoxes = input.claimRoot ? tent.roots : requireClaimBoxes(input);
  const claimScope = input.claimRoot ? allBoxes(tent).filter(isUsableBox) : claimBoxes.flatMap(subtree);
  const readable = [];
  const writable = [];
  for (const box of allBoxes(tent)) {
    if (isUsableBox(box)) {
      readable.push({ id: box.id, path: box.path, note: oneLineNote(box) });
    }
  }
  readable.push({ path: "roles.json", note: "System registry: available roles and persistent prompts." });
  readable.push({ path: "temp/", note: "System pipeline: read all role temp state." });
  for (const box of claimScope) {
    if (isUsableBox(box)) {
      writable.push({ id: box.id, path: box.path });
    }
  }
  if (input.claimRoot) {
    writable.push({ path: "./", note: "Structural permission: may create/move top-level boxes at the Tent root." });
  }
  for (const box of claimScope) {
    writable.push({ id: box.id, path: `${box.path}/`, note: "Structural permission: may create/move/delete child boxes under this box." });
  }
  writable.push({ path: join3("temp", role) + "/" });
  return {
    tent: input.tentName,
    role,
    // No claims[] — writable ids/paths encode selection; Task Node refs are contextCard only.
    ...input.workspace ? { workspace: input.workspace } : {},
    ...input.worktree ? { worktree: input.worktree } : {},
    ...input.branch ? { branch: input.branch } : {},
    ...input.targetBranch ? { targetBranch: input.targetBranch } : {},
    readable: dedupe(readable),
    writable: dedupe(writable)
  };
}
function manifestToYaml(m) {
  const lines = [];
  lines.push(`tent: ${m.tent}`);
  lines.push(`role: ${m.role}`);
  if (m.workspace) lines.push(`workspace: ${yamlStr(m.workspace)}`);
  if (m.worktree) lines.push(`worktree: ${yamlStr(m.worktree)}`);
  if (m.branch) lines.push(`branch: ${yamlStr(m.branch)}`);
  if (m.targetBranch) lines.push(`targetBranch: ${yamlStr(m.targetBranch)}`);
  lines.push(`readable:`);
  for (const e of m.readable) lines.push(`  - ${entryLine(e)}`);
  lines.push(`writable:`);
  for (const e of m.writable) lines.push(`  - ${entryLine(e)}`);
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
    const key = `${e.id ?? ""}|${e.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// src/core/ops.ts
init_id();
init_frontmatter();
init_order();
init_claim();
init_task_node_refs();
init_tree();

// src/core/tags.ts
init_adapter();
init_frontmatter();
init_tree();
init_registryRecovery();
init_paths();
var DEFAULT_TAG_REGISTRY = { tags: [] };
async function loadTagRegistry(fs10) {
  if (!await fs10.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs10.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    const backupPath = await backupCorruptRegistry(fs10, TAGS_REGISTRY_PATH);
    const recovered = await recoverTagRegistryFromBoxes(fs10);
    await saveTagRegistryUnlocked(fs10, recovered);
    warnRegistryRecovered(TAGS_REGISTRY_PATH, backupPath, "recovered");
    return recovered;
  }
}
async function saveTagRegistryUnlocked(fs10, registry) {
  await fs10.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
async function addRegistryTag(fs10, name) {
  await withTentMutation(fs10, async () => addRegistryTagUnlocked(fs10, name));
}
async function addRegistryTagUnlocked(fs10, name) {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs10);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs10, registry);
  }
}
async function addTag(fs10, boxId, name) {
  await withTentMutation(fs10, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs10);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    assertContentMutable(box, "tagged");
    await addRegistryTagUnlocked(fs10, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs10, box, tags);
  });
}
async function removeTag(fs10, boxId, name) {
  await withTentMutation(fs10, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs10);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    assertContentMutable(box, "tagged");
    await writeBoxTags(fs10, box, box.tags.filter((item) => item !== tag));
  });
}
async function removeRegistryTag(fs10, name) {
  await withTentMutation(fs10, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs10);
    await saveTagRegistryUnlocked(fs10, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs10);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs10, box, box.tags.filter((item) => item !== tag));
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
async function writeBoxTags(fs10, box, tags) {
  const path9 = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs10.readFile(path9));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs10.writeFile(path9, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
}
function normalizeRegistry2(value) {
  if (!isRecord3(value) || !Array.isArray(value.tags)) return { tags: [] };
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
async function recoverTagRegistryFromBoxes(fs10) {
  const tent = await loadTent(fs10);
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
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/ops.ts
init_typeRegistry();

// src/core/skillRoleRegistry.ts
init_adapter();
init_id();
init_registryRecovery();
init_paths();
var DEFAULT_ROLES_REGISTRY = {
  roles: []
};
async function loadRolesRegistry(fs10) {
  const { registry } = await readRolesRegistryState(fs10);
  return registry;
}
async function readRolesRegistryState(fs10) {
  if (!await fs10.exists(ROLES_REGISTRY_PATH)) {
    return {
      registry: cloneDefaultRoles(),
      migrated: false,
      rosterMigrated: false,
      recovered: false
    };
  }
  try {
    const rawText = await fs10.readFile(ROLES_REGISTRY_PATH);
    const parsed = JSON.parse(rawText);
    const { registry, migrated, rosterMigrated } = normalizeRolesRegistryWithMigration(parsed);
    return { registry, migrated, rosterMigrated, recovered: false };
  } catch {
    const backupPath = await backupCorruptRegistry(fs10, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs10, ROLES_REGISTRY_PATH, serializeRolesRegistry(reset));
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return {
      registry: reset,
      migrated: false,
      rosterMigrated: false,
      recovered: true
    };
  }
}
function assertRoleNameAvailable(name) {
  if (name.trim().toLowerCase() === AGENT_PROFILES_TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${AGENT_PROFILES_TEMP_DIR}.`);
  }
}
function normalizeRolesRegistryWithMigration(value) {
  const root = isRecord4(value) ? value : {};
  const roles = [];
  let migrated = false;
  let rosterMigrated = false;
  const usedIds = /* @__PURE__ */ new Set();
  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord4(item)) continue;
      const hadId = typeof item.id === "string" && isRoleId(item.id.trim());
      const hadDisplayName = typeof item.displayName === "string" && item.displayName.trim().length > 0;
      const hadLegacyAllowedKey = Object.prototype.hasOwnProperty.call(
        item,
        "allowedProfiles"
      );
      const role = normalizeRoleDefinition(item, {
        usedIds,
        assignMissingId: "deterministic"
      });
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      if (roles.some((existing) => existing.id === role.id)) continue;
      if (hadLegacyAllowedKey) {
        migrated = true;
        rosterMigrated = true;
      }
      if (!hadId || !hadDisplayName) migrated = true;
      usedIds.add(role.id);
      roles.push(role);
    }
  }
  return { registry: { roles }, migrated, rosterMigrated };
}
function normalizeRoleDefinition(value, opts = {}) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const usedIds = opts.usedIds ?? /* @__PURE__ */ new Set();
  const assign = opts.assignMissingId ?? "deterministic";
  let id = typeof value.id === "string" ? value.id.trim() : "";
  if (id && !isRoleId(id)) {
    id = "";
  }
  if (id && usedIds.has(id) && assign !== "keep") {
    id = "";
  }
  if (!id) {
    if (assign === "random") {
      id = makeUniqueRoleId(usedIds, opts.rand ?? Math.random);
    } else if (name) {
      id = deterministicRoleIdFromName(name, usedIds);
    } else {
      id = makeUniqueRoleId(usedIds, opts.rand ?? Math.random);
    }
  }
  const displayRaw = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const displayName = displayRaw || name;
  const role = { id, name, displayName };
  if (typeof value.prompt === "string" && value.prompt.trim()) role.prompt = value.prompt.trim();
  if (typeof value.description === "string" && value.description.trim()) {
    role.description = value.description.trim();
  }
  if (typeof value.color === "string" && value.color.trim()) role.color = value.color.trim();
  const a2a = normalizeA2APolicy(value.a2aPolicy);
  if (a2a) role.a2aPolicy = a2a;
  const rosterFromField = normalizeAgentIdList(value.roster);
  const rawLegacy = value.allowedProfiles;
  const rosterFromLegacy = normalizeAgentIdList(rawLegacy);
  const roster = rosterFromField ?? rosterFromLegacy;
  if (roster) role.roster = roster;
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}
function normalizeAgentIdList(value) {
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
function normalizeCliConfig(value) {
  if (value === void 0) return void 0;
  if (!isRecord4(value)) throw new Error("role.cli must be an object.");
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
function serializeRolesRegistry(registry) {
  return {
    roles: registry.roles.map((role) => {
      const row = {
        id: role.id,
        name: role.name,
        displayName: role.displayName || role.name
      };
      if (role.prompt) row.prompt = role.prompt;
      if (role.description) row.description = role.description;
      if (role.color) row.color = role.color;
      if (role.a2aPolicy) row.a2aPolicy = role.a2aPolicy;
      if (role.roster && role.roster.length > 0) {
        row.roster = [...role.roster];
      }
      if (role.cli) row.cli = { ...role.cli };
      return row;
    })
  };
}
function cloneDefaultRoles() {
  return {
    roles: DEFAULT_ROLES_REGISTRY.roles.map((role) => ({ ...role }))
  };
}
async function writeJson(fs10, path9, value) {
  if (!await fs10.exists(".tent")) await fs10.mkdir(".tent");
  await fs10.writeFile(path9, JSON.stringify(value, null, 2) + "\n");
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/ops.ts
init_task();
init_task_model();
init_paths();

// src/core/delivery.ts
init_adapter();
init_frontmatter();
init_paths();
init_tree();
init_task_model();
async function loadDelivery(fs10, inputPath) {
  const path9 = normalizeDeliveryPath(inputPath);
  if (!await fs10.exists(path9)) throw new Error(`Delivery not found: ${path9}.`);
  const { data, body } = parseFrontmatter(await fs10.readFile(path9));
  if (data.type !== "delivery" || typeof data.id !== "string" || !isDeliveryId(data.id)) {
    throw new Error(`Invalid delivery format: ${path9}.`);
  }
  if (typeof data.taskId !== "string" || typeof data.boxId !== "string" || typeof data.role !== "string") {
    throw new Error(`Invalid delivery format: ${path9}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : void 0;
  const reviewDecision = data.reviewDecision === "accept" || data.reviewDecision === "reject" ? data.reviewDecision : void 0;
  const targetHead = normalizeTargetHead(
    typeof data.targetHead === "string" ? data.targetHead : void 0
  );
  return {
    path: path9,
    id: data.id,
    taskId: data.taskId,
    boxId: data.boxId,
    role: data.role,
    status,
    summary: body.trim(),
    commits: Array.isArray(data.commits) ? uniqueCommits(data.commits.filter((c) => typeof c === "string")) : [],
    ...targetHead ? { targetHead } : {},
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
async function loadDeliveries(fs10, filter) {
  const out = [];
  if (!await fs10.exists(TEMP_DIR)) return out;
  for (const entry2 of await fs10.listDir(TEMP_DIR)) {
    if (!entry2.isDir) continue;
    if (entry2.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join3(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs10.exists(profilesRoot)) continue;
      for (const profileEntry of await fs10.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectDeliveryFiles(
          fs10,
          join3(profilesRoot, profileEntry.name, "deliveries"),
          filter,
          out
        );
      }
      continue;
    }
    await collectDeliveryFiles(fs10, join3(TEMP_DIR, entry2.name, "deliveries"), filter, out);
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
async function collectDeliveryFiles(fs10, dir, filter, out) {
  if (!await fs10.exists(dir)) return;
  for (const entry2 of await fs10.listDir(dir)) {
    if (entry2.isDir || !entry2.name.endsWith(".md")) continue;
    try {
      const d = await loadDelivery(fs10, join3(dir, entry2.name));
      if (filter?.taskId && d.taskId !== filter.taskId) continue;
      if (filter?.boxId && d.boxId !== filter.boxId) continue;
      out.push(d);
    } catch {
    }
  }
}
async function removeNonAcceptedDeliveriesForBox(fs10, boxId) {
  for (const delivery of await loadDeliveries(fs10, { boxId })) {
    if (delivery.status === "accepted") continue;
    if (await fs10.exists(delivery.path)) await fs10.remove(delivery.path);
  }
}
function normalizeDeliveryPath(input) {
  const path9 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path9) && !/^temp\/agent-profiles\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path9)) {
    throw new Error(
      "Delivery must point to temp/<role>/deliveries/<dl-id>.md or temp/agent-profiles/<profile>/deliveries/<dl-id>.md."
    );
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
function uniqueCommits(commits) {
  return [...new Set(commits.map((c) => c.trim()).filter(Boolean))];
}
function normalizeTargetHead(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}

// src/core/scaffold.ts
init_frontmatter();
init_typeRegistry();
init_tree();
init_id();
init_paths();
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
    const path9 = nested(boxName);
    await workspaceFs.mkdir(path9);
    await workspaceFs.writeFile(
      `${path9}/${boxName}.md`,
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
  const path9 = ".gitignore";
  const entry2 = `${TENT_SYSTEM_DIR}/`;
  if (!await workspaceFs.exists(path9)) {
    await workspaceFs.writeFile(path9, `${entry2}
`);
    return;
  }
  const text = await workspaceFs.readFile(path9);
  const lines = text.split(/\r?\n/);
  const has = lines.some((line) => {
    const t = line.trim();
    return t === entry2 || t === TENT_SYSTEM_DIR || t === `/${entry2}` || t === `/${TENT_SYSTEM_DIR}`;
  });
  if (has) return;
  const next = text.endsWith("\n") || text === "" ? `${text}${entry2}
` : `${text}
${entry2}
`;
  await workspaceFs.writeFile(path9, next);
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
init_adapter();
init_claim();
init_task_node_refs();

// src/core/output.ts
init_frontmatter();
init_task();
init_task_model();
init_tree();
init_typeRegistry();
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

// src/core/task-lifecycle.ts
init_tree();
init_task();
init_paths();
init_task_model();
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
    if (task.contextCard == null) {
      throw new Error(
        `Cannot claim task: missing Task.contextCard (run migrateLegacyTaskNodeRefs for legacy claims).`
      );
    }
    const claimedBoxes = taskReferencedNodeIds(task).map(
      (claimId) => requireBoxById(tent, claimId)
    );
    for (const box of claimedBoxes) {
      const claimable = canClaim(box);
      if (!claimable.ok) throw new Error(`Cannot claim task: ${claimable.reason || "box cannot be claimed"}`);
    }
    await ackTaskEnvelope(env.fs, taskPath);
    if (options.sessionId) {
      return patchTaskEnvelope(env.fs, taskPath, {
        sessionId: options.sessionId,
        updatedAt: env.clock.now()
      });
    }
    return loadTaskEnvelope(env.fs, taskPath);
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
    await releaseOccupationForTask(env, task);
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
  if (task.contextCard == null) return;
  for (const nodeId of taskReferencedNodeIds(task)) {
    if (nodeId === "root") continue;
    await removeNonAcceptedDeliveriesForBox(env.fs, nodeId);
  }
}
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs10, action) {
  return withTentMutation(fs10, action);
}

// src/core/forkOps.ts
init_adapter();
init_frontmatter();
init_id();
init_order();
init_tree();
async function forkNode(env, boxId) {
  return withTentMutation(env.fs, async () => forkNodeUnlocked(env, boxId));
}
async function forkNodeUnlocked(env, boxId) {
  const tent = await loadTent(env.fs);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const source = tent.byId.get(boxId);
  if (!source) throw new Error(`Box not found: ${boxId}.`);
  if (!isUsableBox(source)) throw new Error("Invalid or archived boxes cannot be forked.");
  assertContentMutable(source, "forked");
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
    const nextPath = rel ? join3(forkPath, rel) : forkPath;
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
async function uniqueSiblingPath(fs10, parentPath, base) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base : `${base.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join3(parentPath, name);
    if (!await fs10.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs10, from, to) {
  await fs10.mkdir(to);
  for (const entry2 of await fs10.listDir(from)) {
    const src = join3(from, entry2.name);
    const dst = join3(to, entry2.name);
    if (entry2.isDir) await copyTree(fs10, src, dst);
    else await fs10.writeFile(dst, await fs10.readFile(src));
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
async function ensureIdentityFileName(fs10, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs10.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join3(newBoxPath, oldName);
  if (await fs10.exists(copied)) await fs10.move(copied, expected);
}

// src/core/renameOps.ts
init_adapter();
init_claim();
init_frontmatter();

// src/core/okf.ts
init_adapter();
init_frontmatter();
init_tree();
async function syncOkfBundle(fs10) {
  return withTentMutation(fs10, async () => syncOkfBundleUnlocked(fs10));
}
async function syncOkfBundleUnlocked(fs10) {
  const tent = await loadTent(fs10);
  const concepts = [...tent.byPath.values()];
  const index = buildConceptIndex(concepts);
  const generatedFiles = await writeIndexes(fs10, concepts);
  const projection = await projectWikiLinks(fs10, concepts, index);
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
async function projectWikiLinks(fs10, boxes, index) {
  const projectedFiles = [];
  const unresolved = [];
  for (const box of boxes) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs10.readFile(notePath));
    const projected = projectMarkdownLinks(body, notePath, index);
    if (projected.unresolved.length > 0) {
      unresolved.push(...projected.unresolved.map((target) => ({ file: notePath, target })));
    }
    if (!projected.changed) continue;
    await fs10.writeFile(notePath, serializeFrontmatter(data, projected.body, keyOrder));
    projectedFiles.push(notePath);
  }
  return { projectedFiles, unresolved };
}
async function writeIndexes(fs10, boxes) {
  const generated = /* @__PURE__ */ new Set();
  const byDir = /* @__PURE__ */ new Map();
  for (const box of boxes) {
    const dir = dirName(boxNotePath(box.path));
    const list = byDir.get(dir) ?? [];
    list.push(box);
    byDir.set(dir, list);
  }
  const roots = boxes.filter((box) => !box.parent);
  await fs10.writeFile(
    "index.md",
    serializeFrontmatter(
      { type: "index", okf_version: "0.1" },
      "# Index\n\n" + roots.map((box) => `- [${box.name}](${markdownLinkDestination(boxNotePath(box.path))})`).join("\n") + "\n"
    )
  );
  generated.add("index.md");
  for (const [dir, siblings] of byDir.entries()) {
    if (!dir) continue;
    const indexPath = join3(dir, "index.md");
    await fs10.writeFile(
      indexPath,
      serializeFrontmatter(
        { type: "index" },
        "# Index\n\n" + siblings.map((box) => `- [${box.name}](${markdownLinkDestination(`${box.name}.md`)})`).join("\n") + "\n"
      )
    );
    generated.add(indexPath);
  }
  await fs10.writeFile("log.md", serializeFrontmatter({ type: "log" }, "# Log\n\n_No log entries._\n"));
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

// src/core/renameOps.ts
init_paths();
init_tree();

// src/core/moveOps.ts
init_adapter();
init_frontmatter();
init_order();
init_paths();
init_tree();

// src/core/ops.ts
async function dispatch(env, claimId, role, promptOrOptions) {
  return withMutation2(env.fs, async () => dispatchUnlocked(env, claimId, role, promptOrOptions));
}
async function dispatchUnlocked(env, claimId, role, promptOrOptions) {
  const tent = await loadTent(env.fs);
  const options = typeof promptOrOptions === "string" ? { userPrompt: promptOrOptions, ...userTaskActors() } : promptOrOptions;
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
  const createdRoot = assigneeKind === "agentProfile" ? agentProfileTempRoot(assigneeLabel) : join3("temp", assigneeLabel);
  const createdRootExisted = await env.fs.exists(createdRoot);
  if (!options.parentActor) {
    throw new Error(
      "Dispatch requires explicit parentActor (legacy dispatchedBy is migration-only; reviewer may be derived equal)."
    );
  }
  void options.asSub;
  void tasks;
  if (claim.root) {
  } else {
    const structural = structuralClaimGate(claim.box);
    if (!structural.ok) {
      throw new Error(`Cannot dispatch: ${structural.reason || "box cannot be claimed"}`);
    }
    const claimable = canClaim(claim.box, { tent, tasks });
    if (!claimable.ok) {
      throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    }
  }
  try {
    const roleSelection = claim.root ? [] : assigneeKind === "role" ? roleManifestSelection(tent, assigneeLabel, claim.box, tasks) : [claim.box];
    const input = claim.root ? { tentName: env.tentName, role: assigneeLabel, claimRoot: true, ...options.workspace } : { tentName: env.tentName, role: assigneeLabel, claimBoxes: roleSelection, ...options.workspace };
    const manifest = buildManifest(tent, input);
    const yaml = manifestToYaml(manifest);
    const taskId = options.taskId && options.taskId.trim() ? options.taskId.trim() : makeTaskId();
    let manifestPath;
    let initPath;
    if (assigneeKind === "agentProfile") {
      manifestPath = agentProfileManifestPath(assigneeLabel, taskId);
      await ensureDir2(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
    } else {
      manifestPath = join3("temp", assigneeLabel, "manifest.yml");
      await ensureDir2(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
      const registry = await loadRolesRegistry(env.fs);
      const roleDefinition = registry.roles.find((item) => item.name === assigneeLabel) ?? { name: assigneeLabel };
      initPath = await ensureRoleInit(env.fs, roleDefinition, env.tentName);
    }
    const taskClaims = claim.root ? [{ id: "root", path: "./" }] : [{ id: claim.box.id, path: claim.box.path }];
    const agentId = options.agentId?.trim() || void 0;
    const taskPath = await writeTaskEnvelope(env.fs, env.clock, {
      role: assigneeLabel,
      claims: taskClaims,
      manifestPath,
      userPrompt,
      workspace: options.workspace,
      parentActor: options.parentActor,
      reviewer: options.reviewer,
      asSub: options.asSub === true,
      deliveryPolicy: options.deliveryPolicy,
      assigneeKind,
      agentId,
      id: taskId,
      tasksDir: assigneeKind === "agentProfile" ? agentProfileTasksDir(assigneeLabel) : void 0
    });
    const written = await loadTaskEnvelope(env.fs, taskPath).catch(() => null);
    const parentActor = options.parentActor;
    const reviewer = options.reviewer ?? { ...parentActor };
    const relayPrompt = relayPromptForTask(
      written ?? {
        path: taskPath,
        role: assigneeLabel,
        manifest: manifestPath,
        status: "pending",
        state: "queued",
        assigneeKind,
        ...agentId ? { agentId } : {},
        id: taskId,
        parentActor,
        reviewer,
        ...options.asSub === true ? { asSub: true } : {}
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
async function cleanTemp(env, role) {
  const roleName = role === void 0 ? void 0 : assertRoleName(role);
  await withMutation2(env.fs, async () => {
    const target = roleName ? join3("temp", roleName) : "temp";
    if (await env.fs.exists(target)) {
      await env.fs.remove(target);
    }
    if (!roleName) await ensureDir2(env.fs, "temp");
  });
}
async function forceRelease(env, boxId) {
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireBoxById2(tent, boxId);
  });
  const tasks = await loadTaskEnvelopes(env.fs);
  const active = tasks.filter(
    (t) => envelopeIsActiveOccupation(t) && t.contextCard != null && taskDirectlyReferencesNode(t, boxId)
  );
  if (active.length === 0) {
    await withMutation2(env.fs, async () => {
      await removeNonAcceptedDeliveriesForBox(env.fs, boxId);
    });
    return;
  }
  for (const task of active) {
    if (task.state === "queued" || task.status === "pending") {
      await cancelPendingTask(env, task.path);
      continue;
    }
    try {
      await taskInterrupt(env, task.path);
    } catch {
      try {
        await taskFail(env, task.path, { summary: "force-release" });
      } catch {
        await withMutation2(env.fs, async () => {
          const current = await loadTaskEnvelope(env.fs, task.path).catch(() => null);
          if (!current) return;
          if (envelopeIsActiveOccupation(current)) {
            await patchTaskEnvelope(env.fs, task.path, {
              state: "interrupted",
              wait: null,
              updatedAt: env.clock.now()
            });
          }
          await removeNonAcceptedDeliveriesForBox(env.fs, boxId);
        });
      }
    }
  }
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
    assertContentMutable(parent2, "used as create parent");
  }
  const existing = new Set(tent.byId.keys());
  const id = makeUniqueConceptId(existing, env.rand);
  const path9 = join3(input.parentPath, name);
  assertNotTempPath(path9);
  await ensureDir2(env.fs, path9);
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
async function ensureDir2(fs10, path9) {
  if (path9 && !await fs10.exists(path9)) await fs10.mkdir(path9);
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
  assertRoleNameAvailable(name);
  return name;
}
function roleManifestSelection(tent, role, current, tasks) {
  const selected = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (taskAssigneeKind(task) !== "role") continue;
    if (task.role !== role) continue;
    if (!envelopeIsActiveOccupation(task)) continue;
    if (task.contextCard == null) continue;
    for (const nodeId of taskReferencedNodeIds(task)) {
      const box = tent.byId.get(nodeId);
      if (box) selected.set(box.id, box);
    }
  }
  selected.set(current.id, current);
  return [...selected.values()];
}
function requireBoxById2(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation2(fs10, action) {
  return withTentMutation(fs10, action);
}

// src/cli/tent.ts
init_typeRegistry();
init_task();

// src/core/proposal.ts
init_adapter();
init_frontmatter();
init_tree();
async function submitProposal(fs10, clock, role, boxId, body) {
  return withTentMutation(fs10, async () => submitProposalUnlocked(fs10, clock, role, boxId, body));
}
async function submitProposalUnlocked(fs10, clock, roleInput, boxId, body) {
  const text = body.trim();
  if (!text) throw new Error("Proposal body cannot be empty.");
  const role = normalizeRole(roleInput);
  const tent = await loadTent(fs10);
  if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  const path9 = proposalPath(role, box.id);
  if (await fs10.exists(path9)) {
    const current = await loadProposal(fs10, path9);
    if (current.status === "pending") throw new Error("A proposal is already pending triage; the user must confirm or reject it first.");
  }
  const proposal = {
    path: path9,
    boxId: box.id,
    role,
    status: "pending",
    createdAt: clock.now(),
    body: text
  };
  await ensureDir3(fs10, join3("temp", role, "proposals"));
  await writeProposal(fs10, proposal);
  return proposal;
}
async function loadProposals(fs10) {
  const proposals = [];
  if (!await fs10.exists("temp")) return proposals;
  for (const roleDir of await fs10.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join3("temp", roleDir.name, "proposals");
    if (!await fs10.exists(dir)) continue;
    for (const entry2 of await fs10.listDir(dir)) {
      if (entry2.isDir || !entry2.name.endsWith(".md")) continue;
      const path9 = join3(dir, entry2.name);
      try {
        proposals.push(await loadProposal(fs10, path9));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs10, inputPath) {
  const path9 = normalizeProposalPath(inputPath);
  if (!await fs10.exists(path9)) throw new Error(`Proposal not found: ${path9}.`);
  const { data, body } = parseFrontmatter(await fs10.readFile(path9));
  if (data.type !== "proposal" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path9}.`);
  }
  return {
    path: path9,
    boxId: data.box,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    body: body.trim()
  };
}
function proposalPath(role, boxId) {
  return join3("temp", role, "proposals", `${boxId}.md`);
}
function normalizeProposalPath(input) {
  const path9 = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/[bc]x-[^/]+\.md$/.test(path9)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path9;
}
async function writeProposal(fs10, proposal) {
  const data = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
  await fs10.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}
async function ensureDir3(fs10, path9) {
  if (!await fs10.exists(path9)) await fs10.mkdir(path9);
}
function normalizeRole(role) {
  const normalized = role.trim();
  if (!normalized) throw new Error("Proposal role cannot be empty; set TENT_ROLE before running tent propose.");
  if (normalized.includes("..") || /[\/\\\r\n]/.test(normalized)) throw new Error(`Invalid proposal role: ${role}`);
  return normalized;
}

// src/core/status.ts
import * as fs5 from "node:fs/promises";
import * as path3 from "node:path";
init_task();
init_tree();
init_claim();
init_task_node_refs();

// src/core/workspace.ts
init_paths();
init_task_context_card();
import * as nodePath2 from "node:path";
import * as nodeFs from "node:fs/promises";
import { spawn } from "node:child_process";
function resolveTentWorkspace(_tent, systemRoot) {
  void _tent;
  if (!systemRoot) return void 0;
  const fromLayout = workspaceRootFromSystemRoot(systemRoot);
  return fromLayout ? nodePath2.resolve(fromLayout) : void 0;
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

// src/core/status.ts
var NOT_INSIDE_TENT_MESSAGE = "Not inside a Tent (no .tent/ system root with RULES.md found).";
async function renderTentStatus(cwd = process.cwd(), role = process.env.TENT_ROLE, createFs) {
  const systemRoot = await findTentSystemRoot(cwd);
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  if (!createFs) {
    throw new Error(
      "renderTentStatus requires createFs (host FsAdapter factory); Core does not import src/fs"
    );
  }
  const fsAdapter = createFs(systemRoot);
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
  const allTasks = await loadTaskEnvelopes(fsAdapter);
  const pendingTasks = allTasks.filter((task) => task.state === "queued" || task.status === "pending").filter((task) => !role || task.role === role);
  lines.push("");
  if (pendingTasks.length === 0) {
    lines.push("Pending tasks (task-ack): none");
  } else {
    lines.push("Pending tasks (task-ack):");
    for (const task of pendingTasks) {
      const nodeIds = task.contextCard != null ? taskReferencedNodeIds(task) : [];
      lines.push(
        `- ${task.role}/${path3.posix.basename(task.path)} -> ${nodeIds.join(", ") || "-"}`
      );
    }
  }
  const activeTasks = allTasks.filter((task) => envelopeIsActiveOccupation(task)).filter((task) => task.state !== "queued" && task.status !== "pending").filter((task) => !role || task.role === role);
  lines.push("");
  if (activeTasks.length === 0) {
    lines.push("Active tasks: none");
  } else {
    lines.push("Active tasks:");
    for (const task of activeTasks) {
      const state = task.state || task.status || "unknown";
      const nodeIds = task.contextCard != null ? taskReferencedNodeIds(task) : [];
      lines.push(
        `- ${task.id || path3.posix.basename(task.path)}: ${task.role} [${state}] nodes=${nodeIds.join(",") || "-"}`
      );
    }
  }
  return lines.join("\n") + "\n";
}
async function findTentSystemRoot(cwd = process.cwd()) {
  let dir = path3.resolve(cwd);
  for (; ; ) {
    if (await isSystemRoot(dir)) return dir;
    const nested = path3.join(dir, ".tent");
    if (await isSystemRoot(nested)) return nested;
    const parent = path3.dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
}
async function isSystemRoot(root) {
  if (!await exists(path3.join(root, "RULES.md"))) return false;
  return await exists(path3.join(root, "types.json")) || await exists(path3.join(root, "temp")) || await exists(path3.join(root, ".tent"));
}
async function exists(target) {
  try {
    await fs5.access(target);
    return true;
  } catch {
    return false;
  }
}

// src/cli/tent.ts
init_adapter();
init_paths();

// src/core/migration.ts
init_frontmatter();
init_id();
init_paths();
import * as nodeFs2 from "node:fs/promises";
import * as nodePath3 from "node:path";
init_tree();
init_typeRegistry();
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
function rewriteCanonicalConceptType(type) {
  const raw = type.trim();
  if (!raw) return void 0;
  const i = raw.indexOf("-");
  const base = i === -1 ? raw : raw.slice(0, i);
  const modifier = i === -1 ? void 0 : raw.slice(i + 1);
  let nextBase = base;
  if (base === "note") nextBase = "prompt";
  else if (base === "artifact") nextBase = "output";
  else if (base === "open" || base === "sealed") nextBase = "prompt";
  let nextMod = modifier;
  if (modifier === "open" || modifier === "sealed") nextMod = void 0;
  if (nextMod && nextMod !== "reference" && nextMod !== "asset" && (nextBase === "goal" || nextBase === "prompt" || nextBase === "output")) {
  }
  const next = nextMod ? `${nextBase}-${nextMod}` : nextBase;
  return next === raw ? void 0 : next;
}
function migrateTypeRegistryJson(value) {
  const changes = [];
  const root = isRecord5(value) ? deepClone(value) : {};
  const hadNestedBuckets = isRecord5(root.primary) || isRecord5(root.secondary);
  const hadRetiredFields = jsonHadRetiredFields(value);
  const hadLegacyKeys = jsonHadLegacyTypeKeys(value);
  let flat = {};
  if (hadNestedBuckets) {
    if (isRecord5(root.primary)) {
      mergeLegacyKeysInto(flat, root.primary, changes, "primary");
    }
    if (isRecord5(root.secondary)) {
      mergeLegacyKeysInto(flat, root.secondary, changes, "secondary");
    }
  } else {
    mergeLegacyKeysInto(flat, root, changes, "root");
  }
  const registry = normalizeRegistry(flat);
  const beforeSlim = isAlreadySlimV02Registry(value);
  if (!beforeSlim) {
    if (!isRecord5(value) || Object.keys(flat).length === 0) {
      changes.push("seeded default V0.2 type registry");
    } else if (hadNestedBuckets) {
      changes.push("normalized primary/secondary registry to V0.2 slim shape");
    } else {
      changes.push("normalized flat registry to V0.2 slim shape");
    }
    if (hadRetiredFields) {
      changes.push(
        "stripped domain R/W, coordination, color, description, workspacePointer from type defs"
      );
    }
    if (hadLegacyKeys && changes.length === 0) {
      changes.push("mapped legacy type keys to V0.2");
    }
  }
  void DEFAULT_TYPE_REGISTRY;
  return { registry, changes: uniqueChanges(changes) };
}
function isAlreadySlimV02Registry(value) {
  if (!isRecord5(value)) return false;
  if ("primary" in value || "secondary" in value) return false;
  for (const [name, raw] of Object.entries(value)) {
    if (name === "note" || name === "artifact" || name === "open" || name === "sealed") return false;
    if (!isRecord5(raw)) return false;
    const keys = Object.keys(raw);
    if (keys.length === 0) continue;
    if (keys.length === 1 && keys[0] === "tier" && (raw.tier === "base" || raw.tier === "modifier")) {
      continue;
    }
    return false;
  }
  return true;
}
function jsonHadLegacyTypeKeys(value) {
  if (!isRecord5(value)) return false;
  const walk = (node) => {
    if (!isRecord5(node)) return false;
    for (const [k, v] of Object.entries(node)) {
      if (k === "note" || k === "artifact" || k === "open" || k === "sealed") return true;
      if (walk(v)) return true;
    }
    return false;
  };
  return walk(value);
}
function mergeLegacyKeysInto(target, source, changes, label) {
  for (const [key, raw] of Object.entries(source)) {
    if (key === "primary" || key === "secondary") continue;
    if (key === "open" || key === "sealed") {
      changes.push(`dropped retired secondary key ${label}.${key}`);
      continue;
    }
    let nextKey = key;
    if (key === "note") {
      nextKey = "prompt";
      changes.push(`mapped ${label}.note \u2192 prompt`);
    } else if (key === "artifact") {
      nextKey = "output";
      changes.push(`mapped ${label}.artifact \u2192 output`);
    }
    if (target[nextKey] === void 0) {
      target[nextKey] = isRecord5(raw) ? slimTypeDef(raw) : raw;
    }
  }
}
function slimTypeDef(raw) {
  const tier = raw.tier === "modifier" ? "modifier" : "base";
  return { tier };
}
function jsonHadRetiredFields(value) {
  if (!isRecord5(value)) return false;
  const walk = (node) => {
    if (!isRecord5(node)) return false;
    for (const [k, v] of Object.entries(node)) {
      if (k === "readable" || k === "writable" || k === "coordination" || k === "color" || k === "description" || k === "workspacePointer") {
        return true;
      }
      if (walk(v)) return true;
    }
    return false;
  };
  return walk(value);
}
function uniqueChanges(changes) {
  return [...new Set(changes)];
}
async function migrateLegacySchema(fs10, options = {}) {
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
  await liftNestedRegistries(fs10, report, dryRun);
  await migrateFlatTypeRegistry(fs10, report, dryRun);
  await unifyMutationLock(fs10, report, dryRun);
  const tent = await loadTent(fs10);
  const legacyIds = [...tent.byId.keys()].filter(isLegacyBoxId);
  const existing = new Set(tent.byId.keys());
  const idMap = planIdRemap(legacyIds, existing, options.rand);
  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    const { data, body, keyOrder } = parseFrontmatter(await fs10.readFile(notePath));
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
      const rewritten = rewriteCanonicalConceptType(data.type);
      if (rewritten) {
        report.typeRewrites.push({ path: box.path, from: data.type, to: rewritten });
        data.type = rewritten;
        dirty = true;
      }
    }
    if ("readable" in data) {
      delete data.readable;
      dirty = true;
      report.registryChanges.push(
        dryRun ? `would strip readable at ${box.path}` : `stripped readable at ${box.path}`
      );
    }
    if ("writable" in data) {
      delete data.writable;
      dirty = true;
      report.registryChanges.push(
        dryRun ? `would strip writable at ${box.path}` : `stripped writable at ${box.path}`
      );
    }
    if (data.mode === "read-only") {
      delete data.mode;
      dirty = true;
      report.registryChanges.push(
        dryRun ? `would clear read-only mode at ${box.path}` : `cleared read-only mode at ${box.path}`
      );
    }
    if (data.archived === true) {
      if (data.mode !== "archived") {
        data.mode = "archived";
        report.registryChanges.push(
          dryRun ? `would migrate archived\u2192mode at ${box.path}` : `migrated archived\u2192mode at ${box.path}`
        );
      }
      delete data.archived;
      dirty = true;
    } else if ("archived" in data) {
      delete data.archived;
      dirty = true;
      report.registryChanges.push(
        dryRun ? `would strip legacy archived key at ${box.path}` : `stripped legacy archived key at ${box.path}`
      );
    }
    for (const key of ["owner", "status", "acceptedBy"]) {
      if (key in data) {
        delete data[key];
        dirty = true;
        report.registryChanges.push(
          dryRun ? `would strip legacy ${key} at ${box.path}` : `stripped legacy ${key} at ${box.path}`
        );
      }
    }
    if (dirty && !dryRun) {
      await fs10.writeFile(
        notePath,
        serializeFrontmatter(data, body, keyOrder.length ? keyOrder : BOX_FRONTMATTER_KEY_ORDER)
      );
    }
  }
  if (await fs10.exists(ORDER_PATH)) {
    try {
      const order = JSON.parse(await fs10.readFile(ORDER_PATH));
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
        if (!dryRun) await fs10.writeFile(ORDER_PATH, JSON.stringify(next, null, 2) + "\n");
      }
    } catch (error) {
      report.warnings.push(`order.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rewriteOps && await fs10.exists(TEMP_DIR)) {
    await rewriteOperationalTree(fs10, idMap, report, dryRun);
  }
  const seen = /* @__PURE__ */ new Set();
  report.idMap = report.idMap.filter((entry2) => {
    const key = `${entry2.from}->${entry2.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return report;
}
async function liftNestedRegistries(fs10, report, dryRun) {
  if (!await fs10.exists(TENT_SYSTEM_DIR)) return;
  for (const name of NESTED_REGISTRY_FILES) {
    const nested = join3(TENT_SYSTEM_DIR, name);
    if (!await fs10.exists(nested)) continue;
    const flatExists = await fs10.exists(name);
    if (!flatExists) {
      report.registryChanges.push(
        dryRun ? `would lift nested ${nested} \u2192 ${name}` : `lifted nested ${nested} \u2192 ${name}`
      );
      if (!dryRun) {
        const text = await fs10.readFile(nested);
        await fs10.writeFile(name, text);
      }
    } else {
      report.registryChanges.push(`nested ${nested} ignored; flat ${name} already present`);
    }
    report.registryChanges.push(dryRun ? `would remove nested ${nested}` : `removed nested ${nested}`);
    if (!dryRun) await fs10.remove(nested);
  }
  const nestedLock = join3(TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  if (await fs10.exists(nestedLock)) {
    report.registryChanges.push(
      dryRun ? `would remove nested ${nestedLock}` : `removed nested ${nestedLock}`
    );
    if (!dryRun) await fs10.remove(nestedLock);
  }
}
async function migrateFlatTypeRegistry(fs10, report, dryRun) {
  if (!await fs10.exists(TYPE_REGISTRY_PATH)) return;
  try {
    const text = await fs10.readFile(TYPE_REGISTRY_PATH);
    const raw = JSON.parse(text);
    const { registry, changes } = migrateTypeRegistryJson(raw);
    report.registryChanges.push(...changes);
    const nextText = JSON.stringify(registry, null, 2) + "\n";
    if (!dryRun && changes.length > 0 && nextText !== text) {
      await fs10.writeFile(TYPE_REGISTRY_PATH, nextText);
    }
  } catch (error) {
    report.warnings.push(
      `types.json migration skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function unifyMutationLock(fs10, report, dryRun) {
  const nestedLock = join3(TENT_SYSTEM_DIR, MUTATION_LOCK_PATH);
  if (await fs10.exists(nestedLock)) {
    report.registryChanges.push(
      dryRun ? `would remove nested lock ${nestedLock}` : `removed nested lock ${nestedLock}`
    );
    if (!dryRun) await fs10.remove(nestedLock);
  }
  if (!report.registryChanges.some((c) => c.includes(MUTATION_LOCK_PATH))) {
    report.registryChanges.push(`unique lock path: ${MUTATION_LOCK_PATH}`);
  }
}
async function rewriteOperationalTree(fs10, idMap, report, dryRun) {
  if (idMap.size === 0) return;
  const walk = async (dir) => {
    if (!await fs10.exists(dir)) return;
    for (const entry2 of await fs10.listDir(dir)) {
      const path9 = join3(dir, entry2.name);
      if (entry2.isDir) {
        await walk(path9);
        continue;
      }
      const lower = entry2.name.toLowerCase();
      if (!lower.endsWith(".md") && !lower.endsWith(".yml") && !lower.endsWith(".yaml")) continue;
      const text = await fs10.readFile(path9);
      const rewritten = rewriteOperationalText(text, idMap);
      let targetName = entry2.name;
      for (const [from, to] of idMap) {
        if (targetName.includes(from)) {
          targetName = replaceExactIdTokens(targetName, from, to);
        }
      }
      const targetPath = join3(dir, targetName);
      if (rewritten === text && targetPath === path9) continue;
      report.registryChanges.push(`operational rewrite: ${path9}`);
      if (!dryRun) {
        if (targetPath !== path9) {
          await fs10.writeFile(targetPath, rewritten);
          await fs10.remove(path9);
        } else {
          await fs10.writeFile(path9, rewritten);
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
  const createFs = options.createFs;
  if (typeof createFs !== "function") {
    throw new Error(
      "importExternalTentRoot requires createFs (host FsAdapter factory); Core does not import src/fs"
    );
  }
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
  const sourceFs = createFs(sourceRoot);
  try {
    const { loadTaskEnvelopes: loadTaskEnvelopes2 } = await Promise.resolve().then(() => (init_task(), task_exports));
    const { envelopeIsActiveOccupation: envelopeIsActiveOccupation2 } = await Promise.resolve().then(() => (init_claim(), claim_exports));
    const tasks = await loadTaskEnvelopes2(sourceFs);
    const active = tasks.filter((t) => envelopeIsActiveOccupation2(t));
    if (active.length > 0) {
      const msg = `Source has ${active.length} active task(s). Prefer idle cutover.`;
      if (options.force) warnings.push(msg + " (--force: continuing)");
      else {
        throw new Error(
          msg + ` Re-run with --force to import anyway (still will not overwrite an existing .tent).`
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("active task")) throw error;
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
    const destFs = createFs(stagingRoot);
    const schema = await migrateLegacySchema(destFs, {
      dryRun: false,
      rand: options.rand,
      rewriteOperationalRefs: options.rewriteOperationalRefs
    });
    if (options._testHooks?.afterSchema) await options._testHooks.afterSchema(stagingRoot);
    const workspaceFs = createFs(workspaceRoot);
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
  for (const entry2 of entries) {
    if (IMPORT_SKIP_DIR_NAMES.has(entry2.name)) continue;
    if (entry2.name === "MIGRATED.md") continue;
    const rel = relBase ? `${relBase}/${entry2.name}` : entry2.name;
    const relPosix = rel.replace(/\\/g, "/");
    const abs = nodePath3.join(root, entry2.name);
    if (entry2.isSymbolicLink()) {
      noteSkippedSymlink(relPosix, skipped, warnings);
      continue;
    }
    if (entry2.isDirectory()) {
      await collectSymlinkSkips(abs, skipped, warnings, relPosix);
    }
  }
}
async function copyHostTree(from, to, skipped, warnings, relBase = "") {
  await nodeFs2.mkdir(to, { recursive: true });
  const entries = await nodeFs2.readdir(from, { withFileTypes: true });
  for (const entry2 of entries) {
    if (IMPORT_SKIP_DIR_NAMES.has(entry2.name)) continue;
    if (entry2.name === "MIGRATED.md") continue;
    const rel = relBase ? `${relBase}/${entry2.name}` : entry2.name;
    const relPosix = rel.replace(/\\/g, "/");
    const src = nodePath3.join(from, entry2.name);
    const dst = nodePath3.join(to, entry2.name);
    if (entry2.isSymbolicLink()) {
      noteSkippedSymlink(relPosix, skipped, warnings);
      continue;
    }
    if (entry2.isDirectory()) {
      await copyHostTree(src, dst, skipped, warnings, relPosix);
    } else if (entry2.isFile()) {
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
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/cli/service-attach.ts
import * as fs8 from "node:fs/promises";
import * as path6 from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath } from "node:url";

// src/service/data-dir.ts
import * as fs7 from "node:fs/promises";
import { isIP } from "node:net";
import * as os3 from "node:os";
import * as path5 from "node:path";

// src/machine-state.ts
import * as fs6 from "node:fs/promises";
import * as path4 from "node:path";
function isNotFoundError(err) {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

// src/service/data-dir.ts
function defaultServiceDataDir(env = process.env) {
  if (env.TENT_SERVICE_DATA_DIR) return path5.resolve(env.TENT_SERVICE_DATA_DIR);
  if (process.platform === "win32") {
    const base = env.APPDATA || path5.join(os3.homedir(), "AppData", "Roaming");
    return path5.join(base, "Tent");
  }
  if (process.platform === "darwin") {
    return path5.join(os3.homedir(), "Library", "Application Support", "Tent");
  }
  const xdg = env.XDG_STATE_HOME || path5.join(os3.homedir(), ".local", "state");
  return path5.join(xdg, "tent");
}
function serviceEndpointPath(dataDir) {
  return path5.join(dataDir, "service.json");
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
async function readServiceEndpoint(dataDir) {
  const file = serviceEndpointPath(dataDir);
  try {
    const raw = await fs7.readFile(file, "utf8");
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

// src/service/auth.ts
import * as crypto from "node:crypto";
var AUTH_TOKEN_HEADER = "x-tent-token";

// src/service/client.ts
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseRpcErrorBody(value) {
  if (!isPlainObject2(value)) return null;
  if (!Number.isInteger(value.code) || typeof value.message !== "string") return null;
  const error = { code: value.code, message: value.message };
  if (Object.prototype.hasOwnProperty.call(value, "data")) {
    error.data = value.data;
  }
  return error;
}
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
    let rawText;
    try {
      rawText = await res.text();
    } catch {
      throw new Error(`Service RPC: failed to read response (HTTP ${res.status})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      if (res.ok) throw new Error("Service RPC: invalid JSON response");
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    if (!isPlainObject2(parsed) || parsed.jsonrpc !== "2.0") {
      if (res.ok) {
        throw new Error(
          !isPlainObject2(parsed) ? "Service RPC: response must be a plain object" : "Service RPC: invalid jsonrpc version"
        );
      }
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
    const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
    if (hasResult === hasError) {
      if (res.ok) {
        throw new Error("Service RPC: response must include exactly one of result or error");
      }
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    if (res.ok) {
      if (parsed.id !== id) {
        throw new Error(`Service RPC: response id mismatch (expected ${id})`);
      }
      if (hasResult) {
        return { result: parsed.result };
      }
      const error2 = parseRpcErrorBody(parsed.error);
      if (!error2) {
        throw new Error("Service RPC: invalid error object");
      }
      return { error: error2 };
    }
    if (!hasError) {
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    const error = parseRpcErrorBody(parsed.error);
    if (!error) {
      throw new Error(`Service RPC HTTP ${res.status}`);
    }
    return { error };
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
  /**
   * Read workspace collaboration settings projection (defaultDeliveryPolicy, extensible).
   * Missing file/field resolves to defaultDeliveryPolicy=review.
   * Historical on-disk `manual` is normalized to `review` at the settings read boundary.
   */
  workspaceSettings(workspaceId) {
    return this.call("workspace.settings", { workspaceId });
  }
  /**
   * User-only settings mutation (MutationBus).
   * Emits exactly one workspace.settings.updated on successful actual change; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   * New writes accept review | bypass | agent-decide only (not historical manual).
   */
  workspaceSettingsUpdate(workspaceId, patch, actor = "user") {
    return this.call("workspace.settings.update", {
      workspaceId,
      ...patch,
      actor
    });
  }
  /**
   * Read canonical workspace-root AGENTS.md projection.
   * Missing file → content "" and exists=false (not an error). Includes etag for edit.
   */
  workspaceAgents(workspaceId) {
    return this.call("workspace.agents", { workspaceId });
  }
  /**
   * User-only write of workspace-root AGENTS.md (MutationBus, atomic).
   * Optional baseEtag rejects stale writes with -32009. Emits workspace.agents.updated
   * only when content actually changes; no-op emits none.
   * `actor` defaults to "user"; non-user is rejected by the service.
   */
  workspaceAgentsWrite(workspaceId, args) {
    return this.call("workspace.agents.write", {
      workspaceId,
      content: args.content,
      ...args.baseEtag !== void 0 ? { baseEtag: args.baseEtag } : {},
      actor: args.actor ?? "user"
    });
  }
  // ---- convenience: docs ----
  docsList(workspaceId, includeBody = false) {
    return this.call("docs.list", { workspaceId, includeBody });
  }
  docsGet(workspaceId, idOrPath) {
    return this.call("docs.get", { workspaceId, ...idOrPath });
  }
  /**
   * Existing-node body/frontmatter write. baseEtag is required (from docs.readForEdit).
   * Missing → -32008; stale → -32009. Errors carry currentEtag only (no body).
   */
  docsWrite(workspaceId, args) {
    return this.call("docs.write", { workspaceId, ...args });
  }
  docsCreateNote(workspaceId, args) {
    return this.call("docs.createNote", { workspaceId, ...args });
  }
  docsFork(workspaceId, idOrPath) {
    return this.call("docs.fork", { workspaceId, ...idOrPath });
  }
  /**
   * User-only atomic concept rename (MutationBus).
   * Resolve by id/path/boxId; pass newName only — cx- is immutable.
   * Success emits exactly one concept.changed with oldPath/path.
   */
  docsRename(workspaceId, args) {
    return this.call("docs.rename", { workspaceId, ...args });
  }
  /**
   * User-only structural move / reparent (MutationBus).
   * Resolve by stable cx- id; expectedPath required for stale-path conflict.
   * newParentId null = tent root. position: inside | before/after siblingId.
   * Success emits exactly one concept.changed (reason docs.move) with oldPath/path/pathMap.
   */
  docsMove(workspaceId, args) {
    return this.call("docs.move", { workspaceId, ...args });
  }
  /**
   * Set Node mode (editable | archived). Sole mode mutation client surface.
   */
  docsSetMode(workspaceId, args) {
    return this.call("docs.setMode", { workspaceId, ...args });
  }
  /**
   * Import attachment bytes for a concept. Wire payload is base64; disk stores original bytes.
   */
  docsImportAttachment(workspaceId, args) {
    return this.call("docs.importAttachment", { workspaceId, ...args });
  }
  /**
   * User-only set compound Node type (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits concept.changed reason docs.setType.
   */
  docsSetType(workspaceId, args) {
    return this.call("docs.setType", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only replace Node tags (MutationBus + baseEtag). Empty clears Node tags only.
   */
  docsTagsSet(workspaceId, args) {
    return this.call("docs.tags.set", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /** User-only attach one tag (idempotent; MutationBus + baseEtag). */
  docsTagAdd(workspaceId, args) {
    return this.call("docs.tag.add", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /** User-only detach one tag from Node (does not prune registry). */
  docsTagRemove(workspaceId, args) {
    return this.call("docs.tag.remove", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * Read-only first-class semantic relations for a Node.
   * Outgoing from source frontmatter; incoming derived from other Nodes.
   * Does not include Markdown/wiki body links.
   */
  relationList(workspaceId, args) {
    return this.call("relation.list", { workspaceId, ...args });
  }
  /**
   * User-only create semantic relation on source Node (MutationBus + baseEtag).
   * Missing baseEtag → -32008; stale → -32009. Emits concept.changed reason relation.create.
   */
  relationCreate(workspaceId, args) {
    return this.call("relation.create", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only update semantic relation (cannot change id/source).
   * label: null clears. Emits concept.changed reason relation.update.
   */
  relationUpdate(workspaceId, args) {
    return this.call("relation.update", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only delete semantic relation by id on source Node.
   * Missing id fails loudly. Emits concept.changed reason relation.delete.
   */
  relationDelete(workspaceId, args) {
    return this.call("relation.delete", {
      workspaceId,
      ...args,
      actor: args.actor ?? "user"
    });
  }
  // ---- convenience: registry ----
  registryTypes(workspaceId) {
    return this.call("registry.types", { workspaceId });
  }
  /**
   * User-only custom secondary type create. Primaries / built-ins fail loud.
   * Emits registry.types.updated.
   */
  registryTypeCreate(workspaceId, args) {
    return this.call("registry.type.create", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user"
    });
  }
  /**
   * User-only custom secondary type delete. confirmation must equal name.
   * In-use and built-in fail loud. Emits registry.types.updated.
   */
  registryTypeDelete(workspaceId, args) {
    return this.call("registry.type.delete", {
      workspaceId,
      name: args.name,
      confirmation: args.confirmation,
      actor: args.actor ?? "user"
    });
  }
  /** Read-only global tag vocabulary. */
  registryTags(workspaceId) {
    return this.call("registry.tags", { workspaceId });
  }
  /** User-only ensure tag in global vocabulary. Emits registry.tags.updated. */
  registryTagCreate(workspaceId, args) {
    return this.call("registry.tag.create", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user"
    });
  }
  /** User-only global tag delete + cascade off Nodes. Emits registry.tags.updated. */
  registryTagDelete(workspaceId, args) {
    return this.call("registry.tag.delete", {
      workspaceId,
      name: args.name,
      actor: args.actor ?? "user"
    });
  }
  registryRoles(workspaceId) {
    return this.call("registry.roles", { workspaceId });
  }
  /**
   * User-only role create (MutationBus). Pass fields at top level — never secrets.
   * Server assigns immutable roleId. `actor` defaults to "user"; non-user is rejected.
   */
  registryRoleCreate(workspaceId, role) {
    return this.call("registry.role.create", { workspaceId, ...role });
  }
  /**
   * User-only role update. Resolve by operational name (compat) or pass roleId in patch.
   * Operational name cannot be renamed in identity batch 1; change displayName instead.
   * Success emits exactly one registry.roles.updated.
   */
  registryRoleUpdate(workspaceId, name, patch) {
    return this.call("registry.role.update", { workspaceId, name, ...patch });
  }
  // ---- convenience: machine-local AgentDefinition (logical worker identity) ----
  agentList() {
    return this.call("agent.list", {});
  }
  agentGet(id) {
    return this.call("agent.get", { id });
  }
  agentCreate(agent) {
    return this.call("agent.create", { ...agent, actor: agent.actor ?? "user" });
  }
  agentUpdate(id, patch) {
    return this.call("agent.update", { ...patch, id, actor: patch.actor ?? "user" });
  }
  agentDelete(id, confirmation, actor = "user") {
    return this.call("agent.delete", { id, confirmation, actor });
  }
  /**
   * User-only role delete. confirmation must equal operational name or roleId.
   * Refuses when the role has an active task or live managed session.
   */
  registryRoleDelete(workspaceId, name, confirmation, actor = "user") {
    return this.call("registry.role.delete", {
      workspaceId,
      name,
      confirmation,
      actor
    });
  }
  // ---- convenience: machine-local profiles (safe metadata / editor projection) ----
  profileList(opts) {
    return this.call("profile.list", opts ?? {});
  }
  profileGet(id) {
    return this.call("profile.get", { id });
  }
  profileCreate(profile) {
    return this.call("profile.create", profile);
  }
  /** Method `id` always wins over any `id` inside patch (spread cannot override). */
  profileUpdate(id, patch) {
    return this.call("profile.update", { ...patch, id });
  }
  profileDelete(id) {
    return this.call("profile.delete", { id });
  }
  /**
   * Read-only product provider verification catalog.
   * Returns adapterId + verificationLevel (+ optional canResume/notes).
   * Distinct from profile.list (machine-local launch config). Never secrets.
   */
  providerCatalog() {
    return this.call("provider.catalog", {});
  }
  // ---- convenience: machine-local credentials (never returns secret) ----
  credentialList() {
    return this.call("credential.list", {});
  }
  /**
   * Store encrypted secret under id. Response is id/metadata only.
   * Callers must not log `secret`; RPC response never echoes it.
   */
  credentialSet(id, secret, metadata) {
    return this.call("credential.set", {
      id,
      secret,
      ...metadata !== void 0 ? { metadata } : {}
    });
  }
  credentialDelete(id) {
    return this.call("credential.delete", { id });
  }
  // ---- convenience: machine-local skills (bundled only; no workspaceId) ----
  skillList() {
    return this.call("skill.list", {});
  }
  /**
   * Install bundled skills into shared-agents and/or claude skill dirs.
   * Omitting skills installs all bundled; omitting targets installs both.
   * Does not accept arbitrary source/destination paths.
   */
  skillInstall(opts) {
    return this.call("skill.install", opts ?? {});
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
  /**
   * A2U business ask: running task → pending UserAsk + waiting(user-input).
   * Not multi-turn chat. choices optional.
   */
  taskAskUser(workspaceId, taskPath, args) {
    return this.call("task.askUser", { workspaceId, taskPath, ...args });
  }
  /**
   * U2A one-shot append to a running/waiting managed task (user-only).
   * Provide text and/or contextRefs (stable entity ids). Not chat; not UserAsk reply.
   */
  taskSendInput(workspaceId, taskPath, args) {
    return this.call("task.sendInput", { workspaceId, taskPath, ...args });
  }
  taskDeliver(workspaceId, taskPath, args) {
    return this.call("task.deliver", { workspaceId, taskPath, ...args });
  }
  taskAccept(workspaceId, taskPath, actor, commits, opts) {
    return this.call("task.accept", {
      workspaceId,
      taskPath,
      actor,
      commits,
      ...opts?.outputNodeIds ? { outputNodeIds: opts.outputNodeIds } : {}
    });
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
  /**
   * Explicit fresh managed Session on the same Task when the bound provider
   * context is unusable. Not a silent fallback from taskStartSession.
   * Same A2A params as startSession; refuses turnBusy with TURN_BUSY (no force).
   * Shares the per-Task managed-session execution slot with startSession.
   */
  taskReplaceSession(workspaceId, args) {
    return this.call("task.replaceSession", { workspaceId, ...args });
  }
  taskList(workspaceId) {
    return this.call("task.list", { workspaceId });
  }
  taskGet(workspaceId, taskPath) {
    return this.call("task.get", { workspaceId, taskPath });
  }
  /**
   * List deliveries for a workspace (optional taskId / boxId / role filters).
   * Read projection only — review still uses task.accept / task.reject.
   */
  deliveryList(workspaceId, opts) {
    return this.call(
      "delivery.list",
      { workspaceId, ...opts }
    );
  }
  /** Get one delivery by id within a workspace. */
  deliveryGet(workspaceId, id) {
    return this.call(
      "delivery.get",
      { workspaceId, id }
    );
  }
  /**
   * @deprecated Prefer nodeCollaboration (V0.2). Migration-only.
   * Stable box collaboration projection (legacy task-api §2.3).
   * Resolve by id, boxId, or path (same conventions as docs.get).
   * Active task is authoritative; without one, only persisted done is preserved.
   */
  boxProjection(workspaceId, idOrPath) {
    return this.call("box.projection", { workspaceId, ...idOrPath });
  }
  /**
   * @deprecated Prefer nodeCollaborations (V0.2). Migration-only.
   * Batch box collaboration projection — same item semantics as box.projection.
   * `ids` order is preserved in the returned `projections` array.
   */
  boxProjections(workspaceId, ids) {
    return this.call("box.projections", { workspaceId, ids });
  }
  /**
   * V0.2 Node-keyed collaboration projection (task-api §2.3 / cx-tsw53f).
   * Resolve by id, boxId, or path (same conventions as docs.get).
   * Multi-Task: activeTasks[] + activeTaskCount (projection-only mirror of length);
   * Session/Delivery only via explicit ids. No totalCount/pagination.
   * Idle Node returns activeTasks: [] / activeTaskCount: 0.
   */
  nodeCollaboration(workspaceId, idOrPath) {
    return this.call("node.collaboration", {
      workspaceId,
      ...idOrPath
    });
  }
  /**
   * V0.2 batch Node collaboration projection — same multi-Task item semantics.
   * `ids` order is preserved in the returned `items` array. Empty ids → empty items.
   * Loads workspace tasks/sessions/deliveries once per batch (no N+1).
   */
  nodeCollaborations(workspaceId, ids) {
    return this.call("node.collaborations", {
      workspaceId,
      ids
    });
  }
  /**
   * V0.2 Output provenance: Output → Delivery → Task → sourceNode by id.
   * Unbound type=output returns bound:false; never infers by path/name/time.
   */
  outputProvenance(workspaceId, idOrPath) {
    return this.call("output.provenance", {
      workspaceId,
      ...idOrPath
    });
  }
  /**
   * Workspace-level graph projection for Working-set Canvas.
   * Node summaries + parent / markdown / wiki edges; no body, no placement.
   * Unresolved concept links are retained with explicit unresolved payload.
   */
  graphProjection(workspaceId) {
    return this.call("graph.projection", { workspaceId });
  }
  // ---- convenience: proposal (triage; separate from delivery review) ----
  proposalList(workspaceId, opts) {
    return this.call("proposal.list", { workspaceId, ...opts });
  }
  proposalSubmit(workspaceId, args) {
    return this.call("proposal.submit", { workspaceId, ...args });
  }
  /**
   * User-only resolve (accept|reject). actor defaults to "user";
   * non-user actors are rejected by the service.
   */
  proposalResolve(workspaceId, path9, decision, actor = "user") {
    return this.call("proposal.resolve", { workspaceId, path: path9, decision, actor });
  }
  sessionList(workspaceId) {
    return this.call("session.list", workspaceId ? { workspaceId } : {});
  }
  sessionGet(sessionId) {
    return this.call("session.get", { sessionId });
  }
  /**
   * Register or reuse a pull-host external session (no ACP spawn).
   * Machine-callable; idempotent for sessionId / externalKey.
   */
  sessionEnter(args = {}) {
    return this.call("session.enter", { ...args });
  }
  /** Probe external/managed session + incomplete task bindings. */
  sessionStatus(args = {}) {
    return this.call("session.status", { ...args });
  }
  /**
   * End external session binding only — never deliver/accept tasks.
   * Reports incompleteTasks still bound to the sessionId / externalKey.
   * Accepts either a sessionId string or an options object (hook closed-loop).
   */
  sessionLeave(sessionIdOrArgs, workspaceId) {
    if (typeof sessionIdOrArgs === "string") {
      return this.call("session.leave", {
        sessionId: sessionIdOrArgs,
        ...workspaceId ? { workspaceId } : {}
      });
    }
    return this.call("session.leave", { ...sessionIdOrArgs });
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
  /** A2U UserAsk pending list (business questions). Not tool permission / not chat. */
  userAskListPending(workspaceId) {
    return this.call("userAsk.listPending", workspaceId ? { workspaceId } : {});
  }
  userAskGet(askId) {
    return this.call("userAsk.get", { askId });
  }
  /** User-only: answer a business ask; resumes task + optional managed continue. */
  userAskReply(askId, args = {}) {
    return this.call("userAsk.reply", {
      askId,
      actor: args.actor ?? "user",
      answer: args.answer,
      choiceId: args.choiceId
    });
  }
  /** User-only: deny a business ask; resumes task for rework/observe. */
  userAskDeny(askId, actor = "user") {
    return this.call("userAsk.deny", { askId, actor });
  }
  /**
   * Unified A2U pending read projection for one workspace.
   * Aggregates UserAsk / A2A / toolApproval / ready Delivery.
   * Resolve actions stay on domain RPCs — no interaction.resolve.
   */
  interactionListPending(workspaceId) {
    return this.call("interaction.listPending", {
      workspaceId
    });
  }
  /**
   * U2A pending one-shot inputs for external poll.
   * Always requires workspaceId + taskPath — no machine-global inbox.
   */
  taskInputListPending(workspaceId, taskPath) {
    return this.call("taskInput.listPending", { workspaceId, taskPath });
  }
  /**
   * Scoped get: workspaceId + taskPath + inputId (no id-only lookup).
   */
  taskInputGet(workspaceId, taskPath, inputId) {
    return this.call("taskInput.get", { workspaceId, taskPath, inputId });
  }
  /**
   * External agent formal ack after observing one-shot input (poll+ack).
   * Actor must match stored task role / session binding; scope is workspaceId+taskPath.
   */
  taskInputAck(workspaceId, taskPath, inputId, actor) {
    return this.call("taskInput.ack", {
      workspaceId,
      taskPath,
      inputId,
      ...actor ? { actor } : {}
    });
  }
  /**
   * User-only operational retention preview (task-api §6).
   * Read-only: returns candidates/skipped/warnings; never mutates.
   * `keepTerminalTasksDays` defaults to 30; `0` = immediately eligible.
   */
  operationalRetentionPreview(workspaceId, opts) {
    return this.call("operationalRetention.preview", {
      workspaceId,
      ...opts
    });
  }
  /**
   * User-only operational retention purge (task-api §6).
   * Mutates via MutationBus; emits exactly one retention.purged when files are deleted.
   */
  operationalRetentionPurge(workspaceId, opts) {
    return this.call("operationalRetention.purge", {
      workspaceId,
      ...opts
    });
  }
  /**
   * List Node Markdown underline annotations for a node (cx- identity).
   * Projection includes live relocate state; does not rewrite stored anchors.
   */
  annotationList(workspaceId, nodeId) {
    return this.call("annotation.list", { workspaceId, nodeId });
  }
  /**
   * User-only create underline annotation (MutationBus).
   * Validates range/quote against authoritative body; documentEtag uses docs.readForEdit etag.
   * Events: annotation.changed (invalidation only). Never injects Agent / TaskInput.
   */
  annotationCreate(workspaceId, args) {
    return this.call("annotation.create", {
      workspaceId,
      nodeId: args.nodeId,
      quote: args.quote,
      start: args.start,
      end: args.end,
      body: args.body,
      documentEtag: args.documentEtag,
      actor: args.actor ?? "user"
    });
  }
  /** User-only resolve annotation (open → resolved). */
  annotationResolve(workspaceId, id, actor = "user") {
    return this.call("annotation.resolve", { workspaceId, id, actor });
  }
  /** User-only reopen annotation (resolved → open). */
  annotationReopen(workspaceId, id, actor = "user") {
    return this.call("annotation.reopen", { workspaceId, id, actor });
  }
  /** User-only delete annotation record. */
  annotationDelete(workspaceId, id, actor = "user") {
    return this.call("annotation.delete", { workspaceId, id, actor });
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
  const entry2 = options.serviceEntry ?? await resolveDefaultServiceEntry(options.packageRoot);
  const entryAbs = path6.resolve(entry2);
  const child = spawnFn(process.execPath, [entryAbs, "start", "--data-dir", dataDir], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: cliServiceChildEnv(options.env, dataDir),
    windowsHide: true,
    cwd: path6.dirname(entryAbs)
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
    const attached = await tryAttachService(dataDir, fetchImpl);
    if (attached) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      return { ...attached, started: true, child, dataDir };
    }
    await sleep(pollMs);
  }
  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(
      `Local Tent Service exited before an endpoint became healthy (code=${child.exitCode}). entry=${entryAbs}
${spawnLog}`
    );
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
  const url = serviceBaseUrl(endpoint.host, endpoint.port);
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
    const here = path6.dirname(fileURLToPath(import.meta.url));
    if (path6.basename(here) === "cli" && path6.basename(path6.dirname(here)) === "src") {
      roots.push(path6.resolve(here, "../.."));
    } else {
      roots.push(here);
    }
  } catch {
  }
  const relativeCandidates = [
    "service.mjs",
    path6.join("dist", "service.mjs"),
    path6.join("desktop", "service.mjs"),
    path6.join("src", "service", "cli.ts")
  ];
  for (const root of roots) {
    for (const rel of relativeCandidates) {
      const candidate = path6.join(root, rel);
      try {
        await fs8.access(candidate);
        return candidate;
      } catch {
      }
    }
  }
  return path6.join(roots[0] ?? process.cwd(), "service.mjs");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/cli/workspace-context.ts
import * as path7 from "node:path";
init_paths();
async function ensureMountedWorkspace(client, options = {}) {
  const { workspaceRoot, systemRoot } = await resolveWorkspacePaths(options);
  const listed = await client.listWorkspaces();
  const existing = (listed.workspaces ?? []).find(
    (w) => path7.resolve(w.workspaceRoot) === path7.resolve(workspaceRoot)
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
  const start = path7.resolve(options.workspace || options.cwd || process.cwd());
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
  return { workspaceRoot: path7.resolve(workspaceRoot), systemRoot: path7.resolve(systemRoot) };
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
        const usageRole = "Usage: tent task dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]";
        const usageProfile = "Usage: tent task dispatch <boxId> --profile <profileId> [localPrompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]";
        const usageAgent = "Usage: tent task dispatch <boxId> --agent <agentId> [localPrompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]";
        const usageBoth = `${usageRole}
   or: ${usageProfile.replace(/^Usage: /, "")}
   or: ${usageAgent.replace(/^Usage: /, "")}`;
        if (Object.prototype.hasOwnProperty.call(flags, "assignee-kind") || Object.prototype.hasOwnProperty.call(flags, "assigneeKind")) {
          return failUsage(
            "Do not pass --assignee-kind; use <role> for durable role dispatch, --profile <profileId> for user one-shot, or --agent <agentId> for Role roster dispatch"
          );
        }
        if (Object.prototype.hasOwnProperty.call(flags, "start-session") || Object.prototype.hasOwnProperty.call(flags, "startSession")) {
          return failUsage(
            "Do not pass --start-session; managed --profile / --agent dispatch always starts a session"
          );
        }
        const boxId = positionals[0];
        if (!boxId) {
          return failUsage(usageBoth);
        }
        const hasProfileFlag = Object.prototype.hasOwnProperty.call(flags, "profile");
        const hasAgentFlag = Object.prototype.hasOwnProperty.call(flags, "agent");
        const profileIdRaw = hasProfileFlag ? String(flags.profile ?? "").trim() : "";
        const agentIdRaw = hasAgentFlag ? String(flags.agent ?? "").trim() : "";
        if (hasProfileFlag && !profileIdRaw) {
          return failUsage(`--profile requires <profileId>
${usageProfile}`);
        }
        if (hasAgentFlag && !agentIdRaw) {
          return failUsage(`--agent requires <agentId>
${usageAgent}`);
        }
        if (hasProfileFlag && hasAgentFlag) {
          return failUsage(
            "Pass either --profile <profileId> or --agent <agentId>, not both\n" + usageBoth
          );
        }
        const isManagedOneShotForm = hasProfileFlag || hasAgentFlag;
        const role = isManagedOneShotForm ? void 0 : positionals[1];
        const promptParts = isManagedOneShotForm ? positionals.slice(1) : positionals.slice(2);
        if (!isManagedOneShotForm && !role) {
          return failUsage(usageBoth);
        }
        if (Object.prototype.hasOwnProperty.call(flags, "prompt") && promptParts.length > 0) {
          return failUsage(
            "Pass prompt either as positionals or via --prompt <text>|- , not both\n" + usageBoth
          );
        }
        let prompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
        if (prompt === "-") prompt = await readStdinText();
        const asSub = flags["as-sub"] === "true";
        const explicitBy = (flags.by || flags.from || flags["dispatched-by"] || "").trim();
        if (explicitBy && explicitBy === "user") {
          return failUsage(
            "--by/--from/--dispatched-by must name a dispatching role, not user; omit the flag for plain user-originated dispatch"
          );
        }
        const tentRole = (process.env.TENT_ROLE || "").trim();
        const parentRole = explicitBy || (tentRole && tentRole !== "user" ? tentRole : "");
        if (asSub && !parentRole) {
          return failUsage("--as-sub requires --by <parent-role> or TENT_ROLE");
        }
        const roleAttributed = asSub || Boolean(explicitBy) || Boolean(tentRole && tentRole !== "user");
        const callerKind = roleAttributed ? "role" : "user";
        const parentActor = parentRole ? { kind: "role", id: parentRole } : { kind: "user", id: "user" };
        const result = await client.taskDispatch(
          workspaceId,
          isManagedOneShotForm ? {
            boxId,
            assigneeKind: "agentProfile",
            ...hasAgentFlag ? { agentId: agentIdRaw } : { profileId: profileIdRaw },
            prompt,
            parentActor,
            reviewer: parentActor,
            asSub: asSub || void 0,
            deliveryPolicy: flags["delivery-policy"] || flags.deliveryPolicy,
            startSession: true,
            callerKind
          } : {
            boxId,
            role,
            prompt,
            parentActor,
            reviewer: parentActor,
            asSub: asSub || void 0,
            deliveryPolicy: flags["delivery-policy"] || flags.deliveryPolicy,
            callerKind
          }
        );
        return okPrint(result, json, (r) => formatTaskDispatch(r));
      }
      case "accept": {
        const taskPath = positionals[0];
        if (!taskPath || positionals.length > 1) {
          return failUsage(
            "Usage: tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--outputs id,id] [--workspace <path>] [--json]"
          );
        }
        const actor = flags.actor || flags.by || process.env.TENT_ROLE;
        if (!actor) return failUsage("tent task accept requires --actor <user|role>");
        const commits = parseCommitsFlag(flags.commits);
        const outputNodeIds = parseCommitsFlag(flags.outputs) ?? parseCommitsFlag(flags["output-ids"]);
        const result = await client.taskAccept(workspaceId, taskPath, actor, commits, {
          outputNodeIds
        });
        return okPrint(result, json, (r) => {
          const row = r;
          const bound = row.boundOutputIds && row.boundOutputIds.length ? `boundOutputs: ${row.boundOutputIds.join(",")}
` : "";
          return `\u2713 Accepted via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "accepted"}
` + bound;
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
      case "ask-user":
      case "askUser": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task ask-user <taskPath> --question <text>|- [--choices id=label,id=label] [--workspace <path>] [--json]"
          );
        }
        if (!Object.prototype.hasOwnProperty.call(flags, "question")) {
          return failUsage("tent task ask-user requires --question <text> or --question -");
        }
        let question = flags.question ?? "";
        if (question === "-") question = await readStdinText();
        if (!question.trim()) {
          return failUsage("tent task ask-user: --question must be non-empty");
        }
        const choices = parseChoicesFlag(flags.choices);
        const result = await client.taskAskUser(workspaceId, taskPath, {
          question,
          choices
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 UserAsk created via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "waiting"}
` + (row.ask?.id ? `askId: ${row.ask.id}
` : "") + (row.ask?.status ? `askStatus: ${row.ask.status}
` : "");
        });
      }
      case "user-ask":
      case "userAsk": {
        const action = positionals[0];
        if (!action || action === "list") {
          const result = await client.userAskListPending(workspaceId);
          return okPrint(result, json, (r) => formatUserAskList(r));
        }
        if (action === "get") {
          const askId = positionals[1];
          if (!askId) {
            return failUsage(
              "Usage: tent task user-ask get <askId> [--workspace <path>] [--json]"
            );
          }
          const result = await client.userAskGet(askId);
          return okPrint(result, json, (r) => formatUserAskGet(r));
        }
        if (action === "reply") {
          const askId = positionals[1];
          if (!askId) {
            return failUsage(
              "Usage: tent task user-ask reply <askId> [--answer <text>|-] [--choice <id>] [--workspace <path>] [--json]"
            );
          }
          let answer = flags.answer;
          if (answer === "-") answer = await readStdinText();
          const choiceId = flags.choice || flags["choice-id"] || flags.choiceId;
          if (!(answer?.trim() || choiceId?.trim())) {
            return failUsage(
              "tent task user-ask reply requires --answer and/or --choice"
            );
          }
          const result = await client.userAskReply(askId, {
            answer,
            choiceId,
            actor: flags.actor || "user"
          });
          return okPrint(result, json, (r) => {
            const row = r;
            return `\u2713 UserAsk answered via service RPC
` + (row.ask?.id ? `askId: ${row.ask.id}
` : "") + (row.ask?.status ? `askStatus: ${row.ask.status}
` : "") + (row.state ? `taskState: ${row.state}
` : "") + (row.continued != null ? `continued: ${row.continued}
` : "");
          });
        }
        if (action === "deny") {
          const askId = positionals[1];
          if (!askId) {
            return failUsage(
              "Usage: tent task user-ask deny <askId> [--workspace <path>] [--json]"
            );
          }
          const result = await client.userAskDeny(askId, flags.actor || "user");
          return okPrint(result, json, (r) => {
            const row = r;
            return `\u2713 UserAsk denied via service RPC
` + (row.ask?.id ? `askId: ${row.ask.id}
` : "") + (row.ask?.status ? `askStatus: ${row.ask.status}
` : "") + (row.state ? `taskState: ${row.state}
` : "");
          });
        }
        return failUsage(
          "Usage: tent task user-ask list|get|reply|deny \u2026\n" + taskHelpText()
        );
      }
      case "send-input":
      case "sendInput": {
        const taskPath = positionals[0];
        if (!taskPath) {
          return failUsage(
            "Usage: tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]"
          );
        }
        let text = flags.text;
        if (text === "-") text = await readStdinText();
        const contextRefs = parseRefsFlag(
          flags.refs || flags["context-refs"] || flags.contextRefs
        );
        if (!(text?.trim() || contextRefs && contextRefs.length > 0)) {
          return failUsage(
            "tent task send-input requires --text and/or --refs (stable entity ids)"
          );
        }
        const result = await client.taskSendInput(workspaceId, taskPath, {
          text,
          contextRefs,
          actor: flags.actor || "user"
        });
        return okPrint(result, json, (r) => {
          const row = r;
          return `\u2713 TaskInput accepted via service RPC
taskPath: ${row.taskPath ?? taskPath}
` + (row.state ? `state: ${row.state}
` : "") + (row.input?.id ? `inputId: ${row.input.id}
` : "") + (row.input?.status ? `inputStatus: ${row.input.status}
` : "") + (row.accepted != null ? `accepted: ${row.accepted}
` : "") + (row.enqueued != null ? `enqueued: ${row.enqueued}
` : "") + (row.continued != null ? `continued: ${row.continued}
` : "") + (row.continueError ? `continueError: ${row.continueError}
` : "");
        });
      }
      case "task-input":
      case "taskInput": {
        const action = positionals[0];
        if (!action || action === "list") {
          const taskPathFilter = flags.task || flags["task-path"] || flags.taskPath || positionals[1];
          if (!taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input list <taskPath> | --task <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputListPending(
            workspaceId,
            taskPathFilter
          );
          return okPrint(result, json, (r) => formatTaskInputList(r));
        }
        if (action === "get") {
          const inputId = positionals[1];
          const taskPathFilter = flags.task || flags["task-path"] || flags.taskPath;
          if (!inputId || !taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input get <inputId> --task <taskPath> [--workspace <path>] [--json]"
            );
          }
          const result = await client.taskInputGet(
            workspaceId,
            taskPathFilter,
            inputId
          );
          return okPrint(result, json, (r) => formatTaskInputGet(r));
        }
        if (action === "ack") {
          const inputId = positionals[1];
          const taskPathFilter = flags.task || flags["task-path"] || flags.taskPath;
          if (!inputId || !taskPathFilter) {
            return failUsage(
              "Usage: tent task task-input ack <inputId> --task <taskPath> --actor <role|sessionId> [--workspace <path>] [--json]"
            );
          }
          if (!flags.actor) {
            return failUsage(
              "tent task task-input ack requires --actor matching the task role or verified session id"
            );
          }
          const result = await client.taskInputAck(
            workspaceId,
            taskPathFilter,
            inputId,
            flags.actor
          );
          return okPrint(result, json, (r) => {
            const row = r;
            return `\u2713 TaskInput acked via service RPC
` + (row.input?.id ? `inputId: ${row.input.id}
` : "") + (row.input?.status ? `status: ${row.input.status}
` : "") + (row.input?.taskPath ? `taskPath: ${row.input.taskPath}
` : "");
          });
        }
        return failUsage(
          "Usage: tent task task-input list|get|ack \u2026\n" + taskHelpText()
        );
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
function formatTaskDispatch(result) {
  const row = result;
  const nested = row.session && "session" in row.session ? row.session.session : void 0;
  const sessionView = nested ?? row.session ?? void 0;
  const sessionId = sessionView && (sessionView.sessionId || sessionView.id) ? String(sessionView.sessionId || sessionView.id) : void 0;
  const sessionState = sessionView?.state ? String(sessionView.state) : void 0;
  const sessionProfileId = sessionView?.profileId ? String(sessionView.profileId) : void 0;
  const parentLabel = row.parentActor?.kind && row.parentActor?.id ? `${row.parentActor.kind}:${row.parentActor.id}` : void 0;
  const reviewerLabel = row.reviewer?.kind && row.reviewer?.id ? `${row.reviewer.kind}:${row.reviewer.id}` : void 0;
  return `\u2713 Dispatched via service RPC
taskPath: ${row.taskPath}
state: ${row.state ?? "queued"}
` + (row.assigneeKind ? `assigneeKind: ${row.assigneeKind}
` : "") + (row.assignee ? `assignee: ${row.assignee}
` : "") + (parentLabel ? `parentActor: ${parentLabel}
` : "") + (reviewerLabel ? `reviewer: ${reviewerLabel}
` : "") + (row.asSub ? `asSub: true
` : "") + (sessionId ? `sessionId: ${sessionId}
` : "") + (sessionState ? `sessionState: ${sessionState}
` : "") + (sessionProfileId ? `sessionProfileId: ${sessionProfileId}
` : "") + (row.relayPrompt ? `
--- Relay prompt ---
${row.relayPrompt}` : "");
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
      `- ${t.path ?? t.id ?? "?"}	state=${t.state ?? t.status ?? "?"}	role=${t.role ?? "?"}	nodes=${(t.referencedNodeIds ?? []).join(",") || "-"}` + (t.sessionId ? `	session=${t.sessionId}` : "")
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
    `nodes: ${(t.referencedNodeIds ?? []).join(", ") || "-"}`
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
function parseChoicesFlag(raw) {
  if (raw === void 0 || !raw.trim()) return void 0;
  const choices = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid --choices entry (expected id=label): ${trimmed}`);
    }
    const id = trimmed.slice(0, eq).trim();
    const label = trimmed.slice(eq + 1).trim();
    if (!id || !label) {
      throw new Error(`Invalid --choices entry (empty id/label): ${trimmed}`);
    }
    choices.push({ id, label });
  }
  return choices.length ? choices : void 0;
}
function parseRefsFlag(raw) {
  if (raw === void 0 || !raw.trim()) return void 0;
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push(id);
  }
  return refs.length ? refs : void 0;
}
function formatUserAskList(result) {
  const row = result;
  const asks = row.asks ?? [];
  if (asks.length === 0) return "asks: (none)\n";
  const lines = [`asks: ${asks.length}`, ""];
  for (const a of asks) {
    lines.push(
      `- ${a.id ?? "?"}	task=${a.taskPath ?? "?"}	status=${a.status ?? "?"}	q=${(a.question ?? "").slice(0, 80)}`
    );
  }
  return lines.join("\n") + "\n";
}
function formatUserAskGet(result) {
  const row = result;
  const a = row.ask ?? {};
  const lines = [
    `id: ${a.id ?? "?"}`,
    `taskPath: ${a.taskPath ?? "?"}`,
    `status: ${a.status ?? "?"}`,
    `question: ${a.question ?? ""}`
  ];
  if (a.choiceId) lines.push(`choiceId: ${a.choiceId}`);
  if (a.answer) lines.push(`answer: ${a.answer}`);
  if (a.choices?.length) {
    lines.push("choices:");
    for (const c of a.choices) lines.push(`  - ${c.id}=${c.label}`);
  }
  return lines.join("\n") + "\n";
}
function formatTaskInputList(result) {
  const row = result;
  const inputs = row.inputs ?? [];
  if (inputs.length === 0) return "inputs: (none)\n";
  const lines = [`inputs: ${inputs.length}`, ""];
  for (const i of inputs) {
    const preview = (i.text ?? "").slice(0, 60) || (i.contextRefs?.length ? `refs=${i.contextRefs.join(",")}` : "");
    lines.push(
      `- ${i.id ?? "?"}	task=${i.taskPath ?? "?"}	status=${i.status ?? "?"}` + (preview ? `	${preview}` : "")
    );
  }
  return lines.join("\n") + "\n";
}
function formatTaskInputGet(result) {
  const row = result;
  const i = row.input ?? {};
  const lines = [
    `id: ${i.id ?? "?"}`,
    `workspaceId: ${i.workspaceId ?? "?"}`,
    `taskPath: ${i.taskPath ?? "?"}`,
    `status: ${i.status ?? "?"}`
  ];
  if (i.text) lines.push(`text: ${i.text}`);
  if (i.contextRefs?.length) lines.push(`contextRefs: ${i.contextRefs.join(", ")}`);
  if (i.deliveredAt) lines.push(`deliveredAt: ${i.deliveredAt}`);
  if (i.consumedAt) lines.push(`consumedAt: ${i.consumedAt}`);
  if (i.cancelledAt) lines.push(`cancelledAt: ${i.cancelledAt}`);
  return lines.join("\n") + "\n";
}
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set([
  "json",
  "attach-only",
  "resume",
  "no-resume",
  "yes",
  "as-sub"
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
  return new Promise((resolve10, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve10(data));
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
  tent task dispatch <boxId> <role> [prompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]
  tent task dispatch <boxId> --profile <profileId> [prompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]
  tent task dispatch <boxId> --agent <agentId> [prompt...] [--prompt <text>|-] [--delivery-policy review|bypass|agent-decide] [--as-sub --by <role>] [--workspace <path>] [--json]
      # --profile: user-direct one-shot agentProfile + startSession (does not register a role)
      # --agent: Role roster logical agentId \u2192 resolves machine-local profileId + startSession
      # role form: durable role assignee (queued; no auto session)
      # --profile form: one-shot agentProfile + startSession (prints sessionId/sessionState); does not register a role
      # Do not pass --assignee-kind; a bare role-like string is never inferred as a profile
  tent task accept <taskPath> --actor <user|role> [--commits sha,sha] [--workspace <path>] [--json]
  tent task reject <taskPath> --actor <user|role> [--note <text>] [--resume|--no-resume] [--workspace <path>] [--json]
  tent task cancel <taskPath> [--workspace <path>] [--json]
  tent task ask-user <taskPath> --question <text>|- [--choices id=label,\u2026] [--workspace <path>] [--json]
  tent task user-ask list|get <askId>|reply <askId>|deny <askId> [\u2026] [--workspace <path>] [--json]
  tent task send-input <taskPath> [--text <text>|-] [--refs id,id] [--workspace <path>] [--json]
  tent task task-input list <taskPath>|get <inputId>|ack <inputId> --task <taskPath> --actor <role|sessionId> [--workspace <path>] [--json]

Service options:
  --data-dir <path>       Machine-local service data area (default: %APPDATA%/Tent)
  --attach-only           Fail if no healthy service (do not bootstrap)
  --service-entry <path>  Path to service.mjs when bootstrapping

Legacy CLI direct core write is blocked on in-workspace <workspace>/.tent
(fail-loud; use tent task * / Desktop Service). External tent roots keep
dispatch / task-ack / complete / stamp \u2026 for the migration window only.
Formal delivery is Delivery-only via tent task deliver (no tent report).
Derived role-init remains available because it regenerates bootstrap context only.
`;
}

// src/cli/agent-rpc.ts
async function runAgentCommand(sub, args, globals = {}) {
  const normalized = normalizeAgentSub(sub);
  if (!normalized) {
    return failUsage2(
      `Unknown agent subcommand: ${sub || "(empty)"}
` + agentHelpText()
    );
  }
  const hookAlias = isHookAlias(sub);
  try {
    const { positionals, flags } = parseAgentFlags(args);
    const json = globals.json === true || flags.json === "true";
    const silent = globals.silentOutsideTent === true || flags.silent === "true" || flags["silent-outside"] === "true";
    const hookMeta = hookAlias ? await loadHookMeta(flags, globals) : { stdin: null, host: void 0 };
    const cwd = pathResolve(globals.cwd) || pathResolve(
      typeof hookMeta.stdin?.cwd === "string" ? hookMeta.stdin.cwd : void 0
    ) || pathResolve(
      typeof hookMeta.stdin?.workspace === "string" ? hookMeta.stdin.workspace : void 0
    ) || pathResolve(
      typeof hookMeta.stdin?.workspace_root === "string" ? hookMeta.stdin.workspace_root : void 0
    ) || pathResolve(
      typeof hookMeta.stdin?.workspaceRoot === "string" ? hookMeta.stdin.workspaceRoot : void 0
    );
    const workspaceFlag = flags.workspace || globals.workspace || (typeof hookMeta.stdin?.workspace === "string" ? hookMeta.stdin.workspace : void 0) || (typeof hookMeta.stdin?.workspace_root === "string" ? hookMeta.stdin.workspace_root : void 0) || (typeof hookMeta.stdin?.workspaceRoot === "string" ? hookMeta.stdin.workspaceRoot : void 0);
    const tentProbe = await probeTentPresence({
      cwd,
      workspace: workspaceFlag
    });
    if (!tentProbe.ok) {
      if (silent || hookAlias) {
        return silentOutsideResult(normalized, json);
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: tentProbe.message + "\n"
      };
    }
    const attachOpts = {
      dataDir: flags["data-dir"] || globals.dataDir,
      attachOnly: globals.attachOnly === true || flags["attach-only"] === "true",
      serviceEntry: flags["service-entry"] || globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const ctx = await ensureMountedWorkspace(client, {
      cwd,
      workspace: workspaceFlag
    });
    const workspaceId = ctx.workspaceId;
    const explicitKey = flags.key || flags["external-key"] || flags.externalKey || flags.external;
    const host = flags.host || flags.agent || hookMeta.host || process.env.TENT_HOOK_HOST || process.env.TENT_AGENT_HOST;
    const nativeSessionId = pickNativeSessionId(hookMeta.stdin, flags);
    const derivedKey = hookAlias ? buildHookExternalKey({
      host,
      nativeSessionId,
      workspaceRoot: ctx.workspaceRoot,
      workspaceId
    }) : void 0;
    const externalKey = explicitKey || derivedKey;
    switch (normalized) {
      case "enter": {
        if (positionals.length > 0) {
          return failUsage2(
            "Usage: tent agent enter [--session <ss-\u2026>] [--role <name>] [--profile <id>] [--key <externalKey>] [--host <agent>] [--task <taskId>] [--json]"
          );
        }
        if (hookAlias && !externalKey) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "session-start requires --host <agent> (or native session id + host) to form a stable externalKey; refusing to create orphan external rows\n"
          };
        }
        const sessionId = flags.session || flags["session-id"] || flags.sessionId;
        const tentSessionId = sessionId && isTentSessionId(sessionId) ? sessionId : void 0;
        const roleName = flags.role || flags["role-name"] || flags.roleName || process.env.TENT_ROLE;
        const profileId = flags.profile || flags["profile-id"] || flags.profileId;
        const lastTaskId = flags.task || flags["task-id"] || flags.taskId || flags["last-task-id"];
        const assigneeKindRaw = flags["assignee-kind"] || flags.assigneeKind;
        const assigneeKind = assigneeKindRaw === "agentProfile" || assigneeKindRaw === "role" ? assigneeKindRaw : void 0;
        const result = await client.sessionEnter({
          workspaceId,
          sessionId: tentSessionId,
          profileId,
          roleName,
          externalKey,
          lastTaskId,
          cwd: ctx.workspaceRoot,
          assigneeKind
        });
        return okPrint2(result, json, (r) => formatEnter(r));
      }
      case "status": {
        if (positionals.length > 1) {
          return failUsage2(
            "Usage: tent agent status [sessionId] [--key <externalKey>] [--host <agent>] [--workspace <path>] [--json]"
          );
        }
        const sessionIdPos = positionals[0] || flags.session || flags["session-id"] || flags.sessionId;
        const tentSessionId = sessionIdPos && isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const keyFromPos = sessionIdPos && !isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const result = await client.sessionStatus({
          workspaceId,
          sessionId: tentSessionId,
          externalKey: explicitKey || keyFromPos || derivedKey
        });
        return okPrint2(result, json, (r) => formatStatus(r));
      }
      case "leave": {
        const sessionIdPos = positionals[0] || flags.session || flags["session-id"] || flags.sessionId;
        const tentSessionId = sessionIdPos && isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const keyFromPos = sessionIdPos && !isTentSessionId(sessionIdPos) ? sessionIdPos : void 0;
        const leaveKey = explicitKey || keyFromPos || derivedKey;
        if (!tentSessionId && !leaveKey) {
          if (hookAlias) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "session-end requires --host <agent> (with native stdin session id or workspace fallback) or --key <externalKey>; cannot leave without a stable identity\n"
            };
          }
          return failUsage2(
            "Usage: tent agent leave [<sessionId>] [--key <externalKey>] [--host <agent>] [--workspace <path>] [--json]"
          );
        }
        const result = await client.sessionLeave({
          sessionId: tentSessionId,
          externalKey: leaveKey,
          workspaceId
        });
        return okPrint2(result, json, (r) => formatLeave(r));
      }
      default:
        return failUsage2(agentHelpText());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (hookAlias && /Not inside a Tent/i.test(message)) {
      return silentOutsideResult("status", globals.json === true);
    }
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}
function agentHelpText() {
  return `tent agent \u2014 external / pull-host session lifecycle (Local Service RPC)

Usage:
  tent agent enter   [--session <ss-\u2026>] [--role <name>] [--profile <id>]
                     [--key <externalKey>] [--host <agent>] [--task <taskId>] [--json]
  tent agent status  [sessionId|externalKey] [--key <externalKey>] [--json]
  tent agent leave   [sessionId|externalKey] [--key <externalKey>] [--json]

Semantics:
  enter   Register or reuse a SessionRegistry row with state=external.
          Does not start ACP or any managed agent process. Idempotent.
  status  Probe session + list incomplete (active) tasks bound to it.
  leave   End external session binding only. Never deliver or accept.
          Reports incompleteTasks still open for the caller to handle.

Hook aliases (projection contract with Agent Hook task):
  tent agent session-start --host <agent>   \u2192 enter via stable externalKey
  tent agent session-end   --host <agent>   \u2192 leave via same externalKey
  tent agent session-status --host <agent>  \u2192 status via same externalKey

  Reads native hook stdin JSON when present (session_id / sessionId / cwd /
  workspace). externalKey = host + ":" + nativeSessionId, or host + ":ws:" +
  workspaceRoot when no native id (explicit, testable fallback \u2014 not silent orphans).
  Outside a Tent workspace: silent exit 0. Inside a real Tent: other errors fail loud.

Common flags:
  --workspace <path>   Workspace root (default: resolve from cwd / stdin)
  --host <agent>       Host/agent name for hook externalKey (alias: --agent)
  --key <externalKey>  Explicit externalKey (overrides derived)
  --data-dir <path>    Service data area override
  --attach-only        Do not bootstrap Local Service
  --json               Machine-readable result
`;
}
function normalizeAgentSub(sub) {
  const s = (sub || "").trim().toLowerCase();
  if (s === "enter" || s === "session-start" || s === "sessionstart" || s === "start") {
    return "enter";
  }
  if (s === "status" || s === "session-status" || s === "sessionstatus") {
    return "status";
  }
  if (s === "leave" || s === "session-end" || s === "sessionend" || s === "end") {
    return "leave";
  }
  return null;
}
function isHookAlias(sub) {
  const s = (sub || "").trim().toLowerCase();
  return s === "session-start" || s === "sessionstart" || s === "session-status" || s === "sessionstatus" || s === "session-end" || s === "sessionend";
}
function buildHookExternalKey(opts) {
  const host = normalizeHostToken(opts.host);
  if (!host) return void 0;
  const native = (opts.nativeSessionId || "").trim();
  if (native) {
    return `${host}:${native}`;
  }
  const ws = (opts.workspaceRoot || "").trim() || (opts.workspaceId || "").trim();
  if (!ws) return void 0;
  return `${host}:ws:${normalizeWorkspaceToken(ws)}`;
}
function parseNativeHookStdin(text) {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function pickNativeSessionId(stdin, flags = {}) {
  const fromFlags = flags["native-session"] || flags.nativeSession || flags["provider-session"] || flags.providerSession;
  if (fromFlags && fromFlags.trim()) return fromFlags.trim();
  if (!stdin) return void 0;
  const candidates = [
    stdin.session_id,
    stdin.sessionId,
    stdin.SESSION_ID,
    stdin.sessionID
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return void 0;
}
function normalizeHostToken(host) {
  const h = (host || "").trim().toLowerCase();
  if (!h) return void 0;
  return h.replace(/[^a-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "") || void 0;
}
function normalizeWorkspaceToken(ws) {
  return ws.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function isTentSessionId(id) {
  return id.startsWith("ss-") && id.length > 3;
}
async function loadHookMeta(flags, globals) {
  const host = flags.host || flags.agent || process.env.TENT_HOOK_HOST || process.env.TENT_AGENT_HOST;
  let text = globals.stdinText;
  if (text === void 0 && !globals.skipStdin) {
    text = await readStdinIfAny();
  }
  return { stdin: parseNativeHookStdin(text), host };
}
function readStdinIfAny() {
  return new Promise((resolve10, reject) => {
    if (process.stdin.isTTY) {
      resolve10("");
      return;
    }
    let data = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve10(value);
    };
    const timer = setTimeout(() => done(data), 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done(data);
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (process.stdin.readableEnded) {
      clearTimeout(timer);
      done(data);
    }
  });
}
async function probeTentPresence(options) {
  try {
    await resolveWorkspacePaths({
      cwd: options.cwd,
      workspace: options.workspace
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!options.workspace) {
      const systemRoot = await findTentSystemRoot(options.cwd || process.cwd());
      if (!systemRoot) {
        return { ok: false, message: NOT_INSIDE_TENT_MESSAGE };
      }
    }
    return { ok: false, message };
  }
}
function silentOutsideResult(kind, json) {
  const payload = kind === "enter" ? { skipped: true, reason: "not-a-tent-workspace", session: null } : kind === "status" ? {
    skipped: true,
    reason: "not-a-tent-workspace",
    sessions: [],
    incompleteTasks: []
  } : {
    skipped: true,
    reason: "not-a-tent-workspace",
    left: false,
    alreadyLeft: true,
    incompleteTasks: [],
    delivered: false,
    accepted: false
  };
  if (json) {
    return { exitCode: 0, stdout: JSON.stringify(payload) + "\n", stderr: "" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}
function formatEnter(result) {
  const row = result;
  const s = row.session ?? {};
  return `\u2713 External session enter
sessionId: ${s.sessionId ?? "?"}
state: ${s.state ?? "external"}
` + (s.externalKey ? `externalKey: ${s.externalKey}
` : "") + (s.roleName ? `role: ${s.roleName}
` : "") + (s.profileId ? `profileId: ${s.profileId}
` : "") + (row.reused != null ? `reused: ${row.reused}
` : "");
}
function formatStatus(result) {
  const row = result;
  const lines = [];
  if (row.session) {
    const s = row.session;
    lines.push(
      `sessionId: ${s.sessionId ?? "?"}`,
      `state: ${s.state ?? "?"}`,
      `alive: ${s.alive ?? false}`,
      ...s.externalKey ? [`externalKey: ${s.externalKey}`] : [],
      ...s.roleName ? [`role: ${s.roleName}`] : [],
      ...s.lastTaskId ? [`lastTaskId: ${s.lastTaskId}`] : [],
      ...row.open != null ? [`open: ${row.open}`] : []
    );
  } else if (row.sessions) {
    lines.push(`externalSessions: ${row.sessions.length}`);
    for (const s of row.sessions) {
      lines.push(
        `- ${s.sessionId ?? "?"} state=${s.state ?? "?"}` + (s.externalKey ? ` key=${s.externalKey}` : "") + (s.roleName ? ` role=${s.roleName}` : "")
      );
    }
  }
  const tasks = row.incompleteTasks ?? [];
  lines.push("", `incompleteTasks: ${tasks.length}`);
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? t.id ?? "?"} state=${t.state ?? "?"} role=${t.role ?? "?"}`
    );
  }
  return lines.join("\n") + "\n";
}
function formatLeave(result) {
  const row = result;
  const tasks = row.incompleteTasks ?? [];
  const lines = [
    `\u2713 External session leave`,
    `sessionId: ${row.sessionId ?? "?"}`,
    ...row.externalKey ? [`externalKey: ${row.externalKey}`] : [],
    `state: ${row.state ?? "stopped"}`,
    `left: ${row.left ?? false}`,
    ...row.alreadyLeft ? [`alreadyLeft: true`] : [],
    `delivered: ${row.delivered ?? false}`,
    `accepted: ${row.accepted ?? false}`,
    "",
    `incompleteTasks: ${tasks.length}`
  ];
  for (const t of tasks) {
    lines.push(
      `- ${t.path ?? "?"} state=${t.state ?? "?"} role=${t.role ?? "?"}`
    );
  }
  if (tasks.length > 0) {
    lines.push(
      "",
      "Note: leave did not deliver/accept. Finish incomplete tasks with tent task deliver / accept as needed."
    );
  }
  return lines.join("\n") + "\n";
}
function okPrint2(result, json, human) {
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : human(result);
  return { exitCode: 0, stdout, stderr: "" };
}
function failUsage2(msg) {
  return { exitCode: 1, stdout: "", stderr: msg + "\n" };
}
function pathResolve(cwd) {
  if (!cwd) return void 0;
  return cwd;
}
function parseAgentFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

// src/cli/proposal-rpc.ts
async function runProposalSubmit(args, globals = {}) {
  try {
    const attachOpts = {
      dataDir: globals.dataDir,
      attachOnly: globals.attachOnly === true,
      serviceEntry: globals.serviceEntry,
      packageRoot: globals.packageRoot,
      env: globals.env
    };
    const client = globals.client ?? (await attachOrBootstrapService(attachOpts)).client;
    const ctx = await ensureMountedWorkspace(client, {
      cwd: globals.cwd,
      workspace: globals.workspace
    });
    const result = await client.proposalSubmit(ctx.workspaceId, {
      boxId: args.boxId,
      role: args.role,
      body: args.body
    });
    const proposalPath2 = result.proposal?.path;
    if (!proposalPath2) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "proposal.submit returned no proposal path\n"
      };
    }
    return {
      exitCode: 0,
      stdout: `\u2713 Proposal submitted for triage: ${proposalPath2}
`,
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message + "\n" };
  }
}

// src/cli/tent.ts
var LEGACY_MUTATION_COMMANDS = /* @__PURE__ */ new Set([
  "dispatch",
  "task-ack",
  "task-cancel",
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
Allowed without Service: read-only tree/status/roles/find/tags; init/derived new/migrate/role-init/skill-install/agent-hooks.
External (non-${TENT_SYSTEM_DIR}) Tent roots still accept legacy mutation commands during the migration window.`;
}
async function makeEnv() {
  const systemRoot = await findTentSystemRoot(process.cwd());
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  return {
    fs: new NodeFs(systemRoot),
    clock: new SystemClock(),
    tentName: path8.basename(workspace ?? systemRoot),
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
    if (positionals.length > 0) return fail("Usage: tent skill-install [--target all|claude|shared-agents] [--force]");
    const target = flags.target || "all";
    const force = flags.force === "true";
    const defaultDirs = resolveCliSkillInstallDirs(target);
    const targetDirs = flags.dir ? [flags.dir] : defaultDirs;
    const results = await installSkills({
      packageRoot: packageRoot(),
      targetDirs,
      force
    });
    console.log(formatSkillInstallResults(target, results));
    return;
  }
  if (cmd === "agent-hooks") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(agentHooksHelpText());
      return;
    }
    if (sub !== "install" && sub !== "doctor" && sub !== "remove") {
      return fail(
        `Unknown agent-hooks subcommand: ${sub}
Usage: tent agent-hooks install|doctor|remove [--agent all|claude|codex|agy|copilot] [--json]`
      );
    }
    const { positionals, flags } = parseFlags(rest);
    if (positionals.length > 0) {
      return fail(
        `Usage: tent agent-hooks ${sub} [--agent all|claude|codex|agy|copilot] [--json]`
      );
    }
    let agents;
    try {
      agents = flags.agent ? resolveAgentHookSelection([flags.agent]) : void 0;
      if (flags.agent && flags.agent !== "all") parseAgentHookId(flags.agent);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const asJson = flags.json === "true";
    const home = flags.home || void 0;
    const tentCommand = flags["tent-command"] || flags.tentCommand || void 0;
    const runOpts = { agents, home, tentCommand };
    const batch = sub === "install" ? await installAgentHooks(runOpts) : sub === "doctor" ? await doctorAgentHooks(runOpts) : await removeAgentHooks(runOpts);
    if (asJson) {
      console.log(JSON.stringify(batch, null, 2));
    } else {
      console.log(formatAgentHooksResults(batch));
    }
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
        sourceRoot: path8.resolve(source),
        workspaceRoot: path8.resolve(workspace),
        createFs: (root) => new NodeFs(root),
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
  if (cmd === "agent") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(agentHelpText());
      return;
    }
    const result = await runAgentCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  const tentCommands = /* @__PURE__ */ new Set([
    ...LEGACY_MUTATION_COMMANDS,
    ...LEGACY_READONLY_COMMANDS,
    "role-init",
    "propose"
  ]);
  if (!tentCommands.has(cmd)) {
    return fail(
      `Unknown command: ${cmd || "(empty)"}
Commands: new migrate import task agent agent-hooks role-init roles dispatch task-ack task-cancel propose complete stamp status grant-readable new-box tag untag tag-new tag-rm tags find fork clean-temp force-release okf-sync skill-install tree`
    );
  }
  const env = await makeEnv();
  if (!cmd) return fail("Unknown command: (empty)");
  const systemRoot = env.tentRoot;
  if (!systemRoot) return fail(NOT_INSIDE_TENT_MESSAGE);
  if (cmd === "propose" && isInWorkspaceSystemRoot(systemRoot)) {
    const { positionals } = parseFlags(args);
    const [boxId, bodySource] = positionals;
    if (!boxId || !bodySource) {
      return fail("Usage: tent propose <boxId> <bodyFile|->");
    }
    if (positionals.length > 2) return fail("Usage: tent propose <boxId> <bodyFile|->");
    const role = process.env.TENT_ROLE;
    if (!role) return fail("tent propose requires TENT_ROLE to identify the submitting role");
    const body = bodySource === "-" ? await readStdin() : await readBodyFile(bodySource);
    const workspace = workspaceRootFromSystemRoot(systemRoot);
    const result = await runProposalSubmit(
      { boxId, role, body },
      {
        cwd: workspace ?? process.cwd(),
        workspace: workspace ?? void 0,
        packageRoot: packageRoot()
      }
    );
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
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
        if (dispatcher === role) return fail("--as-sub parent role must not equal the assignee itself");
        const registry = await loadRolesRegistry(env.fs);
        if (!registry.roles.some((item) => item.name === dispatcher)) {
          return fail(`--as-sub parent role not found in registry: ${dispatcher}`);
        }
        const dispatcherWorkspace = await ensureRoleWorkspace(workspacePath, dispatcher);
        workspace = { ...workspace ?? await ensureRoleWorkspace(workspacePath, role), targetBranch: dispatcherWorkspace.branch };
      }
      const parentActor = dispatcher && dispatcher !== "user" ? { kind: "role", id: dispatcher } : { kind: "user", id: "user" };
      const r = await dispatch(env, boxId, role, {
        userPrompt: localPrompt,
        workspace,
        parentActor,
        reviewer: parentActor,
        asSub: flags["as-sub"] === "true"
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
      return fail(
        "complete is retired: Node owner/status dual-write is removed. Use tent task deliver/accept (or task.fail)."
      );
    }
    case "stamp": {
      return fail(
        "stamp is retired: Node owner/status dual-write is removed. Use tent task deliver/accept (or task.fail)."
      );
    }
    case "status": {
      if (args.length > 0) return fail("Usage: tent status");
      try {
        process.stdout.write(
          await renderTentStatus(process.cwd(), process.env.TENT_ROLE, (root) => new NodeFs(root))
        );
      } catch (error) {
        if (error instanceof Error && error.message === NOT_INSIDE_TENT_MESSAGE) return fail(error.message);
        throw error;
      }
      break;
    }
    case "grant-readable": {
      return fail(
        "grant-readable is retired in V0.2: Node readable/writable axes are removed; use Task context pointers."
      );
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
      console.log(`\u2713 Force-released active tasks for box: ${args[0]}`);
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
  return new Promise((resolve10, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve10(data));
    process.stdin.on("error", reject);
  });
}
async function readBodyFile(bodySource) {
  const resolved = path8.resolve(bodySource);
  if (!await existsPath2(resolved)) throw new Error(`Body file not found: ${bodySource}.`);
  return fs9.readFile(resolved, "utf8");
}
function printBox(box, depth) {
  const ind = "  ".repeat(depth);
  const mode = box.archived ? " archived" : "";
  const type = box.type;
  const id = box.id || "missing-id";
  const invalid = box.invalid ? ` invalid:${box.invalidReason || "invalid"}` : "";
  console.log(`${ind}${box.name} [${type} ${id}]${mode}${invalid}`);
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
function agentHooksHelpText() {
  return `tent agent-hooks \u2014 machine-local native hook/config projection (V0.2)

Usage:
  tent agent-hooks install [--agent all|claude|codex|agy|copilot] [--json]
  tent agent-hooks doctor  [--agent all|claude|codex|agy|copilot] [--json]
  tent agent-hooks remove  [--agent all|claude|codex|agy|copilot] [--json]

Behavior:
  - SessionStart \u2192 tent agent session-start --host <agent>
  - Stop         \u2192 tent agent session-end --host <agent>
  - CLI hook aliases parse session identity/cwd from native hook stdin and
    silently skip non-Tent workspaces (leave never needs a sessionId positional).
  - Merges into existing agent configs; never rewrites permissions or MCP.
  - install / doctor / remove are idempotent; remove only Tent-managed handlers.
  - Antigravity (agy) and Copilot report unsupported when no verified lifecycle hook surface exists.
  - Projection only writes under --home (tests) or os.homedir(); never smoke real user configs.

Options:
  --agent <id>     Target agent (default: all). Alias: agy \u2192 antigravity.
  --json           Machine-readable result.
  --home <path>    Override home for config roots (tests / isolated fixtures only).
  --tent-command <cmd>  Override tent entry used in projected commands (tests).
`;
}
function formatSkillInstallResults(target, results) {
  const byDir = /* @__PURE__ */ new Map();
  for (const item of results) {
    const list = byDir.get(item.targetDir) ?? [];
    list.push(item);
    byDir.set(item.targetDir, list);
  }
  const lines = [`\u2713 skill-install (${target})`];
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
  const here = path8.dirname(fileURLToPath2(import.meta.url));
  if (path8.basename(here) === "cli" && path8.basename(path8.dirname(here)) === "src") {
    return path8.resolve(here, "../..");
  }
  return here;
}
async function existsPath2(target) {
  try {
    await fs9.access(target);
    return true;
  } catch {
    return false;
  }
}
async function packageVersion() {
  const pkg = JSON.parse(await fs9.readFile(path8.join(packageRoot(), "package.json"), "utf8"));
  return String(pkg.version ?? "0.0.0");
}
function helpText() {
  return `Tent CLI

Usage:
  tent <command> [args]

Run commands from a workspace with <workspace>/.tent/ (or legacy external tent root) unless noted.

Service-backed collaboration (required for Desktop / in-workspace mutates):
  tent task list|get|claim|deliver|\u2026  Attach Local Service \u2192 mount \u2192 task.* RPC
  tent task --help                    Full task subcommand help
  tent agent enter|status|leave       External session lifecycle (no ACP spawn)
  tent agent --help                   Pull-host enter/status/leave + hook aliases
  propose <boxId> <file|->            Submit a proposal (in-workspace \u2192 proposal.submit RPC)
  CLI exit does not stop Local Service. Token stays in machine-local service.json.

Init / machine config (always allowed):
  new <path>                         Create an empty in-workspace Tent at <path>/.tent.
  new <name> --vault <vault>         Create a Tent under the vault's configured tents root.
  migrate --source <root> --workspace <ws>
                                     Copy legacy external tent root into <ws>/.tent (alias: import).
                                     Refuses if <ws>/.tent exists. Never deletes source.
                                     Options: --dry-run --force --json
  skill-install [--target all|claude|shared-agents] [--force]
                                     Install bundled skills to selected machine roots.
  agent-hooks install|doctor|remove [--agent all|claude|codex|agy|copilot]
                                     Project Tent-managed SessionStart/Stop hooks into
                                     verified agent configs (no permissions / MCP).
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
  complete|stamp                     Retired (no Node owner/status dual-write; use task.*).
  force-release <boxId>              Interrupt/cancel active tasks for the box (no FM write).
  grant-readable                     Retired (V0.2: no Node R/W axes).
  new-box <name> <type> [parentId]   Create a box (type: goal|prompt|output[-secondary]).
  tag|untag <boxId> <tag>            Add or remove a tag.
  tag-new | tag-rm                   Manage the tag registry.
  fork <boxId>                       Copy a box subtree with new ids.
  clean-temp [role]                  Remove temp state for one role or all roles.
  okf-sync                           Regenerate OKF indexes and projected links.
  propose <boxId> <file|->           External roots only: direct-core proposal submit.

Options:
  -h, --help                         Show this help.
  -v, --version                      Show the package version.
`;
}
async function readVaultPluginSettings(vault) {
  const fsmod = await import("node:fs/promises");
  const dataPath = path8.join(path8.resolve(vault), ".obsidian", "plugins", "tent", "data.json");
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
    target = path8.join(path8.resolve(vault), pluginSettings.tentsRoot, target);
  }
  const workspaceRoot = path8.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${workspaceRoot}`);
  await fsmod.mkdir(workspaceRoot, { recursive: true });
  const name = path8.basename(workspaceRoot);
  const fallbackRules = `# ${name} - Project Rules

> Local project rules for this Tent; edit freely.
> Mechanism-level rules live in the Tent repository docs/SPEC.md; agent behavior contracts live in the tent-role and tent-task skills.

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
    `\u2713 Created Tent: ${path8.join(workspaceRoot, ".tent")}
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
var entry = process.argv[1] ? path8.resolve(process.argv[1]) : "";
var thisFile = path8.resolve(fileURLToPath2(import.meta.url));
var normalizeEntryPath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
void (async () => {
  if (!entry) return;
  const realEntry = await fs9.realpath(entry).catch(() => entry);
  const realThisFile = await fs9.realpath(thisFile).catch(() => thisFile);
  const isDirectEntry = normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile) || normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile.replace(/\.ts$/i, ".js"));
  if (!isDirectEntry) return;
  await main();
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
export {
  inWorkspaceLegacyMutationMessage,
  isInWorkspaceSystemRoot,
  isLegacyMutationCommand,
  listLegacyMutationCommands
};
