import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { canClaim, isFrozen } from "../src/core/claim.js";
import { buildManifest, manifestToYaml } from "../src/core/manifest.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  BOX_FRONTMATTER_KEY_ORDER,
} from "../src/core/frontmatter.js";
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
import { submitReport } from "../src/core/report.js";
import { makeTent } from "./helpers.js";

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

test("frontmatter round-trip:quoted Windows path does not double escape", () => {
  let raw = String.raw`---
id: bx-path
type: output
workspace: "C:\\cucarol\\_code\\Tent"
---
# Workspace
`;

  for (let i = 0; i < 3; i++) {
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.data.workspace, String.raw`C:\cucarol\_code\Tent`);
    raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }

  assert.match(raw, /workspace: "C:\\\\cucarol\\\\_code\\\\Tent"/);
  assert.doesNotMatch(raw, /workspace: "C:\\\\\\\\cucarol/);
});

test("frontmatter round-trip:Obsidian block sequences are preserved as arrays", () => {
  const raw = String.raw`---
id: bx-paths
type: output
paths:
  - test/a.ts
  - "C:\\cucarol\\_code\\Tent\\src\\core\\frontmatter.ts"
custom: keep-me
---
# Paths
`;
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.paths, [
    "test/a.ts",
    String.raw`C:\cucarol\_code\Tent\src\core\frontmatter.ts`,
  ]);
  assert.equal(parsed.data.custom, "keep-me");

  const out = serializeFrontmatter(
    { ...parsed.data, type: "prompt" },
    parsed.body,
    parsed.keyOrder,
  );
  const reparsed = parseFrontmatter(out);
  assert.deepEqual(reparsed.data.paths, parsed.data.paths);
  assert.equal(reparsed.data.custom, "keep-me");
  assert.equal(reparsed.data.type, "prompt");
});

test("frontmatter parse:previously doubled workspace paths are cleaned in memory", () => {
  const parsed = parseFrontmatter(String.raw`---
id: bx-damaged
type: output
workspace: "C:\\\\cucarol\\\\_code\\\\Tent"
---
`);
  assert.equal(parsed.data.workspace, String.raw`C:\cucarol\_code\Tent`);
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

test("syncOkfBundle:生成 index/log 并把唯一 wiki 链接投影为 Markdown 链接", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const source = path.join(dir, "prompt", "表达式任务书", "表达式任务书.md");
  await fs.mkdir(path.join(dir, "prompt", "space child"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "prompt", "space child", "space child.md"),
    "---\nid: bx-space\ntype: prompt\n---\n# Space Child\n",
  );
  await fs.mkdir(path.join(dir, "space root"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "space root", "space root.md"),
    "---\nid: bx-space-root\ntype: prompt\n---\n# Space Root\n",
  );
  await fs.writeFile(
    source,
    "---\nid: bx-p1\ntype: prompt\n---\n见 [[bx-g1|目标]]、[[bx-space|空格子框]] 和 ![[Pasted image.png]]。\n",
  );

  const result = await syncOkfBundle(fsa);
  const note = await fs.readFile(source, "utf8");
  const rootIndex = await fs.readFile(path.join(dir, "index.md"), "utf8");
  const childIndex = await fs.readFile(path.join(dir, "prompt", "space child", "index.md"), "utf8");
  assert.ok(result.generatedFiles.includes("index.md"));
  assert.ok(result.generatedFiles.includes("log.md"));
  assert.equal(result.unresolved.length, 0);
  assert.match(note, /\[目标\]\(\.\.\/\.\.\/goal\/挖新alpha\/挖新alpha\.md\)/);
  assert.match(note, /\[空格子框\]\(<\.\.\/space child\/space child\.md>\)/);
  assert.match(rootIndex, /\[space root\]\(<space root\/space root\.md>\)/);
  assert.match(childIndex, /\[space child\]\(<space child\.md>\)/);
  assert.match(note, /!\[\[Pasted image\.png\]\]/);
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
