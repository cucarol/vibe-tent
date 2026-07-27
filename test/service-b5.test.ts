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
  enableManagedTaskInputBackgroundAccept,
  invokeDeliverManagedTaskInputForTests,
  invokeManagedAutoDeliverForTests,
  mapRuntimeEventToService,
  migrateSessionWorkspaceIdsOnMount,
  reconcileTaskSessionsOnMount,
  REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY,
  isTaskStartSessionInFlightForTests,
  resetManagedAutoDeliverDedupForTests,
  resetManagedTaskInputBackgroundForTests,
  resetRuntimeProjectionForTests,
  setRejectResumePostStartFailureForTests,
  setRuntimeProjectionTestHooksForTests,
  SESSION_UNAVAILABLE_WAIT_CODE,
  SESSION_UNAVAILABLE_WAIT_SUMMARY,
  stopManagedTaskInputBackgroundAccept,
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
    /** Advertise agentCapabilities.loadSession (native resume). */
    loadSession?: boolean;
    /** Reject session/load (native resume fails; reject-resume may honest-fallback). */
    failLoad?: boolean;
    /** Text returned for ## Review Feedback / ## User Input follow-ups. */
    followupText?: string;
    /** Delay bootstrap session/prompt completion so turnBusy stays true. */
    promptDelayMs?: number;
    /** Spontaneous child death after session/new (no pending prompt required). */
    dieAfterSessionMs?: number;
    dieExitCode?: number;
    /**
     * After session/prompt result is written, schedule a late worktree write.
     * Seal-before-deliver must kill the process so this marker never appears
     * once the task is delivered (no sleep-based "stability").
     */
    postResponseTailMs?: number;
    postResponseTailPath?: string;
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
      ...(opts.loadSession ? { MOCK_ACP_LOAD_SESSION: "1" } : {}),
      ...(opts.failLoad ? { MOCK_ACP_FAIL_LOAD: "1" } : {}),
      ...(opts.followupText
        ? { MOCK_ACP_FOLLOWUP_TEXT: opts.followupText }
        : {}),
      ...(opts.promptDelayMs != null
        ? { MOCK_ACP_PROMPT_DELAY_MS: String(opts.promptDelayMs) }
        : {}),
      ...(opts.dieAfterSessionMs != null
        ? {
            MOCK_ACP_DIE_AFTER_SESSION_MS: String(opts.dieAfterSessionMs),
            MOCK_ACP_DIE_EXIT_CODE: String(opts.dieExitCode ?? 1),
            // Hang on prompt if it arrives before death — spontaneous path still fires.
            MOCK_ACP_PROMPT_MODE: "interrupt",
          }
        : {}),
      ...(opts.postResponseTailMs != null && opts.postResponseTailPath
        ? {
            MOCK_ACP_POST_RESPONSE_TAIL_MS: String(opts.postResponseTailMs),
            MOCK_ACP_POST_RESPONSE_TAIL_PATH: opts.postResponseTailPath,
          }
        : {}),
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: opts.permissionPolicy ?? "deny",
      // Busy-turn tests need the bootstrap prompt to outlive manual deliver probes.
      promptTimeoutMs: Math.max(8_000, (opts.promptDelayMs ?? 0) + 4_000),
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
          {
            name: "reviewer",
            prompt: "review work",
            ...(rolePolicies?.reviewer ? { a2aPolicy: rolePolicies.reviewer } : {}),
            ...(rolePolicies?.reviewer === "allow"
              ? {
                  allowedProfiles:
                    roleProfiles?.reviewer ?? ["fake-default"],
                }
              : roleProfiles?.reviewer
                ? { allowedProfiles: roleProfiles.reviewer }
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

/** Task-oracle collaboration view — not Node frontmatter owner/status. */
type BoxCollabProjection = {
  workspaceId: string;
  boxId: string;
  status: "todo" | "doing" | "done";
  assignee?: string;
  activeTaskId?: string;
};

async function boxCollabProjection(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  boxId: string
): Promise<BoxCollabProjection> {
  const res = await rpc(svc, "box.projection", { workspaceId, id: boxId });
  assert.ok(!res.error, JSON.stringify(res.error));
  return res.result as BoxCollabProjection;
}

/** Occupation released: no active task; accepted history may still project done. */
function assertOccupationReleased(
  proj: BoxCollabProjection,
  label = "occupation",
  expectedStatus: "todo" | "done" = "todo"
): void {
  assert.equal(proj.status, expectedStatus, `${label}: expected ${expectedStatus}`);
  assert.equal(proj.assignee, undefined, `${label}: assignee must be clear`);
  assert.equal(proj.activeTaskId, undefined, `${label}: activeTaskId must be clear`);
}

/** Occupation held by an active task (doing + assignee + activeTaskId). */
function assertOccupationHeld(
  proj: BoxCollabProjection,
  opts?: { assignee?: string; label?: string }
): void {
  const label = opts?.label ?? "occupation";
  assert.equal(proj.status, "doing", `${label}: expected doing`);
  if (opts?.assignee !== undefined) {
    assert.equal(proj.assignee, opts.assignee, `${label}: assignee`);
  } else {
    assert.ok(proj.assignee, `${label}: assignee must remain`);
  }
  assert.ok(proj.activeTaskId, `${label}: activeTaskId must remain`);
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
      deliveryPolicy: "review",
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

    // After accept: Task/Delivery are authoritative; occupation is released.
    // box.projection derives historical done from the accepted Task, not Node FM.
    const finalTask = (await client.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(finalTask.task.state, "accepted");
    assertOccupationReleased(
      (await client.boxProjection(workspaceId, { id: boxId })) as BoxCollabProjection,
      "manual accept",
      "done"
    );

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
        deliveryPolicy: "review",
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

test("P0: Delivery only after turn seal — post-response tail write cannot land after delivered", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("seal-before-deliver");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-seal-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const tailMarker = path.join(ws, "POST_RESPONSE_TAIL_MARKER.txt");
  const reportText = "SEAL_BEFORE_DELIVER_REPORT";

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "prove post-response worktree mutation cannot race Delivery",
        deliveryPolicy: "review",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-seal",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      // Wait for Delivery via real prompt_complete projection (no sleep forge).
      const delivered = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string } }).task;
        return task.state === "delivered" ? task : null;
      }, 20_000, "task delivered after sealed turn");

      assert.equal(delivered.state, "delivered");

      // At the moment Delivery is published, the managed process must already
      // be sealed (not alive). Poll only observes authority state — no sleep.
      const probe = await rpc(svc, "session.get", {
        workspaceId,
        sessionId,
      });
      assert.ok(!probe.error, JSON.stringify(probe.error));
      const session = (
        probe.result as {
          session: { alive?: boolean; state?: string; turnBusy?: boolean };
        }
      ).session;
      assert.equal(
        session.alive,
        false,
        "session must not stay process-alive after Delivery (sealed)"
      );
      assert.notEqual(session.turnBusy, true, "turn must be idle after Delivery");

      // Marker path: if seal failed, mock would write this after prompt result.
      // Absence is the real proof — not a fixed delay.
      let markerExists = false;
      try {
        await fs.access(tailMarker);
        markerExists = true;
      } catch {
        markerExists = false;
      }
      assert.equal(
        markerExists,
        false,
        "post-response tail write must not land after/during Delivery seal"
      );

      const list = await rpc(svc, "delivery.list", { workspaceId });
      const deliveries = (
        list.result as { deliveries: Array<{ summary: string; status: string }> }
      ).deliveries;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].summary, reportText);
      assert.equal(deliveries[0].status, "ready");
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-seal", {
          logPath,
          promptText: reportText,
          keepAlive: true,
          // Tail is long enough that without seal-before-deliver it would
          // clearly write after prompt_complete. Seal kills the process first.
          postResponseTailMs: 2_500,
          postResponseTailPath: tailMarker,
        }),
      ],
    }
  );
});

test("P0: public task.deliver/requestReview refuse while managed turnBusy; idle still allows", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("manual-deliver-turn-busy");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-busy-deliver-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const tailMarker = path.join(ws, "BUSY_TURN_TAIL_MARKER.txt");
  // Long enough that manual deliver probes run while bootstrap turn is open;
  // process stays alive (keepAlive) so turnBusy is the authority signal.
  const promptDelayMs = 4_000;
  const reportText = "BUSY_TURN_AUTO_REPORT";

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "manual deliver must not publish during busy managed turn",
        deliveryPolicy: "review",
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "mock-acp-busy-deliver",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } })
        .session.sessionId;

      // Wait until the managed turn is actually busy (not merely session live).
      await pollUntil(async () => {
        const probe = await rpc(svc, "session.get", { workspaceId, sessionId });
        if (probe.error) return null;
        const session = (
          probe.result as {
            session: { alive?: boolean; turnBusy?: boolean };
          }
        ).session;
        return session.alive && session.turnBusy === true ? session : null;
      }, 8_000, "managed turnBusy during bootstrap");

      // Accident path: agent calls public deliver while the same turn is still open.
      const manualDeliver = await rpc(svc, "task.deliver", {
        workspaceId,
        taskPath,
        summary: "PREMATURE_MANUAL_DELIVER",
      });
      assert.ok(manualDeliver.error, "busy turn must fail-loud on task.deliver");
      assert.match(
        String(manualDeliver.error.message ?? ""),
        /turnBusy|in-flight turn/i
      );
      const deliverData = manualDeliver.error.data as
        | { code?: string; turnBusy?: boolean }
        | undefined;
      assert.equal(deliverData?.code, "TURN_BUSY");
      assert.equal(deliverData?.turnBusy, true);

      // Same gate for requestReview (agent-decide / explicit review queue path).
      const manualReview = await rpc(svc, "task.requestReview", {
        workspaceId,
        taskPath,
        summary: "PREMATURE_REQUEST_REVIEW",
      });
      assert.ok(manualReview.error, "busy turn must fail-loud on task.requestReview");
      assert.match(
        String(manualReview.error.message ?? ""),
        /turnBusy|in-flight turn/i
      );
      const reviewData = manualReview.error.data as { code?: string } | undefined;
      assert.equal(reviewData?.code, "TURN_BUSY");

      // Authority: still running, no ready Delivery while turn is open / settling.
      const mid = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.ok(!mid.error, JSON.stringify(mid.error));
      assert.equal(
        (mid.result as { task: { state: string } }).task.state,
        "running",
        "task must remain running after refused public deliver"
      );
      const midList = await rpc(svc, "delivery.list", { workspaceId });
      const midDeliveries = (
        midList.result as { deliveries: Array<{ status: string; summary: string }> }
      ).deliveries;
      assert.equal(
        midDeliveries.filter((x) => x.status === "ready").length,
        0,
        "no ready Delivery before turn settles"
      );
      assert.equal(
        midDeliveries.some((x) =>
          /PREMATURE_MANUAL_DELIVER|PREMATURE_REQUEST_REVIEW/.test(x.summary)
        ),
        false,
        "premature manual summaries must not appear as Delivery"
      );

      // Tail write is scheduled only after mock prompt result; while we refused
      // early it must not exist yet. Seal-before-auto-deliver later kills the
      // process so the marker also must not appear after Delivery.
      let markerDuringBusy = false;
      try {
        await fs.access(tailMarker);
        markerDuringBusy = true;
      } catch {
        markerDuringBusy = false;
      }
      assert.equal(
        markerDuringBusy,
        false,
        "tail mutation must not land while public deliver is refused"
      );

      // Auto path still seals then delivers after the turn completes.
      const delivered = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (g.result as { task: { state: string } }).task;
        return task.state === "delivered" ? task : null;
      }, 20_000, "auto-deliver after busy turn settles");
      assert.equal(delivered.state, "delivered");

      const afterProbe = await rpc(svc, "session.get", {
        workspaceId,
        sessionId,
      });
      assert.ok(!afterProbe.error, JSON.stringify(afterProbe.error));
      const afterSession = (
        afterProbe.result as {
          session: { alive?: boolean; turnBusy?: boolean };
        }
      ).session;
      assert.equal(afterSession.alive, false, "auto seal stops process");
      assert.notEqual(afterSession.turnBusy, true, "turn idle after Delivery");

      let markerAfter = false;
      try {
        await fs.access(tailMarker);
        markerAfter = true;
      } catch {
        markerAfter = false;
      }
      assert.equal(
        markerAfter,
        false,
        "post-response tail must not land after sealed auto-Delivery"
      );

      const list = await rpc(svc, "delivery.list", { workspaceId });
      const deliveries = (
        list.result as { deliveries: Array<{ summary: string; status: string }> }
      ).deliveries;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].status, "ready");
      assert.equal(deliveries[0].summary, reportText);
    },
    {
      profiles: [
        mockAcpProfile("mock-acp-busy-deliver", {
          logPath,
          promptText: reportText,
          keepAlive: true,
          promptDelayMs,
          postResponseTailMs: 2_500,
          postResponseTailPath: tailMarker,
        }),
      ],
    }
  );

  // Idle managed session + still-running task: public manual deliver allowed.
  // Fake adapter has no turnBusy depth; covers external/idle path without
  // racing auto seal (no managed ACP prompt_complete).
  const wsIdle = await makeWorkspace("manual-deliver-idle");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, wsIdle);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "idle manual deliver still ok",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } })
      .session.sessionId;

    const probe = await rpc(svc, "session.get", { workspaceId, sessionId });
    assert.ok(!probe.error, JSON.stringify(probe.error));
    const session = (
      probe.result as { session: { turnBusy?: boolean } }
    ).session;
    assert.notEqual(session.turnBusy, true, "fake/idle session is not turnBusy");

    const running = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (running.result as { task: { state: string } }).task.state,
      "running"
    );

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "IDLE_MANUAL_DELIVER_OK",
    });
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { state: string }).state, "delivered");

    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ summary: string; status: string }> }
    ).deliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].summary, "IDLE_MANUAL_DELIVER_OK");
    assert.equal(deliveries[0].status, "ready");
  });
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

        const parked = await pollUntil(async () => {
          const g = await rpc(svc, "task.get", { workspaceId, taskPath });
          const task = (
            g.result as {
              task: { state: string; wait?: { reason: string; summary: string } | null };
            }
          ).task;
          return task.state === "waiting" && task.wait?.reason === "external"
            ? task
            : null;
        }, 12_000, `task parked for mode=${mode}`);
        assert.equal(parked.state, "waiting");
        assert.equal(parked.wait?.reason, "external");
        assert.equal(parked.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);

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
    "provider.catalog",
    "box.projection",
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

