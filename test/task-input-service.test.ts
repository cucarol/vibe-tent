/**
 * U2A task.sendInput + taskInput.* via Local Service RPC (mock ACP; no paid networks).
 * Minimal non-chat companion to A2U UserAsk.
 * Review boundaries: workspaceId+taskPath scope; ack actor binding; cancel pending-only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, RPC_LIFECYCLE } from "../src/service/types.js";
import {
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";

const MOCK_ACP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

function mockAcpProfile(
  id: string,
  opts: {
    logPath: string;
    promptText?: string;
    followupText?: string;
    promptDelayMs?: number;
    /** Delay only U2A follow-up prompts (bootstrap unaffected). */
    followupDelayMs?: number;
    /** Never complete U2A follow-ups (hang until SIGTERM). */
    hangFollowup?: boolean;
    keepAlive?: boolean;
    /** Hang bootstrap (no auto-deliver); U2A follow-ups still complete. */
    hangBootstrap?: boolean;
    /** Override profile promptTimeoutMs (default 15s). */
    promptTimeoutMs?: number;
  }
): import("../src/runtime/types.js").AgentProfileConfig {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath,
      MOCK_ACP_KEEP_ALIVE: opts.keepAlive === false ? "0" : "1",
      MOCK_ACP_PROMPT_TEXT: opts.promptText ?? "MANAGED_FINAL_REPORT",
      ...(opts.followupText
        ? { MOCK_ACP_FOLLOWUP_TEXT: opts.followupText }
        : {}),
      ...(opts.promptDelayMs != null
        ? { MOCK_ACP_PROMPT_DELAY_MS: String(opts.promptDelayMs) }
        : {}),
      ...(opts.followupDelayMs != null
        ? { MOCK_ACP_FOLLOWUP_DELAY_MS: String(opts.followupDelayMs) }
        : {}),
      ...(opts.hangFollowup ? { MOCK_ACP_FOLLOWUP_HANG: "1" } : {}),
      // interrupt hangs bootstrap; follow-ups (User Input / Review Feedback) still ok
      // unless hangFollowup is set.
      MOCK_ACP_PROMPT_MODE: opts.hangBootstrap ? "interrupt" : "ok",
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: opts.promptTimeoutMs ?? 15_000,
      permissionTimeoutMs: 500,
    },
  };
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 20_000,
  label = "condition"
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "task-input",
    rules: "# RULES\n\nTaskInput tests\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
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
            allowedProfiles: ["mock-ti"],
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
  profiles: import("../src/runtime/types.js").AgentProfileConfig[],
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles,
  });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

test("CLIENT_METHODS includes task.sendInput and taskInput.*", () => {
  assert.ok(CLIENT_METHODS.includes("task.sendInput"));
  assert.ok(CLIENT_METHODS.includes("taskInput.listPending"));
  assert.ok(CLIENT_METHODS.includes("taskInput.get"));
  assert.ok(CLIENT_METHODS.includes("taskInput.ack"));
});

test("task.sendInput: user-only, text/refs, scoped poll+ack, lifecycle cancel", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "append-item",
      type: "prompt",
    })) as { id: string };
    const boxId = created.id;

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "Work that may get user append",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);

    // Empty payload rejected
    await assert.rejects(
      () => client.taskSendInput(workspaceId, taskPath, {}),
      /text and\/or contextRefs/
    );

    // Agent cannot self-send
    const agentSend = await rpcCall(
      svc.url,
      "task.sendInput",
      {
        workspaceId,
        taskPath,
        text: "nope",
        actor: "executor",
      },
      { token: svc.token }
    );
    assert.ok(agentSend.error);
    assert.equal(agentSend.error!.code, -32001);

    const sent = (await client.taskSendInput(workspaceId, taskPath, {
      text: "Also consider cx-abc",
      contextRefs: [boxId, "cx-dup", "cx-dup"],
    })) as {
      state: string;
      input: {
        id: string;
        status: string;
        text?: string;
        contextRefs?: string[];
        workspaceId: string;
        taskPath: string;
        role?: string;
      };
      continued?: boolean;
    };
    assert.equal(sent.state, "running");
    assert.equal(sent.input.status, "pending");
    assert.equal(sent.input.text, "Also consider cx-abc");
    assert.deepEqual(sent.input.contextRefs, [boxId, "cx-dup"]);
    assert.equal(sent.input.workspaceId, workspaceId);
    assert.equal(sent.input.taskPath, taskPath);
    assert.equal(sent.input.role, "executor");
    // No managed session → not continued
    assert.equal(sent.continued, false);

    const pending = (await client.taskInputListPending(
      workspaceId,
      taskPath
    )) as {
      inputs: { id: string }[];
    };
    assert.equal(pending.inputs.length, 1);
    assert.equal(pending.inputs[0]!.id, sent.input.id);

    // listPending without taskPath fails loud (no global inbox)
    const badList = await rpcCall(
      svc.url,
      "taskInput.listPending",
      { workspaceId },
      { token: svc.token }
    );
    assert.ok(badList.error);
    assert.equal(badList.error!.code, -32602);

    // listPending without workspaceId fails loud
    const badList2 = await rpcCall(
      svc.url,
      "taskInput.listPending",
      { taskPath },
      { token: svc.token }
    );
    assert.ok(badList2.error);
    assert.equal(badList2.error!.code, -32602);

    // id-only get rejected
    const badGet = await rpcCall(
      svc.url,
      "taskInput.get",
      { inputId: sent.input.id },
      { token: svc.token }
    );
    assert.ok(badGet.error);
    assert.equal(badGet.error!.code, -32602);

    const got = (await client.taskInputGet(
      workspaceId,
      taskPath,
      sent.input.id
    )) as {
      input: { status: string; text?: string };
    };
    assert.equal(got.input.status, "pending");
    assert.equal(got.input.text, "Also consider cx-abc");

    // Arbitrary actor string is insufficient
    const badActor = await rpcCall(
      svc.url,
      "taskInput.ack",
      {
        workspaceId,
        taskPath,
        inputId: sent.input.id,
        actor: "spoofed-agent",
      },
      { token: svc.token }
    );
    assert.ok(badActor.error);
    assert.equal(badActor.error!.code, -32001);

    // Missing actor fails
    const noActor = await rpcCall(
      svc.url,
      "taskInput.ack",
      {
        workspaceId,
        taskPath,
        inputId: sent.input.id,
      },
      { token: svc.token }
    );
    assert.ok(noActor.error);
    assert.equal(noActor.error!.code, -32602);

    // Role-bound ack succeeds
    const acked = (await client.taskInputAck(
      workspaceId,
      taskPath,
      sent.input.id,
      "executor"
    )) as {
      input: { status: string; consumedAt?: string };
    };
    assert.equal(acked.input.status, "consumed");
    assert.ok(acked.input.consumedAt);

    // Double-ack fails loud
    const doubleAck = await rpcCall(
      svc.url,
      "taskInput.ack",
      {
        workspaceId,
        taskPath,
        inputId: sent.input.id,
        actor: "executor",
      },
      { token: svc.token }
    );
    assert.ok(doubleAck.error);
    assert.equal(doubleAck.error!.code, RPC_LIFECYCLE);

    // Pending UserAsk blocks sendInput
    const asked = (await client.taskAskUser(workspaceId, taskPath, {
      question: "Need a decision first?",
    })) as { ask: { id: string }; state: string };
    assert.equal(asked.state, "waiting");

    await assert.rejects(
      () =>
        client.taskSendInput(workspaceId, taskPath, {
          text: "should not land while ask pending",
        }),
      /pending UserAsk|userAsk\.reply/
    );

    await client.userAskReply(asked.ask.id, { answer: "go" });

    // After ask resolved, sendInput works again; interrupt cancels pending input
    const sent2 = (await client.taskSendInput(workspaceId, taskPath, {
      contextRefs: [boxId],
    })) as { input: { id: string; status: string } };
    assert.equal(sent2.input.status, "pending");

    await client.taskInterrupt(workspaceId, taskPath);
    const cancelled = (await client.taskInputGet(
      workspaceId,
      taskPath,
      sent2.input.id
    )) as {
      input: { status: string };
    };
    assert.equal(cancelled.input.status, "cancelled");

    const task = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(task.task.state, "interrupted");
  });
});

