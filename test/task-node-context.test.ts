import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskNodeContextError,
  normalizeTaskNodeContext,
} from "../src/core/task-node-context.js";

function snapshot(id: string) {
  return {
    id,
    path: `Nodes/${id}`,
    type: "reference",
    archived: false,
    tags: [],
    body: `${id} frozen body`,
    etag: "a".repeat(24),
  };
}

test("Task Node context binds ordered snapshots to nodeIds authority", () => {
  const value = {
    nodeIds: ["cx-work", "cx-context"],
    nodeSnapshots: [snapshot("cx-work"), snapshot("cx-context")],
  };
  assert.deepEqual(normalizeTaskNodeContext(value), value);
});

test("Task Node context rejects reordered, missing, and extra snapshots", () => {
  const invalid: unknown[] = [
    {
      nodeIds: ["cx-work", "cx-context"],
      nodeSnapshots: [snapshot("cx-context"), snapshot("cx-work")],
    },
    {
      nodeIds: ["cx-work", "cx-context"],
      nodeSnapshots: [snapshot("cx-work")],
    },
    {
      nodeIds: ["cx-work"],
      nodeSnapshots: [snapshot("cx-work")],
      refs: { nodes: ["cx-work"] },
    },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeTaskNodeContext(value), TaskNodeContextError);
  }
});
