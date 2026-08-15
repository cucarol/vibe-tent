import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { CanvasDocument, CanvasPlacement } from "../src/desktop/renderer-next/types/identity.js";
import { movePlacement, NODE_CARD } from "../src/desktop/renderer-next/model/canvas-document.js";
import {
  CANVAS_SUBTREE_META_KEY,
  canvasDocumentAuthorityDigest,
  carryCollapsedSubtreeDescendants,
  createCanvasSubtreeProjectionInstance,
  deriveCanvasSubtreeProjection,
  readCanvasSubtreePlacementMeta,
  reconcileCanvasDocumentSync,
  reconcileCanvasDocumentSyncFromLatestAuthority,
  readCanvasProjectionPlacementMeta,
  setCanvasProjectionPlacementHidden,
  toggleCanvasSubtreeBranch,
  type CanvasSubtreeNodeSource,
} from "../src/desktop/renderer-next/model/canvas-subtree-projection.js";
import {
  applyCanvasSubtreeStructureBranchPaths,
  deriveCanvasSubtreeStructureBranches,
} from "../src/desktop/renderer-next/model/canvas-subtree-geometry.js";
import {
  activeCanvasPresentationRevision,
  advanceCanvasPresentationHistory,
  isCanvasPresentationHistoryElement,
  preserveCanvasPresentationHistoryMarker,
} from "../src/desktop/renderer-next/canvas/excalidraw/canvas-presentation-history.js";
import { drawingElementsFromScene } from "../src/desktop/renderer-next/canvas/excalidraw/documentToExcalidraw.js";
import {
  dropPresentationSubtreeOrLeaf,
  placePresentationSubtreeOrLeaf,
} from "../src/desktop/renderer-next/shell/workbench-presentation.js";

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

function nodePlacement(placementId: string, nodeId: string, x: number, y: number): CanvasPlacement {
  return {
    placementId,
    kind: "node",
    entityRef: nodeId,
    x,
    y,
    width: 240,
    height: 104,
    meta: {},
  };
}

function placementRectForTest(placement: CanvasPlacement) {
  const left = placement.x ?? 0;
  const top = placement.y ?? 0;
  return {
    left,
    top,
    right: left + NODE_CARD.width,
    bottom: top + NODE_CARD.height,
  };
}

type Segment = { from: { x: number; y: number }; to: { x: number; y: number } };

function segmentCrossesPlacement(segment: Segment, placement: CanvasPlacement): boolean {
  const clearance = 12;
  const left = (placement.x ?? 0) - clearance;
  const top = (placement.y ?? 0) - clearance;
  const right = left + NODE_CARD.width + clearance * 2;
  const bottom = top + NODE_CARD.height + clearance * 2;
  if (segment.from.y === segment.to.y) {
    if (segment.from.y <= top || segment.from.y >= bottom) return false;
    return Math.max(Math.min(segment.from.x, segment.to.x), left) <
      Math.min(Math.max(segment.from.x, segment.to.x), right);
  }
  if (segment.from.x === segment.to.x) {
    if (segment.from.x <= left || segment.from.x >= right) return false;
    return Math.max(Math.min(segment.from.y, segment.to.y), top) <
      Math.min(Math.max(segment.from.y, segment.to.y), bottom);
  }
  return true;
}

function assertRouteAvoidsPlacements(
  points: readonly { x: number; y: number }[],
  placements: readonly CanvasPlacement[]
): void {
  const segments = points.slice(1).map((to, index) => ({ from: points[index], to }));
  assert.ok(segments.length > 0);
  for (const segment of segments) {
    assert.ok(segment.from.x === segment.to.x || segment.from.y === segment.to.y);
    for (const placement of placements) {
      assert.equal(segmentCrossesPlacement(segment, placement), false);
    }
  }
}

const TREE = [
  source("root", null),
  source("child-a", "root"),
  source("grandchild", "child-a"),
  source("out-b", "root"),
] as const;

function createInstance(document = emptyDocument(), prefix = "a", startExpanded = false) {
  let placement = 0;
  const created = createCanvasSubtreeProjectionInstance(
    document,
    "root",
    TREE,
    { x: prefix === "a" ? 100 : 900, y: 120 },
    "right",
    () => `instance-${prefix}`,
    () => `placement-${prefix}-${placement++}`
  );
  return startExpanded
    ? created
    : {
      ...created,
      document: toggleCanvasSubtreeBranch(created.document, created.rootPlacementId, "right"),
    };
}

test("subtree drop freezes the complete bundle with root and direct children visible", () => {
  const created = createInstance(emptyDocument(), "a", true);
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
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-1", "right");
  assert.deepEqual(
    deriveCanvasSubtreeProjection(expanded, TREE).visiblePlacementIds,
    ["placement-a-0", "placement-a-1", "placement-a-2", "placement-a-3"]
  );
  const branches = deriveCanvasSubtreeStructureBranches(
    created.document,
    projection
  );
  const sharedTrunks = branches.map((branch) => branch.path.split(/(?= H | V )/).slice(0, 2).join(""));
  assert.equal(new Set(sharedTrunks).size, 1, "direct siblings share one quiet short trunk");
});

