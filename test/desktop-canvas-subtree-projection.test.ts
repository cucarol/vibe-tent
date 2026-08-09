import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasDocument, CanvasPlacement } from "../src/desktop/renderer-next/types/identity.js";
import { movePlacement } from "../src/desktop/renderer-next/model/canvas-document.js";
import {
  CANVAS_SUBTREE_META_KEY,
  carryCollapsedSubtreeDescendants,
  createCanvasSubtreeProjectionInstance,
  deriveCanvasSubtreeProjection,
  joinCanvasSubtreeInstanceAt,
  readCanvasSubtreePlacementMeta,
  reconcileCanvasProjectionSync,
  toggleCanvasSubtreeBranch,
  type CanvasSubtreeNodeSource,
} from "../src/desktop/renderer-next/model/canvas-subtree-projection.js";
import { deriveCanvasSubtreeStructureBranches } from "../src/desktop/renderer-next/model/canvas-subtree-geometry.js";
import {
  activeCanvasPresentationRevision,
  advanceCanvasPresentationHistory,
  isCanvasPresentationHistoryElement,
  preserveCanvasPresentationHistoryMarker,
} from "../src/desktop/renderer-next/canvas/excalidraw/canvas-presentation-history.js";
import { drawingElementsFromScene } from "../src/desktop/renderer-next/canvas/excalidraw/documentToExcalidraw.js";

const emptyDocument = (): CanvasDocument => ({
  version: 1,
  placements: [],
  backgroundMode: "blank",
  focusedPlacementId: null,
  viewport: { x: 0, y: 0, zoom: 1 },
});

function source(nodeId: string, parentNodeId: string | null, etag = `${nodeId}-v1`): CanvasSubtreeNodeSource {
  return {
    nodeId,
    parentNodeId,
    snapshot: {
      version: 1,
      nodeId,
      etag,
      name: nodeId,
      title: `标题 ${nodeId}`,
      path: `根/${nodeId}`,
      type: nodeId === "root" ? "goal" : nodeId.startsWith("out") ? "output" : "prompt",
      tags: ["ui"],
      mode: "editable",
      archived: false,
      invalid: false,
    },
  };
}

const TREE = [
  source("root", null),
  source("child-a", "root"),
  source("grandchild", "child-a"),
  source("out-b", "root"),
] as const;

function createInstance(document = emptyDocument(), prefix = "a") {
  let placement = 0;
  return createCanvasSubtreeProjectionInstance(
    document,
    "root",
    TREE,
    { x: prefix === "a" ? 100 : 900, y: 120 },
    "right",
    () => `instance-${prefix}`,
    () => `placement-${prefix}-${placement++}`
  );
}

test("subtree drop persists all members while only root and direct children start visible", () => {
  const created = createInstance();
  assert.equal(created.document.placements.length, 4);
  const projection = deriveCanvasSubtreeProjection(created.document, TREE);
  assert.deepEqual(
    projection.visiblePlacementIds,
    ["placement-a-0", "placement-a-1", "placement-a-3"]
  );
  assert.deepEqual(
    projection.relationships.map((edge) => [edge.parentPlacementId, edge.childPlacementId]),
    [["placement-a-0", "placement-a-1"], ["placement-a-0", "placement-a-3"]]
  );
  assert.equal(projection.controls.find((item) => item.placementId === "placement-a-0")?.expandedDirection, "right");
  assert.equal(projection.controls.find((item) => item.placementId === "placement-a-1")?.expandedDirection, null);
});

test("duplicate subtree instances never cross-pair relationships", () => {
  const first = createInstance();
  const second = createInstance(first.document, "b");
  const projection = deriveCanvasSubtreeProjection(second.document, TREE);
  assert.equal(projection.relationships.length, 4);
  assert.equal(new Set(projection.relationships.map((edge) => edge.instanceId)).size, 2);
  for (const edge of projection.relationships) {
    const prefix = edge.instanceId.endsWith("a") ? "placement-a-" : "placement-b-";
    assert.equal(edge.parentPlacementId.startsWith(prefix), true);
    assert.equal(edge.childPlacementId.startsWith(prefix), true);
  }
});

