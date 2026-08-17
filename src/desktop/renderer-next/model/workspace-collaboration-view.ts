import { isSessionId } from "../../../core/id.js";
import { isTaskId, type TaskState, type TaskStatusDetail } from "../../../core/task-model.js";

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

export type CollaborationTaskResult = {
  resultId: string;
  summary: string;
  createdAt: string;
};

export type CollaborationActiveTask = {
  taskId: string;
  state: TaskState;
  responsibility: CollaborationResponsibility;
  execution: CollaborationExecution | null;
  readyResult: CollaborationTaskResult | null;
  pendingDecision: CollaborationDecision | null;
};

export type CollaborationStatusDetail = TaskStatusDetail & { taskId: string };

export type CollaborationInboxItem =
  | ({ kind: "result" } & CollaborationTaskResult)
  | ({ kind: "decision"; nodeIds: readonly string[]; createdAt: string } & CollaborationDecision);

/**
 * Product-facing renderer projection. Task ids exist only inside Service joins;
 * the renderer owns exact Task Result / Decision identities and no Session facts.
 */
export type WorkspaceCollaborationView = {
  workspaceId: string;
  selectedNode: {
    nodeId: string;
    activeTasks: readonly CollaborationActiveTask[];
    statusDetail: CollaborationStatusDetail | null;
  } | null;
  inbox: {
    items: readonly CollaborationInboxItem[];
    counts: { result: number; decision: number; total: number };
  };
};

const TASK_STATES = new Set<TaskState>([
  "queued",
  "running",
  "waiting",
  "submitted",
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

function parseStatusDetail(raw: unknown): TaskStatusDetail | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new Error("workspace.collaboration statusDetail is corrupt");
  const allowed = new Set(["kind", "report", "error", "code", "at", "executionSessionId"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error("workspace.collaboration statusDetail is corrupt");
  }
  if (raw.kind !== "blocked" && raw.kind !== "failed") {
    throw new Error("workspace.collaboration statusDetail kind is corrupt");
  }
  const report = parseBoundedStatusDetailString(raw.report, 64 * 1024);
  const error = parseBoundedStatusDetailString(raw.error, 8 * 1024);
  if (!report && !error) throw new Error("workspace.collaboration statusDetail is empty");
  const code = parseBoundedStatusDetailString(raw.code, 128);
  if (code && !/^[A-Za-z0-9_.:-]+$/.test(code)) {
    throw new Error("workspace.collaboration statusDetail code is corrupt");
  }
  const at = raw.at === undefined ? undefined : parseStatusDetailTimestamp(raw.at);
  const executionSessionId = raw.executionSessionId === undefined
    ? undefined
    : parseStatusDetailSessionId(raw.executionSessionId);
  return {
    kind: raw.kind,
    ...(report ? { report } : {}),
    ...(error ? { error } : {}),
    ...(code ? { code } : {}),
    ...(at ? { at } : {}),
    ...(executionSessionId ? { executionSessionId } : {}),
  };
}

function parseSelectedNodeStatusDetail(raw: unknown): CollaborationStatusDetail | null {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.taskId !== "string" || !isTaskId(raw.taskId)) {
    throw new Error("workspace.collaboration selected statusDetail identity is corrupt");
  }
  const { taskId, ...statusDetail } = raw;
  const parsed = parseStatusDetail(statusDetail);
  if (!parsed) throw new Error("workspace.collaboration selected statusDetail is corrupt");
  return { taskId, ...parsed };
}

function parseBoundedStatusDetailString(value: unknown, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("workspace.collaboration statusDetail text is corrupt");
  const text = value.trim();
  if (!text) return undefined;
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error("workspace.collaboration statusDetail text exceeds its bound");
  }
  return text;
}

function parseStatusDetailTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) throw new Error("workspace.collaboration statusDetail timestamp is corrupt");
  return value;
}

