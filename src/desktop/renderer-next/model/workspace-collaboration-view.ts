import type { TaskState } from "../../../core/task-model.js";

export type CollaborationResponsibility =
  | { kind: "user" }
  | { kind: "role"; roleId: string; label: string };

export type CollaborationExecution =
  | { kind: "role"; roleId: string; label: string }
  | { kind: "connection"; connectionId: string; label: string };

export type CollaborationDecision = {
  requestId: string;
  question: string;
  options: readonly { id: string; label: string }[];
};

export type CollaborationDelivery = {
  deliveryId: string;
  summary: string;
  createdAt: string;
};

export type CollaborationActiveTask = {
  state: TaskState;
  responsibility: CollaborationResponsibility;
  execution: CollaborationExecution | null;
  readyDelivery: CollaborationDelivery | null;
  pendingDecision: CollaborationDecision | null;
};

export type CollaborationInboxItem =
  | ({ kind: "delivery"; sourceNodeId: string } & CollaborationDelivery)
  | ({ kind: "decision"; nodeIds: readonly string[]; createdAt: string } & CollaborationDecision);

/**
 * Product-facing renderer projection. Task ids exist only inside Service joins;
 * the renderer owns exact Delivery / Decision identities and no Session facts.
 */
export type WorkspaceCollaborationView = {
  workspaceId: string;
  selectedNode: {
    nodeId: string;
    activeTask: CollaborationActiveTask | null;
  } | null;
  inbox: {
    items: readonly CollaborationInboxItem[];
    counts: { delivery: number; decision: number; total: number };
  };
};

const TASK_STATES = new Set<TaskState>([
  "queued",
  "running",
  "waiting",
  "delivered",
  "accepted",
  "rejected",
  "interrupted",
  "failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseOptions(raw: unknown, label: string): Array<{ id: string; label: string }> {
  if (!Array.isArray(raw)) throw new Error(`${label} options are corrupt`);
  const options = raw.map((item) => {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["id", "label"]) ||
      !nonEmpty(item.id) ||
      !nonEmpty(item.label)
    ) throw new Error(`${label} option is corrupt`);
    return { id: item.id, label: item.label };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error(`${label} option ids are duplicated`);
  }
  return options;
}

function parseDecision(raw: unknown, label: string): CollaborationDecision | null {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["requestId", "question", "options"]) ||
    !nonEmpty(raw.requestId) ||
    !nonEmpty(raw.question)
  ) throw new Error(`${label} is corrupt`);
  return {
    requestId: raw.requestId,
    question: raw.question,
    options: parseOptions(raw.options, label),
  };
}

function parseDelivery(raw: unknown, label: string): CollaborationDelivery | null {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["deliveryId", "summary", "createdAt"]) ||
    !nonEmpty(raw.deliveryId) ||
    typeof raw.summary !== "string" ||
    !nonEmpty(raw.createdAt)
  ) throw new Error(`${label} is corrupt`);
  return {
    deliveryId: raw.deliveryId,
    summary: raw.summary,
    createdAt: raw.createdAt,
  };
}

function parseResponsibility(raw: unknown): CollaborationResponsibility {
  if (!isRecord(raw) || !nonEmpty(raw.kind)) {
    throw new Error("workspace.collaboration responsibility is corrupt");
  }
  if (raw.kind === "user" && exactKeys(raw, ["kind"])) return { kind: "user" };
  if (
    raw.kind === "role" &&
    exactKeys(raw, ["kind", "roleId", "displayName"]) &&
    nonEmpty(raw.roleId) &&
    nonEmpty(raw.displayName)
  ) return { kind: "role", roleId: raw.roleId, label: raw.displayName };
  throw new Error("workspace.collaboration responsibility is corrupt");
}

function parseExecution(raw: unknown): CollaborationExecution | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !nonEmpty(raw.kind)) {
    throw new Error("workspace.collaboration execution is corrupt");
  }
  if (
    raw.kind === "role" &&
    exactKeys(raw, ["kind", "roleId", "displayName"]) &&
    nonEmpty(raw.roleId) &&
    nonEmpty(raw.displayName)
  ) return { kind: "role", roleId: raw.roleId, label: raw.displayName };
  if (
    raw.kind === "connection" &&
    exactKeys(raw, ["kind", "connectionId", "displayName"]) &&
    nonEmpty(raw.connectionId) &&
    nonEmpty(raw.displayName)
  ) return { kind: "connection", connectionId: raw.connectionId, label: raw.displayName };
  throw new Error("workspace.collaboration execution is corrupt");
}

