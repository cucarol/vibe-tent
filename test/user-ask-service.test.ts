/**
 * A2U UserAsk + U2A continue via Local Service RPC (mock ACP; no paid networks).
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
      // Managed finals must lead with structured outcome: delivered|blocked|needs-input.
      MOCK_ACP_PROMPT_TEXT:
        opts.promptText ?? "outcome: delivered\n\nMANAGED_FINAL_REPORT",
      ...(opts.followupText
        ? { MOCK_ACP_FOLLOWUP_TEXT: opts.followupText }
        : {}),
      ...(opts.promptDelayMs != null
        ? { MOCK_ACP_PROMPT_DELAY_MS: String(opts.promptDelayMs) }
        : {}),
      // Keep session open after first bootstrap so follow-up can land.
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
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ua-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "user-ask",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
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
            allowedProfiles: ["mock-ua"],
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ua-data-"));
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

test("CLIENT_METHODS includes task.askUser and userAsk.*", () => {
  assert.ok(CLIENT_METHODS.includes("task.askUser"));
  assert.ok(CLIENT_METHODS.includes("userAsk.listPending"));
  assert.ok(CLIENT_METHODS.includes("userAsk.get"));
  assert.ok(CLIENT_METHODS.includes("userAsk.reply"));
  assert.ok(CLIENT_METHODS.includes("userAsk.deny"));
});

test("task.askUser parks running task; second ask rejected; reply resumes + persists answer", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "work-item",
      type: "prompt",
    }));
    const nodeId = created.nodeId;

    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [nodeId],
      role: "executor",
      prompt: "Need a product decision",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);

    const asked = (await client.taskAskUser(workspaceId, taskPath, {
      question: "Ship v1 or v2?",
      choices: [
        { id: "v1", label: "Ship v1" },
        { id: "v2", label: "Ship v2" },
      ],
    })) as {
      state: string;
      ask: { id: string; status: string; question: string };
    };
    assert.equal(asked.state, "waiting");
    assert.equal(asked.ask.status, "pending");
    assert.equal(asked.ask.question, "Ship v1 or v2?");

    const pending = (await client.userAskListPending(workspaceId)) as {
      asks: { id: string }[];
    };
    assert.equal(pending.asks.length, 1);
    assert.equal(pending.asks[0]!.id, asked.ask.id);

    await assert.rejects(
      () =>
        client.taskAskUser(workspaceId, taskPath, {
          question: "Second ask should fail",
        }),
      /pending UserAsk|already has a pending/
    );

    // Agent cannot self-reply
    const agentReply = await rpcCall(
      svc.url,
      "userAsk.reply",
      {
        askId: asked.ask.id,
        actor: "executor",
        answer: "nope",
      },
      { token: svc.token }
    );
    assert.ok(agentReply.error);
    assert.equal(agentReply.error!.code, -32001);

    const replied = (await client.userAskReply(asked.ask.id, {
      answer: "Ship v1 first",
      choiceId: "v1",
    })) as {
      ask: { status: string; answer?: string; choiceId?: string };
      state: string | null;
    };
    assert.equal(replied.ask.status, "answered");
    assert.equal(replied.ask.answer, "Ship v1 first");
    assert.equal(replied.ask.choiceId, "v1");
    assert.equal(replied.state, "running");

    const got = (await client.userAskGet(asked.ask.id)) as {
      ask: { status: string; answer?: string };
    };
    assert.equal(got.ask.status, "answered");
    assert.equal(got.ask.answer, "Ship v1 first");

    const task = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(task.task.state, "running");

    // External agent path: deliver after observing answer (no chat).
    await client.taskDeliver(workspaceId, taskPath, {
      summary: "Chose v1 per user answer",
    });
    const after = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(after.task.state, "delivered");
  });
});

test("userAsk.deny resumes task; interrupt cancels pending ask", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "deny-item",
      type: "prompt",
    }));

    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [created.nodeId],
      role: "executor",
      prompt: "Ask then deny",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;
    await client.taskClaim(workspaceId, taskPath);

    const asked = (await client.taskAskUser(workspaceId, taskPath, {
      question: "Approve risky change?",
    })) as { ask: { id: string } };

    const denied = (await client.userAskDeny(asked.ask.id)) as {
      ask: { status: string };
      state: string | null;
    };
    assert.equal(denied.ask.status, "denied");
    assert.equal(denied.state, "running");

    // Second ask after deny is allowed
    const asked2 = (await client.taskAskUser(workspaceId, taskPath, {
      question: "Retry with safer plan?",
    })) as { ask: { id: string }; state: string };
    assert.equal(asked2.state, "waiting");

    await client.taskInterrupt(workspaceId, taskPath);
    const cancelled = (await client.userAskGet(asked2.ask.id)) as {
      ask: { status: string };
    };
    assert.equal(cancelled.ask.status, "cancelled");

    const task = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(task.task.state, "interrupted");
  });
});

test("managed ACP: UserAsk reply continues same session with User Answer prompt then Delivery", async () => {
  const ws = await makeWorkspace();
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-ua-log-")),
    "mock-acp.json"
  );
  const profiles = [
    mockAcpProfile("mock-ua", {
      logPath,
      // Slow bootstrap so askUser can park the task before auto-delivery races.
      // Follow-up User Answer prompt returns the real deliverable report.
      promptText: "BOOTSTRAP_PLACEHOLDER",
      followupText: "outcome: delivered\n\nMANAGED_FINAL_REPORT_AFTER_USER_ANSWER",
      promptDelayMs: 2_500,
      keepAlive: true,
    }),
  ];

  await withService(profiles, async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "managed-ask",
      type: "prompt",
    }));

    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [created.nodeId],
      role: "executor",
      prompt: "Managed ask flow",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      deliveryPolicy: "review",
    })) as { taskPath: string };
    const taskPath = dispatched.taskPath;

    // startSession auto-claims on user path
    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "mock-ua",
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

    // Must ask while still running — delayed bootstrap guarantees this window.
    // Parking on waiting means bootstrap prompt_complete cannot auto-deliver
    // (tryManagedAutoDeliver requires running), so the session stays live.
    const beforeAsk = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(
      beforeAsk.task.state,
      "running",
      "bootstrap delay must keep task running long enough for askUser"
    );

    const asked = (await client.taskAskUser(workspaceId, taskPath, {
      question: "Which branch?",
      choices: [
        { id: "main", label: "main" },
        { id: "role", label: "role branch" },
      ],
    })) as { ask: { id: string }; state: string };
    assert.equal(asked.state, "waiting");

    // Wait until bootstrap prompt has finished (logged) while task stays waiting.
    // Replying before that races: resume→running then bootstrap auto-delivers.
    await pollUntil(async () => {
      try {
        const logRaw = await fs.readFile(logPath, "utf8");
        const log = JSON.parse(logRaw) as { prompts?: string[] };
        if (!Array.isArray(log.prompts) || log.prompts.length < 1) return null;
        const t = (await client.taskGet(workspaceId, taskPath)) as {
          task: { state: string };
        };
        // Still waiting = bootstrap did not steal delivery.
        return t.task.state === "waiting" ? log : null;
      } catch {
        return null;
      }
    }, 15_000, "bootstrap prompt finished while task waiting");

    const replied = (await client.userAskReply(asked.ask.id, {
      answer: "Use role branch",
      choiceId: "role",
    })) as {
      ask: { status: string; answer?: string };
      state: string | null;
      continued?: boolean;
      continueError?: string;
    };
    assert.equal(replied.ask.status, "answered");
    assert.equal(replied.ask.answer, "Use role branch");
    // Managed follow-up must be genuinely exercised (not optionally skipped).
    assert.equal(
      replied.continued,
      true,
      `expected managed continue; continueError=${replied.continueError ?? "none"}`
    );

    const delivered = await pollUntil(async () => {
      const t = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      return t.task.state === "delivered" ? t : null;
    }, 20_000, "managed delivery after user answer");
    assert.equal(delivered.task.state, "delivered");

    const logRaw = await fs.readFile(logPath, "utf8");
    const log = JSON.parse(logRaw) as { prompts?: string[] };
    assert.ok(Array.isArray(log.prompts), "mock ACP should record prompts");
    assert.ok(
      log.prompts!.length >= 2,
      `expected bootstrap + User Answer prompts, got ${log.prompts!.length}`
    );
    const followUp = log.prompts!.find((p) => p.includes("## User Answer"));
    assert.ok(followUp, "follow-up prompt must contain ## User Answer");
    assert.match(followUp!, /choiceId: role/);
    assert.match(followUp!, /answer: Use role branch/);
  });
});

test("two workspaces sharing relative taskPath keep independent UserAsk pending", async () => {
  const wsA = await makeWorkspace();
  const wsB = await makeWorkspace();
  // Same relative path under both system roots — the cross-workspace collision case.
  const sharedTaskPath = "temp/executor/tasks/task-shared-cross-ws.md";

  async function plantRunningTask(
    workspaceRoot: string,
    nodeId: string
  ): Promise<void> {
    const abs = path.join(workspaceRoot, ".tent", ...sharedTaskPath.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const now = new Date().toISOString();
    const body =
      "---\n" +
      "type: task\n" +
      "id: tk-sharedpath\n" +
      "status: taken\n" +
      "state: running\n" +
      "role: executor\n" +
      "assigneeKind: role\n" +
      // Flow maps only — frontmatter parser does not read nested block maps.
      "parentActor: {kind: user, id: user}\n" +
      "reviewer: {kind: user, id: user}\n" +
      `claims: [${nodeId}]\n` +
      "manifest: temp/executor/manifest.yml\n" +
      "deliveryPolicy: review\n" +
      `createdAt: "${now}"\n` +
      `updatedAt: "${now}"\n` +
      "---\n" +
      "# Task\n\n## User Prompt\n\nPlanted for cross-workspace UserAsk isolation.\n";
    await fs.writeFile(abs, body, "utf8");
    // Minimal role lane so claim/lifecycle can resolve manifest if needed later.
    const manifestAbs = path.join(
      workspaceRoot,
      ".tent",
      "temp",
      "executor",
      "manifest.yml"
    );
    await fs.mkdir(path.dirname(manifestAbs), { recursive: true });
    await fs.writeFile(
      manifestAbs,
      `role: executor\nclaims: [${nodeId}]\nreadable: []\nwritable: []\n`,
      "utf8"
    );
  }

  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mountedA = (await client.mount(wsA)) as { workspaceId: string };
    const mountedB = (await client.mount(wsB)) as { workspaceId: string };
    const workspaceA = mountedA.workspaceId;
    const workspaceB = mountedB.workspaceId;

    const noteA = (await client.docsCreateNote(workspaceA, {
      name: "shared-path-a",
      type: "prompt",
    }));
    const noteB = (await client.docsCreateNote(workspaceB, {
      name: "shared-path-b",
      type: "prompt",
    }));

    await plantRunningTask(wsA, noteA.nodeId);
    await plantRunningTask(wsB, noteB.nodeId);

    const askedA = (await client.taskAskUser(workspaceA, sharedTaskPath, {
      question: "Alpha only?",
    })) as { ask: { id: string; workspaceId: string; taskPath: string }; state: string };
    const askedB = (await client.taskAskUser(workspaceB, sharedTaskPath, {
      question: "Beta only?",
    })) as { ask: { id: string; workspaceId: string; taskPath: string }; state: string };

    assert.equal(askedA.state, "waiting");
    assert.equal(askedB.state, "waiting");
    assert.equal(askedA.ask.taskPath, sharedTaskPath);
    assert.equal(askedB.ask.taskPath, sharedTaskPath);
    assert.notEqual(askedA.ask.id, askedB.ask.id);
    assert.equal(askedA.ask.workspaceId, workspaceA);
    assert.equal(askedB.ask.workspaceId, workspaceB);

    const pendingA = (await client.userAskListPending(workspaceA)) as {
      asks: { id: string }[];
    };
    const pendingB = (await client.userAskListPending(workspaceB)) as {
      asks: { id: string }[];
    };
    assert.equal(pendingA.asks.length, 1);
    assert.equal(pendingB.asks.length, 1);
    assert.equal(pendingA.asks[0]!.id, askedA.ask.id);
    assert.equal(pendingB.asks[0]!.id, askedB.ask.id);

    // Interrupt A must not cancel B's pending ask (same relative taskPath).
    await client.taskInterrupt(workspaceA, sharedTaskPath);
    const afterA = (await client.userAskGet(askedA.ask.id)) as {
      ask: { status: string };
    };
    const afterB = (await client.userAskGet(askedB.ask.id)) as {
      ask: { status: string };
    };
    assert.equal(afterA.ask.status, "cancelled");
    assert.equal(afterB.ask.status, "pending");

    const stillB = (await client.userAskListPending(workspaceB)) as {
      asks: { id: string }[];
    };
    assert.equal(stillB.asks.length, 1);
    assert.equal(stillB.asks[0]!.id, askedB.ask.id);
  });
});

test("task.askUser rejects non-running task", async () => {
  const ws = await makeWorkspace();
  await withService([], async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const created = (await client.docsCreateNote(workspaceId, {
      name: "queued-only",
      type: "prompt",
    }));
    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [created.nodeId],
      role: "executor",
      prompt: "not claimed",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };

    const res = await rpcCall(
      svc.url,
      "task.askUser",
      {
        workspaceId,
        taskPath: dispatched.taskPath,
        question: "too early",
      },
      { token: svc.token }
    );
    assert.ok(res.error);
    assert.equal(res.error!.code, RPC_LIFECYCLE);
  });
});
