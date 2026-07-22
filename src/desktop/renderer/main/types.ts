// Shared main-workbench view types (renderer-local; not Service wire types).

import type { TaskReviewItem } from "../../workbench/collaboration-ui.js";
import type {
  CoordinationTypeOption,
  ProfileOption,
  RoleOption,
} from "../../workbench/collaboration-ui.js";
import type {
  A2AApprovalItem,
  ProposalItem,
  TaskInputItem,
  ToolApprovalItem,
  UserAskItem,
} from "../../workbench/pending-interactions.js";

export type ConceptNode = {
  id: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  /**
   * Collaboration status from box.projection only (todo|doing|done).
   * Never populated from docs.list frontmatter / owner.
   */
  status?: string;
  /** Assignee from box.projection only when an active task occupies the box. */
  assignee?: string;
  mode?: "editable" | "read-only" | "archived";
  tags?: string[];
  children?: ConceptNode[];
};

export type TabView = {
  cx: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  etag: string;
  buffer: string;
  dirty: boolean;
  mode: "source" | "preview";
  nodeMode: "editable" | "read-only" | "archived";
  frontmatter: Record<string, unknown>;
  artifactRefs?: Array<{ kind: string; target: string; label?: string }>;
};

/** docs.backlinks hit for inspector (right rail only — not document body). */
export type BacklinkView = {
  cx: string;
  name: string;
  path: string;
  context?: string;
};

/** Normalized pending rows — see workbench/pending-interactions.ts. */
export type UserAskView = UserAskItem;
export type A2AApprovalView = A2AApprovalItem;
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
    tree: ConceptNode[];
    tabs: TabView[];
    activeCx: string | null;
    searchHits: Array<{ cx: string; name: string; snippet: string; match: string }>;
    statusMessage: string | null;
  } | null;
  tasks: Array<{
    path: string;
    role: string;
    status: string;
    claims: string[];
    state?: string;
    id?: string;
    prompt?: string;
    activeDeliveryId?: string;
    sessionId?: string;
  }>;
  taskReview?: TaskReviewItem[];
  roles?: RoleOption[];
  coordinationTypes?: CoordinationTypeOption[];
  profiles?: ProfileOption[];
  selectedProfileId?: string | null;
  statusMessage: string | null;
};

export type {
  CoordinationTypeOption,
  ProfileOption,
  RoleOption,
  TaskReviewItem,
};
