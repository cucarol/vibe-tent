import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  decideDesktopNavigation,
  installDesktopNavigationPolicy,
  type DesktopNavigationWebContents,
} from "../src/desktop/main/navigation-policy.js";
import {
  DESKTOP_PROJECTION_METHODS,
  invokeDesktopProjectionRpc,
  isDesktopProjectionMethod,
} from "../src/desktop/projection-ipc.js";

test("desktop navigation keeps local entry in place and denies every Electron popup", async () => {
  const entry = path.resolve("desktop", "dist", "renderer-next", "index.html");
  const entryUrl = pathToFileURL(entry).href;
  assert.deepEqual(decideDesktopNavigation(`${entryUrl}#focus`, entry), {
    kind: "allow-local",
  });
  assert.deepEqual(decideDesktopNavigation("https://example.com/docs", entry), {
    kind: "open-external",
    url: "https://example.com/docs",
  });
  assert.deepEqual(
    decideDesktopNavigation(pathToFileURL(path.resolve("README.md")).href, entry),
    { kind: "deny" }
  );
  assert.deepEqual(decideDesktopNavigation("javascript:alert(1)", entry), {
    kind: "deny",
  });

  let navigate: ((event: { preventDefault: () => void }, url: string) => void) | null = null;
  let openWindow: ((details: { url: string }) => { action: "deny" }) | null = null;
  const opened: string[] = [];
  const webContents: DesktopNavigationWebContents = {
    on: (_event, listener) => {
      navigate = listener;
    },
    setWindowOpenHandler: (handler) => {
      openWindow = handler;
    },
  };
  installDesktopNavigationPolicy(webContents, entry, async (url) => {
    opened.push(url);
  });

  let prevented = false;
  navigate!({ preventDefault: () => { prevented = true; } }, "https://example.com/docs");
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.deepEqual(opened, ["https://example.com/docs"]);

  prevented = false;
  navigate!({ preventDefault: () => { prevented = true; } }, `${entryUrl}#node`);
  assert.equal(prevented, false);

  assert.deepEqual(openWindow!({ url: "https://example.com/other" }), {
    action: "deny",
  });
  await Promise.resolve();
  assert.deepEqual(opened, ["https://example.com/docs", "https://example.com/other"]);

  assert.deepEqual(openWindow!({ url: entryUrl }), { action: "deny" });
  assert.deepEqual(openWindow!({ url: "tent://node/cx-a" }), { action: "deny" });
});

test("desktop raw RPC surface is exactly the three read-only projections", async () => {
  assert.deepEqual(DESKTOP_PROJECTION_METHODS, [
    "graph.projection",
    "workspace.collaboration",
    "output.provenance",
  ]);
  for (const method of DESKTOP_PROJECTION_METHODS) {
    assert.equal(isDesktopProjectionMethod(method), true);
  }
  for (const method of [
    "task.dispatch",
    "task.accept",
    "docs.write",
    "connection.create",
    "settings.launchSecret.list",
    "",
    null,
  ]) {
    assert.equal(isDesktopProjectionMethod(method), false);
  }

  const calls: Array<{ method: string; params: unknown }> = [];
  let clientAccesses = 0;
  const getClient = () => {
    clientAccesses += 1;
    return {
      call: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        return { ok: true };
      },
    };
  };
  await assert.rejects(
    () => invokeDesktopProjectionRpc(getClient, "docs.write", { workspaceId: "ws-a" }),
    /Unsupported desktop projection method/
  );
  assert.equal(clientAccesses, 0);
  assert.deepEqual(calls, []);
  await invokeDesktopProjectionRpc(getClient, "graph.projection", { workspaceId: "ws-a" });
  assert.equal(clientAccesses, 1);
  assert.deepEqual(calls, [
    { method: "graph.projection", params: { workspaceId: "ws-a" } },
  ]);
});
