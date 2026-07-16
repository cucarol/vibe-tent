// Shared ACP stdio session layer (provider-neutral).
// Provider launch/auth/env/model stay in adapter packages (e.g. grok-acp, codex-acp).

export {
  AcpClient,
  type AcpClientOptions,
  type AcpConnectMode,
  type AcpConnectOptions,
  type AcpConnectResult,
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
  type AcpProfileOptions,
  type AcpSessionUpdate,
} from "./types.js";
export {
  AcpManagedSession,
  bindAcpPermissionHooks,
  loadSessionAcpCapabilities,
  mapAcpProcessExit,
  mainstreamAcpCapabilities,
  parseAcpResumeToken,
  resumeManagedAcpSession,
  startManagedAcpSession,
  stopAcpClientQuiet,
  type AcpPermissionAskHooks,
  type ManagedAcpClient,
  type ResumeManagedAcpSessionInput,
  type StartManagedAcpSessionInput,
} from "./managed-session.js";
export {
  defaultNpxCommand,
  normalizeAcpPermissionPolicy,
  normalizeSharedAcpOpts,
  readAcpExtras,
  resolveNpxAcpLaunch,
  resolvePlanOrProcessEnv,
} from "./profile.js";