test("B5 failure cleanup: prompt error stops process, parks waiting(external), keeps occupation", async () => {
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

      const parked = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (
          g.result as {
            task: {
              state: string;
              wait?: { reason: string; summary: string } | null;
              sessionId?: string;
            };
          }
        ).task;
        return task.state === "waiting" && task.wait?.reason === "external" ? task : null;
      }, 12_000, "task parked after prompt error");
      assert.equal(parked.state, "waiting");
      assert.equal(parked.wait?.reason, "external");
      assert.equal(parked.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
      assert.equal(parked.sessionId, sessionId);

      // No live managed session / orphan process; Session may be terminal diagnostic.
      const probe = await svc.runtime.probe(sessionId);
      assert.equal(probe.alive, false);
      assert.ok(probe.state === "failed" || probe.state === "stopped");

      // Occupation held for explicit task.startSession recovery.
      assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
        label: "prompt-error park",
      });

      // Same box cannot re-dispatch while occupation held.
      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "must not steal parked occupation",
      });
      assert.ok(d2.error, "re-dispatch while parked must fail");

      // Duplicate session.failed must not throw / illegal transition / demote park.
      mapRuntimeEventToService(svc.ctx, {
        type: "session.failed",
        sessionId,
        error: "duplicate failure event",
      });
      await new Promise((r) => setTimeout(r, 150));
      const g2 = await rpc(svc, "task.get", { workspaceId, taskPath });
      const afterDup = (
        g2.result as {
          task: { state: string; wait?: { reason: string; summary: string } | null };
        }
      ).task;
      assert.equal(afterDup.state, "waiting");
      assert.equal(afterDup.wait?.reason, "external");
      assert.equal(afterDup.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
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

for (const exitCode of [7, 0]) test(`B5 spontaneous managed child exit code=${exitCode} parks waiting(external)`, async () => {
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
      // and clean exit without delivery recoverably park the bound task.
      const parked = await pollUntil(async () => {
        const g = await rpc(svc, "task.get", { workspaceId, taskPath });
        const task = (
          g.result as {
            task: {
              state: string;
              wait?: { reason: string; summary: string } | null;
              sessionId?: string;
            };
          }
        ).task;
        return task.state === "waiting" && task.wait?.reason === "external" ? task : null;
      }, 12_000, "task parked after spontaneous child exit");
      assert.equal(parked.state, "waiting");
      assert.equal(parked.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
      assert.equal(parked.sessionId, sessionId);

      const probe = await svc.runtime.probe(sessionId);
      assert.equal(probe.alive, false);
      assert.ok(probe.state === "failed" || probe.state === "stopped");

      assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
        label: `spontaneous exit code=${exitCode}`,
      });

      // Occupation still held — re-dispatch must fail-loud.
      const d2 = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "must not steal parked occupation",
      });
      assert.ok(d2.error, "re-dispatch while parked must fail");
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

    assertOccupationHeld(await boxCollabProjection(svc2, workspaceId, boxId), {
      label: "crash→mount",
    });
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
      deliveryPolicy: "review",
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

    // Bypass success: task terminal accepted + historical done, with no active occupation.
    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "accepted");
    assertOccupationReleased(
      await boxCollabProjection(svc, workspaceId, boxId),
      "bypass accept",
      "done"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const acceptedDeliveries = (
      list.result as { deliveries: Array<{ status: string }> }
    ).deliveries.filter((d) => d.status === "accepted");
    assert.ok(acceptedDeliveries.length >= 1, "bypass path must leave an accepted delivery");
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

/** Blocked integrate harness: MutationBus free during Git; per-Task flight still serializes. */
async function withBlockedIntegrate(
  label: string,
  run: (ctx: {
    svc: Awaited<ReturnType<typeof startLocalTentService>>;
    order: string[];
    waitIntegrate: () => Promise<void>;
    release: () => void;
  }) => Promise<void>
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `tent-b5-${label}-`));
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  let entered = false;
  const order: string[] = [];
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    integrateCommits: async () => {
      entered = true;
      order.push("integrate-enter");
      await hold;
      order.push("integrate-exit");
    },
  });
  const waitIntegrate = async () => {
    const deadline = Date.now() + 15000;
    while (!entered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(entered, true, `${label}: must reach integrate outside MutationBus`);
  };
  try {
    await run({ svc, order, waitIntegrate, release: () => release() });
  } finally {
    release();
    await svc.stop();
  }
}

async function claimDeliveredReviewTask(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  sourceRef: string,
  prompt: string
): Promise<{ workspaceId: string; taskPath: string }> {
  const { workspaceId, boxId } = await mountWorkItem(svc, ws);
  const d = await rpc(svc, "task.dispatch", {
    workspaceId,
    boxId,
    role: "executor",
    prompt,
    deliveryPolicy: "review",
  });
  const taskPath = (d.result as { taskPath: string }).taskPath;
  await rpc(svc, "task.claim", { workspaceId, taskPath });
  const delivered = await rpc(svc, "task.deliver", {
    workspaceId,
    taskPath,
    summary: "ready",
    commits: [sourceRef],
  });
  assert.ok(!delivered.error, JSON.stringify(delivered.error));
  assert.equal((delivered.result as { state: string }).state, "delivered");
  return { workspaceId, taskPath };
}

/** MutationBus must not span Git: unrelated docs complete while accept is mid-integrate. */
test("P0-2: task.accept releases MutationBus during blocked Git integrate", async () => {
  const ws = await makeWorkspace("p0-bus-accept");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "bus.txt", "bus\n", "bus accept");
  await withBlockedIntegrate("bus-accept", async ({ svc, order, waitIntegrate, release }) => {
    const { workspaceId, taskPath } = await claimDeliveredReviewTask(
      svc,
      ws,
      sourceRef,
      "block bus during accept integrate"
    );
    const acceptPromise = rpc(svc, "task.accept", { workspaceId, taskPath, actor: "user" });
    await waitIntegrate();
    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "unrelated-while-integrate",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    order.push("docs-done");
    release();
    const accepted = await acceptPromise;
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    order.push("accept-done");
    assert.deepEqual(order, ["integrate-enter", "docs-done", "integrate-exit", "accept-done"]);
  });
});

/** Commit-bearing auto-integrate deliver also releases MutationBus during Git. */
test("P0-2: bypass deliver releases MutationBus during blocked Git integrate", async () => {
  const ws = await makeWorkspace("p0-bus-bypass");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "bypass-bus.txt", "x\n", "bypass bus");
  await withBlockedIntegrate("bus-bypass", async ({ svc, order, waitIntegrate, release }) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "block bus during bypass integrate",
      deliveryPolicy: "bypass",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const deliverPromise = rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "auto integrate outside bus",
      commits: [sourceRef],
    });
    await waitIntegrate();
    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "unrelated-while-bypass-integrate",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    order.push("docs-done");
    release();
    const delivered = await deliverPromise;
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { autoIntegrated: boolean }).autoIntegrated, true);
    assert.equal((delivered.result as { state: string }).state, "accepted");
    order.push("deliver-done");
    assert.deepEqual(order, ["integrate-enter", "docs-done", "integrate-exit", "deliver-done"]);
  });
});

/**
 * Same-Task reject waits on per-Task flight spanning accept Git, then refuses accepted
 * (no integrated-code / state-not-accepted split). Docs still complete early.
 */
test("P0-2: same-Task reject waits for accept Git then refuses accepted", async () => {
  const ws = await makeWorkspace("p0-life-reject");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "life-reject.txt", "r\n", "life reject");
  await withBlockedIntegrate("life-reject", async ({ svc, order, waitIntegrate, release }) => {
    const { workspaceId, taskPath } = await claimDeliveredReviewTask(
      svc,
      ws,
      sourceRef,
      "same-task reject serializes with accept"
    );
    const acceptPromise = rpc(svc, "task.accept", { workspaceId, taskPath, actor: "user" }).then(
      (res) => {
        order.push("accept-done");
        return res;
      }
    );
    await waitIntegrate();
    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "unrelated-while-same-task-reject-waits",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    order.push("docs-done");
    const rejectPromise = rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      note: "should wait then refuse",
      resume: false,
    }).then((res) => {
      order.push("reject-done");
      return res;
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!order.includes("reject-done"), "reject must not finish during accept Git");
    assert.ok(!order.includes("accept-done"), "accept must not finish while Git is held");
    release();
    const [accepted, rejected] = await Promise.all([acceptPromise, rejectPromise]);
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal((accepted.result as { state: string }).state, "accepted");
    assert.ok(rejected.error, "reject must refuse after accept completed");
    assert.equal(rejected.error?.code, RPC_LIFECYCLE, JSON.stringify(rejected.error));
    assert.match(
      String(rejected.error?.message ?? ""),
      /Invalid task transition|No ready delivery/i,
      JSON.stringify(rejected.error)
    );
    const get = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((get.result as { task: { state: string } }).task.state, "accepted");
    assert.ok(order.indexOf("docs-done") < order.indexOf("integrate-exit"));
    assert.ok(order.indexOf("integrate-exit") < order.indexOf("accept-done"));
    assert.ok(order.indexOf("accept-done") < order.indexOf("reject-done"));
  });
});

/**
 * Same-Task sendInput waits on bypass auto-deliver Git, then refuses accepted
 * (cannot slip a pending TaskInput past auto-deliver).
 */
