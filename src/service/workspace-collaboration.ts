import {
  taskResultPathForTask,
  type TaskResultRecord,
} from "../core/task-result.js";
import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import type { TaskRecord } from "../core/task.js";
import { isTaskId } from "../core/task-model.js";
import {
  listDirectActiveTasksForNode,
} from "../core/task-node-refs.js";
import type { DecisionRequestRecord } from "./decision-request-store.js";
import { RpcError } from "./rpc-error.js";
import type {
  WorkspaceCollaborationActiveTask,
  WorkspaceCollaborationDecision,
  WorkspaceCollaborationProjection,
  WorkspaceUserInboxItem,
} from "./types.js";

type SessionBinding = {
  workspace?: string;
  currentTaskId?: string;
  connectionId?: string;
  open: boolean;
};

type ConnectionIdentity = {
  connectionId: string;
  displayName?: string;
};

export type WorkspaceCollaborationInput = {
  workspaceId: string;
  nodeId?: string;
  tasks: readonly TaskRecord[];
  results: readonly TaskResultRecord[];
  pendingDecisions: readonly DecisionRequestRecord[];
  roles: readonly RoleDefinition[];
  readSession: (sessionId: string) => Promise<SessionBinding | null>;
  getConnection: (connectionId: string) => ConnectionIdentity | undefined;
};

/**
 * Pure read-model assembly over existing authorities. The callbacks are reads;
 * this module owns no entity, cache, mutation, or lifecycle state.
 */
export async function buildWorkspaceCollaborationProjection(
  input: WorkspaceCollaborationInput
): Promise<WorkspaceCollaborationProjection> {
  const tasksById = indexCanonicalTasks(input.tasks);
  const { byTaskId: decisionsByTaskId, actionable: actionableDecisions } =
    await selectActionableUserDecisions(input, tasksById);
  const resultsById = indexTaskResultsById(input.results);
  const readyResultsByTaskId = indexReadyTaskResults(input.results);
  const inboxItems = selectUserInboxResults(input.tasks, resultsById, tasksById);

  for (const { request, task } of actionableDecisions) {
    inboxItems.push({
      kind: "decision",
      requestId: request.id,
      taskId: task.id!,
      nodeIds: [...task.nodeIds],
      question: request.question,
      options: request.options.map((option) => ({ ...option })),
      createdAt: request.createdAt,
    });
  }
  inboxItems.sort(compareWorkspaceUserInboxItem);

  let selectedNode: WorkspaceCollaborationProjection["selectedNode"] = null;
  if (input.nodeId) {
    const selectedTasks = listDirectActiveTasksForNode(input.nodeId, input.tasks);
    for (const selectedTask of selectedTasks) {
      if (!selectedTask.id) {
        throw consistencyError("Selected active Task is missing canonical id", {
          nodeId: input.nodeId,
        });
      }
      const sameId = tasksById.get(selectedTask.id) ?? [];
      if (sameId.length !== 1) {
        throw consistencyError("Selected active Task identity is ambiguous", {
          nodeId: input.nodeId,
          taskId: selectedTask.id,
        });
      }
    }
    const activeTasks = [];
    for (const selectedTask of selectedTasks) {
      activeTasks.push(
        await projectActiveTask({
          ...input,
          task: selectedTask,
          resultsById,
          readyResults: selectedTask.id
            ? readyResultsByTaskId.get(selectedTask.id) ?? []
            : [],
          decisionByTaskId: decisionsByTaskId,
        })
      );
    }
    selectedNode = {
      nodeId: input.nodeId,
      activeTasks,
      statusDetail: selectNodeStatusDetail(input.nodeId, input.tasks),
    };
  }

  const counts = { result: 0, decision: 0, total: inboxItems.length };
  for (const item of inboxItems) counts[item.kind] += 1;
  return {
    workspaceId: input.workspaceId,
    selectedNode,
    inbox: { items: inboxItems, counts },
  };
}

