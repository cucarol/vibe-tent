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

// src/core/paths.ts
function workspaceRootFromSystemRoot(systemRoot) {
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base2 = normalized.split(/[\\/]/).pop() ?? "";
  if (base2 !== TENT_SYSTEM_DIR) return void 0;
  const parent = normalized.replace(/[\\/]+[^\\/]+$/, "");
  return parent || void 0;
}
function isOperationalPath(relativePath4) {
  const path = relativePath4.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path) return false;
  const top = path.split("/")[0] ?? "";
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

// src/core/adapter.ts
function withTentMutation(fs2, action) {
  return fs2.withLock ? fs2.withLock(MUTATION_LOCK_PATH, action) : action();
}
var init_adapter = __esm({
  "src/core/adapter.ts"() {
    "use strict";
    init_paths();
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
async function backupCorruptRegistry(fs2, path) {
  const backupPath = `${path}.corrupt-${timestamp()}`;
  await fs2.writeFile(backupPath, await fs2.readFile(path));
  return backupPath;
}
function warnRegistryRecovered(path, backupPath, action, extra = "") {
  console.error(
    `WARNING: ${path} was corrupt; backed up to ${backupPath} and ${action}. Review it.${extra ? ` ${extra}` : ""}`
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

// src/core/order.ts
async function loadOrder(fs2) {
  if (!await fs2.exists(ORDER_PATH)) return {};
  try {
    return JSON.parse(await fs2.readFile(ORDER_PATH));
  } catch {
    const backupPath = await backupCorruptRegistry(fs2, ORDER_PATH);
    await saveOrder(fs2, {});
    warnRegistryRecovered(ORDER_PATH, backupPath, "recovered");
    return {};
  }
}
async function saveOrder(fs2, map) {
  await fs2.writeFile(ORDER_PATH, JSON.stringify(map, null, 2) + "\n");
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
function joinType(base2, modifier) {
  return modifier ? `${base2}-${modifier}` : base2;
}
function isCanonicalPrimary(name) {
  return CANONICAL_PRIMARY_TYPES.includes(name);
}
function isBuiltinSecondary(name) {
  return BUILTIN_SECONDARY_TYPES.includes(name);
}
function typeExists(type, registry) {
  if (registry[type]) return true;
  const { base: base2, modifier } = splitType(type);
  const baseOk = !!registry[base2] && (registry[base2].tier ?? "base") !== "modifier";
  if (!baseOk) return false;
  if (modifier === void 0) return true;
  const mod = registry[modifier];
  return !!mod && mod.tier === "modifier";
}
async function loadTypeRegistry(fs2) {
  if (!await fs2.exists(TYPE_REGISTRY_PATH)) return cloneDefaults();
  try {
    const parsed = JSON.parse(await fs2.readFile(TYPE_REGISTRY_PATH));
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
  return join2(boxPath, baseName(boxPath) + ".md");
}
async function loadTent(fs2) {
  const byId = /* @__PURE__ */ new Map();
  const byPath = /* @__PURE__ */ new Map();
  const roots = [];
  const typeRegistry = await loadTypeRegistry(fs2);
  const top = await fs2.listDir("");
  for (const entry of top) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    if (isSystemNoteName(entry.name)) continue;
    await loadBoxInto(fs2, entry.name, null, typeRegistry, roots);
  }
  const order = await loadOrder(fs2);
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
async function reloadLoadedBox(fs2, tent, path) {
  const box = tent.byPath.get(path);
  if (!box) throw new Error(`Box not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs2.readFile(boxNotePath(path)));
  const identity = normalizeIdentity(data);
  if (identity.fm.id !== box.id) throw new Error("Incremental reload cannot change box id.");
  box.type = identity.fm.type;
  box.tags = identity.tags;
  box.relations = identity.relations;
  box.fm = identity.fm;
  box.body = body;
  for (const root of tent.roots) resolveSubtree(root, tent.typeRegistry);
  return box;
}
function sortChildren(box, order) {
  box.children = sortByOrder(box.children, order[box.id], (a, b) => a.name.localeCompare(b.name));
  for (const c of box.children) sortChildren(c, order);
}
async function loadBox(fs2, path, parent, registry) {
  if (isOperationalPath(path)) return null;
  const boxFile = boxNotePath(path);
  if (!await fs2.exists(boxFile)) {
    return null;
  }
  const raw = await fs2.readFile(boxFile);
  let parsed;
  let parseError;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    parsed = { data: {}, body: raw, keyOrder: [] };
  }
  const { data, body } = parsed;
  const name = baseName(path);
  const { fm, tags, relations } = normalizeIdentity(data);
  const box = {
    id: fm.id,
    type: fm.type,
    tags,
    relations,
    mode: "editable",
    archived: false,
    invalid: !!parseError,
    path,
    name,
    fm,
    body,
    children: [],
    parent
  };
  if (parseError) {
    box.invalidRootId = path;
    box.invalidReason = `Invalid frontmatter: ${parseError}`;
  }
  const sub = await fs2.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs2, join2(path, entry.name), box, registry, box.children);
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
function isExplicitArchiveRoot(box) {
  return box.fm.mode === "archived";
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
async function loadBoxInto(fs2, path, parent, registry, target) {
  if (isOperationalPath(path)) return;
  const box = await loadBox(fs2, path, parent, registry);
  if (box) {
    target.push(box);
    return;
  }
  const sub = await fs2.listDir(path);
  for (const entry of sub) {
    if (!entry.isDir) continue;
    if (OPERATIONAL_TOP_LEVEL.has(entry.name)) continue;
    await loadBoxInto(fs2, join2(path, entry.name), parent, registry, target);
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

// src/core/tags.ts
async function loadTagRegistry(fs2) {
  if (!await fs2.exists(TAGS_REGISTRY_PATH)) return { tags: [] };
  try {
    return normalizeRegistry2(JSON.parse(await fs2.readFile(TAGS_REGISTRY_PATH)));
  } catch {
    const backupPath = await backupCorruptRegistry(fs2, TAGS_REGISTRY_PATH);
    const recovered = await recoverTagRegistryFromBoxes(fs2);
    await saveTagRegistryUnlocked(fs2, recovered);
    warnRegistryRecovered(TAGS_REGISTRY_PATH, backupPath, "recovered");
    return recovered;
  }
}
async function saveTagRegistryUnlocked(fs2, registry) {
  await fs2.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(normalizeRegistry2(registry), null, 2) + "\n");
}
async function addRegistryTag(fs2, name) {
  await withTentMutation(fs2, async () => addRegistryTagUnlocked(fs2, name));
}
async function addRegistryTagUnlocked(fs2, name) {
  const tag = normalizeTagName(name);
  const registry = await loadTagRegistry(fs2);
  if (!registry.tags.includes(tag)) {
    registry.tags.push(tag);
    await saveTagRegistryUnlocked(fs2, registry);
  }
}
async function addTag(fs2, boxId, name) {
  await withTentMutation(fs2, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs2);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    assertContentMutable(box, "tagged");
    await addRegistryTagUnlocked(fs2, tag);
    const tags = uniqueSorted([...box.tags, tag]);
    await writeBoxTags(fs2, box, tags);
  });
}
async function removeTag(fs2, boxId, name) {
  await withTentMutation(fs2, async () => {
    const tag = normalizeTagName(name);
    const tent = await loadTent(fs2);
    if (tent.duplicateIds.has(boxId)) throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
    const box = tent.byId.get(boxId);
    if (!box) throw new Error(`Box not found: ${boxId}.`);
    if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot be tagged.");
    assertContentMutable(box, "tagged");
    await writeBoxTags(fs2, box, box.tags.filter((item) => item !== tag));
  });
}
async function removeRegistryTag(fs2, name) {
  await withTentMutation(fs2, async () => {
    const tag = normalizeTagName(name);
    const registry = await loadTagRegistry(fs2);
    await saveTagRegistryUnlocked(fs2, { tags: registry.tags.filter((item) => item !== tag) });
    const tent = await loadTent(fs2);
    for (const box of tent.byId.values()) {
      if (box.tags.includes(tag)) {
        await writeBoxTags(fs2, box, box.tags.filter((item) => item !== tag));
      }
    }
  });
}
async function syncTagRegistryAfterBoxTagsChangeUnlocked(fs2, previousTags, nextTags) {
  const previous = new Set(normalizeTagList(previousTags));
  const next = normalizeTagList(nextTags);
  const added = next.filter((tag) => !previous.has(tag));
  for (const tag of added) {
    await addRegistryTagUnlocked(fs2, tag);
  }
}
function normalizeTagName(name) {
  const tag = name.trim();
  if (!tag) throw new Error("Tag name cannot be empty.");
  if (/[\/\\\r\n]/.test(tag)) throw new Error("Tag name cannot contain path separators or newlines.");
  return tag;
}
async function writeBoxTags(fs2, box, tags) {
  const path = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs2.readFile(path));
  const next = uniqueSorted(tags);
  if (next.length === 0) delete data.tags;
  else data.tags = next;
  await fs2.writeFile(path, serializeFrontmatter(data, body, boxKeyOrder(keyOrder)));
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
async function recoverTagRegistryFromBoxes(fs2) {
  const tent = await loadTent(fs2);
  const tags = [];
  for (const box of tent.byPath.values()) {
    tags.push(...box.tags);
  }
  return { tags: uniqueSorted(tags) };
}
function normalizeTagList(values) {
  const tags = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const tag = normalizeTagName(value);
      if (!tags.includes(tag)) tags.push(tag);
    } catch {
    }
  }
  return uniqueSorted(tags);
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
var init_tags = __esm({
  "src/core/tags.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_tree();
    init_registryRecovery();
    init_paths();
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
var ALPHABET, CONCEPT_ID_PREFIX, ROLE_ID_PREFIX;
var init_id = __esm({
  "src/core/id.ts"() {
    "use strict";
    ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
    CONCEPT_ID_PREFIX = "cx-";
    ROLE_ID_PREFIX = "rl-";
  }
});

// src/core/skillRoleRegistry.ts
async function loadRolesRegistry(fs2) {
  const { registry } = await readRolesRegistryState(fs2);
  return registry;
}
async function loadRolesRegistryForMutation(fs2) {
  return loadRolesRegistry(fs2);
}
async function readRolesRegistryState(fs2) {
  if (!await fs2.exists(ROLES_REGISTRY_PATH)) {
    return { registry: cloneDefaultRoles(), migrated: false, recovered: false };
  }
  try {
    const rawText = await fs2.readFile(ROLES_REGISTRY_PATH);
    const parsed = JSON.parse(rawText);
    const { registry, migrated } = normalizeRolesRegistryWithMigration(parsed);
    return { registry, migrated, recovered: false };
  } catch {
    const backupPath = await backupCorruptRegistry(fs2, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs2, ROLES_REGISTRY_PATH, serializeRolesRegistry(reset));
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return { registry: reset, migrated: false, recovered: true };
  }
}
async function createRole(fs2, definition, rand = Math.random) {
  await withTentMutation(fs2, async () => {
    const registry = await loadRolesRegistryForMutation(fs2);
    const usedIds = roleIdSet(registry.roles);
    const role = normalizeRoleDefinition(definition, {
      usedIds,
      assignMissingId: "random",
      rand
    });
    if (!role.name) throw new Error("Role name cannot be empty.");
    assertRoleNameAvailable(role.name);
    if (registry.roles.some((item) => item.name === role.name)) {
      throw new Error(`Role already exists: ${role.name}.`);
    }
    if (registry.roles.some((item) => item.id === role.id)) {
      throw new Error(`Role id already exists: ${role.id}.`);
    }
    registry.roles.push(role);
    await writeJson(fs2, ROLES_REGISTRY_PATH, serializeRolesRegistry(registry));
  });
}
function assertRoleNameAvailable(name) {
  if (name.trim().toLowerCase() === AGENT_PROFILES_TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${AGENT_PROFILES_TEMP_DIR}.`);
  }
}
async function updateRole(fs2, ref, patch) {
  await withTentMutation(fs2, async () => {
    const registry = await loadRolesRegistryForMutation(fs2);
    const index = findRoleIndex(registry.roles, ref);
    if (index === -1) throw new Error(`Role does not exist: ${ref}.`);
    const current = registry.roles[index];
    if (patch.id !== void 0 && patch.id !== current.id) {
      throw new Error("Role id is immutable.");
    }
    if (patch.name !== void 0 && patch.name.trim() !== current.name) {
      throw new Error(
        "Role operational name cannot be renamed in this batch (temp/path migration is deferred); change displayName instead."
      );
    }
    const next = normalizeRoleDefinition(
      {
        ...current,
        ...patch,
        id: current.id,
        name: current.name
      },
      { usedIds: roleIdSet(registry.roles, current.id), assignMissingId: "keep" }
    );
    if (Object.prototype.hasOwnProperty.call(patch, "allowedProfiles")) {
      const normalized = normalizeAllowedProfiles(patch.allowedProfiles);
      if (normalized) next.allowedProfiles = normalized;
      else delete next.allowedProfiles;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "displayName")) {
      const dn = typeof patch.displayName === "string" ? patch.displayName.trim() : "";
      next.displayName = dn || current.name;
    }
    registry.roles[index] = next;
    await writeJson(fs2, ROLES_REGISTRY_PATH, serializeRolesRegistry(registry));
  });
}
async function deleteRole(fs2, ref, confirmation) {
  await withTentMutation(fs2, async () => {
    const registry = await loadRolesRegistryForMutation(fs2);
    const index = findRoleIndex(registry.roles, ref);
    if (index === -1) throw new Error(`Role does not exist: ${ref}.`);
    const role = registry.roles[index];
    if (confirmation !== role.name && confirmation !== role.id) {
      throw new Error(
        `Confirmation mismatch; enter the role name ${role.name} or id ${role.id}.`
      );
    }
    registry.roles.splice(index, 1);
    await writeJson(fs2, ROLES_REGISTRY_PATH, serializeRolesRegistry({ roles: registry.roles }));
  });
}
function findRoleIndex(roles, ref) {
  const key = typeof ref === "string" ? ref.trim() : "";
  if (!key) return -1;
  let idx = roles.findIndex((role) => role.id === key);
  if (idx !== -1) return idx;
  return roles.findIndex((role) => role.name === key);
}
function normalizeRolesRegistryWithMigration(value) {
  const root = isRecord4(value) ? value : {};
  const roles = [];
  let migrated = false;
  const usedIds = /* @__PURE__ */ new Set();
  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord4(item)) continue;
      const hadId = typeof item.id === "string" && isRoleId(item.id.trim());
      const hadDisplayName = typeof item.displayName === "string" && item.displayName.trim().length > 0;
      const role = normalizeRoleDefinition(item, {
        usedIds,
        assignMissingId: "deterministic"
      });
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      if (roles.some((existing) => existing.id === role.id)) continue;
      if (!hadId || !hadDisplayName) migrated = true;
      usedIds.add(role.id);
      roles.push(role);
    }
  }
  return { registry: { roles }, migrated };
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
  const allowedProfiles = normalizeAllowedProfiles(value.allowedProfiles);
  if (allowedProfiles) role.allowedProfiles = allowedProfiles;
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
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
function roleIdSet(roles, exceptId) {
  const set = /* @__PURE__ */ new Set();
  for (const role of roles) {
    if (!role.id) continue;
    if (exceptId && role.id === exceptId) continue;
    set.add(role.id);
  }
  return set;
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
      if (role.allowedProfiles && role.allowedProfiles.length > 0) {
        row.allowedProfiles = [...role.allowedProfiles];
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
async function writeJson(fs2, path, value) {
  if (!await fs2.exists(".tent")) await fs2.mkdir(".tent");
  await fs2.writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var DEFAULT_ROLES_REGISTRY;
var init_skillRoleRegistry = __esm({
  "src/core/skillRoleRegistry.ts"() {
    "use strict";
    init_adapter();
    init_id();
    init_registryRecovery();
    init_paths();
    DEFAULT_ROLES_REGISTRY = {
      roles: []
    };
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
function userTaskActors() {
  return {
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" }
  };
}
function roleTaskActors(roleName) {
  const id = roleName.trim();
  if (!id || id === "user") {
    throw new TaskLifecycleError(
      "INVALID_ACTOR",
      "Role parent/reviewer requires a durable role name (not user)."
    );
  }
  return {
    parentActor: { kind: "role", id },
    reviewer: { kind: "role", id }
  };
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
  const reviewer = input.reviewer;
  if (!reviewer) {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} requires an explicit Task.reviewer (parent-reviewer wire).`
    );
  }
  if (actor === "user") return;
  if (reviewer.kind === "user") {
    throw new TaskLifecycleError(
      "REVIEW_FORBIDDEN",
      `task.${action} on user-reviewed task requires actor user; got ${actor}.`
    );
  }
  if (actor === reviewer.id) return;
  throw new TaskLifecycleError(
    "REVIEW_FORBIDDEN",
    `task.${action} requires actor user or reviewer role (${reviewer.id}); got ${actor}.`
  );
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

// src/core/claim.ts
function envelopeIsActiveOccupation(task) {
  const state = task.state || (task.status === "pending" || task.status === "taken" ? legacyStatusToState(task.status) : "failed");
  return isActiveTaskState(state);
}
function canClaim(box, options) {
  const structural = structuralClaimGate(box);
  if (!structural.ok) return structural;
  const tasks = options?.tasks;
  const tent = options?.tent;
  if (!tasks || tasks.length === 0 || !tent) {
    return { ok: true };
  }
  const allowAncestorBy = (options?.allowAncestorClaimedBy || "").trim();
  const hit = findActiveOccupation(tent, box, tasks, {
    allowAncestorClaimedBy: allowAncestorBy || void 0
  });
  if (!hit) return { ok: true };
  return {
    ok: false,
    blocker: hit.blocker,
    task: hit.task,
    reason: hit.reason
  };
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
function findActiveOccupation(tent, box, tasks, options) {
  const allowAncestorBy = (options?.allowAncestorClaimedBy || "").trim();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      if (claimId === "root") {
        return {
          blocker: box,
          task,
          relation: "root",
          reason: `Tent root is occupied by active task for ${task.role}.`
        };
      }
      const claimed = tent.byId.get(claimId);
      if (!claimed) continue;
      if (claimed.id === box.id) {
        return {
          blocker: claimed,
          task,
          relation: "self",
          reason: `${box.name} is already occupied by active task for ${task.role}.`
        };
      }
      if (isAncestor(claimed, box)) {
        if (allowAncestorBy && task.role === allowAncestorBy) {
          continue;
        }
        return {
          blocker: claimed,
          task,
          relation: "ancestor",
          reason: `Ancestor ${claimed.name} is occupied by active task for ${task.role}.`
        };
      }
      if (isAncestor(box, claimed)) {
        return {
          blocker: claimed,
          task,
          relation: "descendant",
          reason: `Descendant ${claimed.name} is occupied by active task for ${task.role}.`
        };
      }
    }
  }
  return void 0;
}
function findAnyActiveTask(tasks) {
  return tasks.find((t) => envelopeIsActiveOccupation(t));
}
function occupiedBoxesFromTasks(tent, tasks) {
  const out = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      if (claimId === "root") continue;
      const box = tent.byId.get(claimId);
      if (box) out.set(box.id, box);
    }
  }
  return [...out.values()];
}
function isFrozen(box) {
  return box.invalid || box.archived;
}
function isAncestor(ancestor, child) {
  let parent = child.parent;
  while (parent) {
    if (parent.id === ancestor.id) return true;
    parent = parent.parent;
  }
  return false;
}
var init_claim = __esm({
  "src/core/claim.ts"() {
    "use strict";
    init_task_model();
  }
});

// src/core/task.ts
async function loadTaskEnvelopes(fs2) {
  const tasks = [];
  if (!await fs2.exists(TEMP_DIR)) return tasks;
  for (const entry of await fs2.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join2(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs2.exists(profilesRoot)) continue;
      for (const profileEntry of await fs2.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectTaskFiles(fs2, join2(profilesRoot, profileEntry.name, "tasks"), tasks);
      }
      continue;
    }
    await collectTaskFiles(fs2, join2(TEMP_DIR, entry.name, "tasks"), tasks);
  }
  return tasks.sort((a, b) => a.path.localeCompare(b.path));
}
async function collectTaskFiles(fs2, taskDir, tasks) {
  if (!await fs2.exists(taskDir)) return;
  for (const entry of await fs2.listDir(taskDir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    const path = join2(taskDir, entry.name);
    try {
      tasks.push(await loadTaskEnvelope(fs2, path));
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
function serializeTaskActorRef(actor) {
  return { kind: actor.kind, id: actor.id };
}
function resolveDispatchActors(input) {
  if (input.parentActor) {
    const parentActor = parseTaskActorRef(input.parentActor, "parentActor");
    const reviewer = input.reviewer ? parseTaskActorRef(input.reviewer, "reviewer") : { ...parentActor };
    return { parentActor, reviewer };
  }
  if (input.reviewer) {
    throw new Error("task.dispatch reviewer requires parentActor");
  }
  return migrateParentReviewerFromLegacy({
    asSub: input.asSub,
    dispatchedBy: input.dispatchedBy
  });
}
async function loadTaskEnvelope(fs2, path) {
  if (!await fs2.exists(path)) throw new Error(`Task envelope not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs2.readFile(path));
  if (data.type !== "task" || typeof data.role !== "string" || typeof data.manifest !== "string" || !Array.isArray(data.claims) || !data.claims.every((claim) => typeof claim === "string")) {
    throw new Error(`Invalid task envelope format: ${path}.`);
  }
  const legacyStatus = data.status === "taken" ? "taken" : "pending";
  const state = parseTaskState(data.state, legacyStatus);
  const actors = resolveActorsFromDisk(data);
  const task = {
    path,
    role: data.role,
    claims: data.claims,
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
  const deliveryPolicy = normalizeDeliveryPolicyRead(data.deliveryPolicy);
  if (deliveryPolicy) task.deliveryPolicy = deliveryPolicy;
  if (data.assigneeKind === "role" || data.assigneeKind === "agentProfile") {
    task.assigneeKind = data.assigneeKind;
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
    return {
      parentActor: parseTaskActorRef(data.parentActor, "parentActor"),
      reviewer: parseTaskActorRef(data.reviewer, "reviewer")
    };
  }
  const legacyDispatcher = typeof data.dispatchedBy === "string" ? data.dispatchedBy : void 0;
  return migrateParentReviewerFromLegacy({
    asSub: data.asSub === true,
    dispatchedBy: legacyDispatcher
  });
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
  const base2 = normalized.split(/[\\/]/).pop() ?? "";
  const workspaceRoot = base2 === ".tent" ? normalized.replace(/[\\/]+[^\\/]+$/, "") || systemRoot : systemRoot;
  return { workspaceRoot, systemRoot };
}
function formatTaskPointers(task) {
  const kind = taskAssigneeKind(task);
  const lines = [
    `Task envelope: ${task.path}`,
    `Manifest: ${task.manifest}`
  ];
  if (task.claims?.length) {
    lines.push(`claims: ${task.claims.join(", ")}`);
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
    const initCli = join2("temp", task.role, "init.md");
    const initFile = join2(".tent", "temp", task.role, "init.md");
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
  const taskFile = join2(".tent", task.path);
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
async function ensureRoleInit(fs2, role, tentName) {
  const path = join2("temp", role.name, "init.md");
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
  await fs2.writeFile(path, serializeFrontmatter({ type: "role-init", role: role.name }, body));
  return path;
}
async function writeTaskEnvelope(fs2, clock, input) {
  const userPrompt = input.userPrompt?.trim() || "";
  if (!userPrompt) throw new Error("Dispatch requires a user prompt.");
  const assigneeKind = input.assigneeKind ?? "role";
  const dir = input.tasksDir?.trim() || (assigneeKind === "agentProfile" ? agentProfileTasksDir(input.role) : join2(TEMP_DIR, input.role, "tasks"));
  await ensureDir(fs2, dir);
  const id = input.id && isTaskId(input.id) ? input.id : makeTaskId();
  const stem = taskStem(clock.now(), input.claims[0]?.id || "root");
  const path = await uniqueMarkdownPath(fs2, dir, stem);
  const now = clock.now();
  const actors = resolveDispatchActors({
    parentActor: input.parentActor,
    reviewer: input.reviewer,
    dispatchedBy: input.dispatchedBy,
    asSub: input.asSub
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
  const data = {
    type: "task",
    id,
    status: "pending",
    state: "queued",
    role: input.role,
    assigneeKind,
    parentActor: serializeTaskActorRef(actors.parentActor),
    reviewer: serializeTaskActorRef(actors.reviewer),
    claims: input.claims.map((claim) => claim.id),
    manifest: input.manifestPath,
    deliveryPolicy,
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
  await fs2.writeFile(path, serializeFrontmatter(data, body));
  return path;
}
async function ackTaskEnvelope(fs2, path) {
  await patchTaskEnvelope(fs2, path, {
    status: "taken",
    state: "running"
  });
}
async function cancelTaskEnvelope(fs2, path) {
  const task = await loadTaskEnvelope(fs2, path);
  if (task.state !== "queued" && task.status !== "pending") {
    throw new Error("Only queued (pending) task envelopes can be cancelled.");
  }
  await fs2.remove(path);
}
async function patchTaskEnvelope(fs2, path, patch) {
  if (!await fs2.exists(path)) throw new Error(`Task envelope not found: ${path}.`);
  const raw = await fs2.readFile(path);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  if (data.type !== "task") throw new Error(`Invalid task envelope format: ${path}.`);
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
  if (patch.parentActor) {
    data.parentActor = serializeTaskActorRef(
      parseTaskActorRef(patch.parentActor, "parentActor")
    );
  }
  if (patch.reviewer) {
    data.reviewer = serializeTaskActorRef(parseTaskActorRef(patch.reviewer, "reviewer"));
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
  await fs2.writeFile(path, serializeFrontmatter(data, body, keyOrder));
  return loadTaskEnvelope(fs2, path);
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
  const stamp2 = now.replace(/[^0-9A-Za-z]+/g, "").slice(0, 14) || "task";
  return `task-${stamp2}-${claimId.replace(/[^0-9A-Za-z_-]+/g, "-")}`;
}
async function uniqueMarkdownPath(fs2, dir, stem) {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const path = join2(dir, `${stem}${suffix}.md`);
    if (!await fs2.exists(path)) return path;
  }
}
async function ensureDir(fs2, path) {
  if (!await fs2.exists(path)) await fs2.mkdir(path);
}
var init_task = __esm({
  "src/core/task.ts"() {
    "use strict";
    init_frontmatter();
    init_paths();
    init_tree();
    init_task_model();
  }
});

// src/core/delivery.ts
async function loadDelivery(fs2, inputPath) {
  const path = normalizeDeliveryPath(inputPath);
  if (!await fs2.exists(path)) throw new Error(`Delivery not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs2.readFile(path));
  if (data.type !== "delivery" || typeof data.id !== "string" || !isDeliveryId(data.id)) {
    throw new Error(`Invalid delivery format: ${path}.`);
  }
  if (typeof data.taskId !== "string" || typeof data.boxId !== "string" || typeof data.role !== "string") {
    throw new Error(`Invalid delivery format: ${path}.`);
  }
  const status = parseDeliveryStatus(data.status);
  const reviewBy = typeof data.reviewBy === "string" ? data.reviewBy : void 0;
  const reviewDecision = data.reviewDecision === "accept" || data.reviewDecision === "reject" ? data.reviewDecision : void 0;
  const targetHead = normalizeTargetHead(
    typeof data.targetHead === "string" ? data.targetHead : void 0
  );
  return {
    path,
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
async function loadDeliveries(fs2, filter) {
  const out = [];
  if (!await fs2.exists(TEMP_DIR)) return out;
  for (const entry of await fs2.listDir(TEMP_DIR)) {
    if (!entry.isDir) continue;
    if (entry.name === AGENT_PROFILES_TEMP_DIR) {
      const profilesRoot = join2(TEMP_DIR, AGENT_PROFILES_TEMP_DIR);
      if (!await fs2.exists(profilesRoot)) continue;
      for (const profileEntry of await fs2.listDir(profilesRoot)) {
        if (!profileEntry.isDir) continue;
        await collectDeliveryFiles(
          fs2,
          join2(profilesRoot, profileEntry.name, "deliveries"),
          filter,
          out
        );
      }
      continue;
    }
    await collectDeliveryFiles(fs2, join2(TEMP_DIR, entry.name, "deliveries"), filter, out);
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
async function collectDeliveryFiles(fs2, dir, filter, out) {
  if (!await fs2.exists(dir)) return;
  for (const entry of await fs2.listDir(dir)) {
    if (entry.isDir || !entry.name.endsWith(".md")) continue;
    try {
      const d = await loadDelivery(fs2, join2(dir, entry.name));
      if (filter?.taskId && d.taskId !== filter.taskId) continue;
      if (filter?.boxId && d.boxId !== filter.boxId) continue;
      out.push(d);
    } catch {
    }
  }
}
async function removeNonAcceptedDeliveriesForBox(fs2, boxId) {
  for (const delivery of await loadDeliveries(fs2, { boxId })) {
    if (delivery.status === "accepted") continue;
    if (await fs2.exists(delivery.path)) await fs2.remove(delivery.path);
  }
}
async function writeDelivery(fs2, record) {
  const data = {
    type: "delivery",
    id: record.id,
    taskId: record.taskId,
    boxId: record.boxId,
    role: record.role,
    status: record.status,
    commits: record.commits,
    targetHead: record.targetHead,
    checksJson: record.checks.length ? JSON.stringify(record.checks) : void 0,
    artifactRefsJson: record.artifactRefs.length ? JSON.stringify(record.artifactRefs) : void 0,
    integrationMode: record.integrationMode,
    reviewBy: record.review?.by,
    reviewDecision: record.review?.decision,
    reviewNote: record.review?.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
  await fs2.writeFile(record.path, serializeFrontmatter(data, record.summary + "\n", KEY_ORDER));
}
function normalizeDeliveryPath(input) {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path) && !/^temp\/agent-profiles\/[^/]+\/deliveries\/dl-[^/]+\.md$/.test(path)) {
    throw new Error(
      "Delivery must point to temp/<role>/deliveries/<dl-id>.md or temp/agent-profiles/<profile>/deliveries/<dl-id>.md."
    );
  }
  return path;
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
var KEY_ORDER;
var init_delivery = __esm({
  "src/core/delivery.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_paths();
    init_tree();
    init_task_model();
    KEY_ORDER = [
      "type",
      "id",
      "taskId",
      "boxId",
      "role",
      "status",
      "commits",
      "targetHead",
      "checksJson",
      "artifactRefsJson",
      "integrationMode",
      "reviewBy",
      "reviewDecision",
      "reviewNote",
      "createdAt",
      "updatedAt"
    ];
  }
});

// src/core/output.ts
function isOutputPrimaryType(type) {
  if (!type || typeof type !== "string") return false;
  return splitType(type).base === "output";
}
function readOutputDeliveryId(fm) {
  const raw = fm[OUTPUT_PROVENANCE_FIELD];
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  return trimmed || void 0;
}
function assertOutputBindable(box, deliveryId) {
  if (!box.id) {
    throw new OutputProvenanceError("OUTPUT_INVALID", `Output has no id: ${box.path}`);
  }
  if (box.invalid) {
    throw new OutputProvenanceError(
      "OUTPUT_INVALID",
      `Output is invalid: ${box.path}`,
      { outputId: box.id, detail: box.invalidReason }
    );
  }
  if (box.archived || box.mode === "archived") {
    throw new OutputProvenanceError(
      "OUTPUT_ARCHIVED",
      `Output is archived and cannot bind provenance: ${box.id}`,
      { outputId: box.id }
    );
  }
  if (!isOutputPrimaryType(box.type)) {
    throw new OutputProvenanceError(
      "OUTPUT_NOT_OUTPUT_TYPE",
      `Node primary type must be output to bind provenance (got ${box.type}): ${box.id}`,
      { outputId: box.id, type: box.type }
    );
  }
  if (!isDeliveryId(deliveryId)) {
    throw new OutputProvenanceError(
      "INVALID_DELIVERY_ID",
      `Invalid delivery id for provenance bind: ${deliveryId}`
    );
  }
  const existing = readOutputDeliveryId(box.fm);
  if (existing && existing !== deliveryId) {
    throw new OutputProvenanceError(
      "OUTPUT_ALREADY_BOUND",
      `Output ${box.id} is already bound to ${existing}; cannot rebind to ${deliveryId}`,
      { outputId: box.id, existingDeliveryId: existing, deliveryId }
    );
  }
  return { alreadyBound: existing === deliveryId };
}
function validateOutputBindingsForAccept(tent, outputNodeIds, deliveryId) {
  if (!outputNodeIds || outputNodeIds.length === 0) {
    return { outputIds: [], boxes: [] };
  }
  if (!isDeliveryId(deliveryId)) {
    throw new OutputProvenanceError(
      "INVALID_DELIVERY_ID",
      `Invalid delivery id for provenance bind: ${deliveryId}`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const outputIds = [];
  const boxes = [];
  for (const raw of outputNodeIds) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new OutputProvenanceError(
        "INVALID_SELECTOR",
        "outputNodeIds entries must be non-empty Node ids"
      );
    }
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    if (tent.duplicateIds.has(id)) {
      throw new OutputProvenanceError(
        "OUTPUT_INVALID",
        `Duplicate box id '${id}' found; repair before binding provenance.`,
        { outputId: id }
      );
    }
    const box = tent.byId.get(id);
    if (!box) {
      throw new OutputProvenanceError("OUTPUT_NOT_FOUND", `Output Node not found: ${id}`, {
        outputId: id
      });
    }
    assertOutputBindable(box, deliveryId);
    outputIds.push(id);
    boxes.push(box);
  }
  return { outputIds, boxes };
}
async function restoreOutputBindSnapshots(fs2, snapshots) {
  if (snapshots.length === 0) return;
  const failures = [];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = snapshots[i];
    try {
      await fs2.writeFile(snap.notePath, snap.raw);
      const prev = snap.previousDeliveryId;
      if (prev === void 0) {
        delete snap.box.fm[OUTPUT_PROVENANCE_FIELD];
      } else {
        snap.box.fm[OUTPUT_PROVENANCE_FIELD] = prev;
      }
    } catch (err) {
      failures.push({
        outputId: snap.outputId,
        notePath: snap.notePath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (failures.length > 0) {
    throw new OutputProvenanceError(
      "BIND_ROLLBACK_FAILED",
      `Failed to roll back Output provenance bind for ${failures.length} file(s); disk may be partially bound.`,
      { failures }
    );
  }
}
async function bindOutputsToDeliveryUnlocked(fs2, tent, outputNodeIds, deliveryId) {
  const { outputIds, boxes } = validateOutputBindingsForAccept(tent, outputNodeIds, deliveryId);
  const planned = [];
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const outputId = outputIds[i];
    const { alreadyBound } = assertOutputBindable(box, deliveryId);
    if (alreadyBound) continue;
    const notePath = boxNotePath(box.path);
    const raw = await fs2.readFile(notePath);
    planned.push({
      box,
      outputId,
      notePath,
      raw,
      previousDeliveryId: readOutputDeliveryId(box.fm)
    });
  }
  const snapshots = [];
  const changedIds = [];
  try {
    for (const item of planned) {
      const { data, body, keyOrder } = parseFrontmatter(item.raw);
      data[OUTPUT_PROVENANCE_FIELD] = deliveryId;
      const nextRaw = serializeFrontmatter(data, body, outputKeyOrder(keyOrder));
      await fs2.writeFile(item.notePath, nextRaw);
      snapshots.push({
        outputId: item.outputId,
        notePath: item.notePath,
        raw: item.raw,
        box: item.box,
        previousDeliveryId: item.previousDeliveryId
      });
      item.box.fm[OUTPUT_PROVENANCE_FIELD] = deliveryId;
      changedIds.push(item.outputId);
    }
  } catch (err) {
    try {
      await restoreOutputBindSnapshots(fs2, snapshots);
    } catch (rollbackErr) {
      if (rollbackErr instanceof OutputProvenanceError) throw rollbackErr;
      throw new OutputProvenanceError(
        "BIND_ROLLBACK_FAILED",
        `Output provenance bind failed and rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)} (original: ${err instanceof Error ? err.message : String(err)})`,
        {
          originalError: err instanceof Error ? err.message : String(err)
        }
      );
    }
    throw err;
  }
  return { boundIds: outputIds, changedIds, snapshots };
}
function outputKeyOrder(existing) {
  const preferred = [...BOX_FRONTMATTER_KEY_ORDER, OUTPUT_PROVENANCE_FIELD];
  return [
    ...preferred,
    ...existing.filter((key) => !preferred.includes(key))
  ];
}
var OUTPUT_PROVENANCE_FIELD, OutputProvenanceError;
var init_output = __esm({
  "src/core/output.ts"() {
    "use strict";
    init_delivery();
    init_frontmatter();
    init_task();
    init_task_model();
    init_tree();
    init_typeRegistry();
    OUTPUT_PROVENANCE_FIELD = "deliveryId";
    OutputProvenanceError = class extends Error {
      constructor(code, message, details) {
        super(message);
        this.code = code;
        this.name = "OutputProvenanceError";
        this.details = details;
      }
    };
  }
});

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
    const parentRole = task.parentActor?.kind === "role" ? task.parentActor.id : void 0;
    const allowAncestorClaimedBy = taskAsSub(task) && parentRole && parentRole !== task.role ? parentRole : void 0;
    const allTasks = await loadTaskEnvelopes(env.fs);
    const peerTasks = allTasks.filter((t) => t.path !== taskPath && t.path !== task.path);
    for (const box of claimedBoxes) {
      const claimable = canClaim(box, {
        tent,
        tasks: peerTasks,
        ...allowAncestorClaimedBy ? { allowAncestorClaimedBy } : {}
      });
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
async function prepareTaskAccept(env, taskPath, options) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      reviewer: task.reviewer,
      action: "accept"
    });
    if (options.outputNodeIds && options.outputNodeIds.length > 0) {
      const tent = await loadTent(env.fs);
      validateOutputBindingsForAccept(tent, options.outputNodeIds, delivery.id);
    }
    const commits = options.commits ?? delivery.commits;
    return {
      deliveryId: delivery.id,
      deliveryPath: delivery.path,
      commits: [...commits]
    };
  });
}
async function finalizeTaskAccept(env, taskPath, options, prepared) {
  return withMutation(env.fs, async () => {
    const task = await loadTaskEnvelope(env.fs, taskPath);
    assertTransition(task.state, "accept", "accepted");
    const delivery = await requireActiveReadyDelivery(env.fs, task);
    if (delivery.id !== prepared.deliveryId) {
      throw new TaskLifecycleError(
        "NO_ACTIVE_DELIVERY",
        "Ready delivery changed during integrate; refusing accept."
      );
    }
    assertReviewAuthority({
      actor: options.actor,
      submitterRole: delivery.role,
      reviewer: task.reviewer,
      action: "accept"
    });
    const deliveryRawBefore = await env.fs.readFile(delivery.path);
    const taskRawBefore = await env.fs.readFile(taskPath);
    const tent = await loadTent(env.fs);
    let outputSnapshots = [];
    try {
      const bindResult = await bindOutputsToDeliveryUnlocked(
        env.fs,
        tent,
        options.outputNodeIds,
        delivery.id
      );
      outputSnapshots = bindResult.snapshots;
      delivery.status = "accepted";
      delivery.integrationMode = "manual-accept";
      delivery.review = { by: options.actor, decision: "accept" };
      delivery.updatedAt = env.clock.now();
      await writeDelivery(env.fs, delivery);
      const next = await patchTaskEnvelope(env.fs, taskPath, {
        state: "accepted",
        wait: null,
        updatedAt: env.clock.now()
      });
      return {
        task: next,
        delivery,
        boundOutputIds: bindResult.boundIds,
        changedOutputIds: bindResult.changedIds
      };
    } catch (err) {
      await compensateAcceptAfterOutputBind(env.fs, {
        deliveryPath: delivery.path,
        deliveryRawBefore,
        taskPath,
        taskRawBefore,
        outputSnapshots
      });
      throw err;
    }
  });
}
async function taskAccept(env, taskPath, options) {
  const prepared = await prepareTaskAccept(env, taskPath, options);
  if (prepared.commits.length > 0) {
    if (!options.integrate) {
      throw new Error("Delivery contains commits; workspace integration is required.");
    }
    await options.integrate(prepared.commits);
  }
  return finalizeTaskAccept(env, taskPath, options, prepared);
}
async function compensateAcceptAfterOutputBind(fs2, args) {
  const failures = [];
  try {
    await fs2.writeFile(args.deliveryPath, args.deliveryRawBefore);
  } catch (err) {
    failures.push(
      `delivery ${args.deliveryPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    await fs2.writeFile(args.taskPath, args.taskRawBefore);
  } catch (err) {
    failures.push(
      `task ${args.taskPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    await restoreOutputBindSnapshots(fs2, args.outputSnapshots);
  } catch (err) {
    failures.push(
      `outputs: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (failures.length > 0) {
    throw new TaskLifecycleError(
      "ACCEPT_ROLLBACK_FAILED",
      `task.accept failed after Output bind and compensating rollback also failed: ${failures.join("; ")}`
    );
  }
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
      reviewer: task.reviewer,
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
  for (const claimId of task.claims) {
    if (claimId === "root") continue;
    await removeNonAcceptedDeliveriesForBox(env.fs, claimId);
  }
}
async function requireActiveReadyDelivery(fs2, task) {
  if (task.activeDeliveryId) {
    const byId = (await loadDeliveries(fs2, { taskId: task.id || task.path })).find(
      (d) => d.id === task.activeDeliveryId
    );
    if (byId && byId.status === "ready") return byId;
    if (byId) {
    }
  }
  const ready = (await loadDeliveries(fs2, { taskId: task.id || task.path })).find((d) => d.status === "ready");
  if (!ready) {
    throw new TaskLifecycleError("NO_ACTIVE_DELIVERY", "No ready delivery for this task.");
  }
  return ready;
}
function requireBoxById(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation(fs2, action) {
  return withTentMutation(fs2, action);
}
var init_task_lifecycle = __esm({
  "src/core/task-lifecycle.ts"() {
    "use strict";
    init_adapter();
    init_claim();
    init_delivery();
    init_output();
    init_tree();
    init_task();
    init_paths();
    init_task_model();
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
    writable: dedupe(writable)
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
var init_manifest = __esm({
  "src/core/manifest.ts"() {
    "use strict";
    init_tree();
  }
});

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
var init_scaffold = __esm({
  "src/core/scaffold.ts"() {
    "use strict";
    init_frontmatter();
    init_typeRegistry();
    init_skillRoleRegistry();
    init_tags();
    init_tree();
    init_id();
    init_paths();
  }
});

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
  return withTentMutation(env.fs, async () => {
    await normalizeCopiedRootIdentity(env.fs, boxPath);
    const tent = await loadTent(env.fs);
    const root = tent.byPath.get(boxPath);
    if (!root) throw new Error(`Copied box not found: ${boxPath}.`);
    const copied = collectSubtree(root);
    const copiedPaths = new Set(copied.map((box) => box.path));
    const outsideIds = new Set(
      [...tent.byPath.values()].filter((box) => !copiedPaths.has(box.path) && box.id).map((box) => box.id)
    );
    const hasDuplicate = copied.some((box) => outsideIds.has(box.id));
    if (!hasDuplicate) return [];
    const idMap = /* @__PURE__ */ new Map();
    for (const box of copied) {
      const next = makeUniqueConceptId(outsideIds, env.rand);
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
async function normalizeCopiedRootIdentity(fs2, boxPath) {
  const expected = boxNotePath(boxPath);
  if (await fs2.exists(expected) || !await fs2.exists(boxPath)) return;
  const candidates = [];
  for (const entry of await fs2.listDir(boxPath)) {
    if (entry.isDir || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
    const candidate = join2(boxPath, entry.name);
    const { data } = parseFrontmatter(await fs2.readFile(candidate));
    if (typeof data.id === "string" && (data.id.startsWith("bx-") || data.id.startsWith("cx-")) && typeof data.type === "string") {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 1) await fs2.move(candidates[0], expected);
}
async function uniqueSiblingPath(fs2, parentPath, base2) {
  let n = 1;
  while (true) {
    const name = n === 1 ? base2 : `${base2.replace(/\s\(fork\)$/, "")} (fork ${n})`;
    const candidate = join2(parentPath, name);
    if (!await fs2.exists(candidate)) return candidate;
    n += 1;
  }
}
async function copyTree(fs2, from, to) {
  await fs2.mkdir(to);
  for (const entry of await fs2.listDir(from)) {
    const src = join2(from, entry.name);
    const dst = join2(to, entry.name);
    if (entry.isDir) await copyTree(fs2, src, dst);
    else await fs2.writeFile(dst, await fs2.readFile(src));
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
async function ensureIdentityFileName(fs2, newBoxPath, oldBoxPath) {
  const expected = boxNotePath(newBoxPath);
  if (await fs2.exists(expected)) return;
  const oldName = `${baseName(oldBoxPath)}.md`;
  const copied = join2(newBoxPath, oldName);
  if (await fs2.exists(copied)) await fs2.move(copied, expected);
}
var init_forkOps = __esm({
  "src/core/forkOps.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_id();
    init_order();
    init_tree();
  }
});

// src/core/okf.ts
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
var init_okf = __esm({
  "src/core/okf.ts"() {
    "use strict";
    init_adapter();
    init_frontmatter();
    init_tree();
  }
});

// src/core/link-target.ts
function safePercentDecode(value) {
  try {
    if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function normalizeTarget(raw, fromNotePath) {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  t = safePercentDecode(t);
  t = (t.split("#")[0]?.split("?")[0] ?? t).trim();
  if ((t.startsWith("./") || t.startsWith("../")) && fromNotePath) {
    const base2 = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
    for (const part of t.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") base2.pop();
      else base2.push(part);
    }
    t = base2.join("/");
  }
  return t.replace(/\.md$/i, "");
}
var init_link_target = __esm({
  "src/core/link-target.ts"() {
    "use strict";
  }
});

// src/core/renameOps.ts
async function renameNode(env, conceptIdOrPath, newNameRaw) {
  return withTentMutation(env.fs, async () => renameNodeUnlocked(env, conceptIdOrPath, newNameRaw));
}
async function renameNodeUnlocked(env, conceptIdOrPath, newNameRaw) {
  const newName = validateBoxName(newNameRaw);
  const tent = await loadTent(env.fs);
  const target = resolveRenameTarget(tent, conceptIdOrPath);
  if (!isUsableBox(target)) {
    throw new Error("Invalid or archived boxes cannot be renamed.");
  }
  assertContentMutable(target, "renamed");
  if (isFrozen(target)) {
    throw new Error("Invalid or archived boxes cannot be renamed.");
  }
  await assertRenameOccupationAllowed(env, tent, target);
  const oldPath = target.path;
  const oldName = target.name;
  if (newName === oldName) {
    return {
      id: target.id,
      oldPath,
      path: oldPath,
      name: oldName,
      pathMap: { [oldPath]: oldPath },
      rewrittenNotes: []
    };
  }
  const parentPath = dirName(oldPath);
  const newPath = join2(parentPath, newName);
  assertNotOperationalPath(oldPath);
  assertNotOperationalPath(newPath);
  if (await env.fs.exists(newPath)) {
    throw new Error(`Rename target already exists: ${newPath}.`);
  }
  const siblings = target.parent ? target.parent.children : tent.roots;
  if (siblings.some((box) => box.id !== target.id && box.name === newName)) {
    throw new Error(`A sibling concept already uses the name: ${newName}.`);
  }
  const subtree2 = collectSubtree2(target);
  const pathMap = /* @__PURE__ */ new Map();
  for (const box of subtree2) {
    const rel = relativePath2(oldPath, box.path);
    const nextBoxPath = rel ? join2(newPath, rel) : newPath;
    pathMap.set(box.path, nextBoxPath);
    pathMap.set(
      boxNotePath(box.path).replace(/\.md$/i, ""),
      boxNotePath(nextBoxPath).replace(/\.md$/i, "")
    );
  }
  const conceptIndex = buildConceptIndex(tent.byPath.values());
  const rewriteOpts = {
    renameBoxId: target.id,
    conceptIndex
  };
  const plannedWrites = [];
  const rewrittenNotes = [];
  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    if (!await env.fs.exists(notePath)) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== box.id) {
      throw new Error(`Refuse rename: frontmatter id drift on ${box.path}.`);
    }
    const afterBoxPath = pathMap.get(box.path) ?? box.path;
    const restyleFromNotePath = boxNotePath(afterBoxPath);
    const rewritten = rewriteConceptLinks(body, notePath, pathMap, oldName, newName, {
      ...rewriteOpts,
      restyleFromNotePath
    });
    if (!rewritten.changed) continue;
    plannedWrites.push({
      writePath: restyleFromNotePath,
      originalPath: notePath,
      originalContent: raw,
      newContent: serializeFrontmatter(data, rewritten.body, keyOrder)
    });
    rewrittenNotes.push(afterBoxPath);
  }
  await env.fs.move(oldPath, newPath);
  let identityRenamed = false;
  const completedWrites = [];
  try {
    identityRenamed = await ensureIdentityFileName2(env.fs, newPath, oldName);
    for (const write of plannedWrites) {
      await env.fs.writeFile(write.writePath, write.newContent);
      completedWrites.push(write);
    }
  } catch (error) {
    await rollbackRename(env.fs, {
      oldPath,
      newPath,
      oldName,
      identityRenamed,
      completedWrites
    });
    throw error;
  }
  const pathMapRecord = {};
  for (const [from, to] of pathMap) pathMapRecord[from] = to;
  return {
    id: target.id,
    oldPath,
    path: newPath,
    name: newName,
    pathMap: pathMapRecord,
    rewrittenNotes: rewrittenNotes.sort()
  };
}
async function rollbackRename(fs2, args) {
  const { oldPath, newPath, oldName, identityRenamed, completedWrites } = args;
  const restoreErrors = [];
  for (let i = completedWrites.length - 1; i >= 0; i--) {
    const write = completedWrites[i];
    try {
      await fs2.writeFile(write.writePath, write.originalContent);
    } catch (err) {
      restoreErrors.push(
        `note ${write.writePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  try {
    const expectedNew = boxNotePath(newPath);
    const legacyAfterMove = join2(newPath, `${oldName}.md`);
    if ((identityRenamed || await fs2.exists(expectedNew)) && await fs2.exists(expectedNew) && !await fs2.exists(legacyAfterMove)) {
      await fs2.move(expectedNew, legacyAfterMove);
    }
  } catch (err) {
    restoreErrors.push(`identity: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (await fs2.exists(newPath) && !await fs2.exists(oldPath)) {
      const expectedNew = boxNotePath(newPath);
      const legacyAfterMove = join2(newPath, `${oldName}.md`);
      if (!await fs2.exists(legacyAfterMove) && await fs2.exists(expectedNew)) {
        try {
          await fs2.move(expectedNew, legacyAfterMove);
        } catch {
        }
      }
      await fs2.move(newPath, oldPath);
    }
  } catch (err) {
    restoreErrors.push(`tree: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (restoreErrors.length > 0) {
    throw new Error(
      `Rename failed after filesystem move, and rollback also failed: ${restoreErrors.join("; ")}`
    );
  }
}
function resolveRenameTarget(tent, conceptIdOrPath) {
  const key = conceptIdOrPath.trim().replace(/\\/g, "/");
  const byId = tent.byId.get(key);
  if (byId) return byId;
  const byPath = tent.byPath.get(key);
  if (byPath) return byPath;
  throw new Error(`Concept not found: ${conceptIdOrPath}.`);
}
async function assertRenameOccupationAllowed(env, tent, concept) {
  const tasks = await loadTaskEnvelopes(env.fs);
  const hit = findActiveOccupation(tent, concept, tasks);
  if (hit) {
    throw new Error(
      `Cannot rename ${concept.name}: active task ${hit.task.path} occupies this range (${hit.relation}).`
    );
  }
}
function assertNotOperationalPath(path) {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be renamed as concepts.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be renamed as concepts.");
  }
}
function collectSubtree2(box, out = []) {
  out.push(box);
  for (const child of box.children) collectSubtree2(child, out);
  return out;
}
function relativePath2(root, child) {
  if (child === root) return "";
  return child.slice(root.length + 1);
}
async function ensureIdentityFileName2(fs2, newBoxPath, oldName) {
  const expected = boxNotePath(newBoxPath);
  if (await fs2.exists(expected)) return false;
  const legacy = join2(newBoxPath, `${oldName}.md`);
  if (await fs2.exists(legacy)) {
    await fs2.move(legacy, expected);
    return true;
  }
  const entries = await fs2.listDir(newBoxPath);
  const candidates = entries.filter((e) => !e.isDir && e.name.endsWith(".md") && e.name !== "index.md").map((e) => join2(newBoxPath, e.name));
  if (candidates.length === 1) {
    await fs2.move(candidates[0], expected);
    return true;
  }
  throw new Error(`Identity note missing after rename: expected ${expected}.`);
}
function rewriteConceptLinks(body, fromNotePath, pathMap, oldName, newName, opts) {
  if (pathMap.size === 0) return { body, changed: false };
  const oldPaths = [...pathMap.keys()].sort((a, b) => b.length - a.length);
  let next = body;
  let changed = false;
  next = next.replace(/\[([^\]]*)\]\((<[^>\n]+>|[^)\n]+)\)/g, (full, label, destRaw) => {
    const angled = destRaw.startsWith("<") && destRaw.endsWith(">");
    const inner = angled ? destRaw.slice(1, -1) : destRaw;
    const { url, titleTail } = splitMdUrlAndTitle(inner);
    if (!url || isExternalOrAnchor(url)) return full;
    const mapped = mapLinkTarget(url, fromNotePath, pathMap, oldPaths, oldName, newName, opts);
    if (!mapped) return full;
    changed = true;
    const dest = angled ? `<${mapped}${titleTail}>` : `${mapped}${titleTail}`;
    return `[${label}](${dest})`;
  });
  next = next.replace(
    /(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (full, prefix, rawTarget, rawLabel) => {
      const target = rawTarget.trim();
      if (!target) return full;
      const { head, suffix } = splitWikiTarget(target);
      if (!head || isExternalOrAnchor(head)) return full;
      const nextHead = mapLinkTarget(head, fromNotePath, pathMap, oldPaths, oldName, newName, opts);
      if (!nextHead || nextHead === head) return full;
      changed = true;
      const labelPart = rawLabel !== void 0 ? `|${rawLabel}` : "";
      return `${prefix}[[${nextHead}${suffix}${labelPart}]]`;
    }
  );
  return { body: next, changed };
}
function mapLinkTarget(raw, fromNotePath, pathMap, oldPaths, oldName, newName, opts) {
  const { pathPart, tail } = splitDestTail(raw);
  if (!pathPart) return void 0;
  if (isUnqualifiedName(pathPart)) {
    return mapUnqualifiedName(pathPart, tail, oldName, newName, opts);
  }
  const restyleFrom = opts?.restyleFromNotePath ?? fromNotePath;
  const sourceMoved = restyleFrom.replace(/\\/g, "/") !== fromNotePath.replace(/\\/g, "/");
  const isRelativeForm = pathPart.startsWith("./") || pathPart.startsWith("../");
  const normalized = normalizeTarget(pathPart, fromNotePath);
  const mapped = resolveMappedPath(normalized, pathMap, oldPaths);
  if (!mapped && !(isRelativeForm && sourceMoved)) {
    return void 0;
  }
  const newAbs = mapped ?? normalized;
  const sourceHadMd = /\.md$/i.test(pathPart.split(/[?#]/)[0] ?? pathPart);
  const absTarget = sourceHadMd ? newAbs.endsWith(".md") ? newAbs : `${newAbs}.md` : newAbs.replace(/\.md$/i, "");
  const styled = restyleRelative(pathPart, restyleFrom, absTarget, sourceHadMd);
  if (styled === pathPart) return void 0;
  return styled + tail;
}
function mapUnqualifiedName(pathPart, tail, oldName, newName, opts) {
  if (!opts || oldName === newName) return void 0;
  const bare = pathPart.replace(/\.md$/i, "");
  const resolved = resolveConcept(opts.conceptIndex, bare);
  if (!resolved || resolved.boxId !== opts.renameBoxId) return void 0;
  const sourceHadMd = /\.md$/i.test(pathPart);
  const nextBare = bare === oldName || normalizeLookupLoose(bare) === normalizeLookupLoose(oldName) ? newName : newName;
  return (sourceHadMd ? `${nextBare}.md` : nextBare) + tail;
}
function resolveMappedPath(normalized, pathMap, oldPaths) {
  const clean = normalized.replace(/\\/g, "/").replace(/^\.\//, "");
  if (pathMap.has(clean)) return pathMap.get(clean);
  const noMd = clean.replace(/\.md$/i, "");
  if (pathMap.has(noMd)) return pathMap.get(noMd);
  for (const oldPath of oldPaths) {
    if (clean === oldPath || noMd === oldPath || clean === `${oldPath}.md`) {
      return pathMap.get(oldPath);
    }
  }
  return void 0;
}
function isUnqualifiedName(raw) {
  const t = raw.trim().replace(/\\/g, "/");
  if (!t || t.includes("/") || t.startsWith(".")) return false;
  return true;
}
function normalizeLookupLoose(value) {
  return value.toLowerCase().replace(/[\s、，,。:：;；/\\_\-.()[\]（）【】"'`]+/g, "");
}
function splitMdUrlAndTitle(inner) {
  const t = inner.trim();
  const m = t.match(/^(\S+?)(\s+(".*"|'.*'|\(.*\)))\s*$/);
  if (m) return { url: m[1], titleTail: m[2] ?? "" };
  return { url: t, titleTail: "" };
}
function splitWikiTarget(raw) {
  const t = raw.trim();
  const caret = t.lastIndexOf("^");
  if (caret > 0) {
    const before = t.slice(0, caret);
    const hash2 = before.indexOf("#");
    if (hash2 >= 0) {
      return { head: before.slice(0, hash2).trim(), suffix: before.slice(hash2) + t.slice(caret) };
    }
    return { head: before.trim(), suffix: t.slice(caret) };
  }
  const hash = t.indexOf("#");
  if (hash >= 0) return { head: t.slice(0, hash).trim(), suffix: t.slice(hash) };
  return { head: t, suffix: "" };
}
function splitDestTail(dest) {
  const t = dest.trim();
  const hash = t.indexOf("#");
  const query = t.indexOf("?");
  let cut = -1;
  if (hash >= 0 && query >= 0) cut = Math.min(hash, query);
  else if (hash >= 0) cut = hash;
  else if (query >= 0) cut = query;
  if (cut < 0) return { pathPart: t, tail: "" };
  return { pathPart: t.slice(0, cut), tail: t.slice(cut) };
}
function isExternalOrAnchor(dest) {
  const t = dest.trim();
  if (!t || t.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(t);
}
function restyleRelative(originalPathPart, fromNotePath, absoluteNext, keepMd) {
  const orig = originalPathPart.replace(/\\/g, "/");
  if (orig.startsWith("./") || orig.startsWith("../")) {
    const toNote = absoluteNext.endsWith(".md") ? absoluteNext : `${absoluteNext}.md`;
    let rel = relativeMarkdownPath(fromNotePath, toNote);
    if (!keepMd) rel = rel.replace(/\.md$/i, "");
    return rel;
  }
  if (!keepMd && absoluteNext.endsWith(".md")) return absoluteNext.replace(/\.md$/i, "");
  return absoluteNext;
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
var init_renameOps = __esm({
  "src/core/renameOps.ts"() {
    "use strict";
    init_adapter();
    init_claim();
    init_frontmatter();
    init_okf();
    init_link_target();
    init_paths();
    init_scaffold();
    init_task();
    init_tree();
  }
});

// src/core/moveOps.ts
async function moveNode(env, conceptId, newParentId, position) {
  return withTentMutation(
    env.fs,
    async () => moveNodeUnlocked(env, conceptId, newParentId, position)
  );
}
async function moveNodeUnlocked(env, conceptId, newParentId, position) {
  const id = conceptId.trim();
  if (!id) throw new Error("Concept id is required for move.");
  const tent = await loadTent(env.fs);
  const moved = tent.byId.get(id);
  if (!moved) throw new Error(`Concept not found: ${id}.`);
  if (!isUsableBox(moved)) throw new Error("Invalid or archived boxes cannot be moved.");
  assertContentMutable(moved, "moved");
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived boxes cannot be moved.");
  }
  assertNotOperationalPath2(moved.path);
  const tasks = await loadTaskEnvelopes(env.fs);
  const movedHit = findActiveOccupation(tent, moved, tasks);
  if (movedHit && (movedHit.relation === "self" || movedHit.relation === "ancestor" || movedHit.relation === "root")) {
    throw new Error(
      "Ranges with an active task cannot be moved; complete or interrupt the task first."
    );
  }
  const parentBox = resolveNewParent(tent, newParentId);
  if (parentBox) {
    if (!isUsableBox(parentBox)) throw new Error("Target parent box is invalid or archived.");
    assertContentMutable(parentBox, "used as move parent");
    assertNotOperationalPath2(parentBox.path);
  }
  const parentHit = parentBox ? findActiveOccupation(tent, parentBox, tasks) : void 0;
  if (parentHit && (parentHit.relation === "self" || parentHit.relation === "ancestor" || parentHit.relation === "root")) {
    throw new Error(
      "Cannot move into a range occupied by an active task; complete or interrupt the task first."
    );
  }
  const newParentPath = parentBox ? parentBox.path : "";
  if (newParentPath === moved.path || newParentPath.startsWith(moved.path + "/")) {
    throw new Error("Cannot move a box into its own subtree.");
  }
  if (position.mode !== "inside") {
    const sibling = tent.byId.get(position.siblingId);
    if (!sibling) throw new Error(`Sibling not found: ${position.siblingId}.`);
    const siblingParentId = sibling.parent ? sibling.parent.id : null;
    const destParentId = parentBox ? parentBox.id : null;
    if (siblingParentId !== destParentId) {
      throw new Error("before/after sibling must be under the destination parent.");
    }
    if (sibling.id === moved.id) {
      throw new Error("Cannot position a box relative to itself.");
    }
  }
  const oldPath = moved.path;
  const movedName = moved.name;
  const destination = join2(newParentPath, movedName);
  const parentChanged = dirName(oldPath) !== newParentPath;
  if (parentChanged) {
    if (await env.fs.exists(destination)) {
      throw new Error(`Move target already exists: ${destination}.`);
    }
    const destSiblings = parentBox ? parentBox.children : tent.roots;
    if (destSiblings.some((box) => box.id !== moved.id && box.name === movedName)) {
      throw new Error(`A sibling concept already uses the name: ${movedName}.`);
    }
  }
  const parentKey = parentBox ? parentBox.id : ROOT_KEY;
  const oldParentKey = moved.parent ? moved.parent.id : ROOT_KEY;
  const siblings = (parentBox ? parentBox.children : tent.roots).filter((b) => b.id !== moved.id).map((b) => b.id);
  let insertAt;
  if (position.mode === "inside") {
    insertAt = siblings.length;
  } else {
    const idx = siblings.indexOf(position.siblingId);
    insertAt = idx === -1 ? siblings.length : position.mode === "before" ? idx : idx + 1;
  }
  siblings.splice(insertAt, 0, moved.id);
  if (!parentChanged) {
    const order = await loadOrder(env.fs);
    order[parentKey] = siblings;
    await saveOrder(env.fs, order);
    const identityMap = {};
    for (const box of collectSubtree3(moved)) {
      identityMap[box.path] = box.path;
      identityMap[boxNotePath(box.path).replace(/\.md$/i, "")] = boxNotePath(box.path).replace(
        /\.md$/i,
        ""
      );
    }
    return {
      id: moved.id,
      oldPath,
      path: oldPath,
      pathMap: identityMap,
      rewrittenNotes: []
    };
  }
  const subtree2 = collectSubtree3(moved);
  const pathMap = /* @__PURE__ */ new Map();
  for (const box of subtree2) {
    const rel = relativePath3(oldPath, box.path);
    const nextBoxPath = rel ? join2(destination, rel) : destination;
    pathMap.set(box.path, nextBoxPath);
    pathMap.set(
      boxNotePath(box.path).replace(/\.md$/i, ""),
      boxNotePath(nextBoxPath).replace(/\.md$/i, "")
    );
  }
  const conceptIndex = buildConceptIndex(tent.byPath.values());
  const rewriteOpts = {
    renameBoxId: moved.id,
    conceptIndex
  };
  const plannedWrites = [];
  const rewrittenNotes = [];
  for (const box of tent.byPath.values()) {
    const notePath = boxNotePath(box.path);
    if (!await env.fs.exists(notePath)) continue;
    const raw = await env.fs.readFile(notePath);
    const { data, body, keyOrder } = parseFrontmatter(raw);
    if (typeof data.id === "string" && data.id !== box.id) {
      throw new Error(`Refuse move: frontmatter id drift on ${box.path}.`);
    }
    const afterBoxPath = pathMap.get(box.path) ?? box.path;
    const restyleFromNotePath = boxNotePath(afterBoxPath);
    const rewritten = rewriteConceptLinks(body, notePath, pathMap, movedName, movedName, {
      ...rewriteOpts,
      restyleFromNotePath
    });
    if (!rewritten.changed) continue;
    plannedWrites.push({
      writePath: restyleFromNotePath,
      originalPath: notePath,
      originalContent: raw,
      newContent: serializeFrontmatter(data, rewritten.body, keyOrder)
    });
    rewrittenNotes.push(afterBoxPath);
  }
  const orderBefore = await loadOrder(env.fs);
  const orderSnapshot = JSON.stringify(orderBefore);
  await env.fs.move(oldPath, destination);
  const completedWrites = [];
  try {
    for (const write of plannedWrites) {
      await env.fs.writeFile(write.writePath, write.newContent);
      completedWrites.push(write);
    }
    const order = JSON.parse(orderSnapshot);
    if (order[oldParentKey]) {
      order[oldParentKey] = order[oldParentKey].filter((sid) => sid !== moved.id);
    }
    order[parentKey] = siblings;
    await saveOrder(env.fs, order);
  } catch (error) {
    await rollbackMove(env.fs, {
      oldPath,
      newPath: destination,
      completedWrites,
      orderSnapshot
    });
    throw error;
  }
  const pathMapRecord = {};
  for (const [from, to] of pathMap) pathMapRecord[from] = to;
  return {
    id: moved.id,
    oldPath,
    path: destination,
    pathMap: pathMapRecord,
    rewrittenNotes: rewrittenNotes.sort()
  };
}
async function rollbackMove(fs2, args) {
  const { oldPath, newPath, completedWrites, orderSnapshot } = args;
  const restoreErrors = [];
  for (let i = completedWrites.length - 1; i >= 0; i--) {
    const write = completedWrites[i];
    try {
      await fs2.writeFile(write.writePath, write.originalContent);
    } catch (err) {
      restoreErrors.push(
        `note ${write.writePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  try {
    if (await fs2.exists(newPath) && !await fs2.exists(oldPath)) {
      await fs2.move(newPath, oldPath);
    }
  } catch (err) {
    restoreErrors.push(`tree: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await saveOrder(fs2, JSON.parse(orderSnapshot));
  } catch (err) {
    restoreErrors.push(`order: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (restoreErrors.length > 0) {
    throw new Error(
      `Move failed after filesystem move, and rollback also failed: ${restoreErrors.join("; ")}`
    );
  }
}
function resolveNewParent(tent, newParentId) {
  if (newParentId === null || newParentId === void 0 || newParentId === "") {
    return null;
  }
  const parent = tent.byId.get(newParentId.trim());
  if (!parent) throw new Error(`Target parent not found: ${newParentId}.`);
  return parent;
}
function assertNotOperationalPath2(path) {
  if (isOperationalPath(path) || path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ and other system pipelines cannot be moved as concepts.");
  }
  const top = path.split("/")[0] ?? "";
  if (top === "attachments" || top === ".tent") {
    throw new Error("System directories cannot be moved as concepts.");
  }
}
function collectSubtree3(box, out = []) {
  out.push(box);
  for (const child of box.children) collectSubtree3(child, out);
  return out;
}
function relativePath3(root, child) {
  if (child === root) return "";
  return child.slice(root.length + 1);
}
var init_moveOps = __esm({
  "src/core/moveOps.ts"() {
    "use strict";
    init_adapter();
    init_claim();
    init_frontmatter();
    init_okf();
    init_order();
    init_paths();
    init_renameOps();
    init_task();
    init_tree();
  }
});

// src/core/ops.ts
var ops_exports = {};
__export(ops_exports, {
  adoptCopiedSubtree: () => adoptCopiedSubtree,
  archiveBox: () => archiveBox,
  cancelPendingTask: () => cancelPendingTask,
  cleanTemp: () => cleanTemp,
  completeClaim: () => completeClaim,
  createBox: () => createBox,
  createTag: () => createTag,
  deleteArchivedBox: () => deleteArchivedBox,
  deleteTag: () => deleteTag,
  dispatch: () => dispatch,
  forceRelease: () => forceRelease,
  forkNode: () => forkNode,
  moveNode: () => moveNode,
  patchBody: () => patchBody,
  patchBox: () => patchBox,
  placeBox: () => placeBox,
  renameNode: () => renameNode,
  restoreBox: () => restoreBox,
  setNodeMode: () => setNodeMode,
  stamp: () => stamp,
  tagBox: () => tagBox,
  taskAck: () => taskAck,
  untagBox: () => untagBox
});
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
  const createdRoot = assigneeKind === "agentProfile" ? agentProfileTempRoot(assigneeLabel) : join2("temp", assigneeLabel);
  const createdRootExisted = await env.fs.exists(createdRoot);
  const asSub = options.asSub === true;
  const parentRoleId = options.parentActor?.kind === "role" ? options.parentActor.id : (options.dispatchedBy || "").trim() && (options.dispatchedBy || "").trim() !== "user" ? (options.dispatchedBy || "").trim() : "";
  const subUnderDispatcher = asSub && Boolean(parentRoleId) && parentRoleId !== assigneeLabel;
  if (claim.root) {
    const blocker = findAnyActiveTask(tasks);
    if (blocker) {
      const claimLabel = blocker.claims.includes("root") ? "root" : blocker.claims[0] || "unknown";
      throw new Error(
        `Cannot dispatch: Tent root already has an active claim ${claimLabel} (${blocker.role}).`
      );
    }
  } else {
    const structural = structuralClaimGate(claim.box);
    if (!structural.ok) {
      throw new Error(`Cannot dispatch: ${structural.reason || "box cannot be claimed"}`);
    }
    const claimable = canClaim(claim.box, {
      tent,
      tasks,
      ...subUnderDispatcher ? { allowAncestorClaimedBy: parentRoleId } : {}
    });
    if (!claimable.ok) {
      throw new Error(`Cannot dispatch: ${claimable.reason || "box cannot be claimed"}`);
    }
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
      await ensureDir2(env.fs, dirName(manifestPath));
      await env.fs.writeFile(manifestPath, yaml);
    } else {
      manifestPath = join2("temp", assigneeLabel, "manifest.yml");
      await ensureDir2(env.fs, dirName(manifestPath));
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
      parentActor: options.parentActor,
      reviewer: options.reviewer,
      dispatchedBy: options.dispatchedBy,
      asSub: options.asSub === true,
      deliveryPolicy: options.deliveryPolicy,
      assigneeKind,
      id: taskId,
      tasksDir: assigneeKind === "agentProfile" ? agentProfileTasksDir(assigneeLabel) : void 0
    });
    const actorsForRelay = {
      parentActor: options.parentActor,
      reviewer: options.reviewer,
      dispatchedBy: options.dispatchedBy,
      asSub: options.asSub
    };
    const written = await loadTaskEnvelope(env.fs, taskPath).catch(() => null);
    const relayPrompt = relayPromptForTask(
      written ?? {
        path: taskPath,
        role: assigneeLabel,
        claims: taskClaims.map((taskClaim2) => taskClaim2.id),
        manifest: manifestPath,
        status: "pending",
        state: "queued",
        assigneeKind,
        id: taskId,
        ...migrateParentReviewerFromLegacy(actorsForRelay)
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
async function stamp(_env, _boxId, _acceptedBy = "user") {
  void _env;
  void _boxId;
  void _acceptedBy;
  throw new Error(STAMP_RETIRED_MESSAGE);
}
async function completeClaim(env, boxId, integrate, _acceptedBy = "user") {
  void _acceptedBy;
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    requireBoxById2(tent, boxId);
  });
  void integrate;
  throw new Error(STAMP_RETIRED_MESSAGE);
}
async function cleanTemp(env, role) {
  const roleName = role === void 0 ? void 0 : assertRoleName(role);
  await withMutation2(env.fs, async () => {
    const target = roleName ? join2("temp", roleName) : "temp";
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
    (t) => envelopeIsActiveOccupation(t) && t.claims.includes(boxId)
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
  const path = join2(input.parentPath, name);
  assertNotTempPath(path);
  await ensureDir2(env.fs, path);
  const fm = { id, type: input.type };
  const content = serializeFrontmatter(fm, `
# ${name}
`, BOX_FRONTMATTER_KEY_ORDER);
  await env.fs.writeFile(boxNotePath(path), content);
  const parent = input.parentPath ? tent.byPath.get(input.parentPath) : void 0;
  const parentKey = parent ? parent.id : ROOT_KEY;
  try {
    const order = await loadOrder(env.fs);
    const siblings = order[parentKey] ?? [];
    order[parentKey] = siblings.includes(id) ? siblings : [...siblings, id];
    await saveOrder(env.fs, order);
  } catch (error) {
    await env.fs.remove(path);
    throw error;
  }
  return id;
}
async function placeBox(env, fromPath, newParentPath, position) {
  await withMutation2(env.fs, async () => placeBoxUnlocked(env, fromPath, newParentPath, position));
}
async function placeBoxUnlocked(env, fromPath, newParentPath, position) {
  assertNotTempPath(newParentPath);
  const before = await loadTent(env.fs);
  const moved = before.byPath.get(fromPath);
  if (!moved) throw new Error(`Box not found: ${fromPath}.`);
  if (!isUsableBox(moved)) throw new Error("Invalid or archived boxes cannot be moved.");
  assertContentMutable(moved, "moved");
  const tasks = await loadTaskEnvelopes(env.fs);
  const movedHit = findActiveOccupation(before, moved, tasks);
  if (movedHit && (movedHit.relation === "self" || movedHit.relation === "ancestor" || movedHit.relation === "root")) {
    throw new Error("Ranges with an active task cannot be moved; complete or interrupt the task first.");
  }
  if (moved.invalid || moved.archived) {
    throw new Error("Invalid or archived boxes cannot be moved.");
  }
  const movedId = moved.id;
  const movedName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
  const parentBox = newParentPath ? before.byPath.get(newParentPath) : null;
  if (newParentPath && (!parentBox || !isUsableBox(parentBox))) throw new Error("Target parent box is invalid or archived.");
  if (parentBox) assertContentMutable(parentBox, "used as move parent");
  const parentHit = parentBox ? findActiveOccupation(before, parentBox, tasks) : void 0;
  if (parentHit && (parentHit.relation === "self" || parentHit.relation === "ancestor" || parentHit.relation === "root")) {
    throw new Error("Cannot move into a range occupied by an active task; complete or interrupt the task first.");
  }
  if (newParentPath === fromPath || newParentPath.startsWith(fromPath + "/")) {
    throw new Error("Cannot move a box into its own subtree.");
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
        throw new Error(`Failed to save order after move, and rollback also failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    return;
  }
  order[parentKey] = siblings;
  await saveOrder(env.fs, order);
}
async function patchBox(env, boxPath, patch, loadedTent) {
  await withMutation2(env.fs, async () => patchBoxUnlocked(env, boxPath, patch, loadedTent));
}
async function patchBoxUnlocked(env, boxPath, patch, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box) throw new Error(`Box not found: ${boxPath}.`);
  const reserved = [
    "id",
    "owner",
    "mode",
    "archived",
    "readable",
    "writable",
    "status",
    "relations",
    // Output provenance: only formal task.accept bind path may write deliveryId.
    "deliveryId"
  ].filter((key) => key in patch);
  if (reserved.length > 0) {
    throw new Error(
      `Reserved or retired fields cannot be edited here: ${reserved.join(", ")}. Use docs.setMode for archive; collaboration status lives on Task projection; relations use relation.* RPCs; Output deliveryId binds via task.accept.`
    );
  }
  if (box.archived || box.mode === "archived") {
    throw new Error("Archived boxes can only be restored or permanently deleted.");
  }
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
  const tagsTouched = "tags" in patch;
  const previousTags = box.tags.slice();
  if (tagsTouched) {
    patch = { ...patch, tags: normalizeTagPatch(patch.tags) };
  }
  const boxFile = boxNotePath(boxPath);
  const { data, body, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
  if (tagsTouched) {
    const nextTags = Array.isArray(patch.tags) ? patch.tags : [];
    await syncTagRegistryAfterBoxTagsChangeUnlocked(env.fs, previousTags, nextTags);
  }
}
async function patchBody(env, boxPath, newBody, loadedTent) {
  await withMutation2(env.fs, async () => patchBodyUnlocked(env, boxPath, newBody, loadedTent));
}
async function patchBodyUnlocked(env, boxPath, newBody, loadedTent) {
  const tent = loadedTent ?? await loadTent(env.fs);
  const box = tent.byPath.get(boxPath);
  if (!box) throw new Error(`Box not found: ${boxPath}.`);
  if (!isUsableBox(box)) throw new Error("Invalid or archived boxes cannot have their body edited.");
  assertContentMutable(box, "body-edited");
  const boxFile = boxNotePath(boxPath);
  const { data, keyOrder } = parseFrontmatter(await env.fs.readFile(boxFile));
  await env.fs.writeFile(boxFile, serializeFrontmatter(data, newBody, keyOrder));
}
async function setNodeMode(env, boxId, mode) {
  await withMutation2(env.fs, async () => setNodeModeUnlocked(env, boxId, mode));
}
async function setNodeModeUnlocked(env, boxId, mode) {
  if (mode === "read-only") {
    throw new Error(
      'read-only mode is retired in V0.2; use "editable" or "archived" (archive freezes the subtree).'
    );
  }
  const next = parseNodeMode(mode);
  if (!next || next !== "editable" && next !== "archived") {
    throw new Error('mode must be "editable" or "archived".');
  }
  const tent = await loadTent(env.fs);
  const box = requireBoxById2(tent, boxId);
  if (box.invalid) throw new Error("Invalid boxes cannot change mode.");
  if (box.archived && !isExplicitArchiveRoot(box)) {
    if (next === "archived") {
      throw new Error("Invalid or already archived boxes cannot be archived.");
    }
    throw new Error("Only an explicit archive root can leave archived mode; restore the archive root first.");
  }
  const current = isExplicitArchiveRoot(box) ? "archived" : "editable";
  if (current === next) {
    if (next === "editable") {
      await patchFrontmatter(env.fs, box, { mode: void 0, archived: void 0 });
    } else {
      await patchFrontmatter(env.fs, box, { mode: "archived", archived: void 0 });
    }
    return;
  }
  if (next === "archived" || current !== "archived") {
    const tasks = await loadTaskEnvelopes(env.fs);
    if (findActiveOccupation(tent, box, tasks)) {
      throw new Error(
        next === "archived" ? "Ranges with an active task cannot be archived; complete or interrupt the task first." : "Ranges with an active task cannot change mode; complete or interrupt the task first."
      );
    }
  }
  if (next === "archived") {
    await patchFrontmatter(env.fs, box, { mode: "archived", archived: void 0 });
    return;
  }
  await patchFrontmatter(env.fs, box, { mode: void 0, archived: void 0 });
}
async function archiveBox(env, boxId) {
  await setNodeMode(env, boxId, "archived");
}
async function restoreBox(env, boxId) {
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById2(tent, boxId);
    if (!isExplicitArchiveRoot(box)) {
      throw new Error("Only an explicit archive root can restore the subtree.");
    }
    await patchFrontmatter(env.fs, box, { mode: void 0, archived: void 0 });
  });
}
async function deleteArchivedBox(env, boxId) {
  await withMutation2(env.fs, async () => {
    const tent = await loadTent(env.fs);
    const box = requireBoxById2(tent, boxId);
    if (!isExplicitArchiveRoot(box)) throw new Error("Box must be archived before permanent deletion.");
    const tasks = await loadTaskEnvelopes(env.fs);
    if (hasActiveTaskInSubtree(tent, box, tasks)) {
      throw new Error(
        "Archived subtree still has an active task and cannot be deleted; cancel or fail the task first."
      );
    }
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
async function patchFrontmatter(fs2, box, patch) {
  const boxFile = boxNotePath(box.path);
  const { data, body, keyOrder } = parseFrontmatter(await fs2.readFile(boxFile));
  for (const [k, v] of Object.entries(patch)) {
    if (v === void 0) delete data[k];
    else data[k] = v;
  }
  await fs2.writeFile(boxFile, serializeFrontmatter(data, body, boxKeyOrder2(keyOrder)));
}
async function ensureDir2(fs2, path) {
  if (path && !await fs2.exists(path)) await fs2.mkdir(path);
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
function boxKeyOrder2(existing) {
  return [
    ...BOX_FRONTMATTER_KEY_ORDER,
    ...existing.filter((key) => !BOX_FRONTMATTER_KEY_ORDER.includes(key))
  ];
}
function assertNotTempPath(path) {
  if (path === "temp" || path.startsWith("temp/")) {
    throw new Error("temp/ is a system pipeline; typed boxes cannot be created or moved there.");
  }
}
function hasActiveTaskInSubtree(tent, box, tasks) {
  const ids = collectSubtreeIds(box);
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      if (claimId === "root") return true;
      if (ids.has(claimId)) return true;
    }
  }
  void tent;
  return false;
}
function collectSubtreeIds(box, ids = /* @__PURE__ */ new Set()) {
  ids.add(box.id);
  for (const child of box.children) collectSubtreeIds(child, ids);
  return ids;
}
function assertRoleName(role) {
  const name = role.trim();
  if (!name) throw new Error("Role name cannot be empty.");
  if (/[\/\\\r\n]/.test(name)) throw new Error("Role name cannot contain path separators or newlines.");
  assertRoleNameAvailable(name);
  return name;
}
function roleManifestClaims(tent, role, current, tasks) {
  const claims = /* @__PURE__ */ new Map();
  for (const task of tasks) {
    if (taskAssigneeKind(task) !== "role") continue;
    if (task.role !== role) continue;
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      const box = tent.byId.get(claimId);
      if (box) claims.set(box.id, box);
    }
  }
  claims.set(current.id, current);
  return [...claims.values()];
}
function requireBoxById2(tent, boxId) {
  if (tent.duplicateIds.has(boxId)) {
    throw new Error(`Duplicate box id '${boxId}' found; repair or fork the duplicate boxes before using this id.`);
  }
  const box = tent.byId.get(boxId);
  if (!box) throw new Error(`Box not found: ${boxId}.`);
  return box;
}
async function withMutation2(fs2, action) {
  return withTentMutation(fs2, action);
}
var STAMP_RETIRED_MESSAGE;
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
    init_tags();
    init_typeRegistry();
    init_skillRoleRegistry();
    init_task();
    init_task_model();
    init_paths();
    init_delivery();
    init_scaffold();
    init_task_lifecycle();
    init_forkOps();
    init_renameOps();
    init_moveOps();
    STAMP_RETIRED_MESSAGE = "stamp/complete no longer write Node owner/status. Use task.deliver + task.accept (or task.fail) for collaboration completion.";
  }
});

// src/plugin/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TentPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");

// src/plugin/view.ts
var import_obsidian4 = require("obsidian");
var nodePath3 = __toESM(require("node:path"), 1);

// src/plugin/obsidian-fs.ts
var import_obsidian = require("obsidian");
var nodePath = __toESM(require("node:path"), 1);

// src/fs/mutation-lock.ts
var import_node_crypto = require("node:crypto");
var fs = __toESM(require("node:fs/promises"), 1);
var MUTATION_LOCK_STALE_MS = 12e4;
async function withFileMutationLock(lockPath, action, options) {
  const now = options.now ?? Date.now;
  const makeOwnerToken = options.makeOwnerToken ?? import_node_crypto.randomUUID;
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
      const quarantine = `${lockPath}.stale-${(0, import_node_crypto.randomUUID)()}`;
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

// src/plugin/obsidian-fs.ts
var ObsidianFs = class {
  constructor(app, tentRoot) {
    this.app = app;
    this.tentRoot = normalizeVaultPath(tentRoot);
    this.resolvedTentRoot = nodePath.posix.resolve("/", this.tentRoot);
  }
  get a() {
    return this.app.vault.adapter;
  }
  vp(p) {
    const resolved = nodePath.posix.resolve(this.resolvedTentRoot, normalizeVaultPath(p || "."));
    const inside = this.resolvedTentRoot === "/" || resolved === this.resolvedTentRoot || resolved.startsWith(`${this.resolvedTentRoot}/`);
    if (!inside) throw new Error(`Path escapes Tent root: ${p}`);
    return resolved.slice(1);
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
  async readBinary(path) {
    const ab = await this.a.readBinary(this.vp(path));
    return new Uint8Array(ab);
  }
  async writeBinary(path, data) {
    const vp = this.vp(path);
    await this.ensureDirAbs(parentOf(vp));
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    await this.a.writeBinary(vp, copy.buffer);
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
    return withFileMutationLock(lockPath, action, {
      busyMessage: "\u5E10\u6B63\u5728\u6267\u884C\u53E6\u4E00\u4E2A\u5199\u64CD\u4F5C,\u8BF7\u7A0D\u540E\u91CD\u8BD5",
      acquireFailedMessage: "\u65E0\u6CD5\u83B7\u53D6\u5E10 mutation lock"
    });
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
function normalizeVaultPath(p) {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

// src/plugin/colors.ts
var TYPE_COLOR_PALETTE = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "brown"
];
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

// src/core/inbox.ts
init_task();
init_claim();
async function buildInbox(tent, fs2) {
  if (!fs2) {
    return [];
  }
  const tasks = await loadTaskEnvelopes(fs2);
  const occupied = occupiedBoxesFromTasks(tent, tasks);
  const items = [];
  for (const box of occupied) {
    if (box.invalid || box.archived) continue;
    const task = tasks.find(
      (t) => envelopeIsActiveOccupation(t) && t.claims.includes(box.id)
    );
    if (!task) continue;
    items.push({
      state: "stale",
      role: task.role,
      boxPath: box.path,
      boxId: box.id,
      taskId: task.id || task.path
    });
  }
  return items;
}

// src/plugin/view.ts
init_delivery();

// src/core/proposal.ts
init_adapter();
init_frontmatter();
init_tree();
async function loadProposals(fs2) {
  const proposals = [];
  if (!await fs2.exists("temp")) return proposals;
  for (const roleDir of await fs2.listDir("temp")) {
    if (!roleDir.isDir) continue;
    const dir = join2("temp", roleDir.name, "proposals");
    if (!await fs2.exists(dir)) continue;
    for (const entry of await fs2.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join2(dir, entry.name);
      try {
        proposals.push(await loadProposal(fs2, path));
      } catch {
      }
    }
  }
  return proposals.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
async function loadProposal(fs2, inputPath) {
  const path = normalizeProposalPath(inputPath);
  if (!await fs2.exists(path)) throw new Error(`Proposal not found: ${path}.`);
  const { data, body } = parseFrontmatter(await fs2.readFile(path));
  if (data.type !== "proposal" || typeof data.box !== "string" || typeof data.role !== "string" || data.status !== "pending" && data.status !== "accepted" && data.status !== "rejected") {
    throw new Error(`Invalid proposal format: ${path}.`);
  }
  return {
    path,
    boxId: data.box,
    role: data.role,
    status: data.status,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : void 0,
    body: body.trim()
  };
}
async function acceptProposal(fs2, inputPath) {
  await withTentMutation(fs2, async () => {
    const proposal = await loadProposal(fs2, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be accepted.");
    proposal.status = "accepted";
    await writeProposal(fs2, proposal);
  });
}
async function rejectProposal(fs2, inputPath) {
  await withTentMutation(fs2, async () => {
    const proposal = await loadProposal(fs2, inputPath);
    if (proposal.status !== "pending") throw new Error("Only pending proposals can be rejected.");
    proposal.status = "rejected";
    await writeProposal(fs2, proposal);
  });
}
function normalizeProposalPath(input) {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/proposals\/[bc]x-[^/]+\.md$/.test(path)) {
    throw new Error("Proposal must point to temp/<role>/proposals/<boxId>.md.");
  }
  return path;
}
async function writeProposal(fs2, proposal) {
  const data = {
    type: "proposal",
    box: proposal.boxId,
    role: proposal.role,
    status: proposal.status,
    createdAt: proposal.createdAt
  };
  await fs2.writeFile(
    proposal.path,
    serializeFrontmatter(data, proposal.body + "\n", ["type", "box", "role", "status", "createdAt"])
  );
}

// src/plugin/view.ts
init_task();
init_task_lifecycle();

// src/core/canvas.ts
init_tree();
init_typeRegistry();
var CARD_W = 230;
var CARD_H = 56;
var PAD = 18;
var HEADER = 36;
var GAP = 12;
var COL_GAP = 48;
var ROOT_COLOR = {
  goal: "5",
  prompt: "6",
  output: "4",
  temp: "",
  custom: "2"
};
function buildCanvas(tent, pathPrefix) {
  const nodes = [];
  let cursorX = 0;
  for (const root of tent.roots) {
    const s = sizeOf(root);
    layout(root, cursorX, 0, nodes, pathPrefix, true);
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
function layout(box, x, y, out, prefix, isRoot) {
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
      color: colorFor(box, isRoot)
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
    label: labelFor(box, isRoot),
    color: colorFor(box, isRoot)
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
function labelFor(box, isRoot) {
  const tag = isRoot ? "" : ` \xB7 ${box.type}`;
  return `${box.name}${tag}`;
}
function colorFor(box, isRoot) {
  if (isRoot) return ROOT_COLOR[box.name] || void 0;
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
  for (const root of tent.roots) {
    const rid = root.id || root.path;
    const freshRoot = fresh.nodes.find((n) => n.id === rid);
    const oldRoot = oldById.get(rid);
    if (!freshRoot || !oldRoot) continue;
    const dx = oldRoot.x - freshRoot.x;
    const dy = oldRoot.y - freshRoot.y;
    if (dx === 0 && dy === 0) continue;
    const subtreeIds = collectIds(root);
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

// src/core/workspace.ts
var nodePath2 = __toESM(require("node:path"), 1);
var nodeFs = __toESM(require("node:fs/promises"), 1);
var import_node_child_process = require("node:child_process");
init_paths();
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
    resolved.map((item) => item.fullRef),
    contract.branch
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
async function listRoleCommits(contract) {
  try {
    return await listRoleCommitsStrict(contract);
  } catch {
    return [];
  }
}
async function listRoleCommitsStrict(contract) {
  const output = await git(contract.workspace, [
    "log",
    `${contract.targetBranch}..${contract.branch}`,
    "--format=%H%x09%h%x09%s"
  ]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [ref = "", shortRef = "", ...subjectParts] = line.split("	");
    return { ref, shortRef, subject: subjectParts.join("	") };
  }).filter((item) => item.ref && item.shortRef);
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
async function completeFastForwardRef(root, targetRef, commits, sourceBranch) {
  const lastRef = commits.at(-1);
  if (!lastRef || lastRef === targetRef) return void 0;
  if (!await gitOk(root, ["merge-base", "--is-ancestor", targetRef, lastRef])) return void 0;
  const sourceRef = `refs/heads/${sourceBranch}`;
  if (!await gitOk(root, ["merge-base", "--is-ancestor", lastRef, sourceRef])) {
    return void 0;
  }
  if (commits.length === 1) {
    return lastRef;
  }
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
async function pathExists(path) {
  try {
    await nodeFs.access(path);
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

// src/plugin/ui-model.ts
function capturePaneScroll(root) {
  return {
    tree: root.querySelector(".tent-tree")?.scrollTop ?? 0,
    property: root.querySelector(".tent-prop")?.scrollTop ?? 0
  };
}
function restorePaneScroll(root, positions) {
  const tree = root.querySelector(".tent-tree");
  const property = root.querySelector(".tent-prop");
  if (tree) tree.scrollTop = positions.tree;
  if (property) property.scrollTop = positions.property;
}
function visibleTreeCount(node, collapsed, directCount) {
  if (!collapsed) return directCount(node);
  const subtreeCount = (current) => directCount(current) + current.children.reduce((total, child) => total + subtreeCount(child), 0);
  return subtreeCount(node);
}
function bottomTabCounts(input) {
  return {
    dispatch: input.pendingDispatches,
    triage: input.pendingProposals + input.readyReports
  };
}
function statusBarText(total) {
  return total > 0 ? `${total} \u5728\u529E` : "\u5E10\u5185\u65E0\u4E8B";
}
function statusBarTotal(input) {
  return input.triage + input.dispatch;
}
function statusIncreaseNoticeDelta(previousTriage, triage) {
  return previousTriage !== null && triage > previousTriage ? triage - previousTriage : null;
}
function statusIncreaseNoticeText(increase) {
  return `\u5E10\u5185\u65B0\u589E ${increase} \u9879\u5F85\u88C1`;
}
function hasTreePending(input) {
  return input.pendingProposals > 0 || input.pendingDispatches > 0;
}
function bottomTabParts(label, count) {
  return {
    label,
    count: count > 0 ? `(${count})` : ""
  };
}
function createRegistryPaneState() {
  return {
    markedRoles: /* @__PURE__ */ new Set(),
    markedTypes: /* @__PURE__ */ new Set(),
    collapsed: { type: false, modifier: false, roles: false },
    typeCollapsed: false,
    newFormOpen: null,
    openEditor: null
  };
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

// src/plugin/ui-controls.ts
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
function hasActiveOwnerInScope(_box) {
  void _box;
  return false;
}
function tentTooltip(el, text, placement = "top") {
  el.removeAttribute("title");
  if (!text) return;
  (0, import_obsidian2.setTooltip)(el, text, {
    placement,
    delay: 300,
    gap: 6,
    classes: ["tent-tooltip"]
  });
}
function makeDragLabel(parent, name) {
  const el = parent.createDiv({ cls: "tent-drag-label tent-drag-label-preview", text: name });
  window.setTimeout(() => el.remove(), 0);
  return el;
}

// src/plugin/registry-pane.ts
var import_obsidian3 = require("obsidian");
init_skillRoleRegistry();

// src/core/typeManagement.ts
init_adapter();
init_tree();
init_task();
init_claim();
init_typeRegistry();
async function createType(fs2, name, definition) {
  await withTentMutation(fs2, async () => {
    assertTypeName(name);
    if (isCanonicalPrimary(name) || CANONICAL_PRIMARY_TYPES.includes(name)) {
      throw new Error(`Built-in primary types cannot be created: ${name}.`);
    }
    if (BUILTIN_SECONDARY_TYPES.includes(name)) {
      throw new Error(`Built-in secondary types already exist: ${name}.`);
    }
    if (definition.tier !== "modifier") {
      throw new Error("V0.2 only allows creating custom secondary (modifier) types; primaries are fixed.");
    }
    const registry = await loadTypeRegistry(fs2);
    if (registry[name]) throw new Error(`Type already exists: ${name}.`);
    registry[name] = { tier: "modifier" };
    await writeTypeRegistryUnlocked(fs2, registry);
  });
}
async function createSecondaryType(fs2, name, _definition) {
  void _definition;
  await createType(fs2, name, { tier: "modifier" });
}
async function inspectTypeDeletion(fs2, level, name) {
  void level;
  const tent = await loadTent(fs2);
  const registry = tent.typeRegistry;
  const boxes = [...tent.byId.values()];
  const referenced = boxes.filter((box) => {
    const { base: base2, modifier } = splitType(box.type);
    return box.type === name || base2 === name || modifier === name;
  });
  const tasks = await loadTaskEnvelopes(fs2);
  const ownerMap = /* @__PURE__ */ new Map();
  const relatedIds = /* @__PURE__ */ new Set();
  for (const reference of referenced) {
    for (const box of relatedBoxes(reference, boxes)) {
      relatedIds.add(box.id);
    }
  }
  for (const task of tasks) {
    if (!envelopeIsActiveOccupation(task)) continue;
    for (const claimId of task.claims) {
      if (claimId === "root") {
        if (referenced.length > 0) {
          ownerMap.set("root", { id: "root", path: "./", owner: task.role });
        }
        continue;
      }
      if (!relatedIds.has(claimId)) continue;
      const box = tent.byId.get(claimId);
      if (!box) continue;
      ownerMap.set(box.id, { id: box.id, path: box.path, owner: task.role });
    }
  }
  const builtIn = name in DEFAULT_TYPE_REGISTRY || isCanonicalPrimary(name) || BUILTIN_SECONDARY_TYPES.includes(name);
  return {
    level: "type",
    name,
    builtIn,
    exists: name in registry,
    references: referenced.map(({ id, path, name: boxName }) => ({ id, path, name: boxName })),
    activeOwners: [...ownerMap.values()]
  };
}
async function deleteCustomType(fs2, level, name, confirmation) {
  return withTentMutation(fs2, async () => {
    if (confirmation !== name) throw new Error(`Confirmation mismatch; enter the type name ${name}.`);
    const inspection = await inspectTypeDeletion(fs2, level, name);
    if (!inspection.exists) throw new Error(`Type does not exist: ${name}.`);
    if (inspection.builtIn) throw new Error(`Built-in types cannot be deleted: ${name}.`);
    if (inspection.references.length > 0) {
      throw new Error(
        `Type still in use by ${inspection.references.length} node(s); retype them first: ${inspection.references.map((x) => x.path).join(", ")}.`
      );
    }
    if (inspection.activeOwners.length > 0) {
      throw new Error(
        `Referenced range still has an active task; cancel or fail first: ${inspection.activeOwners.map((x) => x.path).join(", ")}.`
      );
    }
    const registry = await loadTypeRegistry(fs2);
    delete registry[name];
    await writeTypeRegistryUnlocked(fs2, registry);
    return inspection;
  });
}
async function writeTypeRegistryUnlocked(fs2, registry) {
  const slim = {};
  for (const [name, def] of Object.entries(registry)) {
    slim[name] = { tier: def.tier === "modifier" ? "modifier" : "base" };
  }
  await fs2.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(slim, null, 2) + "\n");
}
function assertTypeName(name) {
  if (!name.trim()) throw new Error("Type name cannot be empty.");
  if (name === "temp") throw new Error("temp/ is a system pipeline and cannot be used as a type.");
  if (name.includes("-")) throw new Error("Type names cannot contain '-' (compound separator).");
}
function relatedBoxes(reference, boxes) {
  return boxes.filter(
    (box) => box.path === reference.path || box.path.startsWith(reference.path + "/") || reference.path.startsWith(box.path + "/")
  );
}

// src/plugin/registry-pane.ts
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
    drawTypeSection(typeBlock, context, state, "modifier", "modifier", "\u4E8C\u7EA7", secondary);
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
    for (const [name] of definitions) {
      drawChip(
        chips,
        name,
        state.markedTypes.has(name),
        typeColorValue(void 0),
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
      if (key === "type" || key === "modifier") state.typeCollapsed = false;
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
  row.createSpan({ cls: "item-name", text: name });
  row.createSpan({
    cls: "reg-desc",
    text: `tier:${definition.tier ?? "base"}`
  });
  const rightArea = row.createDiv({ cls: "row-right-area" });
  const actions = rightArea.createDiv({ cls: "row-actions" });
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
        `\u5173\u8054\u8303\u56F4\u4ECD\u6709 active task,\u5148\u53D6\u6D88\u6216 fail:${inspection.activeOwners.map((item) => item.path).join(", ")}`
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
  const normalized = label === "\u540D\u5B57" ? "name" : label === "\u989C\u8272" ? "color" : label === "\u63CF\u8FF0" ? "description" : label === "R/W" ? "r-w" : label === "\u534F\u4F5C" ? "coordination" : label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
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
function drawNewTypeForm(section, context, state, tier) {
  const card = section.createDiv({ cls: "tent-newform" });
  if (tier === "base") {
    card.createDiv({
      cls: "reg-desc",
      text: "V0.2 \u4E00\u7EA7 type \u56FA\u5B9A\u4E3A goal|prompt|output\uFF0C\u4E0D\u53EF\u65B0\u5EFA\u3002"
    });
    drawFormActions(card, context, state, async () => {
      state.newFormOpen = null;
      context.redraw();
    });
    return;
  }
  const form = { name: "" };
  const name = drawLabelRow(card, "\u540D\u5B57").createEl("input", {
    cls: "tent-newform-input",
    attr: { type: "text" }
  });
  name.oninput = () => {
    form.name = name.value.trim();
  };
  window.setTimeout(() => name.focus(), 0);
  drawFormActions(card, context, state, async () => {
    if (!form.name || form.name === "temp") {
      new import_obsidian3.Notice("\u8BF7\u586B\u5199\u6709\u6548\u7684 type \u540D");
      return;
    }
    if (context.registry[form.name]) {
      new import_obsidian3.Notice(`\u7C7B\u578B\u300C${form.name}\u300D\u5DF2\u5B58\u5728`);
      return;
    }
    await createSecondaryType(context.fs, form.name, { tier: "modifier" });
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

// src/plugin/timed-cache.ts
var GIT_UI_CACHE_TTL_MS = 6e3;
var TimedCache = class {
  constructor(ttlMs = GIT_UI_CACHE_TTL_MS, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = /* @__PURE__ */ new Map();
  }
  get(key, loader) {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit?.hasValue && hit.expiresAt > now) return Promise.resolve(hit.value);
    if (hit?.promise) return hit.promise;
    const promise = loader().then((value) => {
      this.entries.set(key, {
        value,
        hasValue: true,
        expiresAt: this.now() + this.ttlMs
      });
      return value;
    }).catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { expiresAt: now + this.ttlMs, hasValue: false, promise });
    return promise;
  }
  clear() {
    this.entries.clear();
  }
};

// src/plugin/pending-dispatch.ts
function pendingDispatches(tasks) {
  const latestByBox = /* @__PURE__ */ new Map();
  for (const task of [...tasks].sort(compareTaskOrder)) {
    for (const boxId of task.claims) {
      if (boxId !== "root") latestByBox.set(boxId, task);
    }
  }
  const pending = [];
  for (const [boxId, task] of latestByBox) {
    if (task.status === "taken") continue;
    pending.push({ boxId, task });
  }
  return pending;
}
function compareTaskOrder(a, b) {
  const aName = a.path.slice(a.path.lastIndexOf("/") + 1);
  const bName = b.path.slice(b.path.lastIndexOf("/") + 1);
  return aName.localeCompare(bName) || a.path.localeCompare(b.path);
}

// src/plugin/view.ts
init_ops();
var TENT_VIEW_TYPE = "tent-structure-editor";
var MIN_TREE_COLUMN = 250;
var MIN_PROPERTY_COLUMN = 320;
var COLUMN_DIVIDER = 6;
var TentView = class extends import_obsidian4.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tentName = "";
    this.selectedId = null;
    this.tent = null;
    this.deliveries = [];
    this.proposals = [];
    this.tasks = [];
    this.inbox = [];
    this.pendingDispatchItems = [];
    this.pendingDispatchByBox = /* @__PURE__ */ new Map();
    this.draggedPath = null;
    this.collapsed = /* @__PURE__ */ new Set();
    this.selectedSystem = null;
    this.bottomTab = "note";
    // 左树热切换:全部 / 只看有待处理(proposal、owner 或待投递 task)的框
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
    // 每个 box 的 pending proposal 数；Delivery / 待投递 task 在 boxTriageCount 合并。
    this.pendingByTarget = /* @__PURE__ */ new Map();
    this.loadError = null;
    this.refreshTimer = null;
    this.ignoredVaultChanges = /* @__PURE__ */ new Map();
    this.recentCreates = /* @__PURE__ */ new Set();
    this.columnResizeObserver = null;
    this.columnResizeDrag = null;
    this.roleCommitsCache = new TimedCache();
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
    this.register(() => this.clearRefreshTimer());
    this.registerDomEvent(document, "mousemove", (event) => this.onColumnResizeMove(event));
    this.registerDomEvent(document, "mouseup", () => this.stopColumnResize());
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
    this.clearRefreshTimer();
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
      tentRoot: this.tentRootAbsolutePath() ?? this.tentRootPath(),
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
        const fs2 = this.env().fs;
        await this.adoptNativeCopies();
        this.tent = await loadTent(fs2);
        this.deliveries = await loadDeliveries(fs2);
        this.proposals = await loadProposals(fs2);
        this.tasks = await loadTaskEnvelopes(fs2);
        this.inbox = await buildInbox(this.tent, fs2);
        this.roles = (await loadRolesRegistry(fs2)).roles;
        this.registryTags = (await loadTagRegistry(fs2)).tags;
        this.loadError = null;
      } catch (e) {
        this.tent = null;
        this.deliveries = [];
        this.proposals = [];
        this.tasks = [];
        this.inbox = [];
        this.roles = [];
        this.registryTags = [];
        this.loadError = e instanceof Error ? e.message : String(e);
      }
    }
    this.rebuildPendingDispatches();
    const statusCounts = bottomTabCounts({
      pendingDispatches: this.pendingDispatchItems.length,
      pendingProposals: this.pendingProposals().length,
      readyReports: this.readyDeliveries().length
    });
    this.plugin.updateStatus({
      triage: statusCounts.triage,
      dispatch: statusCounts.dispatch
    });
    this.draw();
  }
  rebuildPendingDispatches() {
    const tent = this.tent;
    if (!tent) {
      this.pendingDispatchItems = [];
      this.pendingDispatchByBox = /* @__PURE__ */ new Map();
      return;
    }
    this.pendingDispatchItems = pendingDispatches(this.tasks);
    const byBox = /* @__PURE__ */ new Map();
    for (const item of this.pendingDispatchItems) {
      const current = byBox.get(item.boxId) ?? [];
      current.push(item);
      byBox.set(item.boxId, current);
    }
    this.pendingDispatchByBox = byBox;
  }
  async adoptNativeCopies() {
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
        if (!(error instanceof Error) || !error.message.startsWith("Copied box not found")) throw error;
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
    const paneScroll = capturePaneScroll(root);
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
    restorePaneScroll(root, paneScroll);
  }
  wireDivider(cols, divider) {
    divider.onmousedown = (e) => {
      e.preventDefault();
      const rect = cols.getBoundingClientRect();
      const style = getComputedStyle(cols);
      const paddingLeft = parseFloat(style.paddingLeft);
      const horizontalPadding = paddingLeft + parseFloat(style.paddingRight);
      const available = Math.max(0, rect.width - horizontalPadding - COLUMN_DIVIDER);
      this.columnResizeDrag = {
        cols,
        rectLeft: rect.left,
        paddingLeft,
        available
      };
    };
  }
  onColumnResizeMove(ev) {
    if (!this.columnResizeDrag) return;
    const { cols, rectLeft, paddingLeft, available } = this.columnResizeDrag;
    const rawTreeWidth = ev.clientX - rectLeft - paddingLeft;
    this.applyColumnRatio(cols, available > 0 ? rawTreeWidth / available : this.colRatio);
  }
  stopColumnResize() {
    this.columnResizeDrag = null;
  }
  clearRefreshTimer() {
    if (this.refreshTimer === null) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
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
    const prompt = "Please use the tent-role skill to create a new Tent and initialize its durable roles. Lightly confirm the workspace root and initial roles, then run `tent new <workspace>` to scaffold the in-workspace `.tent` layout. Tent state itself does not use Git.";
    await navigator.clipboard.writeText(prompt);
    new import_obsidian4.Notice("\u5DF2\u590D\u5236 tent-role \u8D77\u624B prompt");
  }
  // ---- 树 ----
  drawTree(el) {
    this.pendingByTarget = this.countPendingProposalsByBox();
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
    return hasTreePending({
      pendingProposals: this.pendingByTarget.get(box.id) ?? 0,
      pendingDispatches: this.pendingDispatchByBox.get(box.id)?.length ?? 0
    });
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
      wrap.style.setProperty("--zone-color", typeColorValue(void 0));
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
        e.dataTransfer.setDragImage(makeDragLabel(this.contentEl, box.name), 8, 8);
      }
    };
    row.createSpan({ cls: "tent-name", text: box.name });
    const split = splitType(box.type);
    const showType = this.registryUi.markedTypes.has(box.type) || this.registryUi.markedTypes.has(split.base) || !!split.modifier && this.registryUi.markedTypes.has(split.modifier) || box.id === this.selectedId;
    const owner = void 0;
    const showRole = false;
    if (showType || showRole) {
      const meta = row.createSpan({ cls: "tent-node-meta" });
      meta.createSpan({ cls: "tent-meta-sep", text: "\u2502" });
      if (showType) {
        const showBase = box.id === this.selectedId || this.registryUi.markedTypes.has(box.type) || this.registryUi.markedTypes.has(split.base);
        const showModifier = !!split.modifier && (box.id === this.selectedId || this.registryUi.markedTypes.has(box.type) || this.registryUi.markedTypes.has(split.modifier));
        if (showBase) {
          const tw = meta.createSpan({ cls: "tent-meta-type", text: split.base });
          tw.style.setProperty("--tent-type-color", typeColorValue(void 0));
        }
        if (showModifier && split.modifier) {
          if (showBase) meta.createSpan({ cls: "tent-meta-type-join", text: "-" });
          const tw = meta.createSpan({ cls: "tent-meta-type", text: split.modifier });
          tw.style.setProperty("--tent-type-color", typeColorValue(void 0));
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
    const pend = visibleTreeCount(box, isCollapsed, (item) => this.boxTriageCount(item));
    if (pend > 0) {
      const nb = rest.createSpan({ cls: "tent-slot-notif", text: String(pend) });
      tentTooltip(nb, isCollapsed ? `${pend} \u9879\u5F85\u88C1\uFF08\u542B\u5B50\u7EA7\uFF09` : `${pend} \u9879\u5F85\u88C1`);
    }
    if (box.invalid) {
      const pill = rest.createSpan({ cls: "tent-slot-status tent-spill tent-spill-invalid" });
      const ico = pill.createSpan();
      (0, import_obsidian4.setIcon)(ico, "triangle-alert");
      tentTooltip(pill, box.invalidReason || "\u5931\u6548\u6846");
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
    if (!box.archived && !box.invalid) {
      menu.addItem(
        (i) => i.setTitle("\u4E2D\u65AD\u91CA\u653E (active tasks)").setIcon("unlock").onClick(() => void this.requestForceRelease(box))
      );
    }
    if (!box.archived && !box.invalid) {
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
    const expandBtn = titleRow.createEl("button", { cls: "tent-prop-expand" });
    expandBtn.setAttr("type", "button");
    (0, import_obsidian4.setIcon)(expandBtn, this.propEditExpanded ? "chevron-up" : "chevron-down");
    tentTooltip(expandBtn, this.propEditExpanded ? "\u6536\u8D77\u5C5E\u6027" : "\u5C55\u5F00\u5C5E\u6027");
    expandBtn.onclick = () => {
      this.propEditExpanded = !this.propEditExpanded;
      this.draw();
    };
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
      this.drawTagsRow(editor, box);
      if (this.tagPickerOpen) this.drawTagPicker(editor, box);
    }
    this.drawBottom(card, box);
  }
  async dispatchBox(box, roleName, userPrompt) {
    const workspacePath = this.tent ? resolveTentWorkspace(this.tent) : void 0;
    const workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, roleName) : void 0;
    return dispatch(this.env(), box.id, roleName, { userPrompt, workspace });
  }
  tentRootAbsolutePath() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian4.FileSystemAdapter)) return null;
    return nodePath3.join(adapter.getBasePath(), this.tentRootPath());
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
      if (cur.fm.mode === "archived") return cur;
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
    const counts = bottomTabCounts({
      pendingDispatches: this.pendingDispatchByBox.get(box.id)?.length ?? 0,
      pendingProposals: this.pendingProposalsForBox(box.id).length,
      readyReports: this.readyDeliveriesForBox(box.id).length
    });
    const mkTab = (key, label, count = 0) => {
      const t = tabs.createDiv({ cls: "tent-bottom-tab" + (this.bottomTab === key ? " is-active" : "") });
      const parts = bottomTabParts(label, count);
      t.createSpan({ cls: "tent-bottom-tab-label", text: parts.label });
      if (parts.count) t.createSpan({ cls: "tent-bottom-tab-count", text: parts.count });
      t.onclick = () => {
        this.bottomTab = key;
        this.draw();
      };
    };
    mkTab("note", "\u7B14\u8BB0");
    mkTab("dispatch", "\u6D3E\u6D3B", counts.dispatch);
    mkTab("triage", "\u5F85\u88C1", counts.triage);
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
    const proposals = this.pendingProposalsForBox(box.id).length;
    const deliveries = this.readyDeliveriesForBox(box.id).length;
    const dispatches = this.pendingDispatchByBox.get(box.id)?.length ?? 0;
    return proposals + deliveries + dispatches;
  }
  readyDeliveries() {
    return this.deliveries.filter((d) => d.status === "ready");
  }
  readyDeliveriesForBox(boxId) {
    return this.readyDeliveries().filter((d) => d.boxId === boxId);
  }
  rejectedDeliveryForBox(boxId) {
    return this.deliveries.find((d) => d.boxId === boxId && d.status === "rejected");
  }
  taskForDelivery(delivery) {
    return this.tasks.find(
      (t) => t.id === delivery.taskId || t.path === delivery.taskId || t.activeDeliveryId === delivery.id
    );
  }
  // 待裁 tab:pending proposal + Delivery 完成待确认(中断释放 / 确认完成)
  drawTriageInline(body, actSlot, box) {
    const proposals = this.pendingProposalsForBox(box.id);
    const delivery = this.readyDeliveriesForBox(box.id)[0];
    const rejectedDelivery = this.rejectedDeliveryForBox(box.id);
    {
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
    if (proposals.length === 0 && !delivery) {
      body.createDiv({ cls: "tent-bottom-empty", text: "\u65E0\u5F85\u5904\u7406" });
      return;
    }
    if (proposals.length > 0) {
      body.createDiv({ cls: "tent-triage-sec", text: "\u5F85\u4F60\u5904\u7406\u7684\u63D0\u6848" });
      for (const proposal of proposals) {
        const item = body.createDiv({ cls: "tent-triage-item" });
        const main = item.createDiv({ cls: "tent-triage-main" });
        const first = proposal.body.split("\n").map((line) => line.trim()).find(Boolean) || "(\u65E0\u8BF4\u660E)";
        main.createDiv({ cls: "tent-triage-name", text: first });
        main.createDiv({ cls: "tent-triage-meta", text: `${proposal.role} \xB7 \u63D0\u6848` });
        const acts = item.createDiv({ cls: "tent-triage-acts" });
        const open2 = acts.createEl("button", { text: "\u6253\u5F00" });
        open2.setAttr("type", "button");
        open2.onclick = () => this.openVaultFile(proposal.path);
        const reject = acts.createEl("button", { text: "\u9A73\u56DE" });
        reject.setAttr("type", "button");
        reject.onclick = async () => {
          reject.setAttr("disabled", "true");
          try {
            await rejectProposal(this.env().fs, proposal.path);
            await this.refresh();
            new import_obsidian4.Notice("\u63D0\u6848\u5DF2\u9A73\u56DE");
          } catch (e) {
            reject.removeAttribute("disabled");
            new import_obsidian4.Notice("\u9A73\u56DE\u5931\u8D25:" + (e instanceof Error ? e.message : e));
          }
        };
        const accept = acts.createEl("button", { cls: "mod-cta", text: "\u786E\u8BA4" });
        accept.setAttr("type", "button");
        accept.onclick = async () => {
          accept.setAttr("disabled", "true");
          try {
            await acceptProposal(this.env().fs, proposal.path);
            await this.refresh();
            new import_obsidian4.Notice("\u63D0\u6848\u5DF2\u786E\u8BA4");
          } catch (e) {
            accept.removeAttribute("disabled");
            new import_obsidian4.Notice("\u786E\u8BA4\u5931\u8D25:" + (e instanceof Error ? e.message : e));
          }
        };
      }
    }
    if (delivery) {
      body.createDiv({ cls: "tent-triage-sec", text: "\u5F85\u786E\u8BA4\u4EA4\u4ED8" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      const first = delivery.summary.split("\n").map((line) => line.trim()).find(Boolean) || "(\u65E0\u8BF4\u660E)";
      main.createDiv({ cls: "tent-triage-name", text: first });
      main.createDiv({
        cls: "tent-triage-meta",
        text: `${delivery.role} \xB7 ${delivery.commits.length === 0 ? "\u65E0\u4EE3\u7801\u63D0\u4EA4" : `${delivery.commits.length} \u4E2A\u4EE3\u7801\u63D0\u4EA4`}`
      });
      const acts = item.createDiv({ cls: "tent-triage-acts" });
      const open2 = acts.createEl("button", { text: "\u6253\u5F00" });
      open2.setAttr("type", "button");
      open2.onclick = () => this.openVaultFile(delivery.path);
      const reject = acts.createEl("button", { text: "\u9A73\u56DE" });
      reject.setAttr("type", "button");
      reject.onclick = async () => {
        try {
          await this.rejectReadyDelivery(delivery);
          await this.refresh();
          new import_obsidian4.Notice("\u5DF2\u9A73\u56DE\uFF0C\u7B49\u5F85 agent \u91CD\u65B0\u4EA4\u4ED8");
        } catch (e) {
          new import_obsidian4.Notice("\u9A73\u56DE\u5931\u8D25:" + (e instanceof Error ? e.message : e));
        }
      };
      const done = acts.createEl("button", { cls: "mod-cta", text: "\u786E\u8BA4" });
      done.setAttr("type", "button");
      if (delivery.commits.length > 0) {
        const pick = body.createDiv({ cls: "tent-commit-pick" });
        pick.createDiv({ cls: "tent-commit-note", text: "\u8BFB\u53D6 delivery commits\u2026" });
        this.loadRoleCommits(delivery.role).then((commits) => {
          pick.empty();
          pick.createDiv({ cls: "tent-commit-head", text: "\u786E\u8BA4\u540E\u5C06\u5168\u90E8\u5408\u5165:" });
          const byRef = new Map((commits || []).map((commit) => [commit.ref, commit]));
          for (const ref of delivery.commits) {
            const commit = byRef.get(ref);
            const row = pick.createDiv({ cls: "tent-commit-row" });
            row.createSpan({ cls: "tent-commit-sha", text: commit?.shortRef || ref.slice(0, 8) });
            row.createSpan({ cls: "tent-commit-sub", text: commit?.subject || ref });
          }
        }).catch(() => {
          pick.empty();
          for (const ref of delivery.commits) {
            const row = pick.createDiv({ cls: "tent-commit-row" });
            row.createSpan({ cls: "tent-commit-sha", text: ref.slice(0, 8) });
            row.createSpan({ cls: "tent-commit-sub", text: ref });
          }
        });
      }
      done.onclick = async () => {
        done.setAttr("disabled", "true");
        try {
          await this.acceptReadyDelivery(delivery, {
            integrate: async (refs) => {
              const wp = this.tent ? resolveTentWorkspace(this.tent) : void 0;
              if (!wp) throw new Error("\u65E0\u6CD5\u4ECE in-workspace .tent \u89E3\u6790 workspace root");
              const contract = await ensureRoleWorkspace(wp, delivery.role);
              await integrateWorkspaceCommits(contract, refs);
            }
          });
          this.clearGitUiCache();
          await this.refresh();
          new import_obsidian4.Notice(
            delivery.commits.length ? `\u5DF2\u786E\u8BA4(\u5408\u5165 ${delivery.commits.length} commit)` : "\u5DF2\u786E\u8BA4\u4EA4\u4ED8"
          );
        } catch (e) {
          done.removeAttribute("disabled");
          new import_obsidian4.Notice("\u786E\u8BA4\u5931\u8D25:" + (e instanceof Error ? e.message : e));
        }
      };
    } else if (rejectedDelivery) {
      body.createDiv({ cls: "tent-triage-sec", text: "\u5904\u7406\u4E2D" });
      const item = body.createDiv({ cls: "tent-triage-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      main.createDiv({ cls: "tent-triage-name", text: `${rejectedDelivery.role} \xB7 \u4EA4\u4ED8\u5DF2\u9A73\u56DE` });
      main.createDiv({
        cls: "tent-triage-meta",
        text: "\u7B49\u5F85\u91CD\u65B0\u4EA4\u4ED8"
      });
    }
  }
  /** Offline plugin accept via task lifecycle (same semantics as task.accept). */
  async acceptReadyDelivery(delivery, options = {}) {
    const task = this.taskForDelivery(delivery);
    if (!task?.path) {
      throw new Error("No task envelope for this delivery; accept via Desktop Service / tent task accept.");
    }
    await taskAccept(this.env(), task.path, {
      actor: options.actor ?? "user",
      integrate: options.integrate
    });
  }
  /** Offline plugin reject via task lifecycle (resume running for resubmission). */
  async rejectReadyDelivery(delivery, note) {
    const task = this.taskForDelivery(delivery);
    if (!task?.path) {
      throw new Error("No task envelope for this delivery; reject via Desktop Service / tent task reject.");
    }
    await taskReject(this.env(), task.path, {
      actor: "user",
      note: note?.trim() || "User rejected; waiting for resubmission."
    });
  }
  pendingProposals() {
    return this.proposals.filter((proposal) => proposal.status === "pending");
  }
  pendingProposalsForBox(boxId) {
    return this.pendingProposals().filter((proposal) => proposal.boxId === boxId);
  }
  countPendingProposalsByBox() {
    const counts = /* @__PURE__ */ new Map();
    for (const proposal of this.pendingProposals()) {
      counts.set(proposal.boxId, (counts.get(proposal.boxId) ?? 0) + 1);
    }
    return counts;
  }
  // 读取某 role lane 尚未合入正式分支的 commit;无 in-workspace Git root 返回 null
  async loadRoleCommits(owner) {
    let wp;
    try {
      wp = this.tent ? resolveTentWorkspace(this.tent) : void 0;
    } catch {
      return null;
    }
    if (!wp) return null;
    const workspace = nodePath3.resolve(wp);
    return this.roleCommitsCache.get(`${workspace}\0${owner}`, () => listRoleCommitsFor(workspace, owner));
  }
  clearGitUiCache() {
    this.roleCommitsCache.clear();
  }
  // 派活内联:表单常驻；下方显示当前投递状态。
  drawDispatchInline(body, actSlot, box) {
    const pendingDispatch = this.pendingDispatchByBox.get(box.id)?.[0];
    body.createDiv({ cls: "tent-dispatch-sec", text: "\u6D3E\u6D3B\u8868\u5355" });
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
    const claim = canClaim(box);
    const blockedReason = pendingDispatch ? "\u5DF2\u6709\u6295\u9012\u7B49\u5F85\u63A5\u624B\u3002" : claim.reason || "";
    const run = actSlot.createEl("button", { cls: "tent-bottom-action", text: "\u6D3E\u6D3B\u63A5\u529B" });
    run.setAttr("type", "button");
    run.disabled = !!pendingDispatch || !claim.ok;
    if (run.disabled) tentTooltip(run, blockedReason);
    run.onclick = async () => {
      const roleName = roleSelect.value.trim() || manualRole.value.trim();
      if (!roleName) {
        new import_obsidian4.Notice("\u8BF7\u9009\u62E9\u6216\u8F93\u5165 role");
        return;
      }
      const localPrompt = prompt.value.trim();
      if (!localPrompt) {
        new import_obsidian4.Notice("\u8BF7\u586B\u5199 user prompt");
        return;
      }
      try {
        const r = await this.dispatchBox(box, roleName, localPrompt);
        if (this.plugin.settings.dispatchPrefs.copyPromptToClipboard) {
          await navigator.clipboard.writeText(r.relayPrompt);
          new import_obsidian4.Notice("\u5DF2\u6D3E\u6D3B\u3002\u5DF2\u590D\u5236\u63A5\u529B prompt,\u53BB\u76EE\u6807 agent \u4F1A\u8BDD\u7C98\u8D34\u3002", 6e3);
        } else {
          new import_obsidian4.Notice("\u5DF2\u6D3E\u6D3B\u3002\u63A5\u529B prompt \u5DF2\u751F\u6210\u3002", 6e3);
        }
        await this.refresh();
      } catch (e) {
        new import_obsidian4.Notice("\u6D3E\u6D3B\u5931\u8D25:" + (e instanceof Error ? e.message : e));
      }
    };
    if (pendingDispatch) {
      body.createDiv({ cls: "tent-dispatch-sec tent-dispatch-status-sec", text: "\u6295\u9012\u72B6\u6001" });
      const item = body.createDiv({ cls: "tent-triage-item tent-dispatch-status-item" });
      const main = item.createDiv({ cls: "tent-triage-main" });
      main.createDiv({
        cls: "tent-triage-name",
        text: `\u7B49\u5F85\u6295\u9012\u7ED9 ${pendingDispatch.task.role}`
      });
      main.createDiv({
        cls: "tent-triage-meta",
        text: "\u590D\u5236\u540E\u53EF\u65B0\u5F00\u6216\u590D\u7528\u76EE\u6807 role \u7684\u4F1A\u8BDD\uFF1B\u53EA\u6709 agent \u6267\u884C tent task claim \u540E\uFF0C\u6B64\u6761\u76EE\u624D\u4F1A\u6E05\u9664\u3002"
      });
      const acts = item.createDiv({ cls: "tent-triage-acts" });
      const copy = acts.createEl("button", { text: "\u590D\u5236\u6295\u9012 prompt" });
      copy.setAttr("type", "button");
      copy.onclick = async () => {
        try {
          const tentRoot = this.tentRootAbsolutePath();
          if (!tentRoot) throw new Error("\u65E0\u6CD5\u89E3\u6790\u5E10\u6839\u7EDD\u5BF9\u8DEF\u5F84");
          await navigator.clipboard.writeText(relayPromptForTask(pendingDispatch.task, tentRoot));
          new import_obsidian4.Notice(`\u5DF2\u590D\u5236\uFF0C\u53BB ${pendingDispatch.task.role} \u7684 agent \u4F1A\u8BDD\u7C98\u8D34\u5373\u53EF\u3002`);
        } catch (e) {
          new import_obsidian4.Notice("\u590D\u5236\u5931\u8D25:" + (e instanceof Error ? e.message : e));
        }
      };
      const cancel = acts.createEl("button", { text: "\u53D6\u6D88\u6295\u9012" });
      cancel.setAttr("type", "button");
      cancel.onclick = async () => {
        cancel.setAttr("disabled", "true");
        try {
          await cancelPendingTask(this.env(), pendingDispatch.task.path);
          await this.refresh();
          new import_obsidian4.Notice("\u5DF2\u53D6\u6D88\u6295\u9012");
        } catch (e) {
          new import_obsidian4.Notice("\u53D6\u6D88\u5931\u8D25:" + (e instanceof Error ? e.message : e));
        } finally {
          cancel.removeAttribute("disabled");
        }
      };
    } else {
      const activeTask = this.tasks.find(
        (t) => (t.state === "running" || t.state === "waiting" || t.state === "delivered" || t.state === "queued" || t.status === "pending" || t.status === "taken") && t.claims.includes(box.id)
      );
      if (activeTask) {
        body.createDiv({ cls: "tent-dispatch-sec tent-dispatch-status-sec", text: "\u6295\u9012\u72B6\u6001" });
        const state = body.createDiv({ cls: "tent-content-intro tent-dispatch-status-item is-stacked" });
        state.createDiv({
          cls: "tent-content-title",
          text: `${activeTask.role} \u6B63\u5728\u5904\u7406\u6B64\u6846`
        });
        state.createDiv({ cls: "tent-content-meta", text: "\u53EF\u5728\u300C\u5F85\u88C1\u300D\u4E2D\u67E5\u770B\u4EA4\u4ED8\u6216\u4E2D\u65AD\u4EFB\u52A1" });
      }
    }
  }
  // 正文:可编辑 textarea,blur 落盘。支持拖 Obsidian 文件进来转成帐根相对路径。
  drawNote(el, box) {
    const intro = el.createDiv({ cls: "tent-content-intro" });
    intro.createDiv({ cls: "tent-content-title", text: "\u7B14\u8BB0\u6B63\u6587" });
    intro.createDiv({
      cls: "tent-content-meta",
      text: !box.invalid && !box.archived ? "\u6D3E\u6D3B\u65F6\u4F5C\u4E3A\u6B64\u6846\u4E0A\u4E0B\u6587\u63D0\u4F9B\u7ED9 agent" : "\u65E0\u6548\u6216\u5DF2\u5C01\u5B58\u8282\u70B9\u4E0D\u53EF\u8FDB\u5165\u534F\u4F5C"
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
      modifier: sp.modifier && mods.includes(sp.modifier) ? sp.modifier : ""
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
    const modifierSel = row.createEl("select", { cls: "dropdown tent-newbox-type" });
    const none = modifierSel.createEl("option", { text: "\u65E0", value: "" });
    if (!state.modifier) none.selected = true;
    for (const m of mods) {
      const o = modifierSel.createEl("option", { text: m, value: m });
      if (m === state.modifier) o.selected = true;
    }
    modifierSel.onchange = () => state.modifier = modifierSel.value;
    const create = row.createEl("button", { cls: "mod-cta", text: "\u65B0\u5EFA" });
    create.setAttr("type", "button");
    create.onclick = async () => {
      if (!state.name) {
        new import_obsidian4.Notice("\u8BF7\u586B\u5199\u6846\u540D");
        return;
      }
      const type = joinType(state.base, state.modifier || void 0);
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
        new import_obsidian4.Notice(`\u5DF2\u4E2D\u65AD\u300C${box.name}\u300D\u7684 active tasks`);
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
    const fs2 = this.env().fs;
    const canvasRel = "_tent.canvas";
    try {
      const old = await fs2.exists(canvasRel) ? parseCanvas(await fs2.readFile(canvasRel)) : null;
      const fresh = buildCanvas(this.tent, this.tentRootPath());
      preservePositions(fresh, old, this.tent);
      await fs2.writeFile(canvasRel, canvasToJson(fresh));
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

// src/plugin/settings-model.ts
init_typeRegistry();
init_skillRoleRegistry();
var DEFAULT_RULES_TEMPLATE = "# {tent} - Project Rules\n\n> Local rules for this Tent; mechanism-level rules are provided by Tent and the tent-role / tent-task skills.\n\n- Output workspace: <real code repository path>\n- Commit / naming conventions: <fill in>\n- Other project rules: <fill in>\n";
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
    const role = normalizeRoleDefinition(item);
    if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
    roles.push(role);
  }
  return { roles };
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
      copyPromptToClipboard: typeof saved.dispatchPrefs?.copyPromptToClipboard === "boolean" ? saved.dispatchPrefs.copyPromptToClipboard : DEFAULT_SETTINGS.dispatchPrefs.copyPromptToClipboard
    },
    triageReminder,
    newTentDefaults: {
      typeRegistry,
      rolesRegistry,
      rulesTemplate
    }
  };
}

// src/plugin/settings.ts
var import_obsidian5 = require("obsidian");
init_typeRegistry();
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
    settingHeading(containerEl, "\u5E37\u5E44 / Tent");
    settingHeading(containerEl, "\u5E10");
    new import_obsidian5.Setting(containerEl).setName("\u5E10\u6839\u76EE\u5F55").setDesc("vault \u5185\u5B58\u653E\u5404\u5E10\u7684\u6587\u4EF6\u5939\u3002\u5E10\u4FDD\u5B58\u4E0A\u4E0B\u6587\u4E0E\u72B6\u6001\uFF0C\u672C\u8EAB\u4E0D\u4F7F\u7528 Git\u3002").addText(
      (t) => t.setValue(this.plugin.settings.tentsRoot).onChange(async (v) => {
        this.plugin.settings.tentsRoot = v.trim() || "tents";
        await this.plugin.saveSettings();
      })
    );
    this.drawNewTentDefaults(containerEl);
    settingHeading(containerEl, "\u5916\u89C2");
    new import_obsidian5.Setting(containerEl).setName("\u914D\u8272\u6A21\u5F0F").setDesc("\u8DDF\u968F Obsidian\uFF0C\u6216\u56FA\u5B9A\u4F7F\u7528\u5E10\u7684\u6D45\u8272 / \u6DF1\u8272\u914D\u8272\u3002").addDropdown(
      (dropdown) => dropdown.addOption("follow", "\u8DDF\u968F Obsidian").addOption("light", "\u6D45\u8272").addOption("dark", "\u6DF1\u8272").setValue(this.plugin.settings.appearance).onChange(async (value) => {
        this.plugin.settings.appearance = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
    settingHeading(containerEl, "\u4EA4\u4E92");
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
    settingHeading(parent, "\u65B0\u5EFA\u5E10\u9ED8\u8BA4\u503C");
    parent.createEl("p", {
      cls: "setting-item-description tent-settings-intro",
      text: "\u7528\u4E8E\u4E4B\u540E\u65B0\u5EFA\u7684\u5E10\uFF0C\u4E0D\u8986\u76D6\u5DF2\u6709\u5E10\u3002"
    });
    this.drawDefaultTypes(parent);
    this.drawDefaultRoles(parent);
    settingHeading(parent, "\u9ED8\u8BA4 RULES.md");
    const rules = new import_obsidian5.Setting(parent).setName("\u89C4\u5219\u6A21\u677F").setDesc("\u65B0\u5EFA\u5E10\u65F6\u5199\u5165 RULES.md\uFF1B{tent} \u4F1A\u66FF\u6362\u4E3A\u5E10\u540D\u3002");
    rules.settingEl.addClass("tent-settings-rules-row");
    rules.addTextArea((textarea) => {
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
    settingHeading(section, label);
    this.drawAddType(section, tier, label);
    for (const [name, definition] of Object.entries(registry)) {
      if ((definition.tier ?? "base") !== tier) continue;
      const row = section.createDiv({ cls: "tent-settings-registry-item" });
      const summary = new import_obsidian5.Setting(row).setName(name).setDesc(tier === "base" ? "\u4E00\u7EA7\uFF08\u56FA\u5B9A\u8BED\u4E49\uFF09" : "\u4E8C\u7EA7\u4FEE\u9970");
      summary.controlEl.createSpan({
        cls: "tent-settings-rw-summary",
        text: `tier:${definition.tier ?? "base"}`
      });
      if (!BUILTIN_TYPES.has(name) && tier === "modifier") {
        summary.addButton(
          (button) => button.setIcon("trash").setTooltip(`\u5220\u9664 ${name}`).onClick(async () => {
            delete this.plugin.settings.newTentDefaults.typeRegistry[name];
            this.openType = null;
            await this.plugin.saveSettings();
            this.display();
          })
        );
      }
    }
  }
  drawAddType(parent, tier, label) {
    let name = "";
    const form = new import_obsidian5.Setting(parent).setName(`\u65B0\u5EFA${label}`).setDesc(
      tier === "base" ? "V0.2 \u4E00\u7EA7 type \u56FA\u5B9A\u4E3A goal|prompt|output\uFF0C\u4E0D\u53EF\u5728\u6B64\u65B0\u5EFA\u3002" : "\u521B\u5EFA\u540E\u540D\u79F0\u4E0D\u53EF\u4FEE\u6539\u3002\u4EC5\u652F\u6301\u81EA\u5B9A\u4E49\u4E8C\u7EA7\uFF08modifier\uFF09\u3002"
    );
    form.settingEl.addClass("tent-settings-add-row");
    if (tier === "base") {
      return;
    }
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
        registry[normalized] = { tier: "modifier" };
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
function setOptionalText(target, key, value) {
  const text = value.trim();
  if (text) target[key] = text;
  else delete target[key];
}
function validRegistryName(name) {
  return !!name && name !== "temp" && !/[\s/\\-]/.test(name);
}
function settingHeading(parent, name) {
  return new import_obsidian5.Setting(parent).setName(name).setHeading();
}

// src/plugin/main.ts
var TENT_ICON = `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M50 14 88 82H12L50 14Z"/><path d="M50 14v68"/><path d="M50 82 35 56"/><path d="M50 82l15-26"/><path d="M22 82h56"/><circle cx="50" cy="14" r="4" fill="currentColor" stroke="none"/><circle cx="22" cy="82" r="4" fill="currentColor" stroke="none"/><circle cx="78" cy="82" r="4" fill="currentColor" stroke="none"/></svg>`;
var TentPlugin = class extends import_obsidian6.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.lastStatusCounts = null;
  }
  async onload() {
    await this.loadSettings();
    (0, import_obsidian6.addIcon)("tent", TENT_ICON);
    this.registerView(TENT_VIEW_TYPE, (leaf) => new TentView(leaf, this));
    this.addRibbonIcon("tent", "Open Tent panel", () => this.activateView());
    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "open-board-experimental",
      name: "Open or refresh experimental board",
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
    this.updateStatus({ triage: 0, dispatch: 0 });
    this.addSettingTab(new TentSettingTab(this.app, this));
  }
  onunload() {
    this.app.workspace.detachLeavesOfType(TENT_VIEW_TYPE);
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
  updateStatus(counts) {
    if (!this.statusEl) return;
    const previousTriage = this.lastStatusCounts?.triage ?? null;
    this.lastStatusCounts = counts;
    const total = statusBarTotal(counts);
    if (this.settings.triageReminder === "off") {
      this.statusEl.hide();
      return;
    }
    this.statusEl.show();
    this.statusEl.empty();
    this.statusEl.createSpan({ text: "\u26FA " });
    this.statusEl.createSpan({
      text: statusBarText(total),
      cls: total > 0 ? "tent-status-hot" : "tent-status-calm"
    });
    const noticeIncrease = statusIncreaseNoticeDelta(previousTriage, counts.triage);
    if (this.settings.triageReminder === "notice" && noticeIncrease !== null) {
      new import_obsidian6.Notice(statusIncreaseNoticeText(noticeIncrease));
    }
  }
  refreshStatusPreference() {
    this.updateStatus(this.lastStatusCounts ?? { triage: 0, dispatch: 0 });
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
