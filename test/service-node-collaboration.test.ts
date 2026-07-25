/**
 * V0.2 Node-keyed collaboration projection:
 * node.collaboration / node.collaborations (task-api §2.3).
 * Direct-claim nonterminal Task only; Session/Delivery via explicit ids;
 * no universal todo/doing/done; no ancestor paint.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { boxNotePath } from "../src/core/tree.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import type {
  NodeCollaboration,
  NodeCollaborationsResult,
} from "../src/service/types.js";

async function makeWorkspace(name = "node-collab"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-node-collab-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nNode collaboration projection\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "planner", prompt: "plan" },
          { name: "executor", prompt: "do work" },
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
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
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
): Promise<{ id: string; path: string }> {
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: opts.name,
    type: opts.type ?? "prompt",
    ...(opts.parentPath ? { parentPath: opts.parentPath } : {}),
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return created.result as { id: string; path: string };
}

async function removeBoxId(ws: string, boxPath: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = boxNotePath(boxPath);
  const raw = await fsa.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  delete data.id;
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

function assertIdle(item: NodeCollaboration, nodeId: string, workspaceId: string): void {
  assert.equal(item.workspaceId, workspaceId);
  assert.equal(item.nodeId, nodeId);
  assert.equal(item.task, null);
  assert.equal(item.session, null);
  assert.equal(item.delivery, null);
  assert.equal("status" in item, false);
  assert.equal("assignee" in item, false);
  assert.equal("owner" in item, false);
  assert.equal("coordination" in item, false);
}

test("CLIENT_METHODS includes node.collaboration(s) as V0.2 truth", () => {
  assert.ok(isClientMethod("node.collaboration"));
  assert.ok(isClientMethod("node.collaborations"));
  assert.ok(CLIENT_METHODS.includes("node.collaboration"));
  assert.ok(CLIENT_METHODS.includes("node.collaborations"));
  // Legacy migration surface may remain registered.
  assert.ok(isClientMethod("box.projection"));
  assert.ok(isClientMethod("box.projections"));
});

test("node.collaboration: idle Node → null task/session/delivery", async () => {
  const ws = await makeWorkspace("idle");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "idle-item" });

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assertIdle(item, note.id, workspaceId);
  });
});

test("node.collaboration: running Task projects raw state + role; no session/delivery", async () => {
  const ws = await makeWorkspace("running");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "run-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: note.id,
      role: "executor",
      prompt: "do running work",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assert.equal(item.workspaceId, workspaceId);
    assert.equal(item.nodeId, note.id);
    assert.ok(item.task);
    assert.equal(item.task!.state, "running");
    assert.equal(item.task!.role, "executor");
    assert.equal(item.task!.assigneeKind, "role");
    assert.equal(item.task!.profileId, undefined);
    assert.ok(item.task!.id);
    assert.equal(item.task!.sessionId, undefined);
    assert.equal(item.task!.activeDeliveryId, undefined);
    assert.equal(item.session, null);
    assert.equal(item.delivery, null);

    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { id?: string; path: string; state: string };
    };
    assert.ok(
      item.task!.id === task.task.id || item.task!.id === task.task.path,
      `task.id=${item.task!.id}`
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
      boxId: note.id,
      role: "executor",
      prompt: "need input",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);
    await client.taskWait(workspaceId, dispatched.taskPath, "user-input", "Need criteria");

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assert.ok(item.task);
    assert.equal(item.task!.state, "waiting");
    assert.equal(item.task!.role, "executor");
    assert.equal(item.session, null);
    assert.equal(item.delivery, null);
  });
});

test("node.collaboration: delivered Task attaches Delivery summary via activeDeliveryId", async () => {
  const ws = await makeWorkspace("delivered");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "deliver-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: note.id,
      role: "executor",
      prompt: "ship for review",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);
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

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assert.ok(item.task);
    assert.equal(item.task!.state, "delivered");
    assert.equal(item.task!.activeDeliveryId, task.task.activeDeliveryId);
    assert.ok(item.delivery);
    assert.equal(item.delivery!.id, task.task.activeDeliveryId);
    assert.equal(item.delivery!.status, "ready");
    assert.equal(item.session, null);
  });
});

test("node.collaboration: accepted Task clears occupation (null task)", async () => {
  const ws = await makeWorkspace("accepted");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "accept-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: note.id,
      role: "executor",
      prompt: "finish",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);
    await client.taskDeliver(workspaceId, dispatched.taskPath, { summary: "done" });
    await client.taskAccept(workspaceId, dispatched.taskPath, "user");

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assertIdle(item, note.id, workspaceId);
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
      boxId: a.id,
      role: "executor",
      prompt: "work a",
    });

    const empty = (await client.nodeCollaborations(
      workspaceId,
      []
    )) as NodeCollaborationsResult;
    assert.equal(empty.workspaceId, workspaceId);
    assert.deepEqual(empty.items, []);

    const ids = [c.id, a.id, b.id];
    const batch = (await client.nodeCollaborations(
      workspaceId,
      ids
    )) as NodeCollaborationsResult;
    assert.equal(batch.items.length, 3);
    assert.deepEqual(
      batch.items.map((x) => x.nodeId),
      ids
    );
    assertIdle(batch.items[0]!, c.id, workspaceId);
    assert.ok(batch.items[1]!.task);
    assert.equal(batch.items[1]!.task!.state, "queued");
    assertIdle(batch.items[2]!, b.id, workspaceId);

    // Single matches batch item-for-item.
    for (let i = 0; i < ids.length; i++) {
      const single = (await client.nodeCollaboration(workspaceId, {
        id: ids[i],
      })) as NodeCollaboration;
      const item = batch.items[i]!;
      assert.equal(item.nodeId, single.nodeId);
      assert.equal(item.task?.id, single.task?.id);
      assert.equal(item.task?.state, single.task?.state);
      assert.equal(item.session, single.session);
      assert.equal(item.delivery?.id, single.delivery?.id);
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
      ids: [ok.id, "cx-does-not-exist"],
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
      ids: [ok.id, "  "],
    });
    assert.equal(blank.ok, false);
    if (!blank.ok) {
      assert.equal(blank.error.code, -32602);
    }

    const again = await createNote(svc, workspaceId, { name: "invalid-item" });
    const strippedId = again.id;
    await removeBoxId(ws, again.path);
    const invalid = await client.tryCall("node.collaborations", {
      workspaceId,
      ids: [strippedId],
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, -32004);
    }

    // Single-item missing
    const singleMissing = await client.tryCall("node.collaboration", {
      workspaceId,
      id: "cx-missing-single",
    });
    assert.equal(singleMissing.ok, false);
    if (!singleMissing.ok) {
      assert.equal(singleMissing.error.code, -32004);
    }
  });
});

test("node.collaboration: direct claim only — ancestor occupation does not paint child", async () => {
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
      boxId: parent.id,
      role: "executor",
      prompt: "occupy parent only",
    });

    const parentItem = (await client.nodeCollaboration(workspaceId, {
      id: parent.id,
    })) as NodeCollaboration;
    assert.ok(parentItem.task);
    assert.equal(parentItem.task!.state, "queued");
    assert.equal(parentItem.task!.role, "executor");

    const childItem = (await client.nodeCollaboration(workspaceId, {
      id: child.id,
    })) as NodeCollaboration;
    // Child is not in claims — no ancestor-derived occupation.
    assertIdle(childItem, child.id, workspaceId);

    const batch = (await client.nodeCollaborations(workspaceId, [
      child.id,
      parent.id,
    ])) as NodeCollaborationsResult;
    assertIdle(batch.items[0]!, child.id, workspaceId);
    assert.ok(batch.items[1]!.task);
    assert.equal(batch.items[1]!.nodeId, parent.id);
  });
});

test("node.collaboration: session linkage only through explicit task.sessionId", async () => {
  const ws = await makeWorkspace("session-link");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "session-item" });

    const entered = (await client.sessionEnter({
      workspaceId,
      roleName: "executor",
      externalKey: "node-collab-session-key",
      cwd: ws,
    })) as { session: { sessionId: string; state: string; alive: boolean } };
    const sessionId = entered.session.sessionId;
    assert.ok(sessionId);

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: note.id,
      role: "executor",
      prompt: "bind session",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath, sessionId);

    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { sessionId?: string; state: string };
    };
    assert.equal(task.task.sessionId, sessionId);
    assert.equal(task.task.state, "running");

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assert.ok(item.task);
    assert.equal(item.task!.sessionId, sessionId);
    assert.ok(item.session);
    assert.equal(item.session!.id, sessionId);
    assert.equal(typeof item.session!.state, "string");
    assert.equal(typeof item.session!.alive, "boolean");
    assert.equal(typeof item.session!.turnBusy, "boolean");
    // Delivery not attached without activeDeliveryId.
    assert.equal(item.delivery, null);

    // Without sessionId on task, session stays null even if sessions exist.
    const note2 = await createNote(svc, workspaceId, { name: "no-session-item" });
    await client.taskDispatch(workspaceId, {
      boxId: note2.id,
      role: "executor",
      prompt: "no bind",
    });
    const bare = (await client.nodeCollaboration(workspaceId, {
      id: note2.id,
    })) as NodeCollaboration;
    assert.ok(bare.task);
    assert.equal(bare.task!.sessionId, undefined);
    assert.equal(bare.session, null);
  });
});
