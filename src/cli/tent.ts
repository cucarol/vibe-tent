#!/usr/bin/env node
// tent CLI —— agent 侧的薄壳。tent-genesis / tent-role 等 skill 脚本就是喊这个命令。
// 用法(cwd = 帐根,new 例外):
//   tent new <帐路径>                  建一顶新帐(空骨架);genesis 调用
//   tent new <帐名> --vault <vault>    同上,但读 vault 的 tentsRoot 设置,落到 <vault>/<tentsRoot>/<帐名>
//   tent dispatch <claimId> <role> [localPrompt...] [--prompt <text>|-]  派活,打印接力 prompt
//   tent stamp <boxId>                 盖章
//   tent propose <targetId> <role> <bodyFile|->
//   tent proposal <path> accept|reject [note]
//   tent grant-readable <boxId>
//   tent new-box <name> <type> [parentId]
//   tent tag <boxId> <name>
//   tent untag <boxId> <name>
//   tent tag-new <name>
//   tent tag-rm <name> --yes
//   tent tags
//   tent find <name>
//   tent fork <boxId>
//   tent handoff <fromBoxId> <targetId> <targetRole> <promptFile|->
//   tent report <boxId> <bodyFile|-> [--commits <sha,sha>]
//   tent clean-temp [role]
//   tent force-release <boxId>
//   tent migrate-kind-to-type
//   tent okf-sync
//   tent skill-install [--target claude] [--force]
//   tent tree                          打印框树(调试)

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { NodeFs, SystemClock } from "../fs/node-fs.js";
import { loadTent, boxNotePath } from "../core/tree.js";
import {
  OpsEnv,
  dispatch,
  stamp,
  completeClaim,
  propose,
  applyProposal,
  grantReadable,
  cleanTemp,
  forceRelease,
  startApply,
  finishApply,
  forkNode,
  handoff,
  createBox,
  tagBox,
  untagBox,
  createTag,
  deleteTag,
} from "../core/ops.js";
import { scaffoldTent } from "../core/scaffold.js";
import { findBoxesByTag, loadTagRegistry } from "../core/tags.js";
import { parseOutputPointer } from "../core/output.js";
import { migrateKindToType } from "../core/typeManagement.js";
import { syncOkfBundle } from "../core/okf.js";
import { normalizeRegistry, splitType, type TypeRegistry } from "../core/typeRegistry.js";
import { ensureRoleInit } from "../core/task.js";
import { loadRolesRegistry, type RoleDefinition, type RolesRegistry } from "../core/skillRoleRegistry.js";
import { submitReport } from "../core/report.js";
import { withTentMutation } from "../core/adapter.js";
import {
  ensureRoleWorkspace,
  integrateWorkspaceCommits,
  resolveTentWorkspace,
} from "../core/workspace.js";

