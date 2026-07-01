import type { FsAdapter } from "./adapter.js";
import { parseFrontmatter } from "./frontmatter.js";
import { join } from "./tree.js";

export interface Handoff {
  path: string;
  fromBoxId: string;
  targetId: string;
  targetRole: string;
  fromRole: string;
  timestamp?: string;
  body: string;
}

/** Collect immutable handoff prompt pointers from every role lane. */
export async function loadHandoffs(fs: FsAdapter): Promise<Handoff[]> {
  const handoffs: Handoff[] = [];
  if (!(await fs.exists("temp"))) return handoffs;

  const roleDirs = await fs.listDir("temp");
  for (const roleDir of roleDirs) {
    if (!roleDir.isDir) continue;
    const dir = join("temp", roleDir.name, "handoffs");
    if (!(await fs.exists(dir))) continue;

    for (const entry of await fs.listDir(dir)) {
      if (entry.isDir || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      const handoff = parseHandoff(path, await fs.readFile(path), roleDir.name);
      if (handoff) handoffs.push(handoff);
    }
  }

  return handoffs.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "") || a.path.localeCompare(b.path));
}

export async function loadHandoff(fs: FsAdapter, inputPath: string): Promise<Handoff> {
  const path = normalizeHandoffPath(inputPath);
  if (!(await fs.exists(path))) throw new Error(`找不到 handoff: ${path}`);
  const sourceRole = path.split("/")[1] || "";
  const handoff = parseHandoff(path, await fs.readFile(path), sourceRole);
  if (!handoff) throw new Error(`handoff 格式无效: ${path}`);
  return handoff;
}

export async function validateDispatchHandoff(
  fs: FsAdapter,
  inputPath: string,
  targetId: string,
  targetRole: string
): Promise<Handoff> {
  const handoff = await loadHandoff(fs, inputPath);
  if (handoff.targetId !== targetId) {
    throw new Error(`handoff 目标是 ${handoff.targetId},不能派到 ${targetId}`);
  }
  if (handoff.targetRole !== targetRole) {
    throw new Error(`handoff 指定 role ${handoff.targetRole},不能派给 ${targetRole}`);
  }
  return handoff;
}

function parseHandoff(path: string, raw: string, sourceRole: string): Handoff | null {
  const { data, body } = parseFrontmatter(raw);
  if (data.type !== "handoff") return null;
  if (
    typeof data.from !== "string" ||
    typeof data.target !== "string" ||
    typeof data.role !== "string"
  ) {
    return null;
  }

  return {
    path,
    fromBoxId: data.from,
    targetId: data.target,
    targetRole: data.role,
    fromRole: typeof data.by === "string" && data.by ? data.by : sourceRole,
    timestamp: typeof data.ts === "string" ? data.ts : undefined,
    body: body.trim(),
  };
}

function normalizeHandoffPath(input: string): string {
  const path = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!/^temp\/[^/]+\/handoffs\/[^/]+\.md$/.test(path)) {
    throw new Error("handoff 必须指向 temp/<role>/handoffs/*.md");
  }
  return path;
}
