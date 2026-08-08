/**
 * Canvas V5 production adapter / migration / ownership — data-level tests.
 * No source-string scanning as the primary proof.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasDocument } from "../src/desktop/renderer-next/types/identity.js";
import { dropNodeSnapshotAt, hasEntityPlacement, NODE_CARD } from "../src/desktop/renderer-next/model/canvas-document.js";
import {
  captureCanvasNodeSnapshot,
  deriveCanvasPlacementSourceState,
  materializeMissingCanvasNodeSnapshots,
  readCanvasNodeSnapshot,
  withCanvasNodeSnapshot,
} from "../src/desktop/renderer-next/model/canvas-node-snapshot.js";
import { DEFAULT_EDGE_LAYERS } from "../src/desktop/renderer-next/model/canvas-edges.js";
import {
  applyPlacementPatches,
  documentToExcalidrawElements,
  duplicateTentPlacements,
  extractPlacementPatchesFromElements,
  limitedCanvasNodePreview,
  placementToEmbeddableElement,
  readTentNodeCustomData,
  reconcileTentPlacementHistory,
  releaseTentTransformSelection,
  selectionToFocusedPlacement,
  tentNodeLink,
  tentNodeOpenTarget,
  tentPlacementElementId,
  validateTentEmbeddableLink,
  viewportFromExcalidrawAppState,
  excalidrawAppStateFromViewport,
  TENT_NODE_CUSTOM_KIND,
  captureTentNodeOpenTarget,
  type ExcalidrawElementLike,
} from "../src/desktop/renderer-next/canvas/excalidraw/documentToExcalidraw.js";
import {
  createCanvasV5PersistGate,
  flushCanvasV5PersistGates,
} from "../src/desktop/renderer-next/canvas/excalidraw/canvasV5PersistGate.js";
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
import { shouldRefreshCanvasV5Scene } from "../src/desktop/renderer-next/canvas/excalidraw/sceneRefreshPolicy.js";
import {
  schedulePostMountCanvasViewportSync,
  viewportAfterCanvasResize,
} from "../src/desktop/renderer-next/model/canvas-viewport-resize.js";
import {
  completeCanvasDrop,
  enterCanvasDropTarget,
  IDLE_CANVAS_DROP_FEEDBACK,
  leaveCanvasDropTarget,
} from "../src/desktop/renderer-next/model/canvas-drop-feedback.js";
import {
  createTentPlacementDrag,
  focusExcalidrawKeyboardOwner,
  moveTentPlacementForPointer,
  restoreTentPlacementAfterCancel,
} from "../src/desktop/renderer-next/canvas/excalidraw/tent-placement-drag.js";

test("Tent placement pointer ownership focuses the native Canvas keyboard surface", () => {
  let selector = "";
  let options: FocusOptions | undefined;
  const host = {
    querySelector(query: string) {
      selector = query;
      return {
        focus(next: FocusOptions) {
          options = next;
        },
      };
    },
  } as unknown as ParentNode;
  assert.equal(focusExcalidrawKeyboardOwner(host), true);
  assert.equal(selector, ".excalidraw-container");
  assert.deepEqual(options, { preventScroll: true });
  assert.equal(
    focusExcalidrawKeyboardOwner({ querySelector: () => null } as unknown as ParentNode),
    false
  );
});

function sampleDoc(): CanvasDocument {
  const snapshot = (nodeId: string, type: string) => captureCanvasNodeSnapshot({
    nodeId,
    etag: `etag-${nodeId}`,
    name: nodeId === "cx-alpha" ? "Alpha" : "Beta",
    title: nodeId === "cx-alpha" ? "Alpha snapshot" : "Beta snapshot",
    path: `产品/${nodeId}`,
    type,
    tags: [type],
    mode: "editable",
    archived: false,
    invalid: false,
  });
  return {
    version: 1,
    backgroundMode: "blank",
    focusedPlacementId: "pl-a",
    viewport: { x: 40, y: 80, zoom: 1.25 },
    placements: [
      withCanvasNodeSnapshot({
        placementId: "pl-a",
        entityRef: "cx-alpha",
        kind: "node",
        x: 100,
        y: 120,
        width: 220,
        height: 96,
      }, snapshot("cx-alpha", "prompt")),
      withCanvasNodeSnapshot({
        placementId: "pl-b",
        entityRef: "cx-alpha",
        kind: "node",
        x: 400,
        y: 200,
        width: 200,
        height: 80,
      }, snapshot("cx-alpha", "prompt")),
      withCanvasNodeSnapshot({
        placementId: "pl-c",
        entityRef: "cx-beta",
        kind: "node",
        x: 40,
        y: 300,
        width: 180,
        height: 72,
      }, snapshot("cx-beta", "output")),
    ],
  };
}

test("same nodeId maps to multiple placements with distinct element ids", () => {
  const doc = sampleDoc();
  const mapped = documentToExcalidrawElements(doc);
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
    assert.equal(el.link, tentNodeLink(custom!.nodeId));
    assert.ok(validateTentEmbeddableLink(el.link as string | null));
    // Must not copy body/task facts into customData
    assert.equal(Object.keys(custom!).sort().join(","), "kind,nodeId,placementId");
  }
});

test("Tent placement drag moves one fixed instance at viewport zoom and preserves siblings", () => {
  const scene = documentToExcalidrawElements(sampleDoc()).elements;
  const source = scene.find((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-a"
  )!;
  const sibling = scene.find((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-b"
  )!;
  const drag = createTentPlacementDrag({
    pointerId: 7,
    placementId: "pl-a",
    nodeId: "cx-alpha",
    elementId: source.id,
    startClientX: 300,
    startClientY: 200,
    originX: source.x,
    originY: source.y,
    zoom: 2,
  });

  const moved = moveTentPlacementForPointer(scene, drag, 360, 236);
  const movedElements = moved.elements as ExcalidrawElementLike[];
  const movedSource = movedElements.find((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-a"
  )!;
  const untouchedSibling = movedElements.find((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-b"
  )!;
  assert.equal(moved.moved, true);
  assert.equal(movedSource.x, source.x + 30);
  assert.equal(movedSource.y, source.y + 18);
  assert.equal(movedSource.width, NODE_CARD.width);
  assert.equal(movedSource.height, NODE_CARD.height);
  assert.equal(movedSource.angle, 0);
  assert.equal(untouchedSibling, sibling, "duplicate placement remains untouched");

  const restored = restoreTentPlacementAfterCancel(
    moved.elements,
    drag
  ) as ExcalidrawElementLike[];
  const restoredSource = restored.find((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-a"
  )!;
  assert.equal(restoredSource.x, source.x);
  assert.equal(restoredSource.y, source.y);
  assert.equal(
    restored.find((element) => readTentNodeCustomData(element)?.placementId === "pl-b"),
    sibling,
    "cancel does not create or mutate sibling placement"
  );
});

test("Tent placement click below drag threshold creates no geometry change", () => {
  const scene = documentToExcalidrawElements(sampleDoc()).elements;
  const source = scene.find((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-a"
  )!;
  const drag = createTentPlacementDrag({
    pointerId: 9,
    placementId: "pl-a",
    nodeId: "cx-alpha",
    elementId: source.id,
    startClientX: 100,
    startClientY: 100,
    originX: source.x,
    originY: source.y,
    zoom: 1,
  });
  const click = moveTentPlacementForPointer(scene, drag, 101, 100);
  assert.equal(click.moved, false);
  assert.equal(click.elements, scene);
});

test("Excalidraw duplicate becomes a new local placement without changing Node identity", () => {
  const doc = sampleDoc();
  const original = placementToEmbeddableElement(doc.placements[0]!);
  const copied = { ...original, id: "excal-copy", x: 180, y: 220 };
  const result = duplicateTentPlacements({
    document: doc,
    previousElements: [original],
    nextElements: [original, copied],
    createPlacementId: () => "pl-copy",
  });
  assert.deepEqual(result.addedPlacementIds, ["pl-copy"]);
  assert.equal(result.document.placements.length, doc.placements.length + 1);
  const placement = result.document.placements.find((item) => item.placementId === "pl-copy");
  assert.equal(placement?.entityRef, "cx-alpha");
  assert.equal(placement?.x, 180);
  assert.equal(placement?.width, NODE_CARD.width);
  assert.equal(readTentNodeCustomData(result.elements[1])?.placementId, "pl-copy");
  assert.equal(readTentNodeCustomData(result.elements[1])?.nodeId, "cx-alpha");
});

test("duplicate and delete follow native scene history without losing local placements", () => {
  const base = sampleDoc();
  const initial = base;
  const initialElements = documentToExcalidrawElements(initial).elements;
  const source = initialElements[0]!;
  const duplicate = duplicateTentPlacements({
    document: initial,
    previousElements: initialElements,
    nextElements: [
      ...initialElements,
      { ...source, id: "excal-copy", x: source.x + 24, y: source.y + 24 },
    ],
    createPlacementId: () => "pl-copy",
  });
  const copyPlacement = duplicate.document.placements.find(
    (placement) => placement.placementId === "pl-copy"
  )!;
  const cache = new Map([[copyPlacement.placementId, copyPlacement]]);
  const knownHistoryPlacements = new Set([copyPlacement.placementId]);

  const applyFrame = (document: CanvasDocument, elements: typeof duplicate.elements) => {
    const result = reconcileTentPlacementHistory({
      document,
      elements,
      cachedPlacements: cache,
      knownHistoryPlacementIds: knownHistoryPlacements,
      focusRestoredPlacementId: "pl-copy",
    });
    for (const placement of result.deletedPlacements) {
      cache.set(placement.placementId, placement);
    }
    for (const placement of result.restoredPlacements) {
      cache.delete(placement.placementId);
    }
    return result.document;
  };

  const afterDuplicate = applyFrame(initial, duplicate.elements);
  assert.equal(initial.placements.length, 3);
  assert.equal(afterDuplicate.placements.length, 4);
  assert.equal(afterDuplicate.focusedPlacementId, "pl-copy");

  const missingCopyElements = duplicate.elements.filter(
    (element) => readTentNodeCustomData(element)?.placementId !== "pl-copy"
  );
  const afterDirectUndo = applyFrame(afterDuplicate, missingCopyElements);
  assert.equal(afterDirectUndo.placements.length, 3, "missing native undo removes the copy");
  const afterDirectRedo = applyFrame(afterDirectUndo, duplicate.elements);
  assert.equal(afterDirectRedo.placements.length, 4);

  const deletedElements = duplicate.elements.map((element) =>
    readTentNodeCustomData(element)?.placementId === "pl-copy"
      ? { ...element, isDeleted: true }
      : element
  );
  const afterDelete = applyFrame(afterDirectRedo, deletedElements);
  assert.equal(afterDelete.placements.length, 3);

  const afterUndo = applyFrame(afterDelete, duplicate.elements);
  assert.equal(afterUndo.placements.length, 4);
  assert.equal(afterUndo.placements.filter((placement) => placement.placementId === "pl-copy").length, 1);

  const copyElement = duplicate.elements.find(
    (element) => readTentNodeCustomData(element)?.placementId === "pl-copy"
  )!;
  const conflicted = reconcileTentPlacementHistory({
    document: afterUndo,
    elements: [
      ...duplicate.elements,
      { ...copyElement, id: "conflicting-tombstone", isDeleted: true },
    ],
    cachedPlacements: cache,
  });
  assert.equal(conflicted.document, afterUndo, "ambiguous topology stays fail-closed");
  assert.deepEqual(conflicted.conflictedPlacementIds, ["pl-copy"]);
  assert.deepEqual(conflicted.restoredPlacements, []);
  assert.deepEqual(conflicted.deletedPlacements, []);

  const afterRedo = applyFrame(afterUndo, deletedElements);
  assert.equal(afterRedo.placements.length, 3);
});

test("quick preview derives a bounded non-interactive excerpt from already-loaded Markdown", () => {
  const body = "# 标题\n\n这是 **已经加载** 的正文。\n\n- 第一项\n- 第二项";
  assert.equal(limitedCanvasNodePreview(body), "标题 这是 已经加载 的正文。 第一项 第二项");
  assert.equal(limitedCanvasNodePreview(body, 10).endsWith("…"), true);
});

test("Tent embeddable links resolve only to their exact Node Focus target", () => {
  const element = placementToEmbeddableElement(sampleDoc().placements[0]!);
  assert.deepEqual(tentNodeOpenTarget(element), {
    kind: TENT_NODE_CUSTOM_KIND,
    nodeId: "cx-alpha",
    placementId: "pl-a",
  });
  assert.equal(tentNodeOpenTarget({ ...element, link: "https://example.com" }), null);
  assert.equal(tentNodeOpenTarget({ ...element, link: tentNodeLink("cx-other") }), null);
  assert.equal(tentNodeOpenTarget({ ...element, customData: undefined }), null);
});

test("hydrate keeps Tent focus separate from Excalidraw transform selection", () => {
  const doc = sampleDoc();
  const hydrated = hydrateCanvasV5Scene({ document: doc });
  assert.deepEqual(hydrated.appState.selectedElementIds, {});
});

test("pointer-up cleanup removes Tent transform handles and canonicalizes size without clearing drawing selection", () => {
  const tent = {
    ...placementToEmbeddableElement(sampleDoc().placements[0]!),
    width: 420,
    height: 240,
    angle: 0.5,
  };
  const drawing = { id: "drawing-1", type: "rectangle", width: 10, height: 10 };
  const released = releaseTentTransformSelection(
    [tent, drawing],
    { [tent.id]: true, [drawing.id]: true }
  );
  assert.equal(released.changed, true);
  assert.deepEqual(released.selectedElementIds, { [drawing.id]: true });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(released.elements[0] as Record<string, unknown>).filter(([key]) =>
        ["width", "height", "angle", "x", "y"].includes(key)
      )
    ),
    { x: 100, y: 120, width: NODE_CARD.width, height: NODE_CARD.height, angle: 0 }
  );
});

test("live V5 scene refreshes for edge layers and external documents only", () => {
  const document = sampleDoc();
  const graph = { edges: { parent: [] } };
  const previous = {
    document,
    graph,
    edgeLayers: { ...DEFAULT_EDGE_LAYERS },
  };
  assert.equal(
    shouldRefreshCanvasV5Scene(
      previous,
      {
        ...previous,
        edgeLayers: { ...DEFAULT_EDGE_LAYERS, parent: false },
      },
      null
    ),
    true
  );
  const externallyChanged = { ...document, viewport: { x: 4, y: 8, zoom: 1 } };
  assert.equal(
    shouldRefreshCanvasV5Scene(
      previous,
      { ...previous, document: externallyChanged },
      null
    ),
    true
  );
  assert.equal(
    shouldRefreshCanvasV5Scene(
      previous,
      { ...previous, document: externallyChanged },
      externallyChanged
    ),
    false
  );
});

test("position writes back continuously while Tent Node geometry stays fixed", () => {
  const doc = sampleDoc();
  const el = placementToEmbeddableElement(doc.placements[0]!);
  // Simulate mid-drag frames
  const mid = { ...el, x: 150, y: 160, width: 240, height: 110 };
  const patches = extractPlacementPatchesFromElements([mid]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.x, 150);
  assert.equal(patches[0]!.width, NODE_CARD.width);
  const next = applyPlacementPatches(doc, patches);
  const p = next.placements.find((x) => x.placementId === "pl-a");
  assert.ok(p);
  assert.equal(p!.x, 150);
  assert.equal(p!.y, 160);
  assert.equal(p!.width, NODE_CARD.width);
  assert.equal(p!.height, NODE_CARD.height);
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
  assert.equal(ghosted.cards.get("pl-a")!.state, "snapshot");
  // Placements still present
  assert.equal(ghosted.elements.filter((e) => e.type === "embeddable").length, 3);
});

test("node cards stay frozen while projection-visible fields change", () => {
  const mapped = documentToExcalidrawElements(sampleDoc(), {
    resolvers: {
      resolveCurrent: (nodeId) => ({
        nodeId,
        etag: `etag-${nodeId}`,
        name: "Live renamed Node",
        title: "Live renamed title",
        path: "Live/new/path",
        type: "goal",
        tags: ["live"],
        mode: "editable",
        archived: false,
        invalid: false,
      }),
    },
  });
  const frozen = mapped.cards.get("pl-a")!;
  assert.equal(frozen.title, "Alpha snapshot");
  assert.equal(frozen.typeLabel, "提示");
  assert.equal(frozen.detail, "产品/cx-alpha");
  assert.equal(frozen.state, "snapshot");
  assert.equal(frozen.stateLabel, "来源有更新");
  assert.equal(frozen.sourceState, "changed");
  assert.equal(frozen.rawTaskState, undefined);
});

test("etag-only source changes use the same fail-closed state on Canvas cards", () => {
  const doc = sampleDoc();
  const current = {
    nodeId: "cx-alpha",
    etag: "etag-new",
    name: "Alpha",
    title: "Alpha snapshot",
    path: "产品/cx-alpha",
    type: "prompt",
    tags: ["prompt"],
    mode: "editable" as const,
    archived: false,
    invalid: false,
  };
  const changed = documentToExcalidrawElements(doc, {
    resolvers: { resolveCurrent: (nodeId) => nodeId === "cx-alpha" ? current : undefined },
  });
  assert.equal(changed.cards.get("pl-a")?.stateLabel, "来源有更新");
  assert.equal(changed.cards.get("pl-a")?.sourceState, "changed");

  const stale = documentToExcalidrawElements(doc, {
    resolvers: {
      resolveCurrent: () => current,
      resolvePendingRecovery: (nodeId) => nodeId === "cx-alpha",
    },
  });
  assert.equal(stale.cards.get("pl-a")?.stateLabel, "投影已过期");
  assert.equal(stale.cards.get("pl-a")?.sourceState, "unknown");
});

test("Tent Node cards have one fixed presentation and ignore legacy display mode", () => {
  const base = sampleDoc();
  const doc: CanvasDocument = {
    ...base,
    placements: base.placements.map((placement, index) => index === 0 ? {
      ...placement,
      width: 420,
      height: 280,
      meta: { ...(placement.meta ?? {}), presentation: "expanded" },
    } : placement),
  };
  const mapped = documentToExcalidrawElements(doc);
  const element = mapped.elements.find((item) => item.id === tentPlacementElementId("pl-a"));
  assert.equal(element?.width, NODE_CARD.width);
  assert.equal(element?.height, NODE_CARD.height);
  assert.equal("presentation" in (mapped.cards.get("pl-a") ?? {}), false);
});

test("Canvas resize preserves world centre then minimally reveals the focused placement", () => {
  const direct1280 = viewportAfterCanvasResize({
    viewport: { x: 0, y: 0, zoom: 1 },
    previousSize: { width: 650, height: 640 },
    nextSize: { width: 650, height: 640 },
    focusedPlacement: {
      placementId: "pl-selected",
      entityRef: "cx-selected",
      kind: "node",
      x: 760,
      y: 220,
      width: 240,
      height: 120,
    },
  });
  assert.equal(760 + direct1280.x + 240, 626, "direct narrow mount reveals the full focused placement");

  const viewport = viewportAfterCanvasResize({
    viewport: { x: -320, y: 40, zoom: 1 },
    previousSize: { width: 900, height: 700 },
    nextSize: { width: 650, height: 640 },
    focusedPlacement: {
      placementId: "pl-selected",
      entityRef: "cx-selected",
      kind: "node",
      x: 760,
      y: 220,
      width: 240,
      height: 120,
    },
  });
  const left = 760 + viewport.x;
  const right = left + 240;
  assert.ok(left >= 24 && right <= 626, "selected placement remains fully visible");
  assert.notEqual(viewport.x, 0, "manual pan is not reset to the origin");

  assert.deepEqual(viewportAfterCanvasResize({
    viewport: { x: -1000, y: -300, zoom: 1 },
    previousSize: { width: 900, height: 700 },
    nextSize: { width: 650, height: 640 },
    focusedPlacement: {
      placementId: "pl-offscreen",
      entityRef: "cx-offscreen",
      kind: "node",
      x: 100,
      y: 100,
      width: 240,
      height: 120,
    },
    focusVisibility: "if-visible-before-resize",
  }), { x: -1125, y: -330, zoom: 1 }, "offscreen selection does not override a manual pan");

  assert.deepEqual(viewportAfterCanvasResize({
    viewport: { x: -500, y: 80, zoom: 1.5 },
    previousSize: { width: 1000, height: 700 },
    nextSize: { width: 800, height: 600 },
  }), { x: -600, y: 30, zoom: 1.5 }, "unselected resize preserves the visible world centre");
});

test("pending pan flushes before resize and cannot restore the pre-resize camera", () => {
  let document = sampleDoc();
  const gate = createCanvasV5PersistGate(60_000);
  gate.schedule(() => {
    document = {
      ...document,
      viewport: { x: -480, y: -220, zoom: 1.25 },
    };
  });

  gate.flush();
  const resized = viewportAfterCanvasResize({
    viewport: document.viewport!,
    previousSize: { width: 1440, height: 900 },
    nextSize: { width: 1280, height: 840 },
    focusedPlacement: document.placements[0]!,
    focusVisibility: "if-visible-before-resize",
  });
  document = { ...document, viewport: resized };

  assert.notDeepEqual(document.viewport, { x: -480, y: -220, zoom: 1.25 });
  gate.flush();
  assert.deepEqual(
    document.viewport,
    resized,
    "the flushed debounce gate has no captured camera left to publish"
  );
});

test("delayed Canvas API sync applies the latest direct-mount viewport after mount", () => {
  let queued: (() => void) | null = null;
  let cancelled = 0;
  let current = true;
  let viewport = { x: -120, y: -80, zoom: 1 };
  const applied: Array<typeof viewport> = [];
  const cancel = schedulePostMountCanvasViewportSync({
    scheduler: {
      requestFrame: (callback) => {
        queued = callback;
        return 17;
      },
      cancelFrame: (frameId) => {
        assert.equal(frameId, 17);
        cancelled += 1;
      },
    },
    isCurrent: () => current,
    readViewport: () => viewport,
    applyViewport: (value) => applied.push(value),
  });

  assert.deepEqual(applied, [], "API delivery does not synchronously update an unmounted engine");
  viewport = { x: -210, y: -95, zoom: 1 };
  assert.ok(queued);
  (queued as () => void)();
  assert.deepEqual(applied, [{ x: -210, y: -95, zoom: 1 }]);

  current = false;
  cancel();
  assert.equal(cancelled, 1);
});

test("whiteboard drop creates another placement with an independent frozen snapshot", () => {
  const doc = sampleDoc();
  const sourceTags = ["dragged"];
  const snapshot = captureCanvasNodeSnapshot({
    nodeId: "cx-alpha",
    etag: "etag-dragged",
    name: "Dragged Alpha",
    path: "产品/拖放",
    type: "prompt",
    tags: sourceTags,
    mode: "editable",
    archived: false,
    invalid: false,
  });
  sourceTags.push("mutated-after-capture");
  const dropped = dropNodeSnapshotAt(
    doc,
    "cx-alpha",
    snapshot,
    { x: 812, y: 456 },
    () => "pl-drop"
  );
  assert.equal(dropped.document.placements.length, doc.placements.length + 1);
  assert.deepEqual(doc, sampleDoc());
  const placement = dropped.document.placements.at(-1)!;
  assert.equal(placement.x, 812);
  assert.equal(placement.y, 456);
  assert.deepEqual(readCanvasNodeSnapshot(placement)?.tags, ["dragged"]);
  assert.equal(dropped.document.focusedPlacementId, "pl-drop");
});

test("Canvas owns one stable nested drop-target lifecycle", () => {
  const firstEnter = enterCanvasDropTarget(IDLE_CANVAS_DROP_FEEDBACK);
  const nestedEnter = enterCanvasDropTarget(firstEnter);
  assert.deepEqual(nestedEnter, { phase: "target", depth: 2 });
  assert.deepEqual(leaveCanvasDropTarget(nestedEnter), {
    phase: "target",
    depth: 1,
  });
  assert.deepEqual(
    leaveCanvasDropTarget({ phase: "target", depth: 1 }),
    IDLE_CANVAS_DROP_FEEDBACK
  );
  assert.deepEqual(completeCanvasDrop(false), IDLE_CANVAS_DROP_FEEDBACK);
  assert.deepEqual(completeCanvasDrop(true), { phase: "success", depth: 0 });
});

test("legacy snapshot materialization never overwrites malformed snapshot metadata", () => {
  const source = {
    nodeId: "cx-alpha",
    etag: "etag-authoritative-alpha",
    name: "Authoritative Alpha",
    path: "产品/Alpha",
    type: "prompt",
    tags: ["ui"],
    mode: "editable" as const,
    archived: false,
    invalid: false,
  };
  const legacy: CanvasDocument = {
    version: 1,
    backgroundMode: "blank",
    placements: [
      { placementId: "pl-empty", entityRef: "cx-alpha", kind: "node" },
      {
        placementId: "pl-corrupt",
        entityRef: "cx-alpha",
        kind: "node",
        meta: { tentNodeSnapshot: { version: 1, nodeId: "foreign" } },
      },
    ],
  };
  const result = materializeMissingCanvasNodeSnapshots(legacy, [source]);
  assert.equal(result.changed, true);
  assert.equal(readCanvasNodeSnapshot(result.document.placements[0]!)?.name, "Authoritative Alpha");
  assert.equal(readCanvasNodeSnapshot(result.document.placements[1]!), null);
  assert.deepEqual(
    result.document.placements[1]!.meta,
    legacy.placements[1]!.meta,
    "an existing malformed key is preserved fail-closed"
  );
});

test("snapshot revisions remain local, explicit, and fail closed", () => {
  const source = {
    nodeId: "cx-alpha",
    etag: "etag-live",
    name: "Alpha",
    title: "Alpha snapshot",
    path: "产品/cx-alpha",
    type: "prompt",
    tags: ["prompt"],
    mode: "editable" as const,
    archived: false,
    invalid: false,
  };
  const captured = captureCanvasNodeSnapshot(source);
  assert.equal(captured.etag, "etag-live");
  const placement = withCanvasNodeSnapshot(
    { placementId: "pl-a", entityRef: "cx-alpha", kind: "node" },
    captured
  );
  assert.deepEqual(deriveCanvasPlacementSourceState({
    placement,
    authority: "fresh",
    source,
  }), { state: "current", reason: "matched", canSync: false });

  assert.equal(deriveCanvasPlacementSourceState({
    placement,
    authority: "fresh",
    source: { ...source, etag: "etag-new" },
  }).state, "changed", "etag alone proves a changed source");
  const visibleFieldChanges = [
    { ...source, name: "Renamed Alpha" },
    { ...source, title: "Retitled Alpha" },
    { ...source, path: "产品/移动后/cx-alpha" },
    { ...source, type: "goal" },
    { ...source, tags: ["prompt", "changed"] },
    { ...source, mode: "archived" as const },
    { ...source, archived: true },
    { ...source, invalid: true },
  ];
  for (const changedSource of visibleFieldChanges) {
    assert.equal(deriveCanvasPlacementSourceState({
      placement,
      authority: "fresh",
      source: changedSource,
    }).state, "changed", "every frozen projection-visible field proves a change");
  }

  const { etag: _legacyEtag, ...legacySnapshot } = captured;
  const legacyPlacement = withCanvasNodeSnapshot(
    { placementId: "pl-legacy", entityRef: "cx-alpha", kind: "node" },
    legacySnapshot
  );
  assert.equal(readCanvasNodeSnapshot(legacyPlacement)?.etag, undefined);
  assert.deepEqual(deriveCanvasPlacementSourceState({
    placement: legacyPlacement,
    authority: "fresh",
    source,
  }), { state: "unknown", reason: "revision-unavailable", canSync: true });
  const legacyDocument: CanvasDocument = {
    version: 1,
    backgroundMode: "blank",
    focusedPlacementId: "pl-legacy",
    placements: [legacyPlacement],
  };
  const preserved = materializeMissingCanvasNodeSnapshots(legacyDocument, [source]);
  assert.equal(preserved.changed, false);
  assert.deepEqual(preserved.document, legacyDocument);
  assert.equal(readCanvasNodeSnapshot(preserved.document.placements[0]!)?.etag, undefined);
  assert.deepEqual(deriveCanvasPlacementSourceState({
    placement,
    authority: "fresh",
    source: null,
  }), { state: "deleted", reason: "fresh-source-missing", canSync: false });
  assert.deepEqual(deriveCanvasPlacementSourceState({
    placement,
    authority: "unknown",
    source,
  }), { state: "unknown", reason: "authority-unavailable", canSync: false });

  const malformed = {
    placementId: "pl-bad",
    entityRef: "cx-alpha",
    kind: "node",
    meta: { tentNodeSnapshot: { ...captured, etag: "" } },
  };
  assert.deepEqual(deriveCanvasPlacementSourceState({
    placement: malformed,
    authority: "fresh",
    source,
  }), { state: "unknown", reason: "snapshot-malformed", canSync: false });
});

test("snapshotless cards never read live Node fields as a fallback", () => {
  let liveReads = 0;
  const document: CanvasDocument = {
    version: 1,
    backgroundMode: "blank",
    placements: [{ placementId: "pl-legacy", entityRef: "cx-alpha", kind: "node" }],
  };
  const mapped = documentToExcalidrawElements(document, {
    resolvers: {
      resolveCurrent: () => {
        liveReads += 1;
        throw new Error("live fields must not be consulted");
      },
    },
  });
  assert.equal(liveReads, 0);
  assert.equal(mapped.cards.get("pl-legacy")?.title, "未固化的节点快照");
  assert.equal(mapped.cards.get("pl-legacy")?.state, "unknown");
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
  assert.equal(persisted.layerVisible, true);
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
  // Duplicate placements still produce exactly one quiet structure edge.
  assert.equal(arrows.length, 1);
  for (const arrow of arrows) {
    assert.equal(arrow.locked, true);
    assert.equal(arrow.endArrowhead, null);
    assert.equal(arrow.strokeStyle, "solid", "focused parent emphasizes direct children");
    assert.equal(arrow.opacity, 76);
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
  const shellCss = await fs.readFile(
    path.join(process.cwd(), "src/desktop/renderer-next/styles/shell.css"),
    "utf8"
  );
  const host = await fs.readFile(
    path.join(
      process.cwd(),
      "src/desktop/renderer-next/canvas/excalidraw/CanvasV5Host.tsx"
    ),
    "utf8"
  );
  const workbench = await fs.readFile(
    path.join(
      process.cwd(),
      "src/desktop/renderer-next/components/CanvasWorkbench.tsx"
    ),
    "utf8"
  );

  assert.doesNotMatch(host, /canvas-v5-toolbar|canvas-v5-tool-/);
  assert.doesNotMatch(host, /TOOL_ORDER|TOOL_LABELS|setTool\(/);
  assert.doesNotMatch(host, /canvasKeyboardOwnerRef|onDuplicate=/);
  assert.match(host, /document\.activeElement && host\.contains\(document\.activeElement\)/);
  assert.doesNotMatch(css, /tn-canvas-v5-host__toolbar/);
  assert.match(host, /tools:\s*\{\s*image:\s*true\s*\}/);
  assert.match(host, /data-testid="canvas-display-menu"/);
  assert.match(shellCss, /\.tn-canvas-pane\s*\{[^}]*grid-template-rows: minmax\(0, 1fr\);/s);
  assert.match(css, /\.tn-canvas-v5-host__scene \.welcome-screen-decor-hint--toolbar/);
  assert.match(css, /\.tn-canvas-v5-host__scene \.HintViewer/);
  assert.doesNotMatch(workbench, /tn-canvas-tabbar|tn-canvas-tab|tn-canvas-tools|工作集/);
  assert.match(workbench, /graph=\{structureGraph\}/);
  assert.match(workbench, /markdown:\s*false,\s*wiki:\s*false,\s*relation:\s*false/);
  assert.doesNotMatch(workbench, /onToggleEdgeLayer/);
});

test("Canvas V5 only captures an exact internal Tent Node link", async () => {
  const internal = {
    id: "tent-pl:pl-a",
    link: tentNodeLink("cx-alpha"),
    customData: {
      kind: TENT_NODE_CUSTOM_KIND,
      nodeId: "cx-alpha",
      placementId: "pl-a",
    },
  };
  assert.deepEqual(tentNodeOpenTarget(internal), internal.customData);
  assert.equal(
    tentNodeOpenTarget({
      ...internal,
      link: "https://example.com/reference",
    }),
    null
  );
  assert.equal(
    tentNodeOpenTarget({ link: "https://example.com/reference" }),
    null
  );
  let internalPrevented = 0;
  assert.deepEqual(
    captureTentNodeOpenTarget(internal, {
      preventDefault: () => { internalPrevented += 1; },
    }),
    internal.customData
  );
  assert.equal(internalPrevented, 1);
  let externalPrevented = 0;
  assert.equal(
    captureTentNodeOpenTarget(
      { link: "https://example.com/reference" },
      { preventDefault: () => { externalPrevented += 1; } }
    ),
    null
  );
  assert.equal(externalPrevented, 0, "generic Excalidraw URL keeps native behavior");
});

test("immediate Canvas V5 unmount flushes queued placement and scene writes before remount", () => {
  const durable: string[] = [];
  const placement = createCanvasV5PersistGate(60_000);
  const drawing = createCanvasV5PersistGate(60_000);
  placement.schedule(() => durable.push("placement:last"));
  drawing.schedule(() => durable.push("scene:last"));

  // React cleanup uses this exact synchronous seam before cancelling gates.
  flushCanvasV5PersistGates({ placement, drawing });
  drawing.cancel();
  placement.cancel();

  assert.deepEqual(durable, ["placement:last", "scene:last"]);
  assert.deepEqual([...durable], ["placement:last", "scene:last"], "next mount sees both final writes");
});
