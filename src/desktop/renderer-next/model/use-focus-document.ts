import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ServiceGateway } from "../gateway/service-gateway.js";
import {
  FocusDocumentController,
  type FocusDocumentActions,
  type FocusDocumentView,
} from "./focus-document-controller.js";

export function useFocusDocument(args: {
  gateway: ServiceGateway;
  workspaceId: string;
  nodeId: string | null;
  archived: boolean;
  online: boolean;
}): { view: FocusDocumentView; actions: FocusDocumentActions } {
  const controller = useMemo(
    () => new FocusDocumentController(args.gateway),
    [args.gateway]
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getView,
    controller.getView
  );
  const actions = useMemo(() => controller.actions(), [controller]);

  useEffect(() => {
    controller.setOnline(args.online);
  }, [args.online, controller]);

  useEffect(() => {
    controller.select(args.workspaceId, args.nodeId, args.archived);
  }, [args.archived, args.nodeId, args.workspaceId, controller]);

  useEffect(
    () => args.gateway.onInvalidation((hint) => {
      if (hint.event?.workspaceId && hint.event.workspaceId !== args.workspaceId) return;
      if (
        hint.keys.includes("*") ||
        hint.keys.includes("docs.focus") ||
        hint.keys.includes("docs.get")
      ) {
        void controller.invalidate();
      }
    }),
    [args.gateway, args.workspaceId, controller]
  );

  return { view, actions };
}
