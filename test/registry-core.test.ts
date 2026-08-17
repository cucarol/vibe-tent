import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import {
  NODE_FRONTMATTER_KEY_ORDER,
  parseFrontmatter,
  serializeFrontmatter,
} from "../src/core/frontmatter.js";
import { scaffoldTent } from "../src/core/scaffold.js";
import {
  createRole,
  deleteRole,
  loadRolesRegistry,
  normalizeRoleDefinition,
  resolveRole,
  updateRole,
} from "../src/core/skillRoleRegistry.js";
import {
  deterministicRoleIdFromName,
  isRoleId,
} from "../src/core/id.js";
import {
  addRegistryTag,
  addTag,
  findNodesByTag,
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
    nodes: [
      { name: "aim", type: "goal", body: "# demo · aim" },
      { name: "out", type: "output-asset" },
    ],
  });

  const tent = await loadTent(fsa);
  assert.deepEqual(
    tent.roots.map((box) => box.path).sort(),
    ["aim", "out"],
  );
  assert.match(await fsa.readFile("aim/aim.md"), /# demo · aim/);
  assert.match(await fsa.readFile("out/out.md"), /type: output-asset/);

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
  assert.equal(await fsa.exists("types.json"), false);
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
      id: "cx-tagged",
      type: "reference",
      tags: ["backend-hardening", "needs,quote"],
      owner: "reviewer",
    },
    body,
    NODE_FRONTMATTER_KEY_ORDER,
  );

  assert.match(raw, /type: reference\ntags: \[backend-hardening, "needs,quote"\]\nowner: reviewer/);
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.data.tags, ["backend-hardening", "needs,quote"]);
  assert.equal(parsed.data.owner, "reviewer");
  assert.equal(parsed.body, body);
});

test("frontmatter round-trip:quoted Windows path does not double escape", () => {
  let raw = String.raw`---
id: cx-path
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

test("frontmatter parse: incomplete flow mapping fails loud on the first line", () => {
  assert.throws(
    () =>
      parseFrontmatter(`---
type: task
contextCard: {schemaVersion: v1, objective: 没有闭合
state: queued
---
# Task
`),
    /unterminated flow mapping/
  );
});

test("frontmatter parse: incomplete flow array fails loud on the first line", () => {
  assert.throws(
    () =>
      parseFrontmatter(`---
type: task
commits: [abc123
state: queued
---
# Task
`),
    /unterminated flow array/
  );
});

test("frontmatter round-trip:Obsidian block sequences are preserved as arrays", () => {
  const raw = String.raw`---
id: cx-paths
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
id: cx-damaged
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

  await addTag(fsa, "cx-p1", "backend-hardening");
  await addTag(fsa, "cx-o1", "backend-hardening");
  await addTag(fsa, "cx-o1", "backend-hardening");
  let tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("cx-o1")?.tags, ["backend-hardening"]);
  assert.deepEqual(
    findNodesByTag(tent, "backend-hardening").map((box) => box.id),
    ["cx-o1", "cx-p1"],
  );

  await removeTag(fsa, "cx-p1", "backend-hardening");
  tent = await loadTent(fsa);
  assert.deepEqual(findNodesByTag(tent, "backend-hardening").map((box) => box.id), ["cx-o1"]);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["alpha", "backend-hardening", "zeta"]);

  await removeRegistryTag(fsa, "backend-hardening");
  tent = await loadTent(fsa);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["alpha", "zeta"]);
  assert.deepEqual(findNodesByTag(tent, "backend-hardening"), []);
  assert.throws(() => findNodesByTag(tent, "bad\ntag"), /Tag name cannot contain path separators or newlines\./);
  assert.equal(tent.byId.get("cx-o1")?.tags.length, 0);
  const raw = await fs.readFile(path.join(dir, "output", "alpha仓库指针", "alpha仓库指针.md"), "utf8");
  assert.doesNotMatch(raw, /^tags:/m);
});

