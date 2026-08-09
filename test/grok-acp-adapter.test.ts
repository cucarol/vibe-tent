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
  grokAcpRouteTemplate,
  normalizeCpaBaseUrl,
} from "../src/adapters/grok-acp/index.js";
import { GrokAcpClient } from "../src/adapters/grok-acp/client.js";
import { AcpClient } from "../src/adapters/acp/client.js";
import { startManagedAcpSession } from "../src/adapters/acp/managed-session.js";
import {
  ACP_OBSERVATION_TEXT_BYTES,
  ACP_PERMISSION_REQUEST_COUNT_MAX,
  createAgentRuntime,
  type AcpRuntimeObservation,
  type RuntimeEvent,
  type AgentConnectionConfig,
  type StartSessionRequest,
} from "../src/runtime/index.js";
import { taskContextCard } from "../src/core/context-card.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ACP = path.join(__dirname, "fixtures", "mock-acp-server.mjs");

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Access private AcpClient fields for write-failure regression only. */
type AcpClientInternals = {
  pending: Map<number, { timer: ReturnType<typeof setTimeout> }>;
  proc: { stdin: NodeJS.WritableStream | null } | null;
};

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
          connectionId: "grok-handshake-fail",
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

test("AcpClient: handshake errors retain safe diagnostics and redact arbitrary data", async () => {
  const cwd = await tempDir("tent-acp-handshake-diagnostics-");
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: {
      MOCK_ACP_FAIL_NEW: "1",
      MOCK_ACP_KEEP_ALIVE: "1",
    },
    sessionId: "ss-handshake-diagnostics",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: () => undefined,
  });

  try {
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Internal error/);
        assert.match(message, /JSON-RPC -32603/);
        assert.match(message, /mock provider unavailable/);
        assert.match(message, /mock bridge session initialization failed/);
        assert.doesNotMatch(message, /must-not-leak|token/);
        return true;
      }
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient: RPC error retains safe data.details and data.errorKind", async () => {
  const cwd = await tempDir("tent-acp-rpc-details-");
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: {
      MOCK_ACP_RESUME_SESSION: "1",
      MOCK_ACP_FAIL_RESUME: "1",
      MOCK_ACP_KEEP_ALIVE: "0",
    },
    sessionId: "ss-rpc-details",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: () => undefined,
  });

  try {
    await assert.rejects(
      () =>
        client.connect({
          mode: "resume",
          providerSessionId: "mock-acp-session-1",
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Internal error/);
        assert.match(message, /JSON-RPC -32603/);
        assert.match(message, /mock session\/resume SDK failure detail/);
        assert.match(message, /mock_resume_failed/);
        assert.doesNotMatch(message, /must-not-leak-resume/);
        return true;
      }
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient: destroyed stdin rejects pending request without hang", async () => {
  const cwd = await tempDir("tent-acp-stdin-destroyed-");
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: {
      MOCK_ACP_KEEP_ALIVE: "1",
      // Skip authenticate so connect only needs initialize + session/new.
    },
    sessionId: "ss-stdin-destroyed",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: () => undefined,
  });
  try {
    await client.connect();
    const internals = client as unknown as AcpClientInternals;
    const stdin = internals.proc?.stdin as
      | (NodeJS.WritableStream & { destroy: () => void })
      | null
      | undefined;
    assert.ok(stdin, "spawned process must expose stdin");
    stdin.destroy();

    const started = Date.now();
    await assert.rejects(
      () => client.sendPrompt("should fail send"),
      /发送失败|stdin 不可写/
    );
    assert.ok(
      Date.now() - started < 2_000,
      "must not wait for prompt timeout after write failure"
    );
    assert.equal(internals.pending.size, 0, "failed write must clear pending");
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient: write callback error rejects pending and clears timer", async () => {
  const cwd = await tempDir("tent-acp-stdin-write-cb-");
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: { MOCK_ACP_KEEP_ALIVE: "1" },
    sessionId: "ss-stdin-write-cb",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: () => undefined,
  });
  try {
    await client.connect();
    const internals = client as unknown as AcpClientInternals;
    const stdin = internals.proc?.stdin as
      | (NodeJS.WritableStream & {
          write: (
            chunk: string,
            encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
            cb?: (err?: Error | null) => void
          ) => boolean;
        })
      | null
      | undefined;
    assert.ok(stdin, "spawned process must expose stdin");

    const originalWrite = stdin.write.bind(stdin);
    stdin.write = ((
      chunk: string,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void
    ) => {
      const callback =
        typeof encodingOrCb === "function" ? encodingOrCb : cb;
      // Simulate async EPIPE / stream error after write is scheduled.
      queueMicrotask(() => {
        callback?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      });
      return true;
    }) as typeof stdin.write;

    const started = Date.now();
    await assert.rejects(
      () => client.sendPrompt("callback write fails"),
      /发送失败: write EPIPE/
    );
    assert.ok(
      Date.now() - started < 2_000,
      "write callback error must reject without prompt timeout"
    );
    assert.equal(internals.pending.size, 0, "callback error must clear pending");

    // Restore so stop/cleanup paths do not use the stub.
    stdin.write = originalWrite;
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient: stdin stream error rejects all pending requests", async () => {
  const cwd = await tempDir("tent-acp-stdin-error-");
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: { MOCK_ACP_KEEP_ALIVE: "1" },
    sessionId: "ss-stdin-error",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: () => undefined,
  });
  try {
    await client.connect();
    const internals = client as unknown as AcpClientInternals;
    const stdin = internals.proc?.stdin;
    assert.ok(stdin, "spawned process must expose stdin");

    const pending = client.sendPrompt("stream fails");
    stdin.emit("error", new Error("broken pipe"));

    await assert.rejects(() => pending, /stdin 写入失败: broken pipe/);
    assert.equal(internals.pending.size, 0, "stream error must clear pending");
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient clears prior permission result in count-before-decision snapshot", async () => {
  const cwd = await tempDir("tent-acp-permission-snapshot-");
  const events: RuntimeEvent[] = [];
  const client = new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP],
    cwd,
    env: { MOCK_ACP_KEEP_ALIVE: "1" },
    sessionId: "ss-permsnapshot",
    permissionPolicy: "deny",
    label: "MockACP",
    emit: (event) => events.push(event),
  });
  const permissionClient = client as unknown as {
    handlePermissionRequest(
      id: number,
      params: { options: []; toolCall?: { title?: string } }
    ): Promise<void>;
  };
  try {
    await client.connect();
    await permissionClient.handlePermissionRequest(9001, {
      options: [],
      toolCall: { title: "first" },
    });
    await permissionClient.handlePermissionRequest(9002, {
      options: [],
      toolCall: { title: "second" },
    });
    const observations = events
      .filter(
        (event): event is Extract<
          RuntimeEvent,
          { type: "session.acp_observation" }
        > => event.type === "session.acp_observation"
      )
      .map((event) => event.observation);
    const countOnly = observations.find(
      (value) =>
        value.permissionRequestCount === 2 &&
        value.permissionDecision === undefined &&
        value.permissionOutcome === undefined
    );
    assert.ok(countOnly, "second request must clear the first result before deciding");
    const settled = observations.at(-1);
    assert.equal(settled?.permissionRequestCount, 2);
    assert.equal(settled?.permissionDecision, "deny");
    assert.equal(settled?.permissionOutcome, "cancelled");
  } finally {
    await client.stop("shutdown");
  }
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

