import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { listDirectActiveTasksForNode } from "../src/core/task-node-refs.js";
import { buildManifest, manifestToYaml } from "../src/core/manifest.js";
import { parseFrontmatter } from "../src/core/frontmatter.js";
import { syncOkfBundle } from "../src/core/okf.js";
import { createTaskResult } from "../src/core/task-result.js";
import {
  loadTaskRecord,
  loadTaskRecords,
  relayPromptForTask,
  writeTaskRecord,
} from "../src/core/task.js";
import { cli, makeTent } from "./helpers.js";
import { contentEtag } from "../src/core/etag.js";

function nodeSnapshot(id: string, nodePath: string, type = "prompt", body = "") {
  return {
    id,
    path: nodePath,
    type,
    tags: [],
    body,
    etag: contentEtag(body),
    archived: false,
  };
}

async function dispatchToRole(env: any, nodeId: string, roleName: string, input: string | Record<string, unknown>) {
  const roleId = `rl-${roleName.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const registry = await env.fs.exists("roles.json")
    ? JSON.parse(await env.fs.readFile("roles.json")) as { roles?: Array<Record<string, unknown>> }
    : { roles: [] as Array<Record<string, unknown>> };
  if (!(registry.roles ?? []).some((role) => role.id === roleId)) {
    registry.roles = [...(registry.roles ?? []), { id: roleId, name: roleName, displayName: roleName }];
    await env.fs.writeFile("roles.json", JSON.stringify(registry, null, 2) + "\n");
  }
  const { dispatch } = await import("../src/core/ops.js");
  return dispatch(env, {
    assigneeRoleId: roleId,
    nodeIds: [nodeId],
    requester: { kind: "user", id: "user" },
    ...(typeof input === "string" ? { prompt: input } : input),
  });
}

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

test("NodeFs: text replacement never exposes a partial file to readers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-fs-atomic-"));
  const fsa = new NodeFs(root);
  const oldValue = `old:${"a".repeat(256 * 1024)}`;
  const newValue = `new:${"b".repeat(256 * 1024)}`;
  await fsa.writeFile("state.json", oldValue);

  const observed = new Set<string>();
  const writer = (async () => {
    for (let i = 0; i < 20; i += 1) {
      await fsa.writeFile("state.json", i % 2 === 0 ? newValue : oldValue);
    }
  })();
  const readers = Array.from({ length: 80 }, async () => {
    observed.add(await fsa.readFile("state.json"));
  });
  await Promise.all([writer, ...readers]);

  for (const value of observed) {
    assert.ok(value === oldValue || value === newValue);
  }
});

test("syncOkfBundle:生成 index/log 并把唯一 wiki 链接投影为 Markdown 链接", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const source = path.join(dir, "prompt", "表达式任务书", "表达式任务书.md");
  await fs.mkdir(path.join(dir, "prompt", "space child"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "prompt", "space child", "space child.md"),
    "---\nid: cx-space\ntype: prompt\n---\n# Space Child\n",
  );
  await fs.mkdir(path.join(dir, "space root"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "space root", "space root.md"),
    "---\nid: cx-spaceroot\ntype: prompt\n---\n# Space Root\n",
  );
  await fs.writeFile(
    source,
    "---\nid: cx-p1\ntype: prompt\n---\n见 [[cx-g1|目标]]、[[cx-space|空格子框]] 和 ![[Pasted image.png]]。\n",
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

test("active Task refs project only exact nodeIds", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);

  await writeTaskRecord(fsa, { now: () => "2026-07-28T12:00:00.000Z" }, {
    assigneeRoleId: "rl-reviewer",
    nodeIds: ["cx-p1"],
    nodeSnapshots: [nodeSnapshot("cx-p1", "prompt/x")],
    manifestPath: "temp/roles/rl-reviewer/manifests/tk-boxocc.yml",
    prompt: "Node ref",
    id: "tk-boxocc",
    requester: { kind: "user", id: "user" },
  });
  const tasks = await loadTaskRecords(fsa);
  const active = listDirectActiveTasksForNode("cx-p1", tasks);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.assigneeRoleId, "rl-reviewer");
  assert.equal(active[0]!.executionSessionId, undefined);
  assert.deepEqual(active[0]!.nodeIds, ["cx-p1"]);
});

test("loadTent:缺省根排序按稳定名称,不再按 zone 排名", async () => {
  const dir = await makeTent();
  // 额外顶层框:名称在字母序上夹在 goal 与 prompt 之间,且不在旧 zone 名单里
  await fs.mkdir(path.join(dir, "middle"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "middle", "middle.md"),
    "---\nid: cx-middle\ntype: prompt\n---\n",
  );
  const tent = await loadTent(new NodeFs(dir));
  const rootNames = tent.roots.map((box) => box.name);
  assert.deepEqual(
    rootNames,
    [...rootNames].sort((a, b) => a.localeCompare(b)),
    "缺省根顺序应等于稳定名称排序",
  );
  assert.ok(
    !("zone" in tent.roots[0]),
    "Node 不再携带 zone 领域属性",
  );
});

test("loadTent:顶层普通目录透传其下合法框", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "普通分组", "嵌套框"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "普通分组", "嵌套框", "嵌套框.md"),
    "---\nid: cx-nested\ntype: prompt\n---\n",
  );
  const tent = await loadTent(new NodeFs(dir));
  assert.equal(tent.byId.get("cx-nested")?.path, "普通分组/嵌套框");
  assert.ok(tent.roots.some((box) => box.id === "cx-nested"));
});

test("manifest:可读集=全帐 usable context,可写集=认领子树 + temp 格 (非 domain R/W)", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));
  const claim = tent.byId.get("cx-p1")!; // prompt/表达式任务书
  const m = buildManifest({
    tentName: "wqb",
    roleId: "rl-executor",
    selectedNodes: [claim],
  });

  // V0.2: manifest readable/writable are Task context pointers, not Node domain R/W axes.

  const writablePaths = m.writable.map((e) => e.path);
  const readablePaths = m.readable.map((e) => e.path);
  assert.ok(
    writablePaths.some((p) => p.includes("草稿")),
    "草稿在认领子树可写集",
  );
  assert.ok(
    writablePaths.some((p) => p === "temp/roles/rl-executor/"),
    "temp 格在可写集",
  );
  assert.ok(readablePaths.includes("roles.json"), "role 注册表是 agent 的系统只读上下文");
  assert.ok(readablePaths.includes("temp/"), "整个 temp 系统管道在可读集");
  // All usable concepts appear in readable context set
  assert.ok(readablePaths.some((p) => p.includes("表达式任务书")));

  const yaml = manifestToYaml(m);
  assert.ok(yaml.includes("tent: wqb"));
  assert.ok(yaml.includes("roleId: rl-executor"));
  assert.ok(yaml.includes("readable:"));
  assert.ok(yaml.includes("writable:"));
  assert.equal(yaml.includes("preloaded:"), false, "preloaded 字段已删除");
  assert.doesNotMatch(yaml, /^claims:/m, "manifest YAML must not persist a second claims source");
  assert.ok(!("claims" in m), "Manifest object has no claims field");
  assert.deepEqual(
    Object.keys(m).sort(),
    ["roleId", "readable", "tent", "writable"].sort(),
    "manifest 仅保留 readable/writable 与身份字段（无 claims）",
  );
  // Writable pointer list encodes dispatch selection (id present for claimed nodes).
  assert.ok(
    m.writable.some((e) => e.id === "cx-p1"),
    "writable context pointers carry selected Node ids without a claims[] field",
  );
});

test("manifest: selected subtree grants structural write access", async () => {
  const dir = await makeTent();
  const tent = await loadTent(new NodeFs(dir));
  const claim = tent.byId.get("cx-p1")!;
  const leafManifest = buildManifest({
    tentName: "wqb",
    roleId: "rl-executor",
    selectedNodes: [claim],
  });
  assert.ok(
    leafManifest.writable.some((e) => e.path === "prompt/表达式任务书/" && /Structural permission/.test(e.note || "")),
    "认领框本身有创建/移动/删除子框的结构权",
  );
  assert.ok(
    leafManifest.writable.some((e) => e.path === "prompt/表达式任务书/草稿/"),
    "认领子树里的子框也有结构权",
  );

  const rootManifest = buildManifest({
    tentName: "wqb",
    roleId: "rl-architect",
    selectedNodes: tent.roots,
  });
  assert.ok(!("claims" in rootManifest), "root selection is not a persisted claims field");
  assert.doesNotMatch(manifestToYaml(rootManifest), /^claims:/m);
  assert.ok(rootManifest.writable.some((e) => e.path === "goal/"), "所选根保留子树结构权");
  assert.ok(rootManifest.writable.some((e) => e.path === "prompt/"), "所选根覆盖完整所选子树");
});

test("dispatch:只写 pending envelope + frozen Node Context Card；manifest 按 Task 隔离", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-06-29T01:02:03.000Z" },
    tentName: "wqb",
    rand: () => 0.5,
  };
  const { dispatch } = await import("../src/core/ops.js");
  const result = await dispatchToRole(
    env as any,
    "cx-p1",
    "analyst",
    "请只处理表达式任务书。",
  );
  const task = await fs.readFile(path.join(dir, ...result.taskPath.split("/")), "utf8");
  assert.match(task, /只处理表达式任务书/);
  assert.match(task, /type: task/);
  assert.match(task, /contextCard:/);
  assert.doesNotMatch(task, /^claims:/m);
  assert.match(await fs.readFile(path.join(dir, "temp", "roles", "rl-analyst", "init.md"), "utf8"), /type: role-init/);
  assert.match(result.relayPrompt, /task-/);
  assert.doesNotMatch(result.relayPrompt, /```yaml/);
  assert.doesNotMatch(result.relayPrompt, /\ntent: wqb\nrole: analyst/);
  assert.equal(result.manifestYaml.includes("preloaded:"), false);
  assert.doesNotMatch(result.manifestYaml, /^claims:/m, "manifest must not emit claims[]");
  assert.match(result.manifestYaml, /readable:/);
  assert.match(result.manifestYaml, /writable:/);
  // Selection appears as writable context pointers (id), not a dual claims source.
  assert.match(result.manifestYaml, /id: cx-p1/);
  let claimed = (await loadTent(env.fs)).byId.get("cx-p1")!;
  assert.equal(claimed.fm.owner, undefined);
  assert.equal(claimed.fm.status, undefined, "dispatch 不写 Node owner/status");
  assert.equal((await loadTaskRecord(env.fs, result.taskPath)).state, "queued");

  const concurrent = await dispatchToRole(env as any, "cx-p1", "executor", "同 Node 并发");
  assert.notEqual(concurrent.taskPath, result.taskPath);

  const firstTask = await loadTaskRecord(env.fs, result.taskPath);
  assert.equal(firstTask.manifest, result.manifestPath);
  assert.match(result.manifestPath, new RegExp(`^temp/roles/rl-analyst/manifests/${firstTask.id}\\.yml$`));

  // Parent and child refs remain independent from the same frozen Node selection.
  const onChild = await dispatchToRole(env as any, "cx-p2", "analyst", "子孙并发");
  assert.ok(onChild.taskPath);
  const onAncestor = await dispatchToRole(env as any, "cx-promptzone", "planner", "祖先并发");
  assert.ok(onAncestor.taskPath);

  const second = await dispatchToRole(env as any, "cx-o1", "analyst", "继续处理 output 指针");
  assert.notEqual(second.taskPath, result.taskPath, "task 信封不可变,不覆盖");
  const secondTask = await loadTaskRecord(env.fs, second.taskPath);
  assert.equal(secondTask.manifest, second.manifestPath);
  assert.match(second.manifestPath, new RegExp(`^temp/roles/rl-analyst/manifests/${secondTask.id}\\.yml$`));
  assert.notEqual(firstTask.manifest, secondTask.manifest, "不同 Task 不共享可写 manifest");
  // Manifest snapshots only this Task's exact requested Node (no prior Role aggregation).
  assert.doesNotMatch(second.manifestYaml, /^claims:/m);
  assert.match(second.manifestYaml, /writable:/);
  assert.match(second.manifestYaml, /id: cx-o1/);
  // Prior active analyst Task Nodes must not bleed into this Task's writable selection.
  const secondWritable = second.manifestYaml.split(/^writable:\r?\n/m)[1] ?? "";
  assert.doesNotMatch(secondWritable, /id: cx-p1\b/);
  assert.doesNotMatch(secondWritable, /id: cx-p2\b/);

  const { cancelPendingTask, taskAck } = await import("../src/core/ops.js");
  await cancelPendingTask(env as any, result.taskPath);
  assert.equal(await env.fs.exists(result.taskPath), false, "未 ack 的投递可直接取消");

  await taskAck(env as any, second.taskPath);
  claimed = (await loadTent(env.fs)).byId.get("cx-o1")!;
  assert.equal(claimed.fm.owner, undefined, "task-ack 不写 Node owner");
  assert.equal(claimed.fm.status, undefined, "task-ack 不写 Node status");
  assert.equal((await loadTaskRecord(env.fs, second.taskPath)).state, "running");
});

