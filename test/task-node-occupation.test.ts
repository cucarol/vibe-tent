import assert from "node:assert/strict";
import { test } from "node:test";
import { isActiveTaskState } from "../src/core/task-model.js";
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
  workNodeIds: string[],
  contextNodeIds: string[] = [],
  state: TaskNodeRefSource["state"] = "queued",
  createdAt = `2026-08-01T00:00:00.${id.slice(-3)}Z`
): TaskNodeRefSource {
  return { id, state, workNodeIds, contextNodeIds, createdAt, path: `tasks/${id}.md` };
}

test("Task references preserve work-then-context order", () => {
  const value = task("tk-order", ["cx-worka", "cx-workb"], ["cx-contexta"]);
  assert.deepEqual(taskReferencedNodeIds(value), ["cx-worka", "cx-workb", "cx-contexta"]);
});

test("context Nodes are shared read context and never occupy", () => {
  const contextOnly = task("tk-context", ["cx-other"], ["cx-shared"]);
  assert.equal(taskDirectlyReferencesNode(contextOnly, "cx-shared"), false);
  assert.equal(taskDirectlyReferencesNode(contextOnly, "cx-other"), true);
  assert.deepEqual(listDirectActiveTasksForNode("cx-shared", [contextOnly]), []);
  assert.deepEqual(listDirectActiveTasksForNode("cx-other", [contextOnly]), [contextOnly]);
});

test("only active Tasks occupy their work Nodes", () => {
  const activeStates = ["queued", "running", "waiting", "delivered"] as const;
  for (const state of activeStates) {
    const active = task(`tk-${state}`, ["cx-work"], [], state);
    assert.deepEqual(listDirectActiveTasksForNode("cx-work", [active]), [active]);
    assert.equal(isActiveTaskState(state), true);
  }

  for (const state of ["accepted", "rejected", "interrupted", "failed"] as const) {
    const terminal = task(`tk-${state}`, ["cx-work"], [], state);
    assert.deepEqual(listDirectActiveTasksForNode("cx-work", [terminal]), []);
    assert.equal(isActiveTaskState(state), false);
  }
});

test("multiple work Nodes are all exclusive and parent/child remain independent", () => {
  const multi = task("tk-multi", ["cx-parent", "cx-child"], ["cx-sibling"]);
  const other = task("tk-other", ["cx-sibling"]);

  assert.deepEqual(listDirectActiveTasksForNode("cx-parent", [multi, other]), [multi]);
  assert.deepEqual(listDirectActiveTasksForNode("cx-child", [multi, other]), [multi]);
  assert.deepEqual(listDirectActiveTasksForNode("cx-sibling", [multi, other]), [other]);
});

test("canonical selection is strict and never falls back to legacy refs", () => {
  assert.throws(
    () => taskReferencedNodeIds({ id: "tk-missing", state: "queued" } as TaskNodeRefSource),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(MISSING_TASK_NODE_SELECTION) &&
      error.message.includes("tk-missing")
  );
  assert.throws(
    () =>
      taskReferencedNodeIds({
        id: "tk-legacy",
        state: "queued",
        contextCard: { refs: { nodes: [{ id: "cx-old" }] } },
      } as unknown as TaskNodeRefSource),
    /MISSING_TASK_NODE_SELECTION/
  );
  assert.throws(
    () => taskReferencedNodeIds({
      id: "tk-empty",
      state: "queued",
      workNodeIds: [],
      contextNodeIds: [],
    }),
    /MISSING_TASK_NODE_SELECTION/
  );
  assert.throws(
    () => taskReferencedNodeIds({
      id: "tk-overlap",
      state: "queued",
      workNodeIds: ["cx-work"],
      contextNodeIds: ["cx-work"],
    }),
    /MISSING_TASK_NODE_SELECTION/
  );
});

test("active Task ordering is deterministic", () => {
  const early = task("tk-early", ["cx-work"], [], "running", "2026-08-01T00:00:00.000Z");
  const late = task("tk-late", ["cx-work"], [], "running", "2026-08-01T00:00:01.000Z");
  assert.deepEqual(sortTasksDeterministically([late, early]), [early, late]);
});
