import { test } from "node:test";
import assert from "node:assert/strict";
import { typeColorValue } from "../src/plugin/colors.js";
import { TimedCache } from "../src/plugin/timed-cache.js";
import {
  dispatchAckKey,
  pendingDispatches,
  rememberDispatchAck,
} from "../src/plugin/pending-dispatch.js";
import type { TaskEnvelope } from "../src/core/task.js";
import { mergeSettings } from "../src/plugin/settings-model.js";
import * as uiModel from "../src/plugin/ui-model.js";
import {
  createRegistryPaneState,
  roleColorValue,
  rwSegmentStates,
  visibleTreeCount,
} from "../src/plugin/ui-model.js";

test("plugin ui-model:registry pane state starts expanded and isolated", () => {
  const first = createRegistryPaneState();
  const second = createRegistryPaneState();

  assert.deepEqual(first.collapsed, { type: false, kind: false, roles: false });
  assert.equal(first.typeCollapsed, false);
  assert.equal(first.newFormOpen, null);
  assert.equal(first.openEditor, null);

  first.markedTypes.add("goal");
  first.markedRoles.add("planner");
  assert.equal(second.markedTypes.has("goal"), false);
  assert.equal(second.markedRoles.has("planner"), false);
});

test("plugin ui-model:R/W segment states mark active option", () => {
  assert.deepEqual(rwSegmentStates(undefined), [
    { label: "继承", value: undefined, active: true },
    { label: "开", value: true, active: false },
    { label: "关", value: false, active: false },
  ]);
  assert.deepEqual(rwSegmentStates(false, false), [
    { label: "开", value: true, active: false },
    { label: "关", value: false, active: true },
  ]);
});

test("plugin ui-model:captures and restores pane scroll positions across redraws", () => {
  const capturePaneScroll = Reflect.get(uiModel, "capturePaneScroll");
  const restorePaneScroll = Reflect.get(uiModel, "restorePaneScroll");
  assert.equal(typeof capturePaneScroll, "function");
  assert.equal(typeof restorePaneScroll, "function");

  const oldTree = { scrollTop: 360 };
  const oldProperty = { scrollTop: 140 };
  const oldRoot = {
    querySelector: (selector: string) =>
      selector === ".tent-tree" ? oldTree : selector === ".tent-prop" ? oldProperty : null,
  };
  const positions = capturePaneScroll(oldRoot);
  assert.deepEqual(positions, { tree: 360, property: 140 });

  const newTree = { scrollTop: 0 };
  const newProperty = { scrollTop: 0 };
  const newRoot = {
    querySelector: (selector: string) =>
      selector === ".tent-tree" ? newTree : selector === ".tent-prop" ? newProperty : null,
  };
  restorePaneScroll(newRoot, positions);
  assert.equal(newTree.scrollTop, 360);
  assert.equal(newProperty.scrollTop, 140);
});

test("plugin ui-model:collapsed rows include hidden descendant triage counts", () => {
  const grandchild = { id: "grandchild", children: [] };
  const child = { id: "child", children: [grandchild] };
  const root = { id: "root", children: [child] };
  const counts = new Map([
    ["root", 1],
    ["child", 2],
    ["grandchild", 3],
  ]);
  const direct = (box: { id: string }) => counts.get(box.id) ?? 0;

  assert.equal(visibleTreeCount(root, false, direct), 1);
  assert.equal(visibleTreeCount(root, true, direct), 6);
  assert.equal(visibleTreeCount(child, true, direct), 5);
});

test("plugin pending dispatch:newest matching task wins and acknowledgement clears every claim", () => {
  const tasks: TaskEnvelope[] = [
    {
      path: "temp/executor/tasks/task-20260703T08000-bx-one.md",
      role: "executor",
      claims: ["bx-one"],
      manifest: "temp/executor/manifest.yml",
      status: "pending",
    },
    {
      path: "temp/executor/tasks/task-20260703T08100-bx-one.md",
      role: "executor",
      claims: ["bx-one", "bx-two", "root"],
      manifest: "temp/executor/manifest.yml",
      status: "pending",
    },
    {
      path: "temp/planner/tasks/task-20260703T08200-bx-three.md",
      role: "planner",
      claims: ["bx-three"],
      manifest: "temp/planner/manifest.yml",
      status: "pending",
    },
    {
      path: "temp/zeta/tasks/task-20260703T07000-bx-four.md",
      role: "zeta",
      claims: ["bx-four"],
      manifest: "temp/zeta/manifest.yml",
      status: "pending",
    },
    {
      path: "temp/alpha/tasks/task-20260703T09000-bx-four.md",
      role: "alpha",
      claims: ["bx-four"],
      manifest: "temp/alpha/manifest.yml",
      status: "pending",
    },
  ];
  const owners = new Map([
    ["bx-one", "executor"],
    ["bx-two", "executor"],
    ["bx-three", "executor"],
    ["bx-four", "alpha"],
  ]);
  const ownerFor = (boxId: string) => owners.get(boxId);

  const pending = pendingDispatches(tasks, ownerFor, "tent-dev");
  assert.deepEqual(
    pending
      .map((item) => [item.boxId, item.task.path])
      .sort(([a], [b]) => a.localeCompare(b)),
    [
      ["bx-four", tasks[4].path],
      ["bx-one", tasks[1].path],
      ["bx-two", tasks[1].path],
    ],
  );

  tasks[1].status = "taken";
  assert.deepEqual(
    pendingDispatches(tasks, ownerFor, "tent-dev").map((item) => item.boxId),
    ["bx-four"],
  );
});