function parseStatusDetailSessionId(value: unknown): string {
  if (typeof value !== "string" || !isSessionId(value)) {
    throw new Error("workspace.collaboration statusDetail Session is corrupt");
  }
  return value;
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

function parseTaskResult(raw: unknown, label: string): CollaborationTaskResult | null {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !exactKeys(raw, ["resultId", "summary", "createdAt"]) ||
    !nonEmpty(raw.resultId) ||
    typeof raw.summary !== "string" ||
    !nonEmpty(raw.createdAt)
  ) throw new Error(`${label} is corrupt`);
  return {
    resultId: raw.resultId,
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

function parseActiveTasks(raw: unknown): CollaborationActiveTask[] {
  if (!Array.isArray(raw)) throw new Error("workspace.collaboration activeTasks are corrupt");
  return raw.map((item) => {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "taskId",
        "state",
        "responsibility",
        "execution",
        "readyResult",
        "pendingDecision",
      ]) ||
      !nonEmpty(item.taskId) ||
      !TASK_STATES.has(item.state as TaskState)
    ) throw new Error("workspace.collaboration activeTasks are corrupt");
    return {
      taskId: item.taskId,
      state: item.state as TaskState,
      responsibility: parseResponsibility(item.responsibility),
      execution: parseExecution(item.execution),
      readyResult: parseTaskResult(item.readyResult, "selected Task Result"),
      pendingDecision: parseDecision(item.pendingDecision, "selected Decision"),
    };
  });
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
      !exactKeys(raw.inbox.counts, ["result", "decision", "total"])
    ) throw new Error("workspace.collaboration envelope is corrupt");

    let selectedNode: WorkspaceCollaborationView["selectedNode"] = null;
    if (expectedNodeId === null) {
      if (raw.selectedNode !== null) {
        throw new Error("workspace.collaboration unexpectedly selected a Node");
      }
    } else {
      if (
        !isRecord(raw.selectedNode) ||
        !exactKeys(raw.selectedNode, ["nodeId", "activeTasks", "statusDetail"]) ||
        raw.selectedNode.nodeId !== expectedNodeId
      ) throw new Error("workspace.collaboration selected Node mismatch");
      selectedNode = {
        nodeId: expectedNodeId,
        activeTasks: parseActiveTasks(raw.selectedNode.activeTasks),
        statusDetail: parseSelectedNodeStatusDetail(raw.selectedNode.statusDetail),
      };
    }

    const items: CollaborationInboxItem[] = raw.inbox.items.map((item, index) => {
      if (!isRecord(item) || !nonEmpty(item.kind) || !nonEmpty(item.taskId)) {
        throw new Error(`workspace.collaboration inbox[${index}] is corrupt`);
      }
      if (
        item.kind === "result" &&
        exactKeys(item, [
          "kind",
          "resultId",
          "taskId",
          "summary",
          "createdAt",
        ]) &&
        nonEmpty(item.resultId) &&
        typeof item.summary === "string" &&
        nonEmpty(item.createdAt)
      ) {
        return {
          kind: "result",
          resultId: item.resultId,
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

    const result = items.filter((item) => item.kind === "result").length;
    const decision = items.filter((item) => item.kind === "decision").length;
    if (
      raw.inbox.counts.result !== result ||
      raw.inbox.counts.decision !== decision ||
      raw.inbox.counts.total !== items.length
    ) throw new Error("workspace.collaboration counts are corrupt");

    const identities = items.map((item) =>
      item.kind === "result" ? `result:${item.resultId}` : `decision:${item.requestId}`
    );
    if (new Set(identities).size !== identities.length) {
      throw new Error("workspace.collaboration inbox identities are duplicated");
    }

    return {
      ok: true,
      value: {
        workspaceId: expectedWorkspaceId,
        selectedNode,
        inbox: { items, counts: { result, decision, total: items.length } },
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "workspace.collaboration is corrupt",
    };
  }
}