test("dispatch: corrupt Role registry fails loud without mutation", async () => {
  const dir = await makeTent();
  const corrupt = "{not-json";
  await fs.writeFile(path.join(dir, "roles.json"), corrupt, "utf8");
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "2026-06-29T01:02:03.000Z" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");

  await assert.rejects(
    () => dispatch(env as any, {
      assigneeRoleId: "rl-analyst",
      nodeIds: ["cx-p1"],
      prompt: "请只处理表达式任务书。",
      requester: { kind: "user", id: "user" },
    }),
    /JSON/
  );

  const box = parseFrontmatter(await fs.readFile(path.join(dir, "prompt", "表达式任务书", "表达式任务书.md"), "utf8")).data;
  assert.equal(box.owner, undefined);
  assert.equal(box.status, undefined);
  assert.equal(await fs.readFile(path.join(dir, "roles.json"), "utf8"), corrupt);
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("roles.json.corrupt-")), false);
  assert.equal((await loadTaskRecords(env.fs)).length, 0, "failed Role lookup writes no Task");
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
  const first = await dispatchToRole(env as any, "cx-p1", "analyst", "分析任务");
  env.clock.now = () => "2026-07-03T08:11:00.000Z";
  const second = await dispatchToRole(env as any, "cx-o1", "reviewer", "审阅产出");
  const tasks = await loadTaskRecords(env.fs);
  assert.deepEqual(tasks.map((task) => task.path), [first.taskPath, second.taskPath]);
  assert.equal(tasks[0].path, first.taskPath);
  assert.equal(tasks[0].assigneeRoleId, "rl-analyst");
  assert.equal(tasks[0].executionSessionId, undefined);
  assert.deepEqual(
    tasks[0].contextCard?.nodeSnapshots.map((n) => n.id) ?? [],
    ["cx-p1", "cx-p2"]
  );
  assert.equal(tasks[0].manifest, first.manifestPath);
  assert.match(tasks[0].manifest, new RegExp(`^temp/roles/rl-analyst/manifests/${tasks[0].id}\\.yml$`));
  assert.equal(tasks[0].state, "queued");
  assert.equal(tasks[0].requester?.kind, "user");
  assert.equal(tasks[0].requester?.id, "user");
  assert.doesNotMatch(await env.fs.readFile(tasks[0].path), /^reviewer:/m);
  assert.equal(tasks[0].acceptMode, "review-required");
  assert.ok(tasks[0].id?.startsWith("tk-"));
  const relay = relayPromptForTask(tasks[1], dir);
  assert.match(relay, /^A Tent task has been handed to Role rl-reviewer\./);
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
  assert.match(relay, /Task Context Card/);
  assert.match(relay, /nodeIds:/);
  assert.doesNotMatch(relay, /workNodeIds:|contextNodeIds:/);
  assert.match(
    relay,
    new RegExp(
      `3\\. When finished, run \`tent task submit ${second.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --report <text>\``
    )
  );
  assert.match(relay, /complete Role init first/);
  assert.doesNotMatch(relay, /task-ack|tent report\b/);
  assert.doesNotMatch(relay, /whether to reuse|是否复用/i);
  // Agent-facing relay must not use box vocabulary (Node/nodeId only).
  assert.doesNotMatch(relay, /\bbox\b|\bboxes\b|\bbox notes\b/i);

  const { extractTaskPrompt, taskPackageForTask } = await import(
    "../src/core/task.js"
  );
  const taskPackage = taskPackageForTask(tasks[1]);
  assert.match(relay, new RegExp(taskPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(taskPackage, /## Context Pointers/);
  const prompt = extractTaskPrompt(tasks[1]);
  assert.equal(prompt, "审阅产出");
  assert.equal(
    taskPackageForTask({ ...tasks[1], executionSessionId: "ss-changed" }),
    taskPackage,
    "runtime Session binding must not affect canonical Task Package bytes"
  );

  await fs.mkdir(path.join(dir, "temp", "sessions", "ss-broken", "tasks"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "temp", "sessions", "ss-broken", "tasks", "bad.md"),
    "---\ntype: task\nsessionId: ss-broken\nnodeIds: nope\n---\n",
  );
  await assert.rejects(() => loadTaskRecords(env.fs), /Invalid task record format/);
});

test("task-ack missing envelope reports a clean error", async () => {
  const dir = await makeTent();
  const { ackTaskRecord } = await import("../src/core/task.js");
  await assert.rejects(
    () => ackTaskRecord(new NodeFs(dir), "temp/roles/rl-analyst/tasks/nope.md"),
    /Task record not found: temp\/roles\/rl-analyst\/tasks\/nope\.md\./,
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
  await dispatchToRole(env as any, "cx-p1", "analyst", "旧意图");
  await assert.rejects(
    () => dispatchToRole(env as any, "cx-o1", "analyst", ""),
    /Dispatch requires a user prompt\./,
  );
});

test("dispatch:拒绝退役根选择 token，具体 Node 仍可派活", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");
  const message = /Task nodeIds must contain canonical lowercase cx-\* Node ids/;
  await assert.rejects(() => dispatchToRole(env as any, ".", "architect", "接管全帐"), message);
  await assert.rejects(() => dispatchToRole(env as any, "root", "architect", "接管全帐"), message);
  await assert.rejects(() => dispatchToRole(env as any, "wqb", "architect", "接管全帐"), message);

  const result = await dispatchToRole(env as any, "cx-p1", "architect", "处理具体框");
  assert.doesNotMatch(result.manifestYaml, /^claims:/m);
  assert.match(result.manifestYaml, /id: cx-p1/);
  assert.match(result.manifestYaml, /writable:/);
});

test("Tent 动作不初始化 Tent Git", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");
  await dispatchToRole(env as any, "cx-p1", "analyst", "处理任务书");
  assert.equal(await new NodeFs(dir).exists(".git"), false);
});

