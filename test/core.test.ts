import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { canClaim, isFrozen } from "../src/core/claim.js";
import { buildManifest, manifestToYaml } from "../src/core/manifest.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { syncOkfBundle } from "../src/core/okf.js";
import { submitReport } from "../src/core/report.js";
import { loadTaskEnvelope, loadTaskEnvelopes, relayPromptForTask } from "../src/core/task.js";
import { cli, makeTent } from "./helpers.js";

test("NodeFs:rejects paths that resolve outside the Tent root", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-nodefs-"));
  const root = path.join(parent, "tent");
  const victim = path.join(parent, "victim");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(victim, { recursive: true });
  await fs.writeFile(path.join(victim, "keep.txt"), "keep\n", "utf8");
  const fsa = new NodeFs(root);

  await assert.rejects(() => fsa.remove("../victim"), /Path escapes Tent root/);

  assert.equal(await exists(path.join(victim, "keep.txt")), true);
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test("占用只冻结向下子树,认领仍保持祖先/子孙不重叠", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "goal", "挖新alpha", "写表达式", "实现细节"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "goal", "挖新alpha", "写表达式", "实现细节", "实现细节.md"),
    "---\nid: bx-g3\ntype: goal\n---\n",
  );
  const tent = await loadTent(new NodeFs(dir));

  const g1 = tent.byId.get("bx-g1")!; // 子孙 g2 已被 executor 占
  const check = canClaim(g1);
  assert.equal(check.ok, false);
  assert.ok(check.blocker?.id === "bx-g2");
  assert.equal(isFrozen(g1), false, "有占用子孙的祖先不冻结");
  assert.equal(g1.locked, false);
  assert.equal(g1.lockSource, undefined);
  assert.equal(g1.lockOwner, undefined);

  const g2 = tent.byId.get("bx-g2")!;
  assert.equal(canClaim(g2).ok, false, "自己已被占");
  assert.equal(isFrozen(g2), true, "占用框自身冻结");
  assert.equal(g2.locked, true);
  assert.equal(g2.lockSource, "self");
  assert.equal(g2.lockOwner, "executor");

  const g3 = tent.byId.get("bx-g3")!;
  const descendantCheck = canClaim(g3);
  assert.equal(descendantCheck.ok, false, "占用框的子孙仍不能被重复认领");
  assert.equal(descendantCheck.blocker?.id, "bx-g2");
  assert.equal(isFrozen(g3), true, "占用框的子孙冻结");
  assert.equal(g3.locked, true);
  assert.equal(g3.lockSource, "ancestor");
  assert.equal(g3.lockOwner, "executor");
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
  assert.ok(readablePaths.includes("roles.json"), "role 注册表是 agent 的系统只读上下文");
  assert.ok(readablePaths.includes("temp/"), "整个 temp 系统管道在可读集");

  const yaml = manifestToYaml(m);
  assert.ok(yaml.includes("tent: wqb"));
  assert.ok(yaml.includes("role: executor"));
  assert.equal(m.preloaded[0], "RULES.md", "RULES 固定在预灌前缀");
  assert.ok(
    m.preloaded.indexOf("prompt/表达式任务书 body") <
      m.preloaded.indexOf("prompt/表达式任务书/草稿 body"),
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
    leafManifest.writable.some((e) => e.path === "prompt/表达式任务书/" && /Structural permission/.test(e.note || "")),
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

test("dispatch:只写 pending envelope,task-ack 才占用并保留重复派活拓扑门", async () => {
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
  assert.equal(claimed.fm.owner, undefined);
  assert.equal(claimed.fm.status, undefined, "dispatch 不占用,只留下 pending envelope");
  assert.equal((await loadTaskEnvelope(env.fs, result.taskPath)).status, "pending");

  await assert.rejects(
    () => dispatch(env as any, "bx-p1", "analyst", "重复派活"),
    /already awaiting delivery to analyst\./,
    "同一框 pending envelope 也算占位",
  );
  await assert.rejects(
    () => dispatch(env as any, "bx-p2", "analyst", "对子孙重复派活"),
    /Ancestor 表达式任务书 is awaiting delivery to analyst\./,
    "pending envelope 挡住子孙",
  );
  await assert.rejects(
    () => dispatch(env as any, "bx-promptzone", "analyst", "对祖先重复派活"),
    /Descendant 表达式任务书 is awaiting delivery to analyst\./,
    "pending envelope 挡住祖先",
  );

  const second = await dispatch(env as any, "bx-o1", "analyst", "继续处理 output 指针");
  assert.notEqual(second.taskPath, result.taskPath, "task 信封不可变,不覆盖");
  assert.match(second.manifestYaml, /claims: \[bx-p1, bx-o1\]/);

  const { cancelPendingTask, taskAck } = await import("../src/core/ops.js");
  await cancelPendingTask(env as any, result.taskPath);
  assert.equal(await env.fs.exists(result.taskPath), false, "未 ack 的投递可直接取消");

  await taskAck(env as any, second.taskPath);
  claimed = (await loadTent(env.fs)).byId.get("bx-o1")!;
  assert.equal(claimed.fm.owner, "analyst");
  assert.equal(claimed.fm.status, "doing", "task-ack 才进入 doing");
  assert.equal((await loadTaskEnvelope(env.fs, second.taskPath)).status, "taken");
});

test("dispatch:corrupt roles registry is backed up, reset, and dispatch continues", async () => {
  const dir = await makeTent();
  await fs.writeFile(path.join(dir, "roles.json"), "{not-json", "utf8");
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-06-29T01:02:03.000Z" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");

  await dispatch(env as any, "bx-p1", "analyst", "请只处理表达式任务书。");

  const box = parseFrontmatter(await fs.readFile(path.join(dir, "prompt", "表达式任务书", "表达式任务书.md"), "utf8")).data;
  assert.equal(box.owner, undefined);
  assert.equal(box.status, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "roles.json"), "utf8")), { roles: [] });
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("roles.json.corrupt-")), true);
  assert.equal(await exists(path.join(dir, "temp", "analyst")), true);
});

