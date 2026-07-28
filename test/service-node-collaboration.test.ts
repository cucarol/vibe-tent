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
import {
  CLIENT_METHODS,
  isClientMethod,
  RPC_COLLAB_AMBIGUOUS,
} from "../src/service/types.js";
import type {
  NodeCollaboration,
  NodeCollaborationsResult,
} from "../src/service/types.js";
import { writeTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";

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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
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
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    const bare = (await client.nodeCollaboration(workspaceId, {
      id: note2.id,
    })) as NodeCollaboration;
    assert.ok(bare.task);
    assert.equal(bare.task!.sessionId, undefined);
    assert.equal(bare.session, null);
  });
});

test("node.collaboration: multi-active direct claims fail loud with nodeId + taskIds", async () => {
  const ws = await makeWorkspace("multi-active");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "corrupt-node" });

    // First active task via normal dispatch.
    const d1 = (await client.taskDispatch(workspaceId, {
      boxId: note.id,
      role: "executor",
      prompt: "first",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string; taskId?: string };
    // Second active task written under a different role lane (corrupt dual claim).
    const fsa = new NodeFs(path.join(ws, ".tent"));
    const secondPath = await writeTaskEnvelope(
      fsa,
      { now: () => "2026-01-01T00:00:00.000Z" },
      {
        role: "planner",
        claims: [{ id: note.id, path: note.path }],
        manifestPath: "temp/planner/manifests/corrupt.yml",
        userPrompt: "second corrupt claim",
        id: "tk-corrupt2",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
      }
    );
    assert.ok(secondPath);

    const t1 = (await client.taskGet(workspaceId, d1.taskPath)) as {
      task: { id?: string; path: string };
    };
    const id1 = t1.task.id || t1.task.path;
    const id2 = "tk-corrupt2";

    const single = await client.tryCall("node.collaboration", {
      workspaceId,
      id: note.id,
    });
    assert.equal(single.ok, false);
    if (!single.ok) {
      assert.equal(single.error.code, RPC_COLLAB_AMBIGUOUS);
      assert.match(single.error.message, /Multiple active tasks/i);
      const data = single.error.data as { nodeId?: string; taskIds?: string[] };
      assert.equal(data.nodeId, note.id);
      assert.ok(Array.isArray(data.taskIds));
      assert.equal(data.taskIds!.length, 2);
      assert.ok(data.taskIds!.includes(id1));
      assert.ok(data.taskIds!.includes(id2));
    }

    const batch = await client.tryCall("node.collaborations", {
      workspaceId,
      ids: [note.id],
    });
    assert.equal(batch.ok, false);
    if (!batch.ok) {
      assert.equal(batch.error.code, RPC_COLLAB_AMBIGUOUS);
      const data = batch.error.data as { nodeId?: string; taskIds?: string[] };
      assert.equal(data.nodeId, note.id);
      assert.equal(data.taskIds!.length, 2);
    }
  });
});

test("node.collaborations: duplicate ids preserve order and project same item", async () => {
  const ws = await makeWorkspace("dup-ids");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "dup-item" });
    await client.taskDispatch(workspaceId, {
      boxId: note.id,
      role: "executor",
      prompt: "dup",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });

    const batch = (await client.nodeCollaborations(workspaceId, [
      note.id,
      note.id,
      note.id,
    ])) as NodeCollaborationsResult;
    assert.equal(batch.items.length, 3);
    assert.deepEqual(
      batch.items.map((x) => x.nodeId),
      [note.id, note.id, note.id]
    );
    for (const item of batch.items) {
      assert.ok(item.task);
      assert.equal(item.task!.state, "queued");
      assert.equal(item.task!.id, batch.items[0]!.task!.id);
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
      boxId: child.id,
      role: "executor",
      prompt: "occupy child only",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });

    const childItem = (await client.nodeCollaboration(workspaceId, {
      id: child.id,
    })) as NodeCollaboration;
    assert.ok(childItem.task);
    assert.equal(childItem.task!.state, "queued");

    const parentItem = (await client.nodeCollaboration(workspaceId, {
      id: parent.id,
    })) as NodeCollaboration;
    assertIdle(parentItem, parent.id, workspaceId);
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
      boxId: n1.id,
      role: "executor",
      prompt: "interrupt me",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, d1.taskPath);
    await client.taskInterrupt(workspaceId, d1.taskPath);
    assertIdle(
      (await client.nodeCollaboration(workspaceId, { id: n1.id })) as NodeCollaboration,
      n1.id,
      workspaceId
    );

    // rejected (terminal, resume:false)
    const n2 = await createNote(svc, workspaceId, { name: "term-rej" });
    const d2 = (await client.taskDispatch(workspaceId, {
      boxId: n2.id,
      role: "executor",
      prompt: "reject me",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, d2.taskPath);
    await client.taskDeliver(workspaceId, d2.taskPath, { summary: "for reject" });
    await client.taskReject(workspaceId, d2.taskPath, "user", {
      resume: false,
      note: "terminal reject",
    });
    assertIdle(
      (await client.nodeCollaboration(workspaceId, { id: n2.id })) as NodeCollaboration,
      n2.id,
      workspaceId
    );

    // failed via envelope patch (service has no public task.fail convenience in all paths)
    const n3 = await createNote(svc, workspaceId, { name: "term-fail" });
    const d3 = (await client.taskDispatch(workspaceId, {
      boxId: n3.id,
      role: "executor",
      prompt: "fail me",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, d3.taskPath);
    const fsa = new NodeFs(path.join(ws, ".tent"));
    await patchTaskEnvelope(fsa, d3.taskPath, { state: "failed" });
    assertIdle(
      (await client.nodeCollaboration(workspaceId, { id: n3.id })) as NodeCollaboration,
      n3.id,
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
      boxId: note.id,
      role: "executor",
      prompt: "stale pointers",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);

    const fsa = new NodeFs(path.join(ws, ".tent"));
    await patchTaskEnvelope(fsa, dispatched.taskPath, {
      sessionId: "ss-does-not-exist",
      activeDeliveryId: "dl-does-not-exist",
    });

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assert.ok(item.task);
    assert.equal(item.task!.state, "running");
    assert.equal(item.task!.sessionId, "ss-does-not-exist");
    assert.equal(item.task!.activeDeliveryId, "dl-does-not-exist");
    assert.equal(item.session, null);
    assert.equal(item.delivery, null);
  });
});

