// Codex ACP provider types — machine-local config only; never workspace secrets.

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

export type CodexAcpPermissionPolicy = AcpPermissionPolicy;

/**
 * Route extras for adapterId "codex-acp".
 * Extends shared {@link AcpRouteOptions}; no invented default model/envKey.
 * Canonical storage is `RouteConfig.acp`.
 */
export interface CodexAcpRouteOptions extends AcpRouteOptions {}

export const CODEX_ACP_ADAPTER_ID = "codex-acp";

/** npm package launched via npx for the official Codex ACP bridge. */
export const CODEX_ACP_NPX_PACKAGE = "@agentclientprotocol/codex-acp";

/**
 * Child-env JSON for Codex ACP DEFAULT_AUTH_REQUEST.
 * methodId=api-key; secret only under _meta.api-key.apiKey (never logged by Tent).
 */
export const CODEX_DEFAULT_AUTH_REQUEST_ENV = "DEFAULT_AUTH_REQUEST";