test("task envelopes:只读加载有效任务并重建 relay prompt", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-07-03T08:10:00.000Z" },
    tentName: "wqb",
    rand: () => 0.5,
  };
  const { dispatch } = await import("../src/core/ops.js");
  const first = await dispatch(env as any, "bx-p1", "analyst", "分析任务");
  env.clock.now = () => "2026-07-03T08:11:00.000Z";
  const second = await dispatch(env as any, "bx-o1", "reviewer", "审阅产出");
  await fs.mkdir(path.join(dir, "temp", "broken", "tasks"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "temp", "broken", "tasks", "bad.md"),
    "---\ntype: task\nrole: broken\nclaims: nope\n---\n",
  );

  const tasks = await loadTaskEnvelopes(env.fs);
  assert.deepEqual(tasks.map((task) => task.path), [first.taskPath, second.taskPath]);
  assert.equal(tasks[0].path, first.taskPath);
  assert.equal(tasks[0].role, "analyst");
  assert.deepEqual(tasks[0].claims, ["bx-p1"]);
  assert.equal(tasks[0].manifest, "temp/analyst/manifest.yml");
  assert.equal(tasks[0].status, "pending");
  assert.equal(tasks[0].state, "queued");
  assert.equal(tasks[0].dispatchedBy, "user");
  assert.equal(tasks[0].deliveryPolicy, "manual");
  assert.ok(tasks[0].id?.startsWith("tk-"));
  const relay = relayPromptForTask(tasks[1], dir);
  assert.match(relay, /^A Tent task has been dispatched to role reviewer\./);
  assert.match(relay, new RegExp(`systemRoot: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(relay, /\.tent\/temp\//);
  assert.match(
    relay,
    new RegExp(
      `1\\. Run \`tent task claim ${second.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` to take this task`
    )
  );
  assert.match(
    relay,
    new RegExp(`tent task get ${second.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  );
  assert.match(
    relay,
    new RegExp(
      `3\\. When finished, run \`tent task deliver ${second.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --summary <text>\``
    )
  );
  assert.match(relay, /complete role init first/);
  assert.doesNotMatch(relay, /task-ack|tent report\b/);
  assert.doesNotMatch(relay, /whether to reuse|是否复用/i);

  const { sessionBootstrapPromptForTask } = await import("../src/core/task.js");
  const bootstrap = sessionBootstrapPromptForTask(
    { ...tasks[1], state: "running", status: "taken" },
    { workspaceRoot: path.join(dir, ".."), systemRoot: dir }
  );
  assert.match(bootstrap, /already claimed/i);
  assert.match(bootstrap, /Skip any claim step/i);
  assert.match(bootstrap, new RegExp(`tent task get ${second.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(bootstrap, new RegExp(`tent task deliver ${second.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(bootstrap, /tent task claim|task-ack|tent report\b/);
});

test("task-ack missing envelope reports a clean error", async () => {
  const dir = await makeTent();
  const { ackTaskEnvelope } = await import("../src/core/task.js");
  await assert.rejects(
    () => ackTaskEnvelope(new NodeFs(dir), "temp/analyst/tasks/nope.md"),
    /Task envelope not found: temp\/analyst\/tasks\/nope\.md\./,
  );
});

test("dispatch:必须提供 user prompt", async () => {
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
    /Dispatch requires a user prompt\./,
  );
});

test("dispatch:拒绝整帐 claim,具体框仍可派活", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");
  const message = /Cannot dispatch the whole Tent directly; dispatch a specific box \(boxId cannot be \., root, or the Tent name\)\./;
  await assert.rejects(() => dispatch(env as any, ".", "architect", "接管全帐"), message);
  await assert.rejects(() => dispatch(env as any, "root", "architect", "接管全帐"), message);
  await assert.rejects(() => dispatch(env as any, "wqb", "architect", "接管全帐"), message);

  const result = await dispatch(env as any, "bx-p1", "architect", "处理具体框");
  assert.match(result.manifestYaml, /claims: \[bx-p1\]/);
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

test("placeBox:只阻止移动或移入被占用子树,不阻止其祖先", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { placeBox } = await import("../src/core/ops.js");
  await assert.rejects(
    () => placeBox(env as any, "goal/挖新alpha/写表达式", "prompt", { mode: "inside" }),
    /Claimed ranges cannot be moved/,
  );
  await assert.rejects(
    () => placeBox(env as any, "prompt/旧站资料", "goal/挖新alpha/写表达式", { mode: "inside" }),
    /Cannot move into a claimed range/,
  );

  await placeBox(env as any, "goal/挖新alpha", "prompt", { mode: "inside" });
  const tent = await loadTent(new NodeFs(dir));
  const prompt = tent.byId.get("bx-promptzone")!;
  assert.ok(prompt.children.some((child) => child.id === "bx-g1"));
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
  assert.match(orphan.invalidReason || "", /Missing id/);
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
    /system pipe/,
  );
  await assert.rejects(
    () =>
      createBox(env as any, { parentPath: "", name: "temp", type: "output" }),
    /system pipe/,
  );
  await cleanTemp(env as any);
  assert.equal(await fsa.exists("temp"), true, "清空后系统目录仍存在");
  assert.equal(await fsa.exists("temp/temp.md"), false);
});

test("createBox and cleanTemp reject unsafe names before filesystem writes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { createBox, cleanTemp } = await import("../src/core/ops.js");

  await assert.rejects(
    () => createBox(env as any, { parentPath: "", name: "a/b", type: "goal" }),
    /Box name cannot contain path separators\./,
  );
  await assert.rejects(
    () => createBox(env as any, { parentPath: "", name: "a\\b", type: "goal" }),
    /Box name cannot contain path separators\./,
  );
  await assert.rejects(
    () => createBox(env as any, { parentPath: "", name: "Line\nBreak", type: "goal" }),
    /Box name cannot contain newlines\./,
  );
  await assert.rejects(
    () => createBox(env as any, { parentPath: "", name: "x".repeat(201), type: "goal" }),
    /Box name cannot be longer than 200 characters\./,
  );
  assert.equal(await fsa.exists("a"), false);
  assert.equal(await fsa.exists("Line\nBreak"), false);

  await assert.rejects(
    () => cleanTemp(env as any, "bad\nrole"),
    /Role name cannot contain path separators or newlines\./,
  );
  assert.equal(await fsa.exists("temp/bad\nrole"), false);
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
  const { archiveBox, restoreBox, tagBox } = await import("../src/core/ops.js");

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
  await assert.rejects(
    () => tagBox(env as any, "bx-p1", "release"),
    /Invalid or archived boxes cannot be tagged\./,
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
  await assert.rejects(() => deleteArchivedBox(env as any, "bx-p1"), /must be archived/);
  await archiveBox(env as any, "bx-p1");
  await deleteArchivedBox(env as any, "bx-p1");
  assert.equal(await fsa.exists("prompt/表达式任务书"), false);
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.has("bx-p1"), false);
  assert.equal(tent.byId.has("bx-p2"), false);
});

