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
  applyBoxProjectionsToTree,
  collectCoordinationBoxIds,
  normalizeBoxProjection,
  type BoxProjectionView,
} from "../../workbench/box-projection.js";
import {
  buildTaskReviewItems,
  isActionableTaskState,
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
import {
  isPendingInteractionEventType,
  isTaskProjectionEventType,
  normalizeA2AList,
  normalizeProposalList,
  normalizeTaskInputList,
  normalizeToolApprovalList,
  normalizeUserAskList,
  pendingInteractionCount as countPendingParts,
  type A2AApprovalItem,
  type ProposalItem,
  type TaskInputItem,
  type ToolApprovalItem,
  type UserAskItem,
} from "../../workbench/pending-interactions.js";
import type { BacklinkView, ConceptNode, ShellState, TabView } from "./types.js";
import { setError } from "./elements.js";

/** Local editor state mirrors WorkspaceController via service RPC (not core FS). */
export const localTabs = new Map<string, TabView>();
export let activeCx: string | null = null;
export let tree: ConceptNode[] = [];
export let state: ShellState | null = null;
export let workspaceId: string | null = null;

/**
 * box.projection by boxId — sole truth for tree/inspector status/assignee/activeTaskId.
 * Cleared on workspace switch; never derived from frontmatter.
 */
export const boxProjections = new Map<string, BoxProjectionView>();
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
export let a2aApprovals: A2AApprovalItem[] = [];
export let toolApprovals: ToolApprovalItem[] = [];
/** U2A one-shot pending inputs — independent type, never folded into UserAsk. */
export let taskInputs: TaskInputItem[] = [];
/** Pending proposal triage (separate from delivery review). */
export let proposals: ProposalItem[] = [];
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

export function setA2aApprovals(list: A2AApprovalItem[]): void {
  a2aApprovals = list;
}

export function setToolApprovals(list: ToolApprovalItem[]): void {
  toolApprovals = list;
}

export function setTaskInputs(list: TaskInputItem[]): void {
  taskInputs = list;
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

/** Non-terminal tasks the user can still act on (start / interrupt / cancel / review). */
export function actionableTasks(): TaskReviewItem[] {
  return taskReview.filter((task) =>
    isActionableTaskState(String(task.state || task.status || ""))
  );
}

export function pendingInteractionCount(): number {
  return countPendingParts({
    userAsks,
    a2aApprovals,
    toolApprovals,
    taskInputs,
    proposals,
  });
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
  /** Re-render inspector meta / backlinks when projection or links change. */
  renderMeta?: () => void;
  renderBacklinks?: () => void;
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
  boxProjections.clear();
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
    concepts: ConceptNode[];
  };
  // Strip list-side collab fields before overlay — docs.list is not authority.
  const raw = (result.concepts || []).map(stripListCollabFields);
  tree = raw;
  for (const [id, tab] of localTabs) {
    const concept = findConcept(tree, id);
    if (concept?.mode) tab.nodeMode = concept.mode;
    if (concept?.name) tab.name = concept.name;
    if (concept?.path) tab.path = concept.path;
  }
  await reloadBoxProjections();
  host?.renderTree();
}

/** Drop status/assignee that may ride along on ConceptProjection from docs.list. */
function stripListCollabFields(node: ConceptNode): ConceptNode {
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
 * Fan-out box.projection for every coordination node in the tree.
 * Failures for individual boxes leave that node without collab marks (no guess).
 */
export async function reloadBoxProjections(): Promise<void> {
  if (!workspaceId) {
    boxProjections.clear();
    return;
  }
  const ids = collectCoordinationBoxIds(tree);
  if (ids.length === 0) {
    boxProjections.clear();
    tree = applyBoxProjectionsToTree(tree, boxProjections);
    return;
  }
  const results = await Promise.all(
    ids.map((id) =>
      window.tentDesktop
        .rpc("box.projection", { workspaceId, id })
        .then((raw) => normalizeBoxProjection(raw))
        .catch(() => null)
    )
  );
  boxProjections.clear();
  for (const p of results) {
    if (p) boxProjections.set(p.boxId, p);
  }
  tree = applyBoxProjectionsToTree(tree, boxProjections);
  host?.renderMeta?.();
}

export function boxProjectionFor(cx: string | null | undefined): BoxProjectionView | null {
  if (!cx) return null;
  return boxProjections.get(cx) ?? null;
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
    // Wire: BacklinkHit { fromCx, fromPath, fromName, raw, kind }
    const result = (await window.tentDesktop.rpc("docs.backlinks", {
      workspaceId,
      id: activeCx,
    })) as {
      backlinks?: Array<{
        fromCx?: string;
        fromPath?: string;
        fromName?: string;
        raw?: string;
        kind?: string;
        // Tolerate older/alternate shapes if service ever aliases.
        cx?: string;
        id?: string;
        name?: string;
        path?: string;
      }>;
    };
    const hits: BacklinkView[] = [];
    for (const h of result.backlinks || []) {
      const cx = h.fromCx || h.cx || h.id || "";
      if (!cx) continue;
      const row: BacklinkView = {
        cx,
        name: h.fromName || h.name || cx,
        path: h.fromPath || h.path || "",
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
    const [askResult, a2aResult, toolResult, proposalResult] = await Promise.all([
      window.tentDesktop.rpc("userAsk.listPending", { workspaceId }),
      window.tentDesktop.rpc("a2a.listPending", { workspaceId }),
      window.tentDesktop.rpc("toolApproval.listPending", { workspaceId }),
      window.tentDesktop.rpc("proposal.list", {
        workspaceId,
        status: "pending",
      }),
    ]);
    userAsks = normalizeUserAskList(askResult);
    a2aApprovals = normalizeA2AList(a2aResult);
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
  for (const a of a2aApprovals) {
    if (a.taskPath) paths.add(a.taskPath);
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
  const reloadTasksNeeded = isTaskProjectionEventType(type);
  const reloadPendingNeeded = isPendingInteractionEventType(type);
  // concept.changed is not currently fan-out by main host; keep for completeness
  // if the filter widens. Tree refresh is still driven by explicit UI actions.
  if (!reloadTasksNeeded && !reloadPendingNeeded) return;
  try {
    // Tasks first so taskInput fan-out sees current paths (no guessed paths).
    if (reloadTasksNeeded) {
      await reloadTasks();
      // Active task / delivery / session changes invalidate box.projection.
      await reloadBoxProjections();
      host?.renderTree();
    }
    if (reloadPendingNeeded) await reloadPendingInteractions();
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