test("P0-2: same-Task sendInput waits for auto-deliver Git then refuses accepted", async () => {
  const ws = await makeWorkspace("p0-life-sendinput");
  await initGitOnWorkspace(ws);
  const sourceRef = await roleCommit(ws, "executor", "life-send.txt", "s\n", "life send");
  await withBlockedIntegrate("life-send", async ({ svc, order, waitIntegrate, release }) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "same-task sendInput serializes with bypass deliver",
      deliveryPolicy: "bypass",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const deliverPromise = rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "auto integrate with sendInput race",
      commits: [sourceRef],
    }).then((res) => {
      order.push("deliver-done");
      return res;
    });
    await waitIntegrate();
    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "unrelated-while-same-task-sendinput-waits",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    order.push("docs-done");
    const sendPromise = rpc(svc, "task.sendInput", {
      workspaceId,
      taskPath,
      actor: "user",
      text: "must not slip past auto-deliver",
    }).then((res) => {
      order.push("send-done");
      return res;
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!order.includes("send-done"), "sendInput must not finish during auto-deliver Git");
    assert.ok(!order.includes("deliver-done"), "deliver must not finish while Git is held");
    release();
    const [delivered, sent] = await Promise.all([deliverPromise, sendPromise]);
    assert.ok(!delivered.error, JSON.stringify(delivered.error));
    assert.equal((delivered.result as { autoIntegrated: boolean }).autoIntegrated, true);
    assert.equal((delivered.result as { state: string }).state, "accepted");
    assert.ok(sent.error, "sendInput must refuse after auto-deliver accepted");
    assert.equal(sent.error?.code, RPC_LIFECYCLE);
    assert.match(String(sent.error?.message ?? ""), /running or waiting/i);
    const pending = await rpc(svc, "taskInput.listPending", { workspaceId, taskPath });
    assert.ok(!pending.error, JSON.stringify(pending.error));
    const inputs = (pending.result as { inputs?: unknown[] }).inputs ?? [];
    assert.equal(inputs.length, 0, "no pending TaskInput may slip past auto-deliver");
    assert.ok(order.indexOf("docs-done") < order.indexOf("integrate-exit"));
    assert.ok(order.indexOf("integrate-exit") < order.indexOf("deliver-done"));
    assert.ok(order.indexOf("deliver-done") < order.indexOf("send-done"));
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

    // Integrate failed: delivery stays ready, occupation held (task still active).
    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      assignee: "executor",
      label: "accept integrate conflict",
    });
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const ready = (
      list.result as { deliveries: Array<{ status: string }> }
    ).deliveries.filter((d) => d.status === "ready");
    assert.ok(ready.length >= 1, "delivery stays ready for retry after integrate failure");

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

    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      assignee: "executor",
      label: "bypass integrate failure",
    });

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

    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      assignee: "executor",
      label: "managed auto-deliver integrate failure",
    });

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
    // Seal-before-deliver stops the process before publishing Delivery. On
    // integrate failure the task stays running (retryable) but the managed
    // process is already sealed — no post-failure worktree mutation from that turn.
    assert.ok(
      rec!.state === "stopped" || rec!.state === "failed",
      `expected sealed session after integrate failure, got ${rec!.state}`
    );
    const probe = await svc.runtime.probe(sessionId);
    assert.equal(probe.alive, false, "sealed process must not stay alive after failed deliver");

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
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
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
      deliveryPolicy: "review",
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

test("P0: dirty task worktree refuses managed auto-deliver and public task.deliver (tracked + untracked)", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-dirty-worktree-refuse");
  await initGitOnWorkspace(ws);

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "must not deliver with dirty role worktree",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    // One committed change (would be collectable) plus uncommitted tracked + untracked.
    const sourceRef = await roleCommit(
      ws,
      "executor",
      "committed-before-dirty.txt",
      "committed\n",
      "committed before dirty"
    );
    const contract = await ensureRoleWorkspace(ws, "executor");
    await fs.writeFile(
      path.join(contract.worktree, "committed-before-dirty.txt"),
      "tracked dirty edit\n"
    );
    await fs.writeFile(
      path.join(contract.worktree, "UNTRACKED_DIRTY.txt"),
      "untracked dirty\n"
    );
    // Main must stay clean: gate inspects task/role worktree only.
    const mainDirty = (await git(ws, "status", "--porcelain")).trim();
    assert.equal(mainDirty, "", "main workspace must remain clean for this regression");

    const diag: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "session.state") diag.push(ev.payload as Record<string, unknown>);
    });

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "DIRTY_SHOULD_NOT_DELIVER",
    });
    unsub();

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (got.result as { task: { state: string } }).task.state,
      "running",
      "dirty auto-deliver must keep task running (retryable)"
    );
    const list = await rpc(svc, "delivery.list", { workspaceId });
    const deliveries = (
      list.result as { deliveries: Array<{ status: string; summary: string; commits?: string[] }> }
    ).deliveries;
    assert.equal(deliveries.length, 0, "dirty worktree must not publish any Delivery");
    assert.equal(
      deliveries.some((x) => /DIRTY_SHOULD_NOT_DELIVER/.test(x.summary)),
      false
    );

    const failEv = diag.find((p) => p.runtimeEvent === "session.prompt_complete.failed");
    assert.ok(failEv, "must emit session diagnostics for dirty refusal");
    assert.equal(failEv!.taskFailed, false);
    assert.equal(failEv!.errorCode, "WORKTREE_DIRTY");
    assert.match(String(failEv!.error ?? ""), /WORKTREE_DIRTY|uncommitted|dirty/i);

    const rec = await svc.runtime.registry.read(sessionId);
    assert.ok(rec?.lastError);
    assert.match(rec!.lastError!, /managed auto-deliver failed/);
    assert.match(rec!.lastError!, /uncommitted|dirty/i);

    // Public path must refuse the same dirty worktree with stable error code.
    const manual = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "PREMATURE_DIRTY_MANUAL",
      commits: [sourceRef],
    });
    assert.ok(manual.error, "public deliver must fail-loud on dirty worktree");
    assert.match(String(manual.error.message ?? ""), /uncommitted|dirty/i);
    const manualData = manual.error.data as
      | { code?: string; trackedDirty?: boolean; untrackedDirty?: boolean }
      | undefined;
    assert.equal(manualData?.code, "WORKTREE_DIRTY");
    assert.equal(manualData?.trackedDirty, true);
    assert.equal(manualData?.untrackedDirty, true);

    const mid = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((mid.result as { task: { state: string } }).task.state, "running");
    const midList = await rpc(svc, "delivery.list", { workspaceId });
    assert.equal(
      (midList.result as { deliveries: unknown[] }).deliveries.length,
      0,
      "public dirty refuse must not leave a Delivery"
    );

    // Clean worktree: commit remaining edits, then auto-deliver succeeds with full SHA set.
    await git(contract.worktree, "add", "committed-before-dirty.txt", "UNTRACKED_DIRTY.txt");
    await git(contract.worktree, "commit", "-q", "-m", "commit dirty edits");
    const cleanRef = (await git(contract.worktree, "rev-parse", "HEAD")).trim();
    assert.equal((await git(contract.worktree, "status", "--porcelain")).trim(), "");

    resetManagedAutoDeliverDedupForTests();
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "CLEAN_AFTER_COMMIT_OK",
    });

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((after.result as { task: { state: string } }).task.state, "delivered");
    const afterList = await rpc(svc, "delivery.list", { workspaceId });
    const afterDeliveries = (
      afterList.result as {
        deliveries: Array<{ summary: string; status: string; commits: string[] }>;
      }
    ).deliveries;
    assert.equal(afterDeliveries.length, 1);
    assert.equal(afterDeliveries[0].summary, "CLEAN_AFTER_COMMIT_OK");
    assert.equal(afterDeliveries[0].status, "ready");
    assert.ok(afterDeliveries[0].commits.includes(sourceRef));
    assert.ok(afterDeliveries[0].commits.includes(cleanRef));
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
      deliveryPolicy: "review",
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
      deliveryPolicy: "review",
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

test("reject-resume restores live managed session for durable role (no false-running)", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-role-live");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "reject resume must wake session",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "FIRST_DELIVERY",
    });

    const afterDeliver = await loadTaskEnvelope(
      svc.ctx.host.require(workspaceId).env.fs,
      taskPath
    );
    assert.equal(afterDeliver.state, "delivered");
    const probeStopped = await svc.runtime.probe(sessionId);
    assert.equal(probeStopped.alive, false, "managed session stops after deliver");

    const rejected = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      resume: true,
      note: "please fix tests",
    });
    assert.ok(!rejected.error, JSON.stringify(rejected.error));
    const body = rejected.result as {
      state: string;
      task: { state: string; sessionId?: string };
      session?: { sessionId: string; state: string };
    };
    assert.equal(body.state, "running");
    assert.equal(body.task.state, "running");
    assert.ok(body.session?.sessionId, "reject-resume must return a session projection");
    assert.equal(body.task.sessionId, body.session!.sessionId);

    const probeLive = await svc.runtime.probe(body.session!.sessionId);
    assert.equal(probeLive.alive, true, "runtime process must be alive after reject-resume");
    assert.ok(
      probeLive.state === "live" || probeLive.state === "starting" || probeLive.state === "waiting-user",
      `session state must be non-terminal, got ${probeLive.state}`
    );

    // Consume durable review-feedback before rework Delivery (TaskInput gate).
    // fake-default may leave the row pending/failed when follow-up inject is unsupported.
    const pendingFeedback = await svc.ctx.taskInputs.listBlockingForDeliver(
      workspaceId,
      taskPath
    );
    for (const row of pendingFeedback) {
      if (row.status === "pending" || row.status === "failed") {
        await svc.ctx.taskInputs.markDelivered(row.id, "test-consume-review-feedback");
      }
    }

    // Rework can deliver again (dedup cleared for session+task).
    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId: body.session!.sessionId,
      assistantText: "REWORK_DELIVERY",
    });
    const afterRework = await loadTaskEnvelope(
      svc.ctx.host.require(workspaceId).env.fs,
      taskPath
    );
    assert.equal(afterRework.state, "delivered");
  });
});

