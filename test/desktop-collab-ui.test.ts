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
  buildStartSessionPayload,
  buildTaskReviewItems,
  canInterruptTask,
  canStartAgentOnTask,
  listCoordinationTypeNames,
  listCoordinationTypeOptions,
  listProfileOptions,
  pickDefaultCoordinationType,
  pickDefaultProfileId,
  sessionStateLabel,
  suggestBoxName,
  taskStateLabel,
  validateDispatchForm,
} from "../src/desktop/workbench/collaboration-ui.js";
import { DesktopShellModel } from "../src/desktop/workbench/shell-model.js";
import { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";
import {
  defaultAgentProfiles,
  projectAgentProfile,
  projectAgentProfiles,
} from "../src/service/profiles.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";

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
  assert.equal(items[1].canStartAgent, true);
  assert.equal(items[0].canStartAgent, false);
  assert.match(items[0].summaryLine, /待确认交付/);
});

test("suggestBoxName embeds type without hardcoding goal", () => {
  assert.match(suggestBoxName("prompt", 1_700_000_000_000), /^prompt-/);
  assert.match(suggestBoxName("mission", 1_700_000_000_000), /^mission-/);
});

test("CLIENT_METHODS includes registry.types/roles and profile CRUD", () => {
  assert.ok(CLIENT_METHODS.includes("registry.types"));
  assert.ok(CLIENT_METHODS.includes("registry.roles"));
  assert.ok(CLIENT_METHODS.includes("profile.list"));
  assert.ok(CLIENT_METHODS.includes("profile.get"));
  assert.ok(CLIENT_METHODS.includes("profile.create"));
  assert.ok(CLIENT_METHODS.includes("profile.update"));
  assert.ok(CLIENT_METHODS.includes("profile.delete"));
});

test("projectAgentProfiles strips secrets and marks fake as testOnly", () => {
  const raw = defaultAgentProfiles();
  // Inject a secret-looking env bag — must never appear in projection.
  raw[0].env = { CPA_GROK_API_KEY: "sk-secret-value", PATH: "/tmp" };
  raw[1].env = { TOKEN: "should-not-leak" };
  raw[1].acp = {
    ...raw[1].acp,
    executable: "C:\\\\tools\\\\grok.exe",
    envKey: "CPA_GROK_API_KEY",
  };

  const projected = projectAgentProfiles(raw);
  const json = JSON.stringify(projected);
  assert.ok(!json.includes("sk-secret-value"));
  assert.ok(!json.includes("should-not-leak"));
  // Env key *names* may appear; secret *values* must not.
  assert.ok(!json.includes("TOKEN"));
  // No raw env map object in projection payload.
  assert.ok(!/"env"\s*:/.test(json));

  const fake = projected.find((p) => p.id === "fake-default")!;
  const grok = projected.find((p) => p.id === "grok-acp-default")!;
  assert.equal(fake.testOnly, true);
  assert.equal(fake.adapterId, FAKE_ADAPTER_ID);
  assert.equal(grok.testOnly, false);
  assert.equal(grok.adapterId, GROK_ACP_ADAPTER_ID);
  assert.equal(grok.model, "grok-4.5");
  assert.equal(grok.envKey, "CPA_GROK_API_KEY");
  assert.equal(grok.executable, "C:\\\\tools\\\\grok.exe");
  // Product profiles sort before test-only.
  assert.equal(projected[0].id, "grok-acp-default");

  const single = projectAgentProfile(raw[1]);
  assert.equal(single.id, "grok-acp-default");
  assert.ok(!("env" in single));
  assert.ok(!("fake" in single));
  assert.ok(!("grokAcp" in single) && !("acp" in single));
});

test("listProfileOptions + pickDefaultProfileId hide fake as product default", () => {
  const opts = listProfileOptions(projectAgentProfiles(defaultAgentProfiles()));
  assert.ok(opts.every((p) => !p.testOnly));
  assert.ok(opts.some((p) => p.id === "grok-acp-default"));
  assert.equal(pickDefaultProfileId(opts), "grok-acp-default");

  // With includeTest, fake is available but still not the product default when grok exists.
  const withTest = listProfileOptions(projectAgentProfiles(defaultAgentProfiles()), {
    includeTest: true,
  });
  assert.ok(withTest.some((p) => p.id === "fake-default"));
  assert.equal(pickDefaultProfileId(withTest), "grok-acp-default");

  // Sole product profile wins.
  assert.equal(
    pickDefaultProfileId([{ id: "only", adapterId: "x", displayName: "only", testOnly: false, label: "only" }]),
    "only"
  );
});

test("buildStartSessionPayload is user callerKind and never auto-dispatches", () => {
  const ok = buildStartSessionPayload("temp/executor/tasks/t1.md", "grok-acp-default");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.payload, {
      taskPath: "temp/executor/tasks/t1.md",
      profileId: "grok-acp-default",
      callerKind: "user",
    });
  }
  assert.equal(buildStartSessionPayload("", "grok-acp-default").ok, false);
  assert.equal(buildStartSessionPayload("temp/x.md", "  ").ok, false);
});

