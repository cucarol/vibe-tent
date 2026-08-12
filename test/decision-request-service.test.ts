/**
 * DecisionRequest production Service path: authenticated authority, exact Task
 * binding, TaskInput-first persistence, and same-id Role-to-user escalation.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadTaskEnvelope, patchTaskEnvelope } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { createServiceClient } from "../src/service/client.js";
import { deriveSessionToken } from "../src/service/auth.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { prepareDecisionResponse } from "../src/service/decision-request-flow.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { makeSessionId } from "../src/runtime/types.js";

const FAKE_CONNECTION = {
  connectionId: "fake-default",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, sleepMs: 60_000 },
} as const;

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-decision-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "decision-request",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { id: "rl-executor", name: "executor", prompt: "execute" },
          { id: "rl-reviewer", name: "reviewer", prompt: "review" },
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-decision-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: [FAKE_CONNECTION],
  });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

async function enterRole(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  workspaceId: string,
  workspace: string,
  roleId: string,
  externalKey?: string
) {
  const root = createServiceClient({ baseUrl: svc.url, token: svc.token });
  const entered = (await root.sessionEnter({
    workspaceId,
    roleId,
    cwd: workspace,
    ...(externalKey ? { externalKey } : {}),
  })) as {
    session: { sessionId: string };
    sessionToken: string;
  };
  return {
    sessionId: entered.session.sessionId,
    client: createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentSessionId: entered.session.sessionId,
      currentSessionToken: entered.sessionToken,
    }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createRunningRoleTask(input: {
  svc: Awaited<ReturnType<typeof startLocalTentService>>;
  workspace: string;
  parentActor: { kind: "user"; id: "user" } | { kind: "role"; id: string };
}) {
  const root = createServiceClient({ baseUrl: input.svc.url, token: input.svc.token });
  const { workspaceId } = (await root.mount(input.workspace)) as { workspaceId: string };
  const executorExternalKey = `codex:${Math.random().toString(36).slice(2)}`;
  const executor = await enterRole(
    input.svc,
    workspaceId,
    input.workspace,
    "rl-executor",
    executorExternalKey
  );
  const note = await root.docsCreateNote(workspaceId, {
    name: `decision-${Math.random().toString(36).slice(2, 8)}`,
    type: "prompt",
  });
  const dispatched = (await root.taskDispatch(workspaceId, {
    workNodeIds: [note.nodeId],
    contextNodeIds: [],
    roleId: "rl-executor",
    prompt: "Need a durable decision",
    parentActor: input.parentActor,
    acceptMode: "review-required",
  })) as { taskPath: string };
  await executor.client.taskClaim(workspaceId, dispatched.taskPath);
  return {
    root,
    workspaceId,
    taskPath: dispatched.taskPath,
    executor,
    executorExternalKey,
  };
}

async function createRunningConnectionTask(input: {
  svc: Awaited<ReturnType<typeof startLocalTentService>>;
  workspace: string;
}) {
  const root = createServiceClient({ baseUrl: input.svc.url, token: input.svc.token });
  const { workspaceId } = (await root.mount(input.workspace)) as { workspaceId: string };
  const note = await root.docsCreateNote(workspaceId, {
    name: `managed-decision-${Math.random().toString(36).slice(2, 8)}`,
    type: "prompt",
  });
  const dispatched = (await root.taskDispatch(workspaceId, {
    workNodeIds: [note.nodeId],
    contextNodeIds: [],
    connectionId: "fake-default",
    prompt: "Managed Task with a durable Decision Request",
    parentActor: { kind: "user", id: "user" },
    acceptMode: "review-required",
  })) as { taskPath: string; task: { sessionId?: string } };
  const current = (await root.taskGet(workspaceId, dispatched.taskPath)) as {
    task: { sessionId?: string; state: string };
  };
  assert.equal(current.task.state, "running");
  assert.ok(current.task.sessionId);
  return {
    root,
    workspaceId,
    taskPath: dispatched.taskPath,
    sessionId: current.task.sessionId,
    executor: createServiceClient({
      baseUrl: input.svc.url,
      token: input.svc.token,
      currentSessionId: current.task.sessionId,
      currentSessionToken: deriveSessionToken(input.svc.token, current.task.sessionId),
    }),
  };
}

test("public RPC surface contains only DecisionRequest methods", () => {
  for (const method of [
    "task.requestDecision",
    "decisionRequest.listPending",
    "decisionRequest.get",
    "decisionRequest.respond",
    "decisionRequest.escalate",
  ] as const) {
    assert.ok(CLIENT_METHODS.includes(method));
  }
  for (const retired of [
    "task.askUser",
    "userAsk.listPending",
    "userAsk.get",
    "userAsk.reply",
    "userAsk.deny",
  ]) {
    assert.equal((CLIENT_METHODS as readonly string[]).includes(retired), false);
  }
});

test("exact requester Session creates a user DecisionRequest and blocks ordinary input and Delivery", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor, executorExternalKey } =
      await createRunningRoleTask({
        svc,
        workspace,
        parentActor: { kind: "user", id: "user" },
      });

    await assert.rejects(
      () => root.taskRequestDecision(workspaceId, taskPath, { question: "forged" }),
      /caller Session|session context|authenticated/i
    );
    const externalKeyOnly = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentExternalKey: executorExternalKey,
    });
    await assert.rejects(
      () =>
        externalKeyOnly.taskRequestDecision(workspaceId, taskPath, {
          question: "external key is not a Session capability",
        }),
      /caller Session|authenticated/i
    );

    const created = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Ship now?",
      options: [
        { id: "ship", label: "Ship" },
        { id: "wait", label: "Wait" },
      ],
    })) as {
      state: string;
      request: {
        id: string;
        requester: { kind: string; id: string };
        target: { kind: string; id: string };
      };
    };
    assert.equal(created.state, "waiting");
    assert.deepEqual(created.request.requester, {
      kind: "session",
      id: executor.sessionId,
    });
    assert.deepEqual(created.request.target, { kind: "user", id: "user" });
    assert.equal(
      (await svc.runtime.registry.read(executor.sessionId))?.state,
      "external",
      "a DecisionRequest must not convert an external Role Session into managed state"
    );

    const pending = (await root.decisionRequestListPending(workspaceId)) as {
      requests: Array<{ id: string }>;
    };
    assert.deepEqual(pending.requests.map((row) => row.id), [created.request.id]);
    await assert.rejects(
      () => root.taskSendInput(workspaceId, taskPath, { text: "bypass" }),
      /pending Decision Request/i
    );
    await assert.rejects(
      () => root.taskDeliver(workspaceId, taskPath, { summary: "bypass" }),
      /pending Decision Request/i
    );

    const retired = await rpcCall(
      svc.url,
      "task.askUser",
      { workspaceId, taskPath, question: "legacy" },
      { token: svc.token }
    );
    assert.equal(retired.error?.code, -32601);
  });
});

test("response persists deterministic TaskInput before answer and retry creates no duplicate", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Choose release",
      options: [{ id: "v2", label: "V2" }],
    })) as { request: { id: string } };

    for (const retired of [
      { taskPath },
      { taskId: "tk-retired" },
    ]) {
      const response = await rpcCall(
        svc.url,
        "decisionRequest.respond",
        {
          workspaceId,
          requestId: requested.request.id,
          response: { kind: "option", optionId: "v2" },
          ...retired,
        },
        { token: svc.token }
      );
      assert.equal(response.error?.code, -32602);
    }
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 0);

    const taskFs = svc.ctx.host.require(workspaceId).env.fs;
    const duplicateTaskPath = taskPath.replace(/\.md$/, "-duplicate.md");
    await taskFs.writeFile(duplicateTaskPath, await taskFs.readFile(taskPath));
    const taskBeforeDuplicateReject = await taskFs.readFile(taskPath);
    const requestBeforeDuplicateReject = await svc.ctx.decisionRequests.getExactById(
      workspaceId,
      requested.request.id
    );
    await assert.rejects(
      () =>
        root.decisionRequestRespond(workspaceId, requested.request.id, {
          kind: "option",
          optionId: "v2",
        }),
      /exactly one canonical Task/
    );
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 0);
    assert.equal(await taskFs.readFile(taskPath), taskBeforeDuplicateReject);
    assert.deepEqual(
      await svc.ctx.decisionRequests.getExactById(workspaceId, requested.request.id),
      requestBeforeDuplicateReject
    );
    await taskFs.remove(duplicateTaskPath);

    const originalAnswer = svc.ctx.decisionRequests.answerExact.bind(svc.ctx.decisionRequests);
    let injected = true;
    svc.ctx.decisionRequests.answerExact = async (...args) => {
      if (injected) {
        injected = false;
        throw new Error("injected answer persistence failure");
      }
      return originalAnswer(...args);
    };
    await assert.rejects(
      () =>
        root.decisionRequestRespond(workspaceId, requested.request.id, {
          kind: "option",
          optionId: "v2",
        }),
      /injected answer persistence failure/
    );
    const beforeRetry = await svc.ctx.taskInputs.listForTask(workspaceId, taskPath);
    assert.equal(beforeRetry.length, 1, "TaskInput must persist before request answer");
    assert.equal(beforeRetry[0]!.kind, "decision-response");
    assert.match(beforeRetry[0]!.text ?? "", /optionId: v2/);
    const stillPending = await svc.ctx.decisionRequests.getExact(
      workspaceId,
      taskPath,
      requested.request.id
    );
    assert.equal(stillPending?.status, "pending");
    const hidden = (await root.taskInputListPending(workspaceId, taskPath)) as {
      inputs: unknown[];
    };
    assert.deepEqual(
      hidden.inputs,
      [],
      "unpublished decision response must not appear in TaskInput attention"
    );
    await assert.rejects(
      () => root.taskInputGet(workspaceId, taskPath, beforeRetry[0]!.id),
      /TaskInput not found/
    );
    await assert.rejects(
      () => root.taskInputAck(workspaceId, taskPath, beforeRetry[0]!.id),
      /not published until its Decision Request is answered/
    );

    const events: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = svc.ctx.events.subscribe((event) => events.push(event));
    const responded = (await root.decisionRequestRespond(
      workspaceId,
      requested.request.id,
      { kind: "option", optionId: "v2" }
    )) as { request: { status: string }; state: string };
    unsubscribe();
    assert.equal(responded.request.status, "answered");
    assert.equal(responded.state, "running");
    const eventTypes = events.map((event) => event.type);
    const resolvedIndex = events.findIndex((event) => event.type === "decisionRequest.resolved");
    const taskStateIndex = events.findIndex(
      (event) =>
        event.type === "task.state" &&
        (event.payload as { reason?: unknown }).reason === "decisionRequest.respond"
    );
    assert.ok(resolvedIndex >= 0, `missing decisionRequest.resolved: ${eventTypes.join(",")}`);
    assert.ok(
      taskStateIndex >= 0,
      `missing decisionRequest.respond task.state: ${eventTypes.join(",")}`
    );
    assert.ok(
      resolvedIndex < taskStateIndex,
      "resolved invalidation must precede exact Task resume projection"
    );
    const afterRetry = await svc.ctx.taskInputs.listForTask(workspaceId, taskPath);
    assert.equal(afterRetry.length, 1, "same request id must reuse one deterministic TaskInput");
    const runningRetry = (await root.decisionRequestRespond(
      workspaceId,
      requested.request.id,
      { kind: "option", optionId: "v2" }
    )) as { request: { status: string }; state: string };
    assert.equal(runningRetry.request.status, "answered");
    assert.equal(runningRetry.state, "running");
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 1);
    const reboundSessionId = makeSessionId();
    await svc.ctx.taskInputs.rebindOpenSessions(
      workspaceId,
      taskPath,
      reboundSessionId,
      [afterRetry[0]!.id]
    );
    await patchTaskEnvelope(svc.ctx.host.require(workspaceId).env.fs, taskPath, {
      sessionId: reboundSessionId,
      state: "failed",
    });
    const responseLossRetry = (await root.decisionRequestRespond(
      workspaceId,
      requested.request.id,
      { kind: "option", optionId: "v2" }
    )) as { request: { status: string }; state: string; enqueued: boolean };
    assert.equal(responseLossRetry.request.status, "answered");
    assert.equal(responseLossRetry.state, "failed");
    assert.equal(responseLossRetry.enqueued, false);
    assert.equal(
      (await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length,
      1,
      "answered request retry after Task resume must remain idempotent"
    );
    const published = (await root.taskInputGet(
      workspaceId,
      taskPath,
      beforeRetry[0]!.id
    )) as { input: { id: string } };
    assert.equal(published.input.id, beforeRetry[0]!.id);

    const forged = await rpcCall(
      svc.url,
      "decisionRequest.respond",
      {
        workspaceId,
        taskPath,
        requestId: requested.request.id,
        response: { kind: "option", optionId: "v2" },
        actor: "rl-executor",
      },
      { token: svc.token }
    );
    assert.equal(forged.error?.code, -32602, "actor text must never select authority");
  });
});

test("answered Decision retry never resumes a later Decision wait", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    const first = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "First decision",
    })) as { request: { id: string } };
    await root.decisionRequestRespond(workspaceId, first.request.id, {
      kind: "custom",
      text: "first",
    });
    const second = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Second decision",
    })) as { request: { id: string } };
    const beforeTask = await svc.ctx.host.require(workspaceId).env.fs.readFile(taskPath);
    const replay = (await root.decisionRequestRespond(workspaceId, first.request.id, {
      kind: "custom",
      text: "first",
    })) as { state: string; enqueued: boolean };
    assert.equal(replay.state, "waiting");
    assert.equal(replay.enqueued, false);
    assert.equal(await svc.ctx.host.require(workspaceId).env.fs.readFile(taskPath), beforeTask);
    assert.equal(
      (await svc.ctx.decisionRequests.getExactById(workspaceId, second.request.id))?.status,
      "pending"
    );
  });
});

test("answered Decision retry repairs the committed answer before Task resume", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Recover answered WAL",
    })) as { request: { id: string } };
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const request = await svc.ctx.decisionRequests.getExactById(
      workspaceId,
      requested.request.id
    );
    assert.ok(request && request.status === "pending");
    const response = { kind: "custom" as const, text: "recover" };
    const prepared = prepareDecisionResponse({
      request: {
        id: request.id,
        taskId: request.taskId,
        requester: request.requester,
        target: request.target,
        question: request.question,
        options: request.options,
        status: "pending",
      },
      responder: { kind: "user", id: "user" },
      response,
      binding: {
        workspaceId,
        taskPath,
        taskId: task.id!,
        sessionId: executor.sessionId,
      },
      now: new Date().toISOString(),
    });
    await svc.ctx.taskInputs.add(prepared.taskInput);
    await svc.ctx.decisionRequests.answerExact({
      workspaceId,
      taskPath,
      requestId: request.id,
      responder: { kind: "user", id: "user" },
      response,
    });

    const recovered = (await root.decisionRequestRespond(
      workspaceId,
      request.id,
      response
    )) as { state: string; enqueued: boolean };
    assert.equal(recovered.state, "running");
    assert.equal(recovered.enqueued, true);
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 1);
  });
});

test("answered Decision retry returns durable facts when requester Session is closed", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Persist answer before requester closes",
    })) as { request: { id: string } };
    const mount = svc.ctx.host.require(workspaceId);
    const task = await loadTaskEnvelope(mount.env.fs, taskPath);
    const request = await svc.ctx.decisionRequests.getExactById(
      workspaceId,
      requested.request.id
    );
    assert.ok(request && request.status === "pending");
    const response = { kind: "custom" as const, text: "durable" };
    const prepared = prepareDecisionResponse({
      request: {
        id: request.id,
        taskId: request.taskId,
        requester: request.requester,
        target: request.target,
        question: request.question,
        options: request.options,
        status: "pending",
      },
      responder: { kind: "user", id: "user" },
      response,
      binding: {
        workspaceId,
        taskPath,
        taskId: task.id!,
        sessionId: executor.sessionId,
      },
      now: new Date().toISOString(),
    });
    await svc.ctx.taskInputs.add(prepared.taskInput);
    await svc.ctx.decisionRequests.answerExact({
      workspaceId,
      taskPath,
      requestId: request.id,
      responder: { kind: "user", id: "user" },
      response,
    });
    await svc.runtime.registry.update(executor.sessionId, { state: "stopped" });
    const taskBefore = await mount.env.fs.readFile(taskPath);

    const replay = (await root.decisionRequestRespond(workspaceId, request.id, response)) as {
      request: { status: string };
      state: string;
      enqueued: boolean;
    };
    assert.equal(replay.request.status, "answered");
    assert.equal(replay.state, "waiting");
    assert.equal(replay.enqueued, false);
    assert.equal(await mount.env.fs.readFile(taskPath), taskBefore);
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 1);
  });
});

test("pending response rejects a closed requester Session before creating TaskInput", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Respond only while requester remains open",
    })) as { request: { id: string } };

    await root.sessionLeave(executor.sessionId, workspaceId);
    await assert.rejects(
      () =>
        root.decisionRequestRespond(workspaceId, requested.request.id, {
          kind: "custom",
          text: "late",
        }),
      /waiting for user input|registry binding is stale/
    );
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 0);
    assert.equal(
      (await svc.ctx.decisionRequests.getExactById(workspaceId, requested.request.id))?.status,
      "pending"
    );
  });
});

test("Role target alone may escalate the same request id to user", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "role", id: "rl-reviewer" },
    });
    const reviewerExternalKey = `codex:${Math.random().toString(36).slice(2)}`;
    const reviewer = await enterRole(
      svc,
      workspaceId,
      workspace,
      "rl-reviewer",
      reviewerExternalKey
    );
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Escalate this?",
    })) as { request: { id: string; target: { kind: string; id: string } } };
    assert.deepEqual(requested.request.target, { kind: "role", id: "rl-reviewer" });

    const userBefore = (await root.decisionRequestListPending(workspaceId)) as {
      requests: unknown[];
    };
    assert.equal(userBefore.requests.length, 0);
    const rolePending = (await reviewer.client.decisionRequestListPending(workspaceId)) as {
      requests: Array<{ id: string }>;
    };
    assert.deepEqual(rolePending.requests.map((row) => row.id), [requested.request.id]);

    const externalKeyOnly = createServiceClient({
      baseUrl: svc.url,
      token: svc.token,
      currentExternalKey: reviewerExternalKey,
    });
    await assert.rejects(
      () =>
        externalKeyOnly.decisionRequestEscalate(
          workspaceId,
          taskPath,
          requested.request.id
        ),
      /frozen Decision Request target|forbidden/i,
      "a machine token plus bare externalKey must remain user authority"
    );

    await assert.rejects(
      () => executor.client.decisionRequestEscalate(workspaceId, taskPath, requested.request.id),
      /frozen Decision Request target|forbidden/i
    );
    const escalated = (await reviewer.client.decisionRequestEscalate(
      workspaceId,
      taskPath,
      requested.request.id
    )) as { request: { id: string; target: { kind: string; id: string } } };
    assert.equal(escalated.request.id, requested.request.id);
    assert.deepEqual(escalated.request.target, { kind: "user", id: "user" });

    const answered = (await root.decisionRequestRespond(
      workspaceId,
      requested.request.id,
      { kind: "deny" }
    )) as { request: { status: string; response: { kind: string } } };
    assert.equal(answered.request.status, "answered");
    assert.deepEqual(answered.request.response, { kind: "deny" });
  });
});

test("escalation and response serialize on the exact Task lifecycle", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "role", id: "rl-reviewer" },
    });
    const reviewer = await enterRole(svc, workspaceId, workspace, "rl-reviewer");
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Serialize this?",
    })) as { request: { id: string } };

    const entered = deferred();
    const release = deferred();
    const originalEscalate = svc.ctx.decisionRequests.escalateExact.bind(
      svc.ctx.decisionRequests
    );
    svc.ctx.decisionRequests.escalateExact = async (...args) => {
      entered.resolve();
      await release.promise;
      return originalEscalate(...args);
    };
    const escalating = reviewer.client.decisionRequestEscalate(
      workspaceId,
      taskPath,
      requested.request.id
    );
    await entered.promise;
    const racingResponse = reviewer.client.decisionRequestRespond(
      workspaceId,
      requested.request.id,
      { kind: "custom", text: "stale role answer" }
    );
    release.resolve();
    await escalating;
    await assert.rejects(racingResponse, /frozen Decision Request target|forbidden/i);
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 0);
    await root.decisionRequestRespond(workspaceId, requested.request.id, {
      kind: "deny",
    });
  });
});

test("task.sendInput rechecks DecisionRequest under the exact mutation boundary", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Block racing input?",
    });
    const originalGet = svc.ctx.decisionRequests.getPendingForTask.bind(
      svc.ctx.decisionRequests
    );
    let reads = 0;
    svc.ctx.decisionRequests.getPendingForTask = async (...args) => {
      reads += 1;
      return reads === 1 ? undefined : originalGet(...args);
    };
    await assert.rejects(
      () => root.taskSendInput(workspaceId, taskPath, { text: "racing input" }),
      /pending Decision Request/
    );
    assert.ok(reads >= 2, "sendInput must re-read the decision inside the lock");
    assert.equal((await svc.ctx.taskInputs.listForTask(workspaceId, taskPath)).length, 0);
  });
});

test("terminal Task cleanup removes pending DecisionRequest and stale rows stay hidden", async () => {
  const workspace = await makeWorkspace();
  await withService(async (svc) => {
    const { root, workspaceId, taskPath, executor } = await createRunningRoleTask({
      svc,
      workspace,
      parentActor: { kind: "user", id: "user" },
    });
    const requested = (await executor.client.taskRequestDecision(workspaceId, taskPath, {
      question: "Will be interrupted",
    })) as {
      request: {
        id: string;
        taskId: string;
        requester: { kind: "session"; id: string };
        target: { kind: "user"; id: "user" };
        question: string;
        options: [];
      };
    };
    await root.taskInterrupt(workspaceId, taskPath);
    assert.equal(
      await svc.ctx.decisionRequests.getPendingForTask(workspaceId, taskPath),
      undefined
    );

    const second = await createRunningConnectionTask({
      svc,
      workspace,
    });
    const stale = (await second.executor.taskRequestDecision(
      second.workspaceId,
      second.taskPath,
      { question: "Cleanup failure stays terminal" }
    )) as { request: { id: string } };
    const originalRemove = svc.ctx.decisionRequests.removePendingForTask.bind(
      svc.ctx.decisionRequests
    );
    let failCleanup = true;
    svc.ctx.decisionRequests.removePendingForTask = async (...args) => {
      if (failCleanup) {
        failCleanup = false;
        throw new Error("injected DecisionRequest cleanup failure");
      }
      return originalRemove(...args);
    };
    const cleanupEvents: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = svc.ctx.events.subscribe((event) => {
      if (event.type === "decisionRequest.resolved") cleanupEvents.push(event);
    });
    await second.root.taskInterrupt(second.workspaceId, second.taskPath);
    unsubscribe();
    const terminal = (await second.root.taskGet(
      second.workspaceId,
      second.taskPath
    )) as { task: { state: string } };
    assert.equal(terminal.task.state, "interrupted");
    const probe = await svc.runtime.probe(second.sessionId);
    assert.equal(probe.alive, false, "managed Session must stop despite request cleanup failure");
    assert.ok(
      cleanupEvents.some(
        (event) =>
          (event.payload as { cleanupFailed?: boolean }).cleanupFailed === true
      ),
      "cleanup failure must emit a non-authoritative diagnostic invalidation"
    );
    assert.equal(
      (await svc.ctx.decisionRequests.getPendingForTask(
        second.workspaceId,
        second.taskPath
      ))?.id,
      stale.request.id,
      "cleanup failure may retain only a hidden machine row after terminal transition"
    );

    const pending = (await second.root.decisionRequestListPending(second.workspaceId)) as {
      requests: unknown[];
    };
    assert.deepEqual(pending.requests, [], "terminal Task requests must not project as pending");
    await assert.rejects(
      () =>
        second.root.decisionRequestGet(
          second.workspaceId,
          second.taskPath,
          stale.request.id
        ),
      /not found for active exact Task/
    );
    await assert.rejects(
      () =>
        second.root.decisionRequestRespond(
          second.workspaceId,
          stale.request.id,
          {
            kind: "deny",
          }
        ),
      /terminal Task/
    );
  });
});
