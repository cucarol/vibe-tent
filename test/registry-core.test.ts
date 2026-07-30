import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  BOX_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "../src/core/frontmatter.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import {
  createRole,
  deleteRole,
  loadRolesRegistry,
  normalizeAgentIdList,
  normalizeRoleDefinition,
  resolveRole,
  roleA2APolicy,
  roleAllowsAgent,
  updateRole,
} from "../src/core/skillRoleRegistry.js";
import {
  deterministicRoleIdFromName,
  isRoleId,
} from "../src/core/id.js";
import {
  addRegistryTag,
  addTag,
  findBoxesByTag,
  loadTagRegistry,
  removeRegistryTag,
  removeTag,
  saveTagRegistry,
} from "../src/core/tags.js";
import { makeTent } from "./helpers.js";

test("scaffoldTent:core 生成自包含帐骨架(index,不进 SPEC/CLAUDE/AGENTS)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-scaffold-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
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

  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-scaffold-empty-"));
  const emptyFs = new NodeFs(emptyDir);
  await scaffoldTent(emptyFs, { name: "empty" });
  assert.deepEqual((await loadTent(emptyFs)).roots, []);
  assert.equal(await fsa.exists("temp/temp.md"), false);
  assert.match(await fsa.readFile("index.md"), /type: index/);
  assert.equal(await fsa.exists("SPEC.md"), false);
  assert.equal(await fsa.exists("CLAUDE.md"), false);
  assert.equal(await fsa.exists("AGENTS.md"), false);
  assert.equal(await fsa.exists(".claude"), false);
  assert.equal(await fsa.exists("skills.json"), false);
  assert.equal(await fsa.exists(".tent/skills.json"), false);
  assert.deepEqual((await loadRolesRegistry(fsa)).roles, []);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, []);
  assert.deepEqual(
    JSON.parse(await fsa.readFile("types.json")),
    tent.typeRegistry,
  );
  assert.equal(await fsa.exists(".gitignore"), false, "system-root scaffold 不写 workspace gitignore");

  const invalidDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tent-scaffold-invalid-"),
  );
  await assert.rejects(
    () => scaffoldTent(new NodeFs(invalidDir), { name: "" }),
    /Tent name cannot be empty\./,
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
workspace: "C:\\example\\_code\\Tent"
---
# Workspace
`;

  for (let i = 0; i < 3; i++) {
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.data.workspace, String.raw`C:\example\_code\Tent`);
    raw = serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder);
  }

  assert.match(raw, /workspace: "C:\\\\example\\\\_code\\\\Tent"/);
  assert.doesNotMatch(raw, /workspace: "C:\\\\\\\\example/);
});

test("frontmatter round-trip: nested multiline and control strings are always quoted", () => {
  const objective = "第一行\n第二行\t继续\r第三行";
  const raw = serializeFrontmatter(
    {
      type: "task",
      contextCard: {
        schemaVersion: "v1",
        objective,
        acceptance: [objective],
      },
    },
    "# Task\n"
  );

  const frontmatter = raw.slice(0, raw.indexOf("\n---\n", 4));
  assert.doesNotMatch(frontmatter, /\n第二行/);
  assert.match(frontmatter, /objective: "第一行\\n第二行\\t继续\\r第三行"/);
  const parsed = parseFrontmatter(raw);
  const card = parsed.data.contextCard as {
    objective: string;
    acceptance: string[];
  };
  assert.equal(card.objective, objective);
  assert.deepEqual(card.acceptance, [objective]);
});

test("frontmatter parse: recovers historical multiline flow collections", () => {
  const fixtures = [
    {
      raw: `---
type: task
contextCard: {schemaVersion: v1, objective: 第一行

第二行
第三行, frozenDecisions: [], scope: {include: [], exclude: []}, acceptance: [第一行

第二行
第三行], refs: {nodes: [{id: cx-one, path: 节点一}], tasks: [], deliveries: [], git: []}}
state: queued
---
# Task
`,
      objective: "第一行\n\n第二行\n第三行",
      nodeId: "cx-one",
    },
    {
      raw: `---
type: task
contextCard: {schemaVersion: v1, objective: 先读取项目说明

文件边界只允许核心解析器

目标
1. 保留已有事实
2. 使用正式生命周期, frozenDecisions: [], scope: {include: [], exclude: []}, acceptance: [先读取项目说明

文件边界只允许核心解析器

目标
1. 保留已有事实
2. 使用正式生命周期], refs: {nodes: [{id: cx-a, path: 节点甲}, {id: cx-b, path: 节点乙}], tasks: [], deliveries: [], git: []}}
state: queued
---
# Task
`,
      objective:
        "先读取项目说明\n\n文件边界只允许核心解析器\n\n目标\n1. 保留已有事实\n2. 使用正式生命周期",
      nodeId: "cx-b",
    },
  ];

  for (const fixture of fixtures) {
    const parsed = parseFrontmatter(fixture.raw);
    const card = parsed.data.contextCard as {
      objective: string;
      acceptance: string[];
      refs: { nodes: Array<{ id: string }> };
    };
    assert.equal(card.objective, fixture.objective);
    assert.deepEqual(card.acceptance, [fixture.objective]);
    assert.ok(card.refs.nodes.some((node) => node.id === fixture.nodeId));
    assert.equal(parsed.data.state, "queued");
    assert.equal(parsed.body, "# Task\n");
  }
});

test("frontmatter parse: malformed multiline flow recovery cannot consume the next top-level key", () => {
  assert.throws(
    () =>
      parseFrontmatter(`---
type: task
contextCard: {schemaVersion: v1, objective: 没有闭合
state: queued
---
# Task
`),
    /unterminated multiline flow collection/
  );
});

test("frontmatter round-trip:Obsidian block sequences are preserved as arrays", () => {
  const raw = String.raw`---
id: bx-paths
type: output
paths:
  - test/a.ts
  - "C:\\example\\_code\\Tent\\src\\core\\frontmatter.ts"
custom: keep-me
---
# Paths
`;
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.paths, [
    "test/a.ts",
    String.raw`C:\example\_code\Tent\src\core\frontmatter.ts`,
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
workspace: "C:\\\\example\\\\_code\\\\Tent"
---
`);
  assert.equal(parsed.data.workspace, String.raw`C:\example\_code\Tent`);
});

