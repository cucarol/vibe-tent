/**
 * Public ordinary Task dispatch grammar (cx-b9bf58 / tk-vnb8vesj):
 *   tent task dispatch --target role:<id>|route:<routeId> --node <nodeId>… --prompt <text>|-
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
      const isRoute = args.assigneeKind === "route";
      return {
        taskPath: isRoute
          ? `temp/routes/${String(args.assigneeId)}/tasks/task-capture.md`
          : `temp/${String(args.assigneeId)}/tasks/task-capture.md`,
        state: args.startSession === true ? "running" : "queued",
        assigneeKind: args.assigneeKind,
        assigneeId: args.assigneeId,
        parentActor: args.parentActor,
        reviewer: args.reviewer,
        session:
          args.startSession === true
            ? {
                session: {
                  sessionId: "ss-capture",
                  state: "live",
                  routeId: String(args.assigneeId),
                },
              }
            : undefined,
      };
    },
  };
  return { client, calls };
}

async function withTentRole<T>(
  role: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const previous = process.env.TENT_ROLE;
  try {
    if (role === undefined) delete process.env.TENT_ROLE;
    else process.env.TENT_ROLE = role;
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TENT_ROLE;
    else process.env.TENT_ROLE = previous;
  }
}

test("CLI help documents only the canonical target and Node grammar", () => {
  const help = taskHelpText();
  assert.match(help, /tent task dispatch --target role:<roleIdOrName>\|route:<routeId>/);
  assert.match(help, /--node <nodeId>/);
  assert.match(help, /queued; never starts managed ACP/);
  assert.match(help, /Settings route/);
  assert.match(help, /Any flag outside this command's canonical grammar is rejected/);
  assert.doesNotMatch(help, /tent task dispatch <nodeId>/);
  const usageLine = help
    .split("\n")
    .find((l) => l.includes("tent task dispatch --target"));
  assert.ok(usageLine);
  assert.equal(usageLine!.includes("--target"), true);
});

test("parseTaskFlags collects repeatable --node values in order", () => {
  const parsed = parseTaskFlags([
    "--target",
    "role:planner",
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
  assert.equal(parsed.flags.target, "role:planner");
  assert.equal(parsed.flags.prompt, "hi");
  assert.deepEqual(parsed.positionals, []);
});

test("role target: queued durable handoff; multi --node; no startSession", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  await withTentRole(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:executor",
        "--node",
        "cx-one",
        "--node",
        "cx-two",
        "--node",
        "cx-one",
        "--prompt",
        "role handoff work",
        "--json",
      ],
      { client: client as never, cwd, json: true }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.equal(calls.length, 1);
    const args = calls[0]!;
    assert.equal(args.assigneeKind, "role");
    assert.equal(args.assigneeId, "executor");
    assert.equal(args.role, undefined);
    assert.equal(args.startSession, undefined);
    assert.equal(args.agentId, undefined);
    assert.equal(args.profileId, undefined);
    assert.equal(args.routeId, undefined);
    assert.deepEqual(args.nodeIds, ["cx-one", "cx-two"]);
    assert.equal(args.nodes, undefined, "must not send retired nodes[] key");
    assert.equal(args.prompt, "role handoff work");
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(args.reviewer, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined, "user-direct role target must not set asSub");
    assert.equal(args.deliveryPolicy, undefined);

    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      assigneeKind?: string;
      session?: unknown;
    };
    assert.equal(parsed.state, "queued");
    assert.equal(parsed.assigneeKind, "role");
    assert.equal(parsed.session, undefined);
  });
});

test("route target: managed ACP startSession via canonical assignee wire; multi --node", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();
  await withTentRole(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "route:route-a",
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
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.equal(calls.length, 1);
    const args = calls[0]!;
    assert.equal(args.assigneeKind, "route");
    assert.equal(args.assigneeId, "route-a");
    assert.equal(args.agentId, undefined);
    assert.equal(args.startSession, true);
    assert.equal(args.role, undefined);
    assert.equal(args.routeId, undefined);
    assert.equal(args.profileId, undefined);
    assert.deepEqual(args.nodeIds, ["cx-alpha", "cx-beta"]);
    assert.equal(args.nodes, undefined, "must not send retired nodes[] key");
    assert.deepEqual(args.parentActor, { kind: "user", id: "user" });
    assert.deepEqual(args.reviewer, { kind: "user", id: "user" });
    assert.equal(args.callerKind, "user");
    assert.equal(args.asSub, undefined, "user-direct route target must not set asSub");

    const parsed = JSON.parse(r.stdout) as {
      state?: string;
      assigneeKind?: string;
      session?: { session?: { sessionId?: string } };
    };
    assert.equal(parsed.state, "running");
    assert.equal(parsed.assigneeKind, "route");
    assert.ok(parsed.session?.session?.sessionId || parsed.session);
  });
});

test("parentActor/reviewer + derived asSub: Role caller vs user-direct (both targets)", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();

  // Role caller → role:* : equal parent/reviewer, asSub:true, no startSession
  await withTentRole("规划", async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:executor",
        "--node",
        "cx-n1",
        "--prompt",
        "from role to role",
        "--json",
      ],
      {
        client: client as never,
        cwd,
        json: true,
        env: { ...process.env, TENT_ROLE: "规划" },
      }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "role", id: "规划" });
    assert.deepEqual(args.reviewer, { kind: "role", id: "规划" });
    assert.equal(args.callerKind, "role");
    assert.equal(args.asSub, true, "Role caller role:* targets parent Role Git lane");
    assert.equal(args.startSession, undefined);
    assert.equal(args.assigneeKind, "role");
    assert.equal(args.assigneeId, "executor");
    assert.equal(args.role, undefined);
  });

  // Role caller → route:* : equal parent/reviewer, asSub:true, startSession
  await withTentRole("规划", async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "route:route-a",
        "--node",
        "cx-n1b",
        "--prompt",
        "from role to agent",
        "--json",
      ],
      {
        client: client as never,
        cwd,
        json: true,
        env: { ...process.env, TENT_ROLE: "规划" },
      }
    );
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    const args = calls[calls.length - 1]!;
    assert.deepEqual(args.parentActor, { kind: "role", id: "规划" });
    assert.deepEqual(args.reviewer, { kind: "role", id: "规划" });
    assert.equal(args.callerKind, "role");
    assert.equal(args.asSub, true, "Role caller route:* targets parent Role Git lane");
    assert.equal(args.startSession, true);
    assert.equal(args.assigneeKind, "route");
    assert.equal(args.assigneeId, "route-a");
    assert.equal(args.agentId, undefined);
    assert.equal(args.routeId, undefined);
  });

  // User-direct → route:* : no asSub
  await withTentRole(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "route:route-b",
        "--node",
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
    assert.equal(args.asSub, undefined, "user-direct route:* must not set asSub");
    assert.equal(args.startSession, true);
    assert.equal(args.assigneeKind, "route");
    assert.equal(args.assigneeId, "route-b");
    assert.equal(args.agentId, undefined);
    assert.equal(args.routeId, undefined);
  });

  // User-direct → role:* : no asSub
  await withTentRole(undefined, async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:executor",
        "--node",
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

  // TENT_ROLE=user is plain user-direct (not a role named "user")
  await withTentRole("user", async () => {
    const r = await runTaskCommand(
      "dispatch",
      [
        "--target",
        "role:executor",
        "--node",
        "cx-n3",
        "--prompt",
        "tent role user token",
        "--json",
      ],
      {
        client: client as never,
        cwd,
        json: true,
        env: { ...process.env, TENT_ROLE: "user" },
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
    ["--target", "role:x", "--node", "cx-1", "--prompt", "p", "--unknown-option", "x"],
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
  assert.match(positional.stderr + positional.stdout, /--target|--node/i);
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

test("missing --target / --node / --prompt and invalid target fail loud", async () => {
  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();

  const missingTarget = await runTaskCommand(
    "dispatch",
    ["--node", "cx-1", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(missingTarget.exitCode, 0);
  assert.match(missingTarget.stderr, /--target/i);

  const badTarget = await runTaskCommand(
    "dispatch",
    ["--target", "worker:fake", "--node", "cx-1", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(badTarget.exitCode, 0);
  assert.match(badTarget.stderr, /role:|route:/i);

  const missingNode = await runTaskCommand(
    "dispatch",
    ["--target", "role:executor", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(missingNode.exitCode, 0);
  assert.match(missingNode.stderr, /--node/i);

  const missingPrompt = await runTaskCommand(
    "dispatch",
    ["--target", "role:executor", "--node", "cx-1"],
    { client: client as never, cwd }
  );
  assert.notEqual(missingPrompt.exitCode, 0);
  assert.match(missingPrompt.stderr, /--prompt/i);

  const emptyPrompt = await runTaskCommand(
    "dispatch",
    ["--target", "role:executor", "--node", "cx-1", "--prompt", "   "],
    { client: client as never, cwd }
  );
  assert.notEqual(emptyPrompt.exitCode, 0);

  // Empty/whitespace --node must fail even when another --node is valid.
  const emptyNodeAmongValid = await runTaskCommand(
    "dispatch",
    [
      "--target",
      "role:executor",
      "--node",
      "cx-valid",
      "--node",
      "   ",
      "--prompt",
      "p",
    ],
    { client: client as never, cwd }
  );
  assert.notEqual(emptyNodeAmongValid.exitCode, 0);
  assert.match(
    emptyNodeAmongValid.stderr + emptyNodeAmongValid.stdout,
    /--node|non-empty|empty|whitespace/i
  );

  const bareEmptyNode = await runTaskCommand(
    "dispatch",
    ["--target", "role:executor", "--node", "", "--prompt", "p"],
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
    ["--target", "worker:one", "--node", "cx-1", "--prompt", "p"],
    { client: client as never, cwd }
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /role:<roleIdOrName> or route:<routeId>/i);
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