test("CLI rejects unexpected positional args and missing report body cleanly", async () => {
  const dir = await makeTent();

  let result = await cli(dir, "new-box", "Extra", "goal", "parent", "ignored");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage: tent new-box <name> <type> \[parentId\]/);

  result = await cli(dir, "tag-new", "release", "ignored");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage: tent tag-new <name>/);

  result = await cli(dir, "report", "bx-p1", path.join(dir, "missing-report.txt"));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Body file not found:/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
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

test("duplicate box id direct operations report duplicate id", async () => {
  const dir = await makeTent();
  const duplicate = path.join(dir, "另一个任务");
  await fs.mkdir(duplicate);
  await fs.writeFile(
    path.join(duplicate, "另一个任务.md"),
    "---\nid: bx-p1\ntype: prompt\n---\n",
  );
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch, grantReadable } = await import("../src/core/ops.js");
  await assert.rejects(
    () => dispatch(env as any, "bx-p1", "analyst", "work"),
    /Duplicate box id 'bx-p1'/,
  );
  await assert.rejects(
    () => grantReadable(env as any, "bx-p1"),
    /Duplicate box id 'bx-p1'/,
  );
});

test("malformed box frontmatter is marked invalid with parse detail", async () => {
  const dir = await makeTent();
  await fs.writeFile(
    path.join(dir, "prompt", "表达式任务书", "表达式任务书.md"),
    "---\nid: [unterminated\ntype: prompt\n---\n# Bad\n",
  );
  const tent = await loadTent(new NodeFs(dir));
  const box = tent.byPath.get("prompt/表达式任务书")!;
  assert.equal(box.invalid, true);
  assert.match(box.invalidReason || "", /Invalid frontmatter: Invalid frontmatter YAML: unterminated flow array\./);
  assert.equal(tent.byId.has("bx-p1"), false);
});

test("Tent mutation lock:并发写入被短期互斥,释放后可继续", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-lock-"));
  const first = new NodeFs(dir);
  const second = new NodeFs(dir);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const active = first.withLock!("mutation.lock", async () => held);
  while (!(await first.exists("mutation.lock"))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await assert.rejects(
    () => second.withLock!("mutation.lock", async () => undefined),
    /already running another write operation/,
  );
  release();
  await active;
  await second.withLock!("mutation.lock", async () => undefined);
});
