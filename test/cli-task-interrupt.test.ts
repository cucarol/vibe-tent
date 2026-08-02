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

test("task worktree-reclaim exposes exact preview and reconcile only", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-task-reconcile-"));
  await fs.mkdir(path.join(workspace, ".tent"));
  await fs.writeFile(path.join(workspace, ".tent", "index.md"), "# Index\n");
  const calls: Array<[string, string, string, string?]> = [];
  const client = {
    listWorkspaces: async () => ({ workspaces: [] }),
    mount: async (workspaceRoot: string) => ({
      workspaceId: "ws-reconcile",
      workspaceRoot,
      systemRoot: path.join(workspaceRoot, ".tent"),
    }),
    taskWorktreeReclaimPreview: async (workspaceId: string, taskPath: string) => {
      calls.push(["preview", workspaceId, taskPath]);
      return { taskPath, code: "DIRTY", eligible: false, reclaimed: false };
    },
    taskWorktreeReclaimReconcile: async (
      workspaceId: string,
      taskPath: string,
      actor: string
    ) => {
      calls.push(["reconcile", workspaceId, taskPath, actor]);
      return { taskPath, code: "RECLAIMED", eligible: true, reclaimed: true };
    },
  } as unknown as ServiceClient;
  const taskPath = "temp/routes/example/tasks/task.md";

  const preview = await runTaskCommand(
    "worktree-reclaim",
    ["preview", taskPath, "--json"],
    { client, cwd: workspace }
  );
  const reconcile = await runTaskCommand(
    "worktree-reclaim",
    ["reconcile", taskPath, "--json"],
    { client, cwd: workspace }
  );
  assert.equal(preview.exitCode, 0, preview.stderr);
  assert.equal(reconcile.exitCode, 0, reconcile.stderr);
  assert.deepEqual(calls, [
    ["preview", "ws-reconcile", taskPath],
    ["reconcile", "ws-reconcile", taskPath, "user"],
  ]);
  assert.equal(JSON.parse(preview.stdout).code, "DIRTY");
  assert.equal(JSON.parse(reconcile.stdout).reclaimed, true);

  const broad = await runTaskCommand("worktree-reclaim", ["reconcile"], {
    client,
    cwd: workspace,
  });
  assert.equal(broad.exitCode, 1);
  assert.match(broad.stderr, /<taskPath>/);
  assert.match(taskHelpText(), /worktree-reclaim preview <taskPath>/);
  assert.match(taskHelpText(), /worktree-reclaim reconcile <taskPath>/);

  calls.length = 0;
  const roleReconcile = await runTaskCommand(
    "worktree-reclaim",
    ["reconcile", taskPath],
    { client, cwd: workspace, env: { TENT_ROLE: "规划" } }
  );
  assert.equal(roleReconcile.exitCode, 0, roleReconcile.stderr);
  assert.deepEqual(calls, [["reconcile", "ws-reconcile", taskPath, "规划"]]);
});
