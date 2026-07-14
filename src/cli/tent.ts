#!/usr/bin/env node
// tent CLI —— agent 侧的薄壳。tent-genesis / tent-role 等 skill 脚本就是喊这个命令。
// 用法(cwd = 帐根 / workspace 根, new 例外):
//   --- 新架构协作生命周期（Local Service RPC；不直写）---
//   tent task list|get|claim|deliver|…  attach → mount → task.* （见 task-rpc.ts）
//   --- Legacy 直写：仅 external / 非 <ws>/.tent system root；in-workspace 协作 mutate 已封死 ---
//   tent new <帐路径>                  建一顶新帐(空骨架);genesis 调用
//   tent new <帐名> --vault <vault>    同上,但读 vault 的 tentsRoot 设置,落到 <vault>/<tentsRoot>/<帐名>
//   tent migrate|import --source <legacyRoot> --workspace <ws> [--dry-run] [--force]  旧独立帐根 → <ws>/.tent
//   tent skill-install [--target claude] [--force]  // 机器配置；default: ~/.claude/skills + ~/.agents/skills
//   tent tree | status | roles | find | tags       // 只读
//   tent dispatch / task-ack / report / …          // external root migration window only

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { NodeFs, SystemClock } from "../fs/node-fs.js";
import { loadTent } from "../core/tree.js";
import {
  OpsEnv,
  dispatch,
  stamp,
  completeClaim,
  acceptReport,
  grantReadable,
  cleanTemp,
  cancelPendingTask,
  forceRelease,
  forkNode,
  createBox,
  tagBox,
  untagBox,
  createTag,
  deleteTag,
  taskAck,
} from "../core/ops.js";

import { findBoxesByTag, loadTagRegistry, normalizeTagName } from "../core/tags.js";
import { parseOutputPointer } from "../core/output.js";
import { syncOkfBundle } from "../core/okf.js";
import { normalizeRegistry, splitType, type TypeRegistry } from "../core/typeRegistry.js";
import { ensureRoleInit } from "../core/task.js";
import { loadRolesRegistry, normalizeRoleDefinition, type RoleDefinition, type RolesRegistry } from "../core/skillRoleRegistry.js";
import { loadReports, submitReport } from "../core/report.js";
import { submitProposal } from "../core/proposal.js";
import { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE, renderTentStatus } from "../core/status.js";
import { withTentMutation } from "../core/adapter.js";
import { scaffoldInWorkspace, validateBoxName } from "../core/scaffold.js";
import {
  ensureRoleWorkspace,
  integrateWorkspaceCommits,
  resolveTentWorkspace,
  runWorkspaceCheck,
} from "../core/workspace.js";
import { TENT_SYSTEM_DIR, workspaceRootFromSystemRoot } from "../core/paths.js";
import { importExternalTentRoot } from "../core/migration.js";
import { runTaskCommand, taskHelpText } from "./task-rpc.js";

/**
 * Legacy CLI commands that still direct-write core.
 * On in-workspace system root (`<workspace>/.tent`) these fail-loud — use tent task * / Desktop Service.
 * External / flat collab roots keep them for the migration window (no env escape hatch).
 */
const LEGACY_MUTATION_COMMANDS = new Set([
  "dispatch",
  "task-ack",
  "task-cancel",
  "report",
  "propose",
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
]);

/** Read-only legacy commands allowed on in-workspace `.tent`. */
const LEGACY_READONLY_COMMANDS = new Set(["tree", "status", "roles", "find", "tags"]);

export function isInWorkspaceSystemRoot(systemRoot: string): boolean {
  return workspaceRootFromSystemRoot(systemRoot) !== undefined;
}

export function isLegacyMutationCommand(cmd: string): boolean {
  return LEGACY_MUTATION_COMMANDS.has(cmd);
}

export function listLegacyMutationCommands(): string[] {
  return [...LEGACY_MUTATION_COMMANDS].sort();
}

