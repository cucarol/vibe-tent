import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { promoteConcept } from "../src/core/concept.js";
import {
  IMPORT_STAGING_DIR_PREFIX,
  importExternalTentRoot,
  isLegacyTentRoot,
  migrateLegacySchema,
  planIdRemap,
  rewriteOutputType,
} from "../src/core/migration.js";
import { scaffoldInWorkspace, scaffoldTent } from "../src/core/scaffold.js";
import { makeConceptId, isConceptId, isLegacyBoxId } from "../src/core/id.js";
import { typeHasCoordination } from "../src/core/typeRegistry.js";
import { createBox } from "../src/core/ops.js";
import { configureTestGitIdentity, git } from "./helpers.js";

test("id:新 handle 为 cx- 前缀", () => {
  const id = makeConceptId(() => 0.1);
  assert.equal(isConceptId(id), true);
  assert.equal(isLegacyBoxId(id), false);
  assert.match(id, /^cx-/);
});

test("scaffoldInWorkspace:写 <workspace>/.tent 且 gitignore 忽略系统目录", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "demo",
    rules: "# RULES\n\nbody\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  assert.equal(await fsa.exists(".tent/RULES.md"), true);
  assert.equal(await fsa.exists(".tent/types.json"), true);
  assert.equal(await fsa.exists(".tent/temp"), true);
  assert.equal(await fsa.exists(".tent/attachments"), true);
  assert.equal(await fsa.exists(".tent/inbox/inbox.md"), true);
  const gitignore = await fsa.readFile(".gitignore");
  assert.match(gitignore, /\.tent\//);
  const note = await fsa.readFile(".tent/inbox/inbox.md");
  assert.match(note, /id: cx-/);
  assert.match(note, /type: note/);
});

test("loadTent:temp 与 operational 不进 concept 索引", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-op-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  await fsa.mkdir("temp/role/tasks");
  await fsa.writeFile(
    "temp/role/tasks/task.md",
    "---\ntype: task\nrole: role\nclaims: [cx-a]\nmanifest: m\n---\n",
  );
  await fsa.mkdir("note");
  await fsa.writeFile("note/note.md", "---\nid: cx-note1\ntype: note\n---\n# n\n");
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.has("cx-note1"), true);
  assert.equal(tent.byPath.has("temp"), false);
  assert.equal(tent.byPath.has("temp/role"), false);
  assert.equal(tent.roots.every((r) => r.path !== "temp"), true);
});

test("promoteConcept:原地 note→goal，保留 cx- 与路径", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-promote-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = { fs: fsa, clock: { now: () => "t" }, tentName: "x", rand: () => 0.2 };
  const id = await createBox(env as any, { parentPath: "", name: "idea", type: "note" });
  assert.match(id, /^cx-/);
  const before = await loadTent(fsa);
  assert.equal(before.byId.get(id)!.coordination, false);

  const result = await promoteConcept(env as any, id, "goal");
  assert.equal(result.id, id);
  assert.equal(result.path, "idea");
  assert.equal(result.toType, "goal");

  const after = await loadTent(fsa);
  const box = after.byId.get(id)!;
  assert.equal(box.path, "idea");
  assert.equal(box.type, "goal");
  assert.equal(box.coordination, true);
  assert.equal(box.fm.status, "todo");
  assert.equal(typeHasCoordination("goal", after.typeRegistry), true);

  await assert.rejects(() => promoteConcept(env as any, id, "note"), /coordination/);
});

