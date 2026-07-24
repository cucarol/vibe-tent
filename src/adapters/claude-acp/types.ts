// Claude ACP provider types — machine-local config only; never workspace secrets.

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

export type ClaudeAcpPermissionPolicy = AcpPermissionPolicy;

/**
 * Profile extras for adapterId "claude-acp".
 * Extends shared {@link AcpProfileOptions}; no invented default model/envKey.
 * Canonical storage is `AgentProfileConfig.acp`.
 */
export interface ClaudeAcpProfileOptions extends AcpProfileOptions {}

export const CLAUDE_ACP_ADAPTER_ID = "claude-acp";

/** Known-good bridge release; never let an existing profile drift with npm `latest`. */
export const CLAUDE_ACP_NPX_VERSION = "0.62.0";

/** npm package spec launched via npx for the official Claude Agent ACP bridge. */
export const CLAUDE_ACP_NPX_PACKAGE =
  `@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_NPX_VERSION}`;