function parseActiveTask(raw: unknown): CollaborationActiveTask | null {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !exactKeys(raw, [
      "taskId",
      "state",
      "responsibility",
      "execution",
      "readyDelivery",
      "pendingDecision",
    ]) ||
    !nonEmpty(raw.taskId) ||
    !TASK_STATES.has(raw.state as TaskState)
  ) throw new Error("workspace.collaboration activeTask is corrupt");
  return {
    state: raw.state as TaskState,
    responsibility: parseResponsibility(raw.responsibility),
    execution: parseExecution(raw.execution),
    readyDelivery: parseDelivery(raw.readyDelivery, "selected Delivery"),
    pendingDecision: parseDecision(raw.pendingDecision, "selected Decision"),
  };
}

export function normalizeWorkspaceCollaboration(
  raw: unknown,
  expectedWorkspaceId: string,
  expectedNodeId: string | null
): { ok: true; value: WorkspaceCollaborationView } | { ok: false; message: string } {
  try {
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["workspaceId", "selectedNode", "inbox"]) ||
      raw.workspaceId !== expectedWorkspaceId ||
      !isRecord(raw.inbox) ||
      !exactKeys(raw.inbox, ["items", "counts"]) ||
      !Array.isArray(raw.inbox.items) ||
      !isRecord(raw.inbox.counts) ||
      !exactKeys(raw.inbox.counts, ["delivery", "decision", "total"])
    ) throw new Error("workspace.collaboration envelope is corrupt");

    let selectedNode: WorkspaceCollaborationView["selectedNode"] = null;
    if (expectedNodeId === null) {
      if (raw.selectedNode !== null) {
        throw new Error("workspace.collaboration unexpectedly selected a Node");
      }
    } else {
      if (
        !isRecord(raw.selectedNode) ||
        !exactKeys(raw.selectedNode, ["nodeId", "activeTask"]) ||
        raw.selectedNode.nodeId !== expectedNodeId
      ) throw new Error("workspace.collaboration selected Node mismatch");
      selectedNode = {
        nodeId: expectedNodeId,
        activeTask: parseActiveTask(raw.selectedNode.activeTask),
      };
    }

    const items: CollaborationInboxItem[] = raw.inbox.items.map((item, index) => {
      if (!isRecord(item) || !nonEmpty(item.kind) || !nonEmpty(item.taskId)) {
        throw new Error(`workspace.collaboration inbox[${index}] is corrupt`);
      }
      if (
        item.kind === "delivery" &&
        exactKeys(item, [
          "kind",
          "deliveryId",
          "taskId",
          "sourceNodeId",
          "summary",
          "createdAt",
        ]) &&
        nonEmpty(item.deliveryId) &&
        nonEmpty(item.sourceNodeId) &&
        typeof item.summary === "string" &&
        nonEmpty(item.createdAt)
      ) {
        return {
          kind: "delivery",
          deliveryId: item.deliveryId,
          sourceNodeId: item.sourceNodeId,
          summary: item.summary,
          createdAt: item.createdAt,
        };
      }
      if (
        item.kind === "decision" &&
        exactKeys(item, [
          "kind",
          "requestId",
          "taskId",
          "nodeIds",
          "question",
          "options",
          "createdAt",
        ]) &&
        nonEmpty(item.requestId) &&
        Array.isArray(item.nodeIds) &&
        item.nodeIds.length > 0 &&
        item.nodeIds.every(nonEmpty) &&
        new Set(item.nodeIds).size === item.nodeIds.length &&
        nonEmpty(item.question) &&
        nonEmpty(item.createdAt)
      ) {
        return {
          kind: "decision",
          requestId: item.requestId,
          nodeIds: [...item.nodeIds],
          question: item.question,
          options: parseOptions(item.options, `inbox Decision ${index}`),
          createdAt: item.createdAt,
        };
      }
      throw new Error(`workspace.collaboration inbox[${index}] is corrupt`);
    });

    const delivery = items.filter((item) => item.kind === "delivery").length;
    const decision = items.filter((item) => item.kind === "decision").length;
    if (
      raw.inbox.counts.delivery !== delivery ||
      raw.inbox.counts.decision !== decision ||
      raw.inbox.counts.total !== items.length
    ) throw new Error("workspace.collaboration counts are corrupt");

    const identities = items.map((item) =>
      item.kind === "delivery" ? `delivery:${item.deliveryId}` : `decision:${item.requestId}`
    );
    if (new Set(identities).size !== identities.length) {
      throw new Error("workspace.collaboration inbox identities are duplicated");
    }

    return {
      ok: true,
      value: {
        workspaceId: expectedWorkspaceId,
        selectedNode,
        inbox: { items, counts: { delivery, decision, total: items.length } },
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "workspace.collaboration is corrupt",
    };
  }
}
