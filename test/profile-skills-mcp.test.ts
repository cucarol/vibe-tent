/**
 * AgentProfile Skill refs + MCP server projection (CRUD, snapshot, ACP wire).
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
  FAKE_DEFAULT_PROFILE_ID,
  GROK_ACP_DEFAULT_PROFILE_ID,
  loadAgentProfiles,
  projectAgentProfile,
  profilesPath,
} from "../src/service/profiles.js";
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
import type { AgentProfileConfig } from "../src/runtime/types.js";
import { makeSessionId } from "../src/runtime/types.js";

const MOCK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

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
    },
  },
];

const rpc = (svc: Svc, method: string, params?: Record<string, unknown>) =>
  rpcCall(svc.url, method, params, { token: svc.token });

async function withService(
  fn: (svc: Svc, dataDir: string) => Promise<void>,
  opts?: { profiles?: AgentProfileConfig[]; inject?: boolean }
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    // inject=false seeds defaults to disk so CRUD persists agent-profiles.json
    ...(opts?.inject === false ? {} : { profiles: opts?.profiles ?? seed() }),
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

test("resolveAcpMcpServersWire fails loud on missing env / credential", () => {
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
      envCredentialRefs: { API_KEY: "mcp-key-1" },
    },
  ];
  assert.throws(
    () =>
      resolveAcpMcpServersWire(withCred, {
        planEnv: {},
        resolveCredential: () => undefined,
      }),
    /credential not found/i
  );

  const wire = resolveAcpMcpServersWire(withCred, {
    planEnv: {},
    resolveCredential: (id) => (id === "mcp-key-1" ? "secret-value" : undefined),
  });
  assert.equal(wire.length, 1);
  assert.ok("command" in wire[0]!);
  if ("command" in wire[0]!) {
    assert.equal(wire[0].env[0]?.value, "secret-value");
  }
});

test("profile.create/update/list/get skill+mcp whitelist + projection without secrets", async () => {
  const skillRoot = path.join(os.homedir(), ".agents", "skills", "tent-task");
  // Disk-backed catalog so create/update round-trips agent-profiles.json.
  await withService(async (svc, dataDir) => {
    const created = await rpc(svc, "profile.create", {
      id: "grok-acp-skmcp",
      adapterId: "grok-acp",
      displayName: "Skill MCP profile",
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
    const profile = (created.result as { profile: Record<string, unknown> }).profile;
    assert.equal((profile.skills as unknown[])?.length, 2);
    assert.equal((profile.mcpServers as unknown[])?.length, 2);
    // No plaintext secret fields on stored profile
    assert.equal(JSON.stringify(profile).includes("sk-"), false);

    const listed = await rpc(svc, "profile.list", {});
    assert.ok(!listed.error);
    const proj = (listed.result as { profiles: Array<Record<string, unknown>> }).profiles.find(
      (p) => p.id === "grok-acp-skmcp"
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

    const got = await rpc(svc, "profile.get", { id: "grok-acp-skmcp" });
    assert.ok(!got.error);
    assert.equal(
      ((got.result as { profile: { skills?: unknown[] } }).profile.skills)?.length,
      2
    );

    // Reject plaintext env on update
    const bad = await rpc(svc, "profile.update", {
      id: "grok-acp-skmcp",
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
    const cleared = await rpc(svc, "profile.update", {
      id: "grok-acp-skmcp",
      skills: null,
    });
    assert.ok(!cleared.error, JSON.stringify(cleared.error));
    const after = await rpc(svc, "profile.get", { id: "grok-acp-skmcp" });
    assert.ok(!after.error);
    assert.equal(
      (after.result as { profile: { skills?: unknown } }).profile.skills,
      undefined
    );

    // Disk round-trip
    const disk = await loadAgentProfiles(dataDir);
    const row = disk.find((p) => p.id === "grok-acp-skmcp");
    assert.ok(row, `expected grok-acp-skmcp on disk; got ${disk.map((p) => p.id).join(",")}`);
    assert.equal(row!.skills, undefined);
    assert.equal(row!.mcpServers?.length, 2);
  }, { inject: false });
});

test("profile.create rejects skill path outside allowed roots", async () => {
  await withService(async (svc) => {
    const res = await rpc(svc, "profile.create", {
      id: "grok-acp-badskill",
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

test("session/new projects mcpServers + skill meta from profile snapshot; live edits do not hot-update", async () => {
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

  const profile: AgentProfileConfig = {
    id: "grok-acp-mcp-proj",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: logPath,
      MOCK_ACP_KEEP_ALIVE: "1",
      MOCK_ACP_PROMPT_TEXT: "SKMCP_OK",
      CPA_GROK_API_KEY: "test-key-not-real",
      MCP_API_KEY: "mcp-secret-should-not-log",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 8_000,
    },
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
    profiles: [profile],
  });

  try {
    const sessionId = makeSessionId();
    await runtime.startSession({
      sessionId,
      profileId: profile.id,
      runtimeWorkspace: { cwd },
      bootstrapPrompt: "report ok",
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
    runtime.registerProfile({
      ...profile,
      skills: [{ name: "other-skill" }],
      mcpServers: [],
    });
    const record = await runtime.registry.read(sessionId);
    assert.ok(record?.profileSnapshot);
    assert.equal(record!.profileSnapshot!.skills?.[0]?.name, "extra-skill-fixture");
    assert.equal(record!.profileSnapshot!.mcpServers?.length, 2);

    await runtime.stopSession(sessionId, "user");
  } finally {
    await runtime.shutdown();
    await fs.rm(skillRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(homeSkill, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("session/load sends original snapshot mcpServers/skills after live profile mutation", async () => {
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

  const profile: AgentProfileConfig = {
    id: "grok-acp-mcp-load",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      ...baseEnv,
      MOCK_ACP_LOG: startLogPath,
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 8_000,
    },
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
    profiles: [profile],
  });

  try {
    const sessionId = makeSessionId();
    await runtime.startSession({
      sessionId,
      profileId: profile.id,
      runtimeWorkspace: { cwd },
      bootstrapPrompt: "start ok",
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
    runtime.registerProfile({
      ...profile,
      env: {
        ...baseEnv,
        MOCK_ACP_LOG: resumeLogPath,
      },
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

    // Resume uses profileSnapshot (original skills/mcp) + session/load, not live catalog.
    // Snapshot still has startLogPath in env — that is fine for asserting load payload.
    // Point resume env override so the new process writes a clean load log.
    await runtime.resumeSession({
      sessionId,
      cwd,
      env: { MOCK_ACP_LOG: resumeLogPath },
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
    // Original snapshot wire — not the mutated live profile.
    assert.equal(load.mcpServersLen, 1);
    assert.deepEqual(load.mcpServerNames, ["fs"]);
    assert.deepEqual(load.skillNames, ["extra-skill-fixture"]);
    assert.equal(loadRaw.includes("mcp-secret-should-not-log"), false);
    assert.equal(loadRaw.includes("mutated-only"), false);
    assert.equal(loadRaw.includes("mutated-skill-only"), false);

    const record = await runtime.registry.read(sessionId);
    assert.equal(record?.profileSnapshot?.skills?.[0]?.name, "extra-skill-fixture");
    assert.equal(record?.profileSnapshot?.mcpServers?.[0]?.name, "fs");

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
  const profile: AgentProfileConfig = {
    id: "grok-acp-skill-missing",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 4_000,
    },
    skills: [{ name: "missing-skill", path: missing, enabled: true }],
  };
  const runtime = createAgentRuntime({ dataDir, profiles: [profile] });
  try {
    await assert.rejects(
      () =>
        runtime.startSession({
          sessionId: makeSessionId(),
          profileId: profile.id,
          runtimeWorkspace: { cwd },
          bootstrapPrompt: "should fail",
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
  const profile: AgentProfileConfig = {
    id: "grok-acp-skill-resmiss",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: logPath,
      MOCK_ACP_KEEP_ALIVE: "1",
      MOCK_ACP_LOAD_SESSION: "1",
      MOCK_ACP_PROMPT_TEXT: "OK",
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 8_000,
    },
    skills: [{ name: "will-vanish", path: skillDir, enabled: true }],
  };
  const runtime = createAgentRuntime({ dataDir, profiles: [profile] });
  try {
    const sessionId = makeSessionId();
    await runtime.startSession({
      sessionId,
      profileId: profile.id,
      runtimeWorkspace: { cwd },
      bootstrapPrompt: "start ok",
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
        }),
      /path does not exist/i
    );
  } finally {
    await runtime.shutdown();
    await fs.rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("buildAcpLaunchExtras / startSession does not swallow credential resolver errors", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-cred-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-cred-cwd-"));
  const profile: AgentProfileConfig = {
    id: "grok-acp-cred-throw",
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    acp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: "deny",
      promptTimeoutMs: 4_000,
    },
    mcpServers: [
      {
        name: "vaulted",
        transport: "stdio",
        command: "npx",
        envCredentialRefs: { API_KEY: "mcp-secret-ref" },
      },
    ],
  };
  const runtime = createAgentRuntime({
    dataDir,
    profiles: [profile],
    resolveCredentialRef: async () => {
      throw new Error("vault backend exploded with secret=sk-should-not-leak");
    },
  });
  try {
    await assert.rejects(
      () =>
        runtime.startSession({
          sessionId: makeSessionId(),
          profileId: profile.id,
          runtimeWorkspace: { cwd },
          bootstrapPrompt: "should fail loud",
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /credential resolve failed/i);
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

test("projectAgentProfile never embeds SKILL.md body", () => {
  const body = "# Super secret skill body\nDo not leak\n";
  const p = projectAgentProfile({
    id: "grok-acp-x",
    adapterId: GROK_ACP_ADAPTER_ID,
    skills: [{ name: "tent-role", path: path.join(os.homedir(), ".agents", "skills", "tent-role") }],
    acp: { permissionPolicy: "deny" },
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
    profilesPath(dataDir),
    JSON.stringify({
      profiles: [
        {
          id: "grok-acp-q",
          adapterId: "grok-acp",
          acp: { permissionPolicy: "deny" },
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
  const loaded = await loadAgentProfiles(dataDir);
  // Whole-file quarantine → empty catalog
  assert.equal(loaded.length, 0);
});
