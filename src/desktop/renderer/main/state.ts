// Central renderer state + Service RPC adapters.
// Components render from this module; they do not own backend state machines.

import type {
  AgentProfileProjection,
  DeliveryProjection,
  RoleRegistryEntryProjection,
  SessionProjection,
  TaskProjection,
  TypeRegistryEntryProjection,
} from "../../../service/types.js";
import {
  buildTaskReviewItems,
  listCoordinationTypeOptions,
  listProfileOptions,
  listRoleOptions,
  pickDefaultCoordinationType,
  pickDefaultProfileId,
  type CoordinationTypeOption,
  type ProfileOption,
  type RoleOption,
  type TaskReviewItem,
} from "../../workbench/collaboration-ui.js";
import type {
  A2AApprovalView,
  ConceptNode,
  ShellState,
  TabView,
  ToolApprovalView,
  UserAskView,
} from "./types.js";
import { setError } from "./elements.js";

/** Local editor state mirrors WorkspaceController via service RPC (not core FS). */
export const localTabs = new Map<string, TabView>();
export let activeCx: string | null = null;
export let tree: ConceptNode[] = [];
export let state: ShellState | null = null;
export let workspaceId: string | null = null;

/** Cached registry projections for create/dispatch pickers. */
export let coordinationTypes: CoordinationTypeOption[] = [];
export let roles: RoleOption[] = [];
export let taskReview: TaskReviewItem[] = [];
export let deliveries: DeliveryProjection[] = [];
export let sessions: SessionProjection[] = [];
export let userAsks: UserAskView[] = [];
export let a2aApprovals: A2AApprovalView[] = [];
export let toolApprovals: ToolApprovalView[] = [];
/** Product profiles from profile.list (safe metadata; no secrets). */
export let profiles: ProfileOption[] = [];
/** Selected machine-local profile for「启动 agent」— never auto-starts. */
export let selectedProfileId: string | null = null;

/** Draft form state (pure UI). */
export let createTypePick = "";
export let dispatchRole = "";
export let dispatchPrompt = "";
/** taskPath → inline reject reason draft */
export const rejectDrafts = new Map<string, string>();

export function setActiveCx(cx: string | null): void {
  activeCx = cx;
}

export function setTree(nodes: ConceptNode[]): void {
  tree = nodes;
}

export function setState(s: ShellState | null): void {
  state = s;
}

export function setWorkspaceId(id: string | null): void {
  workspaceId = id;
}

export function setCoordinationTypes(list: CoordinationTypeOption[]): void {
  coordinationTypes = list;
}

export function setRoles(list: RoleOption[]): void {
  roles = list;
}

export function setTaskReview(list: TaskReviewItem[]): void {
  taskReview = list;
}

export function setDeliveries(list: DeliveryProjection[]): void {
  deliveries = list;
}

export function setSessions(list: SessionProjection[]): void {
  sessions = list;
}

export function setUserAsks(list: UserAskView[]): void {
  userAsks = list;
}

export function setA2aApprovals(list: A2AApprovalView[]): void {
  a2aApprovals = list;
}

export function setToolApprovals(list: ToolApprovalView[]): void {
  toolApprovals = list;
}

export function setProfiles(list: ProfileOption[]): void {
  profiles = list;
}

export function setSelectedProfileId(id: string | null): void {
  selectedProfileId = id;
}

export function setCreateTypePick(value: string): void {
  createTypePick = value;
}

export function setDispatchRole(value: string): void {
  dispatchRole = value;
}

export function setDispatchPrompt(value: string): void {
  dispatchPrompt = value;
}

export function findConcept(nodes: ConceptNode[], id: string): ConceptNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findConcept(node.children || [], id);
    if (child) return child;
  }
  return undefined;
}

export function actionableTasks(): TaskReviewItem[] {
  return taskReview.filter((task) =>
    ["queued", "pending", "running", "taken", "waiting", "delivered"].includes(
      String(task.state || task.status || "")
    )
  );
}

export function pendingInteractionCount(): number {
  return userAsks.length + a2aApprovals.length + toolApprovals.length;
}

export function tasksForActiveNode(states?: string[]): TaskReviewItem[] {
  if (!activeCx) return [];
  return actionableTasks().filter((task) => {
    const st = String(task.state || task.status || "");
    return task.claims.includes(activeCx!) && (!states || states.includes(st));
  });
}

