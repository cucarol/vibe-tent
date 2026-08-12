/**
 * Managed auto-delivery must fail closed unless runtime death and idle state
 * are positively observed. Deterministic fake adapter only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
import { createServiceClient } from "../src/service/client.js";
import {
  invokeManagedAutoDeliverForTests,
  resetManagedAutoDeliverDedupForTests,
} from "../src/service/handlers.js";
import { startLocalTentService } from "../src/service/service.js";

const CONNECTION: AgentConnectionConfig = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
};

test("managed auto-delivery refuses when stop and both seal probes fail", async () => {
  resetManagedAutoDeliverDedupForTests();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-seal-closed-ws-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-seal-closed-data-"));
  await scaffoldInWorkspace(new NodeFs(workspace), {
    name: "managed-seal-fail-closed",
    nodes: [{ name: "work", type: "prompt", body: "# work\n" }],
  });

  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: [CONNECTION],
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(workspace)) as { workspaceId: string };
    const created = (await client.docsCreateNote(mounted.workspaceId, {
      name: "seal-target",
      type: "prompt",
    })) as { nodeId: string };
    const dispatched = (await client.taskDispatch(mounted.workspaceId, {
      workNodeIds: [created.nodeId],
      contextNodeIds: [],
      connectionId: CONNECTION.connectionId,
      prompt: "hold managed session open",
      parentActor: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string; sessionId: string };

    const originalProbe = svc.runtime.probe.bind(svc.runtime);
    const originalStop = svc.runtime.stopSession.bind(svc.runtime);
    assert.equal((await originalProbe(dispatched.sessionId)).alive, true);

    let probeCalls = 0;
    let stopCalls = 0;
    svc.runtime.probe = async (sessionId: string) => {
      if (sessionId !== dispatched.sessionId) return originalProbe(sessionId);
      probeCalls += 1;
      throw new Error(`intentional seal probe failure ${probeCalls}`);
    };
    svc.runtime.stopSession = async (sessionId: string, reason = "user") => {
      if (sessionId !== dispatched.sessionId) return originalStop(sessionId, reason);
      stopCalls += 1;
      throw new Error("intentional managed stop failure");
    };

    const diagnostics: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "session.state") {
        diagnostics.push(event.payload as Record<string, unknown>);
      }
    });
    try {
      await invokeManagedAutoDeliverForTests(svc.ctx, {
        workspaceId: mounted.workspaceId,
        taskPath: dispatched.taskPath,
        sessionId: dispatched.sessionId,
        assistantText: "outcome: delivered\n\nMUST_NOT_PUBLISH",
        commits: [],
      });
    } finally {
      unsubscribe();
      svc.runtime.probe = originalProbe;
      svc.runtime.stopSession = originalStop;
    }

    assert.equal(probeCalls, 2, "seal must make both bounded observations");
    assert.equal(stopCalls, 1, "seal must attempt the exact owned stop once");
    assert.equal(
      (await originalProbe(dispatched.sessionId)).alive,
      true,
      "failed stop leaves the fake child live for the fail-closed assertion"
    );

    const task = (await client.taskGet(mounted.workspaceId, dispatched.taskPath)) as {
      task: { state: string };
    };
    assert.equal(task.task.state, "running");
    const deliveries = (await client.deliveryList(mounted.workspaceId)) as {
      deliveries: unknown[];
    };
    assert.equal(deliveries.deliveries.length, 0, "no ready Delivery without a proven seal");

    const sealFailure = diagnostics.find(
      (event) => event.runtimeEvent === "session.seal_before_deliver.failed"
    );
    assert.ok(sealFailure, "stable seal failure diagnostic must be emitted");
    assert.match(String(sealFailure.error), /pre-stop probe failed/);
    assert.match(String(sealFailure.error), /stop failed/);
    assert.match(String(sealFailure.error), /post-stop probe failed/);
    const promptFailure = diagnostics.find(
      (event) => event.runtimeEvent === "session.prompt_complete.failed"
    );
    assert.ok(promptFailure, "managed auto-delivery failure remains observable");
    assert.match(String(promptFailure.error), /could not be sealed/);
    const registryRow = await svc.runtime.registry.read(dispatched.sessionId);
    assert.match(
      registryRow?.lastError ?? "",
      /managed auto-deliver failed: managed session could not be sealed/
    );

    const health = await client.call<{ status: string; protocolVersion: number }>(
      "service.health",
      {}
    );
    assert.equal(health.status, "ok");
    assert.equal(health.protocolVersion, 7);
  } finally {
    await svc.stop();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
