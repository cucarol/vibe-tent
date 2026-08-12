import type {
  DesktopCollaborationRequest,
  DesktopCollaborationResponse,
} from "../collaboration-ipc.js";
import { ServiceRpcError, type ServiceRpcClient } from "../client/rpc-client.js";

class InvalidCollaborationResponseError extends Error {}

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

function uniqueStrings(value: unknown, allowEmpty: boolean): value is string[] {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(nonEmpty) &&
    new Set(value).size === value.length;
}

function normalizeRequest(raw: unknown): DesktopCollaborationRequest | null {
  if (!isRecord(raw) || !nonEmpty(raw.operation) || !nonEmpty(raw.workspaceId)) return null;
  if (raw.operation === "targets" && exactKeys(raw, ["operation", "workspaceId"])) {
    return raw as DesktopCollaborationRequest;
  }
  if (
    raw.operation === "dispatch" &&
    exactKeys(raw, [
      "operation",
      "workspaceId",
      "workNodeIds",
      "contextNodeIds",
      "prompt",
      "target",
      "acceptMode",
    ]) &&
    uniqueStrings(raw.workNodeIds, false) &&
    uniqueStrings(raw.contextNodeIds, true) &&
    raw.workNodeIds.every((id) => !(raw.contextNodeIds as string[]).includes(id)) &&
    nonEmpty(raw.prompt) &&
    isRecord(raw.target) &&
    exactKeys(raw.target, ["kind", "id"]) &&
    (raw.target.kind === "role" || raw.target.kind === "connection") &&
    nonEmpty(raw.target.id) &&
    (raw.acceptMode === "review-required" ||
      raw.acceptMode === "auto-accept" ||
      raw.acceptMode === "agent-decide")
  ) return raw as DesktopCollaborationRequest;
  if (
    raw.operation === "acceptDelivery" &&
    exactKeys(raw, ["operation", "workspaceId", "deliveryId", "outputNodeIds"]) &&
    nonEmpty(raw.deliveryId) &&
    uniqueStrings(raw.outputNodeIds, true)
  ) return raw as DesktopCollaborationRequest;
  if (
    raw.operation === "rejectDelivery" &&
    exactKeys(raw, ["operation", "workspaceId", "deliveryId", "note", "resume"]) &&
    nonEmpty(raw.deliveryId) &&
    nonEmpty(raw.note) &&
    raw.resume === true
  ) return raw as DesktopCollaborationRequest;
  if (
    raw.operation === "respondDecision" &&
    exactKeys(raw, ["operation", "workspaceId", "requestId", "response"]) &&
    nonEmpty(raw.requestId) &&
    isRecord(raw.response)
  ) {
    const response = raw.response;
    if (
      (response.kind === "option" && exactKeys(response, ["kind", "optionId"]) && nonEmpty(response.optionId)) ||
      (response.kind === "custom" && exactKeys(response, ["kind", "text"]) && nonEmpty(response.text)) ||
      (response.kind === "deny" && exactKeys(response, ["kind"]))
    ) return raw as DesktopCollaborationRequest;
  }
  return null;
}

function dispatchTargets(
  rolesRaw: unknown,
  connectionsRaw: unknown,
  workspaceId: string
): Record<string, unknown> {
  if (
    !isRecord(rolesRaw) ||
    rolesRaw.workspaceId !== workspaceId ||
    !Array.isArray(rolesRaw.roles) ||
    !isRecord(connectionsRaw) ||
    !Array.isArray(connectionsRaw.connections)
  ) throw new InvalidCollaborationResponseError("dispatch targets response is corrupt");

  const roles = rolesRaw.roles.map((item) => {
    if (
      !isRecord(item) ||
      !nonEmpty(item.roleId) ||
      !nonEmpty(item.displayName) ||
      !(item.description === undefined || nonEmpty(item.description))
    ) throw new InvalidCollaborationResponseError("Role target is corrupt");
    return {
      kind: "role",
      id: item.roleId,
      label: item.displayName,
      ...(item.description ? { description: item.description } : {}),
    };
  });
  const connections = connectionsRaw.connections.map((item) => {
    if (!isRecord(item) || !nonEmpty(item.connectionId) || !nonEmpty(item.displayName)) {
      throw new InvalidCollaborationResponseError("Connection target is corrupt");
    }
    return { kind: "connection", id: item.connectionId, label: item.displayName };
  });
  return { workspaceId, targets: [...roles, ...connections] };
}

/** Narrow user-facing dispatch/review boundary; collaboration reads use workspace.collaboration. */
export async function handleDesktopCollaborationRequest(
  client: Pick<ServiceRpcClient, "call"> | null,
  rawRequest: unknown
): Promise<DesktopCollaborationResponse> {
  const request = normalizeRequest(rawRequest);
  if (!request) {
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Invalid collaboration request" },
    };
  }
  if (!client) {
    return { ok: false, error: { kind: "transport", message: "Service not attached" } };
  }
  try {
    if (request.operation === "targets") {
      const [roles, connections] = await Promise.all([
        client.call("registry.roles", { workspaceId: request.workspaceId }),
        client.call("connection.list", {}),
      ]);
      return { ok: true, value: dispatchTargets(roles, connections, request.workspaceId) };
    }
    if (request.operation === "dispatch") {
      const target = request.target.kind === "role"
        ? { roleId: request.target.id }
        : { connectionId: request.target.id };
      const result = await client.call("task.dispatch", {
        workspaceId: request.workspaceId,
        workNodeIds: request.workNodeIds,
        contextNodeIds: request.contextNodeIds,
        prompt: request.prompt,
        parentActor: { kind: "user", id: "user" },
        asSub: false,
        acceptMode: request.acceptMode,
        ...target,
      });
      if (!isRecord(result) || result.workspaceId !== request.workspaceId || !nonEmpty(result.taskPath)) {
        throw new InvalidCollaborationResponseError("task.dispatch response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    if (request.operation === "acceptDelivery") {
      const result = await client.call("task.accept", {
        workspaceId: request.workspaceId,
        deliveryId: request.deliveryId,
        outputNodeIds: request.outputNodeIds,
        actor: "user",
      });
      if (!isRecord(result) || result.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.accept response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    if (request.operation === "rejectDelivery") {
      const result = await client.call("task.reject", {
        workspaceId: request.workspaceId,
        deliveryId: request.deliveryId,
        actor: "user",
        note: request.note,
        resume: request.resume,
      });
      if (!isRecord(result) || result.workspaceId !== request.workspaceId) {
        throw new InvalidCollaborationResponseError("task.reject response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    if (request.operation === "respondDecision") {
      const result = await client.call("decisionRequest.respond", {
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        response: request.response,
      });
      if (!isRecord(result) || result.accepted !== true) {
        throw new InvalidCollaborationResponseError("decisionRequest.respond response is corrupt");
      }
      return { ok: true, value: { workspaceId: request.workspaceId } };
    }
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Unsupported collaboration request" },
    };
  } catch (cause) {
    if (cause instanceof ServiceRpcError) {
      return {
        ok: false,
        error: {
          kind: "rpc",
          code: cause.code,
          message: cause.message,
          data: cause.data,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: cause instanceof InvalidCollaborationResponseError
          ? "invalid-response"
          : "transport",
        message: cause instanceof Error ? cause.message : "Collaboration request failed",
      },
    };
  }
}
