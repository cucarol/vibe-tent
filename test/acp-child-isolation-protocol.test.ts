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
import type { RuntimeEvent, StartSessionRequest } from "../src/runtime/types.js";
import { startLocalTentService } from "../src/service/service.js";
import {
  assertServiceProtocolCompatible,
  isServiceProtocolCompatible,
  isServiceProtocolIncompatibleError,
  ServiceProtocolIncompatibleError,
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

function startConnection(
  runtime: ReturnType<typeof createAgentRuntime>,
  request: StartSessionRequest & { connectionId: string }
) {
  const { connectionId, ...start } = request;
  const workspace = start.workspace ?? start.workspaceLane?.workspace ?? start.runtimeWorkspace?.cwd ?? start.cwd;
  if (!workspace) throw new Error("test start requires a workspace");
  const lastTaskId = start.lastTaskId ?? `tk-${start.sessionId.replace(/[^a-z0-9]/gi, "")}`;
  return runtime.reserveSession({
    sessionId: start.sessionId,
    connectionId,
    lastTaskId,
    workspace,
    workspaceLane: start.workspaceLane,
    runtimeWorkspace: start.runtimeWorkspace,
    cwd: start.cwd,
  }).then(() => runtime.startSession({ ...start, lastTaskId, workspace }));
}

// ── 1) Minimal host env allowlist ──────────────────────────────────────────

test("pickMinimalHostEnv: OS launch necessities only; drops NODE_OPTIONS/proxy/npm/user", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/tent",
    TMPDIR: "/tmp",
    LANG: "C",
    NODE_OPTIONS: "--require /tmp/evil.js",
    NODE_PATH: "/evil/node_path",
    NODE_EXTRA_CA_CERTS: "/evil/ca.pem",
    SSL_CERT_FILE: "/evil/ssl.pem",
    HTTPS_PROXY: "http://user:proxy-secret@proxy:8080",
    HTTP_PROXY: "http://user:proxy-secret@proxy:8080",
    npm_execpath: "C:\\evil\\npm-cli.js",
    npm_node_execpath: "C:\\evil\\node.exe",
    npm_config_user_agent: "evil-agent",
    CPA_GROK_API_KEY: "must-not-inherit",
    OPENAI_API_KEY: "must-not-inherit",
    TENT_SERVICE_DATA_DIR: "C:\\evil-data",
    TENT_SERVICE_TOKEN: "svc-token-must-not-bleed",
    RANDOM_HOST_LEAK: "nope",
    USERNAME: "must-not-inherit-user",
    USERDOMAIN: "EVILDOMAIN",
    ProgramFiles: "C:\\Program Files",
    USERPROFILE: "C:\\Users\\tent",
    LOCALAPPDATA: "C:\\Users\\tent\\AppData\\Local",
    APPDATA: "C:\\Users\\tent\\AppData\\Roaming",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  } as NodeJS.ProcessEnv;

  const win = pickMinimalHostEnv(host, "win32");
  assert.equal(win.PATH, "/usr/bin");
  assert.equal(win.USERPROFILE, "C:\\Users\\tent");
  assert.equal(win.LOCALAPPDATA, "C:\\Users\\tent\\AppData\\Local");
  assert.equal(win.APPDATA, "C:\\Users\\tent\\AppData\\Roaming");
  assert.equal(win.SystemRoot, "C:\\Windows");
  assert.equal(win.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(win.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(win.LANG, "C");
  assert.equal(win.NODE_OPTIONS, undefined);
  assert.equal(win.NODE_PATH, undefined);
  assert.equal(win.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(win.SSL_CERT_FILE, undefined);
  assert.equal(win.HTTPS_PROXY, undefined);
  assert.equal(win.HTTP_PROXY, undefined);
  assert.equal(win.npm_execpath, undefined);
  assert.equal(win.npm_node_execpath, undefined);
  assert.equal(win.USERNAME, undefined);
  assert.equal(win.ProgramFiles, undefined);
  assert.equal(win.CPA_GROK_API_KEY, undefined);
  assert.equal(win.TENT_SERVICE_DATA_DIR, undefined);
  assert.equal(win.RANDOM_HOST_LEAK, undefined);

  const posix = pickMinimalHostEnv(host, "linux");
  assert.equal(posix.HOME, "/home/tent");
  assert.equal(posix.TMPDIR, "/tmp");
  assert.equal(posix.PATH, "/usr/bin");
  assert.equal(posix.NODE_OPTIONS, undefined);
  assert.equal(posix.HTTPS_PROXY, undefined);
  assert.equal(posix.CPA_GROK_API_KEY, undefined);
});

test("buildManagedChildEnv: launchEnv opt-in non-reserved; reserved only via core overlay", () => {
  const host = {
    PATH: "/bin",
    HOME: "/home/h",
    HOST_SECRET_API_KEY: "host-secret",
    NODE_OPTIONS: "--require /tmp/evil.js",
    HTTPS_PROXY: "http://user:proxy-secret@proxy:8080",
    TENT_SERVICE_DATA_DIR: "C:\\host-must-lose",
  } as NodeJS.ProcessEnv;

  // Without reserved overlay: launchEnv cannot smuggle Core keys.
  const bare = buildManagedChildEnv({
    hostEnv: host,
    platform: "linux",
    launchEnv: {
      CPA_GROK_API_KEY: "connection-secret-ok",
      CUSTOM_FLAG: "1",
      TENT_SERVICE_DATA_DIR: "C:\\launch-must-not-smuggle",
      TENT_SESSION_ID: "ss-from-launch",
      NODE_OPTIONS: "--max-old-space-size=128",
      HTTPS_PROXY: "http://explicit-proxy",
    },
  });
  assert.equal(bare.PATH, "/bin");
  assert.equal(bare.CPA_GROK_API_KEY, "connection-secret-ok");
  assert.equal(bare.CUSTOM_FLAG, "1");
  assert.equal(bare.NODE_OPTIONS, "--max-old-space-size=128", "explicit launchEnv may opt in");
  assert.equal(bare.HTTPS_PROXY, "http://explicit-proxy", "explicit launchEnv may opt in");
  assert.equal(bare.TENT_SERVICE_DATA_DIR, undefined);
  assert.equal(bare.TENT_SESSION_ID, undefined);
  assert.equal(bare.HOST_SECRET_API_KEY, undefined);

  const withCore = buildManagedChildEnv({
    hostEnv: host,
    platform: "linux",
    launchEnv: {
      CPA_GROK_API_KEY: "connection-secret-ok",
      TENT_SERVICE_DATA_DIR: "C:\\launch-must-not-win",
    },
    reserved: {
      TENT_SERVICE_DATA_DIR: "C:\\core-data",
      TENT_SESSION_ID: "ss-core",
    },
  });
  assert.equal(withCore.TENT_SERVICE_DATA_DIR, "C:\\core-data");
  assert.equal(withCore.TENT_SESSION_ID, "ss-core");
  assert.ok(isReservedTentChildEnvKey("TENT_SERVICE_DATA_DIR"));
  assert.deepEqual(
    stripReservedTentChildEnv({
      TENT_SERVICE_DATA_DIR: "x",
      OK: "1",
    }),
    { OK: "1" }
  );
});

test("ProcessSupervisor: host NODE_OPTIONS/proxy do not reach child; reserved needs coreEnv", async () => {
  const prev: Record<string, string | undefined> = {
    TENT_TEST_HOST_LEAK_SECRET: process.env.TENT_TEST_HOST_LEAK_SECRET,
    TENT_TEST_FAKE_API_KEY: process.env.TENT_TEST_FAKE_API_KEY,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
  process.env.TENT_TEST_HOST_LEAK_SECRET = "host-leak-value-xyz";
  process.env.TENT_TEST_FAKE_API_KEY = "host-api-key-xyz";
  process.env.NODE_OPTIONS = "--require /tmp/evil-host-inject.js";
  process.env.HTTPS_PROXY = "http://user:proxy-cred-host@127.0.0.1:9";
  try {
    const cwd = await tempDir("tent-sup-env-");
    const outFile = path.join(cwd, "child-env.json");
    const script = path.join(cwd, "dump-env.mjs");
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

    // Arbitrary launchEnv alone cannot set reserved Core keys.
    const smuggle = await supervisor.start("ss-env-smuggle", {
      command: process.execPath,
      args: [script],
      cwd,
      env: {
        EXPLICIT_OK: "from-launch",
        CPA_GROK_API_KEY: "launch-secret-only",
        TENT_SERVICE_DATA_DIR: "C:\\launch-must-not-become-core",
        TENT_DUMP_ENV_PATH: outFile + ".smuggle",
      },
    });
    assert.ok(smuggle.pid > 0);
    const smugglePath = outFile + ".smuggle";
    const smuggleDeadline = Date.now() + 8_000;
    while (Date.now() < smuggleDeadline) {
      try {
        await fs.access(smugglePath);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    const smuggleEnv = JSON.parse(await fs.readFile(smugglePath, "utf8")) as Record<
      string,
      string
    >;
    assert.equal(smuggleEnv.EXPLICIT_OK, "from-launch");
    assert.equal(smuggleEnv.TENT_SERVICE_DATA_DIR, undefined);
    assert.equal(smuggleEnv.NODE_OPTIONS, undefined);
    assert.equal(smuggleEnv.HTTPS_PROXY, undefined);
    assert.equal(smuggleEnv.TENT_TEST_HOST_LEAK_SECRET, undefined);
    await supervisor.stop("ss-env-smuggle").catch(() => undefined);

    // Explicit coreEnv is the only reserved authority.
    const started = await supervisor.start("ss-env", {
      command: process.execPath,
      args: [script],
      cwd,
      env: {
        EXPLICIT_OK: "from-launch",
        CPA_GROK_API_KEY: "launch-secret-only",
        TENT_DUMP_ENV_PATH: outFile,
        // Explicit opt-in for non-reserved network/node knobs is still allowed.
        NODE_OPTIONS: "--max-old-space-size=64",
      },
      coreEnv: {
        TENT_SERVICE_DATA_DIR: "C:\\core-from-coreEnv",
        TENT_SESSION_ID: "ss-core-env",
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
    assert.equal(childEnv.TENT_SERVICE_DATA_DIR, "C:\\core-from-coreEnv");
    assert.equal(childEnv.TENT_SESSION_ID, "ss-core-env");
    assert.equal(childEnv.NODE_OPTIONS, "--max-old-space-size=64");
    assert.equal(childEnv.TENT_TEST_HOST_LEAK_SECRET, undefined);
    assert.equal(childEnv.TENT_TEST_FAKE_API_KEY, undefined);
    assert.equal(childEnv.HTTPS_PROXY, undefined);
    assert.ok(childEnv.PATH || childEnv.Path);
    await supervisor.stop("ss-env").catch(() => undefined);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("AgentRuntime: Connection/request cannot override reserved; coreEnv + diagnosticSecrets written", async () => {
  const dataDir = await tempDir("tent-reserved-");
  const cwd = await tempDir("tent-reserved-cwd-");
  const secret = "resolver-output-under-any-key-4411";
  const captured: Array<{
    dataDir?: string;
    coreDataDir?: string;
    sessionId?: string;
    secrets?: string[];
  }> = [];
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
    startManagedSession: async (plan: {
      env: Record<string, string>;
      coreEnv?: Record<string, string>;
      diagnosticSecrets?: string[];
      sessionId: string;
    }) => {
      captured.push({
        dataDir: plan.env.TENT_SERVICE_DATA_DIR,
        coreDataDir: plan.coreEnv?.TENT_SERVICE_DATA_DIR,
        sessionId: plan.coreEnv?.TENT_SESSION_ID,
        secrets: plan.diagnosticSecrets,
      });
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
    connections: [
      {
        connectionId: "p-reserved",
        provider: "test",
        adapterId: "env-capture",
        envKey: "PROVIDER_RUNTIME_BLOB",
        launchSecretRef: "cred-1",
      },
    ],
    resolveConnectionEnv: async () => ({ PROVIDER_RUNTIME_BLOB: secret }),
  });
  await startConnection(runtime, {
    sessionId: "ss-reserved",
    connectionId: "p-reserved",
    cwd,
    env: { TENT_SERVICE_DATA_DIR: "C:\\request-must-not-win" },
  });
  assert.equal(captured[0]?.dataDir, dataDir);
  assert.equal(captured[0]?.coreDataDir, dataDir);
  assert.equal(captured[0]?.sessionId, "ss-reserved");
  assert.ok(captured[0]?.secrets?.includes(secret));
  await runtime.stopSession("ss-reserved", "user");
  await runtime.shutdown();
});

test("managed ACP child process sees Core TENT_SERVICE_DATA_DIR; Connection spoof loses", async () => {
  const dataDir = await tempDir("tent-acp-core-env-");
  const cwd = await tempDir("tent-acp-core-cwd-");
  const logPath = path.join(cwd, "mock-log.json");
  const prevNode = process.env.NODE_OPTIONS;
  const prevProxy = process.env.HTTPS_PROXY;
  const prevLeak = process.env.TENT_TEST_HOST_LEAK_SECRET;
  process.env.NODE_OPTIONS = "--require /tmp/must-not-reach-acp-child.js";
  process.env.HTTPS_PROXY = "http://user:proxy-host-secret@127.0.0.1:9";
  process.env.TENT_TEST_HOST_LEAK_SECRET = "host-leak-must-not-reach-child";
  try {
    const runtime = createAgentRuntime({
      dataDir,
      adapters: [createGrokAcpAdapter({ resolveApiKey: () => "test-key" })],
      connections: [
        {
          connectionId: "grok-core-env",
          provider: "grok",
          adapterId: GROK_ACP_ADAPTER_ID,
          command: process.execPath,
          args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
          promptTimeoutMs: 8_000,
        },
      ],
    });
    const handle = await startConnection(runtime, {
      sessionId: "ss-core-env-child",
      connectionId: "grok-core-env",
      cwd,
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "0",
        MOCK_ACP_PROMPT_TEXT: "CORE_ENV_OK",
        TENT_SERVICE_DATA_DIR: "C:\\request-spoof-must-lose",
        CPA_GROK_API_KEY: "test-key",
      },
      bootstrapPrompt: "prove core env",
    });
    const managed = runtime as unknown as {
      // wait via events
    };
    void managed;
    // Wait for prompt complete / session settle
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
          methods?: string[];
          envValues?: Record<string, string | null>;
        };
        if (log.methods?.includes("session/prompt") || log.methods?.includes("session/new")) {
          assert.equal(log.envValues?.TENT_SERVICE_DATA_DIR, dataDir);
          assert.equal(log.envValues?.TENT_SESSION_ID, handle.sessionId);
          assert.equal(log.envValues?.NODE_OPTIONS, null);
          assert.equal(log.envValues?.HTTPS_PROXY, null);
          assert.equal(log.envValues?.TENT_TEST_HOST_LEAK_SECRET, null);
          break;
        }
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    const finalLog = JSON.parse(await fs.readFile(logPath, "utf8")) as {
      envValues?: Record<string, string | null>;
    };
    assert.equal(finalLog.envValues?.TENT_SERVICE_DATA_DIR, dataDir);
    await runtime.stopSession(handle.sessionId, "user").catch(() => undefined);
    await runtime.shutdown();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prevNode;
    if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevProxy;
    if (prevLeak === undefined) delete process.env.TENT_TEST_HOST_LEAK_SECRET;
    else process.env.TENT_TEST_HOST_LEAK_SECRET = prevLeak;
  }
});

test("resolved secret under non-secret-looking key redacted via diagnosticSecrets end-to-end", async () => {
  const dataDir = await tempDir("tent-diag-secret-");
  const cwd = await tempDir("tent-diag-secret-cwd-");
  const secret = "resolver-plain-key-secret-VALUE-9900";
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [
      createGrokAcpAdapter({
        // Adapter also resolves via plan env; value comes from Core injection.
        resolveApiKey: (_k, planEnv) => planEnv.PROVIDER_RUNTIME_BLOB ?? "",
      }),
    ],
    connections: [
      {
        connectionId: "grok-plain-key",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP],
        model: DEFAULT_GROK_MODEL,
        envKey: "PROVIDER_RUNTIME_BLOB",
        launchSecretRef: "cred-plain",
        permissionPolicy: "deny",
      },
    ],
    resolveConnectionEnv: async () => ({ PROVIDER_RUNTIME_BLOB: secret }),
  });
  await assert.rejects(
    () =>
      startConnection(runtime, {
        sessionId: "ss-plain-key-secret",
        connectionId: "grok-plain-key",
        cwd,
        env: {
          MOCK_ACP_FAIL_NEW: "1", MOCK_ACP_KEEP_ALIVE: "0",
          MOCK_ACP_STDERR_ENV_KEY: "PROVIDER_RUNTIME_BLOB",
          MOCK_ACP_ERROR_ENV_KEY: "PROVIDER_RUNTIME_BLOB",
        },
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(secret));
      return true;
    }
  );
  const record = await runtime.registry.read("ss-plain-key-secret");
  assert.ok(record);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  if (record.lastError) {
    assert.doesNotMatch(record.lastError, new RegExp(secret));
  }
  await runtime.shutdown();
});

// ── 2) Secret redaction ────────────────────────────────────────────────────

test("redact helpers: secret-named keys + explicit resolver outputs", () => {
  const named = "sk-live-super-secret-value-99";
  const resolved = "resolver-output-value-NOT-KEY-NAMED-7788";
  const env = {
    CPA_GROK_API_KEY: named,
    PATH: "/usr/bin",
    SAFE_NOTE: "ok",
  };
  const secrets = collectSecretValues(env, [resolved]);
  assert.ok(secrets.includes(named));
  assert.ok(secrets.includes(resolved));
  assert.equal(redactSecrets(`stderr has ${named} and ${resolved}`, secrets).includes(named), false);
  assert.equal(
    redactSecrets(`stderr has ${named} and ${resolved}`, secrets).includes(resolved),
    false
  );
  assert.match(
    redactDiagnosticText(`RPC failed: token=${named} extra=${resolved}`, {
      env,
      secrets: [resolved],
    }),
    /\[redacted\]/
  );
});

test("AcpClient: stderr + RPC error redact resolved credential value", async () => {
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
      // Put secret under a non-secret-looking key so diagnosticSecrets is required.
      PROVIDER_RUNTIME_VALUE: secret,
      MOCK_ACP_STDERR_ENV_KEY: "PROVIDER_RUNTIME_VALUE",
      MOCK_ACP_ERROR_ENV_KEY: "PROVIDER_RUNTIME_VALUE",
      CPA_GROK_API_KEY: "named-key-also-present-zzzz",
    },
    diagnosticSecrets: [secret],
    sessionId: "ss-redact-diag",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: (ev) => events.push(ev),
  });
  try {
    await assert.rejects(() => client.connect(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(secret));
      assert.match(message, /Internal error|JSON-RPC/);
      // Must have seen and redacted the secret (fixture put it in data.message).
      assert.match(message, /\[redacted\]|provider detail/i);
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
  assert.match(client.lastStderrTail, /mock bridge|envSecret|\[redacted\]/i);
});

test("AcpClient: secret-shaped coreEnv is redacted from stderr, RPC errors, and events", async () => {
  const cwd = await tempDir("tent-acp-core-env-redact-");
  const secret = "core-service-token-ABC12345";
  const events: RuntimeEvent[] = [];
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: {
      MOCK_ACP_FAIL_NEW: "1",
      MOCK_ACP_KEEP_ALIVE: "0",
      MOCK_ACP_STDERR_ENV_KEY: "TENT_SERVICE_TOKEN",
      MOCK_ACP_ERROR_ENV_KEY: "TENT_SERVICE_TOKEN",
    },
    coreEnv: {
      TENT_SERVICE_TOKEN: secret,
    },
    sessionId: "ss-core-env-redact",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: (ev) => events.push(ev),
  });
  try {
    await assert.rejects(() => client.connect(), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(secret));
      assert.match(message, /\[redacted\]|provider detail/i);
      return true;
    });
  } finally {
    await client.stop("shutdown");
  }
  for (const ev of events) {
    assert.doesNotMatch(JSON.stringify(ev), new RegExp(secret));
  }
  assert.doesNotMatch(client.lastStderrTail, new RegExp(secret));
  assert.match(client.lastStderrTail, /\[redacted\]/);
});