test("collapse preserves positions and explicit direction change alone relayouts descendants", () => {
  const created = createInstance();
  const before = new Map(created.document.placements.map((placement) => [placement.placementId, [placement.x, placement.y]]));
  const collapsed = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  assert.equal(deriveCanvasSubtreeProjection(collapsed, TREE).visiblePlacementIds.length, 1);
  const reopened = toggleCanvasSubtreeBranch(collapsed, "placement-a-0", "right");
  assert.deepEqual(
    reopened.placements.map((placement) => [placement.x, placement.y]),
    created.document.placements.map((placement) => before.get(placement.placementId))
  );
  const collapsedAgain = toggleCanvasSubtreeBranch(reopened, "placement-a-0", "right");
  const relaid = toggleCanvasSubtreeBranch(collapsedAgain, "placement-a-0", "down");
  assert.notDeepEqual(
    relaid.placements.slice(1).map((placement) => [placement.x, placement.y]),
    created.document.placements.slice(1).map((placement) => [placement.x, placement.y])
  );
  assert.equal(readCanvasSubtreePlacementMeta(relaid.placements[0])?.expandedDirection, "down");
});

test("expanded children move freely while collapsed roots carry hidden descendants", () => {
  const created = createInstance();
  const movedChild = movePlacement(created.document, "placement-a-1", { x: 740, y: 40 });
  assert.deepEqual(
    movedChild.placements.find((placement) => placement.placementId === "placement-a-2")?.x,
    created.document.placements.find((placement) => placement.placementId === "placement-a-2")?.x
  );
  const collapsed = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const movedRootOnly = movePlacement(collapsed, "placement-a-0", { x: 160, y: 170 });
  const carried = carryCollapsedSubtreeDescendants(collapsed, movedRootOnly);
  for (const placement of carried.placements.slice(1)) {
    const before = collapsed.placements.find((candidate) => candidate.placementId === placement.placementId)!;
    assert.equal(placement.x, (before.x ?? 0) + 60);
    assert.equal(placement.y, (before.y ?? 0) + 50);
  }
});

test("structure paths reroute from current geometry and stay orthogonal", () => {
  const created = createInstance();
  const moved = movePlacement(created.document, "placement-a-1", { x: -260, y: 500 });
  const projection = deriveCanvasSubtreeProjection(moved, TREE);
  const branches = deriveCanvasSubtreeStructureBranches(moved, projection);
  assert.ok(branches.length >= 2);
  assert.ok(branches.every((branch) => !/[Ll]\s*-?\d+(?:\.\d+)?\s+-?\d/.test(branch.path)));
  assert.ok(branches.some((branch) => branch.direction === "left" || branch.direction === "down"));
});

test("stale authority preserves placements but hides relationships and disables sync", () => {
  const created = createInstance();
  const projection = deriveCanvasSubtreeProjection(created.document, null);
  assert.equal(projection.relationships.length, 0);
  assert.equal(projection.syncControls.length, 0);
  assert.equal(projection.visiblePlacementIds.length, 3);
  assert.ok(projection.placementStates.every((item) => item.state === "unknown"));
});

test("pending sync aggregates content and membership drift at the exact instance root", () => {
  const created = createInstance();
  const changed = [
    source("root", null, "root-v2"),
    source("child-a", "root"),
    source("grandchild", "out-b"),
    source("out-b", "root"),
    source("new-child", "root"),
  ];
  const projection = deriveCanvasSubtreeProjection(created.document, changed);
  const control = projection.syncControls.find((item) => item.placementId === "placement-a-0");
  assert.equal(control?.scope, "subtree");
  assert.ok((control?.affectedCount ?? 0) >= 3);
  assert.equal(
    projection.placementStates.find((item) => item.placementId === "placement-a-0")?.state,
    "pending-sync"
  );
});

test("a nested projection root ignores its external parent while internal reparent stays pending", () => {
  const nested = [
    source("ancestor", null),
    source("root", "ancestor"),
    source("child-a", "root"),
  ];
  let placement = 0;
  const created = createCanvasSubtreeProjectionInstance(
    emptyDocument(),
    "root",
    nested,
    { x: 100, y: 120 },
    "right",
    () => "instance-nested",
    () => `placement-nested-${placement++}`
  );

  assert.equal(deriveCanvasSubtreeProjection(created.document, nested).syncControls.length, 0);
  const reconciled = reconcileCanvasProjectionSync(
    created.document,
    "placement-nested-0",
    nested
  );
  assert.equal(deriveCanvasSubtreeProjection(reconciled, nested).syncControls.length, 0);

  const reparented = [
    source("ancestor", null),
    source("root", "ancestor"),
    source("child-a", "ancestor"),
  ];
  const pending = deriveCanvasSubtreeProjection(reconciled, reparented);
  assert.equal(pending.syncControls[0]?.placementId, "placement-nested-0");
  assert.equal(pending.syncControls[0]?.affectedCount, 1);
});