test("reject-resume restores live managed session for agentProfile tasks", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-profile-live");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      assigneeKind: "agentProfile",
      profileId: "fake-default",
      prompt: "profile reject resume",
      deliveryPolicy: "review",
    });
    assert.ok(!d.error, JSON.stringify(d.error));
    const taskPath = (d.result as { taskPath: string }).taskPath;
    assert.match(taskPath, /^temp\/agent-profiles\/fake-default\/tasks\//);

    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!started.error, JSON.stringify(started.error));
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "PROFILE_FIRST",
    });
    assert.equal(
      (await loadTaskEnvelope(svc.ctx.host.require(workspaceId).env.fs, taskPath)).state,
      "delivered"
    );
    // Stop prior process; fake-default is resumeCapable → same Tent sessionId.
    await svc.runtime.stopSession(sessionId, "user");
    const priorProbe = await svc.runtime.probe(sessionId);
    assert.equal(
      priorProbe.alive,
      false,
      `prior session must be dead before reject-resume (state=${priorProbe.state})`
    );
    assert.equal(priorProbe.resumeCapable, true, JSON.stringify(priorProbe));
    assert.ok(
      priorProbe.state === "stopped" || priorProbe.state === "failed",
      `prior session must be terminal; got state=${priorProbe.state}`
    );
    assert.equal(
      (await loadTaskEnvelope(svc.ctx.host.require(workspaceId).env.fs, taskPath)).state,
      "delivered",
      "explicit stop after deliver must leave task delivered for reject-resume"
    );

    const rejected = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      resume: true,
      note: "profile rework",
    });
    assert.ok(!rejected.error, JSON.stringify(rejected.error));
    const body = rejected.result as {
      state: string;
      task: { state: string; sessionId?: string; assigneeKind?: string };
      session?: { sessionId: string };
      input?: {
        id: string;
        kind?: string;
        status: string;
        sessionId?: string;
        text?: string;
      };
      accepted?: boolean;
      enqueued?: boolean;
      continued?: boolean;
    };
    assert.equal(body.state, "running");
    assert.equal(body.task.assigneeKind, "agentProfile");
    assert.ok(body.session?.sessionId);
    assert.equal(body.task.sessionId, body.session!.sessionId);
    assert.equal((await svc.runtime.probe(body.session!.sessionId)).alive, true);

    // fake-default is resumeCapable → same Tent sessionId (native resume path).
    assert.equal(
      body.session!.sessionId,
      sessionId,
      "reject-resume must reuse prior Tent sessionId when resumeCapable"
    );
    assert.ok(body.input, "reject-resume must return review-feedback TaskInput");
    assert.equal(body.input!.kind, "review-feedback");
    assert.equal(body.input!.text, "profile rework");
    assert.equal(
      body.input!.sessionId,
      sessionId,
      "review-feedback must stay bound to the resumed session"
    );
    // Async accept: RPC does not wait for inject; continued is always false.
    assert.equal(body.accepted, true);
    assert.equal(body.enqueued, true);
    assert.equal(body.continued, false);
    // fake-default may leave pending or record a retryable failed row when
    // follow-up inject is unsupported; either way durable binding stays on the
    // same session and the feedback stays visible.
    assert.ok(
      body.input!.status === "pending" || body.input!.status === "processing",
      `accept status should be pending|processing, got ${body.input!.status}`
    );

    // Background inject settles to a terminal-or-retryable durable status.
    const settled = await pollUntil(async () => {
      const stored = await svc.ctx.taskInputs.get(
        body.input!.id,
        workspaceId,
        taskPath
      );
      if (!stored) return null;
      if (
        stored.status === "delivered" ||
        stored.status === "failed" ||
        stored.status === "uncertain"
      ) {
        return stored;
      }
      return null;
    }, 15_000, "review-feedback background inject settles");
    assert.equal(settled.sessionId, body.session!.sessionId);
    // fake-default may leave failed when follow-up inject is unsupported;
    // durable binding must remain on the resumed session.
    assert.ok(
      settled.status === "delivered" ||
        settled.status === "failed" ||
        settled.status === "uncertain",
      `unexpected review-feedback status: ${settled.status}`
    );
    if (settled.status === "failed") {
      const retryable = await svc.ctx.taskInputs.listPending(workspaceId, taskPath);
      assert.ok(
        retryable.some((row) => row.id === settled.id),
        "failed review-feedback must remain visible for retry/poll"
      );
    }
  });
});

test("reject-resume native load reuses same sessionId + provider token (mock ACP)", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-native-same-ss", {
    executor: "allow",
  }, { executor: ["mock-reject-resume"] });
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-rr-native-")),
    "mock-acp.json"
  );
  const profile = mockAcpProfile("mock-reject-resume", {
    logPath,
    promptText: "NATIVE_REJECT_FIRST",
    keepAlive: true,
    loadSession: true,
  });

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "native reject-resume continuity",
        deliveryPolicy: "review",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-reject-resume",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: "NATIVE_REJECT_FIRST",
      });
      assert.equal(
        (await loadTaskEnvelope(svc.ctx.host.require(workspaceId).env.fs, taskPath)).state,
        "delivered"
      );

      const beforeStop = await svc.runtime.registry.read(sessionId);
      const providerToken = beforeStop?.resumeToken;
      assert.ok(providerToken, "managed ACP must persist provider resume token");

      await svc.runtime.stopSession(sessionId, "user");
      const priorProbe = await svc.runtime.probe(sessionId);
      assert.equal(priorProbe.alive, false);
      assert.equal(priorProbe.resumeCapable, true, JSON.stringify(priorProbe));

      const rejected = await rpc(svc, "task.reject", {
        workspaceId,
        taskPath,
        actor: "user",
        resume: true,
        note: "  keep provider context  ",
      });
      assert.ok(!rejected.error, JSON.stringify(rejected.error));
      const body = rejected.result as {
        state: string;
        task: { sessionId?: string; state: string };
        session?: {
          sessionId: string;
          contextRestored?: boolean;
          restoreReason?: string;
        };
        input?: {
          id: string;
          kind?: string;
          status: string;
          sessionId?: string;
          text?: string;
        };
        continued?: boolean;
        continueError?: string;
      };
      assert.equal(body.state, "running");
      assert.equal(body.session?.sessionId, sessionId, "must keep same Tent sessionId");
      assert.equal(body.session?.contextRestored, true, "native path claims continuity");
      assert.equal(body.session?.restoreReason, "task.reject.resume.native");
      assert.equal(body.task.sessionId, sessionId);
      assert.equal((await svc.runtime.probe(sessionId)).alive, true);

      const afterResume = await svc.runtime.registry.read(sessionId);
      assert.equal(
        afterResume?.resumeToken,
        providerToken,
        "provider resume token must continue (no new provider session)"
      );
      assert.equal(afterResume?.contextRestored, true);

      assert.ok(body.input, "must retain review-feedback TaskInput");
      assert.equal(body.input!.kind, "review-feedback");
      assert.equal(body.input!.text, "  keep provider context  ");
      assert.equal(body.input!.sessionId, sessionId);
      assert.equal(body.continued, false);
      assert.ok(
        body.input!.status === "pending" || body.input!.status === "processing",
        `got ${body.input!.status}`
      );

      const delivered = await pollUntil(async () => {
        const stored = await svc.ctx.taskInputs.get(
          body.input!.id,
          workspaceId,
          taskPath
        );
        if (stored?.status === "delivered") return stored;
        if (stored?.status === "failed") {
          throw new Error(`review feedback inject failed: ${stored.lastError ?? "unknown"}`);
        }
        return null;
      }, 20_000, "native reject-resume review feedback delivered");
      assert.equal(delivered.sessionId, sessionId);

      // Resume spawns a new bridge process that rewrites MOCK_ACP_LOG — assert
      // this process used session/load (not session/new) and injected review once.
      const logRaw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(logRaw) as {
        loads?: unknown[];
        news?: unknown[];
        prompts?: string[];
      };
      assert.ok(
        Array.isArray(log.loads) && log.loads.length >= 1,
        "native resume must call session/load"
      );
      assert.equal(
        Array.isArray(log.news) ? log.news.length : 0,
        0,
        "resumed bridge must not call session/new (would allocate new provider session)"
      );
      const reviewPrompts = (log.prompts ?? []).filter((p) =>
        p.includes("## Review Feedback")
      );
      assert.equal(
        reviewPrompts.length,
        1,
        `review feedback must inject exactly once; got ${reviewPrompts.length}`
      );
      assert.ok(reviewPrompts[0]!.includes("text:   keep provider context  "));
    },
    { profiles: [profile] }
  );
});

test("reject-resume native load failure falls back to new session (contextRestored=false) + redelivery", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-native-fail", {
    executor: "allow",
  }, { executor: ["mock-reject-fail-load"] });
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-rr-fail-")),
    "mock-acp.json"
  );
  const profile = mockAcpProfile("mock-reject-fail-load", {
    logPath,
    promptText: "FIRST_DELIVERY_BEFORE_NATIVE_FAIL",
    followupText: "REWORK_AFTER_NATIVE_FAIL_FALLBACK",
    keepAlive: true,
    loadSession: true,
    failLoad: true,
  });

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "native load fail then honest fallback",
        deliveryPolicy: "review",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-reject-fail-load",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const priorSessionId = (started.result as { session: { sessionId: string } })
        .session.sessionId;

      // deliver → provider dies (explicit stop) → reject(resume)
      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        assistantText: "FIRST_DELIVERY_BEFORE_NATIVE_FAIL",
      });
      await svc.runtime.stopSession(priorSessionId, "user");
      assert.equal((await svc.runtime.probe(priorSessionId)).resumeCapable, true);

      const beforeIds = new Set(
        (await svc.runtime.registry.list()).map((r) => r.id)
      );

      const exactNote = "  fix after native fail fallback  ";
      const rejected = await rpc(svc, "task.reject", {
        workspaceId,
        taskPath,
        actor: "user",
        resume: true,
        note: exactNote,
      });
      assert.ok(!rejected.error, JSON.stringify(rejected.error));
      const body = rejected.result as {
        state: string;
        session?: {
          sessionId: string;
          contextRestored?: boolean;
          restoreReason?: string;
        };
        input?: { id: string; sessionId?: string; text?: string; kind?: string };
        accepted?: boolean;
        enqueued?: boolean;
      };
      assert.equal(body.state, "running", "honest fallback must keep rework running");
      assert.ok(body.session?.sessionId);
      assert.notEqual(
        body.session!.sessionId,
        priorSessionId,
        "native fail must allocate independent new ss-"
      );
      assert.equal(
        body.session!.contextRestored,
        false,
        "must never claim cache continuity after native fail"
      );
      assert.equal(
        body.session!.restoreReason,
        "task.reject.resume.native-fallback"
      );
      assert.equal(body.accepted, true);
      assert.equal(body.enqueued, true);
      assert.equal(body.input?.kind, "review-feedback");
      assert.equal(body.input?.text, exactNote);
      assert.equal(body.input?.sessionId, body.session!.sessionId);

      const newSessionId = body.session!.sessionId;
      assert.ok(
        !beforeIds.has(newSessionId) || newSessionId !== priorSessionId,
        "new session id must be trackable"
      );

      // Projection / provenance honesty on registry + session.get
      const row = await svc.runtime.registry.read(newSessionId);
      assert.equal(row?.contextRestored, false);
      const projected = await rpc(svc, "session.get", { sessionId: newSessionId });
      assert.ok(!projected.error, JSON.stringify(projected.error));
      assert.equal(
        (projected.result as { session: { contextRestored?: boolean } }).session
          .contextRestored,
        false
      );

      // Feedback delivered exactly once; rework redelivers.
      const inputDelivered = await pollUntil(async () => {
        const got = await rpc(svc, "taskInput.get", {
          workspaceId,
          taskPath,
          inputId: body.input!.id,
        });
        if (got.error) return null;
        const input = (
          got.result as {
            input: { status: string; lastError?: string };
          }
        ).input;
        if (input.status === "delivered") return input;
        if (input.status === "failed") {
          throw new Error(`review-feedback inject failed: ${input.lastError}`);
        }
        return null;
      }, 20_000, "review-feedback delivered on recovery session");
      assert.equal(inputDelivered.status, "delivered");

      await pollUntil(async () => {
        const t = await rpc(svc, "task.get", { workspaceId, taskPath });
        const state = (t.result as { task: { state: string } }).task.state;
        return state === "delivered" ? t : null;
      }, 20_000, "rework delivery after native-fail fallback");

      // Fallback startSession rewrites MOCK_ACP_LOG (new bridge process), so
      // loads[] from the failed native resume are not durable on disk. Provenance
      // of "native first" is restoreReason + recovery bootstrap restorePath.
      const log = await pollUntil(async () => {
        try {
          return JSON.parse(await fs.readFile(logPath, "utf8")) as {
            news?: unknown[];
            loads?: unknown[];
            prompts?: string[];
          };
        } catch {
          return null;
        }
      }, 5_000, "mock acp log readable after fallback");
      assert.ok(
        Array.isArray(log.news) && log.news.length >= 1,
        "honest fallback must call session/new after native fail"
      );
      const reviewPrompts = (log.prompts ?? []).filter((p) =>
        p.includes("## Review Feedback")
      );
      assert.equal(
        reviewPrompts.length,
        1,
        "feedback inject exactly once (no double channel)"
      );
      const inject = reviewPrompts[0]!;
      // Review note appears exactly once, solely under ## Review Feedback.
      const noteOccurrences = inject.split(exactNote).length - 1;
      assert.equal(
        noteOccurrences,
        1,
        `review note must appear exactly once in inject; got ${noteOccurrences}`
      );
      assert.ok(
        inject.includes(`text: ${exactNote}`),
        "note must live under ## Review Feedback text: field"
      );
      assert.ok(
        !/rejected Delivery:[\s\S]*reviewNote:/i.test(inject),
        "recovery/rejected-delivery blocks must not re-copy review note"
      );
      assert.ok(
        inject.includes("contextRestored: false"),
        "recovery orientation must mark contextRestored=false"
      );
      assert.ok(inject.includes("--- Tent reject-resume recovery ---"));
      assert.ok(
        inject.includes("restorePath: native-resume-failed-fallback"),
        "bootstrap must record that native resume failed before new session"
      );
      assert.ok(inject.includes("rejected Delivery:"));
      assert.ok(inject.includes("FIRST_DELIVERY_BEFORE_NATIVE_FAIL"));
      assert.ok(inject.includes(taskPath) || inject.includes("Task envelope:"));
      assert.ok(
        inject.includes("workspace lane:") || inject.includes("worktree:"),
        "recovery bootstrap must carry workspace lane"
      );
      // Native same-context path must not be claimed on the recovery inject.
      assert.ok(!inject.includes("contextRestored: true"));
    },
    { profiles: [profile] }
  );
});

