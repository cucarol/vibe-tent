/**
 * Legacy profile/positional dispatch grammar was retired (cx-b9bf58).
 * Public ordinary dispatch is covered by test/cli-task-dispatch-grammar.test.ts.
 * This file keeps a thin regression: retired knobs stay rejected and help matches.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runTaskCommand, taskHelpText } from "../src/cli/task-rpc.js";

async function makeFakeTentCwd(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-profile-legacy-"));
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
      return {
        taskPath: "temp/capture/tasks/task-capture.md",
        state: "queued",
        assigneeKind: "role",
        assignee: args.role,
      };
    },
  };
  return { client, calls };
}

test("retired CLI profile/positional dispatch forms are rejected (no compatibility alias)", async () => {
  const help = taskHelpText();
  assert.match(help, /--target role:<roleIdOrName>\|agent:<agentId>/);
  assert.doesNotMatch(help, /tent task dispatch <boxId> --profile/);
  assert.doesNotMatch(help, /tent task dispatch <boxId> <role>/);

  const cwd = await makeFakeTentCwd();
  const { client, calls } = capturingDispatchClient();

  const profileForm = await runTaskCommand(
    "dispatch",
    ["cx-box", "--profile", "fake-default", "one-shot"],
    { client: client as never, cwd }
  );
  assert.notEqual(profileForm.exitCode, 0);
  assert.match(profileForm.stderr + profileForm.stdout, /no longer accepts|positional|--target/i);

  const rolePositional = await runTaskCommand(
    "dispatch",
    ["cx-box", "executor", "role path"],
    { client: client as never, cwd }
  );
  assert.notEqual(rolePositional.exitCode, 0);

  const agentFlag = await runTaskCommand(
    "dispatch",
    ["--target", "role:x", "--node", "cx-1", "--prompt", "p", "--agent", "w"],
    { client: client as never, cwd }
  );
  assert.notEqual(agentFlag.exitCode, 0);
  assert.match(agentFlag.stderr + agentFlag.stdout, /--agent|no longer accepts/i);

  assert.equal(calls.length, 0);
});
