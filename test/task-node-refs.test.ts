import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listDirectActiveTasksForNode,
  MISSING_TASK_NODE_SELECTION,
  sortTasksDeterministically,
  taskDirectlyReferencesNode,
  taskReferencedNodeIds,
  type TaskNodeRefSource,
} from "../src/core/task-node-refs.js";

function task(
  id: string,
  nodeIds: string[],
  state: TaskNodeRefSource["state"] = "queued",
  createdAt = `2026-08-01T00:00:00.${id.slice(-3)}Z`
): TaskNodeRefSource {
  return { id, state, nodeIds, createdAt, path: `tasks/${id}.md` };
}

test("Task node refs preserve exact ordered nodeIds", () => {
  const value = task("tk-order", ["cx-worka", "cx-workb", "cx-contexta"]);
  assert.deepEqual(taskReferencedNodeIds(value), ["cx-worka", "cx-workb", "cx-contexta"]);
  assert.equal(taskDirectlyReferencesNode(value, "cx-contexta"), true);
});

test("canonical selection is strict and prompt-only empty refs round-trip", () => {
  assert.deepEqual(taskReferencedNodeIds(task("tk-empty", [])), []);
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-missing", state: "queued" } as TaskNodeRefSource),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(MISSING_TASK_NODE_SELECTION) &&
      error.message.includes("tk-missing")
  );
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-overlap", state: "queued", nodeIds: ["cx-work", "cx-work"] }),
    /MISSING_TASK_NODE_SELECTION/
  );
});

test("all in-flight Tasks referencing the same node are returned in deterministic order", () => {
  const early = task("tk-early", ["cx-work"], "running", "2026-08-01T00:00:00.000Z");
  const late = task("tk-late", ["cx-work"], "submitted", "2026-08-01T00:00:01.000Z");
  const terminal = task("tk-done", ["cx-work"], "accepted", "2026-08-01T00:00:02.000Z");
  assert.deepEqual(sortTasksDeterministically([late, early]), [early, late]);
  assert.deepEqual(listDirectActiveTasksForNode("cx-work", [terminal, late, early]), [early, late]);
});