test("late session.failed on prior after native-fallback keeps rework + review-feedback", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-late-failed", {
    executor: "allow",
  }, { executor: ["mock-rr-late-fail"] });
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-rr-late-")),
    "mock-acp.json"
  );
  const profile = mockAcpProfile("mock-rr-late-fail", {
    logPath,
    promptText: "LATE_FAIL_PRIOR",
    followupText: "REWORK_DESPITE_LATE_PRIOR_FAIL",
    keepAlive: true,
    loadSession: true,
    failLoad: true,
  });

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "late failed on prior must not demote fallback rework",
        deliveryPolicy: "review",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-rr-late-fail",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const priorSessionId = (started.result as { session: { sessionId: string } })
        .session.sessionId;

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        assistantText: "LATE_FAIL_PRIOR",
      });
      await svc.runtime.stopSession(priorSessionId, "user");
      assert.equal((await svc.runtime.probe(priorSessionId)).resumeCapable, true);

      const rejected = await rpc(svc, "task.reject", {
        workspaceId,
        taskPath,
        actor: "user",
        resume: true,
        note: "retain after late session.failed on prior",
      });
      assert.ok(!rejected.error, JSON.stringify(rejected.error));
      const body = rejected.result as {
        state: string;
        session?: { sessionId: string; contextRestored?: boolean };
        input?: { id: string; status?: string };
      };
      assert.equal(body.state, "running");
      assert.ok(body.session?.sessionId);
      assert.notEqual(body.session!.sessionId, priorSessionId);
      assert.equal(body.session!.contextRestored, false);
      const newSessionId = body.session!.sessionId;

      // Late terminal on the *prior* ss- (failed load bridge / Internal error)
      // must not demote the rework occupation bound to the new ss-.
      await svc.runtime.registry.update(priorSessionId, {
        state: "failed",
        lastError: "Internal error",
        pid: undefined,
      });
      await mapRuntimeEventToService(svc.ctx, {
        type: "session.failed",
        sessionId: priorSessionId,
        error: "Internal error",
      });

      const after = await rpc(svc, "task.get", { workspaceId, taskPath });
      const afterTask = (
        after.result as {
          task: {
            state: string;
            sessionId?: string;
            wait?: { reason?: string; summary?: string };
          };
        }
      ).task;
      assert.equal(
        afterTask.state,
        "running",
        "late session.failed on prior must not demote native-fallback rework"
      );
      assert.equal(afterTask.sessionId, newSessionId);

      const reviewGot = await rpc(svc, "taskInput.get", {
        workspaceId,
        taskPath,
        inputId: body.input!.id,
      });
      assert.ok(!reviewGot.error, JSON.stringify(reviewGot.error));
      const review = (
        reviewGot.result as { input: { status: string; sessionId?: string } }
      ).input;
      assert.notEqual(review.status, "cancelled");
      assert.equal(review.sessionId, newSessionId);
    },
    { profiles: [profile] }
  );
});

test("late session.failed after managed Delivery is diagnostic only", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("late-failed-after-deliver", {
    executor: "allow",
  });

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "delivery then late session.failed",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "CLEAN_DELIVERY_REPORT",
    });

    const delivered = await rpc(svc, "task.get", { workspaceId, taskPath });
    const deliveredTask = (
      delivered.result as {
        task: { state: string; activeDeliveryId?: string; sessionId?: string };
      }
    ).task;
    assert.equal(deliveredTask.state, "delivered");
    assert.ok(deliveredTask.activeDeliveryId, "Delivery must remain published");

    // Self-hosting shape: seal stopReason=user, adapter still reports session.failed
    // ("session interrupted…") after Delivery is already on disk. Session may
    // show failed; Task + Delivery authority must not be demoted.
    await svc.runtime.registry.update(sessionId, {
      state: "failed",
      stopReason: "user",
      lastError: "session interrupted: session interrupted before prompt completed",
      pid: undefined,
    });
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId,
      error: "session interrupted: session interrupted before prompt completed",
    });

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    const afterTask = (
      after.result as {
        task: { state: string; activeDeliveryId?: string };
      }
    ).task;
    assert.equal(afterTask.state, "delivered", "must not demote published Delivery");
    assert.equal(afterTask.activeDeliveryId, deliveredTask.activeDeliveryId);

    // listPending emptiness after a clean managed turn is normal consumption
    // (delivered/consumed rows are not listed) — not evidence of task.fail cancel.
    const pending = await svc.ctx.taskInputs.listPending(workspaceId, taskPath);
    assert.equal(pending.length, 0);
  });
});

test("P0 pre-Delivery session.failed parks waiting(external) and preserves TaskInput", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("legit-session-failed");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "recoverable failure path",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    const sent = await rpc(svc, "task.sendInput", {
      workspaceId,
      taskPath,
      text: "must survive recoverable park",
    });
    assert.ok(!sent.error, JSON.stringify(sent.error));
    const inputId = (sent.result as { input: { id: string } }).input.id;

    const ask = await rpc(svc, "task.askUser", {
      workspaceId,
      taskPath,
      question: "must survive recoverable park",
    });
    assert.ok(!ask.error, JSON.stringify(ask.error));
    const askId = (ask.result as { ask: { id: string } }).ask.id;

    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId,
      error: "provider crashed mid-turn",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      got.result as {
        task: {
          state: string;
          wait?: { reason: string; summary: string; code?: string } | null;
          sessionId?: string;
          worktree?: string;
        };
      }
    ).task;
    assert.equal(task.state, "waiting", "pre-delivery session.failed must park, not fail");
    assert.equal(task.wait?.reason, "external");
    assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.equal(
      task.wait?.code,
      SESSION_UNAVAILABLE_WAIT_CODE,
      "durable waitCode must persist on envelope"
    );
    assert.equal(task.sessionId, sessionId);
    // Worktree/lane is optional for non-Git harness workspaces; when present it is kept.
    // Occupation + session binding are the durable park facts.

    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      label: "session.failed park",
    });

    const input = await svc.ctx.taskInputs.get(inputId, workspaceId, taskPath);
    assert.ok(input);
    assert.notEqual(input!.status, "cancelled", "TaskInput must not cancel on park");
    assert.ok(
      input!.status === "pending" ||
        input!.status === "failed" ||
        input!.status === "processing" ||
        input!.status === "delivered" ||
        input!.status === "uncertain",
      `expected open/retryable TaskInput (not cancelled), got ${input!.status}`
    );

    const userAsk = await svc.ctx.userAsks.get(askId);
    assert.ok(userAsk);
    assert.equal(userAsk!.status, "pending", "UserAsk must remain pending on park");

    // Session registry may be terminal diagnostic; Task remains recoverable.
    const probe = await svc.runtime.probe(sessionId);
    assert.equal(probe.alive, false);
  });
});

test("P0 pre-Delivery session.exited parks waiting(external) with stable summary", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("legit-session-exited");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "clean exit before delivery",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await mapRuntimeEventToService(svc.ctx, {
      type: "session.exited",
      sessionId,
      exitCode: 0,
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      got.result as {
        task: { state: string; wait?: { reason: string; summary: string } | null };
      }
    ).task;
    assert.equal(task.state, "waiting");
    assert.equal(task.wait?.reason, "external");
    assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.equal(
      (task.wait as { code?: string } | undefined)?.code,
      SESSION_UNAVAILABLE_WAIT_CODE
    );
    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      label: "session.exited park",
    });
  });
});

test("P0 duplicate session.failed/exited on same session is idempotent park", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("dup-session-terminal");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "duplicate terminals",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId,
      error: "first fail",
    });
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId,
      error: "duplicate fail",
    });
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.exited",
      sessionId,
      exitCode: 1,
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      got.result as {
        task: { state: string; wait?: { reason: string; summary: string } | null };
      }
    ).task;
    assert.equal(task.state, "waiting");
    assert.equal(task.wait?.reason, "external");
    assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);
    assert.notEqual(task.state, "failed");
  });
});

test("P0 late terminal from old session after rebind does not affect new occupation", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("late-old-session-rebind");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "rebind then late old exit",
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
    const oldSessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    // Park old session first, then force a true rebind (new ss-) by clearing
    // resume capability so late events from the old id can be proven inert.
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId: oldSessionId,
      error: "old died",
    });
    const parked = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal(
      (parked.result as { task: { state: string } }).task.state,
      "waiting"
    );
    await svc.runtime.registry.update(oldSessionId, {
      resumeToken: undefined,
      state: "failed",
    });

    const resumed = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!resumed.error, JSON.stringify(resumed.error));
    const newSessionId = (resumed.result as { session: { sessionId: string } }).session
      .sessionId;
    assert.notEqual(
      newSessionId,
      oldSessionId,
      "non-resumeCapable prior must allocate a replacement sessionId"
    );

    const afterBind = await rpc(svc, "task.get", { workspaceId, taskPath });
    const bound = (
      afterBind.result as { task: { state: string; sessionId?: string; wait?: unknown } }
    ).task;
    assert.equal(bound.state, "running");
    assert.equal(bound.sessionId, newSessionId);
    assert.equal(bound.wait ?? null, null);

    // Late terminal from the old Session must not re-park or fail the rebound task.
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.exited",
      sessionId: oldSessionId,
      exitCode: 0,
    });
    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId: oldSessionId,
      error: "late old fail",
    });

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      got.result as {
        task: { state: string; sessionId?: string; wait?: { reason: string } | null };
      }
    ).task;
    assert.equal(task.state, "running");
    assert.equal(task.sessionId, newSessionId);
    assert.equal(task.wait ?? null, null);
    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      label: "after late old-session event",
    });
  });
});

test("P0 three independent same-tick session terminals each park only their own Task", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("same-tick-three-terminals", {
    executor: "allow",
    orchestrator: "allow",
    reviewer: "allow",
  });

  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    async function seed(role: string, name: string) {
      const created = await rpc(svc, "docs.createNote", {
        workspaceId,
        name,
        type: "prompt",
      });
      const boxId = (created.result as { id: string }).id;
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role,
        prompt: `independent ${name}`,
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
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;
      return { taskPath, boxId, sessionId };
    }

    const a = await seed("executor", "tick-a");
    const b = await seed("orchestrator", "tick-b");
    const c = await seed("reviewer", "tick-c");

    // Fire all three terminals without awaiting between map calls (same tick projection).
    const p1 = mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId: a.sessionId,
      error: "a died",
    });
    const p2 = mapRuntimeEventToService(svc.ctx, {
      type: "session.exited",
      sessionId: b.sessionId,
      exitCode: 0,
    });
    const p3 = mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId: c.sessionId,
      error: "c died",
    });
    await Promise.all([p1, p2, p3]);

    for (const row of [a, b, c]) {
      const got = await rpc(svc, "task.get", { workspaceId, taskPath: row.taskPath });
      const task = (
        got.result as {
          task: {
            state: string;
            sessionId?: string;
            wait?: { reason: string; summary: string } | null;
          };
        }
      ).task;
      assert.equal(task.state, "waiting", row.taskPath);
      assert.equal(task.wait?.reason, "external", row.taskPath);
      assert.equal(task.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY, row.taskPath);
      assert.equal(task.sessionId, row.sessionId, row.taskPath);
      assertOccupationHeld(await boxCollabProjection(svc, workspaceId, row.boxId), {
        label: row.taskPath,
      });
    }
  });
});

