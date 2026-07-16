/**
 * Machine-local JSON store hardening:
 * atomic temp+rename writes, A2A mutation serialization, corrupt backup.
 * Deterministic on Windows (no timers, no network).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionRegistry } from "../src/runtime/session-registry.js";
import {
  A2AApprovalStore,
  makeApprovalId,
  type A2APendingApproval,
} from "../src/service/a2a-store.js";
import {
  ensureDefaultProfiles,
  loadAgentProfiles,
  profilesPath,
  saveAgentProfiles,
} from "../src/service/profiles.js";
import {
  readServiceEndpoint,
  removeServiceEndpoint,
  writeServiceEndpoint,
  serviceEndpointPath,
} from "../src/service/data-dir.js";
import { writeJsonAtomic } from "../src/machine-state.js";
import { ToolApprovalStore } from "../src/service/tool-approval-store.js";
import {
  acquireServiceDataDirLease,
  ServiceDataDirBusyError,
  serviceLeasePath,
} from "../src/service/service-lease.js";
import { startLocalTentService } from "../src/service/service.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = orig;
    },
  };
}

function a2aPending(partial: Partial<A2APendingApproval> & { id: string }): A2APendingApproval {
  return {
    workspaceId: "ws-1",
    taskPath: "tasks/t1.md",
    role: "worker",
    profileId: "fake-default",
    policy: "ask",
    callerKind: "user",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

test("writeJsonAtomic: sequential replace leaves parseable pretty JSON", async () => {
  const dataDir = await tempDir("tent-ms-atomic-");
  const file = path.join(dataDir, "payload.json");

  // Stores serialize mutations; atomic helper itself is temp+rename per write.
  // Sequential replaces exercise Windows rename-over-existing without races.
  for (let i = 0; i < 12; i++) {
    await writeJsonAtomic(file, { seq: i, items: Array.from({ length: i + 1 }, (_, j) => j) });
  }

  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw) as { seq: number; items: number[] };
  assert.equal(parsed.seq, 11);
  assert.ok(Array.isArray(parsed.items));
  assert.equal(parsed.items.length, 12);
  // Pretty UTF-8 + trailing newline preserved.
  assert.ok(raw.includes("\n  "));
  assert.equal(raw.endsWith("\n"), true);
  // No leftover temp files in the directory.
  const names = await fs.readdir(dataDir);
  assert.equal(
    names.filter((n) => n.endsWith(".tmp")).length,
    0,
    "temp files must be cleaned or renamed away"
  );
});

test("A2AApprovalStore: malformed row quarantines the whole machine-state file", async () => {
  const dataDir = await tempDir("tent-a2a-corrupt-row-");
  const file = path.join(dataDir, "a2a-approvals.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      items: [
        a2aPending({ id: "ap-valid0001" }),
        {
          ...a2aPending({ id: "ap-bad00001" }),
          policy: "maybe",
          extraUnknown: "drop-me",
        },
      ],
    }),
    "utf8"
  );

  const cap = captureConsoleError();
  try {
    const store = new A2AApprovalStore(dataDir);
    assert.deepEqual(await store.listPending(), []);
    await assert.rejects(() => fs.access(file));

    const names = await fs.readdir(dataDir);
    const backups = names.filter((n) => n.startsWith("a2a-approvals.json.corrupt-"));
    assert.equal(backups.length, 1);
    const quarantined = JSON.parse(
      await fs.readFile(path.join(dataDir, backups[0]), "utf8")
    ) as { items: unknown[] };
    assert.equal(quarantined.items.length, 2);
    assert.ok(cap.lines.some((l) => /a2a-approvals\.json was corrupt/.test(l)));
  } finally {
    cap.restore();
  }
});

test("A2AApprovalStore: valid pending survives reload without status change", async () => {
  const dataDir = await tempDir("tent-a2a-pending-reload-");
  const store = new A2AApprovalStore(dataDir);
  const id = makeApprovalId(() => 0.42);
  const created = await store.add(
    a2aPending({
      id,
      taskId: "task-1",
      bootstrapPrompt: "continue",
      // Unknown keys must not be persisted via parse on reload either.
    })
  );
  assert.equal(created.status, "pending");

  // Inject a disk row with an unknown field; load path must strip unknowns
  // and keep the legal pending status (unlike tool approvals, no expire-on-restart).
  const file = path.join(dataDir, "a2a-approvals.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      items: [
        {
          ...created,
          extraUnknown: "should-be-dropped",
          nested: { x: 1 },
        },
      ],
    }),
    "utf8"
  );

  const reloaded = new A2AApprovalStore(dataDir);
  const item = await reloaded.get(id);
  assert.ok(item);
  assert.equal(item!.status, "pending");
  assert.equal(item!.workspaceId, "ws-1");
  assert.equal(item!.taskPath, "tasks/t1.md");
  assert.equal(item!.role, "worker");
  assert.equal(item!.profileId, "fake-default");
  assert.equal(item!.policy, "ask");
  assert.equal(item!.callerKind, "user");
  assert.equal(item!.taskId, "task-1");
  assert.equal(item!.bootstrapPrompt, "continue");
  assert.equal(item!.createdAt, created.createdAt);
  assert.equal(
    Object.prototype.hasOwnProperty.call(item!, "extraUnknown"),
    false,
    "unknown fields must be discarded on parse"
  );
  assert.equal(Object.prototype.hasOwnProperty.call(item!, "nested"), false);

  const pending = await reloaded.listPending("ws-1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id);
  assert.equal(pending[0].status, "pending");
});

test("A2AApprovalStore: concurrent resolve cannot resurrect pending", async () => {
  const dataDir = await tempDir("tent-a2a-race-");
  const store = new A2AApprovalStore(dataDir);
  const id = makeApprovalId(() => 0.33);
  await store.add(a2aPending({ id }));

  const results = await Promise.allSettled([
    store.resolve(id, "approved", "user-a"),
    store.resolve(id, "denied", "user-b"),
    store.resolve(id, "approved", "user-c"),
  ]);

  const item = await store.get(id);
  assert.ok(item);
  assert.notEqual(item!.status, "pending");
  assert.ok(item!.status === "approved" || item!.status === "denied");

  await assert.rejects(
    () => store.resolve(id, "approved", "late"),
    /already (approved|denied)/
  );

  const reloaded = new A2AApprovalStore(dataDir);
  const disk = await reloaded.get(id);
  assert.ok(disk);
  assert.equal(disk!.status, item!.status);
  assert.notEqual(disk!.status, "pending");

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 2);

  const raw = await fs.readFile(path.join(dataDir, "a2a-approvals.json"), "utf8");
  const parsed = JSON.parse(raw) as { items: A2APendingApproval[] };
  assert.equal(parsed.items.filter((i) => i.status === "pending").length, 0);
});

test("A2AApprovalStore: concurrent add leaves valid atomic JSON", async () => {
  const dataDir = await tempDir("tent-a2a-atomic-");
  const store = new A2AApprovalStore(dataDir);
  const ids = Array.from({ length: 8 }, (_, i) => makeApprovalId(() => (i + 1) / 20));

  await Promise.all(ids.map((id, i) => store.add(a2aPending({ id, role: `r${i}` }))));

  const raw = await fs.readFile(path.join(dataDir, "a2a-approvals.json"), "utf8");
  const parsed = JSON.parse(raw) as { items: A2APendingApproval[] };
  assert.equal(parsed.items.length, 8);
  assert.equal(parsed.items.filter((i) => i.status === "pending").length, 8);
  assert.equal(raw.endsWith("\n"), true);
});

test("A2AApprovalStore: persistence failure leaves memory and disk uncommitted", async () => {
  const dataDir = await tempDir("tent-a2a-rollback-");
  let failWrites = true;
  const store = new A2AApprovalStore(dataDir, {
    writeState: async (file, value) => {
      if (failWrites) throw new Error("injected A2A persist failure");
      await writeJsonAtomic(file, value);
    },
  });
  const id = makeApprovalId(() => 0.61);

  await assert.rejects(
    () => store.add(a2aPending({ id })),
    /injected A2A persist failure/
  );
  assert.equal(await store.get(id), undefined, "failed add must not leak into memory");

  failWrites = false;
  await store.add(a2aPending({ id }));
  failWrites = true;
  await assert.rejects(
    () => store.resolve(id, "approved", "user"),
    /injected A2A persist failure/
  );
  assert.equal((await store.get(id))?.status, "pending");

  const disk = await new A2AApprovalStore(dataDir).get(id);
  assert.equal(disk?.status, "pending", "disk and memory must retain the old snapshot");

  failWrites = false;
  assert.equal((await store.resolve(id, "approved", "user")).status, "approved");
});

test("machine stores retry loading after a transient non-ENOENT read error", async () => {
  const dataDir = await tempDir("tent-store-retry-");

  const a2aPath = path.join(dataDir, "a2a-approvals.json");
  await fs.mkdir(a2aPath);
  const a2a = new A2AApprovalStore(dataDir);
  await assert.rejects(() => a2a.ensureLoaded());
  await fs.rm(a2aPath, { recursive: true });
  const a2aItem = a2aPending({ id: makeApprovalId(() => 0.51) });
  await fs.writeFile(a2aPath, JSON.stringify({ items: [a2aItem] }), "utf8");
  assert.equal((await a2a.get(a2aItem.id))?.id, a2aItem.id);

  const toolPath = path.join(dataDir, "tool-approvals.json");
  await fs.mkdir(toolPath);
  const tools = new ToolApprovalStore(dataDir);
  await assert.rejects(() => tools.ensureLoaded());
  await fs.rm(toolPath, { recursive: true });
  const toolItem = {
    id: "ta-retry0001",
    workspaceId: "ws-1",
    sessionId: "ss-retry01",
    toolTitle: "read_file",
    options: [{ optionId: "allow_once", kind: "allow_once" }],
    status: "pending" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  await fs.writeFile(toolPath, JSON.stringify({ items: [toolItem] }), "utf8");
  assert.equal((await tools.get(toolItem.id))?.id, toolItem.id);
});

test("profiles: corrupt catalog is backed up before defaults; warning has no secrets", async () => {
  const dataDir = await tempDir("tent-profiles-corrupt-");
  const file = profilesPath(dataDir);
  const secret = "sk-live-secret-token-SHOULD-NOT-LEAK";
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, `{ "profiles": [ {"id":"x","adapterId":"y","apiKey":"${secret}"`, "utf8");

  const cap = captureConsoleError();
  try {
    const profiles = await ensureDefaultProfiles(dataDir);
    assert.ok(profiles.length >= 2);
    assert.ok(profiles.some((p) => p.id === "fake-default"));
    assert.ok(profiles.some((p) => p.id === "grok-acp-default"));

    const names = await fs.readdir(dataDir);
    const backups = names.filter((n) => n.startsWith("agent-profiles.json.corrupt-"));
    assert.equal(backups.length, 1);
    // Backup name is path + timestamp only — never embeds content/secrets.
    assert.equal(backups[0].includes(secret), false);
    assert.match(backups[0], /^agent-profiles\.json\.corrupt-\d{4}-\d{2}-\d{2}T/);

    const backupRaw = await fs.readFile(path.join(dataDir, backups[0]), "utf8");
    assert.ok(backupRaw.includes(secret), "backup body preserves original bytes for operator review");

    assert.ok(cap.lines.some((l) => /agent-profiles\.json was corrupt/.test(l)));
    assert.ok(cap.lines.every((l) => !l.includes(secret)));

    // Reloaded catalog is valid defaults, not the torn file.
    const reloaded = await loadAgentProfiles(dataDir);
    assert.ok(reloaded.some((p) => p.id === "grok-acp-default"));
    const raw = await fs.readFile(file, "utf8");
    JSON.parse(raw);
    assert.equal(raw.includes(secret), false);
  } finally {
    cap.restore();
  }
});

test("profiles: good legacy + bad row quarantines whole file; defaults restore; backup keeps bad row", async () => {
  const dataDir = await tempDir("tent-profiles-row-quarantine-");
  const file = profilesPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });

  const badMarker = "BAD-PROFILE-ROW-MUST-SURVIVE-BACKUP";
  // Mix: valid legacy grokAcp row + one illegal row. Must NOT silent-skip the bad line
  // into a shrunk catalog — whole file backup/quarantine/reset.
  await fs.writeFile(
    file,
    JSON.stringify({
      profiles: [
        {
          id: "legacy-good",
          adapterId: "grok-acp",
          displayName: "Legacy Good",
          grokAcp: {
            model: "user-model",
            envKey: "USER_GROK_KEY",
            permissionPolicy: "ask",
            permissionTimeoutMs: 12_000,
          },
        },
        {
          id: "bad-row",
          adapterId: "grok-acp",
          displayName: badMarker,
          acp: {
            // Invalid permissionPolicy (CRUD rejects "yolo") → row poison.
            permissionPolicy: "yolo",
            executable: "",
          },
        },
      ],
    }) + "\n",
    "utf8"
  );

  const cap = captureConsoleError();
  try {
    const profiles = await ensureDefaultProfiles(dataDir);
    // From empty (quarantined) library, defaults are fully restored.
    assert.ok(profiles.some((p) => p.id === "fake-default"));
    assert.ok(profiles.some((p) => p.id === "grok-acp-default"));
    assert.ok(
      !profiles.some((p) => p.id === "legacy-good" || p.id === "bad-row"),
      "must not keep a shrunk mix of good+skipped-bad rows"
    );

    const names = await fs.readdir(dataDir);
    const backups = names.filter((n) => n.startsWith("agent-profiles.json.corrupt-"));
    assert.equal(backups.length, 1);

    const backupRaw = await fs.readFile(path.join(dataDir, backups[0]!), "utf8");
    assert.ok(backupRaw.includes(badMarker), "quarantine backup must retain original bad row");
    assert.ok(backupRaw.includes("legacy-good"));
    assert.ok(
      backupRaw.includes('"permissionPolicy": "yolo"') ||
        backupRaw.includes('"permissionPolicy":"yolo"')
    );
    const quarantined = JSON.parse(backupRaw) as { profiles: unknown[] };
    assert.equal(quarantined.profiles.length, 2, "corrupt backup must keep the full original file");

    assert.ok(cap.lines.some((l) => /agent-profiles\.json was corrupt/.test(l)));

    // Active path is rewritten with full defaults (not a silent partial keep of only legacy-good).
    await fs.access(file);
    const active = JSON.parse(await fs.readFile(file, "utf8")) as {
      profiles: Array<{ id: string }>;
    };
    assert.ok(active.profiles.some((p) => p.id === "grok-acp-default"));
    assert.ok(active.profiles.every((p) => p.id !== "bad-row" && p.id !== "legacy-good"));
    assert.ok(active.profiles.length >= 2);
  } finally {
    cap.restore();
  }
});

test("profiles: legal legacy-only catalog migrates to acp without quarantine", async () => {
  const dataDir = await tempDir("tent-profiles-legacy-ok-");
  const file = profilesPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      profiles: [
        {
          id: "fake-default",
          adapterId: "fake",
          displayNameKey: "profile.fake.default",
          fake: { waitForSignal: true },
        },
        {
          id: "grok-acp-default",
          adapterId: "grok-acp",
          displayNameKey: "profile.grokAcp.default",
          grokAcp: {
            model: "legacy-model",
            envKey: "LEGACY_GROK_KEY",
            permissionPolicy: "deny",
          },
        },
      ],
    }) + "\n",
    "utf8"
  );

  const cap = captureConsoleError();
  try {
    const profiles = await ensureDefaultProfiles(dataDir);
    const grok = profiles.find((p) => p.id === "grok-acp-default");
    assert.ok(grok);
    assert.equal(grok!.acp?.model, "legacy-model");
    assert.equal(grok!.acp?.envKey, "LEGACY_GROK_KEY");
    assert.equal((grok as { grokAcp?: unknown }).grokAcp, undefined);

    const names = await fs.readdir(dataDir);
    assert.equal(
      names.filter((n) => n.startsWith("agent-profiles.json.corrupt-")).length,
      0,
      "valid legacy grokAcp file must not be quarantined"
    );
    assert.ok(cap.lines.every((l) => !/agent-profiles\.json was corrupt/.test(l)));

    const disk = JSON.parse(await fs.readFile(file, "utf8")) as {
      profiles: Array<Record<string, unknown>>;
    };
    const diskGrok = disk.profiles.find((p) => p.id === "grok-acp-default")!;
    assert.ok(!("grokAcp" in diskGrok));
    assert.equal((diskGrok.acp as { model?: string }).model, "legacy-model");
  } finally {
    cap.restore();
  }
});

test("profiles: invalid executable / permissionPolicy / acp shape quarantines whole file", async () => {
  async function expectQuarantine(label: string, row: Record<string, unknown>): Promise<void> {
    const dataDir = await tempDir(`tent-profiles-bad-${label}-`);
    const file = profilesPath(dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        profiles: [
          {
            id: "ok-peer",
            adapterId: "fake",
            fake: { waitForSignal: true },
          },
          row,
        ],
      }) + "\n",
      "utf8"
    );

    const cap = captureConsoleError();
    try {
      const loaded = await loadAgentProfiles(dataDir);
      assert.deepEqual(loaded, [], `${label}: bad row must empty catalog after quarantine`);
      await assert.rejects(() => fs.access(file), { code: "ENOENT" });
      const names = await fs.readdir(dataDir);
      assert.ok(
        names.some((n) => n.startsWith("agent-profiles.json.corrupt-")),
        `${label}: expected corrupt backup`
      );
      assert.ok(cap.lines.some((l) => /agent-profiles\.json was corrupt/.test(l)));
    } finally {
      cap.restore();
    }
  }

  // Empty executable rejected by optionalNonEmptyString-equivalent rules.
  await expectQuarantine("empty-executable", {
    id: "bad-exec",
    adapterId: "grok-acp",
    acp: { executable: "   ", permissionPolicy: "deny" },
  });

  // Non-string executable is an illegal acp shape.
  await expectQuarantine("exec-not-string", {
    id: "bad-exec-type",
    adapterId: "grok-acp",
    acp: { executable: 42 },
  });

  await expectQuarantine("bad-permission", {
    id: "bad-policy",
    adapterId: "grok-acp",
    acp: { permissionPolicy: "yolo" },
  });

  // acp bag must be an object when present.
  await expectQuarantine("acp-string", {
    id: "bad-acp-shape",
    adapterId: "grok-acp",
    acp: "not-an-object",
  });

  await expectQuarantine("acp-array", {
    id: "bad-acp-array",
    adapterId: "grok-acp",
    acp: [{ model: "x" }],
  });

  // Structural: missing adapterId must not silent-skip.
  await expectQuarantine("missing-adapter", {
    id: "no-adapter",
    acp: { permissionPolicy: "deny" },
  });
});

test("profiles: unknown top-level / acp / fake keys quarantine whole file; backup keeps them", async () => {
  const cases: Array<{
    label: string;
    row: Record<string, unknown>;
    /** Substring that must remain in the corrupt backup (unknown field preserved). */
    backupMarker: string;
  }> = [
    {
      label: "unknown-top-level",
      row: {
        id: "bad-top",
        adapterId: "grok-acp",
        displayName: "has-unknown-top",
        acp: { permissionPolicy: "deny" },
        apiKey: "MUST-NOT-STRIP-TOP-LEVEL",
      },
      backupMarker: "MUST-NOT-STRIP-TOP-LEVEL",
    },
    {
      label: "unknown-acp-key",
      row: {
        id: "bad-acp-key",
        adapterId: "grok-acp",
        acp: {
          permissionPolicy: "deny",
          secretToken: "MUST-NOT-STRIP-ACP-KEY",
        },
      },
      backupMarker: "MUST-NOT-STRIP-ACP-KEY",
    },
    {
      label: "unknown-fake-key",
      row: {
        id: "bad-fake-key",
        adapterId: "fake",
        fake: {
          waitForSignal: true,
          unknownFake: "MUST-NOT-STRIP-FAKE-KEY",
        },
      },
      backupMarker: "MUST-NOT-STRIP-FAKE-KEY",
    },
  ];

  for (const { label, row, backupMarker } of cases) {
    const dataDir = await tempDir(`tent-profiles-unknown-${label}-`);
    const file = profilesPath(dataDir);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        profiles: [
          {
            id: "ok-peer",
            adapterId: "fake",
            fake: { waitForSignal: true },
          },
          row,
        ],
      }) + "\n",
      "utf8"
    );

    const cap = captureConsoleError();
    try {
      const loaded = await loadAgentProfiles(dataDir);
      assert.deepEqual(loaded, [], `${label}: unknown key must empty catalog after quarantine`);
      await assert.rejects(() => fs.access(file), { code: "ENOENT" });

      const names = await fs.readdir(dataDir);
      const backups = names.filter((n) => n.startsWith("agent-profiles.json.corrupt-"));
      assert.equal(backups.length, 1, `${label}: expected one corrupt backup`);

      const backupRaw = await fs.readFile(path.join(dataDir, backups[0]!), "utf8");
      assert.ok(
        backupRaw.includes(backupMarker),
        `${label}: quarantine backup must retain unknown field`
      );
      const quarantined = JSON.parse(backupRaw) as { profiles: unknown[] };
      assert.equal(
        quarantined.profiles.length,
        2,
        `${label}: backup must keep the full original file`
      );
      assert.ok(cap.lines.some((l) => /agent-profiles\.json was corrupt/.test(l)));
    } finally {
      cap.restore();
    }
  }
});

