import assert from "node:assert/strict";
import type { FSWatcher } from "node:fs";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { patchTaskEnvelope } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { contentEtag } from "../src/service/etag.js";
import { EventBus } from "../src/service/events.js";
import {
  isFetchBlockedPort,
  MAX_RPC_BODY_BYTES,
  rpcCall,
} from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { MutationBus } from "../src/service/mutation-bus.js";
import {
  defaultServiceDataDir,
  isLoopbackServiceHost,
  readServiceEndpoint,
  serviceBaseUrl,
  serviceEndpointPath,
} from "../src/service/data-dir.js";
import { serviceLeasePath } from "../src/service/service-lease.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import { WorkspaceHost } from "../src/service/workspace-host.js";

/** Permission / capability failures when creating dir links — not ordinary I/O bugs. */
function isUnavailableLinkError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  const code = err?.code;
  if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
    return true;
  }
  const msg = String(err?.message ?? error);
  return /privilege|not privileged|operation not permitted|a required privilege is not held/i.test(
    msg
  );
}

function createStubWatchFn(onCreate?: () => void): typeof import("node:fs").watch {
  return ((_target, _opts?, _listener?) => {
    onCreate?.();
    const watcher = {
      close() {},
      on() {
        return watcher;
      },
    };
    return watcher as unknown as FSWatcher;
  }) as typeof import("node:fs").watch;
}

function createControllableWatchFn(): {
  watchFn: typeof import("node:fs").watch;
  fire: (event: string, filename: string | Buffer | null) => void;
} {
  type Listener = (event: string, filename: string | Buffer | null) => void;
  let listener: Listener | undefined;
  const watchFn = ((_target, optsOrListener?, maybeListener?) => {
    listener =
      typeof optsOrListener === "function"
        ? (optsOrListener as Listener)
        : typeof maybeListener === "function"
          ? (maybeListener as Listener)
          : undefined;
    const watcher = {
      close() {},
      on() {
        return watcher;
      },
    };
    return watcher as unknown as FSWatcher;
  }) as typeof import("node:fs").watch;
  return {
    watchFn,
    fire(event, filename) {
      listener?.(event, filename);
    },
  };
}

async function makeWorkspace(name = "demo"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  // Register a role so dispatch manifest preloads cleanly
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ name: "executor", prompt: "do work" }] }, null, 2) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

/** Authenticated RPC helper bound to a running service token. */
function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function oversizedRpcHeaders(
  svc: Awaited<ReturnType<typeof startLocalTentService>>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${svc.url}/rpc`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_RPC_BODY_BYTES + 1),
          "x-tent-token": svc.token,
          connection: "close",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        });
      }
    );
    req.setTimeout(5_000, () => req.destroy(new Error("oversized RPC test timed out")));
    req.on("error", reject);
    req.flushHeaders();
  });
}

test("Local Service never advertises Fetch-blocked ports", async () => {
  assert.equal(isFetchBlockedPort(6000), true);
  assert.equal(isFetchBlockedPort(6667), true);
  assert.equal(isFetchBlockedPort(4174), false);
  await withService(async (svc) => {
    assert.equal(isFetchBlockedPort(svc.port), false);
  });
});

test("Local Service accepts literal loopback only and formats IPv6 endpoints", async () => {
  assert.equal(isLoopbackServiceHost("127.0.0.1"), true);
  assert.equal(isLoopbackServiceHost("127.9.8.7"), true);
  assert.equal(isLoopbackServiceHost("::1"), true);
  assert.equal(isLoopbackServiceHost("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackServiceHost("localhost"), false);
  assert.equal(isLoopbackServiceHost("0.0.0.0"), false);
  assert.equal(isLoopbackServiceHost("192.168.1.10"), false);
  assert.equal(serviceBaseUrl("::1", 7788), "http://[::1]:7788");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-non-loopback-"));
  await assert.rejects(
    () => startLocalTentService({ dataDir, host: "0.0.0.0" }),
    /literal loopback address/
  );
  await assert.rejects(() => fs.access(serviceLeasePath(dataDir)), /ENOENT/);
});

test("RPC transport rejects invalid envelopes and oversized bodies without killing service", async () => {
  await withService(async (svc) => {
    const send = async (body: string) => {
      const response = await fetch(`${svc.url}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tent-token": svc.token,
        },
        body,
      });
      return {
        status: response.status,
        json: (await response.json()) as { error?: { code?: number } },
      };
    };

    const nullEnvelope = await send("null");
    assert.equal(nullEnvelope.status, 200);
    assert.equal(nullEnvelope.json.error?.code, -32600);

    const wrongVersion = await send(
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "service.health", params: {} })
    );
    assert.equal(wrongVersion.json.error?.code, -32600);

    const primitiveParams = await send(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "service.health", params: "bad" })
    );
    assert.equal(primitiveParams.json.error?.code, -32602);

    const oversized = await oversizedRpcHeaders(svc);
    assert.equal(oversized.status, 413);
    assert.equal(
      (oversized.body.error as { code?: number } | undefined)?.code,
      -32013
    );

    const health = await rpc(svc, "service.health", {});
    assert.equal((health.result as { status: string }).status, "ok");
  });
});

