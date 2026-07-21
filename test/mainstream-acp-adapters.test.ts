/**
 * Mainstream ACP adapter tests use the offline mock ACP server only.
 * They never launch npx, Codex, Claude, or contact a network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildCodexDefaultAuthRequest,
  CODEX_ACP_NPX_PACKAGE,
  createCodexAcpAdapter,
} from "../src/adapters/codex-acp/index.js";
import {
  CLAUDE_ACP_NPX_PACKAGE,
  createClaudeAcpAdapter,
} from "../src/adapters/claude-acp/index.js";
import {
  createAntigravityAcpAdapter,
  defaultAntigravityAcpExecutable,
} from "../src/adapters/antigravity-acp/index.js";
import {
  createOpenCodeAcpAdapter,
  defaultOpenCodeExecutable,
} from "../src/adapters/opencode-acp/index.js";
import {
  COPILOT_ACP_NPX_PACKAGE,
  createCopilotAcpAdapter,
} from "../src/adapters/copilot-acp/index.js";
import type { ProviderAdapter } from "../src/adapters/types.js";
import { defaultNpxLaunch } from "../src/adapters/acp/index.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ACP = path.join(__dirname, "fixtures", "mock-acp-server.mjs");

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readJsonWhenComplete<T>(
  file: string,
  accept: (value: T) => boolean = () => true,
  timeoutMs = 2_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as T;
      if (accept(value)) return value;
      lastError = new Error(`JSON log not complete yet: ${file}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

test("Codex ACP resolves the official npx bridge and injects headless API-key auth", () => {
  const adapter = createCodexAcpAdapter({
    resolveEnvValue: () => "secret-for-test",
  });
  const launch = adapter.resolveLaunch({
    sessionId: "ss-codex01",
    profileId: "codex-acp-default",
    roleName: "executor",
    cwd: process.cwd(),
    env: {},
    extras: { acp: { envKey: "OPENAI_API_KEY" } },
  });

  const npx = defaultNpxLaunch();
  assert.equal(launch.command, npx.command);
  assert.deepEqual(launch.args, [...npx.argsPrefix, "--yes", CODEX_ACP_NPX_PACKAGE]);
  assert.equal(launch.env.OPENAI_API_KEY, "secret-for-test");
  assert.deepEqual(JSON.parse(launch.env.DEFAULT_AUTH_REQUEST), {
    methodId: "api-key",
    _meta: { "api-key": { apiKey: "secret-for-test" } },
  });
  assert.equal(launch.env.TENT_ROLE_NAME, "executor");
  assert.doesNotMatch(JSON.stringify(adapter), /secret-for-test/);
});

test("Codex ACP fails loud when an explicitly configured key is missing", () => {
  const adapter = createCodexAcpAdapter({ resolveEnvValue: () => undefined });
  assert.throws(
    () =>
      adapter.resolveLaunch({
        sessionId: "ss-codex02",
        profileId: "codex-acp-default",
        cwd: process.cwd(),
        env: {},
        extras: { acp: { envKey: "OPENAI_API_KEY" } },
      }),
    /未配置环境变量 OPENAI_API_KEY/
  );
});

test("Claude ACP resolves the official npx bridge and permits local-login mode", () => {
  const adapter = createClaudeAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-claude01",
    profileId: "claude-acp-default",
    cwd: process.cwd(),
    env: {},
    extras: { acp: {} },
  });

  const npx = defaultNpxLaunch();
  assert.equal(launch.command, npx.command);
  assert.deepEqual(launch.args, [...npx.argsPrefix, "--yes", CLAUDE_ACP_NPX_PACKAGE]);
  assert.equal(launch.env.DEFAULT_AUTH_REQUEST, undefined);
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
});

test("Claude ACP injects an explicitly configured env key and fails when absent", () => {
  const adapter = createClaudeAcpAdapter({
    resolveEnvValue: (_key, env) => env.ANTHROPIC_API_KEY,
  });
  const base = {
    sessionId: "ss-claude02",
    profileId: "claude-acp-default",
    cwd: process.cwd(),
    extras: { acp: { envKey: "ANTHROPIC_API_KEY" } },
  };
  assert.equal(
    adapter.resolveLaunch({ ...base, env: { ANTHROPIC_API_KEY: "test-only" } }).env
      .ANTHROPIC_API_KEY,
    "test-only"
  );
  assert.throws(() => adapter.resolveLaunch({ ...base, env: {} }), /ANTHROPIC_API_KEY/);
});

test("Codex auth request builder contains only the ACP api-key envelope", () => {
  assert.deepEqual(JSON.parse(buildCodexDefaultAuthRequest("k")), {
    methodId: "api-key",
    _meta: { "api-key": { apiKey: "k" } },
  });
});

test("Antigravity ACP uses the external agy-acp bridge, never agy directly", () => {
  const adapter = createAntigravityAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-agy01",
    profileId: "antigravity-acp-default",
    cwd: process.cwd(),
    env: {},
    extras: { acp: {} },
  });
  assert.equal(launch.command, defaultAntigravityAcpExecutable());
  assert.deepEqual(launch.args, []);
  assert.notEqual(launch.command, process.platform === "win32" ? "agy.exe" : "agy");
});

test("Antigravity ACP explicit env requirement fails loud and names the bridge", () => {
  const adapter = createAntigravityAcpAdapter({ resolveEnvValue: () => undefined });
  assert.throws(
    () =>
      adapter.resolveLaunch({
        sessionId: "ss-agy02",
        profileId: "antigravity-acp-default",
        cwd: process.cwd(),
        env: {},
        extras: { acp: { envKey: "AGY_API_KEY" } },
      }),
    /第三方 agy-acp bridge/
  );
});

test("OpenCode ACP uses its native `opencode acp` entrypoint", () => {
  const adapter = createOpenCodeAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-opencode01",
    profileId: "opencode-acp-default",
    cwd: process.cwd(),
    env: {},
    extras: { acp: {} },
  });
  assert.equal(launch.command, defaultOpenCodeExecutable());
  assert.deepEqual(launch.args, ["acp"]);
});

test("OpenCode ACP honors explicit command/args without appending `acp`", () => {
  const adapter = createOpenCodeAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-opencode02",
    profileId: "opencode-acp-default",
    cwd: process.cwd(),
    env: {},
    command: process.execPath,
    args: [MOCK_ACP],
    extras: { acp: {} },
  });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [MOCK_ACP]);
});

test("Copilot ACP uses the official npx package in explicit stdio mode", () => {
  const adapter = createCopilotAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-copilot01",
    profileId: "copilot-acp-default",
    cwd: process.cwd(),
    env: {},
    extras: { acp: { model: "claude-sonnet-4.5" } },
  });
  const npx = defaultNpxLaunch();
  assert.equal(launch.command, npx.command);
  assert.deepEqual(launch.args, [
    ...npx.argsPrefix,
    "--yes",
    COPILOT_ACP_NPX_PACKAGE,
    "--acp",
    "--stdio",
    "--model",
    "claude-sonnet-4.5",
  ]);
});

test("Copilot ACP executable override still receives ACP stdio arguments", () => {
  const adapter = createCopilotAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-copilot02",
    profileId: "copilot-acp-default",
    cwd: process.cwd(),
    env: {},
    extras: { acp: { executable: "C:\\tools\\copilot.exe" } },
  });
  assert.equal(launch.command, "C:\\tools\\copilot.exe");
  assert.deepEqual(launch.args, ["--acp", "--stdio"]);
});

test("Copilot ACP may reuse local login or require an explicit env key", () => {
  const local = createCopilotAcpAdapter().resolveLaunch({
    sessionId: "ss-copilot03",
    profileId: "copilot-acp-default",
    cwd: process.cwd(),
    env: {},
    extras: { acp: {} },
  });
  assert.equal(local.env.GH_TOKEN, undefined);

  const required = createCopilotAcpAdapter({ resolveEnvValue: () => undefined });
  assert.throws(
    () =>
      required.resolveLaunch({
        sessionId: "ss-copilot04",
        profileId: "copilot-acp-default",
        cwd: process.cwd(),
        env: {},
        extras: { acp: { envKey: "GH_TOKEN" } },
      }),
    /省略 envKey 可复用本机 Copilot 登录/
  );
});

for (const [name, adapter] of [
  ["Codex", createCodexAcpAdapter()],
  ["Claude", createClaudeAcpAdapter()],
  ["Antigravity", createAntigravityAcpAdapter()],
  ["OpenCode", createOpenCodeAcpAdapter()],
  ["Copilot", createCopilotAcpAdapter()],
] as const satisfies ReadonlyArray<readonly [string, ProviderAdapter]>) {
  test(`${name} ACP managed session completes through the offline mock without authenticate`, async () => {
    const cwd = await tempDir(`tent-${name.toLowerCase()}-acp-`);
    const logPath = path.join(cwd, "mock-acp-log.json");
    const events: RuntimeEvent[] = [];
    const session = await adapter.startManagedSession!(
      {
        sessionId: `ss-${name.toLowerCase()}03`,
        profileId: `${name.toLowerCase()}-acp-default`,
        cwd,
        env: {
          MOCK_ACP_LOG: logPath,
          MOCK_ACP_KEEP_ALIVE: "0",
          MOCK_ACP_PROMPT_TEXT: `${name}_ACP_OK`,
        },
        command: process.execPath,
        args: [MOCK_ACP],
        bootstrapPrompt: `test ${name} bootstrap`,
        extras: { acp: { promptTimeoutMs: 5_000, permissionPolicy: "deny" } },
      },
      (event) => events.push(event)
    );

    const managed = session as typeof session & { waitBootstrap(): Promise<void> };
    await managed.waitBootstrap();
    const report = events.find((event) => event.type === "session.prompt_complete");
    assert.ok(report && report.type === "session.prompt_complete");
    assert.equal(report.assistantText, `${name}_ACP_OK`);

    const log = await readJsonWhenComplete<{
      methods: string[];
      prompts: string[];
      authenticateParams: unknown;
    }>(logPath, (value) => value.methods.length >= 3);
    assert.deepEqual(log.methods.slice(0, 3), ["initialize", "session/new", "session/prompt"]);
    assert.equal(log.authenticateParams, null);
    assert.deepEqual(log.prompts, [`test ${name} bootstrap`]);
    await session.stop("shutdown");
  });
}

const RESUME_CAPABLE_MAINSTREAM: ReadonlyArray<
  readonly [string, () => ProviderAdapter]
> = [
  ["OpenCode", createOpenCodeAcpAdapter],
  ["Codex", createCodexAcpAdapter],
  ["Claude", createClaudeAcpAdapter],
  ["Copilot", createCopilotAcpAdapter],
];

test("mainstream ACP loadSession adapters advertise canResume; Antigravity stays false", () => {
  for (const [name, create] of RESUME_CAPABLE_MAINSTREAM) {
    const adapter = create();
    assert.equal(adapter.capabilities().canResume, true, name);
    assert.equal(typeof adapter.resumeManagedSession, "function", name);
  }
  const antigravity: ProviderAdapter = createAntigravityAcpAdapter();
  assert.equal(antigravity.capabilities().canResume, false);
  assert.equal(antigravity.resumeManagedSession, undefined);
});

for (const [name, create] of RESUME_CAPABLE_MAINSTREAM) {
  test(`${name} ACP resumeManagedSession uses session/load and isolates history replay`, async () => {
    const slug = name.toLowerCase();
    const cwd = await tempDir(`tent-${slug}-load-`);
    const logPath = path.join(cwd, "mock-acp-log.json");
    const events: RuntimeEvent[] = [];
    const adapter = create();
    const session = await adapter.resumeManagedSession!(
      {
        sessionId: `ss-${slug}-load`,
        profileId: `${slug}-acp-default`,
        cwd,
        env: {
          MOCK_ACP_LOG: logPath,
          MOCK_ACP_KEEP_ALIVE: "0",
          MOCK_ACP_LOAD_SESSION: "1",
          MOCK_ACP_HISTORY_TEXT: "OLD_HISTORY_MUST_NOT_DELIVER",
          MOCK_ACP_PROMPT_TEXT: "POST_LOAD_ONLY",
        },
        command: process.execPath,
        args: [MOCK_ACP],
        bootstrapPrompt: "resume bootstrap after load",
        extras: { acp: { promptTimeoutMs: 5_000, permissionPolicy: "deny" } },
      },
      { raw: "mock-acp-session-1", providerSessionId: "mock-acp-session-1" },
      (event) => events.push(event)
    );

    const managed = session as typeof session & { waitBootstrap(): Promise<void> };
    await managed.waitBootstrap();

    const complete = events.filter((e) => e.type === "session.prompt_complete");
    assert.equal(complete.length, 1);
    assert.equal(
      (complete[0] as Extract<RuntimeEvent, { type: "session.prompt_complete" }>)
        .assistantText,
      "POST_LOAD_ONLY"
    );
    assert.ok(
      !events.some(
        (e) =>
          e.type === "session.prompt_complete" &&
          "assistantText" in e &&
          String(e.assistantText).includes("OLD_HISTORY")
      )
    );

    const log = await readJsonWhenComplete<{
      methods: string[];
      loads: Array<{ sessionId: string; cwd: string; hasMcpServers: boolean }>;
      prompts: string[];
    }>(logPath, (value) => value.methods.includes("session/prompt"));
    assert.deepEqual(log.methods.slice(0, 3), [
      "initialize",
      "session/load",
      "session/prompt",
    ]);
    assert.ok(!log.methods.includes("session/new"));
    assert.equal(log.loads.length, 1);
    assert.equal(log.loads[0].sessionId, "mock-acp-session-1");
    assert.equal(log.loads[0].cwd, cwd);
    assert.equal(log.loads[0].hasMcpServers, true);
    assert.deepEqual(log.prompts, ["resume bootstrap after load"]);
    await session.stop("shutdown");
  });

  test(`${name} ACP resumeManagedSession fails loud when loadSession unsupported`, async () => {
    const slug = name.toLowerCase();
    const cwd = await tempDir(`tent-${slug}-noload-`);
    const logPath = path.join(cwd, "mock-acp-log.json");
    const adapter = create();
    await assert.rejects(
      () =>
        adapter.resumeManagedSession!(
          {
            sessionId: `ss-${slug}-noload`,
            profileId: `${slug}-acp-default`,
            cwd,
            env: {
              MOCK_ACP_LOG: logPath,
              MOCK_ACP_KEEP_ALIVE: "0",
              // loadSession not advertised
            },
            command: process.execPath,
            args: [MOCK_ACP],
            bootstrapPrompt: "should not prompt",
            extras: { acp: { promptTimeoutMs: 5_000, permissionPolicy: "deny" } },
          },
          { raw: "mock-acp-session-1", providerSessionId: "mock-acp-session-1" },
          () => undefined
        ),
      /loadSession|session\/load/i
    );
    // If the mock wrote a log, resume must never have fallen back to session/new.
    try {
      const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
        methods: string[];
      };
      assert.ok(!log.methods.includes("session/new"));
    } catch {
      // no log file is fine
    }
  });
}