test("P0 explicit interrupt remains terminal and releases occupation after park", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("interrupt-after-park");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "park then interrupt",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    const sent = await rpc(svc, "task.sendInput", {
      workspaceId,
      taskPath,
      text: "cancel on explicit interrupt only",
    });
    assert.ok(!sent.error, JSON.stringify(sent.error));
    const inputId = (sent.result as { input: { id: string } }).input.id;

    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId,
      error: "spontaneous",
    });
    const parked = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((parked.result as { task: { state: string } }).task.state, "waiting");

    const interrupted = await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    assert.ok(!interrupted.error, JSON.stringify(interrupted.error));
    assert.equal(
      (interrupted.result as { task: { state: string } }).task.state,
      "interrupted"
    );

    assertOccupationReleased(
      await boxCollabProjection(svc, workspaceId, boxId),
      "explicit interrupt"
    );

    const input = await svc.ctx.taskInputs.get(inputId, workspaceId, taskPath);
    assert.ok(input);
    assert.equal(input!.status, "cancelled", "interrupt cancels pending TaskInput");
  });
});

test("P0 explicit replacement session resume after recoverable park", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("replace-session-resume");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "recover with new session",
      deliveryPolicy: "review",
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
    const oldSessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    const sent = await rpc(svc, "task.sendInput", {
      workspaceId,
      taskPath,
      text: "survive park and rebind",
    });
    assert.ok(!sent.error, JSON.stringify(sent.error));
    const inputId = (sent.result as { input: { id: string } }).input.id;

    // Seed a report draft that must survive park (no auto re-prompt).
    await svc.ctx.managedDeliveryReportDrafts.preserve({
      workspaceId,
      taskPath,
      sessionId: oldSessionId,
      assistantText: "draft preserved across park",
    });

    await mapRuntimeEventToService(svc.ctx, {
      type: "session.failed",
      sessionId: oldSessionId,
      error: "child died",
    });

    const parked = await rpc(svc, "task.get", { workspaceId, taskPath });
    const parkedTask = (
      parked.result as {
        task: {
          state: string;
          wait?: { reason: string; summary: string } | null;
          sessionId?: string;
        };
      }
    ).task;
    assert.equal(parkedTask.state, "waiting");
    assert.equal(parkedTask.wait?.summary, SESSION_UNAVAILABLE_WAIT_SUMMARY);

    const draft = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.ok(draft, "report draft preserved");
    assert.equal(draft!.assistantText, "draft preserved across park");

    const inputBefore = await svc.ctx.taskInputs.get(inputId, workspaceId, taskPath);
    assert.ok(inputBefore);
    assert.notEqual(inputBefore!.status, "cancelled");

    // Explicit recovery — does not auto-rerun. Supported path may native-resume
    // the same Tent sessionId when resumeCapable, or allocate a replacement ss-.
    const recovery = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!recovery.error, JSON.stringify(recovery.error));
    const recoverySessionId = (
      recovery.result as { session: { sessionId: string } }
    ).session.sessionId;
    assert.ok(recoverySessionId, "recovery must bind a live session");

    const after = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      after.result as {
        task: {
          state: string;
          sessionId?: string;
          wait?: { reason: string } | null;
        };
      }
    ).task;
    assert.equal(task.state, "running");
    assert.equal(task.sessionId, recoverySessionId);
    assert.equal(task.wait ?? null, null);
    assert.equal(
      (await svc.runtime.probe(recoverySessionId)).alive,
      true,
      "explicit startSession must leave a live managed process"
    );

    const inputAfter = await svc.ctx.taskInputs.get(inputId, workspaceId, taskPath);
    assert.ok(inputAfter);
    assert.notEqual(inputAfter!.status, "cancelled");

    const draftAfter = await svc.ctx.managedDeliveryReportDrafts.get(workspaceId, taskPath);
    assert.ok(draftAfter, "report draft still present until successful deliver");
    assert.equal(draftAfter!.assistantText, "draft preserved across park");

    assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
      label: "after replacement session",
    });
  });
});

test("P0 UserAsk reply after park targets replacement Session, not dead origin", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace(
    "userask-replace-session",
    { executor: "allow" },
    { executor: ["mock-ua-park-reply"] }
  );
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-ua-park-")),
    "mock-acp.json"
  );

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "park ask then reply on replacement",
        deliveryPolicy: "review",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-ua-park-reply",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const oldSessionId = (
        started.result as { session: { sessionId: string } }
      ).session.sessionId;

      // Park on UserAsk while bootstrap is still in flight (keepAlive mock).
      const asked = await rpc(svc, "task.askUser", {
        workspaceId,
        taskPath,
        question: "Ship v1 or v2 after recovery?",
        choices: [
          { id: "v1", label: "v1" },
          { id: "v2", label: "v2" },
        ],
      });
      assert.ok(!asked.error, JSON.stringify(asked.error));
      const askId = (asked.result as { ask: { id: string; sessionId?: string } })
        .ask.id;
      const originAsk = await svc.ctx.userAsks.get(askId);
      assert.ok(originAsk);
      assert.equal(originAsk!.status, "pending");
      assert.equal(originAsk!.sessionId, oldSessionId, "ask records origin session");

      // Unintentional session death before Delivery → recoverable park.
      await mapRuntimeEventToService(svc.ctx, {
        type: "session.failed",
        sessionId: oldSessionId,
        error: "child died mid-ask",
      });
      const parked = await rpc(svc, "task.get", { workspaceId, taskPath });
      assert.equal(
        (parked.result as { task: { state: string } }).task.state,
        "waiting"
      );
      assert.equal(
        (await svc.ctx.userAsks.get(askId))!.status,
        "pending",
        "UserAsk preserved across park"
      );

      // Force a true replacement ss- (not native resume of the dead origin).
      await svc.runtime.registry.update(oldSessionId, {
        resumeToken: undefined,
        state: "failed",
      });

      const recovery = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-ua-park-reply",
        callerKind: "user",
      });
      assert.ok(!recovery.error, JSON.stringify(recovery.error));
      const newSessionId = (
        recovery.result as { session: { sessionId: string } }
      ).session.sessionId;
      assert.notEqual(newSessionId, oldSessionId, "must bind a replacement Session");
      assert.equal(
        (await svc.runtime.probe(newSessionId)).alive,
        true,
        "replacement session must be live"
      );

      const bound = await rpc(svc, "task.get", { workspaceId, taskPath });
      const boundTask = (
        bound.result as { task: { state: string; sessionId?: string } }
      ).task;
      assert.equal(boundTask.sessionId, newSessionId);
      assert.equal(boundTask.state, "running");

      // Audit origin on the ask row must not change.
      const askBeforeReply = await svc.ctx.userAsks.get(askId);
      assert.equal(askBeforeReply!.sessionId, oldSessionId);
      assert.equal(askBeforeReply!.status, "pending");

      const replied = await rpc(svc, "userAsk.reply", {
        askId,
        actor: "user",
        answer: "Ship v1 after rebind",
        choiceId: "v1",
      });
      assert.ok(!replied.error, JSON.stringify(replied.error));
      const body = replied.result as {
        ask: { status: string; sessionId?: string; answer?: string };
        state: string | null;
        continued?: boolean;
        continueError?: string;
      };
      assert.equal(body.ask.status, "answered");
      assert.equal(body.ask.answer, "Ship v1 after rebind");
      assert.equal(
        body.ask.sessionId,
        oldSessionId,
        "ask.sessionId remains audit origin"
      );
      assert.equal(
        body.continued,
        true,
        `answer must continue on live replacement; continueError=${body.continueError ?? "none"}`
      );
      assert.equal(body.state, "running");

      // Follow-up must land on the replacement process (mock log is per profile launch).
      const logRaw = await pollUntil(async () => {
        try {
          const raw = await fs.readFile(logPath, "utf8");
          if (raw.includes("## User Answer")) return raw;
          return null;
        } catch {
          return null;
        }
      }, 12_000, "User Answer follow-up on replacement session");
      assert.match(logRaw, /## User Answer/);
      assert.match(logRaw, /Ship v1 after rebind/);
      assert.match(logRaw, /choiceId: v1/);

      const after = await rpc(svc, "task.get", { workspaceId, taskPath });
      const task = (
        after.result as {
          task: { state: string; sessionId?: string; wait?: unknown };
        }
      ).task;
      assert.equal(task.state, "running");
      assert.equal(task.sessionId, newSessionId);
      assert.equal(task.wait ?? null, null);
      assertOccupationHeld(await boxCollabProjection(svc, workspaceId, boxId), {
        label: "after UserAsk reply on replacement",
      });

      // Dead origin must not be the continue target (still not alive).
      assert.equal((await svc.runtime.probe(oldSessionId)).alive, false);
      assert.equal((await svc.runtime.probe(newSessionId)).alive, true);
    },
    {
      profiles: [
        mockAcpProfile("mock-ua-park-reply", {
          logPath,
          promptText: "BOOTSTRAP_PLACEHOLDER",
          followupText: "AFTER_USER_ANSWER_ON_REPLACEMENT",
          promptDelayMs: 2_500,
          keepAlive: true,
        }),
      ],
    }
  );
});

test("reject-resume allocates new session only when prior is not resumeCapable", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace(
    "reject-resume-not-capable",
    { executor: "allow" },
    { executor: ["mock-reject-not-capable"] }
  );
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-rr-notcap-")),
    "mock-acp.json"
  );
  // No loadSession: after stop, probe.resumeCapable is false → honest new-session path.
  const profile = mockAcpProfile("mock-reject-not-capable", {
    logPath,
    promptText: "NOT_CAPABLE_FIRST",
    followupText: "REWORK_AFTER_NOT_CAPABLE",
    keepAlive: true,
  });

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "new ss when not resumeCapable",
        deliveryPolicy: "review",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-reject-not-capable",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const sessionId = (started.result as { session: { sessionId: string } }).session
        .sessionId;

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId,
        assistantText: "NOT_CAPABLE_FIRST",
      });
      await svc.runtime.stopSession(sessionId, "user");
      // Strip any residual token so probe.resumeCapable is false (honest new-session).
      await svc.runtime.registry.update(sessionId, {
        resumeToken: undefined,
        state: "stopped",
        pid: undefined,
      });
      assert.equal((await svc.runtime.probe(sessionId)).resumeCapable, false);

      const exactNote = "  new session ok after not-capable  ";
      const rejected = await rpc(svc, "task.reject", {
        workspaceId,
        taskPath,
        actor: "user",
        resume: true,
        note: exactNote,
      });
      assert.ok(!rejected.error, JSON.stringify(rejected.error));
      const body = rejected.result as {
        state: string;
        session?: {
          sessionId: string;
          contextRestored?: boolean;
          restoreReason?: string;
        };
        input?: { id: string; sessionId?: string; text?: string; kind?: string };
        accepted?: boolean;
        enqueued?: boolean;
      };
      assert.equal(body.state, "running");
      assert.ok(body.session?.sessionId);
      assert.notEqual(
        body.session!.sessionId,
        sessionId,
        "not resumeCapable must allocate a trackable new ss-"
      );
      assert.equal(body.session!.contextRestored, false);
      assert.equal(body.session!.restoreReason, "task.reject.resume.new-session");
      assert.equal((await svc.runtime.probe(body.session!.sessionId)).alive, true);
      assert.equal(
        (await svc.runtime.registry.read(body.session!.sessionId))?.contextRestored,
        false
      );
      assert.equal(body.input?.sessionId, body.session!.sessionId);
      assert.equal(body.input?.text, exactNote);
      assert.equal(body.accepted, true);
      assert.equal(body.enqueued, true);

      const newSessionId = body.session!.sessionId;
      const inputDelivered = await pollUntil(async () => {
        const got = await rpc(svc, "taskInput.get", {
          workspaceId,
          taskPath,
          inputId: body.input!.id,
        });
        if (got.error) return null;
        const input = (
          got.result as { input: { status: string; lastError?: string } }
        ).input;
        if (input.status === "delivered") return input;
        if (input.status === "failed") {
          throw new Error(`review-feedback inject failed: ${input.lastError}`);
        }
        return null;
      }, 20_000, "review-feedback delivered on not-capable new session");
      assert.equal(inputDelivered.status, "delivered");

      await pollUntil(async () => {
        const t = await rpc(svc, "task.get", { workspaceId, taskPath });
        const state = (t.result as { task: { state: string } }).task.state;
        return state === "delivered" ? t : null;
      }, 20_000, "rework delivery after not-capable new session");

      const log = await pollUntil(async () => {
        try {
          return JSON.parse(await fs.readFile(logPath, "utf8")) as {
            prompts?: string[];
          };
        } catch {
          return null;
        }
      }, 5_000, "mock acp log after not-capable fallback");
      const reviewPrompts = (log.prompts ?? []).filter((p) =>
        p.includes("## Review Feedback")
      );
      assert.equal(reviewPrompts.length, 1, "feedback inject exactly once");
      const inject = reviewPrompts[0]!;
      assert.ok(inject.includes("--- Tent reject-resume recovery ---"));
      assert.ok(inject.includes("contextRestored: false"));
      assert.ok(
        inject.includes("restorePath: not-resume-capable-new-session"),
        "not-capable path must not claim native-fail provenance"
      );
      assert.ok(inject.includes("rejected Delivery:"));
      assert.ok(inject.includes("NOT_CAPABLE_FIRST"));
      assert.ok(
        inject.includes("workspace lane:") || inject.includes("worktree:")
      );
      const noteOccurrences = inject.split(exactNote).length - 1;
      assert.equal(
        noteOccurrences,
        1,
        `review note must appear exactly once; got ${noteOccurrences}`
      );
      assert.ok(inject.includes(`text: ${exactNote}`));
      assert.ok(!/rejected Delivery:[\s\S]*reviewNote:/i.test(inject));
      assert.equal(
        (await svc.runtime.registry.read(newSessionId))?.contextRestored,
        false
      );
    },
    { profiles: [profile] }
  );
});

