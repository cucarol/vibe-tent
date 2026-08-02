import { FsAdapter } from "./adapter.js";
import { NODE_FRONTMATTER_KEY_ORDER, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  assertValidNodeType,
  DEFAULT_TYPE_REGISTRY,
  TYPE_REGISTRY_PATH,
} from "./typeRegistry.js";
import type { TypeRegistry } from "./typeRegistry.js";
import { ROLES_REGISTRY_PATH } from "./skillRoleRegistry.js";
import type { RolesRegistry } from "./skillRoleRegistry.js";
import { DEFAULT_TAG_REGISTRY, TAGS_REGISTRY_PATH } from "./tags.js";
import { nodeNotePath } from "./tree.js";
import { isNodeId, makeUniqueNodeId } from "./id.js";
import {
  ATTACHMENTS_DIR,
  INDEX_PATH,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
  isOperationalPath,
  isSystemNoteName,
  systemRootFromWorkspace,
} from "./paths.js";

/** Registry files that count as clear Tent evidence and may be default-filled on re-adopt. */
const RECOGNIZED_REGISTRY_PATHS = [
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
] as const;

/** 顶层 Node: genesis grill 产生的具名节点（非强制通用顶层文件夹）。 */
export interface ScaffoldNode {
  name: string;   // 文件夹名 = 框身份(真名)
  type: string;   // OKF/Tent 单层 type
  body?: string;  // 身份笔记正文
  id?: string;    // 缺省自动生成 cx-
}

export interface ScaffoldTentOptions {
  name: string;
  /** 顶层节点;由 genesis grill 决定。缺省 = 空帐(不强制建顶层文件夹)。 */
  nodes?: ScaffoldNode[];
  typeRegistry?: TypeRegistry;
  rolesRegistry?: RolesRegistry;
}

/**
 * 在 **tent system root**（`<workspace>/.tent`）上 scaffold。
 * 调用方须把 FsAdapter 根指向 system root；本函数不写外置 vault 双路径。
 */
export async function scaffoldTent(fs: FsAdapter, options: ScaffoldTentOptions): Promise<void> {
  const name = options.name.trim();
  if (!name) throw new Error("Tent name cannot be empty.");

  const typeRegistry = options.typeRegistry ?? DEFAULT_TYPE_REGISTRY;
  const usedIds = new Set<string>();
  for (const node of options.nodes ?? []) {
    const nodeName = validateNodeName(node.name);
    const type = node.type.trim();
    if (!type) throw new Error(`Node ${nodeName} is missing a primary type.`);
    assertValidNodeType(type, typeRegistry);
    const id = node.id?.trim() || makeUniqueNodeId(usedIds);
    if (!isNodeId(id)) throw new Error(`Scaffold Node id must use canonical cx-* form: ${id}`);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    await writeNode(fs, nodeName, frontmatter, node.body ?? `# ${nodeName}\n`);
  }

  await fs.mkdir(TEMP_DIR);
  await fs.mkdir(ATTACHMENTS_DIR);

  await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(typeRegistry, null, 2) + "\n");
  await fs.writeFile(ROLES_REGISTRY_PATH, JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n");
  await fs.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n");
  await fs.writeFile(INDEX_PATH, tentIndexMarker());
}

/**
 * 在 **workspace 根** 上创建 in-workspace tent：`<workspace>/.tent/`。
 * 会确保 workspace `.gitignore` 忽略 `.tent/`（若仓库使用 Git 且文件可写）。
 * 不创建外置 vault 路径，不双写。
 */
