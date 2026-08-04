import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GraphProjection,
  NodeCollaborationsResult,
} from "../../service/types.js";
import { AppShell } from "./shell/AppShell.js";
import {
  createDesktopServiceGateway,
  normalizeDesktopBootstrap,
  requireDesktopBridge,
  type DesktopBootstrap,
  type DesktopWorkspace,
  type RendererDesktopBridge,
} from "./gateway/desktop-bridge.js";
import {
  beginProjectionLoad,
  settleProjection,
  type ProjectionResource,
} from "./gateway/workspace-projections.js";
import { startWorkspaceProjectionBridge } from "./gateway/workspace-projection-bridge.js";
import {
  CanvasV5LocalPersistence,
  shouldSeedLocalCanvas,
  type CanvasV5LoadResult,
  type CanvasV5LocalSnapshot,
  type CanvasV5PersistenceStatus,
} from "./model/canvas-v5-local-persistence.js";
import type { ExcalidrawSceneSnapshot } from "./canvas/excalidraw/excalidrawSceneTypes.js";
import type { CanvasDocument } from "./types/identity.js";
import {
  projectionForConnection,
  workspaceProjectionStatus,
} from "./model/workspace-projection-view.js";
import {
  handleDesktopRecoveryEvent,
  type DesktopConnection,
} from "./model/desktop-recovery.js";

import {
  workbenchNodesFromResources,
  type ProvenanceView,
} from "./model/workbench-nodes.js";
import { seedCanvasDocumentFromGraph } from "./model/canvas-seeding.js";
import { useFocusDocument } from "./model/use-focus-document.js";
import { useCollaborationSurface } from "./model/use-collaboration-surface.js";

