/**
 * Public ordinary Task dispatch grammar (cx-b9bf58 / tk-vnb8vesj):
 *   tent task dispatch --target role:<roleId>|connection:<connectionId> --work-node <nodeId>… [--context-node <nodeId>…] --prompt <text>|-
 *
 * Fake Service/client only — no paid/live provider, no real Local Service.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runTaskCommand, taskHelpText, parseTaskFlags } from "../src/cli/task-rpc.js";

/** Minimal in-workspace Tent marker so ensureMountedWorkspace can resolve paths. */
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
          : `temp/roles/${String(args.roleId)}/tasks/task-capture.md`,
        state: isConnection ? "running" : "queued",
        roleId: args.roleId,
        sessionId: isConnection ? "ss-capture" : undefined,
        parentActor: args.parentActor,
        reviewer: args.reviewer,
        session: isConnection
            ? {
                session: {
                  sessionId: "ss-capture",
                  state: "live",
                  connectionId: String(args.connectionId),
                },
              }
            : undefined,
      };
    },
  };
  return { client, calls };
}

async function withTentRoleId<T>(
  roleId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const previous = process.env.TENT_ROLE_ID;
  try {
    if (roleId === undefined) delete process.env.TENT_ROLE_ID;
    else process.env.TENT_ROLE_ID = roleId;
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TENT_ROLE_ID;
    else process.env.TENT_ROLE_ID = previous;
  }
}

test("CLI help documents only the canonical target and work/context Node grammar", () => {
  const help = taskHelpText();
  assert.match(help, /tent task dispatch --target role:<roleId>\|connection:<connectionId>/);
  assert.match(help, /--work-node <nodeId>/);
  assert.match(help, /--context-node <nodeId>/);
  assert.match(help, /queued; never starts managed ACP/);
  assert.match(help, /Settings Connection/);
  assert.match(help, /Any flag outside this command's canonical grammar is rejected/);
  assert.doesNotMatch(help, /tent task dispatch <nodeId>/);
  const usageLine = help
    .split("\n")
    .find((l) => l.includes("tent task dispatch --target"));
  assert.ok(usageLine);
  assert.equal(usageLine!.includes("--target"), true);
  assert.match(help, /task request-decision/);
  assert.match(help, /task decision list\|get\|respond\|escalate/);
  assert.doesNotMatch(help, /ask-user|user-ask/i);
});

test("DecisionRequest CLI forwards canonical payloads and rejects actor/alias knobs", async () => {
  const cwd = await makeFakeTentCwd();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    listWorkspaces: async () => ({ workspaces: [] }),
    mount: async (workspaceRoot: string) => ({
      workspaceId: "ws-decision",
      workspaceRoot,
      systemRoot: path.join(workspaceRoot, ".tent"),
    }),
    taskRequestDecision: async (...args: unknown[]) => {
      calls.push({ method: "request", args });
      return { taskPath: args[1], state: "waiting", request: { id: "dr-0000000000" } };
    },
    decisionRequestRespond: async (...args: unknown[]) => {
      calls.push({ method: "respond", args });
      return { request: { id: args[2], status: "answered" }, state: "running" };
    },
  };

  const requested = await runTaskCommand(
    "request-decision",
    [
      "temp/role/tasks/task.md",
      "--question",
      "Choose?",
      "--options",
      "a=Alpha,b=Beta",
    ],
    { client: client as never, cwd }
  );
  assert.equal(requested.exitCode, 0, requested.stderr);
  assert.deepEqual(calls[0], {
    method: "request",
    args: [
      "ws-decision",
      "temp/role/tasks/task.md",
      {
        question: "Choose?",
        options: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      },
    ],
  });

  const denied = await runTaskCommand(
    "decision",
    ["respond", "temp/role/tasks/task.md", "dr-0000000000", "--deny"],
    { client: client as never, cwd }
  );
  assert.equal(denied.exitCode, 0, denied.stderr);
  assert.deepEqual(calls[1], {
    method: "respond",
    args: [
      "ws-decision",
      "temp/role/tasks/task.md",
      "dr-0000000000",
      { kind: "deny" },
    ],
  });

  const actor = await runTaskCommand(
    "decision",
    [
      "respond",
      "temp/role/tasks/task.md",
      "dr-0000000000",
      "--deny",
      "--actor",
      "rl-forged",
    ],
    { client: client as never, cwd }
  );
  assert.notEqual(actor.exitCode, 0);
  assert.match(actor.stderr, /Unknown option --actor/);
  assert.equal(calls.length, 2, "rejected actor selector must not call mutation RPC");

  for (const alias of ["requestDecision", "decision-request", "decisionRequest"]) {
    const rejected = await runTaskCommand(alias, [], { client: client as never, cwd });
    assert.notEqual(rejected.exitCode, 0);
  }
  assert.equal(calls.length, 2);
});

