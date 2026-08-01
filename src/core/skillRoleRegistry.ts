import { FsAdapter, withTentMutation } from "./adapter.js";
import {
  deterministicRoleIdFromName,
  isRoleId,
  makeUniqueRoleId,
  type RandomSource,
} from "./id.js";
import { backupCorruptRegistry, warnRegistryRecovered } from "./registryRecovery.js";

import { AGENT_PROFILES_TEMP_DIR, ROLES_REGISTRY_PATH } from "./paths.js";
export { ROLES_REGISTRY_PATH };

/**
 * Role registry row.
 *
 * Identity model (batch 1):
 * - `id` (`rl-…`) is immutable after create / migration fill.
 * - `displayName` is mutable **presentation only** — never used as a resolver key.
 * - `name` remains the operational path / envelope key (temp/<name>/, task.role,
 *   git lane labels). This batch does **not** rename name or move temp/worktrees;
 *   resolveRole accepts id | operational name only (legacy compat).
 */
export interface RoleDefinition {
  /**
   * Stable immutable handle (`rl-…`).
   * Optional on raw create/scaffold input; always present after normalize/load.
   */
  id?: string;
  /**
   * Operational key used by temp paths, task envelopes, and historical refs.
   * Immutable in this batch (moving temp/git is a later migration).
   */
  name: string;
  /**
   * Mutable human label. Defaults to `name` when omitted on disk.
   * Always present after normalize/load.
   */
  displayName?: string;
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

/** Role row after normalize/load — id and displayName are always filled. */
export type LoadedRoleDefinition = RoleDefinition & {
  id: string;
  displayName: string;
};

/** On-disk / scaffold template shape (id/displayName may be omitted before normalize). */
export interface RolesRegistry {
  roles: RoleDefinition[];
}

/** In-memory registry after load/normalize. */
export interface LoadedRolesRegistry {
  roles: LoadedRoleDefinition[];
}

const DEFAULT_ROLES_REGISTRY: LoadedRolesRegistry = {
  roles: [],
};

/**
 * 正常路径只读扁平 roles.json；嵌套 `.tent/roles.json` 由一次性迁移搬迁。
 * 旧行缺 id/displayName 时在**内存**确定性投影；普通 read **不写盘**。
 * 其他持久化只发生在 create/update/delete 等显式 mutation。
 */
export async function loadRolesRegistry(fs: FsAdapter): Promise<LoadedRolesRegistry> {
  const { registry } = await readRolesRegistryState(fs);
  return registry;
}

/** Same as loadRolesRegistry — kept for mutation call sites. */
async function loadRolesRegistryForMutation(fs: FsAdapter): Promise<LoadedRolesRegistry> {
  return loadRolesRegistry(fs);
}

async function readRolesRegistryState(fs: FsAdapter): Promise<{
  registry: LoadedRolesRegistry;
  recovered: boolean;
}> {
  if (!(await fs.exists(ROLES_REGISTRY_PATH))) {
    return {
      registry: cloneDefaultRoles(),
      recovered: false,
    };
  }
  try {
    const rawText = await fs.readFile(ROLES_REGISTRY_PATH);
    const parsed = JSON.parse(rawText) as unknown;
    const registry = normalizeRolesRegistry(parsed);
    return { registry, recovered: false };
  } catch {
    const backupPath = await backupCorruptRegistry(fs, ROLES_REGISTRY_PATH);
    const reset = cloneDefaultRoles();
    await writeJson(fs, ROLES_REGISTRY_PATH, serializeRolesRegistry(reset));
    warnRegistryRecovered(
      ROLES_REGISTRY_PATH,
      backupPath,
      "reset",
      "IMPORTANT: role definitions cannot be inferred; restore needed roles from the backup."
    );
    return {
      registry: reset,
      recovered: true,
    };
  }
}

export async function createRole(
  fs: FsAdapter,
  definition: RoleDefinition,
  rand: RandomSource = Math.random
): Promise<void> {
  await withTentMutation(fs, async () => {
    const registry = await loadRolesRegistryForMutation(fs);
    const usedIds = roleIdSet(registry.roles);
    const role = normalizeRoleDefinition(definition, {
      usedIds,
      assignMissingId: "random",
      rand,
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
    await writeJson(fs, ROLES_REGISTRY_PATH, serializeRolesRegistry(registry));
  });
}

/** Names that would collide with Tent-owned operational directories. */
export function assertRoleNameAvailable(name: string): void {
  if (name.trim().toLowerCase() === AGENT_PROFILES_TEMP_DIR) {
    throw new Error(`Role name is reserved by Tent: ${AGENT_PROFILES_TEMP_DIR}.`);
  }
}

/**
 * Update role fields. `ref` is roleId or operational name (never displayName).
 * Cannot change `id`. This batch also refuses operational `name` renames (temp/git
 * paths stay put); only `displayName` and metadata may change for identity surface.
 */
export async function updateRole(
  fs: FsAdapter,
  ref: string,
  patch: Partial<RoleDefinition>
): Promise<void> {
  await withTentMutation(fs, async () => {
    const registry = await loadRolesRegistryForMutation(fs);
    const index = findRoleIndex(registry.roles, ref);
    if (index === -1) throw new Error(`Role does not exist: ${ref}.`);
    const current = registry.roles[index]!;

    if (patch.id !== undefined && patch.id !== current.id) {
      throw new Error("Role id is immutable.");
    }
    if (patch.name !== undefined && patch.name.trim() !== current.name) {
      throw new Error(
        "Role operational name cannot be renamed in this batch (temp/path migration is deferred); change displayName instead."
      );
    }

    const next = normalizeRoleDefinition(
      {
        ...current,
        ...patch,
        id: current.id,
        name: current.name,
      },
      { usedIds: roleIdSet(registry.roles, current.id), assignMissingId: "keep" }
    );

    // Explicit displayName clear falls back to operational name (never empty).
    if (Object.prototype.hasOwnProperty.call(patch, "displayName")) {
      const dn =
        typeof patch.displayName === "string" ? patch.displayName.trim() : "";
      next.displayName = dn || current.name;
    }

    registry.roles[index] = next;
    await writeJson(fs, ROLES_REGISTRY_PATH, serializeRolesRegistry(registry));
  });
}

/**
 * Delete by roleId or operational name (never displayName). Confirmation must
 * equal the operational `name` (historical contract) or the stable `id`.
 */
export async function deleteRole(fs: FsAdapter, ref: string, confirmation: string): Promise<void> {
  await withTentMutation(fs, async () => {
    const registry = await loadRolesRegistryForMutation(fs);
    const index = findRoleIndex(registry.roles, ref);
    if (index === -1) throw new Error(`Role does not exist: ${ref}.`);
    const role = registry.roles[index]!;
    if (confirmation !== role.name && confirmation !== role.id) {
      throw new Error(
        `Confirmation mismatch; enter the role name ${role.name} or id ${role.id}.`
      );
    }
    registry.roles.splice(index, 1);
    await writeJson(fs, ROLES_REGISTRY_PATH, serializeRolesRegistry({ roles: registry.roles }));
  });
}

/**
 * Resolve a role reference from task/session/UI.
 * Order: exact `rl-` id, then operational `name`.
 * `displayName` is presentation only and is **never** a resolver key
 * (duplicate display names must be harmless).
 */
export function resolveRole(
  roles: readonly RoleDefinition[],
  ref: string
): RoleDefinition | undefined {
  const key = typeof ref === "string" ? ref.trim() : "";
  if (!key) return undefined;
  const byId = roles.find((role) => role.id === key);
  if (byId) return byId;
  return roles.find((role) => role.name === key);
}

export function findRoleIndex(roles: readonly RoleDefinition[], ref: string): number {
  const key = typeof ref === "string" ? ref.trim() : "";
  if (!key) return -1;
  let idx = roles.findIndex((role) => role.id === key);
  if (idx !== -1) return idx;
  return roles.findIndex((role) => role.name === key);
}

function normalizeRolesRegistry(value: unknown): LoadedRolesRegistry {
  const root = isRecord(value) ? value : {};
  const roles: LoadedRoleDefinition[] = [];
  const usedIds = new Set<string>();

  if (Array.isArray(root.roles)) {
    for (const item of root.roles) {
      if (!isRecord(item)) continue;
      const role = normalizeRoleDefinition(item, {
        usedIds,
        assignMissingId: "deterministic",
      });
      if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
      if (roles.some((existing) => existing.id === role.id)) continue;
      usedIds.add(role.id);
      roles.push(role);
    }
  }

  return { roles };
}

export interface NormalizeRoleOptions {
  usedIds?: Set<string>;
  /**
   * - random: new create (collision-checked random rl-)
   * - deterministic: legacy fill from name
   * - keep: require existing valid id (or fill deterministic as last resort)
   */
  assignMissingId?: "random" | "deterministic" | "keep";
  rand?: RandomSource;
}

export function normalizeRoleDefinition(
  value: Partial<RoleDefinition> | Record<string, unknown>,
  opts: NormalizeRoleOptions = {}
): LoadedRoleDefinition {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const usedIds = opts.usedIds ?? new Set<string>();
  const assign = opts.assignMissingId ?? "deterministic";

  let id = typeof value.id === "string" ? value.id.trim() : "";
  if (id && !isRoleId(id)) {
    // Invalid id treated as missing so corrupt rows still load.
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

  const displayRaw =
    typeof value.displayName === "string" ? value.displayName.trim() : "";
  const displayName = displayRaw || name;

  const role: LoadedRoleDefinition = { id, name, displayName };
  if (typeof value.prompt === "string" && value.prompt.trim()) role.prompt = value.prompt.trim();
  if (typeof value.description === "string" && value.description.trim()) {
    role.description = value.description.trim();
  }
  if (typeof value.color === "string" && value.color.trim()) role.color = value.color.trim();
  const cli = normalizeCliConfig(value.cli);
  if (cli) role.cli = cli;
  return role;
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

function roleIdSet(roles: readonly RoleDefinition[], exceptId?: string): Set<string> {
  const set = new Set<string>();
  for (const role of roles) {
    if (!role.id) continue;
    if (exceptId && role.id === exceptId) continue;
    set.add(role.id);
  }
  return set;
}

/** Disk shape: always write id + displayName; omit empty optionals. */
function serializeRolesRegistry(registry: LoadedRolesRegistry): LoadedRolesRegistry {
  return {
    roles: registry.roles.map((role) => {
      const row: LoadedRoleDefinition = {
        id: role.id,
        name: role.name,
        displayName: role.displayName || role.name,
      };
      if (role.prompt) row.prompt = role.prompt;
      if (role.description) row.description = role.description;
      if (role.color) row.color = role.color;
      if (role.cli) row.cli = { ...role.cli };
      return row;
    }),
  };
}

function cloneDefaultRoles(): LoadedRolesRegistry {
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

// Re-export normalize helper used by tests that imported internal shape.
export { normalizeRolesRegistry };
