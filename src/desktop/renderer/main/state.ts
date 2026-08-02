// Central renderer state + Service RPC adapters.
// Components render from this module; they do not own backend state machines.

import type {
  DeliveryProjection,
  NodeCollaborationsResult,
  RoleRegistryEntryProjection,
  SessionProjection,
  AgentConnectionProjection,
  TaskProjection,
  TypeRegistryEntryProjection,
} from "../../../service/types.js";
import {
  applyNodeCollaborationsToTree,
  collectUsableNodeIds,
  normalizeNodeCollaboration,
  type NodeCollaborationView,
} from "../../workbench/node-collaboration.js";
import {
  buildTaskReviewItems,
  isActionableTaskState,
  listCoordinationTypeOptions,
  listConnectionOptions,
  listRoleOptions,
  pickDefaultCoordinationType,
  pickDefaultConnectionId,
  type CoordinationTypeOption,
  type ConnectionOption,
  type RoleOption,
  type TaskReviewItem,
} from "../../workbench/collaboration-ui.js";
import {
  isPendingInteractionEventType,
  isTaskProjectionEventType,
  normalizeProposalList,
  normalizeTaskInputList,
  normalizeToolApprovalList,
  normalizeUserAskList,
  pendingInteractionCount as countPendingParts,
  type ProposalItem,
  type TaskInputItem,
  type ToolApprovalItem,
  type UserAskItem,
} from "../../workbench/pending-interactions.js";
import type { BacklinkView, NodeView, ShellState, TabView } from "./types.js";
import { setError } from "./elements.js";

/** Local editor state mirrors WorkspaceController via service RPC (not core FS). */
export const localTabs = new Map<string, TabView>();
export let activeCx: string | null = null;
export let tree: NodeView[] = [];
export let state: ShellState | null = null;
export let workspaceId: string | null = null;

/**
 * Canonical node.collaboration projection by nodeId.
 * Cleared on workspace switch; never derived from frontmatter.
 */
export const nodeCollaborations = new Map<string, NodeCollaborationView>();
/** docs.backlinks for the active node (inspector only). */
export let activeBacklinks: BacklinkView[] = [];
export let activeBacklinksError: string | null = null;

/** Cached registry projections for create/dispatch pickers. */
export let coordinationTypes: CoordinationTypeOption[] = [];
export let roles: RoleOption[] = [];
export let taskReview: TaskReviewItem[] = [];
export let deliveries: DeliveryProjection[] = [];
export let sessions: SessionProjection[] = [];
export let userAsks: UserAskItem[] = [];
export let toolApprovals: ToolApprovalItem[] = [];
/** U2A one-shot pending inputs — independent type, never folded into UserAsk. */
export let taskInputs: TaskInputItem[] = [];
/** Pending proposal triage (separate from delivery review). */
export let proposals: ProposalItem[] = [];
/** Machine-local Agent Connections from connection.list (safe metadata; no secrets). */
export let connections: ConnectionOption[] = [];
/** Selected machine-local Connection metadata in the shared renderer state. */
export let selectedConnectionId: string | null = null;

/** Draft form state (pure UI). */
export let createTypePick = "";
export let dispatchRole = "";
export let dispatchPrompt = "";
/** taskPath → inline reject reason draft */
export const rejectDrafts = new Map<string, string>();

export function setActiveCx(cx: string | null): void {
  activeCx = cx;
}

export function setTree(nodes: NodeView[]): void {
  tree = nodes;
}

