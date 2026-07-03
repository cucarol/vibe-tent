import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { loadReport, loadReports, rejectReport, submitReport } from "../src/core/report.js";
import { makeTent } from "./helpers.js";
test("propose:只允许 readable target,写入 temp/<role>/proposals", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-06-25T01:02:03.000Z" },
    tentName: "wqb",
  };
  const { propose } = await import("../src/core/ops.js");
  const result = await propose(env as any, "bx-g1", "planner", "为什么:目标可改得更清楚\n\n具体改动:补验收标准");
  assert.match(result.proposalPath, /^temp\/planner\/proposals\/pr-20260625T010203000-bx-g1\.md$/);
  const proposal = parseFrontmatter(await fs.readFile(path.join(dir, result.proposalPath), "utf8"));
  assert.equal(proposal.data.type, "proposal");
  assert.equal(proposal.data.target, "bx-g1");
  assert.equal(proposal.data.status, "open");
  assert.equal(proposal.data.from, "planner");
  assert.match(proposal.body, /补验收标准/);

  await assert.rejects(
    () => propose(env as any, "bx-a1", "planner", "请求改不可读 asset"),
    /不可读/,
  );
});

test("buildInbox:proposal + 认领中由各自聚合器处理", async () => {
  const dir = await makeTent();
  // 一条 proposal
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dir, "temp", "planner", "proposals", "p.md"),
    "---\ntype: proposal\ntarget: bx-g1\nstatus: open\nfrom: planner\n---\n建议\n",
  );
  await fs.writeFile(
    path.join(dir, "temp", "planner", "proposals", "hidden.md"),
    "---\ntype: proposal\ntarget: bx-a1\nstatus: open\nfrom: planner\n---\n看不见的参考不能提\n",
  );
  const fsa = new NodeFs(dir);
  const tent = await loadTent(fsa);
  const { loadProposals } = await import("../src/core/proposal.js");
  const { buildInbox, pendingCount } = await import("../src/core/proposal.js");
  const props = await loadProposals(fsa);
  const inbox = await buildInbox(fsa, tent, props);
  assert.ok(
    inbox.some((i) => i.kind === "proposal" && i.proposal.target === "bx-g1"),
    "readable 目标可提 proposal",
  );
  const invalidProposal = inbox.find(
    (i) => i.kind === "invalid-proposal" && i.proposal.target === "bx-a1",
  );
  assert.ok(invalidProposal, "不可读目标 proposal 仍进待裁,可由 user 驳回清理");
  if (!invalidProposal || invalidProposal.kind !== "invalid-proposal")
    throw new Error("missing invalid proposal");
  assert.match(invalidProposal.reason, /不可读/);
  assert.ok(inbox.some((i) => i.kind === "stale" && i.boxId === "bx-g2"), "owner 显示为认领中");
  assert.equal(
    pendingCount(inbox),
    2,
    "待裁数只计算 proposal",
  );
});

test("apply-proposal 落地:accepted → startApply → finishApply → applied", async () => {
  const dir = await makeTent();
  // 一条已 accepted 的提议,改 goal bx-g1
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  const pp = path.join(dir, "temp", "planner", "proposals", "edit.md");
  await fs.writeFile(
    pp,
    "---\ntarget: bx-g1\nstatus: accepted\nfrom: planner\n---\n把目标描述改清楚\n",
  );
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { startApply, finishApply } = await import("../src/core/ops.js");

  const g = await startApply(env as any, "temp/planner/proposals/edit.md");
  assert.equal(g.targetPath, "goal/挖新alpha", "授权指向目标框");
  assert.equal(g.instructions, "把目标描述改清楚", "带出改动说明");

  await finishApply(env as any, "temp/planner/proposals/edit.md");
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");
  const after = parseFrontmatter(await fs.readFile(pp, "utf8"));
  assert.equal(after.data.status, "applied", "转 applied");
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

test("apply-proposal:未 accepted 不许落地", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  const pp = path.join(dir, "temp", "planner", "proposals", "open.md");
  await fs.writeFile(
    pp,
    "---\ntarget: bx-g1\nstatus: open\nfrom: planner\n---\nx\n",
  );
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { startApply } = await import("../src/core/ops.js");
  await assert.rejects(
    () => startApply(env as any, "temp/planner/proposals/open.md"),
    /accepted/,
  );
});

test("proposal 作用域:批准只接受 readable target,驳回可清理不可读 target", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dir, "temp", "planner", "proposals", "hidden.md"),
    "---\ntarget: bx-a1\nstatus: open\nfrom: planner\n---\n请求改不可读参考\n",
  );
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { applyProposal } = await import("../src/core/ops.js");
  await assert.rejects(
    () => applyProposal(env as any, "temp/planner/proposals/hidden.md", true),
    /不可读/,
  );
  await applyProposal(env as any, "temp/planner/proposals/hidden.md", false);
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");
  const after = parseFrontmatter(
    await fs.readFile(
      path.join(dir, "temp", "planner", "proposals", "hidden.md"),
      "utf8",
    ),
  );
  assert.equal(after.data.status, "rejected");
});