test("taskInput list/get/ack are isolated across workspaces (no cross get/ack)", async () => {
  const wsA = await makeWorkspace();
  const wsB = await makeWorkspace();
  const sharedTaskPath = "temp/executor/tasks/task-shared-ti.md";

  async function plantRunningTask(
    workspaceRoot: string,
    boxId: string
  ): Promise<void> {
    const abs = path.join(workspaceRoot, ".tent", ...sharedTaskPath.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const now = new Date().toISOString();
    const body =
      "---\n" +
      "type: task\n" +
      "id: tk-shared-ti\n" +
      "status: taken\n" +
      "state: running\n" +
      "role: executor\n" +
      "assigneeKind: role\n" +
      "dispatchedBy: user\n" +
      `claims: [${boxId}]\n` +
      "manifest: temp/executor/manifest.yml\n" +
      "deliveryPolicy: manual\n" +
      `createdAt: "${now}"\n` +
      `updatedAt: "${now}"\n` +
      "---\n" +
      "# Task\n\n## User Prompt\n\nPlanted for cross-workspace TaskInput isolation.\n";
    await fs.writeFile(abs, body, "utf8");
  }

  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mA = (await client.mount(wsA)) as { workspaceId: string };
    const mB = (await client.mount(wsB)) as { workspaceId: string };
    const noteA = (await client.docsCreateNote(mA.workspaceId, {
      name: "a",
      type: "prompt",
    })) as { id: string };
    const noteB = (await client.docsCreateNote(mB.workspaceId, {
      name: "b",
      type: "prompt",
    })) as { id: string };
    await plantRunningTask(wsA, noteA.id);
    await plantRunningTask(wsB, noteB.id);

    const sentA = (await client.taskSendInput(mA.workspaceId, sharedTaskPath, {
      text: "from A",
    })) as { input: { id: string; workspaceId: string } };
    const sentB = (await client.taskSendInput(mB.workspaceId, sharedTaskPath, {
      text: "from B",
    })) as { input: { id: string; workspaceId: string } };
    assert.notEqual(sentA.input.id, sentB.input.id);
    assert.equal(sentA.input.workspaceId, mA.workspaceId);
    assert.equal(sentB.input.workspaceId, mB.workspaceId);

    const listA = (await client.taskInputListPending(
      mA.workspaceId,
      sharedTaskPath
    )) as { inputs: { id: string; text?: string }[] };
    assert.equal(listA.inputs.length, 1);
    assert.equal(listA.inputs[0]!.text, "from A");

    const listB = (await client.taskInputListPending(
      mB.workspaceId,
      sharedTaskPath
    )) as { inputs: { id: string; text?: string }[] };
    assert.equal(listB.inputs.length, 1);
    assert.equal(listB.inputs[0]!.text, "from B");

    // Cross-workspace get with A's id under B's scope → not found
    const crossGet = await rpcCall(
      svc.url,
      "taskInput.get",
      {
        workspaceId: mB.workspaceId,
        taskPath: sharedTaskPath,
        inputId: sentA.input.id,
      },
      { token: svc.token }
    );
    assert.ok(crossGet.error);
    assert.equal(crossGet.error!.code, -32004);

    // Cross-workspace ack with A's id under B's scope → not found
    const crossAck = await rpcCall(
      svc.url,
      "taskInput.ack",
      {
        workspaceId: mB.workspaceId,
        taskPath: sharedTaskPath,
        inputId: sentA.input.id,
        actor: "executor",
      },
      { token: svc.token }
    );
    assert.ok(crossAck.error);
    assert.equal(crossAck.error!.code, -32004);

    // Same-workspace ack still works
    const ackedA = (await client.taskInputAck(
      mA.workspaceId,
      sharedTaskPath,
      sentA.input.id,
      "executor"
    )) as { input: { status: string } };
    assert.equal(ackedA.input.status, "consumed");

    // Terminal task rejects sendInput
    await client.taskInterrupt(mA.workspaceId, sharedTaskPath);
    await assert.rejects(
      () =>
        client.taskSendInput(mA.workspaceId, sharedTaskPath, {
          text: "too late",
        }),
      /running or waiting|state=/
    );
  });
});

