import assert from "node:assert/strict";
import { test } from "node:test";
import { isDesktopProjectionEventType } from "../src/desktop/main/service-host.js";
import { DesktopServiceHost } from "../src/desktop/main/service-host.js";
import type { EventEnvelope } from "../src/service/types.js";

test("desktop host forwards workspace and projection invalidations only", () => {
  for (const type of [
    "workspace.switched",
    "service.health",
    "node.changed",
    "task.state",
    "delivery.updated",
  ]) {
    assert.equal(isDesktopProjectionEventType(type), true, type);
  }

  for (const type of ["workspace.debug", "provider.log", "unknown.event"]) {
    assert.equal(isDesktopProjectionEventType(type), false, type);
  }
});

test("desktop host coalesces identical types independently per workspace", async () => {
  const host = new DesktopServiceHost();
  const seen: Array<{ type: string; workspaceId: string }> = [];
  host.onServiceEvent((event) => seen.push(event));
  const push = (host as unknown as { handleEnvelope: (event: EventEnvelope) => void })
    .handleEnvelope.bind(host);
  const event = (workspaceId: string): EventEnvelope => ({
    id: `ev-${workspaceId}`,
    type: "node.changed",
    workspaceId,
    ts: new Date().toISOString(),
    source: "service",
    payload: {},
  });
  push(event("ws-a"));
  push(event("ws-b"));
  push(event("ws-a"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(seen, [
    { type: "node.changed", workspaceId: "ws-a" },
    { type: "node.changed", workspaceId: "ws-b" },
  ]);
  await host.disposeShellOnly();
});