test("wide sibling sets wrap into bounded directional bands instead of an unbounded circuit column", () => {
  const wideTree = [
    source("root", null),
    ...Array.from({ length: 13 }, (_value, index) => source(`child-${index}`, "root")),
  ];
  let placement = 0;
  const created = createCanvasSubtreeProjectionInstance(
    emptyDocument(),
    "root",
    wideTree,
    { x: 100, y: 300 },
    "right",
    () => "instance-wide",
    () => `placement-wide-${placement++}`
  );
  const children = created.document.placements.slice(1);
  const xBands = [...new Set(children.map((child) => child.x))];
  assert.equal(xBands.length, 3, "thirteen siblings use three rightward bands");
  assert.deepEqual(
    children.slice(0, 5).map((child) => child.x),
    Array(5).fill(xBands[0])
  );
  const yValues = children.map((child) => child.y ?? 0);
  assert.ok(
    Math.max(...yValues) - Math.min(...yValues) <= 4 * (NODE_CARD.height + 28),
    "cross-axis span is bounded to five cards"
  );
  for (let left = 0; left < children.length; left += 1) {
    const leftRect = placementRectForTest(children[left]!);
    for (let right = left + 1; right < children.length; right += 1) {
      const rightRect = placementRectForTest(children[right]!);
      assert.equal(
        leftRect.left < rightRect.right && leftRect.right > rightRect.left &&
          leftRect.top < rightRect.bottom && leftRect.bottom > rightRect.top,
        false,
        `initial cards ${left} and ${right} do not overlap`
      );
    }
  }
  assert.equal(deriveCanvasSubtreeProjection(created.document, wideTree).visiblePlacementIds.length, 14);
});

test("right-pane placement repeats the same leaf-or-subtree materialization as drag", () => {
  const first = placePresentationSubtreeOrLeaf(
    { document: emptyDocument(), selectedNodeId: "root" },
    "root",
    TREE
  );
  const second = placePresentationSubtreeOrLeaf(first, "root", TREE);
  assert.equal(second.document.placements.length, 8);
  const roots = second.document.placements.filter((placement) => placement.entityRef === "root");
  assert.equal(roots.length, 2);
  assert.notEqual(
    readCanvasSubtreePlacementMeta(roots[0]!)?.instanceId,
    readCanvasSubtreePlacementMeta(roots[1]!)?.instanceId
  );
  assert.deepEqual(
    second.document.placements.filter((placement) => placement.entityRef === "root").map((placement) => [placement.x, placement.y]),
    [[96, 150], [96, 326]]
  );
  const firstInstanceId = readCanvasSubtreePlacementMeta(roots[0]!)?.instanceId;
  const secondInstanceId = readCanvasSubtreePlacementMeta(roots[1]!)?.instanceId;
  const firstPlacements = second.document.placements.filter(
    (placement) => readCanvasSubtreePlacementMeta(placement)?.instanceId === firstInstanceId
  );
  const secondPlacements = second.document.placements.filter(
    (placement) => readCanvasSubtreePlacementMeta(placement)?.instanceId === secondInstanceId
  );
  for (const firstPlacement of firstPlacements) {
    for (const secondPlacement of secondPlacements) {
      assert.equal(
        Math.max(firstPlacement.x ?? 0, secondPlacement.x ?? 0) <
          Math.min((firstPlacement.x ?? 0) + NODE_CARD.width, (secondPlacement.x ?? 0) + NODE_CARD.width) &&
        Math.max(firstPlacement.y ?? 0, secondPlacement.y ?? 0) <
          Math.min((firstPlacement.y ?? 0) + NODE_CARD.height, (secondPlacement.y ?? 0) + NODE_CARD.height),
        false,
        `${firstPlacement.placementId} must not overlap ${secondPlacement.placementId}`
      );
    }
  }
});