test("migration:bx→cx 与 output→artifact 纯函数 + 落盘", async () => {
  assert.equal(rewriteOutputType("output"), "artifact");
  assert.equal(rewriteOutputType("output-asset"), "artifact-asset");
  assert.equal(rewriteOutputType("goal"), undefined);

  const map = planIdRemap(["bx-abc123", "bx-xyz"], new Set(["cx-other"]), () => 0.5);
  assert.equal(map.get("bx-abc123"), "cx-abc123");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-mig-"));
  const fsa = new NodeFs(dir);
  await fsa.writeFile(
    "types.json",
    JSON.stringify({
      goal: { tier: "base", readable: true, writable: false },
      output: { tier: "base", readable: true, writable: true, workspacePointer: true },
    }),
    // writeFile signature is (path, content)
  );
  // fix: NodeFs writeFile takes two args only
  await fsa.mkdir("legacy");
  await fsa.writeFile(
    "legacy/legacy.md",
    "---\nid: bx-leg001\ntype: output\n---\n# L\n",
  );
  await fsa.writeFile("RULES.md", "# r\n");

  const dry = await migrateLegacySchema(fsa, { dryRun: true, rand: () => 0.1 });
  assert.ok(dry.idMap.some((e) => e.from === "bx-leg001"));
  assert.ok(dry.typeRewrites.some((e) => e.from === "output" && e.to === "artifact"));
  assert.match(await fsa.readFile("legacy/legacy.md"), /id: bx-leg001/);

  const live = await migrateLegacySchema(fsa, { dryRun: false, rand: () => 0.1 });
  const text = await fsa.readFile("legacy/legacy.md");
  assert.match(text, /id: cx-leg001/);
  assert.match(text, /type: artifact/);
  assert.ok(live.idMap.length >= 1);
  const tent = await loadTent(fsa);
  assert.equal(tent.byId.has("cx-leg001"), true);
  assert.equal(tent.byId.get("cx-leg001")!.coordination, true);
});

test("findIntegratedCommit:ancestor 与 cherry-pick 幂等", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-int-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "a.txt"), "a\n");
  await git(workspace, "add", "a.txt");
  await git(workspace, "commit", "-q", "-m", "init");
  const base = (await git(workspace, "rev-parse", "HEAD")).trim();

  await git(workspace, "checkout", "-q", "-b", "tent-role/r");
  await fs.writeFile(path.join(workspace, "b.txt"), "b\n");
  await git(workspace, "add", "b.txt");
  await git(workspace, "commit", "-q", "-m", "role work");
  const roleRef = (await git(workspace, "rev-parse", "HEAD")).trim();
  await git(workspace, "checkout", "-q", "main");

  const { findIntegratedCommit, integrateWorkspaceCommits, ensureRoleWorkspace } =
    await import("../src/core/workspace.js");

  assert.equal(await findIntegratedCommit(workspace, roleRef, "main"), undefined);
  assert.deepEqual(await findIntegratedCommit(workspace, base, "main"), {
    integratedRef: base,
    reason: "ancestor",
  });

  const contract = await ensureRoleWorkspace(workspace, "r");
  await integrateWorkspaceCommits(contract, [roleRef]);
  const again = await findIntegratedCommit(workspace, roleRef, "main");
  assert.ok(again);
  assert.equal(again!.reason === "ancestor" || again!.reason === "cherry-pick", true);

  const [second] = await integrateWorkspaceCommits(contract, [roleRef]);
  assert.equal(second.alreadyIntegrated, true);
});

test("findCherryPick:仅目标分支可达历史，其他分支痕迹不得误判", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-cp-"));
  const workspace = path.join(parent, "repo");
  await fs.mkdir(workspace);
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, "a.txt"), "a\n");
  await git(workspace, "add", "a.txt");
  await git(workspace, "commit", "-q", "-m", "init");

  await git(workspace, "checkout", "-q", "-b", "tent-role/r");
  await fs.writeFile(path.join(workspace, "b.txt"), "b\n");
  await git(workspace, "add", "b.txt");
  await git(workspace, "commit", "-q", "-m", "role work");
  const roleRef = (await git(workspace, "rev-parse", "HEAD")).trim();
  await git(workspace, "checkout", "-q", "main");

  // 在无关分支上伪造 cherry-pick 文案，不得让 main 判定为已合入
  await git(workspace, "checkout", "-q", "-b", "noise");
  await fs.writeFile(path.join(workspace, "noise.txt"), "n\n");
  await git(workspace, "add", "noise.txt");
  await git(workspace, "commit", "-q", "-m", `noise (cherry picked from commit ${roleRef})`);
  await git(workspace, "checkout", "-q", "main");

  const { findIntegratedCommit, integrateWorkspaceCommits, ensureRoleWorkspace } =
    await import("../src/core/workspace.js");

  assert.equal(
    await findIntegratedCommit(workspace, roleRef, "main"),
    undefined,
    "other-branch cherry-pick message must not mark main as integrated",
  );

  const contract = await ensureRoleWorkspace(workspace, "r");
  const [first] = await integrateWorkspaceCommits(contract, [roleRef]);
  assert.equal(first.alreadyIntegrated, false);
  const after = await findIntegratedCommit(workspace, roleRef, "main");
  assert.ok(after);
  // FF 路径 → ancestor；cherry-pick -x 路径 → cherry-pick；二者都算已合入
  assert.equal(after!.reason === "ancestor" || after!.reason === "cherry-pick", true);

  // 截断 sha 痕迹在无关分支上不得单独构成合入判定（main 已因真实合入而命中）
  await git(workspace, "checkout", "-q", "-b", "trunc");
  await fs.writeFile(path.join(workspace, "t.txt"), "t\n");
  await git(workspace, "add", "t.txt");
  const short = roleRef.slice(0, 12);
  await git(workspace, "commit", "-q", "-m", `fake (cherry picked from commit ${short})`);
  await git(workspace, "checkout", "-q", "main");
  const again = await findIntegratedCommit(workspace, roleRef, "main");
  assert.ok(again, "real integration on main still detected");
});