test("ProcessSupervisor: secret-shaped coreEnv is redacted from output ring and callback", async () => {
  const cwd = await tempDir("tent-supervisor-core-env-redact-");
  const secret = "core-session-token-XYZ98765";
  const script = path.join(cwd, "print-core-secret.mjs");
  await fs.writeFile(
    script,
    `const secret = process.env.TENT_SESSION_TOKEN || "";
process.stderr.write("core-secret " + secret + "\\n");
process.stdout.write("core-output " + secret + "\\n");
`,
    "utf8"
  );
  const observed: string[] = [];
  const supervisor = new ProcessSupervisor({
    stdoutRingBytes: 4096,
    onStdout: (_sessionId, text) => observed.push(text),
  });
  await supervisor.start("ss-supervisor-core-redact", {
    command: process.execPath,
    args: [script],
    cwd,
    env: {},
    coreEnv: {
      TENT_SESSION_TOKEN: secret,
    },
  });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (supervisor.get("ss-supervisor-core-redact")?.exited) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const output = observed.join("") + supervisor.getStdoutTail("ss-supervisor-core-redact");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /\[redacted\]/);
  await supervisor.stop("ss-supervisor-core-redact");
});

test("runtime + ProcessSupervisor: child that prints secret fails clean on events/registry", async () => {
  const dataDir = await tempDir("tent-child-redact-");
  const cwd = await tempDir("tent-child-redact-cwd-");
  const secret = "vault-secret-value-XYZ98765";
  const script = path.join(cwd, "print-secret-and-fail.mjs");
  await fs.writeFile(
    script,
    `const secret = process.env.CPA_GROK_API_KEY || "";
process.stderr.write("LEAKING " + secret + "\\n");
process.stdout.write("also " + secret + "\\n");
process.exit(1);
`,
    "utf8"
  );

  const events: RuntimeEvent[] = [];
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [
      {
        id: "secret-print",
        displayNameKey: "secret-print",
        capabilities: () => ({
          canSpawn: true,
          canResume: false,
          canStopGraceful: true,
          needsTty: false,
          supportsWorktreeCwd: true,
          authModel: "env" as const,
          observeLevel: "process" as const,
        }),
        resolveLaunch: (plan) => ({
          command: process.execPath,
          args: [script],
          cwd: plan.cwd,
          env: plan.env,
        }),
        mapExit: (code, signal) =>
          code === 0 || signal === "SIGTERM" || signal === "SIGINT"
            ? { type: "session.exited" as const, sessionId: "", exitCode: code }
            : {
                type: "session.failed" as const,
                sessionId: "",
                error: signal ? `signal:${signal}` : `exit:${code}`,
              },
      },
    ],
    connections: [
      {
        connectionId: "p-secret-print",
        provider: "test",
        adapterId: "secret-print",
        envKey: "CPA_GROK_API_KEY",
        launchSecretRef: "cred-1",
      },
    ],
    resolveConnectionEnv: async () => ({ CPA_GROK_API_KEY: secret }),
  });
  const off = runtime.subscribeAll((ev) => events.push(ev));

  // startSession returns after spawn; process then exits non-zero.
  await startConnection(runtime, {
    sessionId: "ss-secret-print",
    connectionId: "p-secret-print",
    cwd,
  });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rec = await runtime.registry.read("ss-secret-print");
    if (rec && (rec.state === "failed" || rec.state === "stopped")) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  off();

  const record = await runtime.registry.read("ss-secret-print");
  assert.ok(record);
  assert.equal(record.state, "failed");
  const raw = JSON.stringify(record);
  assert.doesNotMatch(raw, new RegExp(secret));
  assert.ok(record.lastError);
  assert.doesNotMatch(record.lastError!, new RegExp(secret));
  assert.match(record.lastError!, /stderr:|LEAKING|\[redacted\]/i);

  for (const ev of events) {
    assert.doesNotMatch(JSON.stringify(ev), new RegExp(secret));
  }
  const failedEv = events.find((e) => e.type === "session.failed");
  assert.ok(failedEv);
  assert.doesNotMatch(
    (failedEv as Extract<RuntimeEvent, { type: "session.failed" }>).error,
    new RegExp(secret)
  );

  await runtime.shutdown();
});