function makeEnv(): OpsEnv {
  const root = process.cwd();
  return {
    fs: new NodeFs(root),
    clock: new SystemClock(),
    tentName: path.basename(root),
  };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const env = makeEnv();

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(helpText());
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(await packageVersion());
    return;
  }

  switch (cmd) {
    case "new": {
      const { positionals, flags } = parseFlags(args);
      if (!positionals[0]) {
        return fail("Usage: tent new <path> OR tent new <name> --vault <vault-path>");
      }
      await newTent(positionals[0], flags.vault);
      break;
    }
    case "dispatch": {
      const { positionals, flags } = parseFlags(args);
      const [claimId, role, ...promptParts] = positionals;
      if (!claimId || !role) {
        return fail("Usage: tent dispatch <claimId> <role> [localPrompt...] [--prompt <text>|-] [--handoff <path>]");
      }
      let localPrompt = typeof flags.prompt === "string" ? flags.prompt : promptParts.join(" ");
      if (localPrompt === "-") localPrompt = await readStdin();
      const tent = await loadTent(env.fs);
      const workspacePath = resolveTentWorkspace(tent);
      const workspace = workspacePath ? await ensureRoleWorkspace(workspacePath, role) : undefined;
      const r = await dispatch(env, claimId, role, {
        userPrompt: localPrompt,
        handoffPath: flags.handoff,
        workspace,
      });
      console.log(`✓ Dispatched. Task: ${r.taskPath}\n\n--- Relay prompt ---\n${r.relayPrompt}`);
      break;
    }
    case "role-init": {
      const roleName = args[0];
      if (!roleName) return fail("Usage: tent role-init <role>");
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
      const body = bodySource === "-"
        ? await readStdin()
        : await (await import("node:fs/promises")).readFile(path.resolve(bodySource), "utf8");
      const commits = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      const report = await submitReport(env.fs, env.clock, boxId, body, commits);
      console.log(`✓ Report ready for review: ${report.path}`);
      break;
    }
    case "complete": {
      const { positionals, flags } = parseFlags(args);
      const boxId = positionals[0];
      if (!boxId) return fail("Usage: tent complete <boxId> [--commits <sha,sha>]");
      const tent = await loadTent(env.fs);
      const box = tent.byId.get(boxId);
      if (!box) return fail(`Box not found: ${boxId}`);
      const owner = ownerFor(box);
      const refs = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (refs.length > 0 && !owner) return fail("Completing with workspace commits requires an owner");
      let integrationLines: string[] = [];
      await completeClaim(env, boxId, refs.length === 0 ? undefined : async () => {
        const workspacePath = resolveTentWorkspace(tent);
        if (!workspacePath) throw new Error("The Tent has no workspace output pointer");
        const contract = await ensureRoleWorkspace(workspacePath, owner!);
        const integrated = await integrateWorkspaceCommits(contract, refs);
        integrationLines = integrated.map(
          (item) => `${item.sourceRef} → ${item.integratedRef}${item.alreadyIntegrated ? " (already)" : ""}`
        );
      });
      for (const line of integrationLines) console.log(line);
      console.log(`✓ Completed ${boxId}`);
      break;
    }
    case "stamp": {
      if (!args[0]) return fail("Usage: tent stamp <boxId>");
      await stamp(env, args[0]);
      console.log(`✓ Stamped ${args[0]} (done and owner cleared)`);
      break;
    }
    case "propose": {
      const [targetId, role, bodySource] = args;
      if (!targetId || !role || !bodySource) return fail("Usage: tent propose <targetId> <role> <bodyFile|->");
      const body = bodySource === "-"
        ? await readStdin()
        : await (await import("node:fs/promises")).readFile(path.resolve(bodySource), "utf8");
      const r = await propose(env, targetId, role, body);
      console.log(`✓ Proposal written: ${r.proposalPath}`);
      break;
    }
    case "proposal": {
      const [p, verb, ...noteParts] = args;
      if (!p || (verb !== "accept" && verb !== "reject")) return fail("Usage: tent proposal <path> accept|reject [note]");
      await applyProposal(env, p, verb === "accept", noteParts.join(" ") || undefined);
      console.log(`✓ proposal ${verb}: ${p}`);
      break;
    }
    case "grant-readable": {
      if (!args[0]) return fail("Usage: tent grant-readable <boxId>");
      await grantReadable(env, args[0]);
      console.log(`✓ ${args[0]} readable=true`);
      break;
    }
    case "new-box": {
      const [name, type, parentId] = args;
      if (!name || !type) return fail("Usage: tent new-box <name> <type> [parentId]");
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
      await tagBox(env, boxId, name);
      console.log(`✓ Added tag to ${boxId}: ${name}`);
      break;
    }
    case "untag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("Usage: tent untag <boxId> <name>");
      await untagBox(env, boxId, name);
      console.log(`✓ Removed tag from ${boxId}: ${name}`);
      break;
    }
    case "tag-new": {
      if (!args[0]) return fail("Usage: tent tag-new <name>");
      await createTag(env, args[0]);
      console.log(`✓ Registered tag: ${args[0]}`);
      break;
    }
    case "tag-rm": {
      const [name, confirmation] = args;
      if (!name) return fail("Usage: tent tag-rm <name> --yes OR tent tag-rm <name> <name>");
      if (!args.includes("--yes") && confirmation !== name) {
        return fail(`Deleting a tag removes it from every box. Add --yes or repeat the tag name to confirm: tent tag-rm ${name} ${name}`);
      }
      await deleteTag(env, name);
      console.log(`✓ Deleted tag from registry and all boxes: ${name}`);
      break;
    }
    case "tags": {
      const registry = await loadTagRegistry(env.fs);
      if (registry.tags.length === 0) console.log("(no tags)");
      else for (const tag of registry.tags) console.log(tag);
      break;
    }
    case "find": {
      if (!args[0]) return fail("Usage: tent find <name>");
      const tent = await loadTent(env.fs);
      const boxes = findBoxesByTag(tent, args[0]);
      if (boxes.length === 0) {
        console.log("(no matches)");
        break;
      }
      for (const box of boxes) {
        const pointer = splitType(box.type).base === "output" ? outputPointer(box.fm, box.body) : "";
        console.log(`${box.id}\t${box.path}\t${box.type}${pointer ? `\t${pointer}` : ""}`);
      }
      break;
    }
    case "apply": {
      if (!args[0]) return fail("Usage: tent apply <proposal-path>");
      const g = await startApply(env, args[0]);
      console.log(
        `✓ Proposal is ready to apply. Target: ${g.targetPath}\n\n` +
          `--- Requested change ---\n${g.instructions || "(The proposal body is empty; see the source file.)"}\n\n` +
          `After updating the target box note, run: tent apply-done ${args[0]}`
      );
      break;
    }
    case "apply-done": {
      if (!args[0]) return fail("Usage: tent apply-done <proposal-path>");
      await finishApply(env, args[0]);
      console.log("✓ Proposal marked as applied.");
      break;
    }
    case "fork": {
      if (!args[0]) return fail("Usage: tent fork <boxId>");
      const id = await forkNode(env, args[0]);
      console.log(`✓ Forked ${args[0]} → ${id}`);
      break;
    }
    case "handoff": {
      const [fromBoxId, targetId, targetRole, promptSource] = args;
      if (!fromBoxId || !targetId || !targetRole || !promptSource) {
        return fail("Usage: tent handoff <fromBoxId> <targetId> <targetRole> <promptFile|->");
      }
      const prompt = promptSource === "-"
        ? await readStdin()
        : await (await import("node:fs/promises")).readFile(path.resolve(promptSource), "utf8");
      const handoffPath = await handoff(env, fromBoxId, targetId, targetRole, prompt);
      console.log(`✓ Handoff written: ${handoffPath}`);
      break;
    }
    case "clean-temp": {
      await cleanTemp(env, args[0]);
      console.log(`✓ Cleared temp/${args[0] || "(all)"}`);
      break;
    }
    case "force-release": {
      if (!args[0]) return fail("Usage: tent force-release <boxId>");
      await forceRelease(env, args[0]);
      console.log(`✓ Force-released owner: ${args[0]}`);
      break;
    }
    case "migrate-kind-to-type": {
      const touched = await migrateKindToType(env.fs);
      if (touched.length === 0) console.log("✓ No migration needed: no legacy kind fields found");
      else console.log(`✓ Migrated legacy kind → type:\n${touched.map((p) => `- ${p}`).join("\n")}`);
      break;
    }
    case "okf-sync": {
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
    case "skill-install": {
      const { flags } = parseFlags(args);
      const target = flags.target || "claude";
      const force = flags.force === "true";
      const dir = flags.dir || defaultSkillInstallDir(target);
      const installed = await installSkills(dir, { force, target });
      console.log(
        `✓ Installed ${target} skills in ${dir}\n` +
          installed.map((name) => `- ${name}`).join("\n")
      );
      break;
    }
    case "tree": {
      const tent = await loadTent(env.fs);
      for (const r of tent.roots) printBox(r, 0);
      break;
    }
    default:
      fail(
        `Unknown command: ${cmd || "(empty)"}\nCommands: new role-init roles dispatch report complete stamp propose proposal grant-readable new-box tag untag tag-new tag-rm tags find apply apply-done fork handoff clean-temp force-release migrate-kind-to-type okf-sync skill-install tree`
      );
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

/** 解析 args 里的 --flag <value>,其余作为位置参数。 */
function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleanFlags = new Set(["force", "yes"]);
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

function defaultSkillInstallDir(target: string): string {
  if (target !== "claude") {
    throw new Error("skill-install currently supports only --target claude; Codex uses a different skill format.");
  }
  return path.join(os.homedir(), ".claude", "skills");
}

async function installSkills(
  targetDir: string,
  options: { force: boolean; target: string }
): Promise<string[]> {
  if (options.target !== "claude") defaultSkillInstallDir(options.target);
  const sourceDir = path.join(packageRoot(), "skills");
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const skillNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await existsPath(path.join(sourceDir, entry.name, "SKILL.md"))) skillNames.push(entry.name);
  }
  if (skillNames.length === 0) throw new Error(`No installable skills found in ${sourceDir}`);

  const conflicts: string[] = [];
  for (const name of skillNames) {
    if (await existsPath(path.join(targetDir, name))) conflicts.push(name);
  }
  if (conflicts.length > 0 && !options.force) {
    throw new Error(`Skills already exist: ${conflicts.join(", ")}. Add --force to overwrite them.`);
  }

  await fs.mkdir(targetDir, { recursive: true });
  const installed: string[] = [];
  for (const name of skillNames) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    assertChildPath(targetDir, target);
    if (options.force) await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true, errorOnExist: true });
    installed.push(name);
  }
  return installed.sort();
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