test("reject-resume recovery orientation rebuilds after simulated restart/retry", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace(
    "reject-resume-restart-rebuild",
    { executor: "allow" },
    { executor: ["mock-rr-restart"] }
  );
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-rr-restart-")),
    "mock-acp.json"
  );
  const profile = mockAcpProfile("mock-rr-restart", {
    logPath,
    promptText: "RESTART_REBUILD_FIRST",
    followupText: "REWORK_AFTER_RESTART_RETRY",
    keepAlive: true,
  });

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "rebuild orientation after restart",
        deliveryPolicy: "review",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "mock-rr-restart",
        callerKind: "user",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      const priorSessionId = (started.result as { session: { sessionId: string } })
        .session.sessionId;

      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId,
        taskPath,
        sessionId: priorSessionId,
        assistantText: "RESTART_REBUILD_FIRST",
      });
      await svc.runtime.stopSession(priorSessionId, "user");
      await svc.runtime.registry.update(priorSessionId, {
        resumeToken: undefined,
        state: "stopped",
        pid: undefined,
      });

      const exactNote = "  retry after service restart  ";
      // Simulate Service restart gap: durable accept + restore happen, but
      // background inject is not accepted (process died before FIFO ran).
      stopManagedTaskInputBackgroundAccept();
      let rejected;
      try {
        rejected = await rpc(svc, "task.reject", {
          workspaceId,
          taskPath,
          actor: "user",
          resume: true,
          note: exactNote,
        });
      } finally {
        // Re-enable for later tests / redelivery; we inject manually below.
        enableManagedTaskInputBackgroundAccept();
      }
      assert.ok(!rejected.error, JSON.stringify(rejected.error));
      const body = rejected.result as {
        state: string;
        session?: { sessionId: string; contextRestored?: boolean };
        input?: { id: string; sessionId?: string; text?: string; status?: string };
        enqueued?: boolean;
      };
      assert.equal(body.state, "running");
      assert.equal(body.session?.contextRestored, false);
      const newSessionId = body.session!.sessionId;
      assert.notEqual(newSessionId, priorSessionId);
      assert.equal(body.input?.text, exactNote);
      // Background was stopped — enqueue is a no-op; row stays pending.
      assert.equal(body.enqueued, true); // RPC still reports schedule intent
      const durable = await svc.ctx.taskInputs.get(
        body.input!.id,
        workspaceId,
        taskPath
      );
      assert.ok(durable);
      assert.ok(
        durable!.status === "pending" || durable!.status === "failed",
        `simulated restart must leave open TaskInput; got ${durable!.status}`
      );
      assert.equal(
        (await svc.runtime.registry.read(newSessionId))?.contextRestored,
        false,
        "durable Session row must keep contextRestored=false across restart"
      );

      // Post-restart retry: rebuild orientation from durable facts only
      // (no in-memory recoveryBootstrap from the original reject RPC).
      const result = await invokeDeliverManagedTaskInputForTests(svc.ctx, durable!, {
        sessionIdOverride: newSessionId,
      });
      assert.equal(
        result.continued,
        true,
        `retry inject must succeed with rebuilt orientation: ${result.continueError}`
      );
      assert.equal(result.input.status, "delivered");

      await pollUntil(async () => {
        const t = await rpc(svc, "task.get", { workspaceId, taskPath });
        const state = (t.result as { task: { state: string } }).task.state;
        return state === "delivered" ? t : null;
      }, 20_000, "rework delivery after restart retry");

      const log = await pollUntil(async () => {
        try {
          return JSON.parse(await fs.readFile(logPath, "utf8")) as {
            prompts?: string[];
          };
        } catch {
          return null;
        }
      }, 5_000, "mock log after restart retry");
      const reviewPrompts = (log.prompts ?? []).filter((p) =>
        p.includes("## Review Feedback")
      );
      assert.equal(reviewPrompts.length, 1, "exactly one review inject after manual retry");
      const injectText = reviewPrompts[0]!;
      assert.ok(
        injectText.includes("--- Tent reject-resume recovery ---"),
        "orientation must be rebuilt from durable facts at inject time"
      );
      assert.ok(injectText.includes("contextRestored: false"));
      assert.ok(
        injectText.includes("restorePath: not-resume-capable-new-session")
      );
      assert.ok(injectText.includes("rejected Delivery:"));
      assert.ok(injectText.includes("RESTART_REBUILD_FIRST"));
      assert.ok(
        injectText.includes("workspace lane:") || injectText.includes("worktree:")
      );
      const noteOccurrences = injectText.split(exactNote).length - 1;
      assert.equal(noteOccurrences, 1, "review note exactly once after rebuild");
      assert.ok(injectText.includes(`text: ${exactNote}`));
      assert.ok(!/rejected Delivery:[\s\S]*reviewNote:/i.test(injectText));
    },
    { profiles: [profile] }
  );
  resetManagedTaskInputBackgroundForTests();
});

test("reject-resume post-start context failure stops orphan Session and parks occupation", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-post-start-fail");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "post-start context failure must stop orphan",
      deliveryPolicy: "review",
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
    const priorSessionId = (started.result as { session: { sessionId: string } })
      .session.sessionId;

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId: priorSessionId,
      assistantText: "POST_START_FAIL_FIRST",
    });
    await svc.runtime.stopSession(priorSessionId, "user");
    await svc.runtime.registry.update(priorSessionId, {
      resumeToken: undefined,
      state: "stopped",
      pid: undefined,
    });
    assert.equal((await svc.runtime.probe(priorSessionId)).resumeCapable, false);

    const beforeIds = new Set(
      (await svc.runtime.registry.list()).map((r) => r.id)
    );

    setRejectResumePostStartFailureForTests(
      () => new Error("simulated post-start context-update failure")
    );
    try {
      const rejected = await rpc(svc, "task.reject", {
        workspaceId,
        taskPath,
        actor: "user",
        resume: true,
        note: "must park after orphan stop",
      });
      assert.ok(rejected.error, "post-start failure must fail the RPC");
      assert.equal(rejected.error!.code, RPC_LIFECYCLE);
      assert.match(
        String(rejected.error!.message),
        /resume failed to restore managed session/i
      );
      assert.match(
        String(rejected.error!.message),
        /simulated post-start context-update failure/
      );
    } finally {
      setRejectResumePostStartFailureForTests(null);
    }

    const afterIds = (await svc.runtime.registry.list()).map((r) => r.id);
    const newIds = afterIds.filter((id) => !beforeIds.has(id));
    // A fallback Session may have been allocated then stopped — must not stay live.
    for (const id of newIds) {
      const probe = await svc.runtime.probe(id);
      assert.equal(
        probe.alive,
        false,
        `orphan fallback Session must be stopped; ${id} still alive`
      );
    }
    // Also ensure no live process other than already-dead prior.
    for (const id of afterIds) {
      if (id === priorSessionId) continue;
      const probe = await svc.runtime.probe(id);
      assert.equal(
        probe.alive,
        false,
        `no live orphan after post-start failure; ${id} alive`
      );
    }

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      got.result as {
        task: {
          state: string;
          sessionId?: string;
          wait?: { reason?: string; summary?: string };
        };
      }
    ).task;
    assert.equal(task.state, "waiting", "must park waiting, not fail or stay running");
    assert.equal(task.wait?.reason, "external");
    assert.ok(
      task.wait?.summary?.includes(REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY),
      task.wait?.summary
    );
    // Occupation retained (waiting, not released/failed).
    assert.notEqual(task.state, "failed");
    assert.notEqual(task.state, "interrupted");
    assert.notEqual(task.state, "cancelled");

    const pending = await svc.ctx.taskInputs.listPending(workspaceId, taskPath);
    assert.ok(
      pending.some(
        (row) =>
          row.kind === "review-feedback" &&
          row.text === "must park after orphan stop" &&
          row.status !== "cancelled"
      ),
      "review-feedback must remain for retry after orphan stop"
    );
  });
});

