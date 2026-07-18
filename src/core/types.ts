// The Tent 核心类型。这一层是唯一真相,插件和 CLI 都 import 它。

export type BoxType = string;

export type Status = "todo" | "doing" | "done";

/** concept 身份文件 frontmatter。type 必填。id 为 cx- handle（迁移前可有 bx-）。 */
export interface BoxFrontmatter {
  id: string;
  type: BoxType;
  tags?: string[];
  archived?: boolean;
  readable?: boolean;
  writable?: boolean;
  /** @deprecated 投影为 task assignee；迁移后新写入优先用 Task API。 */
  owner?: string;
  status?: Status;
  /** 允许 user 加自定义键,原样保留落盘。 */
  [k: string]: unknown;
}

/** 某条轴(readable/writable)解析后的终值 + 它从哪来。 */
export type AxisSource = "self" | "type" | "archived" | "invalid";

export interface ResolvedAxis {
  value: boolean;
  source: AxisSource;
}

/**
 * 解析进内存的 concept 节点。
 * box = coordination 开启的 concept；字段名 Box 为历史兼容。
 */
export interface Box {
  id: string;
  type: BoxType;
  tags: string[];
  /** 解析后的 type.coordination（来自注册表 capability，非名称硬编码）。 */
  coordination: boolean;
  /** 自身或祖先 archived=true。归档子树强制 R/W=false。 */
  archived: boolean;
  /** 自身或祖先引用了不存在的 type。失效子树退出正常流程。 */
  invalid: boolean;
  /** 直接失效的根节点 id;子孙沿用。 */
  invalidRootId?: string;
  invalidReason?: string;
  /** 相对帐根(system root)的路径,如 "goal/挖新alpha"。 */
  path: string;
  /** 显示名 = 文件夹名。 */
  name: string;
  fm: BoxFrontmatter;
  /** 框身份文件正文(frontmatter 之后的部分)。 */
  body: string;
  children: Box[];
  parent: Box | null;
  /** owner 关系派生出的认领锁；不落盘。 */
  locked: boolean;
  lockSource?: "self" | "ancestor" | "descendant";
  lockOwner?: string;
  readable: ResolvedAxis;
  writable: ResolvedAxis;
}

/** 是否为可承载协作生命周期的 box（coordination-enabled concept）。 */
export function isCoordinationBox(concept: Pick<Box, "coordination">): boolean {
  return concept.coordination === true;
}

/** manifest 里 readable/writable 的一条。 */
export interface ManifestEntry {
  id?: string;
  path: string;
  note?: string;
}

export interface Manifest {
  tent: string;
  role: string;
  claims: string[];
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  readable: ManifestEntry[];
  writable: ManifestEntry[];
  preloaded: string[];
}
