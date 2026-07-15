#!/usr/bin/env node
/**
 * Offline mock Grok ACP stdio server for Tent tests.
 * Speaks initialize / authenticate / session/new / session/load / session/prompt + session/update.
 * NEVER contacts api.x.ai or any network. Refuse if asked to.
 *
 * Env:
 *   MOCK_ACP_PROMPT_TEXT — text chunk to stream (default "MOCK_ACP_OK")
 *   MOCK_ACP_REQUEST_PERMISSION — "1" to send session/request_permission before prompt result
 *   MOCK_ACP_KEEP_ALIVE — "1" stay alive after prompt until SIGTERM (default 1)
 *   MOCK_ACP_FAIL_AUTH — "1" reject authenticate
 *   MOCK_ACP_LOG — optional path to write JSON log of requests
 *   MOCK_ACP_LOAD_SESSION — "1" advertise agentCapabilities.loadSession (default 0)
 *   MOCK_ACP_HISTORY_TEXT — history agent_message_chunk text on session/load (default "HISTORY_REPLAY")
 *   MOCK_ACP_LATE_HISTORY_MS — emit one replay chunk after load result (bridge hardening test)
 *   MOCK_ACP_FAIL_LOAD — "1" reject session/load
 *   MOCK_ACP_KNOWN_SESSION_ID — only this sessionId succeeds on load (default mock-acp-session-1)
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

// Hard guard: no network modules used; refuse known paid host.
const FORBIDDEN_HOST = "api.x.ai";
for (const arg of process.argv) {
  if (String(arg).includes(FORBIDDEN_HOST)) {
    process.stderr.write(`mock-acp-server refused forbidden host in argv: ${FORBIDDEN_HOST}\n`);
    process.exit(3);
  }
}

const promptText = process.env.MOCK_ACP_PROMPT_TEXT || "MOCK_ACP_OK";
const requestPermission = process.env.MOCK_ACP_REQUEST_PERMISSION === "1";
const keepAlive = process.env.MOCK_ACP_KEEP_ALIVE !== "0";
const failAuth = process.env.MOCK_ACP_FAIL_AUTH === "1";
/** empty | error | interrupt — special prompt outcomes for managed-delivery tests */
const promptMode = process.env.MOCK_ACP_PROMPT_MODE || "ok";
const stopReasonEnv = process.env.MOCK_ACP_STOP_REASON || "end_turn";
const logPath = process.env.MOCK_ACP_LOG || "";
/** After session/new, die with this code (spontaneous exit; no pending prompt required). */
const dieAfterSessionMs = Number(process.env.MOCK_ACP_DIE_AFTER_SESSION_MS || "0");
const dieExitCode = Number(process.env.MOCK_ACP_DIE_EXIT_CODE || "1");
/** Advertise loadSession capability (default off — matches schema default false). */
const loadSessionCapable = process.env.MOCK_ACP_LOAD_SESSION === "1";
const historyText = process.env.MOCK_ACP_HISTORY_TEXT || "HISTORY_REPLAY";
const lateHistoryMs = Number(process.env.MOCK_ACP_LATE_HISTORY_MS || "0");
const failLoad = process.env.MOCK_ACP_FAIL_LOAD === "1";
const knownSessionId =
  process.env.MOCK_ACP_KNOWN_SESSION_ID || "mock-acp-session-1";

const log = {
  argv: process.argv.slice(1),
  modelFlag: (() => {
    const i = process.argv.indexOf("--model");
    return i >= 0 ? process.argv[i + 1] : null;
  })(),
  hasStdio: process.argv.includes("stdio"),
  methods: [],
  authenticateParams: null,
  prompts: [],
  loads: [],
  permissionOutcomes: [],
  loadSessionCapable,
  envKeysPresent: {
    CPA_GROK_API_KEY: Boolean(process.env.CPA_GROK_API_KEY),
    XAI_API_KEY: Boolean(process.env.XAI_API_KEY),
    CPA_GROK_BASE_URL: Boolean(process.env.CPA_GROK_BASE_URL),
    XAI_API_BASE_URL: Boolean(process.env.XAI_API_BASE_URL),
    OPENAI_BASE_URL: Boolean(process.env.OPENAI_BASE_URL),
  },
  xaiApiBaseUrlFlag: (() => {
    const i = process.argv.indexOf("--xai-api-base-url");
    return i >= 0 ? process.argv[i + 1] : null;
  })(),
  // Never log secret values
  contactedApiXai: false,
};

