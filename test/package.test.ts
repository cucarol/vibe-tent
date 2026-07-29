import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  envExtra: Record<string, string> = {}
): Promise<RunResult> {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runOk(
  command: string,
  args: string[],
  cwd: string,
  envExtra: Record<string, string> = {}
): Promise<RunResult> {
  const result = await run(command, args, cwd, envExtra);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function runCli(cwd: string, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

async function runCliOk(cwd: string, ...args: string[]): Promise<RunResult> {
  return runOk(process.execPath, ["--import", tsxImport, cliSource, ...args], cwd);
}

test("tent new adopts an existing project without touching project files", async () => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-adopt-")));
  const readme = path.join(workspace, "README.md");
  const agents = path.join(workspace, "AGENTS.md");
  await fs.writeFile(readme, "# Existing project\n", "utf8");
  await fs.writeFile(agents, "# Existing rules\n", "utf8");

  await runCliOk(workspace, "new", ".");

  assert.equal(await fs.readFile(readme, "utf8"), "# Existing project\n");
  assert.equal(await fs.readFile(agents, "utf8"), "# Existing rules\n");
  assert.match(await fs.readFile(path.join(workspace, ".tent", "index.md"), "utf8"), /type: index/);
  assert.deepEqual(
    Object.keys(JSON.parse(await fs.readFile(path.join(workspace, ".tent", "types.json"), "utf8"))).sort(),
    ["asset", "goal", "output", "prompt", "reference"]
  );
  assert.equal(await exists(path.join(workspace, ".tent", "temp")), true);
  assert.equal(await exists(path.join(workspace, ".git")), false);
  assert.match(await fs.readFile(path.join(workspace, ".gitignore"), "utf8"), /\.tent\//);

  const repeated = await runCli(workspace, "new", ".");
  assert.notEqual(repeated.code, 0);
  assert.match(repeated.stderr, /already a Tent/);
});

test("removed legacy and migration commands are not part of the CLI", async () => {
  const removed = [
    "migrate",
    "import",
    "dispatch",
    "task-ack",
    "task-cancel",
    "new-box",
    "tag",
    "untag",
    "tag-new",
    "tag-rm",
    "fork",
    "clean-temp",
    "force-release",
    "okf-sync",
  ];
  for (const command of removed) {
    const result = await runCli(repoRoot, command);
    assert.notEqual(result.code, 0, `${command} must not remain callable`);
    assert.match(result.stderr, new RegExp(`Unknown command: ${command}`));
  }
});

const BUNDLED_SKILLS = ["tent-init", "tent-role", "tent-task"] as const;

test("skill-install installs all current Tent skills idempotently", async () => {
  const target = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-skill-install-")));
  const first = await runCliOk(repoRoot, "skill-install", "--dir", target);
  for (const name of BUNDLED_SKILLS) {
    assert.match(first.stdout, new RegExp(`${name}: installed`));
    assert.equal(await exists(path.join(target, name, "SKILL.md")), true);
    assert.equal(
      await fs.readFile(path.join(target, name, "SKILL.md"), "utf8"),
      await fs.readFile(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8")
    );
  }

  const second = await runCliOk(repoRoot, "skill-install", "--dir", target);
  for (const name of BUNDLED_SKILLS) assert.match(second.stdout, new RegExp(`${name}: skipped`));

  await fs.writeFile(path.join(target, "tent-init", "SKILL.md"), "# stale\n", "utf8");
  await runCliOk(repoRoot, "skill-install", "--dir", target, "--force");
  assert.match(await fs.readFile(path.join(target, "tent-init", "SKILL.md"), "utf8"), /name: tent-init/);
  await assertInstalledSkills(target);
});

test("skill-install targets derive only from the selected home", async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-skill-home-")));
  const env = { HOME: home, USERPROFILE: home };
  await runOk(process.execPath, ["--import", tsxImport, cliSource, "skill-install"], repoRoot, env);
  await assertInstalledSkills(path.join(home, ".agents", "skills"));
  await assertInstalledSkills(path.join(home, ".claude", "skills"));
});

test("CLI help and version expose only the current surface", async () => {
  const help = await runCliOk(repoRoot, "--help");
  assert.match(help.stdout, /tent node/);
  assert.match(help.stdout, /tent task/);
  assert.match(help.stdout, /tent new \./);
  assert.match(help.stdout, /skill-install/);
  assert.doesNotMatch(help.stdout, /migrate|new-box|task-ack|clean-temp|--vault/);

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal((await runCliOk(repoRoot, "--version")).stdout.trim(), pkg.version);
  assert.equal((await runCliOk(repoRoot, "-v")).stdout.trim(), pkg.version);
});

test("packed npm CLI keeps the current initialization and help surface", async (t) => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    t.skip("package smoke runs under npm test");
    return;
  }
  const packDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-pack-")));
  const packed = await runOk(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--dry-run=false", "--json", "--pack-destination", packDir],
    repoRoot
  );
  const packageInfo = JSON.parse(packed.stdout)[0];
  const tarball = path.join(packDir, packageInfo.filename);
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-package-")));
  const prefix = path.join(parent, "install");
  const workspace = path.join(parent, "workspace");

  try {
    await fs.mkdir(prefix, { recursive: true });
    await runOk(
      process.execPath,
      [npmCli, "install", "--ignore-scripts", "--dry-run=false", "--prefix", prefix, tarball],
      repoRoot
    );
    const installed = path.join(prefix, "node_modules", packageInfo.name);
    const cli = path.join(installed, "cli.mjs");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# keep\n", "utf8");
    await runOk(process.execPath, [cli, "new", "."], workspace);
    assert.equal(await fs.readFile(path.join(workspace, "README.md"), "utf8"), "# keep\n");
    assert.equal(await exists(path.join(workspace, ".tent", "index.md")), true);
    const help = await runOk(process.execPath, [cli, "--help"], workspace);
    assert.match(help.stdout, /tent node/);
    assert.doesNotMatch(help.stdout, /new-box|migrate|--vault/);
    for (const name of BUNDLED_SKILLS) {
      assert.equal(await exists(path.join(installed, "skills", name, "SKILL.md")), true);
    }
    assert.equal(await exists(path.join(installed, "LICENSE")), true);
    assert.equal(await exists(path.join(installed, "docs", "SPEC.md")), true);
  } finally {
    await fs.rm(tarball, { force: true });
  }
});

async function assertInstalledSkills(root: string): Promise<void> {
  const init = await fs.readFile(path.join(root, "tent-init", "SKILL.md"), "utf8");
  const role = await fs.readFile(path.join(root, "tent-role", "SKILL.md"), "utf8");
  const task = await fs.readFile(path.join(root, "tent-task", "SKILL.md"), "utf8");
  assert.match(init, /name: tent-init/);
  assert.match(init, /wait for explicit user approval/i);
  assert.match(role, /name: tent-role/);
  assert.match(role, /also apply `tent-task`/i);
  assert.match(task, /name: tent-task/);
  assert.match(task, /Delivery is never acceptance/i);
  assert.ok(init.length < 6000, "tent-init should stay cache-friendly");
  assert.ok(role.length < 6000, "tent-role should stay cache-friendly");
  assert.ok(task.length < 6000, "tent-task should stay cache-friendly");
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