test("service.health + endpoint file written for attach discovery", async () => {
  await withService(async (svc, dataDir) => {
    const res = await fetch(`${svc.url}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; pid: number; version: string };
    assert.equal(body.status, "ok");
    assert.equal(typeof body.pid, "number");

    const ep = await readServiceEndpoint(dataDir);
    assert.ok(ep);
    assert.equal(ep!.port, svc.port);
    assert.equal(ep!.host, svc.host);
    assert.ok(ep!.token);
    assert.equal(ep!.token, svc.token);
  });
});

test("WorkspaceHost mount multi-workspace + setForeground emits workspace.switched", async () => {
  const ws1 = await makeWorkspace("a");
  const ws2 = await makeWorkspace("b");
  await withService(async (svc) => {
    const switched: string[] = [];
    svc.events.subscribe((ev) => {
      if (ev.type === "workspace.switched") switched.push(ev.workspaceId);
    });

    const m1 = await rpc(svc, "workspace.mount", { workspaceRoot: ws1 });
    assert.ok(m1.result);
    const m2 = await rpc(svc, "workspace.mount", { workspaceRoot: ws2 });
    assert.ok(m2.result);

    const list = await rpc(svc, "workspace.list", {});
    const workspaces = (list.result as { workspaces: { workspaceId: string }[] }).workspaces;
    assert.equal(workspaces.length, 2);

    const id2 = (m2.result as { workspaceId: string }).workspaceId;
    await rpc(svc, "workspace.setForeground", { workspaceId: id2 });
    assert.ok(switched.includes(id2));

    const health = await rpc(svc, "service.health", {});
    assert.equal((health.result as { foregroundWorkspaceId: string }).foregroundWorkspaceId, id2);
  });
});

test("WorkspaceHost: junction/symlink alias remount reuses workspaceId, list, and watcher", async (t) => {
  const realWs = await makeWorkspace("alias-target");
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-alias-"));
  const aliasPath = path.join(parent, "alias-ws");

  try {
    // Windows: directory junction (no admin). Other platforms: directory symlink.
    if (process.platform === "win32") {
      await fs.symlink(realWs, aliasPath, "junction");
    } else {
      await fs.symlink(realWs, aliasPath, "dir");
    }
  } catch (error) {
    if (isUnavailableLinkError(error)) {
      t.skip(
        `directory link unavailable on this host: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    throw error;
  }

  let watchCreates = 0;
  const host = new WorkspaceHost({
    events: new EventBus(),
    watchFn: createStubWatchFn(() => {
      watchCreates += 1;
    }),
  });

  try {
    const first = await host.mount(realWs);
    const second = await host.mount(aliasPath);
    assert.equal(second.workspaceId, first.workspaceId);
    assert.equal(host.list().length, 1);
    assert.equal(watchCreates, 1);

    const realRoot = await fs.realpath(path.resolve(realWs));
    assert.equal(first.workspaceRoot, realRoot);
    assert.equal(second.workspaceRoot, realRoot);
    assert.equal(first.systemRoot, path.join(realRoot, ".tent"));
  } finally {
    await host.dispose();
  }
});

test("WorkspaceHost: same basename + long shared path prefix still gets distinct workspaceIds", async () => {
  // Two real workspaces: identical leaf name, long common prefix, different mid segment.
  // Old base64url-prefix ids collided; sha256 digest of full identity must not.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-id-prefix-"));
  const shared = path.join(root, "very", "long", "shared", "prefix", "segment");
  const leaf = "same-leaf-name";
  const pathA = path.join(shared, "branch-alpha-side", leaf);
  const pathB = path.join(shared, "branch-beta-other", leaf);

  async function scaffoldAt(dir: string, name: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const fsa = new NodeFs(dir);
    await scaffoldInWorkspace(fsa, {
      name,
      boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
    });
    await fsa.writeFile(
      ".tent/roles.json",
      JSON.stringify({ roles: [{ name: "executor", prompt: "do work" }] }, null, 2) + "\n"
    );
  }

  await scaffoldAt(pathA, leaf);
  await scaffoldAt(pathB, leaf);

  let watchCreates = 0;
  const host = new WorkspaceHost({
    events: new EventBus(),
    watchFn: createStubWatchFn(() => {
      watchCreates += 1;
    }),
  });

  try {
    const first = await host.mount(pathA);
    const second = await host.mount(pathB);
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.match(first.workspaceId, new RegExp(`^ws-${leaf}-[A-Za-z0-9_-]{12,}$`));
    assert.match(second.workspaceId, new RegExp(`^ws-${leaf}-[A-Za-z0-9_-]{12,}$`));
    assert.equal(host.list().length, 2);
    assert.equal(watchCreates, 2);
  } finally {
    await host.dispose();
  }
});

test("WorkspaceHost: missing path and missing Tent errors stay clear", async () => {
  const host = new WorkspaceHost({
    events: new EventBus(),
    watchFn: createStubWatchFn(),
  });
  try {
    const missing = path.join(os.tmpdir(), `tent-b2-missing-${Date.now()}-${Math.random()}`);
    await assert.rejects(() => host.mount(missing), /Workspace path does not exist/);

    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-empty-"));
    await assert.rejects(() => host.mount(empty), /No in-workspace Tent/);
  } finally {
    await host.dispose();
  }
});

test("docs.createNote / list / get / write with etag; promote retired + fork", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    // Default type is prompt when omitted
    const defaulted = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "default-type",
    });
    assert.ok(!defaulted.error, JSON.stringify(defaulted.error));
    assert.equal((defaulted.result as { type?: string }).type, "prompt");

    // Explicit type: note is not a permanent alias — createBox rejects unknown types
    const badNote = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "legacy-note",
      type: "note",
    });
    assert.ok(badNote.error);
    assert.match(badNote.error!.message, /Unknown type|unknown type/i);

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "idea",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const id = (created.result as { id: string }).id;
    assert.match(id, /^cx-/);
    assert.equal((created.result as { type?: string }).type, "prompt");

    const listed = await rpc(svc, "docs.list", { workspaceId });
    const concepts = (listed.result as { concepts: { id: string; name: string }[] }).concepts;
    assert.ok(concepts.some((c) => c.id === id));

    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    assert.ok(!edit.error, JSON.stringify(edit.error));
    const { etag, body } = edit.result as { etag: string; body: string };

    const written = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: body + "\nupdated\n",
      baseEtag: etag,
    });
    assert.ok(!written.error, JSON.stringify(written.error));
    const writeResult = written.result as { etag: string; body?: string; raw?: string };
    assert.ok(writeResult.etag);
    assert.equal(writeResult.body, undefined);
    assert.equal(writeResult.raw, undefined);

    // Missing baseEtag → -32008 (distinct from conflict); data carries currentEtag, not body.
    const missing = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: "blind overwrite\n",
    });
    assert.ok(missing.error);
    assert.equal(missing.error!.code, -32008);
    assert.match(missing.error!.message, /baseEtag|etag/i);
    const missingData = missing.error!.data as {
      code?: string;
      currentEtag?: string;
      path?: string;
      id?: string;
      body?: string;
      raw?: string;
    };
    assert.equal(missingData.code, "etag_required");
    assert.equal(missingData.currentEtag, writeResult.etag);
    assert.equal(missingData.id, id);
    assert.equal(missingData.body, undefined);
    assert.equal(missingData.raw, undefined);

    const conflict = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: "stale\n",
      baseEtag: etag,
    });
    assert.ok(conflict.error);
    assert.equal(conflict.error!.code, -32009);
    const conflictData = conflict.error!.data as {
      code?: string;
      currentEtag?: string;
      baseEtag?: string;
      body?: string;
      raw?: string;
    };
    assert.equal(conflictData.code, "etag_conflict");
    assert.equal(conflictData.currentEtag, writeResult.etag);
    assert.equal(conflictData.baseEtag, etag);
    assert.equal(conflictData.body, undefined);
    assert.equal(conflictData.raw, undefined);

    // docs.promote removed from CLIENT_METHODS in V0.2
    const promoted = await rpc(svc, "docs.promote", {
      workspaceId,
      id,
      toType: "goal",
    });
    assert.ok(promoted.error);
    assert.equal(promoted.error!.code, -32601);
    assert.match(
      promoted.error!.message,
      /docs\.promote is retired|retired in V0\.2|Method not found/
    );

    // Semantic type changes use the dedicated command, not generic docs.write.
    const editType = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    assert.ok(!editType.error, JSON.stringify(editType.error));
    const typeWrite = await rpc(svc, "docs.setType", {
      workspaceId,
      id,
      type: "goal",
      baseEtag: (editType.result as { etag: string }).etag,
      actor: "user",
    });
    assert.ok(!typeWrite.error, JSON.stringify(typeWrite.error));
    const gotGoal = await rpc(svc, "docs.get", { workspaceId, id });
    assert.equal((gotGoal.result as { concept: { type: string } }).concept.type, "goal");

    const forked = await rpc(svc, "docs.fork", { workspaceId, id });
    assert.ok(!forked.error, JSON.stringify(forked.error));
    const forkId = (forked.result as { id: string }).id;
    assert.match(forkId, /^cx-/);
    assert.notEqual(forkId, id);
  });
});

