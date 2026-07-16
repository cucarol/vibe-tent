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
  makeSessionId,
  SessionRegistry,
  type RuntimeEvent,
} from "../src/runtime/index.js";

async function tempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tent-b9a-"));
}

async function tempCwd(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tent-b9a-cwd-"));
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
    profileId: "fake-default",
    adapterId: FAKE_ADAPTER_ID,
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
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-live001";
  const handle = await runtime.startSession({
    sessionId,
    profileId: "fake-default",
    roleName: "ACP适配Grok",
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
  assert.equal(probeLive.alive, true);
  assert.equal(probeLive.state, "live");

  await runtime.stopSession(sessionId, "user");
  await waitFor(events, "session.exited", sessionId);

  const probeStopped = await runtime.probe(sessionId);
  assert.equal(probeStopped.alive, false);
  assert.ok(probeStopped.state === "stopped" || probeStopped.state === "failed");

  await runtime.shutdown();
});

test("launch failure records session.failed without spawning paid provider", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir });
  runtime.registerProfile({
    id: "fake-broken",
    adapterId: FAKE_ADAPTER_ID,
    fake: { failLaunch: "missing binary: codex" },
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-fail001";
  await assert.rejects(
    () =>
      runtime.startSession({
        sessionId,
        profileId: "fake-broken",
        cwd,
      }),
    /missing binary/
  );

  await waitFor(events, "session.failed", sessionId);
  const probe = await runtime.probe(sessionId);
  assert.equal(probe.alive, false);
  assert.equal(probe.state, "failed");
  assert.match(probe.lastError ?? "", /missing binary/);

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
    profiles: [{ id: "managed-start-fail", adapterId: adapter.id }],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));

  const sessionId = "ss-fastfail";
  await assert.rejects(
    () => runtime.startSession({ sessionId, profileId: "managed-start-fail", cwd }),
    /provider failed during startup/
  );

  const probe = await runtime.probe(sessionId);
  assert.equal(probe.alive, false);
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

