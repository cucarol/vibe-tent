/**
 * Corrupt TaskInput/DecisionRequest authority must stay fail-closed across
 * Service/store recreation. Deterministic fake adapter only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import type { PendingDecisionRequest } from "../src/core/decision-request.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
import { createServiceClient } from "../src/service/client.js";
import {
  DECISION_REQUEST_STORE_CORRUPT,
  DecisionRequestStore,
} from "../src/service/decision-request-store.js";
import { startLocalTentService } from "../src/service/service.js";
import {
  TASK_INPUT_STORE_CORRUPT,
  TaskInputStore,
  type TaskInputRecord,
} from "../src/service/task-input-store.js";

const CONNECTION: AgentConnectionConfig = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
};

type StoreKind = "task-input" | "decision-request";

const cases: Array<{
  name: string;
  kind: StoreKind;
  fileName: string;
  code: string;
  seed: string;
}> = [
  {
    name: "TaskInput malformed JSON",
    kind: "task-input",
    fileName: "task-inputs.json",
    code: TASK_INPUT_STORE_CORRUPT,
    seed: "{not-json\n",
  },
  {
    name: "TaskInput malformed row",
    kind: "task-input",
    fileName: "task-inputs.json",
    code: TASK_INPUT_STORE_CORRUPT,
    seed: JSON.stringify({ items: [{ id: "ti-invalid" }] }, null, 2) + "\n",
  },
  {
    name: "DecisionRequest malformed JSON",
    kind: "decision-request",
    fileName: "decision-requests.json",
    code: DECISION_REQUEST_STORE_CORRUPT,
    seed: "{not-json\n",
  },
  {
    name: "DecisionRequest malformed row",
    kind: "decision-request",
    fileName: "decision-requests.json",
    code: DECISION_REQUEST_STORE_CORRUPT,
    seed: JSON.stringify({ items: [{ id: "dr-invalid" }] }, null, 2) + "\n",
  },
];

function pendingInput(workspaceId: string, taskPath: string): TaskInputRecord {
  const now = new Date().toISOString();
  return {
    id: "ti-0123456789",
    workspaceId,
    taskPath,
    kind: "user-input",
    text: "must remain blocked",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

function pendingDecision(): PendingDecisionRequest {
  return {
    id: "dr-0123456789",
    taskId: "tk-corrupt",
    requester: { kind: "session", id: "ss-corrupt" },
    target: { kind: "role", id: "rl-reviewer" },
    question: "Must remain blocked?",
    options: [],
    status: "pending",
  };
}

async function captureError(work: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error as Error & { code?: string };
  }
  assert.fail("expected authority store operation to fail closed");
}

function listEvidenceBackups(entries: string[], fileName: string): string[] {
  const latchName = `${fileName}.corrupt-latch.json`;
  return entries.filter(
    (name) => name.startsWith(`${fileName}.corrupt-`) && name !== latchName
  );
}

for (const fixture of cases) {
  test(`${fixture.name} remains latched across restart and blocks Delivery`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-authority-corrupt-data-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-authority-corrupt-ws-"));
    const primary = path.join(dataDir, fixture.fileName);
    await fs.writeFile(primary, fixture.seed, "utf8");
    await scaffoldInWorkspace(new NodeFs(workspace), {
      name: "interaction-store-corruption",
      nodes: [{ name: "work", type: "prompt", body: "# work\n" }],
    });

    const svc = await startLocalTentService({
      dataDir,
      writeEndpoint: true,
      connections: [CONNECTION],
    });
    let workspaceId = "";
    let taskPath = "";
    let firstError: (Error & { code?: string }) | undefined;
    try {
      const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
      workspaceId = ((await client.mount(workspace)) as { workspaceId: string }).workspaceId;
      const note = await client.docsCreateNote(workspaceId, {
        name: `corrupt-${fixture.kind}`,
        type: "prompt",
      });
      const dispatched = (await client.taskDispatch(workspaceId, {
        workNodeIds: [note.nodeId],
        contextNodeIds: [],
        connectionId: CONNECTION.connectionId,
        prompt: "hold for corruption delivery gate",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
        acceptMode: "review-required",
      })) as { taskPath: string };
      taskPath = dispatched.taskPath;

      const failedDelivery = await captureError(() =>
        client.taskDeliver(workspaceId, taskPath, {
          summary: "MUST_NOT_DELIVER",
          commits: [],
        })
      );
      assert.match(failedDelivery.message, new RegExp(fixture.code));
      const repeatedDelivery = await captureError(() =>
        client.taskDeliver(workspaceId, taskPath, {
          summary: "MUST_NOT_DELIVER_AGAIN",
          commits: [],
        })
      );
      assert.match(repeatedDelivery.message, new RegExp(fixture.code));

      const deliveries = await client.deliveryList(workspaceId);
      assert.equal(deliveries.deliveries.length, 0, "corrupt authority publishes no Delivery");
      const task = (await client.taskGet(workspaceId, taskPath)) as {
        task: { state: string };
      };
      assert.equal(task.task.state, "running");

      if (fixture.kind === "task-input") {
        firstError = await captureError(() =>
          svc.ctx.taskInputs.listBlockingForDeliver(workspaceId, taskPath)
        );
        const mutationError = await captureError(() =>
          svc.ctx.taskInputs.add(pendingInput(workspaceId, taskPath))
        );
        assert.strictEqual(mutationError, firstError);
      } else {
        firstError = await captureError(() =>
          svc.ctx.decisionRequests.getPendingForTask(workspaceId, taskPath)
        );
        const mutationError = await captureError(() =>
          svc.ctx.decisionRequests.add({
            workspaceId,
            taskPath,
            request: pendingDecision(),
          })
        );
        assert.strictEqual(mutationError, firstError);
      }
      assert.equal(firstError.code, fixture.code);
      const health = await client.call<{ status: string }>("service.health", {});
      assert.equal(health.status, "ok");
    } finally {
      await svc.stop();
    }

    try {
      await assert.rejects(fs.stat(primary), { code: "ENOENT" });
      const entries = await fs.readdir(dataDir);
      const backups = listEvidenceBackups(entries, fixture.fileName);
      assert.equal(backups.length, 1, "first detection retains one evidence backup");
      assert.equal(
        await fs.readFile(path.join(dataDir, backups[0]!), "utf8"),
        fixture.seed
      );
      assert.ok(
        entries.includes(`${fixture.fileName}.corrupt-latch.json`),
        "restart-safe corruption latch must be durable"
      );

      let authorityWrites = 0;
      if (fixture.kind === "task-input") {
        const restarted = new TaskInputStore(dataDir, {
          writeState: async () => {
            authorityWrites += 1;
          },
        });
        const readError = await captureError(() =>
          restarted.listBlockingForDeliver(workspaceId, taskPath)
        );
        assert.equal(readError.code, fixture.code);
        assert.equal(readError.message, firstError?.message);
        const writeError = await captureError(() =>
          restarted.add(pendingInput(workspaceId, taskPath))
        );
        assert.strictEqual(writeError, readError);
        await restarted.shutdown();
      } else {
        const restarted = new DecisionRequestStore(dataDir, {
          writeState: async () => {
            authorityWrites += 1;
          },
        });
        const readError = await captureError(() =>
          restarted.getPendingForTask(workspaceId, taskPath)
        );
        assert.equal(readError.code, fixture.code);
        assert.equal(readError.message, firstError?.message);
        const writeError = await captureError(() =>
          restarted.add({ workspaceId, taskPath, request: pendingDecision() })
        );
        assert.strictEqual(writeError, readError);
        await restarted.shutdown();
      }
      assert.equal(authorityWrites, 0, "latched store never recreates empty authority state");

      const afterRestart = await fs.readdir(dataDir);
      assert.equal(
        listEvidenceBackups(afterRestart, fixture.fileName).length,
        1,
        "restart does not create repeated evidence backups"
      );
      await assert.rejects(fs.stat(primary), { code: "ENOENT" });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}
