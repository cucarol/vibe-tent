/**
 * Grok ACP adapter tests — offline mock ACP server only.
 * Never calls real CPA / api.x.ai / paid networks.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createGrokAcpAdapter,
  GROK_ACP_ADAPTER_ID,
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  DEFAULT_GROK_MODEL,
  grokAcpProfileTemplate,
  normalizeCpaBaseUrl,
} from "../src/adapters/grok-acp/index.js";
import { GrokAcpClient } from "../src/adapters/grok-acp/client.js";
import { startManagedAcpSession } from "../src/adapters/acp/managed-session.js";
import { createAgentRuntime, type RuntimeEvent } from "../src/runtime/index.js";
import { taskContextCard } from "../src/core/context-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ACP = path.join(__dirname, "fixtures", "mock-acp-server.mjs");

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("managed ACP start cleans bridge process when handshake fails", async () => {
  const cwd = await tempDir("tent-grok-handshake-fail-");
  const client = new GrokAcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: { MOCK_ACP_FAIL_AUTH: "1", MOCK_ACP_KEEP_ALIVE: "1" },
    sessionId: "ss-handfail1",
    model: DEFAULT_GROK_MODEL,
    permissionPolicy: "deny",
    emit: () => undefined,
  });
  await assert.rejects(
    () =>
      startManagedAcpSession({
        plan: {
          sessionId: "ss-handfail1",
          profileId: "grok-handshake-fail",
          cwd,
          env: {},
        },
        emit: () => undefined,
        client,
      }),
    /auth failed/i
  );
  assert.equal(client.isAlive(), false);
});

function waitFor(
  events: RuntimeEvent[],
  type: RuntimeEvent["type"],
  sessionId: string,
  timeoutMs = 8000
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

function mockProfile(
  id: string,
  opts: {
    logPath: string;
    permissionPolicy?: "allow" | "ask" | "deny";
    requestPermission?: boolean;
    apiKey?: string;
    envKey?: string;
    dieAfterSessionMs?: number;
    dieExitCode?: number;
    keepAlive?: boolean;
    promptMode?: string;
  }
) {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath,
      MOCK_ACP_KEEP_ALIVE: opts.keepAlive === false ? "0" : "1",
      ...(opts.requestPermission ? { MOCK_ACP_REQUEST_PERMISSION: "1" } : {}),
      ...(opts.promptMode ? { MOCK_ACP_PROMPT_MODE: opts.promptMode } : {}),
      ...(opts.dieAfterSessionMs != null
        ? {
            MOCK_ACP_DIE_AFTER_SESSION_MS: String(opts.dieAfterSessionMs),
            MOCK_ACP_DIE_EXIT_CODE: String(opts.dieExitCode ?? 1),
            MOCK_ACP_PROMPT_MODE: opts.promptMode ?? "interrupt",
          }
        : {}),
      // Inject test key via plan env only when provided — still not workspace.
      ...(opts.apiKey
        ? { [opts.envKey ?? DEFAULT_GROK_ENV_KEY]: opts.apiKey }
        : {}),
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: opts.envKey ?? DEFAULT_GROK_ENV_KEY,
      permissionPolicy: opts.permissionPolicy ?? "deny",
      permissionTimeoutMs: 500,
      promptTimeoutMs: 10_000,
    },
  };
}

test("resolveLaunch fails loud without API key (Chinese, no fake/xAI fallback)", async () => {
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => undefined,
  });
  assert.throws(
    () =>
      adapter.resolveLaunch({
        sessionId: "ss-nokey01",
        profileId: "grok-acp-default",
        cwd: process.cwd(),
        env: {},
        extras: { acp: { model: "grok-4.5", envKey: "CPA_GROK_API_KEY" } },
        // Skip filesystem executable check by providing command override path that exists
        command: process.execPath,
        args: ["agent", "--model", "grok-4.5", "stdio"],
      }),
    (err: Error) => {
      assert.match(err.message, /未配置环境变量 CPA_GROK_API_KEY/);
      assert.match(err.message, /不会回退官方 xAI/);
      assert.match(err.message, /不会回退 fake/);
      // Message may mention api.x.ai as a forbidden fallback target; must not claim we use it.
      assert.match(err.message, /不会回退官方 xAI（api\.x\.ai）/);
      return true;
    }
  );
});

test("resolveLaunch puts explicit model on argv and never targets api.x.ai", async () => {
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key-not-real",
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-model01",
    profileId: "grok-acp-default",
    cwd: process.cwd(),
    env: {},
    command: process.execPath,
    extras: {
      acp: {
        model: "grok-4.5",
        envKey: "CPA_GROK_API_KEY",
        executable: process.execPath,
      },
    },
  });
  assert.ok(launch.args.includes("--model"));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "grok-4.5");
  assert.ok(launch.args.includes("stdio"));
  assert.ok(launch.args.includes("agent"));
  const joined = [launch.command, ...launch.args].join(" ");
  assert.doesNotMatch(joined, /api\.x\.ai/);
  assert.equal(launch.env.CPA_GROK_API_KEY, "test-key-not-real");
  // Secret values must not appear in profile serialization surfaces — only env injection.
});

test("resolveLaunch injects CPA base URL via env + --xai-api-base-url", () => {
  assert.equal(normalizeCpaBaseUrl("http://127.0.0.1:8317/v1/"), "http://127.0.0.1:8317/v1");
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key-not-real",
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-base01",
    profileId: "grok-acp-default",
    cwd: process.cwd(),
    env: {
      [DEFAULT_GROK_BASE_URL_ENV_KEY]: "http://127.0.0.1:8317/v1/",
    },
    command: process.execPath,
    extras: {
      acp: {
        model: "grok-4.5",
        envKey: DEFAULT_GROK_ENV_KEY,
        baseUrlEnvKey: DEFAULT_GROK_BASE_URL_ENV_KEY,
        executable: process.execPath,
      },
    },
  });
  assert.ok(launch.args.includes("--xai-api-base-url"));
  assert.equal(
    launch.args[launch.args.indexOf("--xai-api-base-url") + 1],
    "http://127.0.0.1:8317/v1"
  );
  assert.equal(launch.env.XAI_API_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(launch.env.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(launch.env.OPENAI_API_BASE, "http://127.0.0.1:8317/v1");
  assert.equal(launch.env[DEFAULT_GROK_BASE_URL_ENV_KEY], "http://127.0.0.1:8317/v1");
  assert.equal(launch.env.TENT_GROK_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(launch.env.XAI_API_KEY, "test-key-not-real");
  assert.doesNotMatch(launch.args.join(" "), /api\.x\.ai/);
});

test("resolveLaunch accepts machine-local profile baseUrl when env unset", () => {
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "k",
    resolveBaseUrl: (_key, planEnv, profileBaseUrl) =>
      planEnv.CPA_GROK_BASE_URL ?? profileBaseUrl,
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-base02",
    profileId: "grok-acp-default",
    cwd: process.cwd(),
    env: {},
    command: process.execPath,
    extras: {
      acp: {
        model: "grok-4.5",
        envKey: "CPA_GROK_API_KEY",
        baseUrl: "http://10.0.0.2:8317/v1",
        executable: process.execPath,
      },
    },
  });
  assert.equal(launch.env.XAI_API_BASE_URL, "http://10.0.0.2:8317/v1");
  assert.ok(launch.args.includes("--xai-api-base-url"));
});

test("grokAcpProfileTemplate includes baseUrlEnvKey name only", () => {
  const t = grokAcpProfileTemplate({ model: "grok-4.5" });
  assert.equal(t.acp.baseUrlEnvKey, DEFAULT_GROK_BASE_URL_ENV_KEY);
  assert.equal(t.acp.baseUrl, undefined);
  const json = JSON.stringify(t);
  assert.ok(json.includes("CPA_GROK_BASE_URL"));
  assert.doesNotMatch(json, /127\.0\.0\.1|8317/);
});

test("mock ACP: handshake, prompt, events, stop (no network)", async () => {
  const dataDir = await tempDir("tent-grok-acp-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: (_key, planEnv) => planEnv.CPA_GROK_API_KEY ?? "test-key",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [mockProfile("grok-mock", { logPath, apiKey: "test-key-local" })],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpmock1";
  const pointerPrompt = taskContextCard("tk-test01", {
    path: "temp/role/tasks/t.md",
    tentRootHint: cwd,
  }).prompt;

  const handle = await runtime.startSession({
    sessionId,
    profileId: "grok-mock",
    roleName: "ACP适配Grok",
    runtimeWorkspace: { cwd },
    bootstrapPrompt: pointerPrompt + "\n\nrelay: claim via tent task API",
  });

  assert.equal(handle.state, "live");
  assert.equal(handle.adapterId, GROK_ACP_ADAPTER_ID);
  assert.ok(handle.pid && handle.pid > 0);
  await waitFor(events, "session.live", sessionId);

  // Wait for prompt diagnostics (message chunk)
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (events.some((e) => e.type === "session.stdout_tail" && e.text.includes("MOCK_ACP_OK"))) {
      break;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(
    events.some((e) => e.type === "session.stdout_tail" && /MOCK_ACP_OK|agent_message/.test(e.text)),
    "expected agent message diagnostics"
  );

  const probe = await runtime.probe(sessionId);
  assert.equal(probe.alive, true);
  assert.equal(probe.state, "live");

  // Session registry is machine-local under dataDir — not cwd/workspace
  const sessionFile = path.join(dataDir, "sessions", `${sessionId}.json`);
  await fs.access(sessionFile);
  const body = await fs.readFile(sessionFile, "utf8");
  assert.ok(JSON.parse(body).pid);
  // Workspace cwd must not gain a PID file
  const cwdEntries = await fs.readdir(cwd);
  assert.ok(!cwdEntries.some((n) => n.includes("ss-") || n.includes("pid")));

  await runtime.stopSession(sessionId, "user");
  await waitFor(events, "session.exited", sessionId);
  const probeStopped = await runtime.probe(sessionId);
  assert.equal(probeStopped.alive, false);

  // Mock log: explicit model, no api.x.ai, prompt received
  const logRaw = await fs.readFile(logPath, "utf8");
  const log = JSON.parse(logRaw) as {
    modelFlag: string;
    hasStdio: boolean;
    methods: string[];
    authenticateParams: { methodId?: string; _meta?: { headless?: boolean } } | null;
    prompts: string[];
    contactedApiXai: boolean;
  };
  assert.equal(log.modelFlag, DEFAULT_GROK_MODEL);
  assert.equal(log.hasStdio, true);
  assert.ok(log.methods.includes("initialize"));
  assert.ok(log.methods.includes("authenticate"));
  assert.equal(log.authenticateParams?.methodId, "xai.api_key");
  assert.equal(log.authenticateParams?._meta?.headless, true);
  assert.ok(log.methods.includes("session/new"));
  assert.ok(log.methods.includes("session/prompt"));
  assert.equal(log.contactedApiXai, false);
  assert.ok(log.prompts.some((p) => p.includes("contextCard") || p.includes("Tent")));
  assert.doesNotMatch(logRaw, /api\.x\.ai/);

  await runtime.shutdown();
});

test("permission policy deny cancels tool permission (no yolo)", async () => {
  const dataDir = await tempDir("tent-grok-deny-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      mockProfile("grok-deny", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "deny",
        requestPermission: true,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpdeny1";
  await runtime.startSession({
    sessionId,
    profileId: "grok-deny",
    cwd,
    bootstrapPrompt: "pointer only",
  });
  await waitFor(events, "session.live", sessionId);

  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const raw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(raw) as { permissionOutcomes: unknown[] };
      if (log.permissionOutcomes?.length) {
        const outcome = log.permissionOutcomes[0] as { outcome?: string };
        assert.equal(outcome.outcome, "cancelled");
        break;
      }
    } catch {
      // log not ready
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  const raw = await fs.readFile(logPath, "utf8");
  const log = JSON.parse(raw) as { permissionOutcomes: Array<{ outcome?: string }> };
  assert.ok(log.permissionOutcomes.length >= 1);
  assert.equal(log.permissionOutcomes[0].outcome, "cancelled");
  // Never selected allow_always
  assert.ok(
    !JSON.stringify(log.permissionOutcomes).includes("allow_always")
  );

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("permission policy allow selects allow_once only (never allow_always)", async () => {
  const dataDir = await tempDir("tent-grok-allow-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      mockProfile("grok-allow", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "allow",
        requestPermission: true,
      }),
    ],
  });

  const sessionId = "ss-acpallo1";
  await runtime.startSession({
    sessionId,
    profileId: "grok-allow",
    cwd,
    bootstrapPrompt: "pointer",
  });

  const start = Date.now();
  let outcome: { outcome?: string; optionId?: string } | undefined;
  while (Date.now() - start < 5000) {
    try {
      const raw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(raw) as {
        permissionOutcomes: Array<{ outcome?: string; optionId?: string }>;
      };
      if (log.permissionOutcomes?.length) {
        outcome = log.permissionOutcomes[0];
        break;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(outcome);
  assert.equal(outcome!.outcome, "selected");
  assert.equal(outcome!.optionId, "allow_once");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("permission policy ask emits waiting_user then denies without handler", async () => {
  const dataDir = await tempDir("tent-grok-ask-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
    // no onPermissionAsk → deny after timeout
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      mockProfile("grok-ask", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "ask",
        requestPermission: true,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpask01";
  await runtime.startSession({
    sessionId,
    profileId: "grok-ask",
    cwd,
    bootstrapPrompt: "pointer",
  });

  await waitFor(events, "session.waiting_user", sessionId, 3000);

  const start = Date.now();
  while (Date.now() - start < 4000) {
    try {
      const raw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(raw) as { permissionOutcomes: Array<{ outcome?: string }> };
      if (log.permissionOutcomes?.length) {
        assert.equal(log.permissionOutcomes[0].outcome, "cancelled");
        break;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("permission policy ask → onPermissionAsk allow selects allow_once", async () => {
  const dataDir = await tempDir("tent-grok-ask-allow-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  let asked = false;

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
    onPermissionAsk: async (info) => {
      asked = true;
      assert.equal(info.sessionId, "ss-acpaskal");
      assert.match(info.toolTitle, /read_file|tool/);
      return "allow";
    },
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      mockProfile("grok-ask-allow", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "ask",
        requestPermission: true,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpaskal";
  await runtime.startSession({
    sessionId,
    profileId: "grok-ask-allow",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.waiting_user", sessionId, 3000);

  const start = Date.now();
  let outcome: { outcome?: string; optionId?: string } | undefined;
  while (Date.now() - start < 5000) {
    try {
      const raw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(raw) as {
        permissionOutcomes: Array<{ outcome?: string; optionId?: string }>;
      };
      if (log.permissionOutcomes?.length) {
        outcome = log.permissionOutcomes[0];
        break;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(asked);
  assert.ok(outcome);
  assert.equal(outcome!.outcome, "selected");
  assert.equal(outcome!.optionId, "allow_once");
  assert.ok(events.some((e) => e.type === "session.live" && e.sessionId === sessionId));

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("permission policy ask → onPermissionAsk deny cancels", async () => {
  const dataDir = await tempDir("tent-grok-ask-deny-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
    onPermissionAsk: async () => "deny",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      mockProfile("grok-ask-deny", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "ask",
        requestPermission: true,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpaskdn";
  await runtime.startSession({
    sessionId,
    profileId: "grok-ask-deny",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.waiting_user", sessionId, 3000);

  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const raw = await fs.readFile(logPath, "utf8");
      const log = JSON.parse(raw) as { permissionOutcomes: Array<{ outcome?: string }> };
      if (log.permissionOutcomes?.length) {
        assert.equal(log.permissionOutcomes[0].outcome, "cancelled");
        break;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("spontaneous child exit emits session.failed once (deduped)", async () => {
  const dataDir = await tempDir("tent-grok-spontaneous-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      mockProfile("grok-spontaneous", {
        logPath,
        apiKey: "test-key",
        dieAfterSessionMs: 80,
        dieExitCode: 9,
        keepAlive: false,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpspawn";
  await runtime.startSession({
    sessionId,
    profileId: "grok-spontaneous",
    cwd,
    bootstrapPrompt: "pointer",
  });

  await waitFor(events, "session.failed", sessionId, 8000);
  // Allow a short window for a second terminal emission race.
  await new Promise((r) => setTimeout(r, 200));
  const failed = events.filter(
    (e) => e.type === "session.failed" && e.sessionId === sessionId
  );
  assert.ok(failed.length >= 1);
  // Dedupe: at most one spontaneous + prompt-path failure pair should collapse to 1.
  assert.equal(failed.length, 1, `expected single session.failed, got ${failed.length}`);
  assert.match(
    (failed[0] as { error: string }).error,
    /spontaneous exit|code=9|exit/i
  );

  const probe = await runtime.probe(sessionId);
  assert.equal(probe.alive, false);

  await runtime.shutdown();
});

test("startSession with missing key fails without spawning mock as fake fallback", async () => {
  const dataDir = await tempDir("tent-grok-fail-");
  const cwd = await tempDir("tent-grok-cwd-");
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => undefined,
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        id: "grok-nokey",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP, "agent", "--model", "grok-4.5", "stdio"],
        acp: { envKey: "CPA_GROK_API_KEY", model: "grok-4.5" },
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  await assert.rejects(
    () =>
      runtime.startSession({
        sessionId: "ss-acpnokey",
        profileId: "grok-nokey",
        cwd,
      }),
    /未配置环境变量 CPA_GROK_API_KEY/
  );
  await waitFor(events, "session.failed", "ss-acpnokey");
  // Must not have fallen back to fake-cli
  assert.ok(!events.some((e) => e.type === "session.live"));
  await runtime.shutdown();
});

test("grokAcpProfileTemplate never embeds secret values", () => {
  const t = grokAcpProfileTemplate({ model: "grok-4.5" });
  assert.equal(t.adapterId, GROK_ACP_ADAPTER_ID);
  assert.equal(t.acp.envKey, DEFAULT_GROK_ENV_KEY);
  const json = JSON.stringify(t);
  assert.doesNotMatch(json, /sk-|xai-|api_key_value/i);
  assert.ok(json.includes("CPA_GROK_API_KEY")); // name only
});

test("mock ACP: prompt_complete emits assistant_message only (not thoughts)", async () => {
  const dataDir = await tempDir("tent-grok-pc-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        ...mockProfile("grok-pc", { logPath, apiKey: "test-key" }),
        env: {
          ...mockProfile("grok-pc", { logPath, apiKey: "test-key" }).env,
          MOCK_ACP_PROMPT_TEXT: "FINAL_REPORT_BODY",
          MOCK_ACP_KEEP_ALIVE: "1",
        },
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpprom1";
  await runtime.startSession({
    sessionId,
    profileId: "grok-pc",
    cwd,
    bootstrapPrompt: "user near-field: do the thing",
  });
  await waitFor(events, "session.live", sessionId);
  const complete = (await waitFor(
    events,
    "session.prompt_complete",
    sessionId,
    8000
  )) as Extract<RuntimeEvent, { type: "session.prompt_complete" }>;
  assert.equal(complete.assistantText, "FINAL_REPORT_BODY");
  assert.doesNotMatch(complete.assistantText, /thinking/);
  assert.equal(complete.stopReason, "end_turn");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("mock ACP: empty assistant does not emit prompt_complete", async () => {
  const dataDir = await tempDir("tent-grok-empty-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        ...mockProfile("grok-empty", { logPath, apiKey: "test-key" }),
        env: {
          ...mockProfile("grok-empty", { logPath, apiKey: "test-key" }).env,
          MOCK_ACP_PROMPT_MODE: "empty",
        },
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpempty";
  await runtime.startSession({
    sessionId,
    profileId: "grok-empty",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.failed", sessionId, 8000);
  assert.ok(!events.some((e) => e.type === "session.prompt_complete"));
  await runtime.shutdown();
});

test("mock ACP: prompt error does not emit prompt_complete", async () => {
  const dataDir = await tempDir("tent-grok-err-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        ...mockProfile("grok-err", { logPath, apiKey: "test-key" }),
        env: {
          ...mockProfile("grok-err", { logPath, apiKey: "test-key" }).env,
          MOCK_ACP_PROMPT_MODE: "error",
        },
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acperror";
  await runtime.startSession({
    sessionId,
    profileId: "grok-err",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.failed", sessionId, 8000);
  assert.ok(!events.some((e) => e.type === "session.prompt_complete"));
  await runtime.shutdown();
});

test("resolveLaunch accepts deprecated extras.grokAcp fallback", () => {
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-legacy01",
    profileId: "p",
    cwd: process.cwd(),
    env: {},
    command: process.execPath,
    // @deprecated pre-canonical plan shape — production runtime passes extras.acp only.
    extras: { grokAcp: { model: "grok-4.5", envKey: "CPA_GROK_API_KEY" } },
  });
  assert.ok(launch.args.includes("--model"));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "grok-4.5");
});

test("grok-acp capabilities: canResume true with resumeManagedSession", () => {
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  assert.equal(adapter.capabilities().canResume, true);
  assert.equal(typeof adapter.resumeManagedSession, "function");
});

test("mock ACP load: method order initialize → authenticate → session/load → session/prompt", async () => {
  const dataDir = await tempDir("tent-grok-load-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const events: RuntimeEvent[] = [];
  const session = await adapter.resumeManagedSession!(
    {
      sessionId: "ss-acpload1",
      profileId: "grok-load",
      cwd,
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "0",
        MOCK_ACP_LOAD_SESSION: "1",
        MOCK_ACP_HISTORY_TEXT: "SHOULD_NOT_BE_DELIVERED",
        MOCK_ACP_LATE_HISTORY_MS: "50",
        MOCK_ACP_PROMPT_TEXT: "LOAD_THEN_PROMPT_OK",
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

  const complete = events.find((e) => e.type === "session.prompt_complete") as
    | Extract<RuntimeEvent, { type: "session.prompt_complete" }>
    | undefined;
  assert.ok(complete);
  assert.equal(complete.assistantText, "LOAD_THEN_PROMPT_OK");
  assert.doesNotMatch(complete.assistantText, /SHOULD_NOT_BE_DELIVERED|HISTORY/);

  // Poll log: keepAlive=0 may flush mid-write; wait for full method sequence.
  const deadline = Date.now() + 2_000;
  let log: {
    methods: string[];
    loads: Array<{ sessionId: string; cwd: string; hasMcpServers: boolean }>;
  } | null = null;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await fs.readFile(logPath, "utf8")) as {
        methods: string[];
        loads: Array<{ sessionId: string; cwd: string; hasMcpServers: boolean }>;
      };
      if (parsed.methods.includes("session/prompt")) {
        log = parsed;
        break;
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(log, "expected mock log with session/prompt");
  assert.deepEqual(log.methods.slice(0, 4), [
    "initialize",
    "authenticate",
    "session/load",
    "session/prompt",
  ]);
  assert.ok(!log.methods.includes("session/new"));
  assert.equal(log.loads[0]?.sessionId, "mock-acp-session-1");
  assert.equal(log.loads[0]?.cwd, cwd);
  assert.equal(log.loads[0]?.hasMcpServers, true);

  await session.stop("user");
});

test("mock ACP load: unsupported loadSession fails loud without session/new", async () => {
  const cwd = await tempDir("tent-grok-noload-");
  const logPath = path.join(cwd, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  await assert.rejects(
    () =>
      adapter.resumeManagedSession!(
        {
          sessionId: "ss-acpnoload",
          profileId: "grok-noload",
          cwd,
          env: {
            MOCK_ACP_LOG: logPath,
            MOCK_ACP_KEEP_ALIVE: "0",
            CPA_GROK_API_KEY: "test-key",
          },
          command: process.execPath,
          args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
          extras: {
            acp: {
              model: DEFAULT_GROK_MODEL,
              envKey: DEFAULT_GROK_ENV_KEY,
              permissionPolicy: "deny",
            },
          },
        },
        { raw: "mock-acp-session-1", providerSessionId: "mock-acp-session-1" },
        () => undefined
      ),
    /loadSession|session\/load/i
  );
  // Log may or may not exist depending on how far connect got; if present, no session/new.
  try {
    const log = JSON.parse(await fs.readFile(logPath, "utf8")) as { methods: string[] };
    assert.ok(!log.methods.includes("session/new"));
  } catch {
    // no log file is fine
  }
});

test("mock ACP load: load failure cleans process and does not emit prompt_complete", async () => {
  const dataDir = await tempDir("tent-grok-loadfail-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        id: "grok-loadfail",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
        env: {
          MOCK_ACP_LOG: logPath,
          MOCK_ACP_KEEP_ALIVE: "0",
          MOCK_ACP_LOAD_SESSION: "1",
          MOCK_ACP_FAIL_LOAD: "1",
          CPA_GROK_API_KEY: "test-key",
        },
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
          promptTimeoutMs: 8_000,
        },
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acplfail";
  // Seed a stopped resume-capable session row (post-restart shape).
  await runtime.registry.write({
    id: sessionId,
    profileId: "grok-loadfail",
    adapterId: GROK_ACP_ADAPTER_ID,
    state: "stopped",
    resumeToken: "mock-acp-session-1",
    runtimeWorkspace: { cwd },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      runtime.resumeSession({
        sessionId,
        cwd,
        bootstrapPrompt: "should not run",
      }),
    /session\/load|mock session\/load failed/i
  );

  assert.ok(!events.some((e) => e.type === "session.prompt_complete"));
  const probe = await runtime.probe(sessionId);
  assert.equal(probe.alive, false);
  assert.equal(probe.state, "failed");
  await runtime.shutdown();
});

test("runtime resumeSession: reuses provider token + load (not session/new)", async () => {
  const dataDir = await tempDir("tent-grok-resume-rt-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        id: "grok-resume-rt",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
        env: {
          MOCK_ACP_LOG: logPath,
          MOCK_ACP_KEEP_ALIVE: "1",
          MOCK_ACP_LOAD_SESSION: "1",
          MOCK_ACP_HISTORY_TEXT: "REPLAY_NO_DELIVER",
          MOCK_ACP_PROMPT_TEXT: "RESUME_PROMPT_OK",
          CPA_GROK_API_KEY: "test-key",
        },
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
          promptTimeoutMs: 8_000,
        },
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acprsum1";
  await runtime.registry.write({
    id: sessionId,
    profileId: "grok-resume-rt",
    adapterId: GROK_ACP_ADAPTER_ID,
    state: "stopped",
    resumeToken: "mock-acp-session-1",
    runtimeWorkspace: { cwd },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const handle = await runtime.resumeSession({
    sessionId,
    cwd,
    bootstrapPrompt: "runtime resume bootstrap",
  });
  assert.equal(handle.sessionId, sessionId);
  assert.equal(handle.state, "live");

  const complete = (await waitFor(
    events,
    "session.prompt_complete",
    sessionId,
    8000
  )) as Extract<RuntimeEvent, { type: "session.prompt_complete" }>;
  assert.equal(complete.assistantText, "RESUME_PROMPT_OK");

  const log = JSON.parse(await fs.readFile(logPath, "utf8")) as { methods: string[] };
  assert.ok(log.methods.includes("session/load"));
  assert.ok(!log.methods.includes("session/new"));

  const rec = await runtime.registry.read(sessionId);
  assert.equal(rec?.resumeToken, "mock-acp-session-1");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("runtime resumeSession rejects a cwd different from the recorded provider session", async () => {
  const dataDir = await tempDir("tent-grok-resume-cwd-");
  const recordedCwd = await tempDir("tent-grok-recorded-cwd-");
  const otherCwd = await tempDir("tent-grok-other-cwd-");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        id: "grok-resume-cwd",
        adapterId: GROK_ACP_ADAPTER_ID,
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
        },
      },
    ],
  });
  const sessionId = "ss-acpcwd01";
  await runtime.registry.write({
    id: sessionId,
    profileId: "grok-resume-cwd",
    adapterId: GROK_ACP_ADAPTER_ID,
    state: "stopped",
    resumeToken: "mock-acp-session-1",
    runtimeWorkspace: { cwd: recordedCwd },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () => runtime.resumeSession({ sessionId, cwd: otherCwd }),
    /cwd mismatch/i
  );
  const record = await runtime.registry.read(sessionId);
  assert.equal(record?.state, "stopped");
  assert.equal(record?.runtimeWorkspace?.cwd, recordedCwd);
  await runtime.shutdown();
});

test("runtime resume failure redacts provider session token from errors and projections", async () => {
  const dataDir = await tempDir("tent-grok-resume-redact-");
  const cwd = await tempDir("tent-grok-redact-cwd-");
  const privateToken = "provider-session-private-123";
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    profiles: [
      {
        id: "grok-resume-redact",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP],
        env: {
          MOCK_ACP_LOAD_SESSION: "1",
          MOCK_ACP_KEEP_ALIVE: "1",
          CPA_GROK_API_KEY: "test-key",
        },
        acp: {
          model: DEFAULT_GROK_MODEL,
          envKey: DEFAULT_GROK_ENV_KEY,
          permissionPolicy: "deny",
        },
      },
    ],
  });
  const sessionId = "ss-acpredact";
  const now = new Date().toISOString();
  await runtime.registry.write({
    id: sessionId,
    profileId: "grok-resume-redact",
    adapterId: GROK_ACP_ADAPTER_ID,
    state: "stopped",
    resumeToken: privateToken,
    runtimeWorkspace: { cwd },
    createdAt: now,
    updatedAt: now,
  });

  await assert.rejects(
    () => runtime.resumeSession({ sessionId, cwd }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(privateToken));
      assert.match(message, /\[provider-session\]/);
      return true;
    }
  );
  const record = await runtime.registry.read(sessionId);
  assert.ok(record?.lastError);
  assert.doesNotMatch(record!.lastError!, new RegExp(privateToken));
  assert.equal((await runtime.probe(sessionId)).alive, false);
  await runtime.shutdown();
});
