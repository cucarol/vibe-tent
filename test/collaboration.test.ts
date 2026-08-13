import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  createTaskResult,
  loadTaskResults,
  loadTaskResult,
  writeTaskResult,
} from "../src/core/task-result.js";
import { dispatch, forceRelease } from "../src/core/ops.js";
import { loadTaskRecord } from "../src/core/task.js";
import {
  taskAccept,
  taskClaim,
  taskSubmit,
  taskFail,
  taskInterrupt,
  taskReject,
} from "../src/core/task-lifecycle.js";
import { acceptProposal, loadProposal, loadProposals, rejectProposal, submitProposal } from "../src/core/proposal.js";
import { makeTent } from "./helpers.js";

test("buildInbox: active task occupation 聚合,不计入待裁", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-01T00:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
  const result = await dispatch(env as any, "cx-p1", {
    executionSessionId: "ss-executor",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    prompt: "for inbox",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, result.taskPath);
  const tent = await loadTent(fsa);
  const { buildInbox, pendingCount } = await import("../src/core/inbox.js");
  const inbox = await buildInbox(tent, fsa);
  assert.ok(inbox.some((i) => i.state === "stale" && i.nodeId === "cx-p1"), "active task 显示为认领中");
  assert.equal(pendingCount(inbox), 0, "认领中不计入待裁");
  // Without fs, inbox is empty (no FM owner scan).
  assert.equal((await buildInbox(tent)).length, 0);
});

test("result:驳回后 task 仍 running,重新交付后 accept 保留 accepted 记录", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-01T00:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };

  const result = await dispatch(env as any, "cx-p1", {
    executionSessionId: "ss-executor",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    prompt: "Implement result single-track",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, result.taskPath);

  const first = await taskSubmit(env as any, result.taskPath, {
    report: "完成第一版",
    commits: ["a".repeat(40), "b".repeat(40), "a".repeat(40)],
    targetHead: "f".repeat(40),
  });
  assert.match(first.result.path, /^temp\/sessions\/ss-executor\/results\/rs-/);
  assert.deepEqual(first.result.commits, ["a".repeat(40), "b".repeat(40)]);
  assert.equal(first.result.status, "ready");
  assert.equal((await loadTaskResults(fsa)).find((item) => item.id === first.result.id)?.status, "ready");

  const rejected = await taskReject(env as any, result.taskPath, {
    actor: "user",
    resultId: first.result.id,
    note: "需要补测试",
  });
  assert.equal(rejected.result.status, "rejected");
  assert.equal(rejected.result.review?.note, "需要补测试");
  assert.equal(rejected.task.state, "running");
  const mid = (await loadTent(fsa)).byId.get("cx-p1")!;
  assert.equal(mid.fm.owner, undefined);
  assert.equal(mid.fm.status, undefined);

  const revised = await taskSubmit(env as any, result.taskPath, {
    report: "已补测试",
    commits: ["c".repeat(40)],
    targetHead: "f".repeat(40),
  });
  assert.equal(revised.result.status, "ready");
  let integrated: string[] = [];
  const accepted = await taskAccept(env as any, result.taskPath, {
    actor: "user",
    resultId: revised.result.id,
    integrate: async (commits) => {
      integrated = commits;
    },
  });
  assert.deepEqual(integrated, ["c".repeat(40)]);
  assert.equal(accepted.result.status, "accepted");
  assert.equal(accepted.task.state, "accepted");
  const box = (await loadTent(fsa)).byId.get("cx-p1")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
  // Accepted result remains as operational history (not deleted like legacy report).
  assert.equal(await fsa.exists(accepted.result.path), true);
  assert.equal((await loadTaskResult(fsa, accepted.result.path)).status, "accepted");
  // Formal report body is TaskResult.summary only — no temp/<role>/reports dual track.
  assert.equal(accepted.result.report, "已补测试");
  assert.equal(await fsa.exists("temp/sessions/ss-executor/reports/cx-p1.md"), false);
  assert.match(accepted.result.path, /\/results\//);
});

test("result:单轨写入 results，不创建 legacy reports 路径", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-01T01:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
  const result = await dispatch(env as any, "cx-p1", {
    executionSessionId: "ss-executor",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    prompt: "TaskResult-only formal record",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, result.taskPath);
  const delivered = await taskSubmit(env as any, result.taskPath, {
    report: "User-facing report body via TaskResult.report",
    commits: ["d".repeat(40)],
    targetHead: "f".repeat(40),
    checks: [{ name: "typecheck", command: "npm run typecheck", exitCode: 0 }],
    artifactRefs: [{ kind: "path", target: "dist/out.js" }],
  });
  assert.equal(delivered.result.report, "User-facing report body via TaskResult.report");
  assert.deepEqual(delivered.result.commits, ["d".repeat(40)]);
  assert.equal(delivered.result.checks[0]?.name, "typecheck");
  assert.equal(delivered.result.artifactRefs[0]?.target, "dist/out.js");
  assert.match(delivered.result.path, /^temp\/sessions\/ss-executor\/results\/rs-/);
  assert.equal(await fsa.exists("temp/sessions/ss-executor/reports"), false);
  assert.equal(await fsa.exists(`temp/sessions/ss-executor/reports/cx-p1.md`), false);
  const raw = await fsa.readFile(delivered.result.path);
  assert.match(raw, /^---\n/);
  assert.match(raw, /type: task-result/);
  assert.match(raw, /User-facing report body via TaskResult\.report/);
});

