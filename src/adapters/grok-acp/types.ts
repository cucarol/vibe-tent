// Grok ACP provider types — machine-local config only; never workspace secrets.

import type { AcpPermissionPolicy, AcpProfileOptions } from "../acp/types.js";

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
 * Extends shared {@link AcpProfileOptions}; Grok-specific knobs can be added here later.
 * Lives only on machine-local AgentProfile; never in workspace git / task bodies.
 *
 * Canonical storage is `AgentProfileConfig.acp` (not a separate grokAcp bag).
 */
export interface GrokAcpProfileOptions extends AcpProfileOptions {
  // Shared fields (executable / model / envKey / baseUrl* / timeouts / permissionPolicy)
  // are defined on AcpProfileOptions. Grok defaults (model/env keys) live in constants below
  // and are applied by the Grok adapter + product create path — not invented for other adapters.
}

export const GROK_ACP_ADAPTER_ID = "grok-acp";
export const DEFAULT_GROK_MODEL = "grok-4.5";
export const DEFAULT_GROK_ENV_KEY = "CPA_GROK_API_KEY";
/** Default process env name for CPA OpenAI-compatible base URL (value never in workspace). */
export const DEFAULT_GROK_BASE_URL_ENV_KEY = "CPA_GROK_BASE_URL";
