import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { canClaim, isFrozen } from "../src/core/claim.js";
import { buildManifest, manifestToYaml } from "../src/core/manifest.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  BOX_FRONTMATTER_KEY_ORDER,
} from "../src/core/frontmatter.js";
import { loadTypeRegistry } from "../src/core/typeRegistry.js";
import {
  createPrimaryType,
  createSecondaryType,
  deleteCustomType,
  inspectTypeDeletion,
  migrateKindToType,
  updateTypeMetadata,
} from "../src/core/typeManagement.js";
import { syncOkfBundle } from "../src/core/okf.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import {
  createRole,
  deleteRole,
  loadRolesRegistry,
  updateRole,
} from "../src/core/skillRoleRegistry.js";
import {
  addRegistryTag,
  addTag,
  findBoxesByTag,
  loadTagRegistry,
  removeRegistryTag,
  removeTag,
  saveTagRegistry,
} from "../src/core/tags.js";
import { loadHandoffs } from "../src/core/handoff.js";
import { loadReports, rejectReport, submitReport } from "../src/core/report.js";

async function makeTent(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-"));
  const box = (p: string, fm: string, body = "") => {
    const folderName = p.split("/").pop() || p;
    return fs
      .mkdir(path.join(dir, p), { recursive: true })
      .then(() =>
        fs.writeFile(
          path.join(dir, p, `${folderName}.md`),
          `---\n${fm}\n---\n${body}\n`,
        ),
      );
  };
  await box("goal", "id: bx-goalzone\ntype: goal");
  await box("goal/挖新alpha", "id: bx-g1\ntype: goal\nstatus: doing");
  await box(
    "goal/挖新alpha/写表达式",
    "id: bx-g2\ntype: goal\nowner: executor\nstatus: doing",
  );
  await box("prompt", "id: bx-promptzone\ntype: prompt");
  await box(
    "prompt/表达式任务书",
    "id: bx-p1\ntype: prompt",
    "给 executor 的任务",
  );
  await box(
    "prompt/表达式任务书/草稿",
    "id: bx-p2\ntype: prompt\nwritable: true",
  );
  await box("output", "id: bx-outzone\ntype: output");
  await box("output/alpha仓库指针", "id: bx-o1\ntype: output");
  await fs.mkdir(path.join(dir, "temp"), { recursive: true });
  await box("prompt/旧站资料", "id: bx-a1\ntype: asset");
  return dir;
}

function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "The Tent Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "The Tent Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err || `git ${args.join(" ")} exit ${code}`)));
  });
}

async function configureTestGitIdentity(dir: string): Promise<void> {
  await git(dir, "config", "user.name", "The Tent Test");
  await git(dir, "config", "user.email", "test@example.invalid");
}

test("scaffoldTent:core 生成自包含帐骨架(RULES,不进 SPEC/CLAUDE/AGENTS)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-scaffold-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rules: "# RULES\n\n规则正文\n",
    boxes: [
      { name: "aim", type: "goal", body: "# demo · aim" },
      { name: "out", type: "asset" },
    ],
  });

  const tent = await loadTent(fsa);
  assert.deepEqual(
    tent.roots.map((box) => box.path).sort(),
    ["aim", "out"],
  );
  assert.match(await fsa.readFile("aim/aim.md"), /# demo · aim/);
  assert.match(await fsa.readFile("out/out.md"), /type: asset/);

  // 无 boxes = 空帐(不强制建 zone)
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-scaffold-empty-"));
  const emptyFs = new NodeFs(emptyDir);
  await scaffoldTent(emptyFs, { name: "empty", rules: "# RULES\n" });
  assert.deepEqual((await loadTent(emptyFs)).roots, []);
  assert.equal(await fsa.exists("temp/temp.md"), false);
  assert.equal(await fsa.readFile("RULES.md"), "# RULES\n\n规则正文\n");
  // 机制 SPEC 与 agent 配置层指针不再进帐
  assert.equal(await fsa.exists("SPEC.md"), false);
  assert.equal(await fsa.exists("CLAUDE.md"), false);
  assert.equal(await fsa.exists("AGENTS.md"), false);
  assert.equal(await fsa.exists(".claude"), false);
  assert.equal(await fsa.exists(".tent/skills.json"), false);
  assert.deepEqual((await loadRolesRegistry(fsa)).roles, []);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, []);
  assert.deepEqual(
    JSON.parse(await fsa.readFile(".tent/types.json")),
    tent.typeRegistry,
  );
  assert.equal(await fsa.exists(".gitignore"), false, "Tent 本身不创建 Git 配置");

  const invalidDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tent-scaffold-invalid-"),
  );
  await assert.rejects(
    () => scaffoldTent(new NodeFs(invalidDir), { name: "", rules: "# RULES" }),
    /帐名不能为空/,
  );
});

test("tags frontmatter:数组往返且键序在 type 后", async () => {
  const body = "# 节点\n";
  const raw = serializeFrontmatter(
    {
      id: "bx-tagged",
      type: "reference",
      tags: ["backend-hardening", "needs,quote"],
      owner: "reviewer",
    },
    body,
    BOX_FRONTMATTER_KEY_ORDER,
  );

  assert.match(raw, /type: reference\ntags: \[backend-hardening, "needs,quote"\]\nowner: reviewer/);
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.tags, ["backend-hardening", "needs,quote"]);
  assert.equal(parsed.data.owner, "reviewer");
  assert.equal(parsed.body, body);
});

test("tags 注册表:自动登记、摘除、级联剥离与检索", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);

  await saveTagRegistry(fsa, { tags: ["zeta", "backend-hardening", "backend-hardening"] });
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["backend-hardening", "zeta"]);

  await addRegistryTag(fsa, "alpha");
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["alpha", "backend-hardening", "zeta"]);
  await assert.rejects(() => addRegistryTag(fsa, "bad/name"), /路径分隔符/);

  await addTag(fsa, "bx-p1", "backend-hardening");
  await addTag(fsa, "bx-o1", "backend-hardening");
  await addTag(fsa, "bx-o1", "backend-hardening");
  let tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("bx-o1")?.tags, ["backend-hardening"]);
  assert.deepEqual(
    findBoxesByTag(tent, "backend-hardening").map((box) => box.id),
    ["bx-o1", "bx-p1"],
  );

  await removeTag(fsa, "bx-p1", "backend-hardening");
  tent = await loadTent(fsa);
  assert.deepEqual(findBoxesByTag(tent, "backend-hardening").map((box) => box.id), ["bx-o1"]);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["alpha", "backend-hardening", "zeta"]);

  await removeRegistryTag(fsa, "backend-hardening");
  tent = await loadTent(fsa);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["alpha", "zeta"]);
  assert.deepEqual(findBoxesByTag(tent, "backend-hardening"), []);
  assert.equal(tent.byId.get("bx-o1")?.tags.length, 0);
  const raw = await fs.readFile(path.join(dir, "output", "alpha仓库指针", "alpha仓库指针.md"), "utf8");
  assert.doesNotMatch(raw, /^tags:/m);
});