test("tags 注册表:自动登记、摘除、级联剥离与检索", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);

  await saveTagRegistry(fsa, { tags: ["zeta", "backend-hardening", "backend-hardening"] });
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["backend-hardening", "zeta"]);

  await addRegistryTag(fsa, "alpha");
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["alpha", "backend-hardening", "zeta"]);
  await assert.rejects(() => addRegistryTag(fsa, "bad/name"), /path separators/);

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
  assert.throws(() => findBoxesByTag(tent, "bad\ntag"), /Tag name cannot contain path separators or newlines\./);
  assert.equal(tent.byId.get("bx-o1")?.tags.length, 0);
  const raw = await fs.readFile(path.join(dir, "output", "alpha仓库指针", "alpha仓库指针.md"), "utf8");
  assert.doesNotMatch(raw, /^tags:/m);
});

test("patchBox tags: auto-registers new tags; node remove keeps registry candidates", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const { patchBox } = await import("../src/core/ops.js");
  const env = { fs: fsa, clock: { now: () => "t" }, tentName: "wqb" } as const;

  // New tag via frontmatter patch must appear in tags.json pick-list.
  await patchBox(env as any, "prompt/表达式任务书", { tags: ["from-patch"] });
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["from-patch"]);
  let tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("bx-p1")?.tags, ["from-patch"]);

  // Shared tag on second node; first node drops tags — registry still keeps both.
  await patchBox(env as any, "output/alpha仓库指针", { tags: ["from-patch", "shared"] });
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["from-patch", "shared"]);
  await patchBox(env as any, "prompt/表达式任务书", { tags: [] });
  tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("bx-p1")?.tags, []);
  assert.deepEqual(tent.byId.get("bx-o1")?.tags, ["from-patch", "shared"]);
  assert.deepEqual(
    (await loadTagRegistry(fsa)).tags,
    ["from-patch", "shared"],
    "removing tags from a node must not prune tags.json",
  );

  // Last node also clears tags — still retain registry candidates for reuse.
  await addRegistryTag(fsa, "registry-only");
  await patchBox(env as any, "output/alpha仓库指针", { tags: [] });
  tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("bx-o1")?.tags, []);
  assert.deepEqual(
    (await loadTagRegistry(fsa)).tags,
    ["from-patch", "registry-only", "shared"],
    "orphan node tags stay in pick-list until removeRegistryTag",
  );

  // Explicit registry delete is the only path that drops candidates (+ cascade).
  await removeRegistryTag(fsa, "from-patch");
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["registry-only", "shared"]);
});