test("node.collaboration: agentProfile projects profileId not role", async () => {
  const ws = await makeWorkspace("profile-assignee");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);
    const note = await createNote(svc, workspaceId, { name: "profile-item" });

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: note.id,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "profile work",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };

    const item = (await client.nodeCollaboration(workspaceId, {
      id: note.id,
    })) as NodeCollaboration;
    assert.ok(item.task);
    assert.equal(item.task!.state, "queued");
    assert.equal(item.task!.assigneeKind, "agentProfile");
    assert.equal(item.task!.profileId, "fake-default");
    assert.equal(item.task!.role, undefined);
    assert.ok(dispatched.taskPath.includes("agent-profiles"));
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
      boxId: active.id,
      role: "executor",
      prompt: "no session bind",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });

    // Unrelated sessions exist on the machine.
    await client.sessionEnter({
      workspaceId,
      roleName: "executor",
      externalKey: "unrelated-probe-a",
      cwd: ws,
    });
    await client.sessionEnter({
      workspaceId,
      roleName: "planner",
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
      const idleItem = (await client.nodeCollaboration(workspaceId, {
        id: idle.id,
      })) as NodeCollaboration;
      assertIdle(idleItem, idle.id, workspaceId);
      assert.equal(probeCount, 0, "idle Node must not probe any session");

      probeCount = 0;
      const activeItem = (await client.nodeCollaboration(workspaceId, {
        id: active.id,
      })) as NodeCollaboration;
      assert.ok(activeItem.task);
      assert.equal(activeItem.task!.sessionId, undefined);
      assert.equal(activeItem.session, null);
      assert.equal(probeCount, 0, "active task without sessionId must not probe");

      probeCount = 0;
      const batchIdle = (await client.nodeCollaborations(workspaceId, [
        idle.id,
        active.id,
      ])) as NodeCollaborationsResult;
      assert.equal(batchIdle.items.length, 2);
      assert.equal(probeCount, 0, "batch without sessionIds must not probe");
    } finally {
      svc.runtime.probe = origProbe;
    }
  });
});

test("node.collaborations: duplicate sessionId probes once", async () => {
  const ws = await makeWorkspace("probe-once");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const workspaceId = await mountWorkspace(svc, ws);

    const entered = (await client.sessionEnter({
      workspaceId,
      roleName: "executor",
      externalKey: "shared-session-probe",
      cwd: ws,
    })) as { session: { sessionId: string } };
    const sessionId = entered.session.sessionId;

    // Unrelated sessions that must not be probed.
    await client.sessionEnter({
      workspaceId,
      roleName: "planner",
      externalKey: "noise-session-1",
      cwd: ws,
    });
    await client.sessionEnter({
      workspaceId,
      roleName: "planner",
      externalKey: "noise-session-2",
      cwd: ws,
    });

    const a = await createNote(svc, workspaceId, { name: "share-a" });
    const b = await createNote(svc, workspaceId, { name: "share-b" });
    const dA = (await client.taskDispatch(workspaceId, {
      boxId: a.id,
      role: "executor",
      prompt: "a",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const dB = (await client.taskDispatch(workspaceId, {
      boxId: b.id,
      role: "executor",
      prompt: "b",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dA.taskPath, sessionId);
    await client.taskClaim(workspaceId, dB.taskPath, sessionId);

    const probed: string[] = [];
    const origProbe = svc.runtime.probe.bind(svc.runtime);
    svc.runtime.probe = async (id: string) => {
      probed.push(id);
      return origProbe(id);
    };

    try {
      const batch = (await client.nodeCollaborations(workspaceId, [
        a.id,
        b.id,
        a.id,
      ])) as NodeCollaborationsResult;
      assert.equal(batch.items.length, 3);
      for (const item of batch.items) {
        assert.ok(item.task);
        assert.equal(item.task!.sessionId, sessionId);
        assert.ok(item.session);
        assert.equal(item.session!.id, sessionId);
      }
      assert.deepEqual(
        probed,
        [sessionId],
        `expected single probe of shared sessionId, got ${JSON.stringify(probed)}`
      );
    } finally {
      svc.runtime.probe = origProbe;
    }
  });
});
