/**
 * X6 graph factory + graph ⇄ CanvasDocument bridge.
 * Domain parent relations are drawn as edges but never rewritten by drag.
 */

import { Graph, type Node } from "@antv/x6";
import { Selection } from "@antv/x6-plugin-selection";
import { Transform } from "@antv/x6-plugin-transform";
import { Snapline } from "@antv/x6-plugin-snapline";
import { Keyboard } from "@antv/x6-plugin-keyboard";
import type {
  CanvasDocument,
  DomainNode,
  ExperimentEdge,
  Placement,
  Viewport,
} from "../model/types.js";

const TYPE_FILL: Record<string, string> = {
  goal: "#e8eef6",
  note: "#f4f2ec",
  prompt: "#efe8f6",
  artifact: "#e8f2ec",
};

const EDGE_STYLE: Record<
  ExperimentEdge["kind"],
  { stroke: string; strokeDasharray?: string; strokeWidth: number }
> = {
  parent: { stroke: "#6b7280", strokeWidth: 1.25 },
  "resolved-link": { stroke: "#3b6ea5", strokeWidth: 1, strokeDasharray: "0" },
  "unresolved-link": {
    stroke: "#b45309",
    strokeWidth: 1,
    strokeDasharray: "4 3",
  },
  "visual-annotation": {
    stroke: "#9ca3af",
    strokeWidth: 1,
    strokeDasharray: "2 3",
  },
};

export type GraphBuildInput = {
  container: HTMLElement;
  document: CanvasDocument;
  domainNodes: DomainNode[];
  edges: ExperimentEdge[];
};

export type BuiltGraph = {
  graph: Graph;
  /** placementId → node cell id (same as placementId) */
  placementCellIds: string[];
};

function registerShapes(): void {
  // Idempotent enough for Vite HMR in practice.
  if ((Graph as unknown as { __tentShapes?: boolean }).__tentShapes) return;
  (Graph as unknown as { __tentShapes?: boolean }).__tentShapes = true;

  Graph.registerNode(
    "tent-entity",
    {
      inherit: "rect",
      markup: [
        { tagName: "rect", selector: "body" },
        { tagName: "text", selector: "label" },
        { tagName: "text", selector: "sublabel" },
      ],
      attrs: {
        body: {
          stroke: "#94a3b8",
          strokeWidth: 1,
          rx: 6,
          ry: 6,
          fill: "#f8fafc",
        },
        label: {
          fill: "#1e293b",
          fontSize: 12,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textAnchor: "middle",
          textVerticalAnchor: "middle",
          refY: 0.38,
        },
        sublabel: {
          fill: "#64748b",
          fontSize: 10,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textAnchor: "middle",
          textVerticalAnchor: "middle",
          refY: 0.72,
        },
      },
    },
    true
  );

  Graph.registerNode(
    "tent-group",
    {
      inherit: "rect",
      attrs: {
        body: {
          fill: "rgba(148, 163, 184, 0.08)",
          stroke: "#cbd5e1",
          strokeWidth: 1,
          strokeDasharray: "6 4",
          rx: 8,
          ry: 8,
        },
        label: {
          fill: "#64748b",
          fontSize: 11,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          refX: 10,
          refY: 10,
          textAnchor: "start",
          textVerticalAnchor: "top",
        },
      },
    },
    true
  );

  Graph.registerNode(
    "tent-annotation",
    {
      inherit: "rect",
      attrs: {
        body: {
          fill: "#fffbeb",
          stroke: "#d6d3d1",
          strokeWidth: 1,
          rx: 4,
          ry: 4,
        },
        label: {
          fill: "#57534e",
          fontSize: 11,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textWrap: { width: -12, height: -12, ellipsis: true },
        },
      },
    },
    true
  );
}

