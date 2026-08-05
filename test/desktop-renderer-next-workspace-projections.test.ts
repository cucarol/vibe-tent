import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceGateway, invalidationFromEvent } from "../src/desktop/renderer-next/gateway/service-gateway.js";
import {
  authoritativeProjection,
  beginProjectionLoad,
  normalizeGraphProjection,
  settleProjection,
  type ProjectionResource,
  type WorkspaceProjectionRpc,
} from "../src/desktop/renderer-next/gateway/workspace-projections.js";
import {
  activeTaskState,
  normalizeNodeCollaborations,
} from "../src/desktop/renderer-next/model/node-collaboration-view.js";
import { normalizeOutputProvenance } from "../src/desktop/renderer-next/model/output-provenance-view.js";
import type { EventEnvelope, GraphProjection } from "../src/service/types.js";

const workspaceId = "ws-projections";

function graph(): GraphProjection {
  return {
    workspaceId,
    nodes: [
      {
        nodeId: "cx-source",
        etag: "a".repeat(24),
        path: "Source/Source.md",
        name: "Source",
        title: "源节点",
        type: "goal",
        tags: [],
        mode: "editable",
        archived: false,
        invalid: false,
      },
      {
        nodeId: "cx-output",
        etag: "b".repeat(24),
        path: "Output/Output.md",
        name: "Output",
        type: "output",
        tags: ["ui"],
        mode: "editable",
        archived: false,
        invalid: false,
      },
    ],
    edges: {
      parent: [
        { parentNodeId: null, childNodeId: "cx-source" },
        { parentNodeId: "cx-source", childNodeId: "cx-output" },
      ],
      markdown: [
        {
          fromNodeId: "cx-source",
          toNodeId: "cx-output",
          raw: "[Output](../Output/Output.md)",
        },
      ],
      wiki: [],
      relation: [
        {
          id: "rel-1",
          fromNodeId: "cx-source",
          kind: "supports",
          direction: "directed",
          // Stored missing targets remain explicit ids; Canvas must not infer a placement.
          toNodeId: "cx-missing",
        },
      ],
    },
  };
}

function collabs() {
  return {
    workspaceId,
    items: [
      {
        workspaceId,
        nodeId: "cx-source",
        activeTask: {
          task: {
            id: "tk-1",
            state: "running",
            roleId: "rl-ui",
            sessionId: "ss-1",
            activeDeliveryId: "dl-1",
          },
          session: {
            id: "ss-1",
            state: "live",
            alive: true,
            turnBusy: false,
          },
          delivery: { id: "dl-1", status: "ready" },
        },
      },
      {
        workspaceId,
        nodeId: "cx-output",
        activeTask: null,
      },
    ],
  };
}

function provenance() {
  return {
    workspaceId,
    outputId: "cx-output",
    path: "Output/Output.md",
    bound: true,
    deliveryId: "dl-1",
    delivery: {
      id: "dl-1",
      status: "accepted",
      taskId: "tk-1",
      sourceNodeId: "cx-source",
    },
    task: { id: "tk-1", state: "accepted" },
    sourceNode: { nodeId: "cx-source", type: "goal", archived: false },
    incomplete: [],
  };
}

test("workspace gateway exposes only named typed reads with explicit workspaceId", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: WorkspaceProjectionRpc = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "graph.projection":
        return graph();
      case "node.collaborations":
        return collabs();
      case "node.collaboration":
        return collabs().items[0];
      case "output.provenance":
        return provenance();
    }
  };
  const gateway = new ServiceGateway({ projectionRpc: rpc, projectionTimeoutMs: 50 });

  const graphRead = await gateway.graphProjection(workspaceId);
  const singleCollabRead = await gateway.nodeCollaboration(workspaceId, "cx-source");
  const collabRead = await gateway.nodeCollaborations(workspaceId, [
    "cx-source",
    "cx-output",
  ]);
  const provenanceRead = await gateway.outputProvenance(workspaceId, "cx-output");

  assert.equal(graphRead.ok, true);
  if (graphRead.ok) {
    assert.equal(graphRead.value.nodes[0]?.etag, "a".repeat(24));
    assert.deepEqual(graphRead.value.edges.relation[0], {
      id: "rel-1",
      fromNodeId: "cx-source",
      kind: "supports",
      direction: "directed",
      unresolved: "cx-missing",
    });
  }
  assert.equal(singleCollabRead.ok, true);
  assert.equal(collabRead.ok, true);
  assert.equal(provenanceRead.ok, true);
  assert.deepEqual(calls, [
    { method: "graph.projection", params: { workspaceId } },
    {
      method: "node.collaboration",
      params: { workspaceId, nodeId: "cx-source" },
    },
    {
      method: "node.collaborations",
      params: { workspaceId, nodeIds: ["cx-source", "cx-output"] },
    },
    {
      method: "output.provenance",
      params: { workspaceId, nodeId: "cx-output" },
    },
  ]);
});

