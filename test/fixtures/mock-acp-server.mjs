#!/usr/bin/env node
/**
 * Offline mock Grok ACP stdio server for Tent tests.
 * Speaks initialize / authenticate / session/new / session/load / session/resume /
 * session/prompt + session/update.
 * NEVER contacts api.x.ai or any network. Refuse if asked to.
 *
 * Env:
 *   MOCK_ACP_PROMPT_TEXT — final assistant message text (default "MOCK_ACP_OK")
 *   MOCK_ACP_INTERMEDIATE_TEXT — optional pre-tool assistant narration; when set,
 *     stream this agent_message_chunk before tool_call, then PROMPT_TEXT after tools
 *     (regression: Delivery.summary must keep only the final segment)
 *   MOCK_ACP_FOLLOWUP_TEXT — text for prompts containing "## User Answer", "## User Input", or "## Review Feedback" (default MOCK_ACP_PROMPT_TEXT)
 *   MOCK_ACP_PROMPT_DELAY_MS — delay before completing bootstrap session/prompt (default 0)
 *   MOCK_ACP_FOLLOWUP_DELAY_MS — delay before completing U2A follow-up prompts (default 0)
 *   MOCK_ACP_FOLLOWUP_HANG — "1" never answer User Input / User Answer / Review Feedback (hang until SIGTERM)
 *   MOCK_ACP_REQUEST_PERMISSION — "1" to send session/request_permission before prompt result
 *   MOCK_ACP_PERMISSION_COUNT — concurrent permission requests to send (default 1)
 *   MOCK_ACP_KEEP_ALIVE — "1" stay alive after prompt until SIGTERM (default 1)
 *   MOCK_ACP_FAIL_AUTH — "1" reject authenticate
 *   MOCK_ACP_FAIL_NEW — "1" reject session/new with safe + secret-shaped data
 *   MOCK_ACP_LOG — optional path to write JSON log of requests
 *   MOCK_ACP_LOAD_SESSION — "1" advertise agentCapabilities.loadSession (default 0)
 *   MOCK_ACP_RESUME_SESSION — "1" advertise agentCapabilities.sessionCapabilities.resume={} (default 0)
 *   MOCK_ACP_HISTORY_TEXT — history agent_message_chunk text on session/load (default "HISTORY_REPLAY")
 *   MOCK_ACP_LATE_HISTORY_MS — emit one replay chunk after load result (bridge hardening test)
 *   MOCK_ACP_FAIL_LOAD — "1" reject session/load
 *   MOCK_ACP_FAIL_RESUME — "1" reject session/resume
 *   MOCK_ACP_KNOWN_SESSION_ID — only this sessionId succeeds on load/resume (default mock-acp-session-1)
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
/** Pre-tool assistant narration (empty = single final message only, legacy path). */
const intermediateText = process.env.MOCK_ACP_INTERMEDIATE_TEXT || "";
const followupText =
  process.env.MOCK_ACP_FOLLOWUP_TEXT || process.env.MOCK_ACP_PROMPT_TEXT || "MOCK_ACP_OK";
const promptDelayMs = Math.max(
  0,
  Number(process.env.MOCK_ACP_PROMPT_DELAY_MS || "0") || 0
);
const followupDelayMs = Math.max(
  0,
  Number(process.env.MOCK_ACP_FOLLOWUP_DELAY_MS || "0") || 0
);
/** Hang U2A follow-ups forever (until SIGTERM) — shutdown must not wait full promptTimeout. */
const followupHang = process.env.MOCK_ACP_FOLLOWUP_HANG === "1";
const requestPermission = process.env.MOCK_ACP_REQUEST_PERMISSION === "1";
const permissionCount = Math.max(
  1,
  Number(process.env.MOCK_ACP_PERMISSION_COUNT || "1") || 1
);
const keepAlive = process.env.MOCK_ACP_KEEP_ALIVE !== "0";
const failAuth = process.env.MOCK_ACP_FAIL_AUTH === "1";
const failNew = process.env.MOCK_ACP_FAIL_NEW === "1";
/** empty | error | interrupt — special prompt outcomes for managed-delivery tests */
const promptMode = process.env.MOCK_ACP_PROMPT_MODE || "ok";
const stopReasonEnv = process.env.MOCK_ACP_STOP_REASON || "end_turn";
const logPath = process.env.MOCK_ACP_LOG || "";
/** After session/new, die with this code (spontaneous exit; no pending prompt required). */
const dieAfterSessionMs = Number(process.env.MOCK_ACP_DIE_AFTER_SESSION_MS || "0");
const dieExitCode = Number(process.env.MOCK_ACP_DIE_EXIT_CODE || "1");
/** Advertise loadSession capability (default off — matches schema default false). */
const loadSessionCapable = process.env.MOCK_ACP_LOAD_SESSION === "1";
/**
 * Advertise sessionCapabilities.resume={} (default off).
 * Matches ACP: omitted/null = unsupported; `{}` = session/resume supported.
 */
