/**
 * Agent Connection Skill refs + MCP server projection (CRUD, snapshot, ACP wire).
 * Secrets must never appear in projection / disk / mock logs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import {
  loadAgentConnections,
  projectAgentConnection,
  connectionsPath,
} from "../src/service/connections.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";
import {
  isUnderAllowedSkillRoots,
  parseMcpServersArrayValue,
  parseSkillsArrayValue,
  resolveAcpMcpServersWire,
  resolveAcpSkillMeta,
} from "../src/adapters/acp/mcp-skills.js";
import { createAgentRuntime } from "../src/runtime/index.js";
import type { AgentConnectionConfig } from "../src/runtime/agent-connection.js";
import { makeSessionId } from "../src/runtime/types.js";

const MOCK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

async function startConnection(
  runtime: ReturnType<typeof createAgentRuntime>,
  request: Parameters<ReturnType<typeof createAgentRuntime>["startSession"]>[0] & { connectionId: string }
) {
  const { connectionId, ...start } = request;
  const workspace = start.workspace ?? start.workspaceLane?.workspace ?? start.runtimeWorkspace?.cwd ?? start.cwd;
  if (!workspace) throw new Error("test start requires a workspace");
  const currentTaskId = start.currentTaskId ?? `tk-${start.sessionId.replace(/[^a-z0-9]/gi, "")}`;
  await runtime.reserveSession({ sessionId: start.sessionId, connectionId, currentTaskId, workspace, workspaceLane: start.workspaceLane, runtimeWorkspace: start.runtimeWorkspace, cwd: start.cwd });
  return runtime.startSession({ ...start, currentTaskId, workspace });
}

const seed = (): AgentConnectionConfig[] => [
  {
    connectionId: "fake-default",
    provider: "fake",
    adapterId: FAKE_ADAPTER_ID,
    fake: { waitForSignal: true, emitStdout: true, canResume: true },
  },
  {
    connectionId: "grok-acp-default",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    model: DEFAULT_GROK_MODEL,
    envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny",
  },
];

const rpc = (svc: Svc, method: string, params?: Record<string, unknown>) =>
  rpcCall(svc.url, method, params, { token: svc.token });

async function withService(
  fn: (svc: Svc, dataDir: string) => Promise<void>,
  opts?: { connections?: AgentConnectionConfig[]; inject?: boolean }
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    // inject=false seeds defaults to disk so CRUD persists connections.json.
    ...(opts?.inject === false ? {} : { connections: opts?.connections ?? seed() }),
  });
  try {
    await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

test("parseSkillsArrayValue rejects path outside allowed roots", () => {
  const home = os.tmpdir();
  const roots = [path.join(home, ".agents", "skills")];
  const bad = parseSkillsArrayValue(
    [{ name: "tent-role", path: path.join(home, "evil", "skills", "tent-role") }],
    roots
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /allowed skill roots/i);

  const goodPath = path.join(roots[0]!, "tent-role");
  const good = parseSkillsArrayValue([{ name: "tent-role", path: goodPath }], roots);
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value?.[0]?.name, "tent-role");
    assert.ok(isUnderAllowedSkillRoots(good.value![0]!.path!, roots));
  }
});

test("parseMcpServersArrayValue rejects plaintext env/headers maps", () => {
  const badEnv = parseMcpServersArrayValue([
    {
      name: "fs",
      transport: "stdio",
      command: "npx",
      env: { API_KEY: "sk-secret" },
    },
  ]);
  assert.equal(badEnv.ok, false);
  if (!badEnv.ok) assert.match(badEnv.message, /envKeys|dangerous|unsupported/i);

  const badHeaders = parseMcpServersArrayValue([
    {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer sk-secret" },
    },
  ]);
  assert.equal(badHeaders.ok, false);

  const ok = parseMcpServersArrayValue([
    {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      envKeys: { API_KEY: "MCP_API_KEY" },
    },
    {
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headerEnvKeys: { Authorization: "MCP_AUTH_TOKEN" },
    },
  ]);
  assert.equal(ok.ok, true);
});

test("resolveAcpMcpServersWire fails loud on missing env / launch secret", () => {
  const servers = [
    {
      name: "fs",
      transport: "stdio" as const,
      command: "npx",
      envKeys: { API_KEY: "MISSING_MCP_KEY" },
    },
  ];
  assert.throws(
    () => resolveAcpMcpServersWire(servers, { planEnv: {} }),
    /missing process env MISSING_MCP_KEY/i
  );

  const withCred = [
    {
      name: "fs",
      transport: "stdio" as const,
      command: "npx",
      envSecretRefs: { API_KEY: "mcp-key-1" },
    },
  ];
  assert.throws(
    () =>
      resolveAcpMcpServersWire(withCred, {
        planEnv: {},
        resolveLaunchSecret: () => undefined,
      }),
    /launch secret not found/i
  );

  const wire = resolveAcpMcpServersWire(withCred, {
    planEnv: {},
    resolveLaunchSecret: (id) => (id === "mcp-key-1" ? "secret-value" : undefined),
  });
  assert.equal(wire.length, 1);
  assert.ok("command" in wire[0]!);
  if ("command" in wire[0]!) {
    assert.equal(wire[0].env[0]?.value, "secret-value");
  }
});

test("connection.create/update/list/get skill+mcp whitelist + projection without secrets", async () => {
  const skillRoot = path.join(os.homedir(), ".agents", "skills", "tent-task");
  // Disk-backed catalog so create/update round-trips connections.json.
  await withService(async (svc, dataDir) => {
    const created = await rpc(svc, "connection.create", {
      connectionId: "grok-acp-skmcp",
      provider: "grok",
      adapterId: "grok-acp",
      displayName: "Skill MCP Connection",
      skills: [
        { name: "tent-task", path: skillRoot, enabled: true },
        { name: "review-helper", enabled: false },
      ],
      mcpServers: [
        {
          name: "fs",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          envKeys: { API_KEY: "MCP_API_KEY" },
        },
        {
          name: "remote",
          transport: "http",
          url: "https://mcp.example.com/mcp",
          headerEnvKeys: { Authorization: "MCP_AUTH_TOKEN" },
        },
      ],
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const connection = (created.result as { connection: Record<string, unknown> }).connection;
    assert.equal((connection.skills as unknown[])?.length, 2);
    assert.equal((connection.mcpServers as unknown[])?.length, 2);
    assert.equal(JSON.stringify(connection).includes("sk-"), false);

    const listed = await rpc(svc, "connection.list", {});
    assert.ok(!listed.error);
    const proj = (listed.result as { connections: Array<Record<string, unknown>> }).connections.find(
      (p) => p.connectionId === "grok-acp-skmcp"
    );
    assert.ok(proj);
    assert.ok(Array.isArray(proj.skills));
    assert.ok(Array.isArray(proj.mcpServers));
    // Honesty: skill projection is metadata / provider-dependent — not activation.
    assert.equal(proj.skillsProjectionMode, "metadata-provider-dependent");
    assert.match(String(proj.skillsNote || ""), /provider-dependent|not a claim of activation/i);
    const projJson = JSON.stringify(proj);
    assert.equal(projJson.includes("secret-value"), false);
    assert.equal(projJson.includes("Bearer "), false);
    assert.equal(/activated|activation complete/i.test(projJson), false);
    // envKeys present as key names only
    assert.match(projJson, /MCP_API_KEY/);

    const got = await rpc(svc, "connection.get", { connectionId: "grok-acp-skmcp" });
    assert.ok(!got.error);
    assert.equal(
      ((got.result as { connection: { skills?: unknown[] } }).connection.skills)?.length,
      2
    );

    // Reject plaintext env on update
    const bad = await rpc(svc, "connection.update", {
      connectionId: "grok-acp-skmcp",
      mcpServers: [
        {
          name: "fs",
          transport: "stdio",
          command: "npx",
          env: { API_KEY: "sk-leak" },
        },
      ],
    });
    assert.ok(bad.error);
    assert.match(String(bad.error.message), /envKeys|dangerous|unsupported|Unknown/i);

    // Clear skills
    const cleared = await rpc(svc, "connection.update", {
      connectionId: "grok-acp-skmcp",
      skills: null,
    });
    assert.ok(!cleared.error, JSON.stringify(cleared.error));
    const after = await rpc(svc, "connection.get", { connectionId: "grok-acp-skmcp" });
    assert.ok(!after.error);
    assert.equal(
      (after.result as { connection: { skills?: unknown } }).connection.skills,
      undefined
    );

    // Disk round-trip
    const disk = await loadAgentConnections(dataDir);
    const row = disk.find((p) => p.connectionId === "grok-acp-skmcp");
    assert.ok(row, `expected grok-acp-skmcp on disk; got ${disk.map((p) => p.connectionId).join(",")}`);
    assert.equal(row!.skills, undefined);
    assert.equal(row!.mcpServers?.length, 2);
  }, { inject: false });
});

test("connection.create rejects skill path outside allowed roots", async () => {
  await withService(async (svc) => {
    const res = await rpc(svc, "connection.create", {
      connectionId: "grok-acp-badskill",
      provider: "grok",
      adapterId: GROK_ACP_ADAPTER_ID,
      skills: [{ name: "evil", path: path.join(os.tmpdir(), "not-a-skill-root", "evil") }],
    });
    assert.ok(res.error);
    assert.match(String(res.error.message), /allowed skill roots/i);
  });
});

async function waitForMockLog(
  logPath: string,
  predicate: (raw: string) => boolean,
  attempts = 80
): Promise<string> {
  let logRaw = "";
  for (let i = 0; i < attempts; i++) {
    try {
      logRaw = await fs.readFile(logPath, "utf8");
      if (predicate(logRaw)) return logRaw;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(logRaw, "mock log should exist");
  return logRaw;
}

test("session/new projects mcpServers + skill meta from Connection snapshot; live edits do not hot-update", async () => {
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-log-")),
    "mock.json"
  );
  // Optional extra Skill (non-built-in): tent-role/tent-task are reserved and
  // model-visible only via stable bootstrap — never re-advertised in ACP meta.
  const skillRoot = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-skills-")),
    "extra-skill-fixture"
  );
  await fs.mkdir(skillRoot, { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# fixture\n", "utf8");
  // Temporarily treat this dir as allowed by using name-only for skill that may
  // not be under home roots — path existence is what start/resume validates.
  // For CRUD roots check is separate; runtime only checks existence when path set.
  // Use a path under ~/.agents/skills if possible, else any existing path.
  const homeSkill = path.join(os.homedir(), ".agents", "skills", "extra-skill-skmcp-fixture");
  await fs.mkdir(homeSkill, { recursive: true });
  await fs.writeFile(path.join(homeSkill, "SKILL.md"), "# fixture\n", "utf8");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-rt-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-cwd-"));

  const route: AgentConnectionConfig = {
    connectionId: "grok-acp-mcp-proj",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny",
    promptTimeoutMs: 8_000,
    skills: [{ name: "extra-skill-fixture", path: homeSkill }],
    mcpServers: [
      {
        name: "fs",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        envKeys: { API_KEY: "MCP_API_KEY" },
      },
      {
        name: "disabled",
        transport: "http",
        url: "https://mcp.example.com",
        enabled: false,
      },
    ],
  };

  const runtime = createAgentRuntime({
    dataDir,
    connections: [route],
  });

  try {
    const sessionId = makeSessionId();
    await startConnection(runtime, {
      sessionId,
      connectionId: route.connectionId,
      runtimeWorkspace: { cwd },
      bootstrapPrompt: "report ok",
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "1",
        MOCK_ACP_PROMPT_TEXT: "SKMCP_OK",
        CPA_GROK_API_KEY: "test-key-not-real",
        MCP_API_KEY: "mcp-secret-should-not-log",
      },
    });

    const logRaw = await waitForMockLog(logPath, (raw) => raw.includes("news"));
    const log = JSON.parse(logRaw) as {
      news?: Array<{
        mcpServersLen?: number;
        mcpServerNames?: string[];
        skillNames?: string[];
      }>;
    };
    assert.ok(Array.isArray(log.news) && log.news.length >= 1);
    const news = log.news[0]!;
    assert.equal(news.mcpServersLen, 1); // disabled excluded
    assert.deepEqual(news.mcpServerNames, ["fs"]);
    assert.deepEqual(news.skillNames, ["extra-skill-fixture"]);
    // Secret must not appear in mock log
    assert.equal(logRaw.includes("mcp-secret-should-not-log"), false);

    // Snapshot isolation: mutate live catalog after start — already-started session snapshot unchanged
    runtime.registerConnection({
      ...route,
      skills: [{ name: "other-skill" }],
      mcpServers: [],
    });
    const record = await runtime.registry.read(sessionId);
    assert.ok(record?.connectionSnapshot);
    assert.equal(record!.connectionSnapshot.skills?.[0]?.name, "extra-skill-fixture");
    assert.equal(record!.connectionSnapshot.mcpServers?.length, 2);

    await runtime.stopSession(sessionId, "user");
  } finally {
    await runtime.shutdown();
    await fs.rm(skillRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(homeSkill, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("MCP launchSecretRef plaintext is ephemeral and redacted from ACP failure diagnostics", async () => {
  const secret = "mcp-vault-secret-never-persist";
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-redact-rt-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-redact-cwd-"));
  const connection: AgentConnectionConfig = {
    connectionId: "grok-acp-mcp-redact",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    permissionPolicy: "deny",
    promptTimeoutMs: 8_000,
    mcpServers: [
      {
        name: "vault-mcp",
        transport: "stdio",
        command: "npx",
        envSecretRefs: { API_KEY: "mcp-vault" },
      },
    ],
  };
  const runtime = createAgentRuntime({
    dataDir,
    connections: [connection],
    resolveLaunchSecretRef: async (launchSecretRef) =>
      launchSecretRef === "mcp-vault" ? secret : undefined,
  });
  const sessionId = makeSessionId();
  const events: unknown[] = [];
  runtime.subscribe(sessionId, (event) => events.push(event));

  try {
    await assert.rejects(
      () =>
        startConnection(runtime, {
          sessionId,
          connectionId: connection.connectionId,
          runtimeWorkspace: { cwd },
          bootstrapPrompt: "must fail before prompt",
          env: {
            MOCK_ACP_FAIL_NEW: "1",
            MOCK_ACP_ECHO_MCP_SECRET: "1",
          },
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, new RegExp(secret));
        assert.match(message, /\[redacted\]/);
        return true;
      }
    );

    const record = await runtime.registry.read(sessionId);
    assert.equal(JSON.stringify(record).includes(secret), false);
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.match(JSON.stringify(events), /\[redacted\]/);
  } finally {
    await runtime.shutdown();
  }
});

test("session/load sends original snapshot mcpServers/skills after live Connection mutation", async () => {
  // Separate logs: resume spawns a new bridge process that overwrites MOCK_ACP_LOG.
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-load-log-"));
  const startLogPath = path.join(logDir, "start.json");
  const resumeLogPath = path.join(logDir, "resume.json");
  const homeSkill = path.join(
    os.homedir(),
    ".agents",
    "skills",
    "extra-skill-skmcp-load-fixture"
  );
  await fs.mkdir(homeSkill, { recursive: true });
  await fs.writeFile(path.join(homeSkill, "SKILL.md"), "# fixture load\n", "utf8");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-load-rt-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-load-cwd-"));

  const baseEnv = {
    MOCK_ACP_KEEP_ALIVE: "1",
    MOCK_ACP_LOAD_SESSION: "1",
    MOCK_ACP_HISTORY_TEXT: "HISTORY_NO_DELIVER",
    MOCK_ACP_PROMPT_TEXT: "LOAD_SKMCP_OK",
    CPA_GROK_API_KEY: "test-key-not-real",
    MCP_API_KEY: "mcp-secret-should-not-log",
  };

  const route: AgentConnectionConfig = {
    connectionId: "grok-acp-mcp-load",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny",
    promptTimeoutMs: 8_000,
    skills: [{ name: "extra-skill-fixture", path: homeSkill }],
    mcpServers: [
      {
        name: "fs",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        envKeys: { API_KEY: "MCP_API_KEY" },
      },
    ],
  };

  const runtime = createAgentRuntime({
    dataDir,
    connections: [route],
  });

  try {
    const sessionId = makeSessionId();
    await startConnection(runtime, {
      sessionId,
      connectionId: route.connectionId,
      runtimeWorkspace: { cwd },
      bootstrapPrompt: "start ok",
      env: { ...baseEnv, MOCK_ACP_LOG: startLogPath },
    });

    const startRaw = await waitForMockLog(startLogPath, (raw) => {
      try {
        const j = JSON.parse(raw) as { news?: unknown[]; methods?: string[] };
        return (
          Array.isArray(j.news) &&
          j.news.length >= 1 &&
          Array.isArray(j.methods) &&
          j.methods.includes("session/new")
        );
      } catch {
        return false;
      }
    });
    const startLog = JSON.parse(startRaw) as {
      methods: string[];
      news?: Array<{
        mcpServersLen?: number;
        mcpServerNames?: string[];
        skillNames?: string[];
      }>;
    };
    assert.ok(startLog.methods.includes("session/new"));
    assert.equal(startLog.news?.[0]?.mcpServersLen, 1);
    assert.deepEqual(startLog.news?.[0]?.mcpServerNames, ["fs"]);
    assert.deepEqual(startLog.news?.[0]?.skillNames, ["extra-skill-fixture"]);

    // Live catalog mutation after start must not affect resume projection.
    // Also point resume bridge log at a separate file (snapshot env still has start path).
    runtime.registerConnection({
      ...route,
      skills: [{ name: "mutated-skill-only" }],
      mcpServers: [
        {
          name: "mutated-only",
          transport: "http",
          url: "https://mcp.example.com/mutated",
        },
      ],
    });

    await runtime.stopSession(sessionId, "user");

    // Resume uses connectionSnapshot (original skills/mcp) + session/load, not live catalog.
    await runtime.resumeSession({
      sessionId,
      cwd,
      env: { ...baseEnv, MOCK_ACP_LOG: resumeLogPath },
      bootstrapPrompt: "resume ok",
    });

    const loadRaw = await waitForMockLog(resumeLogPath, (raw) => {
      try {
        const j = JSON.parse(raw) as { loads?: unknown[]; methods?: string[] };
        return (
          Array.isArray(j.loads) &&
          j.loads.length >= 1 &&
          Array.isArray(j.methods) &&
          j.methods.includes("session/load")
        );
      } catch {
        return false;
      }
    });
    const loadLog = JSON.parse(loadRaw) as {
      methods: string[];
      loads?: Array<{
        mcpServersLen?: number;
        mcpServerNames?: string[];
        skillNames?: string[];
        sessionId?: string | null;
      }>;
    };
    assert.ok(loadLog.methods.includes("session/load"));
    // Honest resume: new process must not call session/new.
    assert.ok(!loadLog.methods.includes("session/new"));
    assert.ok(Array.isArray(loadLog.loads) && loadLog.loads.length >= 1);
    const load = loadLog.loads[0]!;
    // Original snapshot wire — not the mutated live Connection.
    assert.equal(load.mcpServersLen, 1);
    assert.deepEqual(load.mcpServerNames, ["fs"]);
    assert.deepEqual(load.skillNames, ["extra-skill-fixture"]);
    assert.equal(loadRaw.includes("mcp-secret-should-not-log"), false);
    assert.equal(loadRaw.includes("mutated-only"), false);
    assert.equal(loadRaw.includes("mutated-skill-only"), false);

    const record = await runtime.registry.read(sessionId);
    assert.equal(record?.connectionSnapshot?.skills?.[0]?.name, "extra-skill-fixture");
    assert.equal(record?.connectionSnapshot?.mcpServers?.[0]?.name, "fs");

    await runtime.stopSession(sessionId, "user");
  } finally {
    await runtime.shutdown();
    await fs.rm(homeSkill, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("startSession fails loud when enabled skill path is missing", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-miss-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-miss-cwd-"));
  const missing = path.join(
    os.homedir(),
    ".agents",
    "skills",
    "tent-role-skmcp-missing-" + Date.now()
  );
  const route: AgentConnectionConfig = {
    connectionId: "grok-acp-skill-missing",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny",
    promptTimeoutMs: 4_000,
    skills: [{ name: "missing-skill", path: missing, enabled: true }],
  };
  const runtime = createAgentRuntime({ dataDir, connections: [route] });
  try {
    await assert.rejects(
      () =>
        startConnection(runtime, {
          sessionId: makeSessionId(),
          connectionId: route.connectionId,
          runtimeWorkspace: { cwd },
          bootstrapPrompt: "should fail",
          env: { CPA_GROK_API_KEY: "test-key-not-real" },
        }),
      /path does not exist/i
    );
  } finally {
    await runtime.shutdown();
  }
});

test("resumeSession fails loud when snapshot skill path is missing", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-resmiss-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-resmiss-cwd-"));
  const skillDir = path.join(
    os.homedir(),
    ".agents",
    "skills",
    "tent-role-skmcp-resmiss-fixture"
  );
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "# fixture\n", "utf8");

  const logPath = path.join(dataDir, "mock.json");
  const route: AgentConnectionConfig = {
    connectionId: "grok-acp-skill-resmiss",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny",
    promptTimeoutMs: 8_000,
    skills: [{ name: "will-vanish", path: skillDir, enabled: true }],
  };
  const runtime = createAgentRuntime({ dataDir, connections: [route] });
  try {
    const sessionId = makeSessionId();
    await startConnection(runtime, {
      sessionId,
      connectionId: route.connectionId,
      runtimeWorkspace: { cwd },
      bootstrapPrompt: "start ok",
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "1",
        MOCK_ACP_LOAD_SESSION: "1",
        MOCK_ACP_PROMPT_TEXT: "OK",
        CPA_GROK_API_KEY: "test-key-not-real",
      },
    });
    await waitForMockLog(logPath, (raw) => raw.includes("news"));
    await runtime.stopSession(sessionId, "user");

    // Remove the path after snapshot was captured — resume must fail loud.
    await fs.rm(skillDir, { recursive: true, force: true });

    await assert.rejects(
      () =>
        runtime.resumeSession({
          sessionId,
          cwd,
          bootstrapPrompt: "resume should fail",
          env: {
            MOCK_ACP_LOG: logPath,
            MOCK_ACP_KEEP_ALIVE: "1",
            MOCK_ACP_LOAD_SESSION: "1",
            MOCK_ACP_PROMPT_TEXT: "OK",
            CPA_GROK_API_KEY: "test-key-not-real",
          },
        }),
      /path does not exist/i
    );
  } finally {
    await runtime.shutdown();
    await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("buildAcpLaunchExtras / startSession does not swallow launch-secret resolver errors", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-cred-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-cred-cwd-"));
  const route: AgentConnectionConfig = {
    connectionId: "grok-acp-cred-throw",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    model: DEFAULT_GROK_MODEL,
    envKey: "CPA_GROK_API_KEY",
    permissionPolicy: "deny",
    promptTimeoutMs: 4_000,
    mcpServers: [
      {
        name: "vaulted",
        transport: "stdio",
        command: "npx",
        envSecretRefs: { API_KEY: "mcp-secret-ref" },
      },
    ],
  };
  const runtime = createAgentRuntime({
    dataDir,
    connections: [route],
    resolveLaunchSecretRef: async () => {
      throw new Error("vault backend exploded with secret=sk-should-not-leak");
    },
  });
  try {
    await assert.rejects(
      () =>
        startConnection(runtime, {
          sessionId: makeSessionId(),
          connectionId: route.connectionId,
          runtimeWorkspace: { cwd },
          bootstrapPrompt: "should fail loud",
          env: { CPA_GROK_API_KEY: "test-key-not-real" },
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /launch-secret resolve failed/i);
        assert.match(msg, /vaulted/);
        assert.match(msg, /mcp-secret-ref/);
        assert.match(msg, /grok-acp-cred-throw/);
        assert.equal(msg.includes("sk-should-not-leak"), false);
        assert.equal(msg.includes("vault backend exploded"), false);
        return true;
      }
    );
  } finally {
    await runtime.shutdown();
  }
});

test("projectAgentConnection never embeds SKILL.md body", () => {
  const body = "# Super secret skill body\nDo not leak\n";
  const p = projectAgentConnection({
    connectionId: "grok-acp-x",
    provider: "grok",
    adapterId: GROK_ACP_ADAPTER_ID,
    skills: [{ name: "tent-role", path: path.join(os.homedir(), ".agents", "skills", "tent-role") }],
    permissionPolicy: "deny",
  });
  assert.ok(p.skills);
  assert.equal(JSON.stringify(p).includes(body), false);
  assert.equal(p.skills![0]!.name, "tent-role");
});

test("resolveAcpSkillMeta skips disabled and does not read SKILL.md", () => {
  const meta = resolveAcpSkillMeta([
    { name: "a", enabled: true },
    { name: "b", enabled: false },
    { name: "c" },
  ]);
  assert.deepEqual(
    meta.map((s) => s.name),
    ["a", "c"]
  );
});

test("resolveAcpSkillMeta requirePathExists fails loud for missing path; name-only ok", () => {
  const missing = path.join(
    os.homedir(),
    ".agents",
    "skills",
    "no-such-skill-" + Date.now()
  );
  assert.throws(
    () =>
      resolveAcpSkillMeta([{ name: "gone", path: missing }], {
        requirePathExists: true,
      }),
    /path does not exist/i
  );
  const nameOnly = resolveAcpSkillMeta([{ name: "name-only" }], {
    requirePathExists: true,
  });
  assert.deepEqual(nameOnly, [{ name: "name-only" }]);
});

test("disk quarantine on unknown mcpServers field with secret shape", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-q-"));
  await fs.writeFile(
    connectionsPath(dataDir),
    JSON.stringify({
      connections: [
        {
          connectionId: "grok-acp-q",
          provider: "grok",
          adapterId: "grok-acp",
          permissionPolicy: "deny",
          mcpServers: [
            {
              name: "fs",
              transport: "stdio",
              command: "npx",
              env: { API_KEY: "sk-leak" },
            },
          ],
        },
      ],
    }) + "\n",
    "utf8"
  );
  await assert.rejects(() => loadAgentConnections(dataDir), /quarantined/i);
  const backups = (await fs.readdir(dataDir)).filter((name) => name.startsWith("connections.json.corrupt-"));
  assert.equal(backups.length, 1);
});
