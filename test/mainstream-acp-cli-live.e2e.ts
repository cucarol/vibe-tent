/**
 * Explicit paid/network foreground roundtrip probes.
 *
 * ACP session/new writes nonce A, the provider's native non-interactive CLI
 * resumes the exact provider session and writes nonce B, then ACP session/load
 * must recover both. Not part of npm test.
 *
 * Run one or more providers:
 *   TENT_LIVE_PROVIDERS=codex,claude npm run test:foreground-e2e
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createAgentRuntime,
  type RuntimeEvent,
  type AgentConnectionConfig,
} from "../src/runtime/index.js";
import {
  DEFAULT_GROK_BASE_URL_ENV_KEY,
  DEFAULT_GROK_ENV_KEY,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";
import { CODEX_ACP_ADAPTER_ID } from "../src/adapters/codex-acp/types.js";
import { CLAUDE_ACP_ADAPTER_ID } from "../src/adapters/claude-acp/types.js";
import { OPENCODE_ACP_ADAPTER_ID } from "../src/adapters/opencode-acp/index.js";
import { COPILOT_ACP_ADAPTER_ID } from "../src/adapters/copilot-acp/types.js";
import { materializeAgentConnectionLaunch } from "../src/service/connections.js";

const selected = new Set(
  (process.env.TENT_LIVE_PROVIDERS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

type ProviderName = "grok" | "codex" | "claude" | "opencode" | "copilot";

type ProviderCase = {
  name: ProviderName;
  connection: AgentConnectionConfig;
  nativeResume: (
    sessionId: string,
    prompt: string,
    cwd: string,
    dataDir: string
  ) => Promise<string>;
};

async function startConnection(
  runtime: ReturnType<typeof createAgentRuntime>,
  request: Parameters<ReturnType<typeof createAgentRuntime>["startSession"]>[0] & { connectionId: string }
) {
  const { connectionId, ...start } = request;
  const workspace = start.workspace ?? start.workspaceLane?.workspace ?? start.runtimeWorkspace?.cwd ?? start.cwd;
  if (!workspace) throw new Error("live start requires a workspace");
  const currentTaskId = start.currentTaskId ?? `tk-${start.sessionId.replace(/[^a-z0-9]/gi, "")}`;
  await runtime.reserveSession({ sessionId: start.sessionId, connectionId, currentTaskId, workspace, workspaceLane: start.workspaceLane, runtimeWorkspace: start.runtimeWorkspace, cwd: start.cwd });
  return runtime.startSession({ ...start, currentTaskId, workspace });
}

const home = os.homedir();
const npmBin = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm");
const nativePaths = {
  grok: path.join(home, ".grok", "bin", "grok.exe"),
  codex: path.join(home, "AppData", "Local", "OpenAI", "Codex", "bin", "codex.exe"),
  claude: path.join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  opencode: path.join(npmBin, "node_modules", "opencode-ai", "bin", "opencode.exe"),
  copilot: path.join(npmBin, "node_modules", "@github", "copilot", "npm-loader.js"),
};
const codexModel = process.env.TENT_LIVE_CODEX_MODEL || "gpt-5.4";

function connection(
  connectionId: string,
  adapterId: string,
  overrides: Partial<AgentConnectionConfig> = {}
): AgentConnectionConfig {
  return materializeAgentConnectionLaunch({
    connectionId,
    provider: connectionId,
    adapterId,
    permissionPolicy: "deny",
    promptTimeoutMs: 300_000,
    permissionTimeoutMs: 30_000,
    ...overrides,
  });
}

async function runNative(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd,
      env: { ...process.env, ...env },
      timeout: 300_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(`${stdout || ""}\n${stderr || ""}`.trim());
    });
    // Some CLIs read piped stdin in addition to positional prompt arguments.
    // EOF makes this probe unambiguously non-interactive.
    child.stdin?.end();
  });
}

const providers: ProviderCase[] = [
  {
    name: "grok",
    connection: {
      ...connection("foreground-grok", GROK_ACP_ADAPTER_ID, {
        model: process.env.CPA_GROK_MODEL || "grok-4.5",
        envKey: DEFAULT_GROK_ENV_KEY,
        endpoint: process.env[DEFAULT_GROK_BASE_URL_ENV_KEY],
      }),
    },
    nativeResume: (sessionId, prompt, cwd, dataDir) =>
      runNative(nativePaths.grok, ["--resume", sessionId, "--single", prompt], cwd, {
        TENT_SERVICE_DATA_DIR: dataDir,
      }),
  },
  {
    name: "codex",
    connection: {
      ...connection("foreground-codex", CODEX_ACP_ADAPTER_ID, { model: codexModel }),
    },
    nativeResume: async (sessionId, prompt, cwd, dataDir) => {
      const outputFile = path.join(cwd, "codex-last-message.txt");
      await runNative(
        nativePaths.codex,
        [
          "exec",
          "resume",
          "--model",
          codexModel,
          "--skip-git-repo-check",
          "--output-last-message",
          outputFile,
          sessionId,
          prompt,
        ],
        cwd,
        { TENT_SERVICE_DATA_DIR: dataDir }
      );
      return fs.readFile(outputFile, "utf8");
    },
  },
  {
    name: "claude",
    connection: connection("foreground-claude", CLAUDE_ACP_ADAPTER_ID),
    nativeResume: (sessionId, prompt, cwd, dataDir) =>
      runNative(
        nativePaths.claude,
        ["--resume", sessionId, "--print", "--permission-mode", "dontAsk", prompt],
        cwd,
        { TENT_SERVICE_DATA_DIR: dataDir }
      ),
  },
  {
    name: "opencode",
    connection: connection("foreground-opencode", OPENCODE_ACP_ADAPTER_ID, {
      command: nativePaths.opencode,
      args: ["acp"],
    }),
    nativeResume: (sessionId, prompt, cwd, dataDir) =>
      runNative(nativePaths.opencode, ["run", "--session", sessionId, prompt], cwd, {
        TENT_SERVICE_DATA_DIR: dataDir,
      }),
  },
  {
    name: "copilot",
    connection: connection("foreground-copilot", COPILOT_ACP_ADAPTER_ID),
    nativeResume: (sessionId, prompt, cwd, dataDir) =>
      runNative(
        process.execPath,
        [
          nativePaths.copilot,
          `--resume=${sessionId}`,
          "--prompt",
          prompt,
          "--allow-all-tools",
          "--no-custom-instructions",
          "--disable-builtin-mcps",
          "--silent",
        ],
        cwd,
        { TENT_SERVICE_DATA_DIR: dataDir }
      ),
  },
];

test("foreground provider fixtures materialize canonical command and args", () => {
  for (const provider of providers) {
    assert.ok(provider.connection.command, `${provider.name} command`);
    assert.ok(Array.isArray(provider.connection.args), `${provider.name} args`);
  }
});

async function waitForComplete(
  events: RuntimeEvent[],
  sessionId: string,
  offset: number,
  timeoutMs = 300_000
): Promise<Extract<RuntimeEvent, { type: "session.prompt_complete" }>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = events
      .slice(offset)
      .find(
        (event): event is Extract<RuntimeEvent, { type: "session.prompt_complete" }> =>
          event.type === "session.prompt_complete" && event.sessionId === sessionId
      );
    if (found) return found;
    const failed = events
      .slice(offset)
      .find((event) => event.type === "session.failed" && event.sessionId === sessionId);
    if (failed && failed.type === "session.failed") throw new Error(failed.error);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${sessionId}`);
}

for (const provider of providers) {
  test(
    `real ${provider.name}: ACP -> native CLI -> ACP preserves one session`,
    { skip: !selected.has(provider.name), timeout: 15 * 60_000 },
    async () => {
      await fs.access(
        provider.name === "codex"
          ? nativePaths.codex
          : provider.name === "claude"
            ? nativePaths.claude
            : provider.name === "opencode"
              ? nativePaths.opencode
              : provider.name === "copilot"
                ? nativePaths.copilot
                : nativePaths.grok
      );
      if (provider.name === "grok") {
        assert.ok(process.env.CPA_GROK_API_KEY, "CPA_GROK_API_KEY is required");
        assert.ok(process.env.CPA_GROK_BASE_URL, "CPA_GROK_BASE_URL is required");
      }

      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `tent-${provider.name}-fg-data-`));
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `tent-${provider.name}-fg-cwd-`));
      const sessionId = `ss-${provider.name.slice(0, 6)}fg1`;
      const nonceA = `A_${provider.name}_${Date.now().toString(36).toUpperCase()}`;
      const nonceB = `B_${provider.name}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      let runtime = createAgentRuntime({ dataDir, connections: [provider.connection] });
      let events: RuntimeEvent[] = [];
      runtime.subscribeAll((event) => events.push(event));

      try {
        await startConnection(runtime, {
          sessionId,
          connectionId: provider.connection.connectionId,
          cwd,
          bootstrapPrompt:
            `Remember ${nonceA}. Reply only FIRST_READY ${nonceA}. Do not use tools.`,
        });
        const first = await waitForComplete(events, sessionId, 0);
        assert.match(first.assistantText, new RegExp(nonceA));
        const record = await runtime.registry.read(sessionId);
        const providerSessionId = record?.resumeToken;
        assert.ok(providerSessionId, "ACP must persist a provider session id");
        await runtime.stopSession(sessionId, "user");
        await runtime.shutdown();

        const native = await provider.nativeResume(
          providerSessionId,
          `Recall ${nonceA}, remember ${nonceB}, and reply only CLI_READY ${nonceA} ${nonceB}. Do not use tools.`,
          cwd,
          dataDir
        );
        assert.match(native, new RegExp(nonceA));
        assert.match(native, new RegExp(nonceB));

        runtime = createAgentRuntime({ dataDir, connections: [provider.connection] });
        events = [];
        runtime.subscribeAll((event) => events.push(event));
        await runtime.resumeSession({
          sessionId,
          cwd,
          bootstrapPrompt:
            `Reply only ACP_READY followed by ${nonceA} and the other nonce learned in the native CLI turn. Do not use tools.`,
        });
        const final = await waitForComplete(events, sessionId, 0);
        assert.match(final.assistantText, /ACP_READY/i);
        assert.match(final.assistantText, new RegExp(nonceA));
        assert.match(final.assistantText, new RegExp(nonceB));
        await runtime.stopSession(sessionId, "user");
      } finally {
        await runtime.shutdown().catch(() => undefined);
        await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  );
}
