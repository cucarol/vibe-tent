/**
 * B5: Service Task / A2A / Runtime unified wiring + loopback token.
 * End-to-end via Local Service RPC (fake adapter only — no paid networks).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { readServiceEndpoint } from "../src/service/data-dir.js";
import {
  CLIENT_METHODS,
  RPC_A2A_ASK,
  RPC_A2A_DENIED,
  RPC_LIFECYCLE,
  RPC_UNAUTHORIZED,
} from "../src/service/types.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";
import {
  invokeManagedAutoDeliverForTests,
  mapRuntimeEventToService,
  reconcileTaskSessionsOnMount,
  resetManagedAutoDeliverDedupForTests,
  SESSION_UNAVAILABLE_WAIT_SUMMARY,
} from "../src/service/handlers.js";
import { ensureRoleWorkspace } from "../src/core/workspace.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { fileURLToPath } from "node:url";

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
    promptMode?: "ok" | "empty" | "error" | "interrupt";
    stopReason?: string;
    permissionPolicy?: "deny" | "allow" | "ask";
  }
): import("../src/runtime/types.js").AgentProfileConfig {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath,
      MOCK_ACP_KEEP_ALIVE: "1",
      MOCK_ACP_PROMPT_TEXT: opts.promptText ?? "MANAGED_FINAL_REPORT",
      ...(opts.promptMode && opts.promptMode !== "ok"
        ? { MOCK_ACP_PROMPT_MODE: opts.promptMode }
        : {}),
      ...(opts.stopReason ? { MOCK_ACP_STOP_REASON: opts.stopReason } : {}),
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    grokAcp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: opts.permissionPolicy ?? "deny",
      promptTimeoutMs: 8_000,
      permissionTimeoutMs: 500,
    },
  };
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
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

async function makeWorkspace(
  name = "b5",
  rolePolicies?: Record<string, "allow" | "ask" | "deny">
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nB5 service wiring\n",
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
            ...(rolePolicies?.executor ? { a2aPolicy: rolePolicies.executor } : {}),
          },
          {
            name: "orchestrator",
            prompt: "dispatch work",
            ...(rolePolicies?.orchestrator ? { a2aPolicy: rolePolicies.orchestrator } : {}),
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
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>,
  opts?: { profiles?: import("../src/runtime/types.js").AgentProfileConfig[] }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    profiles: opts?.profiles,
  });
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

async function mountWorkItem(svc: Awaited<ReturnType<typeof startLocalTentService>>, ws: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: "work-item",
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  const boxId = (created.result as { id: string }).id;
  return { workspaceId, boxId };
}

// ---- token auth ----

test("B5: unauthenticated RPC and SSE rejected; health open; token not in workspace", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc, dataDir) => {
    // health open
    const health = await fetch(`${svc.url}/health`);
    assert.equal(health.status, 200);

    // RPC without token
    const bare = await rpcCall(svc.url, "workspace.list", {});
    assert.ok(bare.error);
    assert.equal(bare.error!.code, RPC_UNAUTHORIZED);

    // wrong token
    const wrong = await rpcCall(svc.url, "workspace.list", {}, { token: "not-the-token" });
    assert.ok(wrong.error);
    assert.equal(wrong.error!.code, RPC_UNAUTHORIZED);

    // SSE without token
    const sse = await fetch(`${svc.url}/events`);
    assert.equal(sse.status, 401);

    // endpoint carries token
    const ep = await readServiceEndpoint(dataDir);
    assert.equal(ep?.token, svc.token);

    // token must not appear under workspace files
    await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...(await walk(p)));
        else out.push(p);
      }
      return out;
    };
    for (const file of await walk(ws)) {
      if (file.includes("node_modules")) continue;
      const text = await fs.readFile(file, "utf8");
      assert.ok(!text.includes(svc.token), `token leaked into ${file}`);
    }
  });
});

// ---- full lifecycle manual review ----

test("B5: dispatch → claim → startSession → deliver → accept (manual) via ServiceClient", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const dispatched = (await client.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "Ship B5 wiring",
      deliveryPolicy: "manual",
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");
    const taskPath = dispatched.taskPath;

    await client.taskClaim(workspaceId, taskPath);
    const started = (await client.taskStartSession(workspaceId, {
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    })) as { session: { sessionId: string; state: string }; task: { sessionId?: string; state: string } };

    assert.match(started.session.sessionId, /^ss-/);
    assert.equal(started.task.sessionId, started.session.sessionId);
    assert.equal(started.task.state, "running");

    // Session projection does not require AgentRuntimePort client call
    const sessions = (await client.sessionList(workspaceId)) as {
      sessions: { sessionId: string; alive: boolean }[];
    };
    assert.ok(sessions.sessions.some((s) => s.sessionId === started.session.sessionId && s.alive));

    // Direct runtime port still forbidden
    const banned = await rpc(svc, "AgentRuntimePort.startSession", {});
    assert.ok(banned.error);
    assert.equal(banned.error!.code, -32601);

    await client.taskWait(workspaceId, taskPath, "user-input", "Need review criteria");
    let got = (await client.taskGet(workspaceId, taskPath)) as { task: { state: string } };
    assert.equal(got.task.state, "waiting");
    await client.taskResume(workspaceId, taskPath);

    // No commits: pure Tent path (Git integration covered by dedicated P0 tests).
    const delivered = (await client.taskDeliver(workspaceId, taskPath, {
      summary: "Implemented service wiring",
    })) as { state: string; autoIntegrated: boolean; delivery: { status: string } };
    assert.equal(delivered.autoIntegrated, false);
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.delivery.status, "ready");

    // Self-accept forbidden
    const selfAccept = await client.tryCall("task.accept", {
      workspaceId,
      taskPath,
      actor: "executor",
    });
    assert.equal(selfAccept.ok, false);

    const accepted = (await client.taskAccept(workspaceId, taskPath, "user")) as {
      state: string;
      delivery: { status: string; integrationMode: string };
    };
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.delivery.status, "accepted");
    assert.equal(accepted.delivery.integrationMode, "manual-accept");

    const box = (await client.docsGet(workspaceId, { id: boxId })) as {
      concept: { status?: string; assignee?: string };
    };
    assert.equal(box.concept.status, "done");
    assert.equal(box.concept.assignee, undefined);

    // stop session cleanup via interrupt would be after deliver; already terminal
    await client.call("session.get", { sessionId: started.session.sessionId });
  });
});

// ---- bypass auto-integrate ----

test("B5: deliveryPolicy=bypass auto-integrates without review", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "auto path",
      deliveryPolicy: "bypass",
    });
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    // No commits: policy auto-accept without Git. Commit integrate is covered by P0 tests.
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "auto done",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { autoIntegrated: boolean }).autoIntegrated, true);
    assert.equal((delivered.result as { state: string }).state, "accepted");
  });
});

// ---- agent-decide ----

test("B5: agent-decide integrate vs request-review", async () => {
  const ws = await makeWorkspace("b5-ad");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d1 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "agent decide",
      deliveryPolicy: "agent-decide",
    });
    const taskPath = (d1.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // missing decision
    const missing = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "no decision",
    });
    assert.ok(missing.error);

    const integrated = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "agent integrates",
      decision: "integrate",
    });
    assert.ok(!integrated.error, JSON.stringify(integrated.error));
    assert.equal((integrated.result as { autoIntegrated: boolean }).autoIntegrated, true);
  });

  // request-review path on a fresh box
  const ws2 = await makeWorkspace("b5-ad2");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws2);
    const d1 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "review me",
      deliveryPolicy: "agent-decide",
    });
    const taskPath = (d1.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const review = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "please review",
      decision: "request-review",
    });
    assert.ok(!review.error, JSON.stringify(review.error));
    assert.equal((review.result as { state: string }).state, "delivered");
    assert.equal((review.result as { autoIntegrated: boolean }).autoIntegrated, false);

    const rejected = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      note: "needs more tests",
      resume: true,
    });
    assert.ok(!rejected.error, JSON.stringify(rejected.error));
    assert.equal((rejected.result as { state: string }).state, "running");
  });
});

// ---- A2A allow / ask / deny (server loads role.a2aPolicy; no client override) ----

test("B5: missing profileId fails loud (no fake-default fallback)", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "need profile",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const missing = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
    });
    assert.ok(missing.error);
    assert.equal(missing.error!.code, -32602);
    assert.match(String(missing.error!.message), /profileId/i);

    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "dispatch-start-miss-profile",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    const startMiss = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: (note.result as { id: string }).id,
      role: "executor",
      prompt: "dispatch start needs profile",
      startSession: true,
    });
    assert.ok(startMiss.error);
    assert.equal(startMiss.error!.code, -32602);
    assert.match(String(startMiss.error!.message), /profileId/i);
  });
});

test("B5: explicit fake-default profile still works when passed", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "explicit fake",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "fake-default",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    assert.equal(
      (started.result as { session: { profileId: string } }).session.profileId,
      "fake-default"
    );
  });
});

test("B5: role a2aPolicy default deny; client a2aPolicy cannot elevate", async () => {
  // No a2aPolicy on role → deny. Client passes a2aPolicy: allow — must still deny.
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "deny path",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const denied = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      a2aPolicy: "allow",
      profileId: "fake-default",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, RPC_A2A_DENIED);

    const stillDenied = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    assert.ok(stillDenied.error);
    assert.equal(stillDenied.error!.code, RPC_A2A_DENIED);
  });
});

test("B5: role a2aPolicy=allow from registry permits role startSession", async () => {
  const ws = await makeWorkspace("b5-allow", { executor: "allow" });
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "allow path",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    assert.match(
      (started.result as { session: { sessionId: string } }).session.sessionId,
      /^ss-/
    );
  });
});

test("B5: A2A ask from role registry; resolve approve starts session", async () => {
  const ws = await makeWorkspace("b5-ask", { executor: "ask" });
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "ask path",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // Client a2aPolicy=allow must not skip ask when role says ask.
    const ask = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      a2aPolicy: "allow",
      profileId: "fake-default",
    });
    assert.ok(ask.error);
    assert.equal(ask.error!.code, RPC_A2A_ASK);
    const approvalId = (ask.error!.data as { approvalId: string }).approvalId;
    assert.match(approvalId, /^ap-/);

    const pending = await rpc(svc, "a2a.listPending", { workspaceId });
    assert.ok(!pending.error, JSON.stringify(pending.error));
    const approvals = (pending.result as { approvals: { id: string }[] }).approvals;
    assert.ok(approvals.some((a) => a.id === approvalId));

    // task should be waiting on a2a-approval
    const waiting = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((waiting.result as { task: { state: string } }).task.state, "waiting");

    const resolved = await rpc(svc, "a2a.resolve", {
      approvalId,
      decision: "approve",
      actor: "user",
    });
    assert.ok(!resolved.error, JSON.stringify(resolved.error));
    const started = resolved.result as {
      started: { session: { sessionId: string }; task: { sessionId?: string; state: string } };
    };
    assert.match(started.started.session.sessionId, /^ss-/);
    assert.equal(started.started.task.sessionId, started.started.session.sessionId);
    assert.equal(started.started.task.state, "running");
  });
});

test("B5: A2A ask deny leaves no live session", async () => {
  const ws = await makeWorkspace("b5-ask-deny", { executor: "ask" });
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "ask deny",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const ask = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    const approvalId = (ask.error!.data as { approvalId: string }).approvalId;
    const denied = await rpc(svc, "a2a.resolve", {
      approvalId,
      decision: "deny",
      actor: "user",
    });
    assert.ok(!denied.error, JSON.stringify(denied.error));
    assert.equal((denied.result as { started: null }).started, null);
    const sessions = await rpc(svc, "session.list", { workspaceId });
    const list = (sessions.result as { sessions: unknown[] }).sessions;
    assert.equal(list.length, 0);
  });
});

test("B5: trusted a2aPolicyOverride can raise policy for harness only", async () => {
  const ws = await makeWorkspace(); // role default deny
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "override allow",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
      a2aPolicyOverride: "allow",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
  });
});

test("B5: user callerKind always allows startSession even if role a2aPolicy=deny", async () => {
  const ws = await makeWorkspace("b5-user", { executor: "deny" });
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "user root",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "fake-default",
      a2aPolicy: "deny",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    assert.match(
      (started.result as { session: { sessionId: string } }).session.sessionId,
      /^ss-/
    );
  });
});

test("B5: dispatch relayPrompt uses task claim/deliver (not task-ack)", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "relay text",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const relay = (d.result as { relayPrompt: string; taskPath: string }).relayPrompt;
    const taskPath = (d.result as { taskPath: string }).taskPath;
    assert.match(relay, new RegExp(`tent task claim ${taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(relay, new RegExp(`tent task deliver ${taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --summary`));
    assert.doesNotMatch(relay, /task-ack|tent report\b/);
  });
});

test("B5: startSession bootstrap is managed (Context Card + user prompt); relay still has claim", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "bootstrap path semantics",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const relay = (d.result as { relayPrompt: string }).relayPrompt;

    // External manual wake: still claim + deliver via CLI.
    assert.match(relay, new RegExp(`tent task claim ${escapeRegExp(taskPath)}`));
    assert.match(relay, new RegExp(`tent task deliver ${escapeRegExp(taskPath)}`));
    assert.match(relay, /workspaceRoot:|systemRoot:/);
    assert.match(relay, /\.tent\/temp\//);
    assert.doesNotMatch(relay, /task-ack|tent report\b/);

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "fake-default",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

    // Capture managed bootstrap from fake adapter temp file.
    const bootstrap = await findFakeBootstrapPrompt(sessionId);
    assert.ok(bootstrap, "fake adapter should write bootstrap file for session");
    const normalized = bootstrap!.replace(/\\/g, "/");
    const wsNorm = ws.replace(/\\/g, "/");
    assert.match(bootstrap!, /workspaceRoot:/);
    assert.match(bootstrap!, /systemRoot:/);
    assert.ok(normalized.includes(wsNorm), `bootstrap should include workspaceRoot ${wsNorm}`);
    assert.ok(
      normalized.includes(`${wsNorm}/.tent`),
      `bootstrap should include systemRoot ${wsNorm}/.tent`
    );
    assert.match(bootstrap!, /\.tent\/temp\//);
    assert.match(bootstrap!, /contextCard|Tent contextCard/i);
    assert.match(bootstrap!, /already claimed/i);
    assert.match(bootstrap!, /managed ACP session|managed session bootstrap/i);
    assert.match(bootstrap!, /## User Prompt/);
    assert.match(bootstrap!, /bootstrap path semantics/);
    assert.match(bootstrap!, /submit delivery automatically|auto/i);
    assert.match(bootstrap!, /skip Local Service claim\/get\/deliver CLI/i);
    // Must not instruct claim/get/deliver CLI commands (managed path auto-delivers final reply).
    assert.doesNotMatch(bootstrap!, /tent task claim|task-ack|tent report\b/);
    assert.doesNotMatch(bootstrap!, /tent task get |tent task deliver /);
    assert.doesNotMatch(bootstrap!, /Run `tent task claim/);
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- managed ACP auto-delivery (mock ACP only; never real CPA) ----

test("B5 managed ACP: user prompt enters ACP; final response → one manual delivery", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-macp-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const reportText = "MANAGED_FINAL_REPORT_OK";

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const userPrompt = "near-field: summarize the box intent without tools";
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: userPrompt,
        deliveryPolicy: "manual",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-managed",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      // Wait for managed auto-deliver → delivered + one ready delivery.
      const delivered = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string } }).task;
        return task.state === "delivered" ? task : null;
      }, 12_000, "task delivered via managed auto-deliver");

      assert.equal(delivered.state, "delivered");

      const list = await rpc(svc, "delivery.list", { workspaceId });
      assert.ok(!list.error, JSON.stringify(list.error));
      const deliveries = (list.result as { deliveries: Array<{ summary: string; status: string }> })
        .deliveries;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].summary, reportText);
      assert.equal(deliveries[0].status, "ready");

      // User prompt must have entered ACP session/prompt text.
      const logRaw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(logRaw) as { prompts: string[] };
      assert.ok(log.prompts.some((p) => p.includes(userPrompt)));
      assert.ok(log.prompts.some((p) => /contextCard|Tent contextCard/i.test(p)));
      assert.ok(log.prompts.some((p) => /skip Local Service claim\/get\/deliver CLI/i.test(p)));
      assert.ok(
        log.prompts.every((p) => !/tent task deliver /.test(p)),
        "managed bootstrap must not instruct tent task deliver"
      );

      // Duplicate completion must not create a second delivery.
      mapRuntimeEventToService(svc.ctx, {
        type: "session.prompt_complete",
        sessionId,
        assistantText: "SECOND_SHOULD_BE_IGNORED",
        stopReason: "end_turn",
      });
      await new Promise((r) => setTimeout(r, 200));
      const list2 = await rpc(svc, "delivery.list", { workspaceId });
      const deliveries2 = (
        list2.result as { deliveries: Array<{ summary: string }> }
      ).deliveries;
      assert.equal(deliveries2.length, 1);
      assert.equal(deliveries2[0].summary, reportText);

      // Still pending user review — not auto-accepted.
      const g2 = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal((g2.result as { task: { state: string } }).task.state, "delivered");
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-managed", {
          logPath,
          promptText: reportText,
        }),
      ],
    }
  );
});

test("B5 managed ACP: empty / error / non-end_turn do not deliver", async () => {
  resetManagedAutoDeliverDedupForTests();
  for (const mode of ["empty", "error"] as const) {
    const ws = await makeWorkspace();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `tent-b5-${mode}-`));
    const logPath = path.join(dataDir, "mock-acp-log.json");
    await withService(
      async (svc) => {
        const { workspaceId, boxId } = await mountWorkItem(svc, ws);
        const d = await rpc(svc, "task.dispatch", {
          workspaceId,
          boxId,
          role: "executor",
          prompt: `mode ${mode}`,
        });
        const taskPath = (d.result as { taskPath: string }).taskPath;
        await rpc(svc, "task.claim", { workspaceId, taskPath });
        const started = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath,
          callerKind: "user",
          profileId: `mock-acp-${mode}`,
        });
        assert.ok(!started.error, JSON.stringify(started.error));

        const failed = await pollUntil(async () => {
          const g = await rpc(svc, "task.get", { workspaceId, taskPath });
          const task = (g.result as { task: { state: string } }).task;
          return task.state === "failed" ? task : null;
        }, 12_000, `task failed for mode=${mode}`);
        assert.equal(failed.state, "failed");

        const list = await rpc(svc, "delivery.list", { workspaceId });
        const deliveries = (list.result as { deliveries: unknown[] }).deliveries;
        assert.equal(deliveries.length, 0, `mode=${mode} must not create delivery`);
      },
      {
        profiles: [
          mockAcpProfile(`mock-acp-${mode}`, {
            logPath,
            promptMode: mode,
          }),
        ],
      }
    );
  }
});

test("B5 managed ACP: interrupt / stop does not deliver", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-int-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "will interrupt",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-interrupt",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      // Hang mode: wait until session is live, then interrupt task.
      await pollUntil(async () => {
        const probe = await svc.runtime.probe(sessionId);
        return probe.alive ? true : null;
      }, 8_000, "session alive");

      const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
      assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
      assert.equal((interrupted.result as { state: string }).state, "interrupted");

      await new Promise((r) => setTimeout(r, 300));
      const list = await rpc(svc, "delivery.list", { workspaceId });
      const deliveries = (list.result as { deliveries: unknown[] }).deliveries;
      assert.equal(deliveries.length, 0);
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-interrupt", {
          logPath,
          promptMode: "interrupt",
        }),
      ],
    }
  );
});

test("B5 managed ACP: bypass auto-integrates; agent-decide stays pending review (no auto-accept forge)", async () => {
  resetManagedAutoDeliverDedupForTests();

  // bypass → accepted without review.by
  {
    const ws = await makeWorkspace();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-bypass-"));
    const logPath = path.join(dataDir, "mock-acp-log.json");
    await withService(
      async (svc) => {
        const { workspaceId, boxId } = await mountWorkItem(svc, ws);
        const d = await rpc(svc, "task.dispatch", {
          workspaceId,
          boxId,
          role: "executor",
          prompt: "bypass policy path",
          deliveryPolicy: "bypass",
        });
        const taskPath = (d.result as { taskPath: string }).taskPath;
        await rpc(svc, "task.claim", { workspaceId, taskPath });
        await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath,
          callerKind: "user",
          profileId: "mock-acp-bypass",
        });
        const accepted = await pollUntil(async () => {
          const g = await rpc(svc, "task.get", { workspaceId, taskPath });
          const task = (g.result as { task: { state: string } }).task;
          return task.state === "accepted" ? task : null;
        }, 12_000, "bypass accepted");
        assert.equal(accepted.state, "accepted");
        const list = await rpc(svc, "delivery.list", { workspaceId });
        const deliveries = (
          list.result as { deliveries: Array<{ status: string; review?: unknown }> }
        ).deliveries;
        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0].status, "accepted");
        assert.equal(deliveries[0].review, undefined);
      },
      {
        profiles: [mockAcpProfile("mock-acp-bypass", { logPath, promptText: "BYPASS_OK" })],
      }
    );
  }

  // agent-decide without integrate decision → request-review → delivered (not accepted)
  {
    resetManagedAutoDeliverDedupForTests();
    const ws = await makeWorkspace();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-ad-"));
    const logPath = path.join(dataDir, "mock-acp-log.json");
    await withService(
      async (svc) => {
        const { workspaceId, boxId } = await mountWorkItem(svc, ws);
        const d = await rpc(svc, "task.dispatch", {
          workspaceId,
          boxId,
          role: "executor",
          prompt: "agent-decide path",
          deliveryPolicy: "agent-decide",
        });
        const taskPath = (d.result as { taskPath: string }).taskPath;
        await rpc(svc, "task.claim", { workspaceId, taskPath });
        await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath,
          callerKind: "user",
          profileId: "mock-acp-ad",
        });
        const delivered = await pollUntil(async () => {
          const g = await rpc(svc, "task.get", { workspaceId, taskPath });
          const task = (g.result as { task: { state: string } }).task;
          return task.state === "delivered" ? task : null;
        }, 12_000, "agent-decide delivered for review");
        assert.equal(delivered.state, "delivered");
        const list = await rpc(svc, "delivery.list", { workspaceId });
        const deliveries = (
          list.result as { deliveries: Array<{ status: string }> }
        ).deliveries;
        assert.equal(deliveries.length, 1);
        assert.equal(deliveries[0].status, "ready");
      },
      {
        profiles: [mockAcpProfile("mock-acp-ad", { logPath, promptText: "AD_OK" })],
      }
    );
  }
});

async function findFakeBootstrapPrompt(sessionId: string): Promise<string | null> {
  const tmp = os.tmpdir();
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  const candidates = [
    path.join(tmp, `tent-bootstrap-${safe}.txt`),
    path.join(tmp, `tent-bootstrap-${sessionId}.txt`),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  // Scan tmp for matching prefix (Windows may vary)
  try {
    for (const name of await fs.readdir(tmp)) {
      if (name.startsWith("tent-bootstrap-") && name.includes(safe) && name.endsWith(".txt")) {
        return await fs.readFile(path.join(tmp, name), "utf8");
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---- interrupt stops runtime ----

test("B5: task.interrupt stops bound session", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "interrupt me",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "fake-default",
    });
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
    assert.equal((await svc.runtime.probe(sessionId)).alive, true);

    const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
    assert.equal((interrupted.result as { state: string }).state, "interrupted");

    // process should stop shortly
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await svc.runtime.probe(sessionId)).alive) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await svc.runtime.probe(sessionId)).alive, false);
  });
});

// ---- cancel queued ----

test("B5: task.cancel removes queued envelope", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "cancel me",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const cancelled = await rpc(svc, "task.cancel", { workspaceId, taskPath });
    assert.ok(!cancelled.error, JSON.stringify(cancelled.error));
    const listed = await rpc(svc, "task.list", { workspaceId });
    const tasks = (listed.result as { tasks: { path: string }[] }).tasks;
    assert.ok(!tasks.some((t) => t.path === taskPath));
  });
});

// ---- client method surface ----

test("B5: client method table covers task lifecycle and excludes runtime port", () => {
  for (const m of [
    "task.wait",
    "task.resume",
    "task.deliver",
    "task.accept",
    "task.reject",
    "task.interrupt",
    "task.cancel",
    "task.startSession",
    "session.list",
    "a2a.listPending",
    "a2a.resolve",
  ]) {
    assert.ok((CLIENT_METHODS as readonly string[]).includes(m), m);
  }
  assert.ok(!(CLIENT_METHODS as readonly string[]).includes("AgentRuntimePort.startSession"));
  assert.equal(FAKE_ADAPTER_ID, "fake-cli");
});

// ---- session reconcile on boot ----

test("B5: service restart reconciles dead sessions without workspace PID data", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-recon-"));
  const ws = await makeWorkspace("recon");
  let sessionId = "";
  {
    const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
    try {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "reconcile",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "fake-default",
      });
      sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
      // Force-kill child without clean stop to leave a stale registry row after process death
      await svc.runtime.supervisor.stop(sessionId, { signal: "SIGKILL" });
    } finally {
      // Stop service without full runtime.shutdown path on this session — call stop which does shutdown
      await svc.stop();
    }
  }

  // New service instance same dataDir — reconcileOnBoot runs
  const svc2 = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const probe = await svc2.runtime.probe(sessionId);
    assert.equal(probe.alive, false);
    assert.ok(probe.state === "stopped" || probe.state === "failed");
  } finally {
    await svc2.stop();
  }
});

// ---- P0-1 / P0-2: WorkspaceLane + real Git integrate ----

async function initGitOnWorkspace(workspace: string): Promise<void> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  // Keep .tent out of Git (product: Git ops only on real workspace content).
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
}

async function roleCommit(
  workspace: string,
  role: string,
  filename: string,
  contents: string,
  message: string
): Promise<string> {
  const contract = await ensureRoleWorkspace(workspace, role);
  await fs.writeFile(path.join(contract.worktree, filename), contents);
  await git(contract.worktree, "add", filename);
  await git(contract.worktree, "commit", "-q", "-m", message);
  return (await git(contract.worktree, "rev-parse", "HEAD")).trim();
}

test("P0-1: task.dispatch ensures role WorkspaceLane; startSession cwd is role worktree", async () => {
  const ws = await makeWorkspace("p0-lane");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "work in role lane",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    const lane = (dispatched.result as {
      workspaceLane?: { workspace?: string; worktree?: string; branch?: string; targetBranch?: string };
    }).workspaceLane;
    assert.ok(lane, "dispatch must attach WorkspaceLane on Git workspace");
    assert.equal(path.resolve(lane!.workspace!), path.resolve(ws));
    assert.equal(lane!.branch, "tent-role/executor");
    assert.equal(lane!.targetBranch, "main");
    assert.ok(lane!.worktree, "role worktree path required");
    assert.equal(path.basename(lane!.worktree!), "executor");
    assert.ok(
      !(lane!.worktree || "").includes(`${path.sep}.tent${path.sep}`) &&
        !(lane!.worktree || "").includes("/.tent/"),
      "Git worktree must not live under .tent"
    );

    // Same role reuses the same long-lived worktree/branch across boxes.
    const box2 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work-item-2",
      type: "prompt",
    });
    const boxId2 = (box2.result as { id: string }).id;
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId2,
      role: "executor",
      prompt: "second box same role",
    });
    assert.ok(!d2.error, JSON.stringify(d2.error));
    const lane2 = (d2.result as { workspaceLane?: { worktree?: string; branch?: string } }).workspaceLane;
    assert.equal(path.resolve(lane2!.worktree!), path.resolve(lane!.worktree!));
    assert.equal(lane2!.branch, lane!.branch);

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const session = (started.result as { session: { cwd?: string } }).session;
    assert.equal(path.resolve(session.cwd!), path.resolve(lane!.worktree!));
    const task = (started.result as { task: { workspaceLane?: { worktree?: string } } }).task;
    assert.equal(path.resolve(task.workspaceLane!.worktree!), path.resolve(lane!.worktree!));
  });
});

test("P0-1: non-Git workspace dispatch has no lane; startSession cwd falls back to workspace root", async () => {
  const ws = await makeWorkspace("p0-nongit");
  // intentionally no git init
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "docs only",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    assert.equal(
      (dispatched.result as { workspaceLane?: unknown }).workspaceLane,
      undefined,
      "pure docs / non-Git must not invent a WorkspaceLane"
    );

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const session = (started.result as { session: { cwd?: string } }).session;
    assert.equal(path.resolve(session.cwd!), path.resolve(ws));
  });
});

test("P0-2: manual accept integrates real commits into main; already-integrated is idempotent", async () => {
  const ws = await makeWorkspace("p0-accept");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "feature.txt", "ship\n", "feature work");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "integrate me",
      deliveryPolicy: "manual",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready for review",
      commits: [sourceRef],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { state: string }).state, "delivered");

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.equal(
      normalizeLf(await fs.readFile(path.join(ws, "feature.txt"), "utf8")),
      "ship\n"
    );

    // Idempotent re-integrate of the same ref via a second box/task.
    const box2 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "idempotent-item",
      type: "prompt",
    });
    const boxId2 = (box2.result as { id: string }).id;
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId2,
      role: "executor",
      prompt: "already on main",
    });
    const taskPath2 = (d2.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: taskPath2 });
    await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath: taskPath2,
      summary: "same commit again",
      commits: [sourceRef],
    });
    const again = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath: taskPath2,
      actor: "user",
    });
    assert.ok(!again.error, JSON.stringify(again.error));
    assert.equal((again.result as { state: string }).state, "accepted");
  });
});

test("P0-2: bypass with commits integrates into main and accepts", async () => {
  const ws = await makeWorkspace("p0-bypass");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "auto.txt", "auto\n", "auto delivery");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "bypass with git",
      deliveryPolicy: "bypass",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "auto integrate",
      commits: [sourceRef],
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { autoIntegrated: boolean }).autoIntegrated, true);
    assert.equal((delivered.result as { state: string }).state, "accepted");
    assert.equal(normalizeLf(await fs.readFile(path.join(ws, "auto.txt"), "utf8")), "auto\n");

    const box = await rpc(svc, "docs.get", { workspaceId, id: boxId });
    const concept = (box.result as { concept: { status?: string; assignee?: string } }).concept;
    assert.equal(concept.status, "done");
    assert.equal(concept.assignee, undefined);
  });
});

test("P0-2: agent-decide integrate with commits merges into main", async () => {
  const ws = await makeWorkspace("p0-agent-decide");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "agent.txt", "agent\n", "agent integrate");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "agent decide integrate",
      deliveryPolicy: "agent-decide",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "integrate now",
      commits: [sourceRef],
      decision: "integrate",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { state: string }).state, "accepted");
    assert.equal(normalizeLf(await fs.readFile(path.join(ws, "agent.txt"), "utf8")), "agent\n");
  });
});

test("P0-2: accept integration conflict keeps delivered + occupation; no done", async () => {
  const ws = await makeWorkspace("p0-conflict-accept");
  await initGitOnWorkspace(ws);

  // Role lane edit
  const contract = await ensureRoleWorkspace(ws, "executor");
  await fs.writeFile(path.join(contract.worktree, "conflict.txt"), "role\n");
  await git(contract.worktree, "add", "conflict.txt");
  await git(contract.worktree, "commit", "-q", "-m", "role conflict");
  const sourceRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

  // Divergent main edit → cherry-pick will conflict
  await fs.writeFile(path.join(ws, "conflict.txt"), "main\n");
  await git(ws, "add", "conflict.txt");
  await git(ws, "commit", "-q", "-m", "main conflict");
  const beforeHead = (await git(ws, "rev-parse", "HEAD")).trim();

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "will conflict",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "conflict delivery",
      commits: [sourceRef],
    });

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(accepted.error, "accept must fail on integrate conflict");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");

    const box = await rpc(svc, "docs.get", { workspaceId, id: boxId });
    const concept = (box.result as { concept: { status?: string; assignee?: string } }).concept;
    assert.equal(concept.status, "doing");
    assert.equal(concept.assignee, "executor");

    assert.equal((await git(ws, "rev-parse", "HEAD")).trim(), beforeHead);
    assert.equal((await git(ws, "status", "--porcelain")).trim(), "");
  });
});

test("P0-2: bypass integrate failure keeps running + occupation; no accepted/done", async () => {
  const ws = await makeWorkspace("p0-conflict-bypass");
  await initGitOnWorkspace(ws);

  const contract = await ensureRoleWorkspace(ws, "executor");
  await fs.writeFile(path.join(contract.worktree, "conflict.txt"), "role\n");
  await git(contract.worktree, "add", "conflict.txt");
  await git(contract.worktree, "commit", "-q", "-m", "role conflict");
  const sourceRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();

  await fs.writeFile(path.join(ws, "conflict.txt"), "main\n");
  await git(ws, "add", "conflict.txt");
  await git(ws, "commit", "-q", "-m", "main conflict");
  const beforeHead = (await git(ws, "rev-parse", "HEAD")).trim();

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "bypass conflict",
      deliveryPolicy: "bypass",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "auto will fail",
      commits: [sourceRef],
    });
    assert.ok(delivered.error, "bypass deliver must fail when integrate conflicts");

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");

    const box = await rpc(svc, "docs.get", { workspaceId, id: boxId });
    const concept = (box.result as { concept: { status?: string; assignee?: string } }).concept;
    assert.equal(concept.status, "doing");
    assert.equal(concept.assignee, "executor");

    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (list.result as { deliveries: unknown[] }).deliveries;
    assert.equal(deliveries.length, 0, "failed auto-integrate must not leave a delivery");

    assert.equal((await git(ws, "rev-parse", "HEAD")).trim(), beforeHead);
  });
});

test("P0 fix: managed auto-deliver integrate failure keeps running; session diagnostics only", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-integrate-fail");
  await initGitOnWorkspace(ws);

  // Divergent role/main so cherry-pick conflicts.
  const contract = await ensureRoleWorkspace(ws, "executor");
  await fs.writeFile(path.join(contract.worktree, "macp-conflict.txt"), "role\n");
  await git(contract.worktree, "add", "macp-conflict.txt");
  await git(contract.worktree, "commit", "-q", "-m", "role macp conflict");
  const sourceRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();
  await fs.writeFile(path.join(ws, "macp-conflict.txt"), "main\n");
  await git(ws, "add", "macp-conflict.txt");
  await git(ws, "commit", "-q", "-m", "main macp conflict");
  const beforeHead = (await git(ws, "rev-parse", "HEAD")).trim();

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "managed integrate will fail",
      deliveryPolicy: "bypass",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

    const diag: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "session.state") diag.push(ev.payload as Record<string, unknown>);
    });

    // Explicit commits only (production never auto-collects worktree commits).
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "MANAGED_INTEGRATE_FAIL_REPORT",
      commits: [sourceRef],
    });

    unsub();

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "integrate failure must not terminal-fail the task"
    );

    const box = await rpc(svc, "docs.get", { workspaceId, id: boxId });
    const concept = (box.result as { concept: { status?: string; assignee?: string } }).concept;
    assert.equal(concept.status, "doing");
    assert.equal(concept.assignee, "executor");

    const list = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (list.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "failed auto-integrate must not leave a delivery"
    );

    const failEv = diag.find((p) => p.runtimeEvent === "session.prompt_complete.failed");
    assert.ok(failEv, "must emit session diagnostics for integrate failure");
    assert.equal(failEv!.taskFailed, false);
    assert.match(String(failEv!.error ?? ""), /conflict|integrat|roll/i);

    const rec = await svc.runtime.registry.read(sessionId);
    assert.ok(rec?.lastError, "session registry lastError surfaces the failure");
    assert.match(rec!.lastError!, /managed auto-deliver failed/);

    assert.equal((await git(ws, "rev-parse", "HEAD")).trim(), beforeHead);
  });
});

test("P0 fix: same role only one active managed session; same-task start is idempotent", async () => {
  const ws = await makeWorkspace("p0-one-session");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);

    // External registry row with same role must NOT block managed start.
    const now = new Date().toISOString();
    await svc.runtime.registry.write({
      id: "ss-external01",
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "executor",
      state: "external",
      createdAt: now,
      updatedAt: now,
    });

    const d1 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "first task",
    });
    const taskPath1 = (d1.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: taskPath1 });
    const s1 = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: taskPath1,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!s1.error, JSON.stringify(s1.error));
    const sessionId1 = (s1.result as { session: { sessionId: string } }).session.sessionId;

    // Idempotent re-start on the same task returns the bound session.
    const again = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: taskPath1,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!again.error, JSON.stringify(again.error));
    assert.equal(
      (again.result as { session: { sessionId: string } }).session.sessionId,
      sessionId1
    );

    // Second task same role must fail-loud with existing session id.
    const box2 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work-item-2",
      type: "prompt",
    });
    const boxId2 = (box2.result as { id: string }).id;
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId2,
      role: "executor",
      prompt: "second task same role",
    });
    const taskPath2 = (d2.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: taskPath2 });
    const s2 = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: taskPath2,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(s2.error, "second managed session for same role must fail");
    assert.equal(s2.error!.code, RPC_LIFECYCLE);
    assert.match(s2.error!.message, /already has an active managed session/);
    const data = s2.error!.data as { existingSessionId?: string } | undefined;
    assert.equal(data?.existingSessionId, sessionId1);

    // Different role is still allowed.
    const box3 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work-item-3",
      type: "prompt",
    });
    const boxId3 = (box3.result as { id: string }).id;
    const d3 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId3,
      role: "orchestrator",
      prompt: "other role ok",
    });
    const taskPath3 = (d3.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: taskPath3 });
    const s3 = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: taskPath3,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!s3.error, JSON.stringify(s3.error));
    assert.notEqual(
      (s3.result as { session: { sessionId: string } }).session.sessionId,
      sessionId1
    );

    // Role identity is workspace-local: the same name in another workspace has its own slot.
    const ws2 = await makeWorkspace("p0-one-session-other-workspace");
    const other = await mountWorkItem(svc, ws2);
    const d4 = await rpc(svc, "task.dispatch", {
      workspaceId: other.workspaceId,
      boxId: other.boxId,
      role: "executor",
      prompt: "same role name, different workspace",
    });
    const taskPath4 = (d4.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId: other.workspaceId, taskPath: taskPath4 });
    const s4 = await rpc(svc, "task.startSession", {
      workspaceId: other.workspaceId,
      taskPath: taskPath4,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!s4.error, JSON.stringify(s4.error));
    assert.notEqual(
      (s4.result as { session: { sessionId: string } }).session.sessionId,
      sessionId1
    );
  });
});

test("mount reconcile: dead/missing session → waiting(external); live/no-sessionId/terminal untouched; multi-ws; idempotent", async () => {
  const wsA = await makeWorkspace("reconcile-a");
  const wsB = await makeWorkspace("reconcile-b");
  await withService(async (svc) => {
    const events: { type: string; workspaceId: string; payload: Record<string, unknown> }[] = [];
    const unsub = svc.events.subscribe((env) => {
      events.push({
        type: env.type,
        workspaceId: env.workspaceId,
        payload: env.payload as Record<string, unknown>,
      });
    });

    const mA = await rpc(svc, "workspace.mount", { workspaceRoot: wsA });
    const mB = await rpc(svc, "workspace.mount", { workspaceRoot: wsB });
    const idA = (mA.result as { workspaceId: string }).workspaceId;
    const idB = (mB.result as { workspaceId: string }).workspaceId;

    async function seedTask(
      workspaceId: string,
      name: string,
      role: string,
      opts: {
        bindSession?: { id: string; state: "stopped" | "failed" | "live" | "starting" | "waiting-user" | "missing" };
        noSession?: boolean;
        terminal?: boolean;
        waitingReason?: "user-input" | "a2a-approval";
      } = {}
    ) {
      const created = await rpc(svc, "docs.createNote", { workspaceId, name, type: "prompt" });
      const boxId = (created.result as { id: string }).id;
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role,
        prompt: `seed ${name}`,
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });

      if (opts.terminal) {
        await rpc(svc, "task.interrupt", { workspaceId, taskPath });
        return { taskPath, boxId };
      }

      if (opts.noSession) {
        return { taskPath, boxId };
      }

      if (opts.bindSession) {
        const sid = opts.bindSession.id;
        if (opts.bindSession.state !== "missing") {
          const now = new Date().toISOString();
          await svc.runtime.registry.write({
            id: sid,
            profileId: "fake-default",
            adapterId: FAKE_ADAPTER_ID,
            roleName: role,
            state: opts.bindSession.state,
            workspace: workspaceId,
            lastTaskId: taskPath,
            createdAt: now,
            updatedAt: now,
          });
        }
        const mount = svc.hostApi.require(workspaceId);
        await patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: sid,
          updatedAt: mount.env.clock.now(),
        });
      }

      if (opts.waitingReason) {
        await rpc(svc, "task.wait", {
          workspaceId,
          taskPath,
          reason: opts.waitingReason,
          summary: `parked for ${opts.waitingReason}`,
        });
      }

      return { taskPath, boxId };
    }

    // A: running + stopped session → must park
    const dead = await seedTask(idA, "dead-session", "executor", {
      bindSession: { id: "ss-dead0001", state: "stopped" },
    });
    // A: running + missing session record → park
    const missing = await seedTask(idA, "missing-session", "orchestrator", {
      bindSession: { id: "ss-miss0001", state: "missing" },
    });
    // A: running + live session → leave
    const live = await seedTask(idA, "live-session", "executor", {
      bindSession: { id: "ss-live0001", state: "live" },
    });
    // A: running without sessionId (manual/external) → leave
    const manual = await seedTask(idA, "manual-run", "orchestrator", { noSession: true });
    // A: waiting(user-input) + failed session → rewrite to external
    const waitUser = await seedTask(idA, "wait-user", "executor", {
      bindSession: { id: "ss-fail0001", state: "failed" },
      waitingReason: "user-input",
    });
    // A: terminal interrupted → leave
    const terminal = await seedTask(idA, "terminal-task", "orchestrator", { terminal: true });

    // B: independent workspace also parks its own dead session
    const deadB = await seedTask(idB, "dead-b", "executor", {
      bindSession: { id: "ss-dead000b", state: "stopped" },
    });

    // Simulate remount: unmount + mount triggers reconcile again
    await rpc(svc, "workspace.unmount", { workspaceId: idA });
    await rpc(svc, "workspace.unmount", { workspaceId: idB });
    events.length = 0;
    const remA = await rpc(svc, "workspace.mount", { workspaceRoot: wsA });
    const remB = await rpc(svc, "workspace.mount", { workspaceRoot: wsB });
    const idA2 = (remA.result as { workspaceId: string }).workspaceId;
    const idB2 = (remB.result as { workspaceId: string }).workspaceId;

    const get = async (workspaceId: string, taskPath: string) => {
      const r = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.ok(!r.error, JSON.stringify(r.error));
      return (r.result as { task: {
        state: string;
        wait?: { reason: string; summary: string } | null;
        sessionId?: string;
      } }).task;
    };

    const deadTask = await get(idA2, dead.taskPath);
    assert.equal(deadTask.state, "waiting");
    assert.equal(deadTask.wait?.reason, "external");
    assert.equal(deadTask.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.equal(deadTask.sessionId, "ss-dead0001");

    const missingTask = await get(idA2, missing.taskPath);
    assert.equal(missingTask.state, "waiting");
    assert.equal(missingTask.wait?.reason, "external");

    const liveTask = await get(idA2, live.taskPath);
    assert.equal(liveTask.state, "running");
    assert.equal(liveTask.wait ?? null, null);

    const manualTask = await get(idA2, manual.taskPath);
    assert.equal(manualTask.state, "running");
    assert.equal(manualTask.sessionId ?? undefined, undefined);

    const waitUserTask = await get(idA2, waitUser.taskPath);
    assert.equal(waitUserTask.state, "waiting");
    assert.equal(waitUserTask.wait?.reason, "external");
    assert.equal(waitUserTask.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);

    const terminalTask = await get(idA2, terminal.taskPath);
    assert.equal(terminalTask.state, "interrupted");

    const deadBTask = await get(idB2, deadB.taskPath);
    assert.equal(deadBTask.state, "waiting");
    assert.equal(deadBTask.wait?.reason, "external");

    // Occupation kept: box still doing / assignee present
    const box = await rpc(svc, "docs.get", { workspaceId: idA2, id: dead.boxId });
    assert.ok(!box.error, JSON.stringify(box.error));
    const concept = (box.result as { concept: { status?: string; assignee?: string; owner?: string } }).concept;
    assert.equal(concept.status, "doing");
    assert.ok(concept.assignee || concept.owner, "occupation must remain after reconcile");

    // Events fired with session.reconcile reason
    const reconcileEvents = events.filter(
      (e) => e.type === "task.state" && e.payload.reason === "session.reconcile"
    );
    assert.ok(reconcileEvents.length >= 3, `expected reconcile events, got ${reconcileEvents.length}`);

    // Idempotent: second reconcile does not re-emit / re-mutate
    events.length = 0;
    const again = await reconcileTaskSessionsOnMount(svc.ctx, idA2);
    assert.deepEqual(again.reconciled, []);
    const after = await get(idA2, dead.taskPath);
    assert.equal(after.state, "waiting");
    assert.equal(after.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.equal(
      events.filter((e) => e.payload.reason === "session.reconcile").length,
      0
    );

    unsub();
  });
});

test("task.startSession resumes any waiting (external/a2a) before launch", async () => {
  const ws = await makeWorkspace("start-from-wait");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "resume external wait",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // Simulate post-restart parked task
    await rpc(svc, "task.wait", {
      workspaceId,
      taskPath,
      reason: "external",
      summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
    });
    let parked = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((parked.result as { task: { state: string } }).task.state, "waiting");

    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const result = started.result as {
      task: { state: string; wait?: unknown; sessionId?: string };
      session: { sessionId: string };
    };
    assert.equal(result.task.state, "running");
    assert.equal(result.task.wait ?? null, null);
    assert.match(result.session.sessionId, /^ss-/);
    assert.equal(result.task.sessionId, result.session.sessionId);
  });
});

test("P0 fix: concurrent dispatch same role serializes worktree ensure (no race)", async () => {
  const ws = await makeWorkspace("p0-concurrent-lane");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const boxes = await Promise.all(
      [1, 2, 3].map(async (i) => {
        const created = await rpc(svc, "docs.createNote", {
          workspaceId,
          name: `concurrent-item-${i}`,
          type: "prompt",
        });
        return (created.result as { id: string }).id;
      })
    );

    const results = await Promise.all(
      boxes.map((boxId, i) =>
        rpc(svc, "task.dispatch", {
          workspaceId,
          boxId,
          role: "executor",
          prompt: `concurrent ${i}`,
        })
      )
    );
    for (const r of results) {
      assert.ok(!r.error, JSON.stringify(r.error));
    }
    const lanes = results.map(
      (r) =>
        (r.result as { workspaceLane: { worktree: string; branch: string } }).workspaceLane
    );
    assert.ok(lanes.every((l) => l && l.worktree));
    const wt = path.resolve(lanes[0].worktree);
    for (const l of lanes) {
      assert.equal(path.resolve(l.worktree), wt);
      assert.equal(l.branch, "tent-role/executor");
    }
  });
});

async function tentFsFor(ws: string): Promise<NodeFs> {
  return new NodeFs(path.join(ws, ".tent"));
}

async function corruptTaskLane(
  ws: string,
  taskPath: string,
  patch: { workspace?: string | null; targetBranch?: string | null; branch?: string | null }
): Promise<void> {
  const tentFs = await tentFsFor(ws);
  const rel = taskPath.replace(/^\.tent[\\/]/, "");
  const task = await loadTaskEnvelope(tentFs, rel);
  await patchTaskEnvelope(tentFs, task.path, {
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

test("P0 fix: resolveIntegrationContract re-validates envelope workspace/targetBranch", async () => {
  const ws = await makeWorkspace("p0-contract-reval");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "reval.txt", "ok\n", "reval commit");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "stale envelope",
      deliveryPolicy: "manual",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // Corrupt envelope targetBranch after dispatch — must not be trusted blindly.
    await corruptTaskLane(ws, taskPath, { targetBranch: "not-the-real-main" });

    await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready",
      commits: [sourceRef],
    });
    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(accepted.error, "stale targetBranch must fail re-validation");
    assert.match(String(accepted.error!.message), /targetBranch mismatch/);

    // Task stays delivered + occupation held (integrate never succeeded).
    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");
  });

  // Wrong workspace root on envelope.
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "wrong workspace",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    await corruptTaskLane(ws, taskPath, {
      workspace: path.join(os.tmpdir(), "other-workspace-not-mounted"),
    });

    await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready",
      commits: [sourceRef],
    });
    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(accepted.error, "workspace mismatch must fail re-validation");
    assert.match(String(accepted.error!.message), /workspace mismatch/);
  });
});

test("P0 fix: bypass with zero commits is legal (pure docs / no auto-collect)", async () => {
  const ws = await makeWorkspace("p0-bypass-zero");
  await initGitOnWorkspace(ws);
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "docs only delivery",
      deliveryPolicy: "bypass",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "no commits needed",
      // intentionally no commits
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { state: string }).state, "accepted");
    assert.equal((delivered.result as { autoIntegrated: boolean }).autoIntegrated, true);
  });
});

function normalizeLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
