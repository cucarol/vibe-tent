import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskNodeOccupiedError,
  assertTaskWorkNodesAvailable,
  listActiveTaskOccupants,
  taskOccupiesNode,
  taskReadsNode,
  type TaskNodeOccupationSource,
} from "../src/core/task-node-occupation.js";

function task(
  id: string,
  workNodeIds: string[],
  contextNodeIds: string[] = [],
  state: TaskNodeOccupationSource["state"] = "running"
): TaskNodeOccupationSource {
  return { id, state, workNodeIds, contextNodeIds };
}

test("only active work refs occupy; context refs remain shared", () => {
  const active = task("tk-active", ["cx-work"], ["cx-shared"]);
  const terminal = task("tk-done", ["cx-work"], [], "accepted");
  assert.equal(taskOccupiesNode(active, "cx-work"), true);
  assert.equal(taskOccupiesNode(active, "cx-shared"), false);
  assert.equal(taskReadsNode(active, "cx-shared"), true);
  assert.equal(taskOccupiesNode(terminal, "cx-work"), false);
  assert.doesNotThrow(() =>
    assertTaskWorkNodesAvailable(
      { workNodeIds: ["cx-other"], contextNodeIds: ["cx-work"] },
      [active]
    )
  );
});

test("one Task may occupy multiple Nodes while each exact Node has one active owner", () => {
  const owner = task("tk-owner", ["cx-parent", "cx-childa"]);
  assert.deepEqual(listActiveTaskOccupants("cx-childa", [owner]), [owner]);
  assert.throws(
    () =>
      assertTaskWorkNodesAvailable(
        { workNodeIds: ["cx-childa", "cx-childb"], contextNodeIds: [] },
        [owner]
      ),
    (error: unknown) =>
      error instanceof TaskNodeOccupiedError &&
      error.nodeId === "cx-childa" &&
      error.taskId === "tk-owner"
  );
});

test("parent and child Nodes do not imply a subtree lock", () => {
  const parent = task("tk-parent", ["cx-parent"]);
  assert.doesNotThrow(() =>
    assertTaskWorkNodesAvailable(
      { workNodeIds: ["cx-child"], contextNodeIds: ["cx-parent"] },
      [parent]
    )
  );
  assert.throws(
    () =>
      assertTaskWorkNodesAvailable(
        { workNodeIds: ["cx-parent"], contextNodeIds: [] },
        [parent]
      ),
    TaskNodeOccupiedError
  );
});

test("same Task id may revalidate its own occupation", () => {
  const current = task("tk-current", ["cx-work"]);
  assert.doesNotThrow(() =>
    assertTaskWorkNodesAvailable(
      { workNodeIds: ["cx-work"], contextNodeIds: [] },
      [current],
      current.id
    )
  );
});