test("duplicate subtree instances never cross-pair relationships", () => {
  const first = createInstance();
  const second = createInstance(first.document, "b");
  const expandedA = toggleCanvasSubtreeBranch(second.document, "placement-a-0", "right");
  const expanded = toggleCanvasSubtreeBranch(expandedA, "placement-b-0", "right");
  const projection = deriveCanvasSubtreeProjection(expanded, TREE);
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
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const collapsed = toggleCanvasSubtreeBranch(expanded, "placement-a-0", "right");
  assert.equal(deriveCanvasSubtreeProjection(collapsed, TREE).visiblePlacementIds.length, 1);
  const reopened = toggleCanvasSubtreeBranch(collapsed, "placement-a-0", "right");
  assert.deepEqual(
    reopened.placements.map((placement) => [placement.x, placement.y]),
    expanded.placements.map((placement) => before.get(placement.placementId))
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
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const movedChild = movePlacement(expanded, "placement-a-1", { x: 740, y: 40 });
  assert.deepEqual(
    movedChild.placements.find((placement) => placement.placementId === "placement-a-2")?.x,
    created.document.placements.find((placement) => placement.placementId === "placement-a-2")?.x
  );
  const collapsed = toggleCanvasSubtreeBranch(expanded, "placement-a-0", "right");
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
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const moved = movePlacement(expanded, "placement-a-1", { x: -260, y: 500 });
  const projection = deriveCanvasSubtreeProjection(moved, TREE);
  const branches = deriveCanvasSubtreeStructureBranches(moved, projection);
  assert.ok(branches.length >= 2);
  assert.ok(branches.every((branch) => !/[Ll]\s*-?\d+(?:\.\d+)?\s+-?\d/.test(branch.path)));
  assert.ok(branches.some((branch) => branch.direction === "left" || branch.direction === "down"));
});

test("moving an already-materialized multi-child root updates every live card-side attachment", () => {
  const created = createInstance();
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const projection = deriveCanvasSubtreeProjection(expanded, TREE);
  const before = deriveCanvasSubtreeStructureBranches(expanded, projection);
  const movedRoot = { placementId: "placement-a-0", x: 420, y: 330 };
  const after = deriveCanvasSubtreeStructureBranches(expanded, projection, movedRoot);

  assert.equal(after.length, 2, "both direct children retain a live relationship");
  assert.notDeepEqual(
    after.map((branch) => branch.path),
    before.map((branch) => branch.path),
    "the already-materialized branches reroute in the imperative drag frame"
  );
  for (const branch of after) {
    const attachment = branch.routePoints[0];
    const onHorizontalSide =
      (attachment.x === movedRoot.x || attachment.x === movedRoot.x + NODE_CARD.width) &&
      attachment.y === movedRoot.y + NODE_CARD.height / 2;
    const onVerticalSide =
      (attachment.y === movedRoot.y || attachment.y === movedRoot.y + NODE_CARD.height) &&
      attachment.x === movedRoot.x + NODE_CARD.width / 2;
    assert.equal(onHorizontalSide || onVerticalSide, true, "route begins on the moved card edge");
  }
});

test("structure routing deterministically avoids visible Node obstacles and reroutes when geometry moves", () => {
  const document: CanvasDocument = {
    ...emptyDocument(),
    placements: [
      nodePlacement("parent", "root", 0, 0),
      nodePlacement("child", "child-a", 600, 0),
      nodePlacement("obstacle", "other", 300, 0),
    ],
  };
  const projection = {
    authority: "fresh" as const,
    visiblePlacementIds: ["parent", "child", "obstacle"],
    relationships: [{
      id: "subtree:test:parent->child",
      instanceId: "test",
      parentPlacementId: "parent",
      childPlacementId: "child",
    }],
    controls: [],
    placementStates: [],
    documentSync: null,
  };
  const blockedDiagnostics = { segmentRectChecks: 0 };
  const blocked = deriveCanvasSubtreeStructureBranches(
    document,
    projection,
    null,
    blockedDiagnostics
  )[0];
  assert.match(blocked?.path ?? "", new RegExp(`^M ${NODE_CARD.width} ${NODE_CARD.height / 2} `));
  assertRouteAvoidsPlacements(blocked?.routePoints ?? [], [document.placements[2]]);
  assert.ok(blockedDiagnostics.segmentRectChecks <= 64);

  const movedObstacle = {
    ...document,
    placements: document.placements.map((placement) =>
      placement.placementId === "obstacle" ? { ...placement, y: 180 } : placement
    ),
  };
  const clear = deriveCanvasSubtreeStructureBranches(movedObstacle, projection)[0];
  assert.deepEqual(clear?.routePoints, [
    { x: NODE_CARD.width, y: NODE_CARD.height / 2 },
    { x: NODE_CARD.width + 18, y: NODE_CARD.height / 2 },
    { x: 600, y: NODE_CARD.height / 2 },
  ]);

  const movedEndpoint = {
    ...movedObstacle,
    placements: movedObstacle.placements.map((placement) =>
      placement.placementId === "child" ? { ...placement, y: 300 } : placement
    ),
  };
  const rerouted = deriveCanvasSubtreeStructureBranches(movedEndpoint, projection)[0];
  assert.notEqual(rerouted?.path, clear?.path);
  assert.match(rerouted?.path ?? "", new RegExp(`^M ${NODE_CARD.width} ${NODE_CARD.height / 2} `));
});

test("multi-bend visibility routing preserves a fresh relationship through a six-card corridor", () => {
  const placements = [
    nodePlacement("p0", "root", 0, 0),
    nodePlacement("p47", "child-a", 1960, 700),
    nodePlacement("o1", "o1", 1680, 0),
    nodePlacement("o2", "o2", 0, 560),
    nodePlacement("o3", "o3", 1960, 560),
    nodePlacement("o4", "o4", 1680, 700),
  ];
  const projection = {
    authority: "fresh" as const,
    visiblePlacementIds: placements.map((placement) => placement.placementId),
    relationships: [{
      id: "subtree:corridor:p0->p47",
      instanceId: "corridor",
      parentPlacementId: "p0",
      childPlacementId: "p47",
    }],
    controls: [],
    placementStates: [],
    documentSync: null,
  };
  const diagnostics = { segmentRectChecks: 0, visibilityNodesExpanded: 0 };
  const branches = deriveCanvasSubtreeStructureBranches(
    { ...emptyDocument(), placements },
    projection,
    null,
    diagnostics
  );
  assert.equal(branches.length, 1);
  assertRouteAvoidsPlacements(branches[0].routePoints, placements.slice(2));
  assert.ok(branches[0].routePoints.length - 1 > 3);

  const densePlacements = [...placements];
  for (let index = 0; index < 42; index += 1) {
    densePlacements.push(nodePlacement(
      `far-${index}`,
      `far-node-${index}`,
      3000 + (index % 7) * 320,
      Math.floor(index / 7) * 240
    ));
  }
  const denseDiagnostics = { segmentRectChecks: 0, visibilityNodesExpanded: 0 };
  const startedAt = performance.now();
  const dense = deriveCanvasSubtreeStructureBranches(
    { ...emptyDocument(), placements: densePlacements },
    { ...projection, visiblePlacementIds: densePlacements.map((placement) => placement.placementId) },
    null,
    denseDiagnostics
  );
  const elapsed = performance.now() - startedAt;
  assert.equal(dense.length, 1);
  assertRouteAvoidsPlacements(dense[0].routePoints, densePlacements.slice(2));
  assert.ok((denseDiagnostics.visibilityNodesExpanded ?? 0) < 10_000);
  assert.ok(denseDiagnostics.segmentRectChecks < 2_000_000);
  assert.ok(elapsed < 250, `dense visibility route took ${elapsed.toFixed(1)}ms`);
});

test("imperative overlay clears an unavailable route and restores it in the same update path", () => {
  const parent = nodePlacement("parent", "root", 0, 0);
  const child = nodePlacement("child", "child-a", 600, 0);
  const obstacle = nodePlacement("obstacle", "other", 590, -10);
  const projection = {
    authority: "fresh" as const,
    visiblePlacementIds: ["parent", "child", "obstacle"],
    relationships: [{
      id: "subtree:test:parent->child",
      instanceId: "test",
      parentPlacementId: "parent",
      childPlacementId: "child",
    }],
    controls: [],
    placementStates: [],
    documentSync: null,
  };
  const feasibleDocument = {
    ...emptyDocument(),
    focusedPlacementId: "parent",
    placements: [parent, child, { ...obstacle, y: 180 }],
  };
  const feasible = deriveCanvasSubtreeStructureBranches(feasibleDocument, projection);
  const blocked = deriveCanvasSubtreeStructureBranches(
    { ...feasibleDocument, placements: [parent, child, obstacle] },
    projection
  );
  const restored = deriveCanvasSubtreeStructureBranches(
    { ...feasibleDocument, placements: [parent, child, { ...obstacle, x: 300, y: 180 }] },
    projection
  );
  assert.equal(feasible.length, 1);
  assert.equal(blocked.length, 0);
  assert.equal(restored.length, 1);

  const values = { base: "", highlight: "" };
  const refs = new Map([[feasible[0].id, {
    base: { setAttribute: (_name: "d", value: string) => { values.base = value; } },
    highlight: { setAttribute: (_name: "d", value: string) => { values.highlight = value; } },
  }]]);
  applyCanvasSubtreeStructureBranchPaths(refs, feasible);
  assert.notEqual(values.base, "");
  assert.notEqual(values.highlight, "");
  applyCanvasSubtreeStructureBranchPaths(refs, blocked);
  assert.equal(values.base, "");
  assert.equal(values.highlight, "");
  applyCanvasSubtreeStructureBranchPaths(refs, restored);
  assert.equal(values.base, restored[0].path);
  assert.equal(values.highlight, restored[0].highlightPath);
});

test("clear structure routing stays linear across a representative 48-Node canvas", () => {
  const placements: CanvasPlacement[] = [];
  const relationships = [];
  for (let index = 0; index < 24; index += 1) {
    const y = index * 400;
    placements.push(nodePlacement(`parent-${index}`, `parent-node-${index}`, 0, y));
    placements.push(nodePlacement(`child-${index}`, `child-node-${index}`, 600, y));
    relationships.push({
      id: `subtree:${index}:parent->child`,
      instanceId: `instance-${index}`,
      parentPlacementId: `parent-${index}`,
      childPlacementId: `child-${index}`,
    });
  }
  const diagnostics = { segmentRectChecks: 0 };
  const branches = deriveCanvasSubtreeStructureBranches(
    { ...emptyDocument(), placements },
    {
      authority: "fresh",
      visiblePlacementIds: placements.map((placement) => placement.placementId),
      relationships,
      controls: [],
      placementStates: [],
      documentSync: null,
    },
    null,
    diagnostics
  );
  assert.equal(branches.length, 24);
  assert.equal(diagnostics.segmentRectChecks, 24 * 46);
});

test("clear structure routing remains frame-bounded across 128 visible Nodes", () => {
  const placements: CanvasPlacement[] = [];
  const relationships = [];
  for (let index = 0; index < 64; index += 1) {
    const y = index * 260;
    placements.push(nodePlacement(`large-parent-${index}`, `large-parent-node-${index}`, 0, y));
    placements.push(nodePlacement(`large-child-${index}`, `large-child-node-${index}`, 620, y));
    relationships.push({
      id: `subtree:large-${index}:parent->child`,
      instanceId: `large-instance-${index}`,
      parentPlacementId: `large-parent-${index}`,
      childPlacementId: `large-child-${index}`,
    });
  }
  const diagnostics = { segmentRectChecks: 0 };
  const startedAt = performance.now();
  const branches = deriveCanvasSubtreeStructureBranches(
    { ...emptyDocument(), placements },
    {
      authority: "fresh",
      visiblePlacementIds: placements.map((placement) => placement.placementId),
      relationships,
      controls: [],
      placementStates: [],
      documentSync: null,
    },
    null,
    diagnostics
  );
  const elapsed = performance.now() - startedAt;
  assert.equal(branches.length, 64);
  assert.equal(diagnostics.segmentRectChecks, 64 * 126);
  assert.ok(elapsed < 120, `64 clear routes across 128 Nodes took ${elapsed.toFixed(1)}ms`);
});

test("a full 48-Node frame reuses indexed obstacle geometry across 24 blocked relationships", () => {
  const placements: CanvasPlacement[] = [];
  const relationships = [];
  for (let row = 0; row < 8; row += 1) {
    const rowPlacements: CanvasPlacement[] = [];
    for (let column = 0; column < 6; column += 1) {
      const placement = nodePlacement(
        `blocked-${row}-${column}`,
        `blocked-node-${row}-${column}`,
        column * 360,
        row * 300
      );
      placements.push(placement);
      rowPlacements.push(placement);
    }
    for (const [from, to] of [[0, 2], [2, 4], [0, 5]] as const) {
      relationships.push({
        id: `subtree:blocked-${row}:${from}->${to}`,
        instanceId: `blocked-instance-${row}`,
        parentPlacementId: rowPlacements[from].placementId,
        childPlacementId: rowPlacements[to].placementId,
      });
    }
  }
  const diagnostics = {
    segmentRectChecks: 0,
    indexBuildRectChecks: 0,
    indexedIntervalChecks: 0,
    visibilityNodesExpanded: 0,
  };
  const startedAt = performance.now();
  const branches = deriveCanvasSubtreeStructureBranches(
    { ...emptyDocument(), placements },
    {
      authority: "fresh",
      visiblePlacementIds: placements.map((placement) => placement.placementId),
      relationships,
      controls: [],
      placementStates: [],
      documentSync: null,
    },
    null,
    diagnostics
  );
  const elapsed = performance.now() - startedAt;
  assert.equal(branches.length, 24);
  assert.ok(diagnostics.visibilityNodesExpanded > 0);
  for (const branch of branches) {
    const relationship = relationships.find((candidate) => `branch:${candidate.id}` === branch.id)!;
    assertRouteAvoidsPlacements(
      branch.routePoints,
      placements.filter((placement) =>
        placement.placementId !== relationship.parentPlacementId &&
        placement.placementId !== relationship.childPlacementId
      )
    );
  }
  const indexedWork = diagnostics.indexBuildRectChecks + diagnostics.indexedIntervalChecks;
  assert.ok(indexedWork < 150_000, `indexed obstacle work was ${indexedWork}`);
  assert.ok(diagnostics.visibilityNodesExpanded < 20_000);
  assert.ok(elapsed < 80, `24 blocked routes took ${elapsed.toFixed(1)}ms`);
});

test("branch DOM identity stays stable when a live drag crosses the parent center", () => {
  const document: CanvasDocument = {
    ...emptyDocument(),
    focusedPlacementId: "parent",
    placements: [
      nodePlacement("parent", "root", 0, 0),
      nodePlacement("child", "child-a", 600, 0),
    ],
  };
  const projection = {
    authority: "fresh" as const,
    visiblePlacementIds: ["parent", "child"],
    relationships: [{
      id: "subtree:stable:parent->child",
      instanceId: "stable",
      parentPlacementId: "parent",
      childPlacementId: "child",
    }],
    controls: [],
    placementStates: [],
    documentSync: null,
  };
  const before = deriveCanvasSubtreeStructureBranches(document, projection);
  const after = deriveCanvasSubtreeStructureBranches(
    document,
    projection,
    { placementId: "child", x: -600, y: 0 }
  );
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(before[0].direction, "right");
  assert.equal(after[0].direction, "left");
  assert.equal(after[0].id, before[0].id);
  assert.notEqual(after[0].path, before[0].path);

  const values = { base: before[0].path, highlight: before[0].highlightPath ?? "" };
  const refs = new Map([[before[0].id, {
    base: { setAttribute: (_name: "d", value: string) => { values.base = value; } },
    highlight: { setAttribute: (_name: "d", value: string) => { values.highlight = value; } },
  }]]);
  applyCanvasSubtreeStructureBranchPaths(refs, after);
  assert.equal(values.base, after[0].path);
  assert.equal(values.highlight, after[0].highlightPath);
  assert.notEqual(values.base, "");
  assert.notEqual(values.highlight, "");
});

test("stale authority preserves frozen membership lines but disables sync", () => {
  const created = createInstance();
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const projection = deriveCanvasSubtreeProjection(expanded, null);
  assert.equal(projection.relationships.length, 2);
  assert.equal(projection.visiblePlacementIds.length, 3);
  assert.ok(projection.placementStates.every((item) => item.state === "unknown"));
  assert.equal(projection.documentSync, null);
  assert.equal(
    deriveCanvasSubtreeStructureBranches(expanded, projection).length,
    2,
    "frozen local membership lines remain visible without claiming fresh authority"
  );
});

test("pending sync aggregates content and membership drift once for the Canvas", () => {
  const created = createInstance();
  const changed = [
    source("root", null, "root-v2"),
    source("child-a", "root"),
    source("grandchild", "out-b"),
    source("out-b", "root"),
    source("new-child", "root"),
  ];
  const projection = deriveCanvasSubtreeProjection(created.document, changed);
  assert.ok((projection.documentSync?.affectedCount ?? 0) >= 3);
  assert.equal(projection.documentSync?.canSync, true);
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

  assert.equal(deriveCanvasSubtreeProjection(created.document, nested).documentSync, null);
  const reconciled = reconcileCanvasDocumentSync(
    created.document,
    nested,
    { authorityDigest: canvasDocumentAuthorityDigest(created.document, nested)! }
  );
  assert.equal(deriveCanvasSubtreeProjection(reconciled, nested).documentSync, null);

  const reparented = [
    source("ancestor", null),
    source("root", "ancestor"),
    source("child-a", "ancestor"),
  ];
  const pending = deriveCanvasSubtreeProjection(reconciled, reparented);
  assert.equal(pending.documentSync?.affectedCount, 1);
});

test("sync preserves manual coordinates, adds new members, and keeps deleted evidence as tombstones", () => {
  const created = createInstance();
  const manuallyMoved = movePlacement(created.document, "placement-a-1", { x: 711, y: 333 });
  const changed = [
    source("root", null, "root-v2"),
    source("child-a", "root", "child-a-v2"),
    source("new-child", "root"),
  ];
  let nextId = 0;
  const synced = reconcileCanvasDocumentSync(
    manuallyMoved,
    changed,
    {
      authorityDigest: canvasDocumentAuthorityDigest(manuallyMoved, changed)!,
      createPlacementId: () => `added-${nextId++}`,
    }
  );
  const missing = synced.placements.filter((placement) =>
    placement.entityRef === "grandchild" || placement.entityRef === "out-b"
  );
  assert.equal(missing.length, 2);
  assert.ok(missing.every((placement) =>
    readCanvasProjectionPlacementMeta(placement).sourceStatus === "deleted" &&
    readCanvasSubtreePlacementMeta(placement) === null
  ));
  const retained = synced.placements.find((placement) => placement.entityRef === "child-a")!;
  assert.deepEqual([retained.x, retained.y], [711, 333]);
  assert.equal(synced.placements.filter((placement) => placement.entityRef === "new-child").length, 1);
  assert.equal(deriveCanvasSubtreeProjection(synced, changed).documentSync, null);
});

test("a newly inserted earlier sibling avoids every surviving placement without moving it", () => {
  let placement = 0;
  const initialSources = [source("root", null), source("existing", "root")];
  const created = createCanvasSubtreeProjectionInstance(
    emptyDocument(),
    "root",
    initialSources,
    { x: 0, y: 0 },
    "right",
    () => "instance-insert",
    () => `insert-${placement++}`
  );
  const existingBefore = created.document.placements.find(
    (candidate) => candidate.entityRef === "existing"
  )!;
  const authority = [
    source("root", null),
    source("new-earlier", "root"),
    source("existing", "root"),
  ];
  const synced = reconcileCanvasDocumentSync(created.document, authority, {
    authorityDigest: canvasDocumentAuthorityDigest(created.document, authority)!,
    createPlacementId: () => "insert-new",
  });
  const existingAfter = synced.placements.find(
    (candidate) => candidate.entityRef === "existing"
  )!;
  const inserted = synced.placements.find(
    (candidate) => candidate.entityRef === "new-earlier"
  )!;

  assert.deepEqual(
    [existingAfter.x, existingAfter.y],
    [existingBefore.x, existingBefore.y],
    "a surviving sibling keeps its exact manual geometry"
  );
  const existingRect = placementRectForTest(existingAfter);
  const insertedRect = placementRectForTest(inserted);
  assert.equal(
    insertedRect.right <= existingRect.left ||
      insertedRect.left >= existingRect.right ||
      insertedRect.bottom <= existingRect.top ||
      insertedRect.top >= existingRect.bottom,
    true,
    "the new sibling must not overlap a surviving placement that appears later"
  );
});

test("new membership searches beyond the former seventy-two occupied candidates", () => {
  let placement = 0;
  const initialSources = [source("root", null)];
  const created = createCanvasSubtreeProjectionInstance(
    emptyDocument(),
    "root",
    initialSources,
    { x: 0, y: 0 },
    "right",
    () => "instance-dense",
    () => `dense-root-${placement++}`
  );
  const laneOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];
  const blockers = laneOffsets.flatMap((laneOffset, lane) =>
    Array.from({ length: 8 }, (_, depth) =>
      nodePlacement(
        `dense-block-${lane}-${depth}`,
        `block-${lane}-${depth}`,
        NODE_CARD.width + 76 + depth * (NODE_CARD.width + 76),
        laneOffset * (NODE_CARD.height + 28)
      )
    )
  );
  const denseDocument = {
    ...created.document,
    placements: [...created.document.placements, ...blockers],
  };
  const authority = [source("root", null), source("new-member", "root")];
  const synced = reconcileCanvasDocumentSync(denseDocument, authority, {
    authorityDigest: canvasDocumentAuthorityDigest(denseDocument, authority)!,
    createPlacementId: () => "dense-new",
  });
  const added = synced.placements.find((candidate) => candidate.entityRef === "new-member")!;
  const addedRect = placementRectForTest(added);

  for (const blocker of blockers) {
    const rect = placementRectForTest(blocker);
    assert.equal(
      addedRect.right <= rect.left ||
        addedRect.left >= rect.right ||
        addedRect.bottom <= rect.top ||
        addedRect.top >= rect.bottom,
      true
    );
  }
  assert.ok((added.x ?? 0) > blockers.at(-1)!.x!);
});

