import { FsAdapter } from "./adapter.js";
import { BOX_FRONTMATTER_KEY_ORDER, serializeFrontmatter } from "./frontmatter.js";
import { DEFAULT_TYPE_REGISTRY, TYPE_REGISTRY_PATH } from "./typeRegistry.js";
import type { TypeRegistry } from "./typeRegistry.js";
import { ROLES_REGISTRY_PATH } from "./skillRoleRegistry.js";
import type { RolesRegistry } from "./skillRoleRegistry.js";
import { DEFAULT_TAG_REGISTRY, TAGS_REGISTRY_PATH } from "./tags.js";
import { boxNotePath } from "./tree.js";
import { makeUniqueBoxId } from "./id.js";

/** 顶层框:genesis grill 出的真名节点(非强制的通用 zone)。 */
export interface ScaffoldBox {
  name: string;   // 文件夹名 = 框身份(真名)
  type: string;   // OKF/Tent 单层 type
  kind?: string;  // legacy: 若传入则折入 type
  body?: string;  // 身份笔记正文
  id?: string;    // 缺省自动生成
}

export interface ScaffoldTentOptions {
  name: string;
  /** 帐根 RULES.md 正文:本项目约定(global rule)。机制规范不进帐(见仓库 docs/SPEC.md)。 */
  rules: string;
  /** 顶层节点;由 genesis grill 决定。缺省 = 空帐(不强制建 goal/prompt/output zone)。 */
  boxes?: ScaffoldBox[];
  typeRegistry?: TypeRegistry;
  rolesRegistry?: RolesRegistry;
}

export async function scaffoldTent(fs: FsAdapter, options: ScaffoldTentOptions): Promise<void> {
  const name = options.name.trim();
  if (!name) throw new Error("Tent name cannot be empty.");
  if (!options.rules.trim()) throw new Error("RULES.md content cannot be empty.");

  const usedIds = new Set<string>();
  for (const box of options.boxes ?? []) {
    const boxName = validateBoxName(box.name);
    const type = (box.kind?.trim() || box.type.trim());
    if (!type) throw new Error(`Box ${boxName} is missing a primary type.`);
    const id = box.id?.trim() || makeUniqueBoxId(usedIds);
    usedIds.add(id);
    const frontmatter: Record<string, unknown> = { id, type };
    await writeBox(fs, boxName, frontmatter, box.body ?? `# ${boxName}\n`);
  }

  await fs.mkdir("temp");
  await fs.mkdir(".tent");

  await fs.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(options.typeRegistry ?? DEFAULT_TYPE_REGISTRY, null, 2) + "\n");
  await fs.writeFile(ROLES_REGISTRY_PATH, JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n");
  await fs.writeFile(TAGS_REGISTRY_PATH, JSON.stringify(DEFAULT_TAG_REGISTRY, null, 2) + "\n");
  await fs.writeFile("RULES.md", options.rules);
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
