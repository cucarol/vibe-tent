import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { canClaim } from "../src/core/claim.js";
import { buildManifest } from "../src/core/manifest.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { loadTypeRegistry } from "../src/core/typeRegistry.js";
import {
  createPrimaryType,
  createSecondaryType,
  deleteCustomType,
  inspectTypeDeletion,
  migrateKindToType,
  updateTypeMetadata,
} from "../src/core/typeManagement.js";
import { makeTent } from "./helpers.js";
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
    /Confirmation mismatch/,
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
    /invalid root/,
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
    /stamp or force-release/,
  );
  await assert.rejects(
    () => deleteCustomType(fsa, "type", "asset", "asset"),
    /Built-in types/,
  );
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
      /Reserved fields/,
    );
  }
  await assert.rejects(
    () => patchBox(env as any, "prompt/旧站资料", { type: undefined }),
    /cannot be cleared/,
  );
  await assert.rejects(
    () => patchBox(env as any, "prompt/旧站资料", { type: "missing" }),
    /Unknown type/,
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
    /already exists/,
  );
  await assert.rejects(
    () => createPrimaryType(fsa, "temp", { readable: true, writable: true }),
    /system pipe/,
  );
  await assert.rejects(
    () => updateTypeMetadata(fsa, "type", "missing", { color: "blue" }),
    /Type does not exist/,
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
  await assert.rejects(() => loadTent(fsa), /types\.json is corrupt/);
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
    /Reserved fields/,
  );
});
