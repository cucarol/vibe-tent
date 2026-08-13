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
import { normalizeWorkspaceCollaboration } from "../src/desktop/renderer-next/model/workspace-collaboration-view.js";
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

function collaboration() {
  return {
    workspaceId,
    selectedNode: null,
    inbox: { items: [], counts: { result: 0, decision: 0, total: 0 } },
  };
}

function provenance() {
  return {
    workspaceId,
    outputId: "cx-output",
    path: "Output/Output.md",
    bound: true,
    resultId: "rs-1",
    result: {
      id: "rs-1",
      status: "accepted",
      taskId: "tk-1",
      artifactRefs: [
        { kind: "commit", target: "a".repeat(40) },
        { kind: "directory", target: "dist" },
        { kind: "path", target: "dist/app.js", label: "app" },
        { kind: "url", target: "https://example.test/artifact" },
      ],
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
      case "workspace.collaboration":
        return collaboration();
      case "output.provenance":
        return provenance();
    }
  };
  const gateway = new ServiceGateway({ projectionRpc: rpc, projectionTimeoutMs: 50 });

  const graphRead = await gateway.graphProjection(workspaceId);
  const collabRead = await gateway.workspaceCollaboration(workspaceId, null);
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
  assert.equal(collabRead.ok, true);
  assert.equal(provenanceRead.ok, true);
  assert.deepEqual(calls, [
    { method: "graph.projection", params: { workspaceId } },
    { method: "workspace.collaboration", params: { workspaceId } },
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

test("workspace collaboration parser accepts exact workspace Inbox with no selected Node", () => {
  const normalized = normalizeWorkspaceCollaboration(collaboration(), workspaceId, null);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.equal(normalized.value.selectedNode, null);
  assert.equal(normalized.value.inbox.counts.total, 0);
});

test("output provenance validates explicit wire records without inventing a source join", () => {
  const ready = normalizeOutputProvenance(provenance(), workspaceId, "cx-output");
  assert.equal(ready.state, "ready");
  if (ready.state === "ready") {
    assert.deepEqual(ready.value.result?.artifactRefs, provenance().result.artifactRefs);
  }

  const independentSource = provenance();
  independentSource.sourceNode.nodeId = "cx-explicit-source";
  assert.equal(
    normalizeOutputProvenance(independentSource, workspaceId, "cx-output").state,
    "ready",
    "the renderer cannot reconstruct Task workNodeIds from this wire"
  );

  const malformedSource = provenance() as unknown as { sourceNode: Record<string, unknown> };
  malformedSource.sourceNode = { nodeId: "cx-source", path: 42 };
  assert.equal(
    normalizeOutputProvenance(malformedSource, workspaceId, "cx-output").state,
    "error"
  );

  const missingSource = provenance() as unknown as Record<string, unknown>;
  missingSource.sourceNode = null;
  missingSource.incomplete = ["source_missing"];
  const incomplete = normalizeOutputProvenance(missingSource, workspaceId, "cx-output");
  assert.equal(incomplete.state, "ready");
  if (incomplete.state === "ready") {
    assert.deepEqual(incomplete.value.incomplete, ["source_missing"]);
  }
});

test("output provenance fails closed on non-canonical artifact refs", () => {
  const badRefs: unknown[] = [
    undefined,
    {},
    [{ kind: "other", target: "opaque" }],
    [{ kind: "path", target: "./dist/app.js" }],
    [{ kind: "commit", target: "A".repeat(40) }],
    [{ kind: "url", target: "HTTPS://EXAMPLE.TEST/artifact" }],
    [{ kind: "path", target: "dist/app.js", label: " app " }],
    [{ kind: "path", target: "dist/app.js", extra: true }],
    [
      { kind: "path", target: "dist/app.js" },
      { kind: "path", target: "dist/app.js" },
    ],
    [
      { kind: "url", target: "https://example.test/artifact" },
      { kind: "path", target: "dist/app.js" },
    ],
  ];
  for (const artifactRefs of badRefs) {
    const payload = structuredClone(provenance()) as unknown as {
      result: Record<string, unknown>;
    };
    payload.result.artifactRefs = artifactRefs;
    assert.equal(
      normalizeOutputProvenance(payload, workspaceId, "cx-output").state,
      "error",
      JSON.stringify(artifactRefs)
    );
  }
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
  assert.ok(node.keys.includes("workspace.collaboration"));
  assert.ok(node.keys.includes("output.provenance"));

  const task = invalidationFromEvent(event("task.updated"));
  assert.ok(task.keys.includes("workspace.collaboration"));
  assert.ok(task.keys.includes("output.provenance"));

  for (const type of ["session.state", "toolApproval.created", "taskInput.created", "proposal.created"]) {
    assert.deepEqual(invalidationFromEvent(event(type)).keys, [], type);
  }
});
