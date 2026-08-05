import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskNodeSnapshotError,
  captureTaskNodeSnapshot,
  normalizeTaskNodeSnapshot,
  normalizeTaskNodeSnapshots,
} from "../src/core/task-node-snapshot.js";
import type { Node } from "../src/core/types.js";

const A = "cx-a1b2c3";
const B = "cx-d4e5f6";

function snapshot(id = A) {
  return {
    id,
    path: `Goals/${id}`,
    type: "goal-reference",
    tags: ["release", "review"],
    body: "Frozen body\n",
    etag: "a".repeat(24),
  };
}

test("Task Node snapshots preserve semantic content and canonicalize identity metadata", () => {
  assert.deepEqual(
    normalizeTaskNodeSnapshot({
      ...snapshot(),
      path: ".\\Goals\\cx-a1b2c3",
      type: " goal-reference ",
      tags: ["release", "release", " review "],
    }),
    snapshot()
  );
});

test("Task Node snapshots reject partial, extensible, and non-canonical records", () => {
  const invalid: unknown[] = [
    { ...snapshot(), body: undefined },
    { ...snapshot(), path: "../outside" },
    { ...snapshot(), path: "Goals//bad" },
    { ...snapshot(), etag: "stale" },
    { ...snapshot(), tags: [""] },
    { ...snapshot(), extra: true },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeTaskNodeSnapshot(value), TaskNodeSnapshotError);
  }
});

test("Task Node snapshots exactly cover ordered work then context refs", () => {
  const snapshots = [snapshot(A), snapshot(B)];
  const selection = { workNodeIds: [A], contextNodeIds: [B] };
  assert.deepEqual(normalizeTaskNodeSnapshots(snapshots, selection), snapshots);
  assert.throws(
    () => normalizeTaskNodeSnapshots(snapshots, { workNodeIds: [B], contextNodeIds: [A] }),
    TaskNodeSnapshotError
  );
  assert.throws(
    () => normalizeTaskNodeSnapshots(snapshots, { workNodeIds: [A], contextNodeIds: [] }),
    TaskNodeSnapshotError
  );
  assert.throws(
    () => normalizeTaskNodeSnapshots(snapshots, { workNodeIds: [A], contextNodeIds: [A] }),
    Error
  );
});

test("captureTaskNodeSnapshot copies the loaded Node semantic view", () => {
  const node: Node = {
    id: A,
    path: "Goals/cx-a1b2c3",
    name: "cx-a1b2c3",
    type: "goal-reference",
    tags: ["release", "review"],
    relations: [],
    mode: "editable",
    archived: false,
    invalid: false,
    fm: { id: A, type: "goal-reference", tags: ["release", "review"] },
    etag: "a".repeat(24),
    body: "Frozen body\n",
    children: [],
    parent: null,
  };
  assert.deepEqual(captureTaskNodeSnapshot(node, "a".repeat(24)), snapshot());
});
