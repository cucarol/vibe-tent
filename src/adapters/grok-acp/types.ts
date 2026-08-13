// Grok ACP provider types — machine-local config only; never workspace secrets.

import type { AcpPermissionPolicy, AcpRouteOptions } from "../acp/types.js";

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
 * Route extras for adapterId "grok-acp".
 * Extends shared {@link AcpRouteOptions}; Grok-specific knobs can be added here later.
 * Lives only on a machine Agent Connection; never in workspace git / task bodies.
 *
 * Canonical storage is the flat machine Agent Connection. The runtime projects
 * these fields into the provider-neutral in-memory ACP launch bag.
 */
export interface GrokAcpRouteOptions extends AcpRouteOptions {
  // Shared fields (model / envKey / endpoint / timeouts / permissionPolicy)
  // are defined on AcpRouteOptions. Grok defaults (model/env keys) live in constants below
  // and are applied by the Grok adapter + product create path — not invented for other adapters.
}

export const GROK_ACP_ADAPTER_ID = "grok-acp";
export const DEFAULT_GROK_MODEL = "grok-4.5";
export const DEFAULT_GROK_ENV_KEY = "CPA_GROK_API_KEY";
/** Default process env name for CPA OpenAI-compatible base URL (value never in workspace). */
export const DEFAULT_GROK_BASE_URL_ENV_KEY = "CPA_GROK_BASE_URL";