export function createWorkingSetGraph(input: GraphBuildInput): BuiltGraph {
  registerShapes();
  const { container, document: doc, domainNodes, edges } = input;
  const byEntity = new Map(domainNodes.map((n) => [n.entityRef, n]));

  const graph = new Graph({
    container,
    autoResize: true,
    background: { color: "#f7f6f3" },
    grid: {
      visible: true,
      type: "dot",
      args: { color: "#d6d3d1", thickness: 1 },
      size: 16,
    },
    panning: {
      enabled: true,
      eventTypes: ["leftMouseDown", "mouseWheel"],
    },
    mousewheel: {
      enabled: true,
      modifiers: ["ctrl", "meta"],
      factor: 1.08,
      maxScale: 2.5,
      minScale: 0.15,
    },
    // No interactive edge creation in this spike — domain edges are data-driven.
    connecting: {
      allowBlank: false,
      allowLoop: false,
      allowNode: false,
      allowEdge: false,
      allowPort: false,
      allowMulti: false,
    },
    interacting: {
      nodeMovable: true,
      edgeMovable: false,
      edgeLabelMovable: false,
      arrowheadMovable: false,
      vertexMovable: false,
      vertexAddable: false,
      vertexDeletable: false,
    },
  });

  graph.use(
    new Selection({
      enabled: true,
      multiple: true,
      rubberband: true,
      rubberEdge: false,
      rubberNode: true,
      modifiers: ["shift"],
      showNodeSelectionBox: true,
      pointerEvents: "none",
    })
  );

  graph.use(
    new Transform({
      resizing: {
        enabled: true,
        minWidth: 120,
        minHeight: 48,
        maxWidth: 480,
        maxHeight: 240,
        orthogonal: false,
        restrict: false,
        preserveAspectRatio: false,
      },
      rotating: false,
    })
  );

  graph.use(
    new Snapline({
      enabled: true,
      sharp: true,
    })
  );

  graph.use(
    new Keyboard({
      enabled: true,
      global: true,
    })
  );

  // Visual groups first (behind entities).
  for (const g of doc.visualGroups) {
    graph.addNode({
      id: g.id,
      shape: "tent-group",
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      label: g.label,
      zIndex: 0,
      data: { kind: "visual-group", visualGroupId: g.id },
    });
  }

  for (const a of doc.annotations) {
    graph.addNode({
      id: a.id,
      shape: "tent-annotation",
      x: a.x,
      y: a.y,
      width: a.width,
      height: a.height,
      label: a.text,
      zIndex: 1,
      data: { kind: "visual-annotation", annotationId: a.id },
    });
  }

  const placementCellIds: string[] = [];
  for (const p of doc.placements) {
    const domain = byEntity.get(p.entityRef);
    const fill = TYPE_FILL[domain?.type ?? "note"] ?? "#f8fafc";
    const title = domain?.title ?? p.entityRef;
    const sub = `${domain?.type ?? "?"} · ${p.entityRef}`;
    graph.addNode({
      id: p.placementId,
      shape: "tent-entity",
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      zIndex: 2,
      attrs: {
        body: { fill },
        label: { text: truncate(title, 28) },
        sublabel: { text: truncate(sub, 32) },
      },
      data: {
        kind: "entity-placement",
        placementId: p.placementId,
        entityRef: p.entityRef,
        /** Snapshot of domain parent for invariant checks — never mutated by drag. */
        parentEntityRef: domain?.parentEntityRef ?? null,
      },
    });
    placementCellIds.push(p.placementId);
  }

  // Domain edges use entityRef endpoints → resolve to placement cell ids.
  const placementByEntity = new Map(
    doc.placements.map((p) => [p.entityRef, p.placementId])
  );

  for (const e of edges) {
    const style = EDGE_STYLE[e.kind];
    let sourceId: string | undefined;
    let targetId: string | undefined;

    if (e.kind === "visual-annotation") {
      sourceId = e.source;
      targetId = e.target;
    } else if (e.kind === "unresolved-link") {
      sourceId = placementByEntity.get(e.source);
      // Dangling: attach a tiny phantom marker near source if needed — skip edge
      // when target placement missing; still count in model.
      if (!sourceId) continue;
      // Create ephemeral ghost target for visibility.
      const ghostId = `ghost-${e.id}`;
      if (!graph.getCellById(ghostId)) {
        const srcNode = graph.getCellById(sourceId) as Node | null;
        const pos = srcNode?.getPosition() ?? { x: 0, y: 0 };
        graph.addNode({
          id: ghostId,
          shape: "rect",
          x: pos.x + 220,
          y: pos.y - 30,
          width: 10,
          height: 10,
          attrs: {
            body: {
              fill: "#fef3c7",
              stroke: "#b45309",
              strokeWidth: 1,
              rx: 2,
              ry: 2,
            },
          },
          zIndex: 1,
          data: { kind: "unresolved-ghost", edgeId: e.id, targetRef: e.target },
        });
      }
      targetId = ghostId;
    } else {
      sourceId = placementByEntity.get(e.source);
      targetId = placementByEntity.get(e.target);
    }

    if (!sourceId || !targetId) continue;
    if (!graph.getCellById(sourceId) || !graph.getCellById(targetId)) continue;

    graph.addEdge({
      id: e.id,
      source: sourceId,
      target: targetId,
      router: e.kind === "parent" ? "orth" : "normal",
      connector: e.kind === "parent" ? "rounded" : "smooth",
      attrs: {
        line: {
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          strokeDasharray: style.strokeDasharray,
          targetMarker:
            e.kind === "parent"
              ? null
              : {
                  name: "classic",
                  size: 6,
                },
        },
      },
      labels: e.label
        ? [
            {
              attrs: {
                label: {
                  text: e.label,
                  fill: "#78716c",
                  fontSize: 9,
                },
              },
            },
          ]
        : [],
      zIndex: 1,
      data: {
        kind: "experiment-edge",
        edgeKind: e.kind,
        /** Explicit: not Core schema */
        notCoreSchema: true,
      },
    });
  }

  // Restore viewport
  applyViewport(graph, doc.viewport);

  return { graph, placementCellIds };
}

