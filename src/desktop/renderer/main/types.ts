// Shared main-workbench view types (renderer-local; not Service wire types).

import type { TaskReviewItem } from "../../workbench/collaboration-ui.js";
import type { TaskContextCard } from "../../../core/task-context-card.js";
import type {
  CoordinationTypeOption,
  ConnectionOption,
  RoleOption,
} from "../../workbench/collaboration-ui.js";
import type {
  ProposalItem,
  TaskInputItem,
  ToolApprovalItem,
  DecisionRequestItem,
} from "../../workbench/pending-interactions.js";

/**
 * Tree row model for the Node workbench.
 * `coordination` is a local usable alias (!invalid && !archived) — not Core wire.
 */
export type NodeView = {
  nodeId: string;
  path: string;
  name: string;
  type: string;
  /** Local usable flag for collaboration UI. */
  coordination: boolean;
  invalid?: boolean;
  archived?: boolean;
  /**
   * Derived presentation marker while activeTask is present.
   */
  status?: string;
  /** Assignee from node.collaboration while an active Task occupies this Node. */
  assignee?: string;
  mode?: "editable" | "archived";
  tags?: string[];
  children?: NodeView[];
};

export type TabView = {
  nodeId: string;
  path: string;
  name: string;
  type: string;
  /** Local usable flag for collab UI (legacy name). */
  coordination: boolean;
  etag: string;
  buffer: string;
  dirty: boolean;
  mode: "source" | "preview";
  nodeMode: "editable" | "archived";
  frontmatter: Record<string, unknown>;
  artifactRefs?: Array<{ kind: string; target: string; label?: string }>;
};

/** docs.backlinks hit for inspector (right rail only — not document body). */
export type BacklinkView = {
  nodeId: string;
  name: string;
  path: string;
  context?: string;
};

/** Normalized pending rows — see workbench/pending-interactions.ts. */
export type DecisionRequestView = DecisionRequestItem;
export type ToolApprovalView = ToolApprovalItem;
export type TaskInputView = TaskInputItem;
export type ProposalView = ProposalItem;

export type ShellState = {
  health: {
    status: string;
    pid?: number;
    version?: string;
    url?: string;
    workspaceCount?: number;
  };
  workspaces: Array<{
    workspaceId: string;
    workspaceRoot: string;
    tentName: string;
    foreground: boolean;
  }>;
  foregroundWorkspaceId: string | null;
  workspace: {
    tree: NodeView[];
    tabs: TabView[];
    activeCx: string | null;
    searchHits: Array<{ nodeId: string; name: string; snippet: string; match: string }>;
    statusMessage: string | null;
  } | null;
  tasks: Array<{
    path: string;
    roleId?: string;
    workNodeIds: string[];
    contextNodeIds: string[];
    state: string;
    acceptMode: import("../../../service/types.js").TaskProjection["acceptMode"];
    id?: string;
    prompt?: string;
    activeDeliveryId?: string;
    sessionId?: string;
    contextCard: TaskContextCard;
  }>;
  taskReview?: TaskReviewItem[];
  roles?: RoleOption[];
  coordinationTypes?: CoordinationTypeOption[];
  connections?: ConnectionOption[];
  selectedConnectionId?: string | null;
  statusMessage: string | null;
};

export type {
  CoordinationTypeOption,
  ConnectionOption,
  RoleOption,
  TaskReviewItem,
};
