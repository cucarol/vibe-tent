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
  timedOut: boolean;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  envExtra: Record<string, string> = {},
  timeoutMs?: number
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...gitIdentity, ...envExtra },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = timeoutMs == null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timeout != null) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout != null) clearTimeout(timeout);
      resolve({
        code,
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms.` : stderr,
        timedOut,
      });
    });
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
  assert.match(help.stdout, /--repair-existing/);
  assert.match(help.stdout, /skill-install/);
  assert.doesNotMatch(help.stdout, /migrate|new-box|task-ack|clean-temp|--vault/);

  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal((await runCliOk(repoRoot, "--version")).stdout.trim(), pkg.version);
  assert.equal((await runCliOk(repoRoot, "-v")).stdout.trim(), pkg.version);
});

test("packed npm runtime installs dependency-free and keeps the current CLI and Service surface", async (t) => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    t.skip("package smoke runs under npm test");
    return;
  }
  const sourcePackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(sourcePackage.dependencies ?? {}, {}, "published runtime must stay dependency-free");
  const packDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-pack-")));
  const packed = await runOk(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--dry-run=false", "--json", "--pack-destination", packDir],
    repoRoot
  );
  const packageInfo = JSON.parse(packed.stdout)[0];
  const packedPaths = packageInfo.files.map((entry: { path: string }) => entry.path);
  assert.ok(packedPaths.includes("cli.mjs"));
  assert.ok(packedPaths.includes("service.mjs"));
  assert.equal(
    packedPaths.some((entry: string) => /^(desktop|src|test|node_modules)\//.test(entry)),
    false,
    "public tarball must not contain Desktop/editor or development trees"
  );
  const tarball = path.join(packDir, packageInfo.filename);
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-package-")));
  const prefix = path.join(parent, "install");
  const workspace = path.join(parent, "workspace");
  const npmLogs = path.join(parent, "npm-logs");

  try {
    await fs.mkdir(prefix, { recursive: true });
    await fs.mkdir(npmLogs, { recursive: true });
    const install = await run(
      process.execPath,
      [npmCli, "install", "--ignore-scripts", "--dry-run=false", "--prefix", prefix, tarball],
      repoRoot,
      { npm_config_logs_dir: npmLogs },
      90_000
    );
    const npmDebugLogs = install.code === 0 ? "" : await readNpmDebugLogs(npmLogs);
    assert.equal(
      install.code,
      0,
      `ordinary bounded npm install failed${install.timedOut ? " (timed out)" : ""}\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}\nnpm debug logs:\n${npmDebugLogs}`
    );
    const installed = path.join(prefix, "node_modules", packageInfo.name);
    const cli = path.join(installed, "cli.mjs");
    const service = path.join(installed, "service.mjs");
    const installedPackage = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
    assert.deepEqual(installedPackage.dependencies ?? {}, {}, "packed package must stay dependency-free");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# keep\n", "utf8");
    await runOk(process.execPath, [cli, "new", "."], workspace);
    assert.equal(await fs.readFile(path.join(workspace, "README.md"), "utf8"), "# keep\n");
    assert.equal(await exists(path.join(workspace, ".tent", "index.md")), true);
    const help = await runOk(process.execPath, [cli, "--help"], workspace);
    assert.match(help.stdout, /tent node/);
    assert.doesNotMatch(help.stdout, /new-box|migrate|--vault/);
    const serviceHelp = await runOk(process.execPath, [service, "--help"], workspace);
    assert.match(serviceHelp.stdout, /tent-service/);
    for (const name of BUNDLED_SKILLS) {
      assert.equal(await exists(path.join(installed, "skills", name, "SKILL.md")), true);
    }
    assert.equal(await exists(path.join(installed, "LICENSE")), true);
    assert.equal(await exists(path.join(installed, "docs", "SPEC.md")), true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(packDir, { recursive: true, force: true });
  }
});

async function readNpmDebugLogs(root: string): Promise<string> {
  try {
    const entries = (await fs.readdir(root)).filter((entry) => entry.endsWith(".log"));
    const candidates = await Promise.all(
      entries.map(async (entry) => ({ entry, stat: await fs.stat(path.join(root, entry)) }))
    );
    candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs || left.entry.localeCompare(right.entry));

    let remainingBytes = 64 * 1024;
    const logs: string[] = [];
    for (const { entry, stat } of candidates.slice(0, 3)) {
      if (remainingBytes === 0) break;
      const bytesToRead = Math.min(stat.size, remainingBytes);
      const buffer = Buffer.alloc(bytesToRead);
      const handle = await fs.open(path.join(root, entry), "r");
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead)));
      } finally {
        await handle.close();
      }
      remainingBytes -= bytesRead;
      const truncated = stat.size > bytesRead ? ` (tail ${bytesRead}/${stat.size} bytes)` : "";
      logs.push(`--- ${entry}${truncated} ---\n${buffer.subarray(0, bytesRead).toString("utf8")}`);
    }
    return logs.join("\n") || "<none>";
  } catch {
    return "<unavailable>";
  }
}

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
