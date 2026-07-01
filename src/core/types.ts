// The Tent 核心类型。这一层是唯一真相,插件和 CLI 都 import 它。

export type BoxType = string;

/** 三个语义 folder zone。temp 是无 type 的系统管道,不属于框树。 */
export type ZoneType = "goal" | "prompt" | "output";

export type Status = "todo" | "doing" | "done";

/** 框身份文件(<box-name>.md)的 frontmatter。type 必填;旧 kind 会被迁移/折入 type。 */
export interface BoxFrontmatter {
  id: string;
  type: BoxType;
  /** legacy: type/kind 合并前的二级分类。新写入不再使用。 */
  kind?: string;
  tags?: string[];
  archived?: boolean;
  readable?: boolean;
  writable?: boolean;
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

/** 解析进内存的框节点。 */
export interface Box {
  id: string;
  type: BoxType;
  /** legacy raw kind,仅供迁移/兼容显示。治理解析不再读取它。 */
  kind?: string;
  tags: string[];
  /** 自身或祖先 archived=true。归档子树强制 R/W=false。 */
  archived: boolean;
  /** 自身或祖先引用了不存在的 type。失效子树退出正常流程。 */
  invalid: boolean;
  /** 直接失效的根节点 id;子孙沿用。 */
  invalidRootId?: string;
  invalidReason?: string;
  /** 相对帐根的路径,如 "goal/挖新alpha"。 */
  path: string;
  /** 显示名 = 文件夹名。 */
  name: string;
  fm: BoxFrontmatter;
  /** 框身份文件正文(frontmatter 之后的部分)。 */
  body: string;
  children: Box[];
  parent: Box | null;
  /** 所属顶层 zone(自身是 zone 时即自己)。custom 顶层框无 zone。 */
  zone: ZoneType | null;
  /** owner 关系派生出的认领锁；不落盘。 */
  locked: boolean;
  lockSource?: "self" | "ancestor" | "descendant";
  lockOwner?: string;
  readable: ResolvedAxis;
  writable: ResolvedAxis;
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
