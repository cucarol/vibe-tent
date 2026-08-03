import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AcpClient } from "../src/adapters/acp/client.js";

const MOCK_SOURCE = String.raw`
import fs from "node:fs";
import readline from "node:readline";
const logPath = process.env.ACP_AUTH_LOG;
const authType = process.env.ACP_AUTH_TYPE;
function record(method) { fs.appendFileSync(logPath, method + "\n", "utf8"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  record(request.method);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [{ id: "login", ...(authType ? { type: authType } : {}) }],
    } });
  } else if (request.method === "authenticate") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "provider-auth" } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`;

async function createFixture(authType?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-acp-auth-"));
  const mockPath = path.join(dir, "mock.mjs");
  const logPath = path.join(dir, "methods.log");
  await fs.writeFile(mockPath, MOCK_SOURCE, "utf8");
  const client = new AcpClient({
    command: process.execPath,
    args: [mockPath],
    cwd: dir,
    env: {
      ACP_AUTH_LOG: logPath,
      ...(authType ? { ACP_AUTH_TYPE: authType } : {}),
    },
    sessionId: "ss-auth-method",
    permissionPolicy: "deny",
    emit: () => undefined,
    authenticate: async () => ({ methodId: "login" }),
  });
  return { client, logPath };
}

test("ACP agent auth method is sent through authenticate", async () => {
  const { client, logPath } = await createFixture("agent");
  try {
    await client.connect();
    const methods = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(methods, ["initialize", "authenticate", "session/new"]);
  } finally {
    await client.stop("shutdown");
  }
});

test("ACP terminal auth method remains out-of-band", async () => {
  const { client, logPath } = await createFixture("terminal");
  try {
    await assert.rejects(
      client.connect(),
      /out-of-band or unsupported type: terminal/
    );
    const methods = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(methods, ["initialize"]);
  } finally {
    await client.stop("shutdown");
  }
});

test("ACP unknown auth method types fail loud instead of guessing", async () => {
  const { client, logPath } = await createFixture("future-auth");
  try {
    await assert.rejects(
      client.connect(),
      /out-of-band or unsupported type: future-auth/
    );
    const methods = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(methods, ["initialize"]);
  } finally {
    await client.stop("shutdown");
  }
});
