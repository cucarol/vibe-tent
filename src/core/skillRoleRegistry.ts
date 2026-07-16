import { FsAdapter, withTentMutation } from "./adapter.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";

import { ROLES_REGISTRY_PATH } from "./paths.js";
export { ROLES_REGISTRY_PATH };

/** Machine-readable A2A spawn authority (task-api §4). Default deny when omitted. */
export type RoleA2APolicy = "allow" | "ask" | "deny";

export interface RoleDefinition {
  name: string;
  prompt?: string;
  /** 一句话角色描述,注册表行上以灰字摘要显示。 */
  description?: string;
  /** 色板色名(gray/red/.../brown);注册表行左侧强调条 + owner 取色用。 */
  color?: string;
  /**
   * Whether this role may start AgentProfile sessions for other roles / itself via service.
   * Server-enforced; clients cannot override for ordinary role callers. Never store secrets here.
   * Default: deny.
   */
  a2aPolicy?: RoleA2APolicy;
  /**
   * Profile ids this role may use when a2aPolicy=allow (role caller startSession).
   * Store **ids only** — never credentials, tokens, or env values. Normalized to
   * trim + de-dupe non-empty strings. Omitted / empty means no profiles authorized
   * for autonomous allow (user root and user-approved ask may still override).
   */
  allowedProfiles?: string[];
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

/** 正常路径只读扁平 roles.json；嵌套 `.tent/roles.json` 由一次性迁移搬迁。 */
export async function loadRolesRegistry(fs: FsAdapter): Promise<RolesRegistry> {
  if (!(await fs.exists(ROLES_REGISTRY_PATH))) return cloneDefaultRoles();
  try {
    const parsed = JSON.parse(await fs.readFile(ROLES_REGISTRY_PATH)) as unknown;
    return normalizeRolesRegistry(parsed);
  } catch {
    const backupPath = await backupCorruptRegistry(fs, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs, ROLES_REGISTRY_PATH, reset);
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return reset;
  }
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
    // Explicit allowedProfiles on the patch (including empty) replaces the prior list.
    // Without this, `{ ...existing, ...patch }` cannot clear the field when normalize drops [].
    if (Object.prototype.hasOwnProperty.call(patch, "allowedProfiles")) {
      const normalized = normalizeAllowedProfiles(patch.allowedProfiles);
      if (normalized) next.allowedProfiles = normalized;
      else delete next.allowedProfiles;
    }
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
  const a2a = normalizeA2APolicy(value.a2aPolicy);
  if (a2a) role.a2aPolicy = a2a;
  const allowedProfiles = normalizeAllowedProfiles(value.allowedProfiles);
  if (allowedProfiles) role.allowedProfiles = allowedProfiles;
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
}

/** Resolve effective policy for a role definition (missing → deny). */
export function roleA2APolicy(role: RoleDefinition | undefined): RoleA2APolicy {
  return role?.a2aPolicy ?? "deny";
}

/**
 * Whether profileId is on the role's allowedProfiles whitelist.
 * Missing / empty list → not allowed for autonomous role allow path.
 * Comparison is exact on already-normalized ids (trim; case-sensitive).
 */
export function roleAllowsProfile(
  role: RoleDefinition | undefined,
  profileId: string
): boolean {
  const id = typeof profileId === "string" ? profileId.trim() : "";
  if (!id) return false;
  const allowed = role?.allowedProfiles;
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(id);
}

/**
 * Normalize allowedProfiles: trim each entry, drop empties, de-dupe (first wins).
 * Returns undefined when the field is absent or yields an empty list after normalize
 * so roles.json does not store empty arrays / credentials bags.
 */
export function normalizeAllowedProfiles(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    // Invalid shape ignored on load (same spirit as bad a2aPolicy) so a bad field
    // cannot wipe the registry. Mutations should validate via parse helpers.
    return undefined;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeA2APolicy(value: unknown): RoleA2APolicy | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  // Invalid values are ignored (effective deny) so a bad field cannot wipe the registry.
  return undefined;
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
