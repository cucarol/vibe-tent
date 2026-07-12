/**
 * Desktop P0-1: collaboration closed-loop UI model + service client smoke.
 * Pure model tests + vertical registry/dispatch/accept via Local Service.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import {
  buildAcceptPayload,
  buildRejectPayload,
  buildTaskReviewItems,
  listCoordinationTypeNames,
  listCoordinationTypeOptions,
  pickDefaultCoordinationType,
  suggestBoxName,
  validateDispatchForm,
} from "../src/desktop/workbench/collaboration-ui.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";

// ---- pure UI model ----

test("listCoordinationTypeNames uses registry coordination flag, not type name", () => {
  const types = [
    { name: "note", tier: "base" as const, coordination: false },
    { name: "goal", tier: "base" as const, coordination: true },
    { name: "prompt", tier: "base" as const, coordination: true },
    { name: "open", tier: "modifier" as const, coordination: false },
    { name: "quest", tier: "base" as const, coordination: true },
  ];
  assert.deepEqual(listCoordinationTypeNames(types), ["goal", "prompt", "quest"]);
  assert.equal(pickDefaultCoordinationType(types), "goal");

  // When goal is absent, first sorted coordination type wins — not hardcoded goal.
  const noGoal = types.filter((t) => t.name !== "goal");
  assert.equal(pickDefaultCoordinationType(noGoal), "prompt");

  // Custom type with coordination=true is eligible even if name is not goal.
  assert.ok(listCoordinationTypeNames([{ name: "mission", tier: "base", coordination: true }]).includes("mission"));
  assert.equal(
    listCoordinationTypeNames([{ name: "goal", tier: "base", coordination: false }]).length,
    0
  );
});

test("validateDispatchForm builds task.dispatch payload and blocks invalid cases", () => {
  const roles = [{ name: "executor" }, { name: "reviewer" }];
  const ok = validateDispatchForm({
    boxId: "cx-1",
    coordination: true,
    role: "executor",
    prompt: "  implement feature  ",
    roles,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, {
    boxId: "cx-1",
    role: "executor",
    prompt: "implement feature",
    dispatchedBy: "user",
  });

  assert.equal(
    validateDispatchForm({
      boxId: "cx-1",
      coordination: false,
      role: "executor",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      boxId: null,
      coordination: true,
      role: "executor",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      boxId: "cx-1",
      coordination: true,
      role: "",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      boxId: "cx-1",
      coordination: true,
      role: "executor",
      prompt: "   ",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      boxId: "cx-1",
      coordination: true,
      role: "ghost",
      prompt: "x",
      roles,
    }).ok,
    false
  );
  assert.equal(
    validateDispatchForm({
      boxId: "cx-1",
      coordination: true,
      role: "executor",
      prompt: "x",
      roles: [],
    }).ok,
    false
  );
});

test("accept/reject payload builders and task review model", () => {
  assert.deepEqual(buildAcceptPayload("temp/executor/tasks/t1.md"), {
    taskPath: "temp/executor/tasks/t1.md",
    actor: "user",
  });

  const badReject = buildRejectPayload("temp/executor/tasks/t1.md", "  ");
  assert.equal(badReject.ok, false);

  const goodReject = buildRejectPayload("temp/executor/tasks/t1.md", "  need more tests  ");
  assert.equal(goodReject.ok, true);
  if (goodReject.ok) {
    assert.equal(goodReject.payload.note, "need more tests");
    assert.equal(goodReject.payload.actor, "user");
    assert.equal(goodReject.payload.resume, true);
  }

  const items = buildTaskReviewItems(
    [
      {
        path: "temp/executor/tasks/a.md",
        id: "tk-a",
        role: "executor",
        claims: ["cx-box"],
        status: "taken",
        state: "delivered",
        manifest: "m",
        activeDeliveryId: "dl-1",
        prompt: "ship it",
      },
      {
        path: "temp/executor/tasks/b.md",
        id: "tk-b",
        role: "executor",
        claims: ["cx-box"],
        status: "pending",
        state: "queued",
        manifest: "m",
        prompt: "queued work",
      },
    ],
    [
      {
        path: "temp/executor/deliveries/dl-1.md",
        id: "dl-1",
        taskId: "tk-a",
        boxId: "cx-box",
        role: "executor",
        status: "ready",
        summary: "Done with tests",
        commits: ["abcdef123456"],
        integrationMode: null,
      },
    ]
  );

  assert.equal(items[0].canAcceptOrReject, true);
  assert.equal(items[0].deliverySummary, "Done with tests");
  assert.deepEqual(items[0].commits, ["abcdef123456"]);
  assert.equal(items[1].canAcceptOrReject, false);
  assert.match(items[0].summaryLine, /待确认交付/);
});

test("suggestBoxName embeds type without hardcoding goal", () => {
  assert.match(suggestBoxName("prompt", 1_700_000_000_000), /^prompt-/);
  assert.match(suggestBoxName("mission", 1_700_000_000_000), /^mission-/);
});

test("CLIENT_METHODS includes registry.types/roles for desktop pickers", () => {
  assert.ok(CLIENT_METHODS.includes("registry.types"));
  assert.ok(CLIENT_METHODS.includes("registry.roles"));
});

// ---- service + client vertical smoke ----

async function makeCollabWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "collab",
    rules: "# RULES\n\nDesktop collab smoke\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "orchestrate" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

test("service+client: registry → create coordination box → dispatch → deliver → accept/reject", async () => {
  const ws = await makeCollabWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const types = (await client.registryTypes(workspaceId)) as {
      types: Array<{ name: string; tier: string; coordination: boolean }>;
    };
    const coordNames = listCoordinationTypeNames(types.types);
    assert.ok(coordNames.includes("goal"));
    assert.ok(coordNames.includes("prompt"));
    assert.ok(!coordNames.includes("note"));
    assert.ok(!coordNames.includes("open")); // modifier

    const roles = (await client.registryRoles(workspaceId)) as {
      roles: Array<{ name: string }>;
    };
    assert.ok(roles.roles.some((r) => r.name === "executor"));

    const defaultType = pickDefaultCoordinationType(types.types)!;
    const created = (await client.docsCreateNote(workspaceId, {
      name: suggestBoxName(defaultType, Date.now()),
      type: defaultType,
    })) as { id: string; type: string };
    assert.match(created.id, /^cx-/);
    assert.equal(created.type, defaultType);

    const form = validateDispatchForm({
      boxId: created.id,
      coordination: true,
      role: "executor",
      prompt: "Ship collab closed loop",
      roles: roles.roles.map((r) => ({ name: r.name })),
    });
    assert.equal(form.ok, true);
    assert.ok(form.payload);

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: form.payload!.boxId,
      role: form.payload!.role,
      prompt: form.payload!.prompt,
      dispatchedBy: form.payload!.dispatchedBy,
      deliveryPolicy: "manual",
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");

    await client.taskClaim(workspaceId, dispatched.taskPath);
    const delivered = (await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "Implemented closed loop",
      commits: ["c0ffee"],
    })) as { state: string; delivery: { status: string } };
    assert.equal(delivered.state, "delivered");

    // Self-accept still forbidden (UI must not bypass)
    const self = await client.tryCall("task.accept", {
      workspaceId,
      taskPath: dispatched.taskPath,
      actor: "executor",
    });
    assert.equal(self.ok, false);

    const acceptPayload = buildAcceptPayload(dispatched.taskPath, "user");
    const accepted = (await client.taskAccept(
      workspaceId,
      acceptPayload.taskPath,
      acceptPayload.actor
    )) as { state: string };
    assert.equal(accepted.state, "accepted");

    // Second box: reject path
    const box2 = (await client.docsCreateNote(workspaceId, {
      name: suggestBoxName("prompt", Date.now() + 1),
      type: "prompt",
    })) as { id: string };
    const d2 = (await client.taskDispatch(workspaceId, {
      boxId: box2.id,
      role: "executor",
      prompt: "will be rejected",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, d2.taskPath);
    await client.taskDeliver(workspaceId, d2.taskPath, {
      summary: "not good enough",
    });
    const rejectPayload = buildRejectPayload(d2.taskPath, "缺测试", "user");
    assert.equal(rejectPayload.ok, true);
    if (rejectPayload.ok) {
      const rejected = (await client.taskReject(
        workspaceId,
        rejectPayload.payload.taskPath,
        rejectPayload.payload.actor,
        { note: rejectPayload.payload.note, resume: rejectPayload.payload.resume }
      )) as { state: string; delivery: { status: string } };
      // resume default → rework path leaves task active (running/waiting), delivery rejected
      assert.equal(rejected.delivery.status, "rejected");
      assert.notEqual(rejected.state, "accepted");
    }

    // Shell model loads registry + tasks over desktop RPC client
    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    await model.refreshWorkspaces();
    await model.bindForeground(workspaceId);
    const snap = model.getSnapshot();
    assert.ok(snap.coordinationTypes.some((t) => t.name === "goal"));
    assert.ok(snap.roles.some((r) => r.name === "executor"));
    assert.ok(Array.isArray(snap.taskReview));
  } finally {
    await svc.stop();
  }
});

test("listCoordinationTypeOptions preserves description metadata", () => {
  const opts = listCoordinationTypeOptions([
    {
      name: "goal",
      tier: "base",
      coordination: true,
      description: "定义目标",
      color: "blue",
    },
    {
      name: "note",
      tier: "base",
      coordination: false,
    },
  ]);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].description, "定义目标");
});
