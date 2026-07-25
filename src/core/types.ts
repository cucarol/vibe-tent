// The Tent 核心类型。这一层是唯一真相,插件和 CLI 都 import 它。

export type BoxType = string;

/**
 * @deprecated Collaboration status is projected from Task/Session/Delivery.
 * Legacy frontmatter may still be present on disk until a later UI cutover;
 * Core does not write status on new Nodes. Prefer box.fm["status"] for lifecycle.
 */
export type Status = "todo" | "doing" | "done";

/**
 * Node lifecycle mode (document semantics; not Task state).
 * Absent on disk ≡ editable. Only archived inherits down the subtree.
 * V0.2: no read-only mode — archive is the freeze / soft-delete layer.
 */
export type NodeMode = "editable" | "archived";

/** concept 身份文件 frontmatter。type 必填。id 为 cx- handle（迁移前可有 bx-）。 */
export interface BoxFrontmatter {
  id: string;
  type: BoxType;
  tags?: string[];
  /** Explicit mode only; omit for editable default. Only "archived" is persisted. */
  mode?: NodeMode;
  /**
   * @deprecated Not written on new Nodes. Lifecycle may still dual-write for
   * transitional cleanup; read via fm["owner"] preferred. Not a Service wire field.
   */
  owner?: string;
  /**
   * @deprecated Not written on new Nodes. Collaboration progress lives on Task projection.
   * Lifecycle may still dual-write; read via fm["status"] preferred.
   */
  status?: Status;
  /** 允许 user 加自定义键,原样保留落盘（迁移会剥离领域 R/W 等退役键）。 */
  [k: string]: unknown;
}

/**
 * 解析进内存的 concept 节点。
 * 字段名 Box 为历史兼容；V0.2 每个有效 concept 均可被引用与派活。
 */
export interface Box {
  id: string;
  type: BoxType;
  tags: string[];
  /**
   * Effective node mode after inheritance.
   * archived cascades from archive root; editable is the default.
   */
  mode: NodeMode;
  /**
   * Convenience: effective mode === "archived" (self root or ancestor archive).
   * Exits normal collaboration / mutation set.
   */
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
  /**
   * @deprecated Derived from legacy fm.owner for transitional UI only.
   * Active Task envelopes are the occupation oracle.
   */
  locked: boolean;
  lockSource?: "self" | "ancestor" | "descendant";
  lockOwner?: string;
}

/** manifest 里 context pointer 的一条（非文件级 ACL）。 */
export interface ManifestEntry {
  id?: string;
  path: string;
  note?: string;
}

/**
 * Dispatch context card payload.
 * `readable` / `writable` keys are retained as **context pointer lists** for Agent
 * envelopes (claim scope + system paths), not domain R/W axes on Nodes.
 */
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
}