test("role 注册表:core 创建修改删除与 scaffold 模板写入", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-registry-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    // Custom secondary may be present; V0.2 normalize strips R/W/color chrome to tier only
    typeRegistry: {
      goal: { tier: "base" },
      prompt: { tier: "base" },
      output: { tier: "base" },
      reference: { tier: "modifier" },
      asset: { tier: "modifier" },
      task: { tier: "modifier" },
    },
    rolesRegistry: {
      roles: [
        {
          name: "analyst",
          prompt: "分析问题并给出计划",
        },
      ],
    },
  });
  // loadTent normalizes to slim tier-only defs (no color / R/W axes)
  assert.deepEqual((await loadTent(fsa)).typeRegistry.task, { tier: "modifier" });
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

test("role 注册表:可选 cli 宿主配置会校验并保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-cli-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rolesRegistry: {
      roles: [
        {
          name: "planner",
          cli: { command: "codex --ask-for-approval never", resume: "codex resume latest" },
        },
      ],
    },
  });

  assert.deepEqual((await loadRolesRegistry(fsa)).roles[0].cli, {
    command: "codex --ask-for-approval never",
    resume: "codex resume latest",
  });

  await updateRole(fsa, "planner", { description: "规划者" });
  assert.deepEqual((await loadRolesRegistry(fsa)).roles[0].cli, {
    command: "codex --ask-for-approval never",
    resume: "codex resume latest",
  });

  await createRole(fsa, {
    name: "executor",
    cli: { command: "claude" },
  });
  assert.deepEqual((await loadRolesRegistry(fsa)).roles.find((role) => role.name === "executor")?.cli, {
    command: "claude",
  });

  await assert.rejects(
    () => createRole(fsa, { name: "broken", cli: { command: "" } }),
    /cli\.command/,
  );
});