test("migration:嵌套 .tent 注册表单次搬迁后切断 dual-read", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-lift-"));
  const fsa = new NodeFs(dir);
  await fsa.writeFile("RULES.md", "# r\n");
  await fsa.mkdir(".tent");
  await fsa.writeFile(
    ".tent/types.json",
    JSON.stringify({
      primary: {
        goal: { readable: true, writable: false, color: "orange" },
        output: { readable: true, writable: true, workspacePointer: true },
        onlyNested: { readable: true, writable: true, coordination: true },
      },
      secondary: {
        asset: { writable: true },
      },
    }),
  );
  await fsa.writeFile(".tent/roles.json", JSON.stringify({ roles: [{ name: "r1" }] }) + "\n");
  await fsa.writeFile(".tent/tags.json", JSON.stringify({ tags: ["alpha"] }) + "\n");
  await fsa.writeFile(".tent/order.json", JSON.stringify({ __root__: ["bx-a"] }) + "\n");
  await fsa.writeFile(".tent/mutation.lock", '{"pid":1}\n');

  // 嵌套存在时正常 load 不得 dual-read：flat 缺失 → defaults，忽略 nested
  const { loadTypeRegistry } = await import("../src/core/typeRegistry.js");
  const before = await loadTypeRegistry(fsa);
  assert.equal(before.goal.color, "blue", "defaults, not nested orange");
  assert.equal(before.onlyNested, undefined, "nested-only type must not dual-read");
  assert.equal(await fsa.exists("types.json"), false);

  const report = await migrateLegacySchema(fsa, { dryRun: false, rand: () => 0.1 });
  assert.ok(report.registryChanges.some((c) => c.includes("lifted nested")));
  assert.equal(await fsa.exists("types.json"), true);
  assert.equal(await fsa.exists(".tent/types.json"), false);
  assert.equal(await fsa.exists(".tent/mutation.lock"), false);
  assert.equal(await fsa.exists("roles.json"), true);
  assert.equal(await fsa.exists(".tent/roles.json"), false);

  const registry = JSON.parse(await fsa.readFile("types.json"));
  assert.ok(registry.artifact, "primary.output → artifact");
  assert.equal(registry.output, undefined);
  assert.equal(registry.artifact.coordination, true);

  // 重跑幂等
  const again = await migrateLegacySchema(fsa, { dryRun: false, rand: () => 0.1 });
  assert.ok(again.registryChanges.some((c) => c.includes("unique lock path")));
  assert.equal(await fsa.exists(".tent/types.json"), false);
});

test("migration:primary/secondary output→artifact 幂等", async () => {
  const { migrateTypeRegistryJson } = await import("../src/core/migration.js");
  const first = migrateTypeRegistryJson({
    primary: {
      goal: { readable: true, writable: false },
      output: { readable: true, writable: true, workspacePointer: true },
    },
    secondary: { asset: { writable: true } },
  });
  assert.ok(first.changes.some((c) => /primary\.output/.test(c) || /promoted/.test(c)));
  assert.equal(first.registry.output, undefined);
  assert.equal(first.registry.artifact?.tier !== "modifier" ? first.registry.artifact?.coordination : undefined, true);

  const second = migrateTypeRegistryJson(first.registry);
  // 已是 artifact 的 flat registry：再迁一次不应再发明 output
  assert.equal(second.registry.output, undefined);
  assert.ok(second.registry.artifact);
});

