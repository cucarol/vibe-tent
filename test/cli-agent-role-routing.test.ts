/**
 * Top-level public CLI routing for durable Role, Session, and Task.
 * AgentDefinition and Session-under-agent commands are intentionally absent.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { roleHelpText } from "../src/cli/role-rpc.js";
import { sessionHelpText } from "../src/cli/session-rpc.js";
import { taskHelpText } from "../src/cli/task-rpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliSource = path.join(repoRoot, "src", "cli", "tent.ts");
const tsxImport = import.meta.resolve("tsx");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(...args: string[]): Promise<RunResult> {
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

test("top-level help omits AgentDefinition command and preserves Role, Session, Task", async () => {
  const help = await runCli("--help");
  assert.equal(help.code, 0, help.stderr);
  const text = help.stdout;

  assert.match(text, /Durable Role, Session, and Task/);
  assert.doesNotMatch(text, /tent agent( |$)/);
  assert.doesNotMatch(text, /Logical AgentDefinition/);
  assert.match(text, /tent role list\|show\|config/);
  assert.match(text, /tent session enter\|status\|leave/);
  assert.match(text, /tent task list\|get\|claim\|deliver/);
  assert.doesNotMatch(text, /\bboxes\b/i);
  assert.doesNotMatch(text, /^\s*roles\s/m);
});

test("tent agent is rejected and tent role routes to the Role module", async () => {
  const agent = await runCli("agent", "--help");
  assert.notEqual(agent.code, 0);
  assert.match(agent.stderr, /Unknown command: agent/);

  const roleHelp = await runCli("role", "--help");
  assert.equal(roleHelp.code, 0, roleHelp.stderr);
  assert.match(roleHelp.stdout, /tent role list/);
  assert.doesNotMatch(roleHelp.stdout, /roster|readiness|agentId/);
  assert.equal(roleHelp.stdout.trim(), roleHelpText().trim());

  const badRole = await runCli("role", "not-a-real-sub");
  assert.notEqual(badRole.code, 0);
  assert.match(badRole.stderr, /Unknown role subcommand/);
});

test("old Session-under-agent commands are rejected; Session stays under tent session", async () => {
  for (const sub of ["enter", "status", "leave", "session-start", "session-status", "session-end"] as const) {
    const result = await runCli("agent", sub, "--host", "claude");
    assert.notEqual(result.code, 0, `tent agent ${sub} must be rejected`);
    assert.match(result.stderr, /Unknown command: agent/);
  }

  const sessionHelp = await runCli("session", "--help");
  assert.equal(sessionHelp.code, 0, sessionHelp.stderr);
  assert.match(sessionHelp.stdout, /tent session enter/);
  assert.equal(sessionHelp.stdout.trim(), sessionHelpText().trim());
});

test("old tent roles alias is rejected; Role checkpoint remains", async () => {
  const roles = await runCli("roles");
  assert.notEqual(roles.code, 0);
  assert.match(roles.stderr, /Unknown command: roles/);

  const roleInit = await runCli("role-init");
  assert.notEqual(roleInit.code, 0);
  assert.doesNotMatch(roleInit.stderr, /Unknown command: role-init/);

  const roleCpHelp = await runCli("role-checkpoint", "--help");
  assert.equal(roleCpHelp.code, 0, roleCpHelp.stderr);
});

test("session and task top-level routes remain intact", async () => {
  const sessionHelp = await runCli("session", "--help");
  assert.equal(sessionHelp.code, 0, sessionHelp.stderr);
  assert.match(sessionHelp.stdout, /tent session/);

  const taskHelp = await runCli("task", "--help");
  assert.equal(taskHelp.code, 0, taskHelp.stderr);
  assert.equal(taskHelp.stdout.trim(), taskHelpText().trim());

  const unknown = await runCli("not-a-command");
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown command: not-a-command/);
  assert.match(unknown.stderr, /\brole\b/);
  assert.doesNotMatch(unknown.stderr, /\btent agent(?:\s|$)/);
  assert.doesNotMatch(unknown.stderr, /\broles\b/);
});