test("role 注册表: a2aPolicy allow|ask|deny 默认为 deny，不存 secret", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-a2a-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rolesRegistry: {
      roles: [
        { name: "plain" },
        { name: "orch", a2aPolicy: "allow" },
        { name: "gate", a2aPolicy: "ask" },
        { name: "blocked", a2aPolicy: "deny" },
      ],
    },
  });
  const roles = await loadRolesRegistry(fsa);
  assert.equal(roleA2APolicy(roles.roles.find((r) => r.name === "plain")), "deny");
  assert.equal(roles.roles.find((r) => r.name === "plain")?.a2aPolicy, undefined);
  assert.equal(roles.roles.find((r) => r.name === "orch")?.a2aPolicy, "allow");
  assert.equal(roles.roles.find((r) => r.name === "gate")?.a2aPolicy, "ask");
  assert.equal(roles.roles.find((r) => r.name === "blocked")?.a2aPolicy, "deny");

  await createRole(fsa, { name: "worker", a2aPolicy: "ask" });
  assert.equal((await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker")?.a2aPolicy, "ask");
  await updateRole(fsa, "worker", { a2aPolicy: "allow" });
  assert.equal((await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker")?.a2aPolicy, "allow");

  // Invalid policy ignored (effective deny); registry still loads.
  await fsa.writeFile(
    "roles.json",
    JSON.stringify({ roles: [{ name: "bad", a2aPolicy: "yolo" }] }, null, 2) + "\n"
  );
  const bad = await loadRolesRegistry(fsa);
  assert.equal(bad.roles[0].name, "bad");
  assert.equal(bad.roles[0].a2aPolicy, undefined);
  assert.equal(roleA2APolicy(bad.roles[0]), "deny");
});

test("role 注册表: roster trim 去重，只存 agentId；disk allowedProfiles 只作迁移输入", async () => {
  assert.deepEqual(
    normalizeAgentIdList(["  grok-acp-default ", "fake-default", "fake-default", "", "  "]),
    ["grok-acp-default", "fake-default"]
  );
  assert.equal(normalizeAgentIdList([]), undefined);
  assert.equal(normalizeAgentIdList(undefined), undefined);
  assert.equal(normalizeAgentIdList("not-array"), undefined);
  assert.deepEqual(normalizeAgentIdList(["ok", 1, null, "ok"]), ["ok"]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-profiles-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rolesRegistry: {
      roles: [
        {
          name: "orch",
          a2aPolicy: "allow",
          // Legacy disk key — normalize projects to roster only.
          allowedProfiles: ["  grok-acp-default ", "fake-default", "fake-default", ""],
        } as { name: string; a2aPolicy: "allow"; allowedProfiles: string[] },
      ],
    },
  });

  const loaded = await loadRolesRegistry(fsa);
  const orch = loaded.roles.find((r) => r.name === "orch");
  assert.deepEqual(orch?.roster, ["grok-acp-default", "fake-default"]);
  assert.equal(Object.prototype.hasOwnProperty.call(orch ?? {}, "allowedProfiles"), false);
  assert.equal(roleAllowsAgent(orch, "fake-default"), true);
  assert.equal(roleAllowsAgent(orch, "  fake-default  "), true);
  assert.equal(roleAllowsAgent(orch, "other"), false);
  assert.equal(roleAllowsAgent(undefined, "fake-default"), false);

  await createRole(fsa, {
    name: "worker",
    a2aPolicy: "allow",
    roster: [" codex-acp ", "codex-acp", " "],
  });
  const worker = (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker");
  assert.deepEqual(worker?.roster, ["codex-acp"]);

  await updateRole(fsa, "worker", { roster: ["a", " b ", "a"] });
  assert.deepEqual(
    (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker")?.roster,
    ["a", "b"]
  );

  await updateRole(fsa, "worker", { roster: [] });
  assert.equal(
    (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker")?.roster,
    undefined
  );

  // Mutations reject allowedProfiles fail-loud.
  await assert.rejects(
    () => createRole(fsa, { name: "bad", allowedProfiles: ["x"] } as never),
    /no longer accept allowedProfiles|use roster/i
  );
  await assert.rejects(
    () => updateRole(fsa, "worker", { allowedProfiles: ["x"] } as never),
    /no longer accept allowedProfiles|use roster/i
  );

  const disk = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<Record<string, unknown>>;
  };
  for (const role of disk.roles) {
    assert.equal("secret" in role, false);
    assert.equal("token" in role, false);
    assert.equal("apiKey" in role, false);
    assert.equal("env" in role, false);
    assert.equal("allowedProfiles" in role, false);
    if (role.roster !== undefined) {
      assert.ok(Array.isArray(role.roster));
      for (const id of role.roster as unknown[]) {
        assert.equal(typeof id, "string");
      }
    }
  }

  const empty = normalizeRoleDefinition({
    name: "x",
    allowedProfiles: ["", "  "],
  } as never);
  assert.equal(empty.roster, undefined);
});

test("role 注册表: updateRole 可明确清除全部可选字段", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-clear-"));
  const fsa = new NodeFs(dir);
  await createRole(fsa, {
    name: "clearable",
    prompt: "prompt",
    description: "description",
    color: "red",
    a2aPolicy: "allow",
    roster: ["fake-default"],
    cli: { command: "codex" },
  });

  const beforeClear = (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "clearable");
  assert.ok(beforeClear);
  assert.ok(isRoleId(beforeClear!.id));

  await updateRole(fsa, "clearable", {
    prompt: undefined,
    description: undefined,
    color: undefined,
    a2aPolicy: undefined,
    roster: [],
    cli: undefined,
  });

  const cleared = (await loadRolesRegistry(fsa)).roles;
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.name, "clearable");
  assert.equal(cleared[0]!.id, beforeClear!.id);
  assert.equal(cleared[0]!.displayName, "clearable");
  assert.equal(cleared[0]!.prompt, undefined);
  assert.equal(cleared[0]!.cli, undefined);
  assert.equal(cleared[0]!.roster, undefined);
});

test("role 注册表: 旧数据无 id 时内存确定性补齐；load 不写盘；displayName 可改；id/name 不可改", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-id-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir(".tent");
  // Legacy disk shape: name only
  const legacyDisk = JSON.stringify({ roles: [{ name: "planner", prompt: "plan" }] }, null, 2) + "\n";
  await fsa.writeFile("roles.json", legacyDisk);

  const expectedId = deterministicRoleIdFromName("planner");
  const loaded = await loadRolesRegistry(fsa);
  assert.equal(loaded.roles.length, 1);
  assert.equal(loaded.roles[0]!.id, expectedId);
  assert.equal(loaded.roles[0]!.displayName, "planner");
  assert.ok(isRoleId(loaded.roles[0]!.id));

  // Plain load must not persist backfill
  assert.equal(await fsa.readFile("roles.json"), legacyDisk);

  // Stable across reloads (still in-memory only until mutation)
  const loaded2 = await loadRolesRegistry(fsa);
  assert.equal(loaded2.roles[0]!.id, expectedId);
  assert.equal(await fsa.readFile("roles.json"), legacyDisk);

  // Compat resolve: id / operational name only — never displayName
  assert.equal(resolveRole(loaded2.roles, expectedId)?.name, "planner");
  assert.equal(resolveRole(loaded2.roles, "planner")?.id, expectedId);

  // Explicit mutation persists filled identity fields
  await updateRole(fsa, expectedId, { displayName: "规划者" });
  const renamed = await loadRolesRegistry(fsa);
  assert.equal(renamed.roles[0]!.id, expectedId);
  assert.equal(renamed.roles[0]!.name, "planner");
  assert.equal(renamed.roles[0]!.displayName, "规划者");
  // displayName is not a resolver key
  assert.equal(resolveRole(renamed.roles, "规划者"), undefined);

  const diskAfterMutation = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<{ id: string; name: string; displayName: string }>;
  };
  assert.equal(diskAfterMutation.roles[0]!.id, expectedId);
  assert.equal(diskAfterMutation.roles[0]!.displayName, "规划者");

  await assert.rejects(
    () => updateRole(fsa, "planner", { name: "planner-v2" }),
    /cannot be renamed|displayName/i
  );
  await assert.rejects(
    () => updateRole(fsa, "planner", { id: "rl-hacked" }),
    /immutable/i
  );

  // New create gets a random rl- (not forced equal to deterministic name hash)
  await createRole(fsa, { name: "worker" }, () => 0.42);
  const worker = (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker");
  assert.ok(worker);
  assert.ok(isRoleId(worker!.id));
  assert.equal(worker!.displayName, "worker");
  assert.notEqual(worker!.id, deterministicRoleIdFromName("worker"));

  // normalizeRoleDefinition fills missing fields without requiring callers to pass id
  const normalized = normalizeRoleDefinition({ name: "x" });
  assert.equal(normalized.id, deterministicRoleIdFromName("x"));
  assert.equal(normalized.displayName, "x");
});