export function inWorkspaceLegacyMutationMessage(cmd: string, systemRoot: string): string {
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  return (
    `Legacy CLI command "${cmd}" refuses to direct-write an in-workspace Tent at ${systemRoot}.\n` +
    `Desktop co-located collaboration must go through Local Service (tent task * / Desktop).\n` +
    `systemRoot is <workspace>/${TENT_SYSTEM_DIR}` +
    (workspace ? ` (workspace: ${workspace})` : "") +
    `.\n` +
    `Allowed without Service: read-only tree/status/roles/find/tags; init/derived new/migrate/role-init/skill-install.\n` +
    `External (non-${TENT_SYSTEM_DIR}) Tent roots still accept legacy mutation commands during the migration window.`
  );
}

async function makeEnv(): Promise<OpsEnv> {
  // 找不到 system root 时明确失败；禁止回退 cwd 把系统数据写到项目根。
  const systemRoot = await findTentSystemRoot(process.cwd());
  if (!systemRoot) throw new Error(NOT_INSIDE_TENT_MESSAGE);
  const workspace = workspaceRootFromSystemRoot(systemRoot);
  return {
    fs: new NodeFs(systemRoot),
    clock: new SystemClock(),
    tentName: path.basename(workspace ?? systemRoot),
    tentRoot: systemRoot,
  };
}

/**
 * Fail-loud before any core mutate when cwd resolves to in-workspace `.tent`.
 * No env escape hatch, no dual-write, no silent compat.
 */