test("managed ACP: task.sendInput continues same session; delivered survives Delivery cleanup", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "BOOTSTRAP_PLACEHOLDER",
      followupText: "MANAGED_FINAL_REPORT_AFTER_USER_INPUT",
      promptDelayMs: 2_500,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "managed-input",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Managed sendInput flow",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string }; task: { state: string } };
    assert.equal(started.task.state, "running");

    await pollUntil(async () => {
      const sessions = (await client.sessionList(workspaceId)) as {
        sessions: { sessionId: string; alive: boolean }[];
      };
      return sessions.sessions.find(
        (s) => s.sessionId === started.session.sessionId && s.alive
      );
    }, 15_000, "session alive");

    // Keep task running long enough to inject before bootstrap auto-delivers.
    await client.taskWait(
      workspaceId,
      taskPath,
      "user-input",
      "hold for append"
    );

    await pollUntil(async () => {
      try {
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        if (!Array.isArray(log.prompts) || log.prompts.length < 1) return null;
        const t = (await client.taskGet(workspaceId, taskPath)) as {
          task: { state: string };
        };
        return t.task.state === "waiting" ? log : null;
      } catch {
        return null;
      }
    }, 15_000, "bootstrap finished while waiting");

    // Resume to running so managed inject path is typical; waiting also allowed.
    await client.taskResume(workspaceId, taskPath);

    const sent = (await client.taskSendInput(workspaceId, taskPath, {
      text: "Use the tighter plan",
      contextRefs: [created.id],
    })) as {
      input: { id: string; status: string };
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
      continueError?: string;
    };
    // RPC is durable accept only — must not wait for the provider turn.
    assert.equal(sent.accepted, true);
    assert.equal(sent.enqueued, true);
    assert.equal(sent.continued, false);
    assert.ok(
      sent.input.status === "pending" || sent.input.status === "processing",
      `accept status should be pending|processing, got ${sent.input.status}`
    );

    // Background FIFO inject → delivered (pin keeps race with prompt_complete safe).
    const inputDelivered = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        sent.input.id
      )) as { input: { status: string; deliveredAt?: string; lastError?: string } };
      if (got.input.status === "delivered") return got.input;
      if (got.input.status === "failed") {
        throw new Error(
          `managed inject failed: ${got.input.lastError ?? "unknown"}`
        );
      }
      return null;
    }, 20_000, "TaskInput delivered after background inject");
    assert.equal(inputDelivered.status, "delivered");
    assert.ok(inputDelivered.deliveredAt);

    const delivered = await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "managed delivery after user input");
    assert.equal(delivered.task.state, "delivered");

    // After task Delivery + session cleanup, managed-delivered input must stay delivered
    // (cancelSession/cancelTask must not rewrite it to cancelled).
    const afterCleanup = (await client.taskInputGet(
      workspaceId,
      taskPath,
      sent.input.id
    )) as {
      input: { status: string; deliveredAt?: string };
    };
    assert.equal(
      afterCleanup.input.status,
      "delivered",
      "managed-delivered TaskInput must remain delivered after Delivery/session cleanup"
    );
    assert.ok(afterCleanup.input.deliveredAt);

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    assert.ok(Array.isArray(log.prompts), "mock ACP should record prompts");
    assert.ok(
      log.prompts!.length >= 2,
      `expected bootstrap + User Input prompts, got ${log.prompts!.length}`
    );
    const followUp = log.prompts!.find((p) => p.includes("## User Input"));
    assert.ok(followUp, "follow-up prompt must contain ## User Input");
    assert.match(followUp!, /Use the tighter plan/);
    assert.match(followUp!, new RegExp(created.id));
  });
});

test("reject-resume: review note is U2A ## Review Feedback on restored managed session", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-reject-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "FIRST_DELIVERY_REPORT",
      followupText: "REWORK_AFTER_REVIEW_FEEDBACK",
      // Bootstrap completes quickly; follow-up is the review inject.
      promptDelayMs: 200,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "reject-review-item",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Work that will be rejected with review note",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string } };
    void started;

    // First managed delivery (bootstrap).
    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "first managed delivery");

    const exactNote = "  please fix the edge case and re-run tests  ";
    const t0 = Date.now();
    const rejected = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: true,
      note: exactNote,
    })) as {
      state: string;
      session?: { sessionId: string };
      input?: {
        id: string;
        kind?: string;
        status: string;
        text?: string;
        taskPath: string;
      };
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
      continueError?: string;
    };
    const rpcMs = Date.now() - t0;

    assert.equal(rejected.state, "running");
    assert.ok(rejected.session?.sessionId, "reject-resume must restore a session");
    assert.ok(rejected.input, "reject-resume must create a TaskInput for review note");
    assert.equal(rejected.input!.kind, "review-feedback");
    assert.equal(rejected.input!.text, exactNote, "review note must be preserved exactly");
    assert.equal(rejected.input!.taskPath, taskPath);
    // Same async accept contract as task.sendInput — durable accept + enqueue only.
    assert.equal(rejected.accepted, true);
    assert.equal(rejected.enqueued, true);
    assert.equal(
      rejected.continued,
      false,
      "reject-resume must not await the full Agent turn on the RPC"
    );
    assert.ok(
      rejected.input!.status === "pending" ||
        rejected.input!.status === "processing",
      `accept status should be pending|processing, got ${rejected.input!.status}`
    );
    // Restore is on the RPC path; inject is background — still well under turn delay.
    assert.ok(
      rpcMs < 5_000,
      `reject-resume accept must return without waiting full turn; rpcMs=${rpcMs}`
    );

    // Background FIFO inject → delivered.
    const inputDelivered = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        rejected.input!.id
      )) as { input: { status: string; deliveredAt?: string; lastError?: string } };
      if (got.input.status === "delivered") return got.input;
      if (got.input.status === "failed") {
        throw new Error(
          `review-feedback inject failed: ${got.input.lastError ?? "unknown"}`
        );
      }
      return null;
    }, 20_000, "review-feedback delivered after background inject");
    assert.equal(inputDelivered.status, "delivered");
    assert.ok(inputDelivered.deliveredAt);

    // Follow-up after review should re-deliver.
    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "rework delivery after review feedback");

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    assert.ok(Array.isArray(log.prompts));
    const reviewPrompt = log.prompts!.find((p) => p.includes("## Review Feedback"));
    assert.ok(reviewPrompt, "restored session must receive ## Review Feedback");
    assert.ok(
      reviewPrompt!.includes(`text: ${exactNote}`),
      "prompt must include exact review note"
    );
    assert.doesNotMatch(
      reviewPrompt!,
      /--- Tent reject-resume rework ---/,
      "review note must not use the old bootstrap rework channel"
    );
    // First bootstrap should not embed the review note as a second channel.
    const firstBootstrap = log.prompts![0] ?? "";
    assert.ok(
      !firstBootstrap.includes(exactNote.trim()) ||
        firstBootstrap.includes("## Review Feedback"),
      "review note is U2A-only after restore"
    );
  });
});