test("patchNode tags: auto-registers new tags; node remove keeps registry candidates", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const { patchNode } = await import("../src/core/ops.js");
  const env = { fs: fsa, clock: { now: () => "t" }, tentName: "wqb" } as const;

  // New tag via frontmatter patch must appear in tags.json pick-list.
  await patchNode(env as any, "prompt/表达式任务书", { tags: ["from-patch"] });
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["from-patch"]);
  let tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("cx-p1")?.tags, ["from-patch"]);

  // Shared tag on second node; first node drops tags — registry still keeps both.
  await patchNode(env as any, "output/alpha仓库指针", { tags: ["from-patch", "shared"] });
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["from-patch", "shared"]);
  await patchNode(env as any, "prompt/表达式任务书", { tags: [] });
  tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("cx-p1")?.tags, []);
  assert.deepEqual(tent.byId.get("cx-o1")?.tags, ["from-patch", "shared"]);
  assert.deepEqual(
    (await loadTagRegistry(fsa)).tags,
    ["from-patch", "shared"],
    "removing tags from a node must not prune tags.json",
  );

  // Last node also clears tags — still retain registry candidates for reuse.
  await addRegistryTag(fsa, "registry-only");
  await patchNode(env as any, "output/alpha仓库指针", { tags: [] });
  tent = await loadTent(fsa);
  assert.deepEqual(tent.byId.get("cx-o1")?.tags, []);
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
    rolesRegistry: {
      roles: [
        {
          id: "rl-analyst",
          name: "analyst",
          prompt: "分析问题并给出计划",
        },
      ],
    },
  });
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


test("role registry drops retired routing authorization fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-retired-route-"));
  const fsa = new NodeFs(dir);
  await fsa.writeFile(
    "roles.json",
    JSON.stringify({
      roles: [{
        id: "rl-orchestrator",
        name: "orchestrator",
        prompt: "coordinate",
        a2aPolicy: "allow",
        roster: ["worker-a"],
        allowedProfiles: ["fake-default"],
        cli: { command: "retired" },
      }],
    }, null, 2) + "\n"
  );

  const role = (await loadRolesRegistry(fsa)).roles[0]!;
  assert.equal(role.name, "orchestrator");
  assert.equal(Object.prototype.hasOwnProperty.call(role, "a2aPolicy"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(role, "roster"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(role, "allowedProfiles"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(role, "cli"), false);

  await updateRole(fsa, "orchestrator", { description: "durable coordinator" });
  const disk = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<Record<string, unknown>>;
  };
  assert.equal("a2aPolicy" in disk.roles[0]!, false);
  assert.equal("roster" in disk.roles[0]!, false);
  assert.equal("allowedProfiles" in disk.roles[0]!, false);
  assert.equal("cli" in disk.roles[0]!, false);
});

test("role 注册表: updateRole 可明确清除全部可选字段", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-clear-"));
  const fsa = new NodeFs(dir);
  await createRole(fsa, {
    name: "clearable",
    prompt: "prompt",
    description: "description",
    color: "red",
  });

  const beforeClear = (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "clearable");
  assert.ok(beforeClear);
  assert.ok(isRoleId(beforeClear!.id));

  await updateRole(fsa, "clearable", {
    prompt: undefined,
    description: undefined,
    color: undefined,
  });

  const cleared = (await loadRolesRegistry(fsa)).roles;
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.name, "clearable");
  assert.equal(cleared[0]!.id, beforeClear!.id);
  assert.equal(cleared[0]!.displayName, "clearable");
  assert.equal(cleared[0]!.prompt, undefined);
});