test("role 注册表: 重复 displayName 无歧义；displayName 永不解析身份", async () => {
  const roles = [
    normalizeRoleDefinition({
      id: "rl-aaaaaa",
      name: "alpha",
      displayName: "Shared Label",
    }),
    normalizeRoleDefinition({
      id: "rl-bbbbbb",
      name: "beta",
      displayName: "Shared Label",
    }),
  ];

  assert.equal(resolveRole(roles, "rl-aaaaaa")?.name, "alpha");
  assert.equal(resolveRole(roles, "rl-bbbbbb")?.name, "beta");
  assert.equal(resolveRole(roles, "alpha")?.id, "rl-aaaaaa");
  assert.equal(resolveRole(roles, "beta")?.id, "rl-bbbbbb");
  // Same presentation label on two roles must not resolve either
  assert.equal(resolveRole(roles, "Shared Label"), undefined);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-dup-dn-"));
  const fsa = new NodeFs(dir);
  await createRole(fsa, {
    id: "rl-cccccc",
    name: "gamma",
    displayName: "Twin",
  });
  await createRole(fsa, {
    id: "rl-dddddd",
    name: "delta",
    displayName: "Twin",
  });
  const loaded = await loadRolesRegistry(fsa);
  assert.equal(loaded.roles.filter((r) => r.displayName === "Twin").length, 2);
  assert.equal(resolveRole(loaded.roles, "Twin"), undefined);
  assert.equal(resolveRole(loaded.roles, "gamma")?.displayName, "Twin");
  assert.equal(resolveRole(loaded.roles, "delta")?.displayName, "Twin");
});

