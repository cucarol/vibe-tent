import { FsAdapter } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "./frontmatter.js";
import { DEFAULT_TYPE_REGISTRY, TYPE_REGISTRY_PATH } from "./typeRegistry.js";
import type { TypeRegistry } from "./typeRegistry.js";
import { ROLES_REGISTRY_PATH } from "./skillRoleRegistry.js";
import type { RolesRegistry } from "./skillRoleRegistry.js";
import { DEFAULT_TAG_REGISTRY, TAGS_REGISTRY_PATH } from "./tags.js";
import { boxNotePath } from "./tree.js";
import { makeUniqueConceptId } from "./id.js";
import {
  ATTACHMENTS_DIR,
  RULES_PATH,
  TEMP_DIR,
  TENT_SYSTEM_DIR,
  systemRootFromWorkspace,
} from "./paths.js";

/** 顶层 concept:genesis grill 出的真名节点(非强制的通用 zone)。 */
export interface ScaffoldBox {
  name: string;   // 文件夹名 = 框身份(真名)
  type: string;   // OKF/Tent 单层 type
  body?: string;  // 身份笔记正文
  id?: string;    // 缺省自动生成 cx-
}

export interface ScaffoldTentOptions {
  name: string;
  /** 帐根 RULES.md 正文:本项目约定(global rule)。机制规范不进帐(见仓库 docs/SPEC.md)。 */
  rules: string;
  /** 顶层节点;由 genesis grill 决定。缺省 = 空帐(不强制建 zone)。 */
  boxes?: ScaffoldBox[];
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
  if (!options.rules.trim()) throw new Error("RULES.md content cannot be empty.");

  const usedIds = new Set<string>();
  for (const box of options.boxes ?? []) {
    const boxName = validateBoxName(box.name);
    const type = box.type.trim();
    if (!type) throw new Error(`Box ${boxName} is missing a primary type.`);
    const id = box.id?.trim() || makeUniqueConceptId(usedIds);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    await writeBox(fs, boxName, frontmatter, box.body ?? `# ${boxName}\n`);
  }

  await fs.mkdir(TEMP_DIR);
  await fs.mkdir(ATTACHMENTS_DIR);

  await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(options.typeRegistry ?? DEFAULT_TYPE_REGISTRY, null, 2) + "\n");
  await fs.writeFile(ROLES_REGISTRY_PATH, JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n");
  await fs.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n");
  await fs.writeFile(RULES_PATH, options.rules);
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

  const usedIds = new Set<string>();
  for (const box of options.boxes ?? []) {
    const boxName = validateBoxName(box.name);
    const type = box.type.trim();
    if (!type) throw new Error(`Box ${boxName} is missing a primary type.`);
    const id = box.id?.trim() || makeUniqueConceptId(usedIds);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    const path = nested(boxName);
    await workspaceFs.mkdir(path);
    await workspaceFs.writeFile(
      `${path}/${boxName}.md`,
      serializeFrontmatter(frontmatter, `\n${box.body ?? `# ${boxName}\n`}\n`, BOX_FRONTMATTER_KEY_ORDER)
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

export function validateBoxName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Box name cannot be empty.");
  if (name.length > 200) throw new Error("Box name cannot be longer than 200 characters.");
  if (/[\/\\]/.test(name)) throw new Error("Box name cannot contain path separators.");
  if (/[\r\n]/.test(name)) throw new Error("Box name cannot contain newlines.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) throw new Error("Box name cannot contain control characters.");
  return name;
}

async function writeBox(
  fs: FsAdapter,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<void> {
  await fs.mkdir(path);
  await fs.writeFile(boxNotePath(path), serializeFrontmatter(frontmatter, `\n${body}\n`, BOX_FRONTMATTER_KEY_ORDER));
}

export { systemRootFromWorkspace };
