/**
 * Service workspace.settings / settings.update + task.dispatch default snapshot.
 * Layer: CLIENT_METHODS + user-only MutationBus + workspace.settings.updated + dispatch.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";

async function makeWorkspace(name = "ws-settings"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-settings-svc-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "executor", prompt: "do work" }] }, null, 2) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-settings-data-"));
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

async function mount(svc: Awaited<ReturnType<typeof startLocalTentService>>, ws: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  return (mounted.result as { workspaceId: string }).workspaceId;
}

async function mountWorkItem(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string
): Promise<{ workspaceId: string; nodeId: string }> {
  const workspaceId = await mount(svc, ws);
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: "work-item",
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return { workspaceId, nodeId: (created.result as { nodeId: string }).nodeId };
}

test("CLIENT_METHODS includes workspace.settings and workspace.settings.update", () => {
  assert.ok(isClientMethod("workspace.settings"));
  assert.ok(isClientMethod("workspace.settings.update"));
  assert.ok(CLIENT_METHODS.includes("workspace.settings"));
  assert.ok(CLIENT_METHODS.includes("workspace.settings.update"));
});

test("workspace.settings: missing file projects defaultDeliveryPolicy=review", async () => {
  const ws = await makeWorkspace("defaults");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const result = (await client.workspaceSettings(workspaceId)) as {
      workspaceId: string;
      settings: { defaultDeliveryPolicy: string };
    };
    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.settings.defaultDeliveryPolicy, "review");
  });
});

test("workspace.settings.update: user-only, MutationBus, one event on actual change, none on no-op", async () => {
  const ws = await makeWorkspace("update-events");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "workspace.settings.updated") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    const denied = await rpc(svc, "workspace.settings.update", {
      workspaceId,
      defaultDeliveryPolicy: "bypass",
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.match(denied.error!.message, /user-only/i);
    assert.equal(events.length, 0);

    const invalid = await rpc(svc, "workspace.settings.update", {
      workspaceId,
      defaultDeliveryPolicy: "nope",
    });
    assert.ok(invalid.error);
    assert.equal(invalid.error!.code, -32602);
    assert.equal(events.length, 0);

    const unknown = await rpc(svc, "workspace.settings.update", {
      workspaceId,
      surpriseBag: true,
    });
    assert.ok(unknown.error);
    assert.equal(unknown.error!.code, -32602);
    assert.match(unknown.error!.message, /unknown workspace setting/i);
    assert.equal(events.length, 0);

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const updated = (await client.workspaceSettingsUpdate(workspaceId, {
      defaultDeliveryPolicy: "bypass",
    })) as {
      settings: { defaultDeliveryPolicy: string };
      changed: boolean;
    };
    assert.equal(updated.settings.defaultDeliveryPolicy, "bypass");
    assert.equal(updated.changed, true);
    assert.equal(events.length, 1);
    assert.equal(
      (events[0]!.settings as { defaultDeliveryPolicy: string }).defaultDeliveryPolicy,
      "bypass"
    );

    // No-op update: same value → success but no event.
    const noop = (await client.workspaceSettingsUpdate(workspaceId, {
      defaultDeliveryPolicy: "bypass",
    })) as { changed: boolean; settings: { defaultDeliveryPolicy: string } };
    assert.equal(noop.changed, false);
    assert.equal(noop.settings.defaultDeliveryPolicy, "bypass");
    assert.equal(events.length, 1, "no-op must not emit workspace.settings.updated");

    // Empty patch against existing file → no-op, no event.
    const empty = await rpc(svc, "workspace.settings.update", { workspaceId });
    assert.ok(!empty.error, JSON.stringify(empty.error));
    assert.equal((empty.result as { changed: boolean }).changed, false);
    assert.equal(events.length, 1);

    // Failed mutation after success still does not add events.
    const failAgain = await rpc(svc, "workspace.settings.update", {
      workspaceId,
      defaultDeliveryPolicy: "invalid",
      actor: "user",
    });
    assert.ok(failAgain.error);
    assert.equal(events.length, 1);

    // Persist on disk under system root.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(ws, ".tent", "settings.json"), "utf8")
    ) as { defaultDeliveryPolicy: string };
    assert.equal(onDisk.defaultDeliveryPolicy, "bypass");

    // Historical wire value `manual` is rejected on new RPC writes.
    const rejectManual = await rpc(svc, "workspace.settings.update", {
      workspaceId,
      defaultDeliveryPolicy: "manual",
      actor: "user",
    });
    assert.ok(rejectManual.error);
    assert.equal(rejectManual.error!.code, -32602);

    unsub();
  });
});

test("task.dispatch: omitted deliveryPolicy snapshots workspace default; explicit overrides", async () => {
  const ws = await makeWorkspace("dispatch-snapshot");
  await withService(async (svc) => {
    const { workspaceId, nodeId: box1 } = await mountWorkItem(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const createNode = async (name: string): Promise<string> => {
      const created = await rpc(svc, "docs.createNote", {
        workspaceId,
        name,
        type: "prompt",
      });
      assert.ok(!created.error, JSON.stringify(created.error));
      return (created.result as { nodeId: string }).nodeId;
    };
    const box2 = await createNode("work-item-two");
    const box3 = await createNode("work-item-three");

    // Default (no settings file) → review
    const d1 = (await client.taskDispatch(workspaceId, {
      nodeIds: [box1],
      role: "executor",
      prompt: "first task uses default review",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const t1 = await loadTaskEnvelope(new NodeFs(path.join(ws, ".tent")), d1.taskPath);
    assert.equal(t1.deliveryPolicy, "review");

    await client.workspaceSettingsUpdate(workspaceId, {
      defaultDeliveryPolicy: "bypass",
    });

    const d2 = (await client.taskDispatch(workspaceId, {
      nodeIds: [box2],
      role: "executor",
      prompt: "second task snapshots bypass",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    const t2 = await loadTaskEnvelope(new NodeFs(path.join(ws, ".tent")), d2.taskPath);
    assert.equal(t2.deliveryPolicy, "bypass");

    // Explicit override still wins over workspace default.
    const d3 = (await client.taskDispatch(workspaceId, {
      nodeIds: [box3],
      role: "executor",
      prompt: "third task explicit agent-decide",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "agent-decide",
    })) as { taskPath: string };
    const t3 = await loadTaskEnvelope(new NodeFs(path.join(ws, ".tent")), d3.taskPath);
    assert.equal(t3.deliveryPolicy, "agent-decide");

    // Existing tasks never change when settings change.
    await client.workspaceSettingsUpdate(workspaceId, {
      defaultDeliveryPolicy: "review",
    });
    const t1Again = await loadTaskEnvelope(new NodeFs(path.join(ws, ".tent")), d1.taskPath);
    const t2Again = await loadTaskEnvelope(new NodeFs(path.join(ws, ".tent")), d2.taskPath);
    assert.equal(t1Again.deliveryPolicy, "review");
    assert.equal(t2Again.deliveryPolicy, "bypass");
    const t3Again = await loadTaskEnvelope(new NodeFs(path.join(ws, ".tent")), d3.taskPath);
    assert.equal(t3Again.deliveryPolicy, "agent-decide");

    // Explicit historical `manual` is rejected on dispatch (use review).
    const rejectManual = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      nodeIds: [await createNode("work-item-manual-reject")],
      role: "executor",
      prompt: "must reject manual wire",
      deliveryPolicy: "manual",
    });
    assert.ok(rejectManual.error);
    assert.equal(rejectManual.error!.code, -32602);
  });
});

test("task envelope on-disk manual projects as review; new serialize writes review", async () => {
  const ws = await makeWorkspace("historical-manual");
  await withService(async (svc) => {
    const { workspaceId, nodeId } = await mountWorkItem(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const d = (await client.taskDispatch(workspaceId, {
      nodeIds: [nodeId],
      role: "executor",
      prompt: "new wire writes review",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string; task?: { deliveryPolicy?: string } };
    const fsa = new NodeFs(path.join(ws, ".tent"));
    const raw = await fsa.readFile(d.taskPath);
    assert.match(raw, /deliveryPolicy:\s*review/);
    assert.doesNotMatch(raw, /deliveryPolicy:\s*manual/);

    // Plant historical on-disk manual; load projects review without rewriting disk.
    const planted = raw.replace(/deliveryPolicy:\s*review/, "deliveryPolicy: manual");
    await fsa.writeFile(d.taskPath, planted);
    const loaded = await loadTaskEnvelope(fsa, d.taskPath);
    assert.equal(loaded.deliveryPolicy, "review");
    const stillOnDisk = await fsa.readFile(d.taskPath);
    assert.match(stillOnDisk, /deliveryPolicy:\s*manual/);
  });
});