test("tent find reports canonical Node facts and ignores retired Output pointer text", async () => {
  const fixtureRoot = await makeTent();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-find-workspace-"));
  const systemRoot = path.join(workspace, ".tent");
  await fs.rename(fixtureRoot, systemRoot);
  const fsa = new NodeFs(systemRoot);
  const notePath = "output/alpha仓库指针/alpha仓库指针.md";
  const raw = await fsa.readFile(notePath);
  await fsa.writeFile(
    notePath,
    raw
      .replace("type: output", "type: output\ntags: [artifact-find]\nworkspace: C:/legacy")
      .replace(/\n$/, "\nworkspace: C:/body\nref: deadbeef\n")
  );

  const result = await cli(workspace, "find", "artifact-find");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "cx-o1\toutput/alpha仓库指针\toutput");
  assert.doesNotMatch(result.stdout, /workspace=|ref=|deadbeef|C:\/legacy/);
});

test("placeNode 换序:before/after/inside 重排 order", async () => {
  const dir = await makeTent();
  const env = {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
    rand: () => 0.5,
  };
  const { placeNode } = await import("../src/core/ops.js");

  // prompt 下:表达式任务书(cx-p1)、旧站资料(cx-a1)。把 a1 拖到 p1 之前。
  await placeNode(env as any, "prompt/旧站资料", "prompt", {
    mode: "before",
    siblingId: "cx-p1",
  });
  let tent = await loadTent(new NodeFs(dir));
  let prompt = tent.byId.get("cx-promptzone")!;
  assert.equal(prompt.children[0].id, "cx-a1", "旧站资料 排到最前");

  // inside:把旧站资料拖进表达式任务书,成为其子框
  await placeNode(env as any, "prompt/旧站资料", "prompt/表达式任务书", {
    mode: "inside",
  });
  tent = await loadTent(new NodeFs(dir));
  const p1 = tent.byId.get("cx-p1")!;
  assert.ok(
    p1.children.some((c) => c.id === "cx-a1"),
    "旧站资料 成为表达式任务书子框",
  );
});

