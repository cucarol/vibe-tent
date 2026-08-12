import type {
  DesktopAcceptMode,
  DesktopCollaborationError,
  DesktopCollaborationRequest,
  DesktopDecisionResponse,
  DesktopDispatchTarget,
} from "../../collaboration-ipc.js";

export type CollaborationTarget = {
  kind: "role" | "connection";
  id: string;
  label: string;
  description?: string;
};

export type DispatchTargets = {
  workspaceId: string;
  targets: readonly CollaborationTarget[];
};

export type CollaborationMutation = { workspaceId: string };

export type CollaborationIssue = DesktopCollaborationError | {
  kind: "timeout" | "corrupt" | "request";
  message: string;
  code?: number;
  data?: unknown;
};

export type CollaborationRead<T> =
  | { ok: true; workspaceId: string; value: T; fetchedAt: string }
  | { ok: false; workspaceId: string; issue: CollaborationIssue; failedAt: string };

export type DispatchTaskRequest = {
  workspaceId: string;
  workNodeIds: string[];
  contextNodeIds: string[];
  prompt: string;
  acceptMode: DesktopAcceptMode;
  target: DesktopDispatchTarget;
};

export type CollaborationTransport = (
  request: DesktopCollaborationRequest
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeIssue(raw: unknown): CollaborationIssue | null {
  if (
    !isRecord(raw) ||
    !["rpc", "transport", "invalid-request", "invalid-response"].includes(String(raw.kind)) ||
    !nonEmpty(raw.message) ||
    !(raw.code === undefined || typeof raw.code === "number")
  ) return null;
  return {
    kind: raw.kind as DesktopCollaborationError["kind"],
    message: raw.message,
    ...(typeof raw.code === "number" ? { code: raw.code } : {}),
    ...(raw.data === undefined ? {} : { data: raw.data }),
  };
}

function invalid<T>(workspaceId: string, message: string): CollaborationRead<T> {
  return {
    ok: false,
    workspaceId,
    issue: { kind: "request", message },
    failedAt: new Date().toISOString(),
  };
}

async function request<T>(input: {
  transport: CollaborationTransport | undefined;
  request: DesktopCollaborationRequest;
  normalize: (value: unknown) => T;
}): Promise<CollaborationRead<T>> {
  const workspaceId = input.request.workspaceId;
  if (!workspaceId.trim()) return invalid(workspaceId, "workspaceId is required");
  if (!input.transport) return {
    ok: false,
    workspaceId,
    issue: { kind: "transport", message: "Desktop collaboration transport is unavailable" },
    failedAt: new Date().toISOString(),
  };
  let raw: unknown;
  try {
    raw = await input.transport(input.request);
  } catch (error) {
    return {
      ok: false,
      workspaceId,
      issue: {
        kind: "transport",
        message: error instanceof Error ? error.message : String(error),
      },
      failedAt: new Date().toISOString(),
    };
  }
  if (!isRecord(raw) || typeof raw.ok !== "boolean") {
    return {
      ok: false,
      workspaceId,
      issue: { kind: "corrupt", message: "Desktop collaboration envelope is corrupt" },
      failedAt: new Date().toISOString(),
    };
  }
  if (!raw.ok) {
    const issue = normalizeIssue(raw.error);
    return {
      ok: false,
      workspaceId,
      issue: issue ?? { kind: "corrupt", message: "Desktop collaboration error is corrupt" },
      failedAt: new Date().toISOString(),
    };
  }
  try {
    const value = input.normalize(raw.value);
    return { ok: true, workspaceId, value, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      workspaceId,
      issue: {
        kind: "corrupt",
        message: error instanceof Error ? error.message : "Desktop collaboration value is corrupt",
      },
      failedAt: new Date().toISOString(),
    };
  }
}

function normalizeMutation(raw: unknown, workspaceId: string): CollaborationMutation {
  if (!isRecord(raw) || raw.workspaceId !== workspaceId || Object.keys(raw).length !== 1) {
    throw new Error("Desktop collaboration mutation response is corrupt");
  }
  return { workspaceId };
}

export function readDispatchTargets(
  transport: CollaborationTransport | undefined,
  workspaceId: string
): Promise<CollaborationRead<DispatchTargets>> {
  return request({
    transport,
    request: { operation: "targets", workspaceId },
    normalize: (raw) => {
      if (
        !isRecord(raw) ||
        raw.workspaceId !== workspaceId ||
        !Array.isArray(raw.targets) ||
        Object.keys(raw).some((key) => key !== "workspaceId" && key !== "targets")
      ) throw new Error("Dispatch targets response is corrupt");
      const targets = raw.targets.map((item) => {
        if (
          !isRecord(item) ||
          (item.kind !== "role" && item.kind !== "connection") ||
          !nonEmpty(item.id) ||
          !nonEmpty(item.label) ||
          !(item.description === undefined || nonEmpty(item.description)) ||
          Object.keys(item).some((key) => !["kind", "id", "label", "description"].includes(key))
        ) throw new Error("Dispatch target is corrupt");
        return {
          kind: item.kind,
          id: item.id,
          label: item.label,
          ...(item.description ? { description: item.description } : {}),
        } as CollaborationTarget;
      });
      const identities = targets.map((target) => `${target.kind}:${target.id}`);
      if (new Set(identities).size !== identities.length) {
        throw new Error("Dispatch targets are duplicated");
      }
      return { workspaceId, targets };
    },
  });
}

export function dispatchTask(
  transport: CollaborationTransport | undefined,
  input: DispatchTaskRequest
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "dispatch", ...input },
    normalize: (raw) => normalizeMutation(raw, input.workspaceId),
  });
}

export function acceptDelivery(
  transport: CollaborationTransport | undefined,
  workspaceId: string,
  deliveryId: string,
  outputNodeIds: string[] = []
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "acceptDelivery", workspaceId, deliveryId, outputNodeIds },
    normalize: (raw) => normalizeMutation(raw, workspaceId),
  });
}

export function rejectDelivery(
  transport: CollaborationTransport | undefined,
  workspaceId: string,
  deliveryId: string,
  note: string
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "rejectDelivery", workspaceId, deliveryId, note, resume: true },
    normalize: (raw) => normalizeMutation(raw, workspaceId),
  });
}

export function respondDecision(
  transport: CollaborationTransport | undefined,
  workspaceId: string,
  requestId: string,
  response: DesktopDecisionResponse
): Promise<CollaborationRead<CollaborationMutation>> {
  return request({
    transport,
    request: { operation: "respondDecision", workspaceId, requestId, response },
    normalize: (raw) => normalizeMutation(raw, workspaceId),
  });
}
