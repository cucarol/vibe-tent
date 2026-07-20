// 极简 frontmatter 解析/序列化。零依赖:框身份文件(<box-name>.md)的 frontmatter 是扁平 key: value,
// 不需要完整 YAML。只认标量(string/number/bool)、流式数组、块序列和行注释。

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
  /** 原文件里键的出现顺序,序列化时尽量保持。 */
  keyOrder: string[];
}

const FENCE = "---";
export const BOX_FRONTMATTER_KEY_ORDER = ["id", "type", "tags", "mode"];

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
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let valuePart = trimmed.slice(colon + 1).trim();
    // 砍掉行尾 ` # 注释`(简单实现:非引号内的 # 之后)
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

function stripInlineComment(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const hash = v.indexOf(" #");
  return hash === -1 ? v : v.slice(0, hash).trim();
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
  // YAML 流式数组: [item1, item2, ...]
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

function isBlockSequenceStart(line: string | undefined): boolean {
  return line !== undefined && /^\s*-\s*/.test(line);
}

function readBlockSequence(
  lines: string[],
  startIndex: number,
  key: string
): { value: unknown[]; nextIndex: number } {
  const value: unknown[] = [];
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

function coerceForKey(key: string, raw: string): unknown {
  if (key !== "commits") return coerce(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowArray(inner).map((item) => coerceCommitItem(item.trim()));
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

function splitFlowArray(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
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
  const s = String(v);
  // 需要引号的情况:含 YAML/flow 标点或首尾空白
  if (
    /^-?(?:\d+|\d*\.\d+)$/.test(s) ||
    /[:,#\[\]]/.test(s) ||
    s !== s.trim() ||
    s === ""
  ) {
    return JSON.stringify(s);
  }
  return s;
}