test("parseTaskFlags collects repeatable work/context Node values in order", () => {
  const parsed = parseTaskFlags([
    "--target",
    "role:rl-planner",
    "--work-node",
    "cx-a",
    "--context-node",
    "cx-context",
    "--work-node",
    "cx-b",
    "--context-node",
    "cx-context-2",
    "--work-node",
    "cx-a",
    "--prompt",
    "hi",
  ]);
  assert.deepEqual(parsed.repeatable["work-node"], ["cx-a", "cx-b", "cx-a"]);
  assert.deepEqual(parsed.repeatable["context-node"], ["cx-context", "cx-context-2"]);
  assert.equal(parsed.flags.target, "role:rl-planner");
  assert.equal(parsed.flags.prompt, "hi");
  assert.deepEqual(parsed.positionals, []);
});

test("role target: queued durable handoff; work/context Nodes; no startSession", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  await withTentRoleId(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:rl-executor",
        "--work-node",
        "cx-one",
        "--work-node",
        "cx-two",
        "--work-node",
        "cx-one",
        "--context-node",
        "cx-context",
        "--prompt",
        "role handoff work",
        "--json",
      ],
      { client: client as never, cwd, json: true }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.equal(calls.length, 1);
    const args = calls[0]!;
    assert.equal(args.roleId, "rl-executor");
    assert.equal(args.connectionId, undefined);
    assert.deepEqual(args.workNodeIds, ["cx-one", "cx-two"]);
    assert.deepEqual(args.contextNodeIds, ["cx-context"]);
    assert.equal(args.prompt, "role handoff work");
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(args.reviewer, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined, "user-direct role target must not set asSub");
    assert.equal(args.acceptMode, undefined);

    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      roleId?: string;
      session?: unknown;
    };
    assert.equal(parsed.state, "queued");
    assert.equal(parsed.roleId, "rl-executor");
    assert.equal(parsed.session, undefined);
  });
});

test("Connection target: managed ACP exact Session; work/context Nodes", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  await withTentRoleId(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "connection:connection-a",
        "--work-node",
        "cx-alpha",
        "--work-node",
        "cx-beta",
        "--context-node",
        "cx-context",
        "--prompt",
        "managed agent work",
        "--json",
      ],
      { client: client as never, cwd, json: true }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.equal(calls.length, 1);
    const args = calls[0]!;
    assert.equal(args.connectionId, "connection-a");
    assert.equal(args.roleId, undefined);
    assert.deepEqual(args.workNodeIds, ["cx-alpha", "cx-beta"]);
    assert.deepEqual(args.contextNodeIds, ["cx-context"]);
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(args.reviewer, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined, "user-direct Connection target must not set asSub");

    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      sessionId?: string;
      session?: { session?: { sessionId?: string } };
    };
    assert.equal(parsed.state, "running");
    assert.equal(parsed.sessionId, "ss-capture");
    assert.ok(parsed.session?.session?.sessionId || parsed.session);
  });
});

test("parentActor/reviewer + derived asSub: Role caller vs user-direct (both targets)", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();

  // Role caller → role:* : equal parent/reviewer, asSub:true, no startSession
  await withTentRoleId("rl-planning", async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:rl-executor",
        "--work-node",
        "cx-n1",
        "--prompt",
        "from role to role",
        "--json",
      ],
      {
        client: client as never,
        cwd,
        json: true,
        env: { ...process.env, TENT_ROLE_ID: "rl-planning" },
      }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "role", id: "rl-planning" });
    assert.deepEqual(args.reviewer, { kind: "role", id: "rl-planning" });
    assert.equal(args.callerKind, "role");
    assert.equal(args.asSub, true, "Role caller role:* targets parent Role Git lane");
    assert.equal(args.roleId, "rl-executor");
    assert.equal(args.connectionId, undefined);
  });

  // Role caller → connection:* : equal parent/reviewer, asSub:true, exact Session
  await withTentRoleId("rl-planning", async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "connection:connection-a",
        "--work-node",
        "cx-n1b",
        "--prompt",
        "from role to agent",
        "--json",
      ],
      {
        client: client as never,
        cwd,
        json: true,
        env: { ...process.env, TENT_ROLE_ID: "rl-planning" },
      }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "role", id: "rl-planning" });
    assert.deepEqual(args.reviewer, { kind: "role", id: "rl-planning" });
    assert.equal(args.callerKind, "role");
    assert.equal(args.asSub, true, "Role caller connection:* targets parent Role Git lane");
    assert.equal(args.connectionId, "connection-a");
    assert.equal(args.roleId, undefined);
  });

  // User-direct → connection:* : no asSub
  await withTentRoleId(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "connection:connection-b",
        "--work-node",
        "cx-n2",
        "--prompt",
        "from user",
        "--json",
      ],
      { client: client as never, cwd, json: true }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(args.reviewer, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined, "user-direct connection:* must not set asSub");
    assert.equal(args.connectionId, "connection-b");
    assert.equal(args.roleId, undefined);
  });

  // User-direct → role:* : no asSub
  await withTentRoleId(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:rl-executor",
        "--work-node",
        "cx-n2b",
        "--prompt",
        "user to role",
        "--json",
      ],
      { client: client as never, cwd, json: true }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(args.reviewer, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined, "user-direct role:* must not set asSub");
    assert.equal(args.startSession, undefined);
  });

  // Missing TENT_ROLE_ID is the plain user-direct path.
  await withTentRoleId(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:rl-executor",
        "--work-node",
        "cx-n3",
        "--prompt",
        "tent role user token",
        "--json",
      ],
      {
        client: client as never,
        cwd,
        json: true,
        env: { ...process.env, TENT_ROLE_ID: "" },
      }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined);
  });
});