test("migration:operational 引用有界改写且幂等", async () => {
  const { rewriteOperationalText, replaceExactIdTokens } = await import("../src/core/migration.js");
  const map = new Map([["bx-abc123", "cx-abc123"]]);

  // 精确 token 改写
  assert.equal(replaceExactIdTokens("claims: [bx-abc123]", "bx-abc123", "cx-abc123"), "claims: [cx-abc123]");
  // 不得把更长 id 子串误伤
  assert.equal(replaceExactIdTokens("bx-abc1234", "bx-abc123", "cx-abc123"), "bx-abc1234");

  const sample =
    "---\ntype: task\nclaims: [bx-abc123]\nbox: bx-abc123\n---\nSee bx-abc123 and not bx-abc1234.\n";
  const once = rewriteOperationalText(sample, map);
  assert.match(once, /claims: \[cx-abc123\]/);
  assert.match(once, /box: cx-abc123/);
  assert.match(once, /See cx-abc123 and not bx-abc1234/);
  const twice = rewriteOperationalText(once, map);
  assert.equal(twice, once, "idempotent");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-oprw-"));
  const fsa = new NodeFs(dir);
  await fsa.writeFile("RULES.md", "# r\n");
  await fsa.mkdir("work");
  await fsa.writeFile("work/work.md", "---\nid: bx-abc123\ntype: prompt\n---\n# w\n");
  await fsa.mkdir("temp/role/tasks");
  await fsa.writeFile(
    "temp/role/tasks/task-1-bx-abc123.md",
    "---\ntype: task\nrole: role\nclaims: [bx-abc123]\nmanifest: m.yml\n---\nbody bx-abc123\n",
  );
  const report = await migrateLegacySchema(fsa, { dryRun: false, rand: () => 0.2 });
  assert.ok(report.idMap.some((e) => e.from === "bx-abc123"));
  assert.equal(await fsa.exists("temp/role/tasks/task-1-cx-abc123.md"), true);
  const task = await fsa.readFile("temp/role/tasks/task-1-cx-abc123.md");
  assert.match(task, /claims: \[cx-abc123\]/);
  assert.doesNotMatch(task, /bx-abc123/);
});

test("dispatch/claim:拒绝 coordination=false 的 note；prompt 正向通过", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-dispatch-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = { fs: fsa, clock: { now: () => "2026-07-12T00:00:00.000Z" }, tentName: "x", tentRoot: dir, rand: () => 0.3 };
  const noteId = await createBox(env as any, { parentPath: "", name: "memo", type: "note" });
  const promptId = await createBox(env as any, { parentPath: "", name: "job", type: "prompt" });

  const { dispatch, taskAck } = await import("../src/core/ops.js");
  const { canClaim } = await import("../src/core/claim.js");
  const tent = await loadTent(fsa);
  assert.equal(canClaim(tent.byId.get(noteId)!).ok, false);
  assert.equal(canClaim(tent.byId.get(promptId)!).ok, true);

  await assert.rejects(
    () => dispatch(env as any, noteId, "reviewer", "do note"),
    /coordination=false/,
  );

  const result = await dispatch(env as any, promptId, "reviewer", "do prompt");
  assert.match(result.taskPath, /temp\/reviewer\/tasks\//);
  await taskAck(env as any, result.taskPath);
  const after = await loadTent(fsa);
  assert.equal(after.byId.get(promptId)!.fm.owner, "reviewer");
  assert.equal(after.byId.get(promptId)!.fm.status, "doing");
});

test("promoteConcept:active task 时 box→box 写保护", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-promote-lock-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  const env = { fs: fsa, clock: { now: () => "2026-07-12T00:00:00.000Z" }, tentName: "x", tentRoot: dir, rand: () => 0.4 };
  const id = await createBox(env as any, { parentPath: "", name: "job", type: "prompt" });
  const { dispatch } = await import("../src/core/ops.js");
  await dispatch(env as any, id, "reviewer", "work");

  await assert.rejects(
    () => promoteConcept(env as any, id, "goal"),
    /active task|write-protect/,
  );
});

