// Shared ACP stdio session layer (provider-neutral).
// Provider launch/auth/env/model stay in adapter packages (e.g. grok-acp).

export {
  AcpClient,
  PERMISSION_FAILSAFE_SLACK_MS,
  type AcpClientOptions,
  type AcpStartResult,
} from "./client.js";
export {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_PROMPT_TIMEOUT_MS,
  type AcpAuthenticateParams,
  type AcpJsonRpcNotification,
  type AcpJsonRpcRequest,
  type AcpJsonRpcResponse,
  type AcpPermissionOption,
  type AcpPermissionPolicy,
  type AcpSessionUpdate,
} from "./types.js";