test("role 注册表: canonical rows load strict; createRole still generates ids; resolve/update remain exact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-id-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir(".tent");
  const canonicalDisk =
    JSON.stringify(
      {
        roles: [{
          id: "rl-planner",
          name: "planner",
          prompt: "plan",
        }],
      },
      null,
      2
    ) + "\n";
  await fsa.writeFile("roles.json", canonicalDisk);

  const loaded = await loadRolesRegistry(fsa);
  assert.equal(loaded.roles.length, 1);
  assert.equal(loaded.roles[0]!.id, "rl-planner");
  assert.equal(loaded.roles[0]!.displayName, "planner");
  assert.ok(isRoleId(loaded.roles[0]!.id));

  assert.equal(await fsa.readFile("roles.json"), canonicalDisk);
  const loaded2 = await loadRolesRegistry(fsa);
  assert.equal(loaded2.roles[0]!.id, "rl-planner");
  assert.equal(await fsa.readFile("roles.json"), canonicalDisk);

  assert.equal(resolveRole(loaded2.roles, "rl-planner")?.name, "planner");
  assert.equal(resolveRole(loaded2.roles, "planner")?.id, "rl-planner");

  await updateRole(fsa, "rl-planner", { displayName: "规划者" });
  const renamed = await loadRolesRegistry(fsa);
  assert.equal(renamed.roles[0]!.id, "rl-planner");
  assert.equal(renamed.roles[0]!.name, "planner");
  assert.equal(renamed.roles[0]!.displayName, "规划者");
  assert.equal(resolveRole(renamed.roles, "规划者"), undefined);

  const diskAfterMutation = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<{ id: string; name: string; displayName: string }>;
  };
  assert.equal(diskAfterMutation.roles[0]!.id, "rl-planner");
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

test("role 注册表: missing id fails loud and leaves bytes untouched", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-nowrite-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir(".tent");
  const legacy =
    JSON.stringify(
      {
        roles: [
          { name: "a", prompt: "A" },
          { id: "rl-bee", name: "b", displayName: "Bee" },
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
    await assert.rejects(
      () => loadRolesRegistry(fsa),
      /canonical role id/i
    );
    assert.equal(writeCount, 0, "loadRolesRegistry must not write during ordinary read");
  } finally {
    fsa.writeFile = originalWrite;
  }
  assert.equal(await fsa.readFile("roles.json"), legacy);
});

test("role 注册表: malformed root and strict row violations fail loud without rewriting bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-strict-"));
  const fsa = new NodeFs(dir);

  const badRoot = JSON.stringify({ nope: [] }, null, 2) + "\n";
  await fsa.writeFile("roles.json", badRoot);
  await assert.rejects(
    () => loadRolesRegistry(fsa),
    /roles must be an array/i
  );
  assert.equal(await fsa.readFile("roles.json"), badRoot);

  const cases: Array<{
    label: string;
    registry: unknown;
    pattern: RegExp;
  }> = [
    {
      label: "non-object row",
      registry: { roles: ["bad-row"] },
      pattern: /each role must be an object/i,
    },
    {
      label: "invalid id",
      registry: { roles: [{ id: "bad", name: "alpha" }] },
      pattern: /canonical role id/i,
    },
    {
      label: "missing name",
      registry: { roles: [{ id: "rl-alpha" }] },
      pattern: /non-empty name/i,
    },
    {
      label: "empty name",
      registry: { roles: [{ id: "rl-alpha", name: "   " }] },
      pattern: /non-empty name/i,
    },
    {
      label: "duplicate name",
      registry: {
        roles: [
          { id: "rl-alpha", name: "alpha" },
          { id: "rl-beta", name: "alpha" },
        ],
      },
      pattern: /duplicate role name alpha/i,
    },
    {
      label: "duplicate id",
      registry: {
        roles: [
          { id: "rl-alpha", name: "alpha" },
          { id: "rl-alpha", name: "beta" },
        ],
      },
      pattern: /duplicate role id rl-alpha/i,
    },
  ];

  for (const { label, registry, pattern } of cases) {
    const raw = JSON.stringify(registry, null, 2) + "\n";
    await fsa.writeFile("roles.json", raw);
    await assert.rejects(
      () => loadRolesRegistry(fsa),
      pattern,
      label
    );
    assert.equal(await fsa.readFile("roles.json"), raw, `${label}: bytes must stay untouched`);
  }
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
    const { createNode } = await import("../src/core/ops.js");
    await createNode({
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

test("corrupt roles registry fails loud and preserves exact bytes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.writeFile(path.join(dir, "roles.json"), "{not-json", "utf8");

  const warnings = await captureConsoleError(async () => {
    await assert.rejects(
      () => loadRolesRegistry(fsa),
      /Unexpected token|JSON/i
    );
  });

  assert.deepEqual(warnings, []);
  assert.equal(await fs.readFile(path.join(dir, "roles.json"), "utf8"), "{not-json");
  assert.equal((await fs.readdir(dir)).some((name) => name.startsWith("roles.json.corrupt-")), false);
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
