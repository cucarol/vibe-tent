import {
  DEFAULT_TYPE_REGISTRY,
  normalizeRegistry,
  type TypeRegistry,
} from "../core/typeRegistry.js";
import { normalizeRoleDefinition, type RoleDefinition, type RolesRegistry } from "../core/skillRoleRegistry.js";

export type Appearance = "follow" | "light" | "dark";
export type TriageReminder = "off" | "status" | "notice";

interface NewTentDefaults {
  typeRegistry: TypeRegistry;
  rolesRegistry: RolesRegistry;
  rulesTemplate: string;
}

export interface TentSettings {
  /** vault 内存放各帐的根目录。每个子文件夹 = 一个帐。 */
  tentsRoot: string;
  /** 上次打开的帐(tentsRoot 下的子文件夹名)。 */
  activeTent: string;
  /** 面板外观:跟随 Obsidian 主题 / 强制浅 / 强制深。 */
  appearance: Appearance;
  dispatchPrefs: {
    copyPromptToClipboard: boolean;
  };
  triageReminder: TriageReminder;
  newTentDefaults: NewTentDefaults;
}

export const DEFAULT_RULES_TEMPLATE =
  "# {tent} - Project Rules\n\n" +
  "> Local rules for this Tent; mechanism-level rules are provided by Tent and the tent-agent skill.\n\n" +
  "- Output workspace: <real code repository path>\n" +
  "- Commit / naming conventions: <fill in>\n" +
  "- Other project rules: <fill in>\n";

const DEFAULT_ROLES_REGISTRY: RolesRegistry = { roles: [] };

export const DEFAULT_SETTINGS: TentSettings = {
  tentsRoot: "tents",
  activeTent: "",
  appearance: "follow",
  dispatchPrefs: {
    copyPromptToClipboard: true,
  },
  triageReminder: "status",
  newTentDefaults: {
    typeRegistry: cloneTypeRegistry(DEFAULT_TYPE_REGISTRY),
    rolesRegistry: { roles: [] },
    rulesTemplate: DEFAULT_RULES_TEMPLATE,
  },
};

export function cloneTypeRegistry(registry: TypeRegistry): TypeRegistry {
  return Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, { ...definition }]));
}

function cloneRolesRegistry(registry: RolesRegistry): RolesRegistry {
  return { roles: registry.roles.map((role) => ({ ...role })) };
}

function normalizeRoles(value: unknown): RolesRegistry {
  if (typeof value !== "object" || value === null) return cloneRolesRegistry(DEFAULT_ROLES_REGISTRY);
  const raw = value as { roles?: unknown };
  if (!Array.isArray(raw.roles)) return cloneRolesRegistry(DEFAULT_ROLES_REGISTRY);
  const roles: RoleDefinition[] = [];
  for (const item of raw.roles) {
    if (typeof item !== "object" || item === null) continue;
    const role = normalizeRoleDefinition(item as Record<string, unknown>);
    if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
    roles.push(role);
  }
  return { roles };
}

export function mergeSettings(raw: unknown): TentSettings {
  const saved = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<TentSettings> & {
    newTentTemplate?: {
      typeRegistry?: unknown;
      rolesRegistry?: unknown;
      rulesTemplate?: unknown;
    };
  };
  const appearance: Appearance =
    saved.appearance === "follow" || saved.appearance === "light" || saved.appearance === "dark"
      ? saved.appearance
      : (saved.appearance as string | undefined) === "warm"
        ? "light"
        : DEFAULT_SETTINGS.appearance;
  const legacyDefaults = saved.newTentTemplate;
  const defaults = saved.newTentDefaults;
  const typeRegistry = normalizeRegistry(defaults?.typeRegistry ?? legacyDefaults?.typeRegistry ?? DEFAULT_TYPE_REGISTRY);
  const rolesRegistry = normalizeRoles(defaults?.rolesRegistry ?? legacyDefaults?.rolesRegistry ?? DEFAULT_ROLES_REGISTRY);
  const rulesCandidate = defaults?.rulesTemplate ?? legacyDefaults?.rulesTemplate;
  const rulesTemplate =
    typeof rulesCandidate === "string" && rulesCandidate.trim() ? rulesCandidate : DEFAULT_RULES_TEMPLATE;
  const triageReminder: TriageReminder =
    saved.triageReminder === "off" || saved.triageReminder === "status" || saved.triageReminder === "notice"
      ? saved.triageReminder
      : DEFAULT_SETTINGS.triageReminder;
  return {
    tentsRoot: typeof saved.tentsRoot === "string" && saved.tentsRoot.trim() ? saved.tentsRoot : DEFAULT_SETTINGS.tentsRoot,
    activeTent: typeof saved.activeTent === "string" ? saved.activeTent : "",
    appearance,
    dispatchPrefs: {
      copyPromptToClipboard:
        typeof saved.dispatchPrefs?.copyPromptToClipboard === "boolean"
          ? saved.dispatchPrefs.copyPromptToClipboard
          : DEFAULT_SETTINGS.dispatchPrefs.copyPromptToClipboard,
    },
    triageReminder,
    newTentDefaults: {
      typeRegistry,
      rolesRegistry,
      rulesTemplate,
    },
  };
}