export function applyViewport(graph: Graph, viewport: Viewport): void {
  graph.zoomTo(viewport.zoom);
  graph.translate(viewport.x, viewport.y);
}

export function readViewport(graph: Graph): Viewport {
  const t = graph.translate();
  return {
    x: t.tx,
    y: t.ty,
    zoom: graph.zoom(),
  };
}

export function readPlacementFromNode(node: Node): Placement | null {
  const data = node.getData() as { kind?: string; placementId?: string; entityRef?: string };
  if (data?.kind !== "entity-placement" || !data.placementId || !data.entityRef) {
    return null;
  }
  const pos = node.getPosition();
  const size = node.getSize();
  return {
    placementId: data.placementId,
    entityRef: data.entityRef,
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
  };
}

export function syncDocumentFromGraph(
  graph: Graph,
  base: CanvasDocument
): CanvasDocument {
  const placements: Placement[] = [];
  for (const p of base.placements) {
    const cell = graph.getCellById(p.placementId) as Node | null;
    if (!cell || !cell.isNode()) {
      placements.push({ ...p });
      continue;
    }
    const pos = cell.getPosition();
    const size = cell.getSize();
    placements.push({
      ...p,
      x: pos.x,
      y: pos.y,
      width: size.width,
      height: size.height,
    });
  }

  const visualGroups = base.visualGroups.map((g) => {
    const cell = graph.getCellById(g.id) as Node | null;
    if (!cell || !cell.isNode()) return { ...g };
    const pos = cell.getPosition();
    const size = cell.getSize();
    return { ...g, x: pos.x, y: pos.y, width: size.width, height: size.height };
  });

  const annotations = base.annotations.map((a) => {
    const cell = graph.getCellById(a.id) as Node | null;
    if (!cell || !cell.isNode()) return { ...a };
    const pos = cell.getPosition();
    const size = cell.getSize();
    return { ...a, x: pos.x, y: pos.y, width: size.width, height: size.height };
  });

  return {
    version: 1,
    viewport: readViewport(graph),
    placements,
    visualGroups,
    annotations,
  };
}

/** Assert drag did not mutate domain parent fields stored on node data. */
export function collectParentEntityRefs(graph: Graph): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const cell of graph.getNodes()) {
    const data = cell.getData() as {
      kind?: string;
      entityRef?: string;
      parentEntityRef?: string | null;
    };
    if (data?.kind === "entity-placement" && data.entityRef) {
      map.set(data.entityRef, data.parentEntityRef ?? null);
    }
  }
  return map;
}

export function focusPlacement(graph: Graph, placementId: string): void {
  const cell = graph.getCellById(placementId);
  if (!cell || !cell.isNode()) return;
  graph.cleanSelection();
  graph.select(cell);
  graph.centerCell(cell);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
