#!/usr/bin/env node
// Tent CLI is the thin Agent-facing shell. Product mutations go through Local Service.
// First-time workspace initialization is the only direct scaffold operation.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeFs, SystemClock } from "../fs/node-fs.js";
import {
  installSkills,
  resolveCliSkillInstallDirs,
  type SkillInstallItemResult,
} from "../machine/skills.js";
import {
  doctorAgentHooks,
  formatAgentHooksResults,
  installAgentHooks,
  parseAgentHookId,
  removeAgentHooks,
  resolveAgentHookSelection,
  type AgentHookId,
} from "../machine/agent-hooks.js";
import { loadTent } from "../core/tree.js";
import type { OpsEnv } from "../core/ops-context.js";

import { findBoxesByTag, loadTagRegistry, normalizeTagName } from "../core/tags.js";
import { parseOutputPointer } from "../core/output.js";
import { ensureRoleInit } from "../core/task.js";
import { loadRolesRegistry } from "../core/skillRoleRegistry.js";
import { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE, renderTentStatus } from "../core/status.js";
import { withTentMutation } from "../core/adapter.js";
import { reAdoptOrphanTent, scaffoldInWorkspace } from "../core/scaffold.js";
import { workspaceRootFromSystemRoot } from "../core/paths.js";
import { runTaskCommand, taskHelpText } from "./task-rpc.js";
import { runSessionCommand, sessionHelpText } from "./session-rpc.js";
import { runNodeCommand, nodeHelpText } from "./node-rpc.js";
import {
  runAgentDefinitionCommand,
  agentDefinitionHelpText,
} from "./agent-definition-rpc.js";
import { runRoleCommand, roleHelpText } from "./role-rpc.js";
import {
  runRoleCheckpointCommand,
  roleCheckpointHelpText,
} from "./role-checkpoint-rpc.js";
import { runProposalSubmit } from "./proposal-rpc.js";

export function isInWorkspaceSystemRoot(systemRoot: string): boolean {
  return workspaceRootFromSystemRoot(systemRoot) !== undefined;
}

async function makeEnv(): Promise<OpsEnv> {
  // 找不到 system root 时明确失败；禁止回退 cwd 把系统数据写到项目根。
  const systemRoot = await findTentSystemRoot(process.cwd());
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  if (!workspace) throw new Error("Tent requires an in-workspace <workspace>/.tent layout.");
  return {
    fs: new NodeFs(systemRoot),
    clock: new SystemClock(),
    tentName: path.basename(workspace),
    tentRoot: systemRoot,
  };
}


