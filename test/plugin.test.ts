import { test } from "node:test";
import assert from "node:assert/strict";
import { typeColorValue } from "../src/plugin/colors.js";
import { TimedCache } from "../src/plugin/timed-cache.js";
import {
  pendingDispatches,
} from "../src/plugin/pending-dispatch.js";
import type { TaskEnvelope } from "../src/core/task.js";
import { DEFAULT_TYPE_REGISTRY } from "../src/core/typeRegistry.js";
import { mergeSettings } from "../src/plugin/settings-model.js";
import * as uiModel from "../src/plugin/ui-model.js";
import {
  createRegistryPaneState,
  bottomTabCounts,
  bottomTabParts,
  hasTreePending,
  roleColorValue,
  rwSegmentStates,
  showsUnstampedState,
  statusBarText,
  statusBarTotal,
  statusIncreaseNoticeDelta,
  statusIncreaseNoticeText,
  statuslessDirectChildren,
  visibleTreeCount,
} from "../src/plugin/ui-model.js";

test("plugin ui-model:registry pane state starts expanded and isolated", () => {
  const first = createRegistryPaneState();
  const second = createRegistryPaneState();

  assert.deepEqual(first.collapsed, { type: false, modifier: false, roles: false });
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

test("plugin ui-model:showsUnstampedState always false (Node owner/status retired)", () => {
  assert.equal(showsUnstampedState({ fm: {} }), false);
  assert.equal(showsUnstampedState({ fm: { owner: "executor" } }), false);
  assert.equal(showsUnstampedState({ fm: { status: "todo" } }), false);
  assert.equal(showsUnstampedState({ fm: { status: "done" } }), false);
});

test("plugin ui-model:statuslessDirectChildren returns all direct children", () => {
  const grandchild = { id: "grandchild", fm: {}, children: [] };
  const statusless = { id: "statusless", fm: {}, children: [grandchild] };
  const todo = { id: "todo", fm: { status: "todo" }, children: [] };
  const done = { id: "done", fm: { status: "done" }, children: [] };
  const parent = { id: "parent", fm: { status: "doing" }, children: [statusless, todo, done] };

  assert.deepEqual(
    statuslessDirectChildren(parent).map((child) => child.id),
    ["statusless", "todo", "done"]
  );
});

test("plugin ui-model:dispatch and triage tab counts stay separate", () => {
  assert.deepEqual(
    bottomTabCounts({
      pendingDispatches: 2,
      pendingProposals: 3,
      readyReports: 1,
    }),
    { dispatch: 2, triage: 4 },
  );
});

test("plugin ui-model:status bar summarizes active work", () => {
  assert.equal(statusBarText(0), "帐内无事");
  assert.equal(statusBarText(3), "3 在办");
  assert.equal(statusBarTotal({ triage: 2, dispatch: 3 }), 5);
  assert.equal(statusIncreaseNoticeText(2), "帐内新增 2 项待裁");
});

test("plugin ui-model:status notice increase follows triage only", () => {
  assert.equal(statusIncreaseNoticeDelta(null, 2), null);
  assert.equal(statusIncreaseNoticeDelta(2, 2), null);
  assert.equal(statusIncreaseNoticeDelta(2, 1), null);
  assert.equal(statusIncreaseNoticeDelta(2, 5), 3);
});

test("plugin ui-model:tab count is a stable part separate from its label", () => {
  assert.deepEqual(bottomTabParts("派活", 1), { label: "派活", count: "(1)" });
  assert.deepEqual(bottomTabParts("待裁", 0), { label: "待裁", count: "" });
});

test("plugin ui-model:tree pending filter includes pending dispatches (not owner)", () => {
  assert.equal(hasTreePending({ pendingProposals: 0, pendingDispatches: 1 }), true);
  assert.equal(hasTreePending({ pendingProposals: 1, pendingDispatches: 0 }), true);
  assert.equal(hasTreePending({ pendingProposals: 0, pendingDispatches: 0, owner: "executor" }), false);
  assert.equal(hasTreePending({ pendingProposals: 0, pendingDispatches: 0 }), false);
});

/** Minimal contextCard projection for pending-dispatch fixtures (refs.nodes only). */
function fixtureCard(nodeIds: string[]): NonNullable<TaskEnvelope["contextCard"]> {
  return {
    schemaVersion: "v1",
    objective: "fixture",
    frozenDecisions: [],
    scope: { include: [], exclude: [] },
    acceptance: ["fixture"],
    refs: {
      nodes: nodeIds.filter((id) => id !== "root").map((id) => ({ id })),
      tasks: [],
      deliveries: [],
      git: [],
    },
    contextGeneration: "cg-v1-fixture",
    taskDeltaDigest: "td-fixture",
  };
}

test("plugin pending dispatch:only taken status clears the newest task node refs", () => {
  const tasks: TaskEnvelope[] = [
    {
      path: "temp/executor/tasks/task-20260703T08000-bx-one.md",
      role: "executor",
      contextCard: fixtureCard(["bx-one"]),
      manifest: "temp/executor/manifest.yml",
      status: "pending",
      state: "queued",
    },
    {
      path: "temp/executor/tasks/task-20260703T08100-bx-one.md",
      role: "executor",
      // "root" is not a Node ref; fixtureCard drops it (workspace context separate).
      contextCard: fixtureCard(["bx-one", "bx-two", "root"]),
      manifest: "temp/executor/manifest.yml",
      status: "pending",
      state: "queued",
    },
    {
      path: "temp/planner/tasks/task-20260703T08200-bx-three.md",
      role: "planner",
      contextCard: fixtureCard(["bx-three"]),
      manifest: "temp/planner/manifest.yml",
      status: "pending",
      state: "queued",
    },
    {
      path: "temp/zeta/tasks/task-20260703T07000-bx-four.md",
      role: "zeta",
      contextCard: fixtureCard(["bx-four"]),
      manifest: "temp/zeta/manifest.yml",
      status: "pending",
      state: "queued",
    },
    {
      path: "temp/alpha/tasks/task-20260703T09000-bx-four.md",
      role: "alpha",
      contextCard: fixtureCard(["bx-four"]),
      manifest: "temp/alpha/manifest.yml",
      status: "pending",
      state: "queued",
    },
  ];
  const pending = pendingDispatches(tasks);
  assert.deepEqual(
    pending
      .map((item) => [item.boxId, item.task.path])
      .sort(([a], [b]) => a.localeCompare(b)),
    [
      ["bx-four", tasks[4].path],
      ["bx-one", tasks[1].path],
      ["bx-three", tasks[2].path],
      ["bx-two", tasks[1].path],
    ],
  );

  tasks[1].status = "taken";
  assert.deepEqual(
    pendingDispatches(tasks).map((item) => item.boxId),
    ["bx-four", "bx-three"],
  );
});

test("plugin settings:migrates legacy defaults", () => {
  const settings = mergeSettings({
    tentsRoot: "vault-tents",
    appearance: "warm",
    newTentTemplate: {
      typeRegistry: {
        note: { tier: "base", readable: true, writable: false, color: "blue" },
        output: { tier: "base", readable: true, writable: true, color: "cyan" },
        repo: { tier: "base", readable: true, writable: true, color: "green", workspacePointer: true },
      },
      rolesRegistry: {
        roles: [
          { name: "planner", color: "purple", description: "Plan" },
          { name: "planner", color: "orange" },
          { name: " ", color: "gray" },
        ],
      },
    },
    dispatchPrefs: {
      copyPromptToClipboard: false,
    },
  });

  assert.equal(settings.tentsRoot, "vault-tents");
  assert.equal(settings.appearance, "light");
  assert.equal(settings.dispatchPrefs.copyPromptToClipboard, false);
  // V0.2: note→prompt, chrome/R/W stripped; custom bases dropped.
  assert.equal(settings.newTentDefaults.typeRegistry.note, undefined);
  assert.ok(settings.newTentDefaults.typeRegistry.prompt);
  assert.deepEqual(settings.newTentDefaults.typeRegistry.prompt, { tier: "base" });
  assert.ok(settings.newTentDefaults.typeRegistry.output);
  assert.deepEqual(settings.newTentDefaults.typeRegistry.output, { tier: "base" });
  assert.equal(settings.newTentDefaults.typeRegistry.repo, undefined, "custom primary bases are not kept");
  assert.equal(settings.newTentDefaults.rolesRegistry.roles.length, 1);
  const migratedRoleId = settings.newTentDefaults.rolesRegistry.roles[0].id;
  assert.ok(migratedRoleId);
  assert.match(migratedRoleId, /^rl-[a-z0-9]+$/);
  assert.deepEqual(settings.newTentDefaults.rolesRegistry.roles[0], {
    id: migratedRoleId,
    name: "planner",
    displayName: "planner",
    color: "purple",
    description: "Plan",
  });
});

test("plugin settings:default type registry is V0.2 goal|prompt|output", () => {
  const settings = mergeSettings({});
  const reg = settings.newTentDefaults.typeRegistry;
  assert.deepEqual(Object.keys(reg).sort(), ["asset", "goal", "output", "prompt", "reference"]);
  assert.deepEqual(reg.goal, { tier: "base" });
  assert.deepEqual(reg.prompt, { tier: "base" });
  assert.deepEqual(reg.output, { tier: "base" });
  assert.equal(reg.note, undefined);
  assert.equal(reg.artifact, undefined);
  assert.ok(DEFAULT_TYPE_REGISTRY.goal);
  assert.equal(DEFAULT_TYPE_REGISTRY.goal.tier ?? "base", "base");
});

test("plugin surfaces: no workspacePointer registry/settings write path", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pluginFiles = ["registry-pane.ts", "settings.ts", "ui-controls.ts", "view.ts"];
  const sources = await Promise.all(
    pluginFiles.map((name) => fs.readFile(path.join(root, "src", "plugin", name), "utf8"))
  );
  for (const src of sources) {
    assert.doesNotMatch(src, /workspacePointer\s*:/);
    assert.doesNotMatch(src, /workspacePointer:\s*true/);
    assert.doesNotMatch(src, /setBaseWorkspacePointer/);
    assert.doesNotMatch(src, /"workspacePointer"/);
    // Retired product phrase must not reappear in user-facing plugin copy/prompts
    assert.doesNotMatch(src, /workspace pointer/i);
  }
  // Type chrome / coordination capability UI removed from plugin settings/registry.
  const [registryPane, settingsSrc, , viewSrc] = sources;
  assert.doesNotMatch(registryPane, /updateTypeMetadata|baseDefinitionCoordination|setBaseCoordination/);
  assert.doesNotMatch(settingsSrc, /setBaseCoordination|baseDefinitionCoordination/);
  // genesis clipboard prompt uses in-workspace / workspace-root language
  assert.match(viewSrc, /workspace root/i);
  assert.match(viewSrc, /in-workspace/i);
  assert.doesNotMatch(viewSrc, /workspace pointer/i);
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