test("SessionRegistry: corrupt row is backed up, ignored, and does not poison list", async () => {
  const dataDir = await tempDir("tent-sess-corrupt-");
  const reg = new SessionRegistry(dataDir);
  const now = "2026-01-01T00:00:00.000Z";
  await reg.write({
    id: "ss-good01",
    profileId: "fake-default",
    adapterId: "fake",
    state: "live",
    createdAt: now,
    updatedAt: now,
  });

  const badId = "ss-bad001";
  const badFile = path.join(dataDir, "sessions", `${badId}.json`);
  await fs.writeFile(badFile, "{ not-json", "utf8");

  const cap = captureConsoleError();
  try {
    const read = await reg.read(badId);
    assert.equal(read, null);

    const listed = await reg.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "ss-good01");

    const names = await fs.readdir(path.join(dataDir, "sessions"));
    const backups = names.filter((n) => n.startsWith(`${badId}.json.corrupt-`));
    assert.equal(backups.length, 1);
    // Original path is renamed away so list/read do not re-quarantine.
    assert.equal(names.includes(`${badId}.json`), false);
    assert.match(cap.lines.join("\n"), /ss-bad001\.json was corrupt.*ignored/);
    // Second read of the same id must not emit another warning.
    const warnCount = cap.lines.filter((l) => /ss-bad001\.json was corrupt/.test(l)).length;
    await reg.read(badId);
    const warnCountAfter = cap.lines.filter((l) => /ss-bad001\.json was corrupt/.test(l)).length;
    assert.equal(warnCountAfter, warnCount);

    // Fresh write of same id must succeed atomically.
    await reg.write({
      id: badId,
      profileId: "fake-default",
      adapterId: "fake",
      state: "stopped",
      createdAt: now,
      updatedAt: now,
    });
    const repaired = await reg.read(badId);
    assert.ok(repaired);
    assert.equal(repaired!.state, "stopped");
  } finally {
    cap.restore();
  }
});

