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
  ]);
});

test("concurrent recovery callers share attach, remount, and bootstrap result", async () => {
  const client = {} as ServiceRpcClient;
  const { model, calls } = recoveryModel();
  let attachCalls = 0;
  let releaseAttach!: () => void;
  const heldAttach = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const args = {
    host: {
      async ensureAttached() {
        attachCalls += 1;
        await heldAttach;
        return { client };
      },
    },
    model,
    loadPrefs: async () => ({
      recentWorkspaces: ["C:/remembered"],
      lastWorkspaceRoot: "C:/remembered",
      showFloatOnClose: true,
    }),
  };

  const first = recoverDesktopState(args);
  const second = recoverDesktopState(args);
  assert.equal(attachCalls, 1, "the full recovery flight starts once");
  releaseAttach();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.strictEqual(secondResult, firstResult);
  assert.deepEqual(calls, [
    "setRpc",
    "refreshHealth",
    "refreshWorkspaces",
    "mount:C:/remembered",
  ]);
});

test("failed recovery releases the flight so the next call can retry", async () => {
  const client = {} as ServiceRpcClient;
  const { model, calls } = recoveryModel();
  let attachCalls = 0;
  const host = {
    async ensureAttached() {
      attachCalls += 1;
      if (attachCalls === 1) throw new Error("isolated attach failed");
      return { client };
    },
  };
  const args = {
    host,
    model,
    loadPrefs: async () => ({
      recentWorkspaces: ["C:/remembered"],
      lastWorkspaceRoot: "C:/remembered",
      showFloatOnClose: true,
    }),
  };

  await assert.rejects(recoverDesktopState(args), /isolated attach failed/);
  const recovered = await recoverDesktopState(args);

  assert.equal(attachCalls, 2);
  assert.equal(recovered.foregroundWorkspaceId, "ws-remembered");
  assert.deepEqual(calls, [
    "setRpc",
    "refreshHealth",
    "refreshWorkspaces",
    "mount:C:/remembered",
  ]);
});
