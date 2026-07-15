/**
 * Machine-local Grok ACP Profile Catalog (serial CRUD).
 * Transactional commit, inject no-disk, null clear, baseUrl safety, RPC shape.
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
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import {
  FAKE_DEFAULT_PROFILE_ID,
  GROK_ACP_DEFAULT_PROFILE_ID,
  ensureDefaultProfiles,
  loadAgentProfiles,
  profilesPath,
  projectAgentProfile,
} from "../src/service/profiles.js";
import { AgentProfileCatalog } from "../src/service/profile-catalog.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { DEFAULT_GROK_MODEL, GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { createAgentRuntime, legacyGrokAcpDiskProfile } from "../src/runtime/index.js";
import type { AgentProfileConfig } from "../src/runtime/types.js";

const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-acp-server.mjs");
type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

const seed = (): AgentProfileConfig[] => [
  {
    id: FAKE_DEFAULT_PROFILE_ID,
    adapterId: FAKE_ADAPTER_ID,
    displayNameKey: "profile.fake.default",
    fake: { waitForSignal: true, emitStdout: true, canResume: true },
  },
  {
    id: GROK_ACP_DEFAULT_PROFILE_ID,
    adapterId: GROK_ACP_ADAPTER_ID,
    displayNameKey: "profile.grokAcp.default",
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      baseUrlEnvKey: "CPA_GROK_BASE_URL",
      permissionPolicy: "deny",
      permissionTimeoutMs: 120_000,
    },
  },
];

function mockAcp(
  id: string,
  logPath: string,
  o: { permissionTimeoutMs?: number; permissionPolicy?: "deny" | "allow" | "ask"; requestPermission?: boolean } = {}
): AgentProfileConfig {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: logPath,
      MOCK_ACP_KEEP_ALIVE: "1",
      MOCK_ACP_PROMPT_TEXT: "CATALOG_TIMEOUT_REPORT",
      ...(o.requestPermission ? { MOCK_ACP_REQUEST_PERMISSION: "1" } : {}),
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: o.permissionPolicy ?? "ask",
      promptTimeoutMs: 8_000,
      permissionTimeoutMs: o.permissionTimeoutMs ?? 400,
    },
  };
}

async function makeWs(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "pcat",
    rules: "# RULES\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "executor", prompt: "do work" }] }) + "\n"
  );
  return workspace;
}

async function withService(
  fn: (svc: Svc) => Promise<void>,
  opts?: { profiles?: AgentProfileConfig[]; inject?: boolean }
): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    ...(opts?.inject === false ? {} : { profiles: opts?.profiles ?? seed() }),
  });
  try {
    await fn(svc);
  } finally {
    await svc.stop();
  }
  return dataDir;
}

const rpc = (svc: Svc, method: string, params?: Record<string, unknown>) =>
  rpcCall(svc.url, method, params, { token: svc.token });
const client = (svc: Svc) => createServiceClient({ baseUrl: svc.url, token: svc.token });

async function pollUntil<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000, label = "cond"): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout ${label}`);
}

async function expectParamError(svc: Svc, method: string, params: Record<string, unknown>, re?: RegExp) {
  const res = await rpc(svc, method, params);
  assert.ok(res.error, `expected error ${method}`);
  assert.equal(res.error!.code, -32602);
  if (re) assert.match(res.error!.message, re);
}

test("CRUD + runtime (inject never writes agent-profiles.json)", async () => {
  const dataDir = await withService(async (svc) => {
    const c = client(svc);
    const file = profilesPath(svc.dataDir);
    await assert.rejects(() => fs.stat(file), { code: "ENOENT" });

    const created = (await c.profileCreate({
      id: "grok-acp-cpa-local",
      displayName: "CPA Local",
      model: "grok-4.5",
      envKey: "CPA_GROK_API_KEY",
      baseUrlEnvKey: "CPA_GROK_BASE_URL",
      baseUrl: "http://127.0.0.1:8317/v1",
      permissionPolicy: "ask",
      promptTimeoutMs: 60_000,
      permissionTimeoutMs: 5_000,
    })) as { profile: Record<string, unknown> };
    assert.equal(created.profile.id, "grok-acp-cpa-local");
    assert.equal(created.profile.adapterId, GROK_ACP_ADAPTER_ID);
    assert.equal(created.profile.permissionTimeoutMs, 5_000);
    assert.ok(!("env" in created.profile));
    assert.ok(svc.runtime.getProfile("grok-acp-cpa-local"));

    const got = (await c.profileGet("grok-acp-cpa-local")) as { profile: { model?: string; baseUrl?: string } };
    assert.equal(got.profile.model, "grok-4.5");
    assert.equal(got.profile.baseUrl, "http://127.0.0.1:8317/v1");

    const updated = (await c.profileUpdate("grok-acp-cpa-local", {
      displayName: "CPA Local 2",
      permissionTimeoutMs: 9_000,
    })) as { profile: { displayName: string } };
    assert.equal(updated.profile.displayName, "CPA Local 2");
    assert.equal(svc.runtime.getProfile("grok-acp-cpa-local")?.acp?.permissionTimeoutMs, 9_000);

    const list = (await c.profileList()) as { profiles: Array<{ id: string }> };
    assert.ok(list.profiles.some((p) => p.id === "grok-acp-cpa-local"));
    assert.ok(list.profiles.every((p) => p.id !== FAKE_DEFAULT_PROFILE_ID));
    const withTests = (await c.profileList({ includeTest: true })) as {
      profiles: Array<{ id: string }>;
    };
    assert.ok(withTests.profiles.some((p) => p.id === FAKE_DEFAULT_PROFILE_ID));

    await c.profileDelete("grok-acp-cpa-local");
    assert.equal(svc.runtime.getProfile("grok-acp-cpa-local"), undefined);
    assert.equal((await rpc(svc, "profile.get", { id: "grok-acp-cpa-local" })).error?.code, -32004);
    await assert.rejects(() => fs.stat(file), { code: "ENOENT" });
  });
  await assert.rejects(() => fs.stat(profilesPath(dataDir)), { code: "ENOENT" });
});

test("boot persist writes disk; write failure keeps disk/catalog/runtime old", async () => {
  const dataDir = await withService(async (svc) => {
    await client(svc).profileCreate({ id: "grok-acp-persisted", displayName: "On Disk", permissionTimeoutMs: 3_000 });
    assert.ok((await loadAgentProfiles(svc.dataDir)).some((p) => p.id === "grok-acp-persisted"));
  }, { inject: false });
  assert.ok((await loadAgentProfiles(dataDir)).some((p) => p.id === "grok-acp-persisted"));

  const failDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-fail-"));
  const runtime = createAgentRuntime({ dataDir: failDir, profiles: seed() });
  try {
    const catalog = new AgentProfileCatalog(failDir, runtime, seed(), {
      persistToDisk: true,
      saveProfiles: async () => {
        throw new Error("deterministic write failure");
      },
    });
    await assert.rejects(
      () => catalog.create({ id: "grok-acp-should-fail", displayName: "Nope" }),
      /deterministic write failure/
    );
    assert.equal(catalog.get("grok-acp-should-fail"), undefined);
    assert.equal(runtime.getProfile("grok-acp-should-fail"), undefined);
    assert.ok(catalog.get(GROK_ACP_DEFAULT_PROFILE_ID) && runtime.getProfile(GROK_ACP_DEFAULT_PROFILE_ID));
    await assert.rejects(() => fs.stat(profilesPath(failDir)), { code: "ENOENT" });
  } finally {
    await runtime.shutdown();
  }
});

test("null clears; baseUrl rejects credentials; nested/RPC/id-override/clone/validation", async () => {
  await withService(async (svc) => {
    const c = client(svc);
    await c.profileCreate({
      id: "grok-acp-clearable",
      displayName: "Clear Me",
      model: "grok-custom",
      executable: "/tmp/custom-grok",
      envKey: "CUSTOM_KEY",
      baseUrlEnvKey: "CUSTOM_BASE",
      baseUrl: "http://127.0.0.1:9/v1",
      permissionPolicy: "ask",
      promptTimeoutMs: 11_000,
      permissionTimeoutMs: 2_000,
    });
    const kept = (await c.profileUpdate("grok-acp-clearable", { displayName: "Still Named" })) as {
      profile: Record<string, unknown>;
    };
    assert.equal(kept.profile.displayName, "Still Named");
    assert.equal(kept.profile.model, "grok-custom");
    assert.equal(kept.profile.baseUrl, "http://127.0.0.1:9/v1");

    const cleared = (await c.profileUpdate("grok-acp-clearable", {
      displayName: null,
      model: null,
      executable: null,
      envKey: null,
      baseUrlEnvKey: null,
      baseUrl: null,
      permissionPolicy: null,
      promptTimeoutMs: null,
      permissionTimeoutMs: null,
    })) as { profile: Record<string, unknown> };
    assert.equal(cleared.profile.displayName, "grok-acp-clearable");
    assert.equal(cleared.profile.model, undefined);
    assert.equal(cleared.profile.baseUrl, undefined);
    const raw = svc.runtime.getProfile("grok-acp-clearable");
    assert.equal(raw?.displayName, undefined);
    assert.equal(raw?.acp?.model, undefined);

    await c.profileUpdate(GROK_ACP_DEFAULT_PROFILE_ID, { displayName: "Custom", permissionTimeoutMs: 1_000 });
    const def = (await c.profileUpdate(GROK_ACP_DEFAULT_PROFILE_ID, {
      displayName: null,
      permissionTimeoutMs: null,
    })) as { profile: { displayName: string; permissionTimeoutMs?: number } };
    assert.equal(def.profile.displayName, "Grok ACP");
    assert.equal(def.profile.permissionTimeoutMs, undefined);

    for (const baseUrl of [
      "http://user:pass@127.0.0.1:8317/v1",
      "http://127.0.0.1:8317/v1?token=x",
      "http://127.0.0.1:8317/v1#frag",
      "ftp://x",
    ]) {
      await expectParamError(svc, "profile.create", { id: "grok-acp-u" + Math.random().toString(16).slice(2, 6), baseUrl }, /baseUrl/i);
    }
    await expectParamError(svc, "profile.create", { id: "BAD_ID" }, /id/i);
    await expectParamError(svc, "profile.create", { id: "grok-acp-e", envKey: "bad!" }, /envKey/i);
    await expectParamError(svc, "profile.create", { id: "grok-acp-p", permissionPolicy: "yolo" }, /permissionPolicy/i);
    await expectParamError(svc, "profile.create", { id: "grok-acp-m", permissionTimeoutMs: 0 }, /permissionTimeoutMs/i);
    await expectParamError(svc, "profile.create", { id: "grok-acp-max", promptTimeoutMs: Number.MAX_SAFE_INTEGER }, /promptTimeoutMs/i);

    await expectParamError(svc, "profile.create", { profile: { id: "grok-acp-n", displayName: "x" } }, /nested|top level/i);
    await expectParamError(svc, "profile.update", { id: GROK_ACP_DEFAULT_PROFILE_ID, profile: { displayName: "x" } }, /nested/i);
    for (const bad of [
      { id: "evil-1", apiKey: "sk" },
      { id: "evil-2", env: { K: "v" } },
      { id: "evil-3", adapterId: "fake-cli" },
      { id: "evil-4", unknownField: true },
    ]) {
      await expectParamError(svc, "profile.create", bad);
    }

    await c.profileCreate({ id: "grok-acp-id-win", displayName: "A" });
    await c.profileCreate({ id: "grok-acp-id-lose", displayName: "B" });
    const upd = (await c.profileUpdate("grok-acp-id-win", { id: "grok-acp-id-lose", displayName: "Won" })) as {
      profile: { id: string; displayName: string };
    };
    assert.equal(upd.profile.id, "grok-acp-id-win");
    assert.equal(upd.profile.displayName, "Won");
    assert.equal(
      ((await c.profileGet("grok-acp-id-lose")) as { profile: { displayName: string } }).profile.displayName,
      "B"
    );
  });

  // projection + runtime clone (unit, no service)
  const secret: AgentProfileConfig = {
    id: "grok-acp-proj",
    adapterId: GROK_ACP_ADAPTER_ID,
    displayName: "Proj",
    env: { CPA_GROK_API_KEY: "sk-secret-value" },
    acp: { model: "grok-4.5", envKey: "CPA_GROK_API_KEY", permissionTimeoutMs: 1000 },
  };
  const proj = projectAgentProfile(secret);
  assert.ok(!JSON.stringify(proj).includes("sk-secret-value"));
  assert.ok(!("env" in proj) && !("grokAcp" in proj) && !("acp" in proj));

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-clone-"));
  const runtime = createAgentRuntime({ dataDir, profiles: [secret] });
  try {
    secret.acp!.model = "mutated through constructor input";
    assert.equal(runtime.getProfile("grok-acp-proj")!.acp?.model, "grok-4.5");
    const a = runtime.getProfile("grok-acp-proj")!;
    a.acp!.model = "mutated";
    assert.equal(runtime.getProfile("grok-acp-proj")!.acp?.model, "grok-4.5");
    runtime.listProfiles().find((p) => p.id === "grok-acp-proj")!.acp!.permissionTimeoutMs = 1;
    assert.equal(runtime.getProfile("grok-acp-proj")?.acp?.permissionTimeoutMs, 1000);
  } finally {
    await runtime.shutdown();
  }
});

test("delete gates + permission timeout uses runtime after catalog update", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-sess-"));
  const profiles = [
    ...seed(),
    mockAcp("grok-acp-deletable", path.join(dataDir, "mock-del.json"), { permissionPolicy: "deny" }),
    mockAcp("grok-acp-timeout-live", path.join(dataDir, "mock-to.json"), {
      permissionPolicy: "ask",
      requestPermission: true,
      permissionTimeoutMs: 60_000,
    }),
  ];
  const ws = await makeWs();
  const svc = await startLocalTentService({ dataDir, writeEndpoint: false, profiles });
  try {
    const { workspaceId } = (await rpc(svc, "workspace.mount", { workspaceRoot: ws })).result as {
      workspaceId: string;
    };

    async function start(name: string, profileId: string) {
      const box = (await rpc(svc, "docs.createNote", { workspaceId, name, type: "prompt" })).result as { id: string };
      const d = await rpc(svc, "task.dispatch", { workspaceId, boxId: box.id, role: "executor", prompt: name });
      const taskPath = (d.result as { taskPath: string }).taskPath;
      await rpc(svc, "task.claim", { workspaceId, taskPath });
      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId,
      });
      assert.ok(!started.error, JSON.stringify(started.error));
      return taskPath;
    }

    const livePath = await start("work-item", "grok-acp-deletable");
    const blocked = await rpc(svc, "profile.delete", { id: "grok-acp-deletable" });
    assert.ok(blocked.error);
    assert.match(blocked.error!.message, /non-terminal|session/i);

    await rpc(svc, "task.interrupt", { workspaceId, taskPath: livePath });
    await pollUntil(async () => {
      const list = await rpc(svc, "session.list", { workspaceId });
      const sessions = (list.result as { sessions: Array<{ state: string; profileId: string }> }).sessions;
      const mine = sessions.find((s) => s.profileId === "grok-acp-deletable");
      if (!mine) return true;
      return mine.state === "stopped" || mine.state === "failed" ? true : null;
    }, 12_000, "terminal");

    assert.ok(!(await rpc(svc, "profile.delete", { id: "grok-acp-deletable" })).error);
    assert.ok((await rpc(svc, "profile.delete", { id: GROK_ACP_DEFAULT_PROFILE_ID })).error);
    assert.ok((await rpc(svc, "profile.delete", { id: FAKE_DEFAULT_PROFILE_ID })).error);
    assert.ok((await rpc(svc, "profile.update", { id: FAKE_DEFAULT_PROFILE_ID, displayName: "nope" })).error);

    assert.ok(!(await rpc(svc, "profile.update", { id: "grok-acp-timeout-live", permissionTimeoutMs: 400 })).error);
    assert.equal(svc.runtime.getProfile("grok-acp-timeout-live")?.acp?.permissionTimeoutMs, 400);
    await start("timeout-item", "grok-acp-timeout-live");
    const pending = await pollUntil(async () => {
      const list = await rpc(svc, "toolApproval.listPending", { workspaceId });
      return (
        (list.result as { approvals: Array<{ id: string; expiresAt: string; createdAt: string }> }).approvals[0] ??
        null
      );
    }, 12_000, "pending");
    const windowMs = Date.parse(pending.expiresAt) - Date.parse(pending.createdAt);
    assert.ok(windowMs < 5_000 && windowMs >= 300, `window ${windowMs}ms`);
    const expired = await pollUntil(async () => {
      const got = await rpc(svc, "toolApproval.get", { approvalId: pending.id });
      if (got.error) return null;
      const approval = (got.result as { approval: { status: string } }).approval;
      return approval.status === "expired" ? approval : null;
    }, 8_000, "expiry");
    assert.equal(expired.status, "expired");
  } finally {
    await svc.stop();
  }
});

test("whitelist adapterId create + defaults; unknown/immutable/secret reject; legacy disk migration", async () => {
  await withService(async (svc) => {
    const c = client(svc);
    // Explicit whitelist only — never gemini-acp; not a universal router.
    const adapters = [
      "grok-acp",
      "codex-acp",
      "claude-acp",
      "antigravity-acp",
      "opencode-acp",
    ] as const;

    for (const adapterId of adapters) {
      const id = `pcat-${adapterId.replace(/-acp$/, "")}-row`;
      const created = (await c.profileCreate({
        id,
        adapterId,
        displayName: adapterId,
      })) as { profile: { id: string; adapterId: string; model?: string; envKey?: string; permissionPolicy?: string } };
      assert.equal(created.profile.id, id);
      assert.equal(created.profile.adapterId, adapterId);
      assert.equal(created.profile.permissionPolicy, "deny");
      if (adapterId === GROK_ACP_ADAPTER_ID) {
        assert.equal(created.profile.model, DEFAULT_GROK_MODEL);
        assert.equal(created.profile.envKey, "CPA_GROK_API_KEY");
      } else {
        // Non-grok whitelist adapters: deny only — do not invent model/envKey.
        assert.equal(created.profile.model, undefined);
        assert.equal(created.profile.envKey, undefined);
      }
      const raw = svc.runtime.getProfile(id);
      assert.ok(raw?.acp);
      assert.equal((raw as { grokAcp?: unknown }).grokAcp, undefined);
    }

    // Omit adapterId → backward-compatible default grok-acp with grok defaults.
    const def = (await c.profileCreate({ id: "pcat-default-adapter" })) as {
      profile: { adapterId: string; model?: string; envKey?: string; baseUrlEnvKey?: string };
    };
    assert.equal(def.profile.adapterId, GROK_ACP_ADAPTER_ID);
    assert.equal(def.profile.model, DEFAULT_GROK_MODEL);
    assert.equal(def.profile.envKey, "CPA_GROK_API_KEY");
    assert.equal(def.profile.baseUrlEnvKey, "CPA_GROK_BASE_URL");

    await expectParamError(svc, "profile.create", { id: "pcat-unknown-ad", adapterId: "not-a-provider" }, /adapterId|unsupported/i);
    await expectParamError(svc, "profile.create", { id: "pcat-fake-ad", adapterId: FAKE_ADAPTER_ID }, /adapterId|unsupported/i);
    // gemini-acp is intentionally not on the product whitelist.
    await expectParamError(svc, "profile.create", { id: "pcat-gemini-ad", adapterId: "gemini-acp" }, /adapterId|unsupported/i);

    // adapterId immutable on update
    await expectParamError(
      svc,
      "profile.update",
      { id: "pcat-default-adapter", adapterId: "codex-acp" },
      /adapterId|cannot be updated/i
    );

    // secret / nested bag / command still rejected
    for (const bad of [
      { id: "pcat-sec-1", apiKey: "sk" },
      { id: "pcat-sec-2", secret: "x" },
      { id: "pcat-sec-3", token: "t" },
      { id: "pcat-sec-4", env: { K: "v" } },
      { id: "pcat-sec-5", command: "x" },
      { id: "pcat-sec-6", args: ["a"] },
      { id: "pcat-sec-7", acp: { model: "x" } },
      { id: "pcat-sec-8", grokAcp: { model: "x" } },
    ]) {
      await expectParamError(svc, "profile.create", bad);
    }

    assert.ok((await rpc(svc, "profile.delete", { id: GROK_ACP_DEFAULT_PROFILE_ID })).error);
  });

  // Legacy disk migration: grokAcp → acp, atomic save, no dual-write, preserve user fields.
  // Pre-canonical rows are built only via legacyGrokAcpDiskProfile (no scattered grokAcp bags).
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-mig-"));
  const file = profilesPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      profiles: [
        {
          id: FAKE_DEFAULT_PROFILE_ID,
          adapterId: FAKE_ADAPTER_ID,
          displayNameKey: "profile.fake.default",
          fake: { waitForSignal: true },
        },
        legacyGrokAcpDiskProfile({
          id: GROK_ACP_DEFAULT_PROFILE_ID,
          adapterId: GROK_ACP_ADAPTER_ID,
          displayNameKey: "profile.grokAcp.default",
          displayName: "User Named Grok",
          grokAcp: {
            model: "user-model",
            envKey: "USER_GROK_KEY",
            permissionPolicy: "ask",
            permissionTimeoutMs: 42_000,
          },
        }),
        legacyGrokAcpDiskProfile({
          id: "custom-legacy",
          adapterId: GROK_ACP_ADAPTER_ID,
          displayName: "Legacy Custom",
          grokAcp: {
            model: "legacy-m",
            envKey: "LEGACY_KEY",
            executable: "C:\\\\tools\\\\grok.exe",
          },
        }),
      ],
    }) + "\n",
    "utf8"
  );

  const loaded = await ensureDefaultProfiles(dataDir);
  const grok = loaded.find((p) => p.id === GROK_ACP_DEFAULT_PROFILE_ID)!;
  const custom = loaded.find((p) => p.id === "custom-legacy")!;
  assert.equal(grok.displayName, "User Named Grok");
  assert.equal(grok.acp?.model, "user-model");
  assert.equal(grok.acp?.envKey, "USER_GROK_KEY");
  assert.equal(grok.acp?.permissionPolicy, "ask");
  assert.equal(grok.acp?.permissionTimeoutMs, 42_000);
  // Missing baseUrlEnvKey filled for grok only; other user fields preserved.
  assert.equal(grok.acp?.baseUrlEnvKey, "CPA_GROK_BASE_URL");
  assert.equal((grok as { grokAcp?: unknown }).grokAcp, undefined);
  assert.equal(custom.acp?.model, "legacy-m");
  assert.equal(custom.acp?.executable, "C:\\\\tools\\\\grok.exe");
  assert.equal((custom as { grokAcp?: unknown }).grokAcp, undefined);

  const disk = JSON.parse(await fs.readFile(file, "utf8")) as {
    profiles: Array<Record<string, unknown>>;
  };
  for (const row of disk.profiles) {
    assert.ok(!("grokAcp" in row), `disk still has grokAcp on ${row.id}`);
    if (row.adapterId === GROK_ACP_ADAPTER_ID) {
      assert.ok(row.acp && typeof row.acp === "object");
    }
  }
  const diskGrok = disk.profiles.find((p) => p.id === GROK_ACP_DEFAULT_PROFILE_ID)!;
  assert.equal(diskGrok.displayName, "User Named Grok");
  assert.equal((diskGrok.acp as { model?: string }).model, "user-model");
});
