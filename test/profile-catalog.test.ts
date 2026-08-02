/** Canonical machine-local Settings route catalog. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { createAgentRuntime, type SettingsRouteConfig } from "../src/runtime/index.js";
import { createServiceClient } from "../src/service/client.js";
import { rpcCall } from "../src/service/http-server.js";
import { SettingsRouteCatalog } from "../src/service/route-catalog.js";
import {
  defaultSettingsRoutes,
  ensureDefaultSettingsRoutes,
  loadSettingsRoutes,
  projectSettingsRoute,
  routesPath,
} from "../src/service/routes.js";
import { startLocalTentService } from "../src/service/service.js";

type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

const seed = (): SettingsRouteConfig[] => [
  {
    routeId: "fake-default",
    provider: "fake",
    adapterId: FAKE_ADAPTER_ID,
    fake: { waitForSignal: true, emitStdout: true, canResume: true },
  },
  {
    routeId: "grok-default",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    model: "grok-4.5",
    envKey: "CPA_GROK_API_KEY",
    baseUrlEnvKey: "CPA_GROK_BASE_URL",
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
    ...(options?.injected === false ? {} : { routes: seed() }),
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

test("route CRUD synchronizes the runtime and injected catalogs never write routes.json", async () => {
  const dataDir = await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await assert.rejects(() => fs.stat(routesPath(svc.dataDir)), { code: "ENOENT" });

    const created = (await client.routeCreate({
      routeId: "grok-local",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayName: "Local Grok",
      model: "grok-4.5",
      envKey: "CPA_GROK_API_KEY",
      baseUrl: "http://127.0.0.1:8317/v1",
      permissionPolicy: "ask",
      permissionTimeoutMs: 5_000,
    })) as { route: Record<string, unknown> };
    assert.equal(created.route.routeId, "grok-local");
    assert.equal(svc.runtime.getRoute("grok-local")?.permissionTimeoutMs, 5_000);

    const got = (await client.routeGet("grok-local")) as {
      route: { model?: string; baseUrl?: string };
    };
    assert.equal(got.route.model, "grok-4.5");
    assert.equal(got.route.baseUrl, "http://127.0.0.1:8317/v1");

    const updated = (await client.routeUpdate("grok-local", {
      displayName: "Local Grok 2",
      permissionTimeoutMs: 9_000,
    })) as { route: { displayName: string } };
    assert.equal(updated.route.displayName, "Local Grok 2");
    assert.equal(svc.runtime.getRoute("grok-local")?.permissionTimeoutMs, 9_000);

    const listed = (await client.routeList()) as {
      routes: Array<{ routeId: string }>;
    };
    assert.ok(listed.routes.some((route) => route.routeId === "grok-local"));

    await client.routeDelete("grok-local");
    assert.equal(svc.runtime.getRoute("grok-local"), undefined);
    assert.equal((await rpc(svc, "route.get", { routeId: "grok-local" })).error?.code, -32004);
    await assert.rejects(() => fs.stat(routesPath(svc.dataDir)), { code: "ENOENT" });
  });
  await assert.rejects(() => fs.stat(routesPath(dataDir)), { code: "ENOENT" });
});

test("route CRUD emits safe machine-local change events only after durable success", async () => {
  await withService(async (svc) => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "route.changed") events.push(event.payload as Record<string, unknown>);
    });
    try {
      const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
      await client.routeCreate({
        routeId: "evented",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        credentialRef: "missing-vault-slot",
      });
      await client.routeUpdate("evented", { model: "event-model" });
      await expectInvalid(svc, "route.update", {
        routeId: "evented",
        apiKey: "must-not-appear",
      });
      assert.equal(events.length, 2);
      await client.routeDelete("evented");
      assert.deepEqual(events.map((event) => event.action), ["create", "update", "delete"]);
      assert.equal(events[0]!.routeId, "evented");
      assert.equal((events[1]!.route as Record<string, unknown>).model, "event-model");
      assert.deepEqual(events[2], { action: "delete", routeId: "evented" });
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
    await client.routeCreate({
      routeId: "persisted",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayName: "On Disk",
    });
    assert.ok((await loadSettingsRoutes(svc.dataDir)).some((route) => route.routeId === "persisted"));
  }, { injected: false });
  assert.ok((await loadSettingsRoutes(dataDir)).some((route) => route.routeId === "persisted"));

  const failDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-fail-"));
  const runtime = createAgentRuntime({ dataDir: failDir, routes: seed() });
  try {
    const catalog = new SettingsRouteCatalog(failDir, seed(), {
      saveRoutes: async () => { throw new Error("deterministic write failure"); },
      publishRoutes: (routes) => runtime.replaceRouteCatalog(routes),
    });
    await assert.rejects(
      () => catalog.create({
        routeId: "should-fail",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
      }),
      /deterministic write failure/
    );
    assert.equal(catalog.get("should-fail"), undefined);
    assert.equal(runtime.getRoute("should-fail"), undefined);
    assert.ok(catalog.get("grok-default"));
    assert.ok(runtime.getRoute("grok-default"));
    await assert.rejects(() => fs.stat(routesPath(failDir)), { code: "ENOENT" });
  } finally {
    await runtime.shutdown();
  }
});

test("route updates clear optional fields, reject unsafe URLs and preserve clone isolation", async () => {
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.routeCreate({
      routeId: "clearable",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      displayName: "Clear Me",
      model: "custom",
      envKey: "CUSTOM_KEY",
      baseUrl: "http://127.0.0.1:9/v1",
      permissionPolicy: "ask",
      promptTimeoutMs: 11_000,
    });
    const cleared = (await client.routeUpdate("clearable", {
      displayName: null,
      model: null,
      envKey: null,
      baseUrl: null,
      permissionPolicy: null,
      promptTimeoutMs: null,
    })) as { route: Record<string, unknown> };
    assert.equal(cleared.route.displayName, "clearable");
    assert.equal(cleared.route.model, undefined);
    assert.equal(svc.runtime.getRoute("clearable")?.model, undefined);

    for (const baseUrl of [
      "http://user:pass@127.0.0.1/v1",
      "http://127.0.0.1/v1?token=x",
      "http://127.0.0.1/v1#frag",
      "ftp://example.test",
    ]) {
      await expectInvalid(svc, "route.create", {
        routeId: `unsafe${Math.random().toString(16).slice(2, 8)}`,
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        baseUrl,
      }, /baseUrl/i);
    }
    await expectInvalid(svc, "route.create", { route: {} }, /top level/i);
    await expectInvalid(svc, "route.create", {
      routeId: "dangerous",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      env: { SECRET: "x" },
    });
  });

  const route: SettingsRouteConfig = {
    routeId: "clone",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    model: "original",
    credentialRef: "vault-id",
  };
  const projection = projectSettingsRoute(route);
  assert.equal(JSON.stringify(projection).includes("secret"), false);
  const runtime = createAgentRuntime({ dataDir: await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-clone-")), routes: [route] });
  try {
    route.model = "mutated-input";
    assert.equal(runtime.getRoute("clone")?.model, "original");
    const copy = runtime.getRoute("clone")!;
    copy.model = "mutated-copy";
    assert.equal(runtime.getRoute("clone")?.model, "original");
  } finally {
    await runtime.shutdown();
  }
});

test("missing routes initialize once, explicit empty remains empty, corrupt routes fail loud once", async () => {
  const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-missing-"));
  const defaults = await ensureDefaultSettingsRoutes(missingDir);
  assert.equal(defaults.length, 7);
  assert.deepEqual(await loadSettingsRoutes(missingDir), defaults);

  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-empty-"));
  await fs.writeFile(routesPath(emptyDir), JSON.stringify({ routes: [] }) + "\n", "utf8");
  assert.deepEqual(await ensureDefaultSettingsRoutes(emptyDir), []);
  assert.deepEqual(JSON.parse(await fs.readFile(routesPath(emptyDir), "utf8")), { routes: [] });

  const corruptDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-corrupt-"));
  await fs.writeFile(routesPath(corruptDir), "{ not-json", "utf8");
  await assert.rejects(() => ensureDefaultSettingsRoutes(corruptDir), /quarantined/i);
  await assert.rejects(() => fs.stat(routesPath(corruptDir)), { code: "ENOENT" });
  const backups = (await fs.readdir(corruptDir)).filter((name) => name.startsWith("routes.json.corrupt-"));
  assert.equal(backups.length, 1);
});

test("canonical routes accept explicit launch fields and reject profile-era disk or RPC shapes", async () => {
  const defaults = defaultSettingsRoutes();
  assert.equal(defaults.length, 7);
  assert.ok(defaults.every((route) => route.routeId && route.provider && route.adapterId));

  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const created = (await client.routeCreate({
      routeId: "custom-command",
      provider: "custom",
      adapterId: GROK_ACP_ADAPTER_ID,
      command: process.execPath,
      args: ["agent.mjs", "stdio"],
    })) as { route: { routeId: string; command?: string; args?: string[] } };
    assert.equal(created.route.routeId, "custom-command");
    assert.equal(created.route.command, process.execPath);
    assert.deepEqual(created.route.args, ["agent.mjs", "stdio"]);
    await expectInvalid(svc, "route.create", {
      id: "old-id",
      adapterId: GROK_ACP_ADAPTER_ID,
    });
    await expectInvalid(svc, "route.create", {
      routeId: "oldbag",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      acp: { model: "old" },
    });
  });

  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-route-legacy-"));
  await fs.writeFile(routesPath(legacyDir), JSON.stringify({
    profiles: [{ id: "old", adapterId: GROK_ACP_ADAPTER_ID }],
  }) + "\n", "utf8");
  await assert.rejects(() => loadSettingsRoutes(legacyDir), /quarantined/i);
  const backups = (await fs.readdir(legacyDir)).filter((name) => name.startsWith("routes.json.corrupt-"));
  assert.equal(backups.length, 1);
});