test("result:force-release preserves immutable Result history", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-01T02:00:00.000Z" };
  const ready = await createTaskResult(fsa, clock, {
    taskId: "tk-ready",
    resultsDir: "temp/sessions/ss-executor/results",
    report: "ready history",
    status: "ready",
  });
  const accepted = await createTaskResult(fsa, clock, {
    taskId: "tk-accepted",
    resultsDir: "temp/sessions/ss-executor/results",
    report: "accepted history",
    status: "ready",
  });
  accepted.status = "accepted";
  accepted.review = { reviewer: "user", at: clock.now() };
  await writeTaskResult(fsa, accepted);
  assert.equal(await fsa.exists(ready.path), true);
  assert.equal(await fsa.exists(accepted.path), true);
  assert.equal((await loadTaskResult(fsa, accepted.path)).status, "accepted");

  // Force release changes occupation only and never rewrites Result history.
  const ready2 = await createTaskResult(fsa, clock, {
    taskId: "tk-ready2",
    resultsDir: "temp/sessions/ss-executor/results",
    report: "ready again",
    status: "ready",
  });
  await forceRelease(
    { fs: fsa, clock, tentName: "wqb", tentRoot: dir } as any,
    "cx-g2"
  );
  assert.equal(await fsa.exists(ready2.path), true);
  assert.equal(await fsa.exists(accepted.path), true);
  const box = (await loadTent(fsa)).byId.get("cx-g2")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
});

test("task interrupt/fail preserve immutable Task Result history", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-01T02:30:00.000Z" };
  const env = { fs: fsa, clock, tentName: "demo", tentRoot: dir };

  const first = await dispatch(env as any, "cx-g2", {
    executionSessionId: "ss-workera",
    workNodeIds: ["cx-g2"],
    contextNodeIds: [],
    prompt: "first task",
    requester: { kind: "user", id: "user" },
  });
  const second = await dispatch(env as any, "cx-p1", {
    executionSessionId: "ss-workerb",
    workNodeIds: ["cx-p1"],
    contextNodeIds: [],
    prompt: "second task on an independent Node",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, first.taskPath);
  await taskClaim(env as any, second.taskPath);

  const firstTask = await loadTaskRecord(fsa, first.taskPath);
  const secondTask = await loadTaskRecord(fsa, second.taskPath);
  const firstTaskResult = await createTaskResult(fsa, clock, {
    taskId: firstTask.id!,
    resultsDir: "temp/sessions/ss-workera/results",
    report: "retain this rejected result",
    status: "ready",
  });
  firstTaskResult.status = "rejected";
  firstTaskResult.review = { reviewer: "user", at: clock.now() };
  await writeTaskResult(fsa, firstTaskResult);
  const secondTaskResult = await createTaskResult(fsa, clock, {
    taskId: secondTask.id!,
    resultsDir: "temp/sessions/ss-workerb/results",
    report: "must remain",
    status: "ready",
  });

  await taskInterrupt(env as any, first.taskPath);
  assert.equal(await fsa.exists(firstTaskResult.path), true);
  assert.equal(await fsa.exists(secondTaskResult.path), true);

  const third = await dispatch(env as any, "cx-g2", {
    executionSessionId: "ss-workerc",
    workNodeIds: ["cx-g2"],
    contextNodeIds: [],
    prompt: "third task after exact Node release",
    requester: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, third.taskPath);
  const thirdTask = await loadTaskRecord(fsa, third.taskPath);
  const thirdTaskResult = await createTaskResult(fsa, clock, {
    taskId: thirdTask.id!,
    resultsDir: "temp/sessions/ss-workerc/results",
    report: "fail retains this result",
    status: "ready",
  });
  thirdTaskResult.status = "rejected";
  thirdTaskResult.review = { reviewer: "user", at: clock.now() };
  await writeTaskResult(fsa, thirdTaskResult);

  await taskFail(env as any, third.taskPath);
  assert.equal(await fsa.exists(thirdTaskResult.path), true);
  assert.equal(await fsa.exists(secondTaskResult.path), true);
});

test("result: full numeric Git object ids remain exact strings", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-03T08:35:00.000Z" };
  const refs = [
    "1".repeat(40),
    "0".repeat(64),
  ];

  const result = await createTaskResult(fsa, clock, {
    taskId: "tk-testnumeric",
    resultsDir: "temp/sessions/ss-executor/results",
    report: "数字 ref",
    commits: refs,
    targetHead: "2".repeat(40),
  });
  const raw = await fsa.readFile(result.path);
  assert.match(raw, new RegExp(`commits: \\["${"1".repeat(40)}", "${"0".repeat(64)}"\\]`));
  assert.deepEqual((await loadTaskResult(fsa, result.path)).commits, refs);
});

test("proposal:投递后 pending 进待裁,确认和驳回后离开待裁但保留文件", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-04T08:00:00.000Z" };

  const first = await submitProposal(fsa, clock, "planner", "cx-p1", "建议收窄验收标准");
  assert.equal(first.path, "temp/planner/proposals/cx-p1.md");
  assert.equal(first.status, "pending");
  assert.equal(first.role, "planner");
  assert.equal(first.body, "建议收窄验收标准");
  assert.deepEqual((await loadProposals(fsa)).filter((item) => item.status === "pending").map((item) => item.nodeId), ["cx-p1"]);

  await acceptProposal(fsa, first.path);
  assert.equal((await loadProposal(fsa, first.path)).status, "accepted");
  assert.equal(await fsa.exists(first.path), true);
  assert.equal((await loadProposals(fsa)).filter((item) => item.status === "pending").length, 0);

  const second = await submitProposal(fsa, clock, "planner", "cx-p1", "改走低风险方案");
  await rejectProposal(fsa, second.path);
  assert.equal((await loadProposal(fsa, second.path)).status, "rejected");
  assert.equal(await fsa.exists(second.path), true);
  assert.equal((await loadProposals(fsa)).filter((item) => item.status === "pending").length, 0);
});