test("task/session state labels and start/interrupt gates", () => {
  assert.equal(taskStateLabel("queued"), "排队中");
  assert.equal(taskStateLabel("failed"), "失败");
  assert.equal(sessionStateLabel("starting"), "启动中");
  assert.equal(sessionStateLabel("live"), "运行中");
  assert.equal(sessionStateLabel("waiting-user"), "等待用户");
  assert.equal(sessionStateLabel("stopped"), "已停止");
  assert.equal(sessionStateLabel("failed"), "会话失败");

  assert.equal(canStartAgentOnTask("queued"), true);
  assert.equal(canStartAgentOnTask("running"), true);
  assert.equal(canStartAgentOnTask("delivered"), false);
  assert.equal(
    canStartAgentOnTask("running", { state: "live", alive: true }),
    false
  );
  assert.equal(
    canInterruptTask("running", { state: "live", alive: true }),
    true
  );
  assert.equal(canInterruptTask("queued"), false);
  assert.equal(canInterruptTask("running", null, { hasSessionId: true }), true);

  const items = buildTaskReviewItems(
    [
      {
        path: "temp/executor/tasks/live.md",
        id: "tk-live",
        role: "executor",
        claims: ["cx-1"],
        status: "taken",
        state: "running",
        manifest: "m",
        sessionId: "ss-live1",
        prompt: "go",
      },
    ],
    [],
    [
      {
        sessionId: "ss-live1",
        profileId: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        state: "live",
        alive: true,
        resumeCapable: false,
        lastTaskId: "tk-live",
      },
    ]
  );
  assert.equal(items[0].canStartAgent, false);
  assert.equal(items[0].canInterrupt, true);
  assert.equal(items[0].sessionState, "live");
  assert.match(items[0].summaryLine, /会话运行中/);
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
    // No commits: pure Tent accept path (Git integrate covered by service P0 tests).
    const delivered = (await client.taskDeliver(workspaceId, dispatched.taskPath, {
      summary: "Implemented closed loop",
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

test("service+client: profile.list safe metadata + startSession/interrupt via shell model", async () => {
  const ws = await makeCollabWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-collab-acp-"));
  // Inject only fake for offline start (no CPA / no real grok binary).
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles: [
      {
        id: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        displayNameKey: "profile.fake.default",
        fake: { waitForSignal: true, emitStdout: true, canResume: true },
      },
      {
        id: "grok-acp-default",
        adapterId: GROK_ACP_ADAPTER_ID,
        displayNameKey: "profile.grokAcp.default",
        acp: {
          model: "grok-4.5",
          envKey: "CPA_GROK_API_KEY",
          permissionPolicy: "deny",
        },
      },
    ],
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    // Product list: no testOnly, no secret values / env maps.
    const productList = (await client.profileList()) as {
      profiles: Array<Record<string, unknown>>;
    };
    const productJson = JSON.stringify(productList);
    assert.ok(!productJson.includes("fake-default"));
    assert.ok(!/"env"\s*:/.test(productJson));
    assert.ok(!productJson.includes("sk-"));
    assert.ok(productList.profiles.some((p) => p.id === "grok-acp-default"));
    assert.ok(productList.profiles.every((p) => p.testOnly === false));

    // includeTest for harness visibility only.
    const allList = (await client.profileList({ includeTest: true })) as {
      profiles: Array<{ id: string; testOnly: boolean }>;
    };
    assert.ok(allList.profiles.some((p) => p.id === "fake-default" && p.testOnly));

    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const box = (await client.docsCreateNote(workspaceId, {
      name: suggestBoxName("prompt", Date.now()),
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: box.id,
      role: "executor",
      prompt: "start via UI model",
      dispatchedBy: "user",
      deliveryPolicy: "manual",
      // Explicit: dispatch must not auto-start session.
      startSession: false,
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");

    const rpc = new ServiceRpcClient({ baseUrl: svc.url, token: svc.token });
    const model = new DesktopShellModel(rpc);
    await model.refreshHealth();
    await model.refreshWorkspaces();
    await model.bindForeground(workspaceId);

    let snap = model.getSnapshot();
    // Product profiles only in shell default refresh.
    assert.ok(snap.profiles.every((p) => !p.testOnly));
    assert.equal(snap.selectedProfileId, "grok-acp-default");

    const review = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(review);
    assert.equal(review!.canStartAgent, true);
    assert.equal(review!.canInterrupt, false);

    // startSession payload path: user click with fake profile (offline).
    // Shell still defaults to grok; pass explicit fake for harness — never auto.
    const started = (await model.startAgentSession(dispatched.taskPath, "fake-default")) as {
      session: { sessionId: string; state: string; profileId: string };
      task: { state: string; sessionId?: string };
    };
    assert.match(started.session.sessionId, /^ss-/);
    assert.equal(started.session.profileId, "fake-default");
    assert.ok(started.task.state === "running" || started.task.sessionId);

    snap = model.getSnapshot();
    const afterStart = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(afterStart);
    // Live session → interrupt available; start gated off while alive.
    assert.equal(afterStart!.canInterrupt, true);
    assert.equal(afterStart!.canStartAgent, false);
    assert.ok(afterStart!.sessionId);

    const interrupted = (await model.interruptTask(dispatched.taskPath)) as {
      state: string;
    };
    assert.equal(interrupted.state, "interrupted");

    snap = model.getSnapshot();
    const afterIntr = snap.taskReview.find((t) => t.path === dispatched.taskPath);
    assert.ok(afterIntr);
    assert.equal(afterIntr!.state, "interrupted");
    assert.equal(afterIntr!.canStartAgent, false);
    assert.equal(afterIntr!.canInterrupt, false);

    // Missing profileId surfaces as Chinese validation error (no silent fake fallback).
    await assert.rejects(
      () => model.startAgentSession(dispatched.taskPath, ""),
      /profile|请选择/i
    );
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
