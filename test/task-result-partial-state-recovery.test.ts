import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { dispatch } from "../src/core/ops.js";
import { loadTaskRecord, patchTaskRecord } from "../src/core/task.js";
import { loadTaskResult, writeTaskResult } from "../src/core/task-result.js";
import { taskAccept, taskClaim, taskReject, taskSubmit, taskWait } from "../src/core/task-lifecycle.js";
import { makeTent } from "./helpers.js";

type SubmitBoundary = "intent-write" | "result-write" | "task-write" | "intent-remove";
class SubmitBoundaryFaultFs extends NodeFs {
  private faulted = false;
  constructor(
    root: string,
    private readonly boundary: SubmitBoundary,
    private readonly timing: "before" | "after"
  ) { super(root); }
  private matchesWrite(path: string, content: string): boolean {
    if (this.boundary === "intent-write") return path.endsWith(".result-submit-intent.json");
    if (this.boundary === "result-write") return path.includes("/results/") && content.includes("type: task-result");
    return this.boundary === "task-write" && path.includes("/tasks/") && content.includes("state: submitted");
  }
  override async writeFile(path: string, content: string): Promise<void> {
    const matches = !this.faulted && this.matchesWrite(path.replace(/\\/g, "/"), content);
    if (matches && this.timing === "before") {
      this.faulted = true;
      throw new Error(`simulated ${this.boundary} before`);
    }
    await super.writeFile(path, content);
    if (matches && this.timing === "after") {
      this.faulted = true;
      throw new Error(`simulated ${this.boundary} after`);
    }
  }
  override async remove(path: string): Promise<void> {
    const matches = !this.faulted && this.boundary === "intent-remove" && path.endsWith(".result-submit-intent.json");
    if (matches && this.timing === "before") {
      this.faulted = true;
      throw new Error("simulated intent-remove before");
    }
    await super.remove(path);
    if (matches && this.timing === "after") {
      this.faulted = true;
      throw new Error("simulated intent-remove after");
    }
  }
}
function env(root: string, fs = new NodeFs(root)) { return { fs, clock: { now: () => "2026-08-13T00:00:00.000Z" }, tentName: "partial", tentRoot: root }; }
async function fixture() {
  const root = await makeTent(); const e = env(root);
  const d = await dispatch(e as any, {
    nodeIds: ["cx-p1"],
    prompt: "result",
    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-executor",
  });
  await taskClaim(e as any, d.taskPath);
  return { root, e, taskPath: d.taskPath };
}

for (const boundary of ["intent-write", "result-write", "task-write", "intent-remove"] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`submit intent converges ${boundary} ${timing} failure by exact retry`, async () => {
      const f = await fixture();
      const crash = env(f.root, new SubmitBoundaryFaultFs(f.root, boundary, timing));
      await assert.rejects(
        () => taskSubmit(crash as any, f.taskPath, { report: "WAL first", commits: ["a".repeat(40)], targetHead: "c".repeat(40) }),
        /simulated/
      );
      const partial = await loadTaskRecord(f.e.fs, f.taskPath);
      if (boundary === "intent-write" && timing === "before") {
        assert.equal(partial.state, "running");
        assert.equal(partial.currentResultId, undefined);
      } else if (!(boundary === "intent-remove" && timing === "after")) {
        await assert.rejects(
          () => taskWait(f.e as any, f.taskPath, { reason: "external", summary: "must not bypass publication" }),
          /publication is incomplete|retry the exact task\.submit/
        );
      }
      const recovered = await taskSubmit(f.e as any, f.taskPath, {
        report: "WAL first",
        commits: ["a".repeat(40)],
        targetHead: "c".repeat(40),
      });
      assert.equal(recovered.task.state, "submitted");
      assert.equal(recovered.task.currentResultId, recovered.result.id);
      assert.equal(recovered.result.status, "ready");
      assert.equal((await loadTaskResult(f.e.fs, recovered.result.path)).report, "WAL first");
      assert.equal(await f.e.fs.exists(f.taskPath.replace(/\.md$/, ".result-submit-intent.json")), false);
    });
  }
}

test("different submit cannot replace a persisted publication intent", async () => {
  const f = await fixture();
  const crash = env(f.root, new SubmitBoundaryFaultFs(f.root, "result-write", "before"));
  await assert.rejects(
    () => taskSubmit(crash as any, f.taskPath, { report: "candidate A", commits: ["a".repeat(40)], targetHead: "c".repeat(40) }),
    /simulated result-write before/
  );
  const intentPath = f.taskPath.replace(/\.md$/, ".result-submit-intent.json");
  const beforeTask = await f.e.fs.readFile(f.taskPath);
  const beforeIntent = await f.e.fs.readFile(intentPath);
  const beforeRows = await (await import("../src/core/task-result.js")).loadTaskResults(f.e.fs);
  await assert.rejects(
    () => taskSubmit(f.e as any, f.taskPath, { report: "candidate B", commits: ["b".repeat(40)], targetHead: "c".repeat(40) }),
    /differs from the persisted Result publication/
  );
  assert.equal(await f.e.fs.readFile(f.taskPath), beforeTask);
  assert.equal(await f.e.fs.readFile(intentPath), beforeIntent);
  assert.deepEqual(await (await import("../src/core/task-result.js")).loadTaskResults(f.e.fs), beforeRows);
});

