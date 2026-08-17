/**
 * Service operational retention RPCs (task-api §6 MVP).
 * Layer: CLIENT_METHODS + user-only preview/purge + retention.purged event.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createTaskResult, writeTaskResult } from "../src/core/task-result.js";
import { writeTaskRecord, patchTaskRecord } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";

const OLD = "2026-06-01T12:00:00.000Z";

function taskNodeContext(id: string, nodePath: string) {
  return {
    nodeIds: [id],
    nodeSnapshots: [
      {
        id,
        path: nodePath,
        type: "prompt",
        tags: [],
        body: "",
        etag: "a".repeat(24),
        archived: false,
      },
    ],
  };
}

async function makeWorkspace(name = "retention-rpc"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-retention-ws-"));
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
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-retention-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
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

async function seedOldTerminal(
  systemRoot: string,
  opts: { taskId: string; withTaskResult?: boolean; state?: "accepted" | "failed" }
) {
  const fsa = new NodeFs(systemRoot);
  const clock = { now: () => OLD };
  const taskPath = await writeTaskRecord(fsa, clock, {

    requester: { kind: "user", id: "user" },
    executionSessionId: "ss-executor",
    ...taskNodeContext("cx-seed", "inbox"),
    manifestPath: "temp/sessions/ss-executor/manifests/m.md",
    prompt: "old terminal work",
    id: opts.taskId,
  });
  await patchTaskRecord(fsa, taskPath, {
    state: opts.state ?? "accepted",
    updatedAt: OLD,
  });
  // Force timestamps (write/patch use clock for updatedAt; re-stamp both).
  let raw = await fsa.readFile(taskPath);
  raw = raw
    .replace(/createdAt: .*/, `createdAt: ${OLD}`)
    .replace(/updatedAt: .*/, `updatedAt: ${OLD}`);
  await fsa.writeFile(taskPath, raw);

  let resultPath: string | undefined;
  if (opts.withTaskResult) {
    const d = await createTaskResult(fsa, clock, {
      taskId: opts.taskId,
      resultsDir: "temp/sessions/ss-executor/results",
      report: "old result body",
      status: "ready",
    });
    d.status = "accepted";
    d.review = { reviewer: "user", at: OLD };
    await writeTaskResult(fsa, d);
    let dRaw = await fsa.readFile(d.path);
    dRaw = dRaw
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`);
    await fsa.writeFile(d.path, dRaw);
    resultPath = d.path;
  }
  return { taskPath, resultPath };
}

test("CLIENT_METHODS includes operationalRetention.preview/purge", () => {
  assert.ok(isClientMethod("operationalRetention.preview"));
  assert.ok(isClientMethod("operationalRetention.purge"));
  assert.ok(CLIENT_METHODS.includes("operationalRetention.preview"));
  assert.ok(CLIENT_METHODS.includes("operationalRetention.purge"));
});

test("operationalRetention.preview is user-only and read-only", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const { taskPath } = await seedOldTerminal(systemRoot, {
      taskId: "tk-prevu01",
      withTaskResult: true,
    });

    const denied = await rpc(svc, "operationalRetention.preview", {
      workspaceId,
      keepTerminalTasksDays: 0,
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.match(denied.error!.message, /user-only/i);

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const preview = (await client.operationalRetentionPreview(workspaceId, {
      keepTerminalTasksDays: 0,
    })) as {
      candidates: { taskPath?: string; resultPaths: string[] }[];
      candidateTaskCount: number;
    };
    assert.ok(preview.candidates.some((c) => c.taskPath === taskPath));
    assert.ok(preview.candidateTaskCount >= 1);

    // Still on disk after preview
    const fsa = new NodeFs(systemRoot);
    assert.equal(await fsa.exists(taskPath), true);
  });
});

test("operationalRetention.purge: user-only, deletes group, one retention.purged event", async () => {
  const ws = await makeWorkspace("retention-purge");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const { taskPath, resultPath } = await seedOldTerminal(systemRoot, {
      taskId: "tk-purge01",
      withTaskResult: true,
    });

    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "retention.purged") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    const denied = await rpc(svc, "operationalRetention.purge", {
      workspaceId,
      keepTerminalTasksDays: 0,
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.equal(events.length, 0);

    // Invalid keep days
    const badDays = await rpc(svc, "operationalRetention.purge", {
      workspaceId,
      keepTerminalTasksDays: -3,
      actor: "user",
    });
    assert.ok(badDays.error);
    assert.equal(badDays.error!.code, -32602);
    assert.equal(events.length, 0);

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const result = (await client.operationalRetentionPurge(workspaceId, {
      keepTerminalTasksDays: 0,
    })) as {
      deletedCount: number;
      purged: { taskPaths: string[]; resultPaths: string[] };
    };
    assert.ok(result.deletedCount >= 2);
    assert.ok(result.purged.taskPaths.includes(taskPath));
    assert.ok(resultPath && result.purged.resultPaths.includes(resultPath));

    assert.equal(events.length, 1, "exactly one retention.purged when files deleted");
    assert.equal(events[0]!.deletedCount, result.deletedCount);
    assert.ok((events[0]!.taskPaths as string[]).includes(taskPath));

    const fsa = new NodeFs(systemRoot);
    assert.equal(await fsa.exists(taskPath), false);
    if (resultPath) assert.equal(await fsa.exists(resultPath), false);

    // Second purge: no more candidates → no event
    const empty = (await client.operationalRetentionPurge(workspaceId, {
      keepTerminalTasksDays: 0,
    })) as { deletedCount: number };
    assert.equal(empty.deletedCount, 0);
    assert.equal(events.length, 1, "no retention.purged when nothing deleted");

    unsub();
  });
});

test("operationalRetention.purge never deletes active task or ready result", async () => {
  const ws = await makeWorkspace("retention-active");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const fsa = new NodeFs(systemRoot);
    const clock = { now: () => OLD };

    const activePath = await writeTaskRecord(fsa, clock, {

      requester: { kind: "user", id: "user" },
      executionSessionId: "ss-executor",
      ...taskNodeContext("cx-live", "inbox"),
      manifestPath: "temp/sessions/ss-executor/manifests/m.md",
      prompt: "active",
      id: "tk-actlive",
    });
    await patchTaskRecord(fsa, activePath, { state: "running", updatedAt: OLD });
    let raw = await fsa.readFile(activePath);
    raw = raw
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`);
    await fsa.writeFile(activePath, raw);

    const ready = await createTaskResult(fsa, clock, {
      taskId: "tk-orphanready",
      resultsDir: "temp/sessions/ss-executor/results",
      report: "ready review",
      status: "ready",
    });
    let dRaw = await fsa.readFile(ready.path);
    dRaw = dRaw
      .replace(/createdAt: .*/, `createdAt: ${OLD}`)
      .replace(/updatedAt: .*/, `updatedAt: ${OLD}`);
    await fsa.writeFile(ready.path, dRaw);

    const events: unknown[] = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "retention.purged") events.push(ev);
    });

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const result = (await client.operationalRetentionPurge(workspaceId, {
      keepTerminalTasksDays: 0,
    })) as {
      deletedCount: number;
      purged: { taskPaths: string[]; resultPaths: string[] };
    };

    assert.ok(!result.purged.taskPaths.includes(activePath));
    assert.ok(!result.purged.resultPaths.includes(ready.path));
    assert.equal(await fsa.exists(activePath), true);
    assert.equal(await fsa.exists(ready.path), true);

    // If only protected items exist, deletedCount may be 0 → no event
    if (result.deletedCount === 0) {
      assert.equal(events.length, 0);
    }

    unsub();
  });
});

test("operationalRetention.preview reports bad files without deleting them", async () => {
  const ws = await makeWorkspace("retention-bad");
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const systemRoot = path.join(ws, ".tent");
    const fsa = new NodeFs(systemRoot);
    const bad = "temp/sessions/ss-executor/tasks/not-a-task.md";
    await fsa.mkdir("temp/sessions/ss-executor/tasks");
    await fsa.writeFile(bad, "---\ntype: garbage\n---\n");

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const preview = (await client.operationalRetentionPreview(workspaceId, {
      keepTerminalTasksDays: 0,
    })) as { skipped: { path: string }[]; warnings: string[] };

    assert.ok(preview.skipped.some((s) => s.path === bad));
    assert.ok(preview.warnings.some((w) => w.includes(bad)));
    assert.equal(await fsa.exists(bad), true);

    await client.operationalRetentionPurge(workspaceId, { keepTerminalTasksDays: 0 });
    assert.equal(await fsa.exists(bad), true);
  });
});