test("orphan Node:同名 md 缺 id 时进入 invalid 态且不进 byId", async () => {
  const dir = await makeTent();
  await fs.mkdir(path.join(dir, "orphan"), { recursive: true });
  await fs.writeFile(path.join(dir, "orphan", "orphan.md"), "---\ntype: prompt\n---\n# orphan\n");
  const tent = await loadTent(new NodeFs(dir));
  const orphan = tent.byPath.get("orphan")!;
  assert.equal(orphan.invalid, true);
  assert.match(orphan.invalidReason || "", /Invalid Node id: <missing>/);
  assert.equal(tent.byId.has(""), false);
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
  const newId = await forkNode(env as any, "cx-p1");

  const tent = await loadTent(fsa);
  const fork = tent.byId.get(newId)!;
  assert.equal(fork.path, "prompt/表达式任务书 (fork)");
  assert.equal(fork.fm.forkOf, undefined);
  assert.equal(fork.fm.forkBase, undefined);
  assert.equal(fork.fm.owner, undefined);
  assert.equal(fork.fm.status, undefined);
  assert.equal(fork.children.length, 1, "子树结构保留");
  assert.notEqual(fork.children[0].id, "cx-p2", "子框 id 也重发");
  assert.equal(fork.children[0].fm.owner, undefined);
  assert.equal(fork.children[0].fm.status, undefined);
  assert.equal(tent.byId.get("cx-p1")!.path, "prompt/表达式任务书", "原框不变");
  assert.equal(
    tent.byId.get("cx-promptzone")!.children.findIndex((box) => box.id === newId),
    tent.byId.get("cx-promptzone")!.children.findIndex((box) => box.id === "cx-p1") + 1,
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
  const p1 = tent.byId.get("cx-p1")!;
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
  const { createNode, cleanTemp } = await import("../src/core/ops.js");
  await assert.rejects(
    () =>
      createNode(env as any, {
        parentPath: "temp",
        name: "scratch",
        type: "output",
      }),
    /system pipe/,
  );
  await assert.rejects(
    () =>
      createNode(env as any, { parentPath: "", name: "temp", type: "output" }),
    /system pipe/,
  );
  await cleanTemp(env as any);
  assert.equal(await fsa.exists("temp"), true, "清空后系统目录仍存在");
  assert.equal(await fsa.exists("temp/temp.md"), false);
});

test("createNode and cleanTemp reject unsafe names before filesystem writes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { createNode, cleanTemp } = await import("../src/core/ops.js");

  await assert.rejects(
    () => createNode(env as any, { parentPath: "", name: "a/b", type: "goal" }),
    /Node name cannot contain path separators\./,
  );
  await assert.rejects(
    () => createNode(env as any, { parentPath: "", name: "a\\b", type: "goal" }),
    /Node name cannot contain path separators\./,
  );
  await assert.rejects(
    () => createNode(env as any, { parentPath: "", name: "Line\nBreak", type: "goal" }),
    /Node name cannot contain newlines\./,
  );
  await assert.rejects(
    () => createNode(env as any, { parentPath: "", name: "x".repeat(201), type: "goal" }),
    /Node name cannot be longer than 200 characters\./,
  );
  assert.equal(await fsa.exists("a"), false);
  assert.equal(await fsa.exists("Line\nBreak"), false);

  await assert.rejects(
    () => cleanTemp(env as any, "bad\nrole"),
    /Role name cannot contain path separators or newlines\./,
  );
  assert.equal(await fsa.exists("temp/bad\nrole"), false);
});

