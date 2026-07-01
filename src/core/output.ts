export interface OutputPointer {
  workspace?: string;
  ref?: string;
}

/** 解析 output 框里的真实产出指针。frontmatter.workspace 优先,正文兼容旧字段。 */
export function parseOutputPointer(fm: Record<string, unknown>, body: string): OutputPointer {
  const result: OutputPointer = {};
  const fmWorkspace = fieldString(fm.workspace);
  if (fmWorkspace) result.workspace = fmWorkspace;
  const fmRef = fieldString(fm.ref);
  if (fmRef) result.ref = fmRef;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = normalizeLabelLine(rawLine);
    if (!result.workspace) {
      const workspace = matchField(line, ["workspace", "workspace 路径", "repo", "pointer", "路径"]);
      if (workspace) result.workspace = workspace;
    }
    if (!result.ref) {
      const ref = matchField(line, ["git ref", "git-ref", "当前 ref", "commit", "ref"]);
      if (ref) result.ref = ref;
    }
  }
  return result;
}

function fieldString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? cleanValue(value) : undefined;
}

function normalizeLabelLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function matchField(line: string, fields: string[]): string | undefined {
  for (const field of fields) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}\\s*[:：]\\s*(.+)$`, "i").exec(line);
    if (match) return cleanValue(match[1]);
  }
  return undefined;
}

function cleanValue(value: string): string {
  return value.trim().replace(/^`|`$/g, "").trim();
}
