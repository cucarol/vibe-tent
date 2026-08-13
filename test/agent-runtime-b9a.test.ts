/**
 * B9a · Agent Supervisor + SessionRegistry + Fake ProviderAdapter
 * Uses only the fake provider — no real paid/network agent requests.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createFakeAdapter, FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import type { ProviderAdapter } from "../src/adapters/types.js";
import {
  createAgentRuntime,
  createAgentConnectionSnapshot,
  makeSessionId,
  ProcessSupervisor,
  SessionRegistry,
  type RuntimeEvent,
  type AgentConnectionConfig,
  type StartSessionRequest,
} from "../src/runtime/index.js";

async function tempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tent-b9a-"));
}

async function tempCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tent-b9a-cwd-"));
}

function startConnection(
  runtime: ReturnType<typeof createAgentRuntime>,
  request: StartSessionRequest & { connectionId: string }
) {
  const { connectionId, ...start } = request;
  const workspace = start.workspace ?? start.workspaceLane?.workspace ?? start.runtimeWorkspace?.cwd ?? start.cwd;
  if (!workspace) throw new Error("test start requires a workspace");
  const currentTaskId = start.currentTaskId ?? `tk-${start.sessionId.replace(/[^a-z0-9]/gi, "")}`;
  return runtime.reserveSession({
    sessionId: start.sessionId,
    connectionId,
    currentTaskId,
    workspace,
    workspaceLane: start.workspaceLane,
    runtimeWorkspace: start.runtimeWorkspace,
    cwd: start.cwd,
  }).then(() => runtime.startSession({ ...start, currentTaskId, workspace }));
}

function testConnection(connectionId: string, adapterId: string, extra: Omit<AgentConnectionConfig, "connectionId" | "provider" | "adapterId"> = {}): AgentConnectionConfig {
  return { connectionId, provider: "test", adapterId, ...extra };
}

function snapshot(connectionId: string, adapterId: string) {
  return createAgentConnectionSnapshot(testConnection(connectionId, adapterId), {});
}

function waitFor(
  events: RuntimeEvent[],
  type: RuntimeEvent["type"],
  sessionId: string,
  timeoutMs = 5000
): Promise<RuntimeEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = events.find((e) => e.type === type && e.sessionId === sessionId);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `timeout waiting for ${type} on ${sessionId}; got ${events.map((e) => e.type).join(",")}`
          )
        );
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("makeSessionId uses ss- prefix", () => {
  const id = makeSessionId(() => 0.1);
  assert.match(id, /^ss-[0-9a-z]+$/);
});

test("SessionRegistry persists and lists machine-local sessions", async () => {
  const dataDir = await tempDataDir();
  const reg = new SessionRegistry(dataDir);
  const now = new Date().toISOString();
  await reg.write({
    id: "ss-test01",
    connectionId: "fake-default",
    adapterId: FAKE_ADAPTER_ID,
    connectionSnapshot: snapshot("fake-default", FAKE_ADAPTER_ID),
    state: "live",
    pid: 42,
    runtimeWorkspace: { cwd: "C:\\work" },
    createdAt: now,
    updatedAt: now,
  });
  const read = await reg.read("ss-test01");
  assert.ok(read);
  assert.equal(read!.pid, 42);
  assert.equal(read!.runtimeWorkspace?.cwd, "C:\\work");

  const listed = await reg.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "ss-test01");

  // Path is under dataDir/sessions — not workspace
  const file = path.join(dataDir, "sessions", "ss-test01.json");
  await fs.access(file);
});

test("startSession / probe / stopSession with fake provider (no paid requests)", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1500 });
  runtime.registerConnection(testConnection("fake-default", FAKE_ADAPTER_ID));
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-live001";
  const handle = await startConnection(runtime, {
    sessionId,
    connectionId: "fake-default",
    runtimeWorkspace: { cwd },
    workspaceLane: {
      workspace: cwd,
      worktree: cwd,
      branch: "tent-role/ACP适配Grok",
    },
    bootstrapPrompt: "relay: claim task and do work",
  });

  assert.equal(handle.state, "live");
  assert.ok(handle.pid && handle.pid > 0);
  assert.equal(handle.adapterId, FAKE_ADAPTER_ID);

  await waitFor(events, "session.starting", sessionId);
  await waitFor(events, "session.live", sessionId);

  const probeLive = await runtime.probe(sessionId);
  assert.equal(probeLive.isAlive, true);
  assert.equal(probeLive.state, "live");

  await runtime.stopSession(sessionId, "user");
  await waitFor(events, "session.exited", sessionId);

  const probeStopped = await runtime.probe(sessionId);
  assert.equal(probeStopped.isAlive, false);
  assert.ok(probeStopped.state === "stopped" || probeStopped.state === "failed");

  await runtime.shutdown();
});

test("launch failure records session.failed without spawning paid provider", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir });
  runtime.registerConnection(testConnection("fake-broken", FAKE_ADAPTER_ID, {
    fake: { failLaunch: "missing binary: codex" },
  }));
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-fail001";
  await assert.rejects(
    () =>
      startConnection(runtime, {
        sessionId,
        connectionId: "fake-broken",
        cwd,
      }),
    /missing binary/
  );

  await waitFor(events, "session.failed", sessionId);
  const probe = await runtime.probe(sessionId);
  assert.equal(probe.isAlive, false);
  assert.equal(probe.state, "failed");
  assert.match(probe.lastError ?? "", /missing binary/);

  await runtime.shutdown();
});

test("ProcessSupervisor rejects missing executables without an unhandled child error", async () => {
  const cwd = await tempCwd();
  const supervisor = new ProcessSupervisor();
  await assert.rejects(
    () =>
      supervisor.start("ss-missingbin", {
        command: "tent-command-that-does-not-exist-7f9c",
        args: [],
        cwd,
        env: {},
      }),
    /Failed to spawn process.*ENOENT/i
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(supervisor.listLive(), []);
  assert.equal(supervisor.get("ss-missingbin"), null);
});

test("runtime records missing provider command as an ordinary failed session", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const adapter: ProviderAdapter = {
    id: "missing-process-adapter",
    displayNameKey: "missing-process-adapter",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: false,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "process",
    }),
    resolveLaunch: (plan) => ({
      command: "tent-command-that-does-not-exist-7f9c",
      args: [],
      cwd: plan.cwd,
      env: {},
    }),
    mapExit: (_code, _signal) => ({
      type: "session.failed",
      sessionId: "unused",
      error: "unused",
    }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("missing-process", adapter.id)],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));

  const sessionId = "ss-missingproc";
  await assert.rejects(
    () => startConnection(runtime, { sessionId, connectionId: "missing-process", cwd }),
    /Failed to spawn process.*ENOENT/i
  );

  const record = await runtime.registry.read(sessionId);
  assert.equal(record?.state, "failed");
  assert.equal(runtime.supervisor.isAlive(sessionId), false);
  assert.equal(events.filter((event) => event.type === "session.failed").length, 1);

  await runtime.shutdown();
});

test("managed terminal during startup cannot be overwritten back to live", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const adapter: ProviderAdapter = {
    id: "managed-start-fail",
    displayNameKey: "managed-start-fail",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed adapter should not resolve a process launch");
    },
    startManagedSession: async (plan, emit) => {
      emit({
        type: "session.failed",
        sessionId: plan.sessionId,
        error: "provider failed during startup",
      });
      return {
        sessionId: plan.sessionId,
        isAlive: () => false,
        stop: async () => undefined,
      };
    },
    mapExit: (_code, _signal) => ({
      type: "session.failed",
      sessionId: "unused",
      error: "unused",
    }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("managed-start-fail", adapter.id)],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));

  const sessionId = "ss-fastfail";
  await assert.rejects(
    () => startConnection(runtime, { sessionId, connectionId: "managed-start-fail", cwd }),
    /provider failed during startup/
  );

  const probe = await runtime.probe(sessionId);
  assert.equal(probe.isAlive, false);
  assert.equal(probe.state, "failed");
  assert.equal(
    events.filter((event) => event.type === "session.failed").length,
    1,
    "startup failure must emit one terminal event"
  );
  assert.equal(
    events.some((event) => event.type === "session.live"),
    false,
    "terminal startup must never project live"
  );

  await runtime.shutdown();
});

test("managed terminal retries a transient registry failure without an unhandled rejection", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  let emitRuntime!: (event: RuntimeEvent) => void;
  let alive = true;
  const adapter: ProviderAdapter = {
    id: "managed-terminal-retry",
    displayNameKey: "managed-terminal-retry",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed adapter should not resolve a process launch");
    },
    startManagedSession: async (plan, emit) => {
      emitRuntime = emit;
      return {
        sessionId: plan.sessionId,
        isAlive: () => alive,
        stop: async () => {
          alive = false;
        },
      };
    },
    mapExit: (_code, _signal) => ({
      type: "session.failed",
      sessionId: "unused",
      error: "unused",
    }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("managed-terminal-retry", adapter.id)],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const sessionId = "ss-termretry";
  await startConnection(runtime, { sessionId, connectionId: "managed-terminal-retry", cwd });

  const originalUpdate = runtime.registry.update.bind(runtime.registry);
  let failedWrites = 0;
  runtime.registry.update = async (id, patch) => {
    if (patch.state === "failed" && failedWrites++ === 0) {
      throw new Error("injected transient terminal write failure");
    }
    return originalUpdate(id, patch);
  };

  alive = false;
  emitRuntime({ type: "session.failed", sessionId, error: "provider failed" });
  const deadline = Date.now() + 2_000;
  let record = await runtime.registry.read(sessionId);
  while (record?.state !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    record = await runtime.registry.read(sessionId);
  }

  assert.equal(failedWrites, 2);
  assert.equal(record?.state, "failed");
  assert.equal(record?.lastError, "provider failed");
  assert.equal(
    events.filter((event) => event.type === "session.failed").length,
    1,
    "retrying persistence must not duplicate the adapter terminal event"
  );

  await runtime.shutdown();
});

test("managed start stops provider when persisting live state fails", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  let alive = true;
  let stopCalls = 0;
  const adapter: ProviderAdapter = {
    id: "managed-persist-fail",
    displayNameKey: "managed-persist-fail",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed adapter should not resolve a process launch");
    },
    startManagedSession: async (plan) => {
      return {
        sessionId: plan.sessionId,
        pid: 4242,
        isAlive: () => alive,
        stop: async () => {
          stopCalls += 1;
          alive = false;
        },
      };
    },
    mapExit: (_code, _signal) => ({
      type: "session.failed",
      sessionId: "unused",
      error: "unused",
    }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("managed-persist-fail", adapter.id)],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));

  const originalUpdate = runtime.registry.update.bind(runtime.registry);
  let injected = false;
  runtime.registry.update = async (sessionId, patch) => {
    if (!injected && patch.state === "live") {
      injected = true;
      throw new Error("injected live-state persistence failure");
    }
    return originalUpdate(sessionId, patch);
  };

  const sessionId = "ss-persistfail";
  await assert.rejects(
    () => startConnection(runtime, { sessionId, connectionId: "managed-persist-fail", cwd }),
    /injected live-state persistence failure/
  );

  assert.equal(stopCalls, 1, "started managed provider must be stopped on rollback");
  assert.equal(alive, false);
  const record = await runtime.registry.read(sessionId);
  assert.equal(record?.state, "failed");
  assert.equal(record?.pid, undefined);
  assert.equal(
    events.some((event) => event.type === "session.live"),
    false,
    "live must not be published before its registry commit"
  );

  await runtime.shutdown();
});

test("process start is reaped when persisting live state fails", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 500 });
  runtime.registerConnection(testConnection("fake-default", FAKE_ADAPTER_ID));
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));

  const originalUpdate = runtime.registry.update.bind(runtime.registry);
  let injected = false;
  runtime.registry.update = async (sessionId, patch) => {
    if (!injected && patch.state === "live") {
      injected = true;
      throw new Error("injected process live-state persistence failure");
    }
    return originalUpdate(sessionId, patch);
  };

  const sessionId = "ss-procpersist";
  await assert.rejects(
    () => startConnection(runtime, { sessionId, connectionId: "fake-default", cwd }),
    /injected process live-state persistence failure/
  );

  assert.equal(runtime.supervisor.isAlive(sessionId), false);
  const record = await runtime.registry.read(sessionId);
  assert.equal(record?.state, "failed");
  assert.equal(record?.pid, undefined);
  assert.equal(
    events.some((event) => event.type === "session.live"),
    false,
    "live must not be published before its registry commit"
  );

  await runtime.shutdown();
});

test("natural non-zero exit maps to session.failed", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1000 });
  runtime.registerConnection(testConnection("fake-exit1", FAKE_ADAPTER_ID, {
    fake: { waitForSignal: false, sleepMs: 50, exitCode: 7, emitStdout: false },
  }));
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-exit007";
  await startConnection(runtime, { sessionId, connectionId: "fake-exit1", cwd });
  await waitFor(events, "session.failed", sessionId, 5000);

  const probe = await runtime.probe(sessionId);
  assert.equal(probe.isAlive, false);
  assert.equal(probe.state, "failed");

  await runtime.shutdown();
});

test("two live sessions do not cross-contaminate cwd", async () => {
  const dataDir = await tempDataDir();
  const cwdA = await tempCwd();
  const cwdB = await tempCwd();
  await fs.writeFile(path.join(cwdA, "marker-a.txt"), "A");
  await fs.writeFile(path.join(cwdB, "marker-b.txt"), "B");

  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1500 });
  runtime.registerConnection(testConnection("fake-default", FAKE_ADAPTER_ID));
  const idA = "ss-concura";
  const idB = "ss-concurb";

  const [ha, hb] = await Promise.all([
    startConnection(runtime, {
      sessionId: idA,
      connectionId: "fake-default",
      runtimeWorkspace: { cwd: cwdA },
    }),
    startConnection(runtime, {
      sessionId: idB,
      connectionId: "fake-default",
      runtimeWorkspace: { cwd: cwdB },
    }),
  ]);

  assert.notEqual(ha.pid, hb.pid);
  assert.equal(ha.runtimeWorkspace?.cwd, cwdA);
  assert.equal(hb.runtimeWorkspace?.cwd, cwdB);

  const diskA = await runtime.registry.read(idA);
  const diskB = await runtime.registry.read(idB);
  assert.equal(diskA?.runtimeWorkspace?.cwd, cwdA);
  assert.equal(diskB?.runtimeWorkspace?.cwd, cwdB);

  await runtime.stopSession(idA, "user");
  await runtime.stopSession(idB, "user");
  await runtime.shutdown();
});

test("concurrent starts for one session launch exactly one managed provider", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  let startCalls = 0;
  let stopCalls = 0;
  const adapter: ProviderAdapter = {
    id: "start-single-flight",
    displayNameKey: "adapter.startSingleFlight",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed-only test adapter");
    },
    startManagedSession: async (plan, emit) => {
      startCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      emit({ type: "session.live", sessionId: plan.sessionId, pid: 8100 + startCalls });
      return {
        sessionId: plan.sessionId,
        pid: 8100 + startCalls,
        isAlive: () => true,
        stop: async () => {
          stopCalls += 1;
        },
      };
    },
    mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("single-flight-connection", adapter.id)],
  });
  const request = {
    sessionId: "ss-startonce",
    connectionId: "single-flight-connection",
    cwd,
  };
  const currentTaskId = "tk-startonce";
  await runtime.reserveSession({
    sessionId: request.sessionId,
    connectionId: request.connectionId,
    currentTaskId,
    workspace: cwd,
    cwd,
  });
  const start = { sessionId: request.sessionId, currentTaskId, workspace: cwd, cwd };

  const results = await Promise.allSettled([
    runtime.startSession(start),
    runtime.startSession(start),
  ]);

  assert.equal(startCalls, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await runtime.shutdown();
  assert.equal(stopCalls, 1);
});

test("concurrent starts cannot tear down the winning CLI process", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1500 });
  runtime.registerConnection(testConnection("fake-default", FAKE_ADAPTER_ID));
  const request = {
    sessionId: "ss-clistart1",
    connectionId: "fake-default",
    cwd,
  };
  const currentTaskId = "tk-clistart1";
  await runtime.reserveSession({
    sessionId: request.sessionId,
    connectionId: request.connectionId,
    currentTaskId,
    workspace: cwd,
    cwd,
  });
  const start = { sessionId: request.sessionId, currentTaskId, workspace: cwd, cwd };

  const results = await Promise.allSettled([
    runtime.startSession(start),
    runtime.startSession(start),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await runtime.probe(request.sessionId)).isAlive, true);
  assert.deepEqual(runtime.supervisor.listLive(), [request.sessionId]);
  await runtime.shutdown();
});

test("shutdown waits for an in-flight managed start and rejects new work", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  let markStarted!: () => void;
  let releaseStart!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let stopCalls = 0;
  const adapter: ProviderAdapter = {
    id: "shutdown-start-race",
    displayNameKey: "adapter.shutdownStartRace",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed-only test adapter");
    },
    startManagedSession: async (plan, emit) => {
      markStarted();
      await release;
      emit({ type: "session.live", sessionId: plan.sessionId, pid: 8201 });
      return {
        sessionId: plan.sessionId,
        pid: 8201,
        isAlive: () => true,
        stop: async () => {
          stopCalls += 1;
        },
      };
    },
    mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("shutdown-connection", adapter.id)],
  });
  const start = startConnection(runtime, {
    sessionId: "ss-shutdownrace",
    connectionId: "shutdown-connection",
    cwd,
  });
  await started;

  const shutdown = runtime.shutdown();
  await assert.rejects(
    () =>
      startConnection(runtime, {
        sessionId: "ss-afterclose",
        connectionId: "shutdown-connection",
        cwd,
      }),
    /shut down/i
  );
  releaseStart();

  await start;
  await shutdown;
  assert.equal(stopCalls, 1);
  assert.equal(runtime.supervisor.listLive().length, 0);
});

test("shutdown stops push children (service-stop policy)", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1500 });
  runtime.registerConnection(testConnection("fake-default", FAKE_ADAPTER_ID));
  const sessionId = "ss-shut001";
  await startConnection(runtime, { sessionId, connectionId: "fake-default", cwd });
  assert.equal((await runtime.probe(sessionId)).isAlive, true);

  await runtime.shutdown();
  assert.equal(runtime.supervisor.listLive().length, 0);

  // New runtime on same disk sees non-alive process
  const runtime2 = createAgentRuntime({ dataDir });
  const probe = await runtime2.probe(sessionId);
  assert.equal(probe.isAlive, false);
  assert.ok(probe.state === "stopped" || probe.state === "failed");
  await runtime2.shutdown();
});

test("reconcileOnBoot marks dead non-resume sessions failed/stopped", async () => {
  const dataDir = await tempDataDir();
  const reg = new SessionRegistry(dataDir);
  const now = new Date().toISOString();
  await reg.write({
    id: "ss-zombie1",
    connectionId: "fake-default",
    adapterId: FAKE_ADAPTER_ID,
    connectionSnapshot: snapshot("fake-default", FAKE_ADAPTER_ID),
    state: "live",
    pid: 999999, // almost certainly dead
    createdAt: now,
    updatedAt: now,
    runtimeWorkspace: { cwd: await tempCwd() },
  });
  await reg.write({
    id: "ss-reservedboot",
    connectionId: "fake-default",
    adapterId: FAKE_ADAPTER_ID,
    connectionSnapshot: snapshot("fake-default", FAKE_ADAPTER_ID),
    state: "reserved",
    createdAt: now,
    updatedAt: now,
    runtimeWorkspace: { cwd: await tempCwd() },
  });

  const runtime = createAgentRuntime({ dataDir });
  const results = await runtime.reconcileOnBoot();
  assert.equal(results.length, 2);
  const zombie = results.find((result) => result.sessionId === "ss-zombie1");
  assert.ok(zombie);
  assert.equal(zombie!.isAlive, false);
  assert.ok(zombie!.state === "failed" || zombie!.state === "stopped");

  const rec = await reg.read("ss-zombie1");
  assert.ok(rec);
  assert.ok(rec!.state === "failed" || rec!.state === "stopped");
  const reserved = await reg.read("ss-reservedboot");
  assert.ok(reserved);
  assert.equal(reserved!.state, "failed");
  assert.match(reserved!.lastError ?? "", /did not reach provider start before Service restart/);
  await runtime.shutdown();
});

test("subscribe is session-scoped; no chat-router event types", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({
    dataDir,
    gracefulMs: 1500,
    captureStdout: true,
  });
  runtime.registerConnection(testConnection("fake-quick", FAKE_ADAPTER_ID, {
    fake: { waitForSignal: false, sleepMs: 80, exitCode: 0, emitStdout: true },
  }));

  const scoped: RuntimeEvent[] = [];
  const other: RuntimeEvent[] = [];
  const id = "ss-scope01";
  runtime.subscribe(id, (e) => scoped.push(e));
  runtime.subscribe("ss-otherxx", (e) => other.push(e));

  await startConnection(runtime, {
    sessionId: id,
    connectionId: "fake-quick",
    cwd,
    bootstrapPrompt: "hello-fake",
  });
  await waitFor(scoped, "session.exited", id, 5000);

  assert.ok(scoped.some((e) => e.type === "session.live"));
  assert.equal(other.length, 0);

  const allowed = new Set([
    "session.starting",
    "session.live",
    "session.waiting_user",
    "session.exited",
    "session.failed",
    "session.stdout_tail",
  ]);
  for (const e of scoped) {
    assert.ok(allowed.has(e.type), `unexpected event type ${e.type}`);
    assert.equal(
      (e as { message?: string }).message,
      undefined,
      "no chat message field on runtime events"
    );
  }

  await runtime.shutdown();
});

test("fake adapter remains the deterministic process harness", () => {
  const adapter = createFakeAdapter();
  assert.equal(adapter.id, "fake-cli");
  const caps = adapter.capabilities();
  assert.equal(caps.canSpawn, true);
  assert.equal(caps.authModel, "none");
  assert.equal(caps.observeLevel, "process");
});

test("concurrent native resume calls share one in-flight managed bridge", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  let resumeCalls = 0;
  let stopCalls = 0;
  const adapter: ProviderAdapter = {
    id: "resume-test",
    displayNameKey: "adapter.resumeTest",
    capabilities: () => ({
      canSpawn: true,
      canResume: true,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed-only test adapter");
    },
    resumeManagedSession: async (plan, token, emit) => {
      resumeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      emit({ type: "session.live", sessionId: plan.sessionId, pid: 4242 });
      return {
        sessionId: plan.sessionId,
        pid: 4242,
        providerSessionId: token.providerSessionId ?? token.raw,
        isAlive: () => true,
        stop: async () => {
          stopCalls += 1;
        },
      };
    },
    parseResumeToken: (raw) => ({ raw, providerSessionId: raw }),
    mapExit: (code) => ({
      type: "session.exited",
      sessionId: "",
      exitCode: code,
    }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("resume-connection", adapter.id)],
  });
  const sessionId = "ss-conresume";
  const now = new Date().toISOString();
  await runtime.registry.write({
    id: sessionId,
    connectionId: "resume-connection",
    adapterId: adapter.id,
    connectionSnapshot: snapshot("resume-connection", adapter.id),
    state: "stopped",
    resumeToken: "provider-session-1",
    runtimeWorkspace: { cwd },
    createdAt: now,
    updatedAt: now,
  });

  const [first, second] = await Promise.all([
    runtime.resumeSession({ sessionId, cwd }),
    runtime.resumeSession({ sessionId, cwd }),
  ]);
  assert.equal(resumeCalls, 1);
  assert.equal(first.sessionId, sessionId);
  assert.equal(second.sessionId, sessionId);
  await runtime.shutdown();
  assert.equal(stopCalls, 1);
});

test("native resume requires both provider conversation identities and exact equality", async () => {
  for (const missing of ["expected", "actual"] as const) {
    const dataDir = await tempDataDir();
    const cwd = await tempCwd();
    let stopCalls = 0;
    const adapter: ProviderAdapter = {
      id: `resume-identity-${missing}`,
      displayNameKey: "adapter.resumeIdentity",
      capabilities: () => ({
        canSpawn: true,
        canResume: true,
        canStopGraceful: true,
        needsTty: false,
        supportsWorktreeCwd: true,
        authModel: "none",
        observeLevel: "structured",
      }),
      resolveLaunch: () => {
        throw new Error("managed-only test adapter");
      },
      resumeManagedSession: async (plan, _token, emit) => {
        emit({ type: "session.live", sessionId: plan.sessionId, pid: 5150 });
        return {
          sessionId: plan.sessionId,
          pid: 5150,
          ...(missing === "actual" ? {} : { providerSessionId: "provider-exact" }),
          isAlive: () => true,
          stop: async () => {
            stopCalls += 1;
          },
        };
      },
      parseResumeToken: (raw) =>
        missing === "expected" ? { raw } : { raw, providerSessionId: "provider-exact" },
      mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
    };
    const connectionId = `resume-identity-${missing}`;
    const runtime = createAgentRuntime({
      dataDir,
      adapters: [adapter],
      connections: [testConnection(connectionId, adapter.id)],
    });
    const sessionId = `ss-identity${missing}`;
    const now = new Date().toISOString();
    await runtime.registry.write({
      id: sessionId,
      connectionId,
      adapterId: adapter.id,
      connectionSnapshot: snapshot(connectionId, adapter.id),
      state: "stopped",
      resumeToken: "provider-exact",
      runtimeWorkspace: { cwd },
      createdAt: now,
      updatedAt: now,
    });

    await assert.rejects(
      () => runtime.resumeSession({ sessionId, cwd }),
      /did not prove the original conversation identity/
    );
    assert.equal(stopCalls, 1);
    const record = await runtime.registry.read(sessionId);
    assert.equal(record?.state, "failed");
    assert.notEqual(record?.providerContextRestored, true);
    await runtime.shutdown();
  }
});

test("native resume uses immutable Connection snapshot but resolves rotated credential", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const resumedPlans: Array<{
    model?: string;
    endpoint?: string;
    secret?: string;
    serviceDataDir?: string;
  }> = [];
  let secret = "secret-v1";
  const adapter: ProviderAdapter = {
    id: "snapshot-resume",
    displayNameKey: "adapter.snapshotResume",
    capabilities: () => ({
      canSpawn: true,
      canResume: true,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "env",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed-only test adapter");
    },
    startManagedSession: async (plan, emit) => {
      emit({ type: "session.live", sessionId: plan.sessionId, pid: 7001 });
      return {
        sessionId: plan.sessionId,
        pid: 7001,
        providerSessionId: "provider-snapshot-1",
        isAlive: () => true,
        stop: async () => undefined,
      };
    },
    resumeManagedSession: async (plan, token, emit) => {
      const acp = plan.extras?.acp as { model?: string; endpoint?: string } | undefined;
      resumedPlans.push({
        model: acp?.model,
        endpoint: acp?.endpoint,
        secret: plan.env?.SNAPSHOT_KEY,
        serviceDataDir: plan.env?.TENT_SERVICE_DATA_DIR,
      });
      emit({ type: "session.live", sessionId: plan.sessionId, pid: 7002 });
      return {
        sessionId: plan.sessionId,
        pid: 7002,
        providerSessionId: token.providerSessionId ?? token.raw,
        isAlive: () => true,
        stop: async () => undefined,
      };
    },
    parseResumeToken: (raw) => ({ raw, providerSessionId: raw }),
    mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
  };
  const original: AgentConnectionConfig = {
    connectionId: "snapshot-connection",
    provider: "test",
    adapterId: adapter.id,
    model: "old-model",
    endpoint: "https://old.invalid/v1",
    envKey: "SNAPSHOT_KEY",
    launchSecretRef: "credential-1",
  };
  const runtime = createAgentRuntime({
    dataDir: path.relative(process.cwd(), dataDir),
    adapters: [adapter],
    connections: [original],
    resolveConnectionEnv: (route) => {
      const env: Record<string, string> = {};
      if (route.launchSecretRef === "credential-1") {
        env.SNAPSHOT_KEY = secret;
      }
      return env;
    },
  });
  const sessionId = "ss-snapshot1";
  const handle = await startConnection(runtime, { sessionId, connectionId: original.connectionId, cwd });
  assert.equal("connectionSnapshot" in handle, false, "public handle must not expose launch snapshot");
  const started = await runtime.registry.read(sessionId);
  assert.equal(started?.connectionSnapshot?.model, "old-model");
  assert.equal(JSON.stringify(started).includes(secret), false, "snapshot must not persist secret values");
  await runtime.stopSession(sessionId, "user");

  runtime.replaceConnectionCatalog([
    {
      ...original,
      model: "new-model",
      endpoint: "https://new.invalid/v1",
    },
  ]);
  secret = "secret-v2";
  await runtime.resumeSession({
    sessionId,
    cwd,
    env: { TENT_SERVICE_DATA_DIR: "C:\\request-must-not-win" },
  });
  assert.deepEqual(resumedPlans[0], {
    model: "old-model",
    endpoint: "https://old.invalid/v1",
    secret: "secret-v2",
    serviceDataDir: dataDir,
  });
  await runtime.stopSession(sessionId, "user");

  // A stopped custom Connection may be removed; its durable session remains resumable.
  runtime.replaceConnectionCatalog([]);
  await runtime.resumeSession({ sessionId, cwd });
  assert.equal(resumedPlans[1]?.model, "old-model");
  await runtime.shutdown();
});

test("resume rejects a corrupt Connection snapshot before provider resume", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const adapter: ProviderAdapter = {
    id: "snapshot-corrupt",
    displayNameKey: "adapter.snapshotCorrupt",
    capabilities: () => ({
      canSpawn: true,
      canResume: true,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("unused");
    },
    resumeManagedSession: async () => {
      throw new Error("must not reach adapter");
    },
    mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [testConnection("expected-connection", adapter.id)],
  });
  const now = new Date().toISOString();
  await runtime.registry.write({
    id: "ss-badsnapshot",
    connectionId: "expected-connection",
    adapterId: adapter.id,
    connectionSnapshot: snapshot("other-connection", adapter.id),
    state: "stopped",
    resumeToken: "provider-1",
    runtimeWorkspace: { cwd },
    createdAt: now,
    updatedAt: now,
  });
  await assert.rejects(
    () => runtime.resumeSession({ sessionId: "ss-badsnapshot", cwd }),
    /Session not found/i
  );
  await runtime.shutdown();
});
