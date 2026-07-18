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
    keepAlive?: boolean;
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
      MOCK_ACP_PROMPT_MODE: "ok",
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 15_000,
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
      continued?: boolean;
      continueError?: string;
    };
    assert.equal(
      sent.continued,
      true,
      `expected managed continue; continueError=${sent.continueError ?? "none"}`
    );
    // sendFollowUpPrompt awaits the full turn; prompt_complete may have already
    // auto-delivered and run cancelSession while the row was still pending.
    // beginManagedInject must keep that window non-cancelable so status is delivered.
    assert.equal(
      sent.input.status,
      "delivered",
      "managed inject success must mark delivered even when prompt_complete races markDelivered"
    );

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