test("docs.importAttachment: base64 wire → binary disk; rejects bad base64/size", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "attach-me",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const id = (created.result as { id: string }).id;

    const raw = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x00, 0x7f]);
    const imported = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id,
      fileName: "blob.bin",
      bytesBase64: raw.toString("base64"),
    });
    assert.ok(!imported.error, JSON.stringify(imported.error));
    const result = imported.result as {
      relativePath: string;
      markdown: string;
      artifactRef: { kind: string; target: string };
    };
    assert.match(result.relativePath, new RegExp(`^attachments/${id}/blob-[0-9a-f]{12}\\.bin$`));
    assert.equal(result.markdown, `![](../${result.relativePath})`);
    assert.equal(result.artifactRef.target, result.relativePath);

    const onDisk = await fs.readFile(path.join(ws, ".tent", ...result.relativePath.split("/")));
    assert.deepEqual([...onDisk], [...raw]);
    await assert.rejects(
      () => fs.access(path.join(ws, ".tent", result.relativePath + ".b64")),
      /ENOENT/
    );

    // Idempotent re-import
    const again = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id,
      fileName: "blob.bin",
      bytesBase64: raw.toString("base64"),
    });
    assert.ok(!again.error, JSON.stringify(again.error));
    assert.equal((again.result as { relativePath: string }).relativePath, result.relativePath);

    const empty = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id,
      fileName: "empty.bin",
      bytesBase64: "",
    });
    assert.ok(!empty.error, JSON.stringify(empty.error));
    const emptyPath = (empty.result as { relativePath: string }).relativePath;
    assert.equal((await fs.readFile(path.join(ws, ".tent", ...emptyPath.split("/")))).byteLength, 0);

    const traversal = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id,
      fileName: "../escape.bin",
      bytesBase64: raw.toString("base64"),
    });
    assert.equal(traversal.error?.code, -32602);

    // Invalid base64
    const badB64 = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id,
      fileName: "x.bin",
      bytesBase64: "!!!not-base64!!!",
    });
    assert.ok(badB64.error);
    assert.equal(badB64.error!.code, -32602);

    // Missing concept
    const missing = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id: "cx-does-not-exist",
      fileName: "x.bin",
      bytesBase64: raw.toString("base64"),
    });
    assert.ok(missing.error);
    assert.equal(missing.error!.code, -32004);

    // Oversized (decoded length check without allocating full 25MiB+1 on wire when possible —
    // use a small invalid path: still enforce via oversized buffer under limit of test memory).
    const over = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    const tooBig = await rpc(svc, "docs.importAttachment", {
      workspaceId,
      id,
      fileName: "huge.bin",
      bytesBase64: over.toString("base64"),
    });
    assert.ok(tooBig.error);
    assert.equal(tooBig.error!.code, -32602);
    assert.match(tooBig.error!.message, /exceeds max size/i);
  });
});

