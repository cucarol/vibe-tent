import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  createDelivery,
  loadDeliveries,
  loadDelivery,
  removeNonAcceptedDeliveriesForBox,
} from "../src/core/delivery.js";
import { dispatch, forceRelease } from "../src/core/ops.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import {
  taskAccept,
  taskClaim,
  taskDeliver,
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
  const result = await dispatch(env as any, "bx-p1", "executor", {
    userPrompt: "for inbox",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, result.taskPath);
  const tent = await loadTent(fsa);
  const { buildInbox, pendingCount } = await import("../src/core/inbox.js");
  const inbox = await buildInbox(tent, fsa);
  assert.ok(inbox.some((i) => i.state === "stale" && i.boxId === "bx-p1"), "active task 显示为认领中");
  assert.equal(pendingCount(inbox), 0, "认领中不计入待裁");
  // Without fs, inbox is empty (no FM owner scan).
  assert.equal((await buildInbox(tent)).length, 0);
});

test("delivery:驳回后 task 仍 running,重新交付后 accept 保留 accepted 记录", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-01T00:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };

  const result = await dispatch(env as any, "bx-p1", "executor", {
    userPrompt: "Implement delivery single-track",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, result.taskPath);

  const first = await taskDeliver(env as any, result.taskPath, {
    summary: "完成第一版",
    commits: ["aaa", "bbb", "aaa"],
  });
  assert.match(first.delivery.path, /^temp\/executor\/deliveries\/dl-/);
  assert.deepEqual(first.delivery.commits, ["aaa", "bbb"]);
  assert.equal(first.delivery.status, "ready");
  assert.equal((await loadDeliveries(fsa, { boxId: "bx-p1" }))[0].status, "ready");

  const rejected = await taskReject(env as any, result.taskPath, {
    actor: "user",
    note: "需要补测试",
  });
  assert.equal(rejected.delivery.status, "rejected");
  assert.equal(rejected.delivery.review?.note, "需要补测试");
  assert.equal(rejected.task.state, "running");
  const mid = (await loadTent(fsa)).byId.get("bx-p1")!;
  assert.equal(mid.fm.owner, undefined);
  assert.equal(mid.fm.status, undefined);

  const revised = await taskDeliver(env as any, result.taskPath, {
    summary: "已补测试",
    commits: ["ccc"],
  });
  assert.equal(revised.delivery.status, "ready");
  let integrated: string[] = [];
  const accepted = await taskAccept(env as any, result.taskPath, {
    actor: "user",
    integrate: async (commits) => {
      integrated = commits;
    },
  });
  assert.deepEqual(integrated, ["ccc"]);
  assert.equal(accepted.delivery.status, "accepted");
  assert.equal(accepted.task.state, "accepted");
  const box = (await loadTent(fsa)).byId.get("bx-p1")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
  // Accepted delivery remains as operational history (not deleted like legacy report).
  assert.equal(await fsa.exists(accepted.delivery.path), true);
  assert.equal((await loadDelivery(fsa, accepted.delivery.path)).status, "accepted");
  // Formal report body is Delivery.summary only — no temp/<role>/reports dual track.
  assert.equal(accepted.delivery.summary, "已补测试");
  assert.equal(await fsa.exists("temp/executor/reports/bx-p1.md"), false);
  assert.match(accepted.delivery.path, /\/deliveries\//);
});

test("delivery:单轨写入 deliveries，不创建 legacy reports 路径", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-07-01T01:00:00.000Z" },
    tentName: "wqb",
    tentRoot: dir,
  };
  const result = await dispatch(env as any, "bx-p1", "executor", {
    userPrompt: "Delivery-only formal record",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, result.taskPath);
  const delivered = await taskDeliver(env as any, result.taskPath, {
    summary: "User-facing report body via Delivery.summary",
    commits: ["deadbeef"],
    checks: [{ name: "typecheck", command: "npm run typecheck", exitCode: 0 }],
    artifactRefs: [{ kind: "path", target: "dist/out.js" }],
  });
  assert.equal(delivered.delivery.summary, "User-facing report body via Delivery.summary");
  assert.deepEqual(delivered.delivery.commits, ["deadbeef"]);
  assert.equal(delivered.delivery.checks[0]?.name, "typecheck");
  assert.equal(delivered.delivery.artifactRefs[0]?.target, "dist/out.js");
  assert.match(delivered.delivery.path, /^temp\/executor\/deliveries\/dl-/);
  assert.equal(await fsa.exists("temp/executor/reports"), false);
  assert.equal(await fsa.exists(`temp/executor/reports/bx-p1.md`), false);
  const raw = await fsa.readFile(delivered.delivery.path);
  assert.match(raw, /^---\n/);
  assert.match(raw, /type: delivery/);
  assert.match(raw, /User-facing report body via Delivery\.summary/);
});