test("plugin pending dispatch:acknowledgements are deduplicated and bounded", () => {
  assert.deepEqual(
    rememberDispatchAck(["old", "same", "old"], "same", 2),
    ["old", "same"],
  );
  assert.deepEqual(
    rememberDispatchAck(["one", "two", "three"], "four", 3),
    ["two", "three", "four"],
  );
});

test("plugin settings:migrates legacy defaults and bounds acknowledgements", () => {
  const settings = mergeSettings({
    tentsRoot: "vault-tents",
    appearance: "warm",
    newTentTemplate: {
      typeRegistry: {
        note: { tier: "base", readable: true, writable: false, color: "blue" },
      },
      rolesRegistry: {
        roles: [
          { name: "planner", color: "purple", description: "Plan" },
          { name: "planner", color: "orange" },
          { name: " ", color: "gray" },
        ],
      },
      rulesTemplate: "# Custom",
    },
    dispatchPrefs: {
      copyPromptToClipboard: false,
      acknowledgedTasks: Array.from({ length: 505 }, (_, index) => `task-${index}`),
    },
  });

  assert.equal(settings.tentsRoot, "vault-tents");
  assert.equal(settings.appearance, "light");
  assert.equal(settings.dispatchPrefs.copyPromptToClipboard, false);
  assert.equal(settings.dispatchPrefs.acknowledgedTasks.length, 500);
  assert.equal(settings.dispatchPrefs.acknowledgedTasks[0], "task-5");
  assert.equal(settings.newTentDefaults.typeRegistry.note.description, undefined);
  assert.equal(settings.newTentDefaults.rolesRegistry.roles.length, 1);
  assert.deepEqual(settings.newTentDefaults.rolesRegistry.roles[0], {
    name: "planner",
    color: "purple",
    description: "Plan",
  });
  assert.equal(settings.newTentDefaults.rulesTemplate, "# Custom");
});

test("plugin colors:roles use explicit and inferred colors", () => {
  assert.equal(typeColorValue("cyan"), "var(--color-cyan, #2f9e93)");
  assert.equal(typeColorValue("#123456"), "#123456");
  assert.equal(roleColorValue({ name: "planner" }), "var(--color-purple, #8a6bc0)");
  assert.equal(roleColorValue({ name: "executor" }), "var(--color-cyan, #2f9e93)");
  assert.equal(roleColorValue({ name: "ui" }), "var(--color-orange, #d17f2e)");
  assert.equal(roleColorValue({ name: "custom", color: "pink" }), "var(--color-pink, #c8589a)");
});

test("plugin TimedCache:reuses values within ttl and reloads after expiry", async () => {
  let now = 10;
  let calls = 0;
  const cache = new TimedCache<number>(100, () => now);

  assert.equal(await cache.get("a", async () => ++calls), 1);
  assert.equal(await cache.get("a", async () => ++calls), 1);
  assert.equal(calls, 1);

  now = 111;
  assert.equal(await cache.get("a", async () => ++calls), 2);
  assert.equal(calls, 2);
});

test("plugin TimedCache:coalesces in-flight loads and drops failures", async () => {
  let calls = 0;
  const cache = new TimedCache<number>(100);
  const first = cache.get("a", async () => {
    calls += 1;
    return 7;
  });
  const second = cache.get("a", async () => {
    calls += 1;
    return 9;
  });
  assert.equal(await first, 7);
  assert.equal(await second, 7);
  assert.equal(calls, 1);

  cache.clear();
  await assert.rejects(
    () => cache.get("bad", async () => {
      calls += 1;
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(await cache.get("bad", async () => 11), 11);
});
