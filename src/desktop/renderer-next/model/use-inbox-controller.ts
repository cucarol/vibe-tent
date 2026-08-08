import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ServiceGateway } from "../gateway/service-gateway.js";
import { InboxController, type InboxControllerGateway } from "./inbox-controller.js";
import type { InboxModel } from "./inbox.js";

type InboxControllerBinding = {
  gateway: InboxControllerGateway;
  controller: InboxController;
};

function workspaceView(model: InboxModel, workspaceId: string): InboxModel {
  if (model.state === "idle" && workspaceId) {
    return { state: "loading", workspaceId };
  }
  if (model.state !== "idle" && model.workspaceId !== workspaceId) {
    return { state: "loading", workspaceId };
  }
  return model;
}

export function useInboxController(
  gateway: Pick<ServiceGateway, "onInvalidation" | "pendingInteractions">,
  workspaceId: string
): InboxModel {
  const bindingRef = useRef<InboxControllerBinding | null>(null);
  if (!bindingRef.current || bindingRef.current.gateway !== gateway) {
    bindingRef.current?.controller.dispose();
    bindingRef.current = {
      gateway,
      controller: new InboxController(gateway),
    };
  }
  const controller = bindingRef.current.controller;
  const model = useSyncExternalStore(
    controller.subscribe,
    controller.getView,
    controller.getView
  );

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    controller.select(workspaceId);
  }, [controller, workspaceId]);

  return workspaceView(model, workspaceId);
}