const resumeSessionCapable = process.env.MOCK_ACP_RESUME_SESSION === "1";
/**
 * Advertise agentCapabilities.promptCapabilities.image (default off).
 * Only explicit "1" opts in — matches ACP schema default false.
 */
const promptImageCapable = process.env.MOCK_ACP_PROMPT_IMAGE === "1";
const historyText = process.env.MOCK_ACP_HISTORY_TEXT || "HISTORY_REPLAY";
const lateHistoryMs = Number(process.env.MOCK_ACP_LATE_HISTORY_MS || "0");
const failLoad = process.env.MOCK_ACP_FAIL_LOAD === "1";
const failResume = process.env.MOCK_ACP_FAIL_RESUME === "1";
const knownSessionId =
  process.env.MOCK_ACP_KNOWN_SESSION_ID || "mock-acp-session-1";
/**
 * After session/prompt JSON-RPC result is written, optionally schedule a late
 * worktree mutation (write marker file). Used to prove Delivery is sealed only
 * after the process can no longer mutate — not on a sleep. If the bridge is
 * killed first, the timer dies with the process and the marker never appears.
 */
const postResponseTailMs = Math.max(
  0,
  Number(process.env.MOCK_ACP_POST_RESPONSE_TAIL_MS || "0") || 0
);
const postResponseTailPath = process.env.MOCK_ACP_POST_RESPONSE_TAIL_PATH || "";

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
  /** Structured prompt block summary (types + image meta; never full base64 dumps). */
  promptBlocks: [],
  news: [],
  loads: [],
  /** session/resume params (no history replay by contract). */
  resumes: [],
  permissionOutcomes: [],
  loadSessionCapable,
  resumeSessionCapable,
  promptImageCapable,
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