test("归档:整棵子树 wire-compat R/W 投影关闭且退出正常流程,恢复后还原", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = {
    fs: fsa,
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
  const { archiveNode, restoreNode, tagNode } = await import("../src/core/ops.js");
  const { parseFrontmatter } = await import("../src/core/frontmatter.js");
  const { nodeNotePath, isUsableNode } = await import("../src/core/tree.js");

  await archiveNode(env as any, "cx-p1");
  let tent = await loadTent(fsa);
  const root = tent.byId.get("cx-p1")!;
  const child = tent.byId.get("cx-p2")!;
  assert.equal(root.mode, "archived");
  assert.equal(root.archived, true);
  assert.equal(child.mode, "archived");
  assert.equal(child.archived, true);
  // Archived nodes are not usable; no coordination/R/W projection fields.
  assert.equal(child.archived, true);
  assert.equal("coordination" in child, false);
  assert.equal("readable" in child, false);
  assert.equal(isUsableNode(child), false);
  // Disk: archive root has mode:archived, not legacy archived:true; child has no mode write.
  const rootFm = parseFrontmatter(await fsa.readFile(nodeNotePath(root.path))).data;
  assert.equal(rootFm.mode, "archived");
  assert.equal("archived" in rootFm, false);
  assert.equal("readable" in rootFm, false);
  assert.equal("writable" in rootFm, false);
  const childFm = parseFrontmatter(await fsa.readFile(nodeNotePath(child.path))).data;
  assert.equal("mode" in childFm, false);
  assert.equal(root.invalid || root.archived, true);
  const manifest = buildManifest({
    tentName: "x",
    roleId: "rl-executor",
    selectedNodes: [tent.byId.get("cx-a1")!],
  });
  // Manifest readable is context-pointer set of usable nodes — archived subtree excluded
  assert.ok(
    !manifest.readable.some((x) => x.path.startsWith("prompt/表达式任务书")),
  );
  await assert.rejects(
    () => tagNode(env as any, "cx-p1", "release"),
    /Invalid or archived nodes cannot be tagged\./,
  );

  await restoreNode(env as any, "cx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("cx-p1")!.mode, "editable");
  assert.equal(tent.byId.get("cx-p1")!.archived, false);
  assert.equal(isUsableNode(tent.byId.get("cx-p1")!), true);
  assert.equal(tent.byId.get("cx-p2")!.archived, false);
  assert.equal(tent.byId.get("cx-p2")!.invalid, false);
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
  const { archiveNode, deleteArchivedNode } = await import("../src/core/ops.js");
  await assert.rejects(() => deleteArchivedNode(env as any, "cx-p1"), /must be archived/);
  await archiveNode(env as any, "cx-p1");
  await deleteArchivedNode(env as any, "cx-p1");
  assert.equal(await fsa.exists("prompt/表达式任务书"), false);
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.has("cx-p1"), false);
  assert.equal(tent.byId.has("cx-p2"), false);
});

