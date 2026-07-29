import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ServiceClient } from "../src/service/client.js";
import { runTaskCommand, taskHelpText } from "../src/cli/task-rpc.js";

test("task interrupt exposes the canonical Service-backed stop path", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-task-interrupt-"));
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent", "index.md"), "# Index\n");
  const calls: unknown[][] = [];
  const client = {
    listWorkspaces: async () => ({ workspaces: [] }),
    mount: async (workspaceRoot: string) => ({
      workspaceId: "ws-interrupt",
      workspaceRoot,
      systemRoot: path.join(workspaceRoot, ".tent"),
    }),
    taskInterrupt: async (...args: unknown[]) => {
      calls.push(args);
      return {
        taskPath: "temp/role/tasks/task.md",
        task: { state: "interrupted" },
      };
    },
  } as unknown as ServiceClient;

  const result = await runTaskCommand(
    "interrupt",
    ["temp/role/tasks/task.md", "--json"],
    { client, cwd: workspace }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(calls, [["ws-interrupt", "temp/role/tasks/task.md"]]);
  assert.match(result.stdout, /interrupted/);
  assert.match(taskHelpText(), /tent task interrupt/);
});
