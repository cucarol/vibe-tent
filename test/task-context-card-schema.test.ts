import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_CONTEXT_CARD_SCHEMA_VERSION,
  TaskContextCardSchemaError,
  buildTaskContextCardRecord,
  formatTaskContextCardMarkdown,
  normalizeTaskContextCard,
  serializeTaskContextCard,
} from "../src/core/task-context-card-schema.js";

function card() {
  return {
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    nodeIds: ["cx-work", "cx-context"],
    nodeSnapshots: ["cx-work", "cx-context"].map((id) => ({
      id,
      path: `Nodes/${id}`,
      type: "reference",
      archived: false,
      tags: [],
      body: `${id} frozen`,
      etag: "a".repeat(24),
    })),
    contextGeneration: `cg-v1-${"b".repeat(64)}`,
  };
}

test("Task Context Card is the minimal frozen Node context wire", () => {
  const value = card();
  assert.deepEqual(normalizeTaskContextCard(value), value);
  assert.deepEqual(serializeTaskContextCard(value), value);
});

test("Task Context Card rejects retired prompt mirrors, refs, and digest", () => {
  for (const retired of [
    "objective",
    "acceptance",
    "frozenDecisions",
    "scope",
    "refs",
    "taskDeltaDigest",
  ]) {
    assert.throws(
      () =>
        normalizeTaskContextCard({
          ...card(),
          [retired]:
            retired === "refs"
              ? { nodes: [] }
              : retired === "taskDeltaDigest"
                ? "c".repeat(64)
                : [],
        }),
      TaskContextCardSchemaError
    );
  }
  assert.throws(
    () => normalizeTaskContextCard({ ...card(), schemaVersion: "v1" }),
    new RegExp(`schemaVersion must be ${TASK_CONTEXT_CARD_SCHEMA_VERSION}`)
  );
});

test("Task Context Card requires exact ordered snapshots and generation", () => {
  assert.throws(
    () =>
      normalizeTaskContextCard({
        ...card(),
        nodeSnapshots: [...card().nodeSnapshots].reverse(),
      }),
    TaskContextCardSchemaError
  );
  assert.throws(
    () => normalizeTaskContextCard({ ...card(), contextGeneration: "cg-v1-bad" }),
    TaskContextCardSchemaError
  );
});

test("Task Context Card contains only Node context and optional generation", () => {
  const value = card();
  const built = buildTaskContextCardRecord({
    nodeIds: [...value.nodeIds],
    nodeSnapshots: value.nodeSnapshots,
    contextGeneration: value.contextGeneration,
  });
  assert.deepEqual(built, value);
  assert.equal("prompt" in built, false);
  assert.equal("objective" in built, false);
  assert.equal("taskDeltaDigest" in built, false);
});

test("Task Context Card prompt emits each frozen Node body exactly once", () => {
  const text = formatTaskContextCardMarkdown(card());
  assert.match(text, /^Tent Task Context Card v3/);
  assert.match(text, /--- Node cx-work ---/);
  assert.match(text, /--- Node cx-context ---/);
  assert.equal(text.split("cx-work frozen").length - 1, 1);
  assert.equal(text.split("cx-context frozen").length - 1, 1);
  assert.doesNotMatch(text, /objective:|acceptance:|refs\.nodes|taskDeltaDigest/);
});