export async function scaffoldInWorkspace(
  workspaceFs: FsAdapter,
  options: ScaffoldTentOptions
): Promise<{ systemRootRelative: string }> {
  const systemRelative = TENT_SYSTEM_DIR;
  if (await workspaceFs.exists(systemRelative)) {
    throw new Error(`Target already has a Tent system dir: ${systemRelative}`);
  }
  await workspaceFs.mkdir(systemRelative);
  // Nested adapter-style paths under workspace root
  const nested = (p: string) => `${systemRelative}/${p}`.replace(/\\/g, "/");

  const typeRegistry = options.typeRegistry ?? DEFAULT_TYPE_REGISTRY;
  const usedIds = new Set<string>();
  for (const node of options.nodes ?? []) {
    const nodeName = validateNodeName(node.name);
    const type = node.type.trim();
    if (!type) throw new Error(`Node ${nodeName} is missing a primary type.`);
    assertValidNodeType(type, typeRegistry);
    const id = node.id?.trim() || makeUniqueNodeId(usedIds);
    if (!isNodeId(id)) throw new Error(`Scaffold Node id must use canonical cx-* form: ${id}`);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    const path = nested(nodeName);
    await workspaceFs.mkdir(path);
    await workspaceFs.writeFile(
      `${path}/${nodeName}.md`,
      serializeFrontmatter(frontmatter, `\n${node.body ?? `# ${nodeName}\n`}\n`, NODE_FRONTMATTER_KEY_ORDER)
    );
  }

  await workspaceFs.mkdir(nested(TEMP_DIR));
  await workspaceFs.mkdir(nested(ATTACHMENTS_DIR));
  await workspaceFs.writeFile(
    nested(TYPE_REGISTRY_PATH),
    JSON.stringify(typeRegistry, null, 2) + "\n"
  );
  await workspaceFs.writeFile(
    nested(ROLES_REGISTRY_PATH),
    JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n"
  );
  await workspaceFs.writeFile(
    nested(TAGS_REGISTRY_PATH),
    JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n"
  );
  await workspaceFs.writeFile(nested(INDEX_PATH), tentIndexMarker());

  await ensureWorkspaceGitignore(workspaceFs);
  return { systemRootRelative: systemRelative };
}

/**
 * Result of a successful one-shot re-adopt of an orphan in-workspace `.tent/`.
 * Only missing structural pieces are created; existing bytes are never rewritten.
 */
export interface ReAdoptOrphanTentResult {
  systemRootRelative: string;
  /** Always true on success — re-adopt only runs when index.md was absent. */
  createdIndex: true;
  /** Required empty dirs that were missing and created (`temp`, `attachments`). */
  createdDirs: string[];
  /** Missing registry basenames written with scaffold defaults. */
  createdRegistries: string[];
  /** Whether workspace `.gitignore` gained a `.tent/` entry (or was created). */
  gitignoreUpdated: boolean;
}

/**
 * One-shot Core re-adopt for a workspace that already has `.tent/` with Tent evidence
 * but no current valid index marker.
 *
 * Preconditions (all checked before any write; failure → zero writes):
 * - `.tent/` exists
 * - `index.md` is **absent** (present valid index → already a Tent; present invalid/non-index → refuse overwrite)
 * - clear evidence: at least one recognized registry (`types.json` / `roles.json` / `tags.json`)
 *   **or** at least one Markdown Node whose frontmatter `id` is a durable `cx-` handle
 *
 * On success: preserve every existing file byte-for-byte; add only the current index marker,
 * missing required empty dirs, missing registry defaults, and `.tent/` gitignore coverage.
 * Never deletes, renames, or rewrites Nodes, roles, temp history, or other user content.
 */
export async function reAdoptOrphanTent(
  workspaceFs: FsAdapter
): Promise<ReAdoptOrphanTentResult> {
  const systemRelative = TENT_SYSTEM_DIR;
  const nested = (p: string) => `${systemRelative}/${p}`.replace(/\\/g, "/");

  if (!(await workspaceFs.exists(systemRelative))) {
    throw new Error(
      `Cannot re-adopt: workspace has no ${TENT_SYSTEM_DIR}/ system directory.`
    );
  }

  const indexRel = nested(INDEX_PATH);
  if (await workspaceFs.exists(indexRel)) {
    const raw = await workspaceFs.readFile(indexRel);
    if (isValidTentIndexMarker(raw)) {
      throw new Error(
        `Cannot re-adopt: ${TENT_SYSTEM_DIR}/${INDEX_PATH} already marks a valid Tent.`
      );
    }
    throw new Error(
      `Cannot re-adopt: ${TENT_SYSTEM_DIR}/${INDEX_PATH} exists but is not a valid Tent index marker; refusing to overwrite ambiguous content.`
    );
  }

  const hasEvidence = await hasOrphanTentEvidence(workspaceFs, nested);
  if (!hasEvidence) {
    throw new Error(
      `Cannot re-adopt: ${TENT_SYSTEM_DIR}/ has no recognized Tent evidence ` +
        `(expected a registry file or a Markdown Node with durable cx- id).`
    );
  }

  // Plan missing pieces from pure reads, then write only what is absent.
  const createdDirs: string[] = [];
  for (const dir of [TEMP_DIR, ATTACHMENTS_DIR]) {
    const rel = nested(dir);
    if (!(await workspaceFs.exists(rel))) createdDirs.push(dir);
  }

  const createdRegistries: string[] = [];
  const registryBodies = new Map<string, string>();
  for (const reg of RECOGNIZED_REGISTRY_PATHS) {
    const rel = nested(reg);
    if (await workspaceFs.exists(rel)) continue;
    createdRegistries.push(reg);
    registryBodies.set(reg, defaultRegistryBody(reg));
  }

  const gitignoreWillUpdate = await workspaceGitignoreNeedsTentEntry(workspaceFs);

  // Writes only after preconditions + plan are complete.
  for (const dir of createdDirs) {
    await workspaceFs.mkdir(nested(dir));
  }
  for (const reg of createdRegistries) {
    await workspaceFs.writeFile(nested(reg), registryBodies.get(reg)!);
  }
  await workspaceFs.writeFile(indexRel, tentIndexMarker());
  if (gitignoreWillUpdate) {
    await ensureWorkspaceGitignore(workspaceFs);
  }

  return {
    systemRootRelative: systemRelative,
    createdIndex: true,
    createdDirs,
    createdRegistries,
    gitignoreUpdated: gitignoreWillUpdate,
  };
}

/** True when raw content is a structural Tent index marker (`type: index`). */
export function isValidTentIndexMarker(raw: string): boolean {
  try {
    const { data } = parseFrontmatter(raw);
    return data.type === "index";
  } catch {
    return false;
  }
}

async function hasOrphanTentEvidence(
  workspaceFs: FsAdapter,
  nested: (p: string) => string
): Promise<boolean> {
  for (const reg of RECOGNIZED_REGISTRY_PATHS) {
    if (await workspaceFs.exists(nested(reg))) return true;
  }
  // Scan Node content only — never operational/system subtrees under system root.
  return hasDurableNodeView(workspaceFs, "");
}

/**
 * Depth-first scan for Markdown Nodes with durable `cx-` ids.
 * Paths are relative to system root (`.tent/` contents). Skips operational
 * top-level subtrees (`temp/`, `attachments/`, nested `.tent/`) so Task history
 * and attachment dumps cannot masquerade as Node evidence; arbitrary real
 * content folders remain eligible.
 */
async function hasDurableNodeView(
  workspaceFs: FsAdapter,
  systemRelDir: string
): Promise<boolean> {
  if (systemRelDir && isOperationalPath(systemRelDir)) return false;

  const workspaceDir = systemRelDir
    ? `${TENT_SYSTEM_DIR}/${systemRelDir}`.replace(/\\/g, "/")
    : TENT_SYSTEM_DIR;

  let entries: { name: string; isDir: boolean }[];
  try {
    entries = await workspaceFs.listDir(workspaceDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const childSystemRel = systemRelDir
      ? `${systemRelDir}/${entry.name}`.replace(/\\/g, "/")
      : entry.name;
    if (entry.isDir) {
      // Exclude temp/, attachments/, nested .tent/ at system-root top (and their descendants).
      if (isOperationalPath(childSystemRel)) continue;
      if (await hasDurableNodeView(workspaceFs, childSystemRel)) return true;
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    // index.md / log.md / other system note basenames are not durable Nodes.
    if (isSystemNoteName(entry.name)) continue;
    const workspaceFile = `${workspaceDir}/${entry.name}`.replace(/\\/g, "/");
    let raw: string;
    try {
      raw = await workspaceFs.readFile(workspaceFile);
    } catch {
      continue;
    }
    try {
      const { data } = parseFrontmatter(raw);
      const id = typeof data.id === "string" ? data.id.trim() : "";
      if (id && isNodeId(id)) return true;
    } catch {
      // Unreadable / invalid frontmatter is not evidence.
    }
  }
  return false;
}

function defaultRegistryBody(reg: string): string {
  if (reg === TYPE_REGISTRY_PATH) {
    return JSON.stringify(DEFAULT_TYPE_REGISTRY, null, 2) + "\n";
  }
  if (reg === ROLES_REGISTRY_PATH) {
    return JSON.stringify({ roles: [] }, null, 2) + "\n";
  }
  if (reg === TAGS_REGISTRY_PATH) {
    return JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n";
  }
  throw new Error(`Unknown registry path for re-adopt defaults: ${reg}`);
}

async function workspaceGitignoreNeedsTentEntry(workspaceFs: FsAdapter): Promise<boolean> {
  const path = ".gitignore";
  const entry = `${TENT_SYSTEM_DIR}/`;
  if (!(await workspaceFs.exists(path))) return true;
  const text = await workspaceFs.readFile(path);
  const lines = text.split(/\r?\n/);
  return !lines.some((line) => {
    const t = line.trim();
    return t === entry || t === TENT_SYSTEM_DIR || t === `/${entry}` || t === `/${TENT_SYSTEM_DIR}`;
  });
}

/** 确保 workspace 根 `.gitignore` 含 `.tent/` 条目。 */
export async function ensureWorkspaceGitignore(workspaceFs: FsAdapter): Promise<void> {
  const path = ".gitignore";
  const entry = `${TENT_SYSTEM_DIR}/`;
  if (!(await workspaceFs.exists(path))) {
    await workspaceFs.writeFile(path, `${entry}\n`);
    return;
  }
  const text = await workspaceFs.readFile(path);
  const lines = text.split(/\r?\n/);
  const has = lines.some((line) => {
    const t = line.trim();
    return t === entry || t === TENT_SYSTEM_DIR || t === `/${entry}` || t === `/${TENT_SYSTEM_DIR}`;
  });
  if (has) return;
  const next = text.endsWith("\n") || text === "" ? `${text}${entry}\n` : `${text}\n${entry}\n`;
  await workspaceFs.writeFile(path, next);
}

export function validateNodeName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Node name cannot be empty.");
  if (name.length > 200) throw new Error("Node name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Node name cannot contain path separators.");
  if (/[\r\n]/.test(name)) throw new Error("Node name cannot contain newlines.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) throw new Error("Node name cannot contain control characters.");
  return name;
}

export function tentIndexMarker(): string {
  return `---\ntype: index\nokf_version: "0.1"\n---\n# Index\n`;
}

async function writeNode(
  fs: FsAdapter,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<void> {
  await fs.mkdir(path);
  await fs.writeFile(nodeNotePath(path), serializeFrontmatter(frontmatter, `\n${body}\n`, NODE_FRONTMATTER_KEY_ORDER));
}

export { systemRootFromWorkspace };
