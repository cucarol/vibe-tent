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
//   tent tree                          打印框树(调试)

import * as path from "node:path";
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

  switch (cmd) {
    case "new": {
      const { positionals, flags } = parseFlags(args);
      if (!positionals[0]) {
        return fail("用法: tent new <帐路径>  或  tent new <帐名> --vault <vault路径>");
      }
      await newTent(positionals[0], flags.vault);
      break;
    }
    case "dispatch": {
      const { positionals, flags } = parseFlags(args);
      const [claimId, role, ...promptParts] = positionals;
      if (!claimId || !role) {
        return fail("用法: tent dispatch <claimId> <role> [localPrompt...] [--prompt <text>|-] [--handoff <path>]");
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
      console.log(`✓ 已派活。task: ${r.taskPath}\n\n--- 投递 prompt ---\n${r.relayPrompt}`);
      break;
    }
    case "role-init": {
      const roleName = args[0];
      if (!roleName) return fail("用法: tent role-init <role>");
      const roles = await loadRolesRegistry(env.fs);
      const role = roles.roles.find((item) => item.name === roleName) ?? { name: roleName };
      const initPath = await withTentMutation(
        env.fs,
        () => ensureRoleInit(env.fs, role, env.tentName)
      );
      console.log(`读取 ${initPath} 完成 role init。`);
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
        return fail("用法: tent report <boxId> <bodyFile|-> [--commits <sha,sha>]");
      }
      const body = bodySource === "-"
        ? await readStdin()
        : await (await import("node:fs/promises")).readFile(path.resolve(bodySource), "utf8");
      const commits = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      const report = await submitReport(env.fs, env.clock, boxId, body, commits);
      console.log(`✓ report 待裁: ${report.path}`);
      break;
    }
    case "complete": {
      const { positionals, flags } = parseFlags(args);
      const boxId = positionals[0];
      if (!boxId) return fail("用法: tent complete <boxId> [--commits <sha,sha>]");
      const tent = await loadTent(env.fs);
      const box = tent.byId.get(boxId);
      if (!box) return fail(`找不到框 ${boxId}`);
      const owner = ownerFor(box);
      const refs = (flags.commits || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (refs.length > 0 && !owner) return fail("有 workspace commits 的完成操作需要 owner");
      let integrationLines: string[] = [];
      await completeClaim(env, boxId, refs.length === 0 ? undefined : async () => {
        const workspacePath = resolveTentWorkspace(tent);
        if (!workspacePath) throw new Error("帐内没有 workspace output 指针");
        const contract = await ensureRoleWorkspace(workspacePath, owner!);
        const integrated = await integrateWorkspaceCommits(contract, refs);
        integrationLines = integrated.map(
          (item) => `${item.sourceRef} → ${item.integratedRef}${item.alreadyIntegrated ? " (already)" : ""}`
        );
      });
      for (const line of integrationLines) console.log(line);
      console.log(`✓ 已确认完成 ${boxId}`);
      break;
    }
    case "stamp": {
      if (!args[0]) return fail("用法: tent stamp <boxId>");
      await stamp(env, args[0]);
      console.log(`✓ 已盖章 ${args[0]}(done + 清 owner)`);
      break;
    }
    case "propose": {
      const [targetId, role, bodySource] = args;
      if (!targetId || !role || !bodySource) return fail("用法: tent propose <targetId> <role> <bodyFile|->");
      const body = bodySource === "-"
        ? await readStdin()
        : await (await import("node:fs/promises")).readFile(path.resolve(bodySource), "utf8");
      const r = await propose(env, targetId, role, body);
      console.log(`✓ proposal 已写入: ${r.proposalPath}`);
      break;
    }
    case "proposal": {
      const [p, verb, ...noteParts] = args;
      if (!p || (verb !== "accept" && verb !== "reject")) return fail("用法: tent proposal <path> accept|reject [note]");
      await applyProposal(env, p, verb === "accept", noteParts.join(" ") || undefined);
      console.log(`✓ proposal ${verb}: ${p}`);
      break;
    }
    case "grant-readable": {
      if (!args[0]) return fail("用法: tent grant-readable <boxId>");
      await grantReadable(env, args[0]);
      console.log(`✓ ${args[0]} readable=true`);
      break;
    }
    case "new-box": {
      const [name, type, parentId] = args;
      if (!name || !type) return fail("用法: tent new-box <name> <type> [parentId]");
      let parentPath = "";
      if (parentId) {
        const tent = await loadTent(env.fs);
        const parent = tent.byId.get(parentId);
        if (!parent) return fail(`找不到父框 ${parentId}`);
        parentPath = parent.path;
      }
      const id = await createBox(env, { parentPath, name, type });
      console.log(`✓ 已建框 ${name} (${id})`);
      break;
    }
    case "tag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("用法: tent tag <boxId> <name>");
      await tagBox(env, boxId, name);
      console.log(`✓ 已给 ${boxId} 打 tag: ${name}`);
      break;
    }
    case "untag": {
      const [boxId, name] = args;
      if (!boxId || !name) return fail("用法: tent untag <boxId> <name>");
      await untagBox(env, boxId, name);
      console.log(`✓ 已从 ${boxId} 摘 tag: ${name}`);
      break;
    }
    case "tag-new": {
      if (!args[0]) return fail("用法: tent tag-new <name>");
      await createTag(env, args[0]);
      console.log(`✓ 已登记 tag: ${args[0]}`);
      break;
    }
    case "tag-rm": {
      const [name, confirmation] = args;
      if (!name) return fail("用法: tent tag-rm <name> --yes  或  tent tag-rm <name> <name>");
      if (!args.includes("--yes") && confirmation !== name) {
        return fail(`删除 tag 会从所有框级联剥离。请加 --yes,或重复输入 tag 名确认: tent tag-rm ${name} ${name}`);
      }
      await deleteTag(env, name);
      console.log(`✓ 已删除 tag 并级联剥离: ${name}`);
      break;
    }
    case "tags": {
      const registry = await loadTagRegistry(env.fs);
      if (registry.tags.length === 0) console.log("(无 tag)");
      else for (const tag of registry.tags) console.log(tag);
      break;
    }
    case "find": {
      if (!args[0]) return fail("用法: tent find <name>");
      const tent = await loadTent(env.fs);
      const boxes = findBoxesByTag(tent, args[0]);
      if (boxes.length === 0) {
        console.log("(无匹配)");
        break;
      }
      for (const box of boxes) {
        const pointer = splitType(box.type).base === "output" ? outputPointer(box.fm, box.body) : "";
        console.log(`${box.id}\t${box.path}\t${box.type}${pointer ? `\t${pointer}` : ""}`);
      }
      break;
    }
    case "apply": {
      if (!args[0]) return fail("用法: tent apply <proposal文件路径>");
      const g = await startApply(env, args[0]);
      console.log(
        `✓ proposal 可落地。目标:「${g.targetPath}」。请按合同修改。\n\n` +
          `--- 要落地的改动 ---\n${g.instructions || "(proposal 正文为空,见原文)"}\n\n` +
          `改完目标框的身份文件后,运行:tent apply-done ${args[0]}`
      );
      break;
    }
    case "apply-done": {
      if (!args[0]) return fail("用法: tent apply-done <proposal文件路径>");
      await finishApply(env, args[0]);
      console.log(`✓ proposal 已转 applied。`);
      break;
    }
    case "fork": {
      if (!args[0]) return fail("用法: tent fork <boxId>");
      const id = await forkNode(env, args[0]);
      console.log(`✓ 已 fork ${args[0]} → ${id}`);
      break;
    }
    case "handoff": {
      const [fromBoxId, targetId, targetRole, promptSource] = args;
      if (!fromBoxId || !targetId || !targetRole || !promptSource) {
        return fail("用法: tent handoff <fromBoxId> <targetId> <targetRole> <prompt文件|->");
      }
      const prompt = promptSource === "-"
        ? await readStdin()
        : await (await import("node:fs/promises")).readFile(path.resolve(promptSource), "utf8");
      const handoffPath = await handoff(env, fromBoxId, targetId, targetRole, prompt);
      console.log(`✓ handoff 草稿: ${handoffPath}`);
      break;
    }
    case "clean-temp": {
      await cleanTemp(env, args[0]);
      console.log(`✓ 已清 temp/${args[0] || "(全部)"}`);
      break;
    }
    case "force-release": {
      if (!args[0]) return fail("用法: tent force-release <boxId>");
      await forceRelease(env, args[0]);
      console.log(`✓ 已强清 owner: ${args[0]}`);
      break;
    }
    case "migrate-kind-to-type": {
      const touched = await migrateKindToType(env.fs);
      if (touched.length === 0) console.log("✓ 无需迁移:未发现 legacy kind");
      else console.log(`✓ 已迁移 legacy kind → type:\n${touched.map((p) => `- ${p}`).join("\n")}`);
      break;
    }
    case "okf-sync": {
      const result = await syncOkfBundle(env.fs);
      console.log(
        `✓ OKF 已同步\n` +
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
      const tent = await loadTent(env.fs);
      for (const r of tent.roots) printBox(r, 0);
      break;
    }
    default:
      fail(
        `未知命令: ${cmd || "(空)"}\n命令: new role-init roles dispatch report complete stamp propose proposal grant-readable new-box tag untag tag-new tag-rm tags find apply apply-done fork handoff clean-temp force-release migrate-kind-to-type okf-sync tree`
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
  const invalid = box.invalid ? ` invalid:${box.invalidReason || "失效"}` : "";
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
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[i + 1] ?? "";
      i++;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
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
      return fail(`--vault 模式下 <帐名> 不能含路径分隔符: ${target}`);
    }
    pluginSettings = await readVaultPluginSettings(vault);
    target = path.join(path.resolve(vault), pluginSettings.tentsRoot, target);
  }

  const fsa = new NodeFs(target);
  if (await fsa.exists(".tent")) return fail(`目标已是一顶帐: ${target}`);

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
    `✓ 新帐已建: ${target}\n` +
      `顶层为空(按 #C 不强制 zone);用面板的 ＋,或直接建“文件夹 + 同名 .md”添加真名节点。`
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
