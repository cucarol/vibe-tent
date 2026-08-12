/**
 * Narrow Electron boundary for Task, Delivery, and Decision Request UI.
 *
 * Authority fields are deliberately absent: Desktop main supplies the fixed
 * local-user parent/actor values. Renderer code cannot override Git
 * integration commits, Sessions, reviewers, or lifecycle actors.
 */

export type DesktopAcceptMode =
  | "review-required"
  | "auto-accept"
  | "agent-decide";

export type DesktopDispatchTarget =
  | { kind: "role"; id: string }
  | { kind: "connection"; id: string };

export type DesktopDecisionResponse =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "deny" };

export type DesktopCollaborationRequest =
  | { operation: "targets"; workspaceId: string }
  | {
      operation: "dispatch";
      workspaceId: string;
      workNodeIds: string[];
      contextNodeIds: string[];
      prompt: string;
      target: DesktopDispatchTarget;
      acceptMode: DesktopAcceptMode;
    }
  | {
      operation: "acceptDelivery";
      workspaceId: string;
      deliveryId: string;
      outputNodeIds: string[];
    }
  | {
      operation: "rejectDelivery";
      workspaceId: string;
      deliveryId: string;
      note: string;
      resume: true;
    }
  | {
      operation: "respondDecision";
      workspaceId: string;
      requestId: string;
      response: DesktopDecisionResponse;
    };

export type DesktopCollaborationError = {
  kind: "rpc" | "transport" | "invalid-request" | "invalid-response";
  message: string;
  code?: number;
  data?: unknown;
};

export type DesktopCollaborationResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: DesktopCollaborationError };
