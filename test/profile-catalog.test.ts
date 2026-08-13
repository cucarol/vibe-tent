/** Canonical machine-local Agent Connection catalog. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { createAgentRuntime, type AgentConnectionConfig } from "../src/runtime/index.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { AgentConnectionCatalog } from "../src/service/connection-catalog.js";
import {
  defaultAgentConnections,
  ensureDefaultAgentConnections,
  loadAgentConnections,
  projectAgentConnection,
  connectionsPath,
} from "../src/service/connections.js";
import { startLocalTentService } from "../src/service/service.js";

type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

const seed = (): AgentConnectionConfig[] => [
  {
    connectionId: "fake-default",
    provider: "fake",
    adapterId: FAKE_ADAPTER_ID,
    fake: { waitForSignal: true, emitStdout: true, canResume: true },
  },
  {
    connectionId: "grok-default",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    model: "grok-4.5",
    envKey: "CPA_GROK_API_KEY",
    endpoint: "http://127.0.0.1:8317/v1",
    permissionPolicy: "deny",
  },
];

async function withService(
  fn: (svc: Svc) => Promise<void>,
  options?: { injected?: boolean }
): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-catalog-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    ...(options?.injected === false ? {} : { connections: seed() }),
  });
  try {
    await fn(svc);
  } finally {
    await svc.stop();
  }
  return dataDir;
}

const rpc = (svc: Svc, method: string, params: Record<string, unknown> = {}) =>
  rpcCall(svc.url, method, params, { token: svc.token });

async function expectInvalid(
  svc: Svc,
  method: string,
  params: Record<string, unknown>,
  message?: RegExp
): Promise<void> {
  const result = await rpc(svc, method, params);
  assert.equal(result.error?.code, -32602);
  if (message) assert.match(result.error?.message ?? "", message);
}

test("connection CRUD synchronizes the runtime and injected catalogs never write connections.json", async () => {
  const dataDir = await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await assert.rejects(() => fs.stat(connectionsPath(svc.dataDir)), { code: "ENOENT" });

    const created = (await client.connectionCreate({
      connectionId: "grok-local",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayName: "Local Grok",
      model: "grok-4.5",
      envKey: "CPA_GROK_API_KEY",
      endpoint: "http://127.0.0.1:8317/v1",
      permissionPolicy: "ask",
      permissionTimeoutMs: 5_000,
    })) as { connection: Record<string, unknown> };
    assert.equal(created.connection.connectionId, "grok-local");
    assert.equal(svc.runtime.getConnection("grok-local")?.permissionTimeoutMs, 5_000);

    const got = (await client.connectionGet("grok-local")) as {
      connection: { model?: string; endpoint?: string };
    };
    assert.equal(got.connection.model, "grok-4.5");
    assert.equal(got.connection.endpoint, "http://127.0.0.1:8317/v1");

    const updated = (await client.connectionUpdate("grok-local", {
      displayName: "Local Grok 2",
      permissionTimeoutMs: 9_000,
    })) as { connection: { displayName: string } };
    assert.equal(updated.connection.displayName, "Local Grok 2");
    assert.equal(svc.runtime.getConnection("grok-local")?.permissionTimeoutMs, 9_000);

    const listed = (await client.connectionList()) as {
      connections: Array<{ connectionId: string }>;
    };
    assert.ok(listed.connections.some((route) => route.connectionId === "grok-local"));

    await client.connectionDelete("grok-local");
    assert.equal(svc.runtime.getConnection("grok-local"), undefined);
    assert.equal((await rpc(svc, "connection.get", { connectionId: "grok-local" })).error?.code, -32004);
    await assert.rejects(() => fs.stat(connectionsPath(svc.dataDir)), { code: "ENOENT" });
  });
  await assert.rejects(() => fs.stat(connectionsPath(dataDir)), { code: "ENOENT" });
});

test("connection CRUD emits safe machine-local change events only after durable success", async () => {
  await withService(async (svc) => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "connection.changed") events.push(event.payload as Record<string, unknown>);
    });
    try {
      const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
      await client.connectionCreate({
        connectionId: "evented",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        launchSecretRef: "missing-vault-slot",
      });
      await client.connectionUpdate("evented", { model: "event-model" });
      await expectInvalid(svc, "connection.update", {
        connectionId: "evented",
        apiKey: "must-not-appear",
      });
      assert.equal(events.length, 2);
      await client.connectionDelete("evented");
      assert.deepEqual(events.map((event) => event.action), ["create", "update", "delete"]);
      assert.equal(events[0]!.connectionId, "evented");
      assert.equal((events[1]!.connection as Record<string, unknown>).model, "event-model");
      assert.deepEqual(events[2], { action: "delete", connectionId: "evented" });
      const wire = JSON.stringify(events);
      assert.equal(wire.includes("must-not-appear"), false);
      assert.equal(wire.includes("apiKey"), false);
    } finally {
      unsubscribe();
    }
  });
});

test("disk-backed CRUD persists; failed save leaves catalog and runtime unchanged", async () => {
  const dataDir = await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.connectionCreate({
      connectionId: "persisted",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayName: "On Disk",
    });
    assert.ok((await loadAgentConnections(svc.dataDir)).some((route) => route.connectionId === "persisted"));
  }, { injected: false });
  assert.ok((await loadAgentConnections(dataDir)).some((route) => route.connectionId === "persisted"));

  const failDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-fail-"));
  const runtime = createAgentRuntime({ dataDir: failDir, connections: seed() });
  try {
    const catalog = new AgentConnectionCatalog(failDir, seed(), {
      saveConnections: async () => { throw new Error("deterministic write failure"); },
      publishConnections: (connections) => runtime.replaceConnectionCatalog(connections),
    });
    await assert.rejects(
      () => catalog.create({
        connectionId: "should-fail",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
      }),
      /deterministic write failure/
    );
    assert.equal(catalog.get("should-fail"), undefined);
    assert.equal(runtime.getConnection("should-fail"), undefined);
    assert.ok(catalog.get("grok-default"));
    assert.ok(runtime.getConnection("grok-default"));
    await assert.rejects(() => fs.stat(connectionsPath(failDir)), { code: "ENOENT" });
  } finally {
    await runtime.shutdown();
  }
});

test("Connection updates clear optional fields, reject unsafe URLs and preserve clone isolation", async () => {
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.connectionCreate({
      connectionId: "clearable",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayName: "Clear Me",
      model: "custom",
      envKey: "CUSTOM_KEY",
      endpoint: "http://127.0.0.1:9/v1",
      permissionPolicy: "ask",
      promptTimeoutMs: 11_000,
    });
    const cleared = (await client.connectionUpdate("clearable", {
      displayName: null,
      model: null,
      envKey: null,
      endpoint: null,
      permissionPolicy: null,
      promptTimeoutMs: null,
    })) as { connection: Record<string, unknown> };
    assert.equal(cleared.connection.displayName, "clearable");
    assert.equal(cleared.connection.model, undefined);
    assert.equal(svc.runtime.getConnection("clearable")?.model, undefined);

    for (const endpoint of [
      "http://user:pass@127.0.0.1/v1",
      "http://127.0.0.1/v1?token=x",
      "http://127.0.0.1/v1#frag",
      "ftp://example.test",
    ]) {
      await expectInvalid(svc, "connection.create", {
        connectionId: `unsafe${Math.random().toString(16).slice(2, 8)}`,
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        endpoint,
      }, /endpoint/i);
    }
    await expectInvalid(svc, "connection.create", {
      connectionId: "dangerous",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      env: { SECRET: "x" },
    });
  });

  const route: AgentConnectionConfig = {
    connectionId: "clone",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    model: "original",
    launchSecretRef: "vault-id",
  };
  const projection = projectAgentConnection(route);
  assert.equal(JSON.stringify(projection).includes("secret"), false);
  const runtime = createAgentRuntime({ dataDir: await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-clone-")), connections: [route] });
  try {
    route.model = "mutated-input";
    assert.equal(runtime.getConnection("clone")?.model, "original");
    const copy = runtime.getConnection("clone")!;
    copy.model = "mutated-copy";
    assert.equal(runtime.getConnection("clone")?.model, "original");
  } finally {
    await runtime.shutdown();
  }
});

test("missing Connections initialize once, explicit empty remains empty, corrupt Connections fail loud once", async () => {
  const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-missing-"));
  const defaults = await ensureDefaultAgentConnections(missingDir);
  assert.equal(defaults.length, 6);
  assert.deepEqual(await loadAgentConnections(missingDir), defaults);

  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-empty-"));
  await fs.writeFile(connectionsPath(emptyDir), JSON.stringify({ connections: [] }) + "\n", "utf8");
  assert.deepEqual(await ensureDefaultAgentConnections(emptyDir), []);
  assert.deepEqual(JSON.parse(await fs.readFile(connectionsPath(emptyDir), "utf8")), { connections: [] });

  const corruptDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-corrupt-"));
  await fs.writeFile(connectionsPath(corruptDir), "{ not-json", "utf8");
  await assert.rejects(() => ensureDefaultAgentConnections(corruptDir), /quarantined/i);
  await assert.rejects(() => fs.stat(connectionsPath(corruptDir)), { code: "ENOENT" });
  const backups = (await fs.readdir(corruptDir)).filter((name) => name.startsWith("connections.json.corrupt-"));
  assert.equal(backups.length, 1);
});

test("canonical Agent Connections accept explicit launch fields", async () => {
  const defaults = defaultAgentConnections();
  assert.equal(defaults.length, 6);
  assert.ok(defaults.every((route) => route.connectionId && route.provider && route.adapterId));

  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const created = (await client.connectionCreate({
      connectionId: "custom-command",
      provider: "custom",
      adapterId: GROK_ACP_ADAPTER_ID,
      command: process.execPath,
      args: ["agent.mjs", "stdio"],
    })) as { connection: { connectionId: string; command?: string; args?: string[] } };
    assert.equal(created.connection.connectionId, "custom-command");
    assert.equal(created.connection.command, process.execPath);
    assert.deepEqual(created.connection.args, ["agent.mjs", "stdio"]);
  });
});
