// Tent 系统目录路径合同（B1）：协作事实落在 workspace 内固定名 `.tent/`。
// FsAdapter 的根是 tent system root（即 `<workspace>/.tent`），其内路径不再嵌套一层 `.tent/`。

/** 工作区内固定的 tent 系统目录名；合同冻结，B1 不重开命名。 */
export const TENT_SYSTEM_DIR = ".tent";

/** 相对 system root 的注册表与锁（adapter 已指向 system root 时无前缀）。 */
export const TYPE_REGISTRY_PATH = "types.json";
export const ROLES_REGISTRY_PATH = "roles.json";
export const TAGS_REGISTRY_PATH = "tags.json";
export const ORDER_PATH = "order.json";
export const MUTATION_LOCK_PATH = "mutation.lock";
export const RULES_PATH = "RULES.md";
/** Workspace collaboration settings (defaultDeliveryPolicy, extensible). */
export const WORKSPACE_SETTINGS_PATH = "settings.json";
export const TEMP_DIR = "temp";
export const ATTACHMENTS_DIR = "attachments";

/** 不进入 concept 索引的顶层/路径前缀（相对 system root）。 */
export const OPERATIONAL_TOP_LEVEL = new Set([
  TEMP_DIR,
  ATTACHMENTS_DIR,
  // 历史残留：若仍见嵌套 .tent，视为系统区而非 concept
  TENT_SYSTEM_DIR,
]);

/** 系统注册表文件名（非 concept）。 */
export const SYSTEM_REGISTRY_FILES = new Set([
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
  ORDER_PATH,
  MUTATION_LOCK_PATH,
  RULES_PATH,
  WORKSPACE_SETTINGS_PATH,
  "index.md",
  "log.md",
]);

/**
 * 若 system root 目录名是 `.tent`，其父目录即 workspace 根。
 * 否则无法从布局推导 workspace（纯协作目录 / 测试 fixture）。
 */
export function workspaceRootFromSystemRoot(systemRoot: string): string | undefined {
  const normalized = systemRoot.replace(/[\\/]+$/, "");
  const base = normalized.split(/[\\/]/).pop() ?? "";
  if (base !== TENT_SYSTEM_DIR) return undefined;
  const parent = normalized.replace(/[\\/]+[^\\/]+$/, "");
  return parent || undefined;
}

/** 从 workspace 根得到 system root 路径（字符串拼接，不访问磁盘）。 */
export function systemRootFromWorkspace(workspaceRoot: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${sep}${TENT_SYSTEM_DIR}`;
}

/** 路径是否落在 operational pipeline（相对 system root，posix 风格）。 */
export function isOperationalPath(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path) return false;
  const top = path.split("/")[0] ?? "";
  return OPERATIONAL_TOP_LEVEL.has(top);
}

/** 是否为应排除在 concept 索引外的生成/系统文件名。 */
export function isSystemNoteName(fileName: string): boolean {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}