function selectNodeStatusDetail(
  nodeId: string,
  tasks: readonly TaskRecord[]
): NonNullable<WorkspaceCollaborationProjection["selectedNode"]>["statusDetail"] {
  const candidates = tasks.filter((task) => task.nodeIds.includes(nodeId));
  const ids = new Set<string>();
  for (const task of candidates) {
    if (!task.id || !isTaskId(task.id)) {
      throw consistencyError("Node return Task is missing canonical identity", { nodeId });
    }
    if (ids.has(task.id)) {
      throw consistencyError("Node return Task identity is ambiguous", {
        nodeId,
        taskId: task.id,
      });
    }
    ids.add(task.id);
    if (typeof task.updatedAt !== "string" || !Number.isFinite(Date.parse(task.updatedAt))) {
      throw consistencyError("Node return Task timestamp is invalid", {
        nodeId,
        taskId: task.id,
      });
    }
  }
  candidates.sort((left, right) =>
    Date.parse(right.updatedAt!) - Date.parse(left.updatedAt!) ||
    left.id!.localeCompare(right.id!)
  );
  const selected = candidates[0];
  return selected?.statusDetail
    ? { taskId: selected.id!, ...selected.statusDetail }
    : null;
}

function indexCanonicalTasks(
  tasks: readonly TaskRecord[]
): Map<string, TaskRecord[]> {
  const tasksById = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    // An unrelated historical synthetic envelope has no public identity and is
    // ignored unless it occupies the selected Node (validated in projectActiveTask).
    if (!task.id) continue;
    const sameId = tasksById.get(task.id) ?? [];
    sameId.push(task);
    tasksById.set(task.id, sameId);
  }
  return tasksById;
}

async function selectActionableUserDecisions(
  input: Pick<WorkspaceCollaborationInput, "workspaceId" | "pendingDecisions" | "readSession">,
  tasksById: ReadonlyMap<string, readonly TaskRecord[]>
): Promise<{
  byTaskId: Map<string, DecisionRequestRecord>;
  actionable: Array<{
    request: DecisionRequestRecord;
    task: TaskRecord & { id: string };
  }>;
}> {
  const byTaskId = new Map<string, DecisionRequestRecord>();
  const actionable: Array<{
    request: DecisionRequestRecord;
    task: TaskRecord & { id: string };
  }> = [];
  for (const request of input.pendingDecisions) {
    if (request.target.kind !== "user") continue;
    const sameId = tasksById.get(request.taskId) ?? [];
    const exactPath = sameId.filter((candidate) => candidate.path === request.taskPath);
    const candidates = exactPath.filter(
      (candidate) =>
        candidate.state === "waiting" &&
        candidate.wait?.reason === "user-input" &&
        candidate.wait.code === `decision_request:${request.id}` &&
        candidate.executionSessionId === request.requester.id
    );
    // A stale pending row is historical, not an actionable Inbox fact.
    if (candidates.length === 0) continue;
    if (sameId.length !== 1 || candidates.length !== 1) {
      throw consistencyError("Actionable user DecisionRequest has ambiguous Task identity", {
        requestId: request.id,
        taskId: request.taskId,
      });
    }
    if (byTaskId.has(request.taskId)) {
      throw consistencyError("Task has multiple pending user DecisionRequests", {
        taskId: request.taskId,
      });
    }
    const task = candidates[0] as TaskRecord & { id: string };
    const session = await input.readSession(request.requester.id);
    if (
      !session ||
      !session.open ||
      session.workspace !== input.workspaceId ||
      session.currentTaskId !== task.id
    ) {
      // A once-actionable request whose requester is no longer the exact open
      // Task binding is historical inventory, not a workspace-wide failure.
      continue;
    }
    byTaskId.set(request.taskId, request);
    actionable.push({ request, task });
  }
  return { byTaskId, actionable };
}

function indexReadyTaskResults(
  results: readonly TaskResultRecord[]
): Map<string, TaskResultRecord[]> {
  const index = new Map<string, TaskResultRecord[]>();
  for (const result of results) {
    if (result.status !== "ready") continue;
    const sameTask = index.get(result.taskId) ?? [];
    sameTask.push(result);
    index.set(result.taskId, sameTask);
  }
  return index;
}

function indexTaskResultsById(
  results: readonly TaskResultRecord[]
): Map<string, TaskResultRecord[]> {
  const index = new Map<string, TaskResultRecord[]>();
  for (const result of results) {
    const sameId = index.get(result.id) ?? [];
    sameId.push(result);
    index.set(result.id, sameId);
  }
  return index;
}

