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

/**
 * Tested release for the official Claude Agent ACP bridge.
 * Keep this pinned: bare npx specs can reuse a stale cached bridge, and 0.61.0
 * fails Windows session/resume with `spawn EFTYPE` while 0.62.0 is verified.
 */
export const CLAUDE_ACP_NPX_VERSION = "0.62.0";

/** npm package spec launched via npx for the official Claude Agent ACP bridge. */
export const CLAUDE_ACP_NPX_PACKAGE =
  `@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_NPX_VERSION}`;