test("unknown flags and positional dispatch input fail before mutation", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  const unknown = await runTaskCommand(
    "dispatch",
    ["--target", "role:x", "--work-node", "cx-1", "--prompt", "p", "--unknown-option", "x"],
    { client: client as never, cwd }
  );
  assert.notEqual(unknown.exitCode, 0);
  assert.match(unknown.stderr, /Unknown option --unknown-option/);

  const positional = await runTaskCommand(
    "dispatch",
    ["cx-1", "executor", "positional prompt"],
    { client: client as never, cwd }
  );
  assert.notEqual(positional.exitCode, 0);
  assert.match(positional.stderr + positional.stdout, /--target|--work-node/i);
  assert.equal(calls.length, 0);
});

test("task accept rejects --commits before workspace or client access", async () => {
  const accessed: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        accessed.push(String(property));
        return async () => {
          throw new Error("client must not be called");
        };
      },
    }
  );
  const result = await runTaskCommand(
    "accept",
    ["temp/规划/tasks/task-example.md", "--actor", "user", "--commits", "abc1234"],
    { client: client as never, cwd: "C:\\path-that-must-not-be-read" }
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /does not accept --commits/);
  assert.deepEqual(accessed, []);
  const acceptUsage = taskHelpText()
    .split("\n")
    .find((line) => line.includes("tent task accept"));
  assert.ok(acceptUsage);
  assert.doesNotMatch(acceptUsage!, /--commits/);
});

test("missing --target / --work-node / --prompt and invalid target fail loud", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();

  const missingTarget = await runTaskCommand(
    "dispatch",
    ["--work-node", "cx-1", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(missingTarget.exitCode, 0);
  assert.match(missingTarget.stderr, /--target/i);

  const badTarget = await runTaskCommand(
    "dispatch",
    ["--target", "worker:fake", "--work-node", "cx-1", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(badTarget.exitCode, 0);
  assert.match(badTarget.stderr, /role:|connection:/i);

  const missingWorkNode = await runTaskCommand(
    "dispatch",
    ["--target", "role:rl-executor", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(missingWorkNode.exitCode, 0);
  assert.match(missingWorkNode.stderr, /--work-node/i);

  const missingPrompt = await runTaskCommand(
    "dispatch",
    ["--target", "role:rl-executor", "--work-node", "cx-1"],
    { client: client as never, cwd }
  );
  assert.notEqual(missingPrompt.exitCode, 0);
  assert.match(missingPrompt.stderr, /--prompt/i);

  const emptyPrompt = await runTaskCommand(
    "dispatch",
    ["--target", "role:rl-executor", "--work-node", "cx-1", "--prompt", "   "],
    { client: client as never, cwd }
  );
  assert.notEqual(emptyPrompt.exitCode, 0);

  // Empty/whitespace --work-node must fail even when another --work-node is valid.
  const emptyNodeAmongValid = await runTaskCommand(
    "dispatch",
    [
      "--target",
      "role:rl-executor",
      "--work-node",
      "cx-valid",
      "--work-node",
      "   ",
      "--prompt",
      "p",
    ],
    { client: client as never, cwd }
  );
  assert.notEqual(emptyNodeAmongValid.exitCode, 0);
  assert.match(
    emptyNodeAmongValid.stderr + emptyNodeAmongValid.stdout,
    /--work-node|non-empty|empty|whitespace/i
  );

  const bareEmptyNode = await runTaskCommand(
    "dispatch",
    ["--target", "role:rl-executor", "--work-node", "", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(bareEmptyNode.exitCode, 0);

  assert.equal(calls.length, 0, "validation failures must not call taskDispatch");
});

test("unknown target kind is rejected", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  const result = await runTaskCommand(
    "dispatch",
    ["--target", "worker:one", "--work-node", "cx-1", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /role:<roleId> or connection:<connectionId>/i);
  assert.equal(calls.length, 0);
});

test("non-dispatch task commands remain available (help lists claim/get/deliver)", () => {
  const help = taskHelpText();
  assert.match(help, /tent task claim/);
  assert.match(help, /tent task get/);
  assert.match(help, /tent task deliver/);
  assert.match(help, /tent task list/);
  assert.match(help, /tent task accept/);
  assert.match(help, /tent task interrupt/);
});
