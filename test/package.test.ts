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

interface RunExitResult extends RunResult {
  code: number | null;
}

function run(command: string, args: string[], cwd: string, envExtra: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...gitIdentity, ...envExtra },
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

function runWithExit(command: string, args: string[], cwd: string): Promise<RunExitResult> {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 创建 in-workspace tent：返回 **workspace 根**（CLI cwd）；协作文件在 `<root>/.tent/`。 */
async function makeSkeletonTent(withGit = true): Promise<string> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-open-source-")));
  const target = path.join(parent, "example-tent");
  await run(process.execPath, ["--import", tsxImport, cliSource, "new", target], parent);
  if (withGit) {
    await run("git", ["init", "-q", "-b", "main"], target);
    await run("git", ["config", "user.name", gitIdentity.GIT_AUTHOR_NAME], target);
    await run("git", ["config", "user.email", gitIdentity.GIT_AUTHOR_EMAIL], target);
    await fs.writeFile(path.join(target, "README.md"), "# workspace\n", "utf8");
    // 必须提交 .gitignore，否则 porcelain 脏状态会挡住 complete 的 commit 合入
    await run("git", ["add", "README.md", ".gitignore"], target);
    await run("git", ["commit", "-q", "-m", "init workspace"], target);
  }
  return target;
}

/**
 * External / flat collaboration system root（目录名不是 `.tent`）。
 * Legacy mutation CLI 仍允许；用于 migration-window 回归，不模拟 Desktop 共置路径。
 */
async function makeExternalTent(): Promise<string> {
  return makeFlatCollaborationTent();
}

/** workspace 内 system root 相对路径拼接。 */
function systemPath(workspace: string, ...parts: string[]): string {
  return path.join(workspace, ".tent", ...parts);
}

/** external tent system root 路径拼接（cwd 即 system root）。 */
function externalPath(tent: string, ...parts: string[]): string {
  return path.join(tent, ...parts);
}

/**
 * Every legacy mutation command sealed on in-workspace `.tent` (must stay exhaustive).
 * `propose` is service-routed on in-workspace and is not in this sealed set.
 */
const LEGACY_MUTATION_COMMANDS = [
  "dispatch",
  "task-ack",
  "task-cancel",
  "complete",
  "stamp",
  "grant-readable",
  "new-box",
  "tag",
  "untag",
  "tag-new",
  "tag-rm",
  "fork",
  "clean-temp",
  "force-release",
  "okf-sync",
] as const;

function runCli(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

function runCliAsRole(cwd: string, role: string, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd, { TENT_ROLE: role });
}

