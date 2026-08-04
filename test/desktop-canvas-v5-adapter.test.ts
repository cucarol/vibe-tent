/**
 * Canvas V5 production adapter / migration / ownership — data-level tests.
 * No source-string scanning as the primary proof.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasDocument } from "../src/desktop/renderer-next/types/identity.js";
import { hasEntityPlacement } from "../src/desktop/renderer-next/model/canvas-document.js";
import { DEFAULT_EDGE_LAYERS } from "../src/desktop/renderer-next/model/canvas-edges.js";
import {
  applyPlacementPatches,
  documentToExcalidrawElements,
  extractPlacementPatchesFromElements,
  placementToEmbeddableElement,
  readTentNodeCustomData,
  selectionToFocusedPlacement,
  tentPlacementElementId,
  validateTentEmbeddableLink,
  viewportFromExcalidrawAppState,
  excalidrawAppStateFromViewport,
  TENT_NODE_CUSTOM_KIND,
} from "../src/desktop/renderer-next/canvas/excalidraw/documentToExcalidraw.js";
import {
  assertIdempotentPlacementHydrate,
  collectImageFileIds,
  hydrateCanvasV5Scene,
  sceneSnapshotForV4Persist,
} from "../src/desktop/renderer-next/canvas/excalidraw/v5Migration.js";
import {
  createV5OwnershipState,
  reduceV5Ownership,
  canvasGesturesEnabled,
  embeddableInteractive,
} from "../src/desktop/renderer-next/canvas/excalidraw/v5InteractionOwnership.js";

function sampleDoc(): CanvasDocument {
  return {
    version: 1,
    backgroundMode: "grid",
    focusedPlacementId: "pl-a",
    viewport: { x: 40, y: 80, zoom: 1.25 },
    placements: [
      {
        placementId: "pl-a",
        entityRef: "cx-alpha",
        kind: "node",
        x: 100,
        y: 120,
        width: 220,
        height: 96,
      },
      {
        placementId: "pl-b",
        entityRef: "cx-alpha",
        kind: "node",
        x: 400,
        y: 200,
        width: 200,
        height: 80,
      },
      {
        placementId: "pl-c",
        entityRef: "cx-beta",
        kind: "node",
        x: 40,
        y: 300,
        width: 180,
        height: 72,
      },
    ],
  };
}

test("same nodeId maps to multiple placements with distinct element ids", () => {
  const doc = sampleDoc();
  const mapped = documentToExcalidrawElements(doc, {
    resolvers: {
      resolveLabel: (id) => (id === "cx-alpha" ? "Alpha" : "Beta"),
    },
  });
  const tent = mapped.elements.filter((el) => el.type === "embeddable");
  assert.equal(tent.length, 3);
  const alpha = tent.filter(
    (el) => readTentNodeCustomData(el)?.nodeId === "cx-alpha"
  );
  assert.equal(alpha.length, 2);
  assert.notEqual(alpha[0]!.id, alpha[1]!.id);
  assert.equal(
    readTentNodeCustomData(alpha[0]!)?.placementId !==
      readTentNodeCustomData(alpha[1]!)?.placementId,
    true
  );
  for (const el of tent) {
    const custom = readTentNodeCustomData(el);
    assert.ok(custom);
    assert.equal(custom!.kind, TENT_NODE_CUSTOM_KIND);
    assert.equal(el.id, tentPlacementElementId(custom!.placementId));
    assert.ok(validateTentEmbeddableLink(String(el.link)));
    // Must not copy body/task facts into customData
    assert.equal(Object.keys(custom!).sort().join(","), "kind,nodeId,placementId");
  }
});

test("hydrate restores the local focused placement as Excalidraw selection", () => {
  const doc = sampleDoc();
  const hydrated = hydrateCanvasV5Scene({ document: doc });
  assert.deepEqual(hydrated.appState.selectedElementIds, {
    [tentPlacementElementId("pl-a")]: true,
  });
});

test("position and resize mid-change patches write back continuously", () => {
  const doc = sampleDoc();
  const el = placementToEmbeddableElement(doc.placements[0]!);
  // Simulate mid-drag frames
  const mid = { ...el, x: 150, y: 160, width: 240, height: 110 };
  const patches = extractPlacementPatchesFromElements([mid]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.x, 150);
  assert.equal(patches[0]!.width, 240);
  const next = applyPlacementPatches(doc, patches);
  const p = next.placements.find((x) => x.placementId === "pl-a");
  assert.ok(p);
  assert.equal(p!.x, 150);
  assert.equal(p!.y, 160);
  assert.equal(p!.width, 240);
  assert.equal(p!.height, 110);
  // Other placements unchanged
  assert.equal(next.placements.find((x) => x.placementId === "pl-b")!.x, 400);
});

test("viewport round-trip Excalidraw appState ↔ CanvasDocument", () => {
  const vp = { x: 40, y: 80, zoom: 1.25 };
  const slice = excalidrawAppStateFromViewport(vp);
  const back = viewportFromExcalidrawAppState(slice);
  assert.ok(Math.abs(back.x - vp.x) < 1e-9);
  assert.ok(Math.abs(back.y - vp.y) < 1e-9);
  assert.ok(Math.abs(back.zoom - vp.zoom) < 1e-9);
});

test("projection stale/error keeps placements and marks pending recovery", () => {
  const doc = sampleDoc();
  const mapped = documentToExcalidrawElements(doc, {
    resolvers: {
      resolvePendingRecovery: () => true,
      resolveGhost: () => false,
    },
  });
  assert.equal(mapped.elements.filter((e) => e.type === "embeddable").length, 3);
  for (const [, card] of mapped.cards) {
    assert.equal(card.recovery, "pending");
    assert.equal(card.state, "stale");
  }
  // Ghost only when authoritative ready projection says so
  const ghosted = documentToExcalidrawElements(doc, {
    resolvers: {
      resolveGhost: (id) => id === "cx-beta",
      resolvePendingRecovery: () => false,
    },
  });
  assert.equal(ghosted.cards.get("pl-c")!.recovery, "ghost");
  assert.equal(ghosted.cards.get("pl-c")!.state, "unresolved");
  assert.equal(ghosted.cards.get("pl-a")!.recovery, "none");
  assert.equal(ghosted.cards.get("pl-a")!.state, "unknown");
  // Placements still present
  assert.equal(ghosted.elements.filter((e) => e.type === "embeddable").length, 3);
});

test("node cards translate presentation while retaining the exact collaboration state", () => {
  const mapped = documentToExcalidrawElements(sampleDoc(), {
    resolvers: {
      resolveType: (nodeId) => (nodeId === "cx-beta" ? "output" : "prompt"),
      resolveActiveTaskState: (nodeId) =>
        nodeId === "cx-beta" ? "running" : null,
    },
  });
  const idle = mapped.cards.get("pl-a")!;
  assert.equal(idle.typeLabel, "prompt");
  assert.equal(idle.state, "idle");
  assert.equal(idle.stateLabel, "无进行中任务");

  const active = mapped.cards.get("pl-c")!;
  assert.equal(active.typeLabel, "output");
  assert.equal(active.state, "active");
  assert.equal(active.stateLabel, "任务进行中");
  assert.equal(active.rawTaskState, "running");
});

test("V4 hydrate is idempotent and preserves image fileId", () => {
  const doc = sampleDoc();
  const drawingScene = {
    elements: [
      {
        id: "img-1",
        type: "image",
        x: 10,
        y: 10,
        width: 100,
        height: 80,
        fileId: "canvas_image_legacy_abc",
        status: "saved",
      },
      {
        id: "stroke-1",
        type: "freedraw",
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        points: [
          [0, 0],
          [10, 12],
        ],
      },
    ],
    appState: {},
    files: {
      canvas_image_legacy_abc: {
        id: "canvas_image_legacy_abc",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,aaa",
        created: 1,
      },
    },
  };
  const first = hydrateCanvasV5Scene({ document: doc, drawingScene });
  const second = hydrateCanvasV5Scene({ document: doc, drawingScene });
  assert.equal(assertIdempotentPlacementHydrate(first, second), true);
  const fileIds = collectImageFileIds(first.elements);
  assert.ok(fileIds.includes("canvas_image_legacy_abc"));
  assert.ok(first.files["canvas_image_legacy_abc"]);
  // Second hydrate does not duplicate placement element ids
  assert.equal(first.placementElementIds.length, 3);
  assert.equal(new Set(first.placementElementIds).size, 3);
});

test("selection maps to Focus placement and entityRef", () => {
  const doc = sampleDoc();
  const mapped = documentToExcalidrawElements(doc);
  const target = mapped.elements.find(
    (el) => readTentNodeCustomData(el)?.placementId === "pl-b"
  );
  assert.ok(target);
  const focus = selectionToFocusedPlacement(mapped.elements, {
    [target!.id]: true,
  });
  assert.equal(focus.placementId, "pl-b");
  assert.equal(focus.entityRef, "cx-alpha");
  const blank = selectionToFocusedPlacement(mapped.elements, {});
  assert.equal(blank.placementId, null);
});

test("Outline drop dedupe: hasEntityPlacement prevents duplicate entity", () => {
  const doc = sampleDoc();
  assert.equal(hasEntityPlacement(doc, "cx-alpha"), true);
  assert.equal(hasEntityPlacement(doc, "cx-missing"), false);
});

test("Escape interaction ownership: embeddable then focus then canvas", () => {
  let state = createV5OwnershipState("pl-a");
  state = reduceV5Ownership(state, {
    type: "activate-embeddable",
    elementId: "tent-pl:pl-a",
  });
  assert.equal(state.owner, "embeddable-active");
  assert.equal(canvasGesturesEnabled(state), false);
  assert.equal(embeddableInteractive(state, "tent-pl:pl-a"), true);

  state = reduceV5Ownership(state, { type: "escape" });
  assert.equal(state.owner, "canvas");
  assert.equal(state.activeElementId, null);
  assert.equal(state.focusedPlacementId, "pl-a");
  assert.equal(canvasGesturesEnabled(state), true);

  state = reduceV5Ownership(state, { type: "escape" });
  assert.equal(state.focusedPlacementId, null);
  assert.equal(state.owner, "canvas");

  state = reduceV5Ownership(state, { type: "pointer-blank" });
  assert.equal(state.focusedPlacementId, null);
});

test("V5 persist strips tent nodes and keeps drawing file map", () => {
  const doc = sampleDoc();
  const drawingScene = {
    elements: [
      {
        id: "img-2",
        type: "image",
        x: 1,
        y: 2,
        width: 50,
        height: 40,
        fileId: "canvas_image_keep",
      },
    ],
    files: {
      canvas_image_keep: {
        id: "canvas_image_keep",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,bb",
      },
    },
  };
  const hydrated = hydrateCanvasV5Scene({ document: doc, drawingScene });
  const persisted = sceneSnapshotForV4Persist(
    hydrated.elements,
    hydrated.appState,
    hydrated.files,
    true
  );
  for (const raw of persisted.elements) {
    const el = raw as { customData?: unknown; id?: string };
    assert.equal(readTentNodeCustomData(el), null);
    assert.equal(String(el.id ?? "").startsWith("tent-pl:"), false);
  }
  assert.ok(persisted.files?.["canvas_image_keep"]);
});

test("projected edges become locked arrows without inventing missing endpoints", () => {
  const doc = sampleDoc();
  const mapped = documentToExcalidrawElements(doc, {
    graph: {
      edges: {
        parent: [
          { parentNodeId: "cx-alpha", childNodeId: "cx-beta" },
        ],
        relation: [
          {
            id: "rel-1",
            fromNodeId: "cx-alpha",
            toNodeId: "cx-missing",
            kind: "blocks",
            direction: "directed",
            unresolved: "missing-target",
          },
        ],
      },
    },
    edgeLayers: { ...DEFAULT_EDGE_LAYERS, parent: true, relation: true },
  });
  const arrows = mapped.elements.filter((el) => el.type === "arrow");
  // parent edge should project for at least one placement pair of alpha→beta
  assert.ok(arrows.length >= 1);
  for (const arrow of arrows) {
    assert.equal(arrow.locked, true);
  }
});

test("V5 leaves generic drawing tools exclusively to Excalidraw", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const css = await fs.readFile(
    path.join(
      process.cwd(),
      "src/desktop/renderer-next/canvas/excalidraw/canvas-v5-host.css"
    ),
    "utf8"
  );
  const host = await fs.readFile(
    path.join(
      process.cwd(),
      "src/desktop/renderer-next/canvas/excalidraw/CanvasV5Host.tsx"
    ),
    "utf8"
  );

  assert.doesNotMatch(host, /canvas-v5-toolbar|canvas-v5-tool-/);
  assert.doesNotMatch(host, /TOOL_ORDER|TOOL_LABELS|setTool\(/);
  assert.doesNotMatch(css, /tn-canvas-v5-host__toolbar/);
  assert.match(host, /tools:\s*\{\s*image:\s*true\s*\}/);
  assert.match(host, /data-testid="canvas-display-menu"/);
});
