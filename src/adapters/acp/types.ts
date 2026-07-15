// Provider-neutral ACP JSON-RPC types and session defaults.
// No provider-specific argv / auth / env / model knowledge.

/** Permission handling for ACP `session/request_permission` (no unconditional yolo). */
export type AcpPermissionPolicy = "allow" | "ask" | "deny";

/** Max wait for session/prompt result (ms). Default: 30 minutes. */
export const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
/** When permissionPolicy is ask, max wait before deny (ms). Default: 120_000. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export type AcpJsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type AcpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type AcpJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: number | string;
};

export type AcpPermissionOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

export type AcpSessionUpdate = {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
};

/** Params returned by the adapter auth hook for the ACP `authenticate` RPC. */
export type AcpAuthenticateParams = {
  methodId: string;
  [key: string]: unknown;
};