test("SessionRegistry: missing session is null without corrupt backup", async () => {
  const dataDir = await tempDir("tent-sess-missing-");
  const reg = new SessionRegistry(dataDir);
  const cap = captureConsoleError();
  try {
    const read = await reg.read("ss-missing");
    assert.equal(read, null);
    assert.equal(cap.lines.length, 0);
    const names = await fs.readdir(dataDir).catch(() => [] as string[]);
    assert.equal(
      names.some((n) => n.includes(".corrupt-")),
      false
    );
  } finally {
    cap.restore();
  }
});

test("service endpoint write is atomic pretty JSON; malformed read is null", async () => {
  const dataDir = await tempDir("tent-svc-ep-");
  await writeServiceEndpoint(dataDir, {
    pid: 1234,
    host: "127.0.0.1",
    port: 7788,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
    token: "tok-test",
  });
  const file = serviceEndpointPath(dataDir);
  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.port, 7788);

  await fs.writeFile(file, "{ broken", "utf8");
  const cap = captureConsoleError();
  try {
    const ep = await readServiceEndpoint(dataDir);
    assert.equal(ep, null);
    // Regeneratable — no corrupt backup noise required.
    assert.equal(cap.lines.length, 0);
  } finally {
    cap.restore();
  }
});

test("service endpoint discovery rejects non-loopback or invalid coordinates", async () => {
  const dataDir = await tempDir("tent-svc-ep-invalid-");
  const base = {
    pid: 1234,
    host: "127.0.0.1",
    port: 7788,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
  };
  await writeServiceEndpoint(dataDir, { ...base, host: "203.0.113.8" });
  assert.equal(await readServiceEndpoint(dataDir), null);
  await writeServiceEndpoint(dataDir, { ...base, port: 70000 });
  assert.equal(await readServiceEndpoint(dataDir), null);
  await writeServiceEndpoint(dataDir, { ...base, pid: -1 });
  assert.equal(await readServiceEndpoint(dataDir), null);
});