function MountedWorkspace(props: {
  bridge: RendererDesktopBridge;
  workspace: DesktopWorkspace;
  connection: "online" | "offline" | "reconnecting";
  recoveryGeneration: number;
  onConnectionChange: (connection: "online" | "offline") => void;
  onRetryConnection: () => void;
}) {
  const {
    bridge,
    workspace,
    connection,
    recoveryGeneration,
    onConnectionChange,
    onRetryConnection,
  } = props;
  const gateway = useMemo(() => createDesktopServiceGateway(bridge), [bridge]);
  const persistence = useMemo(
    () => new CanvasV5LocalPersistence(window.localStorage, workspace.workspaceId),
    [workspace.workspaceId]
  );
  const initialLoad = useMemo(() => persistence.load(), [persistence]);
  const snapshotRef = useRef<CanvasV5LocalSnapshot>(initialLoad.snapshot);
  const [snapshot, setSnapshot] = useState(initialLoad.snapshot);
  const [persistenceStatus, setPersistenceStatus] =
    useState<CanvasV5PersistenceStatus>(initialLoad.status);
  const retrySave = useRef<(() => void) | null>(null);
  const initialLoadRetryPending = useRef("retry" in initialLoad);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadKind = useRef<CanvasV5LoadResult["kind"]>(initialLoad.kind);
  // Only a genuinely empty local record may receive the one-time default
  // placement seed. Corrupt/unavailable storage stays fail-closed and visible;
  // a successful projection must not silently overwrite the recovery evidence.
  const seeded = useRef(
    !shouldSeedLocalCanvas(
      initialLoad.kind,
      snapshot.document.placements.length,
      1
    )
  );
  const requestGeneration = useRef(0);
  const graphRef = useRef<ProjectionResource<GraphProjection>>({ state: "idle" });
  const collaborationRef = useRef<ProjectionResource<NodeCollaborationsResult>>({ state: "idle" });
  const [graphResource, setGraphResource] = useState(graphRef.current);
  const [collaborationResource, setCollaborationResource] = useState(collaborationRef.current);
  const [provenance, setProvenance] = useState<ReadonlyMap<string, ProvenanceView>>(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() =>
    snapshot.document.focusedPlacementId
      ? snapshot.document.placements.find(
          (placement) => placement.placementId === snapshot.document.focusedPlacementId
        )?.entityRef ?? null
      : null
  );
  const selectedNodeRef = useRef(selectedNodeId);
  const lastAuthoritativeDocumentNode = useRef<{
    nodeId: string;
    archived: boolean;
  } | null>(null);
  const publishSelectedNode = useCallback((nodeId: string | null) => {
    selectedNodeRef.current = nodeId;
    setSelectedNodeId(nodeId);
  }, []);
  const provenanceGeneration = useRef(0);
  const seenRecoveryGeneration = useRef(recoveryGeneration);

  function applyLoadRetry(result: CanvasV5LoadResult): void {
    setPersistenceStatus(result.status);
    if (!("retry" in result)) {
      snapshotRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      publishSelectedNode(
        result.snapshot.document.focusedPlacementId
          ? result.snapshot.document.placements.find(
              (placement) =>
                placement.placementId ===
                result.snapshot.document.focusedPlacementId
            )?.entityRef ?? null
          : null
      );
      // A loaded empty document is an intentional user-owned Canvas. A truly
      // absent record remains eligible for the first non-empty graph seed.
      loadKind.current = result.kind;
      seeded.current = result.kind === "loaded";
      initialLoadRetryPending.current = false;
      retrySave.current = null;

      const graph = graphRef.current.state === "ready" ? graphRef.current.value : null;
      if (
        graph &&
        shouldSeedLocalCanvas(
          result.kind,
          result.snapshot.document.placements.length,
          graph.nodes.length
        )
      ) {
        seeded.current = true;
        const document = seedCanvasDocumentFromGraph(graph);
        snapshotRef.current = { ...result.snapshot, document };
        setSnapshot(snapshotRef.current);
        publishSelectedNode(document.placements[0]?.entityRef ?? null);
        scheduleSnapshot({ document });
      }
      return;
    }
    initialLoadRetryPending.current = true;
    retrySave.current = () => applyLoadRetry(result.retry());
  }

  if (
    retrySave.current === null &&
    initialLoadRetryPending.current &&
    "retry" in initialLoad
  ) {
    retrySave.current = () => applyLoadRetry(initialLoad.retry());
  }

  const commitSnapshot = useCallback(() => {
    const result = persistence.beginSave(snapshotRef.current).commit();
    setPersistenceStatus(result.status);
    retrySave.current =
      "retry" in result
        ? () => {
            const retried = result.retry();
            setPersistenceStatus(retried.status);
            retrySave.current = "retry" in retried ? () => setPersistenceStatus(retried.retry().status) : null;
          }
        : null;
  }, [persistence]);

  const scheduleSnapshot = useCallback(
    (patch: Partial<Pick<CanvasV5LocalSnapshot, "document" | "scene">>) => {
      snapshotRef.current = { ...snapshotRef.current, ...patch };
      setSnapshot(snapshotRef.current);
      setPersistenceStatus({
        kind: "pending",
        message: "正在保存本地画布…",
        retryable: false,
      });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(commitSnapshot, 140);
    },
    [commitSnapshot]
  );

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    graphRef.current = beginProjectionLoad(graphRef.current, workspace.workspaceId);
    setGraphResource(graphRef.current);
    const graphRead = await gateway.graphProjection(workspace.workspaceId);
    if (generation !== requestGeneration.current) return;
    graphRef.current = settleProjection(graphRef.current, graphRead);
    setGraphResource(graphRef.current);
    if (!graphRead.ok) {
      if (graphRead.issue.kind === "transport") onConnectionChange("offline");
      return;
    }
    onConnectionChange("online");

    if (
      !seeded.current &&
      shouldSeedLocalCanvas(
        loadKind.current,
        snapshotRef.current.document.placements.length,
        graphRead.value.nodes.length
      )
    ) {
      seeded.current = true;
      const document = seedCanvasDocumentFromGraph(graphRead.value);
      snapshotRef.current = { ...snapshotRef.current, document };
      setSnapshot(snapshotRef.current);
      publishSelectedNode(document.placements[0]?.entityRef ?? null);
      scheduleSnapshot({ document });
    }

    const nodeIds = graphRead.value.nodes.map((node) => node.nodeId);
    collaborationRef.current = beginProjectionLoad(
      collaborationRef.current,
      workspace.workspaceId
    );
    setCollaborationResource(collaborationRef.current);
    const collaborationRead = await gateway.nodeCollaborations(
      workspace.workspaceId,
      nodeIds
    );
    if (generation !== requestGeneration.current) return;
    collaborationRef.current = settleProjection(
      collaborationRef.current,
      collaborationRead
    );
    setCollaborationResource(collaborationRef.current);
    if (!collaborationRead.ok && collaborationRead.issue.kind === "transport") {
      onConnectionChange("offline");
    }

  }, [gateway, onConnectionChange, publishSelectedNode, scheduleSnapshot, workspace.workspaceId]);

  useEffect(() => {
    const current = ++provenanceGeneration.current;
    const graph =
      graphResource.state === "ready" ? graphResource.value : null;
    const selected = graph?.nodes.find((node) => node.nodeId === selectedNodeId);
    if (!selectedNodeId || selected?.type !== "output") {
      setProvenance(new Map());
      return;
    }
    setProvenance(new Map());
    void gateway.outputProvenance(workspace.workspaceId, selectedNodeId).then((read) => {
      if (current !== provenanceGeneration.current) return;
      const view: ProvenanceView = !read.ok
        ? { state: "error", label: "来源状态未知" }
        : {
            state: "ready",
            label: read.value.bound
              ? read.value.incomplete.length
                ? `来源链不完整 · ${read.value.incomplete.join("、")}`
                : "已绑定交付来源"
              : "未绑定交付来源",
          };
      setProvenance(new Map([[selectedNodeId, view]]));
    });
    return () => {
      provenanceGeneration.current += 1;
    };
  }, [gateway, graphResource, selectedNodeId, workspace.workspaceId]);

  useEffect(() => {
    const stopProjectionBridge = startWorkspaceProjectionBridge(
      gateway,
      workspace.workspaceId,
      refresh
    );
    return () => {
      requestGeneration.current += 1;
      stopProjectionBridge();
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        commitSnapshot();
      }
    };
  }, [commitSnapshot, gateway, refresh, workspace.workspaceId]);

  useEffect(() => {
    if (seenRecoveryGeneration.current === recoveryGeneration) return;
    seenRecoveryGeneration.current = recoveryGeneration;
    void refresh();
  }, [recoveryGeneration, refresh]);

  const presentedGraphResource = projectionForConnection(
    graphResource,
    workspace.workspaceId,
    connection
  );
  const presentedCollaborationResource = projectionForConnection(
    collaborationResource,
    workspace.workspaceId,
    connection
  );
  const nodes = workbenchNodesFromResources(
    presentedGraphResource,
    presentedCollaborationResource,
    snapshot.document,
    provenance
  );
  const graph = presentedGraphResource.state === "ready" ? presentedGraphResource.value : null;
  const projectionState = workspaceProjectionStatus(presentedGraphResource, nodes);
  const selectedAuthoritativeNode = graph?.nodes.find((node) => node.nodeId === selectedNodeId) ?? null;
  if (!selectedNodeId) {
    lastAuthoritativeDocumentNode.current = null;
  } else if (selectedAuthoritativeNode) {
    lastAuthoritativeDocumentNode.current = {
      nodeId: selectedAuthoritativeNode.nodeId,
      archived: selectedAuthoritativeNode.archived,
    };
  } else if (lastAuthoritativeDocumentNode.current?.nodeId !== selectedNodeId) {
    // A newly selected local placement is not enough authority to read a Node.
    lastAuthoritativeDocumentNode.current = null;
  }
  const documentNode = lastAuthoritativeDocumentNode.current;
  const focusedDocument = useFocusDocument({
    gateway,
    workspaceId: workspace.workspaceId,
    nodeId: documentNode?.nodeId ?? null,
    archived: documentNode?.archived ?? false,
    online: connection === "online",
  });
  const collaborationSurface = useCollaborationSurface({
    gateway,
    workspaceId: workspace.workspaceId,
    nodeId: documentNode?.nodeId ?? null,
    online: connection === "online",
  });

  return (
    <AppShell
      key={workspace.workspaceId}
      workspaceId={workspace.workspaceId}
      workspaceLabel={workspace.tentName || "产品工作区"}
      initialNodes={nodes}
      document={snapshot.document}
      initialScene={snapshot.scene}
      selectedNodeId={selectedNodeId}
      graph={graph}
      connection={connection}
      projectionState={projectionState}
      onRetryConnection={connection === "offline" || connection === "reconnecting" ? onRetryConnection : undefined}
      persistenceStatus={persistenceStatus}
      focusDocument={focusedDocument.view}
      focusDocumentActions={focusedDocument.actions}
      collaboration={collaborationSurface.view}
      collaborationActions={collaborationSurface.actions}
      onRetryPersistence={retrySave.current ?? undefined}
      onPresentationChange={(update) => {
        const next = update({
          document: snapshotRef.current.document,
          selectedNodeId: selectedNodeRef.current,
        });
        publishSelectedNode(next.selectedNodeId);
        scheduleSnapshot({ document: next.document });
      }}
      onScenePersist={(scene: ExcalidrawSceneSnapshot) => scheduleSnapshot({ scene })}
    />
  );
}