test("delivery:force-release 删除非 accepted，保留 accepted 历史", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-01T02:00:00.000Z" };
  const ready = await createDelivery(fsa, clock, {
    taskId: "tk-ready",
    boxId: "bx-g2",
    role: "executor",
    summary: "ready to drop",
    status: "ready",
  });
  const accepted = await createDelivery(fsa, clock, {
    taskId: "tk-accepted",
    boxId: "bx-g2",
    role: "executor",
    summary: "keep history",
    status: "accepted",
  });
  await removeNonAcceptedDeliveriesForBox(fsa, "bx-g2");
  assert.equal(await fsa.exists(ready.path), false);
  assert.equal(await fsa.exists(accepted.path), true);
  assert.equal((await loadDelivery(fsa, accepted.path)).status, "accepted");

  // Re-create ready and ensure forceRelease uses the same cleanup.
  const ready2 = await createDelivery(fsa, clock, {
    taskId: "tk-ready-2",
    boxId: "bx-g2",
    role: "executor",
    summary: "ready again",
    status: "ready",
  });
  await forceRelease(
    { fs: fsa, clock, tentName: "wqb", tentRoot: dir } as any,
    "bx-g2"
  );
  assert.equal(await fsa.exists(ready2.path), false);
  assert.equal(await fsa.exists(accepted.path), true);
  const box = (await loadTent(fsa)).byId.get("bx-g2")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, undefined);
});

test("task interrupt/fail remove only their own non-accepted Delivery on a shared Node", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-01T02:30:00.000Z" };
  const env = { fs: fsa, clock, tentName: "demo", tentRoot: dir };

  const first = await dispatch(env as any, "bx-g2", "worker-a", {
    userPrompt: "first shared-node task",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  const second = await dispatch(env as any, "bx-g2", "worker-b", {
    userPrompt: "second shared-node task",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, first.taskPath);
  await taskClaim(env as any, second.taskPath);

  const firstTask = await loadTaskEnvelope(fsa, first.taskPath);
  const secondTask = await loadTaskEnvelope(fsa, second.taskPath);
  const firstDelivery = await createDelivery(fsa, clock, {
    taskId: firstTask.id!,
    boxId: "bx-g2",
    role: "worker-a",
    summary: "remove only this task",
    status: "ready",
  });
  const secondDelivery = await createDelivery(fsa, clock, {
    taskId: secondTask.id!,
    boxId: "bx-g2",
    role: "worker-b",
    summary: "must remain",
    status: "ready",
  });

  await taskInterrupt(env as any, first.taskPath);
  assert.equal(await fsa.exists(firstDelivery.path), false);
  assert.equal(await fsa.exists(secondDelivery.path), true);

  const third = await dispatch(env as any, "bx-g2", "worker-c", {
    userPrompt: "third shared-node task",
    parentActor: { kind: "user", id: "user" },
    reviewer: { kind: "user", id: "user" },
  });
  await taskClaim(env as any, third.taskPath);
  const thirdTask = await loadTaskEnvelope(fsa, third.taskPath);
  const thirdDelivery = await createDelivery(fsa, clock, {
    taskId: thirdTask.id!,
    boxId: "bx-g2",
    role: "worker-c",
    summary: "fail removes only this task",
    status: "rejected",
  });

  await taskFail(env as any, third.taskPath);
  assert.equal(await fsa.exists(thirdDelivery.path), false);
  assert.equal(await fsa.exists(secondDelivery.path), true);
});

test("delivery:纯数字 commit ref 保持字符串", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-03T08:35:00.000Z" };
  const refs = [
    "2297910",
    "0001234",
    "1234567890123456789012345678901234567890",
  ];

  const delivery = await createDelivery(fsa, clock, {
    taskId: "tk-test-numeric",
    boxId: "bx-g2",
    role: "executor",
    summary: "数字 ref",
    commits: refs,
  });
  const raw = await fsa.readFile(delivery.path);
  assert.match(raw, /commits: \["2297910", "0001234", "1234567890123456789012345678901234567890"\]/);
  assert.deepEqual((await loadDelivery(fsa, delivery.path)).commits, refs);
});

test("proposal:投递后 pending 进待裁,确认和驳回后离开待裁但保留文件", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-04T08:00:00.000Z" };

  const first = await submitProposal(fsa, clock, "planner", "bx-p1", "建议收窄验收标准");
  assert.equal(first.path, "temp/planner/proposals/bx-p1.md");
  assert.equal(first.status, "pending");
  assert.equal(first.role, "planner");
  assert.equal(first.body, "建议收窄验收标准");
  assert.deepEqual((await loadProposals(fsa)).filter((item) => item.status === "pending").map((item) => item.boxId), ["bx-p1"]);

  await acceptProposal(fsa, first.path);
  assert.equal((await loadProposal(fsa, first.path)).status, "accepted");
  assert.equal(await fsa.exists(first.path), true);
  assert.equal((await loadProposals(fsa)).filter((item) => item.status === "pending").length, 0);

  const second = await submitProposal(fsa, clock, "planner", "bx-p1", "改走低风险方案");
  await rejectProposal(fsa, second.path);
  assert.equal((await loadProposal(fsa, second.path)).status, "rejected");
  assert.equal(await fsa.exists(second.path), true);
  assert.equal((await loadProposals(fsa)).filter((item) => item.status === "pending").length, 0);
});