test("CLI rejects removed direct-core commands cleanly", async () => {
  const dir = await makeTent();

  let result = await cli(dir, "new-box", "Extra", "goal", "parent", "ignored");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command: new-box/);

  result = await cli(dir, "tag-new", "release", "ignored");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command: tag-new/);

  result = await cli(dir, "report", "cx-p1", path.join(dir, "missing-report.txt"));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown command: report/);
  assert.doesNotMatch(result.stderr, /\breport <nodeId>/);
});

test("CLI does not expose direct Session or retired Agent lifecycle commands", async () => {
  const dir = await makeTent();

  const help = await cli(dir, "--help");
  const helpText = `${help.stdout}${help.stderr}`;
  assert.doesNotMatch(helpText, /tent session enter\|status\|leave/);
  assert.doesNotMatch(helpText, /tent agent enter\|status\|leave/);

  const sessionHelp = await cli(dir, "session", "--help");
  const sessionHelpText = `${sessionHelp.stdout}${sessionHelp.stderr}`;
  assert.equal(sessionHelp.code, 0, sessionHelp.stderr);
  assert.match(sessionHelpText, /tent session enter/);
  assert.match(sessionHelpText, /tent session status/);
  assert.match(sessionHelpText, /tent session leave/);
  assert.doesNotMatch(sessionHelpText, /tent agent enter/);

  // Direct lifecycle commands are absent; Sessions are exact Task execution facts.
  for (const sub of [
    "enter",
    "status",
    "leave",
    "session-start",
    "session-status",
    "session-end",
  ] as const) {
    const result = await cli(dir, "agent", sub);
    assert.notEqual(result.code, 0, `tent agent ${sub} must be rejected`);
    assert.match(result.stderr, /Unknown command: agent/);
  }
});