test("AcpClient/runtime: resolved credential appears in fixture error and is redacted in registry", async () => {
  const dataDir = await tempDir("tent-reg-redact-");
  const cwd = await tempDir("tent-reg-redact-cwd-");
  const secret = "vault-secret-value-XYZ98765";
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [createGrokAcpAdapter({ resolveApiKey: () => secret })],
    connections: [
      {
        connectionId: "grok-redact-start",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP],
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        launchSecretRef: "cred-vault-1",
        permissionPolicy: "deny",
      },
    ],
    resolveConnectionEnv: async () => ({ [DEFAULT_GROK_ENV_KEY]: secret }),
  });
  await assert.rejects(
    () =>
      startConnection(runtime, {
        sessionId: "ss-reg-redact",
        connectionId: "grok-redact-start",
        cwd,
        env: {
          MOCK_ACP_FAIL_NEW: "1", MOCK_ACP_KEEP_ALIVE: "0",
          MOCK_ACP_STDERR_ENV_KEY: DEFAULT_GROK_ENV_KEY,
          MOCK_ACP_ERROR_ENV_KEY: DEFAULT_GROK_ENV_KEY,
        },
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(secret));
      return true;
    }
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

test("protocol helpers: match transparent; legacy and mismatch throw typed errors", () => {
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
    (err: unknown) => {
      assert.ok(isServiceProtocolIncompatibleError(err));
      assert.equal(
        (err as ServiceProtocolIncompatibleError).kind,
        "missing"
      );
      assert.match(String(err), /legacy|Restart or upgrade/i);
      return true;
    }
  );
  assert.throws(
    () =>
      assertServiceProtocolCompatible({
        status: "ok",
        protocolVersion: 0,
        version: "0.1.0-b5",
      }),
    (err: unknown) => {
      assert.ok(isServiceProtocolIncompatibleError(err));
      assert.equal(
        (err as ServiceProtocolIncompatibleError).kind,
        "mismatch"
      );
      return true;
    }
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
    const realFetch = globalThis.fetch;
    const shimFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const request = init?.body ? JSON.parse(String(init.body)) as { method?: string } : null;
      if (url.includes("/rpc") && request?.method === "service.health") {
        const body = (await res.json()) as { result?: Record<string, unknown> };
        delete body.result?.protocolVersion;
        delete body.result?.instanceId;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return res;
    };
    await assert.rejects(
      () => tryAttachService(dataDir, shimFetch),
      (err: unknown) => {
        assert.ok(isServiceProtocolIncompatibleError(err));
        assert.equal((err as ServiceProtocolIncompatibleError).kind, "missing");
        return true;
      }
    );
    await assert.rejects(
      () =>
        attachOrBootstrapService({
          dataDir,
          attachOnly: true,
          packageRoot: repoRoot,
          fetchImpl: shimFetch,
        }),
      (err: unknown) => isServiceProtocolIncompatibleError(err)
    );
  } finally {
    await svc.stop();
  }
});