test("service endpoint removal is scoped to its owning instance", async () => {
  const dataDir = await tempDir("tent-svc-ep-owner-");
  await writeServiceEndpoint(dataDir, {
    instanceId: "instance-current",
    pid: 1234,
    host: "127.0.0.1",
    port: 7788,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "0.1.0",
  });

  await removeServiceEndpoint(dataDir, "instance-old");
  assert.equal((await readServiceEndpoint(dataDir))?.instanceId, "instance-current");
  await removeServiceEndpoint(dataDir, "instance-current");
  assert.equal(await readServiceEndpoint(dataDir), null);
});

test("service data-dir lease rejects a live second owner and releases idempotently", async () => {
  const dataDir = await tempDir("tent-svc-lease-live-");
  const first = await acquireServiceDataDirLease(dataDir, {
    pid: 101,
    makeInstanceId: () => "instance-first",
    isProcessAlive: (pid) => pid === 101,
  });

  await assert.rejects(
    () =>
      acquireServiceDataDirLease(dataDir, {
        pid: 202,
        makeInstanceId: () => "instance-second",
        isProcessAlive: (pid) => pid === 101,
      }),
    (error: unknown) =>
      error instanceof ServiceDataDirBusyError && error.owner.instanceId === "instance-first"
  );

  await first.release();
  await first.release();
  const second = await acquireServiceDataDirLease(dataDir, {
    pid: 202,
    makeInstanceId: () => "instance-second",
    isProcessAlive: () => true,
  });
  await second.release();
  await assert.rejects(() => fs.access(serviceLeasePath(dataDir)), /ENOENT/);
});

