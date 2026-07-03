import { test } from "node:test";
import assert from "node:assert/strict";
import { typeColorValue } from "../src/plugin/colors.js";
import { TimedCache } from "../src/plugin/timed-cache.js";
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