test("tryAttachService: healthy protocol 6 fails after the protocol 7 hard cut and does not spawn competitor", async () => {
  const dataDir = await tempDir("tent-proto-mismatch-");
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  let spawnCalled = false;
  try {
    const realFetch = globalThis.fetch;
    const shimFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const request = init?.body ? JSON.parse(String(init.body)) as { method?: string } : null;
      if (url.includes("/rpc") && request?.method === "service.health") {
        const body = (await res.json()) as { result?: Record<string, unknown> };
        if (body.result) body.result.protocolVersion = 6;
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
      (err: unknown) => {
        assert.ok(isServiceProtocolIncompatibleError(err));
        assert.equal((err as ServiceProtocolIncompatibleError).kind, "mismatch");
        return true;
      }
    );
    assert.equal(spawnCalled, false);
  } finally {
    await svc.stop();
  }
});

test("tryAttachService: ordinary network/health failure still returns null (not protocol error)", async () => {
  const dataDir = await tempDir("tent-proto-net-");
  // No endpoint file → null, not typed protocol error.
  assert.equal(await tryAttachService(dataDir), null);

  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const deadFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED simulated");
    };
    assert.equal(await tryAttachService(dataDir, deadFetch), null);

    const unhealthyFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ status: "starting" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    assert.equal(await tryAttachService(dataDir, unhealthyFetch), null);
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
      connectionId: "grok-late",
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
      connectionId: "mock-img-once",
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