test("role 注册表:core 创建修改删除与 scaffold 模板写入", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-registry-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rules: "# RULES\n",
    typeRegistry: { task: { readable: true, writable: false, color: "orange" } },
    rolesRegistry: {
      roles: [
        {
          name: "analyst",
          prompt: "分析问题并给出计划",
        },
      ],
    },
  });
  assert.equal((await loadTent(fsa)).typeRegistry.task.color, "orange");
  assert.deepEqual(
    (await loadRolesRegistry(fsa)).roles.map((role) => role.name),
    ["analyst"],
  );
  assert.equal((await loadRolesRegistry(fsa)).roles[0].prompt, "分析问题并给出计划");

  await createRole(fsa, {
    name: "critic",
    prompt: "挑问题",
  });
  await updateRole(fsa, "critic", { prompt: "挑关键问题" });
  assert.equal(
    (await loadRolesRegistry(fsa)).roles.find((role) => role.name === "critic")
      ?.prompt,
    "挑关键问题",
  );
  await deleteRole(fsa, "critic", "critic");
  assert.ok(
    !(await loadRolesRegistry(fsa)).roles.some(
      (role) => role.name === "critic",
    ),
  );
});

test("一级 type 默认:goal/prompt/output 来自注册表", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));

  const g2 = tent.byId.get("bx-g2")!;
  assert.equal(g2.readable.value, true, "goal 可读");
  assert.equal(g2.writable.value, false, "goal 不可写");
  assert.equal(g2.writable.source, "type");

  const p1 = tent.byId.get("bx-p1")!;
  assert.equal(p1.writable.value, true, "prompt 默认可写");
  assert.equal(p1.writable.source, "type");

  const p2 = tent.byId.get("bx-p2")!;
  assert.equal(p2.writable.value, true, "草稿显式开 writable");
  assert.equal(p2.writable.source, "self");

  const out = tent.byId.get("bx-o1")!;
  assert.equal(out.writable.value, true, "output 默认可写");
  assert.equal(out.writable.source, "type");
});

test("单层 type:asset 只作用当前 node 的 readable", async () => {
  const dir = await makeTent();
  const box = async (p: string, fm: string) => {
    await fs.mkdir(path.join(dir, p), { recursive: true });
    const folderName = p.split("/").pop() || p;
    await fs.writeFile(
      path.join(dir, p, `${folderName}.md`),
      `---\n${fm}\n---\n`,
    );
  };
  await box("prompt/旧站资料/摘录", "id: bx-a2\ntype: prompt");
  const tent = await loadTent(new NodeFs(dir));
  const asset = tent.byId.get("bx-a1")!;
  const child = tent.byId.get("bx-a2")!;
  assert.equal(asset.readable.value, false);
  assert.equal(asset.readable.source, "type");
  assert.equal(asset.writable.value, true, "asset 现在是 R✗ W✓");
  assert.equal(child.readable.value, true, "type 默认不向子孙下流");
  assert.equal(child.readable.source, "type");
});

test("旧 types.json schema 与 legacy kind 会归一到复合 type", async () => {
  const dir = await makeTent();
  const legacy = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  await fs.writeFile(legacy, "---\nid: bx-a1\ntype: prompt\nkind: asset\n---\n");
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".tent", "types.json"),
    JSON.stringify(
      {
        primary: {},
        secondary: { asset: { readable: false, color: "purple" } },
      },
      null,
      2,
    ),
  );
  const tent = await loadTent(new NodeFs(dir));
  const asset = tent.byId.get("bx-a1")!;
  assert.equal(asset.type, "prompt-asset");
  assert.equal(asset.readable.value, false);
  assert.equal(
    asset.writable.value,
    true,
    "modifier 缺省 writable 时继承 base",
  );
  assert.equal(tent.typeRegistry.asset.writable, undefined);
});

test("migrateKindToType:移除 legacy kind 并写成单层 type registry", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const legacy = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  await fs.writeFile(legacy, "---\nid: bx-a1\ntype: prompt\nkind: asset\n---\n");
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".tent", "types.json"),
    JSON.stringify({
      primary: { goal: { readable: true, writable: false }, prompt: { readable: true, writable: true } },
      secondary: { asset: { readable: false, writable: true } },
    }),
  );

  const touched = await migrateKindToType(fsa);
  const note = await fs.readFile(legacy, "utf8");
  const registry = JSON.parse(await fs.readFile(path.join(dir, ".tent", "types.json"), "utf8"));
  assert.ok(touched.includes("prompt/旧站资料/旧站资料.md"));
  assert.match(note, /type: prompt-asset/);
  assert.doesNotMatch(note, /kind:/);
  assert.ok(registry.asset);
  assert.equal(registry.secondary, undefined);
});

test("syncOkfBundle:生成 index/log 并把唯一 wiki 链接投影为 Markdown 链接", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const source = path.join(dir, "prompt", "表达式任务书", "表达式任务书.md");
  await fs.writeFile(
    source,
    "---\nid: bx-p1\ntype: prompt\n---\n见 [[bx-g1|目标]] 和 ![[Pasted image.png]]。\n",
  );

  const result = await syncOkfBundle(fsa);
  const note = await fs.readFile(source, "utf8");
  assert.ok(result.generatedFiles.includes("index.md"));
  assert.ok(result.generatedFiles.includes("log.md"));
  assert.equal(result.unresolved.length, 0);
  assert.match(note, /\[目标\]\(\.\.\/\.\.\/goal\/挖新alpha\/挖新alpha\.md\)/);
  assert.match(note, /!\[\[Pasted image\.png\]\]/);
});

test("显式 R/W 只作用本框:不再沿祖先下流", async () => {
  const dir = await makeTent();
  const parentFile = path.join(
    dir,
    "prompt",
    "表达式任务书",
    "表达式任务书.md",
  );
  const raw = await fs.readFile(parentFile, "utf8");
  await fs.writeFile(
    parentFile,
    raw.replace(
      "type: prompt",
      "type: prompt\nreadable: false\nwritable: true",
    ),
  );
  const tent = await loadTent(new NodeFs(dir));
  const parent = tent.byId.get("bx-p1")!;
  const child = tent.byId.get("bx-p2")!;
  assert.equal(parent.readable.value, false);
  assert.equal(parent.readable.source, "self");
  assert.equal(parent.writable.value, true);
  assert.equal(parent.writable.source, "self");
  assert.equal(child.readable.value, true, "父框 readable:false 不再下流");
  assert.equal(child.readable.source, "type");
  assert.equal(child.writable.value, true);
  assert.equal(child.writable.source, "self", "子节点自身声明仍是最高优先级");
});

test("自定义 type 解析:显式声明优先于 type 默认", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createPrimaryType(fsa, "research", {
    readable: false,
    writable: true,
    color: "green",
  });
  await fs.mkdir(path.join(dir, "research-note"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "research-note", "research-note.md"),
    "---\nid: bx-custom\ntype: research\nreadable: true\n---\n",
  );
  const tent = await loadTent(fsa);
  const custom = tent.byId.get("bx-custom")!;
  assert.equal(custom.readable.value, true);
  assert.equal(custom.readable.source, "self");
  assert.equal(custom.writable.value, true);
  assert.equal(custom.writable.source, "type");
});