export function setState(s: ShellState | null): void {
  state = s;
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

export function setUserAsks(list: UserAskItem[]): void {
  userAsks = list;
}

export function setProposals(list: ProposalItem[]): void {
  proposals = list;
}

export function setToolApprovals(list: ToolApprovalItem[]): void {
  toolApprovals = list;
}

export function setTaskInputs(list: TaskInputItem[]): void {
  taskInputs = list;
}

export function setConnections(list: ConnectionOption[]): void {
  connections = list;
}

export function setSelectedConnectionId(id: string | null): void {
  selectedConnectionId = id;
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

export function findNode(nodes: NodeView[], nodeId: string): NodeView | undefined {
  for (const node of nodes) {
    if (node.nodeId === nodeId) return node;
    const child = findNode(node.children || [], nodeId);
    if (child) return child;
  }
  return undefined;
}

/** Non-terminal tasks the user can still act on (start / interrupt / cancel / review). */
export function actionableTasks(): TaskReviewItem[] {
  return taskReview.filter((task) =>
    isActionableTaskState(task.state)
  );
}

export function pendingInteractionCount(): number {
  return countPendingParts({
    userAsks,
    toolApprovals,
    taskInputs,
    proposals,
  });
}

export function tasksForActiveNode(states?: string[]): TaskReviewItem[] {
  if (!activeCx) return [];
  return actionableTasks().filter((task) => {
    const st = task.state;
    return (
      task.referencedNodeIds.includes(activeCx!) &&
      (!states || states.includes(st))
    );
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
  /** Re-render inspector meta / backlinks when projection or links change. */
  renderMeta?: () => void;
  renderBacklinks?: () => void;
  /** Reload the active document through its dirty-buffer guard. */
  openNode?: (nodeId: string) => Promise<void>;
};

let host: StateHost | null = null;

export function bindStateHost(h: StateHost): void {
  host = h;
}

export function setActiveBacklinks(hits: BacklinkView[], error: string | null = null): void {
  activeBacklinks = hits;
  activeBacklinksError = error;
}

export function clearLocalDocumentSession(): void {
  localTabs.clear();
  activeCx = null;
  tree = [];
  nodeCollaborations.clear();
  activeBacklinks = [];
  activeBacklinksError = null;
}

/**
 * Switch foreground workspace id. Clears document tabs when the id changes —
 * open buffers are workspace-scoped and must not leak across mounts.
 */
export function setWorkspaceId(id: string | null): void {
  if (workspaceId === id) return;
  clearLocalDocumentSession();
  workspaceId = id;
}

export async function reloadTree(): Promise<void> {
  if (!workspaceId) return;
  const result = (await window.tentDesktop.rpc("docs.list", { workspaceId })) as {
    nodes: NodeView[];
  };
  // Strip list-side collab fields before overlay — docs.list is not authority.
  const raw = (result.nodes || []).map(stripListCollabFields);
  tree = raw;
  for (const [id, tab] of localTabs) {
    const node = findNode(tree, id);
    if (node?.mode) tab.nodeMode = node.mode;
    if (node?.name) tab.name = node.name;
    if (node?.path) tab.path = node.path;
  }
  await reloadNodeCollaborations();
  host?.renderTree();
}

/** Drop non-authoritative collaboration fields from docs.list Nodes. */
function stripListCollabFields(node: NodeView): NodeView {
  const { status: _s, assignee: _a, children, ...rest } = node;
  const archived = !!rest.archived || rest.mode === "archived";
  const invalid = !!rest.invalid;
  const usable = !invalid && !archived;
  return {
    ...rest,
    archived,
    invalid,
    // Local UI alias only — Service no longer projects coordination.
    coordination: usable,
    children: children?.map(stripListCollabFields),
  };
}

/**
 * Load canonical Node collaboration for every usable Node in one batch.
 */
export async function reloadNodeCollaborations(): Promise<void> {
  if (!workspaceId) {
    nodeCollaborations.clear();
    return;
  }
  const ids = collectUsableNodeIds(tree);
  if (ids.length === 0) {
    nodeCollaborations.clear();
    tree = applyNodeCollaborationsToTree(tree, nodeCollaborations);
    return;
  }
  const batch = (await window.tentDesktop.rpc("node.collaborations", {
    workspaceId,
    nodeIds: ids,
  })) as NodeCollaborationsResult;
  const results = batch.items.map((item) => normalizeNodeCollaboration(item));
  nodeCollaborations.clear();
  for (const p of results) {
    nodeCollaborations.set(p.nodeId, p);
  }
  tree = applyNodeCollaborationsToTree(tree, nodeCollaborations);
  host?.renderMeta?.();
}

export function nodeCollaborationFor(cx: string | null | undefined): NodeCollaborationView | null {
  if (!cx) return null;
  return nodeCollaborations.get(cx) ?? null;
}

/** Load docs.backlinks for the active node into inspector state. */
export async function reloadActiveBacklinks(): Promise<void> {
  if (!workspaceId || !activeCx) {
    activeBacklinks = [];
    activeBacklinksError = null;
    host?.renderBacklinks?.();
    return;
  }
  try {
    // Wire: BacklinkHit { fromNodeId, fromPath, fromName, raw, kind }
    const result = (await window.tentDesktop.rpc("docs.backlinks", {
      workspaceId,
      nodeId: activeCx,
    })) as {
      backlinks?: Array<{
        fromNodeId?: string;
        fromPath?: string;
        fromName?: string;
        raw?: string;
        kind?: string;
      }>;
    };
    const hits: BacklinkView[] = [];
    for (const h of result.backlinks || []) {
      const cx = h.fromNodeId || "";
      if (!cx) continue;
      const row: BacklinkView = {
        nodeId: cx,
        name: h.fromName || cx,
        path: h.fromPath || "",
      };
      if (typeof h.raw === "string" && h.raw) row.context = h.raw;
      hits.push(row);
    }
    activeBacklinks = hits;
    activeBacklinksError = null;
  } catch (err) {
    activeBacklinks = [];
    activeBacklinksError = err instanceof Error ? err.message : String(err);
  }
  host?.renderBacklinks?.();
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

/**
 * Re-fetch all independent pending types via real listPending RPCs.
 * taskInput has no workspace-global inbox — fan-out over known task paths only.
 */
export async function reloadPendingInteractions(): Promise<void> {
  if (!workspaceId) return;
  try {
    const [askResult, toolResult, proposalResult] = await Promise.all([
      window.tentDesktop.rpc("userAsk.listPending", { workspaceId }),
      window.tentDesktop.rpc("toolApproval.listPending", { workspaceId }),
      window.tentDesktop.rpc("proposal.list", {
        workspaceId,
        status: "pending",
      }),
    ]);
    userAsks = normalizeUserAskList(askResult);
    toolApprovals = normalizeToolApprovalList(toolResult);
    proposals = normalizeProposalList(proposalResult);

    // taskInput.listPending requires workspaceId+taskPath (no global list).
    const paths = collectTaskPathsForInputPoll();
    if (paths.length === 0) {
      taskInputs = [];
    } else {
      const inputLists = await Promise.all(
        paths.map((taskPath) =>
          window.tentDesktop
            .rpc("taskInput.listPending", { workspaceId, taskPath })
            .then((r) => normalizeTaskInputList(r))
            .catch(() => [] as TaskInputItem[])
        )
      );
      const byId = new Map<string, TaskInputItem>();
      for (const list of inputLists) {
        for (const item of list) byId.set(item.id, item);
      }
      taskInputs = [...byId.values()].sort((a, b) =>
        (b.createdAt || "").localeCompare(a.createdAt || "")
      );
    }
    host?.renderPendingInteractions();
  } catch (err) {
    setError(err);
  }
}

/** Task paths we know about for scoped taskInput.listPending fan-out. */
function collectTaskPathsForInputPoll(): string[] {
  const paths = new Set<string>();
  for (const t of taskReview) {
    if (t.path) paths.add(t.path);
  }
  for (const ask of userAsks) {
    if (ask.taskPath) paths.add(ask.taskPath);
  }
  for (const t of toolApprovals) {
    if (t.taskPath) paths.add(t.taskPath);
  }
  return [...paths];
}

/**
 * Service event → re-fetch projections. Renderer never guesses state from the
 * envelope payload alone.
 */
export async function onServiceEvent(type: string): Promise<void> {
  if (!workspaceId) return;
  const reloadNodeNeeded = type === "node.changed";
  const reloadTasksNeeded = isTaskProjectionEventType(type);
  const reloadPendingNeeded = isPendingInteractionEventType(type);
  if (!reloadNodeNeeded && !reloadTasksNeeded && !reloadPendingNeeded) return;
  try {
    if (reloadNodeNeeded) {
      await reloadTree();
      if (activeCx && host?.openNode) await host.openNode(activeCx);
      await reloadActiveBacklinks();
    }
    // Tasks first so taskInput fan-out sees current paths (no guessed paths).
    if (reloadTasksNeeded) {
      await reloadTasks();
      // Active Task / Delivery / Session changes invalidate node.collaboration.
      await reloadNodeCollaborations();
      host?.renderTree();
    }
    if (reloadPendingNeeded) await reloadPendingInteractions();
  } catch (err) {
    setError(err);
  }
}

/** Load machine-local Agent Connections. */
export async function reloadConnections(): Promise<void> {
  try {
    const result = (await window.tentDesktop.rpc("connection.list", {})) as {
      connections: AgentConnectionProjection[];
    };
    connections = listConnectionOptions(result.connections || []);
    if (!selectedConnectionId || !connections.some((connection) => connection.connectionId === selectedConnectionId)) {
      selectedConnectionId = pickDefaultConnectionId(connections);
    }
    host?.renderTasks();
  } catch (err) {
    connections = [];
    selectedConnectionId = null;
    setError(err);
  }
}
