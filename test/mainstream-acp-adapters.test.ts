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
  createOpenCodeAcpAdapter,
  defaultOpenCodeExecutable,
} from "../src/adapters/opencode-acp/index.js";
import {
  COPILOT_ACP_NPX_PACKAGE,
  createCopilotAcpAdapter,
} from "../src/adapters/copilot-acp/index.js";
import {
  PI_ACP_NPX_PACKAGE,
  createPiAcpAdapter,
} from "../src/adapters/pi-acp/index.js";
import type { ProviderAdapter } from "../src/adapters/types.js";
import { defaultNpxLaunch } from "../src/adapters/acp/index.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ACP = path.join(__dirname, "fixtures", "mock-acp-server.mjs");

function exactNpx(packageSpec: string, trailing: string[] = []) {
  const launch = defaultNpxLaunch();
  return { command: launch.command, args: [...launch.argsPrefix, "--yes", packageSpec, ...trailing] };
}

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
    connectionId: "codex-acp-default",
    cwd: process.cwd(),
    env: {},
    ...exactNpx(CODEX_ACP_NPX_PACKAGE),
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
  assert.equal(launch.env.TENT_ROLE_NAME, undefined);
  assert.doesNotMatch(JSON.stringify(adapter), /secret-for-test/);
});

test("Codex ACP fails loud when an explicitly configured key is missing", () => {
  const adapter = createCodexAcpAdapter({ resolveEnvValue: () => undefined });
  assert.throws(
    () =>
      adapter.resolveLaunch({
        sessionId: "ss-codex02",
        connectionId: "codex-acp-default",
        cwd: process.cwd(),
        env: {},
        ...exactNpx(CODEX_ACP_NPX_PACKAGE),
        extras: { acp: { envKey: "OPENAI_API_KEY" } },
      }),
    /未配置环境变量 OPENAI_API_KEY/
  );
});

test("Claude ACP resolves the official npx bridge and leaves auth to the Agent by default", () => {
  assert.equal(CLAUDE_ACP_NPX_PACKAGE, "@agentclientprotocol/claude-agent-acp@0.62.0");
  const adapter = createClaudeAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-claude01",
    connectionId: "claude-acp-default",
    cwd: process.cwd(),
    env: {},
    ...exactNpx(CLAUDE_ACP_NPX_PACKAGE),
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
    connectionId: "claude-acp-default",
    cwd: process.cwd(),
    ...exactNpx(CLAUDE_ACP_NPX_PACKAGE),
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

test("OpenCode ACP uses its native `opencode acp` entrypoint", () => {
  const adapter = createOpenCodeAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-opencode01",
    connectionId: "opencode-acp-default",
    cwd: process.cwd(),
    env: {},
    command: defaultOpenCodeExecutable(),
    args: ["acp"],
    extras: { acp: {} },
  });
  assert.equal(launch.command, defaultOpenCodeExecutable());
  assert.deepEqual(launch.args, ["acp"]);
});

test("OpenCode ACP honors explicit command/args without appending `acp`", () => {
  const adapter = createOpenCodeAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-opencode02",
    connectionId: "opencode-acp-default",
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
    connectionId: "copilot-acp-default",
    cwd: process.cwd(),
    env: {},
    ...exactNpx(COPILOT_ACP_NPX_PACKAGE, ["--acp", "--stdio", "--model", "claude-sonnet-4.5"]),
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

test("Copilot ACP executes an explicit command and complete argv exactly", () => {
  const adapter = createCopilotAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-copilot02",
    connectionId: "copilot-acp-default",
    cwd: process.cwd(),
    env: {},
    command: "C:\\tools\\copilot.exe",
    args: ["--custom", "stdio"],
    extras: { acp: {} },
  });
  assert.equal(launch.command, "C:\\tools\\copilot.exe");
  assert.deepEqual(launch.args, ["--custom", "stdio"]);
});

test("Copilot ACP may reuse local login or require an explicit env key", () => {
  const local = createCopilotAcpAdapter().resolveLaunch({
    sessionId: "ss-copilot03",
    connectionId: "copilot-acp-default",
    cwd: process.cwd(),
    env: {},
    ...exactNpx(COPILOT_ACP_NPX_PACKAGE, ["--acp", "--stdio"]),
    extras: { acp: {} },
  });
  assert.equal(local.env.GH_TOKEN, undefined);

  const required = createCopilotAcpAdapter({ resolveEnvValue: () => undefined });
  assert.throws(
    () =>
      required.resolveLaunch({
        sessionId: "ss-copilot04",
        connectionId: "copilot-acp-default",
        cwd: process.cwd(),
        env: {},
        ...exactNpx(COPILOT_ACP_NPX_PACKAGE, ["--acp", "--stdio"]),
        extras: { acp: { envKey: "GH_TOKEN" } },
      }),
    /省略 envKey 可复用本机 Copilot 登录/
  );
});

