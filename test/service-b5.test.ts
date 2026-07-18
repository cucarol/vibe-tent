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
  migrateSessionWorkspaceIdsOnMount,
  reconcileTaskSessionsOnMount,
  resetManagedAutoDeliverDedupForTests,
  resetRuntimeProjectionForTests,
  setRuntimeProjectionTestHooksForTests,
  SESSION_UNAVAILABLE_WAIT_SUMMARY,
} from "../src/service/handlers.js";
import { ensureRoleWorkspace } from "../src/core/workspace.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { configureTestGitIdentity, git } from "./helpers.js";
import { fileURLToPath } from "node:url";
import {
  ToolApprovalStore,
  makeToolApprovalId,
} from "../src/service/tool-approval-store.js";

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
    requestPermission?: boolean;
    permissionTimeoutMs?: number;
    keepAlive?: boolean;
    /** Spontaneous child death after session/new (no pending prompt required). */
    dieAfterSessionMs?: number;
    dieExitCode?: number;
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
      ...(opts.promptMode && opts.promptMode !== "ok"
        ? { MOCK_ACP_PROMPT_MODE: opts.promptMode }
        : {}),
      ...(opts.stopReason ? { MOCK_ACP_STOP_REASON: opts.stopReason } : {}),
      ...(opts.requestPermission ? { MOCK_ACP_REQUEST_PERMISSION: "1" } : {}),
      ...(opts.dieAfterSessionMs != null
        ? {
            MOCK_ACP_DIE_AFTER_SESSION_MS: String(opts.dieAfterSessionMs),
            MOCK_ACP_DIE_EXIT_CODE: String(opts.dieExitCode ?? 1),
            // Hang on prompt if it arrives before death — spontaneous path still fires.
            MOCK_ACP_PROMPT_MODE: "interrupt",
          }
        : {}),
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: opts.permissionPolicy ?? "deny",
      promptTimeoutMs: 8_000,
      permissionTimeoutMs: opts.permissionTimeoutMs ?? 500,
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

async function makeWorkspace(
  name = "b5",
  rolePolicies?: Record<string, "allow" | "ask" | "deny">,
  roleProfiles?: Record<string, string[]>
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
            // Default allow path needs an authorized profile id (role authority MVP).
            ...(rolePolicies?.executor === "allow"
              ? {
                  allowedProfiles:
                    roleProfiles?.executor ?? ["fake-default"],
                }
              : roleProfiles?.executor
                ? { allowedProfiles: roleProfiles.executor }
                : {}),
          },
          {
            name: "orchestrator",
            prompt: "dispatch work",
            ...(rolePolicies?.orchestrator ? { a2aPolicy: rolePolicies.orchestrator } : {}),
            ...(rolePolicies?.orchestrator === "allow"
              ? {
                  allowedProfiles:
                    roleProfiles?.orchestrator ?? ["fake-default"],
                }
              : roleProfiles?.orchestrator
                ? { allowedProfiles: roleProfiles.orchestrator }
                : {}),
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
    const projectedSession = await client.call("session.get", {
      sessionId: started.session.sessionId,
    });
    assert.equal(
      JSON.stringify(projectedSession).includes("profileSnapshot"),
      false,
      "session RPC projection must not expose the machine-local launch snapshot"
    );
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

test("B5: A2A resolve is user-only and approval is bound to workspace/task/profile", async () => {
  const ws = await makeWorkspace("b5-ask-binding", { executor: "ask" });
  const otherWs = await makeWorkspace("b5-ask-binding-other", { executor: "ask" });
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const otherWorkspaceId = (await rpc(svc, "workspace.mount", {
      workspaceRoot: otherWs,
    })).result as { workspaceId: string };
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "approval binding",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const ask = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    assert.equal(ask.error?.code, RPC_A2A_ASK);
    const approvalId = (ask.error!.data as { approvalId: string }).approvalId;

    const selfApprove = await rpc(svc, "a2a.resolve", {
      approvalId,
      decision: "approve",
      actor: "executor",
    });
    assert.equal(selfApprove.error?.code, -32001);
    assert.match(String(selfApprove.error?.message), /user-only/i);

    // Mark approved through the internal store so the RPC re-entry binding can be tested
    // independently from a2a.resolve, which always reuses the exact stored target.
    await svc.ctx.a2a.resolve(approvalId, "approved", "user");

    const wrongProfile = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "other-profile",
      approvalId,
    });
    assert.equal(wrongProfile.error?.code, RPC_A2A_DENIED);
    assert.match(String(wrongProfile.error?.message), /profile mismatch/i);

    const wrongWorkspace = await rpc(svc, "task.startSession", {
      workspaceId: otherWorkspaceId.workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "fake-default",
      approvalId,
    });
    assert.equal(wrongWorkspace.error?.code, RPC_A2A_DENIED);
    assert.match(String(wrongWorkspace.error?.message), /workspace mismatch/i);

    const sessions = await rpc(svc, "session.list", { workspaceId });
    assert.equal((sessions.result as { sessions: unknown[] }).sessions.length, 0);
  });
});

test("B5: a2aPolicyOverride cannot raise role authority over RPC", async () => {
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
    assert.ok(started.error);
    assert.equal(started.error!.code, -32602);
    const sessions = await rpc(svc, "session.list", { workspaceId });
    assert.equal((sessions.result as { sessions: unknown[] }).sessions.length, 0);
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

test("B5: role a2aPolicy=allow requires profileId in allowedProfiles", async () => {
  const ws = await makeWorkspace(
    "b5-profile-allow",
    { executor: "allow" },
    { executor: ["fake-default"] }
  );
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "profile whitelist",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const denied = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "not-on-list",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, RPC_A2A_DENIED);

    const allowed = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    assert.ok(!allowed.error, JSON.stringify(allowed.error));
  });
});

