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
import {
  authorityStoreCorruptionLatchPath,
  persistAuthorityStoreCorruption,
} from "../src/service/authority-store-corruption.js";
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
  test(`${fixture.name} remains latched across restart and blocks TaskResult`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-authority-corrupt-data-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-authority-corrupt-ws-"));
    const primary = path.join(dataDir, fixture.fileName);
    await scaffoldInWorkspace(new NodeFs(workspace), {
      name: "interaction-store-corruption",
      nodes: [{ name: "work", type: "prompt", body: "# work\n" }],
    });

    let svc: Awaited<ReturnType<typeof startLocalTentService>> | undefined;
    let workspaceId = "";
    let taskPath = "";
    let taskId = "";
    let firstError: (Error & { code?: string }) | undefined;
    try {
      if (fixture.kind === "task-input") {
        // Connection dispatch now correctly consults TaskInput authority before
        // provider continuation. Create the exact Task while authority is healthy,
        // then prove corruption remains fail-closed across a real Service restart.
        svc = await startLocalTentService({
          dataDir,
          writeEndpoint: true,
          connections: [CONNECTION],
        });
        const healthyClient = createServiceClient({ baseUrl: svc.url, token: svc.token });
        workspaceId = ((await healthyClient.mount(workspace)) as { workspaceId: string })
          .workspaceId;
        const note = await healthyClient.docsCreateNote(workspaceId, {
          name: `corrupt-${fixture.kind}`,
          type: "prompt",
        });
        const dispatched = (await healthyClient.taskDispatch(workspaceId, {
          workNodeIds: [note.nodeId],
          contextNodeIds: [],
          connectionId: CONNECTION.connectionId,
          prompt: "hold for corruption result gate",
          requester: { kind: "user", id: "user" },
          acceptMode: "review-required",
        })) as { taskPath: string };
        taskPath = dispatched.taskPath;
        taskId = ((await healthyClient.taskGet(workspaceId, taskPath)) as {
          task: { id: string };
        }).task.id;
        await svc.stop();
        svc = undefined;
        await fs.writeFile(primary, fixture.seed, "utf8");
      } else {
        await fs.writeFile(primary, fixture.seed, "utf8");
      }

      svc = await startLocalTentService({
        dataDir,
        writeEndpoint: true,
        connections: [CONNECTION],
      });
      const activeService = svc;
      const client = createServiceClient({
        baseUrl: activeService.url,
        token: activeService.token,
      });
      workspaceId = ((await client.mount(workspace)) as { workspaceId: string }).workspaceId;
      if (!taskPath) {
        const note = await client.docsCreateNote(workspaceId, {
          name: `corrupt-${fixture.kind}`,
          type: "prompt",
        });
        const dispatched = (await client.taskDispatch(workspaceId, {
          workNodeIds: [note.nodeId],
          contextNodeIds: [],
          connectionId: CONNECTION.connectionId,
          prompt: "hold for corruption result gate",
          requester: { kind: "user", id: "user" },
          acceptMode: "review-required",
        })) as { taskPath: string };
        taskPath = dispatched.taskPath;
        taskId = ((await client.taskGet(workspaceId, taskPath)) as {
          task: { id: string };
        }).task.id;
      }

      const failedTaskResult = await captureError(() =>
        client.taskSubmit(workspaceId, taskPath, {
          report: "MUST_NOT_DELIVER",
          commits: [],
        })
      );
      assert.match(failedTaskResult.message, new RegExp(fixture.code));
      const repeatedTaskResult = await captureError(() =>
        client.taskSubmit(workspaceId, taskPath, {
          report: "MUST_NOT_DELIVER_AGAIN",
          commits: [],
        })
      );
      assert.match(repeatedTaskResult.message, new RegExp(fixture.code));

      const results = await client.taskResultList(workspaceId);
      assert.equal(results.results.length, 0, "corrupt authority publishes no TaskResult");
      const task = (await client.taskGet(workspaceId, taskPath)) as {
        task: { id: string; state: string; wait?: { code?: string } | null };
      };
      assert.equal(task.task.id, taskId, "the exact pre-corruption Task remains auditable");
      assert.ok(
        task.task.state === "running" || task.task.state === "waiting",
        `Task remains legally recoverable, got ${task.task.state}`
      );
      if (task.task.state === "waiting") {
        assert.equal(task.task.wait?.code, "session_unavailable");
      }

      if (fixture.kind === "task-input") {
        firstError = await captureError(() =>
          activeService.ctx.taskInputs.listBlockingForDeliver(workspaceId, taskPath)
        );
        const mutationError = await captureError(() =>
          activeService.ctx.taskInputs.add(pendingInput(workspaceId, taskPath))
        );
        assert.strictEqual(mutationError, firstError);
      } else {
        firstError = await captureError(() =>
          activeService.ctx.decisionRequests.getPendingForTask(workspaceId, taskPath)
        );
        const mutationError = await captureError(() =>
          activeService.ctx.decisionRequests.add({
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
      await svc?.stop();
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

for (const fixture of [
  { kind: "task-input" as const, fileName: "task-inputs.json" },
  { kind: "decision-request" as const, fileName: "decision-requests.json" },
]) {
  test(`${fixture.kind} transient authority read failure is retryable without quarantine`, async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-authority-io-retry-"));
    const primary = path.join(dataDir, fixture.fileName);
    const latch = authorityStoreCorruptionLatchPath(primary);
    await fs.mkdir(primary);

    try {
      if (fixture.kind === "task-input") {
        const store = new TaskInputStore(dataDir);
        const first = await captureError(() =>
          store.listBlockingForDeliver("ws-retry", "temp/retry.md")
        );
        assert.doesNotMatch(first.message, /TASK_INPUT_STORE_CORRUPT/);
        await assert.rejects(fs.stat(latch), { code: "ENOENT" });
        assert.deepEqual(listEvidenceBackups(await fs.readdir(dataDir), fixture.fileName), []);

        await fs.rmdir(primary);
        await fs.writeFile(primary, JSON.stringify({ items: [] }) + "\n", "utf8");
        assert.deepEqual(
          await store.listBlockingForDeliver("ws-retry", "temp/retry.md"),
          []
        );
        await store.shutdown();
      } else {
        const store = new DecisionRequestStore(dataDir);
        const first = await captureError(() => store.listPending());
        assert.doesNotMatch(first.message, /DECISION_REQUEST_STORE_CORRUPT/);
        await assert.rejects(fs.stat(latch), { code: "ENOENT" });
        assert.deepEqual(listEvidenceBackups(await fs.readdir(dataDir), fixture.fileName), []);

        await fs.rmdir(primary);
        await fs.writeFile(primary, JSON.stringify({ items: [] }) + "\n", "utf8");
        assert.deepEqual(await store.listPending(), []);
        await store.shutdown();
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("failed corruption-latch write preserves the original authority evidence", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-authority-latch-fail-"));
  const primary = path.join(dataDir, "task-inputs.json");
  const latch = authorityStoreCorruptionLatchPath(primary);
  const seed = "{not-json\n";
  await fs.writeFile(primary, seed, "utf8");

  try {
    const first = await persistAuthorityStoreCorruption(
      primary,
      TASK_INPUT_STORE_CORRUPT,
      "invalid JSON",
      {
        writeLatch: async () => {
          throw Object.assign(new Error("injected latch write failure"), { code: "EACCES" });
        },
      }
    );
    assert.equal(first.code, TASK_INPUT_STORE_CORRUPT);
    assert.match(first.message, /corruption latch persistence failed/);
    assert.equal(await fs.readFile(primary, "utf8"), seed);
    assert.deepEqual(listEvidenceBackups(await fs.readdir(dataDir), "task-inputs.json"), []);
    await assert.rejects(fs.stat(latch), { code: "ENOENT" });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
