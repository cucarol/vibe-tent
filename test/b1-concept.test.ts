import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent } from "../src/core/tree.js";
import { promoteConcept } from "../src/core/concept.js";
import { migrateLegacySchema, planIdRemap, rewriteOutputType } from "../src/core/migration.js";
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
