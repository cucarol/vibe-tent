/**
 * Service workspace.agents / agents.write + etag + user-only + event.
 * Layer: CLIENT_METHODS + MutationBus + workspace.agents.updated + docs-style etag.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { contentEtag } from "../src/service/etag.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";

async function makeWorkspace(name = "ws-agents"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-agents-svc-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nWorkspace agents service\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ws-agents-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mount(svc: Awaited<ReturnType<typeof startLocalTentService>>, ws: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  return (mounted.result as { workspaceId: string }).workspaceId;
}

test("CLIENT_METHODS includes workspace.agents and workspace.agents.write", () => {
  assert.ok(isClientMethod("workspace.agents"));
  assert.ok(isClientMethod("workspace.agents.write"));
  assert.ok(CLIENT_METHODS.includes("workspace.agents"));
  assert.ok(CLIENT_METHODS.includes("workspace.agents.write"));
});

test("workspace.agents: missing file projects empty exists=false with etag", async () => {
  const ws = await makeWorkspace("missing");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const result = (await client.workspaceAgents(workspaceId)) as {
      workspaceId: string;
      path: string;
      content: string;
      exists: boolean;
      etag: string;
    };
    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.path, "AGENTS.md");
    assert.equal(result.content, "");
    assert.equal(result.exists, false);
    assert.equal(result.etag, contentEtag(""));
    // Not written into .tent
    assert.equal(await fs.access(path.join(ws, ".tent", "AGENTS.md")).then(() => true).catch(() => false), false);
  });
});

test("workspace.agents.write: user-only, etag conflict, event on change, none on no-op", async () => {
  const ws = await makeWorkspace("write-events");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "workspace.agents.updated") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    const denied = await rpc(svc, "workspace.agents.write", {
      workspaceId,
      content: "# no\n",
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.match(denied.error!.message, /user-only/i);
    assert.equal(events.length, 0);

    const missingContent = await rpc(svc, "workspace.agents.write", { workspaceId });
    assert.ok(missingContent.error);
    assert.equal(missingContent.error!.code, -32602);
    assert.equal(events.length, 0);

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const emptyEtag = contentEtag("");

    // Stale etag against missing file
    const conflict = await rpc(svc, "workspace.agents.write", {
      workspaceId,
      content: "# Agents\n",
      baseEtag: "deadbeefdeadbeefdeadbeef",
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error!.code, -32009);
    assert.match(conflict.error!.message, /etag conflict/i);
    assert.equal(events.length, 0);

    const written = (await client.workspaceAgentsWrite(workspaceId, {
      content: "# Agents\n\nHello\n",
      baseEtag: emptyEtag,
    })) as {
      path: string;
      content: string;
      exists: boolean;
      etag: string;
      changed: boolean;
    };
    assert.equal(written.changed, true);
    assert.equal(written.exists, true);
    assert.equal(written.path, "AGENTS.md");
    assert.equal(written.content, "# Agents\n\nHello\n");
    assert.equal(written.etag, contentEtag("# Agents\n\nHello\n"));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.content, "# Agents\n\nHello\n");
    assert.equal(events[0]!.exists, true);
    assert.equal(events[0]!.etag, written.etag);

    // Disk is workspace-root only
    assert.equal(await fs.readFile(path.join(ws, "AGENTS.md"), "utf8"), "# Agents\n\nHello\n");
    assert.equal(await fs.access(path.join(ws, ".tent", "AGENTS.md")).then(() => true).catch(() => false), false);

    // No-op same content → success, no event
    const noop = (await client.workspaceAgentsWrite(workspaceId, {
      content: "# Agents\n\nHello\n",
      baseEtag: written.etag,
    })) as { changed: boolean; etag: string };
    assert.equal(noop.changed, false);
    assert.equal(noop.etag, written.etag);
    assert.equal(events.length, 1, "no-op must not emit workspace.agents.updated");

    // Real update with matching etag
    const next = (await client.workspaceAgentsWrite(workspaceId, {
      content: "# Agents\n\nUpdated\n",
      baseEtag: written.etag,
    })) as { changed: boolean; content: string; etag: string };
    assert.equal(next.changed, true);
    assert.equal(next.content, "# Agents\n\nUpdated\n");
    assert.equal(events.length, 2);

    // Stale etag after update
    const stale = await rpc(svc, "workspace.agents.write", {
      workspaceId,
      content: "stale\n",
      baseEtag: written.etag,
      actor: "user",
    });
    assert.ok(stale.error);
    assert.equal(stale.error!.code, -32009);
    assert.equal(events.length, 2);

    const readBack = (await client.workspaceAgents(workspaceId)) as {
      content: string;
      exists: boolean;
      etag: string;
    };
    assert.equal(readBack.exists, true);
    assert.equal(readBack.content, "# Agents\n\nUpdated\n");
    assert.equal(readBack.etag, next.etag);

    unsub();
  });
});