test("sync preserves surviving manual coordinates and only adds/removes affected members", () => {
  const created = createInstance();
  const manuallyMoved = movePlacement(created.document, "placement-a-1", { x: 711, y: 333 });
  const changed = [
    source("root", null, "root-v2"),
    source("child-a", "root", "child-a-v2"),
    source("new-child", "root"),
  ];
  let nextId = 0;
  const synced = reconcileCanvasProjectionSync(
    manuallyMoved,
    "placement-a-0",
    changed,
    () => `added-${nextId++}`
  );
  assert.equal(synced.placements.some((placement) => placement.entityRef === "grandchild"), false);
  assert.equal(synced.placements.some((placement) => placement.entityRef === "out-b"), false);
  const retained = synced.placements.find((placement) => placement.entityRef === "child-a")!;
  assert.deepEqual([retained.x, retained.y], [711, 333]);
  assert.equal(synced.placements.filter((placement) => placement.entityRef === "new-child").length, 1);
  assert.equal(deriveCanvasSubtreeProjection(synced, changed).syncControls.length, 0);
});

test("duplicate instances reconcile independently", () => {
  const first = createInstance();
  const second = createInstance(first.document, "b");
  const changed = [...TREE, source("new-child", "root")];
  const synced = reconcileCanvasProjectionSync(second.document, "placement-a-0", changed, () => "placement-a-new");
  assert.equal(synced.placements.some((placement) => placement.placementId === "placement-a-new"), true);
  assert.equal(
    synced.placements.filter((placement) =>
      readCanvasSubtreePlacementMeta(placement)?.instanceId === "instance-b"
    ).length,
    4
  );
  assert.ok(deriveCanvasSubtreeProjection(synced, changed).syncControls.some((item) => item.placementId === "placement-b-0"));
});

test("drop joins only one explicitly hit eligible instance and never nearest-pairs blank space", () => {
  const created = createCanvasSubtreeProjectionInstance(
    emptyDocument(),
    "root",
    [source("root", null), source("child-a", "root")],
    { x: 100, y: 100 },
    "right",
    () => "instance-a",
    (() => { let index = 0; return () => `placement-${index++}`; })()
  );
  const joined = joinCanvasSubtreeInstanceAt(
    created.document,
    source("new-child", "root"),
    { x: 240, y: 180 },
    () => "joined"
  );
  assert.equal(joined?.document.placements.at(-1)?.placementId, "joined");
  assert.equal(readCanvasSubtreePlacementMeta(joined!.document.placements.at(-1)!)?.instanceId, "instance-a");
  assert.equal(
    joinCanvasSubtreeInstanceAt(created.document, source("far", "root"), { x: 5000, y: 5000 }),
    null
  );
});

test("malformed subtree metadata fails closed as a visible standalone placement", () => {
  const malformed: CanvasPlacement = {
    placementId: "malformed",
    entityRef: "root",
    kind: "node",
    x: 0,
    y: 0,
    meta: { [CANVAS_SUBTREE_META_KEY]: { version: 1, instanceId: "bad" } },
  };
  const document = { ...emptyDocument(), placements: [malformed] };
  const projection = deriveCanvasSubtreeProjection(document, TREE);
  assert.deepEqual(projection.visiblePlacementIds, ["malformed"]);
  assert.equal(projection.relationships.length, 0);
});

test("projection sync uses one invisible native-history marker without entering drawing persistence", () => {
  const drawing = [{ id: "stroke", type: "freedraw", x: 0, y: 0, width: 10, height: 10 }];
  const first = advanceCanvasPresentationHistory(drawing, "revision-a");
  assert.equal(activeCanvasPresentationRevision(first), "revision-a");
  assert.equal(first.filter(isCanvasPresentationHistoryElement).length, 1);
  assert.deepEqual(drawingElementsFromScene(first).map((element) => (element as { id: string }).id), ["stroke"]);

  const second = advanceCanvasPresentationHistory(first, "revision-b");
  assert.equal(activeCanvasPresentationRevision(second), "revision-b");
  assert.equal(second.filter(isCanvasPresentationHistoryElement).length, 1);
  const refreshed = preserveCanvasPresentationHistoryMarker(drawing, second);
  assert.equal(activeCanvasPresentationRevision(refreshed), "revision-b");

  const undone = second.map((element) => isCanvasPresentationHistoryElement(element)
    ? { ...element, isDeleted: true }
    : element);
  assert.equal(activeCanvasPresentationRevision(undone), null);
});