test("reject-resume: new session after dead prior rebinds review-feedback (not stranded on old ss-)", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-reject-newss-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "FIRST_DELIVERY_CROSS_SESSION",
      followupText: "REWORK_ON_NEW_SESSION",
      promptDelayMs: 200,
      // keepAlive keeps mock process up after prompt; harness explicitly
      // stopSession(prior) after deliver so reject-resume is forced onto the
      // dead-prior → new-ss- path (not the still-alive rebind path).
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "reject-cross-session",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Cross-session reject-resume rebind",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string } };
    const priorSessionId = started.session.sessionId;

    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "first managed delivery before cross-session reject");

    // Deterministically terminate the prior managed session via the public
    // runtime stop API. Do not rely on post-deliver stop side-effects or probe
    // timing: always stopSession, then assert terminal/dead before reject-resume
    // so restore is forced down the "prior dead → new ss-" path.
    await svc.runtime.stopSession(priorSessionId, "user");
    const priorProbe = await svc.runtime.probe(priorSessionId);
    assert.equal(
      priorProbe.alive,
      false,
      `prior session must be dead so reject-resume takes new-session path (state=${priorProbe.state})`
    );
    assert.ok(
      priorProbe.state === "stopped" || priorProbe.state === "failed",
      `prior session must be terminal; got state=${priorProbe.state}`
    );

    // Task must remain reject-resume-eligible (delivered), not failed by stop.
    const beforeReject = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string; sessionId?: string };
    };
    assert.equal(
      beforeReject.task.state,
      "delivered",
      "stopping prior session after deliver must leave task delivered for reject-resume"
    );
    assert.equal(beforeReject.task.sessionId, priorSessionId);

    const exactNote = "  cross-session: fix and re-run  ";
    const rejected = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: true,
      note: exactNote,
    })) as {
      state: string;
      session?: { sessionId: string };
      input?: {
        id: string;
        kind?: string;
        status: string;
        text?: string;
        sessionId?: string;
        taskPath: string;
      };
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
      continueError?: string;
    };

    assert.equal(rejected.state, "running");
    assert.ok(rejected.session?.sessionId, "must restore a live session");
    const newSessionId = rejected.session!.sessionId;
    assert.notEqual(
      newSessionId,
      priorSessionId,
      "agentProfile/role restore after deliver must allocate a new session id"
    );
    assert.equal(
      (await svc.runtime.probe(newSessionId)).alive,
      true,
      "restored session must be live"
    );
    assert.ok(rejected.input, "must create review-feedback TaskInput");
    assert.equal(rejected.input!.kind, "review-feedback");
    assert.equal(rejected.input!.text, exactNote);
    assert.equal(
      rejected.input!.sessionId,
      newSessionId,
      "review-feedback must bind to restored session, not the dead prior"
    );
    assert.notEqual(
      rejected.input!.sessionId,
      priorSessionId,
      "must not leave feedback keyed to the stopped session"
    );
    assert.equal(rejected.accepted, true);
    assert.equal(rejected.enqueued, true);
    assert.equal(
      rejected.continued,
      false,
      "RPC returns before background inject completes"
    );
    assert.ok(
      rejected.input!.status === "pending" ||
        rejected.input!.status === "processing",
      `got ${rejected.input!.status}`
    );

    // Background inject → delivered (rebind already done before enqueue).
    const inputDelivered = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        rejected.input!.id
      )) as { input: { status: string; sessionId?: string; lastError?: string } };
      if (got.input.status === "delivered") return got.input;
      if (got.input.status === "failed") {
        throw new Error(
          `review-feedback inject failed: ${got.input.lastError ?? "unknown"}`
        );
      }
      return null;
    }, 20_000, "cross-session review-feedback delivered");
    assert.equal(inputDelivered.sessionId, newSessionId);

    // Durable store: cancelSession(old) must not rewrite the rebound row.
    const cancelledOld = await svc.ctx.taskInputs.cancelSession(
      priorSessionId,
      "test.late-prior-exit"
    );
    assert.equal(
      cancelledOld.length,
      0,
      "cancelSession(prior) must not touch feedback rebound to new session"
    );
    const stored = await svc.ctx.taskInputs.get(
      rejected.input!.id,
      workspaceId,
      taskPath
    );
    assert.ok(stored);
    assert.equal(stored!.sessionId, newSessionId);
    assert.equal(stored!.status, "delivered");

    // No duplicate pending review-feedback for this task.
    const pending = (await client.taskInputListPending(
      workspaceId,
      taskPath
    )) as { inputs: { id: string; kind?: string }[] };
    assert.equal(
      pending.inputs.filter((i) => i.kind === "review-feedback").length,
      0,
      "delivered review-feedback must not remain pending (no double-consume)"
    );

    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "rework delivery on new session");

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    const reviewPrompts = (log.prompts ?? []).filter((p) =>
      p.includes("## Review Feedback")
    );
    assert.equal(
      reviewPrompts.length,
      1,
      `review feedback must inject exactly once; got ${reviewPrompts.length}`
    );
    assert.ok(
      reviewPrompts[0]!.includes(`text: ${exactNote}`),
      "single inject must carry the exact review note"
    );
  });
});

test("reject-resume external (no session): review feedback stays pending for poll/ack", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "external-reject",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "External role rework",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);
    await client.taskDeliver(workspaceId, taskPath, {
      summary: "first attempt",
    });

    const exactNote = "external: tighten summary wording";
    const rejected = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: true,
      note: exactNote,
    })) as {
      state: string;
      input?: { id: string; kind?: string; status: string; text?: string };
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
      session?: unknown;
    };

    assert.equal(rejected.state, "running");
    assert.equal(rejected.accepted, true);
    assert.equal(rejected.enqueued, false);
    assert.equal(rejected.continued, false);
    assert.ok(!rejected.session, "external path has no managed session restore");
    assert.ok(rejected.input);
    assert.equal(rejected.input!.kind, "review-feedback");
    assert.equal(rejected.input!.status, "pending");
    assert.equal(rejected.input!.text, exactNote);

    const pending = (await client.taskInputListPending(workspaceId, taskPath)) as {
      inputs: { id: string; kind?: string; text?: string; status: string }[];
    };
    assert.equal(pending.inputs.length, 1);
    assert.equal(pending.inputs[0]!.id, rejected.input!.id);
    assert.equal(pending.inputs[0]!.kind, "review-feedback");
    assert.equal(pending.inputs[0]!.text, exactNote);

    const acked = (await client.taskInputAck(
      workspaceId,
      taskPath,
      rejected.input!.id,
      "executor"
    )) as { input: { status: string } };
    assert.equal(acked.input.status, "consumed");
  });
});

test("reject-resume: slow follow-up returns accepted without headers-timeout wait", async () => {
  // Provider follow-up is slow (1.5s). Old path awaited the full turn on the
  // reject RPC and could trip CLI/fetch headers timeouts. New path restores +
  // durable-accepts quickly; inject finishes in the background.
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-reject-slow-")),
    "mock-acp.json"
  );
  const followupDelayMs = 1_500;
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "FIRST_SLOW_REJECT",
      followupText: "REWORK_SLOW_DONE",
      promptDelayMs: 150,
      followupDelayMs,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "reject-slow-turn",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Slow reject-resume inject",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    });

    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "first delivery before slow reject");

    const t0 = Date.now();
    const rejected = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: true,
      note: "SLOW_REVIEW_NOTE",
    })) as {
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
      state: string;
      session?: { sessionId: string };
      input: { id: string; status: string; kind?: string };
    };
    const rpcMs = Date.now() - t0;

    assert.equal(rejected.accepted, true);
    assert.equal(rejected.enqueued, true);
    assert.equal(rejected.continued, false);
    assert.equal(rejected.state, "running");
    assert.ok(rejected.session?.sessionId);
    assert.equal(rejected.input.kind, "review-feedback");
    // Must return far under the follow-up turn delay (headers-timeout safety).
    assert.ok(
      rpcMs < followupDelayMs - 200,
      `reject-resume must not wait slow turn; rpcMs=${rpcMs} followupDelayMs=${followupDelayMs}`
    );
    assert.ok(
      rejected.input.status === "pending" ||
        rejected.input.status === "processing",
      `got ${rejected.input.status}`
    );

    // Background still completes to delivered.
    const final = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        rejected.input.id
      )) as { input: { status: string; deliveredAt?: string } };
      return got.input.status === "delivered" ? got.input : null;
    }, 20_000, "slow reject-resume background delivered");
    assert.ok(final.deliveredAt);

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    assert.ok(
      (log.prompts ?? []).some((p) => p.includes("SLOW_REVIEW_NOTE")),
      "background inject must still reach ACP after fast accept"
    );
  });
});

