// Grok ACP provider types — machine-local config only; never workspace secrets.

import type { AcpPermissionPolicy } from "../acp/types.js";

export type {
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpPermissionOption,
  AcpSessionUpdate,
} from "../acp/types.js";

export {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
} from "../acp/types.js";

/** Permission handling for ACP `session/request_permission` (no unconditional yolo). */
export type GrokAcpPermissionPolicy = AcpPermissionPolicy;

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
  /**
   * Process env key whose **value** is the CPA OpenAI-compatible base URL
   * (e.g. `http://127.0.0.1:8317/v1`). Default: CPA_GROK_BASE_URL.
   * Only the env key *name* is stored on the machine-local profile — never the URL itself
   * (URL is still machine-local secret/config, not workspace git).
   * When the env is set, adapter injects it into the child via XAI_API_BASE_URL /
   * OPENAI_BASE_URL and `--xai-api-base-url` so CPA is reachable without relying solely
   * on ~/.grok/config.toml (still supported as fallback when env is unset).
   */
  baseUrlEnvKey?: string;
  /**
   * Optional literal CPA base URL on the **machine-local** profile only.
   * Prefer baseUrlEnvKey + process env. Never copy this field into workspace / git.
   * Used when Desktop/service cannot inherit a user shell env (still not a secret in product UI).
   */
  baseUrl?: string;
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
/** Default process env name for CPA OpenAI-compatible base URL (value never in workspace). */
export const DEFAULT_GROK_BASE_URL_ENV_KEY = "CPA_GROK_BASE_URL";