test("CLI makeEnv:无 system root 明确失败，不回退 cwd", async () => {
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-nosys-")));
  const { findTentSystemRoot, NOT_INSIDE_TENT_MESSAGE } = await import("../src/core/status.js");
  assert.equal(await findTentSystemRoot(outside), undefined);
  assert.match(NOT_INSIDE_TENT_MESSAGE, /\.tent\//);

  // 在 outside 跑 status 必须失败且不创建任何系统文件
  const { cli } = await import("./helpers.js");
  const result = await cli(outside, "status");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Not inside a Tent/);
  assert.equal(await fsaExists(path.join(outside, "types.json")), false);
  assert.equal(await fsaExists(path.join(outside, "mutation.lock")), false);
  assert.equal(await fsaExists(path.join(outside, ".tent")), false);
});

test("唯一锁:withTentMutation 只使用 system root mutation.lock", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b1-lock-"));
  const fsa = new NodeFs(dir);
  await scaffoldTent(fsa, { name: "x", rules: "# r\n" });
  // 嵌套锁路径即使存在也不应被 withTentMutation 使用
  await fsa.mkdir(".tent");
  await fsa.writeFile(".tent/mutation.lock", "stale\n");

  const { withTentMutation } = await import("../src/core/adapter.js");
  const { MUTATION_LOCK_PATH } = await import("../src/core/paths.js");
  assert.equal(MUTATION_LOCK_PATH, "mutation.lock");

  let sawFlat = false;
  await withTentMutation(fsa, async () => {
    sawFlat = await fsa.exists("mutation.lock");
    assert.equal(sawFlat, true);
    // 嵌套锁仍是我们写入的 stale 内容，未被替换为活跃锁协议
    assert.equal(await fsa.readFile(".tent/mutation.lock"), "stale\n");
  });
  assert.equal(sawFlat, true);
  assert.equal(await fsa.exists("mutation.lock"), false);
});

async function fsaExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Build a minimal legacy external tent root (flat system root, not under .tent). */
async function makeLegacyExternalRoot(parent: string): Promise<string> {
  const root = path.join(parent, "legacy-tent");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "RULES.md"), "# legacy rules\n");
  await fs.writeFile(
    path.join(root, "types.json"),
    JSON.stringify({
      primary: {
        goal: { readable: true, writable: false, color: "blue" },
        output: { readable: true, writable: true, workspacePointer: true },
      },
    }) + "\n"
  );
  await fs.writeFile(
    path.join(root, "roles.json"),
    JSON.stringify({ roles: [{ name: "executor", prompt: "do work" }] }) + "\n"
  );
  await fs.writeFile(path.join(root, "tags.json"), JSON.stringify({ tags: ["alpha"] }) + "\n");
  await fs.writeFile(
    path.join(root, "order.json"),
    JSON.stringify({ __root__: ["bx-legbox1"] }) + "\n"
  );
  // Nested registry residue (old dual layout)
  await fs.mkdir(path.join(root, ".tent"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tent", "types.json"),
    JSON.stringify({ onlyNested: { readable: true, writable: true } }) + "\n"
  );
  const boxDir = path.join(root, "goal");
  await fs.mkdir(boxDir, { recursive: true });
  await fs.writeFile(
    path.join(boxDir, "goal.md"),
    "---\nid: bx-legbox1\ntype: output\n---\n# Goal body\nPreserved.\n"
  );
  const tempRole = path.join(root, "temp", "executor", "tasks");
  await fs.mkdir(tempRole, { recursive: true });
  await fs.writeFile(
    path.join(tempRole, "task-bx-legbox1.md"),
    "---\ntype: task\nrole: executor\nstatus: pending\nclaims: [bx-legbox1]\nbox: bx-legbox1\n---\n## User Prompt\nDo the thing.\n"
  );
  return root;
}

