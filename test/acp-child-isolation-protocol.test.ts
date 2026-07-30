/**
 * ACP child isolation + Service protocol handshake (cx-ehqdtz / tk-xsz304nn).
 * Focused production-path coverage:
 * 1) minimal host env allowlist + explicit launch env + reserved Core keys
 * 2) secret redaction through diagnostics / registry projections
 * 3) legacy / mismatch / match protocol attach
 * 4) load-replay quarantine (incl. late) + bootstrap image one-shot
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/adapters/acp/client.js";
import {
  collectSecretValues,
  redactDiagnosticText,
  redactSecrets,
} from "../src/adapters/acp/redact.js";
import { createGrokAcpAdapter, GROK_ACP_ADAPTER_ID } from "../src/adapters/grok-acp/index.js";
import { DEFAULT_GROK_ENV_KEY, DEFAULT_GROK_MODEL } from "../src/adapters/grok-acp/types.js";
import {
  attachOrBootstrapService,
  tryAttachService,
} from "../src/cli/service-attach.js";
import {
  buildManagedChildEnv,
  isReservedTentChildEnvKey,
  pickMinimalHostEnv,
  stripReservedTentChildEnv,
} from "../src/runtime/child-env.js";
import { createAgentRuntime } from "../src/runtime/agent-runtime.js";
import { ProcessSupervisor } from "../src/runtime/process-supervisor.js";
import type { RuntimeEvent } from "../src/runtime/types.js";
import { startLocalTentService } from "../src/service/service.js";
import {
  assertServiceProtocolCompatible,
  isServiceProtocolCompatible,
  TENT_SERVICE_PROTOCOL_VERSION,
} from "../src/service/protocol.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_ACP = path.join(repoRoot, "test", "fixtures", "mock-acp-server.mjs");
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ── 1) Minimal host env allowlist ──────────────────────────────────────────

test("pickMinimalHostEnv: allowlists launch necessities; drops arbitrary host secrets", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/tent",
    TMPDIR: "/tmp",
    LANG: "C",
    CPA_GROK_API_KEY: "must-not-inherit",
    OPENAI_API_KEY: "must-not-inherit",
    TENT_SERVICE_DATA_DIR: "C:\\evil-data",
    TENT_SERVICE_TOKEN: "svc-token-must-not-bleed",
    RANDOM_HOST_LEAK: "nope",
    USERPROFILE: "C:\\Users\\tent",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  } as NodeJS.ProcessEnv;

  const win = pickMinimalHostEnv(host, "win32");
  assert.equal(win.PATH, "/usr/bin");
  assert.equal(win.USERPROFILE, "C:\\Users\\tent");
  assert.equal(win.SystemRoot, "C:\\Windows");
  assert.equal(win.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(win.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(win.CPA_GROK_API_KEY, undefined);
  assert.equal(win.OPENAI_API_KEY, undefined);
  assert.equal(win.TENT_SERVICE_DATA_DIR, undefined);
  assert.equal(win.TENT_SERVICE_TOKEN, undefined);
  assert.equal(win.RANDOM_HOST_LEAK, undefined);

  const posix = pickMinimalHostEnv(host, "linux");
  assert.equal(posix.HOME, "/home/tent");
  assert.equal(posix.TMPDIR, "/tmp");
  assert.equal(posix.PATH, "/usr/bin");
  assert.equal(posix.CPA_GROK_API_KEY, undefined);
  assert.equal(posix.TENT_SERVICE_DATA_DIR, undefined);
});

test("buildManagedChildEnv: overlays launch env; Core reserved keys win over profile", () => {
  const host = {
    PATH: "/bin",
    HOME: "/home/h",
    HOST_SECRET_API_KEY: "host-secret",
    TENT_SERVICE_DATA_DIR: "C:\\host-must-lose",
  } as NodeJS.ProcessEnv;

  const env = buildManagedChildEnv({
    hostEnv: host,
    platform: "linux",
    launchEnv: {
      CPA_GROK_API_KEY: "profile-secret-ok",
      CUSTOM_FLAG: "1",
      TENT_SERVICE_DATA_DIR: "C:\\profile-must-not-win",
      TENT_SESSION_ID: "ss-from-profile",
    },
    reserved: {
      TENT_SERVICE_DATA_DIR: "C:\\core-data",
      TENT_SESSION_ID: "ss-core",
    },
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/h");
  assert.equal(env.CPA_GROK_API_KEY, "profile-secret-ok");
  assert.equal(env.CUSTOM_FLAG, "1");
  assert.equal(env.TENT_SERVICE_DATA_DIR, "C:\\core-data");
  assert.equal(env.TENT_SESSION_ID, "ss-core");
  assert.equal(env.HOST_SECRET_API_KEY, undefined);
  assert.ok(isReservedTentChildEnvKey("TENT_SERVICE_DATA_DIR"));
  assert.deepEqual(
    stripReservedTentChildEnv({
      TENT_SERVICE_DATA_DIR: "x",
      OK: "1",
    }),
    { OK: "1" }
  );
});

test("ProcessSupervisor spawn env uses allowlist not full process.env", async () => {
  const prevLeak = process.env.TENT_TEST_HOST_LEAK_SECRET;
  const prevKey = process.env.TENT_TEST_FAKE_API_KEY;
  process.env.TENT_TEST_HOST_LEAK_SECRET = "host-leak-value-xyz";
  process.env.TENT_TEST_FAKE_API_KEY = "host-api-key-xyz";
  try {
    const cwd = await tempDir("tent-sup-env-");
    const outFile = path.join(cwd, "child-env.json");
    const script = path.join(cwd, "dump-env.mjs");
    // Write via env path so argv is not required (stdio ignored by supervisor).
    await fs.writeFile(
      script,
      `import fs from "node:fs";
const out = process.env.TENT_DUMP_ENV_PATH;
if (!out) { process.stderr.write("missing TENT_DUMP_ENV_PATH\\n"); process.exit(2); }
fs.writeFileSync(out, JSON.stringify(process.env), "utf8");
`,
      "utf8"
    );
    const supervisor = new ProcessSupervisor({ gracefulMs: 500 });
    const started = await supervisor.start("ss-env", {
      command: process.execPath,
      args: [script],
      cwd,
      env: {
        EXPLICIT_OK: "from-launch",
        CPA_GROK_API_KEY: "launch-secret-only",
        TENT_SERVICE_DATA_DIR: "C:\\core-from-launch",
        TENT_DUMP_ENV_PATH: outFile,
      },
    });
    assert.ok(started.pid > 0);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        await fs.access(outFile);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    const childEnv = JSON.parse(await fs.readFile(outFile, "utf8")) as Record<
      string,
      string
    >;
    assert.equal(childEnv.EXPLICIT_OK, "from-launch");
    assert.equal(childEnv.CPA_GROK_API_KEY, "launch-secret-only");
    assert.equal(childEnv.TENT_SERVICE_DATA_DIR, "C:\\core-from-launch");
    assert.equal(childEnv.TENT_TEST_HOST_LEAK_SECRET, undefined);
    assert.equal(childEnv.TENT_TEST_FAKE_API_KEY, undefined);
    // PATH must still resolve node on the host platform
    assert.ok(childEnv.PATH || childEnv.Path);
    await supervisor.stop("ss-env").catch(() => undefined);
  } finally {
    if (prevLeak === undefined) delete process.env.TENT_TEST_HOST_LEAK_SECRET;
    else process.env.TENT_TEST_HOST_LEAK_SECRET = prevLeak;
    if (prevKey === undefined) delete process.env.TENT_TEST_FAKE_API_KEY;
    else process.env.TENT_TEST_FAKE_API_KEY = prevKey;
  }
});

test("AgentRuntime: profile cannot override reserved TENT_SERVICE_DATA_DIR", async () => {
  const dataDir = await tempDir("tent-reserved-");
  const cwd = await tempDir("tent-reserved-cwd-");
  const captured: Array<string | undefined> = [];
  const adapter = {
    id: "env-capture",
    displayNameKey: "env-capture",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none" as const,
      observeLevel: "structured" as const,
    }),
    resolveLaunch: () => {
      throw new Error("managed-only");
    },
    startManagedSession: async (plan: { env: Record<string, string>; sessionId: string }) => {
      captured.push(plan.env.TENT_SERVICE_DATA_DIR);
      return {
        sessionId: plan.sessionId,
        pid: 4242,
        isAlive: () => true,
        stop: async () => undefined,
      };
    },
    mapExit: () => ({ type: "session.exited" as const, sessionId: "", exitCode: 0 }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        id: "p-reserved",
        adapterId: "env-capture",
        env: { TENT_SERVICE_DATA_DIR: "C:\\profile-must-not-win" },
      },
    ],
  });
  await runtime.startSession({
    sessionId: "ss-reserved",
    profileId: "p-reserved",
    cwd,
    env: { TENT_SERVICE_DATA_DIR: "C:\\request-must-not-win" },
  });
  assert.equal(captured[0], dataDir);
  await runtime.stopSession("ss-reserved", "user");
  await runtime.shutdown();
});

// ── 2) Secret redaction ────────────────────────────────────────────────────

test("redact helpers: secret-named env values never survive diagnostics", () => {
  const secret = "sk-live-super-secret-value-99";
  const env = {
    CPA_GROK_API_KEY: secret,
    PATH: "/usr/bin",
    SAFE_NOTE: "ok",
  };
  const secrets = collectSecretValues(env);
  assert.ok(secrets.includes(secret));
  assert.equal(redactSecrets(`stderr has ${secret} inside`, secrets).includes(secret), false);
  assert.match(
    redactDiagnosticText(`RPC failed: token=${secret}`, { env }),
    /\[redacted\]/
  );
});

test("AcpClient: stderr tail and RPC errors redact launch secrets", async () => {
  const cwd = await tempDir("tent-acp-redact-");
  const secret = "provider-secret-value-ABC12345";
  const events: RuntimeEvent[] = [];
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: {
      MOCK_ACP_FAIL_NEW: "1",
      MOCK_ACP_KEEP_ALIVE: "0",
      CPA_GROK_API_KEY: secret,
      // Make mock print secret on stderr before fail if possible — also cover formatRpcError path.
      MOCK_ACP_STDERR: `leaking ${secret}`,
    },
    sessionId: "ss-redact-diag",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: (ev) => events.push(ev),
  });
  try {
    await assert.rejects(() => client.connect(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(secret));
      return true;
    });
  } finally {
    await client.stop("shutdown");
  }
  for (const ev of events) {
    const blob = JSON.stringify(ev);
    assert.doesNotMatch(blob, new RegExp(secret), `event must not leak secret: ${ev.type}`);
  }
  assert.doesNotMatch(client.lastStderrTail, new RegExp(secret));
});

test("runtime start failure redacts credential values from SessionRegistry projection", async () => {
  const dataDir = await tempDir("tent-reg-redact-");
  const cwd = await tempDir("tent-reg-redact-cwd-");
  const secret = "vault-secret-value-XYZ98765";
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [
      createGrokAcpAdapter({
        resolveApiKey: () => secret,
      }),
    ],
    profiles: [
      {
        id: "grok-redact-start",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        // missing mock args → spawn/connect will fail after env injection
        args: [path.join(cwd, "no-such-mock.mjs")],
        env: {
          CPA_GROK_API_KEY: secret,
        },
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
        },
      },
    ],
  });
  await assert.rejects(() =>
    runtime.startSession({
      sessionId: "ss-reg-redact",
      profileId: "grok-redact-start",
      cwd,
    })
  );
  const record = await runtime.registry.read("ss-reg-redact");
  assert.ok(record);
  const raw = JSON.stringify(record);
  assert.doesNotMatch(raw, new RegExp(secret));
  if (record.lastError) {
    assert.doesNotMatch(record.lastError, new RegExp(secret));
  }
  await runtime.shutdown();
});

// ── 3) Protocol handshake ──────────────────────────────────────────────────

test("protocol helpers: match transparent; legacy and mismatch fail loud", () => {
  assert.equal(
    isServiceProtocolCompatible({
      status: "ok",
      protocolVersion: TENT_SERVICE_PROTOCOL_VERSION,
    }),
    true
  );
  assert.equal(isServiceProtocolCompatible({ status: "ok" }), false);
  assert.equal(
    isServiceProtocolCompatible({ status: "ok", protocolVersion: 999 }),
    false
  );
  assert.doesNotThrow(() =>
    assertServiceProtocolCompatible({
      status: "ok",
      protocolVersion: TENT_SERVICE_PROTOCOL_VERSION,
      version: "0.1.0-b5",
    })
  );
  assert.throws(
    () => assertServiceProtocolCompatible({ status: "ok", version: "0.1.0-b5" }),
    /protocol is missing|legacy|Restart or upgrade/i
  );
  assert.throws(
    () =>
      assertServiceProtocolCompatible({
        status: "ok",
        protocolVersion: 0,
        version: "0.1.0-b5",
      }),
    /protocol mismatch|Restart or upgrade/i
  );
});

test("service.health advertises protocolVersion; matching attach succeeds", async () => {
  const dataDir = await tempDir("tent-proto-match-");
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const health = (await fetch(`${svc.url}/health`).then((r) => r.json())) as {
      status: string;
      protocolVersion?: number;
      version: string;
    };
    assert.equal(health.status, "ok");
    assert.equal(health.protocolVersion, TENT_SERVICE_PROTOCOL_VERSION);

    const attached = await tryAttachService(dataDir);
    assert.ok(attached);
    assert.equal(attached!.url, svc.url);

    const boot = await attachOrBootstrapService({
      dataDir,
      attachOnly: true,
      packageRoot: repoRoot,
    });
    assert.equal(boot.started, false);
    assert.equal(boot.url, svc.url);
  } finally {
    await svc.stop();
  }
});

test("tryAttachService: healthy legacy (no protocolVersion) fails before business RPC", async () => {
  const dataDir = await tempDir("tent-proto-legacy-");
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    // Simulate legacy health by proxying through a shim that strips protocolVersion.
    const realFetch = globalThis.fetch;
    const shimFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      if (url.includes("/health")) {
        const body = (await res.json()) as Record<string, unknown>;
        delete body.protocolVersion;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return res;
    };
    await assert.rejects(
      () => tryAttachService(dataDir, shimFetch),
      /protocol is missing|legacy|Restart or upgrade/i
    );
    await assert.rejects(
      () =>
        attachOrBootstrapService({
          dataDir,
          attachOnly: true,
          packageRoot: repoRoot,
          fetchImpl: shimFetch,
        }),
      /protocol is missing|legacy|Restart or upgrade/i
    );
  } finally {
    await svc.stop();
  }
});

test("tryAttachService: healthy mismatched protocol fails and does not spawn competitor", async () => {
  const dataDir = await tempDir("tent-proto-mismatch-");
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  let spawnCalled = false;
  try {
    const realFetch = globalThis.fetch;
    const shimFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      if (url.includes("/health")) {
        const body = (await res.json()) as Record<string, unknown>;
        body.protocolVersion = 999;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return res;
    };
    await assert.rejects(
      () =>
        attachOrBootstrapService({
          dataDir,
          packageRoot: repoRoot,
          fetchImpl: shimFetch,
          spawnFn: ((..._args: unknown[]) => {
            spawnCalled = true;
            throw new Error("spawn must not run on protocol mismatch");
          }) as typeof import("node:child_process").spawn,
        }),
      /protocol mismatch|Restart or upgrade/i
    );
    assert.equal(spawnCalled, false);
  } finally {
    await svc.stop();
  }
});

// ── 4) Load replay + bootstrap image one-shot ──────────────────────────────

test("load replay (incl. late) never becomes prompt_complete / delivery text", async () => {
  const cwd = await tempDir("tent-late-replay-");
  const logPath = path.join(cwd, "mock-acp-log.json");
  const events: RuntimeEvent[] = [];
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const session = await adapter.resumeManagedSession!(
    {
      sessionId: "ss-late-replay",
      profileId: "grok-late",
      cwd,
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "0",
        MOCK_ACP_LOAD_SESSION: "1",
        MOCK_ACP_HISTORY_TEXT: "LATE_HISTORY_MUST_NOT_DELIVER",
        MOCK_ACP_LATE_HISTORY_MS: "80",
        MOCK_ACP_PROMPT_TEXT: "ONLY_POST_LOAD_OK",
        CPA_GROK_API_KEY: "test-key",
      },
      command: process.execPath,
      args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
      bootstrapPrompt: "post-load bootstrap",
      extras: {
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
          promptTimeoutMs: 8_000,
        },
      },
    },
    { raw: "mock-acp-session-1", providerSessionId: "mock-acp-session-1" },
    (e) => events.push(e)
  );
  const managed = session as typeof session & { waitBootstrap(): Promise<void> };
  await managed.waitBootstrap();
  // Allow late history timer to fire after load quiescence.
  await new Promise((r) => setTimeout(r, 200));

  const completes = events.filter((e) => e.type === "session.prompt_complete");
  assert.equal(completes.length, 1);
  const text = (completes[0] as Extract<RuntimeEvent, { type: "session.prompt_complete" }>)
    .assistantText;
  assert.equal(text, "ONLY_POST_LOAD_OK");
  assert.doesNotMatch(text, /LATE_HISTORY|HISTORY_MUST_NOT/);
  assert.ok(
    !events.some(
      (e) =>
        e.type === "session.prompt_complete" &&
        "assistantText" in e &&
        String(e.assistantText).includes("LATE_HISTORY")
    )
  );
  await session.stop("shutdown");
});

test("bootstrap images project once on first managed prompt; not on follow-up", async () => {
  const workspace = await tempDir("tent-img-once-");
  const systemRoot = path.join(workspace, ".tent");
  await fs.mkdir(path.join(systemRoot, "attachments", "cx"), { recursive: true });
  const rel = "attachments/cx/dot.png";
  await fs.writeFile(path.join(systemRoot, rel), PNG_1X1);
  const logPath = path.join(workspace, "mock-log.json");
  const events: RuntimeEvent[] = [];

  const adapter = createGrokAcpAdapter({
    resolveApiKey: (_k, planEnv) => planEnv.CPA_GROK_API_KEY ?? "test-key",
  });
  const session = await adapter.startManagedSession(
    {
      sessionId: "ss-img-once",
      profileId: "mock-img-once",
      cwd: workspace,
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "1",
        MOCK_ACP_PROMPT_IMAGE: "1",
        MOCK_ACP_PROMPT_TEXT: "FIRST_OK",
        MOCK_ACP_FOLLOWUP_TEXT: "FOLLOW_OK",
        CPA_GROK_API_KEY: "test-key-not-real",
      },
      command: process.execPath,
      args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
      bootstrapPrompt: "first bootstrap with image",
      bootstrapImageRefs: [{ relativePath: rel, markdownPointer: `![](${rel})` }],
      extras: {
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
          promptTimeoutMs: 8_000,
        },
        bootstrapImageSystemRoot: systemRoot,
      },
    },
    (ev) => events.push(ev)
  );

  const managed = session as typeof session & {
    waitBootstrap(): Promise<void>;
    sendFollowUpPrompt(prompt: string): Promise<void>;
  };
  await managed.waitBootstrap();
  const firstComplete = events.filter((e) => e.type === "session.prompt_complete");
  assert.equal(firstComplete.length, 1);

  await managed.sendFollowUpPrompt("## User Input\n\nfollow-up without re-image");
  const deadline = Date.now() + 8_000;
  while (
    Date.now() < deadline &&
    events.filter((e) => e.type === "session.prompt_complete").length < 2
  ) {
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(
    events.filter((e) => e.type === "session.prompt_complete").length,
    2,
    "expected follow-up prompt_complete"
  );

  let log: {
    promptBlocks: Array<Array<{ type: string; mimeType?: string }>>;
  } | null = null;
  const logDeadline = Date.now() + 3_000;
  while (Date.now() < logDeadline) {
    try {
      const parsed = JSON.parse(await fs.readFile(logPath, "utf8")) as {
        promptBlocks: Array<Array<{ type: string; mimeType?: string }>>;
      };
      if (Array.isArray(parsed.promptBlocks) && parsed.promptBlocks.length >= 2) {
        log = parsed;
        break;
      }
    } catch {
      // incomplete flush
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(log, "expected mock log with two promptBlocks");
  assert.ok(
    log.promptBlocks[0]!.some((b) => b.type === "image"),
    "first managed prompt must project image"
  );
  assert.ok(
    log.promptBlocks[1]!.every((b) => b.type !== "image"),
    "follow-up must not re-project bootstrap images"
  );
  await session.stop("shutdown");
});

