import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { loadReport, loadReports, rejectReport, submitReport } from "../src/core/report.js";
import { acceptProposal, loadProposal, loadProposals, rejectProposal, submitProposal } from "../src/core/proposal.js";
import { makeTent } from "./helpers.js";

test("buildInbox:认领中由 inbox 聚合,不计入待裁", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const tent = await loadTent(fsa);
  const { buildInbox, pendingCount } = await import("../src/core/inbox.js");
  const inbox = await buildInbox(tent);
  assert.ok(inbox.some((i) => i.state === "stale" && i.boxId === "bx-g2"), "owner 显示为认领中");
  assert.equal(pendingCount(inbox), 0, "认领中不计入待裁");
});

test("report:驳回保留 owner,重新交付后整份确认并清理临时文件", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-01T00:00:00.000Z" };
  const env = { fs: fsa, clock, tentName: "wqb" };
  const { acceptReport } = await import("../src/core/ops.js");

  const first = await submitReport(fsa, clock, "bx-g2", "完成第一版", ["aaa", "bbb", "aaa"]);
  assert.equal(first.path, "temp/executor/reports/bx-g2.md");
  assert.deepEqual(first.commits, ["aaa", "bbb"]);
  assert.equal((await loadReports(fsa))[0].status, "ready");

  await rejectReport(fsa, first.path, "需要补测试");
  assert.equal((await loadReports(fsa))[0].review, "需要补测试");
  assert.equal((await loadTent(fsa)).byId.get("bx-g2")!.fm.owner, "executor");

  const revised = await submitReport(fsa, clock, "bx-g2", "已补测试", ["ccc"]);
  assert.equal(revised.status, "ready");
  let integrated: string[] = [];
  await acceptReport(env as any, revised.path, {
    integrate: async (commits) => {
      integrated = commits;
    },
  });
  assert.deepEqual(integrated, ["ccc"]);
  const box = (await loadTent(fsa)).byId.get("bx-g2")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, "done");
  assert.equal(await fsa.exists(revised.path), false);
});

test("report:纯数字 commit ref 保持字符串且兼容旧文件", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-03T08:35:00.000Z" };
  const refs = [
    "2297910",
    "0001234",
    "1234567890123456789012345678901234567890",
  ];

  const report = await submitReport(fsa, clock, "bx-g2", "数字 ref", refs);
  const raw = await fsa.readFile(report.path);
  assert.match(raw, /commits: \["2297910", "0001234", "1234567890123456789012345678901234567890"\]/);
  assert.deepEqual((await loadReport(fsa, report.path)).commits, refs);

  await fsa.writeFile(
    report.path,
    "---\ntype: report\nbox: bx-g2\nrole: executor\nstatus: ready\n" +
      "commits: [08a83cd, 2297910, 0001234, 1234567890123456789012345678901234567890]\n---\n旧 report\n",
  );
  assert.deepEqual(
    (await loadReport(fsa, report.path)).commits,
    ["08a83cd", ...refs],
  );
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
