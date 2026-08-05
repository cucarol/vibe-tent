import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceRpcClient } from "../src/desktop/client/rpc-client.js";
import {
  recoverDesktopState,
  type DesktopRecoveryModel,
} from "../src/desktop/main/workspace-recovery.js";

function recoveryModel(args?: {
  foregroundWorkspaceId?: string | null;
  foregroundAfterRefresh?: string | null;
}) {
  let foregroundWorkspaceId = args?.foregroundWorkspaceId ?? null;
  const foregroundAfterRefresh =
    args?.foregroundAfterRefresh ?? foregroundWorkspaceId;
  const calls: string[] = [];
  const model: DesktopRecoveryModel = {
    setRpc() {
      calls.push("setRpc");
    },
    async refreshHealth() {
      calls.push("refreshHealth");
    },
    async refreshWorkspaces() {
      calls.push("refreshWorkspaces");
      foregroundWorkspaceId = foregroundAfterRefresh;
    },
    getSnapshot() {
      return { foregroundWorkspaceId };
    },
    async mountWorkspace(workspaceRoot) {
      calls.push(`mount:${workspaceRoot}`);
      foregroundWorkspaceId = "ws-remembered";
    },
    async refreshTasks() {
      calls.push("refreshTasks");
    },
  };
  return { model, calls };
}

test("same Service client remounts one remembered workspace after authoritative empty refresh", async () => {
  const client = {} as ServiceRpcClient;
  const { model, calls } = recoveryModel();
  let attachCalls = 0;
  let prefsCalls = 0;

  const snapshot = await recoverDesktopState({
    host: {
      async ensureAttached() {
        attachCalls += 1;
        return { client };
      },
    },
    model,
    dataDir: "C:/isolated-desktop-data",
    async loadPrefs(dataDir) {
      prefsCalls += 1;
      assert.equal(dataDir, "C:/isolated-desktop-data");
      return {
        recentWorkspaces: ["C:/remembered"],
        lastWorkspaceRoot: "C:/remembered",
        showFloatOnClose: true,
      };
    },
  });

  assert.equal(attachCalls, 1);
  assert.equal(prefsCalls, 1);
  assert.equal(snapshot.foregroundWorkspaceId, "ws-remembered");
  assert.deepEqual(calls, [
    "setRpc",
    "refreshHealth",
    "refreshWorkspaces",
    "mount:C:/remembered",
    "refreshTasks",
  ]);
});

test("existing authoritative foreground is preserved without a duplicate mount", async () => {
  const client = {} as ServiceRpcClient;
  const { model, calls } = recoveryModel({
    foregroundWorkspaceId: null,
    foregroundAfterRefresh: "ws-live",
  });
  let prefsCalls = 0;

  const snapshot = await recoverDesktopState({
    host: { ensureAttached: async () => ({ client }) },
    model,
    async loadPrefs() {
      prefsCalls += 1;
      throw new Error("preferences must not be read for an existing foreground");
    },
  });

  assert.equal(prefsCalls, 0);
  assert.equal(snapshot.foregroundWorkspaceId, "ws-live");
  assert.deepEqual(calls, [
    "setRpc",
    "refreshHealth",
    "refreshWorkspaces",
    "refreshTasks",
  ]);
});
