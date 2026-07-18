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
  normalizeAllowedProfiles,
  normalizeRoleDefinition,
  resolveRole,
  roleA2APolicy,
  roleAllowsProfile,
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

  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-scaffold-empty-"));
  const emptyFs = new NodeFs(emptyDir);
  await scaffoldTent(emptyFs, { name: "empty", rules: "# RULES\n" });
  assert.deepEqual((await loadTent(emptyFs)).roots, []);
  assert.equal(await fsa.exists("temp/temp.md"), false);
  assert.equal(await fsa.readFile("RULES.md"), "# RULES\n\n规则正文\n");
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
    () => scaffoldTent(new NodeFs(invalidDir), { name: "", rules: "# RULES" }),
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

test("role 注册表:可选 cli 宿主配置会校验并保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-cli-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rules: "# RULES\n",
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
    rules: "# RULES\n",
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

test("role 注册表: allowedProfiles trim 去重，只存 id，不存凭据", async () => {
  assert.deepEqual(
    normalizeAllowedProfiles(["  grok-acp-default ", "fake-default", "fake-default", "", "  "]),
    ["grok-acp-default", "fake-default"]
  );
  assert.equal(normalizeAllowedProfiles([]), undefined);
  assert.equal(normalizeAllowedProfiles(undefined), undefined);
  assert.equal(normalizeAllowedProfiles("not-array"), undefined);
  assert.deepEqual(normalizeAllowedProfiles(["ok", 1, null, "ok"]), ["ok"]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-profiles-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, {
    name: "demo",
    rules: "# RULES\n",
    rolesRegistry: {
      roles: [
        {
          name: "orch",
          a2aPolicy: "allow",
          allowedProfiles: ["  grok-acp-default ", "fake-default", "fake-default", ""],
          // credentials-shaped fields must never be part of RoleDefinition persistence
        },
      ],
    },
  });

  const loaded = await loadRolesRegistry(fsa);
  const orch = loaded.roles.find((r) => r.name === "orch");
  assert.deepEqual(orch?.allowedProfiles, ["grok-acp-default", "fake-default"]);
  assert.equal(roleAllowsProfile(orch, "fake-default"), true);
  assert.equal(roleAllowsProfile(orch, "  fake-default  "), true);
  assert.equal(roleAllowsProfile(orch, "other"), false);
  assert.equal(roleAllowsProfile(undefined, "fake-default"), false);

  await createRole(fsa, {
    name: "worker",
    a2aPolicy: "allow",
    allowedProfiles: [" codex-acp ", "codex-acp", " "],
  });
  const worker = (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker");
  assert.deepEqual(worker?.allowedProfiles, ["codex-acp"]);

  await updateRole(fsa, "worker", { allowedProfiles: ["a", " b ", "a"] });
  assert.deepEqual(
    (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker")?.allowedProfiles,
    ["a", "b"]
  );

  // Explicit clear
  await updateRole(fsa, "worker", { allowedProfiles: [] });
  assert.equal(
    (await loadRolesRegistry(fsa)).roles.find((r) => r.name === "worker")?.allowedProfiles,
    undefined
  );

  // Disk: only ids, no secret-looking keys from normalize
  const disk = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<Record<string, unknown>>;
  };
  for (const role of disk.roles) {
    assert.equal("secret" in role, false);
    assert.equal("token" in role, false);
    assert.equal("apiKey" in role, false);
    assert.equal("env" in role, false);
    if (role.allowedProfiles !== undefined) {
      assert.ok(Array.isArray(role.allowedProfiles));
      for (const id of role.allowedProfiles as unknown[]) {
        assert.equal(typeof id, "string");
      }
    }
  }

  // normalizeRoleDefinition drops empty allowedProfiles
  const empty = normalizeRoleDefinition({ name: "x", allowedProfiles: ["", "  "] });
  assert.equal(empty.allowedProfiles, undefined);
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
    allowedProfiles: ["fake-default"],
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
    allowedProfiles: [],
    cli: undefined,
  });

  const cleared = (await loadRolesRegistry(fsa)).roles;
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.name, "clearable");
  assert.equal(cleared[0]!.id, beforeClear!.id);
  assert.equal(cleared[0]!.displayName, "clearable");
  assert.equal(cleared[0]!.prompt, undefined);
  assert.equal(cleared[0]!.cli, undefined);
});

test("role 注册表: 旧数据无 id 时确定性补齐并写回；displayName 可改；id/name 不可改", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-id-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir(".tent");
  // Legacy disk shape: name only
  await fsa.writeFile(
    "roles.json",
    JSON.stringify({ roles: [{ name: "planner", prompt: "plan" }] }, null, 2) + "\n"
  );

  const expectedId = deterministicRoleIdFromName("planner");
  const loaded = await loadRolesRegistry(fsa);
  assert.equal(loaded.roles.length, 1);
  assert.equal(loaded.roles[0]!.id, expectedId);
  assert.equal(loaded.roles[0]!.displayName, "planner");
  assert.ok(isRoleId(loaded.roles[0]!.id));

  // Persisted on first load
  const disk1 = JSON.parse(await fsa.readFile("roles.json")) as {
    roles: Array<{ id: string; name: string; displayName: string }>;
  };
  assert.equal(disk1.roles[0]!.id, expectedId);
  assert.equal(disk1.roles[0]!.displayName, "planner");

  // Stable across reloads
  const loaded2 = await loadRolesRegistry(fsa);
  assert.equal(loaded2.roles[0]!.id, expectedId);

  // Compat resolve: id / name / displayName
  assert.equal(resolveRole(loaded2.roles, expectedId)?.name, "planner");
  assert.equal(resolveRole(loaded2.roles, "planner")?.id, expectedId);

  await updateRole(fsa, expectedId, { displayName: "规划者" });
  const renamed = await loadRolesRegistry(fsa);
  assert.equal(renamed.roles[0]!.id, expectedId);
  assert.equal(renamed.roles[0]!.name, "planner");
  assert.equal(renamed.roles[0]!.displayName, "规划者");
  assert.equal(resolveRole(renamed.roles, "规划者")?.id, expectedId);

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
