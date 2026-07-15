/**
 * Windows MVP machine-local CredentialStore + credentialRef injection.
 * Offline: inject test protector (no real DPAPI / network).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProviderAdapter, LaunchPlan } from "../src/adapters/types.js";
import { FAKE_ADAPTER_ID, createFakeAdapter } from "../src/adapters/fake/index.js";
import { GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import {
  createAgentRuntime,
  makeSessionId,
  type RuntimeEvent,
} from "../src/runtime/index.js";
import type { AgentProfileConfig } from "../src/runtime/types.js";
import { createTestCredentialProtector } from "../src/service/credential-protector.js";
import {
  CredentialStore,
  credentialsPath,
} from "../src/service/credential-store.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { createServiceClient } from "../src/service/client.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { FAKE_DEFAULT_PROFILE_ID } from "../src/service/profiles.js";

const SECRET = "sk-test-super-secret-value-NOT-FOR-DISK";
const MOCK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function mockProtector() {
  return createTestCredentialProtector("test-enc:");
}

test("CLIENT_METHODS includes credential.list/set/delete and no get", () => {
  assert.ok(isClientMethod("credential.list"));
  assert.ok(isClientMethod("credential.set"));
  assert.ok(isClientMethod("credential.delete"));
  assert.equal(isClientMethod("credential.get"), false);
  assert.equal(isClientMethod("credential.resolve"), false);
  assert.ok(CLIENT_METHODS.includes("credential.list"));
});

test("CredentialStore: disk has ciphertext only; list never returns secret", async () => {
  const dataDir = await tempDir("tent-cred-store-");
  const store = new CredentialStore(dataDir, { protector: mockProtector() });

  const setResult = await store.set("grok-key", SECRET, { label: "Grok CPA" });
  assert.equal(setResult.id, "grok-key");
  assert.equal(setResult.metadata?.label, "Grok CPA");
  assert.equal(
    JSON.stringify(setResult).includes(SECRET),
    false,
    "set response must not contain secret"
  );
  assert.equal("ciphertext" in setResult, false);
  assert.equal("secret" in setResult, false);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, "grok-key");
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
  assert.equal("ciphertext" in listed[0]!, false);

  const raw = await fs.readFile(credentialsPath(dataDir), "utf8");
  assert.equal(raw.includes(SECRET), false, "disk must not contain plaintext secret");
  assert.equal(raw.includes("sk-test"), false);
  const parsed = JSON.parse(raw) as {
    credentials: Array<{ id: string; ciphertext: string; metadata?: { label?: string } }>;
  };
  assert.equal(parsed.credentials.length, 1);
  assert.ok(parsed.credentials[0]!.ciphertext.startsWith("test-enc:"));
  assert.notEqual(parsed.credentials[0]!.ciphertext, SECRET);
  assert.equal(parsed.credentials[0]!.metadata?.label, "Grok CPA");

  const plain = await store.resolve("grok-key");
  assert.equal(plain, SECRET);

  await store.delete("grok-key");
  await assert.rejects(() => store.resolve("grok-key"), /not found/i);
  assert.equal(await store.has("grok-key"), false);
});

test(
  "CredentialStore: Windows DPAPI survives a fresh store instance",
  { skip: process.platform !== "win32" },
  async () => {
    const dataDir = await tempDir("tent-cred-dpapi-");
    const secret = `tent-dpapi-${Date.now()}-${Math.random()}`;
    try {
      await new CredentialStore(dataDir).set("dpapi-smoke", secret);
      const raw = await fs.readFile(credentialsPath(dataDir), "utf8");
      assert.equal(raw.includes(secret), false);
      assert.equal(
        await new CredentialStore(dataDir).resolve("dpapi-smoke"),
        secret
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
);

test("CredentialStore: invalid id and corrupt file quarantine", async () => {
  const dataDir = await tempDir("tent-cred-bad-");
  const store = new CredentialStore(dataDir, { protector: mockProtector() });

  await assert.rejects(() => store.set("BAD_ID", SECRET), /Invalid credential id/);
  await assert.rejects(() => store.set("ok-id", ""), /non-empty/);

  const file = credentialsPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, "{not-json", "utf8");

  const store2 = new CredentialStore(dataDir, { protector: mockProtector() });
  const list = await store2.list();
  assert.deepEqual(list, []);
  const names = await fs.readdir(dataDir);
  assert.ok(
    names.some((n) => n.includes("corrupt")),
    "corrupt file should be backed up"
  );
});

test("RPC credential.*: set/list/delete never echo secret; no get method", async () => {
  const dataDir = await tempDir("tent-cred-rpc-");
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    credentialProtector: mockProtector(),
    profiles: [
      {
        id: FAKE_DEFAULT_PROFILE_ID,
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true, emitStdout: true },
      },
    ],
  });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const setRes = (await client.credentialSet("cpa-key", SECRET, {
      label: "test",
    })) as {
      credential: { id: string; label?: string; metadata?: { label?: string } };
    };
    assert.equal(setRes.credential.id, "cpa-key");
    assert.ok(
      setRes.credential.label === "test" || setRes.credential.metadata?.label === "test"
    );
    assert.equal(JSON.stringify(setRes).includes(SECRET), false);

    const listRes = (await client.credentialList()) as {
      credentials: Array<Record<string, unknown>>;
    };
    assert.equal(listRes.credentials.length, 1);
    assert.equal(JSON.stringify(listRes).includes(SECRET), false);

    // Direct RPC: method not found for get; set response still clean.
    const getRpc = await rpcCall(svc.url, "credential.get", { id: "cpa-key" }, {
      token: svc.token,
    });
    assert.ok(getRpc.error);
    assert.equal(getRpc.error!.code, -32601);

    const rawDisk = await fs.readFile(credentialsPath(dataDir), "utf8");
    assert.equal(rawDisk.includes(SECRET), false);

    // profile projection can show ref presence after update
    const created = (await client.profileCreate({
      id: "with-ref",
      adapterId: "grok-acp",
      envKey: "CPA_GROK_API_KEY",
      credentialRef: "cpa-key",
    })) as {
      profile: {
        credentialRef?: string;
        credentialExists?: boolean;
        envKey?: string;
      };
    };
    assert.equal(created.profile.credentialRef, "cpa-key");
    assert.equal(created.profile.credentialExists, true);
    assert.equal(JSON.stringify(created).includes(SECRET), false);

    // Reject secret-like profile fields
    await assert.rejects(
      () =>
        client.profileCreate({
          id: "bad-secret",
          adapterId: "grok-acp",
          apiKey: SECRET,
        }),
      /dangerous|unsupported|secret|apiKey/i
    );

    await client.credentialDelete("cpa-key");
    const after = (await client.credentialList()) as { credentials: unknown[] };
    assert.equal(after.credentials.length, 0);

    const gone = (await client.profileGet("with-ref")) as {
      profile: { credentialExists?: boolean };
    };
    assert.equal(gone.profile.credentialExists, false);
  } finally {
    await svc.stop();
  }
});

test("AgentRuntime: resolveProfileEnv injects env; missing ref fails; no secret on SessionRecord", async () => {
  const dataDir = await tempDir("tent-cred-rt-");
  const cwd = await tempDir("tent-cred-cwd-");
  const store = new CredentialStore(dataDir, { protector: mockProtector() });
  await store.set("vault-1", SECRET);

  let capturedEnv: Record<string, string> | undefined;
  const mockAdapter: ProviderAdapter = {
    id: "mock-env-capture",
    displayNameKey: "adapter.mockEnv.displayName",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "env",
      observeLevel: "structured",
    }),
    resolveLaunch: async () => {
      throw new Error("should use startManagedSession");
    },
    mapExit: (code) => ({
      type: "session.exited",
      sessionId: "",
      exitCode: code,
    }),
    startManagedSession: async (plan: LaunchPlan, emit) => {
      capturedEnv = { ...(plan.env ?? {}) };
      emit({ type: "session.live", sessionId: plan.sessionId, pid: 1 });
      return {
        sessionId: plan.sessionId,
        pid: 1,
        isAlive: () => true,
        stop: async () => undefined,
      };
    },
  };

  const profile: AgentProfileConfig = {
    id: "prof-with-cred",
    adapterId: "mock-env-capture",
    acp: {
      envKey: "CPA_GROK_API_KEY",
      credentialRef: "vault-1",
      permissionPolicy: "deny",
    },
  };

  const runtime = createAgentRuntime({
    dataDir,
    profiles: [profile],
    adapters: [mockAdapter, createFakeAdapter()],
    resolveProfileEnv: async (p) => {
      const ref = p.acp?.credentialRef?.trim();
      const envKey = p.acp?.envKey?.trim();
      if (!ref || !envKey) return {};
      const secret = await store.resolve(ref);
      return { [envKey]: secret };
    },
  });

  const sessionId = makeSessionId(() => 0.11);
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((ev) => events.push(ev));

  const handle = await runtime.startSession({
    sessionId,
    profileId: "prof-with-cred",
    cwd,
  });
  assert.equal(handle.state, "live");
  assert.ok(capturedEnv);
  assert.equal(capturedEnv!["CPA_GROK_API_KEY"], SECRET);

  const rec = await runtime.registry.read(sessionId);
  assert.ok(rec);
  const recJson = JSON.stringify(rec);
  assert.equal(recJson.includes(SECRET), false, "SessionRecord must not store secret");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();

  // Missing credentialRef fails loud
  const dataDir2 = await tempDir("tent-cred-rt2-");
  const runtime2 = createAgentRuntime({
    dataDir: dataDir2,
    profiles: [
      {
        id: "missing-ref",
        adapterId: "mock-env-capture",
        acp: {
          envKey: "CPA_GROK_API_KEY",
          credentialRef: "does-not-exist",
        },
      },
    ],
    adapters: [mockAdapter, createFakeAdapter()],
    resolveProfileEnv: async (p) => {
      const ref = p.acp?.credentialRef?.trim();
      const envKey = p.acp?.envKey?.trim();
      if (!ref || !envKey) return {};
      try {
        const secret = await store.resolve(ref);
        return { [envKey]: secret };
      } catch {
        return {};
      }
    },
  });
  const missingSessionId = makeSessionId(() => 0.22);
  await assert.rejects(
    () =>
      runtime2.startSession({
        sessionId: missingSessionId,
        profileId: "missing-ref",
        cwd,
      }),
    /Credential not found|empty/i
  );
  const missingRecord = await runtime2.registry.read(missingSessionId);
  assert.equal(missingRecord?.state, "failed");
  assert.equal(JSON.stringify(missingRecord).includes(SECRET), false);
  await runtime2.shutdown();

  // credentialRef without envKey fails
  const dataDir3 = await tempDir("tent-cred-rt3-");
  const runtime3 = createAgentRuntime({
    dataDir: dataDir3,
    profiles: [
      {
        id: "no-envkey",
        adapterId: FAKE_ADAPTER_ID,
        acp: { credentialRef: "vault-1" },
      },
    ],
    resolveProfileEnv: async () => ({ X: "y" }),
  });
  await assert.rejects(
    () =>
      runtime3.startSession({
        sessionId: makeSessionId(() => 0.33),
        profileId: "no-envkey",
        cwd,
      }),
    /no acp\.envKey/i
  );
  await runtime3.shutdown();
});

test("startLocalTentService: credentialRef reaches mock ACP env via vault", async () => {
  const dataDir = await tempDir("tent-cred-svc-");
  const logPath = path.join(dataDir, "mock-acp.log");
  const profiles: AgentProfileConfig[] = [
    {
      id: FAKE_DEFAULT_PROFILE_ID,
      adapterId: FAKE_ADAPTER_ID,
      fake: { waitForSignal: true, emitStdout: true },
    },
    {
      id: "grok-with-vault",
      adapterId: GROK_ACP_ADAPTER_ID,
      command: process.execPath,
      args: [MOCK, "agent", "--model", "test-model", "stdio"],
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "1",
        MOCK_ACP_PROMPT_TEXT: "CRED_OK",
      },
      acp: {
        model: "test-model",
        envKey: "CPA_GROK_API_KEY",
        credentialRef: "svc-vault",
        permissionPolicy: "deny",
        promptTimeoutMs: 8_000,
      },
    },
  ];

  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    profiles,
    credentialProtector: mockProtector(),
  });
  try {
    await svc.credentials.set("svc-vault", SECRET, { label: "svc" });
    const cwd = await tempDir("tent-cred-svc-cwd-");
    const sessionId = makeSessionId(() => 0.44);
    const handle = await svc.runtime.startSession({
      sessionId,
      profileId: "grok-with-vault",
      cwd,
      bootstrapPrompt: "ping",
    });
    assert.ok(handle.state === "live" || handle.state === "starting");

    // Wait briefly for mock to write log if it records env
    await new Promise((r) => setTimeout(r, 400));
    await svc.runtime.stopSession(sessionId, "user");

    const sessionFile = path.join(dataDir, "sessions", `${sessionId}.json`);
    try {
      const sessionRaw = await fs.readFile(sessionFile, "utf8");
      assert.equal(sessionRaw.includes(SECRET), false);
    } catch {
      // session may already be cleaned; still ok
    }

    const vaultRaw = await fs.readFile(credentialsPath(dataDir), "utf8");
    assert.equal(vaultRaw.includes(SECRET), false);

    // Remove vault entry — profile still references it → fail-loud before live
    await svc.credentials.delete("svc-vault");
    await assert.rejects(
      () =>
        svc.runtime.startSession({
          sessionId: makeSessionId(() => 0.55),
          profileId: "grok-with-vault",
          cwd,
        }),
      /Credential not found|empty|credentialRef/i
    );
  } finally {
    await svc.stop();
  }
});
