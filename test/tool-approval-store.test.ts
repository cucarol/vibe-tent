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
