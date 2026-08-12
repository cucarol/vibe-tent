import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GraphProjection,
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
import {
  reconcileLoadedCanvasDocument,
  seedCanvasDocumentFromGraph,
} from "./model/canvas-seeding.js";
import { useFocusDocument } from "./model/use-focus-document.js";
import { useCollaborationSurface } from "./model/use-collaboration-surface.js";
import { materializeMissingCanvasNodeSnapshots } from "./model/canvas-node-snapshot.js";
import { createCanvasSyncCommand } from "./gateway/canvas-sync-command.js";

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
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const mountedWorkspaceIdRef = useRef<string | null>(workspace.workspaceId);
  const [graphResource, setGraphResource] = useState(graphRef.current);
  const [provenance, setProvenance] = useState<ReadonlyMap<string, ProvenanceView>>(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() =>
    snapshot.document.focusedPlacementId
      ? snapshot.document.placements.find(
          (placement) => placement.placementId === snapshot.document.focusedPlacementId
        )?.entityRef ?? null
      : null
  );
  const previewReadGeneration = useRef(0);
  const [canvasPreviewDocument, setCanvasPreviewDocument] = useState<{
    nodeId: string;
    status: "loading" | "ready" | "error";
    body?: string;
  } | null>(null);
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
      const graph =
        graphRef.current.state === "ready" ? graphRef.current.value : null;
      const reconciled = reconcileLoadedCanvasDocument(
        result.kind,
        result.snapshot.document,
        graph
      );
      snapshotRef.current = {
        ...result.snapshot,
        document: reconciled.document,
      };
      setSnapshot(snapshotRef.current);
      publishSelectedNode(
        reconciled.document.focusedPlacementId
          ? reconciled.document.placements.find(
              (placement) =>
                placement.placementId ===
                reconciled.document.focusedPlacementId
            )?.entityRef ?? null
          : null
      );
      // A loaded empty document is an intentional user-owned Canvas. A truly
      // absent record remains eligible for the first non-empty graph seed.
      loadKind.current = result.kind;
      seeded.current = reconciled.seeded;
      initialLoadRetryPending.current = false;
      retrySave.current = null;
      if (reconciled.changed) {
        scheduleSnapshot({ document: reconciled.document });
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
    const attempt = () => {
      const result = persistence.beginSave(snapshotRef.current).commit();
      setPersistenceStatus(result.status);
      retrySave.current = "retry" in result ? attempt : null;
    };
    attempt();
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

    const materialized = materializeMissingCanvasNodeSnapshots(
      snapshotRef.current.document,
      graphRead.value.nodes
    );
    if (materialized.changed) {
      scheduleSnapshot({ document: materialized.document });
    }

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
  const nodes = workbenchNodesFromResources(
    presentedGraphResource,
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
  const canvasSyncCommand = useMemo(
    () => createCanvasSyncCommand({
      workspaceId: workspace.workspaceId,
      currentWorkspaceId: () => mountedWorkspaceIdRef.current,
      online: () => connectionRef.current === "online",
      readGraphProjection: (workspaceId) => gateway.graphProjection(workspaceId),
      currentSnapshot: () => snapshotRef.current,
      persistence,
    }),
    [gateway, persistence, workspace.workspaceId]
  );
  const commitCanvasSync = useCallback(
    async (expectedDigest: string): Promise<CanvasDocument | null> => {
      const result = await canvasSyncCommand.execute(expectedDigest);
      if (result.status) setPersistenceStatus(result.status);
      if (!result.committed) {
        // The sync transaction is deliberately not published until durable
        // local persistence succeeds. The pending diff therefore remains.
        retrySave.current = null;
        return null;
      }
      retrySave.current = null;
      return result.document;
    },
    [canvasSyncCommand]
  );

  useEffect(() => {
    mountedWorkspaceIdRef.current = workspace.workspaceId;
    return () => {
      mountedWorkspaceIdRef.current = null;
    };
  }, [workspace.workspaceId]);
  const requestCanvasPreview = useCallback((nodeId: string | null) => {
    const generation = ++previewReadGeneration.current;
    if (!nodeId) {
      setCanvasPreviewDocument(null);
      return;
    }
    const graph = graphRef.current;
    if (
      connectionRef.current !== "online" ||
      graph.state !== "ready" ||
      graph.workspaceId !== workspace.workspaceId ||
      !graph.value.nodes.some((node) => node.nodeId === nodeId)
    ) {
      setCanvasPreviewDocument({ nodeId, status: "error" });
      return;
    }
    setCanvasPreviewDocument({ nodeId, status: "loading" });
    void gateway.focusDocument(workspace.workspaceId, nodeId).then((result) => {
      if (generation !== previewReadGeneration.current) return;
      setCanvasPreviewDocument(result.ok
        ? { nodeId, status: "ready", body: result.value.body }
        : { nodeId, status: "error" });
    });
  }, [gateway, workspace.workspaceId]);

  useEffect(() => {
    if (connection === "online") return;
    previewReadGeneration.current += 1;
    setCanvasPreviewDocument((current) => current
      ? { nodeId: current.nodeId, status: "error" }
      : null);
  }, [connection]);

  useEffect(() => gateway.onInvalidation((hint) => {
    if (hint.event?.workspaceId && hint.event.workspaceId !== workspace.workspaceId) return;
    if (
      !hint.keys.includes("*") &&
      !hint.keys.includes("docs.focus") &&
      !hint.keys.includes("docs.get")
    ) return;
    previewReadGeneration.current += 1;
    setCanvasPreviewDocument((current) => current
      ? { nodeId: current.nodeId, status: "error" }
      : null);
  }), [gateway, workspace.workspaceId]);

  useEffect(() => () => {
    previewReadGeneration.current += 1;
  }, []);

  return (
    <AppShell
      key={workspace.workspaceId}
      workspaceId={workspace.workspaceId}
      workspaceLabel={workspace.tentName || "产品工作区"}
      initialNodes={nodes}
      document={snapshot.document}
      initialScene={snapshot.scene}
      selectedNodeId={selectedNodeId}
      connection={connection}
      projectionState={projectionState}
      onRetryConnection={connection === "offline" || connection === "reconnecting" ? onRetryConnection : undefined}
      persistenceStatus={persistenceStatus}
      focusDocument={focusedDocument.view}
      canvasPreviewDocument={canvasPreviewDocument}
      onCanvasPreviewNode={requestCanvasPreview}
      focusDocumentActions={focusedDocument.actions}
      collaboration={collaborationSurface.view}
      collaborationActions={collaborationSurface.actions}
      onCanvasSync={commitCanvasSync}
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
