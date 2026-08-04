import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceGateway } from "../src/desktop/renderer-next/gateway/service-gateway.js";

test("ServiceGateway named reads fail closed without protocol transport", async () => {
  const gateway = new ServiceGateway();
  const read = await gateway.graphProjection("ws-a");
  assert.equal(read.ok, false);
  if (read.ok) assert.fail("missing transport cannot return an authoritative graph");
  assert.equal(read.workspaceId, "ws-a");
  assert.equal(read.issue.kind, "transport");
});