test("new membership chooses a nearby side lane before a distant forward slot", () => {
  let placement = 0;
  const initialSources = [source("root", null)];
  const created = createCanvasSubtreeProjectionInstance(
    emptyDocument(),
    "root",
    initialSources,
    { x: 0, y: 0 },
    "right",
    () => "instance-near",
    () => `near-root-${placement++}`
  );
  const centreBlockers = Array.from({ length: 8 }, (_, depth) =>
    nodePlacement(
      `near-block-${depth}`,
      `near-block-${depth}`,
      NODE_CARD.width + 76 + depth * (NODE_CARD.width + 76),
      0
    )
  );
  const denseDocument = {
    ...created.document,
    placements: [...created.document.placements, ...centreBlockers],
  };
  const authority = [source("root", null), source("new-member", "root")];
  const synced = reconcileCanvasDocumentSync(denseDocument, authority, {
    authorityDigest: canvasDocumentAuthorityDigest(denseDocument, authority)!,
    createPlacementId: () => "near-new",
  });
  const added = synced.placements.find((candidate) => candidate.entityRef === "new-member")!;

  assert.deepEqual(
    [added.x, added.y],
    [NODE_CARD.width + 76, NODE_CARD.height + 28],
    "the first adjacent lane at the nearest depth wins before depth eight"
  );
});