test("natural non-zero exit maps to session.failed", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1000 });
  runtime.registerProfile({
    id: "fake-exit1",
    adapterId: FAKE_ADAPTER_ID,
    fake: { waitForSignal: false, sleepMs: 50, exitCode: 7, emitStdout: false },
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-exit007";
  await runtime.startSession({ sessionId, profileId: "fake-exit1", cwd });
  await waitFor(events, "session.failed", sessionId, 5000);

  const probe = await runtime.probe(sessionId);
  assert.equal(probe.alive, false);
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
  const idA = "ss-concura";
  const idB = "ss-concurb";

  const [ha, hb] = await Promise.all([
    runtime.startSession({
      sessionId: idA,
      profileId: "fake-default",
      runtimeWorkspace: { cwd: cwdA },
    }),
    runtime.startSession({
      sessionId: idB,
      profileId: "fake-default",
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

test("shutdown stops push children (service-stop policy)", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const runtime = createAgentRuntime({ dataDir, gracefulMs: 1500 });
  const sessionId = "ss-shut001";
  await runtime.startSession({ sessionId, profileId: "fake-default", cwd });
  assert.equal((await runtime.probe(sessionId)).alive, true);

  await runtime.shutdown();
  assert.equal(runtime.supervisor.listLive().length, 0);

  // New runtime on same disk sees non-alive process
  const runtime2 = createAgentRuntime({ dataDir });
  const probe = await runtime2.probe(sessionId);
  assert.equal(probe.alive, false);
  assert.ok(probe.state === "stopped" || probe.state === "failed");
  await runtime2.shutdown();
});

test("reconcileOnBoot marks dead non-resume sessions failed/stopped", async () => {
  const dataDir = await tempDataDir();
  const reg = new SessionRegistry(dataDir);
  const now = new Date().toISOString();
  await reg.write({
    id: "ss-zombie1",
    profileId: "fake-default",
    adapterId: FAKE_ADAPTER_ID,
    state: "live",
    pid: 999999, // almost certainly dead
    createdAt: now,
    updatedAt: now,
    runtimeWorkspace: { cwd: await tempCwd() },
  });

  const runtime = createAgentRuntime({ dataDir });
  const results = await runtime.reconcileOnBoot();
  assert.equal(results.length, 1);
  assert.equal(results[0].alive, false);
  assert.ok(results[0].state === "failed" || results[0].state === "stopped");

  const rec = await reg.read("ss-zombie1");
  assert.ok(rec);
  assert.ok(rec!.state === "failed" || rec!.state === "stopped");
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
  runtime.registerProfile({
    id: "fake-quick",
    adapterId: FAKE_ADAPTER_ID,
    fake: { waitForSignal: false, sleepMs: 80, exitCode: 0, emitStdout: true },
  });

  const scoped: RuntimeEvent[] = [];
  const other: RuntimeEvent[] = [];
  const id = "ss-scope01";
  runtime.subscribe(id, (e) => scoped.push(e));
  runtime.subscribe("ss-otherxx", (e) => other.push(e));

  await runtime.startSession({
    sessionId: id,
    profileId: "fake-quick",
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
    profiles: [{ id: "resume-profile", adapterId: adapter.id }],
  });
  const sessionId = "ss-conresume";
  const now = new Date().toISOString();
  await runtime.registry.write({
    id: sessionId,
    profileId: "resume-profile",
    adapterId: adapter.id,
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

test("native resume uses immutable profile snapshot but resolves rotated credential", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const resumedPlans: Array<{
    model?: string;
    baseUrl?: string;
    secret?: string;
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
      const acp = plan.extras?.acp as { model?: string; baseUrl?: string } | undefined;
      resumedPlans.push({
        model: acp?.model,
        baseUrl: acp?.baseUrl,
        secret: plan.env?.SNAPSHOT_KEY,
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
  const original = {
    id: "snapshot-profile",
    adapterId: adapter.id,
    acp: {
      model: "old-model",
      baseUrl: "https://old.invalid/v1",
      envKey: "SNAPSHOT_KEY",
      credentialRef: "credential-1",
    },
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [original],
    resolveProfileEnv: (profile) => {
      const env: Record<string, string> = {};
      if (profile.acp?.credentialRef === "credential-1") {
        env.SNAPSHOT_KEY = secret;
      }
      return env;
    },
  });
  const sessionId = "ss-snapshot1";
  const handle = await runtime.startSession({ sessionId, profileId: original.id, cwd });
  assert.equal("profileSnapshot" in handle, false, "public handle must not expose launch snapshot");
  const started = await runtime.registry.read(sessionId);
  assert.equal(started?.profileSnapshot?.acp?.model, "old-model");
  assert.equal(JSON.stringify(started).includes(secret), false, "snapshot must not persist secret values");
  await runtime.stopSession(sessionId, "user");

  runtime.replaceProfileCatalog([
    {
      ...original,
      acp: {
        ...original.acp,
        model: "new-model",
        baseUrl: "https://new.invalid/v1",
      },
    },
  ]);
  secret = "secret-v2";
  await runtime.resumeSession({ sessionId, cwd });
  assert.deepEqual(resumedPlans[0], {
    model: "old-model",
    baseUrl: "https://old.invalid/v1",
    secret: "secret-v2",
  });
  await runtime.stopSession(sessionId, "user");

  // A stopped custom profile may be removed; its durable session remains resumable.
  runtime.replaceProfileCatalog([]);
  await runtime.resumeSession({ sessionId, cwd });
  assert.equal(resumedPlans[1]?.model, "old-model");
  await runtime.shutdown();
});

test("resume rejects corrupt profile snapshot identity", async () => {
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
    profiles: [{ id: "expected-profile", adapterId: adapter.id }],
  });
  const now = new Date().toISOString();
  await runtime.registry.write({
    id: "ss-badsnapshot",
    profileId: "expected-profile",
    adapterId: adapter.id,
    profileSnapshot: { id: "other-profile", adapterId: adapter.id },
    state: "stopped",
    resumeToken: "provider-1",
    runtimeWorkspace: { cwd },
    createdAt: now,
    updatedAt: now,
  });
  await assert.rejects(
    () => runtime.resumeSession({ sessionId: "ss-badsnapshot", cwd }),
    /snapshot id mismatch/i
  );
  await runtime.shutdown();
});

test("fake resume preserves assignee kind and captured profile", async () => {
  const dataDir = await tempDataDir();
  const cwd = await tempCwd();
  const profile = {
    id: "fake-snapshot",
    adapterId: FAKE_ADAPTER_ID,
    fake: { waitForSignal: true, canResume: true, emitStdout: false },
  };
  const runtime = createAgentRuntime({ dataDir, profiles: [profile] });
  const sessionId = "ss-fakesnap1";
  await runtime.startSession({
    sessionId,
    profileId: profile.id,
    assigneeKind: "agentProfile",
    cwd,
  });
  await runtime.stopSession(sessionId, "user");
  runtime.replaceProfileCatalog([]);
  await runtime.resumeSession({ sessionId, cwd });
  const resumed = await runtime.registry.read(sessionId);
  assert.equal(resumed?.assigneeKind, "agentProfile");
  assert.equal(resumed?.profileSnapshot?.id, profile.id);
  await runtime.shutdown();
});
