import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../src/core/frontmatter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliSource = path.join(repoRoot, "src", "cli", "tent.ts");
const tsxImport = import.meta.resolve("tsx");
const gitIdentity = {
  GIT_AUTHOR_NAME: "The Tent Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "The Tent Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...gitIdentity },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function makeSkeletonTent(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-open-source-"));
  const target = path.join(parent, "example-tent");
  await run(process.execPath, ["--import", tsxImport, cliSource, "new", target], parent);
  return target;
}

function runCli(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

function boxId(result: RunResult): string {
  const id = result.stdout.match(/\((bx-[^)]+)\)/)?.[1];
  assert.ok(id, `new-box should print the new id: ${result.stdout}`);
  assert.match(result.stdout, /^✓ Created box /);
  return id;
}

function taskPath(result: RunResult): string {
  const task = result.stdout.match(/Task: (temp\/[^\s]+)/)?.[1];
  assert.ok(task, `dispatch should print task path: ${result.stdout}`);
  return task;
}

async function readOrder(tent: string): Promise<Record<string, string[]>> {
  return JSON.parse(await fs.readFile(path.join(tent, ".tent", "order.json"), "utf8"));
}

test("CLI 全链路:tree → dispatch → proposal/apply → stamp → clean-temp", async () => {
  const tent = await makeSkeletonTent();
  const workspace = await makeWorkspace(path.dirname(tent));

  // 用 CLI 搭 fixture:goal 链 + 指向真实 workspace 的 output 框
  const goalId = boxId(await runCli(tent, "new-box", "挖掘目标", "goal"));
  const checkId = boxId(await runCli(tent, "new-box", "检查项", "goal", goalId));
  const outputId = boxId(await runCli(tent, "new-box", "仓库指针", "output"));
  const outputPath = path.join(tent, "仓库指针", "仓库指针.md");
  await fs.writeFile(
    outputPath,
    `---\nid: ${outputId}\ntype: output\nworkspace: ${workspace.replaceAll("\\", "/")}\nref: a1b2c3d\n---\n\n# 仓库指针\n`,
    "utf8",
  );

  const tree = await runCli(tent, "tree");
  assert.match(tree.stdout, new RegExp(checkId));
  assert.doesNotMatch(tree.stdout, /legacy-temp/);

  const topId = boxId(await runCli(tent, "new-box", "新线索", "goal"));
  let order = await readOrder(tent);
  assert.ok(order.__root__.includes(topId), "new top-level box should be registered in root order");
  assert.equal(new Set(order.__root__).size, order.__root__.length, "root order should not contain duplicate ids");
  let newBoxRaw = await fs.readFile(path.join(tent, "新线索", "新线索.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.id, topId);
  assert.equal(parseFrontmatter(newBoxRaw).data.type, "goal");

  const childId = boxId(await runCli(tent, "new-box", "子任务", "prompt", topId));
  order = await readOrder(tent);
  assert.deepEqual(order[topId], [childId], "new child box should be registered under its parent order");
  newBoxRaw = await fs.readFile(path.join(tent, "新线索", "子任务", "子任务.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.id, childId);
  assert.equal(parseFrontmatter(newBoxRaw).data.type, "prompt");
  const nestedTree = await runCli(tent, "tree");
  assert.match(nestedTree.stdout, /新线索/);
  assert.match(nestedTree.stdout, /子任务/);

  await runCli(tent, "tag-new", "concept");
  let tags = await runCli(tent, "tags");
  assert.match(tags.stdout, /concept/);
  await runCli(tent, "tag", topId, "backend-hardening");
  await runCli(tent, "tag", outputId, "backend-hardening");
  newBoxRaw = await fs.readFile(path.join(tent, "新线索", "新线索.md"), "utf8");
  assert.deepEqual(parseFrontmatter(newBoxRaw).data.tags, ["backend-hardening"]);
  let tagFind = await runCli(tent, "find", "backend-hardening");
  assert.match(tagFind.stdout, new RegExp(topId));
  assert.match(tagFind.stdout, /新线索/);
  assert.match(tagFind.stdout, new RegExp(outputId));
  assert.match(tagFind.stdout, /workspace=.*actual-workspace/);
  assert.match(tagFind.stdout, /ref=a1b2c3d/);
  await runCli(tent, "untag", topId, "backend-hardening");
  newBoxRaw = await fs.readFile(path.join(tent, "新线索", "新线索.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.tags, undefined);
  await runCli(tent, "tag-rm", "backend-hardening", "--yes");
  tags = await runCli(tent, "tags");
  assert.doesNotMatch(tags.stdout, /backend-hardening/);
  tagFind = await runCli(tent, "find", "backend-hardening");
  assert.match(tagFind.stdout, /\(no matches\)/);

  await runCli(tent, "dispatch", checkId, "reviewer", "请重点检查发布说明。");
  const manifest = await fs.readFile(path.join(tent, "temp", "reviewer", "manifest.yml"), "utf8");
  assert.match(manifest, /role: reviewer/);
  assert.match(manifest, /branch: tent-role\/reviewer/);
  const tasks = await fs.readdir(path.join(tent, "temp", "reviewer", "tasks"));
  assert.equal(tasks.length, 1);
  const localPrompt = await fs.readFile(path.join(tent, "temp", "reviewer", "tasks", tasks[0]), "utf8");
  assert.match(localPrompt, /重点检查发布说明/);
  assert.equal(await exists(path.join(path.dirname(workspace), `${path.basename(workspace)}-worktrees`, "reviewer")), true);
  const checkPath = path.join(tent, "挖掘目标", "检查项", "检查项.md");
  let goalRaw = await fs.readFile(checkPath, "utf8");
  assert.equal(parseFrontmatter(goalRaw).data.owner, "reviewer");

  const proposalBody = path.join(path.dirname(tent), "proposal-body.md");
  await fs.writeFile(proposalBody, "建议给检查项补一条集成测试说明。\n", "utf8");
  const proposed = await runCli(tent, "propose", checkId, "planner", proposalBody);
  const proposal = proposed.stdout.match(/temp\/\S+\.md/)?.[0];
  assert.ok(proposal, `propose 应打印 proposal 路径:${proposed.stdout}`);
  await runCli(tent, "proposal", proposal, "accept", "integration-test");
  await runCli(tent, "apply", proposal);
  goalRaw += "\n集成测试已落地。\n";
  await fs.writeFile(checkPath, goalRaw);
  await runCli(tent, "apply-done", proposal);

  const applied = parseFrontmatter(await fs.readFile(path.join(tent, proposal), "utf8"));
  assert.equal(applied.data.status, "applied");

  await runCli(tent, "stamp", checkId);
  const stamped = parseFrontmatter(await fs.readFile(checkPath, "utf8"));
  assert.equal(stamped.data.status, "done");
  assert.equal(stamped.data.owner, undefined);
  assert.equal(stamped.data.acceptedBy, "user");

  await runCli(tent, "clean-temp");
  assert.equal(await exists(path.join(tent, "temp")), true);
  assert.deepEqual(await fs.readdir(path.join(tent, "temp")), []);
});

test("tent dispatch:task ack lifecycle and sub target branch", async () => {
  const tent = await makeSkeletonTent();
  const workspace = await makeWorkspace(path.dirname(tent));
  const peerId = boxId(await runCli(tent, "new-box", "peer", "prompt"));
  const subId = boxId(await runCli(tent, "new-box", "sub", "prompt"));
  const outputId = boxId(await runCli(tent, "new-box", "workspace", "output"));
  await fs.writeFile(
    path.join(tent, "workspace", "workspace.md"),
    `---\nid: ${outputId}\ntype: output\nworkspace: ${workspace.replaceAll("\\", "/")}\n---\n`,
    "utf8",
  );

  const peerDispatch = await runCli(tent, "dispatch", peerId, "reviewer", "Peer task.");
  const peerTask = taskPath(peerDispatch);
  const peerData = parseFrontmatter(await fs.readFile(path.join(tent, peerTask), "utf8")).data;
  assert.equal(peerData.status, "pending");
  assert.equal(peerData.dispatchedBy, "user");
  assert.equal(peerData.targetBranch, "main");
  assert.equal(peerData.handoff, undefined);
  assert.match(peerDispatch.stdout, new RegExp(`Tent root: ${tent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(peerDispatch.stdout, new RegExp(`1\\. Run \`tent task-ack ${peerTask.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` to take this task\\.`));

  await runCli(tent, "task-ack", peerTask);
  await runCli(tent, "task-ack", peerTask);
  const ackedData = parseFrontmatter(await fs.readFile(path.join(tent, peerTask), "utf8")).data;
  assert.equal(ackedData.status, "taken");

  const subTask = taskPath(await runCli(tent, "dispatch", subId, "executor", "Sub task.", "--as-sub", "--by", "planner"));
  const subData = parseFrontmatter(await fs.readFile(path.join(tent, subTask), "utf8")).data;
  assert.equal(subData.status, "pending");
  assert.equal(subData.dispatchedBy, "planner");
  assert.equal(subData.branch, "tent-role/executor");
  assert.equal(subData.targetBranch, "tent-role/planner");
});

test("tent clean-temp:rejects traversal role names and preserves root siblings", async () => {
  const tent = await makeSkeletonTent();
  const victim = path.join(path.dirname(tent), "victim");
  await fs.mkdir(victim, { recursive: true });
  await fs.writeFile(path.join(victim, "keep.txt"), "keep\n", "utf8");

  await fs.mkdir(path.join(tent, "temp", "reviewer", "tasks"), { recursive: true });
  await fs.writeFile(path.join(tent, "temp", "reviewer", "tasks", "task.md"), "task\n", "utf8");
  await runCli(tent, "clean-temp", "reviewer");
  assert.equal(await exists(path.join(tent, "temp", "reviewer")), false);

  for (const badRole of ["../../victim", "..\\..\\victim"]) {
    await fs.mkdir(path.join(tent, "temp", "reviewer"), { recursive: true });
    await assert.rejects(
      () => runCli(tent, "clean-temp", badRole),
      /Invalid role for clean-temp/,
    );
    assert.equal(await exists(path.join(victim, "keep.txt")), true);
  }
});

test("tent complete:defaults to ready report commits and consumes the report", async () => {
  const fixture = await makeCompletionFixture();
  const ref = await commitRoleFile(fixture.roleWorktree, "delivered.txt", "from report\n", "report delivery");
  const body = path.join(path.dirname(fixture.tent), "report.md");
  await fs.writeFile(body, "Implemented the requested delivery.\n", "utf8");
  await runCli(fixture.tent, "report", fixture.boxId, body, "--commits", ref);

  await runCli(fixture.tent, "complete", fixture.boxId);

  assert.equal((await fs.readFile(path.join(fixture.workspace, "delivered.txt"), "utf8")).trim(), "from report");
  assert.equal(await exists(path.join(fixture.tent, "temp", "reviewer", "reports", `${fixture.boxId}.md`)), false);
  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
  assert.equal(completed.acceptedBy, "user");
});

test("tent complete:explicit commits override a ready report and still consume it", async () => {
  const fixture = await makeCompletionFixture();
  const reportRef = await commitRoleFile(fixture.roleWorktree, "report-only.txt", "report\n", "report commit");
  const explicitRef = await commitRoleFile(fixture.roleWorktree, "explicit.txt", "explicit\n", "explicit commit");
  const body = path.join(path.dirname(fixture.tent), "report.md");
  await fs.writeFile(body, "Delivery with an overridable commit list.\n", "utf8");
  await runCli(fixture.tent, "report", fixture.boxId, body, "--commits", reportRef);

  await runCli(fixture.tent, "complete", fixture.boxId, "--commits", explicitRef);

  assert.equal((await fs.readFile(path.join(fixture.workspace, "explicit.txt"), "utf8")).trim(), "explicit");
  assert.equal(await exists(path.join(fixture.workspace, "report-only.txt")), false);
  assert.equal(await exists(path.join(fixture.tent, "temp", "reviewer", "reports", `${fixture.boxId}.md`)), false);
});

test("tent complete:already merged report commit is accepted as integrated", async () => {
  const fixture = await makeCompletionFixture();
  const ref = await commitRoleFile(fixture.roleWorktree, "merged.txt", "already merged\n", "merged delivery");
  const body = path.join(path.dirname(fixture.tent), "report.md");
  await fs.writeFile(body, "Delivery was merged before the Tent acceptance click.\n", "utf8");
  await runCli(fixture.tent, "report", fixture.boxId, body, "--commits", ref);
  await run("git", ["merge", "--ff-only", "tent-role/reviewer"], fixture.workspace);

  const completed = await runCli(fixture.tent, "complete", fixture.boxId);

  assert.match(completed.stdout, /\(already\)/);
  assert.equal((await fs.readFile(path.join(fixture.workspace, "merged.txt"), "utf8")).trim(), "already merged");
  assert.equal(await exists(path.join(fixture.tent, "temp", "reviewer", "reports", `${fixture.boxId}.md`)), false);
  const completedBox = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completedBox.status, "done");
  assert.equal(completedBox.owner, undefined);
});

test("tent complete:without a report remains a zero-integration stamp path", async () => {
  const fixture = await makeCompletionFixture();

  await runCli(fixture.tent, "complete", fixture.boxId);

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
});

test("tent complete:--by records the accepting role", async () => {
  const fixture = await makeCompletionFixture();

  await runCli(fixture.tent, "complete", fixture.boxId, "--by", "planner");

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
  assert.equal(completed.acceptedBy, "planner");
});

test("tent stamp:--by records the accepting role", async () => {
  const fixture = await makeCompletionFixture();

  await runCli(fixture.tent, "stamp", fixture.boxId, "--by", "planner");

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
  assert.equal(completed.acceptedBy, "planner");
});

test("tent complete:--require-check green runs before completion and allows mutation", async () => {
  const fixture = await makeCompletionFixture();
  const check = "git --version";

  await runCli(fixture.tent, "complete", fixture.boxId, "--require-check", check);

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
});

test("tent complete:--require-check red aborts before workspace and Tent mutation", async () => {
  const fixture = await makeCompletionFixture();
  const ref = await commitRoleFile(fixture.roleWorktree, "blocked.txt", "blocked\n", "blocked delivery");
  const body = path.join(path.dirname(fixture.tent), "report.md");
  await fs.writeFile(body, "Delivery guarded by a failing check.\n", "utf8");
  await runCli(fixture.tent, "report", fixture.boxId, body, "--commits", ref);
  const beforeBox = await fs.readFile(fixture.boxNote, "utf8");
  const beforeHead = (await run("git", ["rev-parse", "HEAD"], fixture.workspace)).stdout.trim();
  const check = "git tent-require-check-red";

  await assert.rejects(
    () => runCli(fixture.tent, "complete", fixture.boxId, "--require-check", check),
    /require-check failed/,
  );

  assert.equal(await fs.readFile(fixture.boxNote, "utf8"), beforeBox);
  assert.equal((await run("git", ["rev-parse", "HEAD"], fixture.workspace)).stdout.trim(), beforeHead);
  assert.equal(await exists(path.join(fixture.workspace, "blocked.txt")), false);
  assert.equal(await exists(path.join(fixture.tent, "temp", "reviewer", "reports", `${fixture.boxId}.md`)), true);
});

test("tent complete:--require-check missing command reports an error", async () => {
  const fixture = await makeCompletionFixture();
  const command = `tent-definitely-missing-${Date.now()}`;

  await assert.rejects(
    () => runCli(fixture.tent, "complete", fixture.boxId, "--require-check", command),
    /require-check failed/,
  );

  const stillDoing = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(stillDoing.status, "doing");
  assert.equal(stillDoing.owner, "reviewer");
});

test("tent new:空骨架帐(不强制 zone),生成 RULES 且 Tent 无 Git", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-new-"));
  const target = path.join(parent, "fresh-tent");
  await runCli(parent, "new", target);

  // 帐内是项目规则文件,不是机制 SPEC
  const rules = await fs.readFile(path.join(target, "RULES.md"), "utf8");
  assert.match(rules, /项目约定/);
  assert.equal(await exists(path.join(target, "SPEC.md")), false);
  assert.equal(await exists(path.join(target, "CLAUDE.md")), false);
  assert.equal(await exists(path.join(target, "AGENTS.md")), false);

  // 空骨架:无强制 goal/prompt/output zone,但有 temp / 注册表
  assert.equal(await exists(path.join(target, "goal")), false);
  assert.equal(await exists(path.join(target, "temp")), true);
  assert.equal(await exists(path.join(target, "temp", "temp.md")), false);
  const registry = JSON.parse(await fs.readFile(path.join(target, ".tent", "types.json"), "utf8"));
  assert.deepEqual(Object.keys(registry).sort(), ["asset", "goal", "open", "output", "prompt", "reference", "sealed"]);
  assert.equal(await exists(path.join(target, ".tent", "roles.json")), true);
  assert.equal(await exists(path.join(target, ".tent", "skills.json")), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, ".tent", "tags.json"), "utf8")), { tags: [] });

  // 不生成 agent 配置层文件。
  assert.equal(await exists(path.join(target, ".claude")), false);

  assert.equal(await exists(path.join(target, ".git")), false);

  // 已是帐 → 再 new 拒绝
  await assert.rejects(() => runCli(parent, "new", target));
});

test("tent new --vault:使用插件的新帐 type、role 与 RULES 默认值", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "tent-vault-defaults-"));
  const settingsDir = path.join(vault, ".obsidian", "plugins", "tent");
  await fs.mkdir(settingsDir, { recursive: true });
  await fs.writeFile(
    path.join(settingsDir, "data.json"),
    JSON.stringify({
      tentsRoot: "_tents",
      newTentDefaults: {
        typeRegistry: {
          goal: {
            tier: "base",
            readable: true,
            writable: false,
            color: "orange",
            description: "自定义目标",
          },
        },
        rolesRegistry: {
          roles: [{ name: "maker", color: "green", description: "负责实现" }],
        },
        rulesTemplate: "# {tent}\n\n本机默认规则\n",
      },
    }),
    "utf8",
  );

  await runCli(repoRoot, "new", "demo", "--vault", vault);
  const target = path.join(vault, "_tents", "demo");
  const registry = JSON.parse(await fs.readFile(path.join(target, ".tent", "types.json"), "utf8"));
  const roles = JSON.parse(await fs.readFile(path.join(target, ".tent", "roles.json"), "utf8"));
  assert.equal(registry.goal.color, "orange");
  assert.equal(registry.goal.description, "自定义目标");
  assert.deepEqual(roles.roles, [{ name: "maker", color: "green", description: "负责实现" }]);
  assert.equal(await fs.readFile(path.join(target, "RULES.md"), "utf8"), "# demo\n\n本机默认规则\n");
});

test("skill-install:安装内置 skills,重复执行需 --force", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skill-install-"));
  const installed = await runCli(repoRoot, "skill-install", "--dir", target);
  assert.match(installed.stdout, /tent-genesis/);
  assert.match(installed.stdout, /tent-role/);
  assert.equal(await exists(path.join(target, "tent-genesis", "SKILL.md")), true);
  assert.equal(await exists(path.join(target, "tent-role", "SKILL.md")), true);
  const installedRoleSkill = await fs.readFile(path.join(target, "tent-role", "SKILL.md"), "utf8");
  assert.match(installedRoleSkill, /tent task-ack <taskPath>/);
  assert.doesNotMatch(installedRoleSkill, /tent handoff/);

  await assert.rejects(
    () => runCli(repoRoot, "skill-install", "--dir", target),
    /Skills already exist/,
  );

  await fs.writeFile(path.join(target, "tent-role", "SKILL.md"), "stale\n", "utf8");
  await runCli(repoRoot, "skill-install", "--dir", target, "--force");
  assert.match(
    await fs.readFile(path.join(target, "tent-role", "SKILL.md"), "utf8"),
    /name: tent-role/,
  );

  await assert.rejects(
    () => runCli(repoRoot, "skill-install", "--target", "codex", "--dir", target),
    /currently supports only --target claude/,
  );
});

test("CLI 表面:help 与 version 正常退出", async () => {
  const help = await runCli(repoRoot, "--help");
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /skill-install/);
  assert.match(help.stdout, /task-ack/);
  assert.doesNotMatch(help.stdout, /handoff/i);
  assert.equal(help.stderr, "");

  const helpCommand = await runCli(repoRoot, "help");
  assert.match(helpCommand.stdout, /Tent CLI/);

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const version = await runCli(repoRoot, "--version");
  assert.equal(version.stdout.trim(), pkg.version);
  const shortVersion = await runCli(repoRoot, "-v");
  assert.equal(shortVersion.stdout.trim(), pkg.version);

  await assert.rejects(
    () => runCli(repoRoot, "not-a-command"),
    /Unknown command: not-a-command/,
  );
});

async function makeWorkspace(parent: string): Promise<string> {
  const workspace = path.join(parent, "actual-workspace");
  await fs.mkdir(workspace, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], workspace);
  await run("git", ["config", "user.name", gitIdentity.GIT_AUTHOR_NAME], workspace);
  await run("git", ["config", "user.email", gitIdentity.GIT_AUTHOR_EMAIL], workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# workspace\n", "utf8");
  await run("git", ["add", "README.md"], workspace);
  await run("git", ["commit", "-q", "-m", "init workspace"], workspace);
  return workspace;
}

async function makeCompletionFixture(): Promise<{
  tent: string;
  workspace: string;
  roleWorktree: string;
  boxId: string;
  boxNote: string;
}> {
  const tent = await makeSkeletonTent();
  const workspace = await makeWorkspace(path.dirname(tent));
  const deliveryId = boxId(await runCli(tent, "new-box", "delivery", "prompt"));
  const outputId = boxId(await runCli(tent, "new-box", "workspace", "output"));
  await fs.writeFile(
    path.join(tent, "workspace", "workspace.md"),
    `---\nid: ${outputId}\ntype: output\nworkspace: ${workspace.replaceAll("\\", "/")}\n---\n`,
    "utf8",
  );
  await runCli(tent, "dispatch", deliveryId, "reviewer", "Implement the delivery.");
  return {
    tent,
    workspace,
    roleWorktree: path.join(path.dirname(workspace), `${path.basename(workspace)}-worktrees`, "reviewer"),
    boxId: deliveryId,
    boxNote: path.join(tent, "delivery", "delivery.md"),
  };
}

async function commitRoleFile(
  roleWorktree: string,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  await fs.writeFile(path.join(roleWorktree, filename), contents, "utf8");
  await run("git", ["add", filename], roleWorktree);
  await run("git", ["commit", "-q", "-m", message], roleWorktree);
  return (await run("git", ["rev-parse", "HEAD"], roleWorktree)).stdout.trim();
}

test("npm 包冒烟:产物可安装并运行打包 CLI", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "测试必须由 npm script 启动");
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pack-"));
  const packed = await run(process.execPath, [
    npmCli,
    "pack",
    "--ignore-scripts",
    "--dry-run=false",
    "--json",
    "--pack-destination",
    packDir,
  ], repoRoot);
  const packageInfo = JSON.parse(packed.stdout)[0];
  const tarball = path.join(packDir, packageInfo.filename);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-package-"));
  const prefix = path.join(parent, "install");
  const target = path.join(parent, "packed-tent");

  try {
    await fs.mkdir(prefix, { recursive: true });
    await run(process.execPath, [
      npmCli,
      "install",
      "--ignore-scripts",
      "--dry-run=false",
      "--prefix",
      prefix,
      tarball,
    ], repoRoot);
    const installed = path.join(prefix, "node_modules", packageInfo.name);
    const binDir = path.join(prefix, "node_modules", ".bin");
    const windows = process.platform === "win32";
    const tentBin = path.join(binDir, windows ? "tent.cmd" : "tent");
    assert.equal(await exists(tentBin), true);
    const tentCommand = windows ? process.execPath : tentBin;
    const tentCli = (cwd: string, ...cliArgs: string[]) =>
      run(tentCommand, windows ? [path.join(installed, "cli.mjs"), ...cliArgs] : cliArgs, cwd);
    await tentCli(parent, "new", target);
    const created = await tentCli(target, "new-box", "冒烟检查", "goal");
    const smokeId = created.stdout.match(/\((bx-[^)]+)\)/)?.[1];
    assert.ok(smokeId, "打包 CLI 应能建框并打印 id");
    const tree = await tentCli(target, "tree");
    assert.match(tree.stdout, new RegExp(smokeId));
    assert.equal(await exists(path.join(installed, "LICENSE")), true);
    assert.equal(await exists(path.join(installed, "docs", "SPEC.md")), true);
  } finally {
    await fs.rm(tarball, { force: true });
  }
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
