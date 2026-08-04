import type { EventEnvelope } from "../../../service/types.js";
import type { TentDesktopBridge } from "../../renderer/api-types.js";
import { ServiceGateway } from "./service-gateway.js";

export type DesktopWorkspace = {
  workspaceId: string;
  workspaceRoot: string;
  tentName: string;
  foreground: boolean;
};

export type DesktopBootstrap = {
  protocolVersion: number;
  workspaces: readonly DesktopWorkspace[];
  foregroundWorkspace: DesktopWorkspace | null;
};

export type RendererDesktopBridge = Pick<
  TentDesktopBridge,
  "getState" | "rpc" | "document" | "onStateChanged" | "onServiceEvent"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkspace(value: unknown): DesktopWorkspace | null {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== "string" ||
    !value.workspaceId ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.tentName !== "string" ||
    typeof value.foreground !== "boolean"
  ) {
    return null;
  }
  return {
    workspaceId: value.workspaceId,
    workspaceRoot: value.workspaceRoot,
    tentName: value.tentName,
    foreground: value.foreground,
  };
}

export function normalizeDesktopBootstrap(raw: unknown): DesktopBootstrap {
  if (!isRecord(raw) || !isRecord(raw.health)) {
    throw new Error("桌面服务状态不可用");
  }
  const health = raw.health;
  if (health.status !== "ok" || health.protocolVersion !== 5) {
    throw new Error("桌面服务未连接到协议 5");
  }
  if (!Array.isArray(raw.workspaces)) {
    throw new Error("工作区列表不可用");
  }
  const workspaces = raw.workspaces.map(normalizeWorkspace);
  if (workspaces.some((workspace) => workspace === null)) {
    throw new Error("工作区列表损坏");
  }
  const exact = workspaces as DesktopWorkspace[];
  const foregroundId =
    typeof raw.foregroundWorkspaceId === "string"
      ? raw.foregroundWorkspaceId
      : null;
  const foregroundWorkspace = foregroundId
    ? exact.find((workspace) => workspace.workspaceId === foregroundId) ?? null
    : exact.find((workspace) => workspace.foreground) ?? null;
  if (foregroundId && !foregroundWorkspace) {
    throw new Error("前台工作区不在工作区列表中");
  }
  return {
    protocolVersion: 5,
    workspaces: exact,
    foregroundWorkspace,
  };
}

export function requireDesktopBridge(
  source: Pick<Window, "tentDesktop"> = window
): RendererDesktopBridge {
  if (!source.tentDesktop) {
    throw new Error("Electron preload bridge 不可用");
  }
  return source.tentDesktop;
}

export function createDesktopServiceGateway(
  bridge: RendererDesktopBridge
): ServiceGateway {
  let eventCounter = 0;
  return new ServiceGateway({
    projectionRpc: (method, params) => bridge.rpc(method, params),
    documentTransport: (request) => bridge.document(request),
    subscribeEvents: (handler) =>
      bridge.onServiceEvent((event) => {
        const envelope: EventEnvelope = {
          id: `desktop-invalidation-${++eventCounter}`,
          type: event.type,
          workspaceId: event.workspaceId ?? "",
          ts: new Date().toISOString(),
          source: "service",
          payload: {},
        };
        handler(envelope);
      }),
  });
}
