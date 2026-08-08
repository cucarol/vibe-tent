import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveOutlineReveal,
  type OutlineRevealRequest,
} from "../src/desktop/renderer-next/model/outline-reveal.js";
import type { WorkbenchNodeView } from "../src/desktop/renderer-next/shell/workbench-types.js";

const base = {
  etag: "etag",
  tags: [] as string[],
  mode: "editable" as const,
  archived: false,
  invalid: false,
  projectionState: "ready" as const,
};

const nodes: WorkbenchNodeView[] = [
  { ...base, nodeId: "root", path: "root", name: "Root", type: "goal", parentNodeId: null, hasChildren: true, depth: 0 },
  { ...base, nodeId: "branch", path: "branch", name: "Branch", type: "prompt", parentNodeId: "root", hasChildren: true, depth: 1 },
  { ...base, nodeId: "leaf", path: "leaf", name: "Leaf", type: "output", parentNodeId: "branch", hasChildren: false, depth: 2 },
];

function resolve(
  reveal: OutlineRevealRequest,
  options: {
    visible?: boolean;
    handledRevision?: number;
    expandedNodeIds?: ReadonlySet<string>;
    pendingFocus?: OutlineRevealRequest | null;
  } = {}
) {
  return resolveOutlineReveal({
    nodes,
    expandedNodeIds: options.expandedNodeIds ?? new Set<string>(),
    reveal,
    visible: options.visible ?? true,
    handledRevision: options.handledRevision ?? 0,
    pendingFocus: options.pendingFocus ?? null,
  });
}

test("visible Canvas reveal expands authoritative ancestors and queues the exact item", () => {
  const result = resolve({ nodeId: "leaf", revision: 1 });

  assert.deepEqual([...result.expandedNodeIds], ["root", "branch"]);
  assert.deepEqual(result.pendingFocus, { nodeId: "leaf", revision: 1 });
  assert.equal(result.handledRevision, 1);
  assert.equal(result.shouldShowNodes, true);
});

test("hidden reveal is consumed without opening, expanding, or retaining focus", () => {
  const result = resolve(
    { nodeId: "leaf", revision: 4 },
    { visible: false, expandedNodeIds: new Set(["root"]) }
  );

  assert.deepEqual([...result.expandedNodeIds], ["root"]);
  assert.equal(result.pendingFocus, null);
  assert.equal(result.handledRevision, 4);
  assert.equal(result.shouldShowNodes, false);

  const reopened = resolve({ nodeId: "leaf", revision: 4 }, {
    handledRevision: result.handledRevision,
    expandedNodeIds: result.expandedNodeIds,
  });
  assert.equal(reopened.pendingFocus, null);
  assert.equal(reopened.shouldShowNodes, false);
});

test("newer reveal revisions replace older focus work and stale revisions are ignored", () => {
  const first = resolve({ nodeId: "branch", revision: 1 });
  const latest = resolve({ nodeId: "leaf", revision: 2 }, {
    handledRevision: first.handledRevision,
    expandedNodeIds: first.expandedNodeIds,
  });
  const stale = resolve({ nodeId: "branch", revision: 1 }, {
    handledRevision: latest.handledRevision,
    expandedNodeIds: latest.expandedNodeIds,
    pendingFocus: latest.pendingFocus,
    visible: true,
  });

  assert.deepEqual(latest.pendingFocus, { nodeId: "leaf", revision: 2 });
  assert.equal(stale.pendingFocus, latest.pendingFocus);
  assert.equal(stale.handledRevision, 2);
});