test("task.dispatch + task.claim project doing; docs.write blocks collab fields", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work-item",
      type: "prompt",
    });
    const boxId = (created.result as { id: string }).id;

    const dispatched = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "executor",
      prompt: "implement the thing",
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    assert.match(taskPath, /^temp\//);

    // pending task occupies — cannot patch status via docs.write (still requires baseEtag)
    const editPending = await rpc(svc, "docs.readForEdit", { workspaceId, id: boxId });
    assert.ok(!editPending.error, JSON.stringify(editPending.error));
    const pendingEtag = (editPending.result as { etag: string }).etag;
    const blockedPending = await rpc(svc, "docs.write", {
      workspaceId,
      id: boxId,
      frontmatter: { status: "done" },
      baseEtag: pendingEtag,
    });
    assert.ok(blockedPending.error);
    assert.equal(blockedPending.error!.code, -32010);

    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));
    assert.equal((claimed.result as { state: string }).state, "running");

    const got = await rpc(svc, "docs.get", { workspaceId, id: boxId });
    const concept = (got.result as {
      concept: { status?: string; assignee?: string; invalid?: boolean; archived?: boolean };
    }).concept;
    // ConceptProjection no longer exposes Node FM owner/status; collab truth is box.projection.
    assert.equal("status" in concept ? concept.status : undefined, undefined);
    assert.equal("assignee" in concept ? concept.assignee : undefined, undefined);
    assert.equal(concept.invalid, false);
    assert.equal(concept.archived, false);
    const boxProj = await rpc(svc, "box.projection", { workspaceId, id: boxId });
    assert.ok(!boxProj.error, JSON.stringify(boxProj.error));
    const proj = boxProj.result as { status?: string; assignee?: string };
    assert.equal(proj.status, "doing");
    assert.equal(proj.assignee, "executor");

    const editOwner = await rpc(svc, "docs.readForEdit", { workspaceId, id: boxId });
    assert.ok(!editOwner.error, JSON.stringify(editOwner.error));
    const ownerEtag = (editOwner.result as { etag: string }).etag;
    const blockedOwner = await rpc(svc, "docs.write", {
      workspaceId,
      id: boxId,
      frontmatter: { assignee: "hacker" },
      baseEtag: ownerEtag,
    });
    assert.ok(blockedOwner.error);
    assert.equal(blockedOwner.error!.code, -32010);

    // body-only write still allowed
    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id: boxId });
    const { etag, body } = edit.result as { etag: string; body: string };
    const bodyWrite = await rpc(svc, "docs.write", {
      workspaceId,
      id: boxId,
      body: body + "\nnote\n",
      baseEtag: etag,
    });
    assert.ok(!bodyWrite.error, JSON.stringify(bodyWrite.error));

    const listed = await rpc(svc, "task.list", { workspaceId });
    const tasks = (listed.result as { tasks: { path: string; status: string }[] }).tasks;
    assert.ok(tasks.some((t) => t.path === taskPath && t.status === "taken"));
  });
});