test("importExternalTentRoot:dry-run 不写目标且不标记源", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-import-dry-"));
  const source = await makeLegacyExternalRoot(parent);
  const workspace = path.join(parent, "ws");
  await fs.mkdir(workspace);

  assert.equal(await isLegacyTentRoot(source), true);

  const report = await importExternalTentRoot({
    sourceRoot: source,
    workspaceRoot: workspace,
    dryRun: true,
    rand: () => 0.1,
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.copied, false);
  assert.equal(report.sourceMarked, false);
  assert.ok(report.schema.idMap.some((e) => e.from === "bx-legbox1"));
  assert.equal(await fsaExists(path.join(workspace, ".tent")), false);
  assert.equal(await fsaExists(path.join(source, "MIGRATED.md")), false);
  assert.ok(await fsaExists(path.join(source, "RULES.md")), "source intact");
});

test("importExternalTentRoot:拒绝覆盖已有 .tent", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-import-refuse-"));
  const source = await makeLegacyExternalRoot(parent);
  const workspace = path.join(parent, "ws");
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent", "RULES.md"), "# existing\n");

  await assert.rejects(
    () =>
      importExternalTentRoot({
        sourceRoot: source,
        workspaceRoot: workspace,
        dryRun: false,
        force: true, // force must NOT enable overwrite
      }),
    /already has \.tent|Refusing to import/
  );
  // Source untouched
  assert.equal(await fsaExists(path.join(source, "MIGRATED.md")), false);
  assert.match(await fs.readFile(path.join(workspace, ".tent", "RULES.md"), "utf8"), /existing/);
});

test("importExternalTentRoot:live 复制保留层级/正文/注册表/task 且不删源", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-import-live-"));
  const source = await makeLegacyExternalRoot(parent);
  const workspace = path.join(parent, "ws");
  await fs.mkdir(workspace);

  const report = await importExternalTentRoot({
    sourceRoot: source,
    workspaceRoot: workspace,
    dryRun: false,
    rand: () => 0.1,
  });
  assert.equal(report.copied, true);
  assert.equal(report.sourceMarked, true);
  assert.ok(await fsaExists(path.join(source, "RULES.md")), "source not deleted");
  assert.ok(await fsaExists(path.join(source, "goal", "goal.md")), "source boxes remain");
  assert.match(await fs.readFile(path.join(source, "MIGRATED.md"), "utf8"), /Migrated/);

  const systemRoot = path.join(workspace, ".tent");
  assert.ok(await fsaExists(path.join(systemRoot, "RULES.md")));
  assert.ok(await fsaExists(path.join(systemRoot, "types.json")));
  assert.ok(await fsaExists(path.join(systemRoot, "roles.json")));
  assert.ok(await fsaExists(path.join(systemRoot, "tags.json")));
  assert.ok(await fsaExists(path.join(systemRoot, "order.json")));

  // Nested source registry lifted away on destination
  assert.equal(await fsaExists(path.join(systemRoot, ".tent", "types.json")), false);

  const destFs = new NodeFs(systemRoot);
  const tent = await loadTent(destFs);
  assert.equal(tent.byId.has("cx-legbox1"), true);
  assert.equal(tent.byId.has("bx-legbox1"), false);
  const note = await destFs.readFile("goal/goal.md");
  assert.match(note, /id: cx-legbox1/);
  assert.match(note, /type: artifact/);
  assert.match(note, /Preserved/);

  const taskText = await destFs.readFile("temp/executor/tasks/task-cx-legbox1.md");
  assert.match(taskText, /claims: \[cx-legbox1\]/);
  assert.match(taskText, /Do the thing/);

  const roles = JSON.parse(await destFs.readFile("roles.json"));
  assert.equal(roles.roles[0].name, "executor");
  const tags = JSON.parse(await destFs.readFile("tags.json"));
  assert.deepEqual(tags.tags, ["alpha"]);

  const gitignore = await fs.readFile(path.join(workspace, ".gitignore"), "utf8");
  assert.match(gitignore, /\.tent\//);

  // Idempotent refuse on second live import
  await assert.rejects(
    () =>
      importExternalTentRoot({
        sourceRoot: source,
        workspaceRoot: workspace,
        dryRun: false,
      }),
    /Refusing to import|already has/
  );
});