/** Redacted session/new|load params for mock logs (no secret values). */
function summarizeSessionStartParams(params) {
  const mcp = Array.isArray(params?.mcpServers) ? params.mcpServers : null;
  const skillMeta = params?._meta?.tent?.skills;
  return {
    hasMcpServers: Array.isArray(mcp),
    mcpServersLen: Array.isArray(mcp) ? mcp.length : null,
    mcpServerNames: Array.isArray(mcp)
      ? mcp.map((s) => (s && typeof s.name === "string" ? s.name : null))
      : null,
    mcpTransports: Array.isArray(mcp)
      ? mcp.map((s) => {
          if (!s || typeof s !== "object") return null;
          if (typeof s.command === "string") return "stdio";
          if (s.type === "http" || typeof s.url === "string") return "http";
          return "unknown";
        })
      : null,
    skillNames: Array.isArray(skillMeta)
      ? skillMeta.map((s) => (s && typeof s.name === "string" ? s.name : null))
      : null,
  };
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

/** Schedule a post-response tail write; process death cancels it with the event loop. */
function schedulePostResponseTail() {
  if (postResponseTailMs <= 0 || !postResponseTailPath) return;
  setTimeout(() => {
    try {
      fs.writeFileSync(
        postResponseTailPath,
        `POST_RESPONSE_TAIL ${new Date().toISOString()}\n`,
        "utf8"
      );
      log.postResponseTailWritten = true;
      flushLog();
    } catch {
      // ignore
    }
  }, postResponseTailMs);
}

let nextServerId = 9000;
const pendingPermission = new Map();
/** When multi-segment intermediate mode is active, final text after permission settle. */
const pendingFinalMessageByPromptId = new Map();

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
    const agentCapabilities = {};
    // Schema default loadSession=false; only advertise when MOCK_ACP_LOAD_SESSION=1.
    if (loadSessionCapable) agentCapabilities.loadSession = true;
    // sessionCapabilities.resume: omit when off; `{}` when MOCK_ACP_RESUME_SESSION=1.
    if (resumeSessionCapable) {
      agentCapabilities.sessionCapabilities = { resume: {} };
    }
    // Schema default promptCapabilities.image=false; only advertise when MOCK_ACP_PROMPT_IMAGE=1.
    if (promptImageCapable) {
      agentCapabilities.promptCapabilities = { image: true };
    }
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
        agentCapabilities,
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
    const params = msg.params ?? {};
    // Never log secret values from mcpServers env/headers — names + counts only.
    log.news.push(summarizeSessionStartParams(params));
    if (failNew) {
      process.stderr.write("mock bridge session initialization failed\n");
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: {
            reason: "mock provider unavailable",
            token: "must-not-leak",
          },
        },
      });
      flushLog();
      return;
    }
    if (!Array.isArray(params.mcpServers)) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32602,
          message: "mock session/new requires mcpServers array",
        },
      });
      flushLog();
      return;
    }
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
      ...summarizeSessionStartParams(params),
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

  if (msg.method === "session/resume") {
    const params = msg.params ?? {};
    log.resumes.push({
      ...summarizeSessionStartParams(params),
      sessionId: params.sessionId ?? null,
      cwd: params.cwd ?? null,
      hasMcpServers: Array.isArray(params.mcpServers),
      mcpServersLen: Array.isArray(params.mcpServers)
        ? params.mcpServers.length
        : null,
    });

    if (!resumeSessionCapable) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32601,
          message:
            "mock: method not found session/resume (sessionCapabilities.resume false)",
        },
      });
      flushLog();
      return;
    }

    if (failResume) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: {
            details: "mock session/resume SDK failure detail",
            errorKind: "mock_resume_failed",
            token: "must-not-leak-resume",
          },
        },
      });
      flushLog();
      return;
    }

    // session/resume requires sessionId + cwd; mcpServers always sent by Tent.
    if (!params.sessionId || !params.cwd || !Array.isArray(params.mcpServers)) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32602,
          message: "mock session/resume requires sessionId, cwd, mcpServers",
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
          message: `mock session/resume unknown sessionId: ${params.sessionId}`,
        },
      });
      flushLog();
      return;
    }

    // Contract: no history replay (unlike session/load). Do not emit historyText.
    write({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    flushLog();
    return;
  }

  if (msg.method === "session/prompt") {
    const promptArr = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
    const textParts = promptArr
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
      .join("");
    // Log full prompt for test assertions. Keep head+tail when very large so the
    // trailing ## User Prompt (after stable skill sections) is never dropped.
    const PROMPT_LOG_CAP = 24_000;
    const PROMPT_LOG_EDGE = 10_000;
    log.prompts.push(
      textParts.length <= PROMPT_LOG_CAP
        ? textParts
        : `${textParts.slice(0, PROMPT_LOG_EDGE)}\n...[truncated ${textParts.length} chars]...\n${textParts.slice(-PROMPT_LOG_EDGE)}`
    );
    // Structured blocks: types + image mime/size only (never full base64 payloads).
    log.promptBlocks.push(
      promptArr.map((p) => {
        if (!p || typeof p !== "object") return { type: null };
        if (p.type === "image") {
          const dataLen =
            typeof p.data === "string" ? p.data.length : 0;
          return {
            type: "image",
            mimeType: typeof p.mimeType === "string" ? p.mimeType : null,
            dataChars: dataLen,
            hasUri: typeof p.uri === "string" && p.uri.length > 0,
          };
        }
        if (p.type === "text") {
          return {
            type: "text",
            textChars: typeof p.text === "string" ? p.text.length : 0,
          };
        }
        return { type: typeof p.type === "string" ? p.type : null };
      })
    );
    // U2A follow-ups: UserAsk "## User Answer"; sendInput "## User Input";
    // reject-resume review "## Review Feedback". All use FOLLOWUP_TEXT.
    const isUserFollowUp =
      textParts.includes("## User Answer") ||
      textParts.includes("## User Input") ||
      textParts.includes("## Review Feedback");
    // Follow-up continuation uses a distinct report so delivery is exercised
    // even when the bootstrap prompt was empty / non-delivering.
    const activePromptText = isUserFollowUp ? followupText : promptText;

    const finishPrompt = () => {
      if (promptMode === "error" && !isUserFollowUp) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "mock ACP prompt failed" },
        });
        flushLog();
        if (!keepAlive) setTimeout(() => process.exit(0), 50);
        return;
      }

      if (promptMode === "interrupt" && !isUserFollowUp) {
        // Never answer the bootstrap prompt — hang until SIGTERM.
        // Follow-up User Answer / User Input prompts still complete (managed continue).
        flushLog();
        return;
      }

      // Realistic multi-burst turn:
      // thought → optional intermediate assistant update → tool → final assistant reply.
      // Delivery.summary must use only the last non-empty agent_message segment.
      notifyUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      });
      const modeForThis = isUserFollowUp ? "ok" : promptMode;
      const hasIntermediate =
        !isUserFollowUp &&
        typeof intermediateText === "string" &&
        intermediateText.length > 0;
      if (modeForThis !== "empty" && hasIntermediate) {
        notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: intermediateText },
        });
      } else if (modeForThis !== "empty" && !hasIntermediate) {
        // Legacy single-message path: final text before tools (still one segment).
        notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: activePromptText },
        });
      }
      notifyUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "read_file",
        status: "pending",
      });

      if (requestPermission && !isUserFollowUp) {
        if (modeForThis !== "empty" && hasIntermediate) {
          pendingFinalMessageByPromptId.set(msg.id, activePromptText);
        }
        for (let i = 0; i < permissionCount; i += 1) {
          const permId = nextServerId++;
          const suffix = permissionCount > 1 ? `_${i + 1}` : "";
          write({
            jsonrpc: "2.0",
            id: permId,
            method: "session/request_permission",
            params: {
              toolCall: {
                toolCallId: `tc-1${suffix}`,
                title: `read_file${suffix}`,
              },
              options: [
                { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
                { optionId: "allow_always", kind: "allow_always", name: "Always" },
                { optionId: "reject", kind: "reject_once", name: "Reject" },
              ],
            },
          });
          pendingPermission.set(permId, msg.id);
        }
        flushLog();
        return;
      }

      notifyUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
      });
      // After tools: final user-facing report (multi-segment path only).
      if (modeForThis !== "empty" && hasIntermediate) {
        notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: activePromptText },
        });
      }
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: stopReasonEnv },
      });
      // Visible Delivery trigger (prompt result) is already on the wire; any
      // further tool/write must not be allowed to race a published Delivery.
      schedulePostResponseTail();
      flushLog();
      if (!keepAlive) {
        setTimeout(() => process.exit(0), 50);
      }
    };

    // Hang U2A follow-ups until SIGTERM (service shutdown interrupt test).
    // Log the prompt first so tests can assert inject was attempted.
    if (isUserFollowUp && followupHang) {
      flushLog();
      return;
    }

    // Bootstrap delay keeps task running so ask/sendInput can park first.
    // Follow-up delay is opt-in (default 0) so prompt_complete can race markDelivered
    // (managed inject pin must keep pending rows non-cancelable in that window).
    if (!isUserFollowUp && promptDelayMs > 0) {
      setTimeout(finishPrompt, promptDelayMs);
      return;
    }
    if (isUserFollowUp && followupDelayMs > 0) {
      setTimeout(finishPrompt, followupDelayMs);
      return;
    }
    finishPrompt();
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
    if ([...pendingPermission.values()].includes(promptId)) {
      flushLog();
      return;
    }
    const finalAfterTools = pendingFinalMessageByPromptId.get(promptId);
    pendingFinalMessageByPromptId.delete(promptId);
    if (typeof finalAfterTools === "string" && finalAfterTools.length > 0) {
      notifyUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: finalAfterTools },
      });
    }
    write({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn" },
    });
    schedulePostResponseTail();
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
