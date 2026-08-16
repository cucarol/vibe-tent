import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { roleHelpText } from "../src/cli/role-rpc.js";
import { taskHelpText } from "../src/cli/task-rpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliSource = path.join(repoRoot, "src", "cli", "tent.ts");
const tsxImport = import.meta.resolve("tsx");

function runCli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxImport, cliSource, ...args], {
      cwd: repoRoot,
      env: { ...process.env },
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

test("top-level help presents the canonical public collaboration model", async () => {
  const help = await runCli("--help");
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Core collaboration/);
  assert.match(help.stdout, /tent role list\|show\|config/);
  assert.match(help.stdout, /tent task list\|get\|package\|claim/);
  assert.doesNotMatch(help.stdout, /external session|pull-host|\bboxes\b/i);
});

test("Role and Task commands route to their canonical modules", async () => {
  const roleHelp = await runCli("role", "--help");
  assert.equal(roleHelp.code, 0, roleHelp.stderr);
  assert.equal(roleHelp.stdout.trim(), roleHelpText().trim());

  const taskHelp = await runCli("task", "--help");
  assert.equal(taskHelp.code, 0, taskHelp.stderr);
  assert.equal(taskHelp.stdout.trim(), taskHelpText().trim());

  const unknown = await runCli("not-a-command");
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown command: not-a-command/);
});

test("retired role-init remains routed while Role checkpoint is removed", async () => {
  const roleInit = await runCli("role-init");
  assert.notEqual(roleInit.code, 0);
  assert.doesNotMatch(roleInit.stderr, /Unknown command: role-init/);

  const roleCpHelp = await runCli("role-checkpoint", "--help");
  assert.notEqual(roleCpHelp.code, 0);
  assert.match(roleCpHelp.stderr, /Unknown command: role-checkpoint/);
});
