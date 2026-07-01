#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../fs/node-fs.js";
import { scaffoldTent } from "../core/scaffold.js";

const target = process.argv[2];

if (!target) {
  console.error("用法: tent-seed <目标帐路径>");
  process.exit(1);
}

async function main(): Promise<void> {
  const tentFs = new NodeFs(target);

  await fs.mkdir(target, { recursive: true });
  const tentName = path.basename(path.resolve(target));
  const rules =
    `# ${tentName} · 项目约定\n\n` +
    `> 这顶帐的本地规矩(global rule):随便改。\n` +
    `> 机制规范不在这(见 Tent 仓库 docs/SPEC.md);agent 的操作协议在 tent-role skill。\n\n` +
    `- 产出 workspace:<填真实代码仓路径>\n` +
    `- 提交 / 命名约定:<填>\n`;
  // demo 自选 goal/prompt/output 三个顶层框作演示骨架(scaffold 本身不再强制建 zone)。
  await scaffoldTent(tentFs, {
    name: tentName,
    rules,
    boxes: [
      { name: "goal", type: "goal", id: "bx-goalz", body: `# ${tentName} · goal\n\nuser 意志与目标。` },
      { name: "prompt", type: "prompt", id: "bx-promptz", body: `# ${tentName} · prompt\n\n给 agent 的任务说明与上下文。` },
      { name: "output", type: "output", id: "bx-outz", body: `# ${tentName} · output\n\n真实产出与代码 workspace 的指针。` },
    ],
  });
  await addDemoContent(target);
  console.log("✓ 演示帐已生成:", target);
}

async function addDemoContent(root: string): Promise<void> {
  const box = async (relativePath: string, frontmatter: string, body = "") => {
    const dir = path.join(root, relativePath);
    await fs.mkdir(dir, { recursive: true });
    const folderName = path.basename(dir);
    await fs.writeFile(path.join(dir, `${folderName}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  };
  const file = async (relativePath: string, content: string) => {
    const targetPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  };

  await box(
    "goal/挖一个新alpha",
    "id: bx-g1\ntype: goal\nstatus: doing",
    "# 挖一个新信号\n\n在目标研究平台上找一个能通过验收的新信号表达式。"
  );
  await box(
    "goal/挖一个新alpha/找数据字段",
    "id: bx-g1a\ntype: goal\nstatus: done",
    "# 找数据字段\n\n选定一组有信号的 datafields。"
  );
  await box(
    "goal/挖一个新alpha/写表达式",
    "id: bx-g1b\ntype: goal\nstatus: doing\nowner: executor",
    "# 写表达式\n\n基于选定字段写 alpha 表达式,跑模拟。"
  );
  await box(
    "goal/挖一个新alpha/过相关性检查",
    "id: bx-g1c\ntype: goal\nstatus: todo",
    "# 过相关性检查\n\n确保与已有 alpha 低相关,可提交。"
  );
  await box(
    "prompt/表达式任务书",
    "id: bx-p1\ntype: prompt",
    "# 表达式任务书\n\n用 rank/zscore 组合选定字段,目标 Sharpe > 1.25,fitness > 1。先小批量试,再扩。"
  );
  await box(
    "prompt/表达式任务书/草稿",
    "id: bx-p1d\ntype: prompt\nwritable: true",
    "# 草稿\n\n(agent 可写的表达式草稿区)"
  );
  await box(
    "prompt/字段调研任务书",
    "id: bx-p2\ntype: prompt",
    "# 字段调研任务书\n\n在 fundamental 数据集里筛出覆盖率 > 0.8 的字段。"
  );
  await box(
    "prompt/参考-旧alpha清单",
    "id: bx-a1\ntype: asset",
    "# 旧 alpha 清单\n\n(参照资料,默认不可读。想读走 proposal 翻可读。)"
  );
  await box(
    "output/alpha仓库指针",
    "id: bx-o1\ntype: output",
    "# 代码仓库指针\n\nworkspace: C:/path/to/alpha-workspace\nref: a1b2c3d\n\n真实代码位于项目 workspace。本框只记录指针,产出应保留在代码仓库的 git 历史中。"
  );
  await file(
    "temp/planner/proposals/giscus.md",
    `---\ntype: proposal\ntarget: bx-g1c\nstatus: open\nfrom: planner\n---\n\n## 为什么\n\n相关性检查这一枝可以更早做,建议提前到写表达式之前并行。\n\n## 具体改动\n\n把「过相关性检查」从 todo 提到 doing,和「写表达式」并列推进。\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
