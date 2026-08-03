import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PendingDecisionRequest } from "../src/core/decision-request.js";
import {
  DecisionRequestStore,
  makeDecisionRequestId,
} from "../src/service/decision-request-store.js";

function request(id = "dr-0123456789"): PendingDecisionRequest {
  return {
    id,
    taskId: "tk-taskone",
    requester: { kind: "session", id: "ss-session1" },
    target: { kind: "role", id: "rl-reviewer" },
    question: "Choose the durable direction.",
    options: [
      { id: "a", label: "Direction A" },
      { id: "b", label: "Direction B" },
    ],
    status: "pending",
  };
}

async function withStore(
  run: (store: DecisionRequestStore, dataDir: string) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tent-decision-store-"));
  const store = new DecisionRequestStore(dataDir);
  try {
    await run(store, dataDir);
  } finally {
    await store.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("DecisionRequestStore persists exact-Task pending requests and reloads them", async () => {
  await withStore(async (store, dataDir) => {
    const added = await store.add({
      workspaceId: "ws-one",
      taskPath: "temp/roles/rl-owner/tasks/task.md",
      request: request(),
    });
    assert.equal(added.status, "pending");
    assert.equal((await store.listPending("ws-one")).length, 1);
    assert.equal((await store.listPending("ws-other")).length, 0);
    assert.equal(
      await store.getExact("ws-one", "temp/other/task.md", added.id),
      undefined
    );

    const reloaded = new DecisionRequestStore(dataDir);
    try {
      const exact = await reloaded.getExact(
        "ws-one",
        "temp/roles/rl-owner/tasks/task.md",
        added.id
      );
      assert.deepEqual(exact, added);
    } finally {
      await reloaded.shutdown();
    }
  });
});

test("DecisionRequestStore answers once and retries the exact same answer idempotently", async () => {
  await withStore(async (store) => {
    const taskPath = "temp/roles/rl-owner/tasks/task.md";
    const added = await store.add({ workspaceId: "ws-one", taskPath, request: request() });
    const input = {
      workspaceId: "ws-one",
      taskPath,
      requestId: added.id,
      responder: { kind: "role", id: "rl-reviewer" } as const,
      response: { kind: "option", optionId: "b" } as const,
    };
    const answered = await store.answerExact(input);
    assert.equal(answered.status, "answered");
    assert.deepEqual(await store.answerExact(input), answered);
    await assert.rejects(
      store.answerExact({ ...input, response: { kind: "deny" } }),
      /already answered differently/
    );
    await assert.rejects(
      store.answerExact({ ...input, workspaceId: "ws-other" }),
      /not found for exact Task/
    );
  });
});

test("DecisionRequestStore durably removes only the exact Task pending request", async () => {
  await withStore(async (store, dataDir) => {
    const taskPath = "temp/roles/rl-owner/tasks/task.md";
    const added = await store.add({ workspaceId: "ws-one", taskPath, request: request() });
    await store.add({
      workspaceId: "ws-two",
      taskPath,
      request: request("dr-abcdefghjk"),
    });
    assert.equal(await store.removePendingForTask("ws-other", taskPath), undefined);
    assert.deepEqual(await store.removePendingForTask("ws-one", taskPath), added);
    assert.equal(await store.getPendingForTask("ws-one", taskPath), undefined);

    const reloaded = new DecisionRequestStore(dataDir);
    try {
      assert.equal(await reloaded.getExact("ws-one", taskPath, added.id), undefined);
      assert.equal((await reloaded.listPending("ws-two")).length, 1);
    } finally {
      await reloaded.shutdown();
    }
  });
});

test("DecisionRequestStore permits one pending request per exact Task and same-id escalation", async () => {
  await withStore(async (store) => {
    const taskPath = "temp/roles/rl-owner/tasks/task.md";
    const first = await store.add({ workspaceId: "ws-one", taskPath, request: request() });
    await assert.rejects(
      store.add({ workspaceId: "ws-one", taskPath, request: request("dr-abcdefghjk") }),
      /already has a pending decision request/
    );
    await store.add({
      workspaceId: "ws-two",
      taskPath,
      request: request("dr-mnpqrstvw0"),
    });
    const escalated = await store.escalateExact("ws-one", taskPath, first.id);
    assert.equal(escalated.id, first.id);
    assert.deepEqual(escalated.target, { kind: "user", id: "user" });
    assert.deepEqual(
      await store.escalateExact("ws-one", taskPath, first.id),
      escalated
    );
  });
});

test("DecisionRequestStore publishes state only after durable write succeeds", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tent-decision-store-fail-"));
  let fail = true;
  const store = new DecisionRequestStore(dataDir, {
    writeState: async (filePath, value) => {
      if (fail) {
        fail = false;
        throw new Error("injected persistence failure");
      }
      await import("../src/machine-state.js").then(({ writeJsonAtomic }) =>
        writeJsonAtomic(filePath, value)
      );
    },
  });
  try {
    const taskPath = "temp/roles/rl-owner/tasks/task.md";
    await assert.rejects(
      store.add({ workspaceId: "ws-one", taskPath, request: request() }),
      /injected persistence failure/
    );
    assert.equal(await store.getPendingForTask("ws-one", taskPath), undefined);
    const added = await store.add({ workspaceId: "ws-one", taskPath, request: request() });
    assert.equal(added.status, "pending");
    const persisted = JSON.parse(
      await readFile(path.join(dataDir, "decision-requests.json"), "utf8")
    ) as { items: unknown[] };
    assert.equal(persisted.items.length, 1);
  } finally {
    await store.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("makeDecisionRequestId produces the hard-cut dr identity", () => {
  assert.match(makeDecisionRequestId(() => 0), /^dr-[0-9a-z]{10}$/);
});
