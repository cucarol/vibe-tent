import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseTaskFlags, runTaskCommand, taskHelpText } from "../src/cli/task-rpc.js";

async function makeFakeTentCwd(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-dispatch-"));
  await fs.mkdir(path.join(root, ".tent"), { recursive: true });
  await fs.writeFile(path.join(root, ".tent", "index.md"), "# tent\n", "utf8");
  return root;
}

function capturingDispatchClient() {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    listWorkspaces: async () => ({ workspaces: [] }),
    mount: async (workspaceRoot: string) => ({
      workspaceId: "ws-capture",
      workspaceRoot,
      systemRoot: path.join(workspaceRoot, ".tent"),
    }),
    taskDispatch: async (_workspaceId: string, args: Record<string, unknown>) => {
      calls.push({ ...args });
      const isConnection = typeof args.connectionId === "string";
      return {
        taskPath: isConnection
          ? "temp/sessions/ss-capture/tasks/task-capture.md"
          : `temp/roles/${String(args.assigneeRoleId)}/tasks/task-capture.md`,
        state: isConnection ? "running" : "queued",
        assigneeRoleId: args.assigneeRoleId,
        executionSessionId: isConnection ? "ss-capture" : undefined,
        requester: args.requester,
      };
    },
  };
  return { client, calls };
}

test("CLI help documents canonical dispatch grammar only", () => {
  const help = taskHelpText();
  assert.match(help, /tent task dispatch --target role:<roleId>\|connection:<connectionId>/);
  assert.match(help, /\[--node <nodeId> \.\.\.\]/);
  assert.match(help, /--prompt <text>\|-/);
  assert.doesNotMatch(help, /--work-node|--context-node/);
});

test("parseTaskFlags preserves exact repeated --node order and duplicates", () => {
  const parsed = parseTaskFlags([
    "--target",
    "role:rl-planner",
    "--node",
    "cx-a",
    "--node",
    "cx-b",
    "--node",
    "cx-a",
    "--prompt",
    "hi",
  ]);
  assert.deepEqual(parsed.repeatable.node, ["cx-a", "cx-b", "cx-a"]);
  assert.equal(parsed.flags.target, "role:rl-planner");
  assert.equal(parsed.flags.prompt, "hi");
});

test("role target forwards exact ordered nodeIds and never starts managed ACP", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  const result = await runTaskCommand(
    "dispatch",
    [
      "--target",
      "role:rl-executor",
      "--node",
      "cx-one",
      "--node",
      "cx-two",
      "--prompt",
      "role handoff work",
      "--json",
    ],
    { client: client as never, cwd, json: true }
  );
  assert.equal(result.exitCode, 0, result.stderr + result.stdout);
  assert.deepEqual(calls, [
    {
      assigneeRoleId: "rl-executor",
      nodeIds: ["cx-one", "cx-two"],
      prompt: "role handoff work",
      requester: { kind: "user", id: "user" },
    },
  ]);
  const parsed = JSON.parse(result.stdout) as { state?: string; executionSessionId?: string };
  assert.equal(parsed.state, "queued");
  assert.equal(parsed.executionSessionId, undefined);
});

test("connection target forwards exact ordered nodeIds on the managed path", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  const result = await runTaskCommand(
    "dispatch",
    [
      "--target",
      "connection:connection-a",
      "--node",
      "cx-alpha",
      "--node",
      "cx-beta",
      "--prompt",
      "managed agent work",
      "--json",
    ],
    { client: client as never, cwd, json: true }
  );
  assert.equal(result.exitCode, 0, result.stderr + result.stdout);
  assert.deepEqual(calls, [
    {
      connectionId: "connection-a",
      nodeIds: ["cx-alpha", "cx-beta"],
      prompt: "managed agent work",
      requester: { kind: "user", id: "user" },
    },
  ]);
  const parsed = JSON.parse(result.stdout) as { state?: string; executionSessionId?: string };
  assert.equal(parsed.state, "running");
  assert.equal(parsed.executionSessionId, "ss-capture");
});

test("prompt-only dispatch omits --node and sends nodeIds=[]", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  const result = await runTaskCommand(
    "dispatch",
    [
      "--target",
      "connection:connection-a",
      "--prompt",
      "prompt-only work",
      "--json",
    ],
    { client: client as never, cwd, json: true }
  );
  assert.equal(result.exitCode, 0, result.stderr + result.stdout);
  assert.deepEqual(calls[0]?.nodeIds, []);
});

test("retired work/context flags fail before client access", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  for (const args of [
    ["--target", "role:rl-executor", "--work-node", "cx-one", "--prompt", "p"],
    ["--target", "role:rl-executor", "--context-node", "cx-one", "--prompt", "p"],
  ]) {
    const result = await runTaskCommand("dispatch", args, { client: client as never, cwd });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Unknown option --work-node|Unknown option --context-node/);
  }
  assert.equal(calls.length, 0);
});

test("dispatch validates missing target/prompt, invalid target, and empty node before mutation", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  for (const args of [
    ["--node", "cx-1", "--prompt", "p"],
    ["--target", "worker:bad", "--node", "cx-1", "--prompt", "p"],
    ["--target", "role:rl-executor", "--node", "cx-1"],
    ["--target", "role:rl-executor", "--node", "   ", "--prompt", "p"],
  ]) {
    const result = await runTaskCommand("dispatch", args, { client: client as never, cwd });
    assert.notEqual(result.exitCode, 0);
  }
  assert.equal(calls.length, 0);
});
