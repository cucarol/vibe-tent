import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AcpClient } from "../src/adapters/acp/client.js";
import {
  createAcpSessionConfigSnapshot,
  parseAcpSessionConfigSnapshot,
} from "../src/adapters/acp/types.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { createServiceClient } from "../src/service/client.js";
import { startLocalTentService } from "../src/service/service.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const INITIAL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "small",
    options: [
      { value: "small", name: "Small" },
      { value: "large", name: "Large" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: "safe",
    options: [
      {
        group: "safe-modes",
        name: "Safe modes",
        options: [{ value: "safe", name: "Safe" }],
      },
      {
        group: "active-modes",
        name: "Active modes",
        options: [{ value: "agent", name: "Agent" }],
      },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    type: "boolean",
    currentValue: true,
  },
  { id: "future", name: "Future", type: "future", currentValue: "x" },
];

const UPDATED_OPTIONS = [
  {
    id: "thinking",
    name: "Thinking",
    type: "boolean",
    currentValue: false,
  },
];

const MOCK_SOURCE = String.raw`
import readline from "node:readline";
const initial = ${JSON.stringify(INITIAL_OPTIONS)};
const updated = ${JSON.stringify(UPDATED_OPTIONS)};
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") {
    const booleanCapability = request.params?.clientCapabilities?.session?.configOptions?.boolean;
    if (!booleanCapability || typeof booleanCapability !== "object") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "boolean config capability missing" } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true },
      },
      authMethods: [{ id: "oauth" }, { id: "api-key" }],
    } });
    return;
  }
  if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "provider-config", configOptions: initial } });
    return;
  }
  if (request.method === "session/load" || request.method === "session/resume") {
    send({ jsonrpc: "2.0", id: request.id, result: { configOptions: initial } });
    return;
  }
  if (request.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "provider-config",
      update: { sessionUpdate: "config_option_update", configOptions: updated },
    } });
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "provider-config",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    } });
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;

let mockFilePromise: Promise<string> | undefined;

async function mockFile(): Promise<string> {
  mockFilePromise ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-config-"));
    const file = path.join(dir, "mock.mjs");
    await fs.writeFile(file, MOCK_SOURCE, "utf8");
    return file;
  })();
  return mockFilePromise;
}

async function makeClient(sessionId: string, events: RuntimeEvent[]) {
  return new AcpClient({
    command: process.execPath,
    args: [await mockFile()],
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-config-cwd-")),
    env: {},
    sessionId,
    permissionPolicy: "deny",
    emit: (event) => events.push(event),
  });
}

test("ACP Session config preserves flat, grouped, boolean and ignores unknown option types", () => {
  const snapshot = createAcpSessionConfigSnapshot({
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: true },
    },
    authMethods: [{ id: "oauth" }],
    configOptions: INITIAL_OPTIONS,
  });
  assert.deepEqual(snapshot.capabilities, {
    loadSession: true,
    resumeSession: true,
    promptImage: true,
  });
  assert.deepEqual(snapshot.authMethodIds, ["oauth"]);
  assert.equal(snapshot.configOptions.length, 3);
  assert.equal(snapshot.configOptions[0]?.type, "select");
  if (snapshot.configOptions[0]?.type === "select") {
    assert.equal(snapshot.configOptions[0].options.kind, "flat");
  }
  assert.equal(snapshot.configOptions[1]?.type, "select");
  if (snapshot.configOptions[1]?.type === "select") {
    assert.equal(snapshot.configOptions[1].options.kind, "grouped");
    if (snapshot.configOptions[1].options.kind === "grouped") {
      assert.deepEqual(
        snapshot.configOptions[1].options.groups.map((group) => group.group),
        ["safe-modes", "active-modes"]
      );
    }
  }
  assert.deepEqual(parseAcpSessionConfigSnapshot(snapshot), snapshot);
});

test("ACP Session config bounds adversarial option collections", () => {
  const snapshot = createAcpSessionConfigSnapshot({
    configOptions: Array.from({ length: 129 }, (_, index) => ({
      id: `flag-${index}`,
      name: `Flag ${index}`,
      type: "boolean",
      currentValue: false,
    })),
  });
  assert.equal(snapshot.configOptions.length, 128);
  assert.equal(snapshot.truncated, true);
});

test("session new/load/resume capture full Agent config and config_option_update replaces it", async (t) => {
  for (const mode of ["new", "load", "resume"] as const) {
    await t.test(mode, async () => {
      const events: RuntimeEvent[] = [];
      const client = await makeClient(`ss-config${mode}`, events);
      try {
        const connected = await client.connect(
          mode === "new"
            ? undefined
            : { mode, providerSessionId: "provider-config" }
        );
        assert.equal(connected.sessionConfig.configOptions.length, 3);
        assert.deepEqual(connected.sessionConfig.authMethodIds, ["oauth", "api-key"]);
        if (mode === "new") {
          const result = await client.sendPrompt("go");
          assert.equal(result.assistantText, "ok");
          assert.deepEqual(client.sessionConfig.configOptions, [
            {
              id: "thinking",
              name: "Thinking",
              type: "boolean",
              currentValue: false,
            },
          ]);
          assert.equal(
            events.filter((event) => event.type === "session.config_options").length,
            1
          );
        }
      } finally {
        await client.stop("shutdown");
      }
    });
  }
});

test("Service session.get/list expose the typed bounded ACP Session snapshot", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-config-service-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    connections: [
      {
        connectionId: "fake-default",
        provider: "fake",
        adapterId: FAKE_ADAPTER_ID,
        fake: { waitForSignal: true },
      },
    ],
  });
  try {
    const sessionId = "ss-configprojection";
    await svc.runtime.reserveSession({
      sessionId,
      connectionId: "fake-default",
      lastTaskId: "tk-configprojection",
      workspace: "ws-configprojection",
      runtimeWorkspace: { cwd: dataDir },
      cwd: dataDir,
    });
    const acpSession = createAcpSessionConfigSnapshot({
      authMethods: [{ id: "oauth" }],
      configOptions: INITIAL_OPTIONS,
    });
    await svc.runtime.registry.update(sessionId, { acpSession });
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const got = await client.sessionGet(sessionId);
    assert.deepEqual(got.session.acpSession, acpSession);
    const listed = await client.sessionList("ws-configprojection");
    assert.deepEqual(listed.sessions[0]?.acpSession, acpSession);
    assert.equal("connectionSnapshot" in listed.sessions[0]!, false);
  } finally {
    await svc.stop();
  }
});