function flushLog() {
  if (!logPath) return;
  try {
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n", "utf8");
  } catch {
    // ignore
  }
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notifyUpdate(update) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update },
  });
}

let nextServerId = 9000;
const pendingPermission = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method) log.methods.push(msg.method);

  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
        // Schema default loadSession=false; only advertise when MOCK_ACP_LOAD_SESSION=1.
        agentCapabilities: loadSessionCapable ? { loadSession: true } : {},
      },
    });
    return;
  }

  if (msg.method === "authenticate") {
    log.authenticateParams = msg.params ?? null;
    if (failAuth) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "mock auth failed" },
      });
      return;
    }
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/new") {
    const sessionId = knownSessionId;
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: { sessionId },
    });
    // Spontaneous death after live session exists — even with no pending prompt/RPC.
    if (Number.isFinite(dieAfterSessionMs) && dieAfterSessionMs > 0) {
      setTimeout(() => {
        flushLog();
        process.exit(Number.isFinite(dieExitCode) ? dieExitCode : 1);
      }, dieAfterSessionMs);
    }
    return;
  }

  if (msg.method === "session/load") {
    const params = msg.params ?? {};
    log.loads.push({
      sessionId: params.sessionId ?? null,
      cwd: params.cwd ?? null,
      hasMcpServers: Array.isArray(params.mcpServers),
      mcpServersLen: Array.isArray(params.mcpServers) ? params.mcpServers.length : null,
    });

    if (!loadSessionCapable) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32601,
          message: "mock: method not found session/load (loadSession capability false)",
        },
      });
      flushLog();
      return;
    }

    if (failLoad) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "mock session/load failed" },
      });
      flushLog();
      return;
    }

    if (!params.sessionId || !params.cwd || !Array.isArray(params.mcpServers)) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32602,
          message: "mock session/load requires sessionId, cwd, mcpServers",
        },
      });
      flushLog();
      return;
    }

    if (params.sessionId !== knownSessionId) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32000,
          message: `mock session/load unknown sessionId: ${params.sessionId}`,
        },
      });
      flushLog();
      return;
    }

    // Protocol: stream full history via notifications before load result.
    notifyUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "history-thinking..." },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: historyText },
    });
    notifyUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "_CHUNK2" },
    });

    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    if (Number.isFinite(lateHistoryMs) && lateHistoryMs > 0) {
      setTimeout(() => {
        notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${historyText}_LATE` },
        });
        flushLog();
      }, lateHistoryMs);
    }
    flushLog();
    return;
  }

  if (msg.method === "session/prompt") {
    const textParts = (msg.params?.prompt || [])
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
      .join("");
    // Log full prompt (tests assert user prompt entered ACP); cap huge dumps.
    log.prompts.push(textParts.slice(0, 8000));

    if (promptMode === "error") {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "mock ACP prompt failed" },
      });
      flushLog();
      if (!keepAlive) setTimeout(() => process.exit(0), 50);
      return;
    }

    if (promptMode === "interrupt") {
      // Never answer the prompt — hang until SIGTERM so client sees interrupted.
      flushLog();
      return;
    }

    // Stream thought + optional message + tool call updates.
    notifyUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    });
    if (promptMode !== "empty") {
      notifyUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: promptText },
      });
    }
    notifyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "read_file",
      status: "pending",
    });

    if (requestPermission) {
      const permId = nextServerId++;
      write({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "tc-1", title: "read_file" },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "allow_always", kind: "allow_always", name: "Always" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
        },
      });
      pendingPermission.set(permId, msg.id);
      flushLog();
      return;
    }

    notifyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
    });
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: stopReasonEnv },
    });
    flushLog();
    if (!keepAlive) {
      setTimeout(() => process.exit(0), 50);
    }
    return;
  }

  // Permission response from client
  if (msg.id !== undefined && pendingPermission.has(msg.id)) {
    const promptId = pendingPermission.get(msg.id);
    pendingPermission.delete(msg.id);
    const outcome = msg.result?.outcome;
    log.permissionOutcomes.push(outcome || msg.result || msg.error);
    notifyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: outcome?.outcome === "selected" ? "completed" : "cancelled",
    });
    write({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn" },
    });
    flushLog();
    if (!keepAlive) {
      setTimeout(() => process.exit(0), 50);
    }
    return;
  }

  if (msg.method && msg.id !== undefined) {
    write({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `mock: method not found ${msg.method}` },
    });
  }
});

function shutdown() {
  flushLog();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Stay open for stdin.
flushLog();
