import type { AcpPermissionPolicy, AcpRouteOptions } from "../acp/types.js";

export type CopilotAcpPermissionPolicy = AcpPermissionPolicy;
export interface CopilotAcpRouteOptions extends AcpRouteOptions {}

export const COPILOT_ACP_ADAPTER_ID = "copilot-acp";
export const COPILOT_ACP_NPX_PACKAGE = "@github/copilot";