test("different submit cannot mutate an existing exact Result candidate", async () => {
  const f = await fixture();
  const submitted = await taskSubmit(f.e as any, f.taskPath, {
    report: "candidate A",
    commits: ["a".repeat(40)],
    targetHead: "c".repeat(40),
  });
  await patchTaskRecord(f.e.fs, f.taskPath, {
    state: "running",
    currentResultId: submitted.result.id,
  });
  const beforeTask = await f.e.fs.readFile(f.taskPath);
  const beforeResult = await f.e.fs.readFile(submitted.result.path);
  await assert.rejects(
    () => taskSubmit(f.e as any, f.taskPath, {
      report: "candidate B",
      commits: ["b".repeat(40)],
      targetHead: "c".repeat(40),
    }),
    /conflicts with Task|candidate differs from this task\.submit retry/
  );
  assert.equal(await f.e.fs.readFile(f.taskPath), beforeTask);
  assert.equal(await f.e.fs.readFile(submitted.result.path), beforeResult);
});

test("submit intent rejects a noncanonical uppercase Task identity without mutation", async () => {
  const f = await fixture();
  const crash = env(f.root, new SubmitBoundaryFaultFs(f.root, "result-write", "before"));
  await assert.rejects(
    () => taskSubmit(crash as any, f.taskPath, { report: "candidate", commits: [] }),
    /simulated result-write before/
  );
  const intentPath = f.taskPath.replace(/\.md$/, ".result-submit-intent.json");
  const intent = JSON.parse(await f.e.fs.readFile(intentPath)) as Record<string, unknown>;
  intent.taskId = String(intent.taskId).toUpperCase();
  await f.e.fs.writeFile(intentPath, JSON.stringify(intent, null, 2) + "\n");
  const beforeTask = await f.e.fs.readFile(f.taskPath);
  const beforeIntent = await f.e.fs.readFile(intentPath);
  await assert.rejects(
    () => taskSubmit(f.e as any, f.taskPath, { report: "candidate", commits: [] }),
    /Invalid exact-Task submit recovery intent/
  );
  assert.equal(await f.e.fs.readFile(f.taskPath), beforeTask);
  assert.equal(await f.e.fs.readFile(intentPath), beforeIntent);
});

test("accept and reject cannot publish a Result-only partial submit", async () => {
  const f = await fixture();
  const crash = env(f.root, new SubmitBoundaryFaultFs(f.root, "task-write", "before"));
  await assert.rejects(
    () => taskSubmit(crash as any, f.taskPath, { report: "review after crash" }),
    /simulated task-write before/
  );
  const [result] = await (await import("../src/core/task-result.js")).loadTaskResults(f.e.fs);
  assert.ok(result);
  const intentPath = f.taskPath.replace(/\.md$/, ".result-submit-intent.json");
  const beforeTask = await f.e.fs.readFile(f.taskPath);
  const beforeResult = await f.e.fs.readFile(result.path);
  const beforeIntent = await f.e.fs.readFile(intentPath);
  for (const review of [
    () => taskAccept(f.e as any, f.taskPath, { actor: "user", resultId: result.id }),
    () => taskReject(f.e as any, f.taskPath, { actor: "user", resultId: result.id }),
  ]) {
    await assert.rejects(review, /retry the exact task\.submit request/);
    assert.equal(await f.e.fs.readFile(f.taskPath), beforeTask);
    assert.equal(await f.e.fs.readFile(result.path), beforeResult);
    assert.equal(await f.e.fs.readFile(intentPath), beforeIntent);
  }
  const submitted = await taskSubmit(f.e as any, f.taskPath, { report: "review after crash" });
  assert.equal(submitted.task.state, "submitted");
  assert.equal(submitted.task.currentResultId, result.id);
  assert.equal(await f.e.fs.exists(intentPath), false);
});

async function loadTaskResultFor(fs: NodeFs, resultId: string) {
  const taskResults = await import("../src/core/task-result.js");
  const rows = await taskResults.loadTaskResults(fs);
  const row = rows.find((candidate) => candidate.id === resultId);
  assert.ok(row);
  return row;
}

test("accepted Result repairs a submitted Task with the exact currentResultId", async () => {
  const f = await fixture();
  const submitted = await taskSubmit(f.e as any, f.taskPath, { report:"ready" });
  await taskAccept(f.e as any, f.taskPath, { actor:"user", resultId: submitted.result.id });
  await patchTaskRecord(f.e.fs, f.taskPath, { state:"submitted", currentResultId: submitted.result.id });
  await assert.rejects(() => taskWait(f.e as any, f.taskPath, { reason:"external", summary:"repair before wait" }));
  assert.equal((await loadTaskRecord(f.e.fs, f.taskPath)).state, "accepted");
});

test("reject resume retains the rejected Result and points only to the fresh Result", async () => {
  const f = await fixture();
  const first = await taskSubmit(f.e as any, f.taskPath, { report:"A" });
  await taskReject(f.e as any, f.taskPath, { actor:"user", resultId:first.result.id, resume:true });
  const second = await taskSubmit(f.e as any, f.taskPath, { report:"B" });
  assert.equal((await loadTaskResult(f.e.fs, first.result.path)).status, "rejected");
  assert.equal((await loadTaskRecord(f.e.fs, f.taskPath)).currentResultId, second.result.id);
});
