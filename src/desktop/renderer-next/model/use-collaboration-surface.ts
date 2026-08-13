import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ServiceGateway } from "../gateway/service-gateway.js";
import {
  CollaborationSurfaceController,
  type CollaborationSurfaceActions,
  type CollaborationSurfaceView,
  type CollaborationSurfaceGateway,
} from "./collaboration-surface-controller.js";

export function guardCollaborationViewIdentity(
  view: CollaborationSurfaceView,
  args: { workspaceId: string; nodeId: string | null; online: boolean }
): CollaborationSurfaceView {
  if (view.workspaceId === args.workspaceId && view.nodeId === args.nodeId) {
    if (args.online) return view;
    return {
      ...view,
      status: view.snapshot ? "stale" : "error",
      busyKey: null,
      canMutate: false,
      issue: { kind: "transport" as const, message: "本地服务连接已中断" },
    };
  }
  if (view.workspaceId === args.workspaceId && view.snapshot) {
    return {
      ...view,
      nodeId: args.nodeId,
      status: args.online ? "refreshing" : "stale",
      snapshot: { ...view.snapshot, selectedNode: null },
      busyKey: null,
      canMutate: false,
      ...(!args.online
        ? { issue: { kind: "transport" as const, message: "本地服务连接已中断" } }
        : {}),
    };
  }
  return {
    workspaceId: args.workspaceId,
    nodeId: args.nodeId,
    status: args.online ? "loading" : "error",
    snapshot: null,
    targets: [],
    targetsReady: false,
    busyKey: null,
    canMutate: false,
    ...(!args.online
      ? { issue: { kind: "transport" as const, message: "本地服务连接已中断" } }
      : {}),
  };
}

export function guardCollaborationActionsOnline(
  actions: CollaborationSurfaceActions,
  online: boolean
): CollaborationSurfaceActions {
  if (online) return actions;
  return {
    retry: actions.retry,
    dispatch: async () => false,
    acceptTaskResult: async () => false,
    rejectTaskResult: async () => false,
    respondDecision: async () => false,
  };
}

export function useCollaborationSurface(args: {
  gateway: ServiceGateway & CollaborationSurfaceGateway;
  workspaceId: string;
  nodeId: string | null;
  online: boolean;
}): { view: CollaborationSurfaceView; actions: CollaborationSurfaceActions } {
  const controller = useMemo(
    () => new CollaborationSurfaceController(args.gateway),
    [args.gateway]
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getView,
    controller.getView
  );
  const actions = useMemo(() => controller.actions(), [controller]);
  const exactActions = useMemo(
    () => guardCollaborationActionsOnline(actions, args.online),
    [actions, args.online]
  );
  const exactView = guardCollaborationViewIdentity(view, args);

  // Subscribe before the first selected-Node read. An invalidation arriving
  // while that snapshot is in flight must queue a second authoritative read.
  useEffect(
    () => args.gateway.onInvalidation((hint) => {
      if (hint.event?.workspaceId && hint.event.workspaceId !== args.workspaceId) return;
      if (
        hint.keys.includes("*") ||
        hint.keys.includes("workspace.collaboration") ||
        hint.keys.includes("dispatch.targets")
      ) {
        void controller.invalidate();
      }
    }),
    [args.gateway, args.workspaceId, controller]
  );

  useEffect(() => {
    controller.setOnline(args.online);
  }, [args.online, controller]);

  useEffect(() => {
    controller.select(args.workspaceId, args.nodeId);
  }, [args.nodeId, args.workspaceId, controller]);

  return { view: exactView, actions: exactActions };
}
