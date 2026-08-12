import type { DeliveryRecord } from "../core/delivery.js";
import type { RoleDefinition } from "../core/skillRoleRegistry.js";
import type { TaskEnvelope } from "../core/task.js";
import { isTaskId } from "../core/task-model.js";
import { listDirectActiveTasksForNode } from "../core/task-node-refs.js";
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
  lastTaskId?: string;
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
  tasks: readonly TaskEnvelope[];
  deliveries: readonly DeliveryRecord[];
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
  const deliveriesById = indexDeliveriesById(input.deliveries);
  const readyDeliveriesByTaskId = indexReadyDeliveries(input.deliveries);
  const inboxItems = selectUserInboxDeliveries(input.tasks, deliveriesById, tasksById);

  for (const { request, task } of actionableDecisions) {
    inboxItems.push({
      kind: "decision",
      requestId: request.id,
      taskId: task.id!,
      nodeIds: [...task.workNodeIds],
      question: request.question,
      options: request.options.map((option) => ({ ...option })),
      createdAt: request.createdAt,
    });
  }
  inboxItems.sort(compareWorkspaceUserInboxItem);

  let selectedNode: WorkspaceCollaborationProjection["selectedNode"] = null;
  if (input.nodeId) {
    const occupations = listDirectActiveTasksForNode(input.nodeId, input.tasks);
    if (occupations.length > 1) {
      throw consistencyError("Node has multiple active Task occupations", {
        nodeId: input.nodeId,
        taskIds: occupations.map((task) => task.id ?? null),
      });
    }
    const selectedTask = occupations[0];
    if (selectedTask?.id) {
      const sameId = tasksById.get(selectedTask.id) ?? [];
      if (sameId.length !== 1) {
        throw consistencyError("Selected Task identity is ambiguous", {
          nodeId: input.nodeId,
          taskId: selectedTask.id,
        });
      }
    }
    const activeTask = selectedTask
      ? await projectActiveTask({
          ...input,
          task: selectedTask,
          deliveriesById,
          readyDeliveries: selectedTask.id
            ? readyDeliveriesByTaskId.get(selectedTask.id) ?? []
            : [],
          decisionByTaskId: decisionsByTaskId,
        })
      : null;
    selectedNode = {
      nodeId: input.nodeId,
      activeTask,
      lastReturn: selectNodeLastReturn(input.nodeId, input.tasks),
    };
  }

  const counts = { delivery: 0, decision: 0, total: inboxItems.length };
  for (const item of inboxItems) counts[item.kind] += 1;
  return {
    workspaceId: input.workspaceId,
    selectedNode,
    inbox: { items: inboxItems, counts },
  };
}

function selectNodeLastReturn(
  nodeId: string,
  tasks: readonly TaskEnvelope[]
): NonNullable<WorkspaceCollaborationProjection["selectedNode"]>["lastReturn"] {
  const candidates = tasks.filter((task) => task.workNodeIds.includes(nodeId));
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
  return selected?.lastReturn
    ? { taskId: selected.id!, ...selected.lastReturn }
    : null;
}