test("reject-resume: background completion projects processing → delivered", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-reject-bg-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "FIRST_BG_REJECT",
      followupText: "BG_REWORK_OK",
      promptDelayMs: 150,
      followupDelayMs: 800,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "reject-bg-complete",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Background reject inject",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    });

    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "first delivery for bg reject");

    const rejected = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: true,
      note: "BG_COMPLETE_NOTE",
    })) as {
      accepted?: boolean;
      continued?: boolean;
      input: { id: string; status: string };
    };
    assert.equal(rejected.accepted, true);
    assert.equal(rejected.continued, false);

    // Eventually processing (or delivered if very fast) is visible; then delivered.
    await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        rejected.input.id
      )) as { input: { status: string } };
      return got.input.status === "processing" ||
        got.input.status === "delivered"
        ? got.input.status
        : null;
    }, 5_000, "reject-resume processing or delivered projection");

    const final = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        rejected.input.id
      )) as { input: { status: string; deliveredAt?: string } };
      return got.input.status === "delivered" ? got.input : null;
    }, 20_000, "reject-resume async input delivered");
    assert.equal(final.status, "delivered");
    assert.ok(final.deliveredAt);

    // Rework delivery still single-track after background inject.
    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "rework delivery after bg review-feedback");
  });
});

test("reject-resume: failed inject stays retryable; uncertain is at-most-once", async () => {
  // True inject failure retains failed (listPending + markPendingForRetry ok).
  // Uncertain (inject ok, markDelivered failed) never re-injects.
  const { TaskInputStore, makeTaskInputId } = await import(
    "../src/service/task-input-store.js"
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-reject-fail-"));
  const store = new TaskInputStore(dataDir);
  const workspaceId = "ws-reject-fail";
  const taskPath = "temp/r/tasks/reject-fail.md";
  const now = new Date().toISOString();

  const failedId = makeTaskInputId(() => 0.31);
  await store.add({
    id: failedId,
    workspaceId,
    taskPath,
    sessionId: "ss-reject-fail",
    kind: "review-feedback",
    text: "retry me",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  await store.markProcessing(failedId);
  const failed = await store.markFailed(
    failedId,
    "managed inject did not continue; external agent may poll taskInput",
    "service"
  );
  assert.equal(failed.status, "failed");
  assert.ok(failed.lastError);
  const openFailed = await store.listPending(workspaceId, taskPath);
  assert.ok(
    openFailed.some((r) => r.id === failedId),
    "failed review-feedback must remain poll-visible for retry"
  );
  const retried = await store.markPendingForRetry(failedId, workspaceId, taskPath);
  assert.equal(retried.status, "pending");
  // Claim again for a second inject attempt (no double-inject while processing).
  await store.markProcessing(failedId);
  await assert.rejects(
    () => store.markProcessing(failedId),
    /pending or failed/,
    "processing row must not be re-claimed (duplicate inject protection)"
  );

  const uncertainId = makeTaskInputId(() => 0.32);
  await store.add({
    id: uncertainId,
    workspaceId,
    taskPath,
    sessionId: "ss-reject-unc",
    kind: "review-feedback",
    text: "once only after inject-ok",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  await store.markProcessing(uncertainId);
  const uncertain = await store.markUncertain(
    uncertainId,
    "managed inject ok but markDelivered failed: EIO",
    "service"
  );
  assert.equal(uncertain.status, "uncertain");
  const openUnc = await store.listPending(workspaceId, taskPath);
  assert.equal(
    openUnc.filter((r) => r.id === uncertainId).length,
    0,
    "uncertain must not appear as retryable open"
  );
  await assert.rejects(
    () => store.markProcessing(uncertainId),
    /pending or failed/
  );
  await assert.rejects(
    () => store.markPendingForRetry(uncertainId, workspaceId, taskPath),
    /uncertain/
  );
  // Restart: uncertain stays uncertain (no re-inject as pending).
  const reloaded = new TaskInputStore(dataDir);
  const again = await reloaded.get(uncertainId, workspaceId, taskPath);
  assert.equal(again?.status, "uncertain");
  await assert.rejects(() => reloaded.markProcessing(uncertainId), /pending or failed/);
});

test("reject-resume: second reject while rework running is rejected (no double inject)", async () => {
  // Lifecycle: reject only from delivered. A second reject while rework is
  // running fails loud — does not create a second review-feedback or re-inject.
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-reject-dup-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "FIRST_DUP_REJECT",
      followupText: "REWORK_DUP",
      // Slow inject so second reject races while first feedback is in flight.
      promptDelayMs: 150,
      followupDelayMs: 1_200,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "reject-dup-protect",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Double reject protection",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    });

    await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "first delivery for dup reject");

    const first = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: true,
      note: "FIRST_FEEDBACK_ONLY",
    })) as {
      accepted?: boolean;
      input: { id: string };
      state: string;
    };
    assert.equal(first.accepted, true);
    assert.equal(first.state, "running");

    // Immediate second reject while occupation is rework/running — must fail.
    await assert.rejects(
      () =>
        client.taskReject(workspaceId, taskPath, "user", {
          resume: true,
          note: "SECOND_MUST_NOT_INJECT",
        }),
      /delivered|reject|state/i
    );

    // First row still present with the original note (no second accept).
    const firstRow = (await client.taskInputGet(
      workspaceId,
      taskPath,
      first.input.id
    )) as { input: { id: string; text?: string; kind?: string } };
    assert.equal(firstRow.input.kind, "review-feedback");
    assert.equal(firstRow.input.text, "FIRST_FEEDBACK_ONLY");

    // listPending may omit mid-inject processing; after settle only the first id.
    await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        first.input.id
      )) as { input: { status: string } };
      return got.input.status === "delivered" || got.input.status === "failed"
        ? got.input.status
        : null;
    }, 20_000, "single review-feedback settles");

    const pending = (await client.taskInputListPending(
      workspaceId,
      taskPath
    )) as { inputs: { id: string; kind?: string; text?: string }[] };
    assert.equal(
      pending.inputs.filter(
        (i) =>
          i.kind === "review-feedback" && i.text === "SECOND_MUST_NOT_INJECT"
      ).length,
      0,
      "second reject must not leave a review-feedback row"
    );

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    const reviewPrompts = (log.prompts ?? []).filter((p) =>
      p.includes("## Review Feedback")
    );
    assert.ok(
      reviewPrompts.length <= 1,
      `review feedback inject at most once; got ${reviewPrompts.length}`
    );
    assert.ok(
      !(log.prompts ?? []).some((p) => p.includes("SECOND_MUST_NOT_INJECT")),
      "second reject note must never inject"
    );
  });
});

