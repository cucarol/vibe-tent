import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useRef, useState } from "react";
import type { ExcalidrawSceneSnapshot } from "../canvas/excalidraw/excalidrawSceneTypes.js";
import { CanvasV5LocalPersistence } from "../model/canvas-v5-local-persistence.js";
import { createEmptyCanvasDocument } from "../types/identity.js";
import { AppShell } from "../shell/AppShell.js";
import type { WorkbenchPresentationState } from "../shell/workbench-presentation.js";
import type { ProjectionState, WorkbenchNodeView } from "../shell/workbench-types.js";
import { fixtureNodes } from "./fixtures.js";

const E2E_WORKSPACE_ID = "ws-storybook-production-canvas-e2e";
const AUTHORITY_STORAGE_KEY = "tent.storybook.canvasE2E.authority.v1";

type AuthorityMode = "base" | "drifted";

function driftedNodes(): WorkbenchNodeView[] {
  const nodes = fixtureNodes("ready")
    .filter((node) => node.nodeId !== "cx-research")
    .map((node) => node.nodeId === "cx-product"
      ? {
          ...node,
          etag: "etag-product-v2",
          title: "把复杂协作变成稳定、可见的工作",
        }
      : node);
  return [
    ...nodes,
    {
      nodeId: "cx-evidence",
      etag: "etag-evidence-v1",
      path: "产品方向/交互证据",
      name: "交互证据",
      title: "真实交互与持久化证据",
      type: "output",
      tags: ["E2E"],
      mode: "editable",
      archived: false,
      invalid: false,
      parentNodeId: "cx-product",
      hasChildren: false,
      depth: 1,
      projectionState: "ready",
    },
  ];
}

function nodesFor(mode: AuthorityMode, projection: ProjectionState): WorkbenchNodeView[] {
  const nodes = mode === "drifted" ? driftedNodes() : fixtureNodes("ready");
  if (projection === "ready") return nodes;
  return nodes.map((node) => ({
    ...node,
    projectionState: projection,
    projectionMessage: projection === "stale"
      ? "权威投影正在恢复；本地画布保持可见。"
      : projection === "error"
        ? "权威投影查询失败；本地画布保持可见。"
        : node.projectionMessage,
  }));
}

function readAuthorityMode(): AuthorityMode {
  return window.localStorage.getItem(AUTHORITY_STORAGE_KEY) === "drifted"
    ? "drifted"
    : "base";
}

function CanvasProductionInteractionsPreview() {
  const persistence = useMemo(
    () => new CanvasV5LocalPersistence(window.localStorage, E2E_WORKSPACE_ID),
    []
  );
  const loaded = useMemo(() => persistence.load().snapshot, [persistence]);
  const [presentation, setPresentation] = useState<WorkbenchPresentationState>(() => ({
    document: loaded.document,
    selectedNodeId: loaded.document.focusedPlacementId
      ? loaded.document.placements.find(
          (placement) => placement.placementId === loaded.document.focusedPlacementId
        )?.entityRef ?? null
      : null,
  }));
  const [scene, setScene] = useState<ExcalidrawSceneSnapshot | null>(loaded.scene);
  const sceneRef = useRef(scene);
  const presentationRef = useRef(presentation);
  const [authorityMode, setAuthorityMode] = useState<AuthorityMode>(readAuthorityMode);
  const [projection, setProjection] = useState<ProjectionState>("ready");
  const nodes = useMemo(
    () => nodesFor(authorityMode, projection),
    [authorityMode, projection]
  );

  const save = (nextPresentation: WorkbenchPresentationState, nextScene = sceneRef.current) => {
    persistence.save({
      version: 1,
      workspaceId: E2E_WORKSPACE_ID,
      document: nextPresentation.document,
      scene: nextScene,
    });
  };

  const updatePresentation = (
    update: (current: WorkbenchPresentationState) => WorkbenchPresentationState
  ) => {
    setPresentation((current) => {
      const next = update(current);
      presentationRef.current = next;
      save(next);
      return next;
    });
  };

  const reset = () => {
    window.localStorage.removeItem(AUTHORITY_STORAGE_KEY);
    window.localStorage.removeItem(
      `tent.desktop.canvasV5Local.v1:${E2E_WORKSPACE_ID}`
    );
    const next = { document: createEmptyCanvasDocument(), selectedNodeId: null };
    sceneRef.current = null;
    presentationRef.current = next;
    setScene(null);
    setAuthorityMode("base");
    setProjection("ready");
    setPresentation(next);
  };

  const setAuthority = (mode: AuthorityMode) => {
    window.localStorage.setItem(AUTHORITY_STORAGE_KEY, mode);
    setAuthorityMode(mode);
  };

  return (
    <div
      data-testid="canvas-production-e2e"
      data-authority={authorityMode}
      data-projection={projection}
      style={{ width: "100vw", height: "100vh", overflow: "hidden", position: "relative" }}
    >
      <div
        aria-label="Storybook E2E controls"
        style={{
          position: "fixed",
          zIndex: 10000,
          right: 8,
          bottom: 8,
          display: "flex",
          gap: 4,
          padding: 4,
          border: "1px solid #d8d8d8",
          borderRadius: 6,
          background: "rgba(255,255,255,.94)",
        }}
      >
        <button type="button" data-testid="e2e-reset" onClick={reset}>重置 E2E</button>
        <button type="button" data-testid="e2e-drift" onClick={() => setAuthority("drifted")}>权威变化</button>
        <button type="button" data-testid="e2e-stale" onClick={() => setProjection("stale")}>投影过期</button>
        <button type="button" data-testid="e2e-online" onClick={() => setProjection("ready")}>恢复投影</button>
      </div>
      <output
        data-testid="canvas-e2e-state"
        aria-hidden="true"
        hidden
      >
        {JSON.stringify({
          authorityMode,
          projection,
          presentation,
        })}
      </output>
      <AppShell
        workspaceId={E2E_WORKSPACE_ID}
        workspaceLabel="E2E 隔离工作区"
        initialNodes={nodes}
        document={presentation.document}
        selectedNodeId={presentation.selectedNodeId}
        onPresentationChange={updatePresentation}
        connection={projection === "ready" ? "online" : "reconnecting"}
        projectionState={projection === "ready" ? "fresh" : projection}
        onRetryConnection={() => setProjection("ready")}
        initialScene={scene}
        onScenePersist={(nextScene) => {
          sceneRef.current = nextScene;
          setScene(nextScene);
          save(presentationRef.current, nextScene);
        }}
      />
    </div>
  );
}

const meta = {
  title: "E2E/Production Canvas Interactions",
  component: CanvasProductionInteractionsPreview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CanvasProductionInteractionsPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProductionCanvasE2E: Story = {
  name: "Production Canvas E2E",
};
