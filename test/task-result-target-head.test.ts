import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { createTaskResult, loadTaskResult } from "../src/core/task-result.js";
import { dispatch } from "../src/core/ops.js";
import { taskAccept, taskClaim, taskSubmit } from "../src/core/task-lifecycle.js";
import { makeTent } from "./helpers.js";

const clock = { now: () => "2026-08-13T00:00:00.000Z" };

test("Result targetHead round-trips only with commit-bearing payload", async () => {
  const root = await makeTent();
  const fs = new NodeFs(root);
  const result = await createTaskResult(fs, clock, {
    taskId: "tk-targethead", resultsDir: "temp/sessions/ss-executor/results", report: "source result",
    commits: ["a".repeat(40)], targetHead: "b".repeat(40),
  });
  assert.equal((await loadTaskResult(fs, result.path)).targetHead, "b".repeat(40));
  const zero = await createTaskResult(fs, clock, {
    taskId: "tk-zerohead", resultsDir: "temp/sessions/ss-executor/results", report: "zero commit", commits: [],
  });
  assert.equal((await loadTaskResult(fs, zero.path)).targetHead, undefined);
});

test("exact ready Result keeps immutable targetHead through acceptance", async () => {
  const root = await makeTent();
  const e = { fs: new NodeFs(root), clock, tentName: "target", tentRoot: root };
  const d = await dispatch(e as any, {
    nodeIds: ["cx-p1"],
    prompt: "git authority",
    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-executor",
  });
  await taskClaim(e as any, d.taskPath);
  const submitted = await taskSubmit(e as any, d.taskPath, { report:"commit", commits:["a".repeat(40)], targetHead:"b".repeat(40) });
  const accepted = await taskAccept(e as any, d.taskPath, {
    actor:"user", resultId:submitted.result.id, integrate: async (commits) => assert.deepEqual(commits, ["a".repeat(40)]),
  });
  assert.equal(accepted.result.targetHead, "b".repeat(40));
  assert.deepEqual(accepted.result.commits, ["a".repeat(40)]);
});