async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(await packageVersion());
    return;
  }

  // Commands that do not require an existing system root
  if (cmd === "new") {
    const { positionals, flags } = parseFlags(args);
    if (!positionals[0]) {
      return fail(
        "Usage: tent new <workspace-path>\n" +
          "       tent new <workspace-path> --repair-existing"
      );
    }
    if (positionals.length > 1) {
      return fail(
        "Usage: tent new <workspace-path>\n" +
          "       tent new <workspace-path> --repair-existing"
      );
    }
    const repairExisting = flags["repair-existing"] === "true";
    // Reject unknown flags so --repair-existing stays the only new-path switch.
    const unknown = Object.keys(flags).filter((k) => k !== "repair-existing");
    if (unknown.length > 0) {
      return fail(
        `Unknown flag for tent new: --${unknown[0]}\n` +
          "Usage: tent new <workspace-path>\n" +
          "       tent new <workspace-path> --repair-existing"
      );
    }
    if (repairExisting) {
      await repairExistingTent(positionals[0]);
    } else {
      await newTent(positionals[0]);
    }
    return;
  }
  if (cmd === "skill-install") {
    const { positionals, flags } = parseFlags(args);
    if (positionals.length > 0) return fail("Usage: tent skill-install [--target all|claude|shared-agents] [--force]");
    const target = flags.target || "all";
    const force = flags.force === "true";
    // --dir overrides destinations for tests/single-path installs, but target is still validated.
    const defaultDirs = resolveCliSkillInstallDirs(target);
    const targetDirs = flags.dir ? [flags.dir] : defaultDirs;
    const results = await installSkills({
      packageRoot: packageRoot(),
      targetDirs,
      force,
    });
    console.log(formatSkillInstallResults(target, results));
    return;
  }
  // Machine-local native hook/config projection (no system root / Service required).
  if (cmd === "agent-hooks") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(agentHooksHelpText());
      return;
    }
    if (sub !== "install" && sub !== "doctor" && sub !== "remove") {
      return fail(
        `Unknown agent-hooks subcommand: ${sub}\nUsage: tent agent-hooks install|doctor|remove [--agent all|claude|codex|agy|copilot] [--json]`
      );
    }
    const { positionals, flags } = parseFlags(rest);
    if (positionals.length > 0) {
      return fail(
        `Usage: tent agent-hooks ${sub} [--agent all|claude|codex|agy|copilot] [--json]`
      );
    }
    let agents: AgentHookId[] | undefined;
    try {
      agents = flags.agent
        ? resolveAgentHookSelection([flags.agent])
        : undefined;
      // Validate alias early when --agent is a single token that might be invalid.
      if (flags.agent && flags.agent !== "all") parseAgentHookId(flags.agent);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const asJson = flags.json === "true";
    // --home is a test/CLI override for machine-local config roots.
    const home = flags.home || undefined;
    const tentCommand = flags["tent-command"] || flags.tentCommand || undefined;
    const runOpts = { agents, home, tentCommand };
    const batch =
      sub === "install"
        ? await installAgentHooks(runOpts)
        : sub === "doctor"
          ? await doctorAgentHooks(runOpts)
          : await removeAgentHooks(runOpts);
    if (asJson) {
      console.log(JSON.stringify(batch, null, 2));
    } else {
      console.log(formatAgentHooksResults(batch));
    }
    return;
  }
  // New-architecture task lifecycle: Local Service RPC only (no core direct write).
  if (cmd === "task") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(taskHelpText());
      return;
    }
    const result = await runTaskCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // External / pull-host session lifecycle (SessionRegistry state=external; no ACP spawn).
  // Public surface is tent session only — Session enter|status|leave|session-* never under tent agent.
  if (cmd === "session") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(sessionHelpText());
      return;
    }
    const result = await runSessionCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // Logical AgentDefinition management only (list|get|config). Not Session lifecycle.
  if (cmd === "agent") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(agentDefinitionHelpText());
      return;
    }
    const result = await runAgentDefinitionCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // Durable Role discovery + roster config (list|show|config). Not the old registry-list alias.
  if (cmd === "role") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(roleHelpText());
      return;
    }
    const result = await runRoleCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // Agent-facing Node reads and mutations: Local Service only.
  if (cmd === "node") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(nodeHelpText());
      return;
    }
    const result = await runNodeCommand(sub, rest, { packageRoot: packageRoot() });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // Optional cooperative Role Checkpoint (continuation note for Session replacement).
  if (cmd === "role-checkpoint") {
    const [sub, ...rest] = args;
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      console.log(roleCheckpointHelpText());
      return;
    }
    const result = await runRoleCheckpointCommand(sub, rest, {
      packageRoot: packageRoot(),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  if (cmd === "propose") {
    const { positionals } = parseFlags(args);
    const [nodeId, bodySource] = positionals;
    if (!nodeId || !bodySource || positionals.length > 2) {
      return fail("Usage: tent propose <nodeId> <bodyFile|->");
    }
    const role = process.env.TENT_ROLE;
    if (!role) return fail("tent propose requires TENT_ROLE to identify the submitting role");
    const body = bodySource === "-" ? await readStdin() : await readBodyFile(bodySource);
    const systemRoot = await findTentSystemRoot(process.cwd());
    if (!systemRoot) return fail(NOT_INSIDE_TENT_MESSAGE);
    const workspace = workspaceRootFromSystemRoot(systemRoot);
    if (!workspace) return fail("tent propose requires an in-workspace <workspace>/.tent layout");
    const result = await runProposalSubmit(
      { boxId: nodeId, role, body },
      { cwd: workspace, workspace, packageRoot: packageRoot() }
    );
    if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  const tentCommands = new Set(["role-init", "status", "tags", "find", "tree"]);
  if (!tentCommands.has(cmd)) {
    return fail(
      `Unknown command: ${cmd || "(empty)"}\nCommands: new node task session agent role propose role-init role-checkpoint status tags find tree skill-install agent-hooks`
    );
  }

  const env = await makeEnv();

  switch (cmd) {
    case "role-init": {
      const roleName = args[0];
      if (!roleName) return fail("Usage: tent role-init <role>");
      if (args.length > 1) return fail("Usage: tent role-init <role>");
      const roles = await loadRolesRegistry(env.fs);
      const role = roles.roles.find((item) => item.name === roleName) ?? { name: roleName };
      const initPath = await withTentMutation(
        env.fs,
        () => ensureRoleInit(env.fs, role, env.tentName)
      );
      console.log(`Read ${initPath} to complete role initialization.`);
      break;
    }
    case "status": {
      if (args.length > 0) return fail("Usage: tent status");
      try {
        process.stdout.write(
          await renderTentStatus(process.cwd(), process.env.TENT_ROLE, (root) => new NodeFs(root))
        );
      } catch (error) {
        if (error instanceof Error && error.message === NOT_INSIDE_TENT_MESSAGE) return fail(error.message);
        throw error;
      }
      break;
    }
    case "tags": {
      if (args.length > 0) return fail("Usage: tent tags");
      const registry = await loadTagRegistry(env.fs);
      if (registry.tags.length === 0) console.log("(no tags)");
      else for (const tag of registry.tags) console.log(tag);
      break;
    }
    case "find": {
      if (!args[0]) return fail("Usage: tent find <name>");
      if (args.length > 1) return fail("Usage: tent find <name>");
      try {
        normalizeTagName(args[0]);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const tent = await loadTent(env.fs);
      const boxes = findBoxesByTag(tent, args[0]);
      if (boxes.length === 0) {
        console.log("(no matches)");
        break;
      }
      for (const box of boxes) {
        const pointer = outputPointer(box.fm, box.body);
        console.log(`${box.id}\t${box.path}\t${box.type}${pointer ? `\t${pointer}` : ""}`);
      }
      break;
    }
    case "tree": {
      if (args.length > 0) return fail("Usage: tent tree");
      const tent = await loadTent(env.fs);
      for (const r of tent.roots) printBox(r, 0);
      break;
    }
    default:
      // Unreachable: unknown commands rejected before makeEnv.
      return fail(`Unknown command: ${cmd || "(empty)"}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readBodyFile(bodySource: string): Promise<string> {
  const resolved = path.resolve(bodySource);
  if (!(await existsPath(resolved))) throw new Error(`Body file not found: ${bodySource}.`);
  return fs.readFile(resolved, "utf8");
}

function printBox(box: import("../core/types.js").Box, depth: number) {
  const ind = "  ".repeat(depth);
  const mode = box.archived ? " archived" : "";
  const type = box.type;
  const id = box.id || "missing-id";
  const invalid = box.invalid ? ` invalid:${box.invalidReason || "invalid"}` : "";
  console.log(`${ind}${box.name} [${type} ${id}]${mode}${invalid}`);
  for (const c of box.children) printBox(c, depth + 1);
}

function outputPointer(fm: import("../core/types.js").BoxFrontmatter, body: string): string {
  const { workspace, ref } = parseOutputPointer(fm, body);
  return [workspace ? `workspace=${workspace}` : "", ref ? `ref=${ref}` : ""].filter(Boolean).join(" ");
}

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 1;
}

/** 解析 args 里的 --flag <value>,其余作为位置参数。 */
function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleanFlags = new Set(["force", "json", "repair-existing"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (booleanFlags.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function agentHooksHelpText(): string {
  return `tent agent-hooks — machine-local native hook/config projection (V0.2)

Usage:
  tent agent-hooks install [--agent all|claude|codex|agy|copilot] [--json]
  tent agent-hooks doctor  [--agent all|claude|codex|agy|copilot] [--json]
  tent agent-hooks remove  [--agent all|claude|codex|agy|copilot] [--json]

Behavior:
  - SessionStart → tent session session-start --host <agent>
  - Stop         → tent session session-end --host <agent>
  - CLI hook aliases parse session identity/cwd from native hook stdin and
    silently skip non-Tent workspaces (leave never needs a sessionId positional).
  - Merges into existing agent configs; never rewrites permissions or MCP.
  - install / doctor / remove are idempotent; remove only Tent-managed handlers.
  - Legacy tent agent session-* entries may be replaced/removed on install only;
    they are not generated or advertised as callable aliases.
  - Antigravity (agy) and Copilot report unsupported when no verified lifecycle hook surface exists.
  - Projection only writes under --home (tests) or os.homedir(); never smoke real user configs.

Options:
  --agent <id>     Target agent (default: all). Alias: agy → antigravity.
  --json           Machine-readable result.
  --home <path>    Override home for config roots (tests / isolated fixtures only).
  --tent-command <cmd>  Override tent entry used in projected commands (tests).
`;
}

/** CLI stdout for skill-install — keep message shape compatible with package tests. */
function formatSkillInstallResults(target: string, results: SkillInstallItemResult[]): string {
  const byDir = new Map<string, SkillInstallItemResult[]>();
  for (const item of results) {
    const list = byDir.get(item.targetDir) ?? [];
    list.push(item);
    byDir.set(item.targetDir, list);
  }
  const lines: string[] = [`✓ skill-install (${target})`];
  for (const [dir, items] of byDir) {
    lines.push(`  ${dir}`);
    for (const item of items) {
      const suffix = item.status === "skipped" && item.reason ? ` (${item.reason})` : "";
      lines.push(`    - ${item.skill}: ${item.status}${suffix}`);
    }
  }
  return lines.join("\n");
}

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(here) === "cli" && path.basename(path.dirname(here)) === "src") {
    return path.resolve(here, "../..");
  }
  return here;
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await fs.readFile(path.join(packageRoot(), "package.json"), "utf8"));
  return String(pkg.version ?? "0.0.0");
}

function helpText(): string {
  return `Tent CLI

Usage:
  tent <command> [args]

Run commands from a workspace with <workspace>/.tent/ unless noted.

Logical Agent, durable Role, Session, and Task (distinct surfaces):
  tent agent list|get|config          Logical AgentDefinition (id→profileId; no secrets/Session)
  tent agent --help                   AgentDefinition subcommand help
  tent role list|show|config          Durable Role discovery + roster config (Service-backed)
  tent role --help                    Role subcommand help
  tent session enter|status|leave     External session lifecycle (no ACP spawn)
  tent session --help                 Pull-host enter/status/leave + hook aliases
  tent task list|get|claim|deliver|…  Attach Local Service → mount → task.* RPC
  tent task --help                    Full task subcommand help

Service-backed workspace operations:
  tent node list|get|create|write|… Agent-facing Node operations through Local Service
  tent node --help                   Full Node subcommand help
  tent role-checkpoint set|show|clear Optional cooperative Role continuation note
  tent role-checkpoint --help         set/clear → Service; show read-only; --actor
  propose <boxId> <file|->            Submit a proposal (in-workspace → proposal.submit RPC)
  CLI exit does not stop Local Service. Token stays in machine-local service.json.

Initialization and machine config:
  new <workspace-path>               Create <workspace>/.tent without touching project files.
                                     Use "tent new ." to adopt an existing project.
  new <workspace-path> --repair-existing
                                     One-shot re-adopt of an orphan <workspace>/.tent
                                     (missing index + Tent evidence). Never runs genesis.
  skill-install [--target all|claude|shared-agents] [--force]
                                     Install bundled skills to selected machine roots.
  agent-hooks install|doctor|remove [--agent all|claude|codex|agy|copilot]
                                     Project Tent-managed SessionStart/Stop hooks into
                                     verified agent configs (no permissions / MCP).
  role-init <role>                   Regenerate the derived stable role init document.
  role-checkpoint set|show|clear     Continuation note: set/clear via Local Service; show read-only.
                                     set/clear accept --actor user|<role> (default user).

Read-only:
  status                             Print a read-only Tent status summary.
  tags                               List registered tags.
  find <tag>                         Find boxes by tag.
  tree                               Print the Node tree.

Options:
  -h, --help                         Show this help.
  -v, --version                      Show the package version.
`;
}

/**
 * 建一顶新帐：in-workspace 布局 `<target>/.tent/`。
 * `target` is the workspace root. Existing project files remain untouched.
 */
async function newTent(target: string): Promise<void> {
  const fsmod = await import("node:fs/promises");
  const workspaceRoot = path.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${workspaceRoot}`);

  await fsmod.mkdir(workspaceRoot, { recursive: true });
  const name = path.basename(workspaceRoot);
  await scaffoldInWorkspace(fsa, { name });

  console.log(
    `✓ Created Tent: ${path.join(workspaceRoot, ".tent")}\n` +
      `In-workspace layout: collaboration facts live under <workspace>/.tent/.\n` +
      `The Node tree starts empty; use tent-init to propose and approve its initial structure.`
  );
}

/**
 * One-shot re-adopt: `tent new <target> --repair-existing`.
 * Calls Core reAdoptOrphanTent on that exact workspace only — never genesis/scaffold.
 * Fail-closed Core errors surface as non-zero exit with zero writes.
 */
async function repairExistingTent(target: string): Promise<void> {
  const workspaceRoot = path.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  let result;
  try {
    result = await reAdoptOrphanTent(fsa);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const created: string[] = [];
  if (result.createdIndex) created.push("index.md");
  for (const dir of result.createdDirs) created.push(`${dir}/`);
  for (const reg of result.createdRegistries) created.push(reg);
  if (result.gitignoreUpdated) created.push(".gitignore (.tent/ entry)");

  const createdLine =
    created.length > 0
      ? `Created structural pieces: ${created.join(", ")}`
      : "Created structural pieces: (none beyond index)";

  console.log(
    `✓ Re-adopted orphan Tent: ${path.join(workspaceRoot, ".tent")}\n` +
      `${createdLine}\n` +
      `Existing Node/registry/temp bytes were preserved; no genesis scaffold ran.`
  );
}

// Only auto-run when this file is the process entry (not when imported by tests).
// Resolve through realpath so Windows junctions / global-style symlink entries still match.
// Async IIFE (not top-level await): esbuild CLI target is es2021.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = path.resolve(fileURLToPath(import.meta.url));
const normalizeEntryPath = (value: string) =>
  process.platform === "win32" ? value.toLowerCase() : value;

void (async () => {
  if (!entry) return;
  const realEntry = await fs.realpath(entry).catch(() => entry);
  const realThisFile = await fs.realpath(thisFile).catch(() => thisFile);
  const isDirectEntry =
    normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile) ||
    normalizeEntryPath(realEntry) === normalizeEntryPath(realThisFile.replace(/\.ts$/i, ".js"));
  if (!isDirectEntry) return;
  await main();
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