test("reject-resume fails loud and parks waiting when session cannot be restored", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("reject-resume-fail-loud");

  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "force restore failure",
      deliveryPolicy: "review",
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
    const sessionId = (started.result as { session: { sessionId: string } }).session
      .sessionId;

    await invokeManagedAutoDeliverForTests(svc.ctx, {
      workspaceId,
      taskPath,
      sessionId,
      assistantText: "WILL_REJECT",
    });

    // Destroy registry identity so restore cannot resume or re-bind profile.
    await svc.runtime.registry.remove(sessionId);

    const rejected = await rpc(svc, "task.reject", {
      workspaceId,
      taskPath,
      actor: "user",
      resume: true,
      note: "should fail loud",
    });
    assert.ok(rejected.error, "reject-resume must fail the RPC when session restore fails");
    assert.equal(rejected.error!.code, RPC_LIFECYCLE);
    assert.match(String(rejected.error!.message), /resume failed to restore managed session/i);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    const task = (
      got.result as {
        task: { state: string; wait?: { reason?: string; summary?: string } };
      }
    ).task;
    assert.equal(task.state, "waiting", "must not stay running without a live session");
    assert.equal(task.wait?.reason, "external");
    assert.ok(
      task.wait?.summary?.includes(REJECT_RESUME_SESSION_FAILED_WAIT_SUMMARY),
      task.wait?.summary
    );

    // Review note retained even when restore never ran (input created before restore).
    const pending = await svc.ctx.taskInputs.listPending(workspaceId, taskPath);
    assert.ok(
      pending.some(
        (row) => row.kind === "review-feedback" && row.text === "should fail loud"
      ),
      "review-feedback must remain for poll after fail-loud restore"
    );
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
      deliveryPolicy: "review",
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
    // Turn was sealed before the failed collection/deliver; process is dead,
    // task remains running for startSession retry (no forged zero-commit delivery).
    assert.ok(session && (session.state === "stopped" || session.state === "failed"));
    const probe = await svc.runtime.probe(sessionId);
    assert.equal(probe.alive, false);
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
      deliveryPolicy: "review",
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
    assert.equal(
      sessionId2,
      sessionId1,
      "a resumable durable Role Session is reused across tasks"
    );
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

/**
 * P0: task.startSession single-flight / idempotency per Task.
 * Same-tick concurrent callers must not mint two provider processes before
 * envelope sessionId bind. Fake adapter only — no paid/live providers.
 */
test("P0: concurrent task.startSession same tick coalesces to one Session", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-start-single-flight");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "single-flight concurrent start",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const payload = {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user" as const,
    };
    // Same tick: no await between the two RPC launches.
    const [a, b] = await Promise.all([
      rpc(svc, "task.startSession", payload),
      rpc(svc, "task.startSession", payload),
    ]);
    assert.ok(!a.error, JSON.stringify(a.error));
    assert.ok(!b.error, JSON.stringify(b.error));
    const idA = (a.result as { session: { sessionId: string } }).session.sessionId;
    const idB = (b.result as { session: { sessionId: string } }).session.sessionId;
    assert.equal(idA, idB, "concurrent starts must coalesce to one sessionId");

    const mount = svc.ctx.host.require(workspaceId);
    const envelope = await loadTaskEnvelope(mount.env.fs, taskPath);
    assert.equal(envelope.sessionId, idA);

    const managed = (await svc.runtime.registry.list()).filter(
      (rec) =>
        rec.workspace === workspaceId &&
        rec.roleName === "executor" &&
        (rec.assigneeKind ?? "role") !== "agentProfile" &&
        rec.state !== "external"
    );
    assert.equal(
      managed.length,
      1,
      `expected exactly one managed session row, got ${managed.map((r) => r.id).join(",")}`
    );
    assert.equal((await svc.runtime.probe(idA)).alive, true);
  });
});

test("P0: repeated task.startSession after success reuses bound Session", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("p0-start-idempotent-reuse");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "idempotent restart reuse",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const first = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!first.error, JSON.stringify(first.error));
    const sessionId = (first.result as { session: { sessionId: string } }).session
      .sessionId;

    // After bind succeeds, a second call must reuse without a second provider.
    const second = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      profileId: "fake-default",
      callerKind: "user",
    });
    assert.ok(!second.error, JSON.stringify(second.error));
    assert.equal(
      (second.result as { session: { sessionId: string } }).session.sessionId,
      sessionId
    );

    const liveManaged = (await svc.runtime.registry.list()).filter(
      (rec) =>
        rec.workspace === workspaceId &&
        rec.roleName === "executor" &&
        rec.state !== "external" &&
        rec.state !== "stopped" &&
        rec.state !== "failed"
    );
    assert.equal(liveManaged.length, 1);
    assert.equal(liveManaged[0]!.id, sessionId);
    assert.equal((await svc.runtime.probe(sessionId)).alive, true);
  });
});

test("P0: failed launch clears same-task flight slot (lifecycle failed)", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace(
    "p0-start-fail-same-key",
    { executor: "allow" },
    { executor: ["fake-fail-launch"] }
  );
  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "fail launch clears exact flight key",
      });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });

      const payload = {
        workspaceId,
        taskPath,
        profileId: "fake-fail-launch",
        callerKind: "user" as const,
      };
      // Same-tick concurrent failures coalesce onto one launch attempt.
      const [a, b] = await Promise.all([
        rpc(svc, "task.startSession", payload),
        rpc(svc, "task.startSession", payload),
      ]);
      assert.ok(a.error, "failLaunch must fail startSession");
      assert.ok(b.error, "coalesced authorized caller must observe the same failure");
      assert.match(String(a.error!.message), /simulated launch failure/);
      assert.match(String(b.error!.message), /simulated launch failure/);

      const mount = svc.ctx.host.require(workspaceId);
      const failedTask = await loadTaskEnvelope(mount.env.fs, taskPath);
      assert.equal(
        failedTask.state,
        "failed",
        "launch failure still taskFails occupation (unchanged contract)"
      );

      // Exact same taskPath flight key must be gone after the attempt settles.
      assert.equal(
        isTaskStartSessionInFlightForTests(workspaceId, taskPath),
        false,
        "same-task flight slot must clear after failed launch"
      );

      // Same-task re-start is refused by lifecycle (failed), not by a stuck flight.
      const retrySame = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-fail-launch",
        callerKind: "user",
      });
      assert.ok(retrySame.error);
      assert.equal(retrySame.error!.code, RPC_LIFECYCLE);
      assert.match(
        String(retrySame.error!.message),
        /requires running \(or waiting after approval\); got failed/
      );
      assert.equal(
        isTaskStartSessionInFlightForTests(workspaceId, taskPath),
        false,
        "lifecycle reject must not leave a flight slot"
      );
    },
    {
      profiles: [
        {
          id: "fake-fail-launch",
          adapterId: FAKE_ADAPTER_ID,
          fake: { failLaunch: "simulated launch failure", waitForSignal: true },
        },
      ],
    }
  );
});

test("P0: unauthorized concurrent start is denied; only one authorized launch", async () => {
  resetManagedAutoDeliverDedupForTests();
  // executor a2aPolicy defaults to deny for role callers; user remains root.
  const ws = await makeWorkspace("p0-start-auth-before-flight");
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId,
      role: "executor",
      prompt: "auth gate before coalesce",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // Same tick: authorized user + unauthorized role (same profileId).
    // Role must not piggyback on the user's launch flight.
    const [authorized, unauthorized] = await Promise.all([
      rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-default",
        callerKind: "user",
      }),
      rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        profileId: "fake-default",
        callerKind: "role",
      }),
    ]);

    assert.ok(!authorized.error, JSON.stringify(authorized.error));
    assert.ok(unauthorized.error, "role with default deny must not coalesce");
    assert.equal(unauthorized.error!.code, RPC_A2A_DENIED);
    assert.match(
      String(unauthorized.error!.message),
      /A2A policy denies starting a new runtime session/
    );

    const sessionId = (
      authorized.result as { session: { sessionId: string } }
    ).session.sessionId;
    const mount = svc.ctx.host.require(workspaceId);
    assert.equal((await loadTaskEnvelope(mount.env.fs, taskPath)).sessionId, sessionId);

    const managed = (await svc.runtime.registry.list()).filter(
      (rec) =>
        rec.workspace === workspaceId &&
        rec.roleName === "executor" &&
        (rec.assigneeKind ?? "role") !== "agentProfile" &&
        rec.state !== "external"
    );
    assert.equal(
      managed.length,
      1,
      `expected exactly one managed launch, got ${managed.map((r) => r.id).join(",")}`
    );
    assert.equal((await svc.runtime.probe(sessionId)).alive, true);
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
    assert.equal(
      (deadTask.wait as { code?: string } | undefined)?.code,
      SESSION_UNAVAILABLE_WAIT_CODE
    );
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

    // Occupation kept: active task still owns the box (projection, not Node FM).
    assertOccupationHeld(await boxCollabProjection(svc, idA2, dead.boxId), {
      label: "reconcile dead session",
    });
    assertOccupationHeld(await boxCollabProjection(svc, idA2, staleLive.boxId), {
      label: "reconcile stale-live",
    });

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

test("durable role reuses one provider session across delivered tasks", async () => {
  resetManagedAutoDeliverDedupForTests();
  const ws = await makeWorkspace("role-session-cross-task");
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-b5-role-session-log-")),
    "mock-acp-role-session.json"
  );
  const profile = mockAcpProfile("mock-acp-role-session", {
    logPath,
    promptText: "ROLE_SESSION_DONE",
    keepAlive: true,
  });
  profile.env = {
    ...profile.env,
    MOCK_ACP_LOAD_SESSION: "1",
    MOCK_ACP_HISTORY_TEXT: "OLD_TASK_HISTORY",
  };

  await withService(
    async (svc) => {
      const { workspaceId, boxId } = await mountWorkItem(svc, ws);
      const firstDispatch = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId,
        role: "executor",
        prompt: "first role task",
      });
      const firstPath = (firstDispatch.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath: firstPath });
      const firstStart = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: firstPath,
        profileId: profile.id,
        callerKind: "user",
      });
      assert.ok(!firstStart.error, JSON.stringify(firstStart.error));
      const sessionId = (
        firstStart.result as { session: { sessionId: string } }
      ).session.sessionId;

      await pollUntil(async () => {
        const rec = await svc.runtime.registry.read(sessionId);
        return rec?.state === "stopped" ? rec : null;
      }, 45_000, "first role delivery stop");

      const secondBox = await rpc(svc, "docs.createNote", {
        workspaceId,
        name: "second-role-task",
        type: "prompt",
      });
      const secondDispatch = await rpc(svc, "task.dispatch", {
        workspaceId,
        boxId: (secondBox.result as { id: string }).id,
        role: "executor",
        prompt: "second role task",
      });
      const secondPath = (secondDispatch.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath: secondPath });
      const secondTask = await rpc(svc, "task.get", { workspaceId, taskPath: secondPath });
      const secondTaskId = (
        secondTask.result as { task: { id: string } }
      ).task.id;

      const secondStart = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: secondPath,
        profileId: profile.id,
        callerKind: "user",
      });
      assert.ok(!secondStart.error, JSON.stringify(secondStart.error));
      assert.equal(
        (secondStart.result as { session: { sessionId: string } }).session.sessionId,
        sessionId,
        "Role Session must keep the same Tent session id across tasks"
      );

      const rebound = await svc.runtime.registry.read(sessionId);
      assert.equal(rebound?.lastTaskId, secondTaskId);
      const log = await pollUntil(async () => {
        try {
          const parsed = JSON.parse(await fs.readFile(logPath, "utf8")) as {
            methods: string[];
            loads?: Array<{ sessionId: string }>;
          };
          return parsed.methods.includes("session/load") ? parsed : null;
        } catch {
          return null;
        }
      }, 45_000, "cross-task session/load");
      assert.ok(!log.methods.includes("session/new"));
      assert.equal(log.loads?.[0]?.sessionId, "mock-acp-session-1");

      const secondDelivery = await pollUntil(async () => {
        const listed = await rpc(svc, "delivery.list", { workspaceId });
        return (
          listed.result as { deliveries: Array<{ taskId: string; summary: string }> }
        ).deliveries.find((delivery) => delivery.taskId === secondTaskId);
      }, 45_000, "second role delivery");
      assert.equal(secondDelivery.summary, "ROLE_SESSION_DONE");
      assert.doesNotMatch(secondDelivery.summary, /OLD_TASK_HISTORY/);
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
      deliveryPolicy: "review",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    // Corrupt envelope targetBranch after dispatch — must not be trusted blindly.
    // Commit-bearing deliver snapshots target HEAD via resolveIntegrationContract,
    // so mismatch fails at deliver-time (Task stays running; no ready Delivery).
    await corruptTaskLane(ws, taskPath, { targetBranch: "not-the-real-main" });

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready",
      commits: [sourceRef],
    });
    assert.ok(delivered.error, "stale targetBranch must fail re-validation at deliver");
    assert.match(String(delivered.error!.message), /targetBranch mismatch/);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
  });

  // Wrong workspace root on envelope — also fail-loud at commit-bearing deliver.
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

    const delivered = await rpc(svc, "task.deliver", {
      workspaceId,
      taskPath,
      summary: "ready",
      commits: [sourceRef],
    });
    assert.ok(delivered.error, "workspace mismatch must fail re-validation at deliver");
    assert.match(String(delivered.error!.message), /workspace mismatch/);

    const got = await rpc(svc, "task.get", { workspaceId, taskPath });
    assert.equal((got.result as { task: { state: string } }).task.state, "running");
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