test("Pi ACP resolves the third-party pi-acp npx bridge", () => {
  const adapter = createPiAcpAdapter();
  const launch = adapter.resolveLaunch({
    sessionId: "ss-pi01",
    connectionId: "pi-acp-default",
    cwd: process.cwd(),
    env: {},
    ...exactNpx(PI_ACP_NPX_PACKAGE),
    extras: { acp: {} },
  });
  const npx = defaultNpxLaunch();
  assert.equal(launch.command, npx.command);
  assert.deepEqual(launch.args, [...npx.argsPrefix, "--yes", PI_ACP_NPX_PACKAGE]);
  assert.equal(adapter.capabilities().canResume, true);
});

test("Pi ACP may reuse local pi login or require an explicit env key", () => {
  const local = createPiAcpAdapter().resolveLaunch({
    sessionId: "ss-pi02",
    connectionId: "pi-acp-default",
    cwd: process.cwd(),
    env: {},
    ...exactNpx(PI_ACP_NPX_PACKAGE),
    extras: { acp: {} },
  });
  assert.equal(local.env.OPENAI_API_KEY, undefined);

  const required = createPiAcpAdapter({ resolveEnvValue: () => undefined });
  assert.throws(
    () =>
      required.resolveLaunch({
        sessionId: "ss-pi03",
        connectionId: "pi-acp-default",
        cwd: process.cwd(),
        env: {},
        ...exactNpx(PI_ACP_NPX_PACKAGE),
        extras: { acp: { envKey: "OPENAI_API_KEY" } },
      }),
    /省略 envKey 可复用本机 pi 登录/
  );
});

