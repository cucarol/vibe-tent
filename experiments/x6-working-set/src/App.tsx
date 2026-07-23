import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph, Node } from "@antv/x6";
import {
  collectParentEntityRefs,
  createWorkingSetGraph,
  focusPlacement,
  readPlacementFromNode,
  readViewport,
  syncDocumentFromGraph,
} from "./canvas/x6Graph.js";
import { cloneDocument } from "./model/canvasDocument.js";
import {
  buildSyntheticWorkingSet,
  countEdgeKinds,
} from "./model/syntheticGraph.js";
import type {
  CanvasDocument,
  DomainNode,
  EntityRef,
  IntentRecord,
  LayoutCommand,
  PlacementId,
  Viewport,
  WorkingSetSnapshot,
} from "./model/types.js";
import { EDGE_KIND_NOTE } from "./model/types.js";
import {
  countDomUnder,
  formatScaleReport,
  measureSync,
  nowMs,
  readHeapUsedMb,
  type ScaleSnapshot,
} from "./metrics/perf.js";
import {
  canRedo,
  canUndo,
  createLayoutHistory,
  pushLayoutCommand,
  redoLayout,
  undoLayout,
  type LayoutHistoryState,
} from "./state/layoutHistory.js";
import {
  closeFocus,
  createFocusDraftStore,
  getActiveDraft,
  openFocus,
  setFocusExpanded,
  updateActiveDraft,
  type FocusDraftStore,
} from "./state/focusDrafts.js";
import { makeIntent, pushIntent } from "./state/intentLog.js";
import { FocusWorkspace } from "./ui/FocusWorkspace.js";
import { IntentRail } from "./ui/IntentRail.js";
import { OutlineDrawer } from "./ui/OutlineDrawer.js";

type FocusRestore = {
  viewport: Viewport;
  selection: PlacementId[];
};

