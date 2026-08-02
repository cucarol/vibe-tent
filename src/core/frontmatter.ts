// 极简 frontmatter 解析/序列化。零依赖：Node 身份文件（<node-name>.md）的 frontmatter 是扁平 key: value，
// 不需要完整 YAML。认标量(string/number/bool)、流式数组/映射、块序列(含对象项)和行注释。

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  /** 原文件里键的出现顺序,序列化时尽量保持。 */
  keyOrder: string[];
}

const FENCE = "---";
/** Canonical node identity key order; relations sits with other durable semantic fields. */
export const NODE_FRONTMATTER_KEY_ORDER = ["id", "type", "tags", "mode", "relations"];

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n")) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const end = text.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) {
    return { data: {}, body: raw, keyOrder: [] };
  }
  const fmBlock = text.slice(FENCE.length + 1, end);
  // body 从第二个 fence 行之后开始
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);

  const data: Record<string, unknown> = {};
  const keyOrder: string[] = [];
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Block sequence items belong to a prior key; never treat "- …" as a top-level key.
    if (/^-\s*/.test(trimmed)) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let valuePart = trimmed.slice(colon + 1).trim();
    // 砍掉行尾 ` # 注释`(简单实现:非引号内的 # 之后)
    valuePart = stripInlineComment(valuePart);
    if (
      (valuePart.startsWith("{") || valuePart.startsWith("[")) &&
      !flowCollectionCloses(valuePart)
    ) {
      const recovered = readLegacyMultilineFlowCollection(lines, i, valuePart);
      valuePart = recovered.value;
      i = recovered.nextIndex;
    }
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

function stripInlineComment(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const hash = v.indexOf(" #");
  return hash === -1 ? v : v.slice(0, hash).trim();
}

interface FlowCollectionScan {
  stack: string[];
  quote: '"' | "'" | null;
  invalid: boolean;
}

function scanFlowCollection(text: string, initial?: FlowCollectionScan): FlowCollectionScan {
  const state: FlowCollectionScan = initial ?? { stack: [], quote: null, invalid: false };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state.quote) {
      if (ch === "\\" && state.quote === '"' && i + 1 < text.length) {
        i += 1;
        continue;
      }
      if (ch === state.quote) state.quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state.quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      state.stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (state.stack.pop() !== expected) {
        state.invalid = true;
        return state;
      }
    }
  }
  return state;
}

function flowCollectionCloses(value: string): boolean {
  const state = scanFlowCollection(value);
  return !state.invalid && state.quote === null && state.stack.length === 0;
}

/**
 * Historical recovery for values emitted by the old minimal serializer, which
 * could place an unquoted multiline string inside a flow mapping/array.
 * Collection structure still has to be balanced; malformed input stays fail-loud.
 */
function readLegacyMultilineFlowCollection(
  lines: string[],
  startIndex: number,
  initialValue: string
): { value: string; nextIndex: number } {
  let value = initialValue;
  let state = scanFlowCollection(initialValue);
  if (state.invalid) {
    throw new Error("Invalid frontmatter YAML: malformed multiline flow collection.");
  }

  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*\s*:/.test(lines[i])) {
      throw new Error("Invalid frontmatter YAML: unterminated multiline flow collection.");
    }
    const continuation = `\n${lines[i]}`;
    value += continuation;
    state = scanFlowCollection(continuation, state);
    if (state.invalid) {
      throw new Error("Invalid frontmatter YAML: malformed multiline flow collection.");
    }
    if (state.quote === null && state.stack.length === 0) {
      return { value, nextIndex: i };
    }
  }
  throw new Error("Invalid frontmatter YAML: unterminated multiline flow collection.");
}