export function ProductionApp() {
  const [bridge] = useState<RendererDesktopBridge | null>(() => {
    try {
      return requireDesktopBridge();
    } catch {
      return null;
    }
  });
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap | null>(null);
  const bootstrapRef = useRef<DesktopBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<DesktopConnection>(
    bridge ? "connecting" : "offline"
  );
  const connectionRef = useRef(connection);
  const [recoveryGeneration, setRecoveryGeneration] = useState(0);
  const generation = useRef(0);

  const updateConnection = useCallback(
    (next: DesktopConnection) => {
      connectionRef.current = next;
      setConnection(next);
    },
    []
  );

  const reloadBootstrap = useCallback(async () => {
    const current = ++generation.current;
    if (!bridge) {
      setBootstrap(null);
      bootstrapRef.current = null;
      setError("Electron preload bridge 不可用");
      updateConnection("offline");
      return;
    }
    if (connectionRef.current === "offline") updateConnection("reconnecting");
    try {
      const normalized = normalizeDesktopBootstrap(await bridge.getState());
      if (current !== generation.current) return;
      const previousWorkspaceId =
        bootstrapRef.current?.foregroundWorkspace?.workspaceId ?? null;
      const wasRecovering =
        connectionRef.current === "offline" ||
        connectionRef.current === "reconnecting";
      bootstrapRef.current = normalized;
      setBootstrap(normalized);
      setError(null);
      updateConnection("online");
      if (
        wasRecovering &&
        previousWorkspaceId &&
        previousWorkspaceId === normalized.foregroundWorkspace?.workspaceId
      ) {
        setRecoveryGeneration((value) => value + 1);
      }
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "桌面服务连接失败");
      updateConnection("offline");
    }
  }, [bridge, updateConnection]);

  useEffect(() => {
    void reloadBootstrap();
    if (!bridge) return;
    const stopState = bridge.onStateChanged(() => void reloadBootstrap());
    const stopRecoveryEvents = bridge.onServiceEvent((event) => {
      void handleDesktopRecoveryEvent(
        event.type,
        updateConnection,
        reloadBootstrap
      );
    });
    return () => {
      stopRecoveryEvents();
      stopState();
    };
  }, [bridge, reloadBootstrap, updateConnection]);

  if (!bootstrap?.foregroundWorkspace) {
    return (
      <AppShell
        workspaceLabel={bootstrap ? "未挂载工作区" : "正在连接本地服务"}
        connection={connection}
        projectionState={bootstrap ? "unmounted" : error ? "error" : "loading"}
        onRetryConnection={connection === "offline" || connection === "reconnecting" ? reloadBootstrap : undefined}
      />
    );
  }
  return (
    <MountedWorkspace
      key={bootstrap.foregroundWorkspace.workspaceId}
      bridge={bridge!}
      workspace={bootstrap.foregroundWorkspace}
      connection={connection === "connecting" ? "reconnecting" : connection}
      recoveryGeneration={recoveryGeneration}
      onConnectionChange={updateConnection}
      onRetryConnection={reloadBootstrap}
    />
  );
}
