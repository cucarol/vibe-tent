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
/** Structural marker for an initialized Tent system root. */
export const INDEX_PATH = "index.md";
/** Workspace collaboration settings (defaultAcceptMode, extensible). */
export const WORKSPACE_SETTINGS_PATH = "settings.json";
/**
 * First-class Node Markdown underline annotations (划线注释).
 * Independent of Node body / frontmatter / Task envelopes.
 */
export const ANNOTATIONS_PATH = "annotations.json";
export const TEMP_DIR = "temp";
export const ATTACHMENTS_DIR = "attachments";
/** Canonical operational namespaces. Neither directory is a Node tree. */
export const ROLES_TEMP_DIR = "roles";
export const SESSIONS_TEMP_DIR = "sessions";

/** Canonical Markdown identity file for a Node directory. */
export function nodeNotePath(nodePath: string): string {
  const separator = nodePath.lastIndexOf("/");
  const name = separator === -1 ? nodePath : nodePath.slice(separator + 1);
  return nodePath === "" ? ".md" : `${nodePath}/${name}.md`;
}

/** 不进入 Node 索引的顶层/路径前缀（相对 system root）。 */
export const OPERATIONAL_TOP_LEVEL = new Set([
  TEMP_DIR,
  ATTACHMENTS_DIR,
  // 若仍见嵌套 .tent，视为系统区而非 Node。
  TENT_SYSTEM_DIR,
]);

/** 系统注册表文件名（非 Node）。 */
export const SYSTEM_REGISTRY_FILES = new Set([
  TYPE_REGISTRY_PATH,
  ROLES_REGISTRY_PATH,
  TAGS_REGISTRY_PATH,
  ORDER_PATH,
  MUTATION_LOCK_PATH,
  WORKSPACE_SETTINGS_PATH,
  ANNOTATIONS_PATH,
  INDEX_PATH,
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

/**
 * Sanitize identity / Task id segments for operational directory names.
 * Deterministic, path-safe; not a security boundary.
 */
export function safeOperationalSegment(value: string, emptyPrefix = "id"): string {
  const source = value.trim();
  if (!source) throw new Error("Operational segment cannot be empty.");
  const normalized = source.normalize("NFKC");
  let clean = normalized
    .replace(/[<>:"/\\|?*\x00-\x1f~^:[\]@{}]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean);
  if (reserved) clean = `${emptyPrefix}-${clean}`;
  if (!clean) {
    // Short stable hash of the original so empty sanitization never collides on "".
    let h = 0;
    for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
    return `${emptyPrefix}-${h.toString(36)}`;
  }
  if (clean !== normalized || normalized !== source || reserved) {
    let h = 0;
    for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
    return `${clean}-${h.toString(36)}`;
  }
  return clean;
}

/** `temp/roles/<roleId>` root for durable Role Task records. */
export function roleTempRoot(roleId: string): string {
  return `${TEMP_DIR}/${ROLES_TEMP_DIR}/${safeOperationalSegment(roleId, "role")}`;
}

export function roleTasksDir(roleId: string): string {
  return `${roleTempRoot(roleId)}/tasks`;
}

export function roleDeliveriesDir(roleId: string): string {
  return `${roleTempRoot(roleId)}/deliveries`;
}

/** `temp/sessions/<sessionId>` root for Session-only Task records. */
export function sessionTempRoot(sessionId: string): string {
  return `${TEMP_DIR}/${SESSIONS_TEMP_DIR}/${safeOperationalSegment(sessionId, "session")}`;
}

export function sessionTasksDir(sessionId: string): string {
  return `${sessionTempRoot(sessionId)}/tasks`;
}

export function sessionDeliveriesDir(sessionId: string): string {
  return `${sessionTempRoot(sessionId)}/deliveries`;
}

/** Task-scoped immutable manifest path (never shared `manifest.yml`). */
export function taskManifestPath(ownerRoot: string, taskId: string): string {
  const safeTask = safeOperationalSegment(taskId, "task");
  return `${ownerRoot}/manifests/${safeTask}.yml`;
}

/** 是否为应排除在 Node 索引外的生成/系统文件名。 */
export function isSystemNoteName(fileName: string): boolean {
  return SYSTEM_REGISTRY_FILES.has(fileName) || fileName === "MIGRATED.md";
}