test("B5: role a2aPolicy=ask still parks even when profile not on whitelist; user approve overrides", async () => {
  // ask path must not hard-deny for missing allowedProfiles; user grant may override.
  const ws = await makeWorkspace("b5-ask-profile", { executor: "ask" }, { executor: [] });
  // empty executor profiles via direct write (makeWorkspace skips empty arrays for non-allow)
  await fs.writeFile(
    path.join(ws, ".tent", "roles.json"),
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work", a2aPolicy: "ask", allowedProfiles: ["other-only"] },
          { name: "orchestrator", prompt: "dispatch work" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "ask override profile",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const ask = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    assert.ok(ask.error);
    assert.equal(ask.error!.code, RPC_A2A_ASK);
    const approvalId = (ask.error!.data as { approvalId: string }).approvalId;

    const resolved = await rpc(svc, "a2a.resolve", {
      approvalId,
      decision: "approve",
      actor: "user",
    });
    assert.ok(!resolved.error, JSON.stringify(resolved.error));
    const started = resolved.result as {
      started: { session: { profileId: string } };
    };
    assert.equal(started.started.session.profileId, "fake-default");
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
    assert.match(bootstrap!, /delivered automatically|auto/i);
    assert.match(bootstrap!, /Task envelope:/);
    assert.match(bootstrap!, /Manifest:/);
    assert.match(bootstrap!, /claims:/);
    assert.match(bootstrap!, /deliveryPolicy:/);
    // Path tutorial once (Context Card), not re-taught in managed session body.
    const pathTutorialHits = bootstrap!.match(/run tent from workspaceRoot/gi) || [];
    assert.equal(pathTutorialHits.length, 1, "path tutorial should appear once in managed bootstrap");
    // Must not instruct claim/get/deliver CLI commands (managed path auto-delivers final reply).
    assert.doesNotMatch(bootstrap!, /tent task claim|task-ack|tent report\b/);
    assert.doesNotMatch(bootstrap!, /tent task get |tent task deliver /);
    assert.doesNotMatch(bootstrap!, /Run `tent task claim/);
    assert.doesNotMatch(bootstrap!, /docs API|CLI aliases/i);
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
      }, 20_000, "task delivered via managed auto-deliver");

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
      assert.ok(log.prompts.some((p) => /already claimed/i.test(p)));
      assert.ok(log.prompts.some((p) => /delivered automatically/i.test(p)));
      assert.ok(
        log.prompts.every((p) => !/tent task deliver /.test(p)),
        "managed bootstrap must not instruct tent task deliver"
      );
      assert.ok(
        log.prompts.every((p) => !/docs API|CLI aliases/i.test(p)),
        "managed bootstrap must not advertise non-existent docs CLI aliases"
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
        const runtimeEvents: string[] = [];
        const unsubscribe = svc.runtime.subscribeAll((event) => {
          runtimeEvents.push(event.type);
        });
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
        const started = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath,
          callerKind: "user",
          profileId: "mock-acp-bypass",
        });
        const sessionId = (started.result as { session: { sessionId: string } }).session
          .sessionId;
        let accepted: { state: string };
        try {
          accepted = await pollUntil(async () => {
            const g = await rpc(svc, "task.get", { workspaceId, taskPath });
            const task = (g.result as { task: { state: string } }).task;
            return task.state === "accepted" ? task : null;
          }, 30_000, "bypass accepted");
        } catch (error) {
          const probe = await svc.runtime.probe(sessionId);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; ` +
              `runtimeEvents=${runtimeEvents.join(",")}; probe=${JSON.stringify(probe)}`
          );
        } finally {
          unsubscribe();
        }
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
        const runtimeEvents: string[] = [];
        const unsubscribe = svc.runtime.subscribeAll((event) => {
          runtimeEvents.push(event.type);
        });
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
        const started = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath,
          callerKind: "user",
          profileId: "mock-acp-ad",
        });
        const sessionId = (started.result as { session: { sessionId: string } }).session
          .sessionId;
        let delivered: { state: string };
        try {
          delivered = await pollUntil(async () => {
            const g = await rpc(svc, "task.get", { workspaceId, taskPath });
            const task = (g.result as { task: { state: string } }).task;
            return task.state === "delivered" ? task : null;
          }, 30_000, "agent-decide delivered for review");
        } catch (error) {
          const probe = await svc.runtime.probe(sessionId);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; ` +
              `runtimeEvents=${runtimeEvents.join(",")}; probe=${JSON.stringify(probe)}`
          );
        } finally {
          unsubscribe();
        }
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
    "proposal.list",
    "proposal.submit",
    "proposal.resolve",
    "session.list",
    "a2a.listPending",
    "a2a.resolve",
    "toolApproval.listPending",
    "toolApproval.get",
    "toolApproval.approveOnce",
    "toolApproval.deny",
    "operationalRetention.preview",
    "operationalRetention.purge",
    "registry.role.create",
    "registry.role.update",
    "registry.role.delete",
  ]) {
    assert.ok((CLIENT_METHODS as readonly string[]).includes(m), m);
  }
  assert.ok(!(CLIENT_METHODS as readonly string[]).includes("AgentRuntimePort.startSession"));
  assert.equal(FAKE_ADAPTER_ID, "fake-cli");
});

test("B5 tool approval: service restart expires orphaned pending request", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-tool-restart-"));
  const approvalId = makeToolApprovalId(() => 0.44);
  const seeded = new ToolApprovalStore(dataDir);
  await seeded.add({
    id: approvalId,
    workspaceId: "ws-orphaned",
    sessionId: "ss-orphaned",
    taskId: "task-orphaned",
    taskPath: "temp/executor/tasks/task-orphaned.md",
    role: "executor",
    toolTitle: "write_file",
    options: [{ optionId: "allow_once", kind: "allow_once" }],
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const pending = await rpc(svc, "toolApproval.listPending", {});
    assert.ok(!pending.error, JSON.stringify(pending.error));
    assert.deepEqual((pending.result as { approvals: unknown[] }).approvals, []);

    const get = await rpc(svc, "toolApproval.get", { approvalId });
    assert.ok(!get.error, JSON.stringify(get.error));
    const recovered = (get.result as {
      approval: { status: string; resolvedBy?: string };
    }).approval;
    assert.equal(recovered.status, "expired");
    assert.equal(recovered.resolvedBy, "service-restart");

    const approve = await rpc(svc, "toolApproval.approveOnce", {
      approvalId,
      actor: "user",
    });
    assert.ok(approve.error);
    assert.match(approve.error!.message, /already expired/);
  } finally {
    await svc.stop();
  }
});

test("B5 tool approval: service stop denies and releases store waiter", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-tool-stop-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  const approvalId = makeToolApprovalId(() => 0.46);
  await svc.ctx.toolApprovals.add({
    id: approvalId,
    workspaceId: "ws-stop",
    sessionId: "ss-stop",
    toolTitle: "shell",
    options: [{ optionId: "allow_once", kind: "allow_once" }],
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const waiting = svc.ctx.toolApprovals.waitForDecision(approvalId, 60_000);
  await new Promise((resolve) => setTimeout(resolve, 10));

  await svc.stop();
  assert.equal(await waiting, "denied");
  const item = await svc.ctx.toolApprovals.get(approvalId);
  assert.equal(item?.status, "denied");
  assert.equal(item?.resolvedBy, "service-shutdown");
});

test("B5 tool approval: ask → pending → approve once → running → deliver", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-tool-appr-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "need tool then finish",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-tool-ask",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      // Task parks waiting on tool permission.
      await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string; wait?: { reason: string } } })
          .task;
        return task.state === "waiting" && task.wait?.reason === "user-input" ? task : null;
      }, 12_000, "task waiting for tool approval");

      const pending = await pollUntil(async () => {
        const list = await rpc(svc, "toolApproval.listPending", { workspaceId });
        const approvals = (
          list.result as {
            approvals: Array<{
              id: string;
              toolTitle: string;
              sessionId: string;
              taskPath?: string;
            }>;
          }
        ).approvals;
        return approvals.find((a) => a.sessionId === sessionId) ?? null;
      }, 12_000, "tool approval pending");
      assert.match(pending.toolTitle, /read_file|tool/);
      assert.equal(pending.taskPath, taskPath);

      // Agent self-approve must be rejected.
      const self = await rpc(svc, "toolApproval.approveOnce", {
        approvalId: pending.id,
        actor: "executor",
      });
      assert.ok(self.error);
      assert.match(self.error!.message, /user-only|self-approve/i);

      const got = await rpc(svc, "toolApproval.get", { approvalId: pending.id });
      assert.ok(!got.error, JSON.stringify(got.error));
      assert.equal(
        (got.result as { approval: { status: string } }).approval.status,
        "pending"
      );

      const approved = await rpc(svc, "toolApproval.approveOnce", {
        approvalId: pending.id,
        actor: "user",
      });
      assert.ok(!approved.error, JSON.stringify(approved.error));
      assert.equal(
        (approved.result as { approval: { status: string } }).approval.status,
        "approved"
      );

      // ACP allow_once then managed deliver.
      const logOutcome = await pollUntil(async () => {
        try {
          const raw = await fs.readFile(logPath, "utf8");
          const log = JSON.parse(raw) as {
            permissionOutcomes: Array<{ outcome?: string; optionId?: string }>;
          };
          return log.permissionOutcomes?.[0] ?? null;
        } catch {
          return null;
        }
      }, 12_000, "permission outcome written");
      assert.equal(logOutcome.outcome, "selected");
      assert.equal(logOutcome.optionId, "allow_once");

      const delivered = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string } }).task;
        return task.state === "delivered" ? task : null;
      }, 15_000, "task delivered after tool approve");
      assert.equal(delivered.state, "delivered");

      // Distinct from A2A store — tool approvals never appear as a2a pending.
      const a2a = await rpc(svc, "a2a.listPending", { workspaceId });
      assert.equal((a2a.result as { approvals: unknown[] }).approvals.length, 0);

      // Machine-local only: tool-approvals.json under service dataDir, not workspace .tent.
      const storePath = path.join(svc.dataDir, "tool-approvals.json");
      await fs.access(storePath);
      const tentListing = await fs.readdir(path.join(ws, ".tent"));
      assert.ok(!tentListing.includes("tool-approvals.json"));
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-tool-ask", {
          logPath,
          promptText: "TOOL_APPROVED_REPORT",
          permissionPolicy: "ask",
          requestPermission: true,
          permissionTimeoutMs: 30_000,
        }),
      ],
    }
  );
});

test("B5 tool approval: concurrent asks keep task waiting until the final decision", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "two concurrent tool requests",
    });
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "fake-default",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await mapRuntimeEventToService(svc.ctx, {
      type: "session.waiting_user",
      sessionId,
      summary: "two tools need approval",
    });
    const now = Date.now();
    const base = {
      workspaceId,
      sessionId,
      taskId: taskPath,
      taskPath,
      role: "executor",
      options: [{ optionId: "allow_once", kind: "allow_once" }],
      status: "pending" as const,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    await svc.ctx.toolApprovals.add({
      ...base,
      id: "ta-concurrent-1",
      toolTitle: "read_file",
    });
    await svc.ctx.toolApprovals.add({
      ...base,
      id: "ta-concurrent-2",
      toolTitle: "write_file",
    });

    const first = await rpc(svc, "toolApproval.approveOnce", {
      approvalId: "ta-concurrent-1",
      actor: "user",
    });
    assert.ok(!first.error, JSON.stringify(first.error));
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.live",
      sessionId,
      pid: 8301,
    });

    const stillWaiting = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (stillWaiting.result as { task: { state: string } }).task.state,
      "waiting"
    );
    assert.equal((await svc.runtime.registry.read(sessionId))?.state, "waiting-user");

    const second = await rpc(svc, "toolApproval.approveOnce", {
      approvalId: "ta-concurrent-2",
      actor: "user",
    });
    assert.ok(!second.error, JSON.stringify(second.error));
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.live",
      sessionId,
      pid: 8301,
    });

    const resumed = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((resumed.result as { task: { state: string } }).task.state, "running");
    assert.equal((await svc.runtime.registry.read(sessionId))?.state, "live");
  });
});

test("B5 tool approval: user deny cancels tool (ACP cancelled)", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-tool-deny-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "will deny tool",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-tool-deny",
      });
      assert.ok(!started.error, JSON.stringify(started.error));

      const pending = await pollUntil(async () => {
        const list = await rpc(svc, "toolApproval.listPending", { workspaceId });
        const approvals = (list.result as { approvals: Array<{ id: string }> }).approvals;
        return approvals[0] ?? null;
      }, 12_000, "pending tool approval for deny");

      const denied = await rpc(svc, "toolApproval.deny", {
        approvalId: pending.id,
        actor: "user",
      });
      assert.ok(!denied.error, JSON.stringify(denied.error));
      assert.equal(
        (denied.result as { approval: { status: string } }).approval.status,
        "denied"
      );

      const outcome = await pollUntil(async () => {
        try {
          const raw = await fs.readFile(logPath, "utf8");
          const log = JSON.parse(raw) as {
            permissionOutcomes: Array<{ outcome?: string }>;
          };
          return log.permissionOutcomes?.[0] ?? null;
        } catch {
          return null;
        }
      }, 12_000, "denied permission outcome");
      assert.equal(outcome.outcome, "cancelled");
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-tool-deny", {
          logPath,
          promptText: "AFTER_DENY",
          permissionPolicy: "ask",
          requestPermission: true,
          permissionTimeoutMs: 30_000,
        }),
      ],
    }
  );
});

test("B5 tool approval: ask timeout expires pending; late approve fails", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-tool-timeout-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  // Short store-authoritative timeout (sole expiry; client has no permission timer).
  const permissionTimeoutMs = 400;
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "will timeout tool ask",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-tool-timeout",
      });
      assert.ok(!started.error, JSON.stringify(started.error));

      const pending = await pollUntil(async () => {
        const list = await rpc(svc, "toolApproval.listPending", { workspaceId });
        const approvals = (
          list.result as { approvals: Array<{ id: string; status?: string }> }
        ).approvals;
        return approvals[0] ?? null;
      }, 12_000, "pending tool approval for timeout");

      // Wait for store-authoritative expiry (not a second client-only deny path).
      const expired = await pollUntil(async () => {
        const got = await rpc(svc, "toolApproval.get", { approvalId: pending.id });
        if (got.error) return null;
        const approval = (got.result as { approval: { status: string } }).approval;
        return approval.status === "expired" ? approval : null;
      }, 8_000, "tool approval expired by store timeout");
      assert.equal(expired.status, "expired");

      // Late approve must fail — cannot resurrect pending / dual-timeout allow.
      const late = await rpc(svc, "toolApproval.approveOnce", {
        approvalId: pending.id,
        actor: "user",
      });
      assert.ok(late.error, "late approve after expiry must fail");
      assert.match(late.error!.message, /already expired|not found|already/i);

      // ACP path must cancel (deny), never allow_once after timeout.
      const outcome = await pollUntil(async () => {
        try {
          const raw = await fs.readFile(logPath, "utf8");
          const log = JSON.parse(raw) as {
            permissionOutcomes: Array<{ outcome?: string; optionId?: string }>;
          };
          return log.permissionOutcomes?.[0] ?? null;
        } catch {
          return null;
        }
      }, 12_000, "timeout permission outcome");
      assert.equal(outcome.outcome, "cancelled");
      assert.notEqual(outcome.optionId, "allow_once");

      // No lingering pending for this workspace.
      const list = await rpc(svc, "toolApproval.listPending", { workspaceId });
      assert.equal((list.result as { approvals: unknown[] }).approvals.length, 0);
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-tool-timeout", {
          logPath,
          promptText: "AFTER_TIMEOUT",
          permissionPolicy: "ask",
          requestPermission: true,
          permissionTimeoutMs,
        }),
      ],
    }
  );
});

test("B5 failure cleanup: prompt error stops process, taskFail releases occupation", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-fail-clean-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "will fail",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-fail-clean",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      const failed = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string } }).task;
        return task.state === "failed" ? task : null;
      }, 12_000, "task failed after prompt error");
      assert.equal(failed.state, "failed");

      // No live managed session / orphan process.
      const probe = await svc.runtime.probe(sessionId);
      assert.equal(probe.alive, false);
      assert.ok(probe.state === "failed" || probe.state === "stopped");

      // Occupation released — box has no owner/doing.
      const concept = await rpc(svc, "docs.get", { workspaceId, id: boxId });
      const fm = (concept.result as { frontmatter?: { owner?: string; status?: string } })
        .frontmatter;
      // docs.get may nest differently — fall back to raw read via docs.readForEdit
      let owner: unknown;
      let status: unknown;
      if (fm) {
        owner = fm.owner;
        status = fm.status;
      } else {
        const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id: boxId });
        const data = edit.result as {
          frontmatter?: { owner?: string; status?: string };
          data?: { owner?: string; status?: string };
        };
        owner = data.frontmatter?.owner ?? data.data?.owner;
        status = data.frontmatter?.status ?? data.data?.status;
      }
      assert.ok(owner === undefined || owner === null || owner === "");
      assert.notEqual(status, "doing");

      // Same box re-dispatch without fork.
      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "retry after fail cleanup",
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));

      // Duplicate session.failed must not throw / illegal transition.
      mapRuntimeEventToService(svc.ctx, {
        type: "session.failed",
        sessionId,
        error: "duplicate failure event",
      });
      await new Promise((r) => setTimeout(r, 150));
      const g2 = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal((g2.result as { task: { state: string } }).task.state, "failed");
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-fail-clean", {
          logPath,
          promptMode: "error",
          keepAlive: false,
        }),
      ],
    }
  );
});

for (const exitCode of [7, 0]) test(`B5 spontaneous managed child exit code=${exitCode} releases occupation`, async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-spontaneous-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "child will die spontaneously",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-spontaneous-die",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      // Child exits after session/new even if prompt never settles. Both abnormal
      // and clean exit without delivery are terminal for the bound task.
      const failed = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string } }).task;
        return task.state === "failed" ? task : null;
      }, 12_000, "task failed after spontaneous child exit");
      assert.equal(failed.state, "failed");

      const probe = await svc.runtime.probe(sessionId);
      assert.equal(probe.alive, false);
      assert.ok(probe.state === "failed" || probe.state === "stopped");

      const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id: boxId });
      const data = edit.result as {
        frontmatter?: { owner?: string; status?: string };
        data?: { owner?: string; status?: string };
      };
      const owner = data.frontmatter?.owner ?? data.data?.owner;
      const status = data.frontmatter?.status ?? data.data?.status;
      assert.ok(owner === undefined || owner === null || owner === "");
      assert.notEqual(status, "doing");

      // Re-dispatch same box proves occupation fully released.
      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "retry after spontaneous death",
      });
      assert.ok(!d2.error, JSON.stringify(d2.error));
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-spontaneous-die", {
          logPath,
          dieAfterSessionMs: 120,
          dieExitCode: exitCode,
          keepAlive: false,
        }),
      ],
    }
  );
});

// ---- session reconcile on boot ----

/**
 * Crash/restart → remount task-side evidence (not only session.probe).
 * Same-lifetime exit→failed projection is covered elsewhere and left unchanged.
 * Here we unmount before service stop so exit events cannot project the task, then
 * remount after restart — mount reconcile must correct the stale disk-live registry row,
 * park waiting(external), and keep occupation.
 */
test("B5: crash restart + mount parks running task bound to dead session (task-side)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-crash-mount-"));
  const ws = await makeWorkspace("crash-mount");
  let sessionId = "";
  let taskPath = "";
  let boxId = "";

  {
    const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
    try {
      const mounted = await mountWorkItem(svc, ws);
      boxId = mounted.boxId;
      const d = await rpc(svc, "task.dispatch", {
        workspaceId: mounted.workspaceId,
        boxId,
        role: "executor",
        prompt: "crash mid-session",
      });
      taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId: mounted.workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId: mounted.workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "fake-default",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
      assert.equal((await svc.runtime.probe(sessionId)).alive, true);

      // Snapshot: task running + bound, occupation held, process alive.
      const pre = await loadTaskEnvelope(
        svc.hostApi.require(mounted.workspaceId).env.fs,
        taskPath
      );
      assert.equal(pre.state, "running");
      assert.equal(pre.sessionId, sessionId);

      // Unmount so service shutdown / child stop cannot project exit→failed onto the task.
      // That same-lifetime path is intentional product behavior; restart mount is the heal.
      await rpc(svc, "workspace.unmount", { workspaceId: mounted.workspaceId });
    } finally {
      await svc.stop();
    }
  }

  // Optionally re-mark registry live on disk (simulates crash before registry flush of exit).
  // Probe on the new service must correct it; mount reconcile parks the task.
  {
    const { sessionFilePath } = await import("../src/runtime/session-registry.js");
    const file = sessionFilePath(dataDir, sessionId);
    const rec = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    rec.state = "live";
    rec.pid = 888_001;
    delete rec.exitCode;
    delete rec.lastError;
    delete rec.stopReason;
    rec.updatedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
  }

  const svc2 = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const bootProbe = await svc2.runtime.probe(sessionId);
    assert.equal(bootProbe.alive, false);
    assert.ok(
      bootProbe.state === "failed" || bootProbe.state === "stopped",
      `boot probe must correct stale live, got ${bootProbe.state}`
    );

    const remounted = await rpc(svc2, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!remounted.error, JSON.stringify(remounted.error));
    const workspaceId = (remounted.result as { workspaceId: string }).workspaceId;

    const got = await rpc(svc2, "task.get", { workspaceId, taskPath });
    assert.ok(!got.error, JSON.stringify(got.error));
    const task = (got.result as {
      task: {
        state: string;
        wait?: { reason: string; summary: string } | null;
        sessionId?: string;
      };
    }).task;
    assert.equal(task.state, "waiting", "mount reconcile must park task, not leave running");
    assert.equal(task.wait?.reason, "external");
    assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.equal(task.sessionId, sessionId);

    const rec = await svc2.runtime.registry.read(sessionId);
    assert.ok(rec);
    assert.ok(
      rec!.state === "failed" || rec!.state === "stopped",
      `registry remains corrected after mount, got ${rec!.state}`
    );

    const box = await rpc(svc2, "docs.get", { workspaceId, id: boxId });
    assert.ok(!box.error, JSON.stringify(box.error));
    const concept = (box.result as { concept: { status?: string; assignee?: string; owner?: string } }).concept;
    assert.equal(concept.status, "doing");
    assert.ok(concept.assignee || concept.owner, "occupation must remain after crash→mount");
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

    // Explicit commits override auto-collect (conflict fixtures need a known ref).
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
    // Session must stay non-terminal so the role remains occupied until retry succeeds.
    assert.ok(
      rec!.state === "live" || rec!.state === "starting" || rec!.state === "waiting-user",
      `expected live session after integrate failure, got ${rec!.state}`
    );

    assert.equal((await git(ws, "rev-parse", "HEAD")).trim(), beforeHead);
  });
});

test("P0 fix: managed auto-deliver collects role-lane commit; manual accept integrates", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-collect-manual");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "auto-collect then review",
      deliveryPolicy: "manual",
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
    const sourceRef = await roleCommit(
      ws,
      "executor",
      "collect-manual.txt",
      "ship\n",
      "collect manual"
    );

    // Production path: omit commits → collect from authoritative role lane.
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "COLLECTED_MANUAL_REPORT",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");

    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ summary: string; commits: string[]; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].summary, "COLLECTED_MANUAL_REPORT");
    assert.equal(deliveries[0].status, "ready");
    assert.deepEqual(deliveries[0].commits, [sourceRef]);

    // Session stopped after successful delivery so role can take the next task.
    const rec = await svc.runtime.registry.read(sessionId);
    assert.ok(rec, "registry row retained for resume metadata");
    assert.notEqual(rec!.state, "live");
    assert.ok(rec!.state === "stopped" || rec!.state === "failed");

    const accepted = await rpc(svc, "task.accept", {
      workspaceId,
      taskPath,
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.equal(
      normalizeLf(await fs.readFile(path.join(ws, "collect-manual.txt"), "utf8")),
      "ship\n"
    );
  });
});

test("P0 fix: managed auto-deliver bypass integrates auto-collected commit", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-collect-bypass");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "auto-collect bypass",
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
    const sourceRef = await roleCommit(
      ws,
      "executor",
      "collect-bypass.txt",
      "auto\n",
      "collect bypass"
    );

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "COLLECTED_BYPASS_REPORT",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "accepted");

    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ commits: string[]; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "accepted");
    assert.deepEqual(deliveries[0].commits, [sourceRef]);
    assert.equal(
      normalizeLf(await fs.readFile(path.join(ws, "collect-bypass.txt"), "utf8")),
      "auto\n"
    );

    const rec = await svc.runtime.registry.read(sessionId);
    assert.ok(rec);
    assert.notEqual(rec!.state, "live");
  });
});

test("P0 fix: managed auto-deliver zero-commit / non-Git remains legal", async () => {
  resetManagedAutoDeliverDedupForTests();
  // Non-Git workspace: no lane, zero commits is a valid delivery.
  const ws = await makeWorkspace("p0-macp-zero-nongit");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "docs only managed",
      deliveryPolicy: "manual",
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

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "ZERO_COMMIT_REPORT",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "delivered");
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ commits: string[]; summary: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].summary, "ZERO_COMMIT_REPORT");
    assert.deepEqual(deliveries[0].commits, []);
  });

  // Git workspace with no role commits: also legal zero-commit delivery.
  resetManagedAutoDeliverDedupForTests();
  const wsGit = await makeWorkspace("p0-macp-zero-git");
  await initGitOnWorkspace(wsGit);
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, wsGit);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "report only",
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

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "GIT_ZERO_COMMIT_REPORT",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "accepted");
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (list.result as { deliveries: Array<{ commits: string[] }> }).deliveries;
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0].commits, []);
  });
});

test("P0 fix: managed auto-collect excludes pre-session role commits; includes active-window commits", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-base-scope");
  await initGitOnWorkspace(ws);
  // Pre-existing / unrelated commit on the long-lived role branch before any task binds.
  const preExisting = await roleCommit(
    ws,
    "executor",
    "stale-pre.txt",
    "old\n",
    "pre-existing unrelated"
  );

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "only my commits",
      deliveryPolicy: "manual",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;

    const mount = svc.ctx.host.require(workspaceId);
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath)).roleBranchBase,
      undefined,
      "queued dispatch must not reserve the shared role lane"
    );

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

    const afterStart = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(afterStart.roleBranchBase, preExisting);
    const taskRef = await roleCommit(
      ws,
      "executor",
      "task-only.txt",
      "mine\n",
      "task active-window commit"
    );

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "SCOPED_COLLECT",
    });

    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ commits: string[]; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.deepEqual(
      deliveries[0].commits,
      [taskRef],
      "pre-session role commits must not be scooped into this task"
    );
    assert.ok(!deliveries[0].commits.includes(preExisting));
  });
});

test("P0 fix: roleBranchBase is stable across startSession and reject-resume", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-base-stable");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "stable baseline",
      deliveryPolicy: "manual",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    const mount = svc.ctx.host.require(workspaceId);
    assert.equal((await loadTaskEnvelope(mount.env.fs, taskPath)).roleBranchBase, undefined);

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
    const baseAtStart = (await loadTaskEnvelope(mount.env.fs, taskPath)).roleBranchBase;
    assert.ok(baseAtStart);
    await roleCommit(ws, "executor", "stable-a.txt", "a\n", "after start a");
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath)).roleBranchBase,
      baseAtStart,
      "startSession must not overwrite roleBranchBase"
    );

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "NEED_REWORK",
    });
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath)).roleBranchBase,
      baseAtStart
    );

    const rejected = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      resume: true,
      note: "rework",
    });
    assert.ok(!rejected.error, JSON.stringify(rejected.error));
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath)).roleBranchBase,
      baseAtStart,
      "reject-resume must retain the original baseline"
    );

    // Extra role commits after reject still belong to the same task scope.
    const reworkRef = await roleCommit(ws, "executor", "stable-b.txt", "b\n", "rework commit");
    await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    const got = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(got.roleBranchBase, baseAtStart);
    assert.equal(got.state, "running");
    // Sanity: rework commit is above base (collection would include it).
    assert.notEqual(reworkRef, baseAtStart);
  });
});

test("P0 fix: recorded workspace lane collection errors stay retryable", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-lane-error");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "do not downgrade a broken lane",
      deliveryPolicy: "manual",
    });
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    const sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;

    const mount = svc.ctx.host.require(workspaceId);
    await patchTaskEnvelope(mount.env.fs, taskPath, {
      workspace: ws,
      branch: "tent-role/executor",
      targetBranch: "main",
      updatedAt: mount.env.clock.now(),
    });

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "MUST_NOT_DELIVER_AS_ZERO_COMMITS",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
    const deliveries = await rpc(svc, "delivery.list", { workspaceId });
    assert.deepEqual(
      (deliveries.result as { deliveries: unknown[] }).deliveries,
      [],
      "a recorded lane error must not become a zero-commit delivery"
    );
    const session = await svc.runtime.registry.read(sessionId);
    assert.match(session?.lastError ?? "", /managed auto-deliver failed/);
    assert.ok(session && session.state !== "stopped" && session.state !== "failed");
  });
});

test("P0 fix: successful managed delivery frees same role for next task", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-macp-role-free");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d1 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "first managed task",
      deliveryPolicy: "manual",
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

    // Queue the next task while the first role session is still active.
    const box2 = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "next-item",
      type: "prompt",
    });
    const boxId2 = (box2.result as { id: string }).id;
    const d2 = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: boxId2,
      role: "executor",
      prompt: "second managed task",
    });
    const taskPath2 = (d2.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath: taskPath2 });
    const blocked = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: taskPath2,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(blocked.error);
    const mount = svc.ctx.host.require(workspaceId);
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath2)).roleBranchBase,
      undefined,
      "a blocked queued task must not capture the shared lane early"
    );

    const firstRef = await roleCommit(
      ws,
      "executor",
      "first-task.txt",
      "first\n",
      "first task commit"
    );
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath: taskPath1,
      sessionId: sessionId1,
      assistantText: "FIRST_DONE",
    });

    const rec1 = await svc.runtime.registry.read(sessionId1);
    assert.ok(rec1, "prior session registry retained");
    assert.notEqual(rec1!.state, "live");

    // Once the first session is delivered/stopped, the queued task captures the
    // current role tip, excluding the first task's still-unaccepted commit.
    const s2 = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath: taskPath2,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!s2.error, JSON.stringify(s2.error));
    const sessionId2 = (s2.result as { session: { sessionId: string } }).session.sessionId;
    assert.notEqual(sessionId2, sessionId1);
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath2)).roleBranchBase,
      firstRef
    );
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath: taskPath2,
      sessionId: sessionId2,
      assistantText: "SECOND_DONE",
    });
    const listed = await rpc(svc, "delivery.list", { workspaceId });
    const secondDelivery = (
      listed.result as { deliveries: Array<{ summary: string; commits: string[] }> }
    ).deliveries.find((delivery) => delivery.summary === "SECOND_DONE");
    assert.deepEqual(secondDelivery?.commits, []);

    // Prior registry row still readable (resume metadata not wiped).
    const rec1Again = await svc.runtime.registry.read(sessionId1);
    assert.ok(rec1Again);
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
    const mount = svc.ctx.host.require(workspaceId);
    assert.equal(
      (await loadTaskEnvelope(mount.env.fs, taskPath2)).roleBranchBase,
      undefined,
      "the active-role rejection must happen before baseline capture"
    );

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

test("mount reconcile: dead/missing/stale-live session → waiting(external); truly-alive/no-sessionId/terminal untouched; multi-ws; idempotent", async () => {
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
        /** Start a real managed session so probe.alive stays true across remount. */
        realLiveSession?: boolean;
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

      let sessionId: string | undefined;

      if (opts.terminal) {
        await rpc(svc, "task.interrupt", { workspaceId, taskPath });
        return { taskPath, boxId, sessionId };
      }

      if (opts.noSession) {
        return { taskPath, boxId, sessionId };
      }

      if (opts.realLiveSession) {
        const started = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath,
          profileId: "fake-default",
          callerKind: "user",
        });
        assert.ok(!started.error, JSON.stringify(started.error));
        sessionId = (started.result as { session: { sessionId: string } }).session.sessionId;
        const probe = await svc.runtime.probe(sessionId);
        assert.equal(probe.alive, true, "seeded live session must be process-alive");
      } else if (opts.bindSession) {
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
        sessionId = sid;
      }

      if (opts.waitingReason) {
        await rpc(svc, "task.wait", {
          workspaceId,
          taskPath,
          reason: opts.waitingReason,
          summary: `parked for ${opts.waitingReason}`,
        });
      }

      return { taskPath, boxId, sessionId };
    }

    // A: running + truly alive managed process → leave (seed first so role sole-session
    // check is not blocked by a later forged nonterminal registry row).
    const live = await seedTask(idA, "live-session", "executor", {
      realLiveSession: true,
    });
    // A: running + stopped session → must park
    const dead = await seedTask(idA, "dead-session", "executor", {
      bindSession: { id: "ss-dead0001", state: "stopped" },
    });
    // A: running + missing session record → park
    const missing = await seedTask(idA, "missing-session", "orchestrator", {
      bindSession: { id: "ss-miss0001", state: "missing" },
    });
    // A: running + disk "live" but no process → park (probe corrects registry).
    // Use orchestrator so forged live row does not collide with real executor session.
    const staleLive = await seedTask(idA, "stale-live-session", "orchestrator", {
      bindSession: { id: "ss-stale001", state: "live" },
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

    // Stale disk-live without process: park + registry corrected by probe
    const staleTask = await get(idA2, staleLive.taskPath);
    assert.equal(staleTask.state, "waiting");
    assert.equal(staleTask.wait?.reason, "external");
    assert.equal(staleTask.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.equal(staleTask.sessionId, "ss-stale001");
    const staleRec = await svc.runtime.registry.read("ss-stale001");
    assert.ok(staleRec, "stale session row retained after probe correction");
    assert.ok(
      staleRec!.state === "failed" || staleRec!.state === "stopped",
      `expected registry corrected to terminal, got ${staleRec!.state}`
    );
    const staleProbe = await svc.runtime.probe("ss-stale001");
    assert.equal(staleProbe.alive, false);

    // Truly alive process must remain running
    const liveTask = await get(idA2, live.taskPath);
    assert.equal(liveTask.state, "running");
    assert.equal(liveTask.wait ?? null, null);
    assert.equal(liveTask.sessionId, live.sessionId);
    assert.equal((await svc.runtime.probe(live.sessionId!)).alive, true);

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

    // Stale-live occupation also retained
    const staleBox = await rpc(svc, "docs.get", { workspaceId: idA2, id: staleLive.boxId });
    assert.ok(!staleBox.error, JSON.stringify(staleBox.error));
    const staleConcept = (staleBox.result as { concept: { status?: string; assignee?: string; owner?: string } }).concept;
    assert.equal(staleConcept.status, "doing");
    assert.ok(staleConcept.assignee || staleConcept.owner, "stale-live occupation must remain");

    // Events fired with session.reconcile reason
    const reconcileEvents = events.filter(
      (e) => e.type === "task.state" && e.payload.reason === "session.reconcile"
    );
    assert.ok(reconcileEvents.length >= 4, `expected reconcile events, got ${reconcileEvents.length}`);

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

test("mount migrates SessionRecord.workspace from pre-sha256 id; does not steal other mounts", async () => {
  // After makeWorkspaceId switched to sha256 digests, machine-local rows may still
  // store the old base64url-prefix id. Migration is mount-boundary only.
  const wsA = await makeWorkspace("wsid-migrate-a");
  const wsB = await makeWorkspace("wsid-migrate-b");
  await withService(async (svc) => {
    const mA = await rpc(svc, "workspace.mount", { workspaceRoot: wsA });
    const mB = await rpc(svc, "workspace.mount", { workspaceRoot: wsB });
    assert.ok(!mA.error && !mB.error, JSON.stringify(mA.error || mB.error));
    const idA = (mA.result as { workspaceId: string }).workspaceId;
    const idB = (mB.result as { workspaceId: string }).workspaceId;
    const rootA = (mA.result as { workspaceRoot: string }).workspaceRoot;
    const rootB = (mB.result as { workspaceRoot: string }).workspaceRoot;

    // Seed a real task on A so sessionId binding is authoritative evidence.
    const created = await rpc(svc, "docs.createNote", {
      workspaceId: idA,
      name: "migrate-bound",
      type: "prompt",
    });
    const boxId = (created.result as { id: string }).id;
    const d = await rpc(svc, "task.dispatch", {
      workspaceId: idA,
      boxId,
      role: "executor",
      prompt: "migrate session workspace id",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId: idA, taskPath });

    const now = new Date().toISOString();
    // Legacy-style id for this workspace (pre-84e5e4a base64url slice algorithm).
    const oldIdForA = (() => {
      const base = path.basename(rootA).replace(/[^a-zA-Z0-9._-]+/g, "-") || "ws";
      const hash = Buffer.from(path.resolve(rootA)).toString("base64url").slice(0, 10);
      return `ws-${base}-${hash}`;
    })();
    assert.notEqual(oldIdForA, idA, "fixture must use a stale pre-migration workspace id");

    const boundSid = "ss-migr0001";
    const laneSid = "ss-migr0002";
    const cwdSid = "ss-migr0003";
    const otherSid = "ss-migr000b";
    const foreignSid = "ss-migr00xx";

    await svc.runtime.registry.write({
      id: boundSid,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "executor",
      state: "stopped",
      workspace: oldIdForA,
      lastTaskId: taskPath,
      createdAt: now,
      updatedAt: now,
    });
    const mountA = svc.hostApi.require(idA);
    await patchTaskEnvelope(mountA.env.fs, taskPath, {
      sessionId: boundSid,
      updatedAt: mountA.env.clock.now(),
    });

    // Lane evidence only (no task binding): workspaceLane.workspace = root A.
    await svc.runtime.registry.write({
      id: laneSid,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "orchestrator",
      state: "stopped",
      workspace: oldIdForA,
      workspaceLane: {
        workspace: rootA,
        worktree: path.join(rootA, ".lane-worktree"),
        branch: "tent-role/orchestrator",
      },
      runtimeWorkspace: { cwd: path.join(rootA, ".lane-worktree") },
      createdAt: now,
      updatedAt: now,
    });

    // Non-lane cwd evidence: runtimeWorkspace.cwd is the canonical root.
    await svc.runtime.registry.write({
      id: cwdSid,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "executor",
      state: "stopped",
      workspace: oldIdForA,
      runtimeWorkspace: { cwd: rootA },
      createdAt: now,
      updatedAt: now,
    });

    // Belongs to currently mounted B — must not be stolen when remounting A.
    await svc.runtime.registry.write({
      id: otherSid,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "executor",
      state: "live",
      workspace: idB,
      runtimeWorkspace: { cwd: rootB },
      createdAt: now,
      updatedAt: now,
    });

    // Unrelated workspace id + path — no evidence for A.
    await svc.runtime.registry.write({
      id: foreignSid,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "executor",
      state: "stopped",
      workspace: "ws-other-place-zzzzzzzz",
      runtimeWorkspace: { cwd: path.join(os.tmpdir(), "tent-unrelated-cwd") },
      createdAt: now,
      updatedAt: now,
    });

    // Remount A: migrate runs before reconcileTaskSessionsOnMount.
    await rpc(svc, "workspace.unmount", { workspaceId: idA });
    const remA = await rpc(svc, "workspace.mount", { workspaceRoot: wsA });
    assert.ok(!remA.error, JSON.stringify(remA.error));
    const idA2 = (remA.result as { workspaceId: string }).workspaceId;
    assert.equal(idA2, idA);

    const bound = await svc.runtime.registry.read(boundSid);
    const lane = await svc.runtime.registry.read(laneSid);
    const cwdOnly = await svc.runtime.registry.read(cwdSid);
    const other = await svc.runtime.registry.read(otherSid);
    const foreign = await svc.runtime.registry.read(foreignSid);

    assert.equal(bound?.workspace, idA2, "task-bound session rebinds to current mount id");
    assert.equal(lane?.workspace, idA2, "lane.workspace evidence rebinds");
    assert.equal(cwdOnly?.workspace, idA2, "non-lane cwd evidence rebinds");
    assert.equal(other?.workspace, idB, "must not steal session owned by other mounted workspace");
    assert.equal(foreign?.workspace, "ws-other-place-zzzzzzzz", "unrelated row untouched");

    // session.list(workspaceId) sees rebound rows under the new id.
    const listed = await rpc(svc, "session.list", { workspaceId: idA2 });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const sessions = (listed.result as { sessions: { sessionId: string; workspace?: string }[] })
      .sessions;
    const listedIds = new Set(sessions.map((s) => s.sessionId));
    assert.ok(listedIds.has(boundSid));
    assert.ok(listedIds.has(laneSid));
    assert.ok(listedIds.has(cwdSid));
    assert.ok(!listedIds.has(otherSid));
    assert.ok(!listedIds.has(foreignSid));
    for (const s of sessions.filter((x) =>
      [boundSid, laneSid, cwdSid].includes(x.sessionId)
    )) {
      assert.equal(s.workspace, idA2);
    }

    // Idempotent direct call: already current id → no second rewrite needed.
    const again = await migrateSessionWorkspaceIdsOnMount(svc.ctx, idA2);
    assert.deepEqual(again.migrated, []);
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

test("task.startSession reuses old sessionId via native load when resumeCapable after restart", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("resume-reuse-ss");
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-resume-log-")),
    "mock-acp-log-resume.json"
  );
  const profile = mockAcpProfile("mock-acp-resume", {
    logPath,
    promptText: "RESUME_REUSE_OK",
    keepAlive: true,
  });
  profile.env = {
    ...profile.env,
    MOCK_ACP_LOAD_SESSION: "1",
    MOCK_ACP_HISTORY_TEXT: "HISTORY_MUST_NOT_AUTO_DELIVER",
  };

  // Simulate post-restart disk: waiting task still holds old ss- id; session row has
  // provider resume token; process is dead (no managed Map).
  const priorSessionId = "ss-reuse01";

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "resume reuse after restart",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      // Claim fills worktree lane; use that as recorded session cwd.
      const claimed = await rpc(svc, "task.get", { workspaceId, taskPath });
      const task = (
        claimed.result as {
          task: { worktree?: string; workspace?: string; branch?: string };
        }
      ).task;
      const cwd = task.worktree || ws;
      assert.ok(cwd);

      await svc.runtime.registry.write({
        id: priorSessionId,
        profileId: "mock-acp-resume",
        adapterId: GROK_ACP_ADAPTER_ID,
        roleName: "executor",
        state: "stopped",
        resumeToken: "mock-acp-session-1",
        runtimeWorkspace: { cwd },
        workspace: workspaceId,
        workspaceLane: task.worktree
          ? {
              workspace: task.workspace || ws,
              worktree: task.worktree,
              branch: task.branch || "HEAD",
            }
          : undefined,
        lastTaskId: taskPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Bind task.sessionId + park waiting (external) as mount reconcile would.
      const mount = svc.ctx.host.require(workspaceId);
      await svc.ctx.mutations.run(workspaceId, async () => {
        svc.ctx.host.markSelfWrite(workspaceId);
        await patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: priorSessionId,
          updatedAt: mount.env.clock.now(),
        });
      });
      await rpc(svc, "task.wait", {
        workspaceId,
        taskPath,
        reason: "external",
        summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
      });

      const probe = await svc.runtime.probe(priorSessionId);
      assert.equal(probe.alive, false);
      assert.equal(probe.resumeCapable, true, JSON.stringify(probe));

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-acp-resume",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const result = started.result as {
        session: { sessionId: string };
        task: { sessionId?: string; state: string };
      };
      assert.equal(
        result.session.sessionId,
        priorSessionId,
        "must reuse old Tent sessionId, not allocate a new ss-"
      );
      assert.equal(result.task.sessionId, priorSessionId);
      // Resume returns live quickly; bootstrap may already have auto-delivered.
      assert.ok(
        result.task.state === "running" || result.task.state === "delivered",
        `unexpected task state ${result.task.state}`
      );

      const log = await pollUntil(async () => {
        try {
          const raw = await fs.readFile(logPath, "utf8");
          const parsed = JSON.parse(raw) as {
            methods: string[];
            loads?: Array<{ sessionId: string; cwd: string }>;
          };
          return parsed.methods.includes("session/load") ? parsed : null;
        } catch {
          return null;
        }
      }, 45_000, "session/load in mock log");
      assert.ok(log.methods.includes("session/load"));
      assert.ok(!log.methods.includes("session/new"));
      assert.equal(log.loads?.[0]?.sessionId, "mock-acp-session-1");
      assert.equal(path.resolve(log.loads?.[0]?.cwd || ""), path.resolve(cwd));

      // History replay must not become delivery summary; only post-load prompt text.
      const delivery = await pollUntil(async () => {
        const list = await rpc(svc, "delivery.list", { workspaceId });
        const deliveries = (
          list.result as { deliveries: Array<{ summary: string }> }
        ).deliveries;
        return deliveries[0] ?? null;
      }, 45_000, "auto-delivery after resume bootstrap");
      assert.equal(delivery.summary, "RESUME_REUSE_OK");
      assert.doesNotMatch(delivery.summary, /HISTORY/);
    },
    { profiles: [profile] }
  );
});

test("task.startSession allocates new session when prior token not resumeCapable", async () => {
  // Codex-shaped profile: canResume=false even if a resumeToken were present.
  // Use fake-default for simplicity — no resumeManagedSession path.
  const ws = await makeWorkspace("resume-no-capable");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "no resume reuse",
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
    const firstId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await rpc(svc, "task.wait", {
      workspaceId,
      taskPath,
      reason: "external",
      summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
    });
    // Force dead non-resume probe shape on the bound session.
    await svc.runtime.registry.update(firstId, {
      state: "stopped",
      pid: undefined,
      resumeToken: undefined,
    });

    const started2 = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started2.error, JSON.stringify(started2.error));
    const secondId = (started2.result as { session: { sessionId: string } }).session
      .sessionId;
    assert.notEqual(secondId, firstId);
  });
});

test("task.startSession ignores a stale sessionId whose machine registry row is gone", async () => {
  const ws = await makeWorkspace("resume-missing-registry");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "stale session binding",
    });
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const missingSessionId = "ss-missing01";
    const mount = svc.ctx.host.require(workspaceId);
    await svc.ctx.mutations.run(workspaceId, async () => {
      svc.ctx.host.markSelfWrite(workspaceId);
      await patchTaskEnvelope(mount.env.fs, taskPath, {
        sessionId: missingSessionId,
        updatedAt: mount.env.clock.now(),
      });
    });
    await rpc(svc, "task.wait", {
      workspaceId,
      taskPath,
      reason: "external",
      summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
    });

    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;
    assert.notEqual(sessionId, missingSessionId);
  });
});

test("task.startSession does not resume a provider session bound to another workspace", async () => {
  const ws = await makeWorkspace("resume-workspace-boundary");
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-resume-boundary-")),
    "mock-acp-log.json"
  );
  const profile = mockAcpProfile("mock-acp-boundary", {
    logPath,
    promptText: "NEW_SESSION_OK",
    keepAlive: true,
  });
  profile.env = { ...profile.env, MOCK_ACP_LOAD_SESSION: "1" };

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const dispatched = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "workspace-bound resume",
      });
      const taskPath = (dispatched.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const loaded = await rpc(svc, "task.get", { workspaceId, taskPath });
      const task = (loaded.result as { task: { id?: string; worktree?: string } }).task;
      const cwd = task.worktree || ws;
      const priorSessionId = "ss-otherws01";
      const now = new Date().toISOString();
      await svc.runtime.registry.write({
        id: priorSessionId,
        profileId: "mock-acp-boundary",
        adapterId: GROK_ACP_ADAPTER_ID,
        roleName: "executor",
        state: "stopped",
        resumeToken: "mock-acp-session-1",
        runtimeWorkspace: { cwd },
        workspace: "different-workspace-id",
        lastTaskId: task.id || taskPath,
        createdAt: now,
        updatedAt: now,
      });
      const mount = svc.ctx.host.require(workspaceId);
      await svc.ctx.mutations.run(workspaceId, async () => {
        svc.ctx.host.markSelfWrite(workspaceId);
        await patchTaskEnvelope(mount.env.fs, taskPath, {
          sessionId: priorSessionId,
          updatedAt: mount.env.clock.now(),
        });
      });
      await rpc(svc, "task.wait", {
        workspaceId,
        taskPath,
        reason: "external",
        summary: SESSION_UNAVAILABLE_WAIT_SUMMARY,
      });

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-acp-boundary",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const newSessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;
      assert.notEqual(newSessionId, priorSessionId);
      const log = await pollUntil(async () => {
        try {
          return JSON.parse(await fs.readFile(logPath, "utf8")) as {
            methods: string[];
          };
        } catch {
          return null;
        }
      }, 8_000, "new ACP session log");
      assert.ok(log.methods.includes("session/new"));
      assert.ok(!log.methods.includes("session/load"));
    },
    { profiles: [profile] }
  );
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

// ---- runtime projection reliability (per-session queue + one retry) ----

test("runtime projection: same-session waiting_user → live preserves order under delay", async () => {
  await withService(async (svc) => {
    const sessionId = "ss-projord1";
    const now = new Date().toISOString();
    await svc.runtime.registry.write({
      id: sessionId,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      state: "live",
      createdAt: now,
      updatedAt: now,
    });

    const sessionStateOrder: string[] = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "session.state") {
        sessionStateOrder.push(
          String((ev.payload as { runtimeEvent?: string }).runtimeEvent ?? "")
        );
      }
    });

    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    setRuntimeProjectionTestHooksForTests({
      beforeProject: async (ev, attempt) => {
        if (ev.type === "session.waiting_user" && attempt === 1) {
          await waitGate;
        }
      },
      retryDelayMs: 5,
    });

    try {
      const pWait = mapRuntimeEventToService(svc.ctx, {
        type: "session.waiting_user",
        sessionId,
        summary: "need tool approval",
      });
      // Ensure waiting_user holds the per-session queue before live is enqueued.
      await new Promise((r) => setTimeout(r, 30));
      const pLive = mapRuntimeEventToService(svc.ctx, {
        type: "session.live",
        sessionId,
        pid: 4242,
      });
      await new Promise((r) => setTimeout(r, 20));
      releaseWait();
      await Promise.all([pWait, pLive]);

      const rec = await svc.runtime.registry.read(sessionId);
      assert.equal(rec?.state, "live", "final session state must be live after ordered projection");
      assert.deepEqual(sessionStateOrder, ["session.waiting_user", "session.live"]);
    } finally {
      unsub();
      resetRuntimeProjectionForTests();
    }
  });
});

test("runtime projection: transient failure retries once and emits one session.state", async () => {
  await withService(async (svc) => {
    const sessionId = "ss-projretry1";
    const now = new Date().toISOString();
    await svc.runtime.registry.write({
      id: sessionId,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      state: "live",
      createdAt: now,
      updatedAt: now,
    });

    const sessionStates: Array<Record<string, unknown>> = [];
    const health: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "session.state") {
        sessionStates.push(ev.payload as Record<string, unknown>);
      }
      if (ev.type === "service.health") {
        health.push(ev.payload as Record<string, unknown>);
      }
    });

    const attempts: number[] = [];
    setRuntimeProjectionTestHooksForTests({
      failAttemptsRemaining: 1,
      retryDelayMs: 5,
      beforeProject: (_ev, attempt) => {
        attempts.push(attempt);
      },
    });

    try {
      await mapRuntimeEventToService(svc.ctx, {
        type: "session.waiting_user",
        sessionId,
        summary: "transient",
      });

      assert.deepEqual(attempts, [1, 2], "exactly one retry after first failure");
      assert.equal(sessionStates.length, 1, "one normal session.state after successful retry");
      assert.equal(sessionStates[0].runtimeEvent, "session.waiting_user");
      assert.equal(sessionStates[0].sessionId, sessionId);
      assert.ok(
        !health.some((h) => h.action === "runtime-projection-failed"),
        "successful retry must not emit projection-failed health"
      );

      const rec = await svc.runtime.registry.read(sessionId);
      assert.equal(rec?.state, "waiting-user");
    } finally {
      unsub();
      resetRuntimeProjectionForTests();
    }
  });
});

test("runtime projection: permanent failure emits diagnostic, no unhandled rejection, queue continues", async () => {
  await withService(async (svc) => {
    const sessionId = "ss-projperm1";
    const now = new Date().toISOString();
    await svc.runtime.registry.write({
      id: sessionId,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      state: "live",
      createdAt: now,
      updatedAt: now,
    });

    const sessionStates: Array<Record<string, unknown>> = [];
    const health: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "session.state") {
        sessionStates.push(ev.payload as Record<string, unknown>);
      }
      if (ev.type === "service.health") {
        health.push(ev.payload as Record<string, unknown>);
      }
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    setRuntimeProjectionTestHooksForTests({
      // Both attempt 1 and the single retry fail.
      failAttemptsRemaining: 2,
      retryDelayMs: 5,
    });

    try {
      // Must resolve (not reject) after exhaustion so callers/void do not get unhandled rejections.
      await mapRuntimeEventToService(svc.ctx, {
        type: "session.waiting_user",
        sessionId,
        summary: "permanent inject",
      });
      // Allow any stray rejection microtasks to surface.
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(unhandled.length, 0, "projection failure must not produce unhandledRejection");
      assert.equal(sessionStates.length, 0, "failed projection must not emit session.state");

      const failed = health.filter((h) => h.action === "runtime-projection-failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].sessionId, sessionId);
      assert.equal(failed[0].runtimeEvent, "session.waiting_user");
      assert.equal(failed[0].errorClass, "ProjectionInjectedError");
      assert.equal(failed[0].errorCode, "PROJECTION_INJECTED");
      assert.ok(!("error" in failed[0] && typeof failed[0].error === "object"));

      // Queue must not be poisoned: next event for same session still projects.
      resetRuntimeProjectionForTests();
      await mapRuntimeEventToService(svc.ctx, {
        type: "session.live",
        sessionId,
        pid: 99,
      });
      assert.equal(sessionStates.length, 1);
      assert.equal(sessionStates[0].runtimeEvent, "session.live");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      unsub();
      resetRuntimeProjectionForTests();
    }
  });
});

test("runtime projection: different sessions are not process-wide serialized", async () => {
  await withService(async (svc) => {
    const now = new Date().toISOString();
    for (const id of ["ss-proj-a", "ss-proj-b"] as const) {
      await svc.runtime.registry.write({
        id,
        profileId: "fake-default",
        adapterId: FAKE_ADAPTER_ID,
        state: "starting",
        createdAt: now,
        updatedAt: now,
      });
    }

    const finishOrder: string[] = [];
    setRuntimeProjectionTestHooksForTests({
      beforeProject: async (ev) => {
        // A is slow; B is fast. Independent queues → B completes first.
        if (ev.sessionId === "ss-proj-a") {
          await new Promise((r) => setTimeout(r, 120));
        } else if (ev.sessionId === "ss-proj-b") {
          await new Promise((r) => setTimeout(r, 10));
        }
        finishOrder.push(ev.sessionId);
      },
      retryDelayMs: 5,
    });

    try {
      const pa = mapRuntimeEventToService(svc.ctx, {
        type: "session.live",
        sessionId: "ss-proj-a",
        pid: 1,
      });
      const pb = mapRuntimeEventToService(svc.ctx, {
        type: "session.live",
        sessionId: "ss-proj-b",
        pid: 2,
      });
      await Promise.all([pa, pb]);

      assert.deepEqual(
        finishOrder,
        ["ss-proj-b", "ss-proj-a"],
        "faster session must not wait on a process-wide single queue"
      );
    } finally {
      resetRuntimeProjectionForTests();
    }
  });
});

test("service stop waits for terminal runtime projections before disposing", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-stop-drain-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
  });
  const sessionId = "ss-stopdrain1";
  let releaseProjection!: () => void;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  let enteredProjection!: () => void;
  const projectionEntered = new Promise<void>((resolve) => {
    enteredProjection = resolve;
  });

  try {
    await svc.runtime.startSession({
      sessionId,
      profileId: "fake-default",
      roleName: "executor",
      runtimeWorkspace: { cwd: dataDir },
    });

    setRuntimeProjectionTestHooksForTests({
      beforeProject: async (event, attempt) => {
        if (event.sessionId === sessionId && event.type === "session.exited" && attempt === 1) {
          enteredProjection();
          await projectionGate;
        }
      },
      retryDelayMs: 5,
    });

    let firstStopResolved = false;
    let secondStopResolved = false;
    const stopping = svc.stop().then(() => {
      firstStopResolved = true;
    });
    const concurrentStop = svc.stop().then(() => {
      secondStopResolved = true;
    });

    await projectionEntered;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      firstStopResolved || secondStopResolved,
      false,
      "concurrent service.stop calls must share pending shutdown completion"
    );

    releaseProjection();
    await Promise.all([stopping, concurrentStop]);
    assert.equal(firstStopResolved, true);
    assert.equal(secondStopResolved, true);

    const record = await svc.runtime.registry.read(sessionId);
    assert.ok(record?.state === "stopped" || record?.state === "failed");
  } finally {
    releaseProjection?.();
    resetRuntimeProjectionForTests();
    await svc.stop();
  }
});
