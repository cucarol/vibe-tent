/**
 * Machine-local agent hook/config projection — offline unit tests + fixtures.
 * Covers Claude + Codex lifecycle merge (install/doctor/remove idempotent),
 * session-start/end --host projection only (no bare enter/leave identity),
 * unsupported agents (antigravity/copilot), and preservation of non-hook config.
 * Does not start real agents; does not touch permissions/MCP;
 * all mutations use isolated HOME fixtures only (never real user config).
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
  isManagedHookCommand,
  isManagedLeaveCommand,
  isManagedSessionEndForHost,
  isManagedSessionStartForHost,
  managedCommandHost,
  managedSessionEndCommand,
  managedSessionStartCommand,
  parseAgentHookId,
  removeAgentHooks,
  resolveAgentHookSelection,
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

type HookHandler = {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
};

type HookGroup = { matcher?: string; hooks: HookHandler[] };

function allCommands(
  hooks: Record<string, HookGroup[] | undefined>,
  event: string
): string[] {
  const groups = hooks[event] ?? [];
  return groups.flatMap((g) => (g.hooks ?? []).map((h) => String(h.command ?? "")));
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

test("managed identity: only session-start/end --host; never bare enter/leave", () => {
  assert.equal(
    managedSessionStartCommand("claude"),
    "tent agent session-start --host claude"
  );
  assert.equal(
    managedSessionEndCommand("claude"),
    "tent agent session-end --host claude"
  );
  assert.equal(
    managedSessionStartCommand("codex"),
    "tent agent session-start --host codex"
  );
  assert.equal(
    managedSessionEndCommand("codex"),
    "tent agent session-end --host codex"
  );

  assert.ok(isManagedHookCommand("tent agent session-start --host claude"));
  assert.ok(isManagedEnterCommand("tent agent session-start --host claude"));
  assert.ok(isManagedLeaveCommand("tent agent session-end --host claude"));
  assert.ok(isManagedSessionStartForHost("tent agent session-start --host claude", "claude"));
  assert.ok(isManagedSessionEndForHost("tent agent session-end --host codex", "codex"));
  assert.equal(
    isManagedSessionStartForHost("tent agent session-start --host codex", "claude"),
    false
  );

  assert.equal(managedCommandHost("tent agent session-start --host claude"), "claude");
  assert.equal(managedCommandHost("tent agent session-end --host codex"), "codex");

  assert.ok(isManagedEnterCommand('"/path/to/tent" agent session-start --host claude'));

  // Bare / unpublished enter|leave must NOT be managed identity (avoid removing user commands).
  assert.equal(isManagedHookCommand("tent agent enter"), false);
  assert.equal(isManagedHookCommand("tent agent leave"), false);
  assert.equal(isManagedEnterCommand("tent agent enter"), false);
  assert.equal(isManagedLeaveCommand("tent agent leave"), false);
  assert.equal(isManagedSessionStartForHost("tent agent enter", "claude"), false);
  assert.equal(isManagedSessionEndForHost("tent agent leave", "claude"), false);

  // session-* without --host is not managed.
  assert.equal(isManagedHookCommand("tent agent session-start"), false);
  assert.equal(isManagedHookCommand("tent agent session-end"), false);

  assert.equal(isManagedEnterCommand("echo hello"), false);
  assert.equal(isManagedLeaveCommand("tent agent session-start --host claude"), false);
});

test("Claude: install merges SessionStart/Stop with --host claude; preserves permissions", async () => {
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
    theme?: string;
    permissions?: { allow?: string[] };
    hooks?: Record<string, HookGroup[]>;
  };
  assert.equal(after.model, "claude-opus-4-6");
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.permissions?.allow, ["Read", "Bash(git status)"]);
  assert.ok(Array.isArray(after.hooks?.SessionStart));
  assert.ok(Array.isArray(after.hooks?.Stop));
  assert.ok(Array.isArray(after.hooks?.PreToolUse));
  assert.equal((after.hooks!.PreToolUse as HookGroup[]).length, 1);
  assert.equal(
    (after.hooks!.PreToolUse as HookGroup[])[0]!.hooks[0]!.command,
    "echo pre-existing-hook"
  );

  const enterCmds = allCommands(after.hooks!, "SessionStart");
  const leaveCmds = allCommands(after.hooks!, "Stop");
  assert.ok(enterCmds.some((c) => c === "tent agent session-start --host claude"));
  assert.ok(leaveCmds.some((c) => c === "tent agent session-end --host claude"));
  assert.equal(enterCmds.some((c) => /\bagent\s+enter\b/.test(c)), false);
  assert.equal(leaveCmds.some((c) => /\bagent\s+leave\b/.test(c)), false);

  const enterHandlers = (after.hooks!.SessionStart as HookGroup[]).flatMap((g) => g.hooks);
  const managedEnter = enterHandlers.find((h) =>
    isManagedSessionStartForHost(h.command, "claude")
  )!;
  assert.equal(managedEnter.type, "command");
  assert.equal(managedEnter.timeout, 60);
  assert.equal(managedCommandHost(managedEnter.command), "claude");

  const second = await installAgentHooks({ home, agents: ["claude"] });
  assert.equal(second.results[0]!.status, "skipped");
  const after2 = (await readJson(settingsPath)) as typeof after;
  const enterCount = allCommands(after2.hooks!, "SessionStart").filter((c) =>
    isManagedSessionStartForHost(c, "claude")
  ).length;
  assert.equal(enterCount, 1);
  const leaveCount = allCommands(after2.hooks!, "Stop").filter((c) =>
    isManagedSessionEndForHost(c, "claude")
  ).length;
  assert.equal(leaveCount, 1);
  assert.deepEqual(after2.permissions?.allow, ["Read", "Bash(git status)"]);
  assert.equal(
    (after2.hooks!.PreToolUse as HookGroup[])[0]!.hooks[0]!.command,
    "echo pre-existing-hook"
  );

  const doc = await doctorAgentHooks({ home, agents: ["claude"] });
  assert.equal(doc.results[0]!.status, "ok");
  assert.deepEqual(doc.results[0]!.present, ["SessionStart", "Stop"]);
});

test("Claude: remove only formal Tent-managed handlers; keeps foreign and bare enter/leave", async () => {
  const home = await tempHome("tent-hooks-claude-rm-");
  const fixture = await readJson(path.join(fixturesDir, "claude-settings-existing.json"));
  const settingsPath = claudeSettingsPath(home);
  await writeJson(settingsPath, fixture);
  await installAgentHooks({ home, agents: ["claude"] });

  // User-authored bare enter/leave must survive remove (not managed identity).
  const withUser = (await readJson(settingsPath)) as {
    model?: string;
    permissions?: unknown;
    hooks?: Record<string, HookGroup[]>;
  };
  (withUser.hooks!.SessionStart as HookGroup[]).push({
    hooks: [{ type: "command", command: "tent agent enter", timeout: 10 }],
  });
  (withUser.hooks!.Stop as HookGroup[]).push({
    hooks: [{ type: "command", command: "tent agent leave", timeout: 10 }],
  });
  await writeJson(settingsPath, withUser);

  const removed = await removeAgentHooks({ home, agents: ["claude"] });
  assert.equal(removed.results[0]!.status, "removed");

  const after = (await readJson(settingsPath)) as {
    model?: string;
    permissions?: unknown;
    hooks?: Record<string, HookGroup[]>;
  };
  assert.equal(after.model, "claude-opus-4-6");
  assert.ok(after.permissions);
  assert.ok(after.hooks?.PreToolUse);
  assert.equal(
    (after.hooks!.PreToolUse as HookGroup[])[0]!.hooks[0]!.command,
    "echo pre-existing-hook"
  );
  // Formal managed gone
  assert.equal(
    allCommands(after.hooks!, "SessionStart").some((c) =>
      isManagedSessionStartForHost(c, "claude")
    ),
    false
  );
  assert.equal(
    allCommands(after.hooks!, "Stop").some((c) => isManagedSessionEndForHost(c, "claude")),
    false
  );
  // User bare enter/leave preserved
  assert.ok(allCommands(after.hooks!, "SessionStart").includes("tent agent enter"));
  assert.ok(allCommands(after.hooks!, "Stop").includes("tent agent leave"));

  const again = await removeAgentHooks({ home, agents: ["claude"] });
  assert.equal(again.results[0]!.status, "skipped");
});

test("Codex: install into hooks.json preserves foreign handlers; host=codex; JSON shape", async () => {
  const home = await tempHome("tent-hooks-codex-");
  const fixture = await readJson(path.join(fixturesDir, "codex-hooks-existing.json"));
  const hooksPath = codexHooksPath(home);
  await writeJson(hooksPath, fixture);

  const first = await installAgentHooks({ home, agents: ["codex"] });
  assert.equal(first.results[0]!.status, "installed");

  const afterRoot = (await readJson(hooksPath)) as {
    description?: string;
    hooks: Record<string, HookGroup[]>;
  };
  const after = afterRoot.hooks;
  assert.equal(afterRoot.description, "Existing Codex hooks");
  assert.ok(Array.isArray(after.UserPromptSubmit));
  assert.equal(after.UserPromptSubmit.length, 1);
  assert.equal(
    after.UserPromptSubmit[0]!.hooks[0]!.command,
    "echo pre-existing-codex-hook"
  );

  const startHandlers = after.SessionStart.flatMap((g) => g.hooks);
  const managed = startHandlers.find((h) =>
    isManagedSessionStartForHost(String(h.command), "codex")
  )!;
  assert.ok(managed);
  assert.equal(managed.command, "tent agent session-start --host codex");
  assert.equal(managedCommandHost(String(managed.command)), "codex");
  assert.equal(managed.statusMessage, TENT_HOOK_MARKER);
  assert.equal(managed.async, undefined);
  assert.equal(managed.timeout, 60);
  assert.equal(managed.type, "command");

  const leaveHandlers = after.Stop.flatMap((g) => g.hooks);
  const managedLeave = leaveHandlers.find((h) =>
    isManagedSessionEndForHost(String(h.command), "codex")
  )!;
  assert.equal(managedLeave.command, "tent agent session-end --host codex");
  assert.equal(managedLeave.async, undefined);
  assert.equal(managedLeave.timeout, 60);
  assert.equal(managedLeave.statusMessage, TENT_HOOK_MARKER);

  const second = await installAgentHooks({ home, agents: ["codex"] });
  assert.equal(second.results[0]!.status, "skipped");
  const after2 = ((await readJson(hooksPath)) as typeof afterRoot).hooks;
  const startCount = after2.SessionStart.flatMap((g) => g.hooks).filter((h) =>
    isManagedSessionStartForHost(String(h.command), "codex")
  ).length;
  assert.equal(startCount, 1);
  assert.equal(
    after2.UserPromptSubmit[0]!.hooks[0]!.command,
    "echo pre-existing-codex-hook"
  );

  await removeAgentHooks({ home, agents: ["codex"] });
  const afterRm = ((await readJson(hooksPath)) as typeof afterRoot).hooks;
  assert.ok(afterRm.UserPromptSubmit);
  assert.equal(
    afterRm.UserPromptSubmit[0]!.hooks[0]!.command,
    "echo pre-existing-codex-hook"
  );
  assert.equal(afterRm.SessionStart, undefined);
  assert.equal(afterRm.Stop, undefined);
});

test("Codex: install migrates legacy root events; doctor rejects them first", async () => {
  const home = await tempHome("tent-hooks-codex-legacy-");
  const hooksPath = codexHooksPath(home);
  await writeJson(hooksPath, {
    SessionStart: [{ hooks: [{ type: "command", command: "echo legacy-start" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo legacy-prompt" }] }],
  });

  const before = await doctorAgentHooks({ home, agents: ["codex"] });
  assert.equal(before.results[0]!.status, "error");
  assert.match(before.results[0]!.reason ?? "", /nested under \"hooks\"/);

  const installed = await installAgentHooks({ home, agents: ["codex"] });
  assert.equal(installed.results[0]!.status, "installed");
  const root = (await readJson(hooksPath)) as {
    hooks: Record<string, HookGroup[]>;
    SessionStart?: unknown;
  };
  assert.equal(root.SessionStart, undefined);
  assert.ok(root.hooks.SessionStart);
  assert.ok(root.hooks.UserPromptSubmit);
  assert.ok(allCommands(root.hooks, "SessionStart").includes("echo legacy-start"));
  assert.ok(allCommands(root.hooks, "UserPromptSubmit").includes("echo legacy-prompt"));
  const managed = root.hooks.SessionStart.flatMap((group) => group.hooks).find((handler) =>
    isManagedSessionStartForHost(handler.command, "codex")
  )!;
  assert.equal(managed.async, undefined);
  assert.equal(managed.timeout, 60);
});

test("Codex: doctor missing when hooks.json absent", async () => {
  const home = await tempHome("tent-hooks-codex-miss-");
  const doc = await doctorAgentHooks({ home, agents: ["codex"] });
  assert.equal(doc.results[0]!.status, "missing");
  assert.ok(
    doc.results[0]!.path?.endsWith(path.join(".codex", "hooks.json")) ||
      doc.results[0]!.path?.includes(".codex")
  );
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
  assert.equal(await exists(path.join(home, ".gemini")), false);
  assert.equal(await exists(path.join(home, ".copilot")), false);
  assert.equal(await exists(path.join(home, ".antigravity")), false);

  const doc = await doctorAgentHooks({
    home,
    agents: resolveAgentHookSelection(["agy", "copilot"]),
  });
  assert.equal(doc.results.every((r) => r.status === "unsupported"), true);

  const rm = await removeAgentHooks({
    home,
    agents: ["antigravity", "copilot"],
  });
  assert.equal(rm.results.every((r) => r.status === "unsupported"), true);
});

test("install all: lifecycle agents + unsupported; host params per agent", async () => {
  const home = await tempHome("tent-hooks-all-");
  const batch = await installAgentHooks({ home });
  const byAgent = Object.fromEntries(batch.results.map((r) => [r.agent, r]));
  assert.equal(byAgent.claude?.status, "installed");
  assert.equal(byAgent.codex?.status, "installed");
  assert.equal(byAgent.antigravity?.status, "unsupported");
  assert.equal(byAgent.copilot?.status, "unsupported");

  const claudeSettings = (await readJson(claudeSettingsPath(home))) as {
    hooks: Record<string, HookGroup[]>;
  };
  assert.ok(
    allCommands(claudeSettings.hooks, "SessionStart").includes(
      "tent agent session-start --host claude"
    )
  );
  assert.ok(
    allCommands(claudeSettings.hooks, "Stop").includes(
      "tent agent session-end --host claude"
    )
  );

  const codexHooks = (
    (await readJson(codexHooksPath(home))) as {
      hooks: Record<string, HookGroup[]>;
    }
  ).hooks;
  assert.ok(
    allCommands(codexHooks, "SessionStart").includes(
      "tent agent session-start --host codex"
    )
  );
  assert.ok(
    allCommands(codexHooks, "Stop").includes("tent agent session-end --host codex")
  );

  const home2 = await tempHome("tent-hooks-custom-tent-");
  await installAgentHooks({
    home: home2,
    agents: ["claude"],
    tentCommand: path.join(home2, "bin", "tent"),
  });
  const settings = (await readJson(claudeSettingsPath(home2))) as {
    hooks: { SessionStart: HookGroup[]; Stop: HookGroup[] };
  };
  const startCmd = settings.hooks.SessionStart[0]!.hooks[0]!.command!;
  const endCmd = settings.hooks.Stop[0]!.hooks[0]!.command!;
  assert.ok(startCmd.includes("agent session-start"));
  assert.ok(startCmd.includes("--host claude"));
  assert.ok(startCmd.includes("tent"));
  assert.ok(endCmd.includes("agent session-end"));
  assert.ok(endCmd.includes("--host claude"));
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
  assert.equal(await fs.readFile(settingsPath, "utf8"), "{not-json");
});

test("install does not rewrite user bare enter/leave commands", async () => {
  const home = await tempHome("tent-hooks-user-enter-");
  const settingsPath = claudeSettingsPath(home);
  await writeJson(settingsPath, {
    model: "keep-me",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "tent agent enter", timeout: 30 }] }],
      Stop: [{ hooks: [{ type: "command", command: "tent agent leave", timeout: 30 }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo foreign", timeout: 5 }] }],
    },
  });

  const batch = await installAgentHooks({ home, agents: ["claude"] });
  assert.equal(batch.results[0]!.status, "installed");

  const after = (await readJson(settingsPath)) as {
    model?: string;
    hooks?: Record<string, HookGroup[]>;
  };
  assert.equal(after.model, "keep-me");
  const enterCmds = allCommands(after.hooks!, "SessionStart");
  const leaveCmds = allCommands(after.hooks!, "Stop");
  // User bare commands untouched; formal managed added alongside.
  assert.ok(enterCmds.includes("tent agent enter"));
  assert.ok(leaveCmds.includes("tent agent leave"));
  assert.ok(enterCmds.includes("tent agent session-start --host claude"));
  assert.ok(leaveCmds.includes("tent agent session-end --host claude"));
  assert.equal(
    (after.hooks!.PreToolUse as HookGroup[])[0]!.hooks[0]!.command,
    "echo foreign"
  );
});