test("global sync reconnects in-bundle members, detaches exits, and adds entries without moving survivors", () => {
  const created = createInstance();
  const manual = movePlacement(created.document, "placement-a-2", { x: 733, y: 411 });
  const beforeGeometry = new Map(manual.placements.map((placement) => [
    placement.placementId,
    [placement.x, placement.y] as const,
  ]));
  const reparentedWithin = TREE.map((item) =>
    item.nodeId === "grandchild" ? source("grandchild", "out-b", "grandchild-v2") : item
  );
  const reconnected = reconcileCanvasDocumentSync(manual, reparentedWithin, {
    authorityDigest: canvasDocumentAuthorityDigest(manual, reparentedWithin)!,
  });
  const grandchild = reconnected.placements.find((placement) => placement.placementId === "placement-a-2")!;
  assert.deepEqual([grandchild.x, grandchild.y], [733, 411]);
  assert.equal(readCanvasSubtreePlacementMeta(grandchild)?.parentPlacementId, "placement-a-3");

  const external = source("external", null);
  const reparentedOut = [...TREE.map((item) =>
    item.nodeId === "grandchild" ? source("grandchild", "external", "grandchild-v3") : item
  ), external];
  const detached = reconcileCanvasDocumentSync(reconnected, reparentedOut, {
    authorityDigest: canvasDocumentAuthorityDigest(reconnected, reparentedOut)!,
  });
  const detachedGrandchild = detached.placements.find((placement) => placement.placementId === "placement-a-2")!;
  assert.equal(readCanvasSubtreePlacementMeta(detachedGrandchild), null);
  assert.deepEqual([detachedGrandchild.x, detachedGrandchild.y], [733, 411]);

  const withNewMember = [...reparentedOut, source("new-direct", "root")];
  let added = 0;
  const expandedMembership = reconcileCanvasDocumentSync(detached, withNewMember, {
    authorityDigest: canvasDocumentAuthorityDigest(detached, withNewMember)!,
    createPlacementId: () => `placement-added-${added++}`,
  });
  for (const placement of manual.placements.filter((item) => item.placementId !== "placement-a-2")) {
    const next = expandedMembership.placements.find((candidate) => candidate.placementId === placement.placementId)!;
    assert.deepEqual([next.x, next.y], beforeGeometry.get(placement.placementId));
  }
  const newMember = expandedMembership.placements.find((placement) => placement.entityRef === "new-direct")!;
  assert.equal(readCanvasSubtreePlacementMeta(newMember)?.instanceId, "instance-a");
  assert.equal(
    deriveCanvasSubtreeProjection(expandedMembership, withNewMember).visiblePlacementIds.includes(newMember.placementId),
    false,
    "a new member under a collapsed root stays hidden until the local branch opens"
  );
});

