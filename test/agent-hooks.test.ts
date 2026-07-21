/**
 * Machine-local agent hook/config projection — offline unit tests + fixtures.
 * Covers Claude + Codex lifecycle merge (install/doctor/remove idempotent),
 * unsupported agents (antigravity/copilot), and preservation of non-hook config.
 * Does not start real agents; does not touch permissions/MCP.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_HOOK_IDS,
  claudeSettingsPath,
  codexHooksPath,
  doctorAgentHooks,
  formatAgentHooksResults,
  installAgentHooks,
  isManagedEnterCommand,
  isManagedLeaveCommand,
  managedEnterCommand,
  managedLeaveCommand,
  parseAgentHookId,
  removeAgentHooks,
  resolveAgentHookSelection,
  TENT_HOOK_ENTER_COMMAND,
  TENT_HOOK_LEAVE_COMMAND,
  TENT_HOOK_MARKER,
} from "../src/machine/agent-hooks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures", "agent-hooks");

async function tempHome(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("parseAgentHookId: aliases and rejection", () => {
  assert.equal(parseAgentHookId("claude"), "claude");
  assert.equal(parseAgentHookId("claude-code"), "claude");
  assert.equal(parseAgentHookId("codex"), "codex");
  assert.equal(parseAgentHookId("agy"), "antigravity");
  assert.equal(parseAgentHookId("antigravity"), "antigravity");
  assert.equal(parseAgentHookId("copilot"), "copilot");
  assert.throws(() => parseAgentHookId("gemini"), /Unknown agent/);
  assert.deepEqual(resolveAgentHookSelection(["all"]), [...AGENT_HOOK_IDS]);
  assert.deepEqual(resolveAgentHookSelection(["agy", "claude"]), [
    "antigravity",
    "claude",
  ]);
});

test("managed command identity", () => {
  assert.equal(managedEnterCommand(), TENT_HOOK_ENTER_COMMAND);
  assert.equal(managedLeaveCommand(), TENT_HOOK_LEAVE_COMMAND);
  assert.ok(isManagedEnterCommand("tent agent enter"));
  assert.ok(isManagedLeaveCommand("tent agent leave"));
  assert.ok(isManagedEnterCommand('"/path/to/tent" agent enter'));
  assert.equal(isManagedEnterCommand("echo hello"), false);
  assert.equal(isManagedLeaveCommand("tent agent enter"), false);
});

test("Claude: install merges SessionStart/Stop without touching permissions", async () => {
  const home = await tempHome("tent-hooks-claude-");
  const fixture = await readJson(path.join(fixturesDir, "claude-settings-existing.json"));
  const settingsPath = claudeSettingsPath(home);
  await writeJson(settingsPath, fixture);

  const first = await installAgentHooks({ home, agents: ["claude"] });
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0]!.status, "installed");
  assert.equal(first.results[0]!.path, settingsPath);

  const after = (await readJson(settingsPath)) as {
    model?: string;
    permissions?: { allow?: string[] };
    hooks?: Record<string, unknown[]>;
  };
  // Preserve pre-existing fields (including permissions — never rewritten by us).
  assert.equal(after.model, "claude-opus-4-6");
  assert.deepEqual(after.permissions?.allow, ["Read", "Bash(git status)"]);
  assert.ok(Array.isArray(after.hooks?.SessionStart));
  assert.ok(Array.isArray(after.hooks?.Stop));
  // Existing PreToolUse group preserved.
  assert.ok(Array.isArray(after.hooks?.PreToolUse));
  assert.equal((after.hooks!.PreToolUse as unknown[]).length, 1);

  const enterGroup = after.hooks!.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
  const enterCmds = enterGroup.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(enterCmds.some((c) => isManagedEnterCommand(c)));
  const leaveGroup = after.hooks!.Stop as Array<{ hooks: Array<{ command: string }> }>;
  const leaveCmds = leaveGroup.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(leaveCmds.some((c) => isManagedLeaveCommand(c)));

  // Idempotent second install.
  const second = await installAgentHooks({ home, agents: ["claude"] });
  assert.equal(second.results[0]!.status, "skipped");
  const after2 = (await readJson(settingsPath)) as typeof after;
  const enterCount = (after2.hooks!.SessionStart as Array<{ hooks: unknown[] }>)
    .flatMap((g) => g.hooks)
    .filter((h) => isManagedEnterCommand((h as { command?: string }).command)).length;
  assert.equal(enterCount, 1);

  const doc = await doctorAgentHooks({ home, agents: ["claude"] });
  assert.equal(doc.results[0]!.status, "ok");
  assert.deepEqual(doc.results[0]!.present, ["SessionStart", "Stop"]);
});

test("Claude: remove only Tent-managed handlers", async () => {
  const home = await tempHome("tent-hooks-claude-rm-");
  const fixture = await readJson(path.join(fixturesDir, "claude-settings-existing.json"));
  const settingsPath = claudeSettingsPath(home);
  await writeJson(settingsPath, fixture);
  await installAgentHooks({ home, agents: ["claude"] });

  const removed = await removeAgentHooks({ home, agents: ["claude"] });
  assert.equal(removed.results[0]!.status, "removed");

  const after = (await readJson(settingsPath)) as {
    permissions?: unknown;
    hooks?: Record<string, unknown[]>;
  };
  assert.ok(after.permissions);
  assert.ok(after.hooks?.PreToolUse);
  assert.equal(after.hooks?.SessionStart, undefined);
  assert.equal(after.hooks?.Stop, undefined);

  const again = await removeAgentHooks({ home, agents: ["claude"] });
  assert.equal(again.results[0]!.status, "skipped");

  const doc = await doctorAgentHooks({ home, agents: ["claude"] });
  assert.equal(doc.results[0]!.status, "missing");
});

test("Codex: install into hooks.json preserves foreign handlers", async () => {
  const home = await tempHome("tent-hooks-codex-");
  const fixture = await readJson(path.join(fixturesDir, "codex-hooks-existing.json"));
  const hooksPath = codexHooksPath(home);
  await writeJson(hooksPath, fixture);

  const first = await installAgentHooks({ home, agents: ["codex"] });
  assert.equal(first.results[0]!.status, "installed");

  const after = (await readJson(hooksPath)) as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  // Existing UserPromptSubmit preserved.
  assert.ok(Array.isArray(after.UserPromptSubmit));
  assert.equal(after.UserPromptSubmit.length, 1);
  // Managed markers
  const startHandlers = after.SessionStart.flatMap((g) => g.hooks);
  assert.ok(startHandlers.some((h) => isManagedEnterCommand(String(h.command))));
  assert.ok(startHandlers.some((h) => h.statusMessage === TENT_HOOK_MARKER));
  // Codex shape uses async:false
  const managed = startHandlers.find((h) => isManagedEnterCommand(String(h.command)))!;
  assert.equal(managed.async, false);
  assert.equal(managed.type, "command");

  const leaveHandlers = after.Stop.flatMap((g) => g.hooks);
  assert.ok(leaveHandlers.some((h) => isManagedLeaveCommand(String(h.command))));

  const second = await installAgentHooks({ home, agents: ["codex"] });
  assert.equal(second.results[0]!.status, "skipped");

  await removeAgentHooks({ home, agents: ["codex"] });
  const afterRm = (await readJson(hooksPath)) as typeof after;
  assert.ok(afterRm.UserPromptSubmit);
  assert.equal(afterRm.SessionStart, undefined);
  assert.equal(afterRm.Stop, undefined);
});

test("Codex: doctor missing when hooks.json absent", async () => {
  const home = await tempHome("tent-hooks-codex-miss-");
  const doc = await doctorAgentHooks({ home, agents: ["codex"] });
  assert.equal(doc.results[0]!.status, "missing");
  assert.ok(doc.results[0]!.path?.endsWith(path.join(".codex", "hooks.json")) || doc.results[0]!.path?.includes(".codex"));
});

test("Antigravity and Copilot: unsupported without guessing config", async () => {
  const home = await tempHome("tent-hooks-unsup-");
  const batch = await installAgentHooks({
    home,
    agents: ["antigravity", "copilot"],
  });
  assert.equal(batch.results.length, 2);
  for (const r of batch.results) {
    assert.equal(r.support, "unsupported");
    assert.equal(r.status, "unsupported");
    assert.ok(r.reason && /not guessed/i.test(r.reason));
  }
  // No config files invented for unsupported agents.
  assert.equal(await exists(path.join(home, ".gemini")), false);
  assert.equal(await exists(path.join(home, ".copilot")), false);
  assert.equal(await exists(path.join(home, ".antigravity")), false);

  const doc = await doctorAgentHooks({
    home,
    agents: resolveAgentHookSelection(["agy", "copilot"]),
  });
  assert.equal(doc.results.every((r) => r.status === "unsupported"), true);
});

test("install all: lifecycle agents + unsupported in one batch", async () => {
  const home = await tempHome("tent-hooks-all-");
  const batch = await installAgentHooks({ home });
  const byAgent = Object.fromEntries(batch.results.map((r) => [r.agent, r]));
  assert.equal(byAgent.claude?.status, "installed");
  assert.equal(byAgent.codex?.status, "installed");
  assert.equal(byAgent.antigravity?.status, "unsupported");
  assert.equal(byAgent.copilot?.status, "unsupported");

  // Custom tent command projected into commands.
  const home2 = await tempHome("tent-hooks-custom-tent-");
  await installAgentHooks({
    home: home2,
    agents: ["claude"],
    tentCommand: path.join(home2, "bin", "tent"),
  });
  const settings = (await readJson(claudeSettingsPath(home2))) as {
    hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
  };
  const cmd = settings.hooks.SessionStart[0]!.hooks[0]!.command;
  assert.ok(cmd.includes("agent enter"));
  assert.ok(cmd.includes("tent"));
});

test("formatAgentHooksResults: stable summary lines", () => {
  const text = formatAgentHooksResults({
    action: "doctor",
    results: [
      {
        agent: "claude",
        support: "lifecycle",
        status: "ok",
        path: "/tmp/.claude/settings.json",
        present: ["SessionStart", "Stop"],
        missing: [],
      },
      {
        agent: "copilot",
        support: "unsupported",
        status: "unsupported",
        reason: "no surface",
      },
    ],
  });
  assert.ok(text.includes("agent-hooks doctor"));
  assert.ok(text.includes("claude: ok"));
  assert.ok(text.includes("copilot: unsupported"));
});

test("Claude: corrupt JSON is error, not silent overwrite", async () => {
  const home = await tempHome("tent-hooks-bad-json-");
  const settingsPath = claudeSettingsPath(home);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, "{not-json", "utf8");
  const batch = await installAgentHooks({ home, agents: ["claude"] });
  assert.equal(batch.results[0]!.status, "error");
  assert.ok(/Invalid JSON/i.test(batch.results[0]!.reason ?? ""));
  // File left untouched.
  assert.equal(await fs.readFile(settingsPath, "utf8"), "{not-json");
});