test("docs.write always rejects retired collaboration fields on an idle Node", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "idle-collaboration-fields",
      type: "prompt",
    });
    const id = (created.result as { id: string }).id;

    for (const field of ["owner", "status", "assignee"] as const) {
      const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id });
      const { etag, raw } = edit.result as { etag: string; raw: string };

      const structured = await rpc(svc, "docs.write", {
        workspaceId,
        id,
        frontmatter: { [field]: "retired-value" },
        baseEtag: etag,
      });
      assert.ok(structured.error, `${field} structured write must fail`);
      assert.equal(structured.error!.code, -32010);

      const rawWithRetiredField = raw.replace(
        /^---\r?\n/,
        (opening) => `${opening}${field}: retired-value\n`
      );
      const rawWrite = await rpc(svc, "docs.write", {
        workspaceId,
        id,
        raw: rawWithRetiredField,
        baseEtag: etag,
      });
      assert.ok(rawWrite.error, `${field} raw write must fail`);
      assert.equal(rawWrite.error!.code, -32010);
    }

    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    const { etag, body } = edit.result as { etag: string; body: string };
    const bodyWrite = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: `${body}\nbody-only remains allowed\n`,
      baseEtag: etag,
    });
    assert.ok(!bodyWrite.error, JSON.stringify(bodyWrite.error));
  });
});

