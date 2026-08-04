import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FocusDocumentController,
  type FocusDocumentGateway,
} from "../src/desktop/renderer-next/model/focus-document-controller.js";
import type {
  DocumentRead,
  FocusBacklinks,
  FocusDocumentSnapshot,
  FocusDocumentWrite,
} from "../src/desktop/renderer-next/gateway/document-protocol.js";
import { handleDesktopDocumentRequest } from "../src/desktop/main/document-ipc-handler.js";
import { ServiceRpcError } from "../src/desktop/client/rpc-client.js";
import {
  readFocusDocument,
  writeFocusDocumentBody,
} from "../src/desktop/renderer-next/gateway/document-protocol.js";

const now = "2026-08-04T00:00:00.000Z";

function snapshot(nodeId: string, body: string, etag: string): FocusDocumentSnapshot {
  return {
    workspaceId: "ws-a",
    nodeId,
    path: `Docs/${nodeId}`,
    name: nodeId,
    type: "prompt",
    body,
    raw: `---\nid: ${nodeId}\n---\n${body}`,
    frontmatter: { id: nodeId, type: "prompt" },
    etag,
    artifactRefs: [],
  };
}

function ok<T>(nodeId: string, value: T): DocumentRead<T> {
  return { ok: true, workspaceId: "ws-a", nodeId, value, fetchedAt: now };
}

function emptyBacklinks(nodeId: string): DocumentRead<FocusBacklinks> {
  return ok(nodeId, { workspaceId: "ws-a", nodeId, backlinks: [] });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("save keeps edits typed during the held write and queued self invalidation stays clean", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  let resolveWrite!: (value: DocumentRead<FocusDocumentWrite>) => void;
  const heldWrite = new Promise<DocumentRead<FocusDocumentWrite>>((resolve) => {
    resolveWrite = resolve;
  });
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => heldWrite,
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.beginEdit();
  controller.updateBody("A");
  const saving = controller.actions().save();
  assert.equal(controller.getView().status, "saving");
  controller.updateBody("B");
  const invalidation = controller.invalidate();
  disk = snapshot("cx-a", "A", "etag-2");
  resolveWrite(ok("cx-a", {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    path: disk.path,
    etag: disk.etag,
  }));
  await Promise.all([saving, invalidation]);
  await flush();
  const view = controller.getView();
  assert.equal(view.body, "B");
  assert.equal(view.etag, "etag-2");
  assert.equal(view.dirty, true);
  assert.equal(view.status, "dirty");
  assert.equal(view.diskBody, undefined);
});

test("offline transition makes every cached entry stale and a new selection fail closed", async () => {
  const disk = new Map([
    ["cx-a", snapshot("cx-a", "A", "a-1")],
    ["cx-b", snapshot("cx-b", "B", "b-1")],
  ]);
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk.get(nodeId)!),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => {
      throw new Error("not used");
    },
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.select("ws-a", "cx-b");
  await flush();
  controller.beginEdit();
  controller.updateBody("B draft");
  controller.select("ws-a", "cx-a");
  controller.setOnline(false);

  controller.select("ws-a", "cx-b");
  assert.equal(controller.getView().status, "stale");
  assert.equal(controller.getView().body, "B draft");
  assert.equal(controller.getView().dirty, true);
  assert.equal(controller.getView().canSave, false);

  controller.select("ws-a", "cx-c");
  assert.equal(controller.getView().status, "error");
  assert.equal(controller.getView().etag, undefined);
  assert.equal(controller.getView().canSave, false);
  assert.match(controller.getView().message ?? "", /连接已中断/);
});

test("a read that settles after disconnect cannot make the document authoritative", async () => {
  let resolveRead!: (value: DocumentRead<FocusDocumentSnapshot>) => void;
  const heldRead = new Promise<DocumentRead<FocusDocumentSnapshot>>((resolve) => {
    resolveRead = resolve;
  });
  const gateway: FocusDocumentGateway = {
    focusDocument: async () => heldRead,
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => {
      throw new Error("not used");
    },
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  assert.equal(controller.getView().status, "loading");
  controller.setOnline(false);
  assert.equal(controller.getView().status, "error");
  resolveRead(ok("cx-a", snapshot("cx-a", "late", "etag-late")));
  await flush();
  await flush();
  assert.equal(controller.getView().status, "error");
  assert.equal(controller.getView().etag, undefined);
  assert.equal(controller.getView().canSave, false);
});

test("a write that settles after disconnect stays stale until reconnect rereads", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  let resolveWrite!: (value: DocumentRead<FocusDocumentWrite>) => void;
  const heldWrite = new Promise<DocumentRead<FocusDocumentWrite>>((resolve) => {
    resolveWrite = resolve;
  });
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => heldWrite,
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.beginEdit();
  controller.updateBody("local draft");
  const saving = controller.actions().save();
  controller.setOnline(false);
  resolveWrite(ok("cx-a", {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    path: disk.path,
    etag: "etag-2",
  }));
  await saving;
  assert.equal(controller.getView().status, "stale");
  assert.equal(controller.getView().body, "local draft");
  assert.equal(controller.getView().etag, "etag-1");
  assert.equal(controller.getView().dirty, true);
  assert.equal(controller.getView().canSave, false);

  disk = snapshot("cx-a", "external writer", "etag-3");
  controller.setOnline(true);
  await flush();
  await flush();
  assert.equal(controller.getView().status, "conflict");
  assert.equal(controller.getView().body, "local draft");
  assert.equal(controller.getView().diskBody, "external writer");
  assert.equal(controller.getView().canSave, false);
});