Run commands from a Tent root unless noted.

Commands:
  new <path>                         Create an empty Tent.
  new <name> --vault <vault>         Create a Tent under the vault's configured tents root.
  role-init <role>                   Prepare stable role init context.
  roles                              Print the role registry.
  dispatch <boxId> <role> [prompt]   Claim a box and create a task pointer.
  report <boxId> <file|->            Submit a delivery report for triage.
  complete <boxId>                   Confirm completion and release owner.
  force-release <boxId>              Release owner without accepting delivery.
  new-box <name> <type> [parentId]   Create a box.
  tag|untag <boxId> <tag>            Add or remove a tag.
  tags | tag-new | tag-rm            Manage the tag registry.
  find <tag>                         Find boxes by tag.
  propose | proposal                 Create or review a proposal.
  handoff <from> <target> <role>     Create an agent-to-agent handoff.
  fork <boxId>                       Copy a box subtree with new ids.
  okf-sync                           Regenerate OKF indexes and projected links.
  skill-install [--force]            Install bundled Tent skills for Claude Code.
  tree                               Print the box tree.

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

/** 建一顶新帐:空骨架(不强制 zone)。genesis 调 CLI,免得手糊脚本。 */
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

  const fsa = new NodeFs(target);
  if (await fsa.exists(".tent")) return fail(`Target is already a Tent: ${target}`);

  await fsmod.mkdir(target, { recursive: true });
  const name = path.basename(path.resolve(target));
  const fallbackRules =
    `# ${name} · 项目约定\n\n` +
    `> 这顶帐的本地规矩(global rule):genesis 建、随便改。\n` +
    `> 机制规范不在这(见 Tent 仓库 docs/SPEC.md);agent 的操作协议在 tent-role skill。\n\n` +
    `- 产出 workspace:<填真实代码仓路径>\n` +
    `- 提交 / 命名约定:<填>\n` +
    `- 其它本项目规矩:<填>\n`;
  const rules = pluginSettings?.rulesTemplate
    ? pluginSettings.rulesTemplate.replaceAll("{tent}", name)
    : fallbackRules;
  await scaffoldTent(fsa, {
    name,
    rules,
    typeRegistry: pluginSettings?.typeRegistry,
    rolesRegistry: pluginSettings?.rolesRegistry,
  }); // 无 boxes = 空骨架

  console.log(
    `✓ Created Tent: ${target}\n` +
      `The root starts empty; add boxes in the panel or create a folder with a same-named Markdown note.`
  );
}

function normalizeTemplateRoles(value: unknown): RolesRegistry {
  if (typeof value !== "object" || value === null) return { roles: [] };
  const raw = value as { roles?: unknown };
  if (!Array.isArray(raw.roles)) return { roles: [] };
  const roles: RoleDefinition[] = [];
  for (const item of raw.roles) {
    if (typeof item !== "object" || item === null) continue;
    const source = item as Record<string, unknown>;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name || roles.some((role) => role.name === name)) continue;
    const role: RoleDefinition = { name };
    if (typeof source.color === "string" && source.color.trim()) role.color = source.color.trim();
    if (typeof source.description === "string" && source.description.trim()) role.description = source.description.trim();
    if (typeof source.prompt === "string" && source.prompt.trim()) role.prompt = source.prompt.trim();
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
