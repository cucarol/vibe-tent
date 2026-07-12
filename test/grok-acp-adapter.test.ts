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
import { createAgentRuntime, type RuntimeEvent } from "../src/runtime/index.js";
import { taskContextCard } from "../src/core/context-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ACP = path.join(__dirname, "fixtures", "mock-acp-server.mjs");

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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
  }
) {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath,
      MOCK_ACP_KEEP_ALIVE: "1",
      ...(opts.requestPermission ? { MOCK_ACP_REQUEST_PERMISSION: "1" } : {}),
      // Inject test key via plan env only when provided — still not workspace.
      ...(opts.apiKey
        ? { [opts.envKey ?? DEFAULT_GROK_ENV_KEY]: opts.apiKey }
        : {}),
    },
    grokAcp: {
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
        extras: { grokAcp: { model: "grok-4.5", envKey: "CPA_GROK_API_KEY" } },
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
      grokAcp: {
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
      grokAcp: {
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
      grokAcp: {
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
  assert.equal(t.grokAcp.baseUrlEnvKey, DEFAULT_GROK_BASE_URL_ENV_KEY);
  assert.equal(t.grokAcp.baseUrl, undefined);
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
    prompts: string[];
    contactedApiXai: boolean;
  };
  assert.equal(log.modelFlag, DEFAULT_GROK_MODEL);
  assert.equal(log.hasStdio, true);
  assert.ok(log.methods.includes("initialize"));
  assert.ok(log.methods.includes("authenticate"));
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
        grokAcp: { envKey: "CPA_GROK_API_KEY", model: "grok-4.5" },
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
  assert.equal(t.grokAcp.envKey, DEFAULT_GROK_ENV_KEY);
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
