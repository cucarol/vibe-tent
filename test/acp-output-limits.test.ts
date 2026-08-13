/**
 * ACP resource-boundary regressions (tk-mf6jmc1s).
 *
 * Low-threshold cases exercise the same comparisons as production bounds.
 * The high-fragmentation case intentionally sends more than 65,536 distinct
 * JSON-RPC updates while keeping the assistant report itself small.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AcpClient } from "../src/adapters/acp/client.js";
import {
  ACP_DIAGNOSTIC_EVENT_BYTES,
  DEFAULT_ACP_DIAGNOSTIC_EVENTS,
  DEFAULT_ACP_REQUEST_FRAME_BYTES,
  ACP_OUTPUT_LIMIT_CODE,
  ACP_REQUEST_LIMIT_CODE,
  AcpLimitError,
  BoundedDiagnosticRedactor,
  redactBoundedDiagnosticText,
} from "../src/adapters/acp/limits.js";
import { MAX_ACP_IMAGES_TOTAL_BYTES } from "../src/adapters/acp/image-prompt.js";
import { startManagedAcpSession } from "../src/adapters/acp/managed-session.js";
import type { ProviderAdapter } from "../src/adapters/types.js";
import {
  createAgentRuntime,
  ProcessSupervisor,
  type RuntimeEvent,
} from "../src/runtime/index.js";

const PROVIDER_SESSION_ID = "provider-limit-session";

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

const MOCK_ACP_SOURCE = String.raw`
import readline from "node:readline";

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function update(value) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "${PROVIDER_SESSION_ID}", update: value },
  });
}

function finish(id) {
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

if (process.argv[2] === "diagnostic-burst") {
  const secret = process.env.MOCK_SECRET || "missing-secret";
  const filler = Number(process.env.MOCK_FILLER || "0");
  process.stdout.write("p".repeat(filler) + secret + "ZZ" + "q".repeat(2048));
  setTimeout(() => process.exit(0), 20);
} else if (process.argv[2] === "diagnostic-split") {
  const secret = process.env.MOCK_SECRET || "missing-secret";
  const filler = Number(process.env.MOCK_FILLER || "0");
  const split = Math.max(1, Math.floor(secret.length / 2));
  process.stdout.write("p".repeat(filler) + secret.slice(0, split));
  setTimeout(() => {
    process.stdout.write(secret.slice(split) + "ZZ" + "q".repeat(2048));
    setTimeout(() => process.exit(0), 20);
  }, 20);
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { agentCapabilities: {} } });
      return;
    }
    if (request.method === "session/new") {
      send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "${PROVIDER_SESSION_ID}" } });
      return;
    }
    if (request.method !== "session/prompt") return;

    const mode = process.env.MOCK_MODE || "chunks";
    if (mode === "oversized-frame") {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(Number(process.env.MOCK_SIZE || "2048")) },
      });
      finish(request.id);
      return;
    }
    if (mode === "updates") {
      const count = Number(process.env.MOCK_COUNT || "1");
      for (let i = 0; i < count; i += 1) {
        update({ sessionUpdate: "status", status: "tick" });
      }
      finish(request.id);
      return;
    }
    if (mode === "high-fragments") {
      const count = Number(process.env.MOCK_COUNT || "65537");
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "${PROVIDER_SESSION_ID}",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x" },
          },
        },
      }) + "\n";
      const batchSize = 512;
      for (let i = 0; i < count; i += batchSize) {
        process.stdout.write(line.repeat(Math.min(batchSize, count - i)));
      }
      finish(request.id);
      return;
    }
    if (mode === "control-progress") {
      update({ sessionUpdate: "status", status: "starting" });
      update({ sessionUpdate: "status", status: "starting" });
      update({ sessionUpdate: "status", status: "working" });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      update({ sessionUpdate: "tool_call", toolCallId: "read", title: "read", status: "pending" });
      update({ sessionUpdate: "tool_call", toolCallId: "read", title: "read", status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "read", title: "read", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      finish(request.id);
      return;
    }
    if (mode === "tool-storm") {
      const count = Number(process.env.MOCK_COUNT || "3");
      for (let i = 0; i < count; i += 1) {
        update({ sessionUpdate: "tool_call_update", toolCallId: "read", title: "read", status: "pending" });
      }
      finish(request.id);
      return;
    }
    if (mode === "config-storm") {
      const count = Number(process.env.MOCK_COUNT || "3");
      for (let i = 0; i < count; i += 1) {
        update({
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "thinking", name: "Thinking", type: "boolean", currentValue: true }],
        });
      }
      finish(request.id);
      return;
    }
    if (mode === "rpc-error-boundary") {
      const secret = process.env.MOCK_SECRET || "missing-secret";
      const filler = Number(process.env.MOCK_FILLER || "0");
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: "e".repeat(filler) + secret + "tail",
        },
      });
      return;
    }
    if (mode === "update-diagnostic-split") {
      const secret = process.env.MOCK_SECRET || "missing-secret";
      const filler = Number(process.env.MOCK_FILLER || "0");
      const split = Math.max(1, Math.floor(secret.length / 2));
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "u".repeat(filler) + secret.slice(0, split) },
      });
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: secret.slice(split) + "tail" },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      });
      finish(request.id);
      return;
    }
    if (mode === "tool-diagnostic-boundary") {
      const secret = process.env.MOCK_SECRET || "missing-secret";
      const filler = Number(process.env.MOCK_FILLER || "0");
      update({
        sessionUpdate: "tool_call",
        toolCallId: "boundary-tool",
        title: "v".repeat(filler) + secret + "tail",
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      });
      finish(request.id);
      return;
    }
    if (mode === "segments") {
      const count = Number(process.env.MOCK_COUNT || "1");
      for (let i = 0; i < count; i += 1) {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String(i) },
        });
        update({ sessionUpdate: "status", status: "separator" });
      }
      finish(request.id);
      return;
    }
    if (mode === "final-open-segment") {
      for (const text of ["first", "second"]) {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
        update({ sessionUpdate: "status", status: "separator" });
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "must-not-complete" },
      });
      finish(request.id);
      return;
    }
    if (mode === "multi") {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "intermediate narration" },
      });
      update({ sessionUpdate: "tool_call", toolCallId: "read", title: "read" });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "FINAL " },
      });
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "REPORT" },
      });
      finish(request.id);
      return;
    }
    if (mode === "stderr") {
      const secret = process.env.MOCK_SECRET || "missing-secret";
      const filler = Number(process.env.MOCK_FILLER || "0");
      process.stderr.write("s".repeat(filler) + secret + "ZZ" + "t".repeat(2048));
    } else if (mode === "stderr-split") {
      const secret = process.env.MOCK_SECRET || "missing-secret";
      const filler = Number(process.env.MOCK_FILLER || "0");
      const split = Math.max(1, Math.floor(secret.length / 2));
      process.stderr.write("s".repeat(filler) + secret.slice(0, split));
      setTimeout(() => {
        process.stderr.write(secret.slice(split) + "ZZ" + "t".repeat(2048));
      }, 20);
    }
    const chunks = JSON.parse(process.env.MOCK_CHUNKS || "[\"ok\"]");
    for (const text of chunks) {
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
    }
    finish(request.id);
  });
  process.on("SIGTERM", () => process.exit(0));
}
`;

let mockPathPromise: Promise<string> | undefined;

async function mockPath(): Promise<string> {
  if (!mockPathPromise) {
    mockPathPromise = (async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-limits-fixture-"));
      const file = path.join(dir, "mock-acp-limits.mjs");
      await fs.writeFile(file, MOCK_ACP_SOURCE, "utf8");
      return file;
    })();
  }
  return mockPathPromise;
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

type Limits = NonNullable<ConstructorParameters<typeof AcpClient>[0]["resourceLimits"]>;

async function makeClient(input: {
  sessionId: string;
  events: RuntimeEvent[];
  env?: Record<string, string>;
  limits?: Limits;
  diagnosticSecrets?: string[];
}): Promise<AcpClient> {
  const cwd = await tempDir("tent-acp-limits-cwd-");
  return new AcpClient({
    command: process.execPath,
    args: [await mockPath()],
    cwd,
    env: input.env ?? {},
    diagnosticSecrets: input.diagnosticSecrets,
    sessionId: input.sessionId,
    permissionPolicy: "deny",
    label: "LimitMockACP",
    resourceLimits: input.limits,
    emit: (event) => input.events.push(event),
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function assertLimit(error: unknown, code: string): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code?: string }).code, code);
  assert.match(error.message, new RegExp(`^${code}:`));
  return true;
}

function assertNoSecretFragments(text: string, secret: string): void {
  assert.doesNotMatch(text, new RegExp(secret));
  assert.ok(
    !text.includes(secret.slice(0, Math.min(8, secret.length))),
    "diagnostic must not expose a nontrivial credential prefix"
  );
  assert.ok(
    !text.includes(secret.slice(-Math.min(8, secret.length))),
    "diagnostic must not expose a nontrivial credential suffix"
  );
}

async function assertStopped(client: AcpClient): Promise<void> {
  await waitFor(() => !client.isAlive(), "limited ACP child to stop");
  assert.equal(client.isAlive(), false);
}

test("AcpClient accepts an exact UTF-8 assistant budget across sustained small chunks", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId: "ss-output-exact",
    events,
    env: { MOCK_CHUNKS: JSON.stringify(["汉", "字", "a", "b"]) },
    limits: { assistantReportBytes: 8 },
  });
  try {
    await client.connect();
    const result = await client.sendPrompt("go");
    assert.equal(Buffer.byteLength(result.assistantText, "utf8"), 8);
    assert.equal(result.assistantText, "汉字ab");
    assert.ok(!events.some((event) => event.type === "session.failed"));
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient completes more than 65,536 content fragments exactly with bounded diagnostics", async () => {
  const count = 65_537;
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId: "ss-high-fragments",
    events,
    env: { MOCK_MODE: "high-fragments", MOCK_COUNT: String(count) },
  });
  try {
    await client.connect();
    const result = await client.sendPrompt("go");
    assert.equal(result.assistantText.length, count);
    assert.equal(result.assistantText, "x".repeat(count));
    assert.ok(!events.some((event) => event.type === "session.failed"));
    assert.ok(
      events.filter((event) => event.type === "session.stdout_tail").length <=
        DEFAULT_ACP_DIAGNOSTIC_EVENTS + 1,
      "diagnostic fan-out remains capped plus one aggregate suppression record"
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient rejects one UTF-8 byte over assistant budget with stable ACP_OUTPUT_LIMIT", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId: "ss-output-over",
    events,
    env: { MOCK_CHUNKS: JSON.stringify(["汉", "字", "a", "b", "c"]) },
    limits: { assistantReportBytes: 8 },
  });
  await client.connect();
  await assert.rejects(
    () => client.sendPrompt("go"),
    (error) => assertLimit(error, ACP_OUTPUT_LIMIT_CODE)
  );
  await assertStopped(client);
  const failed = events.filter((event) => event.type === "session.failed");
  assert.equal(failed.length, 1);
  assert.match((failed[0] as Extract<RuntimeEvent, { type: "session.failed" }>).error, /^ACP_OUTPUT_LIMIT:/);
  assert.ok(!events.some((event) => event.type === "session.prompt_complete"));
});

test("managed ACP rejects an oversized stdout JSON-RPC frame before parse and never completes", async () => {
  const sessionId = "ss-frame-over";
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId,
    events,
    env: { MOCK_MODE: "oversized-frame", MOCK_SIZE: "2048" },
    limits: { stdoutFrameBytes: 256 },
  });
  const session = await startManagedAcpSession({
    plan: { sessionId, connectionId: "limit", cwd: process.cwd(), env: {}, bootstrapPrompt: "go" },
    emit: (event) => events.push(event),
    client,
  });
  await session.waitBootstrap();
  await assertStopped(client);
  const failed = events.filter((event) => event.type === "session.failed");
  assert.equal(failed.length, 1);
  assert.match((failed[0] as Extract<RuntimeEvent, { type: "session.failed" }>).error, /^ACP_OUTPUT_LIMIT: stdout JSON-RPC frame .* before parse/);
  assert.ok(!events.some((event) => event.type === "session.prompt_complete"));
});

test("low-count overrides cheaply prove million-small-update and segment exhaustion", async (t) => {
  await t.test("consecutive no-progress session/update count", async () => {
    const events: RuntimeEvent[] = [];
    const client = await makeClient({
      sessionId: "ss-update-count",
      events,
      env: { MOCK_MODE: "updates", MOCK_COUNT: "5" },
      limits: { noProgressUpdates: 3 },
    });
    await client.connect();
    await assert.rejects(
      () => client.sendPrompt("go"),
      (error) => assertLimit(error, ACP_OUTPUT_LIMIT_CODE)
    );
    await assertStopped(client);
    assert.ok(!events.some((event) => event.type === "session.prompt_complete"));
  });

  await t.test("sealed assistant segment count", async () => {
    const events: RuntimeEvent[] = [];
    const client = await makeClient({
      sessionId: "ss-segment-count",
      events,
      env: { MOCK_MODE: "segments", MOCK_COUNT: "3" },
      limits: { assistantSegments: 2 },
    });
    await client.connect();
    await assert.rejects(
      () => client.sendPrompt("go"),
      (error) => assertLimit(error, ACP_OUTPUT_LIMIT_CODE)
    );
    await assertStopped(client);
    assert.ok(!events.some((event) => event.type === "session.prompt_complete"));
  });
});

test("observable ACP control progress resets the consecutive no-progress bound", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId: "ss-control-progress",
    events,
    env: { MOCK_MODE: "control-progress" },
    limits: { noProgressUpdates: 1 },
  });
  try {
    await client.connect();
    const result = await client.sendPrompt("go");
    assert.equal(result.assistantText, "ok");
    assert.ok(!events.some((event) => event.type === "session.failed"));
  } finally {
    await client.stop("shutdown");
  }
});

test("repeated identical tool and config control states hit the no-progress bound", async (t) => {
  for (const mode of ["tool-storm", "config-storm"]) {
    await t.test(mode, async () => {
      const events: RuntimeEvent[] = [];
      const client = await makeClient({
        sessionId: `ss-${mode}`,
        events,
        env: { MOCK_MODE: mode, MOCK_COUNT: "3" },
        limits: { noProgressUpdates: 1, diagnosticEvents: 1 },
      });
      await client.connect();
      await assert.rejects(
        () => client.sendPrompt("go"),
        (error) => assertLimit(error, ACP_OUTPUT_LIMIT_CODE)
      );
      await assertStopped(client);
      assert.ok(
        events.filter((event) => event.type === "session.stdout_tail").length <= 2
      );
    });
  }
});

test("final open segment cannot bypass segment limit into prompt_complete", async () => {
  const sessionId = "ss-final-open-limit";
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId,
    events,
    env: { MOCK_MODE: "final-open-segment" },
    limits: { assistantSegments: 2 },
  });
  const session = await startManagedAcpSession({
    plan: {
      sessionId,
      connectionId: "limit",
      cwd: process.cwd(),
      env: {},
      bootstrapPrompt: "go",
    },
    emit: (event) => events.push(event),
    client,
  });
  await session.waitBootstrap();
  assert.equal(client.isAlive(), false, "managed settle must join the limit stop");
  assert.equal(
    events.filter((event) => event.type === "session.failed").length,
    1
  );
  assert.ok(!events.some((event) => event.type === "session.prompt_complete"));
});

test("normal multi-segment response emits only the final managed report", async () => {
  const sessionId = "ss-normal-multi";
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId,
    events,
    env: { MOCK_MODE: "multi" },
  });
  const session = await startManagedAcpSession({
    plan: { sessionId, connectionId: "limit", cwd: process.cwd(), env: {}, bootstrapPrompt: "go" },
    emit: (event) => events.push(event),
    client,
  });
  await session.waitBootstrap();
  const complete = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "session.prompt_complete" }> =>
      event.type === "session.prompt_complete"
  );
  assert.equal(complete.length, 1);
  assert.equal(complete[0]!.assistantText, "FINAL REPORT");
  assert.doesNotMatch(complete[0]!.assistantText, /intermediate/);
  assert.ok(client.isAlive());
  await session.stop("shutdown");
});

test("outbound bootstrap text accepts exact bytes and rejects one byte over fail-loud", async () => {
  const exactEvents: RuntimeEvent[] = [];
  const exact = await makeClient({
    sessionId: "ss-bootstrap-exact",
    events: exactEvents,
    limits: { bootstrapTextBytes: 8 },
  });
  try {
    await exact.connect();
    const result = await exact.sendPrompt("汉字ab");
    assert.equal(result.assistantText, "ok");
  } finally {
    await exact.stop("shutdown");
  }

  const overEvents: RuntimeEvent[] = [];
  const over = await makeClient({
    sessionId: "ss-bootstrap-over",
    events: overEvents,
    limits: { bootstrapTextBytes: 8 },
  });
  await over.connect();
  await assert.rejects(
    () => over.sendPrompt("汉字abc"),
    (error) => assertLimit(error, ACP_REQUEST_LIMIT_CODE)
  );
  await assertStopped(over);
  assert.ok(!overEvents.some((event) => event.type === "session.prompt_complete"));
});

function promptFrameBytes(text: string): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: PROVIDER_SESSION_ID,
        prompt: [{ type: "text", text }],
      },
    }),
    "utf8"
  );
}

test("outbound JSON-RPC request frame accepts its ceiling and rejects one byte over", async () => {
  const prompt = "frame-boundary-" + "x".repeat(512);
  const ceiling = promptFrameBytes(prompt);

  const exactEvents: RuntimeEvent[] = [];
  const exact = await makeClient({
    sessionId: "ss-request-exact",
    events: exactEvents,
    limits: { requestFrameBytes: ceiling },
  });
  try {
    await exact.connect();
    assert.equal((await exact.sendPrompt(prompt)).assistantText, "ok");
  } finally {
    await exact.stop("shutdown");
  }

  const overEvents: RuntimeEvent[] = [];
  const over = await makeClient({
    sessionId: "ss-request-over",
    events: overEvents,
    limits: { requestFrameBytes: ceiling - 1 },
  });
  await over.connect();
  await assert.rejects(
    () => over.sendPrompt(prompt),
    (error) => assertLimit(error, ACP_REQUEST_LIMIT_CODE)
  );
  await assertStopped(over);
  assert.ok(!overEvents.some((event) => event.type === "session.prompt_complete"));
});

test("default outbound frame ceiling retains the 25 MiB image/base64 contract", () => {
  const base64Chars = 4 * Math.ceil(MAX_ACP_IMAGES_TOTAL_BYTES / 3);
  assert.ok(
    DEFAULT_ACP_REQUEST_FRAME_BYTES > base64Chars + 1024,
    "40 MiB frame ceiling must leave JSON metadata headroom above image base64"
  );
});

test("ACP diagnostic chunk is <=16 KiB and redacts a secret near the truncation boundary", async () => {
  const secret = "near-boundary-secret-7d09b4c2";
  const filler = ACP_DIAGNOSTIC_EVENT_BYTES - 5;
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId: "ss-diagnostic-boundary",
    events,
    env: {
      MOCK_MODE: "stderr",
      MOCK_SECRET: secret,
      MOCK_FILLER: String(filler),
    },
    diagnosticSecrets: [secret],
  });
  try {
    await client.connect();
    await client.sendPrompt("go");
    await waitFor(
      () => events.some((event) => event.type === "session.stdout_tail" && /truncated/.test(event.text)),
      "bounded ACP stderr diagnostic"
    );
    const tails = events.filter(
      (event): event is Extract<RuntimeEvent, { type: "session.stdout_tail" }> =>
        event.type === "session.stdout_tail"
    );
    assert.ok(tails.length > 0);
    for (const event of tails) {
      assert.ok(Buffer.byteLength(event.text, "utf8") <= ACP_DIAGNOSTIC_EVENT_BYTES);
      assertNoSecretFragments(event.text, secret);
    }
    assert.ok(tails.some((event) => event.text.includes("[redacted]")));
    assert.ok(Buffer.byteLength(client.lastStderrTail, "utf8") <= 4000);
    assertNoSecretFragments(client.lastStderrTail, secret);
  } finally {
    await client.stop("shutdown");
  }
});

test("redaction-aware bound hides a credential crossing the one-shot RPC cut", () => {
  const secret = "RPC_SECRET_TOKEN_0123456789";
  const raw = "r".repeat(ACP_DIAGNOSTIC_EVENT_BYTES - 5) + secret + "tail";
  const bounded = redactBoundedDiagnosticText(
    raw,
    [secret],
    ACP_DIAGNOSTIC_EVENT_BYTES
  );
  assert.ok(Buffer.byteLength(bounded, "utf8") <= ACP_DIAGNOSTIC_EVENT_BYTES);
  assertNoSecretFragments(bounded, secret);
  assert.match(bounded, /\[redacted\]/);
});

test("AcpClient RPC error path redacts a credential crossing its diagnostic cut", async () => {
  const secret = "RPC_PATH_SECRET_TOKEN_abcdef";
  const client = await makeClient({
    sessionId: "ss-rpc-error-boundary",
    events: [],
    env: {
      MOCK_MODE: "rpc-error-boundary",
      MOCK_SECRET: secret,
      MOCK_FILLER: String(ACP_DIAGNOSTIC_EVENT_BYTES - 5),
    },
    diagnosticSecrets: [secret],
  });
  try {
    await client.connect();
    await assert.rejects(() => client.sendPrompt("go"), (error) => {
      assert.ok(error instanceof Error);
      assertNoSecretFragments(error.message, secret);
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
  } finally {
    await client.stop("shutdown");
  }
});

test("AcpClient tool diagnostic redacts a credential crossing its title cut", async () => {
  const secret = "TOOL_TITLE_SECRET_TOKEN_abcdef";
  const events: RuntimeEvent[] = [];
  const client = await makeClient({
    sessionId: "ss-tool-diagnostic-boundary",
    events,
    env: {
      MOCK_MODE: "tool-diagnostic-boundary",
      MOCK_SECRET: secret,
      MOCK_FILLER: String(8192 - 5),
    },
    diagnosticSecrets: [secret],
  });
  try {
    await client.connect();
    await client.sendPrompt("go");
    const diagnostics = events.filter(
      (event): event is Extract<RuntimeEvent, { type: "session.stdout_tail" }> =>
        event.type === "session.stdout_tail"
    );
    assert.ok(diagnostics.length > 0);
    for (const event of diagnostics) {
      assertNoSecretFragments(event.text, secret);
    }
    assert.ok(diagnostics.some((event) => event.text.includes("[redacted]")));
  } finally {
    await client.stop("shutdown");
  }
});

test("raw-buffer redactor preserves UTF-8 while a Unicode secret crosses chunks", () => {
  const secret = "密钥令牌_αβγ_012345";
  const redactor = new BoundedDiagnosticRedactor([secret], 256);
  const raw = Buffer.from(`prefix:${secret}:suffix`, "utf8");
  const split = Buffer.byteLength("prefix:密", "utf8") - 1;
  const output =
    redactor.pushBuffer(raw.subarray(0, split)) +
    redactor.pushBuffer(raw.subarray(split)) +
    redactor.flush();
  assertNoSecretFragments(output, secret);
  assert.match(output, /\[redacted\]/);
  assert.doesNotMatch(output, /�/);
  assert.equal(Buffer.from(output, "utf8").toString("utf8"), output);
});

test("bounded redactor never resumes at a credential suffix after discarded input", () => {
  const secret = "DISCARDED_SECRET_TOKEN_0123456789";
  const split = 20;
  const redactor = new BoundedDiagnosticRedactor([secret], 64);
  const first = redactor.pushBuffer(
    Buffer.from("z".repeat(200) + secret.slice(0, split), "utf8")
  );
  const second = redactor.pushBuffer(
    Buffer.from(secret.slice(split) + ":later diagnostic", "utf8")
  );
  const tail = redactor.flush();
  assert.ok(Buffer.byteLength(first, "utf8") <= 64);
  assertNoSecretFragments(first + second + tail, secret);
  assert.equal(second, "");
  assert.equal(tail, "");
});

test("self-overlapping credentials keep redactor carry bounded", () => {
  const redactor = new BoundedDiagnosticRedactor(["aaaaaaaa"], 64);
  let output = "";
  for (let index = 0; index < 1_000; index += 1) {
    output += redactor.pushText("a".repeat(64));
  }
  output += redactor.flush();
  assert.ok(Buffer.byteLength(output, "utf8") <= 64 * 1_001);
  assert.doesNotMatch(output, /aaaaaaaa/);
  assert.match(output, /\[redacted\]/);
});

test("overlapping credential occurrences cannot leak across diagnostic events", () => {
  const redactor = new BoundedDiagnosticRedactor(["abab"], 64);
  const output =
    redactor.pushText("ababab") +
    redactor.pushText("abX") +
    redactor.flush();
  assert.doesNotMatch(output, /abab/);
  assert.match(output, /\[redacted\]/);
});

test("diagnostic joins remain byte-bounded below the truncation marker size", () => {
  const redactor = new BoundedDiagnosticRedactor(["secret-value"], 4);
  const output = redactor.pushText("secret-value") + redactor.flush();
  assert.ok(Buffer.byteLength(output, "utf8") <= 4);
  assert.doesNotMatch(output, /secr/);
});

test("AcpClient and ProcessSupervisor redact a secret split across adjacent child chunks", async (t) => {
  const secret = "SPLIT_SECRET_TOKEN_89abcdef";
  const filler = ACP_DIAGNOSTIC_EVENT_BYTES - 5;

  await t.test("AcpClient stderr events and tail", async () => {
    const events: RuntimeEvent[] = [];
    const client = await makeClient({
      sessionId: "ss-diagnostic-split",
      events,
      env: {
        MOCK_MODE: "stderr-split",
        MOCK_SECRET: secret,
        MOCK_FILLER: String(filler),
      },
      diagnosticSecrets: [secret],
    });
    try {
      await client.connect();
      await client.sendPrompt("go");
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "session.stdout_tail" &&
              event.text.includes("[redacted]")
          ),
        "split ACP stderr redaction"
      );
      const combined = events
        .filter(
          (event): event is Extract<RuntimeEvent, { type: "session.stdout_tail" }> =>
            event.type === "session.stdout_tail"
        )
        .map((event) => event.text)
        .join("");
      assertNoSecretFragments(combined, secret);
      assertNoSecretFragments(client.lastStderrTail, secret);
    } finally {
      await client.stop("shutdown");
    }
  });

  await t.test("AcpClient formatDiagnostic session/update events", async () => {
    const events: RuntimeEvent[] = [];
    const client = await makeClient({
      sessionId: "ss-update-diagnostic-split",
      events,
      env: {
        MOCK_MODE: "update-diagnostic-split",
        MOCK_SECRET: secret,
        MOCK_FILLER: String(filler),
      },
      diagnosticSecrets: [secret],
    });
    try {
      await client.connect();
      assert.equal((await client.sendPrompt("go")).assistantText, "ok");
      const combined = events
        .filter(
          (event): event is Extract<RuntimeEvent, { type: "session.stdout_tail" }> =>
            event.type === "session.stdout_tail"
        )
        .map((event) => event.text)
        .join("");
      assertNoSecretFragments(combined, secret);
      assert.match(combined, /\[redacted\]/);
    } finally {
      await client.stop("shutdown");
    }
  });

  await t.test("ProcessSupervisor callback and ring", async () => {
    const events: string[] = [];
    const supervisor = new ProcessSupervisor({
      stdoutRingBytes: 4000,
      gracefulMs: 100,
      onStdout: (_sessionId, text) => events.push(text),
    });
    const sessionId = "ss-supervisor-split";
    await supervisor.start(sessionId, {
      command: process.execPath,
      args: [await mockPath(), "diagnostic-split"],
      cwd: await tempDir("tent-supervisor-split-"),
      env: {
        MOCK_SECRET: secret,
        MOCK_FILLER: String(filler),
      },
      diagnosticSecrets: [secret],
    });
    await waitFor(() => !supervisor.isAlive(sessionId), "split diagnostic child exit");
    const combined = events.join("");
    assertNoSecretFragments(combined, secret);
    assertNoSecretFragments(supervisor.getStdoutTail(sessionId), secret);
    assert.match(combined, /\[redacted\]/);
    await supervisor.stop(sessionId);
  });
});

test("ProcessSupervisor bounds and redacts raw child diagnostics before event/ring copies", async () => {
  const secret = "supervisor-boundary-secret-f127a3";
  const filler = ACP_DIAGNOSTIC_EVENT_BYTES - Buffer.byteLength(secret, "utf8") - 32;
  const events: string[] = [];
  const supervisor = new ProcessSupervisor({
    stdoutRingBytes: 4000,
    gracefulMs: 100,
    onStdout: (_sessionId, text) => events.push(text),
  });
  const sessionId = "ss-supervisor-boundary";
  const cwd = await tempDir("tent-supervisor-limit-");
  await supervisor.start(sessionId, {
    command: process.execPath,
    args: [await mockPath(), "diagnostic-burst"],
    cwd,
    env: {
      MOCK_SECRET: secret,
      MOCK_FILLER: String(filler),
    },
    diagnosticSecrets: [secret],
  });
  await waitFor(() => !supervisor.isAlive(sessionId), "diagnostic child exit");
  assert.ok(events.length > 0);
  for (const text of events) {
    assert.ok(Buffer.byteLength(text, "utf8") <= ACP_DIAGNOSTIC_EVENT_BYTES);
    assert.doesNotMatch(text, new RegExp(secret));
  }
  const tail = supervisor.getStdoutTail(sessionId);
  assert.ok(Buffer.byteLength(tail, "utf8") <= 4000);
  assert.doesNotMatch(tail, new RegExp(secret));
  await supervisor.stop(sessionId);
});

test("AgentRuntime re-bounds oversized managed diagnostics at its event boundary", async () => {
  const dataDir = await tempDir("tent-runtime-limit-");
  const huge = "r".repeat(ACP_DIAGNOSTIC_EVENT_BYTES * 2);
  let alive = true;
  const adapter: ProviderAdapter = {
    id: "runtime-limit-test",
    displayNameKey: "runtime-limit-test",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed-only test adapter");
    },
    startManagedSession: async (plan, emit) => {
      emit({ type: "session.stdout_tail", sessionId: plan.sessionId, text: huge });
      return {
        sessionId: plan.sessionId,
        pid: process.pid,
        isAlive: () => alive,
        stop: async () => { alive = false; },
      };
    },
    mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [{ connectionId: "runtime-limit-connection", provider: "test", adapterId: adapter.id }],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const sessionId = "ss-runtime-boundary";
  try {
    await startConnection(runtime, {
      sessionId,
      connectionId: "runtime-limit-connection",
      cwd: await tempDir("tent-runtime-limit-cwd-"),
      bootstrapPrompt: "",
    });
    const tail = events.find(
      (event): event is Extract<RuntimeEvent, { type: "session.stdout_tail" }> =>
        event.type === "session.stdout_tail"
    );
    assert.ok(tail);
    assert.ok(Buffer.byteLength(tail.text, "utf8") <= ACP_DIAGNOSTIC_EVENT_BYTES);
    assert.match(tail.text, /truncated/);
  } finally {
    await runtime.shutdown();
  }
});

test("AgentRuntime preserves limit code and does not duplicate an already-emitted startup failure", async () => {
  const dataDir = await tempDir("tent-runtime-limit-startup-");
  const adapter: ProviderAdapter = {
    id: "runtime-limit-startup-test",
    displayNameKey: "runtime-limit-startup-test",
    capabilities: () => ({
      canSpawn: true,
      canResume: false,
      canStopGraceful: true,
      needsTty: false,
      supportsWorktreeCwd: true,
      authModel: "none",
      observeLevel: "structured",
    }),
    resolveLaunch: () => {
      throw new Error("managed-only test adapter");
    },
    startManagedSession: async (plan, emit) => {
      const error = new AcpLimitError(
        ACP_OUTPUT_LIMIT_CODE,
        "startup stdout frame exceeds test ceiling"
      ) as AcpLimitError & { terminalAlreadyEmitted: true };
      error.terminalAlreadyEmitted = true;
      emit({
        type: "session.failed",
        sessionId: plan.sessionId,
        error: error.message,
      });
      throw error;
    },
    mapExit: (code) => ({ type: "session.exited", sessionId: "", exitCode: code }),
  };
  const runtime = createAgentRuntime({
    dataDir,
    adapters: [adapter],
    connections: [{ connectionId: "runtime-limit-startup-connection", provider: "test", adapterId: adapter.id }],
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribeAll((event) => events.push(event));
  const sessionId = "ss-runtime-limit-startup";
  try {
    await assert.rejects(
      () =>
        startConnection(runtime, {
          sessionId,
          connectionId: "runtime-limit-startup-connection",
          cwd: process.cwd(),
        }),
      (error) => assertLimit(error, ACP_OUTPUT_LIMIT_CODE)
    );
    assert.equal(
      events.filter(
        (event) => event.type === "session.failed" && event.sessionId === sessionId
      ).length,
      1
    );
    const record = await runtime.registry.read(sessionId);
    assert.equal(record?.state, "failed");
    assert.match(record?.lastError ?? "", /^ACP_OUTPUT_LIMIT:/);
  } finally {
    await runtime.shutdown();
  }
});