test("reject --no-resume: terminal reject without review-feedback or session restore", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "no-resume-item",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "Terminal reject path",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);
    await client.taskDeliver(workspaceId, taskPath, {
      summary: "will reject terminal",
    });

    const rejected = (await client.taskReject(workspaceId, taskPath, "user", {
      resume: false,
      note: "no rework",
    })) as {
      state: string;
      input?: unknown;
      accepted?: boolean;
      session?: unknown;
    };
    assert.equal(rejected.state, "rejected");
    assert.ok(!rejected.input, "terminal reject must not create review-feedback");
    assert.ok(!rejected.session);
    assert.ok(rejected.accepted === undefined);

    const pending = (await client.taskInputListPending(
      workspaceId,
      taskPath
    )) as { inputs: unknown[] };
    assert.equal(pending.inputs.length, 0);
  });
});

test("managed U2A: concurrent sends on same task are FIFO and non-overlapping", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-fifo-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "BOOTSTRAP_HOLD",
      followupText: "FOLLOWUP_OK",
      // Long enough that overlapping turns would interleave if not serialized.
      promptDelayMs: 400,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "fifo-item",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "FIFO serialization",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string } };

    await pollUntil(async () => {
      const sessions = (await client.sessionList(workspaceId)) as {
        sessions: { sessionId: string; alive: boolean }[];
      };
      return sessions.sessions.find(
        (s) => s.sessionId === started.session.sessionId && s.alive
      );
    }, 15_000, "session alive");

    await client.taskWait(workspaceId, taskPath, "user-input", "hold for fifo");
    await pollUntil(async () => {
      try {
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        const t = (await client.taskGet(workspaceId, taskPath)) as {
          task: { state: string };
        };
        return log.prompts && log.prompts.length >= 1 && t.task.state === "waiting"
          ? log
          : null;
      } catch {
        return null;
      }
    }, 15_000, "bootstrap done while waiting");

    await client.taskResume(workspaceId, taskPath);

    const tAccept0 = Date.now();
    const p1 = client.taskSendInput(workspaceId, taskPath, { text: "FIRST_U2A" });
    // Start second while first is still in-flight.
    await new Promise((r) => setTimeout(r, 30));
    const p2 = client.taskSendInput(workspaceId, taskPath, { text: "SECOND_U2A" });
    const [r1, r2] = (await Promise.all([p1, p2])) as [
      {
        input: { id: string; status: string; text?: string };
        accepted?: boolean;
        enqueued?: boolean;
        continued?: boolean;
      },
      {
        input: { id: string; status: string; text?: string };
        accepted?: boolean;
        enqueued?: boolean;
        continued?: boolean;
      },
    ];
    const acceptElapsed = Date.now() - tAccept0;

    // Both accepts return before two full turns (delay 400ms each).
    assert.ok(
      acceptElapsed < 700,
      `sendInput RPC must not await full FIFO turns; elapsed=${acceptElapsed}ms`
    );
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);
    assert.equal(r1.enqueued, true);
    assert.equal(r2.enqueued, true);
    assert.equal(r1.continued, false);
    assert.equal(r2.continued, false);
    assert.equal(r1.input.text, "FIRST_U2A");
    assert.equal(r2.input.text, "SECOND_U2A");

    // Background FIFO still delivers in order without dropping the second item.
    await pollUntil(async () => {
      const a = (await client.taskInputGet(workspaceId, taskPath, r1.input.id)) as {
        input: { status: string };
      };
      const b = (await client.taskInputGet(workspaceId, taskPath, r2.input.id)) as {
        input: { status: string };
      };
      return a.input.status === "delivered" && b.input.status === "delivered"
        ? true
        : null;
    }, 20_000, "both FIFO inputs delivered");

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    const u2a = (log.prompts ?? []).filter((p) => p.includes("## User Input"));
    assert.equal(u2a.length, 2, `expected 2 User Input prompts, got ${u2a.length}`);
    assert.match(u2a[0]!, /FIRST_U2A/);
    assert.match(u2a[1]!, /SECOND_U2A/);
    // Order: first send's text before second's in the ACP prompt log.
    const iFirst = log.prompts!.findIndex((p) => p.includes("FIRST_U2A"));
    const iSecond = log.prompts!.findIndex((p) => p.includes("SECOND_U2A"));
    assert.ok(iFirst >= 0 && iSecond > iFirst, "FIFO order must be preserved");
  });
});

