// Grok ACP provider types — machine-local config only; never workspace secrets.

/** Permission handling for ACP `session/request_permission` (no unconditional yolo). */
export type GrokAcpPermissionPolicy = "allow" | "ask" | "deny";

/**
 * Profile extras for adapterId "grok-acp".
 * Lives only on machine-local AgentProfile; never in workspace git / task bodies.
 */
export interface GrokAcpProfileOptions {
  /** Absolute path to grok executable. Default: %USERPROFILE%\\.grok\\bin\\grok.exe (or ~/.grok/bin/grok). */
  executable?: string;
  /** Explicit model passed as `grok agent --model <model> stdio`. Default: grok-4.5 */
  model?: string;
  /**
   * Process env key for API token (read from service process env only).
   * Default: CPA_GROK_API_KEY. Value is never written to workspace/box/task.
   */
  envKey?: string;
  /** Max wait for session/prompt result (ms). Default: 30 minutes. */
  promptTimeoutMs?: number;
  /**
   * How to answer ACP tool permission requests:
   * - deny (default): cancel — never auto-approve
   * - allow: allow_once only (never allow_always / yolo)
   * - ask: emit session.waiting_user and wait for runtime permission decision or timeout→deny
   */
  permissionPolicy?: GrokAcpPermissionPolicy;
  /** When permissionPolicy is ask, max wait before deny (ms). Default: 120_000. */
  permissionTimeoutMs?: number;
}

export const GROK_ACP_ADAPTER_ID = "grok-acp";
export const DEFAULT_GROK_MODEL = "grok-4.5";
export const DEFAULT_GROK_ENV_KEY = "CPA_GROK_API_KEY";
export const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
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
