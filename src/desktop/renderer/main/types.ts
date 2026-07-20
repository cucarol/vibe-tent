// Shared main-workbench view types (renderer-local; not Service wire types).

import type { TaskReviewItem } from "../../workbench/collaboration-ui.js";
import type {
  CoordinationTypeOption,
  ProfileOption,
  RoleOption,
} from "../../workbench/collaboration-ui.js";

export type ConceptNode = {
  id: string;
  path: string;
  name: string;
  type: string;
  coordination: boolean;
  status?: string;
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

export type UserAskView = {
  id: string;
  taskPath: string;
  sessionId?: string;
  role?: string;
  question: string;
  choices?: Array<{ id: string; label: string }>;
  createdAt: string;
};

export type A2AApprovalView = {
  id: string;
  taskPath: string;
  role: string;
  profileId: string;
  createdAt: string;
};

export type ToolApprovalView = {
  id: string;
  sessionId: string;
  taskPath?: string;
  role?: string;
  toolTitle: string;
  options?: Array<{ optionId: string; kind?: string; name?: string }>;
  createdAt: string;
  expiresAt: string;
};

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