test("managed U2A: different tasks remain concurrent (not process-wide serial)", async () => {
  const ws = await makeWorkspace();
  const logA = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-conc-a-")),
    "a.json"
  );
  const logB = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-conc-b-")),
    "b.json"
  );
  // Two profiles + two roles so each task has its own managed session (role lane).
  const profiles = [
    mockAcpProfile("mock-ti-a", {
      logPath: logA,
      promptText: "BOOT_A",
      followupText: "DONE_A",
      promptDelayMs: 900,
      keepAlive: true,
    }),
    mockAcpProfile("mock-ti-b", {
      logPath: logB,
      promptText: "BOOT_B",
      followupText: "DONE_B",
      promptDelayMs: 900,
      keepAlive: true,
    }),
  ];

  const rolesPath = path.join(ws, ".tent", "roles.json");
  await fs.writeFile(
    rolesPath,
    JSON.stringify(
      {
        roles: [
          {
            name: "role-a",
            prompt: "do work a",
            a2aPolicy: "allow",
            allowedProfiles: ["mock-ti-a"],
          },
          {
            name: "role-b",
            prompt: "do work b",
            a2aPolicy: "allow",
            allowedProfiles: ["mock-ti-b"],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    async function parkTask(
      name: string,
      role: string,
      profileId: string,
      logFile: string
    ): Promise<string> {
      const created = (await client.docsCreateNote(workspaceId, {
        name,
        type: "prompt",
      })) as { id: string };
      const dispatched = (await client.taskDispatch(workspaceId, {
        boxId: created.id,
        role,
        prompt: `concurrent ${name}`,
        deliveryPolicy: "manual",
      })) as { taskPath: string };
      const taskPath = dispatched.taskPath;
      await client.taskStartSession(workspaceId, {
        taskPath,
        profileId,
        callerKind: "user",
      });
      // Park before bootstrap prompt_complete can deliver (delay=900ms).
      await client.taskWait(workspaceId, taskPath, "user-input", "hold");
      await pollUntil(async () => {
        try {
          const logRaw = await fs.readFile(logFile, "utf8");
          const log = JSON.parse(logRaw) as { prompts?: string[] };
          const t = (await client.taskGet(workspaceId, taskPath)) as {
            task: { state: string };
          };
          return log.prompts &&
            log.prompts.length >= 1 &&
            t.task.state === "waiting"
            ? t
            : null;
        } catch {
          return null;
        }
      }, 15_000, `${name} bootstrap finished while waiting`);
      // Stay waiting so peer setup cannot race auto-deliver.
      return taskPath;
    }

    const taskA = await parkTask("conc-a", "role-a", "mock-ti-a", logA);
    const taskB = await parkTask("conc-b", "role-b", "mock-ti-b", logB);

    // sendInput allows waiting; inject while both are still waiting so no
    // resume→bootstrap race. Bootstrap already completed → follow-up works.
    const t0 = Date.now();
    const [ra, rb] = (await Promise.all([
      client.taskSendInput(workspaceId, taskA, { text: "INPUT_A" }),
      client.taskSendInput(workspaceId, taskB, { text: "INPUT_B" }),
    ])) as [
      {
        accepted?: boolean;
        enqueued?: boolean;
        continued?: boolean;
        input: { id: string; status: string };
      },
      {
        accepted?: boolean;
        enqueued?: boolean;
        continued?: boolean;
        input: { id: string; status: string };
      },
    ];
    const acceptElapsed = Date.now() - t0;

    assert.equal(ra.accepted, true);
    assert.equal(rb.accepted, true);
    assert.equal(ra.enqueued, true);
    assert.equal(rb.enqueued, true);
    assert.equal(ra.continued, false);
    assert.equal(rb.continued, false);
    // Accept must return well under one full turn delay (900ms).
    assert.ok(
      acceptElapsed < 700,
      `sendInput accept must not await provider turns; elapsed=${acceptElapsed}ms`
    );

    const settleStart = Date.now();
    await pollUntil(async () => {
      const a = (await client.taskInputGet(workspaceId, taskA, ra.input.id)) as {
        input: { status: string };
      };
      const b = (await client.taskInputGet(workspaceId, taskB, rb.input.id)) as {
        input: { status: string };
      };
      return a.input.status === "delivered" && b.input.status === "delivered"
        ? true
        : null;
    }, 20_000, "both concurrent task inputs delivered");
    const settleElapsed = Date.now() - settleStart;
    // Follow-up delay 900ms; process-wide serial ≈ 1800ms+. Concurrent ~900–1400ms.
    assert.ok(
      settleElapsed < 1_600,
      `unrelated tasks must not be process-wide serialized; settleElapsed=${settleElapsed}ms`
    );
  });
});

test("managed U2A: failed inject leaves item failed (not dropped) and does not orphan later queue items", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "fail-queue",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "queue failure semantics",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);

    // Bind a dead session id so managed continue fails (not live, not resume-capable).
    const mount = svc.ctx.host.require(workspaceId);
    const { patchTaskEnvelope } = await import("../src/core/task.js");
    await patchTaskEnvelope(mount.env.fs, taskPath, {
      sessionId: "ss-dead-not-in-registry",
      updatedAt: new Date().toISOString(),
    });

    const first = (await client.taskSendInput(workspaceId, taskPath, {
      text: "WILL_FAIL_INJECT",
    })) as {
      input: { id: string; status: string };
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
    };
    assert.equal(first.accepted, true);
    assert.equal(first.enqueued, true);
    assert.equal(first.continued, false);
    // Accept is immediate; background marks failed (not cancelled/dropped).
    const firstFailed = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        first.input.id
      )) as { input: { status: string; lastError?: string } };
      return got.input.status === "failed" ? got.input : null;
    }, 10_000, "first input failed after inject");
    assert.ok(firstFailed.lastError, "failure must retain lastError");

    const second = (await client.taskSendInput(workspaceId, taskPath, {
      text: "STILL_QUEUED_AFTER_FAIL",
    })) as {
      input: { id: string; status: string };
      accepted?: boolean;
    };
    // Also fails inject (same dead session) but must still be accepted —
    // failure of first must not orphan/drop the later queue item.
    assert.equal(second.accepted, true);
    assert.notEqual(second.input.id, first.input.id);

    await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        second.input.id
      )) as { input: { status: string } };
      return got.input.status === "failed" ? true : null;
    }, 10_000, "second input failed after inject");

    const pending = (await client.taskInputListPending(workspaceId, taskPath)) as {
      inputs: { id: string; text?: string; status: string }[];
    };
    // failed rows remain poll-visible (not dropped).
    assert.equal(pending.inputs.length, 2);
    const texts = pending.inputs.map((i) => i.text).sort();
    assert.deepEqual(texts, ["STILL_QUEUED_AFTER_FAIL", "WILL_FAIL_INJECT"].sort());
    assert.ok(pending.inputs.every((i) => i.status === "failed"));

    // Lifecycle interrupt still cancels open failed rows.
    await client.taskInterrupt(workspaceId, taskPath);
    const after = (await client.taskInputListPending(workspaceId, taskPath)) as {
      inputs: unknown[];
    };
    assert.equal(after.inputs.length, 0);

    const got1 = (await client.taskInputGet(
      workspaceId,
      taskPath,
      first.input.id
    )) as { input: { status: string } };
    assert.equal(got1.input.status, "cancelled");
  });
});

test("task.sendInput: RPC returns accepted before managed turn finishes; status projects processing→delivered", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-async-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "BOOTSTRAP_ASYNC",
      followupText: "AFTER_ASYNC_INPUT",
      // Long turn so accept-vs-delivered gap is measurable.
      promptDelayMs: 1_200,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "async-accept",
      type: "prompt",
    })) as { id: string };

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "async accept path",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string } };

    await pollUntil(async () => {
      const sessions = (await client.sessionList(workspaceId)) as {
        sessions: { sessionId: string; alive: boolean }[];
      };
      return sessions.sessions.find(
        (s) => s.sessionId === started.session.sessionId && s.alive
      );
    }, 15_000, "session alive");

    await client.taskWait(workspaceId, taskPath, "user-input", "hold async");
    await pollUntil(async () => {
      try {
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        const t = (await client.taskGet(workspaceId, taskPath)) as {
          task: { state: string };
        };
        return log.prompts &&
          log.prompts.length >= 1 &&
          t.task.state === "waiting"
          ? log
          : null;
      } catch {
        return null;
      }
    }, 15_000, "bootstrap done while waiting");
    await client.taskResume(workspaceId, taskPath);

    const t0 = Date.now();
    const sent = (await client.taskSendInput(workspaceId, taskPath, {
      text: "ASYNC_BODY",
    })) as {
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
      input: { id: string; status: string };
    };
    const rpcMs = Date.now() - t0;

    assert.equal(sent.accepted, true);
    assert.equal(sent.enqueued, true);
    assert.equal(sent.continued, false);
    // Must return far under the follow-up turn delay (1200ms).
    assert.ok(
      rpcMs < 600,
      `sendInput must return accepted without waiting turn; rpcMs=${rpcMs}`
    );
    assert.ok(
      sent.input.status === "pending" || sent.input.status === "processing",
      `got ${sent.input.status}`
    );

    // Eventually processing (or delivered if very fast) is visible; then delivered.
    await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        sent.input.id
      )) as { input: { status: string } };
      return got.input.status === "processing" ||
        got.input.status === "delivered"
        ? got.input.status
        : null;
    }, 5_000, "processing or delivered projection");

    const final = await pollUntil(async () => {
      const got = (await client.taskInputGet(
        workspaceId,
        taskPath,
        sent.input.id
      )) as { input: { status: string; deliveredAt?: string } };
      return got.input.status === "delivered" ? got.input : null;
    }, 20_000, "async input delivered");
    assert.equal(final.status, "delivered");
    assert.ok(final.deliveredAt);

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    assert.ok(
      (log.prompts ?? []).some((p) => p.includes("ASYNC_BODY")),
      "background inject must still reach ACP"
    );
  });
});