async function waitForObservation(
  runtime: ReturnType<typeof createAgentRuntime>,
  sessionId: string,
  predicate: (value: AcpRuntimeObservation) => boolean,
  timeoutMs = 8000
): Promise<AcpRuntimeObservation> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = (await runtime.registry.read(sessionId))?.acpObservation;
    if (value && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ACP observation on ${sessionId}`);
}

const mockLaunchEnvByConnection = new Map<string, Record<string, string>>();

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
  }).then(() => runtime.startSession({
    ...start,
    lastTaskId,
    workspace,
    env: { ...mockLaunchEnvByConnection.get(connectionId), ...start.env },
  }));
}

function withMockEnv(connection: AgentConnectionConfig, patch: Record<string, string>): AgentConnectionConfig {
  mockLaunchEnvByConnection.set(connection.connectionId, { ...mockLaunchEnvByConnection.get(connection.connectionId), ...patch });
  return connection;
}

async function resumeRoute(
  runtime: ReturnType<typeof createAgentRuntime>,
  request: Parameters<ReturnType<typeof createAgentRuntime>["resumeSession"]>[0]
) {
  const record = await runtime.registry.read(request.sessionId);
  return runtime.resumeSession({
    ...request,
    env: { ...mockLaunchEnvByConnection.get(record?.connectionId ?? ""), ...request.env },
  });
}

function mockConnection(
  id: string,
  opts: {
    logPath: string;
    permissionPolicy?: "allow" | "ask" | "deny";
    requestPermission?: boolean;
    permissionCount?: number;
    apiKey?: string;
    envKey?: string;
    dieAfterSessionMs?: number;
    dieExitCode?: number;
    keepAlive?: boolean;
    promptMode?: string;
    permissionTimeoutMs?: number;
  }
) : AgentConnectionConfig {
  const env = {
    MOCK_ACP_LOG: opts.logPath,
    MOCK_ACP_KEEP_ALIVE: opts.keepAlive === false ? "0" : "1",
    ...(opts.requestPermission ? { MOCK_ACP_REQUEST_PERMISSION: "1" } : {}),
    ...(opts.permissionCount
      ? { MOCK_ACP_PERMISSION_COUNT: String(opts.permissionCount) }
      : {}),
    ...(opts.promptMode ? { MOCK_ACP_PROMPT_MODE: opts.promptMode } : {}),
    ...(opts.dieAfterSessionMs != null
      ? {
          MOCK_ACP_DIE_AFTER_SESSION_MS: String(opts.dieAfterSessionMs),
          MOCK_ACP_DIE_EXIT_CODE: String(opts.dieExitCode ?? 1),
          MOCK_ACP_PROMPT_MODE: opts.promptMode ?? "interrupt",
        }
      : {}),
    ...(opts.apiKey ? { [opts.envKey ?? DEFAULT_GROK_ENV_KEY]: opts.apiKey } : {}),
  };
  mockLaunchEnvByConnection.set(id, env);
  return {
    connectionId: id,
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    envKey: opts.envKey ?? DEFAULT_GROK_ENV_KEY,
    permissionPolicy: opts.permissionPolicy ?? "deny",
    permissionTimeoutMs: opts.permissionTimeoutMs ?? 500,
    promptTimeoutMs: 10_000,
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
        connectionId: "grok-acp-default",
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
    connectionId: "grok-acp-default",
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
  // Secret values must not appear in Connection serialization surfaces — only env injection.
});

test("resolveLaunch absorbs the Grok2API wrapper launch contract", () => {
  assert.equal(normalizeCpaBaseUrl("http://127.0.0.1:8320/v1/"), "http://127.0.0.1:8320/v1");
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key-not-real",
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-base01",
    connectionId: "grok-acp-default",
    cwd: process.cwd(),
    env: {
      [DEFAULT_GROK_BASE_URL_ENV_KEY]: "http://127.0.0.1:8320/v1/",
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
    "http://127.0.0.1:8320/v1"
  );
  assert.ok(launch.args.includes("--cli-chat-proxy-base-url"));
  assert.equal(
    launch.args[launch.args.indexOf("--cli-chat-proxy-base-url") + 1],
    "http://127.0.0.1:8320/v1"
  );
  assert.ok(launch.args.includes("--no-leader"));
  assert.equal(launch.env.XAI_API_BASE_URL, "http://127.0.0.1:8320/v1");
  assert.equal(launch.env.OPENAI_BASE_URL, "http://127.0.0.1:8320/v1");
  assert.equal(launch.env.OPENAI_API_BASE, "http://127.0.0.1:8320/v1");
  assert.equal(launch.env[DEFAULT_GROK_BASE_URL_ENV_KEY], "http://127.0.0.1:8320/v1");
  assert.equal(launch.env.TENT_GROK_BASE_URL, "http://127.0.0.1:8320/v1");
  assert.equal(launch.env.GROK_MODELS_BASE_URL, "http://127.0.0.1:8320/v1");
  assert.equal(launch.env.GROK_MODELS_LIST_URL, "http://127.0.0.1:8320/v1/models");
  assert.equal(launch.env.XAI_API_KEY, "test-key-not-real");
  assert.match(launch.env.GROK_HOME, /[\\/]\.grok-acp[\\/]home[\\/]\.grok$/);
  assert.equal(launch.env.USERPROFILE, launch.env.HOME);
  assert.equal(launch.env.GROK_CLAUDE_MCPS_ENABLED, "false");
  assert.equal(launch.env.GROK_CURSOR_HOOKS_ENABLED, "false");
  assert.doesNotMatch(launch.args.join(" "), /api\.x\.ai/);
});

test("resolveLaunch accepts machine-local Connection baseUrl when env unset", () => {
  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "k",
    resolveBaseUrl: (_key, planEnv, connectionBaseUrl) =>
      planEnv.CPA_GROK_BASE_URL ?? connectionBaseUrl,
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-base02",
    connectionId: "grok-acp-default",
    cwd: process.cwd(),
    env: {},
    command: process.execPath,
    extras: {
      acp: {
        model: "grok-4.5",
        envKey: "CPA_GROK_API_KEY",
        baseUrl: "http://10.0.0.2:8320/v1",
        executable: process.execPath,
      },
    },
  });
  assert.equal(launch.env.XAI_API_BASE_URL, "http://10.0.0.2:8320/v1");
  assert.ok(launch.args.includes("--xai-api-base-url"));
  assert.ok(launch.args.includes("--cli-chat-proxy-base-url"));
});

test("Grok Agent Connection template includes baseUrlEnvKey name only", () => {
  const t = grokAcpRouteTemplate({ model: "grok-4.5" });
  assert.equal(t.baseUrlEnvKey, DEFAULT_GROK_BASE_URL_ENV_KEY);
  assert.equal(t.baseUrl, undefined);
  const json = JSON.stringify(t);
  assert.ok(json.includes("CPA_GROK_BASE_URL"));
  assert.doesNotMatch(json, /127\.0\.0\.1|8320/);
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
    connections: [mockConnection("grok-mock", { logPath, apiKey: "test-key-local" })],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpmock1";
  const pointerPrompt = taskContextCard("tk-test01", {
    path: "temp/role/tasks/t.md",
    tentRootHint: cwd,
  }).prompt;

  const handle = await startConnection(runtime, {
    sessionId,
    connectionId: "grok-mock",
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
    connections: [
      mockConnection("grok-deny", {
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
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-deny",
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
  const observation = await waitForObservation(
    runtime,
    sessionId,
    (value) => value.permissionOutcome === "cancelled"
  );
  assert.equal(observation.permissionRequestCount, 1);
  assert.equal(observation.permissionPolicy, "deny");
  assert.equal(observation.permissionDecision, "deny");
  assert.equal(observation.permissionOutcome, "cancelled");

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
    connections: [
      mockConnection("grok-allow", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "allow",
        requestPermission: true,
      }),
    ],
  });

  const sessionId = "ss-acpallo1";
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-allow",
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

test("ACP observation records cancelled when allow has no allow_once option", async () => {
  const dataDir = await tempDir("tent-acp-observe-no-once-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const connection = withMockEnv(
    mockConnection("grok-observe-no-once", {
      logPath,
      apiKey: "test-key",
      permissionPolicy: "allow",
      requestPermission: true,
    }),
    { MOCK_ACP_PERMISSION_NO_ALLOW_ONCE: "1" }
  );
  const runtime = createAgentRuntime({ dataDir, adapters: [adapter], connections: [connection] });
  const sessionId = "ss-acpobsnoonce";

  await startConnection(runtime, {
    sessionId,
    connectionId: connection.connectionId,
    cwd,
    bootstrapPrompt: "pointer",
  });
  const observation = await waitForObservation(
    runtime,
    sessionId,
    (value) => value.permissionOutcome === "cancelled"
  );
  assert.equal(observation.permissionDecision, "allow");
  assert.equal(observation.permissionOutcome, "cancelled");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("ACP observation bounds and redacts provider stopReason with zero permission requests", async () => {
  const dataDir = await tempDir("tent-acp-observe-stop-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const secret = "observation-secret-value";
  const rawStopReason = `cancelled-${secret}-${"x".repeat(2048)}`;
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => secret });
  const connection = withMockEnv(
    mockConnection("grok-observe-stop", {
      logPath,
      apiKey: secret,
      permissionPolicy: "deny",
    }),
    { MOCK_ACP_STOP_REASON: rawStopReason }
  );
  const runtime = createAgentRuntime({ dataDir, adapters: [adapter], connections: [connection] });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const sessionId = "ss-acpobsstop";

  await startConnection(runtime, {
    sessionId,
    connectionId: connection.connectionId,
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.failed", sessionId);
  const observation = await waitForObservation(
    runtime,
    sessionId,
    (value) => value.promptStopReason !== undefined
  );
  assert.equal(observation.permissionRequestCount, 0);
  assert.equal(observation.permissionPolicy, "deny");
  assert.equal(observation.spontaneousChildExit, false);
  assert.ok(observation.promptStopReason);
  assert.ok(
    Buffer.byteLength(observation.promptStopReason!, "utf8") <=
      ACP_OBSERVATION_TEXT_BYTES
  );
  assert.doesNotMatch(observation.promptStopReason!, new RegExp(secret));
  assert.match(observation.promptStopReason!, /cancelled/);

  await runtime.shutdown();
});

test("ACP observation permission request count saturates at its fixed cap", async () => {
  const dataDir = await tempDir("tent-acp-observe-cap-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const connection = mockConnection("grok-observe-cap", {
    logPath,
    apiKey: "test-key",
    permissionPolicy: "deny",
    requestPermission: true,
    permissionCount: ACP_PERMISSION_REQUEST_COUNT_MAX + 5,
  });
  const runtime = createAgentRuntime({ dataDir, adapters: [adapter], connections: [connection] });
  const sessionId = "ss-acpobscap1";

  await startConnection(runtime, {
    sessionId,
    connectionId: connection.connectionId,
    cwd,
    bootstrapPrompt: "pointer",
  });
  const observation = await waitForObservation(
    runtime,
    sessionId,
    (value) => value.permissionRequestCount === ACP_PERMISSION_REQUEST_COUNT_MAX
  );
  assert.equal(observation.permissionRequestCount, ACP_PERMISSION_REQUEST_COUNT_MAX);
  assert.equal(observation.permissionPolicy, "deny");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("intentional ACP stop does not record a spontaneous child exit", async () => {
  const dataDir = await tempDir("tent-acp-observe-stop-intentional-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const adapter = createGrokAcpAdapter({ resolveApiKey: () => "test-key" });
  const connection = mockConnection("grok-observe-intentional", {
    logPath,
    apiKey: "test-key",
    permissionPolicy: "deny",
  });
  const runtime = createAgentRuntime({ dataDir, adapters: [adapter], connections: [connection] });
  const sessionId = "ss-acpobsintent";

  await startConnection(runtime, {
    sessionId,
    connectionId: connection.connectionId,
    cwd,
    bootstrapPrompt: "",
  });
  await runtime.stopSession(sessionId, "user");
  const record = await runtime.registry.read(sessionId);
  assert.equal(record?.acpObservation, undefined);

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
    connections: [
      mockConnection("grok-ask", {
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
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-ask",
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
    connections: [
      mockConnection("grok-ask-allow", {
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
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-ask-allow",
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

test("concurrent permission asks emit live only after the final decision", async () => {
  const dataDir = await tempDir("tent-grok-ask-concurrent-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const decisions = new Map<
    string,
    (decision: "allow" | "deny") => void
  >();

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
    onPermissionAsk: (info) =>
      new Promise((resolve) => {
        decisions.set(info.toolTitle, resolve);
      }),
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [
      mockConnection("grok-ask-concurrent", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "ask",
        requestPermission: true,
        permissionCount: 2,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const sessionId = "ss-acpaskco";
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-ask-concurrent",
    cwd,
    bootstrapPrompt: "pointer",
  });

  const decisionDeadline = Date.now() + 5_000;
  while (decisions.size < 2 && Date.now() < decisionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(decisions.size, 2);
  const initialLiveCount = events.filter(
    (event) => event.type === "session.live" && event.sessionId === sessionId
  ).length;
  assert.equal(
    events.filter(
      (event) => event.type === "session.waiting_user" && event.sessionId === sessionId
    ).length,
    2
  );

  decisions.get("read_file_1")?.("allow");
  const firstOutcomeDeadline = Date.now() + 5_000;
  let firstOutcomeCount = 0;
  while (Date.now() < firstOutcomeDeadline) {
    try {
      const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
        permissionOutcomes: unknown[];
      };
      firstOutcomeCount = log.permissionOutcomes.length;
      if (firstOutcomeCount === 1) break;
    } catch {
      // wait for mock log
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(firstOutcomeCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    events.filter(
      (event) => event.type === "session.live" && event.sessionId === sessionId
    ).length,
    initialLiveCount,
    "first concurrent decision must not emit session.live"
  );

  decisions.get("read_file_2")?.("deny");
  const finalLiveDeadline = Date.now() + 5_000;
  while (
    events.filter(
      (event) => event.type === "session.live" && event.sessionId === sessionId
    ).length <= initialLiveCount &&
    Date.now() < finalLiveDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    events.filter(
      (event) => event.type === "session.live" && event.sessionId === sessionId
    ).length,
    initialLiveCount + 1,
    "final concurrent decision must emit exactly one session.live"
  );

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("permission ask is not denied by a short startup permissionTimeoutMs snapshot", async () => {
  const dataDir = await tempDir("tent-grok-ask-live-timeout-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");
  let askedAt = 0;

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
    // Resolve after the removed client fail-safe window (snapshot + 5s slack).
    // The old implementation denied before this callback settled, so this delay
    // makes the regression test fail against the old dual-timeout behavior.
    onPermissionAsk: async () => {
      askedAt = Date.now();
      await new Promise((r) => setTimeout(r, 5_500));
      return "allow";
    },
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [
      mockConnection("grok-ask-live-timeout", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "ask",
        requestPermission: true,
        // Would have been client snapshot + 5s fail-safe; must not matter on client.
        permissionTimeoutMs: 100,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const sessionId = "ss-acpasklt";

  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-ask-live-timeout",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.waiting_user", sessionId, 3_000);

  const start = Date.now();
  let outcome: { outcome?: string; optionId?: string } | undefined;
  while (Date.now() - start < 8_000) {
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
  assert.ok(askedAt > 0, "onPermissionAsk must run");
  assert.ok(outcome, "permission outcome must be written");
  assert.equal(outcome!.outcome, "selected");
  assert.equal(outcome!.optionId, "allow_once");

  await runtime.stopSession(sessionId, "user");
  await runtime.shutdown();
});

test("stopping a hung permission ask cancels waiters without timer leak", async () => {
  const dataDir = await tempDir("tent-grok-ask-stop-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
    onPermissionAsk: () => new Promise<"allow" | "deny">(() => undefined),
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [
      mockConnection("grok-ask-stop", {
        logPath,
        apiKey: "test-key",
        permissionPolicy: "ask",
        requestPermission: true,
        permissionTimeoutMs: 60_000,
      }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const timeoutCount = () =>
    process.getActiveResourcesInfo().filter((resource) => resource === "Timeout")
      .length;
  const baselineTimeouts = timeoutCount();
  const sessionId = "ss-acpaskst";

  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-ask-stop",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.waiting_user", sessionId, 3_000);
  const waitingTimeouts = timeoutCount();
  // Prompt/request deadlines may exist; permission ask itself has no fail-safe timer.
  assert.ok(
    waitingTimeouts >= baselineTimeouts,
    "session may hold request timers while waiting on permission"
  );

  const startedAt = Date.now();
  await runtime.stopSession(sessionId, "user");
  assert.ok(Date.now() - startedAt < 3_000, "stop must not await permission callback");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(
    timeoutCount() <= waitingTimeouts,
    "stop must not leave extra permission timers"
  );
  // After stop, active Timeout count should not keep climbing from a leaked fail-safe.
  const afterStop = timeoutCount();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    timeoutCount() <= afterStop + 1,
    "no leaked permission fail-safe timer after stop"
  );

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
    connections: [
      mockConnection("grok-ask-deny", {
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
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-ask-deny",
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
    connections: [
      mockConnection("grok-spontaneous", {
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
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-spontaneous",
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
  const observation = await waitForObservation(
    runtime,
    sessionId,
    (value) => value.spontaneousChildExit
  );
  assert.equal(observation.spontaneousChildExit, true);
  assert.equal(observation.exitCode, 9);
  assert.equal(observation.permissionRequestCount, 0);

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
    connections: [
      {
        connectionId: "grok-nokey",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP, "agent", "--model", "grok-4.5", "stdio"],
        envKey: "CPA_GROK_API_KEY",
        model: "grok-4.5",
      },
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  await assert.rejects(
    () =>
      startConnection(runtime, {
        sessionId: "ss-acpnokey",
        connectionId: "grok-nokey",
        cwd,
      }),
    /未配置环境变量 CPA_GROK_API_KEY/
  );
  await waitFor(events, "session.failed", "ss-acpnokey");
  // Must not have fallen back to fake-cli
  assert.ok(!events.some((e) => e.type === "session.live"));
  await runtime.shutdown();
});

test("Grok Agent Connection template never embeds secret values", () => {
  const t = grokAcpRouteTemplate({ model: "grok-4.5" });
  assert.equal(t.adapterId, GROK_ACP_ADAPTER_ID);
  assert.equal(t.envKey, DEFAULT_GROK_ENV_KEY);
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
    connections: [withMockEnv(mockConnection("grok-pc", { logPath, apiKey: "test-key" }), {
      MOCK_ACP_PROMPT_TEXT: "FINAL_REPORT_BODY", MOCK_ACP_KEEP_ALIVE: "1",
    })],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpprom1";
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-pc",
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

test("mock ACP: multi-segment turn keeps only final assistant reply in prompt_complete", async () => {
  const dataDir = await tempDir("tent-grok-pc-seg-");
  const cwd = await tempDir("tent-grok-cwd-");
  const logPath = path.join(dataDir, "mock-acp-log.json");

  const adapter = createGrokAcpAdapter({
    resolveApiKey: () => "test-key",
  });
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [withMockEnv(mockConnection("grok-pc-seg", { logPath, apiKey: "test-key" }), {
      MOCK_ACP_INTERMEDIATE_TEXT: "I'll inspect the codebase and draft a plan first…",
      MOCK_ACP_PROMPT_TEXT: "FINAL_DELIVERY_REPORT_ONLY", MOCK_ACP_KEEP_ALIVE: "1",
    })],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpseg1";
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-pc-seg",
    cwd,
    bootstrapPrompt: "user near-field: multi-burst turn",
  });
  await waitFor(events, "session.live", sessionId);
  const complete = (await waitFor(
    events,
    "session.prompt_complete",
    sessionId,
    8000
  )) as Extract<RuntimeEvent, { type: "session.prompt_complete" }>;
  // Delivery report must be the post-tool final segment only.
  assert.equal(complete.assistantText, "FINAL_DELIVERY_REPORT_ONLY");
  assert.doesNotMatch(complete.assistantText, /inspect the codebase|thinking|read_file/i);
  // Intermediate narration still surfaces as diagnostics, not delivery text.
  assert.ok(
    events.some(
      (e) =>
        e.type === "session.stdout_tail" &&
        e.sessionId === sessionId &&
        /inspect the codebase/.test(e.text)
    )
  );
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
    connections: [withMockEnv(mockConnection("grok-empty", { logPath, apiKey: "test-key" }), {
      MOCK_ACP_PROMPT_MODE: "empty",
    })],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acpempty";
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-empty",
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
    connections: [withMockEnv(mockConnection("grok-err", { logPath, apiKey: "test-key" }), {
      MOCK_ACP_PROMPT_MODE: "error",
    })],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acperror";
  await startConnection(runtime, {
    sessionId,
    connectionId: "grok-err",
    cwd,
    bootstrapPrompt: "pointer",
  });
  await waitFor(events, "session.failed", sessionId, 8000);
  assert.ok(!events.some((e) => e.type === "session.prompt_complete"));
  await runtime.shutdown();
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
      connectionId: "grok-load",
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
          connectionId: "grok-noload",
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
    connections: [
      withMockEnv({
        connectionId: "grok-loadfail", provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
        model: DEFAULT_GROK_MODEL, envKey: DEFAULT_GROK_ENV_KEY,
        permissionPolicy: "deny", promptTimeoutMs: 8_000,
      }, { MOCK_ACP_LOG: logPath, MOCK_ACP_KEEP_ALIVE: "0", MOCK_ACP_LOAD_SESSION: "1", MOCK_ACP_FAIL_LOAD: "1", CPA_GROK_API_KEY: "test-key" }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acplfail";
  // Seed a stopped resume-capable session row (post-restart shape).
  await runtime.registry.write({
    id: sessionId,
    connectionId: "grok-loadfail",
    adapterId: GROK_ACP_ADAPTER_ID,
    connectionSnapshot: runtime.snapshotConnectionForStart("grok-loadfail"),
    state: "stopped",
    resumeToken: "mock-acp-session-1",
    runtimeWorkspace: { cwd },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      resumeRoute(runtime, {
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
    connections: [
      withMockEnv({
        connectionId: "grok-resume-rt", provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
        model: DEFAULT_GROK_MODEL, envKey: DEFAULT_GROK_ENV_KEY,
        permissionPolicy: "deny", promptTimeoutMs: 8_000,
      }, { MOCK_ACP_LOG: logPath, MOCK_ACP_KEEP_ALIVE: "1", MOCK_ACP_LOAD_SESSION: "1", MOCK_ACP_HISTORY_TEXT: "REPLAY_NO_DELIVER", MOCK_ACP_PROMPT_TEXT: "RESUME_PROMPT_OK", CPA_GROK_API_KEY: "test-key" }),
    ],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((e) => events.push(e));

  const sessionId = "ss-acprsum1";
  await runtime.registry.write({
    id: sessionId,
    connectionId: "grok-resume-rt",
    adapterId: GROK_ACP_ADAPTER_ID,
    connectionSnapshot: runtime.snapshotConnectionForStart("grok-resume-rt"),
    state: "stopped",
    resumeToken: "mock-acp-session-1",
    runtimeWorkspace: { cwd },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const handle = await resumeRoute(runtime, {
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
    connections: [
      {
        connectionId: "grok-resume-cwd",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        permissionPolicy: "deny",
      },
    ],
  });
  const sessionId = "ss-acpcwd01";
  await runtime.registry.write({
    id: sessionId,
    connectionId: "grok-resume-cwd",
    adapterId: GROK_ACP_ADAPTER_ID,
    connectionSnapshot: runtime.snapshotConnectionForStart("grok-resume-cwd"),
    state: "stopped",
    resumeToken: "mock-acp-session-1",
    runtimeWorkspace: { cwd: recordedCwd },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () => resumeRoute(runtime, { sessionId, cwd: otherCwd }),
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
    connections: [
      withMockEnv({
        connectionId: "grok-resume-redact",
        provider: "grok",
        adapterId: GROK_ACP_ADAPTER_ID,
        command: process.execPath,
        args: [MOCK_ACP],
        model: DEFAULT_GROK_MODEL,
        envKey: DEFAULT_GROK_ENV_KEY,
        permissionPolicy: "deny",
      }, { MOCK_ACP_LOAD_SESSION: "1", MOCK_ACP_KEEP_ALIVE: "1", CPA_GROK_API_KEY: "test-key" }),
    ],
  });
  const sessionId = "ss-acpredact";
  const now = new Date().toISOString();
  await runtime.registry.write({
    id: sessionId,
    connectionId: "grok-resume-redact",
    adapterId: GROK_ACP_ADAPTER_ID,
    connectionSnapshot: runtime.snapshotConnectionForStart("grok-resume-redact"),
    state: "stopped",
    resumeToken: privateToken,
    runtimeWorkspace: { cwd },
    createdAt: now,
    updatedAt: now,
  });

  await assert.rejects(
    () => resumeRoute(runtime, { sessionId, cwd }),
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
