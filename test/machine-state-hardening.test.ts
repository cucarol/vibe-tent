/**
 * Machine-local JSON store hardening:
 * atomic temp+rename writes, mutation serialization, and corrupt backup.
 * Deterministic on Windows (no network; timers only where the store owns them).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAgentConnectionSnapshot,
  type AgentConnectionConfig,
} from "../src/runtime/agent-connection.js";
import { SessionRegistry } from "../src/runtime/session-registry.js";
import type { SessionRecord } from "../src/runtime/types.js";
import {
  readServiceEndpoint,
  removeServiceEndpoint,
  serviceEndpointPath,
  writeServiceEndpoint,
} from "../src/service/data-dir.js";
import {
  connectionsPath,
  ensureDefaultAgentConnections,
  loadAgentConnections,
  saveAgentConnections,
} from "../src/service/connections.js";
import {
  acquireServiceDataDirLease,
  ServiceDataDirBusyError,
  serviceLeasePath,
} from "../src/service/service-lease.js";
import { startLocalTentService } from "../src/service/service.js";
import {
  makeToolApprovalId,
  ToolApprovalStore,
  type ToolPendingApproval,
} from "../src/service/tool-approval-store.js";
import { writeJsonAtomic } from "../src/machine-state.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

function toolPending(
  partial: Partial<ToolPendingApproval> & { id: string }
): ToolPendingApproval {
  return {
    workspaceId: "ws-1",
    sessionId: "ss-tool0001",
    taskId: "tk-tool0001",
    taskPath: "temp/worker/tasks/task.md",
    toolTitle: "read_file",
    options: [{ optionId: "allow_once", kind: "allow_once" }],
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...partial,
  };
}

function fakeConnection(connectionId = "fake-default"): AgentConnectionConfig {
  return {
    connectionId,
    provider: "fake",
    adapterId: "fake",
    permissionPolicy: "deny",
    fake: { waitForSignal: true, canResume: true },
  };
}

function sessionRecord(
  id: string,
  state: SessionRecord["state"] = "live"
): SessionRecord {
  const connection = fakeConnection();
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id,
    connectionId: connection.connectionId,
    adapterId: connection.adapterId,
    connectionSnapshot: createAgentConnectionSnapshot(connection, {
      effectiveEndpointDigest: undefined,
    }),
    state,
    createdAt: now,
    updatedAt: now,
  };
}

test("writeJsonAtomic: sequential replace leaves parseable pretty JSON", async () => {
  const dataDir = await tempDir("tent-ms-atomic-");
  const file = path.join(dataDir, "payload.json");

  for (let i = 0; i < 12; i++) {
    await writeJsonAtomic(file, {
      seq: i,
      items: Array.from({ length: i + 1 }, (_, index) => index),
    });
  }

  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as { seq: number; items: number[] };
  assert.equal(parsed.seq, 11);
  assert.equal(parsed.items.length, 12);
  assert.ok(raw.includes("\n  "));
  assert.equal(raw.endsWith("\n"), true);
  const names = await fs.readdir(dataDir);
  assert.equal(names.filter((name) => name.endsWith(".tmp")).length, 0);
});

test("ToolApprovalStore: malformed row quarantines the whole machine-state file", async () => {
  const dataDir = await tempDir("tent-tools-corrupt-");
  const file = path.join(dataDir, "tool-approvals.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      items: [
        toolPending({ id: "ta-valid0001" }),
        { ...toolPending({ id: "ta-bad00001" }), status: "maybe" },
      ],
    }),
    "utf8"
  );

  const capture = captureConsoleError();
  try {
    const store = new ToolApprovalStore(dataDir);
    assert.deepEqual(await store.listPending(), []);
    await assert.rejects(() => fs.access(file));
    const names = await fs.readdir(dataDir);
    const backups = names.filter((name) =>
      name.startsWith("tool-approvals.json.corrupt-")
    );
    assert.equal(backups.length, 1);
    const quarantined = JSON.parse(
      await fs.readFile(path.join(dataDir, backups[0]!), "utf8")
    ) as { items: unknown[] };
    assert.equal(quarantined.items.length, 2);
    assert.ok(
      capture.lines.some((line) => /tool-approvals\.json was corrupt/.test(line))
    );
  } finally {
    capture.restore();
  }
});

test("ToolApprovalStore: concurrent resolve cannot resurrect pending", async () => {
  const dataDir = await tempDir("tent-tools-race-");
  const store = new ToolApprovalStore(dataDir);
  const id = makeToolApprovalId(() => 0.33);
  await store.add(toolPending({ id }));

  const results = await Promise.allSettled([
    store.resolve(id, "approved", "user-a"),
    store.resolve(id, "denied", "user-b"),
    store.resolve(id, "approved", "user-c"),
  ]);
  const item = await store.get(id);
  assert.ok(item);
  assert.ok(item.status === "approved" || item.status === "denied");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  await assert.rejects(() => store.resolve(id, "approved", "late"), /already/);

  const reloaded = new ToolApprovalStore(dataDir);
  assert.equal((await reloaded.get(id))?.status, item.status);
  const raw = await fs.readFile(path.join(dataDir, "tool-approvals.json"), "utf8");
  const parsed = JSON.parse(raw) as { items: ToolPendingApproval[] };
  assert.equal(parsed.items.filter((row) => row.status === "pending").length, 0);
});

test("ToolApprovalStore: persistence failure leaves memory and disk uncommitted", async () => {
  const dataDir = await tempDir("tent-tools-rollback-");
  let failWrites = true;
  const store = new ToolApprovalStore(dataDir, {
    writeState: async (file, value) => {
      if (failWrites) throw new Error("injected tool approval persist failure");
      await writeJsonAtomic(file, value);
    },
  });
  const id = makeToolApprovalId(() => 0.61);
  await assert.rejects(
    () => store.add(toolPending({ id })),
    /injected tool approval persist failure/
  );
  assert.equal(await store.get(id), undefined);

  failWrites = false;
  await store.add(toolPending({ id }));
  failWrites = true;
  await assert.rejects(
    () => store.resolve(id, "approved", "user"),
    /injected tool approval persist failure/
  );
  assert.equal((await store.get(id))?.status, "pending");
  assert.equal((await new ToolApprovalStore(dataDir).get(id))?.status, "expired");
});

test("ToolApprovalStore retries loading after a transient non-ENOENT read error", async () => {
  const dataDir = await tempDir("tent-tools-retry-");
  const file = path.join(dataDir, "tool-approvals.json");
  await fs.mkdir(file);
  const store = new ToolApprovalStore(dataDir);
  await assert.rejects(() => store.ensureLoaded());
  await fs.rm(file, { recursive: true });
  const item = toolPending({ id: "ta-retry0001" });
  await fs.writeFile(file, JSON.stringify({ items: [item] }), "utf8");
  assert.equal((await store.get(item.id))?.status, "expired");
});

test("connections: malformed catalog fails loud without mutating original bytes", async () => {
  const dataDir = await tempDir("tent-connections-corrupt-");
  const file = connectionsPath(dataDir);
  const secret = "https://user:secret@example.invalid/?token=hidden";
  await fs.mkdir(dataDir, { recursive: true });
  const original = `{ "connections": [{"connectionId":"x","endpoint":"${secret}"`;
  await fs.writeFile(file, original, "utf8");

  const capture = captureConsoleError();
  try {
    await assert.rejects(
      () => ensureDefaultAgentConnections(dataDir),
      /Agent Connections are unreadable/
    );
    await assert.rejects(() => ensureDefaultAgentConnections(dataDir), /Agent Connections are unreadable/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    const names = await fs.readdir(dataDir);
    const backups = names.filter((name) => name.startsWith("connections.json.corrupt-"));
    assert.equal(backups.length, 0);
    assert.ok(capture.lines.every((line) => !line.includes(secret)));
    assert.equal(names.includes("connections.json"), true, "invalid reads never install defaults");
  } finally {
    capture.restore();
  }
});

test("connections: valid explicit empty catalog remains empty", async () => {
  const dataDir = await tempDir("tent-connections-empty-");
  await saveAgentConnections(dataDir, []);
  assert.deepEqual(await ensureDefaultAgentConnections(dataDir), []);
  assert.deepEqual(await loadAgentConnections(dataDir), []);
  assert.deepEqual(JSON.parse(await fs.readFile(connectionsPath(dataDir), "utf8")), {
    connections: [],
  });
});

test("connections: invalid or unknown row fails loud without rewriting the file", async () => {
  const cases: Array<{ label: string; row: Record<string, unknown> }> = [
    {
      label: "unknown-field",
      row: { connectionId: "bad-route", provider: "grok", adapterId: "grok-acp", apiKey: "do-not-strip" },
    },
    {
      label: "invalid-policy",
      row: { connectionId: "bad-route", provider: "grok", adapterId: "grok-acp", permissionPolicy: "yolo" },
    },
    {
      label: "invalid-id",
      row: { connectionId: "Bad Route", provider: "grok", adapterId: "grok-acp" },
    },
  ];

  for (const { label, row } of cases) {
    const dataDir = await tempDir(`tent-connections-${label}-`);
    const file = connectionsPath(dataDir);
    const original = JSON.stringify({ connections: [fakeConnection("valid-route"), row] }) + "\n";
    await fs.writeFile(file, original, "utf8");
    const capture = captureConsoleError();
    try {
      await assert.rejects(() => loadAgentConnections(dataDir), /Agent Connections are unreadable/);
      assert.equal(await fs.readFile(file, "utf8"), original);
      const names = await fs.readdir(dataDir);
      const backups = names.filter((name) => name.startsWith("connections.json.corrupt-"));
      assert.equal(backups.length, 0, `${label}: no backup or mutation`);
    } finally {
      capture.restore();
    }
  }
});

test("saveAgentConnections uses atomic pretty JSON", async () => {
  const dataDir = await tempDir("tent-connections-atomic-");
  await saveAgentConnections(dataDir, [fakeConnection("route-one")]);
  const raw = await fs.readFile(connectionsPath(dataDir), "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.ok(raw.includes("\n  "));
  const parsed = JSON.parse(raw) as { connections: Array<{ connectionId: string }> };
  assert.equal(parsed.connections[0]?.connectionId, "route-one");
  assert.equal((await fs.readdir(dataDir)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("SessionRegistry: corrupt row is backed up, ignored, and does not poison list", async () => {
  const dataDir = await tempDir("tent-sess-corrupt-");
  const registry = new SessionRegistry(dataDir);
  await registry.write(sessionRecord("ss-good01"));
  const badId = "ss-bad001";
  const badFile = path.join(dataDir, "sessions", `${badId}.json`);
  await fs.writeFile(badFile, "{ not-json", "utf8");

  const capture = captureConsoleError();
  try {
    const listed = await registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "ss-good01");
    const names = await fs.readdir(path.join(dataDir, "sessions"));
    const backups = names.filter((name) => name.startsWith(`${badId}.json.corrupt-`));
    assert.equal(backups.length, 1);
    assert.equal(names.includes(`${badId}.json`), false);
    assert.match(capture.lines.join("\n"), /ss-bad001\.json was corrupt.*ignored/);
    const warningCount = capture.lines.length;
    assert.equal(await registry.read(badId), null);
    assert.equal(capture.lines.length, warningCount);

    await registry.write(sessionRecord(badId, "stopped"));
    assert.equal((await registry.read(badId))?.state, "stopped");
  } finally {
    capture.restore();
  }
});

test("SessionRegistry: missing session is null without corrupt backup", async () => {
  const dataDir = await tempDir("tent-sess-missing-");
  const registry = new SessionRegistry(dataDir);
  const capture = captureConsoleError();
  try {
    assert.equal(await registry.read("ss-missing"), null);
    assert.equal(capture.lines.length, 0);
    const names = await fs.readdir(dataDir).catch(() => [] as string[]);
    assert.equal(names.some((name) => name.includes(".corrupt-")), false);
  } finally {
    capture.restore();
  }
});

test("SessionRegistry: missing createdAt is quarantined so list remains safe", async () => {
  const dataDir = await tempDir("tent-sess-no-createdAt-");
  const registry = new SessionRegistry(dataDir);
  await registry.write(sessionRecord("ss-good02"));
  const badId = "ss-nocreat";
  const bad = sessionRecord(badId);
  const { createdAt: _createdAt, ...withoutCreatedAt } = bad;
  await fs.writeFile(
    path.join(dataDir, "sessions", `${badId}.json`),
    JSON.stringify(withoutCreatedAt),
    "utf8"
  );

  const capture = captureConsoleError();
  try {
    assert.equal(await registry.read(badId), null);
    const listed = await registry.list();
    assert.deepEqual(listed.map((row) => row.id), ["ss-good02"]);
    const names = await fs.readdir(path.join(dataDir, "sessions"));
    assert.equal(names.filter((name) => name.startsWith(`${badId}.json.corrupt-`)).length, 1);
    assert.match(capture.lines.join("\n"), /ss-nocreat\.json was corrupt.*ignored/);
  } finally {
    capture.restore();
  }
});

test("SessionRegistry: illegal state, Connection snapshot, ACP observation, or managed Role identity is quarantined", async () => {
  for (const variant of [
    "state",
    "snapshot",
    "snapshot-unknown",
    "observation-unknown",
    "observation-oversize",
    "observation-malformed",
    "roleId",
  ] as const) {
    const dataDir = await tempDir(`tent-sess-bad-${variant}-`);
    const registry = new SessionRegistry(dataDir);
    await registry.write(sessionRecord("ss-good03", "stopped"));
    const badId = {
      state: "ss-badstat",
      snapshot: "ss-badsnap",
      "snapshot-unknown": "ss-badextra",
      "observation-unknown": "ss-badobsx",
      "observation-oversize": "ss-badobsl",
      "observation-malformed": "ss-badobsm",
      roleId: "ss-badrole",
    }[variant];
    const bad = sessionRecord(badId) as unknown as Record<string, unknown>;
    if (variant === "state") bad.state = "running";
    else if (variant === "snapshot") {
      bad.connectionSnapshot = {
        ...(bad.connectionSnapshot as Record<string, unknown>),
        connectionId: "foreign-route",
      };
    } else if (variant === "snapshot-unknown") {
      bad.connectionSnapshot = {
        ...(bad.connectionSnapshot as Record<string, unknown>),
        rawSecret: "sk-must-not-survive",
      };
    } else if (variant === "observation-unknown") {
      bad.acpObservation = {
        permissionRequestCount: 0,
        permissionPolicy: "deny",
        spontaneousChildExit: false,
        rawPayload: "must-not-survive",
      };
    } else if (variant === "observation-oversize") {
      bad.acpObservation = {
        permissionRequestCount: 0,
        permissionPolicy: "deny",
        promptStopReason: "x".repeat(300),
        spontaneousChildExit: false,
      };
    } else if (variant === "observation-malformed") {
      bad.acpObservation = {
        permissionRequestCount: -1,
        permissionPolicy: "deny",
        permissionOutcome: "selected",
        spontaneousChildExit: "no",
      };
    } else {
      bad.roleId = "rl-executor";
    }
    await fs.writeFile(
      path.join(dataDir, "sessions", `${badId}.json`),
      JSON.stringify(bad),
      "utf8"
    );
    const listed = await registry.list();
    assert.deepEqual(listed.map((row) => row.id), ["ss-good03"]);
    const names = await fs.readdir(path.join(dataDir, "sessions"));
    assert.equal(names.filter((name) => name.startsWith(`${badId}.json.corrupt-`)).length, 1);
  }
});

test("SessionRegistry: update preserves immutable Connection identity and snapshot", async () => {
  const dataDir = await tempDir("tent-sess-immutable-");
  const registry = new SessionRegistry(dataDir);
  const original = sessionRecord("ss-immutable");
  await registry.write(original);
  const updated = await registry.update(original.id, {
    state: "waiting-user",
    resumeToken: "provider-token",
  });
  assert.equal(updated.state, "waiting-user");
  assert.equal(updated.resumeToken, "provider-token");
  assert.equal(updated.connectionId, original.connectionId);
  assert.deepEqual(updated.connectionSnapshot, original.connectionSnapshot);

  const unsafeUpdate = registry.update.bind(registry) as (
    sessionId: string,
    patch: Record<string, unknown>
  ) => Promise<SessionRecord>;
  for (const field of ["connectionId", "adapterId", "connectionSnapshot", "roleId"] as const) {
    await assert.rejects(
      () => unsafeUpdate(original.id, { [field]: "changed" }),
      new RegExp(`cannot mutate immutable field: ${field}`)
    );
  }
  const reloaded = await registry.read(original.id);
  assert.equal(reloaded?.connectionId, original.connectionId);
  assert.deepEqual(reloaded?.connectionSnapshot, original.connectionSnapshot);
});

test("service endpoint generation is immutable pretty JSON; malformed read is null", async () => {
  const dataDir = await tempDir("tent-svc-ep-");
  const file = await writeServiceEndpoint(dataDir, {
    instanceId: "instance-atomic",
    pid: 1234,
    host: "127.0.0.1",
    port: 7788,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
    token: "tok-test",
  });
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(JSON.parse(raw).port, 7788);

  await fs.writeFile(file, "{ broken", "utf8");
  const capture = captureConsoleError();
  try {
    assert.equal(await readServiceEndpoint(dataDir), null);
    assert.equal(capture.lines.length, 0);
  } finally {
    capture.restore();
  }
});

test("service endpoint discovery rejects non-loopback or invalid coordinates", async () => {
  const dataDir = await tempDir("tent-svc-ep-invalid-");
  const base = {
    instanceId: "instance-invalid",
    pid: 1234,
    host: "127.0.0.1",
    port: 7788,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
  };
  await assert.rejects(() =>
    writeServiceEndpoint(dataDir, { ...base, host: "203.0.113.8" })
  );
  await assert.rejects(() =>
    writeServiceEndpoint(dataDir, { ...base, port: 70_000 })
  );
  await assert.rejects(() =>
    writeServiceEndpoint(dataDir, { ...base, pid: -1 })
  );
  assert.equal(await readServiceEndpoint(dataDir), null);
});

test("service endpoint removal is scoped to its owning instance", async () => {
  const dataDir = await tempDir("tent-svc-ep-owner-");
  await writeServiceEndpoint(dataDir, {
    instanceId: "instance-current",
    pid: 1234,
    host: "127.0.0.1",
    port: 7788,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
  });
  await removeServiceEndpoint(dataDir, {
    instanceId: "instance-old",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal((await readServiceEndpoint(dataDir))?.instanceId, "instance-current");
  await removeServiceEndpoint(dataDir, {
    instanceId: "instance-current",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(await readServiceEndpoint(dataDir), null);
});

test("service data-dir lease rejects a live second owner and releases idempotently", async () => {
  const dataDir = await tempDir("tent-svc-lease-live-");
  const first = await acquireServiceDataDirLease(dataDir, {
    pid: 101,
    makeInstanceId: () => "instance-first",
    isProcessAlive: (pid) => pid === 101,
  });
  await assert.rejects(
    () =>
      acquireServiceDataDirLease(dataDir, {
        pid: 202,
        makeInstanceId: () => "instance-second",
        isProcessAlive: (pid) => pid === 101,
      }),
    (error: unknown) =>
      error instanceof ServiceDataDirBusyError && error.owner.instanceId === "instance-first"
  );
  await first.release();
  await first.release();
  const second = await acquireServiceDataDirLease(dataDir, {
    pid: 202,
    makeInstanceId: () => "instance-second",
    isProcessAlive: () => true,
  });
  await second.release();
  await assert.rejects(() => fs.access(serviceLeasePath(dataDir)), /ENOENT/);
});

test("service data-dir lease reclaims stale state and release is ownership-safe", async () => {
  const dataDir = await tempDir("tent-svc-lease-stale-");
  const lockPath = serviceLeasePath(dataDir);
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      instanceId: "stale-owner",
      pid: 303,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8"
  );
  const lease = await acquireServiceDataDirLease(dataDir, {
    pid: 404,
    makeInstanceId: () => "current-owner",
    isProcessAlive: () => false,
  });
  const replacement = {
    instanceId: "replacement-owner",
    pid: 505,
    startedAt: "2026-01-02T00:00:00.000Z",
  };
  await fs.writeFile(lockPath, JSON.stringify(replacement), "utf8");
  await lease.release();
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), replacement);
});

test("startLocalTentService owns one dataDir until stop", async () => {
  const dataDir = await tempDir("tent-svc-single-owner-");
  const first = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const endpointBefore = await readServiceEndpoint(dataDir);
    await assert.rejects(
      () => startLocalTentService({ dataDir, writeEndpoint: true }),
      ServiceDataDirBusyError
    );
    assert.deepEqual(await readServiceEndpoint(dataDir), endpointBefore);
  } finally {
    await first.stop();
  }
  const next = await startLocalTentService({ dataDir, writeEndpoint: true });
  await next.stop();
});

test("controlled Service stop reports an unconfirmed runtime child exit after cleanup", async () => {
  const dataDir = await tempDir("tent-service-stop-truth-");
  const svc = await startLocalTentService({ dataDir, writeEndpoint: false });
  svc.runtime.shutdown = async () => {
    throw new Error("child exit was not confirmed");
  };
  await assert.rejects(() => svc.stop(), /child exit was not confirmed/);
});

test("failed service startup releases its data-dir lease", async () => {
  const blockerDir = await tempDir("tent-svc-port-owner-");
  const failedDir = await tempDir("tent-svc-port-failed-");
  const blocker = await startLocalTentService({ dataDir: blockerDir, port: 0 });
  const occupiedPort = blocker.port;
  try {
    await assert.rejects(
      () => startLocalTentService({ dataDir: failedDir, port: occupiedPort }),
      /EADDRINUSE/
    );
    await assert.rejects(() => fs.access(serviceLeasePath(failedDir)), /ENOENT/);
  } finally {
    await blocker.stop();
  }
  const recovered = await startLocalTentService({ dataDir: failedDir, port: occupiedPort });
  await recovered.stop();
});