test("document wire rejects corrupt identity and preserves structured etag errors", async () => {
  const mismatch = await readFocusDocument(
    async () => ({ ok: true, value: snapshot("cx-wrong", "body", "etag") }),
    "ws-a",
    "cx-a"
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.issue.kind, "corrupt");

  const conflict = await writeFocusDocumentBody(
    async () => ({
      ok: false,
      error: {
        kind: "rpc",
        code: -32009,
        message: "etag conflict",
        data: { currentEtag: "etag-2" },
      },
    }),
    "ws-a",
    "cx-a",
    "local",
    "etag-1"
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.issue.code, -32009);
    assert.deepEqual(conflict.issue.data, { currentEtag: "etag-2" });
  }

  const rejected = await readFocusDocument(
    async () => {
      throw new Error("ECONNRESET");
    },
    "ws-a",
    "cx-a"
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.issue.kind, "transport");

  const malformedEnvelope = await readFocusDocument(
    async () => ({ nope: true }) as never,
    "ws-a",
    "cx-a"
  );
  assert.equal(malformedEnvelope.ok, false);
  if (!malformedEnvelope.ok) assert.equal(malformedEnvelope.issue.kind, "corrupt");
});

test("desktop document IPC keeps write body-only and preserves JSON-RPC code/data", async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client = {
    call: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "docs.write") {
        throw new ServiceRpcError({
          code: -32009,
          message: "etag conflict",
          data: { currentEtag: "etag-2" },
        });
      }
      return {} as T;
    },
  };
  const result = await handleDesktopDocumentRequest(client, {
    operation: "writeBody",
    workspaceId: "ws-a",
    nodeId: "cx-a",
    body: "next",
    baseEtag: "etag-1",
    raw: "must not cross",
    frontmatter: { type: "output" },
  });
  assert.deepEqual(calls, [{
    method: "docs.write",
    params: {
      workspaceId: "ws-a",
      nodeId: "cx-a",
      body: "next",
      baseEtag: "etag-1",
    },
  }]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "rpc");
    assert.equal(result.error.code, -32009);
    assert.deepEqual(result.error.data, { currentEtag: "etag-2" });
  }
});

test("failed held write consumes queued invalidation and converges when the server committed", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  let resolveWrite!: (value: DocumentRead<FocusDocumentWrite>) => void;
  const heldWrite = new Promise<DocumentRead<FocusDocumentWrite>>((resolve) => {
    resolveWrite = resolve;
  });
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => heldWrite,
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.beginEdit();
  controller.updateBody("committed despite timeout");
  const saving = controller.actions().save();
  const invalidation = controller.invalidate();
  disk = snapshot("cx-a", "committed despite timeout", "etag-2");
  resolveWrite({
    ok: false,
    workspaceId: "ws-a",
    nodeId: "cx-a",
    issue: { kind: "timeout", message: "renderer deadline" },
    failedAt: now,
  });
  await Promise.all([saving, invalidation]);
  assert.equal(controller.getView().status, "saved");
  assert.equal(controller.getView().etag, "etag-2");
  assert.equal(controller.getView().dirty, false);
  assert.equal(controller.getView().diskBody, undefined);
});

test("clean invalidation refreshes while dirty invalidation preserves a conflict draft", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => {
      throw new Error("not used");
    },
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();

  disk = snapshot("cx-a", "external clean", "etag-2");
  await controller.invalidate();
  assert.equal(controller.getView().body, "external clean");
  assert.equal(controller.getView().etag, "etag-2");
  assert.equal(controller.getView().status, "read");

  controller.beginEdit();
  controller.updateBody("local draft");
  disk = snapshot("cx-a", "external conflict", "etag-3");
  await controller.invalidate();
  assert.equal(controller.getView().status, "conflict");
  assert.equal(controller.getView().body, "local draft");
  assert.equal(controller.getView().diskBody, "external conflict");
  assert.equal(controller.getView().dirty, true);

  controller.actions().loadDisk();
  assert.equal(controller.getView().body, "external conflict");
  assert.equal(controller.getView().etag, "etag-3");
  assert.equal(controller.getView().dirty, false);
});