test("role 注册表: plain loadRolesRegistry 对缺 id 的 legacy 行不写盘", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-nowrite-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir(".tent");
  const legacy =
    JSON.stringify(
      {
        roles: [
          { name: "a", prompt: "A" },
          { name: "b", displayName: "Bee" },
        ],
      },
      null,
      2
    ) + "\n";
  await fsa.writeFile("roles.json", legacy);

  let writeCount = 0;
  const originalWrite = fsa.writeFile.bind(fsa);
  fsa.writeFile = async (p, content) => {
    writeCount += 1;
    return originalWrite(p, content);
  };

  try {
    const loaded = await loadRolesRegistry(fsa);
    assert.equal(loaded.roles.length, 2);
    assert.equal(loaded.roles[0]!.id, deterministicRoleIdFromName("a"));
    assert.equal(loaded.roles[1]!.id, deterministicRoleIdFromName("b"));
    assert.equal(loaded.roles[1]!.displayName, "Bee");
    assert.equal(writeCount, 0, "loadRolesRegistry must not write during ordinary read");
  } finally {
    fsa.writeFile = originalWrite;
  }
  assert.equal(await fsa.readFile("roles.json"), legacy);
});

test("corrupt tags registry is backed up and rebuilt from box frontmatter before writes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  // system root is flat: registries live at tags.json (not nested .tent/)
  await fs.writeFile(path.join(dir, "tags.json"), "{not-json", "utf8");
  const notePath = path.join(dir, "prompt", "表达式任务书", "表达式任务书.md");
  const raw = await fs.readFile(notePath, "utf8");
  await fs.writeFile(notePath, raw.replace("type: prompt", "type: prompt\ntags: [legacy, recovered]"));

  const warnings = await captureConsoleError(() => addRegistryTag(fsa, "fresh"));

  assert.match(warnings.join("\n"), /tags\.json was corrupt; backed up to tags\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and recovered\. Review it\./);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["fresh", "legacy", "recovered"]);
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("tags.json.corrupt-")), true);
});

test("corrupt order registry is backed up and reset to default order", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.writeFile(path.join(dir, "order.json"), "{not-json", "utf8");

  const warnings = await captureConsoleError(async () => {
    const { createBox } = await import("../src/core/ops.js");
    await createBox({
      fs: fsa,
      clock: { now: () => "t" },
      tentName: "wqb",
    } as any, { parentPath: "", name: "AfterBadOrder", type: "goal" });
  });

  assert.match(warnings.join("\n"), /order\.json was corrupt; backed up to order\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and recovered\. Review it\./);
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("order.json.corrupt-")), true);
  assert.equal((await loadTent(fsa)).byPath.has("AfterBadOrder"), true);
});

test("corrupt roles registry is backed up and reset with an explicit restore warning", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.writeFile(path.join(dir, "roles.json"), "{not-json", "utf8");

  const warnings = await captureConsoleError(async () => {
    assert.deepEqual(await loadRolesRegistry(fsa), { roles: [] });
  });

  assert.match(warnings.join("\n"), /roles\.json was corrupt; backed up to roles\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and reset\. Review it\./);
  assert.match(warnings.join("\n"), /IMPORTANT: role definitions cannot be inferred/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "roles.json"), "utf8")), { roles: [] });
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("roles.json.corrupt-")), true);
});

async function captureConsoleError(action: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    await action();
  } finally {
    console.error = original;
  }
  return messages;
}
