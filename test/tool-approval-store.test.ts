/**
 * ToolApprovalStore concurrency + atomic persistence.
 * Machine-local only — no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  ToolApprovalStore,
  makeToolApprovalId,
  type ToolPendingApproval,
} from "../src/service/tool-approval-store.js";
import { writeJsonAtomic } from "../src/machine-state.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function pending(partial: Partial<ToolPendingApproval> & { id: string }): ToolPendingApproval {
  const now = Date.now();
  return {
    workspaceId: "ws-1",
    sessionId: "ss-1",
    toolTitle: "read_file",
    options: [{ optionId: "allow_once", kind: "allow_once" }],
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...partial,
  };
}

test("tool approval store: concurrent resolve/expire cannot resurrect pending", async () => {
  const dataDir = await tempDir("tent-tool-appr-race-");
  const store = new ToolApprovalStore(dataDir);
  const id = makeToolApprovalId(() => 0.42);
  await store.add(pending({ id }));

  // Race: expire vs approve vs cancelSession — only one terminal winner; no pending left.
  const results = await Promise.allSettled([
    store.expireOne(id),
    store.resolve(id, "approved", "user"),
    store.cancelSession("ss-1", "denied"),
    store.resolve(id, "denied", "user"),
  ]);

  const item = await store.get(id);
  assert.ok(item);
  assert.notEqual(item!.status, "pending", "must not remain pending after concurrent terminal ops");
  assert.ok(
    item!.status === "expired" || item!.status === "approved" || item!.status === "denied",
    `unexpected status ${item!.status}`
  );

  // Late approve after terminal must fail (not resurrect).
  await assert.rejects(
    () => store.resolve(id, "approved", "user"),
    /already (expired|approved|denied)/
  );

  // Disk must agree — reload fresh store instance.
  const reloaded = new ToolApprovalStore(dataDir);
  const disk = await reloaded.get(id);
  assert.ok(disk);
  assert.equal(disk!.status, item!.status);
  assert.notEqual(disk!.status, "pending");

  // At least one of the concurrent ops settled (others may reject as already terminal).
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);
});

test("tool approval store: session remains pending until every request resolves", async () => {
  const dataDir = await tempDir("tent-tool-appr-session-barrier-");
  const store = new ToolApprovalStore(dataDir);
  const firstId = makeToolApprovalId(() => 0.31);
  const secondId = makeToolApprovalId(() => 0.63);
  await store.add(pending({ id: firstId, toolTitle: "read_file" }));
  await store.add(pending({ id: secondId, toolTitle: "write_file" }));

  assert.equal(await store.hasPendingForSession("ss-1"), true);
  await store.resolve(firstId, "approved", "user");
  assert.equal(
    await store.hasPendingForSession("ss-1"),
    true,
    "one resolved request must not release another pending request"
  );
  await store.resolve(secondId, "denied", "user");
  assert.equal(await store.hasPendingForSession("ss-1"), false);
});

test("tool approval store: service restart expires orphaned pending requests", async () => {
  const dataDir = await tempDir("tent-tool-appr-restart-");
  const id = makeToolApprovalId(() => 0.37);
  const first = new ToolApprovalStore(dataDir);
  await first.add(pending({ id }));

  const restarted = new ToolApprovalStore(dataDir);
  const recovered = await restarted.get(id);
  assert.equal(recovered?.status, "expired");
  assert.equal(recovered?.resolvedBy, "service-restart");
  assert.ok(recovered?.resolvedAt);
  assert.deepEqual(await restarted.listPending("ws-1"), []);
  await assert.rejects(
    () => restarted.resolve(id, "approved", "user"),
    /already expired/
  );

  const disk = JSON.parse(
    await fs.readFile(path.join(dataDir, "tool-approvals.json"), "utf8")
  ) as { items: ToolPendingApproval[] };
  assert.equal(disk.items.find((item) => item.id === id)?.status, "expired");
  assert.equal(
    disk.items.find((item) => item.id === id)?.resolvedBy,
    "service-restart"
  );
});

test("tool approval store: atomic temp rename leaves valid JSON after concurrent writes", async () => {
  const dataDir = await tempDir("tent-tool-appr-atomic-");
  const store = new ToolApprovalStore(dataDir);

  const ids = Array.from({ length: 8 }, (_, i) => makeToolApprovalId(() => (i + 1) / 20));
  await Promise.all(
    ids.map((id, i) =>
      store.add(
        pending({
          id,
          sessionId: `ss-${i}`,
          toolTitle: `tool-${i}`,
        })
      )
    )
  );

  // Concurrent terminal mutations.
  await Promise.all([
    ...ids.slice(0, 4).map((id) => store.expireOne(id)),
    ...ids.slice(4).map((id) => store.resolve(id, "denied", "user").catch(() => undefined)),
  ]);

  const raw = await fs.readFile(path.join(dataDir, "tool-approvals.json"), "utf8");
  const parsed = JSON.parse(raw) as { items: ToolPendingApproval[] };
  assert.ok(Array.isArray(parsed.items));
  assert.equal(
    parsed.items.filter((i) => i.status === "pending").length,
    0,
    "no pending rows should survive concurrent expire/deny"
  );
});

test("tool approval store: waitForDecision expires and late approve fails", async () => {
  const dataDir = await tempDir("tent-tool-appr-to-");
  const store = new ToolApprovalStore(dataDir);
  const id = makeToolApprovalId(() => 0.7);
  const now = Date.now();
  await store.add(
    pending({
      id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 80).toISOString(),
    })
  );

  const decision = await store.waitForDecision(id, 80);
  assert.equal(decision, "expired");

  const item = await store.get(id);
  assert.equal(item?.status, "expired");
  assert.equal(item?.resolvedBy, "timeout");

  await assert.rejects(
    () => store.resolve(id, "approved", "user"),
    /already expired/
  );
});

test("tool approval store: persistence failure rolls back state and does not wake waiters", async () => {
  const dataDir = await tempDir("tent-tool-appr-rollback-");
  let failWrites = true;
  const store = new ToolApprovalStore(dataDir, {
    writeState: async (file, value) => {
      if (failWrites) throw new Error("injected tool persist failure");
      await writeJsonAtomic(file, value);
    },
  });
  const id = makeToolApprovalId(() => 0.81);

  await assert.rejects(
    () => store.add(pending({ id })),
    /injected tool persist failure/
  );
  assert.equal(await store.get(id), undefined, "failed add must not leak into memory");

  failWrites = false;
  await store.add(pending({ id }));
  let waiterSettled = false;
  const waiting = store.waitForDecision(id, 2_000).then((decision) => {
    waiterSettled = true;
    return decision;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  failWrites = true;
  await assert.rejects(
    () => store.resolve(id, "approved", "user"),
    /injected tool persist failure/
  );
  assert.equal((await store.get(id))?.status, "pending");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(waiterSettled, false, "failed persistence must not notify ACP waiter");

  await assert.rejects(
    () => store.cancelSession("ss-1", "denied"),
    /injected tool persist failure/
  );
  assert.equal((await store.get(id))?.status, "pending");

  await assert.rejects(
    () => store.expireOne(id),
    /injected tool persist failure/
  );
  assert.equal((await store.get(id))?.status, "pending");

  const disk = JSON.parse(
    await fs.readFile(path.join(dataDir, "tool-approvals.json"), "utf8")
  ) as { items: ToolPendingApproval[] };
  assert.equal(
    disk.items.find((item) => item.id === id)?.status,
    "pending",
    "failed mutation must leave the old disk snapshot intact"
  );

  failWrites = false;
  assert.equal((await store.resolve(id, "approved", "user")).status, "approved");
  assert.equal(await waiting, "approved");
});

test("tool approval store: stale-expiry write failure keeps pending until a retry commits", async () => {
  const dataDir = await tempDir("tent-tool-appr-stale-rollback-");
  let failWrites = false;
  const store = new ToolApprovalStore(dataDir, {
    writeState: async (file, value) => {
      if (failWrites) throw new Error("injected stale persist failure");
      await writeJsonAtomic(file, value);
    },
  });
  const id = makeToolApprovalId(() => 0.91);
  await store.add(
    pending({
      id,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
  );

  failWrites = true;
  await assert.rejects(() => store.get(id), /injected stale persist failure/);
  const raw = JSON.parse(
    await fs.readFile(path.join(dataDir, "tool-approvals.json"), "utf8")
  ) as { items: ToolPendingApproval[] };
  assert.equal(raw.items.find((item) => item.id === id)?.status, "pending");

  failWrites = false;
  assert.equal((await store.get(id))?.status, "expired");
});

test("tool approval store: timeout fails closed when expiry persistence is unavailable", async () => {
  const dataDir = await tempDir("tent-tool-appr-timeout-failclosed-");
  let failWrites = false;
  const store = new ToolApprovalStore(dataDir, {
    writeState: async (file, value) => {
      if (failWrites) throw new Error("injected timeout persist failure");
      await writeJsonAtomic(file, value);
    },
  });
  const id = makeToolApprovalId(() => 0.95);
  await store.add(
    pending({
      id,
      expiresAt: new Date(Date.now() + 40).toISOString(),
    })
  );

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    failWrites = true;
    assert.equal(await store.waitForDecision(id, 40), "expired");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);

    const raw = JSON.parse(
      await fs.readFile(path.join(dataDir, "tool-approvals.json"), "utf8")
    ) as { items: ToolPendingApproval[] };
    assert.equal(raw.items.find((item) => item.id === id)?.status, "pending");

    failWrites = false;
    assert.equal((await store.get(id))?.status, "expired");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
