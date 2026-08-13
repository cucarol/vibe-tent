import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AcpClient } from "../src/adapters/acp/client.js";
import type { AcpResourceLimits } from "../src/adapters/acp/limits.js";
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

const REPLAY_FINAL_OPTIONS = [
  {
    id: "thinking",
    name: "Thinking final",
    type: "boolean",
    currentValue: true,
  },
];

const CONFIG_SECRET = "config-secret-must-not-persist";
const CONFIG_SHORT_SECRET = "qz";
const CONFIG_MARKER_SECRET = "red";
const CONFIG_MARKER_ALT_SECRET = "hidden";

const MOCK_SOURCE = String.raw`
import readline from "node:readline";
const initial = ${JSON.stringify(INITIAL_OPTIONS)};
const updated = ${JSON.stringify(UPDATED_OPTIONS)};
const replayFinal = ${JSON.stringify(REPLAY_FINAL_OPTIONS)};
const secret = process.env.CONFIG_SECRET || "";
const shortSecret = process.env.CONFIG_SHORT_SECRET || "";
const markerSecret = process.env.CONFIG_MARKER_SECRET || "";
const markerSecretAlt = process.env.CONFIG_MARKER_ALT_SECRET || "";
const secretOptions = secret ? [{
  id: "safe-display",
  name: "Name " + secret + " " + markerSecret,
  description: "Description " + shortSecret + " " + markerSecretAlt,
  category: "category-" + secret + "-" + markerSecret,
  type: "select",
  currentValue: "safe",
  options: [{ value: "safe", name: "Value " + secret }],
}, {
  id: "option-" + secret,
  name: "secret identity",
  type: "boolean",
  currentValue: true,
}, {
  id: "secret-current",
  name: "secret current",
  type: "select",
  currentValue: "value-" + shortSecret,
  options: [{ value: "value-" + shortSecret, name: "secret" }],
}, {
  id: "choice-drop",
  name: "Choice drop",
  type: "select",
  currentValue: "safe",
  options: [
    { value: "value-" + secret, name: "drop" },
    { value: "safe", name: "Safe" },
  ],
}, {
  id: "membership-drop",
  name: "Membership drop",
  type: "select",
  currentValue: "safe",
  options: [{ value: "value-" + secret, name: "drop" }],
}, {
  id: "group-display",
  name: "Grouped",
  type: "select",
  currentValue: "safe-group",
  options: [{
    group: "safe-group-id",
    name: "Group " + secret + " " + markerSecretAlt,
    options: [{ value: "safe-group", name: "Safe group value" }],
  }],
}, {
  id: "group-id-drop",
  name: "Group id drop",
  type: "select",
  currentValue: "safe-group",
  options: [{
    group: "group-" + shortSecret,
    name: "drop",
    options: [{ value: "safe-group", name: "Safe" }],
  }],
}] : initial;
const secretUpdatedOptions = secret ? [{
  id: "live-safe",
  name: "Live " + secret + " " + markerSecret,
  description: "Live " + shortSecret + " " + markerSecretAlt,
  type: "boolean",
  currentValue: false,
}, {
  id: "live-" + shortSecret,
  name: "drop",
  type: "boolean",
  currentValue: true,
}] : updated;
const stickyIntermediateOptions = [{
  id: "intermediate-safe",
  name: "Intermediate safe",
  type: "boolean",
  currentValue: false,
}, {
  id: "intermediate-" + shortSecret,
  name: "structurally dropped",
  type: "boolean",
  currentValue: true,
}];
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function sendBatch(values) {
  process.stdout.write(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
}
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
      authMethods: secret
        ? [{ id: "safe-auth" }, { id: "auth-" + secret }, { id: "auth-" + shortSecret }]
        : [{ id: "oauth" }, { id: "api-key" }],
    } });
    return;
  }
  if (request.method === "session/new") {
    const response = { jsonrpc: "2.0", id: request.id, result: { sessionId: "provider-config", configOptions: secretOptions } };
    if (process.env.START_CONFIG_STICKY_TRUNCATED === "1") {
      sendBatch([response, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-config",
        update: { sessionUpdate: "config_option_update", configOptions: stickyIntermediateOptions },
      } }, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-config",
        update: { sessionUpdate: "config_option_update", configOptions: replayFinal },
      } }]);
    } else if (process.env.START_CONFIG_UPDATE === "1") {
      sendBatch([response, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-config",
        update: { sessionUpdate: "config_option_update", configOptions: updated },
      } }]);
    } else {
      send(response);
    }
    return;
  }
  if (request.method === "session/load" || request.method === "session/resume") {
    const response = { jsonrpc: "2.0", id: request.id, result: { configOptions: initial } };
    if (process.env.START_CONFIG_STICKY_TRUNCATED === "1") {
      sendBatch([response, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: request.params?.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: stickyIntermediateOptions },
      } }, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: request.params?.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: replayFinal },
      } }]);
    } else if (request.method === "session/load" && request.params?.sessionId === "provider-replay-config") {
      sendBatch([response, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-replay-config",
        update: { sessionUpdate: "config_option_update", configOptions: updated },
      } }, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-replay-config",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed assistant history" } },
      } }, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-replay-config",
        update: { sessionUpdate: "config_option_update", configOptions: replayFinal },
      } }]);
    } else if (request.method === "session/resume" && process.env.START_CONFIG_UPDATE === "1") {
      sendBatch([response, { jsonrpc: "2.0", method: "session/update", params: {
        sessionId: request.params?.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: updated },
      } }]);
    } else {
      send(response);
    }
    return;
  }
  if (request.method === "session/prompt") {
    if (process.env.UNKNOWN_SECRET_CONFIG_UPDATES === "1") {
      for (let index = 0; index < 2; index += 1) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "provider-config",
          update: { sessionUpdate: "config_option_update", configOptions: [{
            id: "future-" + shortSecret,
            name: "Future",
            type: "future",
            currentValue: shortSecret,
          }] },
        } });
      }
    } else if (process.env.LIMIT_CROSSING_SECRET_CONFIG_UPDATE === "1") {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-config",
        update: { sessionUpdate: "config_option_update", configOptions: { malformed: true } },
      } });
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "provider-config",
        update: { sessionUpdate: "config_option_update", configOptions: [{
          id: "secret-only-" + shortSecret,
          name: "secret only",
          type: "boolean",
          currentValue: true,
        }] },
      } });
    } else if (process.env.MALFORMED_CONFIG_UPDATES === "1") {
      for (const configOptions of [
        { malformed: true },
        [{ id: "future", name: "Future", type: "future", currentValue: "x" }],
      ]) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "provider-config",
          update: { sessionUpdate: "config_option_update", configOptions },
        } });
      }
    } else if (process.env.SECRET_ONLY_CONFIG_UPDATE === "1") {
      for (let index = 0; index < 2; index += 1) {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "provider-config",
          update: { sessionUpdate: "config_option_update", configOptions: [{
            id: "secret-only-" + shortSecret,
            name: "secret only",
            type: "boolean",
            currentValue: true,
          }] },
        } });
      }
    } else {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "provider-config",
      update: { sessionUpdate: "config_option_update", configOptions: secretUpdatedOptions },
    } });
    }
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

async function makeClient(
  sessionId: string,
  events: RuntimeEvent[],
  env: Record<string, string> = {},
  resourceLimits?: Partial<AcpResourceLimits>
) {
  return new AcpClient({
    command: process.execPath,
    args: [await mockFile()],
    cwd: await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-config-cwd-")),
    env,
    sessionId,
    permissionPolicy: "deny",
    resourceLimits,
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

test("session/load keeps config updates received during replay quarantine and drops transcript", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient("ss-configreplay", events);
  try {
    const connected = await client.connect({
      mode: "load",
      providerSessionId: "provider-replay-config",
    });
    assert.deepEqual(connected.sessionConfig.configOptions, [
      {
        id: "thinking",
        name: "Thinking final",
        type: "boolean",
        currentValue: true,
      },
    ]);
    assert.deepEqual(client.sessionConfig, connected.sessionConfig);
    assert.equal(client.lastAssistantText, "");
    assert.equal(
      events.filter((event) => event.type === "session.prompt_complete").length,
      0
    );
    assert.equal(
      events.filter((event) => event.type === "session.config_options").length,
      0
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("session/new and session/resume commit same-chunk config updates after the response baseline", async (t) => {
  for (const mode of ["new", "resume"] as const) {
    await t.test(mode, async () => {
      const events: RuntimeEvent[] = [];
      const client = await makeClient(`ss-configstart${mode}`, events, {
        START_CONFIG_UPDATE: "1",
      });
      try {
        const connected = await client.connect(
          mode === "new"
            ? undefined
            : { mode, providerSessionId: "provider-config" }
        );
        assert.deepEqual(connected.sessionConfig.configOptions, UPDATED_OPTIONS);
        assert.deepEqual(client.sessionConfig, connected.sessionConfig);
        assert.equal(
          events.filter((event) => event.type === "session.config_options").length,
          0
        );
      } finally {
        await client.stop("shutdown");
      }
    });
  }
});

test("session start keeps the last replacement with sticky structural truncation", async (t) => {
  for (const mode of ["new", "load", "resume"] as const) {
    await t.test(mode, async () => {
      const events: RuntimeEvent[] = [];
      const client = await makeClient(`ss-configsticky${mode}`, events, {
        CONFIG_SHORT_SECRET,
        START_CONFIG_STICKY_TRUNCATED: "1",
      });
      try {
        const connected = await client.connect(
          mode === "new"
            ? undefined
            : { mode, providerSessionId: "provider-config" }
        );
        assert.deepEqual(connected.sessionConfig.configOptions, REPLAY_FINAL_OPTIONS);
        assert.equal(connected.sessionConfig.truncated, true);
        assert.deepEqual(client.sessionConfig, connected.sessionConfig);
        assert.equal(
          events.filter((event) => event.type === "session.config_options").length,
          0
        );
      } finally {
        await client.stop("shutdown");
      }
    });
  }
});

test("ACP Session config scrubs launch secrets before Registry and Service projection", async () => {
  const events: RuntimeEvent[] = [];
  const acp = await makeClient("ss-configsecret", events, {
    CONFIG_SECRET,
    CONFIG_SHORT_SECRET,
    CONFIG_MARKER_SECRET,
    CONFIG_MARKER_ALT_SECRET,
  });
  let snapshot = createAcpSessionConfigSnapshot({});
  try {
    snapshot = (await acp.connect()).sessionConfig;
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(CONFIG_SECRET), false);
    assert.equal(serialized.includes(CONFIG_SHORT_SECRET), false);
    assert.equal(serialized.includes(CONFIG_MARKER_SECRET), false);
    assert.equal(serialized.includes(CONFIG_MARKER_ALT_SECRET), false);
    assert.equal(serialized.includes("***"), true);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= 256 * 1024);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.authMethodIds, ["safe-auth"]);
    assert.deepEqual(
      snapshot.configOptions.map((option) => option.id),
      ["safe-display", "choice-drop", "group-display"]
    );
    const safeDisplay = snapshot.configOptions.find(
      (option) => option.id === "safe-display"
    );
    assert.equal(safeDisplay?.name, "Name *** ***");
    assert.equal(safeDisplay?.description, "Description *** ***");
    assert.equal(safeDisplay?.category, "category-***-***");
    const choiceDrop = snapshot.configOptions.find(
      (option) => option.id === "choice-drop"
    );
    assert.equal(choiceDrop?.type, "select");
    if (choiceDrop?.type === "select" && choiceDrop.options.kind === "flat") {
      assert.deepEqual(
        choiceDrop.options.options.map((option) => option.value),
        ["safe"]
      );
    }
    const groupDisplay = snapshot.configOptions.find(
      (option) => option.id === "group-display"
    );
    assert.equal(groupDisplay?.type, "select");
    if (
      groupDisplay?.type === "select" &&
      groupDisplay.options.kind === "grouped"
    ) {
      assert.equal(groupDisplay.options.groups[0]?.name, "Group *** ***");
    }

    const prompted = await acp.sendPrompt("update config");
    assert.equal(prompted.assistantText, "ok");
    snapshot = acp.sessionConfig;
    const updatedSerialized = JSON.stringify(snapshot);
    assert.equal(updatedSerialized.includes(CONFIG_SECRET), false);
    assert.equal(updatedSerialized.includes(CONFIG_SHORT_SECRET), false);
    assert.deepEqual(snapshot.configOptions, [
      {
        id: "live-safe",
        name: "Live *** ***",
        description: "Live *** ***",
        type: "boolean",
        currentValue: false,
      },
    ]);
  } finally {
    await acp.stop("shutdown");
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-config-secret-"));
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
    const sessionId = "ss-configsecretprojection";
    await svc.runtime.reserveSession({
      sessionId,
      connectionId: "fake-default",
      currentTaskId: "tk-configsecretprojection",
      workspace: "ws-configsecretprojection",
      runtimeWorkspace: { cwd: dataDir },
      cwd: dataDir,
    });
    await svc.runtime.registry.update(sessionId, { acpSession: snapshot });
    const persisted = await svc.runtime.registry.read(sessionId);
    assert.equal(JSON.stringify(persisted).includes(CONFIG_SECRET), false);
    assert.equal(JSON.stringify(persisted).includes(CONFIG_SHORT_SECRET), false);
    assert.equal(JSON.stringify(persisted).includes(CONFIG_MARKER_SECRET), false);
    assert.equal(
      JSON.stringify(persisted).includes(CONFIG_MARKER_ALT_SECRET),
      false
    );

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const got = await client.sessionGet(sessionId);
    const listed = await client.sessionList("ws-configsecretprojection");
    assert.equal(JSON.stringify(got.session.acpSession).includes(CONFIG_SECRET), false);
    assert.equal(
      JSON.stringify(got.session.acpSession).includes(CONFIG_SHORT_SECRET),
      false
    );
    assert.equal(
      JSON.stringify(got.session.acpSession).includes(CONFIG_MARKER_SECRET),
      false
    );
    assert.equal(
      JSON.stringify(got.session.acpSession).includes(
        CONFIG_MARKER_ALT_SECRET
      ),
      false
    );
    assert.equal(JSON.stringify(listed.sessions[0]?.acpSession).includes(CONFIG_SECRET), false);
    assert.equal(
      JSON.stringify(listed.sessions[0]?.acpSession).includes(
        CONFIG_SHORT_SECRET
      ),
      false
    );
    assert.equal(
      JSON.stringify(listed.sessions[0]?.acpSession).includes(
        CONFIG_MARKER_SECRET
      ),
      false
    );
    assert.equal(
      JSON.stringify(listed.sessions[0]?.acpSession).includes(
        CONFIG_MARKER_ALT_SECRET
      ),
      false
    );
    assert.deepEqual(got.session.acpSession, snapshot);
    assert.deepEqual(listed.sessions[0]?.acpSession, snapshot);
  } finally {
    await svc.stop();
  }
});

test("malformed and unknown-only config updates do not clear baseline or emit progress", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient("ss-configmalformed", events, {
    MALFORMED_CONFIG_UPDATES: "1",
  });
  try {
    const connected = await client.connect();
    const baseline = connected.sessionConfig;
    const result = await client.sendPrompt("malformed updates");
    assert.equal(result.assistantText, "ok");
    assert.deepEqual(client.sessionConfig, baseline);
    assert.equal(
      events.filter((event) => event.type === "session.config_options").length,
      0
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("unknown option types with short secrets stay ignored and consume no-progress", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient(
    "ss-configunknownsecret",
    events,
    { CONFIG_SHORT_SECRET, UNKNOWN_SECRET_CONFIG_UPDATES: "1" },
    { noProgressUpdates: 1 }
  );
  try {
    const baseline = (await client.connect()).sessionConfig;
    assert.equal(baseline.truncated, false);
    await assert.rejects(
      () => client.sendPrompt("unknown short secret"),
      /ACP_OUTPUT_LIMIT/
    );
    assert.deepEqual(client.sessionConfig, baseline);
    assert.equal(
      events.filter((event) => event.type === "session.config_options").length,
      0
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("limit-crossing secret-only update cannot commit or emit", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient(
    "ss-configlimitsecret",
    events,
    { CONFIG_SHORT_SECRET, LIMIT_CROSSING_SECRET_CONFIG_UPDATE: "1" },
    { noProgressUpdates: 1 }
  );
  try {
    const baseline = (await client.connect()).sessionConfig;
    await assert.rejects(
      () => client.sendPrompt("limit before secret commit"),
      /ACP_OUTPUT_LIMIT/
    );
    assert.deepEqual(client.sessionConfig, baseline);
    assert.equal(
      events.filter((event) => event.type === "session.config_options").length,
      0
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("secret-only config replacement clears options, records truncation, and never persists the secret", async () => {
  const events: RuntimeEvent[] = [];
  const client = await makeClient("ss-configsecretonly", events, {
    CONFIG_SECRET,
    CONFIG_SHORT_SECRET,
    SECRET_ONLY_CONFIG_UPDATE: "1",
  });
  try {
    const connected = await client.connect();
    assert.ok(connected.sessionConfig.configOptions.length > 0);
    await client.sendPrompt("secret-only replacement");
    const snapshot = client.sessionConfig;
    assert.deepEqual(snapshot.configOptions, []);
    assert.equal(snapshot.truncated, true);
    assert.equal(JSON.stringify(snapshot).includes(CONFIG_SECRET), false);
    assert.equal(JSON.stringify(snapshot).includes(CONFIG_SHORT_SECRET), false);
    assert.equal(
      events.filter((event) => event.type === "session.config_options").length,
      1
    );
  } finally {
    await client.stop("shutdown");
  }
});

test("config updates rejected by sanitizer still consume the prompt no-progress bound", async (t) => {
  const testCases: Array<{ name: string; env: Record<string, string> }> = [
    {
      name: "malformed and unknown-only",
      env: { MALFORMED_CONFIG_UPDATES: "1" },
    },
    {
      name: "secret-only",
      env: {
        CONFIG_SECRET,
        CONFIG_SHORT_SECRET,
        SECRET_ONLY_CONFIG_UPDATE: "1",
      },
    },
  ];
  for (const testCase of testCases) {
    await t.test(testCase.name, async () => {
      const client = await makeClient(
        `ss-confignoprogress${testCase.name.replaceAll(" ", "")}`,
        [],
        testCase.env,
        { noProgressUpdates: 1 }
      );
      try {
        await client.connect();
        await assert.rejects(
          () => client.sendPrompt("no progress"),
          /ACP_OUTPUT_LIMIT/
        );
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
      currentTaskId: "tk-configprojection",
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
