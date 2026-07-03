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
const seedScript = path.join(repoRoot, "scripts", "seed-demo.mjs");
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

async function makeSeededTent(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-open-source-"));
  const target = path.join(parent, "example-tent");
  await run(process.execPath, [seedScript, target], repoRoot);
  return target;
}

function runCli(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

test("开源 seed:自包含、RULES 而非 SPEC、类型注册表且 Tent 无 Git", async () => {
  const tent = await makeSeededTent();
  const rules = await fs.readFile(path.join(tent, "RULES.md"), "utf8");
  assert.match(rules, /项目约定/);
  // 机制 SPEC 与 agent 配置层指针不进帐
  assert.equal(await exists(path.join(tent, "SPEC.md")), false);
  assert.equal(await exists(path.join(tent, "CLAUDE.md")), false);
  assert.equal(await exists(path.join(tent, "AGENTS.md")), false);
  assert.equal(await exists(path.join(tent, ".claude")), false);

  const registry = JSON.parse(await fs.readFile(path.join(tent, ".tent", "types.json"), "utf8"));
  assert.deepEqual(Object.keys(registry).sort(), ["asset", "goal", "open", "output", "prompt", "reference", "sealed"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tent, ".tent", "tags.json"), "utf8")), { tags: [] });
  assert.equal(await exists(path.join(tent, "temp", "temp.md")), false);
  assert.equal(await exists(path.join(tent, ".tent", "skills.json")), false);

  assert.equal(await exists(path.join(tent, ".git")), false, "Tent 本身不初始化 Git");
});

test("CLI 全链路:tree → dispatch → proposal/apply → stamp → clean-temp", async () => {
  const tent = await makeSeededTent();
  const workspace = await makeWorkspace(path.dirname(tent));
  const outputPath = path.join(tent, "output", "alpha仓库指针", "alpha仓库指针.md");
  const output = await fs.readFile(outputPath, "utf8");
  await fs.writeFile(
    outputPath,
    output.replace("C:/path/to/alpha-workspace", workspace.replaceAll("\\", "/")),
    "utf8",
  );
  const tree = await runCli(tent, "tree");
  assert.match(tree.stdout, /bx-g1c/);
  assert.doesNotMatch(tree.stdout, /legacy-temp/);

  const top = await runCli(tent, "new-box", "新线索", "goal");
  const topId = top.stdout.match(/\((bx-[^)]+)\)/)?.[1];
  assert.ok(topId, "new-box 顶层框应打印新 id");
  let newBoxRaw = await fs.readFile(path.join(tent, "新线索", "新线索.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.id, topId);
  assert.equal(parseFrontmatter(newBoxRaw).data.type, "goal");

  const child = await runCli(tent, "new-box", "子任务", "prompt", topId);
  const childId = child.stdout.match(/\((bx-[^)]+)\)/)?.[1];
  assert.ok(childId, "new-box 子框应打印新 id");
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
  await runCli(tent, "tag", "bx-o1", "backend-hardening");
  newBoxRaw = await fs.readFile(path.join(tent, "新线索", "新线索.md"), "utf8");
  assert.deepEqual(parseFrontmatter(newBoxRaw).data.tags, ["backend-hardening"]);
  let tagFind = await runCli(tent, "find", "backend-hardening");
  assert.match(tagFind.stdout, new RegExp(topId));
  assert.match(tagFind.stdout, /新线索/);
  assert.match(tagFind.stdout, /bx-o1/);
  assert.match(tagFind.stdout, /workspace=.*actual-workspace/);
  assert.match(tagFind.stdout, /ref=a1b2c3d/);
  await runCli(tent, "untag", topId, "backend-hardening");
  newBoxRaw = await fs.readFile(path.join(tent, "新线索", "新线索.md"), "utf8");
  assert.equal(parseFrontmatter(newBoxRaw).data.tags, undefined);
  await runCli(tent, "tag-rm", "backend-hardening", "--yes");
  tags = await runCli(tent, "tags");
  assert.doesNotMatch(tags.stdout, /backend-hardening/);
  tagFind = await runCli(tent, "find", "backend-hardening");
  assert.match(tagFind.stdout, /\(无匹配\)/);

  await runCli(tent, "dispatch", "bx-g1c", "reviewer", "请重点检查发布说明。");
  const manifest = await fs.readFile(path.join(tent, "temp", "reviewer", "manifest.yml"), "utf8");
  assert.match(manifest, /role: reviewer/);
  assert.match(manifest, /branch: tent-role\/reviewer/);
  const tasks = await fs.readdir(path.join(tent, "temp", "reviewer", "tasks"));
  assert.equal(tasks.length, 1);
  const localPrompt = await fs.readFile(path.join(tent, "temp", "reviewer", "tasks", tasks[0]), "utf8");
  assert.match(localPrompt, /重点检查发布说明/);
  assert.equal(await exists(path.join(path.dirname(workspace), `${path.basename(workspace)}-worktrees`, "reviewer")), true);
  let goalRaw = await fs.readFile(path.join(tent, "goal", "挖一个新alpha", "过相关性检查", "过相关性检查.md"), "utf8");
  assert.equal(parseFrontmatter(goalRaw).data.owner, "reviewer");

  const proposal = "temp/planner/proposals/giscus.md";
  await runCli(tent, "proposal", proposal, "accept", "integration-test");
  await runCli(tent, "apply", proposal);
  goalRaw += "\n集成测试已落地。\n";
  await fs.writeFile(path.join(tent, "goal", "挖一个新alpha", "过相关性检查", "过相关性检查.md"), goalRaw);
  await runCli(tent, "apply-done", proposal);

  const applied = parseFrontmatter(await fs.readFile(path.join(tent, proposal), "utf8"));
  assert.equal(applied.data.status, "applied");

  await runCli(tent, "stamp", "bx-g1c");
  const stamped = parseFrontmatter(
    await fs.readFile(path.join(tent, "goal", "挖一个新alpha", "过相关性检查", "过相关性检查.md"), "utf8")
  );
  assert.equal(stamped.data.status, "done");
  assert.equal(stamped.data.owner, undefined);

  await runCli(tent, "clean-temp");
  assert.equal(await exists(path.join(tent, "temp")), true);
  assert.deepEqual(await fs.readdir(path.join(tent, "temp")), []);
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
  assert.equal(await exists(path.join(target, ".tent", "types.json")), true);
  assert.equal(await exists(path.join(target, ".tent", "roles.json")), true);
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

test("npm 包冒烟:产物可安装、seed 并运行打包 CLI", async () => {
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
    const seedBin = path.join(binDir, windows ? "tent-seed.cmd" : "tent-seed");
    const tentBin = path.join(binDir, windows ? "tent.cmd" : "tent");
    assert.equal(await exists(seedBin), true);
    assert.equal(await exists(tentBin), true);
    const seedCommand = windows ? process.execPath : seedBin;
    const seedArgs = windows ? [path.join(installed, "scripts", "seed-demo.mjs"), target] : [target];
    const tentCommand = windows ? process.execPath : tentBin;
    const tentArgs = windows ? [path.join(installed, "cli.mjs"), "tree"] : ["tree"];
    await run(seedCommand, seedArgs, installed);
    const tree = await run(tentCommand, tentArgs, target);
    assert.match(tree.stdout, /bx-g1c/);
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