test("task.sendInput: service stop drains background work without unhandled rejection", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-drain-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "BOOT_DRAIN",
      followupText: "FOLLOW_DRAIN",
      promptDelayMs: 800,
      keepAlive: true,
    }),
  ];

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-drain-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles,
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "drain-item",
      type: "prompt",
    })) as { id: string };
    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "drain semantics",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string } };

    await pollUntil(async () => {
      const sessions = (await client.sessionList(workspaceId)) as {
        sessions: { sessionId: string; alive: boolean }[];
      };
      return sessions.sessions.find(
        (s) => s.sessionId === started.session.sessionId && s.alive
      );
    }, 15_000, "session alive for drain");

    await client.taskWait(workspaceId, taskPath, "user-input", "hold drain");
    await pollUntil(async () => {
      try {
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        const t = (await client.taskGet(workspaceId, taskPath)) as {
          task: { state: string };
        };
        return log.prompts &&
          log.prompts.length >= 1 &&
          t.task.state === "waiting"
          ? true
          : null;
      } catch {
        return null;
      }
    }, 15_000, "bootstrap parked");
    await client.taskResume(workspaceId, taskPath);

    const sent = (await client.taskSendInput(workspaceId, taskPath, {
      text: "DRAIN_ME",
    })) as { accepted?: boolean; input: { id: string } };
    assert.equal(sent.accepted, true);

    // Stop while background inject may still be running — must not throw from
    // unhandled rejection; drain settles or leaves durable state.
    await svc.stop();
  } finally {
    try {
      await svc.stop();
    } catch {
      // already stopped
    }
  }
});

test("task.sendInput: hung follow-up turns stop promptly; durable row retained; no unhandled", async () => {
  // Provider hangs on U2A follow-up. Old order drained before runtime.shutdown and
  // could wait full promptTimeout (profile 30min / test 20s). New order interrupts
  // runtime first, then bounded drain; store stays writable until drain ends.
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-hang-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ti", {
      logPath,
      promptText: "BOOT_HANG",
      followupText: "SHOULD_NOT_FINISH",
      // Park bootstrap long enough to taskWait before auto-delivery races.
      promptDelayMs: 2_500,
      hangFollowup: true,
      keepAlive: true,
      // Large timeout proves we do not wait for it on stop.
      promptTimeoutMs: 20_000,
    }),
  ];

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-hang-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles,
  });
  let inputId = "";
  let workspaceId = "";
  let taskPath = "";
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "hang-item",
      type: "prompt",
    })) as { id: string };
    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "hang shutdown",
      deliveryPolicy: "manual",
    })) as { taskPath: string };
    taskPath = dispatched.taskPath;
    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ti",
      callerKind: "user",
    })) as { session: { sessionId: string } };

    await pollUntil(async () => {
      const sessions = (await client.sessionList(workspaceId)) as {
        sessions: { sessionId: string; alive: boolean }[];
      };
      return sessions.sessions.find(
        (s) => s.sessionId === started.session.sessionId && s.alive
      );
    }, 15_000, "session alive for hang");

    // Park before bootstrap prompt_complete can deliver (delay=2500ms).
    await client.taskWait(workspaceId, taskPath, "user-input", "hold hang");
    await pollUntil(async () => {
      try {
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        const t = (await client.taskGet(workspaceId, taskPath)) as {
          task: { state: string };
        };
        return log.prompts &&
          log.prompts.length >= 1 &&
          t.task.state === "waiting"
          ? true
          : null;
      } catch {
        return null;
      }
    }, 15_000, "bootstrap parked for hang");
    await client.taskResume(workspaceId, taskPath);

    const sent = (await client.taskSendInput(workspaceId, taskPath, {
      text: "HANG_U2A",
    })) as { accepted?: boolean; input: { id: string } };
    assert.equal(sent.accepted, true);
    inputId = sent.input.id;

    // Inject claimed (processing) and mock saw the follow-up — then hangs.
    await pollUntil(async () => {
      try {
        const got = (await client.taskInputGet(
          workspaceId,
          taskPath,
          sent.input.id
        )) as { input: { status: string } };
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        const saw = (log.prompts ?? []).some((p) => p.includes("HANG_U2A"));
        return got.input.status === "processing" && saw ? true : null;
      } catch {
        return null;
      }
    }, 15_000, "hang follow-up in processing");

    const t0 = Date.now();
    await svc.stop();
    const stopMs = Date.now() - t0;
    // Must finish well under promptTimeout (20s); allow room for process kill +
    // bounded drain (5s) — still far below a full prompt wait.
    assert.ok(
      stopMs < 12_000,
      `stop must not wait full promptTimeout; stopMs=${stopMs}`
    );

    // Durable record retained (not dropped). After interrupt, status is
    // failed/pending/uncertain/delivered — never missing from the store file.
    const { TaskInputStore } = await import("../src/service/task-input-store.js");
    const store = new TaskInputStore(dataDir);
    const row = await store.get(inputId, workspaceId, taskPath);
    assert.ok(row, "TaskInput row must survive shutdown");
    assert.ok(
      row.status === "pending" ||
        row.status === "processing" ||
        row.status === "failed" ||
        row.status === "delivered" ||
        row.status === "uncertain" ||
        row.status === "cancelled",
      `unexpected status after hung shutdown: ${row.status}`
    );
  } finally {
    try {
      await svc.stop();
    } catch {
      // already stopped
    }
  }
});

test("task.sendInput: inject-ok + markDelivered failure → uncertain (no re-inject)", async () => {
  // Unit-level path via store + deliver semantics is covered in task-input-store.
  // Here: simulate post-inject confirmation failure by marking uncertain and
  // proving a subsequent deliverManaged path would skip (status not pending/failed).
  const { TaskInputStore, makeTaskInputId } = await import(
    "../src/service/task-input-store.js"
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ti-unc-svc-"));
  const store = new TaskInputStore(dataDir);
  const id = makeTaskInputId(() => 0.21);
  const workspaceId = "ws-unc-svc";
  const taskPath = "temp/r/tasks/unc-svc.md";
  const now = new Date().toISOString();
  await store.add({
    id,
    workspaceId,
    taskPath,
    sessionId: "ss-unc",
    text: "once only",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  await store.markProcessing(id);
  const u = await store.markUncertain(
    id,
    "managed inject ok but markDelivered failed: EIO",
    "service"
  );
  assert.equal(u.status, "uncertain");

  // listPending must not surface for ordinary retry / recovery inject.
  const open = await store.listPending(workspaceId, taskPath);
  assert.equal(open.length, 0);

  // Second "retry" claim must fail — at-most-once.
  await assert.rejects(() => store.markProcessing(id), /pending or failed/);
  await assert.rejects(
    () => store.markPendingForRetry(id, workspaceId, taskPath),
    /uncertain/
  );

  // Restart still blocks re-inject.
  const reloaded = new TaskInputStore(dataDir);
  const again = await reloaded.get(id, workspaceId, taskPath);
  assert.equal(again?.status, "uncertain");
  await assert.rejects(() => reloaded.markProcessing(id), /pending or failed/);
});
