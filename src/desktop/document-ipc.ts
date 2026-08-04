/**
 * Narrow, structured Electron envelope for Focus document operations.
 *
 * The generic desktop RPC remains unchanged. This seam exists because
 * Electron serializes rejected invoke Errors without preserving JSON-RPC
 * code/data fields, while optimistic Markdown writes must distinguish
 * -32008/-32009 without parsing message text.
 */

export type DesktopDocumentRequest =
  | {
      operation: "readForEdit";
      workspaceId: string;
      nodeId: string;
    }
  | {
      operation: "writeBody";
      workspaceId: string;
      nodeId: string;
      body: string;
      baseEtag: string;
    }
  | {
      operation: "backlinks";
      workspaceId: string;
      nodeId: string;
    };

export type DesktopDocumentError = {
  kind: "rpc" | "transport" | "invalid-request";
  message: string;
  code?: number;
  data?: unknown;
};

export type DesktopDocumentResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: DesktopDocumentError };
