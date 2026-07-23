import { describe, expect, it } from "vitest";
import {
  assertCanvasDocumentShape,
  emptyCanvasDocument,
  findPlacement,
  updatePlacement,
} from "../src/model/canvasDocument.js";
import {
  buildSyntheticWorkingSet,
  countEdgeKinds,
} from "../src/model/syntheticGraph.js";
import {
  canRedo,
  canUndo,
  createLayoutHistory,
  pushLayoutCommand,
  redoLayout,
  undoLayout,
} from "../src/state/layoutHistory.js";
import {
  closeFocus,
  createFocusDraftStore,
  draftCountForEntity,
  getActiveDraft,
  openFocus,
  setFocusExpanded,
  updateActiveDraft,
} from "../src/state/focusDrafts.js";

describe("CanvasDocument shape", () => {
  it("only holds viewport, placements, visual groups, annotations", () => {
    const doc = emptyCanvasDocument();
    assertCanvasDocumentShape(doc);
    expect(Object.keys(doc).sort()).toEqual([
      "annotations",
      "placements",
      "version",
      "viewport",
      "visualGroups",
    ]);
  });

  it("separates entityRef from placementId", () => {
    const snap = buildSyntheticWorkingSet({ seed: 1, minNodes: 250, maxNodes: 300 });
    expect(snap.domainNodes.length).toBeGreaterThanOrEqual(250);
    expect(snap.domainNodes.length).toBeLessThanOrEqual(300);
    for (const p of snap.document.placements) {
      expect(p.placementId).toMatch(/^pl-/);
      expect(p.entityRef).toMatch(/^cx-/);
      expect(p.placementId).not.toEqual(p.entityRef);
      expect(snap.domainNodes.some((n) => n.entityRef === p.entityRef)).toBe(true);
    }
  });
});

describe("synthetic edges (experiment only, not Core schema)", () => {
  it("includes four edge kinds", () => {
    const snap = buildSyntheticWorkingSet({ seed: 2 });
    const counts = countEdgeKinds(snap.edges);
    expect(counts.parent).toBeGreaterThan(0);
    expect(counts["resolved-link"]).toBeGreaterThan(0);
    expect(counts["unresolved-link"]).toBeGreaterThan(0);
    expect(counts["visual-annotation"]).toBeGreaterThan(0);
  });
});

describe("drag mutates placement only", () => {
  it("updatePlacement does not change domain parentEntityRef", () => {
    const snap = buildSyntheticWorkingSet({ seed: 3, minNodes: 250, maxNodes: 260 });
    const parentsBefore = new Map(
      snap.domainNodes.map((n) => [n.entityRef, n.parentEntityRef])
    );
    const p0 = snap.document.placements[0]!;
    const doc2 = updatePlacement(snap.document, p0.placementId, {
      x: p0.x + 40,
      y: p0.y + 20,
    });
    const moved = findPlacement(doc2, p0.placementId)!;
    expect(moved.x).toBe(p0.x + 40);
    expect(moved.y).toBe(p0.y + 20);
    expect(moved.entityRef).toBe(p0.entityRef);
    for (const n of snap.domainNodes) {
      expect(n.parentEntityRef).toBe(parentsBefore.get(n.entityRef));
    }
  });
});

describe("layout undo/redo only", () => {
  it("undo/redo move commands", () => {
    const snap = buildSyntheticWorkingSet({ seed: 4, minNodes: 250, maxNodes: 255 });
    let hist = createLayoutHistory(snap.document);
    const p = snap.document.placements[1]!;
    hist = pushLayoutCommand(hist, {
      type: "move",
      placementId: p.placementId,
      before: { x: p.x, y: p.y },
      after: { x: p.x + 10, y: p.y + 15 },
    });
    expect(findPlacement(hist.document, p.placementId)!.x).toBe(p.x + 10);
    expect(canUndo(hist)).toBe(true);
    hist = undoLayout(hist);
    expect(findPlacement(hist.document, p.placementId)!.x).toBe(p.x);
    expect(canRedo(hist)).toBe(true);
    hist = redoLayout(hist);
    expect(findPlacement(hist.document, p.placementId)!.y).toBe(p.y + 15);
  });
});

describe("Focus Workspace drafts", () => {
  it("keeps a single draft per entity and restores close semantics in store", () => {
    const snap = buildSyntheticWorkingSet({ seed: 5, minNodes: 250, maxNodes: 255 });
    const node = snap.domainNodes[0]!;
    let store = createFocusDraftStore();
    store = openFocus(store, node);
    store = updateActiveDraft(store, { markdown: "edited once" });
    store = closeFocus(store);
    expect(store.activeEntityRef).toBeNull();
    // draft retained
    expect(draftCountForEntity(store, node.entityRef)).toBe(1);
    store = openFocus(store, node);
    store = openFocus(store, node); // re-open same entity
    expect(draftCountForEntity(store, node.entityRef)).toBe(1);
    const draft = getActiveDraft(store)!;
    expect(draft.markdown).toBe("edited once");
    store = setFocusExpanded(store, true);
    expect(store.expanded).toBe(true);
    store = closeFocus(store);
    expect(store.expanded).toBe(false);
  });
});