test("service data-dir lease reclaims stale state and release is ownership-safe", async () => {
  const dataDir = await tempDir("tent-svc-lease-stale-");
  const lockPath = serviceLeasePath(dataDir);
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      instanceId: "stale-owner",
      pid: 303,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8"
  );

  const lease = await acquireServiceDataDirLease(dataDir, {
    pid: 404,
    makeInstanceId: () => "current-owner",
    isProcessAlive: () => false,
  });
  const replacement = {
    instanceId: "replacement-owner",
    pid: 505,
    startedAt: "2026-01-02T00:00:00.000Z",
  };
  await fs.writeFile(lockPath, JSON.stringify(replacement), "utf8");
  await lease.release();

  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, "utf8")), replacement);
});

test("startLocalTentService owns one dataDir until stop", async () => {
  const dataDir = await tempDir("tent-svc-single-owner-");
  const first = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const endpointBefore = await readServiceEndpoint(dataDir);
    await assert.rejects(
      () => startLocalTentService({ dataDir, writeEndpoint: true }),
      ServiceDataDirBusyError
    );
    assert.deepEqual(await readServiceEndpoint(dataDir), endpointBefore);
  } finally {
    await first.stop();
  }

  const next = await startLocalTentService({ dataDir, writeEndpoint: true });
  await next.stop();
});

