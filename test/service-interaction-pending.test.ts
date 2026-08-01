/**
 * Unified A2U pending projection: interaction.listPending.
 * Aggregates UserAsk / A2A / toolApproval / ready Delivery — no new store.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createDelivery } from "../src/core/delivery.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import {
  CLIENT_METHODS,
  isClientMethod,
  type PendingInteractionListResult,
} from "../src/service/types.js";
import { makeApprovalId } from "../src/service/a2a-store.js";
import { makeToolApprovalId } from "../src/service/tool-approval-store.js";

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ix-pending-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "interaction-pending",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor",
            prompt: "do work",
            a2aPolicy: "allow",
            allowedProfiles: ["mock-ix"],
          },
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ix-pending-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

test("CLIENT_METHODS includes interaction.listPending", () => {
  assert.ok(CLIENT_METHODS.includes("interaction.listPending"));
  assert.ok(isClientMethod("interaction.listPending"));
  assert.equal(isClientMethod("interaction.resolve"), false);
});

test("interaction.listPending aggregates four kinds with stable sort and counts", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const created = (await client.docsCreateNote(workspaceId, {
      name: "work-item",
      type: "prompt",
    })) as { id: string };
    const boxId = created.id;

    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [boxId],
      role: "executor",
      prompt: "Need decisions and review",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string; task?: { id?: string } };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);

    const taskGot = (await client.taskGet(workspaceId, taskPath)) as {
      task: { id?: string; sessionId?: string; role: string };
    };
    const taskId = taskGot.task.id;
    assert.ok(taskId, "task id required for delivery + pointers");

    // 1) UserAsk pending
    const asked = (await client.taskAskUser(workspaceId, taskPath, {
      question: "Ship v1 or v2?",
      choices: [
        { id: "v1", label: "Ship v1" },
        { id: "v2", label: "Ship v2" },
      ],
    })) as { ask: { id: string; createdAt: string } };

    // 2) A2A spawn approval (inject into machine store)
    const a2aId = makeApprovalId();
    await svc.ctx.a2a.add({
      id: a2aId,
      workspaceId,
      taskPath,
      taskId,
      role: "executor",
      profileId: "mock-ix",
      policy: "ask",
      callerKind: "role",
      status: "pending",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    // 3) Tool approval pending (safe options only; no raw args in store row)
    const toolId = makeToolApprovalId();
    await svc.ctx.toolApprovals.add({
      id: toolId,
      workspaceId,
      sessionId: "ss-tool-1",
      taskId,
      taskPath,
      role: "executor",
      toolTitle: "read_file",
      toolCallId: "tc-1",
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject", name: "Reject" },
      ],
      status: "pending",
      createdAt: "2021-06-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    // 4) Ready Delivery via core writer under the mounted system root
    const fsa = new NodeFs(path.join(ws, ".tent"));
    const clock = { now: () => "2022-01-01T00:00:00.000Z" };
    const delivery = await createDelivery(fsa, clock, {
      taskId,
      boxId,
      role: "executor",
      summary: "Ready for human review — must not appear in interaction projection",
      status: "ready",
    });

    // Non-ready delivery must not appear
    await createDelivery(fsa, clock, {
      taskId,
      boxId,
      role: "executor",
      summary: "Already accepted history",
      status: "accepted",
    });

    const result = (await client.interactionListPending(
      workspaceId
    )) as PendingInteractionListResult;

    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.counts.total, 4);
    assert.equal(result.counts.userAsk, 1);
    assert.equal(result.counts.a2a, 1);
    assert.equal(result.counts.toolApproval, 1);
    assert.equal(result.counts.delivery, 1);
    assert.equal(result.items.length, 4);

    // Stable sort: createdAt ASC, then kind, then id
    const times = result.items.map((i) => i.createdAt);
    assert.deepEqual(times, [...times].sort((a, b) => a.localeCompare(b)));
    assert.equal(result.items[0]!.kind, "a2a");
    assert.equal(result.items[0]!.id, a2aId);
    assert.equal(result.items[1]!.kind, "toolApproval");
    assert.equal(result.items[1]!.id, toolId);
    assert.equal(result.items[2]!.kind, "delivery");
    assert.equal(result.items[2]!.id, delivery.id);
    assert.equal(result.items[3]!.kind, "userAsk");
    assert.equal(result.items[3]!.id, asked.ask.id);

    const userAsk = result.items.find((i) => i.kind === "userAsk");
    assert.ok(userAsk && userAsk.kind === "userAsk");
    assert.equal(userAsk.taskPath, taskPath);
    assert.equal(userAsk.taskId, taskId);
    assert.equal(userAsk.boxId, boxId);
    assert.equal(userAsk.role, "executor");
    assert.equal(userAsk.question, "Ship v1 or v2?");
    assert.equal(userAsk.choices?.length, 2);

    const a2a = result.items.find((i) => i.kind === "a2a");
    assert.ok(a2a && a2a.kind === "a2a");
    assert.equal(a2a.profileId, "mock-ix");
    assert.equal(a2a.taskPath, taskPath);
    assert.equal(a2a.boxId, boxId);
    // bootstrapPrompt / secrets must not leak
    assert.equal((a2a as { bootstrapPrompt?: string }).bootstrapPrompt, undefined);

    const tool = result.items.find((i) => i.kind === "toolApproval");
    assert.ok(tool && tool.kind === "toolApproval");
    assert.equal(tool.toolTitle, "read_file");
    assert.equal(tool.sessionId, "ss-tool-1");
    assert.equal(tool.options.length, 2);
    // Never project raw tool args / toolCallId as part of the inbox item
    assert.equal((tool as { toolCallId?: string }).toolCallId, undefined);
    assert.equal((tool as { args?: unknown }).args, undefined);
    assert.equal((tool as { rawInput?: unknown }).rawInput, undefined);

    const del = result.items.find((i) => i.kind === "delivery");
    assert.ok(del && del.kind === "delivery");
    assert.equal(del.status, "ready");
    assert.equal(del.taskId, taskId);
    assert.equal(del.boxId, boxId);
    assert.equal(del.taskPath, taskPath);
    // Delivery summary is intentionally not projected on the unified inbox
    assert.equal((del as { summary?: string }).summary, undefined);

    // ServiceClient delivery wrappers
    const listed = await client.deliveryList(workspaceId, { taskId });
    assert.ok(listed.deliveries.some((d) => d.id === delivery.id && d.status === "ready"));
    const got = await client.deliveryGet(workspaceId, delivery.id);
    assert.equal(got.delivery.id, delivery.id);
    assert.equal(got.delivery.summary.includes("Ready for human review"), true);
  });
});

test("interaction.listPending fail-loud when workspace not mounted", async () => {
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await assert.rejects(
      () => client.interactionListPending("ws-does-not-exist"),
      /not mounted|Workspace not found|unknown workspace|not found/i
    );
  });
});

test("interaction.listPending empty workspace returns zero counts", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const result = (await client.interactionListPending(
      mounted.workspaceId
    )) as PendingInteractionListResult;
    assert.equal(result.counts.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.counts.userAsk, 0);
    assert.equal(result.counts.a2a, 0);
    assert.equal(result.counts.toolApproval, 0);
    assert.equal(result.counts.delivery, 0);
  });
});