function selectUserInboxResults(
  tasks: readonly TaskRecord[],
  resultsById: ReadonlyMap<string, readonly TaskResultRecord[]>,
  tasksById: ReadonlyMap<string, readonly TaskRecord[]>
): WorkspaceUserInboxItem[] {
  const items: WorkspaceUserInboxItem[] = [];
  for (const task of tasks) {
    if (task.state !== "submitted") continue;
    if (!task.requester) {
      throw consistencyError("Submitted Task lacks responsibility", {
        taskId: task.id ?? null,
      });
    }
    if (task.requester.kind !== "user") continue;
    if (task.requester.id !== "user") {
      throw consistencyError("Submitted Task has invalid user responsibility", {
        taskId: task.id ?? null,
      });
    }
    if (!task.id) {
      throw consistencyError("User-reviewable Task is missing canonical id", {});
    }
    const sameId = tasksById.get(task.id) ?? [];
    if (sameId.length !== 1) {
      throw consistencyError("User-reviewable Task identity is ambiguous", {
        taskId: task.id,
      });
    }
    const sameResultId = task.currentResultId
      ? resultsById.get(task.currentResultId) ?? []
      : [];
    if (sameResultId.length !== 1) {
      throw consistencyError("User-reviewable Task Result identity is not unique", {
        taskId: task.id,
        resultId: task.currentResultId ?? null,
        matches: sameResultId.length,
      });
    }
    const result = sameResultId[0]!;
    if (
      !result ||
      result.status !== "ready" ||
      result.taskId !== task.id ||
      result.path !== taskResultPathForTask(task.path, result.id)
    ) {
      throw consistencyError("User-reviewable Task Result identity is stale", {
        resultId: task.currentResultId ?? null,
        taskId: task.id,
        taskState: task.state,
        currentResultId: task.currentResultId ?? null,
      });
    }
    items.push({
      kind: "result",
      resultId: result.id,
      taskId: result.taskId,
      summary: result.report,
      createdAt: requireTaskResultCreatedAt(result, task.id),
    });
  }
  return items;
}

async function projectActiveTask(
  input: WorkspaceCollaborationInput & {
    task: TaskRecord;
    resultsById: ReadonlyMap<string, readonly TaskResultRecord[]>;
    readyResults: readonly TaskResultRecord[];
    decisionByTaskId: ReadonlyMap<string, DecisionRequestRecord>;
  }
): Promise<WorkspaceCollaborationActiveTask> {
  const taskId = input.task.id;
  if (!taskId) {
    throw consistencyError("Selected Task is missing canonical id", {});
  }
  const responsibility = projectResponsibility(input.task, input.roles);
  const execution = await projectExecution(input, taskId);
  const readyResult = projectSelectedReadyResult(input, taskId);
  const decision = input.decisionByTaskId.get(taskId);
  return {
    taskId,
    state: input.task.state,
    responsibility,
    execution,
    readyResult,
    pendingDecision: decision ? projectDecision(decision) : null,
  };
}

function projectResponsibility(
  task: TaskRecord,
  roles: readonly RoleDefinition[]
): WorkspaceCollaborationActiveTask["responsibility"] {
  const taskId = task.id!;
  if (!task.requester) {
    throw consistencyError("Selected Task lacks parent responsibility", { taskId });
  }
  if (task.requester.kind === "user") {
    if (task.requester.id !== "user") {
      throw consistencyError("Task has invalid user responsibility", {
        taskId,
        requesterId: task.requester.id,
      });
    }
    return { kind: "user" };
  }
  const role = roles.find((candidate) => candidate.id === task.requester!.id);
  if (!role) {
    throw consistencyError("Task parent responsibility Role is missing", {
      taskId,
      roleId: task.requester.id,
    });
  }
  return {
    kind: "role",
    roleId: task.requester.id,
    displayName: role.displayName?.trim() || role.name,
  };
}