for (const [name, adapter] of [
  ["Codex", createCodexAcpAdapter()],
  ["Claude", createClaudeAcpAdapter()],
  ["OpenCode", createOpenCodeAcpAdapter()],
  ["Copilot", createCopilotAcpAdapter()],
  ["Pi", createPiAcpAdapter()],
] as const satisfies ReadonlyArray<readonly [string, ProviderAdapter]>) {
  test(`${name} ACP managed session completes through the offline mock without authenticate`, async () => {
    const cwd = await tempDir(`tent-${name.toLowerCase()}-acp-`);
    const logPath = path.join(cwd, "mock-acp-log.json");
    const events: RuntimeEvent[] = [];
    const session = await adapter.startManagedSession!(
      {
        sessionId: `ss-${name.toLowerCase()}03`,
        connectionId: `${name.toLowerCase()}-acp-default`,
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

/** Adapters that restore via session/load (history may stream; quarantined). */
const LOAD_RESUME_MAINSTREAM: ReadonlyArray<
  readonly [string, () => ProviderAdapter]
> = [
  ["OpenCode", createOpenCodeAcpAdapter],
  ["Codex", createCodexAcpAdapter],
  ["Copilot", createCopilotAcpAdapter],
  ["Pi", createPiAcpAdapter],
];

/** All product adapters with canResume (load or session/resume transport). */
const RESUME_CAPABLE_MAINSTREAM: ReadonlyArray<
  readonly [string, () => ProviderAdapter]
> = [
  ...LOAD_RESUME_MAINSTREAM,
  ["Claude", createClaudeAcpAdapter],
];

test("mainstream ACP adapters advertise provider-native resume", () => {
  for (const [name, create] of RESUME_CAPABLE_MAINSTREAM) {
    const adapter = create();
    assert.equal(adapter.capabilities().canResume, true, name);
    assert.equal(typeof adapter.resumeManagedSession, "function", name);
  }
});

for (const [name, create] of LOAD_RESUME_MAINSTREAM) {
  test(`${name} ACP resumeManagedSession uses session/load and isolates history replay`, async () => {
    const slug = name.toLowerCase();
    const cwd = await tempDir(`tent-${slug}-load-`);
    const logPath = path.join(cwd, "mock-acp-log.json");
    const events: RuntimeEvent[] = [];
    const adapter = create();
    const session = await adapter.resumeManagedSession!(
      {
        sessionId: `ss-${slug}-load`,
        connectionId: `${slug}-acp-default`,
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
    assert.ok(!log.methods.includes("session/resume"));
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
            connectionId: `${slug}-acp-default`,
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

test("Claude ACP resumeManagedSession uses session/resume (not load/new) without history replay", async () => {
  const cwd = await tempDir("tent-claude-resume-");
  const logPath = path.join(cwd, "mock-acp-log.json");
  const events: RuntimeEvent[] = [];
  const adapter = createClaudeAcpAdapter();
  const session = await adapter.resumeManagedSession!(
    {
      sessionId: "ss-claude-resume",
      connectionId: "claude-acp-default",
      cwd,
      env: {
        MOCK_ACP_LOG: logPath,
        MOCK_ACP_KEEP_ALIVE: "0",
        // Advertise resume only — Claude managed path must not require loadSession.
        MOCK_ACP_RESUME_SESSION: "1",
        MOCK_ACP_HISTORY_TEXT: "OLD_HISTORY_MUST_NOT_DELIVER",
        MOCK_ACP_PROMPT_TEXT: "POST_RESUME_ONLY",
      },
      command: process.execPath,
      args: [MOCK_ACP],
      bootstrapPrompt: "resume bootstrap after session/resume",
      extras: { acp: { promptTimeoutMs: 5_000, permissionPolicy: "deny" } },
    },
    { raw: "mock-acp-session-1", providerSessionId: "mock-acp-session-1" },
    (event) => events.push(event)
  );

  assert.equal(session.providerSessionId, "mock-acp-session-1");
  const managed = session as typeof session & { waitBootstrap(): Promise<void> };
  await managed.waitBootstrap();

  const complete = events.filter((e) => e.type === "session.prompt_complete");
  assert.equal(complete.length, 1);
  assert.equal(
    (complete[0] as Extract<RuntimeEvent, { type: "session.prompt_complete" }>)
      .assistantText,
    "POST_RESUME_ONLY"
  );
  assert.ok(
    !events.some(
      (e) =>
        e.type === "session.prompt_complete" &&
        "assistantText" in e &&
        String(e.assistantText).includes("OLD_HISTORY")
    )
  );
  // No history contamination into diagnostics either during resume.
  assert.ok(
    !events.some(
      (e) =>
        e.type === "session.stdout_tail" &&
        "text" in e &&
        String(e.text).includes("OLD_HISTORY")
    )
  );

  const log = await readJsonWhenComplete<{
    methods: string[];
    loads: unknown[];
    resumes: Array<{ sessionId: string; cwd: string; hasMcpServers: boolean }>;
    prompts: string[];
  }>(logPath, (value) => value.methods.includes("session/prompt"));
  assert.deepEqual(log.methods.slice(0, 3), [
    "initialize",
    "session/resume",
    "session/prompt",
  ]);
  assert.ok(!log.methods.includes("session/new"));
  assert.ok(!log.methods.includes("session/load"));
  assert.equal(log.loads?.length ?? 0, 0);
  assert.equal(log.resumes.length, 1);
  assert.equal(log.resumes[0].sessionId, "mock-acp-session-1");
  assert.equal(log.resumes[0].cwd, cwd);
  assert.equal(log.resumes[0].hasMcpServers, true);
  assert.deepEqual(log.prompts, ["resume bootstrap after session/resume"]);
  await session.stop("shutdown");
});

test("Claude ACP resumeManagedSession fails loud when sessionCapabilities.resume unsupported", async () => {
  const cwd = await tempDir("tent-claude-noresume-");
  const logPath = path.join(cwd, "mock-acp-log.json");
  const adapter = createClaudeAcpAdapter();
  await assert.rejects(
    () =>
      adapter.resumeManagedSession!(
        {
          sessionId: "ss-claude-noresume",
          connectionId: "claude-acp-default",
          cwd,
          env: {
            MOCK_ACP_LOG: logPath,
            MOCK_ACP_KEEP_ALIVE: "0",
            // loadSession alone must not satisfy Claude resume transport
            MOCK_ACP_LOAD_SESSION: "1",
          },
          command: process.execPath,
          args: [MOCK_ACP],
          bootstrapPrompt: "should not prompt",
          extras: { acp: { promptTimeoutMs: 5_000, permissionPolicy: "deny" } },
        },
        { raw: "mock-acp-session-1", providerSessionId: "mock-acp-session-1" },
        () => undefined
      ),
    /sessionCapabilities\.resume|session\/resume/i
  );
  try {
    const log = JSON.parse(await fs.readFile(logPath, "utf8")) as {
      methods: string[];
    };
    assert.ok(!log.methods.includes("session/new"));
    assert.ok(!log.methods.includes("session/load"));
  } catch {
    // no log file is fine
  }
});