test("docs.setMode + docs.write mode gates; raw cannot set mode/id; no read-only", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "mode-note",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const id = (created.result as { id: string }).id;

    const got0 = await rpc(svc, "docs.get", { workspaceId, id });
    const c0 = (got0.result as { concept: { mode: string; archived: boolean } }).concept;
    assert.equal(c0.mode, "editable");
    assert.equal(c0.archived, false);

    // Ordinary body write under editable
    const edit = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    const { etag, body, raw } = edit.result as { etag: string; body: string; raw: string };
    const okWrite = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: body + "\nok\n",
      baseEtag: etag,
    });
    assert.ok(!okWrite.error, JSON.stringify(okWrite.error));

    // frontmatter cannot set mode (reserved)
    const editMode = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    assert.ok(!editMode.error, JSON.stringify(editMode.error));
    const badMode = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      frontmatter: { mode: "archived" },
      baseEtag: (editMode.result as { etag: string }).etag,
    });
    assert.ok(badMode.error);
    assert.equal(badMode.error!.code, -32010);
    assert.match(badMode.error!.message, /reserved|mode/i);

    // read-only mode is retired
    const setRo = await rpc(svc, "docs.setMode", { workspaceId, id, mode: "read-only" });
    assert.ok(setRo.error);
    assert.equal(setRo.error!.code, -32602);
    assert.match(setRo.error!.message, /read-only.*retired|retired in V0\.2/i);

    // editable still writable after rejected read-only attempt
    const stillEditable = await rpc(svc, "docs.get", { workspaceId, id });
    assert.equal((stillEditable.result as { concept: { mode: string } }).concept.mode, "editable");

    // raw cannot inject mode
    const edit2 = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    const raw2 = (edit2.result as { raw: string }).raw;
    const rawBad = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      raw: raw2.replace(/^---\n/, "---\nmode: archived\n"),
      baseEtag: (edit2.result as { etag: string }).etag,
    });
    assert.ok(rawBad.error);
    assert.equal(rawBad.error!.code, -32010);

    const setArch = await rpc(svc, "docs.setMode", { workspaceId, id, mode: "archived" });
    assert.ok(!setArch.error, JSON.stringify(setArch.error));
    assert.equal((setArch.result as { mode: string; archived: boolean }).mode, "archived");
    assert.equal((setArch.result as { archived: boolean }).archived, true);

    const blockedArch = await rpc(svc, "docs.write", { workspaceId, id, body: "x\n" });
    assert.ok(blockedArch.error);
    assert.match(blockedArch.error!.message, /archived/i);

    const restored = await rpc(svc, "docs.setMode", { workspaceId, id, mode: "editable" });
    assert.ok(!restored.error, JSON.stringify(restored.error));
    assert.equal((restored.result as { mode: string }).mode, "editable");

    // editable body write works again
    const edit3 = await rpc(svc, "docs.readForEdit", { workspaceId, id });
    const again = await rpc(svc, "docs.write", {
      workspaceId,
      id,
      body: (edit3.result as { body: string }).body + "\nagain\n",
      baseEtag: (edit3.result as { etag: string }).etag,
    });
    assert.ok(!again.error, JSON.stringify(again.error));
    void raw;
  });
});

test("AgentRuntimePort.* rejected; not in client method table", async () => {
  assert.ok(!CLIENT_METHODS.some((m) => m.startsWith("AgentRuntime")));
  assert.ok(CLIENT_METHODS.includes("docs.setMode"));
  await withService(async (svc) => {
    const res = await rpc(svc, "AgentRuntimePort.startSession", { cwd: "." });
    assert.ok(res.error);
    assert.equal(res.error!.code, -32601);
    assert.match(res.error!.message, /service-internal|not found/i);
  });
});

test("external concept file change fans concept.changed via watch", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const events: string[] = [];
    svc.events.subscribe((ev) => {
      if (ev.type === "concept.changed" && ev.workspaceId === workspaceId) {
        events.push(ev.type);
      }
    });

    // External write under system root (bypass service)
    const notePath = path.join(ws, ".tent", "inbox", "inbox.md");
    const raw = await fs.readFile(notePath, "utf8");
    await fs.writeFile(notePath, raw + "\n<!-- external -->\n", "utf8");

    // Wait for debounced watch
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && events.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(events.length >= 1, "expected concept.changed from watch");
  });
});

test("WorkspaceHost preserves concept and task events from one watch co-burst", async () => {
  const ws = await makeWorkspace("watch-co-burst");
  const events = new EventBus();
  const controlled = createControllableWatchFn();
  const host = new WorkspaceHost({
    events,
    watchFn: controlled.watchFn,
    watchDebounceMs: 20,
  });
  const conceptPaths: string[] = [];
  const taskPaths: string[] = [];
  events.subscribe((event) => {
    const eventPath = String((event.payload as { path?: string }).path ?? "");
    if (event.type === "concept.changed") conceptPaths.push(eventPath);
    if (event.type === "task.state") taskPaths.push(eventPath);
  });

  try {
    await host.mount(ws);
    controlled.fire("change", path.join("inbox", "inbox.md"));
    controlled.fire("rename", path.join("temp", "task-worktree-reclaim-pending.json"));
    controlled.fire("change", "temp");

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && (conceptPaths.length === 0 || taskPaths.length === 0)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(conceptPaths, ["inbox/inbox.md"]);
    assert.equal(taskPaths.length, 1, "temp paths coalesce to one task.state event");
  } finally {
    await host.dispose();
  }
});

test("WorkspaceHost does not retroactively suppress an admitted external event", async () => {
  const ws = await makeWorkspace("watch-ingress-authority");
  const events = new EventBus();
  const controlled = createControllableWatchFn();
  const host = new WorkspaceHost({
    events,
    watchFn: controlled.watchFn,
    watchDebounceMs: 40,
  });
  const conceptPaths: string[] = [];
  events.subscribe((event) => {
    if (event.type === "concept.changed") {
      conceptPaths.push(String((event.payload as { path?: string }).path ?? ""));
    }
  });

  try {
    const mounted = await host.mount(ws);
    controlled.fire("change", path.join("inbox", "inbox.md"));
    host.markSelfWrite(mounted.workspaceId, 200);

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && conceptPaths.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(conceptPaths, ["inbox/inbox.md"]);
  } finally {
    await host.dispose();
  }
});