test("CLI help is TaskResult-only (no legacy tent report migration track)", async () => {
  const dir = await makeTent();
  const help = await cli(dir, "task", "--help");
  // task help may exit 0 or print usage; accept either channel
  const text = `${help.stdout}\n${help.stderr}`;
  assert.match(text, /task submit|tent task submit/i);
  assert.doesNotMatch(text, /task-ack \/ report \/ complete/);
  assert.doesNotMatch(text, /\breport <nodeId>/);
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
  assert.notEqual(fork.id, "cx-p1");
  assert.equal(fork.fm.owner, undefined);
  assert.equal(fork.fm.status, undefined);
  assert.equal(fork.children[0].name, "草稿", "只改复制根名字");
  assert.notEqual(fork.children[0].id, "cx-p2");
  assert.equal(after.byId.get("cx-p1")?.path, "prompt/表达式任务书");
});

test("无法识别为新复制的重复 id 会显式失效,不会覆盖索引", async () => {
  const dir = await makeTent();
  const duplicate = path.join(dir, "另一个任务");
  await fs.mkdir(duplicate);
  await fs.writeFile(
    path.join(duplicate, "另一个任务.md"),
    "---\nid: cx-p1\ntype: prompt\n---\n",
  );
  const tent = await loadTent(new NodeFs(dir));
  assert.equal(tent.byId.has("cx-p1"), false);
  assert.equal(tent.byPath.get("prompt/表达式任务书")?.invalid, true);
  assert.equal(tent.byPath.get("另一个任务")?.invalid, true);
});