export function reconstruct(fm: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm || {})) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  lines.push(body.endsWith("\n") || body === "" ? body : body + "\n");
  return lines.join("\n");
}

export function splitBody(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return raw;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}

/** Host callbacks filled by app shell after modules load (avoids circular imports). */
export type StateHost = {
  renderTree: () => void;
  renderCreateTypeSelect: () => void;
  renderDispatchPanel: () => void;
  renderTasks: () => void;
  renderTaskInput: () => void;
  renderSessions: () => void;
  renderPendingInteractions: () => void;
};

let host: StateHost | null = null;

export function bindStateHost(h: StateHost): void {
  host = h;
}

export async function reloadTree(): Promise<void> {
  if (!workspaceId) return;
  const result = (await window.tentDesktop.rpc("docs.list", { workspaceId })) as {
    concepts: ConceptNode[];
  };
  tree = result.concepts || [];
  for (const [id, tab] of localTabs) {
    const concept = findConcept(tree, id);
    if (concept?.mode) tab.nodeMode = concept.mode;
  }
  host?.renderTree();
}

export async function reloadRegistry(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [typesResult, rolesResult] = await Promise.all([
      window.tentDesktop.rpc("registry.types", { workspaceId }) as Promise<{
        types: TypeRegistryEntryProjection[];
      }>,
      window.tentDesktop.rpc("registry.roles", { workspaceId }) as Promise<{
        roles: RoleRegistryEntryProjection[];
      }>,
    ]);
    coordinationTypes = listCoordinationTypeOptions(typesResult.types || []);
    roles = listRoleOptions(rolesResult.roles || []);
    if (!createTypePick || !coordinationTypes.some((t) => t.name === createTypePick)) {
      createTypePick = pickDefaultCoordinationType(coordinationTypes) || "";
    }
    if (!dispatchRole || !roles.some((r) => r.name === dispatchRole)) {
      dispatchRole = roles[0]?.name || "";
    }
    host?.renderCreateTypeSelect();
    host?.renderDispatchPanel();
  } catch (err) {
    setError(err);
  }
}

export async function reloadTasks(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [taskResult, deliveryResult, sessionResult] = await Promise.all([
      window.tentDesktop.rpc("task.list", { workspaceId }) as Promise<{ tasks: TaskProjection[] }>,
      window.tentDesktop.rpc("delivery.list", { workspaceId }) as Promise<{
        deliveries: DeliveryProjection[];
      }>,
      window.tentDesktop.rpc("session.list", { workspaceId }) as Promise<{
        sessions: SessionProjection[];
      }>,
    ]);
    deliveries = deliveryResult.deliveries || [];
    sessions = sessionResult.sessions || [];
    taskReview = buildTaskReviewItems(taskResult.tasks || [], deliveries, sessions);
    host?.renderTasks();
    host?.renderTaskInput();
    host?.renderSessions();
  } catch (err) {
    setError(err);
  }
}

export async function reloadPendingInteractions(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [askResult, a2aResult, toolResult] = await Promise.all([
      window.tentDesktop.rpc("userAsk.listPending", { workspaceId }) as Promise<{ asks: UserAskView[] }>,
      window.tentDesktop.rpc("a2a.listPending", { workspaceId }) as Promise<{
        approvals: A2AApprovalView[];
      }>,
      window.tentDesktop.rpc("toolApproval.listPending", { workspaceId }) as Promise<{
        approvals: ToolApprovalView[];
      }>,
    ]);
    userAsks = askResult.asks || [];
    a2aApprovals = a2aResult.approvals || [];
    toolApprovals = toolResult.approvals || [];
    host?.renderPendingInteractions();
  } catch (err) {
    setError(err);
  }
}

/** Load product profiles (testOnly hidden by service default). */
export async function reloadProfiles(): Promise<void> {
  try {
    const result = (await window.tentDesktop.rpc("profile.list", {})) as {
      profiles: AgentProfileProjection[];
    };
    profiles = listProfileOptions(result.profiles || []);
    if (!selectedProfileId || !profiles.some((p) => p.id === selectedProfileId)) {
      selectedProfileId = pickDefaultProfileId(profiles);
    }
    host?.renderTasks();
  } catch (err) {
    // Profiles are machine-local; show Chinese error when launch is attempted.
    profiles = [];
    selectedProfileId = null;
    setError(err);
  }
}