async function projectExecution(
  input: WorkspaceCollaborationInput & { task: TaskRecord },
  taskId: string
): Promise<WorkspaceCollaborationActiveTask["execution"]> {
  if (input.task.assigneeRoleId) {
    const role = input.roles.find((candidate) => candidate.id === input.task.assigneeRoleId);
    if (!role) {
      throw consistencyError("Task assignee Role is missing", {
        taskId,
        roleId: input.task.assigneeRoleId,
      });
    }
    return {
      kind: "role",
      roleId: input.task.assigneeRoleId,
      displayName: role.displayName?.trim() || role.name,
    };
  }
  if (input.task.executionSessionId) {
    const session = await input.readSession(input.task.executionSessionId);
    if (
      !session ||
      session.workspace !== input.workspaceId ||
      session.currentTaskId !== taskId
    ) {
      throw consistencyError("Selected Task Session binding is stale", { taskId });
    }
    // An ordinary external Session is valid execution authority but has no
    // machine Connection to expose. Session identity itself stays private.
    if (!session.connectionId) return null;
    const connection = input.getConnection(session.connectionId);
    if (!connection) {
      throw consistencyError("Selected Task references a missing Agent Connection", {
        taskId,
        connectionId: session.connectionId,
      });
    }
    return {
      kind: "connection",
      connectionId: connection.connectionId,
      displayName: connection.displayName?.trim() || connection.connectionId,
    };
  }
  if (input.task.state === "queued") return null;
  throw consistencyError("Active Task has no exact assignee", { taskId });
}

function projectSelectedReadyResult(
  input: {
    task: TaskRecord;
    resultsById: ReadonlyMap<string, readonly TaskResultRecord[]>;
    readyResults: readonly TaskResultRecord[];
  },
  taskId: string
): WorkspaceCollaborationActiveTask["readyResult"] {
  if (input.readyResults.length > 1) {
    throw consistencyError("Selected Task has multiple ready Task Results", {
      taskId,
      resultIds: input.readyResults.map((result) => result.id),
    });
  }
  let readyResult: WorkspaceCollaborationActiveTask["readyResult"] = null;
  if (input.task.currentResultId) {
    const sameResultId = input.resultsById.get(input.task.currentResultId) ?? [];
    if (sameResultId.length !== 1) {
      throw consistencyError("Selected Task Result identity is not unique", {
        taskId,
        resultId: input.task.currentResultId,
        matches: sameResultId.length,
      });
    }
    const result = sameResultId[0]!;
    if (result.taskId !== taskId) {
      throw consistencyError("Selected Task Result binding is stale", {
        taskId,
        resultId: input.task.currentResultId,
      });
    }
    if (result.status === "ready") {
      if (input.task.state !== "submitted") {
        throw consistencyError("Selected Task has a ready Result outside submitted state", {
          taskId,
          taskState: input.task.state,
          resultId: result.id,
        });
      }
      readyResult = {
        resultId: result.id,
        summary: result.report,
        createdAt: requireTaskResultCreatedAt(result, taskId),
      };
    }
  }
  if (input.task.state === "submitted") {
    if (!readyResult) {
      throw consistencyError("Submitted selected Task lacks its exact ready Result", {
        taskId,
        currentResultId: input.task.currentResultId ?? null,
      });
    }
    if (
      input.readyResults.length !== 1 ||
      input.readyResults[0]!.id !== readyResult.resultId
    ) {
      throw consistencyError("Submitted selected Task has inconsistent ready Result authority", {
        taskId,
        currentResultId: readyResult.resultId,
      });
    }
  } else if (input.readyResults.length > 0) {
    throw consistencyError("Selected Task has an unbound ready Result", {
      taskId,
      taskState: input.task.state,
      resultId: input.readyResults[0]!.id,
    });
  }
  return readyResult;
}

function requireTaskResultCreatedAt(result: TaskResultRecord, taskId: string): string {
  const createdAt = result.createdAt;
  if (
    typeof createdAt !== "string" ||
    createdAt.trim() !== createdAt ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw consistencyError("Current ready Task Result lacks durable createdAt", {
      taskId,
      resultId: result.id,
    });
  }
  return createdAt;
}

function projectDecision(request: DecisionRequestRecord): WorkspaceCollaborationDecision {
  return {
    requestId: request.id,
    question: request.question,
    options: request.options.map((option) => ({ ...option })),
  };
}

/** Stable user Inbox order: createdAt ASC, then kind, then exact entity id. */
function compareWorkspaceUserInboxItem(
  a: WorkspaceUserInboxItem,
  b: WorkspaceUserInboxItem
): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  const byKind = a.kind.localeCompare(b.kind);
  if (byKind !== 0) return byKind;
  const aId = a.kind === "result" ? a.resultId : a.requestId;
  const bId = b.kind === "result" ? b.resultId : b.requestId;
  return aId.localeCompare(bId);
}

function consistencyError(message: string, data: Record<string, unknown>): RpcError {
  return new RpcError(-32010, `workspace.collaboration consistency error: ${message}`, {
    code: "WORKSPACE_COLLABORATION_STALE",
    ...data,
  });
}