export function App() {
  const snapshot = useMemo(() => buildSyntheticWorkingSet({ seed: 7 }), []);
  const domainByRef = useMemo(() => {
    const m = new Map<string, DomainNode>();
    for (const n of snapshot.domainNodes) m.set(n.entityRef, n);
    return m;
  }, [snapshot]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const parentSnapshotRef = useRef<Map<string, string | null>>(new Map());
  const dragBeforeRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const resizeBeforeRef = useRef<
    Map<string, { x: number; y: number; width: number; height: number }>
  >(new Map());
  const historyRef = useRef<LayoutHistoryState>(
    createLayoutHistory(snapshot.document)
  );
  const focusRestoreRef = useRef<FocusRestore | null>(null);
  const openFocusRef = useRef<(entityRef: EntityRef, placementId?: string) => void>(
    () => undefined
  );

  const [historyTick, setHistoryTick] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineFilter, setOutlineFilter] = useState("");
  const [focusStore, setFocusStore] = useState<FocusDraftStore>(() =>
    createFocusDraftStore()
  );
  const [intents, setIntents] = useState<IntentRecord[]>([]);
  const [selection, setSelection] = useState<PlacementId[]>([]);
  const [metrics, setMetrics] = useState<ScaleSnapshot | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [statusLine, setStatusLine] = useState("boot");
  const [parentInvariantOk, setParentInvariantOk] = useState(true);

  const bumpHistory = useCallback(() => setHistoryTick((n) => n + 1), []);

  const recordIntent = useCallback(
    (category: IntentRecord["category"], label: string) => {
      setIntents((prev) => pushIntent(prev, makeIntent(category, label)));
    },
    []
  );

  const applyLayout = useCallback(
    (cmd: LayoutCommand, label: string) => {
      historyRef.current = pushLayoutCommand(historyRef.current, cmd);
      bumpHistory();
      recordIntent("layout", label);
    },
    [bumpHistory, recordIntent]
  );

  const rebuildMetrics = useCallback(
    (firstRenderMs?: number, interactionMs?: number) => {
      const graph = graphRef.current;
      const host = hostRef.current;
      const doc = historyRef.current.document;
      const snap: ScaleSnapshot = {
        domainNodeCount: snapshot.domainNodes.length,
        placementCount: doc.placements.length,
        edgeCount: snapshot.edges.length,
        cellCount: graph?.getCells().length,
        domNodeCount: countDomUnder(host),
        heapUsedMb: readHeapUsedMb(),
        firstRenderMs,
        lastInteractionMs: interactionMs,
      };
      setMetrics(snap);
    },
    [snapshot]
  );

  // Mount X6 graph once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const t0 = nowMs();
    const { result: built, sample } = measureSync("first-render-build", () =>
      createWorkingSetGraph({
        container: host,
        document: historyRef.current.document,
        domainNodes: snapshot.domainNodes,
        edges: snapshot.edges,
      })
    );
    const graph = built.graph;
    graphRef.current = graph;
    parentSnapshotRef.current = collectParentEntityRefs(graph);

    const firstMs = nowMs() - t0;
    setStatusLine(
      `nodes=${snapshot.domainNodes.length} edges=${snapshot.edges.length} firstRender=${firstMs.toFixed(1)}ms (build ${sample.ms.toFixed(1)}ms)`
    );
    rebuildMetrics(firstMs);

    const onNodeMouseDown = ({ node }: { node: Node }) => {
      const p = readPlacementFromNode(node);
      if (!p) return;
      dragBeforeRef.current.set(p.placementId, { x: p.x, y: p.y });
      resizeBeforeRef.current.set(p.placementId, {
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
      });
    };

    const onNodeMoved = ({ node }: { node: Node }) => {
      const t0i = nowMs();
      const p = readPlacementFromNode(node);
      if (!p) return;
      const before = dragBeforeRef.current.get(p.placementId);
      if (!before) return;
      if (before.x === p.x && before.y === p.y) return;

      // Update layout history (placement only).
      applyLayout(
        {
          type: "move",
          placementId: p.placementId,
          before,
          after: { x: p.x, y: p.y },
        },
        `move ${p.placementId}`
      );
      // Keep history document in sync with full graph geometry + viewport.
      historyRef.current = {
        ...historyRef.current,
        document: syncDocumentFromGraph(graph, historyRef.current.document),
      };

      // Parent invariant: domain parent map must be unchanged.
      const afterParents = collectParentEntityRefs(graph);
      let ok = true;
      for (const [entityRef, parent] of parentSnapshotRef.current) {
        if (afterParents.get(entityRef) !== parent) {
          ok = false;
          break;
        }
      }
      // Also ensure domainNodes parent fields never mutated (reference equality of map values).
      for (const n of snapshot.domainNodes) {
        if (afterParents.get(n.entityRef) !== n.parentEntityRef) ok = false;
      }
      setParentInvariantOk(ok);
      if (!ok) recordIntent("domain", "INVARIANT FAIL: parent changed on drag");

      rebuildMetrics(undefined, nowMs() - t0i);
    };

    const onNodeResized = ({ node }: { node: Node }) => {
      const p = readPlacementFromNode(node);
      if (!p) return;
      const prev =
        resizeBeforeRef.current.get(p.placementId) ??
        historyRef.current.document.placements.find(
          (x) => x.placementId === p.placementId
        );
      if (!prev) return;
      if (
        prev.x === p.x &&
        prev.y === p.y &&
        prev.width === p.width &&
        prev.height === p.height
      ) {
        return;
      }
      applyLayout(
        {
          type: "resize",
          placementId: p.placementId,
          before: {
            x: prev.x,
            y: prev.y,
            width: prev.width,
            height: prev.height,
          },
          after: {
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
          },
        },
        `resize ${p.placementId}`
      );
      historyRef.current = {
        ...historyRef.current,
        document: syncDocumentFromGraph(graph, historyRef.current.document),
      };
      resizeBeforeRef.current.set(p.placementId, {
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
      });
    };

    const onSelection = () => {
      const ids = graph
        .getSelectedCells()
        .filter((c) => c.isNode())
        .map((c) => c.id)
        .filter((id) =>
          historyRef.current.document.placements.some((p) => p.placementId === id)
        );
      setSelection(ids);
    };

    const onScale = () => {
      // Viewport changes are navigation; optional layout undo for explicit restore only.
      historyRef.current = {
        ...historyRef.current,
        document: {
          ...historyRef.current.document,
          viewport: readViewport(graph),
        },
      };
    };

    graph.on("node:mousedown", onNodeMouseDown);
    graph.on("node:moved", onNodeMoved);
    graph.on("node:resized", onNodeResized);
    graph.on("selection:changed", onSelection);
    graph.on("scale", onScale);
    graph.on("translate", onScale);

    graph.on("node:dblclick", ({ node }) => {
      const data = node.getData() as {
        kind?: string;
        entityRef?: string;
        placementId?: string;
      };
      if (data?.kind !== "entity-placement" || !data.entityRef) return;
      openFocusRef.current(data.entityRef, data.placementId);
    });

    return () => {
      graph.off("node:mousedown", onNodeMouseDown);
      graph.off("node:moved", onNodeMoved);
      graph.off("node:resized", onNodeResized);
      graph.off("selection:changed", onSelection);
      graph.off("scale", onScale);
      graph.off("translate", onScale);
      graph.dispose();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const openFocusForEntity = useCallback(
    (entityRef: EntityRef, placementId?: string) => {
      const node = domainByRef.get(entityRef);
      if (!node) return;
      const graph = graphRef.current;
      if (graph && !focusRestoreRef.current) {
        focusRestoreRef.current = {
          viewport: readViewport(graph),
          selection: graph
            .getSelectedCells()
            .filter((c) => c.isNode())
            .map((c) => c.id),
        };
      }
      setFocusStore((s) => openFocus(s, node, { expand: s.expanded }));
      recordIntent("focus", `open focus ${entityRef}`);
      if (graph && placementId) {
        graph.cleanSelection();
        const cell = graph.getCellById(placementId);
        if (cell) graph.select(cell);
      }
    },
    [domainByRef, recordIntent]
  );

  openFocusRef.current = openFocusForEntity;

  const handleCloseFocus = useCallback(() => {
    const graph = graphRef.current;
    const restore = focusRestoreRef.current;
    setFocusStore((s) => closeFocus(s));
    recordIntent("focus", "close focus · restore viewport/selection");
    if (graph && restore) {
      graph.zoomTo(restore.viewport.zoom);
      graph.translate(restore.viewport.x, restore.viewport.y);
      graph.cleanSelection();
      for (const id of restore.selection) {
        const cell = graph.getCellById(id);
        if (cell) graph.select(cell);
      }
      focusRestoreRef.current = null;
    }
  }, [recordIntent]);

  const handleLocate = useCallback(
    (entityRef: EntityRef) => {
      const graph = graphRef.current;
      const placement = historyRef.current.document.placements.find(
        (p) => p.entityRef === entityRef
      );
      if (!graph || !placement) return;
      focusPlacement(graph, placement.placementId);
      recordIntent("navigation", `outline locate ${entityRef}`);
      setSelection([placement.placementId]);
    },
    [recordIntent]
  );

  const handleUndo = useCallback(() => {
    const graph = graphRef.current;
    const next = undoLayout(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    bumpHistory();
    recordIntent("layout", "undo layout");
    // Re-apply geometry onto graph cells without full rebuild.
    if (graph) applyDocumentToGraph(graph, next.document);
  }, [bumpHistory, recordIntent]);

  const handleRedo = useCallback(() => {
    const graph = graphRef.current;
    const next = redoLayout(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    bumpHistory();
    recordIntent("layout", "redo layout");
    if (graph) applyDocumentToGraph(graph, next.document);
  }, [bumpHistory, recordIntent]);

  const handleGroupSelection = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || selection.length === 0) return;
    const groupId = `vg-user-${Date.now().toString(36)}`;
    const cells = selection
      .map((id) => graph.getCellById(id))
      .filter((c): c is Node => !!c && c.isNode());
    if (cells.length === 0) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const c of cells) {
      const pos = c.getPosition();
      const size = c.getSize();
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + size.width);
      maxY = Math.max(maxY, pos.y + size.height);
    }
    const pad = 24;
    graph.addNode({
      id: groupId,
      shape: "tent-group",
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
      label: "用户视觉分组",
      zIndex: 0,
      data: { kind: "visual-group", visualGroupId: groupId },
    });
    const beforeGroupId = historyRef.current.document.placements.find(
      (p) => p.placementId === selection[0]
    )?.visualGroupId;
    applyLayout(
      {
        type: "group-assign",
        placementIds: selection,
        beforeGroupId,
        afterGroupId: groupId,
      },
      `visual group ${selection.length} nodes`
    );
    historyRef.current = {
      ...historyRef.current,
      document: {
        ...historyRef.current.document,
        visualGroups: [
          ...historyRef.current.document.visualGroups,
          {
            id: groupId,
            label: "用户视觉分组",
            x: minX - pad,
            y: minY - pad,
            width: maxX - minX + pad * 2,
            height: maxY - minY + pad * 2,
          },
        ],
      },
    };
  }, [applyLayout, selection]);

  const handleRestoreViewport = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const before = readViewport(graph);
    const after = snapshot.document.viewport;
    graph.zoomTo(after.zoom);
    graph.translate(after.x, after.y);
    applyLayout({ type: "viewport", before, after }, "viewport restore");
  }, [applyLayout, snapshot.document.viewport]);

  const edgeKinds = useMemo(() => countEdgeKinds(snapshot.edges), [snapshot.edges]);
  const hist = historyRef.current;
  void historyTick;

  const activeDraft = getActiveDraft(focusStore);

  return (
    <div className="app">
      <header className="topbar">
        <h1>X6 Working-set Spike</h1>
        <span className="meta">
          entityRef ≠ placementId · CanvasDocument 仅 viewport/placements/visual
        </span>
        <div className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOutlineOpen((v) => !v);
            recordIntent("navigation", outlineOpen ? "outline close" : "outline open");
          }}
        >
          Outline
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canUndo(hist)}
          onClick={handleUndo}
        >
          Undo
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canRedo(hist)}
          onClick={handleRedo}
        >
          Redo
        </button>
        <button
          type="button"
          className="btn"
          disabled={selection.length === 0}
          onClick={handleGroupSelection}
        >
          Group
        </button>
        <button type="button" className="btn" onClick={handleRestoreViewport}>
          Restore VP
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            rebuildMetrics();
            setShowMetrics((v) => !v);
          }}
        >
          Metrics
        </button>
      </header>

      <main className="stage">
        <div className="banner">
          pan · wheel+ctrl zoom · drag · shift 框选 · resize · dblclick Focus ·{" "}
          {EDGE_KIND_NOTE}
        </div>
        <div className="canvas-host" ref={hostRef} />

        <OutlineDrawer
          open={outlineOpen}
          nodes={snapshot.domainNodes}
          filter={outlineFilter}
          activeEntityRef={focusStore.activeEntityRef}
          onFilter={setOutlineFilter}
          onClose={() => setOutlineOpen(false)}
          onLocate={handleLocate}
        />

        <FocusWorkspace
          draft={activeDraft}
          expanded={focusStore.expanded}
          onExpand={(v) => {
            setFocusStore((s) => setFocusExpanded(s, v));
            recordIntent("focus", v ? "expand markdown" : "collapse sheet");
          }}
          onChange={(patch) => {
            setFocusStore((s) => updateActiveDraft(s, patch));
            recordIntent("domain", "edit focus draft (local only)");
          }}
          onClose={handleCloseFocus}
          onDomainIntent={(label) => recordIntent("domain", label)}
          onLifecycleIntent={(label) => recordIntent("lifecycle", label)}
        />

        <IntentRail intents={intents} />

        {showMetrics && metrics && (
          <div className="metrics-popover" aria-label="metrics">
            {formatScaleReport(metrics)}
            {"\n"}
            edges: parent={edgeKinds.parent} resolved={edgeKinds["resolved-link"]}{" "}
            unresolved={edgeKinds["unresolved-link"]} visual=
            {edgeKinds["visual-annotation"]}
            {"\n"}
            parentInvariant: {parentInvariantOk ? "ok" : "FAIL"}
          </div>
        )}
      </main>

      <footer className="status">
        <span>
          <strong>{snapshot.domainNodes.length}</strong> entities
        </span>
        <span>
          <strong>{hist.document.placements.length}</strong> placements
        </span>
        <span>
          edges p/r/u/v {edgeKinds.parent}/{edgeKinds["resolved-link"]}/
          {edgeKinds["unresolved-link"]}/{edgeKinds["visual-annotation"]}
        </span>
        <span>sel {selection.length}</span>
        <span>parent drag {parentInvariantOk ? "safe" : "BROKEN"}</span>
        <span>{statusLine}</span>
      </footer>
    </div>
  );
}

function applyDocumentToGraph(graph: Graph, doc: CanvasDocument): void {
  for (const p of doc.placements) {
    const cell = graph.getCellById(p.placementId);
    if (!cell || !cell.isNode()) continue;
    cell.setPosition(p.x, p.y);
    cell.setSize(p.width, p.height);
  }
  for (const g of doc.visualGroups) {
    const cell = graph.getCellById(g.id);
    if (!cell || !cell.isNode()) continue;
    cell.setPosition(g.x, g.y);
    cell.setSize(g.width, g.height);
  }
  for (const a of doc.annotations) {
    const cell = graph.getCellById(a.id);
    if (!cell || !cell.isNode()) continue;
    cell.setPosition(a.x, a.y);
    cell.setSize(a.width, a.height);
  }
  graph.zoomTo(doc.viewport.zoom);
  graph.translate(doc.viewport.x, doc.viewport.y);
}

// Exported for tests that want the same synthetic fixture.
export function getSpikeSnapshot(): WorkingSetSnapshot {
  return buildSyntheticWorkingSet({ seed: 7 });
}

void cloneDocument;
