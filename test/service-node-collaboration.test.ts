/**
 * V0.2 Node-keyed collaboration projection:
 * node.collaboration / node.collaborations (task-api §2.3).
 * Singular exact-Node occupation; Session/Delivery via explicit ids.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { nodeNotePath } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  CLIENT_METHODS,
  isClientMethod,
} from "../src/service/types.js";
import type {
  NodeCollaboration,
  NodeCollaborationsResult,
} from "../src/service/types.js";
import { patchTaskEnvelope } from "../src/core/task.js";

const FAKE_CONNECTION = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
} as const;

async function makeWorkspace(name = "node-collab"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-collab-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { id: "rl-planner", name: "planner", prompt: "plan" },
          { id: "rl-executor", name: "executor", prompt: "do work" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-collab-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true, connections: [FAKE_CONNECTION] });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountWorkspace(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string
): Promise<string> {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  return (mounted.result as { workspaceId: string }).workspaceId;
}

async function createNote(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  opts: { name: string; type?: string; parentPath?: string }
): Promise<{ nodeId: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: opts.name,
    type: opts.type ?? "prompt",
    ...(opts.parentPath ? { parentPath: opts.parentPath } : {}),
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { nodeId: string; path: string };
}

async function claimRoleTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  client: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  workspace: string,
  taskPath: string
): Promise<void> {
  const entered = (await client.sessionEnter({
    workspaceId,
    roleId: "rl-executor",
    externalKey: `node-collaboration:${taskPath}`,
    cwd: workspace,
  })) as { session: { sessionId: string }; sessionToken: string };
  const roleClient = createServiceClient({
    baseUrl: svc.url,
    token: svc.token,
    currentSessionId: entered.session.sessionId,
    currentSessionToken: entered.sessionToken,
  });
  await roleClient.taskClaim(workspaceId, taskPath);
}

async function removeNodeId(ws: string, nodePath: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = nodeNotePath(nodePath);
  const raw = await fsa.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  delete data.id;
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

function assertCanonicalShape(item: NodeCollaboration): void {
  assert.equal("activeTasks" in item, false);
  assert.equal("activeTaskCount" in item, false);
  assert.equal("totalCount" in item, false, "no totalCount pre-seed");
  assert.equal("page" in item, false, "no pagination pre-seed");
  assert.equal("pageSize" in item, false, "no pageSize pre-seed");
  assert.equal("hasMore" in item, false, "no truncation/hasMore pre-seed");
  assert.equal("cursor" in item, false, "no cursor pre-seed");
  assert.equal("nextCursor" in item, false, "no nextCursor pre-seed");
}

function assertIdle(item: NodeCollaboration, nodeId: string, workspaceId: string): void {
  assert.equal(item.workspaceId, workspaceId);
  assert.equal(item.nodeId, nodeId);
  assertCanonicalShape(item);
  assert.equal(item.activeTask, null);
  assert.equal("task" in item, false);
  assert.equal("session" in item, false);
  assert.equal("delivery" in item, false);
  assert.equal("activeTaskId" in item, false);
  assert.equal("status" in item, false);
  assert.equal("assignee" in item, false);
  assert.equal("owner" in item, false);
  assert.equal("coordination" in item, false);
}

function primaryEntry(item: NodeCollaboration) {
  assertCanonicalShape(item);
  assert.ok(item.activeTask, "expected active task");
  return item.activeTask!;
}

test("CLIENT_METHODS includes node.collaboration(s) as V0.2 truth", () => {
  assert.ok(isClientMethod("node.collaboration"));
  assert.ok(isClientMethod("node.collaborations"));
  assert.ok(CLIENT_METHODS.includes("node.collaboration"));
  assert.ok(CLIENT_METHODS.includes("node.collaborations"));
  assert.equal(isClientMethod("box.projection"), false);
  assert.equal(isClientMethod("box.projections"), false);
});

test("node.collaboration: idle Node has null activeTask", async () => {
  const ws = await makeWorkspace("idle");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "idle-item" });

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    assertIdle(item, note.nodeId, workspaceId);
  });
});

test("node.collaboration: running Task projects raw state + assignee; no session/delivery", async () => {
  const ws = await makeWorkspace("running");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "run-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "do running work",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, dispatched.taskPath);

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    assert.equal(item.workspaceId, workspaceId);
    assert.equal(item.nodeId, note.nodeId);
    const entry = primaryEntry(item);
    assert.equal(entry.task.state, "running");
    assert.equal(entry.task.roleId, "rl-executor");
    assert.ok(entry.task.id);
    assert.match(entry.task.sessionId ?? "", /^ss-/);
    assert.equal(entry.task.activeDeliveryId, undefined);
    assert.equal(entry.session?.id, entry.task.sessionId);
    assert.equal(entry.delivery, null);

    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { id?: string; path: string; state: string };
    };
    assert.ok(
      entry.task.id === task.task.id || entry.task.id === task.task.path,
      `task.id=${entry.task.id}`
    );
  });
});

test("node.collaboration: waiting Task projects raw waiting state", async () => {
  const ws = await makeWorkspace("waiting");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "wait-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "need input",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, dispatched.taskPath);
    await client.taskWait(workspaceId, dispatched.taskPath, "user-input", "Need criteria");

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    const entry = primaryEntry(item);
    assert.equal(entry.task.state, "waiting");
    assert.equal(entry.task.roleId, "rl-executor");
    assert.equal(entry.session?.id, entry.task.sessionId);
    assert.equal(entry.delivery, null);
  });
});

test("node.collaboration: delivered Task attaches Delivery summary via activeDeliveryId", async () => {
  const ws = await makeWorkspace("delivered");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "deliver-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "ship for review",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, dispatched.taskPath);
    await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "ready for review",
    });

    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: {
        id?: string;
        state: string;
        activeDeliveryId?: string;
      };
    };
    assert.equal(task.task.state, "delivered");
    assert.ok(task.task.activeDeliveryId);

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    const entry = primaryEntry(item);
    assert.equal(entry.task.state, "delivered");
    assert.equal(entry.task.activeDeliveryId, task.task.activeDeliveryId);
    assert.ok(entry.delivery);
    assert.equal(entry.delivery!.id, task.task.activeDeliveryId);
    assert.equal(entry.delivery!.status, "ready");
    assert.equal(entry.session?.id, entry.task.sessionId);
  });
});

test("node.collaboration: accepted Task clears occupation (empty activeTasks)", async () => {
  const ws = await makeWorkspace("accepted");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "accept-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "finish",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, dispatched.taskPath);
    const delivered = (await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "done",
    })) as { delivery: { id: string } };
    await client.taskAccept(workspaceId, delivered.delivery.id, "user");

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    assertIdle(item, note.nodeId, workspaceId);
  });
});

test("node.collaborations: order preserved; empty ids → empty items", async () => {
  const ws = await makeWorkspace("batch-order");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);

    const a = await createNote(svc, workspaceId, { name: "item-a" });
    const b = await createNote(svc, workspaceId, { name: "item-b" });
    const c = await createNote(svc, workspaceId, { name: "item-c" });

    await client.taskDispatch(workspaceId, {
      workNodeIds: [a.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "work a",
      parentActor: { kind: "user", id: "user" },
    });

    const empty = (await client.nodeCollaborations(
      workspaceId,
      []
    )) as NodeCollaborationsResult;
    assert.equal(empty.workspaceId, workspaceId);
    assert.deepEqual(empty.items, []);

    const ids = [c.nodeId, a.nodeId, b.nodeId];
    const batch = (await client.nodeCollaborations(
      workspaceId,
      ids
    )) as NodeCollaborationsResult;
    assert.equal(batch.items.length, 3);
    assert.deepEqual(
      batch.items.map((x) => x.nodeId),
      ids
    );
    assertIdle(batch.items[0]!, c.nodeId, workspaceId);
    assert.equal((batch.items[1]!.activeTask ? 1 : 0), 1);
    assert.equal(batch.items[1]!.activeTask!.task.state, "queued");
    assertIdle(batch.items[2]!, b.nodeId, workspaceId);

    // Single matches batch item-for-item.
    for (let i = 0; i < ids.length; i++) {
      const single = (await client.nodeCollaboration(workspaceId, ids[i])) as NodeCollaboration;
      const item = batch.items[i]!;
      assert.equal(item.nodeId, single.nodeId);
      assert.equal((item.activeTask ? 1 : 0), (single.activeTask ? 1 : 0));
      assert.equal(item.activeTask?.task.id, single.activeTask?.task.id);
      assert.equal(item.activeTask?.task.state, single.activeTask?.task.state);
      assert.equal(item.activeTask?.session?.id, single.activeTask?.session?.id);
      assert.equal(item.activeTask?.delivery?.id, single.activeTask?.delivery?.id);
    }
  });
});

test("node.collaborations: missing/invalid ids fail loud", async () => {
  const ws = await makeWorkspace("batch-errors");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const ok = await createNote(svc, workspaceId, { name: "ok-item" });

    const missing = await client.tryCall("node.collaborations", {
      workspaceId,
      nodeIds: [ok.nodeId, "cx-doesnotexist"],
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, -32004);
      assert.match(missing.error.message, /not found/i);
    }

    const noIds = await client.tryCall("node.collaborations", { workspaceId });
    assert.equal(noIds.ok, false);
    if (!noIds.ok) {
      assert.equal(noIds.error.code, -32602);
    }

    const blank = await client.tryCall("node.collaborations", {
      workspaceId,
      nodeIds: [ok.nodeId, "  "],
    });
    assert.equal(blank.ok, false);
    if (!blank.ok) {
      assert.equal(blank.error.code, -32602);
    }

    const again = await createNote(svc, workspaceId, { name: "invalid-item" });
    const strippedId = again.nodeId;
    await removeNodeId(ws, again.path);
    const invalid = await client.tryCall("node.collaborations", {
      workspaceId,
      nodeIds: [strippedId],
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, -32004);
    }

    // Single-item missing
    const singleMissing = await client.tryCall("node.collaboration", {
      workspaceId,
      nodeId: "cx-missingsingle",
    });
    assert.equal(singleMissing.ok, false);
    if (!singleMissing.ok) {
      assert.equal(singleMissing.error.code, -32004);
    }
  });
});

test("node.collaboration: parent and child Nodes are independently occupied", async () => {
  const ws = await makeWorkspace("direct-vs-ancestor");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const parent = await createNote(svc, workspaceId, { name: "parent-goal", type: "goal" });
    const child = await createNote(svc, workspaceId, {
      name: "child-note",
      parentPath: parent.path,
    });

    await client.taskDispatch(workspaceId, {
      workNodeIds: [parent.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "occupy parent",
      parentActor: { kind: "user", id: "user" },
    });
    await client.taskDispatch(workspaceId, {
      workNodeIds: [child.nodeId],
      contextNodeIds: [],
      roleId: "rl-planner",
      prompt: "occupy child",
      parentActor: { kind: "user", id: "user" },
    });

    const parentItem = (await client.nodeCollaboration(workspaceId, parent.nodeId)) as NodeCollaboration;
    const parentEntry = primaryEntry(parentItem);
    assert.equal(parentEntry.task.state, "queued");
    assert.equal(parentEntry.task.roleId, "rl-executor");

    const childItem = (await client.nodeCollaboration(workspaceId, child.nodeId)) as NodeCollaboration;
    const childEntry = primaryEntry(childItem);
    assert.equal(childEntry.task.state, "queued");
    assert.equal(childEntry.task.roleId, "rl-planner");

    const batch = (await client.nodeCollaborations(workspaceId, [
      child.nodeId,
      parent.nodeId,
    ])) as NodeCollaborationsResult;
    assert.equal((batch.items[0]!.activeTask ? 1 : 0), 1);
    assert.equal(batch.items[0]!.nodeId, child.nodeId);
    assert.equal((batch.items[1]!.activeTask ? 1 : 0), 1);
    assert.equal(batch.items[1]!.nodeId, parent.nodeId);
  });
});

test("task.claim rejects Session selectors and derives exact transport binding", async () => {
  const ws = await makeWorkspace("session-link");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "session-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "bind session",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };

    const rejected = await rpc(svc, "task.claim", {
      workspaceId,
      taskPath: dispatched.taskPath,
      sessionId: "ss-cross-task-selector",
    });
    assert.equal(rejected.error?.code, -32602);
    assert.match(rejected.error?.message ?? "", /unknown parameter: sessionId/);

    let task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { sessionId?: string; state: string };
    };
    assert.equal(task.task.state, "queued", "rejected selector must not claim the Task");
    assert.equal(task.task.sessionId, undefined);

    await claimRoleTask(svc, client, workspaceId, ws, dispatched.taskPath);
    task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { sessionId?: string; state: string };
    };
    assert.equal(task.task.state, "running");
    assert.match(task.task.sessionId ?? "", /^ss-/);

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    const entry = primaryEntry(item);
    assert.equal(entry.task.sessionId, task.task.sessionId);
    assert.equal(entry.session?.id, task.task.sessionId);
    assert.equal(entry.delivery, null);
  });
});

test("node.collaboration: exact Node occupation and multi-Node projection", async () => {
  const ws = await makeWorkspace("node-occupation");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const first = await createNote(svc, workspaceId, { name: "occupied-node" });
    const second = await createNote(svc, workspaceId, { name: "second-node" });
    const third = await createNote(svc, workspaceId, { name: "third-node" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [first.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "occupy one exact Node",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };

    const blocked = await client.tryCall("task.dispatch", {
      workspaceId,
      workNodeIds: [first.nodeId],
      contextNodeIds: [],
      roleId: "rl-planner",
      prompt: "second exact Node task",
      parentActor: { kind: "user", id: "user" },
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.match(blocked.error.message, /occupied by active task/i);
    }

    const occupied = (await client.nodeCollaboration(workspaceId, first.nodeId)) as NodeCollaboration;
    assertCanonicalShape(occupied);
    assert.ok(occupied.activeTask);
    const occupiedTask = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { id: string };
    };
    assert.equal(occupied.activeTask!.task.id, occupiedTask.task.id);

    const multi = (await client.taskDispatch(workspaceId, {
      workNodeIds: [second.nodeId, third.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "reference two Nodes",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const multiTask = (await client.taskGet(workspaceId, multi.taskPath)) as {
      task: { id: string };
    };

    for (const nodeId of [second.nodeId, third.nodeId]) {
      const item = (await client.nodeCollaboration(workspaceId, nodeId)) as NodeCollaboration;
      assertCanonicalShape(item);
      assert.equal(item.activeTask?.task.id, multiTask.task.id);
    }

    const multiRaw = await new NodeFs(path.join(ws, ".tent")).readFile(multi.taskPath);
    assert.doesNotMatch(multiRaw, /activeTaskCount/);
  });
});

test("node.collaborations: duplicate ids preserve order and project same item", async () => {
  const ws = await makeWorkspace("dup-ids");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "dup-item" });
    await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "dup",
      parentActor: { kind: "user", id: "user" },
    });

    const batch = (await client.nodeCollaborations(workspaceId, [
      note.nodeId,
      note.nodeId,
      note.nodeId,
    ])) as NodeCollaborationsResult;
    assert.equal(batch.items.length, 3);
    assert.deepEqual(
      batch.items.map((x) => x.nodeId),
      [note.nodeId, note.nodeId, note.nodeId]
    );
    for (const item of batch.items) {
      assert.equal((item.activeTask ? 1 : 0), 1);
      assert.equal(item.activeTask!.task.state, "queued");
      assert.equal(item.activeTask!.task.id, batch.items[0]!.activeTask!.task.id);
    }
  });
});

test("node.collaboration: descendant claim does not paint parent", async () => {
  const ws = await makeWorkspace("desc-claim");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const parent = await createNote(svc, workspaceId, { name: "parent-node", type: "goal" });
    const child = await createNote(svc, workspaceId, {
      name: "child-only",
      parentPath: parent.path,
    });

    await client.taskDispatch(workspaceId, {
      workNodeIds: [child.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "occupy child only",
      parentActor: { kind: "user", id: "user" },
    });

    const childItem = (await client.nodeCollaboration(workspaceId, child.nodeId)) as NodeCollaboration;
    const childEntry = primaryEntry(childItem);
    assert.equal(childEntry.task.state, "queued");

    const parentItem = (await client.nodeCollaboration(workspaceId, parent.nodeId)) as NodeCollaboration;
    assertIdle(parentItem, parent.nodeId, workspaceId);
  });
});

test("node.collaboration: terminal rejected/interrupted/failed clear occupation", async () => {
  const ws = await makeWorkspace("terminals");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);

    // interrupted
    const n1 = await createNote(svc, workspaceId, { name: "term-int" });
    const d1 = (await client.taskDispatch(workspaceId, {
      workNodeIds: [n1.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "interrupt me",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, d1.taskPath);
    await client.taskInterrupt(workspaceId, d1.taskPath);
    assertIdle(
      (await client.nodeCollaboration(workspaceId, n1.nodeId )) as NodeCollaboration,
      n1.nodeId,
      workspaceId
    );

    // rejected (terminal, resume:false)
    const n2 = await createNote(svc, workspaceId, { name: "term-rej" });
    const d2 = (await client.taskDispatch(workspaceId, {
      workNodeIds: [n2.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "reject me",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, d2.taskPath);
    const delivered = (await client.taskDeliver(workspaceId, d2.taskPath, {
      summary: "for reject",
    })) as { delivery: { id: string } };
    await client.taskReject(workspaceId, delivered.delivery.id, "user", {
      resume: false,
      note: "terminal reject",
    });
    assertIdle(
      (await client.nodeCollaboration(workspaceId, n2.nodeId )) as NodeCollaboration,
      n2.nodeId,
      workspaceId
    );

    // failed via envelope patch (service has no public task.fail convenience in all paths)
    const n3 = await createNote(svc, workspaceId, { name: "term-fail" });
    const d3 = (await client.taskDispatch(workspaceId, {
      workNodeIds: [n3.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "fail me",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, d3.taskPath);
    const fsa = new NodeFs(path.join(ws, ".tent"));
    await patchTaskEnvelope(fsa, d3.taskPath, { state: "failed" });
    assertIdle(
      (await client.nodeCollaboration(workspaceId, n3.nodeId )) as NodeCollaboration,
      n3.nodeId,
      workspaceId
    );
  });
});

test("node.collaboration: stale sessionId/activeDeliveryId keep task, null summaries", async () => {
  const ws = await makeWorkspace("stale-ids");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "stale-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "stale pointers",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await claimRoleTask(svc, client, workspaceId, ws, dispatched.taskPath);

    const fsa = new NodeFs(path.join(ws, ".tent"));
    await patchTaskEnvelope(fsa, dispatched.taskPath, {
      sessionId: "ss-doesnotexist",
      activeDeliveryId: "dl-doesnotexist",
    });

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    const entry = primaryEntry(item);
    assert.equal(entry.task.state, "running");
    assert.equal(entry.task.sessionId, "ss-doesnotexist");
    assert.equal(entry.task.activeDeliveryId, "dl-doesnotexist");
    assert.equal(entry.session, null);
    assert.equal(entry.delivery, null);
  });
});

test("node.collaboration: Connection dispatch projects exact Session binding", async () => {
  const ws = await makeWorkspace("connection-session");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "connection-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [note.nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "Connection work",
      parentActor: { kind: "user", id: "user" },
    })) as {
      taskPath: string;
      sessionId: string;
      session: { session: { connectionId: string } };
    };

    const item = (await client.nodeCollaboration(workspaceId, note.nodeId)) as NodeCollaboration;
    const entry = primaryEntry(item);
    assert.equal(entry.task.sessionId, dispatched.sessionId);
    assert.equal(entry.session?.id, dispatched.sessionId);
    assert.equal(dispatched.session.session.connectionId, "fake-default");
    assert.equal("connectionId" in entry.task, false, "Task identity never exposes Connection");
    assert.ok(dispatched.taskPath.includes("sessions"));
  });
});

test("node.collaboration: idle / no sessionId incurs no session probe", async () => {
  const ws = await makeWorkspace("probe-idle");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const idle = await createNote(svc, workspaceId, { name: "idle-probe" });
    const active = await createNote(svc, workspaceId, { name: "active-no-session" });
    await client.taskDispatch(workspaceId, {
      workNodeIds: [active.nodeId],
      contextNodeIds: [],
      roleId: "rl-executor",
      prompt: "no session bind",
      parentActor: { kind: "user", id: "user" },
    });

    // Unrelated sessions exist on the machine.
    await client.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      externalKey: "unrelated-probe-a",
      cwd: ws,
    });
    await client.sessionEnter({
      workspaceId,
      roleId: "rl-planner",
      externalKey: "unrelated-probe-b",
      cwd: ws,
    });

    let probeCount = 0;
    const origProbe = svc.runtime.probe.bind(svc.runtime);
    svc.runtime.probe = async (sessionId: string) => {
      probeCount += 1;
      return origProbe(sessionId);
    };

    try {
      const idleItem = (await client.nodeCollaboration(workspaceId, idle.nodeId)) as NodeCollaboration;
      assertIdle(idleItem, idle.nodeId, workspaceId);
      assert.equal(probeCount, 0, "idle Node must not probe any session");

      probeCount = 0;
      const activeItem = (await client.nodeCollaboration(workspaceId, active.nodeId)) as NodeCollaboration;
      const activeEntry = primaryEntry(activeItem);
      assert.equal(activeEntry.task.sessionId, undefined);
      assert.equal(activeEntry.session, null);
      assert.equal(probeCount, 0, "active task without sessionId must not probe");

      probeCount = 0;
      const batchIdle = (await client.nodeCollaborations(workspaceId, [
        idle.nodeId,
        active.nodeId,
      ])) as NodeCollaborationsResult;
      assert.equal(batchIdle.items.length, 2);
      assert.equal(probeCount, 0, "batch without sessionIds must not probe");
    } finally {
      svc.runtime.probe = origProbe;
    }
  });
});

test("node.collaborations: duplicate Node requests probe each exact Task Session once", async () => {
  const ws = await makeWorkspace("probe-once");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);

    const a = await createNote(svc, workspaceId, { name: "share-a" });
    const b = await createNote(svc, workspaceId, { name: "share-b" });
    const dA = (await client.taskDispatch(workspaceId, {
      workNodeIds: [a.nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "a",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const dB = (await client.taskDispatch(workspaceId, {
      workNodeIds: [b.nodeId],
      contextNodeIds: [],
      connectionId: "fake-default",
      prompt: "b",
      parentActor: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const startedA = (await client.taskStartSession(workspaceId, {
      taskPath: dA.taskPath,
      callerKind: "user",
    })) as { session: { sessionId: string } };
    const startedB = (await client.taskStartSession(workspaceId, {
      taskPath: dB.taskPath,
      callerKind: "user",
    })) as { session: { sessionId: string } };
    assert.notEqual(startedA.session.sessionId, startedB.session.sessionId);

    const probed: string[] = [];
    const origProbe = svc.runtime.probe.bind(svc.runtime);
    svc.runtime.probe = async (id: string) => {
      probed.push(id);
      return origProbe(id);
    };

    try {
      const batch = (await client.nodeCollaborations(workspaceId, [
        a.nodeId,
        b.nodeId,
        a.nodeId,
      ])) as NodeCollaborationsResult;
      assert.equal(batch.items.length, 3);
      for (const item of batch.items) {
        assert.ok(item.activeTask);
        const expectedSessionId = item.nodeId === a.nodeId
          ? startedA.session.sessionId
          : startedB.session.sessionId;
        assert.equal(item.activeTask!.task.sessionId, expectedSessionId);
        assert.ok(item.activeTask?.session);
        assert.equal(item.activeTask?.session!.id, expectedSessionId);
      }
      assert.equal(
        probed.filter((id) => id === startedA.session.sessionId).length,
        1
      );
      assert.equal(
        probed.filter((id) => id === startedB.session.sessionId).length,
        1
      );
      assert.equal(probed.length, 2, JSON.stringify(probed));
    } finally {
      svc.runtime.probe = origProbe;
    }
  });
});