test("WorkspaceHost scoped self-write suppresses only matching paths", async () => {
  const ws = await makeWorkspace("watch-scoped-self-write");
  const events = new EventBus();
  const controlled = createControllableWatchFn();
  const host = new WorkspaceHost({
    events,
    watchFn: controlled.watchFn,
    watchDebounceMs: 20,
  });
  const conceptPaths: string[] = [];
  const taskPaths: string[] = [];
  events.subscribe((event) => {
    const eventPath = String((event.payload as { path?: string }).path ?? "");
    if (event.type === "concept.changed") conceptPaths.push(eventPath);
    if (event.type === "task.state") taskPaths.push(eventPath);
  });

  try {
    const mounted = await host.mount(ws);
    host.markSelfWrite(mounted.workspaceId, 200, "temp");
    controlled.fire("rename", path.join("temp", "task.json"));
    controlled.fire("change", path.join("inbox", "inbox.md"));

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && conceptPaths.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(conceptPaths, ["inbox/inbox.md"]);
    assert.deepEqual(taskPaths, []);
  } finally {
    await host.dispose();
  }
});

test(
  "WorkspaceHost case-folds Windows suppression and dedupe identity",
  { skip: process.platform !== "win32" },
  async () => {
    const ws = await makeWorkspace("watch-case-fold");
    const events = new EventBus();
    const controlled = createControllableWatchFn();
    const host = new WorkspaceHost({
      events,
      watchFn: controlled.watchFn,
      watchDebounceMs: 20,
    });
    const conceptPaths: string[] = [];
    const taskPaths: string[] = [];
    events.subscribe((event) => {
      const eventPath = String((event.payload as { path?: string }).path ?? "");
      if (event.type === "concept.changed") conceptPaths.push(eventPath);
      if (event.type === "task.state") taskPaths.push(eventPath);
    });

    try {
      const mounted = await host.mount(ws);
      host.markSelfWrite(mounted.workspaceId, 200, "temp");
      controlled.fire("change", "TEMP/Task.md");
      controlled.fire("change", "Inbox/Inbox.md");
      controlled.fire("rename", "inbox/inbox.md");

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && conceptPaths.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(conceptPaths, ["Inbox/Inbox.md"]);
      assert.deepEqual(taskPaths, []);
    } finally {
      await host.dispose();
    }
  }
);

test("mount dead-session reconcile does not suppress an immediate external Node edit", async () => {
  const ws = await makeWorkspace("watch-after-reconcile");
  await withService(async (svc) => {
    const firstMount = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!firstMount.error, JSON.stringify(firstMount.error));
    const workspaceId = (firstMount.result as { workspaceId: string }).workspaceId;

    const created = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "dead-session-watch",
      type: "prompt",
    });
    assert.ok(!created.error, JSON.stringify(created.error));
    const nodeId = (created.result as { id: string }).id;
    const dispatched = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: nodeId,
      role: "executor",
      prompt: "seed dead session reconciliation",
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
    });
    assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
    const taskPath = (dispatched.result as { taskPath: string }).taskPath;
    const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
    assert.ok(!claimed.error, JSON.stringify(claimed.error));

    const sessionId = "ss-watchdead1";
    const now = new Date().toISOString();
    await svc.runtime.registry.write({
      id: sessionId,
      profileId: "fake-default",
      adapterId: FAKE_ADAPTER_ID,
      roleName: "executor",
      state: "stopped",
      workspace: workspaceId,
      lastTaskId: taskPath,
      createdAt: now,
      updatedAt: now,
    });
    const mounted = svc.ctx.host.require(workspaceId);
    await patchTaskEnvelope(mounted.env.fs, taskPath, {
      sessionId,
      updatedAt: mounted.env.clock.now(),
    });
    const unmounted = await rpc(svc, "workspace.unmount", { workspaceId });
    assert.ok(!unmounted.error, JSON.stringify(unmounted.error));

    const conceptPaths: string[] = [];
    const unsubscribe = svc.events.subscribe((event) => {
      if (event.type === "concept.changed") {
        conceptPaths.push(String((event.payload as { path?: string }).path ?? ""));
      }
    });
    try {
      const remounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!remounted.error, JSON.stringify(remounted.error));
      const remountedId = (remounted.result as { workspaceId: string }).workspaceId;

      // The reconcile Task write happens before mount returns and starts a 200ms
      // self-write window. This external write must still be admitted immediately.
      const notePath = path.join(ws, ".tent", "inbox", "inbox.md");
      const raw = await fs.readFile(notePath, "utf8");
      await fs.writeFile(notePath, raw + "\n<!-- immediate after reconcile -->\n", "utf8");

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && conceptPaths.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(
        conceptPaths.some((value) => value.toLowerCase() === "inbox/inbox.md"),
        `expected immediate concept.changed after reconcile; got ${JSON.stringify(conceptPaths)}`
      );

      const taskResult = await rpc(svc, "task.get", {
        workspaceId: remountedId,
        taskPath,
      });
      assert.ok(!taskResult.error, JSON.stringify(taskResult.error));
      assert.equal((taskResult.result as { task: { state: string } }).task.state, "waiting");
    } finally {
      unsubscribe();
    }
  });
});

