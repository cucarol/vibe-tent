import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent, isContentMutable, isUsableNode } from "../src/core/tree.js";
import {
  archiveNode,
  deleteArchivedNode,
  patchBody,
  patchNode,
  restoreNode,
  setNodeMode,
} from "../src/core/ops.js";
import { makeTent } from "./helpers.js";

function envFor(dir: string) {
  return {
    fs: new NodeFs(dir),
    git: { run: async () => "" },
    clock: { now: () => "t" },
    tentName: "x",
  };
}

test("mode matrix: editable mutates; archived freezes; read-only is retired", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = envFor(dir);

  let tent = await loadTent(fsa);
  const goal = tent.byId.get("cx-g2")!;
  assert.equal(goal.mode, "editable");
  assert.equal(isContentMutable(goal), true);
  await patchBody(env as any, goal.path, "goal body ok\n");

  const draft = tent.byId.get("cx-p2")!;
  await assert.rejects(
    () => setNodeMode(env as any, draft.id, "read-only" as any),
    /read-only mode is retired/
  );

  await setNodeMode(env as any, "cx-p1", "archived");
  tent = await loadTent(fsa);
  const archived = tent.byId.get("cx-p1")!;
  assert.equal(archived.mode, "archived");
  assert.equal(archived.archived, true);
  assert.equal(isUsableNode(archived), false);
  assert.equal(isContentMutable(archived), false);
  await assert.rejects(() => patchBody(env as any, archived.path, "nope\n"), /archived/i);
  await assert.rejects(
    () => patchNode(env as any, archived.path, { tags: ["x"] }),
    /archived|restored/i
  );
});

test("archive and restore use their explicit lifecycle commands", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = envFor(dir);

  await assert.rejects(
    () => patchNode(env as any, "prompt/表达式任务书", { mode: "archived" }),
    /Reserved/
  );
  await assert.rejects(
    () => patchNode(env as any, "prompt/表达式任务书", { readable: true }),
    /Reserved|retired/i
  );

  await archiveNode(env as any, "cx-p1");
  let tent = await loadTent(fsa);
  assert.equal(tent.byId.get("cx-p1")!.mode, "archived");

  await restoreNode(env as any, "cx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("cx-p1")!.mode, "editable");

  await setNodeMode(env as any, "cx-p1", "archived");
  await deleteArchivedNode(env as any, "cx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("cx-p1"), undefined);
});