test("graph projection parser requires and retains the exact Node etag", () => {
  const valid = normalizeGraphProjection(graph(), workspaceId);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.value.nodes[0]?.etag, "a".repeat(24));

  const missing = structuredClone(graph()) as unknown as {
    nodes: Array<Record<string, unknown>>;
  };
  delete missing.nodes[0]!.etag;
  const missingResult = normalizeGraphProjection(missing, workspaceId);
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) assert.match(missingResult.message, /nodes\[0\].*corrupt/);

  const nonString = structuredClone(graph()) as unknown as {
    nodes: Array<Record<string, unknown>>;
  };
  nonString.nodes[0]!.etag = 42;
  const nonStringResult = normalizeGraphProjection(nonString, workspaceId);
  assert.equal(nonStringResult.ok, false);
  if (!nonStringResult.ok) assert.match(nonStringResult.message, /nodes\[0\].*corrupt/);
});

test("graph identity mismatch and bounded timeout fail closed", async () => {
  const mismatch = new ServiceGateway({
    projectionRpc: async () => ({ ...graph(), workspaceId: "ws-other" }),
  });
  const corrupt = await mismatch.graphProjection(workspaceId);
  assert.equal(corrupt.ok, false);
  if (!corrupt.ok) assert.equal(corrupt.issue.kind, "corrupt");

  const timeout = new ServiceGateway({
    projectionRpc: async () => new Promise(() => {}),
    projectionTimeoutMs: 2,
  });
  const timedOut = await timeout.graphProjection(workspaceId);
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.issue.kind, "timeout");
});

test("stale resources retain diagnostic data but never expose it as authority", () => {
  const ready: ProjectionResource<GraphProjection> = {
    state: "ready",
    workspaceId,
    value: graph(),
    fetchedAt: "2026-08-04T00:00:00.000Z",
  };
  const loading = beginProjectionLoad(ready, workspaceId);
  assert.equal(authoritativeProjection(loading), null);
  const stale = settleProjection(loading, {
    ok: false,
    workspaceId,
    issue: { kind: "timeout", message: "timed out" },
    failedAt: "2026-08-04T00:00:01.000Z",
  });
  assert.equal(stale.state, "stale");
  assert.equal(authoritativeProjection(stale), null);
  if (stale.state === "stale") assert.equal(stale.previous.nodes.length, 2);

  const firstFailure = settleProjection<GraphProjection>({ state: "idle" }, {
    ok: false,
    workspaceId,
    issue: { kind: "transport", message: "offline" },
    failedAt: "2026-08-04T00:00:02.000Z",
  });
  assert.equal(firstFailure.state, "error");
});

test("collaboration parser accepts roleId and distinguishes unknown from idle", () => {
  const normalized = normalizeNodeCollaborations(
    collabs(),
    workspaceId,
    ["cx-source", "cx-output"]
  );
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.equal(normalized.value.items[0]?.activeTask?.task.roleId, "rl-ui");
  assert.equal(activeTaskState(normalized.value.items[0]), "running");
  assert.equal(activeTaskState(normalized.value.items[1]), null);
  assert.equal(activeTaskState(undefined), undefined);

  const foreignSession = collabs();
  foreignSession.items[0]!.activeTask!.session!.id = "ss-foreign";
  assert.equal(
    normalizeNodeCollaborations(
      foreignSession,
      workspaceId,
      ["cx-source", "cx-output"]
    ).ok,
    false
  );
});

test("output provenance validates explicit joins and never infers a chain", () => {
  const ready = normalizeOutputProvenance(provenance(), workspaceId, "cx-output");
  assert.equal(ready.state, "ready");

  const mismatch = provenance();
  mismatch.sourceNode.nodeId = "cx-guessed-from-time";
  assert.equal(
    normalizeOutputProvenance(mismatch, workspaceId, "cx-output").state,
    "error"
  );
});

test("Service events only invalidate graph/collaboration/provenance reads", () => {
  const event = (type: string): EventEnvelope => ({
    id: "ev-1",
    type,
    workspaceId,
    ts: "2026-08-04T00:00:00.000Z",
    source: "service",
    payload: { mustNotBecomeProjection: true },
  });
  const node = invalidationFromEvent(event("node.changed"));
  assert.ok(node.keys.includes("graph.projection"));
  assert.ok(node.keys.includes("node.collaborations"));
  assert.ok(node.keys.includes("output.provenance"));

  const task = invalidationFromEvent(event("task.updated"));
  assert.ok(task.keys.includes("node.collaborations"));
  assert.ok(task.keys.includes("output.provenance"));
});
