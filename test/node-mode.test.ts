import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeFs } from "../src/fs/node-fs.js";
import { loadTent, isContentMutable, isUsableBox } from "../src/core/tree.js";
import {
  archiveBox,
  deleteArchivedBox,
  patchBody,
  patchBox,
  restoreBox,
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
  const goal = tent.byId.get("bx-g2")!;
  assert.equal(goal.mode, "editable");
  assert.equal(isContentMutable(goal), true);
  await patchBody(env as any, goal.path, "goal body ok\n");

  const draft = tent.byId.get("bx-p2")!;
  await assert.rejects(
    () => setNodeMode(env as any, draft.id, "read-only" as any),
    /read-only mode is retired/
  );

  await setNodeMode(env as any, "bx-p1", "archived");
  tent = await loadTent(fsa);
  const archived = tent.byId.get("bx-p1")!;
  assert.equal(archived.mode, "archived");
  assert.equal(archived.archived, true);
  assert.equal(isUsableBox(archived), false);
  assert.equal(isContentMutable(archived), false);
  await assert.rejects(() => patchBody(env as any, archived.path, "nope\n"), /archived/i);
  await assert.rejects(
    () => patchBox(env as any, archived.path, { tags: ["x"] }),
    /archived|restored/i
  );
});

test("archive and restore use their explicit lifecycle commands", async () => {
  const dir = await makeTent();
  const fsa = new NodeFs(dir);
  const env = envFor(dir);

  await assert.rejects(
    () => patchBox(env as any, "prompt/表达式任务书", { mode: "archived" }),
    /Reserved/
  );
  await assert.rejects(
    () => patchBox(env as any, "prompt/表达式任务书", { readable: true }),
    /Reserved|retired/i
  );

  await archiveBox(env as any, "bx-p1");
  let tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.mode, "archived");

  await restoreBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1")!.mode, "editable");

  await setNodeMode(env as any, "bx-p1", "archived");
  await deleteArchivedBox(env as any, "bx-p1");
  tent = await loadTent(fsa);
  assert.equal(tent.byId.get("bx-p1"), undefined);
});
