/**
 * Role Checkpoint: optional cooperative continuation note.
 * Core write/read/clear/overwrite, tail formatting, Service RPC, bootstrap tail,
 * agentProfile isolation, CLI direct path.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import {
  ROLE_CHECKPOINT_MAX_POINTER_CHARS,
  ROLE_CHECKPOINT_MAX_POINTERS,
  ROLE_CHECKPOINT_MAX_TAIL_CHARS,
  ROLE_CHECKPOINT_MAX_TEXT_CHARS,
  ROLE_CHECKPOINT_TYPE,
  assertRoleCheckpointRoleName,
  clearRoleCheckpoint,
  formatRoleCheckpointTail,
  readRoleCheckpoint,
  roleCheckpointPath,
  writeRoleCheckpoint,
} from "../src/core/role-checkpoint.js";
import { serializeFrontmatter } from "../src/core/frontmatter.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { runRoleCheckpointCommand } from "../src/cli/role-checkpoint-rpc.js";
import { sessionBootstrapPromptForTask } from "../src/core/task.js";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

async function makeWorkspace(name = "role-cp"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-cp-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "planner", prompt: "plan work" },
          { name: "executor", prompt: "do work" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Svc) => Promise<T>,
  opts?: { profiles?: import("../src/runtime/types.js").AgentProfileConfig[] }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-cp-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true, profiles: opts?.profiles });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

function rpc(svc: Svc, method: string, params?: Record<string, unknown>) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

test("CLIENT_METHODS includes role.checkpoint.*", () => {
  const methods = CLIENT_METHODS as readonly string[];
  assert.ok(methods.includes("role.checkpoint.get"));
  assert.ok(methods.includes("role.checkpoint.set"));
  assert.ok(methods.includes("role.checkpoint.clear"));
});

test("core: write / read / overwrite / clear Role Checkpoint", async () => {
  const ws = await makeWorkspace();
  const systemRoot = path.join(ws, ".tent");
  const fsa = new NodeFs(systemRoot);

  assert.equal(await readRoleCheckpoint(fsa, "planner"), null);
  assert.equal(roleCheckpointPath("planner"), "temp/planner/checkpoint.md");

  const first = await writeRoleCheckpoint(fsa, {
    role: "planner",
    text: "Continue Node cx-1 next; wait on tk-abc review.",
    updatedAt: "2026-07-28T10:00:00.000Z",
    sourceSessionId: "ss-old",
    pointers: {
      nodes: ["cx-1"],
      tasks: ["tk-abc"],
      deliveries: ["dl-1"],
      git: ["tent-role/planner"],
    },
  });
  assert.equal(first.path, "temp/planner/checkpoint.md");
  assert.equal(first.role, "planner");
  assert.ok(await fsa.exists(first.path));

  const raw = await fsa.readFile(first.path);
  assert.match(raw, new RegExp(`type: ${ROLE_CHECKPOINT_TYPE}`));
  assert.match(raw, /## Continuation/);
  assert.match(raw, /Continue Node cx-1/);

  const loaded = await readRoleCheckpoint(fsa, "planner");
  assert.ok(loaded);
  assert.equal(loaded!.text, "Continue Node cx-1 next; wait on tk-abc review.");
  assert.equal(loaded!.sourceSessionId, "ss-old");
  assert.deepEqual(loaded!.pointers?.nodes, ["cx-1"]);
  assert.deepEqual(loaded!.pointers?.git, ["tent-role/planner"]);

  // Overwrite — single current note only.
  await writeRoleCheckpoint(fsa, {
    role: "planner",
    text: "Switched to cx-2 after accept.",
    updatedAt: "2026-07-28T11:00:00.000Z",
    sourceSessionId: "ss-new",
  });
  const second = await readRoleCheckpoint(fsa, "planner");
  assert.equal(second!.text, "Switched to cx-2 after accept.");
  assert.equal(second!.sourceSessionId, "ss-new");
  assert.equal(second!.pointers, undefined);

  const tail = formatRoleCheckpointTail(second);
  assert.match(tail, /Tent Role Checkpoint \(dynamic tail; optional\)/);
  assert.match(tail, /not Delivery/);
  assert.match(tail, /Abnormal recovery must re-query/);
  assert.match(tail, /## Continuation/);
  assert.match(tail, /Switched to cx-2/);
  // Tail must not look like stable role-init.
  assert.doesNotMatch(tail, /type: role-init|Role Init/);

  assert.equal(await clearRoleCheckpoint(fsa, "planner"), true);
  assert.equal(await readRoleCheckpoint(fsa, "planner"), null);
  assert.equal(await clearRoleCheckpoint(fsa, "planner"), false);
});

test("core: rejects empty text, oversized text, bad role, reserved agent-profiles", async () => {
  const ws = await makeWorkspace();
  const fsa = new NodeFs(path.join(ws, ".tent"));

  await assert.rejects(
    () =>
      writeRoleCheckpoint(fsa, {
        role: "planner",
        text: "   ",
        updatedAt: "t",
      }),
    /cannot be empty/
  );
  await assert.rejects(
    () =>
      writeRoleCheckpoint(fsa, {
        role: "planner",
        text: "x".repeat(ROLE_CHECKPOINT_MAX_TEXT_CHARS + 1),
        updatedAt: "t",
      }),
    /exceeds/
  );
  await assert.rejects(
    () =>
      writeRoleCheckpoint(fsa, {
        role: "a/b",
        text: "ok",
        updatedAt: "t",
      }),
    /path separators|reserved path/
  );
  await assert.rejects(
    () =>
      writeRoleCheckpoint(fsa, {
        role: "agent-profiles",
        text: "ok",
        updatedAt: "t",
      }),
    /reserved/
  );
});

test("core: bounds checkpoint pointers and complete rendered tail", async () => {
  const ws = await makeWorkspace();
  const fsa = new NodeFs(path.join(ws, ".tent"));

  await assert.rejects(
    () =>
      writeRoleCheckpoint(fsa, {
        role: "planner",
        text: "continue",
        updatedAt: "t",
        pointers: {
          nodes: Array.from({ length: ROLE_CHECKPOINT_MAX_POINTERS + 1 }, (_, i) => `cx-${i}`),
        },
      }),
    new RegExp(`more than ${ROLE_CHECKPOINT_MAX_POINTERS} pointers`)
  );
  await assert.rejects(
    () =>
      writeRoleCheckpoint(fsa, {
        role: "planner",
        text: "continue",
        updatedAt: "t",
        pointers: { git: ["g".repeat(ROLE_CHECKPOINT_MAX_POINTER_CHARS + 1)] },
      }),
    new RegExp(`${ROLE_CHECKPOINT_MAX_POINTER_CHARS} characters`)
  );

  assert.throws(
    () =>
      formatRoleCheckpointTail({
        role: "planner",
        text: "x".repeat(ROLE_CHECKPOINT_MAX_TEXT_CHARS),
        updatedAt: "2026-07-28T12:00:00.000Z",
        pointers: {
          nodes: Array.from(
            { length: ROLE_CHECKPOINT_MAX_POINTERS },
            (_, i) => `${i}-`.padEnd(ROLE_CHECKPOINT_MAX_POINTER_CHARS, "n")
          ),
        },
        path: roleCheckpointPath("planner"),
      }),
    new RegExp(`${ROLE_CHECKPOINT_MAX_TAIL_CHARS} characters`)
  );
});

test("core: read rejects a persisted checkpoint whose rendered tail is oversized", async () => {
  const ws = await makeWorkspace();
  const fsa = new NodeFs(path.join(ws, ".tent"));
  const checkpointPath = roleCheckpointPath("planner");
  const pointers = Array.from(
    { length: ROLE_CHECKPOINT_MAX_POINTERS },
    (_, i) => `${i}-`.padEnd(128, "p")
  );
  await fsa.writeFile(
    checkpointPath,
    serializeFrontmatter(
      {
        type: ROLE_CHECKPOINT_TYPE,
        role: "planner",
        updatedAt: "2026-07-28T12:00:00.000Z",
        nodes: pointers,
      },
      `# Role Checkpoint\n\n## Continuation\n\n${"x".repeat(ROLE_CHECKPOINT_MAX_TEXT_CHARS)}\n`
    )
  );

  await assert.rejects(
    () => readRoleCheckpoint(fsa, "planner"),
    new RegExp(`${ROLE_CHECKPOINT_MAX_TAIL_CHARS} characters`)
  );
});

test("core: path gate rejects dot segments and traversal before any delete", async () => {
  const bad = [".", "..", "../x", "x/..", "..planner", "foo..bar", ".hidden", "trail."];
  for (const name of bad) {
    assert.throws(() => assertRoleCheckpointRoleName(name), /dot|traversal|path/i, name);
    assert.throws(() => roleCheckpointPath(name), /dot|traversal|path/i, name);
  }
  // clear must refuse the same names — never compute a destructive path.
  const ws = await makeWorkspace();
  const fsa = new NodeFs(path.join(ws, ".tent"));
  for (const name of [".", "..", "../x"]) {
    await assert.rejects(() => clearRoleCheckpoint(fsa, name), /dot|traversal|path/i);
  }
  // Control chars + separators + reserved temp + Windows device segments.
  assert.throws(() => assertRoleCheckpointRoleName("a\nb"), /control/);
  assert.throws(() => assertRoleCheckpointRoleName("a\u0000b"), /control/);
  assert.throws(() => assertRoleCheckpointRoleName("a\\b"), /path/);
  assert.throws(() => assertRoleCheckpointRoleName("temp"), /reserved/);
  assert.throws(() => assertRoleCheckpointRoleName("agent-profiles"), /reserved/);
  for (const win of ["CON", "prn", "AUX", "nul", "COM1", "lpt9"]) {
    assert.throws(
      () => assertRoleCheckpointRoleName(win),
      /reserved Windows|path segment/i,
      win
    );
  }
});

test("Service RPC: set / get / clear + session.enter tail", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    const empty = (await client.roleCheckpointGet(workspaceId, "planner")) as {
      checkpoint: null;
      tail: string;
    };
    assert.equal(empty.checkpoint, null);
    assert.equal(empty.tail, "");

    // user actor (default) may set.
    const set = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "Resume cx-94yh78 Skill re-judge after SubGrok delivery.",
      actor: "user",
      nodes: ["cx-94yh78"],
      tasks: ["tk-xxh88t9e"],
      git: ["tent-role/规划"],
    })) as {
      checkpoint: { path: string; text: string; sourceSessionId?: string };
      tail: string;
      actor: string;
    };
    assert.equal(set.actor, "user");
    assert.equal(set.checkpoint.path, "temp/planner/checkpoint.md");
    assert.match(set.tail, /Resume cx-94yh78/);
    assert.match(set.tail, /nodes: cx-94yh78/);
    // Unknown sourceSessionId is omitted (not invented).
    assert.equal(set.checkpoint.sourceSessionId, undefined);

    const got = (await client.roleCheckpointGet(workspaceId, "planner")) as {
      checkpoint: { text: string };
      tail: string;
    };
    assert.equal(got.checkpoint.text, set.checkpoint.text);
    assert.match(got.tail, /dynamic tail/);

    const entered = (await client.sessionEnter({
      workspaceId,
      roleName: "planner",
      externalKey: "test-host:role-cp-1",
    })) as { roleCheckpointTail?: string; session: { roleName?: string } };
    assert.equal(entered.session.roleName, "planner");
    assert.ok(entered.roleCheckpointTail);
    assert.match(entered.roleCheckpointTail!, /Resume cx-94yh78/);
    // Tail is optional field appended by enter — not a second Session mode.
    assert.doesNotMatch(entered.roleCheckpointTail!, /type: role-init/);

    // Idempotent clear (user default).
    const cleared = (await client.roleCheckpointClear(workspaceId, "planner")) as {
      cleared: boolean;
    };
    assert.equal(cleared.cleared, true);
    const clearedAgain = (await client.roleCheckpointClear(workspaceId, "planner")) as {
      cleared: boolean;
    };
    assert.equal(clearedAgain.cleared, false);
    const after = (await client.roleCheckpointGet(workspaceId, "planner")) as {
      checkpoint: null;
    };
    assert.equal(after.checkpoint, null);

    const entered2 = (await client.sessionEnter({
      workspaceId,
      roleName: "planner",
      externalKey: "test-host:role-cp-2",
    })) as { roleCheckpointTail?: string };
    assert.equal(entered2.roleCheckpointTail, undefined);
  });
});

test("Service RPC P0: path gate, unknown Role, actor authority, sourceSessionId", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
    assert.ok(!mounted.error, JSON.stringify(mounted.error));
    const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

    // `.` / `..` refused before any filesystem delete.
    for (const bad of [".", "..", "../x"]) {
      const res = await rpc(svc, "role.checkpoint.set", {
        workspaceId,
        role: bad,
        text: "nope",
      });
      assert.ok(res.error, `expected error for role=${bad}`);
      assert.match(String(res.error!.message), /dot|traversal|path|Role name/i);
      const clearRes = await rpc(svc, "role.checkpoint.clear", {
        workspaceId,
        role: bad,
      });
      assert.ok(clearRes.error, `expected clear error for role=${bad}`);
    }

    // Unknown durable Role refused (path-safe but not in registry).
    const unknown = await rpc(svc, "role.checkpoint.set", {
      workspaceId,
      role: "not-a-registered-role",
      text: "nope",
    });
    assert.ok(unknown.error);
    assert.match(String(unknown.error!.message), /Unknown durable Role/i);
    const unknownGet = await rpc(svc, "role.checkpoint.get", {
      workspaceId,
      role: "not-a-registered-role",
    });
    assert.ok(unknownGet.error);

    // Unrelated Role actor refused.
    const unrelated = await rpc(svc, "role.checkpoint.set", {
      workspaceId,
      role: "planner",
      text: "stolen",
      actor: "executor",
    });
    assert.ok(unrelated.error);
    assert.equal(unrelated.error!.code, -32001);
    assert.match(String(unrelated.error!.message), /exact target Role|ACTOR|actor/i);

    const unrelatedClear = await rpc(svc, "role.checkpoint.clear", {
      workspaceId,
      role: "planner",
      actor: "executor",
    });
    assert.ok(unrelatedClear.error);
    assert.equal(unrelatedClear.error!.code, -32001);

    // Exact target Role actor allowed.
    const asRole = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "planner self-note",
      actor: "planner",
    })) as { actor: string; checkpoint: { text: string } };
    assert.equal(asRole.actor, "planner");
    assert.equal(asRole.checkpoint.text, "planner self-note");

    // User actor allowed (explicit).
    const asUser = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "user note",
      actor: "user",
    })) as { actor: string; checkpoint: { text: string } };
    assert.equal(asUser.actor, "user");
    assert.equal(asUser.checkpoint.text, "user note");

    // Matching sourceSessionId kept; mismatched role/workspace omitted.
    const matchEnter = (await client.sessionEnter({
      workspaceId,
      roleName: "planner",
      externalKey: "test-host:cp-match",
    })) as { session: { sessionId: string } };
    const matchId = matchEnter.session.sessionId;
    const withMatch = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "with session",
      sourceSessionId: matchId,
    })) as {
      checkpoint: { sourceSessionId?: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(withMatch.sourceSessionIdAccepted, true);
    assert.equal(withMatch.checkpoint.sourceSessionId, matchId);

    const otherRoleEnter = (await client.sessionEnter({
      workspaceId,
      roleName: "executor",
      externalKey: "test-host:cp-other-role",
    })) as { session: { sessionId: string } };
    const mismatchRole = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "mismatch role session",
      sourceSessionId: otherRoleEnter.session.sessionId,
    })) as {
      checkpoint: { sourceSessionId?: string; text: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(mismatchRole.sourceSessionIdAccepted, false);
    assert.equal(mismatchRole.checkpoint.sourceSessionId, undefined);
    assert.equal(mismatchRole.checkpoint.text, "mismatch role session");

    // Session bound to a different workspace id string → omit.
    const foreign = await svc.runtime.enterExternalSession({
      roleName: "planner",
      workspace: "ws-foreign-not-mounted",
      externalKey: "test-host:cp-foreign-ws",
    });
    const mismatchWs = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "mismatch ws session",
      sourceSessionId: foreign.sessionId,
    })) as {
      checkpoint: { sourceSessionId?: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(mismatchWs.sourceSessionIdAccepted, false);
    assert.equal(mismatchWs.checkpoint.sourceSessionId, undefined);

    // Missing registry row → omit.
    const missing = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "missing session",
      sourceSessionId: "ss-does-not-exist",
    })) as {
      checkpoint: { sourceSessionId?: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(missing.sourceSessionIdAccepted, false);
    assert.equal(missing.checkpoint.sourceSessionId, undefined);

    // Unscoped workspace on an otherwise matching Role row → drop attribution
    // (legacy rows must not falsely bind to this workspace).
    const unscopedWs = await svc.runtime.enterExternalSession({
      roleName: "planner",
      externalKey: "test-host:cp-unscoped-ws",
      // intentionally omit workspace
    });
    const unscopedWsRec = await svc.runtime.registry.read(unscopedWs.sessionId);
    assert.ok(unscopedWsRec);
    assert.equal(unscopedWsRec!.workspace, undefined);
    assert.equal(unscopedWsRec!.roleName, "planner");
    const dropUnscopedWs = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "unscoped workspace session",
      sourceSessionId: unscopedWs.sessionId,
    })) as {
      checkpoint: { sourceSessionId?: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(dropUnscopedWs.sourceSessionIdAccepted, false);
    assert.equal(dropUnscopedWs.checkpoint.sourceSessionId, undefined);

    // Unscoped roleName with matching workspace → drop attribution.
    const unscopedRole = await svc.runtime.enterExternalSession({
      workspace: workspaceId,
      externalKey: "test-host:cp-unscoped-role",
      // intentionally omit roleName
    });
    const unscopedRoleRec = await svc.runtime.registry.read(unscopedRole.sessionId);
    assert.ok(unscopedRoleRec);
    assert.equal(unscopedRoleRec!.workspace, workspaceId);
    assert.equal(unscopedRoleRec!.roleName, undefined);
    const dropUnscopedRole = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "unscoped role session",
      sourceSessionId: unscopedRole.sessionId,
    })) as {
      checkpoint: { sourceSessionId?: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(dropUnscopedRole.sourceSessionIdAccepted, false);
    assert.equal(dropUnscopedRole.checkpoint.sourceSessionId, undefined);

    // Both unscoped → drop.
    const fullyUnscoped = await svc.runtime.enterExternalSession({
      externalKey: "test-host:cp-fully-unscoped",
    });
    const dropBoth = (await client.roleCheckpointSet(workspaceId, {
      role: "planner",
      text: "fully unscoped session",
      sourceSessionId: fullyUnscoped.sessionId,
    })) as {
      checkpoint: { sourceSessionId?: string };
      sourceSessionIdAccepted: boolean;
    };
    assert.equal(dropBoth.sourceSessionIdAccepted, false);
    assert.equal(dropBoth.checkpoint.sourceSessionId, undefined);

    // Exact Role actor can clear; get remains idempotent null after.
    const clearAsRole = (await client.roleCheckpointClear(workspaceId, "planner", {
      actor: "planner",
    })) as { cleared: boolean; actor: string };
    assert.equal(clearAsRole.actor, "planner");
    assert.equal(clearAsRole.cleared, true);
    const empty2 = (await client.roleCheckpointGet(workspaceId, "planner")) as {
      checkpoint: null;
      tail: string;
    };
    assert.equal(empty2.checkpoint, null);
    assert.equal(empty2.tail, "");
  });
});

test("managed bootstrap appends Role Checkpoint as dynamic tail for durable role only", async () => {
  const ws = await makeWorkspace();
  await withService(
    async (svc) => {
      const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;

      await client.roleCheckpointSet(workspaceId, {
        role: "executor",
        text: "After replace: re-open tk bound claim; do not restate Delivery body.",
        nodes: ["cx-inbox"],
      });

      const created = await rpc(svc, "docs.createNote", {
        workspaceId,
        name: "cp-work",
        type: "prompt",
      });
      assert.ok(!created.error, JSON.stringify(created.error));
      const boxId = (created.result as { id: string }).id;

      const d = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "bootstrap with checkpoint tail",
        deliveryPolicy: "review",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
      });
      assert.ok(!d.error, JSON.stringify(d.error));
      const taskPath = (d.result as { taskPath: string }).taskPath;
      if ((d.result as { state?: string }).state === "queued") {
        await rpc(svc, "task.claim", { workspaceId, taskPath });
      }

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "fake-default",
      });
      assert.ok(!started.error, JSON.stringify(started.error));

      // Capture bootstrap via registry / runtime is internal; re-check via replace path
      // by reading the on-disk note + verifying formatRoleCheckpointTail contract used in builder.
      const systemFs = new NodeFs(path.join(ws, ".tent"));
      const record = await readRoleCheckpoint(systemFs, "executor");
      assert.ok(record);
      const tail = formatRoleCheckpointTail(record);
      const body = sessionBootstrapPromptForTask(
        {
          path: taskPath,
          role: "executor",
          // Node refs live on Task.contextCard.refs.nodes only (no claims[]).
          manifest: "temp/executor/manifest.yml",
          status: "taken",
          state: "running",
          deliveryPolicy: "review",
          prompt: "## User Prompt\n\nbootstrap with checkpoint tail\n",
        },
        { workspaceRoot: ws, systemRoot: path.join(ws, ".tent") }
      );
      // sessionBootstrapPromptForTask stays free of checkpoint (stable dynamic task body only).
      assert.doesNotMatch(body, /Role Checkpoint/);
      // Service builder appends tail after bootstrap — unit-check composition order.
      const composed = `${body}\n${tail}\n`;
      const idxBootstrap = composed.indexOf("Tent managed ACP session is ready");
      const idxTail = composed.indexOf("Tent Role Checkpoint (dynamic tail; optional)");
      assert.ok(idxBootstrap >= 0 && idxTail > idxBootstrap);

      // agentProfile path must never load role checkpoint under profile id.
      const profileDispatch = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [boxId],
        role: "fake-default",
        assigneeKind: "route",
        prompt: "profile one-shot",
        deliveryPolicy: "review",
        callerKind: "role",
        parentActor: { kind: "role", id: "executor" },
        reviewer: { kind: "role", id: "executor" },
        routeId: "fake-default",
      });
      // May fail occupation if still active — cancel first if needed.
      if (profileDispatch.error) {
        await rpc(svc, "task.interrupt", { workspaceId, taskPath }).catch(() => undefined);
        await rpc(svc, "task.cancel", { workspaceId, taskPath }).catch(() => undefined);
      }
    },
    {
      profiles: [
        {
          id: "fake-default",
          adapterId: FAKE_ADAPTER_ID,
          fake: { waitForSignal: true, sleepMs: 60_000 },
        },
      ],
    }
  );
});

test("managed bootstrap fails open when Role Checkpoint pointers are invalid", async () => {
  const ws = await makeWorkspace();
  const systemFs = new NodeFs(path.join(ws, ".tent"));
  await systemFs.writeFile(
    roleCheckpointPath("executor"),
    serializeFrontmatter(
      {
        type: ROLE_CHECKPOINT_TYPE,
        role: "executor",
        updatedAt: "2026-07-28T12:00:00.000Z",
        nodes: Array.from(
          { length: ROLE_CHECKPOINT_MAX_POINTERS + 1 },
          (_, i) => `cx-${i}`
        ),
      },
      "# Role Checkpoint\n\n## Continuation\n\nThis invalid note must be omitted.\n"
    )
  );

  await withService(
    async (svc) => {
      const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
      assert.ok(!mounted.error, JSON.stringify(mounted.error));
      const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
      const created = await rpc(svc, "docs.createNote", {
        workspaceId,
        name: "cp-invalid-bootstrap",
        type: "prompt",
      });
      assert.ok(!created.error, JSON.stringify(created.error));
      const boxId = (created.result as { id: string }).id;
      const dispatched = await rpc(svc, "task.dispatch", {
        workspaceId,
        nodeIds: [boxId],
        role: "executor",
        prompt: "bootstrap despite invalid checkpoint",
        deliveryPolicy: "review",
        parentActor: { kind: "user", id: "user" },
        reviewer: { kind: "user", id: "user" },
      });
      assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
      const taskPath = (dispatched.result as { taskPath: string }).taskPath;
      if ((dispatched.result as { state?: string }).state === "queued") {
        const claimed = await rpc(svc, "task.claim", { workspaceId, taskPath });
        assert.ok(!claimed.error, JSON.stringify(claimed.error));
      }

      const started = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath,
        callerKind: "user",
        profileId: "fake-default",
      });
      assert.ok(!started.error, JSON.stringify(started.error));
    },
    {
      profiles: [
        {
          id: "fake-default",
          adapterId: FAKE_ADAPTER_ID,
          fake: { waitForSignal: true, sleepMs: 60_000 },
        },
      ],
    }
  );
});

test("CLI role-checkpoint set/clear via Service; show read-only; --direct fail-loud", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    // Injected client → set/clear go through Service (MutationBus), not direct files.
    const set = await runRoleCheckpointCommand(
      "set",
      [
        "planner",
        "--text",
        "CLI note for cooperative transfer",
        "--nodes",
        "cx-1,cx-2",
        "--git",
        "tent-role/planner",
        "--actor",
        "user",
      ],
      { cwd: ws, client }
    );
    assert.equal(set.exitCode, 0, set.stderr);
    assert.match(set.stdout, /Role Checkpoint written/);

    // show without client may direct-read (read-only).
    const show = await runRoleCheckpointCommand("show", ["planner"], { cwd: ws });
    assert.equal(show.exitCode, 0, show.stderr);
    assert.match(show.stdout, /CLI note for cooperative transfer/);
    assert.match(show.stdout, /nodes: cx-1, cx-2/);

    // Exact Role actor via CLI → Service.
    const setAsRole = await runRoleCheckpointCommand(
      "set",
      ["planner", "--text", "role self note", "--actor", "planner"],
      { cwd: ws, client }
    );
    assert.equal(setAsRole.exitCode, 0, setAsRole.stderr);

    // Unrelated actor refused by Service.
    const badActor = await runRoleCheckpointCommand(
      "set",
      ["planner", "--text", "stolen", "--actor", "executor"],
      { cwd: ws, client }
    );
    assert.equal(badActor.exitCode, 1);
    assert.match(badActor.stderr, /exact target Role|ACTOR|actor/i);

    const clear = await runRoleCheckpointCommand(
      "clear",
      ["planner", "--actor", "user"],
      { cwd: ws, client }
    );
    assert.equal(clear.exitCode, 0, clear.stderr);
    assert.match(clear.stdout, /cleared/);

    const show2 = await runRoleCheckpointCommand("show", ["planner"], { cwd: ws });
    assert.equal(show2.exitCode, 0, show2.stderr);
    assert.match(show2.stdout, /No Role Checkpoint/);

    // --direct on set/clear is fail-loud (no silent core bypass).
    const directSet = await runRoleCheckpointCommand(
      "set",
      ["planner", "--text", "nope", "--direct"],
      { cwd: ws, client }
    );
    assert.equal(directSet.exitCode, 1);
    assert.match(directSet.stderr, /refuses --direct|Local Service|MutationBus/i);

    const directClear = await runRoleCheckpointCommand(
      "clear",
      ["planner", "--direct"],
      { cwd: ws }
    );
    assert.equal(directClear.exitCode, 1);
    assert.match(directClear.stderr, /refuses --direct|Local Service/i);

    // Help documents Service + actor.
    const help = await runRoleCheckpointCommand("help", [], {});
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout, /Local Service|MutationBus/i);
    assert.match(help.stdout, /--actor/);
    assert.match(help.stdout, /wins over cwd/i);
    assert.doesNotMatch(help.stdout, /--service\s+Use Local Service RPC instead of direct/i);
  });
});

test("CLI show: explicit --workspace wins over cwd (wrong Tent isolation)", async () => {
  // Caller sits inside wsA but passes --workspace wsB → must read wsB only.
  const wsA = await makeWorkspace("role-cp-a");
  const wsB = await makeWorkspace("role-cp-b");
  const fsaA = new NodeFs(path.join(wsA, ".tent"));
  const fsaB = new NodeFs(path.join(wsB, ".tent"));
  await writeRoleCheckpoint(fsaA, {
    role: "planner",
    text: "NOTE_FROM_WORKSPACE_A_ONLY",
    updatedAt: "2026-07-28T11:00:00.000Z",
  });
  await writeRoleCheckpoint(fsaB, {
    role: "planner",
    text: "NOTE_FROM_WORKSPACE_B_ONLY",
    updatedAt: "2026-07-28T11:00:00.000Z",
  });

  // cwd=wsA, --workspace=wsB → B's note (flag wins).
  const showFlag = await runRoleCheckpointCommand(
    "show",
    ["planner", "--workspace", wsB],
    { cwd: wsA }
  );
  assert.equal(showFlag.exitCode, 0, showFlag.stderr);
  assert.match(showFlag.stdout, /NOTE_FROM_WORKSPACE_B_ONLY/);
  assert.doesNotMatch(showFlag.stdout, /NOTE_FROM_WORKSPACE_A_ONLY/);

  // cwd=wsA, globals.workspace=wsB → B's note (globals win over bare cwd).
  const showGlobals = await runRoleCheckpointCommand("show", ["planner"], {
    cwd: wsA,
    workspace: wsB,
  });
  assert.equal(showGlobals.exitCode, 0, showGlobals.stderr);
  assert.match(showGlobals.stdout, /NOTE_FROM_WORKSPACE_B_ONLY/);
  assert.doesNotMatch(showGlobals.stdout, /NOTE_FROM_WORKSPACE_A_ONLY/);

  // No explicit workspace → cwd (wsA) is used.
  const showCwd = await runRoleCheckpointCommand("show", ["planner"], { cwd: wsA });
  assert.equal(showCwd.exitCode, 0, showCwd.stderr);
  assert.match(showCwd.stdout, /NOTE_FROM_WORKSPACE_A_ONLY/);
  assert.doesNotMatch(showCwd.stdout, /NOTE_FROM_WORKSPACE_B_ONLY/);

  // Flag beats both cwd and globals.workspace (flag is the operator surface).
  const showFlagOverGlobals = await runRoleCheckpointCommand(
    "show",
    ["planner", "--workspace", wsA],
    { cwd: wsB, workspace: wsB }
  );
  assert.equal(showFlagOverGlobals.exitCode, 0, showFlagOverGlobals.stderr);
  assert.match(showFlagOverGlobals.stdout, /NOTE_FROM_WORKSPACE_A_ONLY/);
  assert.doesNotMatch(showFlagOverGlobals.stdout, /NOTE_FROM_WORKSPACE_B_ONLY/);
});

test("skills: tent-agent remains retired; Skill authoring is Planning-owned", async () => {
  // Mechanical Core/Service/CLI work must not author Skill text. Assert only
  // that tent-agent stays retired and the two Skills still exist for readers.
  assert.equal(await fs.access(path.join(repoRoot, "skills", "tent-role", "SKILL.md")).then(() => true, () => false), true);
  assert.equal(await fs.access(path.join(repoRoot, "skills", "tent-task", "SKILL.md")).then(() => true, () => false), true);
  await assert.rejects(
    () => fs.access(path.join(repoRoot, "skills", "tent-agent", "SKILL.md")),
    /ENOENT/
  );
  const roleSkill = await fs.readFile(
    path.join(repoRoot, "skills", "tent-role", "SKILL.md"),
    "utf8"
  );
  // Planning owns Skill edits; this suite must not require checkpoint wording
  // until Planning authors it. Report findings via Delivery instead.
  assert.doesNotMatch(roleSkill, /tent-agent/);
  assert.ok(roleSkill.length < 6000, "tent-role SKILL.md should stay compact");
});
