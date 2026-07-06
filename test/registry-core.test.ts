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

test("corrupt tags registry is backed up and rebuilt from box frontmatter before writes", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(path.join(dir, ".tent", "tags.json"), "{not-json", "utf8");
  const notePath = path.join(dir, "prompt", "表达式任务书", "表达式任务书.md");
  const raw = await fs.readFile(notePath, "utf8");
  await fs.writeFile(notePath, raw.replace("type: prompt", "type: prompt\ntags: [legacy, recovered]"));

  const warnings = await captureConsoleError(() => addRegistryTag(fsa, "fresh"));

  assert.match(warnings.join("\n"), /\.tent\/tags\.json was corrupt; backed up to \.tent\/tags\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and recovered\. Review it\./);
  assert.deepEqual((await loadTagRegistry(fsa)).tags, ["fresh", "legacy", "recovered"]);
  assert.equal((await fs.readdir(path.join(dir, ".tent"))).some((name) => name.startsWith("tags.json.corrupt-")), true);
});

test("corrupt order registry is backed up and reset to default order", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(path.join(dir, ".tent", "order.json"), "{not-json", "utf8");

  const warnings = await captureConsoleError(async () => {
    const { createBox } = await import("../src/core/ops.js");
    await createBox({
      fs: fsa,
      clock: { now: () => "t" },
      tentName: "wqb",
    } as any, { parentPath: "", name: "AfterBadOrder", type: "goal" });
  });

  assert.match(warnings.join("\n"), /\.tent\/order\.json was corrupt; backed up to \.tent\/order\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and recovered\. Review it\./);
  assert.equal((await fs.readdir(path.join(dir, ".tent"))).some((name) => name.startsWith("order.json.corrupt-")), true);
  assert.equal((await loadTent(fsa)).byPath.has("AfterBadOrder"), true);
});

test("corrupt roles registry is backed up and reset with an explicit restore warning", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  await fs.mkdir(path.join(dir, ".tent"), { recursive: true });
  await fs.writeFile(path.join(dir, ".tent", "roles.json"), "{not-json", "utf8");

  const warnings = await captureConsoleError(async () => {
    assert.deepEqual(await loadRolesRegistry(fsa), { roles: [] });
  });

  assert.match(warnings.join("\n"), /\.tent\/roles\.json was corrupt; backed up to \.tent\/roles\.json\.corrupt-/);
  assert.match(warnings.join("\n"), /and reset\. Review it\./);
  assert.match(warnings.join("\n"), /IMPORTANT: role definitions cannot be inferred/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, ".tent", "roles.json"), "utf8")), { roles: [] });
  assert.equal((await fs.readdir(path.join(dir, ".tent"))).some((name) => name.startsWith("roles.json.corrupt-")), true);
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