test("认领不重叠:祖先/子孙被占则挡", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));

  const g1 = tent.byId.get("bx-g1")!; // 子孙 g2 已被 executor 占
  const check = canClaim(g1);
  assert.equal(check.ok, false);
  assert.ok(check.blocker?.id === "bx-g2");

  const g2 = tent.byId.get("bx-g2")!;
  assert.equal(canClaim(g2).ok, false, "自己已被占");
  assert.equal(isFrozen(g1), true, "祖先冻结");
  assert.equal(g1.locked, true);
  assert.equal(g1.lockSource, "descendant");
  assert.equal(g1.lockOwner, "executor");
  assert.equal(g2.locked, true);
  assert.equal(g2.lockSource, "self");
});

test("loadTent:顶层普通目录透传其下合法框", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "普通分组", "嵌套框"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "普通分组", "嵌套框", "嵌套框.md"),
    "---\nid: bx-nested\ntype: prompt\n---\n",
  );
  const tent = await loadTent(new NodeFs(dir));
  assert.equal(tent.byId.get("bx-nested")?.path, "普通分组/嵌套框");
  assert.ok(tent.roots.some((box) => box.id === "bx-nested"));
});

test("manifest:可读集=全帐 readable,可写集=认领子树 writable + temp 格", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));
  const claim = tent.byId.get("bx-p1")!; // prompt/表达式任务书,子有可写草稿
  const m = buildManifest(tent, {
    tentName: "wqb",
    role: "executor",
    claimBoxes: [claim],
  });

  const writablePaths = m.writable.map((e) => e.path);
  const readablePaths = m.readable.map((e) => e.path);
  assert.ok(
    writablePaths.some((p) => p.includes("草稿")),
    "草稿在可写集",
  );
  assert.ok(
    writablePaths.some((p) => p === "temp/executor/"),
    "temp 格在可写集",
  );
  assert.ok(readablePaths.includes(".tent/roles.json"), "role 注册表是 agent 的系统只读上下文");
  assert.ok(readablePaths.includes("temp/"), "整个 temp 系统管道在可读集");

  const yaml = manifestToYaml(m);
  assert.ok(yaml.includes("tent: wqb"));
  assert.ok(yaml.includes("role: executor"));
  assert.equal(m.preloaded[0], "RULES.md", "RULES 固定在预灌前缀");
  assert.ok(
    m.preloaded.indexOf("prompt/表达式任务书 正文") <
      m.preloaded.indexOf("prompt/表达式任务书/草稿 正文"),
    "稳定任务书排在易变 scratch 前",
  );
  assert.deepEqual(
    buildManifest(tent, { tentName: "wqb", role: "executor", claimBoxes: [claim] })
      .preloaded,
    m.preloaded,
    "同一框多次 dispatch 预灌顺序稳定",
  );
});

test("manifest:认领即得子树结构权,帐根 claim 可写顶层结构", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));
  const claim = tent.byId.get("bx-p1")!;
  const leafManifest = buildManifest(tent, { tentName: "wqb", role: "executor", claimBoxes: [claim] });
  assert.ok(
    leafManifest.writable.some((e) => e.path === "prompt/表达式任务书/" && /结构权/.test(e.note || "")),
    "认领框本身有创建/移动/删除子框的结构权",
  );
  assert.ok(
    leafManifest.writable.some((e) => e.path === "prompt/表达式任务书/草稿/"),
    "认领子树里的子框也有结构权",
  );

  const rootManifest = buildManifest(tent, { tentName: "wqb", role: "architect", claimRoot: true });
  assert.deepEqual(rootManifest.claims, ["root"]);
  assert.ok(rootManifest.writable.some((e) => e.path === "./"), "帐根 claim 有顶层结构权");
  assert.ok(rootManifest.writable.some((e) => e.path === "goal/"), "帐根 claim 覆盖全帐结构");
});

