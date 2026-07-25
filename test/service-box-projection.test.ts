/**
 * Service box.projection RPC (task-api §2.3).
 * Layer: CLIENT_METHODS + docs.get resolver + findActiveTaskForBox / boxProjectionOf.
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

type BoxProjectionResult = {
  workspaceId: string;
  boxId: string;
  status: "todo" | "doing" | "done";
  assignee?: string;
  activeTaskId?: string;
};

async function makeWorkspace(name = "box-projection"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-box-proj-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nBox projection service\n",
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-box-proj-data-"));
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

async function mountWorkItem(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  opts?: { name?: string; type?: string; parentPath?: string }
): Promise<{ workspaceId: string; boxId: string; path: string }> {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: opts?.name ?? "work-item",
    type: opts?.type ?? "prompt",
    ...(opts?.parentPath ? { parentPath: opts.parentPath } : {}),
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  const result = created.result as { id: string; path: string };
  return { workspaceId, boxId: result.id, path: result.path };
}

async function writeStaleOwnerDoing(ws: string, boxPath: string, owner: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = boxNotePath(boxPath);
  const raw = await fsa.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  data.owner = owner;
  data.status = "doing";
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

async function removeBoxId(ws: string, boxPath: string): Promise<void> {
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const notePath = boxNotePath(boxPath);
  const raw = await fsa.readFile(notePath);
  const { data, body, keyOrder } = parseFrontmatter(raw);
  delete data.id;
  await fsa.writeFile(notePath, serializeFrontmatter(data, body, keyOrder));
}

test("CLIENT_METHODS includes box.projection", () => {
  assert.ok(isClientMethod("box.projection"));
  assert.ok(CLIENT_METHODS.includes("box.projection"));
});

test("box.projection: idle coordination box → todo, no assignee/activeTaskId", async () => {
  const ws = await makeWorkspace("idle");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const proj = (await client.boxProjection(workspaceId, { id: boxId })) as BoxProjectionResult;
    assert.equal(proj.workspaceId, workspaceId);
    assert.equal(proj.boxId, boxId);
    assert.equal(proj.status, "todo");
    assert.equal(proj.assignee, undefined);
    assert.equal(proj.activeTaskId, undefined);
  });
});

test("box.projection: active task → doing + assignee + activeTaskId", async () => {
  const ws = await makeWorkspace("active");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "ship it",
    })) as { taskPath: string };
    assert.ok(dispatched.taskPath);

    const proj = (await client.boxProjection(workspaceId, { id: boxId })) as BoxProjectionResult;
    assert.equal(proj.workspaceId, workspaceId);
    assert.equal(proj.boxId, boxId);
    assert.equal(proj.status, "doing");
    assert.equal(proj.assignee, "executor");
    assert.ok(proj.activeTaskId);
    // activeTaskId is task id or path — must match the operational envelope.
    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { id?: string; path: string; state: string };
    };
    assert.ok(
      proj.activeTaskId === task.task.id || proj.activeTaskId === task.task.path,
      `activeTaskId=${proj.activeTaskId} task.id=${task.task.id} path=${task.task.path}`
    );
    assert.equal(task.task.state, "queued");
  });
});

test("box.projection: accepted → done (no assignee, no activeTaskId)", async () => {
  const ws = await makeWorkspace("accepted-done");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "finish work",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);
    await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "done via accept",
    });
    await client.taskAccept(workspaceId, dispatched.taskPath, "user");

    const proj = (await client.boxProjection(workspaceId, { id: boxId })) as BoxProjectionResult;
    assert.equal(proj.status, "done");
    assert.equal(proj.assignee, undefined);
    assert.equal(proj.activeTaskId, undefined);
    assert.equal(proj.boxId, boxId);
    assert.equal(proj.workspaceId, workspaceId);
  });
});

test("box.projection: interrupt → todo (clears occupation)", async () => {
  const ws = await makeWorkspace("interrupt-todo");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "stop me",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath);
    await client.taskInterrupt(workspaceId, dispatched.taskPath);

    const proj = (await client.boxProjection(workspaceId, { id: boxId })) as BoxProjectionResult;
    assert.equal(proj.status, "todo");
    assert.equal(proj.assignee, undefined);
    assert.equal(proj.activeTaskId, undefined);
  });
});

test("box.projection: stale owner/doing without active task → todo, no assignee", async () => {
  const ws = await makeWorkspace("stale-owner");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId, path: boxPath } = await mountWorkItem(svc, ws);

    // Persist orphan occupation that no longer has an active task.
    await writeStaleOwnerDoing(ws, boxPath, "ghost-role");

    // docs.get may still show the stale frontmatter; projection must not.
    const doc = (await client.docsGet(workspaceId, { id: boxId })) as {
      concept: { status?: string; assignee?: string };
    };
    assert.equal(doc.concept.status, "doing");
    assert.equal(doc.concept.assignee, "ghost-role");

    const proj = (await client.boxProjection(workspaceId, { id: boxId })) as BoxProjectionResult;
    assert.equal(proj.status, "todo");
    assert.equal(proj.assignee, undefined);
    assert.equal(proj.activeTaskId, undefined);

    // Stale owner must not block a new dispatch (occupation oracle = active task only).
    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "reclaim after orphan owner",
    })) as { taskPath: string };
    assert.ok(dispatched.taskPath);
    const after = (await client.boxProjection(workspaceId, { id: boxId })) as BoxProjectionResult;
    assert.equal(after.status, "doing");
    assert.equal(after.assignee, "executor");
    assert.ok(after.activeTaskId);
  });
});

test("box.projection: resolve by path and by boxId (nested coordination box)", async () => {
  const ws = await makeWorkspace("path-lookup");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    // Parent coordination box, then child — proves projection works anywhere in tree.
    const parent = await mountWorkItem(svc, ws, { name: "parent-goal", type: "goal" });
    const childCreated = await rpc(svc, "docs.createNote", {
      workspaceId: parent.workspaceId,
      name: "nested-item",
      type: "prompt",
      parentPath: parent.path,
    });
    assert.ok(!childCreated.error, JSON.stringify(childCreated.error));
    const child = childCreated.result as { id: string; path: string };

    const byId = (await client.boxProjection(parent.workspaceId, {
      id: child.id,
    })) as BoxProjectionResult;
    const byPath = (await client.boxProjection(parent.workspaceId, {
      path: child.path,
    })) as BoxProjectionResult;
    const byBoxId = (await client.boxProjection(parent.workspaceId, {
      boxId: child.id,
    })) as BoxProjectionResult;

    for (const proj of [byId, byPath, byBoxId]) {
      assert.equal(proj.workspaceId, parent.workspaceId);
      assert.equal(proj.boxId, child.id);
      assert.equal(proj.status, "todo");
      assert.equal(proj.assignee, undefined);
      assert.equal(proj.activeTaskId, undefined);
    }
  });
});

test("box.projection: missing box fails cleanly (-32004)", async () => {
  const ws = await makeWorkspace("missing");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId } = await mountWorkItem(svc, ws);

    const missingId = await client.tryCall("box.projection", {
      workspaceId,
      id: "cx-does-not-exist",
    });
    assert.equal(missingId.ok, false);
    if (!missingId.ok) {
      assert.equal(missingId.error.code, -32004);
      assert.match(missingId.error.message, /not found/i);
    }

    const missingPath = await client.tryCall("box.projection", {
      workspaceId,
      path: "no/such/path",
    });
    assert.equal(missingPath.ok, false);
    if (!missingPath.ok) {
      assert.equal(missingPath.error.code, -32004);
    }

    const noSelector = await client.tryCall("box.projection", { workspaceId });
    assert.equal(noSelector.ok, false);
    if (!noSelector.ok) {
      assert.equal(noSelector.error.code, -32602);
    }
  });
});

test("box.projection: structurally invalid box fails instead of projecting stale state", async () => {
  const ws = await makeWorkspace("invalid");
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, path: boxPath } = await mountWorkItem(svc, ws);
    await removeBoxId(ws, boxPath);

    const invalid = await client.tryCall("box.projection", {
      workspaceId,
      path: boxPath,
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.error.code, -32004);
      assert.match(invalid.error.message, /invalid/i);
    }
  });
});