test("failed service startup releases its data-dir lease", async () => {
  const blockerDir = await tempDir("tent-svc-port-owner-");
  const failedDir = await tempDir("tent-svc-port-failed-");
  const blocker = await startLocalTentService({ dataDir: blockerDir, port: 0 });
  const occupiedPort = blocker.port;
  try {
    await assert.rejects(
      () => startLocalTentService({ dataDir: failedDir, port: occupiedPort }),
      /EADDRINUSE/
    );
    await assert.rejects(() => fs.access(serviceLeasePath(failedDir)), /ENOENT/);
  } finally {
    await blocker.stop();
  }

  const recovered = await startLocalTentService({ dataDir: failedDir, port: occupiedPort });
  await recovered.stop();
});

test("saveAgentProfiles uses atomic pretty JSON", async () => {
  const dataDir = await tempDir("tent-profiles-atomic-");
  await saveAgentProfiles(dataDir, [
    { id: "p1", adapterId: "fake", displayNameKey: "profile.fake.default" },
  ]);
  const raw = await fs.readFile(profilesPath(dataDir), "utf8");
  assert.equal(raw.endsWith("\n"), true);
  const parsed = JSON.parse(raw) as { profiles: Array<{ id: string }> };
  assert.equal(parsed.profiles[0].id, "p1");
});
