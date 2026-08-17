import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskNodeSelectionError,
  normalizeTaskNodeSelection,
  orderedTaskNodeIds,
  taskReferencesNode,
} from "../src/core/task-node-selection.js";

const NODE_A = "cx-worka";
const NODE_B = "cx-workb";
const NODE_C = "cx-context";

test("Task Node selection preserves ordered Node refs", () => {
  const selection = normalizeTaskNodeSelection({
    nodeIds: [NODE_A, NODE_B, NODE_C],
  });
  assert.deepEqual(orderedTaskNodeIds(selection), [NODE_A, NODE_B, NODE_C]);
  assert.equal(taskReferencesNode(selection, NODE_C), true);
});

test("Task Node selection allows prompt-only empty refs", () => {
  assert.deepEqual(orderedTaskNodeIds(normalizeTaskNodeSelection({ nodeIds: [] })), []);
});

test("Task Node selection rejects duplicates, noncanonical ids, and unknown fields", () => {
  const invalid: unknown[] = [
    { nodeIds: [NODE_A, NODE_A] },
    { nodeIds: ["CX-WORKA"] },
    { nodeIds: [` ${NODE_A}`] },
    { nodeIds: [NODE_A], nodes: [NODE_B] },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeTaskNodeSelection(value), TaskNodeSelectionError);
  }
});
