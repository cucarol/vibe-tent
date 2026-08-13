import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import type { FsAdapter } from "../src/core/adapter.js";
import { dispatch } from "../src/core/ops.js";
import { loadTaskRecord } from "../src/core/task.js";
import { loadTaskResult } from "../src/core/task-result.js";
import { taskAccept, taskClaim, taskReject, taskSubmit, taskWait } from "../src/core/task-lifecycle.js";
import { makeTent } from "./helpers.js";

class CrashAfterIntentFs extends NodeFs {
  private tripped = false;
  override async writeFile(path: string, content: string): Promise<void> {
    await super.writeFile(path, content);
    if (!this.tripped && path.endsWith(".result-accept-intent.json")) {
      this.tripped = true;
      throw new Error("simulated crash after accept intent");
    }
  }
}

function env(root: string, fs: FsAdapter = new NodeFs(root)) {
  return { fs, clock: { now: () => "2026-08-13T00:00:00.000Z" }, tentName: "intent", tentRoot: root };
}

async function fixture() {
  const root = await makeTent();
  const base = env(root);
  const dispatched = await dispatch(base as any, "cx-p1", {
    workNodeIds: ["cx-p1"], contextNodeIds: [], prompt: "review", requester: { kind: "user", id: "user" }, executionSessionId: "ss-executor",
  });
  await taskClaim(base as any, dispatched.taskPath);
  const submitted = await taskSubmit(base as any, dispatched.taskPath, { report: "immutable result", commits: [] });
  return { root, base, taskPath: dispatched.taskPath, result: submitted.result };
}

test("accept intent crash forward-recovers the exact Result", async () => {
  const f = await fixture();
  const crashing = env(f.root, new CrashAfterIntentFs(f.root));
  await assert.rejects(() => taskAccept(crashing as any, f.taskPath, { actor: "user", resultId: f.result.id }), /simulated crash/);
  const accepted = await taskAccept(f.base as any, f.taskPath, { actor: "user", resultId: f.result.id });
  assert.equal(accepted.task.state, "accepted");
  assert.equal(accepted.result.status, "accepted");
  assert.equal((await loadTaskRecord(f.base.fs, f.taskPath)).currentResultId, f.result.id);
  assert.equal((await loadTaskResult(f.base.fs, f.result.path)).status, "accepted");
});

test("reject after a committed accept intent converges accept first", async () => {
  const f = await fixture();
  const crashing = env(f.root, new CrashAfterIntentFs(f.root));
  await assert.rejects(() => taskAccept(crashing as any, f.taskPath, { actor: "user", resultId: f.result.id }));
  await assert.rejects(() => taskReject(f.base as any, f.taskPath, { actor: "user", resultId: f.result.id, resume: true }), /Invalid task transition/);
  assert.equal((await loadTaskResult(f.base.fs, f.result.path)).status, "accepted");
});

test("mismatched retry never changes the committed Result", async () => {
  const f = await fixture();
  const crashing = env(f.root, new CrashAfterIntentFs(f.root));
  await assert.rejects(() => taskAccept(crashing as any, f.taskPath, { actor: "user", resultId: f.result.id }));
  await assert.rejects(() => taskAccept(f.base as any, f.taskPath, { actor: "role-reviewer", resultId: f.result.id }));
  const task = await loadTaskRecord(f.base.fs, f.taskPath);
  const result = await loadTaskResult(f.base.fs, f.result.path);
  assert.equal(task.state, "accepted");
  assert.equal(result.status, "accepted");
  await assert.rejects(() => taskWait(f.base as any, f.taskPath, { reason: "external", summary: "terminal" }));
});
