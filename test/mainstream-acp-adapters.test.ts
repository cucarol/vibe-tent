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
import type { ProviderAdapter } from "../src/adapters/types.js";
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

  assert.equal(launch.command, process.platform === "win32" ? "npx.cmd" : "npx");
  assert.deepEqual(launch.args, ["--yes", CODEX_ACP_NPX_PACKAGE]);
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

  assert.equal(launch.command, process.platform === "win32" ? "npx.cmd" : "npx");
  assert.deepEqual(launch.args, ["--yes", CLAUDE_ACP_NPX_PACKAGE]);
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

for (const [name, adapter] of [
  ["Codex", createCodexAcpAdapter()],
  ["Claude", createClaudeAcpAdapter()],
  ["Antigravity", createAntigravityAcpAdapter()],
  ["OpenCode", createOpenCodeAcpAdapter()],
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