function runCliWithExit(cwd: string, ...args: string[]): Promise<RunExitResult> {
  return runWithExit(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

function boxId(result: RunResult): string {
  const id = result.stdout.match(/\(([bc]x-[^)]+)\)/)?.[1];
  assert.ok(id, `new-box should print the new id: ${result.stdout}`);
  assert.match(result.stdout, /^✓ Created box /);
  return id;
}

function taskPath(result: RunResult): string {
  const task = result.stdout.match(/Task: (temp\/[^\s]+)/)?.[1];
  assert.ok(task, `dispatch should print task path: ${result.stdout}`);
  return task;
}

async function readOrder(tentRoot: string, inWorkspace = false): Promise<Record<string, string[]>> {
  const orderFile = inWorkspace ? systemPath(tentRoot, "order.json") : externalPath(tentRoot, "order.json");
  return JSON.parse(await fs.readFile(orderFile, "utf8"));
}

test("in-workspace .tent: legacy mutation CLI fail-loud; read-only + init still work", async () => {
  const tent = await makeSkeletonTent(false);
  const systemRoot = systemPath(tent);

  // Read-only still works on in-workspace.
  const tree = await runCli(tent, "tree");
  assert.equal(tree.stderr, "");
  const status = await runCli(tent, "status");
  assert.match(status.stdout, new RegExp(`Tent: ${escapeRegExp(path.resolve(systemRoot))}`));
  assert.match(status.stdout, new RegExp(`Workspace: ${escapeRegExp(path.resolve(tent))}`));
  const roles = await runCli(tent, "roles");
  assert.match(roles.stdout, /"roles"/);
  const tags = await runCli(tent, "tags");
  assert.match(tags.stdout, /\(no tags\)|\w+/);
  const find = await runCli(tent, "find", "no-such-tag-zzz");
  assert.match(find.stdout, /\(no matches\)/);

  // Exhaustive: every direct-core mutation command is blocked (no silent write, no env escape).
  const blockedSamples: Record<(typeof LEGACY_MUTATION_COMMANDS)[number], string[]> = {
    dispatch: ["cx-missing", "reviewer", "prompt"],
    "task-ack": ["temp/reviewer/tasks/x.md"],
    "task-cancel": ["temp/reviewer/tasks/x.md"],
    complete: ["cx-missing"],
    stamp: ["cx-missing"],
    "grant-readable": ["cx-missing"],
    "new-box": ["blocked-box", "goal"],
    tag: ["cx-missing", "t"],
    untag: ["cx-missing", "t"],
    "tag-new": ["blocked-tag"],
    "tag-rm": ["blocked-tag", "--yes"],
    fork: ["cx-missing"],
    "clean-temp": [],
    "force-release": ["cx-missing"],
    "okf-sync": [],
  };
  for (const cmd of LEGACY_MUTATION_COMMANDS) {
    const result = await runCliWithExit(tent, cmd, ...blockedSamples[cmd]);
    assert.equal(result.code, 1, `${cmd} should exit 1 on in-workspace .tent`);
    assert.match(
      result.stderr,
      /refuses to direct-write an in-workspace Tent|tent task \*|Local Service|Desktop/,
      `${cmd} should fail-loud with Service guidance:\n${result.stderr}`,
    );
    assert.doesNotMatch(result.stderr, /TENT_ALLOW|escape|FORCE_LEGACY/i);
  }

  // No structure mutation leaked through new-box.
  assert.equal(await exists(systemPath(tent, "blocked-box")), false);
  assert.equal(await exists(systemPath(tent, "tags.json")), true);

  // Init / machine commands remain available.
  const roleInit = await runCli(tent, "role-init", "reviewer");
  assert.match(roleInit.stdout, /Read .*init\.md to complete role initialization\./);
  assert.equal(await exists(systemPath(tent, "temp", "reviewer", "init.md")), true);

  const parent = path.dirname(tent);
  const another = path.join(parent, "another-ws");
  await runCli(parent, "new", another);
  assert.equal(await exists(path.join(another, ".tent", "RULES.md")), true);
});

test("external tent root: legacy CLI 全链路 tree → dispatch → stamp → clean-temp", async () => {
  // migration window: external system root (not named .tent) still accepts direct core writes
  const tent = await makeExternalTent();

  const goalId = boxId(await runCli(tent, "new-box", "挖掘目标", "goal"));
  const checkId = boxId(await runCli(tent, "new-box", "检查项", "goal", goalId));
  const artifactId = boxId(await runCli(tent, "new-box", "仓库指针", "artifact"));
  const artifactPath = externalPath(tent, "仓库指针", "仓库指针.md");
  await fs.writeFile(
    artifactPath,
    `---\nid: ${artifactId}\ntype: artifact\nref: a1b2c3d\n---\n\n# 仓库指针\n`,
    "utf8",
  );

  const tree = await runCli(tent, "tree");
  assert.match(tree.stdout, new RegExp(checkId));
  assert.doesNotMatch(tree.stdout, /legacy-temp/);

  const topId = boxId(await runCli(tent, "new-box", "新线索", "goal"));
  let order = await readOrder(tent);
  assert.ok(order.__root__.includes(topId), "new top-level box should be registered in root order");
  assert.equal(new Set(order.__root__).size, order.__root__.length, "root order should not contain duplicate ids");
  let newBoxRaw = await fs.readFile(externalPath(tent, "新线索", "新线索.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.id, topId);
  assert.equal(parseFrontmatter(newBoxRaw).data.type, "goal");

  const childId = boxId(await runCli(tent, "new-box", "子任务", "prompt", topId));
  order = await readOrder(tent);
  assert.deepEqual(order[topId], [childId], "new child box should be registered under its parent order");
  newBoxRaw = await fs.readFile(externalPath(tent, "新线索", "子任务", "子任务.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.id, childId);
  assert.equal(parseFrontmatter(newBoxRaw).data.type, "prompt");
  const nestedTree = await runCli(tent, "tree");
  assert.match(nestedTree.stdout, /新线索/);
  assert.match(nestedTree.stdout, /子任务/);

  await runCli(tent, "tag-new", "concept");
  let tags = await runCli(tent, "tags");
  assert.match(tags.stdout, /concept/);
  await runCli(tent, "tag", topId, "backend-hardening");
  await runCli(tent, "tag", artifactId, "backend-hardening");
  newBoxRaw = await fs.readFile(externalPath(tent, "新线索", "新线索.md"), "utf8");
  assert.deepEqual(parseFrontmatter(newBoxRaw).data.tags, ["backend-hardening"]);
  let tagFind = await runCli(tent, "find", "backend-hardening");
  assert.match(tagFind.stdout, new RegExp(topId));
  assert.match(tagFind.stdout, /新线索/);
  assert.match(tagFind.stdout, new RegExp(artifactId));
  assert.match(tagFind.stdout, /ref=a1b2c3d/);
  await runCli(tent, "untag", topId, "backend-hardening");
  newBoxRaw = await fs.readFile(externalPath(tent, "新线索", "新线索.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.tags, undefined);
  await runCli(tent, "tag-rm", "backend-hardening", "--yes");
  tags = await runCli(tent, "tags");
  assert.doesNotMatch(tags.stdout, /backend-hardening/);
  tagFind = await runCli(tent, "find", "backend-hardening");
  assert.match(tagFind.stdout, /\(no matches\)/);

  const checkDispatch = await runCli(tent, "dispatch", checkId, "reviewer", "请重点检查发布说明。");
  const manifest = await fs.readFile(externalPath(tent, "temp", "reviewer", "manifest.yml"), "utf8");
  assert.match(manifest, /role: reviewer/);
  const tasks = await fs.readdir(externalPath(tent, "temp", "reviewer", "tasks"));
  assert.equal(tasks.length, 1);
  const localPrompt = await fs.readFile(externalPath(tent, "temp", "reviewer", "tasks", tasks[0]), "utf8");
  assert.match(localPrompt, /重点检查发布说明/);
  const checkPath = externalPath(tent, "挖掘目标", "检查项", "检查项.md");
  await runCli(tent, "task-ack", taskPath(checkDispatch));
  let goalRaw = await fs.readFile(checkPath, "utf8");
  assert.equal(parseFrontmatter(goalRaw).data.owner, "reviewer");

  goalRaw += "\n集成测试已落地。\n";
  await fs.writeFile(checkPath, goalRaw);

  await runCli(tent, "stamp", checkId);
  const stamped = parseFrontmatter(await fs.readFile(checkPath, "utf8"));
  assert.equal(stamped.data.status, "done");
  assert.equal(stamped.data.owner, undefined);
  assert.equal(stamped.data.acceptedBy, "user");

  await runCli(tent, "clean-temp");
  assert.equal(await exists(externalPath(tent, "temp")), true);
  assert.deepEqual(await fs.readdir(externalPath(tent, "temp")), []);
});

test("external tent: dispatch task-ack lifecycle (no workspace lane)", async () => {
  const tent = await makeExternalTent();
  const peerId = boxId(await runCli(tent, "new-box", "peer", "prompt"));
  const subId = boxId(await runCli(tent, "new-box", "sub", "prompt"));

  const peerDispatch = await runCli(tent, "dispatch", peerId, "reviewer", "Peer task.");
  const peerTask = taskPath(peerDispatch);
  const peerData = parseFrontmatter(await fs.readFile(externalPath(tent, peerTask), "utf8")).data;
  assert.equal(peerData.status, "pending");
  assert.equal(peerData.dispatchedBy, "user");
  assert.equal(peerData.handoff, undefined);
  assert.match(peerDispatch.stdout, new RegExp(`systemRoot: ${escapeRegExp(path.resolve(tent))}`));
  assert.match(
    peerDispatch.stdout,
    new RegExp(`1\\. Run \`tent task claim ${escapeRegExp(peerTask)}\` to take this task`),
  );
  assert.doesNotMatch(peerDispatch.stdout, /task-ack/);
  const peerBoxPath = externalPath(tent, "peer", "peer.md");
  let peerBox = parseFrontmatter(await fs.readFile(peerBoxPath, "utf8")).data;
  assert.equal(peerBox.owner, undefined);
  assert.equal(peerBox.status, undefined);

  await runCli(tent, "task-ack", peerTask);
  await runCli(tent, "task-ack", peerTask);
  const ackedData = parseFrontmatter(await fs.readFile(externalPath(tent, peerTask), "utf8")).data;
  assert.equal(ackedData.status, "taken");
  peerBox = parseFrontmatter(await fs.readFile(peerBoxPath, "utf8")).data;
  assert.equal(peerBox.owner, "reviewer");
  assert.equal(peerBox.status, "doing");

  // --as-sub requires workspace contract; external flat root has none.
  await assert.rejects(
    () => runCli(tent, "dispatch", subId, "executor", "Sub task.", "--as-sub", "--by", "planner"),
    /Scaffold an in-workspace tent at <workspace>\/\.tent\//,
  );
});

test("tent status:read-only on in-workspace; full status on external root", async () => {
  // in-workspace: status is read-only (no propose/dispatch/stamp via legacy CLI)
  const ws = await makeSkeletonTent(false);
  const systemRoot = systemPath(ws);
  const emptyStatus = await runCli(ws, "status");
  assert.match(emptyStatus.stdout, new RegExp(`Tent: ${escapeRegExp(path.resolve(systemRoot))}`));
  assert.match(emptyStatus.stdout, new RegExp(`Workspace: ${escapeRegExp(path.resolve(ws))}`));
  assert.match(emptyStatus.stdout, /Pending proposals: none/);
  assert.match(emptyStatus.stdout, /Pending tasks \(task-ack\): none/);
  assert.equal(emptyStatus.stderr, "");

  // external: mutate + status still works for migration window
  const tent = await makeExternalTent();
  const proposalId = boxId(await runCli(tent, "new-box", "Choose release lane", "prompt"));
  const proposalBody = path.join(path.dirname(tent), "proposal.md");
  await fs.writeFile(proposalBody, "建议选择低风险发布路径\n", "utf8");
  const proposed = await runCliAsRole(tent, "planner", "propose", proposalId, proposalBody);
  assert.match(proposed.stdout, new RegExp(`temp/planner/proposals/${proposalId}\\.md`));
  const claimId = boxId(await runCli(tent, "new-box", "Implement release notes", "prompt"));

  const dispatched = await runCli(tent, "dispatch", claimId, "reviewer", "Draft release notes.");
  const task = path.posix.basename(taskPath(dispatched));
  const status = await runCli(tent, "status");

  assert.match(status.stdout, new RegExp(`Tent: ${escapeRegExp(path.resolve(tent))}`));
  assert.match(status.stdout, /Workspace: \(none\)/);
  assert.match(status.stdout, /Pending proposals:/);
  assert.match(
    status.stdout,
    new RegExp(`- ${proposalId}: Choose release lane \\(planner\\) - 建议选择低风险发布路径`),
  );
  assert.match(status.stdout, /Pending tasks \(task-ack\):/);
  assert.match(status.stdout, new RegExp(`- reviewer/${escapeRegExp(task)} -> ${claimId}`));
  assert.match(status.stdout, /Active claims: none/);
  assert.equal(status.stderr, "");

  await runCli(tent, "task-ack", taskPath(dispatched));
  const ackedStatus = await runCli(tent, "status");
  assert.match(ackedStatus.stdout, /Pending tasks \(task-ack\): none/);
  assert.match(ackedStatus.stdout, /Active claims:/);
  assert.match(
    ackedStatus.stdout,
    new RegExp(`- ${claimId}: Implement release notes \\(owner: reviewer, status: doing\\)`),
  );

  await runCli(tent, "stamp", claimId);
  const doneStatus = await runCli(tent, "status");
  assert.match(doneStatus.stdout, /Pending tasks \(task-ack\): none/);
  assert.doesNotMatch(doneStatus.stdout, new RegExp(`- reviewer/${escapeRegExp(task)} -> ${claimId}`));

  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-status-outside-")));
  const failed = await runCliWithExit(outside, "status");
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /Not inside a Tent \(no \.tent\/ system root with RULES\.md found\)\./);
});

test("external tent dispatch --as-sub:missing dispatcher fails before side effects", async () => {
  const tent = await makeExternalTent();
  const subId = boxId(await runCli(tent, "new-box", "sub", "prompt"));
  const previousTentRole = process.env.TENT_ROLE;
  delete process.env.TENT_ROLE;
  try {
    await assert.rejects(
      () => runCli(tent, "dispatch", subId, "reviewer", "Sub task.", "--as-sub"),
      /--as-sub requires --by <dispatching-role> or TENT_ROLE/,
    );
  } finally {
    if (previousTentRole === undefined) delete process.env.TENT_ROLE;
    else process.env.TENT_ROLE = previousTentRole;
  }
});

test("external tent dispatch --as-sub:missing workspace explains how to register the contract", async () => {
  // 纯协作目录（system root 不叫 .tent，且无 workspace 字段）→ 无 workspace 契约
  const tent = await makeFlatCollaborationTent();
  const subId = boxId(await runCli(tent, "new-box", "sub", "prompt"));
  const noteId = boxId(await runCli(tent, "new-box", "delivery", "note"));
  assert.ok(noteId, "note without workspace field is not a workspace contract");

  await assert.rejects(
    () => runCli(tent, "dispatch", subId, "reviewer", "Sub task.", "--as-sub", "--by", "planner"),
    /Scaffold an in-workspace tent at <workspace>\/\.tent\//,
  );
});

test("external tent clean-temp:rejects traversal role names and preserves root siblings", async () => {
  const tent = await makeExternalTent();
  const victim = path.join(path.dirname(tent), "victim");
  await fs.mkdir(victim, { recursive: true });
  await fs.writeFile(path.join(victim, "keep.txt"), "keep\n", "utf8");

  await fs.mkdir(externalPath(tent, "temp", "reviewer", "tasks"), { recursive: true });
  await fs.writeFile(externalPath(tent, "temp", "reviewer", "tasks", "task.md"), "task\n", "utf8");
  await runCli(tent, "clean-temp", "reviewer");
  assert.equal(await exists(externalPath(tent, "temp", "reviewer")), false);

  for (const badRole of ["../../victim", "..\\..\\victim"]) {
    await fs.mkdir(externalPath(tent, "temp", "reviewer"), { recursive: true });
    await assert.rejects(
      () => runCli(tent, "clean-temp", badRole),
      /Invalid role for clean-temp/,
    );
    assert.equal(await exists(path.join(victim, "keep.txt")), true);
  }
});

test("external tent complete:without a Delivery remains a zero-integration stamp path", async () => {
  const fixture = await makeCompletionFixture();

  await runCli(fixture.tent, "complete", fixture.boxId);

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
});

test("external tent complete:--by records the accepting role", async () => {
  const fixture = await makeCompletionFixture();

  await runCli(fixture.tent, "complete", fixture.boxId, "--by", "planner");

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
  assert.equal(completed.acceptedBy, "planner");
});

test("external tent stamp:--by records the accepting role", async () => {
  const fixture = await makeCompletionFixture();

  await runCli(fixture.tent, "stamp", fixture.boxId, "--by", "planner");

  const completed = parseFrontmatter(await fs.readFile(fixture.boxNote, "utf8")).data;
  assert.equal(completed.status, "done");
  assert.equal(completed.owner, undefined);
  assert.equal(completed.acceptedBy, "planner");
});

test("external tent complete:--require-check without workspace fails before mutation", async () => {
  const fixture = await makeCompletionFixture();
  const beforeBox = await fs.readFile(fixture.boxNote, "utf8");

  await assert.rejects(
    () => runCli(fixture.tent, "complete", fixture.boxId, "--require-check", "git --version"),
    /require-check requires a workspace pointer/,
  );

  assert.equal(await fs.readFile(fixture.boxNote, "utf8"), beforeBox);
  const stillDoing = parseFrontmatter(beforeBox).data;
  assert.equal(stillDoing.status, "doing");
  assert.equal(stillDoing.owner, "reviewer");
});

test("tent new:in-workspace .tent 空骨架,生成 RULES 且 workspace 可无 Git", async () => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-new-")));
  const target = path.join(parent, "fresh-tent");
  await runCli(parent, "new", target);

  const systemRoot = path.join(target, ".tent");
  // 协作事实在 <workspace>/.tent/
  const rules = await fs.readFile(path.join(systemRoot, "RULES.md"), "utf8");
  assert.match(rules, /Project Rules/);
  assert.equal(await exists(path.join(systemRoot, "SPEC.md")), false);
  assert.equal(await exists(path.join(systemRoot, "CLAUDE.md")), false);
  assert.equal(await exists(path.join(systemRoot, "AGENTS.md")), false);

  // 空骨架:无强制顶层文件夹,但有 temp / 注册表
  assert.equal(await exists(path.join(systemRoot, "goal")), false);
  assert.equal(await exists(path.join(systemRoot, "temp")), true);
  assert.equal(await exists(path.join(systemRoot, "temp", "temp.md")), false);
  const registry = JSON.parse(await fs.readFile(path.join(systemRoot, "types.json"), "utf8"));
  assert.deepEqual(
    Object.keys(registry).sort(),
    ["artifact", "asset", "goal", "note", "open", "prompt", "reference", "sealed"],
  );
  assert.equal(registry.note.coordination, false);
  assert.equal(registry.goal.coordination, true);
  assert.equal(registry.artifact.coordination, true);
  assert.equal(await exists(path.join(systemRoot, "roles.json")), true);
  assert.equal(await exists(path.join(systemRoot, "skills.json")), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(systemRoot, "tags.json"), "utf8")), { tags: [] });
  assert.equal(await exists(path.join(target, ".gitignore")), true, "workspace gitignore 忽略 .tent/");

  // 不生成 agent 配置层文件。
  assert.equal(await exists(path.join(target, ".claude")), false);
  assert.equal(await exists(path.join(systemRoot, ".claude")), false);

  assert.equal(await exists(path.join(target, ".git")), false);

  // 已是帐 → 再 new 拒绝
  await assert.rejects(() => runCli(parent, "new", target));
});

test("tent new --vault:使用插件的新帐 type、role 与 RULES 默认值", async () => {
  const vault = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-vault-defaults-")));
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
  const systemRoot = path.join(target, ".tent");
  const registry = JSON.parse(await fs.readFile(path.join(systemRoot, "types.json"), "utf8"));
  const roles = JSON.parse(await fs.readFile(path.join(systemRoot, "roles.json"), "utf8"));
  assert.equal(registry.goal.color, "orange");
  assert.equal(registry.goal.description, "自定义目标");
  assert.equal(roles.roles.length, 1);
  assert.match(roles.roles[0].id, /^rl-[a-z0-9]+$/);
  assert.deepEqual(roles.roles[0], {
    id: roles.roles[0].id,
    name: "maker",
    displayName: "maker",
    color: "green",
    description: "负责实现",
  });
  assert.equal(await fs.readFile(path.join(systemRoot, "RULES.md"), "utf8"), "# demo\n\n本机默认规则\n");
});

test("skill-install:安装内置 skills,重复执行跳过,需 --force 覆盖", async () => {
  const target = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-skill-install-")));
  const installed = await runCli(repoRoot, "skill-install", "--dir", target);
  assert.match(installed.stdout, /tent-genesis: installed/);
  assert.match(installed.stdout, /tent-role: installed/);
  assert.equal(await exists(path.join(target, "tent-genesis", "SKILL.md")), true);
  assert.equal(await exists(path.join(target, "tent-role", "SKILL.md")), true);
  const bundledRoleSkill = await fs.readFile(path.join(repoRoot, "skills", "tent-role", "SKILL.md"), "utf8");
  const installedRoleSkill = await fs.readFile(path.join(target, "tent-role", "SKILL.md"), "utf8");
  assert.equal(
    installedRoleSkill,
    bundledRoleSkill,
    "skill-install must copy bundled tent-role byte-for-byte",
  );
  assertInstalledTentRoleSkill(installedRoleSkill);

  // Idempotent: without --force, existing skills are skipped (not an error).
  const skipped = await runCli(repoRoot, "skill-install", "--dir", target);
  assert.match(skipped.stdout, /tent-genesis: skipped/);
  assert.match(skipped.stdout, /tent-role: skipped/);
  assert.match(skipped.stdout, /already exists/);
  assert.equal(
    await fs.readFile(path.join(target, "tent-role", "SKILL.md"), "utf8"),
    bundledRoleSkill,
    "skip must leave existing skill bytes unchanged",
  );

  // Simulate stale local skill that still teaches legacy main flow
  await fs.writeFile(
    path.join(target, "tent-role", "SKILL.md"),
    [
      "---",
      "name: tent-role",
      "---",
      "# stale legacy",
      "1. Run `tent task-ack <taskPath>`",
      "2. Finish with `tent report <boxId>`",
      "Confirm cwd has RULES.md, .tent/, temp/ at workspace root.",
      "Read temp/<role>/init.md",
    ].join("\n") + "\n",
    "utf8",
  );
  await runCli(repoRoot, "skill-install", "--dir", target, "--force");
  const forced = await fs.readFile(path.join(target, "tent-role", "SKILL.md"), "utf8");
  assert.equal(forced, bundledRoleSkill, "skill-install --force must match bundled skill");
  assertInstalledTentRoleSkill(forced);

  await assert.rejects(
    () => runCli(repoRoot, "skill-install", "--target", "codex", "--dir", target),
    /Unknown skill target/,
  );
});

test("skill-install:默认同步到 Claude 与 .agents/skills,目标独立判断", async () => {
  const fakeHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-skill-home-")));
  const claudeSkills = path.join(fakeHome, ".claude", "skills");
  const agentsSkills = path.join(fakeHome, ".agents", "skills");
  const homeEnv = { HOME: fakeHome, USERPROFILE: fakeHome };

  const bundledRole = await fs.readFile(path.join(repoRoot, "skills", "tent-role", "SKILL.md"), "utf8");
  const bundledGenesis = await fs.readFile(path.join(repoRoot, "skills", "tent-genesis", "SKILL.md"), "utf8");

  const first = await run(
    process.execPath,
    ["--import", tsxImport, cliSource, "skill-install"],
    repoRoot,
    homeEnv,
  );
  assert.match(first.stdout, /skill-install/);
  assert.match(first.stdout, new RegExp(escapeRegExp(claudeSkills)));
  assert.match(first.stdout, new RegExp(escapeRegExp(agentsSkills)));
  assert.match(first.stdout, /tent-genesis: installed/);
  assert.match(first.stdout, /tent-role: installed/);
  // Targets must resolve under the temp HOME only (os.homedir via HOME/USERPROFILE).
  for (const line of first.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("✓") || trimmed.startsWith("-")) continue;
    if (trimmed.includes("installed") || trimmed.includes("skipped")) continue;
    assert.ok(
      trimmed === claudeSkills || trimmed === agentsSkills || trimmed.startsWith(fakeHome + path.sep),
      `skill-install target must stay under temp HOME, got: ${trimmed}`,
    );
  }
  // Installer source must use os.homedir(), not a hard-coded developer absolute path.
  const installerSource = await fs.readFile(path.join(repoRoot, "src", "machine", "skills.ts"), "utf8");
  assert.match(installerSource, /os\.homedir\(\)/);
  assert.doesNotMatch(installerSource, /C:\\\\Users\\\\|\/Users\/[A-Za-z0-9._-]+\/\.claude/);

  for (const root of [claudeSkills, agentsSkills]) {
    assert.equal(
      await fs.readFile(path.join(root, "tent-role", "SKILL.md"), "utf8"),
      bundledRole,
      `${root}/tent-role must match bundled bytes`,
    );
    assert.equal(
      await fs.readFile(path.join(root, "tent-genesis", "SKILL.md"), "utf8"),
      bundledGenesis,
      `${root}/tent-genesis must match bundled bytes`,
    );
    assertInstalledTentRoleSkill(await fs.readFile(path.join(root, "tent-role", "SKILL.md"), "utf8"));
  }

  // Pre-fill only Claude with stale content; agents dir empty after wipe of one skill.
  await fs.writeFile(path.join(claudeSkills, "tent-role", "SKILL.md"), "# stale claude only\n", "utf8");
  await fs.rm(path.join(agentsSkills, "tent-role"), { recursive: true, force: true });

  const partial = await run(
    process.execPath,
    ["--import", tsxImport, cliSource, "skill-install"],
    repoRoot,
    homeEnv,
  );
  // Claude tent-role skipped; agents tent-role installed independently.
  assert.match(partial.stdout, new RegExp(`${escapeRegExp(claudeSkills)}[\\s\\S]*tent-role: skipped`));
  assert.match(partial.stdout, new RegExp(`${escapeRegExp(agentsSkills)}[\\s\\S]*tent-role: installed`));
  assert.equal(
    await fs.readFile(path.join(claudeSkills, "tent-role", "SKILL.md"), "utf8"),
    "# stale claude only\n",
    "without --force, existing Claude skill must not be overwritten",
  );
  assert.equal(
    await fs.readFile(path.join(agentsSkills, "tent-role", "SKILL.md"), "utf8"),
    bundledRole,
    "missing agents skill must still install when Claude already has one",
  );

  const forced = await run(
    process.execPath,
    ["--import", tsxImport, cliSource, "skill-install", "--force"],
    repoRoot,
    homeEnv,
  );
  assert.match(forced.stdout, /tent-role: installed/);
  assert.equal(await fs.readFile(path.join(claudeSkills, "tent-role", "SKILL.md"), "utf8"), bundledRole);
  assert.equal(await fs.readFile(path.join(agentsSkills, "tent-role", "SKILL.md"), "utf8"), bundledRole);
});

/** Assert installed tent-role is the new in-workspace + service lifecycle skill, not legacy main flow. */
function assertInstalledTentRoleSkill(skill: string) {
  assert.match(skill, /name: tent-role/);
  assert.match(skill, /in-workspace/);
  assert.match(skill, /workspace root/i);
  assert.match(skill, /system root/i);
  assert.match(skill, /\.tent\/temp\//);
  assert.match(skill, /temp\/<role>\/init\.md/);
  assert.match(skill, /tent task claim/);
  assert.match(skill, /tent task get/);
  assert.match(skill, /tent task deliver/);
  assert.match(skill, /task\.startSession|startSession/);
  assert.match(skill, /already claimed|已 claim|代 claim/);
  // Legacy may appear only as isolated notes, not as the primary protocol steps.
  assert.match(skill, /## Legacy/);
  // Primary protocol must not prescribe task-ack / tent report as the default claim/deliver path.
  const protocolSection = skill.split("## Legacy")[0] ?? skill;
  assert.doesNotMatch(
    protocolSection,
    /接任务后的第一步运行 `tent task-ack|Run `tent task-ack|`tent report <boxId>/,
  );
  assert.doesNotMatch(protocolSection, /确认工作目录就是 Tent 根目录，且包含 `RULES\.md`、`\.tent\/`、`temp\/`/);
  assert.doesNotMatch(protocolSection, /新 role session 只读一次 `temp\/<role>\/init\.md`/);
  assert.doesNotMatch(skill, /tent handoff/);
}

test("CLI 表面:help 与 version 正常退出", async () => {
  const help = await runCli(repoRoot, "--help");
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /skill-install/);
  assert.match(help.stdout, /status/);
  assert.match(help.stdout, /task-ack/);
  assert.match(help.stdout, /clean-temp/);
  assert.match(help.stdout, /fail-loud|in-workspace|Local Service|tent task \*/i);
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

/**
 * 纯协作目录：system root 即 cwd，目录名不是 `.tent`，无法从布局推导 workspace。
 * 用于验证无 workspace 契约时的 CLI 错误路径。
 */
async function makeFlatCollaborationTent(): Promise<string> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-flat-")));
  const target = path.join(parent, "collab-only");
  await run(process.execPath, ["--import", tsxImport, cliSource, "new", target], parent);
  // 把 `.tent/` 内容上提到 collab-only 根，去掉 in-workspace 布局
  const systemRoot = path.join(target, ".tent");
  const entries = await fs.readdir(systemRoot);
  for (const name of entries) {
    await fs.rename(path.join(systemRoot, name), path.join(target, name));
  }
  await fs.rm(systemRoot, { recursive: true, force: true });
  // 移除 workspace 级 gitignore（若有），避免误导
  await fs.rm(path.join(target, ".gitignore"), { force: true });
  return target;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function makeCompletionFixture(): Promise<{
  tent: string;
  boxId: string;
  boxNote: string;
}> {
  // External system root: legacy complete/stamp still direct-write during migration window.
  // Formal Delivery is task.deliver only; Git integrate paths are covered by service/core tests.
  const tent = await makeExternalTent();
  const deliveryId = boxId(await runCli(tent, "new-box", "delivery", "prompt"));
  const dispatched = await runCli(tent, "dispatch", deliveryId, "reviewer", "Implement the delivery.");
  await runCli(tent, "task-ack", taskPath(dispatched));
  return {
    tent,
    boxId: deliveryId,
    boxNote: externalPath(tent, "delivery", "delivery.md"),
  };
}

test("npm 包冒烟:产物可安装并运行打包 CLI", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "测试必须由 npm script 启动");
  const packDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-pack-")));
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
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-package-")));
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
    // in-workspace: new-box is sealed; smoke uses read-only tree + blocked mutate message
    assert.equal(await exists(path.join(target, ".tent", "RULES.md")), true);
    const tree = await tentCli(target, "tree");
    assert.equal(tree.stderr ?? "", "");
    const blocked = await run(
      tentCommand,
      windows ? [path.join(installed, "cli.mjs"), "new-box", "冒烟检查", "goal"] : ["new-box", "冒烟检查", "goal"],
      target,
    ).then(
      () => null,
      (err: Error) => err.message,
    );
    assert.ok(blocked, "packed CLI must refuse in-workspace new-box");
    assert.match(blocked!, /refuses to direct-write an in-workspace Tent|tent task \*|Local Service/);
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