test("conflict overwrite exposes saving before the replacement write settles", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  let resolveWrite!: (value: DocumentRead<FocusDocumentWrite>) => void;
  const heldWrite = new Promise<DocumentRead<FocusDocumentWrite>>((resolve) => {
    resolveWrite = resolve;
  });
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => heldWrite,
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.beginEdit();
  controller.updateBody("local");
  disk = snapshot("cx-a", "external", "etag-2");
  await controller.invalidate();
  assert.equal(controller.getView().status, "conflict");
  const overwrite = controller.actions().overwriteWithLocal();
  assert.equal(controller.getView().status, "saving");
  resolveWrite(ok("cx-a", {
    workspaceId: "ws-a",
    nodeId: "cx-a",
    path: disk.path,
    etag: "etag-3",
  }));
  await overwrite;
  assert.equal(controller.getView().status, "saved");
  assert.equal(controller.getView().body, "local");
});

test("disconnect recovery compares authoritative etag without losing the session draft", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => {
      throw new Error("not used");
    },
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.beginEdit();
  controller.updateBody("local draft");
  controller.setOnline(false);
  assert.equal(controller.getView().status, "stale");
  assert.equal(controller.getView().canSave, false);

  controller.setOnline(true);
  await flush();
  assert.equal(controller.getView().status, "dirty");
  assert.equal(controller.getView().body, "local draft");

  controller.setOnline(false);
  disk = snapshot("cx-a", "external", "etag-2");
  controller.setOnline(true);
  await flush();
  assert.equal(controller.getView().status, "conflict");
  assert.equal(controller.getView().body, "local draft");
  assert.equal(controller.getView().diskBody, "external");
});

test("disconnect hides conflict actions until an authoritative reread restores the conflict", async () => {
  let disk = snapshot("cx-a", "base", "etag-1");
  const writes: string[] = [];
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => ok(nodeId, disk),
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async (_workspaceId, _nodeId, body) => {
      writes.push(body);
      return ok("cx-a", {
        workspaceId: "ws-a",
        nodeId: "cx-a",
        path: disk.path,
        etag: "etag-write",
      });
    },
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.beginEdit();
  controller.updateBody("local draft");
  disk = snapshot("cx-a", "external", "etag-2");
  await controller.invalidate();
  assert.equal(controller.getView().status, "conflict");

  controller.setOnline(false);
  assert.equal(controller.getView().status, "stale");
  controller.actions().loadDisk();
  await controller.actions().overwriteWithLocal();
  assert.equal(controller.getView().body, "local draft");
  assert.equal(writes.length, 0);

  controller.setOnline(true);
  await flush();
  await flush();
  assert.equal(controller.getView().status, "conflict");
  assert.equal(controller.getView().body, "local draft");
  assert.equal(controller.getView().diskBody, "external");
});

test("selecting another stale cached node after reconnect forces an authoritative etag read", async () => {
  const disk = new Map([
    ["cx-a", snapshot("cx-a", "A", "a-1")],
    ["cx-b", snapshot("cx-b", "B", "b-1")],
  ]);
  const reads = new Map<string, number>();
  const gateway: FocusDocumentGateway = {
    focusDocument: async (_workspaceId, nodeId) => {
      reads.set(nodeId, (reads.get(nodeId) ?? 0) + 1);
      return ok(nodeId, disk.get(nodeId)!);
    },
    focusBacklinks: async (_workspaceId, nodeId) => emptyBacklinks(nodeId),
    writeFocusDocumentBody: async () => {
      throw new Error("not used");
    },
  };
  const controller = new FocusDocumentController(gateway);
  controller.select("ws-a", "cx-a");
  await flush();
  controller.select("ws-a", "cx-b");
  await flush();
  controller.beginEdit();
  controller.updateBody("B draft");
  controller.select("ws-a", "cx-a");
  controller.setOnline(false);
  disk.set("cx-b", snapshot("cx-b", "B external", "b-2"));

  controller.setOnline(true);
  await flush();
  controller.select("ws-a", "cx-b");
  assert.equal(controller.getView().status, "stale");
  assert.equal(controller.getView().canSave, false);
  await flush();
  assert.equal(reads.get("cx-b"), 2);
  assert.equal(controller.getView().status, "conflict");
  assert.equal(controller.getView().body, "B draft");
  assert.equal(controller.getView().diskBody, "B external");
});