test("dispatch:稳定 role init + 不可变 task 指针 + 多 claims manifest", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-06-29T01:02:03.000Z" },
    tentName: "wqb",
    rand: () => 0.5,
  };
  const { dispatch } = await import("../src/core/ops.js");
  const result = await dispatch(
    env as any,
    "bx-p1",
    "analyst",
    "请只处理表达式任务书。",
  );
  const task = await fs.readFile(path.join(dir, ...result.taskPath.split("/")), "utf8");
  assert.match(task, /只处理表达式任务书/);
  assert.match(task, /type: task/);
  assert.match(await fs.readFile(path.join(dir, "temp", "analyst", "init.md"), "utf8"), /type: role-init/);
  assert.match(result.relayPrompt, /task-/);
  assert.doesNotMatch(result.relayPrompt, /```yaml/);
  assert.doesNotMatch(result.relayPrompt, /\ntent: wqb\nrole: analyst/);
  assert.equal(result.manifestYaml.includes("preloaded:"), true);
  assert.match(result.manifestYaml, /claims: \[bx-p1\]/);
  let claimed = (await loadTent(env.fs)).byId.get("bx-p1")!;
  assert.equal(claimed.fm.owner, "analyst");
  assert.equal(claimed.fm.status, "doing", "首次派活自动进入 doing");

  await assert.rejects(
    () => dispatch(env as any, "bx-p1", "analyst", "重复派活"),
    /已被 analyst 认领/,
    "即使是同一 role，也必须先完成或释放",
  );

  const second = await dispatch(env as any, "bx-o1", "analyst", "继续处理 output 指针");
  assert.notEqual(second.taskPath, result.taskPath, "task 信封不可变,不覆盖");
  assert.match(second.manifestYaml, /claims: \[bx-p1, bx-o1\]/);
});

test("dispatch:至少需要 user prompt 或 handoff pointer", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
    rand: () => 0.5,
  };
  const { dispatch } = await import("../src/core/ops.js");
  await dispatch(env as any, "bx-p1", "analyst", "旧意图");
  await assert.rejects(
    () => dispatch(env as any, "bx-o1", "analyst", ""),
    /至少需要 user prompt 或 handoff prompt/,
  );
});

test("dispatch:支持帐根 claim 但有任何 owner 时拒绝", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");
  await assert.rejects(() => dispatch(env as any, ".", "architect", "接管全帐"), /帐根下已有认领/);

  const g2 = path.join(dir, "goal", "挖新alpha", "写表达式", "写表达式.md");
  const parsed = parseFrontmatter(await fs.readFile(g2, "utf8"));
  delete parsed.data.owner;
  await fs.writeFile(g2, serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder));
  const result = await dispatch(env as any, ".", "architect", "接管全帐");
  assert.match(result.manifestYaml, /claims: \[root\]/);
  assert.match(result.manifestYaml, /path: \.\//);
});

test("Tent 动作不初始化 Tent Git", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");
  await dispatch(env as any, "bx-p1", "analyst", "处理任务书");
  assert.equal(await new NodeFs(dir).exists(".git"), false);
});

test("parseOutputPointer:frontmatter workspace 优先,正文兼容中文字段", async () => {
  const { parseOutputPointer } = await import("../src/core/output.js");
  assert.deepEqual(
    parseOutputPointer(
      { workspace: "C:/repo/from-fm" },
      "- **workspace 路径**:`C:\\repo\\from-body`\n- **当前 ref**:`2cab7e6`(tag `v0.1`)\n",
    ),
    { workspace: "C:/repo/from-fm", ref: "2cab7e6(tag v0.1)" },
  );
  assert.deepEqual(
    parseOutputPointer({}, "workspace: C:/repo/body\nref: a1b2c3d\n"),
    { workspace: "C:/repo/body", ref: "a1b2c3d" },
  );
});

test("propose:只允许 readable target,写入 temp/<role>/proposals", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-06-25T01:02:03.000Z" },
    tentName: "wqb",
  };
  const { propose } = await import("../src/core/ops.js");
  const result = await propose(env as any, "bx-g1", "planner", "为什么:目标可改得更清楚\n\n具体改动:补验收标准");
  assert.match(result.proposalPath, /^temp\/planner\/proposals\/pr-20260625T010203000-bx-g1\.md$/);
  const proposal = parseFrontmatter(await fs.readFile(path.join(dir, result.proposalPath), "utf8"));
  assert.equal(proposal.data.type, "proposal");
  assert.equal(proposal.data.target, "bx-g1");
  assert.equal(proposal.data.status, "open");
  assert.equal(proposal.data.from, "planner");
  assert.match(proposal.body, /补验收标准/);

  await assert.rejects(
    () => propose(env as any, "bx-a1", "planner", "请求改不可读 asset"),
    /不可读/,
  );
});

test("placeBox 换序:before/after/inside 重排 order", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
    rand: () => 0.5,
  };
  const { placeBox } = await import("../src/core/ops.js");

  // 把"字段调研"无关:用 prompt zone 下三个框排序。先看现状
  // prompt 下:表达式任务书(bx-p1)、旧站资料(bx-a1)。把 a1 拖到 p1 之前。
  await placeBox(env as any, "prompt/旧站资料", "prompt", {
    mode: "before",
    siblingId: "bx-p1",
  });
  let tent = await loadTent(new NodeFs(dir));
  let prompt = tent.byId.get("bx-promptzone")!;
  assert.equal(prompt.children[0].id, "bx-a1", "旧站资料 排到最前");

  // inside:把旧站资料拖进表达式任务书,成为其子框
  await placeBox(env as any, "prompt/旧站资料", "prompt/表达式任务书", {
    mode: "inside",
  });
  tent = await loadTent(new NodeFs(dir));
  const p1 = tent.byId.get("bx-p1")!;
  assert.ok(
    p1.children.some((c) => c.id === "bx-a1"),
    "旧站资料 成为表达式任务书子框",
  );
});

test("placeBox:不能移动或移入认领冻结范围", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { placeBox } = await import("../src/core/ops.js");
  await assert.rejects(
    () => placeBox(env as any, "goal/挖新alpha", "prompt", { mode: "inside" }),
    /认领范围不能移动/,
  );
  await assert.rejects(
    () => placeBox(env as any, "prompt/旧站资料", "goal/挖新alpha", { mode: "inside" }),
    /不能移入认领范围/,
  );
});

test("buildInbox:proposal + 认领中由各自聚合器处理", async () => {
  const dir = await makeTent();
  // 一条 proposal
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dir, "temp", "planner", "proposals", "p.md"),
    "---\ntype: proposal\ntarget: bx-g1\nstatus: open\nfrom: planner\n---\n建议\n",
  );
  await fs.writeFile(
    path.join(dir, "temp", "planner", "proposals", "hidden.md"),
    "---\ntype: proposal\ntarget: bx-a1\nstatus: open\nfrom: planner\n---\n看不见的参考不能提\n",
  );
  const fsa = new NodeFs(dir);
  const tent = await loadTent(fsa);
  const { loadProposals } = await import("../src/core/proposal.js");
  const { buildInbox, pendingCount } = await import("../src/core/proposal.js");
  const props = await loadProposals(fsa);
  const inbox = await buildInbox(fsa, tent, props);
  assert.ok(
    inbox.some((i) => i.kind === "proposal" && i.proposal.target === "bx-g1"),
    "readable 目标可提 proposal",
  );
  const invalidProposal = inbox.find(
    (i) => i.kind === "invalid-proposal" && i.proposal.target === "bx-a1",
  );
  assert.ok(invalidProposal, "不可读目标 proposal 仍进待裁,可由 user 驳回清理");
  if (!invalidProposal || invalidProposal.kind !== "invalid-proposal")
    throw new Error("missing invalid proposal");
  assert.match(invalidProposal.reason, /不可读/);
  assert.ok(inbox.some((i) => i.kind === "stale" && i.boxId === "bx-g2"), "owner 显示为认领中");
  assert.equal(
    pendingCount(inbox),
    2,
    "待裁数只计算 proposal",
  );
});

test("中断认领:清 owner、回到 todo 并清理临时 report", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const report = await submitReport(fsa, env.clock, "bx-g2", "未完成的交付", []);
  const { forceRelease } = await import("../src/core/ops.js");
  await forceRelease(env as any, "bx-g2");
  const tent = await loadTent(fsa);
  const box = tent.byId.get("bx-g2")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, "todo");
  assert.equal(await fsa.exists(report.path), false);
});

test("orphan box:同名 md 缺 id 时进入 invalid 态且不进 byId", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "orphan"), { recursive: true });
  await fs.writeFile(path.join(dir, "orphan", "orphan.md"), "---\ntype: prompt\n---\n# orphan\n");
  const tent = await loadTent(new NodeFs(dir));
  const orphan = tent.byPath.get("orphan")!;
  assert.equal(orphan.invalid, true);
  assert.match(orphan.invalidReason || "", /缺少 id/);
  assert.equal(tent.byId.has(""), false);
});

test("buildCanvas:zone=group,叶子=file 节点,路径带前缀", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));
  const { buildCanvas } = await import("../src/core/canvas.js");
  const data = buildCanvas(tent, "tents/wqb");
  const groups = data.nodes.filter((n) => n.type === "group");
  const files = data.nodes.filter((n) => n.type === "file");
  assert.ok(
    groups.some((g) => g.label?.startsWith("goal")),
    "goal zone 是 group",
  );
  assert.ok(
    files.every((f) => f.file?.startsWith("tents/wqb/")),
    "file 路径带前缀",
  );
  assert.ok(
    files.some((f) => f.file?.endsWith(".md") && !f.file?.includes("_box")),
    "file 指向同名 .md",
  );
});

test("apply-proposal 落地:accepted → startApply → finishApply → applied", async () => {
  const dir = await makeTent();
  // 一条已 accepted 的提议,改 goal bx-g1
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  const pp = path.join(dir, "temp", "planner", "proposals", "edit.md");
  await fs.writeFile(
    pp,
    "---\ntarget: bx-g1\nstatus: accepted\nfrom: planner\n---\n把目标描述改清楚\n",
  );
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { startApply, finishApply } = await import("../src/core/ops.js");

  const g = await startApply(env as any, "temp/planner/proposals/edit.md");
  assert.equal(g.targetPath, "goal/挖新alpha", "授权指向目标框");
  assert.equal(g.instructions, "把目标描述改清楚", "带出改动说明");

  await finishApply(env as any, "temp/planner/proposals/edit.md");
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");
  const after = parseFrontmatter(await fs.readFile(pp, "utf8"));
  assert.equal(after.data.status, "applied", "转 applied");
});

test("forkNode:复制子树为兄弟框,重发 id 且清 owner/status", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "t" },
    tentName: "wqb",
    rand: Math.random,
  };
  const { forkNode } = await import("../src/core/ops.js");
  const newId = await forkNode(env as any, "bx-p1");

  const tent = await loadTent(fsa);
  const fork = tent.byId.get(newId)!;
  assert.equal(fork.path, "prompt/表达式任务书 (fork)");
  assert.equal(fork.fm.forkOf, undefined);
  assert.equal(fork.fm.forkBase, undefined);
  assert.equal(fork.fm.owner, undefined);
  assert.equal(fork.fm.status, undefined);
  assert.equal(fork.children.length, 1, "子树结构保留");
  assert.notEqual(fork.children[0].id, "bx-p2", "子框 id 也重发");
  assert.equal(fork.children[0].fm.owner, undefined);
  assert.equal(fork.children[0].fm.status, undefined);
  assert.equal(tent.byId.get("bx-p1")!.path, "prompt/表达式任务书", "原框不变");
  assert.equal(
    tent.byId.get("bx-promptzone")!.children.findIndex((box) => box.id === newId),
    tent.byId.get("bx-promptzone")!.children.findIndex((box) => box.id === "bx-p1") + 1,
    "fork 根紧跟原框",
  );
});

test("handoff:写入无 id 的不可变 prompt 指针,不改 owner/status", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-06-21T00:00:00.000Z" },
    tentName: "wqb",
  };
  const { handoff } = await import("../src/core/ops.js");
  const handoffPath = await handoff(
    env as any,
    "bx-g2",
    "bx-p1",
    "planner",
    "请接到任务书继续",
  );

  assert.match(handoffPath, /^temp\/executor\/handoffs\/hf-/);
  const record = parseFrontmatter(await fsa.readFile(handoffPath));
  assert.equal(record.data.id, undefined);
  assert.equal(record.data.type, "handoff");
  assert.equal(record.data.from, "bx-g2");
  assert.equal(record.data.target, "bx-p1");
  assert.equal(record.data.role, "planner");
  assert.equal(record.data.by, "executor");
  assert.equal(record.data.ts, "2026-06-21T00:00:00.000Z");
  assert.match(record.body, /请接到任务书继续/);
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-g2")!.fm.owner, "executor");
  assert.equal(tent.byId.get("bx-g2")!.fm.status, "doing");
});

test("handoff:可聚合读取,dispatch 只接受匹配的 target 与 role", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-06-21T00:00:00.000Z" },
    tentName: "wqb",
  };
  const { dispatch, handoff } = await import("../src/core/ops.js");
  const handoffPath = await handoff(env as any, "bx-g2", "bx-p1", "planner", "请接手");

  const records = await loadHandoffs(fsa);
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      path: records[0].path,
      fromBoxId: records[0].fromBoxId,
      targetId: records[0].targetId,
      targetRole: records[0].targetRole,
      fromRole: records[0].fromRole,
      body: records[0].body,
    },
    {
      path: handoffPath,
      fromBoxId: "bx-g2",
      targetId: "bx-p1",
      targetRole: "planner",
      fromRole: "executor",
      body: "请接手",
    },
  );

  await assert.rejects(
    dispatch(env as any, "bx-p1", "executor", { handoffPath }),
    /handoff 指定 role planner/,
  );
  assert.equal((await loadTent(fsa)).byId.get("bx-p1")!.fm.owner, undefined);

  const result = await dispatch(env as any, "bx-p1", "planner", { handoffPath });
  const task = parseFrontmatter(await fsa.readFile(result.taskPath));
  assert.equal(task.data.handoff, handoffPath);
  assert.equal((await loadTent(fsa)).byId.get("bx-p1")!.fm.owner, "planner");
});

test("dispatch:错误 handoff target 在写 owner 前失败", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    clock: { now: () => "2026-06-21T00:00:00.000Z" },
    tentName: "wqb",
  };
  const { dispatch, handoff } = await import("../src/core/ops.js");
  const handoffPath = await handoff(env as any, "bx-g2", "bx-p1", "planner", "请接手");

  await assert.rejects(
    dispatch(env as any, "bx-o1", "planner", { handoffPath }),
    /handoff 目标是 bx-p1/,
  );
  assert.equal((await loadTent(fsa)).byId.get("bx-o1")!.fm.owner, undefined);
});

test("report:驳回保留 owner,重新交付后整份确认并清理临时文件", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const clock = { now: () => "2026-07-01T00:00:00.000Z" };
  const env = { fs: fsa, clock, tentName: "wqb" };
  const { acceptReport } = await import("../src/core/ops.js");

  const first = await submitReport(fsa, clock, "bx-g2", "完成第一版", ["aaa", "bbb", "aaa"]);
  assert.equal(first.path, "temp/executor/reports/bx-g2.md");
  assert.deepEqual(first.commits, ["aaa", "bbb"]);
  assert.equal((await loadReports(fsa))[0].status, "ready");

  await rejectReport(fsa, first.path, "需要补测试");
  assert.equal((await loadReports(fsa))[0].review, "需要补测试");
  assert.equal((await loadTent(fsa)).byId.get("bx-g2")!.fm.owner, "executor");

  const revised = await submitReport(fsa, clock, "bx-g2", "已补测试", ["ccc"]);
  assert.equal(revised.status, "ready");
  let integrated: string[] = [];
  await acceptReport(env as any, revised.path, async (commits) => {
    integrated = commits;
  });
  assert.deepEqual(integrated, ["ccc"]);
  const box = (await loadTent(fsa)).byId.get("bx-g2")!;
  assert.equal(box.fm.owner, undefined);
  assert.equal(box.fm.status, "done");
  assert.equal(await fsa.exists(revised.path), false);
});

test("apply-proposal:未 accepted 不许落地", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  const pp = path.join(dir, "temp", "planner", "proposals", "open.md");
  await fs.writeFile(
    pp,
    "---\ntarget: bx-g1\nstatus: open\nfrom: planner\n---\nx\n",
  );
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { startApply } = await import("../src/core/ops.js");
  await assert.rejects(
    () => startApply(env as any, "temp/planner/proposals/open.md"),
    /accepted/,
  );
});

test("proposal 作用域:批准只接受 readable target,驳回可清理不可读 target", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "temp", "planner", "proposals"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(dir, "temp", "planner", "proposals", "hidden.md"),
    "---\ntarget: bx-a1\nstatus: open\nfrom: planner\n---\n请求改不可读参考\n",
  );
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { applyProposal } = await import("../src/core/ops.js");
  await assert.rejects(
    () => applyProposal(env as any, "temp/planner/proposals/hidden.md", true),
    /不可读/,
  );
  await applyProposal(env as any, "temp/planner/proposals/hidden.md", false);
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");
  const after = parseFrontmatter(
    await fs.readFile(
      path.join(dir, "temp", "planner", "proposals", "hidden.md"),
      "utf8",
    ),
  );
  assert.equal(after.data.status, "rejected");
});

test("patchBody:改正文不动 frontmatter", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { patchBody } = await import("../src/core/ops.js");
  await patchBody(env as any, "prompt/表达式任务书", "新的 note 内容\n");
  const tent = await loadTent(new NodeFs(dir));
  const p1 = tent.byId.get("bx-p1")!;
  assert.equal(p1.body.trim(), "新的 note 内容", "正文已改");
  assert.equal(p1.type, "prompt", "type 原样");
});

test("temp 系统管道:不进框树、禁止 typed box、全清后重建", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.writeFile(
    path.join(dir, "temp", "temp.md"),
    "---\nid: legacy-temp\ntype: output\n---\n",
  );
  const tent = await loadTent(fsa);
  assert.equal(
    tent.byId.has("legacy-temp"),
    false,
    "temp 即使残留同名 md 也不进框树",
  );

  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { createBox, cleanTemp } = await import("../src/core/ops.js");
  await assert.rejects(
    () =>
      createBox(env as any, {
        parentPath: "temp",
        name: "scratch",
        type: "output",
      }),
    /系统管道/,
  );
  await assert.rejects(
    () =>
      createBox(env as any, { parentPath: "", name: "temp", type: "output" }),
    /系统管道/,
  );
  await cleanTemp(env as any);
  assert.equal(await fsa.exists("temp"), true, "清空后系统目录仍存在");
  assert.equal(await fsa.exists("temp/temp.md"), false);
});

test("frontmatter 往返:删键 = 删声明", () => {
  const raw = "---\nid: bx-x\ntype: prompt\nwritable: true\n---\n正文\n";
  const { data, body, keyOrder } = parseFrontmatter(raw);
  assert.equal(data.writable, true);
  delete data.writable; // 切回继承
  const out = serializeFrontmatter(data, body, keyOrder);
  assert.ok(!out.includes("writable"), "声明已删");
  assert.ok(out.includes("正文"));
});

test("删除自定义 type:二次确认后关联 node 与整棵子树失效,修复后恢复", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createPrimaryType(fsa, "research", {
    readable: true,
    writable: true,
    color: "green",
    description: "研究资料",
  });
  await fs.mkdir(path.join(dir, "research", "child"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "research", "research.md"),
    "---\nid: bx-r\ntype: research\n---\n",
  );
  await fs.writeFile(
    path.join(dir, "research", "child", "child.md"),
    "---\nid: bx-rc\ntype: goal\n---\n",
  );

  const inspection = await inspectTypeDeletion(fsa, "type", "research");
  assert.equal(inspection.references.length, 1);
  await assert.rejects(
    () => deleteCustomType(fsa, "type", "research", "wrong"),
    /二次确认/,
  );
  await deleteCustomType(fsa, "type", "research", "research");

  let tent = await loadTent(fsa);
  const root = tent.byId.get("bx-r")!;
  const child = tent.byId.get("bx-rc")!;
  assert.equal(root.invalid, true);
  assert.equal(child.invalid, true, "失效根隔离整棵子树");
  assert.equal(child.invalidRootId, "bx-r");
  assert.equal(root.readable.value, false);
  assert.equal(canClaim(child).ok, false);
  const manifest = buildManifest(tent, {
    tentName: "x",
    role: "executor",
    claimBoxes: [tent.byId.get("bx-p1")!],
  });
  assert.ok(
    !manifest.readable.some((x) => x.path.startsWith("research")),
    "异常范围不进 manifest",
  );

  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
  const { patchBox } = await import("../src/core/ops.js");
  await assert.rejects(
    () => patchBox(env as any, "research/child", { type: "goal" }),
    /失效根/,
  );
  await patchBox(env as any, "research", { type: "goal" });
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-r")!.invalid, false);
  assert.equal(tent.byId.get("bx-rc")!.invalid, false);
});

test("删除自定义 type:关联认领范围会阻止整次删除", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createPrimaryType(fsa, "secret", {
    readable: false,
    writable: false,
    description: "私密",
  });
  const file = path.join(dir, "goal", "挖新alpha", "挖新alpha.md");
  const raw = await fs.readFile(file, "utf8");
  await fs.writeFile(
    file,
    raw.replace("type: goal", "type: secret"),
  );

  const inspection = await inspectTypeDeletion(fsa, "type", "secret");
  assert.ok(
    inspection.activeOwners.some((x) => x.id === "bx-g2"),
    "关联子孙 owner 被识别",
  );
  await assert.rejects(
    () => deleteCustomType(fsa, "type", "secret", "secret"),
    /先盖章或强清/,
  );
  await assert.rejects(
    () => deleteCustomType(fsa, "type", "asset", "asset"),
    /内置类型/,
  );
});

test("归档:整棵子树 R/W 关闭且退出正常流程,恢复后还原", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
  const { archiveBox, restoreBox } = await import("../src/core/ops.js");

  await archiveBox(env as any, "bx-p1");
  let tent = await loadTent(fsa);
  const root = tent.byId.get("bx-p1")!;
  const child = tent.byId.get("bx-p2")!;
  assert.equal(root.archived, true);
  assert.equal(child.archived, true);
  assert.equal(child.readable.value, false);
  assert.equal(child.writable.value, false);
  assert.equal(canClaim(root).ok, false);
  const manifest = buildManifest(tent, {
    tentName: "x",
    role: "executor",
    claimBoxes: [tent.byId.get("bx-a1")!],
  });
  assert.ok(
    !manifest.readable.some((x) => x.path.startsWith("prompt/表达式任务书")),
  );

  await restoreBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.archived, false);
  assert.equal(
    tent.byId.get("bx-p2")!.writable.value,
    true,
    "原显式权限自然恢复",
  );
});

test("永久删除:node 必须先归档,删除父级会删除整棵子树", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
  const { archiveBox, deleteArchivedBox } = await import("../src/core/ops.js");
  await assert.rejects(() => deleteArchivedBox(env as any, "bx-p1"), /先归档/);
  await archiveBox(env as any, "bx-p1");
  await deleteArchivedBox(env as any, "bx-p1");
  assert.equal(await fsa.exists("prompt/表达式任务书"), false);
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.has("bx-p1"), false);
  assert.equal(tent.byId.has("bx-p2"), false);
});

test("R1 patchBox 上锁:保留字段与空 type 不能绕过专用 API", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
  const { patchBox } = await import("../src/core/ops.js");

  for (const patch of [
    { id: "changed" },
    { owner: "planner" },
    { archived: true },
  ]) {
    await assert.rejects(
      () => patchBox(env as any, "prompt/旧站资料", patch),
      /保留字段/,
    );
  }
  await assert.rejects(
    () => patchBox(env as any, "prompt/旧站资料", { type: undefined }),
    /不允许清空/,
  );
  await assert.rejects(
    () => patchBox(env as any, "prompt/旧站资料", { type: "missing" }),
    /未知 type/,
  );
});

test("R3 注册表创建 API:校验名称、跨级重名并写入定义", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createPrimaryType(fsa, "research", {
    readable: true,
    writable: false,
    color: "green",
    description: "研究",
  });
  await createSecondaryType(fsa, "reviewed", { readable: true, writable: false });
  await updateTypeMetadata(fsa, "type", "research", {
    color: "pink",
  });
  await updateTypeMetadata(fsa, "type", "reviewed", { color: "gray" });
  const registry = await loadTypeRegistry(fsa);
  assert.equal(registry.research.description, "研究");
  assert.equal(registry.research.color, "pink");
  assert.equal(registry.reviewed.color, "gray");
  assert.equal(registry.reviewed.writable, false);
  await assert.rejects(
    () => createSecondaryType(fsa, "research", {}),
    /已存在/,
  );
  await assert.rejects(
    () => createPrimaryType(fsa, "temp", { readable: true, writable: true }),
    /系统管道/,
  );
  await assert.rejects(
    () => updateTypeMetadata(fsa, "type", "missing", { color: "blue" }),
    /类型不存在/,
  );
});

test("modifier R/W:单轴继承、单轴覆盖,裸 modifier 无 base 时缺省 false", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await createSecondaryType(fsa, "reviewed", { writable: false });
  const compoundPath = path.join(dir, "prompt", "表达式任务书", "草稿", "草稿.md");
  await fs.writeFile(compoundPath, "---\nid: bx-p2\ntype: prompt-reviewed\n---\n");
  const barePath = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  await fs.writeFile(barePath, "---\nid: bx-a1\ntype: reviewed\n---\n");

  let tent = await loadTent(fsa);
  const compound = tent.byId.get("bx-p2")!;
  assert.equal(compound.readable.value, true, "readable 继承 prompt");
  assert.equal(compound.writable.value, false, "writable 由 modifier 覆盖");
  const bare = tent.byId.get("bx-a1")!;
  assert.equal(bare.readable.value, false, "裸 modifier 无 base 可继承时为 false");
  assert.equal(bare.writable.value, false);

  await updateTypeMetadata(fsa, "type", "reviewed", { writable: "inherit" });
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p2")!.writable.value, true, "清除 override 后继承 prompt");
});

test("内置 modifier 默认:reference 的 W 与 asset 的 R 继承 base", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const referencePath = path.join(dir, "prompt", "表达式任务书", "草稿", "草稿.md");
  await fs.writeFile(referencePath, "---\nid: bx-p2\ntype: prompt-reference\n---\n");
  const assetPath = path.join(dir, "prompt", "旧站资料", "旧站资料.md");
  await fs.writeFile(assetPath, "---\nid: bx-a1\ntype: goal-asset\n---\n");

  const tent = await loadTent(fsa);
  assert.equal(tent.typeRegistry.reference.writable, undefined);
  assert.equal(tent.typeRegistry.asset.readable, undefined);
  assert.equal(tent.byId.get("bx-p2")!.writable.value, true, "reference W 继承 prompt");
  assert.equal(tent.byId.get("bx-a1")!.readable.value, true, "asset R 继承 goal");
});

test("types.json:遗留 glyph 静默忽略", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".tent", "types.json"),
    JSON.stringify({ research: { tier: "base", readable: true, writable: false, glyph: "R" } }),
  );
  const registry = await loadTypeRegistry(new NodeFs(dir));
  assert.equal("glyph" in registry.research, false);
});

test("类型注册表:旧 schema 缺 color 时继承默认色,新建缺 color 自动分配", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".tent", "types.json"),
    JSON.stringify(
      { primary: { goal: { readable: true, writable: false } }, secondary: {} },
      null,
      2,
    ),
  );
  assert.equal((await loadTent(fsa)).typeRegistry.goal.color, "blue");

  await createPrimaryType(fsa, "research", { readable: true, writable: false });
  await createSecondaryType(fsa, "draft", {});
  const registry = (await loadTent(fsa)).typeRegistry;
  assert.ok(registry.research.color, "新建 type 自动拿默认色");
  assert.ok(registry.draft.color, "legacy createSecondaryType 也创建单层 type");
});

test("R4 types.json 损坏 fail-loud,文件缺省仍用内置默认", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const defaults = await loadTypeRegistry(fsa);
  assert.equal(defaults.goal.readable, true, "缺省文件使用内置注册表");

  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(path.join(dir, ".tent", "types.json"), "{ broken json");
  await assert.rejects(() => loadTent(fsa), /types\.json 损坏/);
});

test("patchBox 改 type 不污染其他字段", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
    rand: Math.random,
  };
  const { patchBox } = await import("../src/core/ops.js");
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");

  const before = parseFrontmatter(
    await fsa.readFile("prompt/表达式任务书/草稿/草稿.md"),
  );
  await patchBox(env as any, "prompt/表达式任务书/草稿", { type: "output" });
  const after = parseFrontmatter(
    await fsa.readFile("prompt/表达式任务书/草稿/草稿.md"),
  );

  assert.equal(after.data.type, "output", "type 已改");
  assert.equal(after.data.id, before.data.id, "id 未污染");
  assert.equal(after.data.writable, before.data.writable, "writable 未污染");
  assert.equal(after.data.kind, before.data.kind, "legacy kind 未污染");
});

test("patchBox 拒绝新写 kind", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
    rand: Math.random,
  };
  const { patchBox } = await import("../src/core/ops.js");
  await assert.rejects(
    () => patchBox(env as any, "prompt/表达式任务书/草稿", { kind: "draft" }),
    /保留字段/,
  );
});

test("原生复制收编:重复 id 先失效,再整树重发 id 并清 owner/status", async () => {
  const dir = await makeTent();
  const source = path.join(dir, "prompt", "表达式任务书");
  const copied = path.join(dir, "prompt", "表达式任务书 副本");
  await fs.cp(source, copied, { recursive: true });
  const rootNote = path.join(copied, "表达式任务书.md");
  const raw = await fs.readFile(rootNote, "utf8");
  await fs.writeFile(rootNote, raw.replace("type: prompt", "type: prompt\nowner: executor\nstatus: doing"));

  const fsa = new NodeFs(dir);
  const before = await loadTent(fsa);
  assert.equal(before.byPath.has("prompt/表达式任务书 副本"), false, "根笔记未同名时尚未构成框");

  const { adoptCopiedSubtree } = await import("../src/core/ops.js");
  const ids = await adoptCopiedSubtree({
    fs: fsa,
    clock: { now: () => "t" },
    tentName: "x",
    rand: Math.random,
  }, "prompt/表达式任务书 副本");
  assert.equal(ids.length, 2);
  assert.equal(await fsa.exists("prompt/表达式任务书 副本/表达式任务书 副本.md"), true);

  const after = await loadTent(fsa);
  const fork = after.byPath.get("prompt/表达式任务书 副本")!;
  assert.equal(fork.invalid, false);
  assert.notEqual(fork.id, "bx-p1");
  assert.equal(fork.fm.owner, undefined);
  assert.equal(fork.fm.status, undefined);
  assert.equal(fork.children[0].name, "草稿", "只改复制根名字");
  assert.notEqual(fork.children[0].id, "bx-p2");
  assert.equal(after.byId.get("bx-p1")?.path, "prompt/表达式任务书");
});

test("无法识别为新复制的重复 id 会显式失效,不会覆盖索引", async () => {
  const dir = await makeTent();
  const duplicate = path.join(dir, "另一个任务");
  await fs.mkdir(duplicate);
  await fs.writeFile(
    path.join(duplicate, "另一个任务.md"),
    "---\nid: bx-p1\ntype: prompt\n---\n",
  );
  const tent = await loadTent(new NodeFs(dir));
  assert.equal(tent.byId.has("bx-p1"), false);
  assert.equal(tent.byPath.get("prompt/表达式任务书")?.invalid, true);
  assert.equal(tent.byPath.get("另一个任务")?.invalid, true);
});

test("Tent mutation lock:并发写入被短期互斥,释放后可继续", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-lock-"));
  const first = new NodeFs(dir);
  const second = new NodeFs(dir);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const active = first.withLock!(".tent/mutation.lock", async () => held);
  while (!(await first.exists(".tent/mutation.lock"))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(
    () => second.withLock!(".tent/mutation.lock", async () => undefined),
    /另一个写操作/,
  );
  release();
  await active;
  await second.withLock!(".tent/mutation.lock", async () => undefined);
});

test("workspace Git:中文 role 复用单一 worktree/branch,验收 commit 合入 main", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-workspace-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");

  const { ensureRoleWorkspace, integrateWorkspaceCommits, listRoleCommits, readWorkspaceHead } =
    await import("../src/core/workspace.js");
  const initialHead = await readWorkspaceHead(workspace);
  assert.equal(initialHead.branch, "main");
  assert.equal(initialHead.ref, (await git(workspace, "rev-parse", "main")).trim());
  const contract = await ensureRoleWorkspace(workspace, "执行者");
  assert.equal(contract.branch, "tent-role/执行者");
  assert.equal(path.basename(contract.worktree), "执行者");
  assert.deepEqual(await ensureRoleWorkspace(workspace, "执行者"), contract, "同 role 复用 lane");

  await fs.writeFile(path.join(contract.worktree, "result.txt"), "done\n");
  await git(contract.worktree, "add", "result.txt");
  await git(contract.worktree, "commit", "-q", "-m", "deliver result");
  const sourceRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(contract.worktree, "second.txt"), "second\n");
  await git(contract.worktree, "add", "second.txt");
  await git(contract.worktree, "commit", "-q", "-m", "second result");
  const secondRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

  const candidates = await listRoleCommits(contract);
  assert.deepEqual(
    candidates.map((item) => item.ref),
    [secondRef, sourceRef],
    "候选 commit 按时间倒序列出 role lane 领先 main 的提交",
  );
  assert.equal(candidates[0].shortRef, secondRef.slice(0, candidates[0].shortRef.length));
  assert.equal(candidates[0].subject, "second result");
  assert.equal(candidates[1].subject, "deliver result");
  assert.equal((await readWorkspaceHead(workspace)).ref, initialHead.ref, "role lane 提交不改变正式 HEAD");
  assert.deepEqual(
    await listRoleCommits({ ...contract, branch: "tent-role/missing" }),
    [],
    "role lane 不存在时按无候选处理",
  );

  const [integrated] = await integrateWorkspaceCommits(contract, [sourceRef]);
  assert.equal(integrated.sourceRef, sourceRef);
  assert.equal(integrated.alreadyIntegrated, false);
  assert.equal((await readWorkspaceHead(workspace)).ref, integrated.integratedRef, "验收后正式 HEAD 随合入更新");
  assert.equal((await fs.readFile(path.join(workspace, "result.txt"), "utf8")).replace(/\r\n/g, "\n"), "done\n");
  const [again] = await integrateWorkspaceCommits(contract, [sourceRef]);
  assert.equal(again.alreadyIntegrated, true, "重复确认不重复 cherry-pick");
  assert.equal(again.integratedRef, integrated.integratedRef);
});

test("listRoleCommitsFor:只读列举 role 分支 commits,不创建 worktree", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-commit-list-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");

  await git(workspace, "checkout", "-q", "-b", "tent-role/reviewer");
  await fs.writeFile(path.join(workspace, "a.txt"), "a\n");
  await git(workspace, "add", "a.txt");
  await git(workspace, "commit", "-q", "-m", "first review");
  const firstRef = (await git(workspace, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(workspace, "b.txt"), "b\n");
  await git(workspace, "add", "b.txt");
  await git(workspace, "commit", "-q", "-m", "second review");
  const secondRef = (await git(workspace, "rev-parse", "HEAD")).trim();
  await git(workspace, "checkout", "-q", "main");

  const beforeWorktrees = await git(workspace, "worktree", "list", "--porcelain");
  const { listRoleCommitsFor } = await import("../src/core/workspace.js");
  const commits = await listRoleCommitsFor(workspace, "reviewer");
  const afterWorktrees = await git(workspace, "worktree", "list", "--porcelain");

  assert.deepEqual(
    commits.map((item) => item.ref),
    [secondRef, firstRef],
    "只读 API 能列出 role branch 领先 main 的 commits",
  );
  assert.equal(commits[0].subject, "second review");
  assert.equal(afterWorktrees, beforeWorktrees, "列举 commit 不应创建 worktree");
  assert.deepEqual(await listRoleCommitsFor(workspace, "missing"), []);
  assert.equal(await git(workspace, "worktree", "list", "--porcelain"), beforeWorktrees);
});

test("completeClaim:workspace 合入失败时不释放 owner 或写 done", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const { completeClaim } = await import("../src/core/ops.js");
  await assert.rejects(
    () => completeClaim(
      { fs: fsa, clock: { now: () => "t" }, tentName: "x" },
      "bx-g2",
      async () => { throw new Error("conflict"); },
    ),
    /conflict/,
  );
  const box = (await loadTent(fsa)).byId.get("bx-g2")!;
  assert.equal(box.fm.owner, "executor");
  assert.equal(box.fm.status, "doing");
});
