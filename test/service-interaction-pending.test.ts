/**
 * Unified A2U pending projection: interaction.listPending.
 * Aggregates DecisionRequest / toolApproval / ready TaskResult — no new store.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { createTaskResult, writeTaskResult } from "../src/core/task-result.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import {
  CLIENT_METHODS,
  isClientMethod,
  type PendingInteractionListResult,
} from "../src/service/types.js";
import { makeToolApprovalId } from "../src/service/tool-approval-store.js";

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ix-pending-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "interaction-pending",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            id: "rl-executor",
            name: "executor",
            prompt: "do work",
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
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ix-pending-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

test("CLIENT_METHODS includes interaction.listPending", () => {
  assert.ok(CLIENT_METHODS.includes("interaction.listPending"));
  assert.ok(isClientMethod("interaction.listPending"));
  assert.equal(isClientMethod("interaction.resolve"), false);
});

test("interaction.listPending aggregates actionable Result and tool approval with stable sort", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;
    const entered = (await client.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      cwd: ws,
    })) as { session: { sessionId: string }; sessionToken: string };
    const roleClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });

    const created = (await client.docsCreateNote(workspaceId, {
      name: "work-item",
      type: "prompt",
    }));
    const nodeId = created.nodeId;

    const dispatched = (await client.taskDispatch(workspaceId, {
      workNodeIds: [nodeId],
      contextNodeIds: [],
      assigneeRoleId: "rl-executor",
      prompt: "Need decisions and review",
      requester: { kind: "user", id: "user" },
      acceptMode: "review-required",
    })) as { taskPath: string; task?: { id?: string } };
    const taskPath = dispatched.taskPath;
    await roleClient.taskClaim(workspaceId, taskPath);

    const taskGot = (await client.taskGet(workspaceId, taskPath)) as {
      task: { id?: string; executionSessionId?: string; assigneeRoleId?: string };
    };
    const taskId = taskGot.task.id;
    assert.ok(taskId, "task id required for result + pointers");

    // Tool approval pending (safe options only; no raw args in store row)
    const toolId = makeToolApprovalId();
    await svc.ctx.toolApprovals.add({
      id: toolId,
      workspaceId,
      sessionId: entered.session.sessionId,
      taskId,
      taskPath,
      role: "executor",
      toolTitle: "read_file",
      toolCallId: "tc-1",
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject", name: "Reject" },
      ],
      status: "pending",
      createdAt: "2021-06-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    // The exact current user-reviewable Result is the only Result interaction.
    const fsa = new NodeFs(path.join(ws, ".tent"));
    const clock = { now: () => "2022-01-01T00:00:00.000Z" };
    const submitted = await roleClient.taskSubmit(workspaceId, taskPath, {
      report: "Ready for human review",
    }) as { result: { id: string; createdAt: string } };
    const readyResult = submitted.result;

    // Stale ready inventory sharing the same Task id is not current authority.
    await createTaskResult(fsa, clock, {
      taskId,
      resultsDir: "temp/roles/rl-executor/results",
      report: "Stale ready history",
      status: "ready",
    });

    // Orphan ready inventory is likewise not a user action.
    await createTaskResult(fsa, clock, {
      taskId: "tk-orphan",
      resultsDir: "temp/roles/rl-executor/results",
      report: "Orphan ready history",
      status: "ready",
    });

    // Non-ready result must not appear
    const acceptedHistory = await createTaskResult(fsa, clock, {
      taskId: "tk-history",
      resultsDir: "temp/roles/rl-executor/results",
      report: "Already accepted history",
      status: "ready",
    });
    acceptedHistory.status = "accepted";
    acceptedHistory.review = {
      reviewer: "user",
      at: "2022-01-01T00:00:00.000Z",
    };
    await writeTaskResult(fsa, acceptedHistory);

    const roleNode = await client.docsCreateNote(workspaceId, {
      name: "role-owned-result",
      type: "prompt",
    });
    const roleOwnedEntered = await client.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      cwd: ws,
      externalKey: "interaction-role-owned",
    }) as { session: { sessionId: string }; sessionToken: string };
    const roleOwnedClient = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: roleOwnedEntered.session.sessionId,
      currentSessionToken: roleOwnedEntered.sessionToken,
    });
    const roleOwned = await roleOwnedClient.taskDispatch(workspaceId, {
      workNodeIds: [roleNode.nodeId],
      contextNodeIds: [],
      assigneeRoleId: "rl-executor",
      prompt: "Role-owned result is not a user Inbox action",
      requester: { kind: "role", id: "rl-executor" },
    }) as { taskPath: string };
    await roleOwnedClient.taskClaim(workspaceId, roleOwned.taskPath);
    await roleOwnedClient.taskSubmit(workspaceId, roleOwned.taskPath, {
      report: "Return to the responsible Role",
    });

    const result = (await client.interactionListPending(
      workspaceId
    )) as PendingInteractionListResult;

    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.counts.total, 2);
    assert.equal(result.counts.decisionRequest, 0);
    assert.equal(result.counts.toolApproval, 1);
    assert.equal(result.counts.result, 1);
    assert.equal(result.items.length, 2);

    // Stable sort: createdAt ASC, then kind, then id
    const times = result.items.map((i) => i.createdAt);
    assert.deepEqual(times, [...times].sort((a, b) => a.localeCompare(b)));
    assert.equal(result.items[0]!.kind, "toolApproval");
    assert.equal(result.items[0]!.id, toolId);
    assert.equal(result.items[1]!.kind, "result");
    assert.equal(result.items[1]!.id, readyResult.id);

    const tool = result.items.find((i) => i.kind === "toolApproval");
    assert.ok(tool && tool.kind === "toolApproval");
    assert.equal(tool.toolTitle, "read_file");
    assert.equal(tool.sessionId, entered.session.sessionId);
    assert.equal(tool.options.length, 2);
    // Never project raw tool args / toolCallId as part of the inbox item
    assert.equal((tool as { toolCallId?: string }).toolCallId, undefined);
    assert.equal((tool as { args?: unknown }).args, undefined);
    assert.equal((tool as { rawInput?: unknown }).rawInput, undefined);

    const del = result.items.find((i) => i.kind === "result");
    assert.ok(del && del.kind === "result");
    assert.equal(del.status, "ready");
    assert.equal(del.taskId, taskId);
    assert.equal(del.path.endsWith(`/${readyResult.id}.md`), true);
    // TaskResult summary is intentionally not projected on the unified inbox
    assert.equal((del as { summary?: string }).summary, undefined);

    // ServiceClient result wrappers
    const listed = await client.taskResultList(workspaceId, { taskId });
    assert.ok(listed.results.some((item) => item.id === readyResult.id && item.status === "ready"));
    const got = await client.taskResultGet(workspaceId, readyResult.id);
    assert.equal(got.result.id, readyResult.id);
    assert.equal(got.result.report.includes("Ready for human review"), true);

    await createTaskResult(fsa, clock, {
      id: readyResult.id,
      taskId: "tk-duplicate",
      resultsDir: "temp/roles/rl-other/results",
      report: "Duplicate identity must fail closed",
      status: "ready",
    });
    await assert.rejects(
      () => client.interactionListPending(workspaceId),
      /Task Result identity is not unique|INTERACTION_RESULT_NOT_UNIQUE/i
    );
  });
});

test("interaction.listPending fail-loud when workspace not mounted", async () => {
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await assert.rejects(
      () => client.interactionListPending("ws-does-not-exist"),
      /not mounted|Workspace not found|unknown workspace|not found/i
    );
  });
});

test("interaction.listPending empty workspace returns zero counts", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const result = (await client.interactionListPending(
      mounted.workspaceId
    )) as PendingInteractionListResult;
    assert.equal(result.counts.total, 0);
    assert.deepEqual(result.items, []);
    assert.equal(result.counts.decisionRequest, 0);
    assert.equal(result.counts.toolApproval, 0);
    assert.equal(result.counts.result, 0);
  });
});

test("interaction.listPending fails closed on duplicate current Task identity", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const local = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId } = await local.mount(ws) as { workspaceId: string };
    const node = await local.docsCreateNote(workspaceId, { name: "duplicate-task" });
    const entered = await local.sessionEnter({
      workspaceId,
      roleId: "rl-executor",
      cwd: ws,
    }) as { session: { sessionId: string }; sessionToken: string };
    const role = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    });
    const dispatched = await local.taskDispatch(workspaceId, {
      workNodeIds: [node.nodeId],
      contextNodeIds: [],
      assigneeRoleId: "rl-executor",
      prompt: "duplicate authority fixture",
      requester: { kind: "user", id: "user" },
    }) as { taskPath: string };
    await role.taskClaim(workspaceId, dispatched.taskPath);
    await role.taskSubmit(workspaceId, dispatched.taskPath, { report: "review me" });

    const systemFs = new NodeFs(path.join(ws, ".tent"));
    const raw = await systemFs.readFile(dispatched.taskPath);
    const duplicatePath = `temp/roles/rl-other/tasks/${path.posix.basename(dispatched.taskPath)}`;
    await systemFs.mkdir(path.posix.dirname(duplicatePath));
    await systemFs.writeFile(
      duplicatePath,
      raw.replace(/^assigneeRoleId: rl-executor$/m, "assigneeRoleId: rl-other")
    );

    await assert.rejects(
      () => local.interactionListPending(workspaceId),
      /Task identity is ambiguous|INTERACTION_RESULT_TASK_NOT_UNIQUE/i
    );
  });
});
