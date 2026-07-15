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
    profiles: [
      {
        id: "grok-live-e2e",
        adapterId: GROK_ACP_ADAPTER_ID,
        acp: {
          model: process.env.CPA_GROK_MODEL || "grok-4.5",
          envKey: DEFAULT_GROK_ENV_KEY,
          baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
          permissionPolicy: "deny",
          promptTimeoutMs: 180_000,
        },
      },
    ],
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
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
