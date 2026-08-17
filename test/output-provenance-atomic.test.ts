import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createNode, dispatch } from "../src/core/ops.js";
import { nodeNotePath, loadTent } from "../src/core/tree.js";
import { loadTaskRecord } from "../src/core/task.js";
import { taskAccept, taskClaim, taskSubmit } from "../src/core/task-lifecycle.js";
import { makeTent } from "./helpers.js";

function env(dir: string) {
  return { fs: new NodeFs(dir), clock: { now: () => "2026-08-13T00:00:00.000Z" }, tentName: "wqb", tentRoot: dir };
}

async function readyResult(dir: string) {
  const e = env(dir);
  const dispatched = await dispatch(e as any, {
    nodeIds: ["cx-p1"],
    prompt: "publish",
    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-executor",
  });
  await taskClaim(e as any, dispatched.taskPath);
  const submitted = await taskSubmit(e as any, dispatched.taskPath, { report: "formal result", artifactRefs: [{ kind: "path", target: "out.txt" }] });
  return { e, taskPath: dispatched.taskPath, result: submitted.result };
}

test("accept never binds or mutates Output Nodes", async () => {
  const dir = await makeTent();
  const e = env(dir);
  const outputId = await createNode(e as any, { parentPath: "output", name: "unbound", type: "output" });
  const output = (await loadTent(e.fs)).byId.get(outputId)!;
  const before = await e.fs.readFile(nodeNotePath(output.path));
  const { taskPath, result } = await readyResult(dir);

  const accepted = await taskAccept(e as any, taskPath, { actor: "user", resultId: result.id });
  assert.equal(accepted.task.state, "accepted");
  assert.equal(accepted.result.status, "accepted");
  assert.equal(await e.fs.readFile(nodeNotePath(output.path)), before);
});

test("Task Result keeps normalized artifact refs; Output is not a second provenance source", async () => {
  const dir = await makeTent();
  const { taskPath, result, e } = await readyResult(dir);
  assert.deepEqual(result.artifactRefs, [{ kind: "path", target: "out.txt" }]);
  const task = await loadTaskRecord(e.fs, taskPath);
  assert.equal(task.currentResultId, result.id);
});
