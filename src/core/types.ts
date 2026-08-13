// The Tent 核心类型。这一层是唯一真相,插件和 CLI 都 import 它。

export type NodeType = string;

/**
 * Collaboration progress for Task / Node collaboration projection (todo|doing|done).
 * Not a Node frontmatter field — Nodes no longer carry status.
 */
/**
 * Node lifecycle mode (document semantics; not Task state).
 * Absent on disk ≡ editable. Only archived inherits down the subtree.
 * V0.2: no read-only mode — archive is the freeze / soft-delete layer.
 */
export type NodeMode = "editable" | "archived";

/**
 * Semantic relation direction (first-class Node relations).
 * Source is always the owning Node; direction describes the edge, not storage location.
 */
export type RelationDirection = "directed" | "bidirectional";

/**
 * Exactly one target form:
 * - resolved: stable Node handle
 * - unresolved: explicit non-empty string (never silent-drop)
 */
export type RelationTarget = { nodeId: string } | { unresolved: string };

/**
 * First-class semantic relation record owned by the source Node frontmatter.
 * Source id is implied by the owning Node — never duplicated per record.
 */
export interface RelationRecord {
  /** Stable generated handle (`rl-…`). */
  id: string;
  /** Open identifier (not a registry). */
  kind: string;
  direction: RelationDirection;
  /** Optional human label; omit when absent. */
  label?: string;
  target: RelationTarget;
}

/** Node identity-file frontmatter. `type` is required and `id` is a cx- handle. */
export interface NodeFrontmatter {
  id: string;
  /** Optional direct semantic marker; no registry or tier semantics. */
  type?: NodeType;
  tags?: string[];
  /** Explicit mode only; omit for editable default. Only "archived" is persisted. */
  mode?: NodeMode;
  /**
   * Outgoing first-class semantic relations (source implied by this Node).
   * Not Markdown/wiki body links.
   */
  relations?: RelationRecord[] | Record<string, unknown>[];
  /** 允许 user 加自定义键,原样保留落盘（迁移会剥离 owner/status/R/W 等退役键）。 */
  [k: string]: unknown;
}

/**
 * Parsed in-memory Node.
 */
export interface Node {
  id: string;
  /** Optional direct semantic marker; never a lifecycle-validity gate. */
  type?: NodeType;
  tags: string[];
  /**
   * Outgoing semantic relations owned by this Node (normalized).
   * Independent of Markdown/wiki body links.
   */
  relations: RelationRecord[];
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
  fm: NodeFrontmatter;
  /** Exact content etag of the raw Node identity file read into this projection. */
  etag: string;
  /** Node identity-file body (the content after frontmatter). */
  body: string;
  children: Node[];
  parent: Node | null;
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
 * Task occupation lives only on Task.workNodeIds; Manifest is not a second source.
 */
export interface Manifest {
  tent: string;
  roleId?: string;
  sessionId?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  targetBranch?: string;
  readable: ManifestEntry[];
  writable: ManifestEntry[];
}
