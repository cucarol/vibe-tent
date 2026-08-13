/**
 * requester single-source review authority + explicit Task outcome.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter.js";
import { contentEtag } from "../src/core/etag.js";
import {
  assertReviewAuthority,
  allowsNonReviewAcceptMode,
  parseTaskOutcomeReport,
  TaskLifecycleError,
} from "../src/core/task-model.js";
import {
  loadTaskRecord,
  patchTaskRecord,
  resolveDispatchRequester,
  writeTaskRecord,
} from "../src/core/task.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";

function nodeSnapshot(id: string, nodePath: string, body = "") {
  return { id, path: nodePath, type: "prompt", tags: [], body, etag: contentEtag(body) };
}

test("parseTaskOutcomeReport: only blocked is a control; normal and decision-shaped reports remain content", () => {
  assert.equal(parseTaskOutcomeReport("outcome: delivered\n\nAll good"), null);
  assert.deepEqual(
    parseTaskOutcomeReport("---\noutcome: blocked\n---\nCannot proceed"),
    { outcome: "blocked", report: "Cannot proceed" }
  );
  assert.equal(parseTaskOutcomeReport("outcome: needs-input\nWhich API?"), null);
  assert.equal(parseTaskOutcomeReport("Just a free-form report"), null);
  assert.equal(parseTaskOutcomeReport("outcome: weird\nnope"), null);
  assert.equal(parseTaskOutcomeReport(""), null);
});

test("allowsNonReviewAcceptMode: only user parent responsibility may elevate", () => {
  assert.equal(
    allowsNonReviewAcceptMode({ requester: { kind: "user", id: "user" } }),
    true
  );
  assert.equal(
    allowsNonReviewAcceptMode({ requester: { kind: "role", id: "rl-planner" } }),
    false
  );
});

test("assertReviewAuthority derives exact reviewer authority from requester", () => {
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        executorRoleId: "rl-helper",
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );

  const roleParent = { kind: "role" as const, id: "rl-planner" };
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "rl-planner",
      executorRoleId: "rl-helper",
      requester: roleParent,
      action: "accept",
    })
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "user",
        executorRoleId: "rl-helper",
        requester: roleParent,
        action: "reject",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "REVIEW_FORBIDDEN"
  );
  assert.throws(
    () =>
      assertReviewAuthority({
        actor: "rl-helper",
        executorRoleId: "rl-helper",
        requester: roleParent,
        action: "accept",
      }),
    (err: unknown) => err instanceof TaskLifecycleError && err.code === "SELF_ACCEPT_FORBIDDEN"
  );
  assert.doesNotThrow(() =>
    assertReviewAuthority({
      actor: "user",
      executorRoleId: "rl-helper",
      requester: { kind: "user", id: "user" },
      action: "accept",
    })
  );
});

test("writeTaskRecord persists requester only and rejects legacy reviewer on reload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-wire-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  const taskPath = await writeTaskRecord(fsa, new SystemClock(), {
    assigneeRoleId: "rl-helper",
    workNodeIds: ["cx-1"],
    contextNodeIds: [],
    nodeSnapshots: [nodeSnapshot("cx-1", "a.md")],
    manifestPath: "temp/helper/manifest.yml",
    prompt: "do it",
    requester: { kind: "role", id: "rl-orchestrator" },
  });
  const raw = await fsa.readFile(taskPath);
  assert.match(raw, /^requester:/m);
  assert.doesNotMatch(raw, /^reviewer:/m);
  const task = await loadTaskRecord(fsa, taskPath);
  assert.equal(task.requester?.id, "rl-orchestrator");

  const persisted = parseFrontmatter(raw);
  persisted.data.reviewer = { kind: "role", id: "rl-orchestrator" };
  await fsa.writeFile(
    taskPath,
    serializeFrontmatter(persisted.data, persisted.body, persisted.keyOrder)
  );
  await assert.rejects(
    () => loadTaskRecord(fsa, taskPath),
    /retired reviewer field; use requester/i
  );
  const corruptBytes = await fsa.readFile(taskPath);
  await assert.rejects(
    () => patchTaskRecord(fsa, taskPath, { state: "running" }),
    /retired reviewer field; use requester/i
  );
  assert.equal(await fsa.readFile(taskPath), corruptBytes);
});

test("retired authority field presence fails loud on load and patch", async () => {
  for (const [field, value] of [
    ["reviewer", null],
    ["reviewer", { kind: "user", id: "user" }],
    ["dispatchedBy", null],
    ["dispatchedBy", "rl-legacy"],
  ] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `tent-retired-${field}-`));
    const fsa = new NodeFs(dir);
    await fsa.mkdir("temp/helper/tasks");
    const taskPath = await writeTaskRecord(fsa, new SystemClock(), {
      assigneeRoleId: "rl-helper",
      workNodeIds: ["cx-1"],
      contextNodeIds: [],
      nodeSnapshots: [nodeSnapshot("cx-1", "a.md")],
      manifestPath: "temp/helper/manifest.yml",
      prompt: "do it",
      requester: { kind: "user", id: "user" },
    });
    const persisted = parseFrontmatter(await fsa.readFile(taskPath));
    persisted.data[field] = value;
    await fsa.writeFile(
      taskPath,
      serializeFrontmatter(persisted.data, persisted.body, persisted.keyOrder)
    );
    const corruptBytes = await fsa.readFile(taskPath);
    const expected = new RegExp(`retired ${field} field; use requester`, "i");
    await assert.rejects(() => loadTaskRecord(fsa, taskPath), expected);
    await assert.rejects(
      () => patchTaskRecord(fsa, taskPath, { state: "running" }),
      expected
    );
    assert.equal(await fsa.readFile(taskPath), corruptBytes);
  }
});

test("dispatch parent authority requires one canonical requester", () => {
  assert.throws(
    () => resolveDispatchRequester({} as never),
    /requires explicit requester/i
  );
  assert.deepEqual(
    resolveDispatchRequester({ requester: { kind: "role", id: "rl-planner" } }),
    { kind: "role", id: "rl-planner" }
  );
});

test("writeTaskRecord refuses elevated policy for downstream Task Agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-policy-"));
  const fsa = new NodeFs(dir);
  await fsa.mkdir("temp/helper/tasks");
  await assert.rejects(
    () =>
      writeTaskRecord(fsa, new SystemClock(), {
        assigneeRoleId: "rl-helper",
        workNodeIds: ["cx-1"],
        contextNodeIds: [],
        nodeSnapshots: [nodeSnapshot("cx-1", "a.md")],
        manifestPath: "temp/helper/manifest.yml",
        prompt: "do it",
        requester: { kind: "role", id: "rl-orchestrator" },
        acceptMode: "auto-accept",
      }),
    /only legal for a user-facing Task|must use review-required/i
  );
});

test("task.dispatch hard-rejects reviewer input and projects requester only", async () => {
  const { scaffoldInWorkspace } = await import("../src/core/scaffold.js");
  const { startLocalTentService } = await import("../src/service/service.js");
  const { rpcCall } = await import("../src/service/http-server.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-rpc-"));
  const fsa = new NodeFs(dir);
  await scaffoldInWorkspace(fsa, {
    name: "parent-rpc",
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify({ roles: [{ id: "rl-executor", name: "executor", prompt: "do work" }] }, null, 2) + "\n"
  );
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-parent-rpc-data-"));
  const svc = await startLocalTentService({ dataDir, host: "127.0.0.1", port: 0 });
  try {
    const mounted = await rpcCall(
      svc.url,
      "workspace.mount",
      { workspaceRoot: dir },
      { token: svc.token }
    );
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
    const created = await rpcCall(
      svc.url,
      "docs.createNote",
      { workspaceId, name: "review-wire", type: "prompt" },
      { token: svc.token }
    );
    const nodeId = (created.result as { nodeId: string }).nodeId;

    const dispatchBase = {
      workspaceId,
      workNodeIds: [nodeId],
      contextNodeIds: [],
      assigneeRoleId: "rl-executor",
      prompt: "parent single source",
      requester: { kind: "user", id: "user" },
    };
    for (const [field, value] of [
      ["reviewer", { kind: "user", id: "user" }],
      ["dispatchedBy", "user"],
      ["callerKind", "user"],
    ] as const) {
      const retired = await rpcCall(
        svc.url,
        "task.dispatch",
        { ...dispatchBase, [field]: value },
        { token: svc.token }
      );
      assert.equal(retired.error?.code, -32602);
      assert.match(String(retired.error?.message), new RegExp(`unknown parameter.*${field}`, "i"));
    }
    const missingParent = await rpcCall(
      svc.url,
      "task.dispatch",
      (({ requester: _requester, ...rest }) => rest)(dispatchBase),
      { token: svc.token }
    );
    assert.equal(missingParent.error?.code, -32602);
    assert.match(String(missingParent.error?.message), /requires explicit requester/i);

    const result = await rpcCall(
      svc.url,
      "task.dispatch",
      dispatchBase,
      { token: svc.token }
    );
    assert.ok(!result.error, JSON.stringify(result.error));
    const projected = result.result as {
      taskPath: string;
      requester?: { kind: string; id: string };
      reviewer?: unknown;
    };
    assert.deepEqual(projected.requester, { kind: "user", id: "user" });
    assert.equal(projected.reviewer, undefined);
    const raw = await fs.readFile(path.join(dir, ".tent", projected.taskPath), "utf8");
    assert.doesNotMatch(raw, /^reviewer:/m);

    const parsed = parseFrontmatter(raw);
    delete parsed.data.requester;
    await fsa.writeFile(
      path.join(dir, ".tent", projected.taskPath),
      serializeFrontmatter(parsed.data, parsed.body, parsed.keyOrder)
    );
    const corruptProjection = await rpcCall(
      svc.url,
      "task.get",
      { workspaceId, taskPath: projected.taskPath },
      { token: svc.token }
    );
    assert.ok(corruptProjection.error, "public projection must fail loud without requester");
    assert.match(String(corruptProjection.error?.message), /missing requester/i);
  } finally {
    await svc.stop();
  }
});
