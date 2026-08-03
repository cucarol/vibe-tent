import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskNodeSelectionError,
  normalizeTaskNodeSelection,
  orderedTaskNodeIds,
  taskCanWriteNode,
  taskReferencesNode,
} from "../src/core/task-node-selection.js";

const WORK_A = "cx-worka";
const WORK_B = "cx-workb";
const CONTEXT = "cx-context";

test("Task Node selection preserves ordered work then context refs", () => {
  const selection = normalizeTaskNodeSelection({
    workNodeIds: [WORK_A, WORK_B],
    contextNodeIds: [CONTEXT],
  });
  assert.deepEqual(orderedTaskNodeIds(selection), [WORK_A, WORK_B, CONTEXT]);
  assert.equal(taskCanWriteNode(selection, WORK_B), true);
  assert.equal(taskCanWriteNode(selection, CONTEXT), false);
  assert.equal(taskReferencesNode(selection, CONTEXT), true);
});

test("Task Node selection requires at least one writable Node", () => {
  assert.throws(
    () => normalizeTaskNodeSelection({ workNodeIds: [], contextNodeIds: [CONTEXT] }),
    TaskNodeSelectionError
  );
});

test("Task Node selection rejects duplicates, overlap, aliases, and unknown fields", () => {
  const invalid: unknown[] = [
    { workNodeIds: [WORK_A, WORK_A], contextNodeIds: [] },
    { workNodeIds: [WORK_A], contextNodeIds: [WORK_A] },
    { workNodeIds: ["CX-WORKA"], contextNodeIds: [] },
    { workNodeIds: [` ${WORK_A}`], contextNodeIds: [] },
    { workNodeIds: [WORK_A], contextNodeIds: [], nodes: [WORK_B] },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeTaskNodeSelection(value), TaskNodeSelectionError);
  }
});
