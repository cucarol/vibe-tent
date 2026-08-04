import type { DesktopDocumentResponse } from "../document-ipc.js";
import { ServiceRpcError, type ServiceRpcClient } from "../client/rpc-client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Pure handler behind the narrow Electron document IPC channel. */
export async function handleDesktopDocumentRequest(
  client: Pick<ServiceRpcClient, "call"> | null,
  request: unknown
): Promise<DesktopDocumentResponse> {
  if (!client) {
    return {
      ok: false,
      error: { kind: "transport", message: "Service not attached" },
    };
  }
  if (
    !isRecord(request) ||
    typeof request.workspaceId !== "string" ||
    !request.workspaceId ||
    typeof request.nodeId !== "string" ||
    !request.nodeId
  ) {
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Invalid document request" },
    };
  }
  try {
    if (request.operation === "readForEdit") {
      return {
        ok: true,
        value: await client.call("docs.readForEdit", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId,
        }),
      };
    }
    if (request.operation === "backlinks") {
      return {
        ok: true,
        value: await client.call("docs.backlinks", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId,
        }),
      };
    }
    if (
      request.operation === "writeBody" &&
      typeof request.body === "string"
    ) {
      return {
        ok: true,
        value: await client.call("docs.write", {
          workspaceId: request.workspaceId,
          nodeId: request.nodeId,
          body: request.body,
          ...(typeof request.baseEtag === "string" && request.baseEtag
            ? { baseEtag: request.baseEtag }
            : {}),
        }),
      };
    }
    return {
      ok: false,
      error: { kind: "invalid-request", message: "Unsupported document request" },
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
        kind: "transport",
        message: cause instanceof Error ? cause.message : "Document request failed",
      },
    };
  }
}
