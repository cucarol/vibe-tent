import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runTaskCommand, taskHelpText } from "../src/cli/task-rpc.js";

async function makeTentCwd(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-direct-claim-"));
  await fs.mkdir(path.join(root, ".tent"), { recursive: true });
  await fs.writeFile(path.join(root, ".tent", "index.md"), "# tent\n", "utf8");
  return root;
}

function capturingClient() {
  const directCalls: Array<Record<string, unknown>> = [];
  const queuedCalls: Array<Record<string, unknown>> = [];
  return {
    directCalls,
    queuedCalls,
    client: {
      listWorkspaces: async () => ({ workspaces: [] }),
      mount: async (workspaceRoot: string) => ({
        workspaceId: "ws-direct",
        workspaceRoot,
        systemRoot: path.join(workspaceRoot, ".tent"),
      }),
      taskClaimDirect: async (_workspaceId: string, args: Record<string, unknown>) => {
        directCalls.push({ ...args });
        return { taskPath: "temp/planner/tasks/task-direct.md", state: "running" };
      },
      taskClaim: async (_workspaceId: string, taskPath: string, sessionId?: string) => {
        queuedCalls.push({ taskPath, sessionId });
        return { taskPath, state: "running", sessionId };
      },
    },
  };
}

test("direct Role claim forwards Nodes and durable provenance without authority or target fields", async () => {
  const cwd = await makeTentCwd();
  const capture = capturingClient();
  const result = await runTaskCommand(
    "claim",
    [
      "--node",
      "cx-one",
      "--node",
      "cx-two",
      "--node",
      "cx-one",
      "--prompt",
      "own this work",
      "--from-task",
      "temp/planner/tasks/parent.md",
      "--json",
    ],
    {
      client: capture.client as never,
      cwd,
      json: true,
      env: {
        ...process.env,
        TENT_ROLE_NAME: "planner",
        TENT_SESSION_ID: "ss-source",
      },
    }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(capture.directCalls.length, 1);
  assert.deepEqual(capture.directCalls[0], {
    role: "planner",
    nodeIds: ["cx-one", "cx-two"],
    prompt: "own this work",
    sourceSessionId: "ss-source",
    sourceTaskPath: "temp/planner/tasks/parent.md",
  });
  for (const forbidden of ["target", "parentActor", "reviewer", "asSub", "callerKind"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(capture.directCalls[0]!, forbidden), false);
  }
});

test("direct Role claim is mutually exclusive with queued taskPath claim and requires Role context", async () => {
  const cwd = await makeTentCwd();
  const capture = capturingClient();
  const mixed = await runTaskCommand(
    "claim",
    ["temp/planner/tasks/existing.md", "--node", "cx-one", "--prompt", "x"],
    { client: capture.client as never, cwd, env: { ...process.env, TENT_ROLE: "planner" } }
  );
  assert.equal(mixed.exitCode, 1);
  assert.match(mixed.stderr, /cannot be combined/i);

  const unbound = await runTaskCommand(
    "claim",
    ["--node", "cx-one", "--prompt", "x"],
    { client: capture.client as never, cwd, env: {} }
  );
  assert.equal(unbound.exitCode, 1);
  assert.match(unbound.stderr, /durable Role environment/i);
  assert.equal(capture.directCalls.length, 0);
});

test("existing taskPath claim remains the queued downstream execution path", async () => {
  const cwd = await makeTentCwd();
  const capture = capturingClient();
  const result = await runTaskCommand(
    "claim",
    ["temp/executor/tasks/existing.md", "--session", "ss-existing", "--json"],
    { client: capture.client as never, cwd, json: true }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(capture.queuedCalls, [
    { taskPath: "temp/executor/tasks/existing.md", sessionId: "ss-existing" },
  ]);
  assert.equal(capture.directCalls.length, 0);
});

test("task help separates direct Role claim from downstream dispatch", () => {
  const help = taskHelpText();
  assert.match(help, /task claim --node <nodeId>/);
  assert.match(help, /create \+ claim atomically/);
  assert.match(help, /no --target and no downstream dispatch/);
  assert.match(help, /Service derives parent\/reviewer from durable facts/);
});