test("importExternalTentRoot:中途 schema 失败后无 .tent / marker / staging 且可重试", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-import-fail-"));
  const source = await makeLegacyExternalRoot(parent);
  const workspace = path.join(parent, "ws");
  await fs.mkdir(workspace);

  await assert.rejects(
    () =>
      importExternalTentRoot({
        sourceRoot: source,
        workspaceRoot: workspace,
        dryRun: false,
        rand: () => 0.1,
        _testHooks: {
          afterSchema: async () => {
            throw new Error("injected schema-phase failure");
          },
        },
      }),
    /injected schema-phase failure/
  );

  assert.equal(await fsaExists(path.join(workspace, ".tent")), false, "final .tent must not exist");
  assert.equal(await fsaExists(path.join(source, "MIGRATED.md")), false, "source marker not written");
  const leftover = await listImportStagingDirs(workspace);
  assert.deepEqual(leftover, [], "staging cleaned best-effort");

  // Retry succeeds after cleanup
  const report = await importExternalTentRoot({
    sourceRoot: source,
    workspaceRoot: workspace,
    dryRun: false,
    rand: () => 0.1,
  });
  assert.equal(report.copied, true);
  assert.equal(report.sourceMarked, true);
  assert.ok(await fsaExists(path.join(workspace, ".tent", "RULES.md")));
  assert.ok(await fsaExists(path.join(source, "MIGRATED.md")));
});

test("importExternalTentRoot:copy 阶段失败后无最终 .tent 且无 marker", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-import-copyfail-"));
  const source = await makeLegacyExternalRoot(parent);
  const workspace = path.join(parent, "ws");
  await fs.mkdir(workspace);

  await assert.rejects(
    () =>
      importExternalTentRoot({
        sourceRoot: source,
        workspaceRoot: workspace,
        dryRun: false,
        _testHooks: {
          afterCopy: async () => {
            throw new Error("injected copy-phase failure");
          },
        },
      }),
    /injected copy-phase failure/
  );

  assert.equal(await fsaExists(path.join(workspace, ".tent")), false);
  assert.equal(await fsaExists(path.join(source, "MIGRATED.md")), false);
  assert.deepEqual(await listImportStagingDirs(workspace), []);
});

test("importExternalTentRoot:不跟随符号链接并记入 skipped/warnings", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-import-symlink-"));
  const source = await makeLegacyExternalRoot(parent);
  const workspace = path.join(parent, "ws");
  await fs.mkdir(workspace);

  // External payload outside source root — must never land in destination.
  const outside = path.join(parent, "outside-secret");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "leak.txt"), "SECRET_OUTSIDE_SOURCE\n");

  let symlinkOk = false;
  try {
    await fs.symlink(
      path.join(outside, "leak.txt"),
      path.join(source, "leaked-file"),
      process.platform === "win32" ? "file" : undefined
    );
    await fs.symlink(outside, path.join(source, "leaked-dir"), process.platform === "win32" ? "dir" : undefined);
    symlinkOk = true;
  } catch (error) {
    // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege.
    t.skip(
      `symlink create unavailable on this host: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  assert.equal(symlinkOk, true);

  const report = await importExternalTentRoot({
    sourceRoot: source,
    workspaceRoot: workspace,
    dryRun: false,
    rand: () => 0.1,
  });
  assert.equal(report.copied, true);

  const systemRoot = path.join(workspace, ".tent");
  assert.equal(await fsaExists(path.join(systemRoot, "leaked-file")), false);
  assert.equal(await fsaExists(path.join(systemRoot, "leaked-dir")), false);
  assert.equal(await fsaExists(path.join(systemRoot, "leaked-dir", "leak.txt")), false);

  const allNotes = [...report.skipped, ...report.warnings].join("\n");
  assert.match(allNotes, /skipped symlink \(not followed\): leaked-file/);
  assert.match(allNotes, /skipped symlink \(not followed\): leaked-dir/);

  // Destination content must not contain the outside secret payload.
  const rules = await fs.readFile(path.join(systemRoot, "RULES.md"), "utf8");
  assert.doesNotMatch(rules, /SECRET_OUTSIDE_SOURCE/);
  assert.ok(await fsaExists(path.join(systemRoot, "goal", "goal.md")));
});

async function listImportStagingDirs(workspace: string): Promise<string[]> {
  const names = await fs.readdir(workspace);
  return names.filter((n) => n.startsWith(IMPORT_STAGING_DIR_PREFIX));
}
