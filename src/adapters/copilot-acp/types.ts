import type { AcpPermissionPolicy, AcpProfileOptions } from "../acp/types.js";

export type CopilotAcpPermissionPolicy = AcpPermissionPolicy;
export interface CopilotAcpProfileOptions extends AcpProfileOptions {}

export const COPILOT_ACP_ADAPTER_ID = "copilot-acp";
export const COPILOT_ACP_NPX_PACKAGE = "@github/copilot";
