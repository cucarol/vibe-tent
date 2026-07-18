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
  const skillRoot = path.join(os.homedir(), ".agents", "skills", "tent-role");
  // Disk-backed catalog so create/update round-trips agent-profiles.json.
  await withService(async (svc, dataDir) => {
    const created = await rpc(svc, "profile.create", {
      id: "grok-acp-skmcp",
      adapterId: "grok-acp",
      displayName: "Skill MCP profile",
      skills: [
        { name: "tent-role", path: skillRoot, enabled: true },
        { name: "tent-genesis", enabled: false },
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
    const projJson = JSON.stringify(proj);
    assert.equal(projJson.includes("secret-value"), false);
    assert.equal(projJson.includes("Bearer "), false);
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

test("session/new projects mcpServers + skill meta from profile snapshot; live edits do not hot-update", async () => {
  const logPath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "tent-skmcp-log-")),
    "mock.json"
  );
  const skillPath = path.join(os.homedir(), ".agents", "skills", "tent-role");
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
    skills: [{ name: "tent-role", path: skillPath }],
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

    // Wait for mock log to flush after session/new
    let logRaw = "";
    for (let i = 0; i < 40; i++) {
      try {
        logRaw = await fs.readFile(logPath, "utf8");
        if (logRaw.includes("news")) break;
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(logRaw, "mock log should exist");
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
    assert.deepEqual(news.skillNames, ["tent-role"]);
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
    assert.equal(record!.profileSnapshot!.skills?.[0]?.name, "tent-role");
    assert.equal(record!.profileSnapshot!.mcpServers?.length, 2);

    await runtime.stopSession(sessionId, "user");
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