function assertLegacyDirectWriteAllowed(cmd: string, systemRoot: string): void {
  if (!LEGACY_MUTATION_COMMANDS.has(cmd)) return;
  if (!isInWorkspaceSystemRoot(systemRoot)) return;
  throw new Error(inWorkspaceLegacyMutationMessage(cmd, systemRoot));
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
      return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
    }
    if (positionals.length > 1) return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
    await newTent(positionals[0], flags.vault);
    return;
  }
  if (cmd === "skill-install") {
    const { positionals, flags } = parseFlags(args);
    if (positionals.length > 0) return fail("Usage: tent skill-install [--target claude] [--force]");
    const target = flags.target || "claude";
    const force = flags.force === "true";
    // --dir overrides for tests/single-path installs; default syncs Claude + shared agents skills.
    const targetDirs = flags.dir ? [flags.dir] : defaultSkillInstallDirs(target);
    const results = await installSkills(targetDirs, { force, target });
    console.log(formatSkillInstallResults(target, results));
    return;
  }
  // External/legacy tent root → in-workspace `.tent` (B5). Does not require an existing system root.
  if (cmd === "migrate" || cmd === "import") {
    const { positionals, flags } = parseFlags(args);
    if (positionals.length > 0) {
      return fail(
        `Usage: tent ${cmd} --source <legacy-tent-root> --workspace <workspace-root> [--dry-run] [--force] [--json]`
      );
    }
    const source = flags.source || flags.from || flags.src;
    const workspace = flags.workspace || flags.to || flags.dest || flags.target;
    if (!source || !workspace) {
      return fail(
        `Usage: tent ${cmd} --source <legacy-tent-root> --workspace <workspace-root> [--dry-run] [--force] [--json]`
      );
    }
    const dryRun = flags["dry-run"] === "true" || flags.dryRun === "true";
    const force = flags.force === "true";
    const asJson = flags.json === "true";
    try {
      const report = await importExternalTentRoot({
        sourceRoot: path.resolve(source),
        workspaceRoot: path.resolve(workspace),
        dryRun,
        force,
      });
      if (asJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatImportReport(report));
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
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

  // Unknown commands fail before system-root resolution (no cwd fallback writes).
  const tentCommands = new Set([
    ...LEGACY_MUTATION_COMMANDS,
    ...LEGACY_READONLY_COMMANDS,
    "role-init",
  ]);
  if (!tentCommands.has(cmd)) {
    return fail(
      `Unknown command: ${cmd || "(empty)"}\nCommands: new migrate import task role-init roles dispatch task-ack task-cancel report propose complete stamp status grant-readable new-box tag untag tag-new tag-rm tags find fork clean-temp force-release okf-sync skill-install tree`
    );
  }

  const env = await makeEnv();
  // Seal legacy core mutates against Desktop in-workspace `.tent` (sole mutation = Service).
  if (!cmd) return fail("Unknown command: (empty)");
  const systemRoot = env.tentRoot;
  if (!systemRoot) return fail(NOT_INSIDE_TENT_MESSAGE);
  try {
    assertLegacyDirectWriteAllowed(cmd, systemRoot);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  switch (cmd) {
    case "dispatch": {
      const { positionals, flags } = parseFlags(args);
      const [boxId, role, ...promptParts] = positionals;
      if (!boxId || !role) {
        return fail("Usage: tent dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--as-sub --by <role>]");
      }
      if (Object.prototype.hasOwnProperty.call(flags, "prompt") && promptParts.length > 0) {
        return fail("Usage: tent dispatch <boxId> <role> [localPrompt...] [--prompt <text>|-] [--as-sub --by <role>]");
      }
      if (isUnsafeRoleSegment(role)) return fail(`Invalid role for dispatch: ${role}`);
      let localPrompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
      if (localPrompt === "-") localPrompt = await readStdin();
      const requestedDispatcher = flags.by || flags.from || flags["dispatched-by"] || process.env.TENT_ROLE;
      if (flags["as-sub"]) {
        if (!requestedDispatcher) return fail("--as-sub requires --by <dispatching-role> or TENT_ROLE");
        if (isUnsafeRoleSegment(requestedDispatcher)) {
          return fail(`Invalid dispatching role for --as-sub: ${requestedDispatcher}`);
        }
      }
      const tent = await loadTent(env.fs);
      const workspacePath = resolveTentWorkspace(tent, env.tentRoot);
      const dispatcher = requestedDispatcher || "user";
      let workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, role) : undefined;
      if (!workspacePath) {
        console.log("Note: this Tent has no in-workspace .tent layout; the task envelope has no workspace contract.");
      }
      if (flags["as-sub"]) {
        if (!workspacePath) {
          return fail(
            "--as-sub requires a workspace contract. Scaffold an in-workspace tent at <workspace>/.tent/."
          );
        }
        if (!dispatcher || dispatcher === "user") return fail("--as-sub requires --by <dispatching-role> or TENT_ROLE");
        const dispatcherWorkspace = await ensureRoleWorkspace(workspacePath, dispatcher);
        workspace = { ...(workspace ?? await ensureRoleWorkspace(workspacePath, role)), targetBranch: dispatcherWorkspace.branch };
      }
      const r = await dispatch(env, boxId, role, {
        userPrompt: localPrompt,
        workspace,
        dispatchedBy: dispatcher,
      });
      console.log(`✓ Dispatched. Task: ${r.taskPath}\n\n--- Relay prompt ---\n${r.relayPrompt}`);
      break;
    }
    case "task-ack": {
      const taskPath = args[0];
      if (!taskPath) return fail("Usage: tent task-ack <taskPath>");
      if (args.length > 1) return fail("Usage: tent task-ack <taskPath>");
      await taskAck(env, taskPath);
      console.log(`✓ Task acknowledged: ${taskPath}`);
      break;
    }
    case "task-cancel": {
      const taskPath = args[0];
      if (!taskPath) return fail("Usage: tent task-cancel <taskPath>");
      if (args.length > 1) return fail("Usage: tent task-cancel <taskPath>");
      await cancelPendingTask(env, taskPath);
      console.log(`✓ Task cancelled: ${taskPath}`);
      break;
    }
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
    case "roles": {
      if (args.length > 0) return fail("Usage: tent roles");
      const registry = await loadRolesRegistry(env.fs);
      console.log(JSON.stringify(registry, null, 2));
      break;
    }
    case "report": {
      const { positionals, flags } = parseFlags(args);
      const [boxId, bodySource] = positionals;
      if (!boxId || !bodySource) {
        return fail("Usage: tent report <boxId> <bodyFile|-> [--commits <sha,sha>]");
      }
      if (positionals.length > 2) return fail("Usage: tent report <boxId> <bodyFile|-> [--commits <sha,sha>]");
      const body = bodySource === "-"
        ? await readStdin()
        : await readBodyFile(bodySource);
      const commits = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      const report = await submitReport(env.fs, env.clock, boxId, body, commits);
      console.log(`✓ Report ready for review: ${report.path}`);
      break;
    }
    case "propose": {
      const { positionals } = parseFlags(args);
      const [boxId, bodySource] = positionals;
      if (!boxId || !bodySource) {
        return fail("Usage: tent propose <boxId> <bodyFile|->");
      }
      if (positionals.length > 2) return fail("Usage: tent propose <boxId> <bodyFile|->");
      const role = process.env.TENT_ROLE;
      if (!role) return fail("tent propose requires TENT_ROLE to identify the submitting role");
      const body = bodySource === "-"
        ? await readStdin()
        : await readBodyFile(bodySource);
      const proposal = await submitProposal(env.fs, env.clock, role, boxId, body);
      console.log(`✓ Proposal submitted for triage: ${proposal.path}`);
      break;
    }
    case "complete": {
      const { positionals, flags } = parseFlags(args);
      const boxId = positionals[0];
      if (!boxId) return fail("Usage: tent complete <boxId> [--commits <sha,sha>] [--require-check <command>] [--by <role>]");
      if (positionals.length > 1) return fail("Usage: tent complete <boxId> [--commits <sha,sha>] [--require-check <command>] [--by <role>]");
      const tent = await loadTent(env.fs);
      const box = tent.byId.get(boxId);
      if (!box) return fail(`Box not found: ${boxId}`);
      const owner = ownerFor(box);
      const reports = (await loadReports(env.fs)).filter((report) => report.boxId === boxId);
      const readyReport = reports.find((report) => report.status === "ready");
      const rejectedReport = reports.find((report) => report.status === "rejected");
      if (!readyReport && rejectedReport) {
        return fail(`Report for ${boxId} was rejected; submit a revised report before completing`);
      }
      const hasExplicitCommits = Object.prototype.hasOwnProperty.call(flags, "commits");
      const explicitRefs = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (hasExplicitCommits && explicitRefs.length === 0) {
        return fail("--commits requires at least one commit ref");
      }
      const refs = hasExplicitCommits ? explicitRefs : readyReport?.commits ?? [];
      if (refs.length > 0 && !owner) return fail("Completing with workspace commits requires an owner");
      let integrationLines: string[] = [];
      const workspacePath = resolveTentWorkspace(tent, env.tentRoot);
      if (flags["require-check"]) {
        if (!workspacePath) return fail("--require-check requires a workspace pointer");
        await runWorkspaceCheck(workspacePath, flags["require-check"]);
      }
      const acceptedBy = flags.by || process.env.TENT_ROLE || "user";
      const integrate = async (commitRefs: string[]) => {
        if (!workspacePath) throw new Error("The Tent has no workspace pointer");
        const contract = await ensureRoleWorkspace(workspacePath, owner!);
        const integrated = await integrateWorkspaceCommits(contract, commitRefs);
        integrationLines = integrated.map(
          (item) => `${item.sourceRef} → ${item.integratedRef}${item.alreadyIntegrated ? " (already)" : ""}`
        );
      };
      if (readyReport) {
        await acceptReport(env, readyReport.path, {
          commits: refs,
          integrate: refs.length > 0 ? integrate : undefined,
          acceptedBy,
        });
      } else {
        await completeClaim(env, boxId, refs.length > 0 ? () => integrate(refs) : undefined, acceptedBy);
      }
      for (const line of integrationLines) console.log(line);
      console.log(`✓ Completed ${boxId}`);
      break;
    }
    case "stamp": {
      const { positionals, flags } = parseFlags(args);
      if (!positionals[0]) return fail("Usage: tent stamp <boxId> [--by <role>]");
      if (positionals.length > 1) return fail("Usage: tent stamp <boxId> [--by <role>]");
      const acceptedBy = flags.by || process.env.TENT_ROLE || "user";
      await stamp(env, positionals[0], acceptedBy);
      console.log(`✓ Stamped ${positionals[0]} (done and owner cleared)`);
      break;
    }
    case "status": {
      if (args.length > 0) return fail("Usage: tent status");
      try {
        process.stdout.write(await renderTentStatus(process.cwd(), process.env.TENT_ROLE));
      } catch (error) {
        if (error instanceof Error && error.message === NOT_INSIDE_TENT_MESSAGE) return fail(error.message);
        throw error;
      }
      break;
    }
    case "grant-readable": {
      if (!args[0]) return fail("Usage: tent grant-readable <boxId>");
      if (args.length > 1) return fail("Usage: tent grant-readable <boxId>");
      await grantReadable(env, args[0]);
      console.log(`✓ ${args[0]} readable=true`);
      break;
    }
    case "new-box": {
      const [name, type, parentId] = args;
      if (!name || !type) return fail("Usage: tent new-box <name> <type> [parentId]");
      if (args.length > 3) return fail("Usage: tent new-box <name> <type> [parentId]");
      try {
        validateBoxName(name);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      let parentPath = "";
      if (parentId) {
        const tent = await loadTent(env.fs);
        const parent = tent.byId.get(parentId);
        if (!parent) return fail(`Parent box not found: ${parentId}`);
        parentPath = parent.path;
      }
      const id = await createBox(env, { parentPath, name, type });
      console.log(`✓ Created box ${name} (${id})`);
      break;
    }
    case "tag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("Usage: tent tag <boxId> <name>");
      if (args.length > 2) return fail("Usage: tent tag <boxId> <name>");
      await tagBox(env, boxId, name);
      console.log(`✓ Added tag to ${boxId}: ${name}`);
      break;
    }
    case "untag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("Usage: tent untag <boxId> <name>");
      if (args.length > 2) return fail("Usage: tent untag <boxId> <name>");
      await untagBox(env, boxId, name);
      console.log(`✓ Removed tag from ${boxId}: ${name}`);
      break;
    }
    case "tag-new": {
      if (!args[0]) return fail("Usage: tent tag-new <name>");
      if (args.length > 1) return fail("Usage: tent tag-new <name>");
      await createTag(env, args[0]);
      console.log(`✓ Registered tag: ${args[0]}`);
      break;
    }
    case "tag-rm": {
      const { positionals, flags } = parseFlags(args);
      const [name, confirmation] = positionals;
      if (!name) return fail("Usage: tent tag-rm <name> --yes OR tent tag-rm <name> <name>");
      if (positionals.length > 2) return fail("Usage: tent tag-rm <name> --yes OR tent tag-rm <name> <name>");
      if (!flags.yes && confirmation !== name) {
        return fail(`Deleting a tag removes it from every box. Add --yes or repeat the tag name to confirm: tent tag-rm ${name} ${name}`);
      }
      await deleteTag(env, name);
      console.log(`✓ Deleted tag from registry and all boxes: ${name}`);
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
    case "fork": {
      if (!args[0]) return fail("Usage: tent fork <boxId>");
      if (args.length > 1) return fail("Usage: tent fork <boxId>");
      const id = await forkNode(env, args[0]);
      console.log(`✓ Forked ${args[0]} → ${id}`);
      break;
    }
    case "clean-temp": {
      if (args.length > 1) return fail("Usage: tent clean-temp [role]");
      if (args[0] && isUnsafeRoleSegment(args[0])) return fail(`Invalid role for clean-temp: ${args[0]}`);
      await cleanTemp(env, args[0]);
      console.log(`✓ Cleared temp/${args[0] || "(all)"}`);
      break;
    }
    case "force-release": {
      if (!args[0]) return fail("Usage: tent force-release <boxId>");
      if (args.length > 1) return fail("Usage: tent force-release <boxId>");
      await forceRelease(env, args[0]);
      console.log(`✓ Force-released owner: ${args[0]}`);
      break;
    }
    case "okf-sync": {
      if (args.length > 0) return fail("Usage: tent okf-sync");
      const result = await syncOkfBundle(env.fs);
      console.log(
        `✓ OKF synchronized\n` +
          `generated: ${result.generatedFiles.length}\n` +
          `projected: ${result.projectedFiles.length}\n` +
          `unresolved wiki links: ${result.unresolved.length}`
      );
      if (result.unresolved.length > 0) {
        for (const item of result.unresolved) console.log(`! ${item.file}: [[${item.target}]]`);
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
  const rw = `R${box.readable.value ? "✓" : "✗"}/W${box.writable.value ? "✓" : "✗"}`;
  const owner = box.fm.owner ? ` ⚑${box.fm.owner}` : "";
  const type = box.type;
  const id = box.id || "missing-id";
  const invalid = box.invalid ? ` invalid:${box.invalidReason || "invalid"}` : "";
  console.log(`${ind}${box.name} [${type} ${id}] ${rw}${owner}${invalid}`);
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

function isUnsafeRoleSegment(value: string): boolean {
  return value.includes("..") || /[\/\\\r\n]/.test(value);
}

/** 解析 args 里的 --flag <value>,其余作为位置参数。 */
function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleanFlags = new Set(["force", "yes", "as-sub", "dry-run", "json"]);
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

/** Claude Code skills dir + Grok/Codex shared agents skills dir (homedir, never hardcode user). */
function defaultSkillInstallDirs(target: string): string[] {
  if (target !== "claude") {
    throw new Error("skill-install currently supports only --target claude; Codex uses a different skill format.");
  }
  const home = os.homedir();
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
  ];
}

interface SkillInstallItemResult {
  targetDir: string;
  skill: string;
  status: "installed" | "skipped";
  reason?: string;
}

/**
 * Copy bundled skills into each target dir.
 * Without --force: each (target, skill) is judged independently — existing skills are skipped,
 * so one populated dir never blocks install into another.
 * With --force: overwrite existing skill dirs.
 */
async function installSkills(
  targetDirs: string[],
  options: { force: boolean; target: string }
): Promise<SkillInstallItemResult[]> {
  if (options.target !== "claude") defaultSkillInstallDirs(options.target);
  if (targetDirs.length === 0) throw new Error("skill-install requires at least one target directory");

  const sourceDir = path.join(packageRoot(), "skills");
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const skillNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await existsPath(path.join(sourceDir, entry.name, "SKILL.md"))) skillNames.push(entry.name);
  }
  skillNames.sort();
  if (skillNames.length === 0) throw new Error(`No installable skills found in ${sourceDir}`);

  const results: SkillInstallItemResult[] = [];
  for (const targetDir of targetDirs) {
    await fs.mkdir(targetDir, { recursive: true });
    for (const name of skillNames) {
      const source = path.join(sourceDir, name);
      const target = path.join(targetDir, name);
      assertChildPath(targetDir, target);
      const exists = await existsPath(target);
      if (exists && !options.force) {
        results.push({
          targetDir,
          skill: name,
          status: "skipped",
          reason: "already exists (use --force to overwrite)",
        });
        continue;
      }
      if (exists && options.force) {
        await fs.rm(target, { recursive: true, force: true });
      }
      await fs.cp(source, target, { recursive: true, errorOnExist: true });
      results.push({ targetDir, skill: name, status: "installed" });
    }
  }
  return results;
}

function formatSkillInstallResults(target: string, results: SkillInstallItemResult[]): string {
  const byDir = new Map<string, SkillInstallItemResult[]>();
  for (const item of results) {
    const list = byDir.get(item.targetDir) ?? [];
    list.push(item);
    byDir.set(item.targetDir, list);
  }
  const lines: string[] = [`✓ skill-install (${target} format)`];
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

function assertChildPath(parent: string, child: string): void {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Install target escapes the destination directory: ${child}`);
  }
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

Run commands from a workspace with <workspace>/.tent/ (or legacy external tent root) unless noted.

Service-backed task lifecycle (required for Desktop / in-workspace collaboration mutates):
  tent task list|get|claim|deliver|…  Attach Local Service → mount → task.* RPC
  tent task --help                    Full task subcommand help
  CLI exit does not stop Local Service. Token stays in machine-local service.json.

Init / machine config (always allowed):
  new <path>                         Create an empty in-workspace Tent at <path>/.tent.
  new <name> --vault <vault>         Create a Tent under the vault's configured tents root.
  migrate --source <root> --workspace <ws>
                                     Copy legacy external tent root into <ws>/.tent (alias: import).
                                     Refuses if <ws>/.tent exists. Never deletes source.
                                     Options: --dry-run --force --json
  skill-install [--force]            Install bundled skills to ~/.claude/skills and ~/.agents/skills.
  role-init <role>                   Regenerate the derived stable role init document.

Read-only (allowed on in-workspace .tent):
  status                             Print a read-only Tent status summary.
  roles                              Print the role registry.
  tags                               List registered tags.
  find <tag>                         Find boxes by tag.
  tree                               Print the box tree.

Legacy direct-core mutations (external / non-.tent system root only — migration window):
  On <workspace>/.tent these fail-loud; use tent task * or Desktop Service instead.
  dispatch <boxId> <role> <prompt>   Create a pending task envelope.
  task-ack <taskPath>                Mark a task taken and claim its box (legacy claim).
  task-cancel <taskPath>             Delete a pending task envelope.
  report <boxId> <file|->            Submit a delivery report for triage.
  propose <boxId> <file|->           Submit a proposal prompt for triage.
  complete <boxId> [options]         Confirm completion and release owner.
  stamp <boxId> [--by <role>]        Mark done without workspace commits.
  force-release <boxId>              Release owner without accepting delivery.
  grant-readable <boxId>             Mark a box readable.
  new-box <name> <type> [parentId]   Create a box.
  tag|untag <boxId> <tag>            Add or remove a tag.
  tag-new | tag-rm                   Manage the tag registry.
  fork <boxId>                       Copy a box subtree with new ids.
  clean-temp [role]                  Remove temp state for one role or all roles.
  okf-sync                           Regenerate OKF indexes and projected links.

Options:
  -h, --help                         Show this help.
  -v, --version                      Show the package version.
`;
}

/**
 * 从 Obsidian 插件设置读 tentsRoot。帐根目录是用户可改的设置(面板里),genesis 不该写死。
 * 读不到/解析失败,回退默认 "tents"(对齐 src/plugin/main.ts 的 DEFAULT_SETTINGS)。
 */
interface VaultPluginSettings {
  tentsRoot: string;
  typeRegistry?: TypeRegistry;
  rolesRegistry?: RolesRegistry;
  rulesTemplate?: string;
}

async function readVaultPluginSettings(vault: string): Promise<VaultPluginSettings> {
  const fsmod = await import("node:fs/promises");
  const dataPath = path.join(path.resolve(vault), ".obsidian", "plugins", "tent", "data.json");
  try {
    const data = JSON.parse(await fsmod.readFile(dataPath, "utf8"));
    const root = typeof data?.tentsRoot === "string" ? data.tentsRoot.trim() : "";
    const defaults = data?.newTentDefaults ?? data?.newTentTemplate;
    return {
      tentsRoot: root || "tents",
      ...(defaults?.typeRegistry ? { typeRegistry: normalizeRegistry(defaults.typeRegistry) } : {}),
      ...(defaults?.rolesRegistry ? { rolesRegistry: normalizeTemplateRoles(defaults.rolesRegistry) } : {}),
      ...(typeof defaults?.rulesTemplate === "string" && defaults.rulesTemplate.trim()
        ? { rulesTemplate: defaults.rulesTemplate }
        : {}),
    };
  } catch {
    return { tentsRoot: "tents" };
  }
}

/**
 * 建一顶新帐：in-workspace 布局 `<target>/.tent/`。
 * `target` 为 workspace 根（或 vault 模式下 vault/tentsRoot/name）。
 * 不写外置双路径；注册表与 RULES 落在 `.tent/` 内。
 */
async function newTent(target: string, vault?: string): Promise<void> {
  const fsmod = await import("node:fs/promises");
  let pluginSettings: VaultPluginSettings | undefined;

  // --vault 模式:target 当帐名,落到 vault 配置的 tentsRoot 下(绑 Obsidian 设置层)。
  if (vault) {
    if (target.includes("/") || target.includes("\\")) {
      return fail(`In --vault mode, <name> cannot contain path separators: ${target}`);
    }
    pluginSettings = await readVaultPluginSettings(vault);
    target = path.join(path.resolve(vault), pluginSettings.tentsRoot, target);
  }

  const workspaceRoot = path.resolve(target);
  const fsa = new NodeFs(workspaceRoot);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${workspaceRoot}`);

  await fsmod.mkdir(workspaceRoot, { recursive: true });
  const name = path.basename(workspaceRoot);
  const fallbackRules =
    `# ${name} - Project Rules\n\n` +
      `> Local project rules for this Tent. Created by tent-genesis; edit freely.\n` +
    `> Mechanism-level rules live in the Tent repository docs/SPEC.md; the agent operation protocol lives in the tent-role skill.\n\n` +
    `- Output workspace: ${workspaceRoot.replaceAll("\\", "/")}\n` +
    `- Commit / naming conventions: <fill in>\n` +
    `- Other project rules: <fill in>\n`;
  const rules = pluginSettings?.rulesTemplate
    ? pluginSettings.rulesTemplate.replaceAll("{tent}", name)
    : fallbackRules;
  await scaffoldInWorkspace(fsa, {
    name,
    rules,
    typeRegistry: pluginSettings?.typeRegistry,
    rolesRegistry: pluginSettings?.rolesRegistry,
  });

  console.log(
    `✓ Created Tent: ${path.join(workspaceRoot, ".tent")}\n` +
      `In-workspace layout: collaboration facts live under <workspace>/.tent/.\n` +
      `The concept tree starts empty; add notes/boxes as folder + same-named Markdown.`
  );
}

function formatImportReport(report: Awaited<ReturnType<typeof importExternalTentRoot>>): string {
  const lines = [
    report.dryRun ? "Tent migrate (dry-run)" : "Tent migrate",
    `  source:     ${report.sourceRoot}`,
    `  workspace:  ${report.workspaceRoot}`,
    `  systemRoot: ${report.systemRoot}`,
    `  copied:     ${report.copied}`,
    `  sourceMarked (MIGRATED.md): ${report.sourceMarked}`,
    `  id remaps:  ${report.schema.idMap.length}`,
    `  type rewrites: ${report.schema.typeRewrites.length}`,
  ];
  if (report.schema.registryChanges.length) {
    lines.push("  registry:");
    for (const c of report.schema.registryChanges.slice(0, 40)) {
      lines.push(`    - ${c}`);
    }
    if (report.schema.registryChanges.length > 40) {
      lines.push(`    … +${report.schema.registryChanges.length - 40} more`);
    }
  }
  if (report.schema.idMap.length) {
    lines.push("  id map (sample):");
    for (const e of report.schema.idMap.slice(0, 12)) {
      lines.push(`    - ${e.from} → ${e.to} (${e.path})`);
    }
    if (report.schema.idMap.length > 12) {
      lines.push(`    … +${report.schema.idMap.length - 12} more`);
    }
  }
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  for (const s of report.skipped) lines.push(`  skipped: ${s}`);
  if (!report.dryRun) {
    lines.push(
      "Source was not deleted. Verify <workspace>/.tent then remove the old root manually if desired."
    );
  }
  return lines.join("\n");
}

function normalizeTemplateRoles(value: unknown): RolesRegistry {
  if (typeof value !== "object" || value === null) return { roles: [] };
  const raw = value as { roles?: unknown };
  if (!Array.isArray(raw.roles)) return { roles: [] };
  const roles: RoleDefinition[] = [];
  for (const item of raw.roles) {
    if (typeof item !== "object" || item === null) continue;
    const role = normalizeRoleDefinition(item as Record<string, unknown>);
    if (!role.name || roles.some((existing) => existing.name === role.name)) continue;
    roles.push(role);
  }
  return { roles };
}

function ownerFor(box: import("../core/types.js").Box): string | undefined {
  if (box.fm.owner) return box.fm.owner;
  let parent = box.parent;
  while (parent) {
    if (parent.fm.owner) return parent.fm.owner;
    parent = parent.parent;
  }
  return undefined;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