test("hide preserves exact placement geometry and folded descendants until restored", () => {
  const created = createInstance();
  const expanded = toggleCanvasSubtreeBranch(created.document, "placement-a-0", "right");
  const before = JSON.stringify(expanded.placements);
  const hidden = setCanvasProjectionPlacementHidden(expanded, "placement-a-0", true);
  assert.deepEqual(deriveCanvasSubtreeProjection(hidden, TREE).visiblePlacementIds, []);
  assert.equal(readCanvasProjectionPlacementMeta(hidden.placements[0]).hidden, true);
  const restored = setCanvasProjectionPlacementHidden(hidden, "placement-a-0", false);
  assert.deepEqual(
    restored.placements.map((placement) => ({ ...placement, meta: {
      ...placement.meta,
      tentProjectionPlacement: undefined,
    } })),
    expanded.placements.map((placement) => ({ ...placement, meta: {
      ...placement.meta,
      tentProjectionPlacement: undefined,
    } }))
  );
  assert.equal(JSON.stringify(restored.placements).includes('"hidden":false'), true);
  assert.equal(before.includes('"hidden"'), false);
});

test("projection sync rejects an authority digest race without mutating local layout", () => {
  const created = createInstance();
  const firstAuthority = [...TREE, source("new-child", "root", "new-v1")];
  const digest = canvasDocumentAuthorityDigest(created.document, firstAuthority)!;
  const newerAuthority = firstAuthority.map((item) =>
    item.nodeId === "child-a" ? source("child-a", "root", "child-a-v3") : item
  );
  let reads = 0;
  const rejected = reconcileCanvasDocumentSyncFromLatestAuthority(
    created.document,
    digest,
    () => {
      reads += 1;
      return newerAuthority;
    },
    () => "must-not-create"
  );
  assert.equal(reads, 1, "the mutation boundary must synchronously re-read current authority");
  assert.equal(rejected, created.document);
  assert.equal(rejected.placements.some((placement) => placement.placementId === "must-not-create"), false);
});

