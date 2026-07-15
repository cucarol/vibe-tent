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

/**
 * Shared machine-local ACP profile bag (canonical `AgentProfileConfig.acp`).
 * Provider-neutral field names; each *-acp adapter interprets values for its CLI.
 * Secret values stay in OS/process env — only env key *names* and non-secret paths live here.
 * Provider adapters may extend (e.g. GrokAcpProfileOptions) for provider-only knobs.
 */
export interface AcpProfileOptions {
  /** Absolute path to the provider CLI / ACP bridge executable on this machine. */
  executable?: string;
  /** Explicit model id passed to the provider CLI when supported. */
  model?: string;
  /**
   * Process env key for API token (read from service process env only).
   * Value is never written to workspace/box/task or agent-profiles.json.
   * When credentialRef is set, AgentRuntime resolves the vault secret into this env key
   * at startSession (process-scoped LaunchPlan.env only — never SessionRecord / disk).
   */
  envKey?: string;
  /**
   * Machine-local CredentialStore id (reference only — never the secret value).
   * Service resolves via OS-backed vault before launch; profile JSON stores only this id.
   */
  credentialRef?: string;
  /**
   * Process env key whose **value** is an OpenAI-compatible / provider base URL.
   * Only the env key *name* is stored on the machine-local profile.
   */
  baseUrlEnvKey?: string;
  /**
   * Optional literal base URL on the **machine-local** profile only.
   * Prefer baseUrlEnvKey + process env. Never copy this field into workspace / git.
   */
  baseUrl?: string;
  /** Max wait for session/prompt result (ms). Default: DEFAULT_PROMPT_TIMEOUT_MS. */
  promptTimeoutMs?: number;
  /**
   * How to answer ACP tool permission requests:
   * - deny (default): cancel — never auto-approve
   * - allow: allow_once only (never allow_always / yolo)
   * - ask: emit session.waiting_user and wait for runtime permission decision or timeout→deny
   */
  permissionPolicy?: AcpPermissionPolicy;
  /** When permissionPolicy is ask, max wait before deny (ms). Default: DEFAULT_PERMISSION_TIMEOUT_MS. */
  permissionTimeoutMs?: number;
}
