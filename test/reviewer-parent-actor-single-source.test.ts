import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("parentActor is the sole persisted and public Task review-authority field", async () => {
  const [task, model, handlers, serviceTypes, client, cli, desktopMain, desktopUi] =
    await Promise.all([
      source("src/core/task.ts"),
      source("src/core/task-model.ts"),
      source("src/service/handlers.ts"),
      source("src/service/types.ts"),
      source("src/service/client.ts"),
      source("src/cli/task-rpc.ts"),
      source("src/desktop/main/collaboration-ipc-handler.ts"),
      source("src/desktop/workbench/collaboration-ui.ts"),
    ]);

  assert.doesNotMatch(task, /reviewer\?:\s*TaskActorRef/);
  assert.doesNotMatch(task, /reviewer:\s*serializeTaskActorRef/);
  assert.match(task, /hasOwnProperty\.call\(data, "reviewer"\)/);
  assert.match(task, /hasOwnProperty\.call\(data, "dispatchedBy"\)/);
  assert.doesNotMatch(model, /resolveParentReviewerPair|assertParentReviewerEqual/);
  assert.doesNotMatch(model, /reviewer\?:\s*TaskActorRef/);
  assert.doesNotMatch(serviceTypes, /^\s*reviewer\?:\s*TaskActorRefWire/m);
  assert.match(serviceTypes, /^\s*parentActor:\s*TaskActorRefWire;/m);
  assert.doesNotMatch(client, /^\s*reviewer\?:\s*\{\s*kind:/m);
  assert.doesNotMatch(cli, /reviewer:\s*parentActor/);
  assert.doesNotMatch(desktopMain, /reviewer:\s*\{\s*kind:\s*"user"/);
  assert.doesNotMatch(desktopUi, /^\s*reviewer:\s*\{\s*kind:/m);

  const dispatchAllowed = handlers.match(
    /async function taskDispatch[\s\S]*?assertAllowedParams\([\s\S]*?new Set\(\[([\s\S]*?)\]\)/
  )?.[1];
  assert.ok(dispatchAllowed, "task.dispatch allowed-parameter set must remain inspectable");
  assert.doesNotMatch(dispatchAllowed, /["']reviewer["']/);
  assert.doesNotMatch(dispatchAllowed, /["']callerKind["']/);
  assert.doesNotMatch(
    client.match(/taskDispatch\([\s\S]*?return this\.call\("task\.dispatch"/)?.[0] ?? "",
    /callerKind/
  );
  assert.doesNotMatch(
    cli.match(/case "dispatch":[\s\S]*?case "accept":/)?.[0] ?? "",
    /callerKind/
  );
  assert.doesNotMatch(
    desktopMain.match(/request\.operation === "dispatch"[\s\S]*?return \{/)?.[0] ?? "",
    /callerKind/
  );
  assert.doesNotMatch(handlers, /reviewerAuthority:/);
  assert.match(handlers, /TASK_PARENT_ACTOR_MISSING/);
});

test("canonical docs and Skills describe parentActor as the sole reviewer authority", async () => {
  const surfaces = await Promise.all(
    [
      "docs/SPEC.md",
      "docs/desktop/task-api.md",
      "docs/desktop/cli-service.md",
      "skills/tent-role/SKILL.md",
      "skills/tent-task/SKILL.md",
      "skills/tent-task/references/task-cli.md",
    ].map(source)
  );
  for (const text of surfaces) {
    assert.doesNotMatch(text, /persists? exact `parentActor` and `reviewer`/i);
    assert.doesNotMatch(text, /persisted parent\/reviewer/i);
    assert.doesNotMatch(text, /exact persisted reviewer/i);
  }
  assert.doesNotMatch(await source("test/reviewer-parent-actor-single-source.test.ts"), /["']Skills\//);
});