test("local movement never changes the authority digest or creates pending sync", () => {
  const created = createInstance();
  const digest = canvasDocumentAuthorityDigest(created.document, TREE);
  const moved = movePlacement(created.document, "placement-a-1", { x: 944, y: 512 });
  assert.equal(canvasDocumentAuthorityDigest(moved, TREE), digest);
  assert.equal(deriveCanvasSubtreeProjection(moved, TREE).documentSync, null);
});

test("one Canvas sync reconciles duplicate instances without cross-linking them", () => {
  const first = createInstance();
  const second = createInstance(first.document, "b");
  const changed = [...TREE, source("new-child", "root")];
  let index = 0;
  const synced = reconcileCanvasDocumentSync(second.document, changed, {
    authorityDigest: canvasDocumentAuthorityDigest(second.document, changed)!,
    createPlacementId: () => `placement-new-${index++}`,
  });
  assert.equal(synced.placements.filter((placement) => placement.entityRef === "new-child").length, 2);
  assert.equal(
    synced.placements.filter((placement) =>
      readCanvasSubtreePlacementMeta(placement)?.instanceId === "instance-b"
    ).length, 5
  );
  assert.equal(deriveCanvasSubtreeProjection(synced, changed).documentSync, null);
});

test("dropping a nested parent creates a complete instance and a leaf stays standalone", () => {
  const created = createInstance();
  const parentTarget = created.document.placements.find((placement) => placement.placementId === "placement-a-1")!;
  const nested = dropPresentationSubtreeOrLeaf(
    { document: created.document, selectedNodeId: null },
    "child-a",
    [source("child-a", "root"), source("grandchild", "child-a")],
    { x: (parentTarget.x ?? 0) + 20, y: (parentTarget.y ?? 0) + 20 }
  );
  const nestedInstanceIds = new Set(nested.document.placements.flatMap((placement) => {
    const meta = readCanvasSubtreePlacementMeta(placement);
    return meta ? [meta.instanceId] : [];
  }));
  assert.equal(nestedInstanceIds.size, 2);
  const newInstanceId = [...nestedInstanceIds].find((instanceId) => instanceId !== "instance-a")!;
  assert.equal(nested.document.placements.filter((placement) =>
    readCanvasSubtreePlacementMeta(placement)?.instanceId === newInstanceId
  ).length, 2);

  const rootTarget = created.document.placements.find((placement) => placement.placementId === "placement-a-0")!;
  const standaloneLeaf = dropPresentationSubtreeOrLeaf(
    { document: created.document, selectedNodeId: null },
    "leaf",
    [source("leaf", "root")],
    { x: (rootTarget.x ?? 0) + 20, y: (rootTarget.y ?? 0) + 20 }
  );
  const leaf = standaloneLeaf.document.placements.find((placement) => placement.entityRef === "leaf")!;
  assert.equal(readCanvasSubtreePlacementMeta(leaf), null);
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
