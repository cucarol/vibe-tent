import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { CanvasDocument, CanvasPlacement } from "../src/desktop/renderer-next/types/identity.js";
import { movePlacement, NODE_CARD } from "../src/desktop/renderer-next/model/canvas-document.js";
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
import { dropPresentationSubtreeOrLeaf } from "../src/desktop/renderer-next/shell/workbench-presentation.js";

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

type Segment = { from: { x: number; y: number }; to: { x: number; y: number } };

function pathSegments(path: string): Segment[] {
  const tokens = path.match(/[MHV]|-?\d+(?:\.\d+)?/g) ?? [];
  const segments: Segment[] = [];
  let index = 0;
  let point = { x: 0, y: 0 };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M") {
      point = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
      continue;
    }
    const next = command === "H"
      ? { x: Number(tokens[index++]), y: point.y }
      : { x: point.x, y: Number(tokens[index++]) };
    segments.push({ from: point, to: next });
    point = next;
  }
  return segments;
}

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

function assertPathAvoidsPlacements(path: string, placements: readonly CanvasPlacement[]): void {
  const segments = pathSegments(path);
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
    syncControls: [],
  };
  const blockedDiagnostics = { segmentRectChecks: 0 };
  const blocked = deriveCanvasSubtreeStructureBranches(
    document,
    projection,
    null,
    blockedDiagnostics
  )[0]?.path;
  assert.match(blocked ?? "", /^M 240 52 /);
  assertPathAvoidsPlacements(blocked ?? "", [document.placements[2]]);
  assert.ok(blockedDiagnostics.segmentRectChecks <= 64);

  const movedObstacle = {
    ...document,
    placements: document.placements.map((placement) =>
      placement.placementId === "obstacle" ? { ...placement, y: 180 } : placement
    ),
  };
  const clear = deriveCanvasSubtreeStructureBranches(movedObstacle, projection)[0]?.path;
  assert.equal(clear, "M 240 52 H 600");

  const movedEndpoint = {
    ...movedObstacle,
    placements: movedObstacle.placements.map((placement) =>
      placement.placementId === "child" ? { ...placement, y: 300 } : placement
    ),
  };
  const rerouted = deriveCanvasSubtreeStructureBranches(movedEndpoint, projection)[0]?.path;
  assert.notEqual(rerouted, clear);
  assert.match(rerouted ?? "", /^M 240 52 (?:H|V)/);
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
    syncControls: [],
  };
  const diagnostics = { segmentRectChecks: 0, visibilityNodesExpanded: 0 };
  const branches = deriveCanvasSubtreeStructureBranches(
    { ...emptyDocument(), placements },
    projection,
    null,
    diagnostics
  );
  assert.equal(branches.length, 1);
  assertPathAvoidsPlacements(branches[0].path, placements.slice(2));
  assert.ok(pathSegments(branches[0].path).length > 3);

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
  assertPathAvoidsPlacements(dense[0].path, densePlacements.slice(2));
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
    syncControls: [],
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
      syncControls: [],
    },
    null,
    diagnostics
  );
  assert.equal(branches.length, 24);
  assert.equal(diagnostics.segmentRectChecks, 24 * 46);
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
      syncControls: [],
    },
    null,
    diagnostics
  );
  const elapsed = performance.now() - startedAt;
  assert.equal(branches.length, 24);
  assert.ok(diagnostics.visibilityNodesExpanded > 0);
  for (const branch of branches) {
    const relationship = relationships.find((candidate) => `branch:${candidate.id}` === branch.id)!;
    assertPathAvoidsPlacements(
      branch.path,
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
    syncControls: [],
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

test("dropping a nested parent always creates a complete instance while a leaf may join", () => {
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
  const joinedLeaf = dropPresentationSubtreeOrLeaf(
    { document: created.document, selectedNodeId: null },
    "leaf",
    [source("leaf", "root")],
    { x: (rootTarget.x ?? 0) + 20, y: (rootTarget.y ?? 0) + 20 }
  );
  const leaf = joinedLeaf.document.placements.find((placement) => placement.entityRef === "leaf")!;
  assert.equal(readCanvasSubtreePlacementMeta(leaf)?.instanceId, "instance-a");
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
