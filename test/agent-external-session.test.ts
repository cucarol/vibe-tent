/**
 * V0.2 external / pull-host session lifecycle:
 * - Runtime enterExternalSession (no ACP spawn)
 * - Service RPC session.enter / status / leave
 * - CLI tent session enter|status|leave (+ hook aliases)
 * - Idempotency, non-Tent silent exit 0 for hooks
 * - leave never deliver/accept
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import {
  createAgentRuntime,
  makeSessionId,
  SessionRegistry,
  EXTERNAL_ADAPTER_ID,
} from "../src/runtime/index.js";
import {
  buildHookExternalKey,
  normalizeSessionSub,
  parseNativeHookStdin,
  pickNativeSessionId,
  runSessionCommand,
} from "../src/cli/session-rpc.js";
import { recordExternalKey } from "../src/runtime/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeWorkspace(name = "ext-sess"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "dispatch" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (
    svc: Awaited<ReturnType<typeof startLocalTentService>>,
    dataDir: string
  ) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

test("normalizeSessionSub maps public + hook aliases", () => {
  assert.equal(normalizeSessionSub("enter"), "enter");
  assert.equal(normalizeSessionSub("session-start"), "enter");
  assert.equal(normalizeSessionSub("status"), "status");
  assert.equal(normalizeSessionSub("session-status"), "status");
  assert.equal(normalizeSessionSub("leave"), "leave");
  assert.equal(normalizeSessionSub("session-end"), "leave");
  assert.equal(normalizeSessionSub("nope"), null);
});

test("SessionRegistry.isOpen includes external; isNonTerminal does not", () => {
  assert.equal(SessionRegistry.isNonTerminal("external"), false);
  assert.equal(SessionRegistry.isOpen("external"), true);
  assert.equal(SessionRegistry.isOpen("live"), true);
  assert.equal(SessionRegistry.isOpen("stopped"), false);
});

test("runtime enterExternalSession: no process, state=external, idempotent", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-rt-"));
  const runtime = createAgentRuntime({ dataDir });
  try {
    const sessionId = makeSessionId(() => 0.42);
    const h1 = await runtime.enterExternalSession({
      sessionId,
      roleName: "executor",
      workspace: "ws-1",
      externalKey: "gui-key-1",
      cwd: dataDir,
    });
    assert.equal(h1.sessionId, sessionId);
    assert.equal(h1.state, "external");
    assert.equal(h1.adapterId, EXTERNAL_ADAPTER_ID);
    assert.equal(runtime.supervisor.isAlive(sessionId), false);

    const probe = await runtime.probe(sessionId);
    assert.equal(probe.state, "external");
    assert.equal(probe.alive, true);
    assert.equal(probe.resumeCapable, false);

    // Idempotent re-enter with same id
    const h2 = await runtime.enterExternalSession({
      sessionId,
      roleName: "executor",
      workspace: "ws-1",
      externalKey: "gui-key-1",
    });
    assert.equal(h2.sessionId, sessionId);
    assert.equal(h2.state, "external");

    // externalKey alone reuses
    const h3 = await runtime.enterExternalSession({
      externalKey: "gui-key-1",
      workspace: "ws-1",
    });
    assert.equal(h3.sessionId, sessionId);

    await runtime.stopSession(sessionId, "user");
    const after = await runtime.probe(sessionId);
    assert.equal(after.state, "stopped");
    assert.equal(after.alive, false);
  } finally {
    await runtime.shutdown();
  }
});

test("service RPC session.enter/status/leave: idempotent, no deliver", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const entered = (await client.sessionEnter({
      workspaceId,
      roleName: "executor",
      externalKey: "rpc-key-a",
      cwd: ws,
    })) as {
      session: { sessionId: string; state: string; adapterId: string; alive: boolean };
      reused: boolean;
    };
    assert.equal(entered.session.state, "external");
    assert.equal(entered.session.adapterId, EXTERNAL_ADAPTER_ID);
    assert.equal(entered.session.alive, true);
    assert.equal(entered.reused, false);
    const sessionId = entered.session.sessionId;
    assert.ok(sessionId.startsWith("ss-"));

    // Idempotent enter
    const again = (await client.sessionEnter({
      workspaceId,
      sessionId,
      externalKey: "rpc-key-a",
    })) as { session: { sessionId: string }; reused: boolean };
    assert.equal(again.session.sessionId, sessionId);
    assert.equal(again.reused, true);

    // Dispatch + claim with this session so leave can report incomplete
    const note = (await client.call("docs.createNote", {
      workspaceId,
      name: "work-item",
      type: "prompt",
      body: "# work\n",
    })) as { id: string };
    // Prefer task.dispatch if available via client helper
    const dispatched = (await client.taskDispatch(workspaceId, {
      nodeIds: [note.id],
      role: "executor",
      prompt: "do the thing",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    })) as { taskPath: string };
    await client.taskClaim(workspaceId, dispatched.taskPath, sessionId);

    const status = (await client.sessionStatus({
      workspaceId,
      sessionId,
    })) as {
      session: { state: string };
      open: boolean;
      incompleteTasks: Array<{ path: string; state: string }>;
    };
    assert.equal(status.session.state, "external");
    assert.equal(status.open, true);
    assert.ok(status.incompleteTasks.length >= 1);
    assert.equal(status.incompleteTasks[0]!.state, "running");

    const left = (await client.sessionLeave(sessionId, workspaceId)) as {
      sessionId: string;
      state: string;
      left: boolean;
      delivered: boolean;
      accepted: boolean;
      incompleteTasks: Array<{ path: string; state: string }>;
    };
    assert.equal(left.left, true);
    assert.equal(left.state, "stopped");
    assert.equal(left.delivered, false);
    assert.equal(left.accepted, false);
    assert.ok(left.incompleteTasks.length >= 1);
    // Task still running — leave must not complete it
    const task = (await client.taskGet(workspaceId, dispatched.taskPath)) as {
      task: { state: string; sessionId?: string };
    };
    assert.equal(task.task.state, "running");
    assert.equal(task.task.sessionId, sessionId);

    // Idempotent leave
    const left2 = (await client.sessionLeave(sessionId, workspaceId)) as {
      left: boolean;
      alreadyLeft: boolean;
      delivered: boolean;
    };
    assert.equal(left2.left, false);
    assert.equal(left2.alreadyLeft, true);
    assert.equal(left2.delivered, false);

    // dataDir used so service endpoint exists under test isolation
    assert.ok(dataDir);
  });
});

test("CLI session enter/status/leave via service", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.mount(ws);

    const enter = await runSessionCommand(
      "enter",
      ["--role", "executor", "--key", "cli-key-1", "--json"],
      { client, cwd: ws, dataDir, packageRoot: repoRoot }
    );
    assert.equal(enter.exitCode, 0, enter.stderr);
    const enterBody = JSON.parse(enter.stdout) as {
      session: { sessionId: string; state: string };
      reused: boolean;
    };
    assert.equal(enterBody.session.state, "external");
    const sessionId = enterBody.session.sessionId;

    const enter2 = await runSessionCommand(
      "enter",
      ["--session", sessionId, "--json"],
      { client, cwd: ws, dataDir }
    );
    assert.equal(enter2.exitCode, 0, enter2.stderr);
    const enter2Body = JSON.parse(enter2.stdout) as { reused: boolean };
    assert.equal(enter2Body.reused, true);

    const status = await runSessionCommand("status", [sessionId, "--json"], {
      client,
      cwd: ws,
      dataDir,
    });
    assert.equal(status.exitCode, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      session: { sessionId: string; state: string };
      open: boolean;
    };
    assert.equal(statusBody.session.sessionId, sessionId);
    assert.equal(statusBody.open, true);

    const leave = await runSessionCommand("leave", [sessionId, "--json"], {
      client,
      cwd: ws,
      dataDir,
    });
    assert.equal(leave.exitCode, 0, leave.stderr);
    const leaveBody = JSON.parse(leave.stdout) as {
      left: boolean;
      delivered: boolean;
      accepted: boolean;
      state: string;
    };
    assert.equal(leaveBody.left, true);
    assert.equal(leaveBody.delivered, false);
    assert.equal(leaveBody.accepted, false);
    assert.equal(leaveBody.state, "stopped");
  });
});

test("hook alias session-start outside Tent: silent exit 0", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws-"));
  const result = await runSessionCommand("session-start", ["--json"], {
    cwd: nonTent,
    attachOnly: true,
    dataDir: path.join(os.tmpdir(), "no-svc-" + Date.now()),
    skipStdin: true,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as { skipped: boolean; reason: string };
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "not-a-tent-workspace");
});

test("public enter outside Tent: fail-loud (not silent)", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws2-"));
  const result = await runSessionCommand("enter", ["--json"], {
    cwd: nonTent,
    attachOnly: true,
    dataDir: path.join(os.tmpdir(), "no-svc2-" + Date.now()),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Not inside a Tent/i);
});

test("hook session-end outside Tent: silent exit 0", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws3-"));
  const result = await runSessionCommand(
    "session-end",
    ["ss-doesnotmatter", "--json"],
    {
      cwd: nonTent,
      attachOnly: true,
      dataDir: path.join(os.tmpdir(), "no-svc3-" + Date.now()),
      skipStdin: true,
    }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout) as {
    skipped: boolean;
    delivered: boolean;
    accepted: boolean;
  };
  assert.equal(body.skipped, true);
  assert.equal(body.delivered, false);
  assert.equal(body.accepted, false);
});

test("buildHookExternalKey: host+nativeSessionId or host+workspace fallback", () => {
  assert.equal(
    buildHookExternalKey({ host: "Codex", nativeSessionId: "abc-123" }),
    "codex:abc-123"
  );
  assert.equal(
    buildHookExternalKey({
      host: "claude",
      workspaceRoot: "C:\\proj\\MyRepo\\",
    }),
    "claude:ws:c:/proj/myrepo"
  );
  // No host → refuse (no silent orphan key)
  assert.equal(
    buildHookExternalKey({ nativeSessionId: "x", workspaceRoot: "/w" }),
    undefined
  );
  assert.equal(buildHookExternalKey({ host: "agy" }), undefined);
});

test("parseNativeHookStdin + pickNativeSessionId accept common fields", () => {
  const a = parseNativeHookStdin(
    JSON.stringify({ session_id: "nat-1", cwd: "/ws" })
  );
  assert.equal(pickNativeSessionId(a), "nat-1");
  const b = parseNativeHookStdin(
    JSON.stringify({ sessionId: "nat-2", workspace: "/ws2" })
  );
  assert.equal(pickNativeSessionId(b), "nat-2");
  assert.equal(parseNativeHookStdin(""), null);
  assert.equal(parseNativeHookStdin("not-json"), null);
});

test("runtime stores first-class externalKey only", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ext-key-"));
  const runtime = createAgentRuntime({ dataDir });
  try {
    const h = await runtime.enterExternalSession({
      externalKey: "explicit-key-1",
      workspace: "ws-k",
      roleName: "executor",
    });
    const rec = await runtime.registry.read(h.sessionId);
    assert.equal(rec?.externalKey, "explicit-key-1");
    assert.equal(recordExternalKey(rec!), "explicit-key-1");
    // Key lives only on the first-class field — not profile env.
    assert.equal(rec?.profileSnapshot?.env, undefined);
    // Env-only / missing first-class field → no key (no legacy fallback).
    assert.equal(recordExternalKey({}), undefined);
    assert.equal(recordExternalKey({ externalKey: "  " }), undefined);
  } finally {
    await runtime.shutdown();
  }
});

test("service status/leave resolve by externalKey without sessionId", async () => {
  await withService(async (svc) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = (await client.mount(ws)) as { workspaceId: string };
    const workspaceId = mounted.workspaceId;

    const entered = (await client.sessionEnter({
      workspaceId,
      externalKey: "lookup-key-1",
      roleName: "executor",
      cwd: ws,
    })) as { session: { sessionId: string; externalKey?: string } };
    assert.equal(entered.session.externalKey, "lookup-key-1");
    const sessionId = entered.session.sessionId;

    const status = (await client.sessionStatus({
      workspaceId,
      externalKey: "lookup-key-1",
    })) as {
      session: { sessionId: string; externalKey?: string; state: string };
      open: boolean;
    };
    assert.equal(status.session.sessionId, sessionId);
    assert.equal(status.session.externalKey, "lookup-key-1");
    assert.equal(status.open, true);

    const left = (await client.sessionLeave({
      externalKey: "lookup-key-1",
      workspaceId,
    })) as {
      sessionId: string;
      left: boolean;
      delivered: boolean;
      accepted: boolean;
    };
    assert.equal(left.sessionId, sessionId);
    assert.equal(left.left, true);
    assert.equal(left.delivered, false);
    assert.equal(left.accepted, false);

    const left2 = (await client.sessionLeave({
      externalKey: "lookup-key-1",
      workspaceId,
    })) as { alreadyLeft: boolean; left: boolean };
    assert.equal(left2.alreadyLeft, true);
    assert.equal(left2.left, false);
  });
});

test("hook session-start → status → session-end closed loop via --host + stdin (no sessionId file)", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.mount(ws);

    const stdinStart = JSON.stringify({
      session_id: "provider-sess-42",
      cwd: ws,
    });
    const start = await runSessionCommand(
      "session-start",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        packageRoot: repoRoot,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(start.exitCode, 0, start.stderr);
    const startBody = JSON.parse(start.stdout) as {
      session: { sessionId: string; externalKey?: string; state: string };
      reused: boolean;
    };
    assert.equal(startBody.session.state, "external");
    assert.equal(startBody.session.externalKey, "codex:provider-sess-42");
    assert.equal(startBody.reused, false);
    const sessionId = startBody.session.sessionId;

    // Re-enter same host+native id reuses (idempotent) without knowing ss-
    const start2 = await runSessionCommand(
      "session-start",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(start2.exitCode, 0, start2.stderr);
    const start2Body = JSON.parse(start2.stdout) as {
      session: { sessionId: string };
      reused: boolean;
    };
    assert.equal(start2Body.session.sessionId, sessionId);
    assert.equal(start2Body.reused, true);

    // status without sessionId — only --host + same stdin
    const status = await runSessionCommand(
      "session-status",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(status.exitCode, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout) as {
      session: { sessionId: string; externalKey?: string };
      open: boolean;
    };
    assert.equal(statusBody.session.sessionId, sessionId);
    assert.equal(statusBody.session.externalKey, "codex:provider-sess-42");
    assert.equal(statusBody.open, true);

    // end in a "separate process" style call: no sessionId positional
    const end = await runSessionCommand(
      "session-end",
      ["--host", "codex", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        stdinText: stdinStart,
        skipStdin: true,
      }
    );
    assert.equal(end.exitCode, 0, end.stderr);
    const endBody = JSON.parse(end.stdout) as {
      sessionId: string;
      left: boolean;
      delivered: boolean;
      accepted: boolean;
      state: string;
    };
    assert.equal(endBody.sessionId, sessionId);
    assert.equal(endBody.left, true);
    assert.equal(endBody.delivered, false);
    assert.equal(endBody.accepted, false);
    assert.equal(endBody.state, "stopped");
  });
});

test("hook session-start without native id uses host+workspace fallback; no host fails loud in Tent", async () => {
  await withService(async (svc, dataDir) => {
    const ws = await makeWorkspace();
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.mount(ws);

    // No host → refuse enter (would create un-findable orphans)
    const noHost = await runSessionCommand("session-start", ["--json"], {
      client,
      cwd: ws,
      dataDir,
      skipStdin: true,
      stdinText: "",
    });
    assert.equal(noHost.exitCode, 1);
    assert.match(noHost.stderr, /externalKey|orphan|--host/i);

    // host + workspace fallback (empty stdin, no session_id)
    const start = await runSessionCommand(
      "session-start",
      ["--host", "claude", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        skipStdin: true,
        stdinText: "",
      }
    );
    assert.equal(start.exitCode, 0, start.stderr);
    const startBody = JSON.parse(start.stdout) as {
      session: { sessionId: string; externalKey?: string };
    };
    const expectedKey = buildHookExternalKey({
      host: "claude",
      workspaceRoot: ws,
    });
    assert.equal(startBody.session.externalKey, expectedKey);

    const end = await runSessionCommand(
      "session-end",
      ["--host", "claude", "--json"],
      {
        client,
        cwd: ws,
        dataDir,
        skipStdin: true,
        stdinText: "",
      }
    );
    assert.equal(end.exitCode, 0, end.stderr);
    const endBody = JSON.parse(end.stdout) as { left: boolean; sessionId: string };
    assert.equal(endBody.left, true);
    assert.equal(endBody.sessionId, startBody.session.sessionId);
  });
});

test("hook aliases silent outside Tent even with --host", async () => {
  const nonTent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-not-ws4-"));
  const result = await runSessionCommand(
    "session-start",
    ["--host", "codex", "--json"],
    {
      cwd: nonTent,
      attachOnly: true,
      dataDir: path.join(os.tmpdir(), "no-svc4-" + Date.now()),
      skipStdin: true,
      stdinText: JSON.stringify({ session_id: "x", cwd: nonTent }),
    }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const body = JSON.parse(result.stdout) as { skipped: boolean };
  assert.equal(body.skipped, true);
});
