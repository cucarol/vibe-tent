/**
 * Top-level public CLI routing for logical Agent + durable Role (cx-b9bf58).
 * Proves tent agent / tent role wiring, rejects old Session-under-agent and tent roles,
 * and keeps session/task surfaces intact. No live provider calls.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { agentDefinitionHelpText } from "../src/cli/agent-definition-rpc.js";
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

test("top-level help distinguishes logical Agent, durable Role, Session, Task", async () => {
  const help = await runCli("--help");
  assert.equal(help.code, 0, help.stderr);
  const text = help.stdout;

  assert.match(text, /Logical Agent, durable Role, Session, and Task/);
  assert.match(text, /tent agent list\|get\|config/);
  assert.match(text, /Logical AgentDefinition/);
  assert.match(text, /tent role list\|show\|config/);
  assert.match(text, /Durable Role/);
  assert.match(text, /tent session enter\|status\|leave/);
  assert.match(text, /tent task list\|get\|claim\|deliver/);

  // Old plural registry-list alias removed; no compatibility line.
  assert.doesNotMatch(text, /^\s*roles\s/m);
  assert.doesNotMatch(text, /\broles\s+Print the role registry/);
  // Agent is not LaunchProfile / credentials selectors.
  assert.doesNotMatch(text, /LaunchProfile/);
  assert.doesNotMatch(text, /credential/i);
  assert.doesNotMatch(text, /tent agent enter\|status\|leave/);
});

test("tent agent and tent role route to accepted modules (help + unknown subcommands)", async () => {
  const agentHelp = await runCli("agent", "--help");
  assert.equal(agentHelp.code, 0, agentHelp.stderr);
  assert.match(agentHelp.stdout, /tent agent list/);
  assert.match(agentHelp.stdout, /AgentDefinition/);
  assert.equal(agentHelp.stdout.trim(), agentDefinitionHelpText().trim());

  const roleHelp = await runCli("role", "--help");
  assert.equal(roleHelp.code, 0, roleHelp.stderr);
  assert.match(roleHelp.stdout, /tent role list/);
  assert.match(roleHelp.stdout, /roster/);
  assert.equal(roleHelp.stdout.trim(), roleHelpText().trim());

  // Unknown agent-definition subcommand fails loud via the module (proves routing).
  const badAgent = await runCli("agent", "not-a-real-sub");
  assert.notEqual(badAgent.code, 0);
  assert.match(badAgent.stderr, /Unknown agent-definition subcommand/);
  assert.doesNotMatch(badAgent.stderr, /Unknown command: agent/);

  const badRole = await runCli("role", "not-a-real-sub");
  assert.notEqual(badRole.code, 0);
  assert.match(badRole.stderr, /Unknown role subcommand/);
  assert.doesNotMatch(badRole.stderr, /Unknown command: role/);
});

test("old Session-under-agent commands are rejected; Session stays under tent session", async () => {
  for (const sub of [
    "enter",
    "status",
    "leave",
    "session-start",
    "session-status",
    "session-end",
  ] as const) {
    const result = await runCli("agent", sub, "--host", "claude");
    assert.notEqual(result.code, 0, `tent agent ${sub} must be rejected`);
    // Routed to agent-definition module — not Session lifecycle, not "unknown top-level agent".
    assert.match(
      result.stderr,
      /Unknown agent-definition subcommand/,
      `tent agent ${sub} stderr=${result.stderr}`
    );
    assert.doesNotMatch(result.stderr, /Unknown command: agent/);
  }

  const sessionHelp = await runCli("session", "--help");
  assert.equal(sessionHelp.code, 0, sessionHelp.stderr);
  assert.match(sessionHelp.stdout, /tent session enter/);
  assert.match(sessionHelp.stdout, /tent session status/);
  assert.match(sessionHelp.stdout, /tent session leave/);
  assert.equal(sessionHelp.stdout.trim(), sessionHelpText().trim());
});

test("old tent roles alias is rejected; role-init and role-checkpoint remain", async () => {
  const roles = await runCli("roles");
  assert.notEqual(roles.code, 0);
  assert.match(roles.stderr, /Unknown command: roles/);

  const unknownList = await runCli("roles", "list");
  assert.notEqual(unknownList.code, 0);
  assert.match(unknownList.stderr, /Unknown command: roles/);

  // role-init still a top-level command (may fail on missing tent root / usage; not "unknown").
  const roleInit = await runCli("role-init");
  assert.notEqual(roleInit.code, 0);
  assert.doesNotMatch(roleInit.stderr, /Unknown command: role-init/);

  const roleCpHelp = await runCli("role-checkpoint", "--help");
  assert.equal(roleCpHelp.code, 0, roleCpHelp.stderr);
  assert.match(roleCpHelp.stdout, /role-checkpoint|Role Checkpoint/i);
});

test("session and task top-level routes remain intact", async () => {
  const sessionHelp = await runCli("session", "--help");
  assert.equal(sessionHelp.code, 0, sessionHelp.stderr);
  assert.match(sessionHelp.stdout, /tent session/);

  const taskHelp = await runCli("task", "--help");
  assert.equal(taskHelp.code, 0, taskHelp.stderr);
  assert.match(taskHelp.stdout, /tent task/);
  assert.equal(taskHelp.stdout.trim(), taskHelpText().trim());

  // Unknown top-level still fails loud with the command list including agent/role, not roles.
  const unknown = await runCli("not-a-command");
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown command: not-a-command/);
  assert.match(unknown.stderr, /\bagent\b/);
  assert.match(unknown.stderr, /\brole\b/);
  assert.doesNotMatch(unknown.stderr, /\broles\b/);
});
