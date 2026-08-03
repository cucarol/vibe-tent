import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_CONTEXT_CARD_SCHEMA_VERSION,
  TaskContextCardSchemaError,
  buildTaskContextCardV2,
  computeTaskContextCardDeltaDigest,
  formatTaskContextCardV2Prompt,
  normalizeTaskContextCard,
  serializeTaskContextCard,
} from "../src/core/task-context-card-schema.js";

function card() {
  return {
    schemaVersion: TASK_CONTEXT_CARD_SCHEMA_VERSION,
    workNodeIds: ["cx-work"],
    contextNodeIds: ["cx-context"],
    nodeSnapshots: ["cx-work", "cx-context"].map((id) => ({
      id,
      path: `Nodes/${id}`,
      type: "reference",
      tags: [],
      body: `${id} frozen`,
      etag: "a".repeat(24),
    })),
    contextGeneration: `cg-v1-${"b".repeat(64)}`,
    taskDeltaDigest: "c".repeat(64),
  };
}

test("Task Context Card is the minimal frozen Node context wire", () => {
  const value = card();
  assert.deepEqual(normalizeTaskContextCard(value), value);
  assert.deepEqual(serializeTaskContextCard(value), value);
});

test("Task Context Card rejects v1 prompt mirrors and generic refs", () => {
  for (const retired of ["objective", "acceptance", "frozenDecisions", "scope", "refs"]) {
    assert.throws(
      () => normalizeTaskContextCard({ ...card(), [retired]: retired === "refs" ? { nodes: [] } : [] }),
      TaskContextCardSchemaError
    );
  }
  assert.throws(
    () => normalizeTaskContextCard({ ...card(), schemaVersion: "v1" }),
    /schemaVersion must be v2/
  );
});

test("Task Context Card requires exact ordered snapshots and digests", () => {
  assert.throws(
    () => normalizeTaskContextCard({ ...card(), nodeSnapshots: [...card().nodeSnapshots].reverse() }),
    TaskContextCardSchemaError
  );
  assert.throws(
    () => normalizeTaskContextCard({ ...card(), taskDeltaDigest: "BAD" }),
    TaskContextCardSchemaError
  );
  assert.throws(
    () => normalizeTaskContextCard({ ...card(), contextGeneration: "cg-v1-bad" }),
    TaskContextCardSchemaError
  );
});

test("Task Context Card delta digest includes the prompt once without mirroring it", () => {
  const value = card();
  const built = buildTaskContextCardV2({
    workNodeIds: value.workNodeIds,
    contextNodeIds: value.contextNodeIds,
    nodeSnapshots: value.nodeSnapshots,
    contextGeneration: value.contextGeneration,
    userPrompt: "Implement the frozen goal.",
  });
  assert.equal(
    built.taskDeltaDigest,
    computeTaskContextCardDeltaDigest({
      nodeContext: value,
      userPrompt: "Implement the frozen goal.",
    })
  );
  assert.equal("userPrompt" in built, false);
  assert.equal("objective" in built, false);
  assert.notEqual(
    built.taskDeltaDigest,
    computeTaskContextCardDeltaDigest({
      nodeContext: value,
      userPrompt: "A different attempt.",
    })
  );
});

test("Task Context Card prompt emits each frozen Node body exactly once", () => {
  const text = formatTaskContextCardV2Prompt(card());
  assert.match(text, /^Tent Task Context Card v2/);
  assert.match(text, /--- Work Node cx-work ---/);
  assert.match(text, /--- Context Node cx-context ---/);
  assert.equal(text.split("cx-work frozen").length - 1, 1);
  assert.equal(text.split("cx-context frozen").length - 1, 1);
  assert.doesNotMatch(text, /objective:|acceptance:|refs\.nodes/);
});
