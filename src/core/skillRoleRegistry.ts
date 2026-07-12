import { FsAdapter, withTentMutation } from "./adapter.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";

import { ROLES_REGISTRY_PATH } from "./paths.js";
export { ROLES_REGISTRY_PATH };

export interface RoleDefinition {
  name: string;
  prompt?: string;
  /** 一句话角色描述,注册表行上以灰字摘要显示。 */
  description?: string;
  /** 色板色名(gray/red/.../brown);注册表行左侧强调条 + owner 取色用。 */
  color?: string;
  /** Optional host-orchestrator hint. Tent records this but never spawns it. */
  cli?: RoleCliConfig;
}

export interface RoleCliConfig {
  command: string;
  resume?: string;
}

export interface RolesRegistry {
  roles: RoleDefinition[];
}

const DEFAULT_ROLES_REGISTRY: RolesRegistry = {
  roles: [],
};

const ROLES_CANDIDATES = [ROLES_REGISTRY_PATH, `.tent/${ROLES_REGISTRY_PATH}`];

export async function loadRolesRegistry(fs: FsAdapter): Promise<RolesRegistry> {
  for (const candidate of ROLES_CANDIDATES) {
    if (!(await fs.exists(candidate))) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(candidate)) as unknown;
      return normalizeRolesRegistry(parsed);
    } catch {
      const backupPath = await backupCorruptRegistry(fs, candidate);
      const reset = cloneDefaultRoles();
      // 写回被损坏的候选路径（兼容迁移窗口的嵌套 .tent/roles.json）
      await writeJson(fs, candidate, reset);
      if (candidate !== ROLES_REGISTRY_PATH) {
        await writeJson(fs, ROLES_REGISTRY_PATH, reset);
      }
      warnRegistryRecovered(
        candidate,
        backupPath,
        "reset",
        "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
      );
      return reset;
    }
  }
  return cloneDefaultRoles();
}

export async function createRole(fs: FsAdapter, definition: RoleDefinition): Promise<void> {
  await withTentMutation(fs, async () => {
    const role = normalizeRole(definition);
    if (!role.name) throw new Error("Role name cannot be empty.");
    const registry = await loadRolesRegistry(fs);
    if (registry.roles.some((item) => item.name === role.name)) throw new Error(`Role already exists: ${role.name}.`);
    registry.roles.push(role);
    await writeJson(fs, ROLES_REGISTRY_PATH, registry);
  });
}

export async function updateRole(fs: FsAdapter, name: string, patch: Partial<RoleDefinition>): Promise<void> {
  await withTentMutation(fs, async () => {
    const registry = await loadRolesRegistry(fs);
    const index = registry.roles.findIndex((role) => role.name === name);
    if (index === -1) throw new Error(`Role does not exist: ${name}.`);
    const next = normalizeRole({ ...registry.roles[index], ...patch, name });
    registry.roles[index] = next;
    await writeJson(fs, ROLES_REGISTRY_PATH, registry);
  });
}

export async function deleteRole(fs: FsAdapter, name: string, confirmation: string): Promise<void> {
  await withTentMutation(fs, async () => {
    if (confirmation !== name) throw new Error(`Confirmation mismatch; enter the role name ${name}.`);
    const registry = await loadRolesRegistry(fs);
    const next = registry.roles.filter((role) => role.name !== name);
    if (next.length === registry.roles.length) throw new Error(`Role does not exist: ${name}.`);
    await writeJson(fs, ROLES_REGISTRY_PATH, { roles: next });
  });
}

function normalizeRolesRegistry(value: unknown): RolesRegistry {
  const root = isRecord(value) ? value : {};
  const roles: RoleDefinition[] = [];

  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord(item)) continue;
      const role = normalizeRoleDefinition(item);
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      roles.push(role);
    }
  }

  return { roles };
}

export function normalizeRoleDefinition(value: Partial<RoleDefinition> | Record<string, unknown>): RoleDefinition {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const role: RoleDefinition = { name };
  if (typeof value.prompt === "string" && value.prompt.trim()) role.prompt = value.prompt.trim();
  if (typeof value.description === "string" && value.description.trim()) role.description = value.description.trim();
  if (typeof value.color === "string" && value.color.trim()) role.color = value.color.trim();
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}

function normalizeRole(value: Partial<RoleDefinition> | Record<string, unknown>): RoleDefinition {
  return normalizeRoleDefinition(value);
}

function normalizeCliConfig(value: unknown): RoleCliConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("role.cli must be an object.");
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) throw new Error("role.cli.command must be a non-empty string.");
  const cli: RoleCliConfig = { command };
  if (value.resume !== undefined) {
    const resume = typeof value.resume === "string" ? value.resume.trim() : "";
    if (!resume) throw new Error("role.cli.resume must be a non-empty string.");
    cli.resume = resume;
  }
  return cli;
}

function cloneDefaultRoles(): RolesRegistry {
  return {
    roles: DEFAULT_ROLES_REGISTRY.roles.map((role) => ({ ...role })),
  };
}

async function writeJson(fs: FsAdapter, path: string, value: unknown): Promise<void> {
  if (!(await fs.exists(".tent"))) await fs.mkdir(".tent");
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