function indexCanonicalTasks(
  tasks: readonly TaskEnvelope[]
): Map<string, TaskEnvelope[]> {
  const tasksById = new Map<string, TaskEnvelope[]>();
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
  tasksById: ReadonlyMap<string, readonly TaskEnvelope[]>
): Promise<{
  byTaskId: Map<string, DecisionRequestRecord>;
  actionable: Array<{
    request: DecisionRequestRecord;
    task: TaskEnvelope & { id: string };
  }>;
}> {
  const byTaskId = new Map<string, DecisionRequestRecord>();
  const actionable: Array<{
    request: DecisionRequestRecord;
    task: TaskEnvelope & { id: string };
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
        candidate.sessionId === request.requester.id
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
    const task = candidates[0] as TaskEnvelope & { id: string };
    const session = await input.readSession(request.requester.id);
    if (
      !session ||
      !session.open ||
      session.workspace !== input.workspaceId ||
      session.lastTaskId !== task.id
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

function indexReadyDeliveries(
  deliveries: readonly DeliveryRecord[]
): Map<string, DeliveryRecord[]> {
  const result = new Map<string, DeliveryRecord[]>();
  for (const delivery of deliveries) {
    if (delivery.status !== "ready") continue;
    const sameTask = result.get(delivery.taskId) ?? [];
    sameTask.push(delivery);
    result.set(delivery.taskId, sameTask);
  }
  return result;
}

function indexDeliveriesById(
  deliveries: readonly DeliveryRecord[]
): Map<string, DeliveryRecord[]> {
  const result = new Map<string, DeliveryRecord[]>();
  for (const delivery of deliveries) {
    const sameId = result.get(delivery.id) ?? [];
    sameId.push(delivery);
    result.set(delivery.id, sameId);
  }
  return result;
}

function selectUserInboxDeliveries(
  tasks: readonly TaskEnvelope[],
  deliveriesById: ReadonlyMap<string, readonly DeliveryRecord[]>,
  tasksById: ReadonlyMap<string, readonly TaskEnvelope[]>
): WorkspaceUserInboxItem[] {
  const items: WorkspaceUserInboxItem[] = [];
  for (const task of tasks) {
    if (task.state !== "delivered") continue;
    if (!task.parentActor) {
      throw consistencyError("Delivered Task lacks responsibility", {
        taskId: task.id ?? null,
      });
    }
    if (task.parentActor.kind !== "user") continue;
    if (task.parentActor.id !== "user") {
      throw consistencyError("Delivered Task has invalid user responsibility", {
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
    const sameDeliveryId = task.activeDeliveryId
      ? deliveriesById.get(task.activeDeliveryId) ?? []
      : [];
    if (sameDeliveryId.length !== 1) {
      throw consistencyError("User-reviewable Delivery identity is not unique", {
        taskId: task.id,
        deliveryId: task.activeDeliveryId ?? null,
        matches: sameDeliveryId.length,
      });
    }
    const delivery = sameDeliveryId[0]!;
    if (
      !delivery ||
      delivery.status !== "ready" ||
      delivery.taskId !== task.id ||
      !task.workNodeIds.includes(delivery.sourceNodeId)
    ) {
      throw consistencyError("User-reviewable Delivery identity is stale", {
        deliveryId: task.activeDeliveryId ?? null,
        taskId: task.id,
        taskState: task.state,
        activeDeliveryId: task.activeDeliveryId ?? null,
      });
    }
    items.push({
      kind: "delivery",
      deliveryId: delivery.id,
      taskId: delivery.taskId,
      sourceNodeId: delivery.sourceNodeId,
      summary: delivery.summary,
      createdAt: requireDeliveryCreatedAt(delivery, task.id),
    });
  }
  return items;
}

async function projectActiveTask(
  input: WorkspaceCollaborationInput & {
    task: TaskEnvelope;
    deliveriesById: ReadonlyMap<string, readonly DeliveryRecord[]>;
    readyDeliveries: readonly DeliveryRecord[];
    decisionByTaskId: ReadonlyMap<string, DecisionRequestRecord>;
  }
): Promise<WorkspaceCollaborationActiveTask> {
  const taskId = input.task.id;
  if (!taskId) {
    throw consistencyError("Selected Task is missing canonical id", {});
  }
  const responsibility = projectResponsibility(input.task, input.roles);
  const execution = await projectExecution(input, taskId);
  const readyDelivery = projectSelectedReadyDelivery(input, taskId);
  const decision = input.decisionByTaskId.get(taskId);
  return {
    taskId,
    state: input.task.state,
    responsibility,
    execution,
    readyDelivery,
    pendingDecision: decision ? projectDecision(decision) : null,
  };
}

function projectResponsibility(
  task: TaskEnvelope,
  roles: readonly RoleDefinition[]
): WorkspaceCollaborationActiveTask["responsibility"] {
  const taskId = task.id!;
  if (!task.parentActor) {
    throw consistencyError("Selected Task lacks parent responsibility", { taskId });
  }
  if (task.parentActor.kind === "user") {
    if (task.parentActor.id !== "user") {
      throw consistencyError("Task has invalid user responsibility", {
        taskId,
        parentActorId: task.parentActor.id,
      });
    }
    return { kind: "user" };
  }
  const role = roles.find((candidate) => candidate.id === task.parentActor!.id);
  if (!role) {
    throw consistencyError("Task parent responsibility Role is missing", {
      taskId,
      roleId: task.parentActor.id,
    });
  }
  return {
    kind: "role",
    roleId: task.parentActor.id,
    displayName: role.displayName?.trim() || role.name,
  };
}

async function projectExecution(
  input: WorkspaceCollaborationInput & { task: TaskEnvelope },
  taskId: string
): Promise<WorkspaceCollaborationActiveTask["execution"]> {
  if (input.task.roleId) {
    const role = input.roles.find((candidate) => candidate.id === input.task.roleId);
    if (!role) {
      throw consistencyError("Task assignee Role is missing", {
        taskId,
        roleId: input.task.roleId,
      });
    }
    return {
      kind: "role",
      roleId: input.task.roleId,
      displayName: role.displayName?.trim() || role.name,
    };
  }
  if (input.task.sessionId) {
    const session = await input.readSession(input.task.sessionId);
    if (
      !session ||
      session.workspace !== input.workspaceId ||
      session.lastTaskId !== taskId
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

function projectSelectedReadyDelivery(
  input: {
    task: TaskEnvelope;
    deliveriesById: ReadonlyMap<string, readonly DeliveryRecord[]>;
    readyDeliveries: readonly DeliveryRecord[];
  },
  taskId: string
): WorkspaceCollaborationActiveTask["readyDelivery"] {
  if (input.readyDeliveries.length > 1) {
    throw consistencyError("Selected Task has multiple ready Deliveries", {
      taskId,
      deliveryIds: input.readyDeliveries.map((delivery) => delivery.id),
    });
  }
  let readyDelivery: WorkspaceCollaborationActiveTask["readyDelivery"] = null;
  if (input.task.activeDeliveryId) {
    const sameDeliveryId = input.deliveriesById.get(input.task.activeDeliveryId) ?? [];
    if (sameDeliveryId.length !== 1) {
      throw consistencyError("Selected Task Delivery identity is not unique", {
        taskId,
        deliveryId: input.task.activeDeliveryId,
        matches: sameDeliveryId.length,
      });
    }
    const delivery = sameDeliveryId[0]!;
    if (delivery.taskId !== taskId) {
      throw consistencyError("Selected Task Delivery binding is stale", {
        taskId,
        deliveryId: input.task.activeDeliveryId,
      });
    }
    if (delivery.status === "ready") {
      if (!input.task.workNodeIds.includes(delivery.sourceNodeId)) {
        throw consistencyError("Selected Task ready Delivery has foreign source Node", {
          taskId,
          deliveryId: delivery.id,
          sourceNodeId: delivery.sourceNodeId,
        });
      }
      if (input.task.state !== "delivered") {
        throw consistencyError("Selected Task has a ready Delivery outside delivered state", {
          taskId,
          taskState: input.task.state,
          deliveryId: delivery.id,
        });
      }
      readyDelivery = {
        deliveryId: delivery.id,
        summary: delivery.summary,
        createdAt: requireDeliveryCreatedAt(delivery, taskId),
      };
    }
  }
  if (input.task.state === "delivered") {
    if (!readyDelivery) {
      throw consistencyError("Delivered selected Task lacks its exact ready Delivery", {
        taskId,
        activeDeliveryId: input.task.activeDeliveryId ?? null,
      });
    }
    if (
      input.readyDeliveries.length !== 1 ||
      input.readyDeliveries[0]!.id !== readyDelivery.deliveryId
    ) {
      throw consistencyError("Delivered selected Task has inconsistent ready Delivery authority", {
        taskId,
        activeDeliveryId: readyDelivery.deliveryId,
      });
    }
  } else if (input.readyDeliveries.length > 0) {
    throw consistencyError("Selected Task has an unbound ready Delivery", {
      taskId,
      taskState: input.task.state,
      deliveryId: input.readyDeliveries[0]!.id,
    });
  }
  return readyDelivery;
}

function requireDeliveryCreatedAt(delivery: DeliveryRecord, taskId: string): string {
  const createdAt = delivery.createdAt;
  if (
    typeof createdAt !== "string" ||
    createdAt.trim() !== createdAt ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw consistencyError("Current ready Delivery lacks durable createdAt", {
      taskId,
      deliveryId: delivery.id,
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
  const aId = a.kind === "delivery" ? a.deliveryId : a.requestId;
  const bId = b.kind === "delivery" ? b.deliveryId : b.requestId;
  return aId.localeCompare(bId);
}

function consistencyError(message: string, data: Record<string, unknown>): RpcError {
  return new RpcError(-32010, `workspace.collaboration consistency error: ${message}`, {
    code: "WORKSPACE_COLLABORATION_STALE",
    ...data,
  });
}
