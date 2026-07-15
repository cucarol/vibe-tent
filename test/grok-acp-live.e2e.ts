/**
 * Explicit paid/network smoke for the real Grok ACP + CPA path.
 * Not part of `npm test`; run with `npm run test:grok-e2e`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { DEFAULT_GROK_BASE_URL_ENV_KEY, DEFAULT_GROK_ENV_KEY, GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { createAgentRuntime, type RuntimeEvent } from "../src/runtime/index.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";

const apiKey = process.env[DEFAULT_GROK_ENV_KEY];
const baseUrl = process.env[DEFAULT_GROK_BASE_URL_ENV_KEY];

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 180_000
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for real Grok ACP delivery");
}

function waitForRuntimeEvent(
  events: RuntimeEvent[],
  type: RuntimeEvent["type"],
  sessionId: string,
  timeoutMs = 180_000
): Promise<RuntimeEvent> {
  return pollUntil(
    async () =>
      events.find((event) => event.type === type && event.sessionId === sessionId) ??
      null,
    timeoutMs
  );
}

function liveProfile() {
  return {
    id: "grok-live-e2e",
    adapterId: GROK_ACP_ADAPTER_ID,
    acp: {
      model: process.env.CPA_GROK_MODEL || "grok-4.5",
      envKey: DEFAULT_GROK_ENV_KEY,
      baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
      permissionPolicy: "deny" as const,
      promptTimeoutMs: 180_000,
    },
  };
}

async function rmTreeWithRetry(target: string): Promise<void> {
  await fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

test("real Grok ACP: dispatch → managed report → manual accept", async () => {
  assert.ok(apiKey, `${DEFAULT_GROK_ENV_KEY} is required`);
  assert.ok(baseUrl, `${DEFAULT_GROK_BASE_URL_ENV_KEY} is required`);

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-grok-e2e-ws-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-grok-e2e-data-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "grok-e2e",
    rules: "# RULES\n\nReal Grok ACP smoke. Do not use tools.\n",
    boxes: [],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "e2e", prompt: "Return a concise report without tools." }] }, null, 2) + "\n"
  );

  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    profiles: [liveProfile()],
  });
  const rpc = (method: string, params?: Record<string, unknown>) =>
    rpcCall(svc.url, method, params, { token: svc.token });

  try {
    const mounted = await rpc("workspace.mount", { workspaceRoot: workspace });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const created = await rpc("docs.createNote", {
      workspaceId,
      name: "grok-live-smoke",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const boxId = (created.result as { id: string }).id;
    const dispatched = await rpc("task.dispatch", {
      workspaceId,
      boxId,
      role: "e2e",
      prompt: "Reply with a short delivery report containing the marker TENT_GROK_E2E_OK. Do not call tools.",
      deliveryPolicy: "manual",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    const claimed = await rpc("task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    const started = await rpc("task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "grok-live-e2e",
    });
    assert.ok(!started.error, JSON.stringify(started.error));

    const delivered = await pollUntil(async () => {
      const got = await rpc("task.get", { workspaceId, taskPath });
      assert.ok(!got.error, JSON.stringify(got.error));
      const task = (got.result as { task: { state: string } }).task;
      return task.state === "delivered" ? task : null;
    });
    assert.equal(delivered.state, "delivered");

    const deliveries = await rpc("delivery.list", { workspaceId });
    assert.ok(!deliveries.error, JSON.stringify(deliveries.error));
    const rows = (deliveries.result as { deliveries: Array<{ summary: string }> }).deliveries;
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.summary, /TENT_GROK_E2E_OK/i);

    const accepted = await rpc("task.accept", { workspaceId, taskPath, actor: "user" });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
  } finally {
    await svc.stop();
    await rmTreeWithRetry(workspace);
    await rmTreeWithRetry(dataDir);
  }
});

test("real Grok ACP: stop bridge → native session/load → recover prior context", async () => {
  assert.ok(apiKey, `${DEFAULT_GROK_ENV_KEY} is required`);
  assert.ok(baseUrl, `${DEFAULT_GROK_BASE_URL_ENV_KEY} is required`);

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-grok-resume-data-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-grok-resume-cwd-"));
  const sessionId = "ss-groklive1";
  const nonce = `TENT_RSM_${Date.now().toString(36).toUpperCase()}`;
  let firstRuntime = createAgentRuntime({ dataDir, profiles: [liveProfile()] });
  const firstEvents: RuntimeEvent[] = [];
  firstRuntime.subscribeAll((event) => firstEvents.push(event));

  try {
    await firstRuntime.startSession({
      sessionId,
      profileId: "grok-live-e2e",
      cwd,
      bootstrapPrompt:
        `Remember the secret nonce ${nonce} for our next turn. ` +
        "Reply only with FIRST_READY. Do not call tools.",
    });
    const firstComplete = (await waitForRuntimeEvent(
      firstEvents,
      "session.prompt_complete",
      sessionId
    )) as Extract<RuntimeEvent, { type: "session.prompt_complete" }>;
    assert.match(firstComplete.assistantText, /FIRST_READY/i);
    const beforeStop = await firstRuntime.registry.read(sessionId);
    assert.ok(beforeStop?.resumeToken, "real Grok session must persist provider session id");
    await firstRuntime.stopSession(sessionId, "user");
    await firstRuntime.shutdown();

    const secondRuntime = createAgentRuntime({ dataDir, profiles: [liveProfile()] });
    firstRuntime = secondRuntime;
    const secondEvents: RuntimeEvent[] = [];
    secondRuntime.subscribeAll((event) => secondEvents.push(event));
    const resumed = await secondRuntime.resumeSession({
      sessionId,
      cwd,
      bootstrapPrompt:
        "Reply only with SECOND_OK followed by the secret nonce from our previous turn. " +
        "Do not call tools and do not invent a nonce.",
    });
    assert.equal(resumed.sessionId, sessionId);
    const secondComplete = (await waitForRuntimeEvent(
      secondEvents,
      "session.prompt_complete",
      sessionId
    )) as Extract<RuntimeEvent, { type: "session.prompt_complete" }>;
    assert.match(secondComplete.assistantText, /SECOND_OK/i);
    assert.match(secondComplete.assistantText, new RegExp(nonce));
    await secondRuntime.stopSession(sessionId, "user");
  } finally {
    await firstRuntime.shutdown().catch(() => undefined);
    await rmTreeWithRetry(cwd);
    await rmTreeWithRetry(dataDir);
  }
});