test("MutationBus serializes concurrent work per workspace", async () => {
  const bus = new MutationBus();
  const order: number[] = [];
  await Promise.all([
    bus.run("w1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    }),
    bus.run("w1", async () => {
      order.push(3);
      order.push(4);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("contentEtag stable for same content", () => {
  assert.equal(contentEtag("a\n"), contentEtag("a\n"));
  assert.notEqual(contentEtag("a\n"), contentEtag("b\n"));
});

test("defaultServiceDataDir respects TENT_SERVICE_DATA_DIR", () => {
  const dir = defaultServiceDataDir({ TENT_SERVICE_DATA_DIR: "C:\\tmp\\tent-data" } as NodeJS.ProcessEnv);
  assert.match(dir.replace(/\\/g, "/"), /tent-data$/);
});

test("service continues after client disconnect (process independent of UI)", async () => {
  // Simulate: open SSE, close it, still RPC works — closing window ≠ stop service
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    await rpc(svc, "workspace.mount", { workspaceRoot: ws });

    const ac = new AbortController();
    const sse = fetch(`${svc.url}/events`, {
      signal: ac.signal,
      headers: { "x-tent-token": svc.token },
    });
    // Give SSE a moment to connect
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    try {
      await sse;
    } catch {
      // aborted
    }

    const health = await rpc(svc, "service.health", {});
    assert.equal((health.result as { status: string }).status, "ok");
  });
});

test("service stop terminates active SSE and releases discovery ownership", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-sse-stop-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  const baselineListeners = svc.events.listenerCount();

  try {
    const response = await fetch(`${svc.url}/events`, {
      headers: { "x-tent-token": svc.token },
    });
    assert.equal(response.status, 200);
    assert.equal(svc.events.listenerCount(), baselineListeners + 1);

    const reader = response.body!.getReader();
    const initial = await reader.read();
    assert.equal(initial.done, false);
    assert.match(new TextDecoder().decode(initial.value), /: ok/);

    let stopTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        svc.stop(),
        new Promise<never>((_, reject) => {
          stopTimer = setTimeout(
            () => reject(new Error("service stop hung behind active SSE")),
            2_000
          );
        }),
      ]);
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
    }

    assert.equal(svc.events.listenerCount(), baselineListeners);
    await assert.rejects(() => fs.access(serviceEndpointPath(dataDir)), /ENOENT/);
    await assert.rejects(() => fs.access(serviceLeasePath(dataDir)), /ENOENT/);
    await assert.rejects(() => fetch(`${svc.url}/health`));

    try {
      await reader.read();
    } catch {
      // Destroyed SSE streams may surface as either EOF or a transport error.
    }
  } finally {
    await svc.stop();
  }
});

test("service stop drains an accepted finite RPC before releasing its lease", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-b2-rpc-drain-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "service.health",
    params: {},
  });

  try {
    const response = new Promise<string>((resolve, reject) => {
      const req = http.request(
        `${svc.url}/rpc`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            "x-tent-token": svc.token,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }
      );
      req.on("error", reject);
      req.write(payload.slice(0, 12));

      setTimeout(() => req.end(payload.slice(12)), 100);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    let stopped = false;
    const stopping = svc.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(stopped, false, "shutdown must wait for an already accepted RPC");
    await fs.access(serviceLeasePath(dataDir));

    const raw = await response;
    assert.equal((JSON.parse(raw) as { result?: { status?: string } }).result?.status, "ok");
    await stopping;
    assert.equal(stopped, true);
    await assert.rejects(() => fs.access(serviceLeasePath(dataDir)), /ENOENT/);
  } finally {
    await svc.stop();
  }
});