function coerce(v: string): unknown {
  if (v === "") return undefined;
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
  // YAML flow mapping: {k: v, ...}
  if (v.startsWith("{")) {
    if (!v.endsWith("}")) {
      throw new Error("Invalid frontmatter YAML: unterminated flow mapping.");
    }
    return parseFlowMapping(v);
  }
  // YAML 流式数组: [item1, item2, ...]
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

function isBlockSequenceStart(line: string | undefined): boolean {
  return line !== undefined && /^\s*-\s*/.test(line);
}

function leadingIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Block sequence reader.
 * Supports scalar items, flow maps/arrays, and multi-line mapping items:
 *   - id: rl-x
 *     kind: related
 */
function readBlockSequence(
  lines: string[],
  startIndex: number,
  key: string
): { value: unknown[]; nextIndex: number } {
  const value: unknown[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    const itemMatch = line.match(/^(\s*)-\s*(.*)$/);
    if (!itemMatch) break;
    const itemIndent = itemMatch[1].length;
    const rest = stripInlineComment(itemMatch[2].trim());
    i += 1;

    // Multi-line mapping item: "- key: value" then deeper "key: value" lines.
    const inlineMap = rest.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (inlineMap && !(rest.startsWith("{") || rest.startsWith("["))) {
      const obj: Record<string, unknown> = {};
      const firstKey = inlineMap[1];
      const firstVal = stripInlineComment(inlineMap[2].trim());
      obj[firstKey] = firstVal === "" ? undefined : coerceForKey(key, firstVal);
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
        obj[fieldKey] = fieldVal === "" ? undefined : coerceForKey(key, fieldVal);
        i += 1;
      }
      // Drop undefined placeholders from empty values.
      for (const k of Object.keys(obj)) {
        if (obj[k] === undefined) delete obj[k];
      }
      value.push(obj);
      continue;
    }

    value.push(rest === "" ? null : coerceForKey(key, rest));
  }
  return { value, nextIndex: i };
}

/** Parse a single-line flow mapping `{k: v, k2: v2}` (values may be nested flow collections). */
function parseFlowMapping(raw: string): Record<string, unknown> {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return {};
  const parts = splitFlowCollection(inner);
  const out: Record<string, unknown> = {};
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

function findTopLevelColon(s: string): number {
  let depth = 0;
  let quote: string | null = null;
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

/**
 * Split a flow collection inner string on top-level commas.
 * Respects quotes and nested `[]` / `{}`.
 */
function splitFlowCollection(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
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

function coerceForKey(key: string, raw: string): unknown {
  if (key !== "commits") return coerce(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowCollection(inner).map((item) => coerceCommitItem(item.trim()));
  }
  return coerceCommitItem(raw);
}

function coerceCommitItem(raw: string): unknown {
  return /^\d+$/.test(raw) ? raw : coerce(raw);
}

function parseDoubleQuoted(v: string): string {
  try {
    return JSON.parse(v) as string;
  } catch {
    return unescapeYamlDoubleQuoted(v.slice(1, -1));
  }
}

function unescapeYamlDoubleQuoted(value: string): string {
  const escapes: Record<string, string> = {
    "0": "\0",
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    e: "\x1b",
    '"': '"',
    "/": "/",
    "\\": "\\",
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

function normalizeValueForKey(key: string, value: unknown): unknown {
  if (key === "workspace" || key === "path" || key === "ref") {
    return normalizeWindowsPathValue(value);
  }
  if (key === "paths" && Array.isArray(value)) {
    return value.map((item) => normalizeWindowsPathValue(item));
  }
  return value;
}

function normalizeWindowsPathValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value)) return value;
  return value.replace(/\\{2,}/g, "\\");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 data 写回 frontmatter + body。undefined 的键被省略(= 删除该声明)。 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  body: string,
  keyOrder: string[] = []
): string {
  const keys = orderedKeys(data, keyOrder);
  const lines: string[] = [FENCE];
  for (const k of keys) {
    const val = data[k];
    if (val === undefined) continue;
    // Object arrays (e.g. relations) use a block sequence of flow maps for readability
    // and round-trip safety with the minimal parser.
    if (Array.isArray(val) && val.some(isPlainObject)) {
      lines.push(`${k}:`);
      if (val.length === 0) {
        // empty object-array still needs a representable form; use flow empty.
        // (Callers normally omit empty relations entirely.)
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

function orderedKeys(data: Record<string, unknown>, keyOrder: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
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

function emit(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    // YAML 流式数组: [item1, item2, ...]
    if (v.length === 0) return "[]";
    return "[" + v.map((item) => emit(item)).join(", ") + "]";
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (keys.length === 0) return "{}";
    return (
      "{" +
      keys.map((k) => `${k}: ${emit(v[k])}`).join(", ") +
      "}"
    );
  }
  const s = String(v);
  // 需要引号的情况:含 YAML/flow 标点、控制字符或首尾空白
  if (
    /^-?(?:\d+|\d*\.\d+)$/.test(s) ||
    /[:,#\[\]{}]/.test(s) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(s) ||
    s !== s.trim() ||
    s === ""
  ) {
    return JSON.stringify(s);
  }
  return s;
}