test("duplicate Node id direct operations report duplicate id", async () => {
  const dir = await makeTent();
  const duplicate = path.join(dir, "另一个任务");
  await fs.mkdir(duplicate);
  await fs.writeFile(
    path.join(duplicate, "另一个任务.md"),
    "---\nid: cx-p1\ntype: prompt\n---\n",
  );
  const env = {
    fs: new NodeFs(dir),
    clock: { now: () => "t" },
    tentName: "wqb",
  };
  const { dispatch } = await import("../src/core/ops.js");
  await assert.rejects(
    () => dispatchToRole(env as any, "cx-p1", "analyst", "work"),
    /Duplicate node id 'cx-p1'/i,
  );
  // Domain R/W grant is retired; call rejects before any id resolution
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
  assert.equal(tent.byId.has("cx-p1"), false);
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
  const lockBody = await first.readFile("mutation.lock");
  const parsed = JSON.parse(lockBody) as { ownerToken?: string; pid?: number };
  assert.equal(typeof parsed.ownerToken, "string");
  assert.ok(parsed.ownerToken && parsed.ownerToken.length > 0);
  assert.equal(parsed.pid, process.pid);
  await assert.rejects(
    () => second.withLock!("mutation.lock", async () => undefined),
    /already running another write operation/,
  );
  release();
  await active;
  await second.withLock!("mutation.lock", async () => undefined);
});
