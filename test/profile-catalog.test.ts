/**
 * Machine-local Grok ACP Profile Catalog (service-process serial CRUD).
 * Focused: hot CRUD, disk persist, dangerous field reject, projection, delete gates,
 * permissionTimeoutMs lookup from runtime after update.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import {
  FAKE_DEFAULT_PROFILE_ID,
  GROK_ACP_DEFAULT_PROFILE_ID,
  loadAgentProfiles,
  profilesPath,
  projectAgentProfile,
} from "../src/service/profiles.js";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import {
  DEFAULT_GROK_MODEL,
  GROK_ACP_ADAPTER_ID,
} from "../src/adapters/grok-acp/index.js";
import type { AgentProfileConfig } from "../src/runtime/types.js";

const MOCK_ACP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "mock-acp-server.mjs"
);

function seedProfiles(): AgentProfileConfig[] {
  return [
    {
      id: FAKE_DEFAULT_PROFILE_ID,
      adapterId: FAKE_ADAPTER_ID,
      displayNameKey: "profile.fake.default",
      fake: { waitForSignal: true, emitStdout: true, canResume: true },
    },
    {
      id: GROK_ACP_DEFAULT_PROFILE_ID,
      adapterId: GROK_ACP_ADAPTER_ID,
      displayNameKey: "profile.grokAcp.default",
      grokAcp: {
        model: DEFAULT_GROK_MODEL,
        envKey: "CPA_GROK_API_KEY",
        baseUrlEnvKey: "CPA_GROK_BASE_URL",
        permissionPolicy: "deny",
        permissionTimeoutMs: 120_000,
      },
    },
  ];
}

function mockAcpProfile(
  id: string,
  opts: {
    logPath: string;
    permissionTimeoutMs?: number;
    permissionPolicy?: "deny" | "allow" | "ask";
    requestPermission?: boolean;
  }
): AgentProfileConfig {
  return {
    id,
    adapterId: GROK_ACP_ADAPTER_ID,
    command: process.execPath,
    args: [MOCK_ACP, "agent", "--model", DEFAULT_GROK_MODEL, "stdio"],
    env: {
      MOCK_ACP_LOG: opts.logPath,
      MOCK_ACP_KEEP_ALIVE: "1",
      MOCK_ACP_PROMPT_TEXT: "CATALOG_TIMEOUT_REPORT",
      ...(opts.requestPermission ? { MOCK_ACP_REQUEST_PERMISSION: "1" } : {}),
      CPA_GROK_API_KEY: "test-key-not-real",
    },
    grokAcp: {
      model: DEFAULT_GROK_MODEL,
      envKey: "CPA_GROK_API_KEY",
      permissionPolicy: opts.permissionPolicy ?? "ask",
      promptTimeoutMs: 8_000,
      permissionTimeoutMs: opts.permissionTimeoutMs ?? 400,
    },
  };
}

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "pcat",
    rules: "# RULES\n\nprofile catalog tests\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "dispatch work" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<void>,
  profiles?: AgentProfileConfig[]
): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    profiles: profiles ?? seedProfiles(),
  });
  try {
    await fn(svc);
  } finally {
    await svc.stop();
  }
  return dataDir;
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
  label = "condition"
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test("profile CRUD: create/update/get/list/delete + disk persist + runtime sync", async () => {
  const dataDir = await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    const created = (await client.profileCreate({
      id: "grok-acp-cpa-local",
      displayName: "CPA Local",
      model: "grok-4.5",
      envKey: "CPA_GROK_API_KEY",
      baseUrlEnvKey: "CPA_GROK_BASE_URL",
      baseUrl: "http://127.0.0.1:8317/v1",
      permissionPolicy: "ask",
      promptTimeoutMs: 60_000,
      permissionTimeoutMs: 5_000,
    })) as { profile: Record<string, unknown> };

    assert.equal(created.profile.id, "grok-acp-cpa-local");
    assert.equal(created.profile.adapterId, GROK_ACP_ADAPTER_ID);
    assert.equal(created.profile.displayName, "CPA Local");
    assert.equal(created.profile.permissionPolicy, "ask");
    assert.equal(created.profile.permissionTimeoutMs, 5_000);
    assert.ok(!("env" in created.profile));
    assert.ok(!("apiKey" in created.profile));

    // Runtime sees it immediately for new startSession resolution.
    assert.ok(svc.runtime.getProfile("grok-acp-cpa-local"));

    const got = (await client.profileGet("grok-acp-cpa-local")) as {
      profile: { model?: string; baseUrl?: string };
    };
    assert.equal(got.profile.model, "grok-4.5");
    assert.equal(got.profile.baseUrl, "http://127.0.0.1:8317/v1");

    const updated = (await client.profileUpdate("grok-acp-cpa-local", {
      displayName: "CPA Local 2",
      permissionTimeoutMs: 9_000,
      permissionPolicy: "deny",
    })) as { profile: { displayName: string; permissionTimeoutMs?: number } };
    assert.equal(updated.profile.displayName, "CPA Local 2");
    assert.equal(updated.profile.permissionTimeoutMs, 9_000);
    assert.equal(
      svc.runtime.getProfile("grok-acp-cpa-local")?.grokAcp?.permissionTimeoutMs,
      9_000
    );

    const list = (await client.profileList()) as {
      profiles: Array<{ id: string }>;
    };
    assert.ok(list.profiles.some((p) => p.id === "grok-acp-cpa-local"));
    assert.ok(list.profiles.every((p) => p.id !== FAKE_DEFAULT_PROFILE_ID));

    await client.profileDelete("grok-acp-cpa-local");
    assert.equal(svc.runtime.getProfile("grok-acp-cpa-local"), undefined);
    const gone = await rpc(svc, "profile.get", { id: "grok-acp-cpa-local" });
    assert.ok(gone.error);
    assert.equal(gone.error!.code, -32004);
  });

  // Persist survives process stop (file under the temp dataDir).
  const onDisk = await loadAgentProfiles(dataDir);
  assert.ok(!onDisk.some((p) => p.id === "grok-acp-cpa-local"));
  assert.ok(onDisk.some((p) => p.id === GROK_ACP_DEFAULT_PROFILE_ID));
});

test("profile CRUD: dangerous fields rejected and agent-profiles.json unchanged", async () => {
  await withService(async (svc) => {
    const file = profilesPath(svc.dataDir);
    // Seed disk so we can compare bytes after rejected writes.
    await fs.writeFile(
      file,
      JSON.stringify({ profiles: seedProfiles() }, null, 2) + "\n",
      "utf8"
    );
    const before = await fs.readFile(file, "utf8");

    for (const bad of [
      { id: "evil-1", apiKey: "sk-live-should-fail" },
      { id: "evil-2", token: "tok" },
      { id: "evil-3", secret: "s" },
      { id: "evil-4", env: { CPA_GROK_API_KEY: "sk-x" } },
      { id: "evil-5", adapterId: "fake-cli" },
      { id: "evil-6", unknownField: true },
    ]) {
      const res = await rpc(svc, "profile.create", bad);
      assert.ok(res.error, `expected reject for ${JSON.stringify(bad)}`);
      assert.equal(res.error!.code, -32602);
    }

    const after = await fs.readFile(file, "utf8");
    assert.equal(after, before);

    // Update on built-in also rejects secrets without mutation.
    const upd = await rpc(svc, "profile.update", {
      id: GROK_ACP_DEFAULT_PROFILE_ID,
      apiKey: "sk-nope",
    });
    assert.ok(upd.error);
    assert.equal(await fs.readFile(file, "utf8"), before);
  });
});

test("profile projection never returns env map or secret values", async () => {
  const raw: AgentProfileConfig = {
    id: "grok-acp-proj",
    adapterId: GROK_ACP_ADAPTER_ID,
    displayName: "Proj",
    env: { CPA_GROK_API_KEY: "sk-secret-value", TOKEN: "leak" },
    grokAcp: {
      model: "grok-4.5",
      envKey: "CPA_GROK_API_KEY",
      baseUrlEnvKey: "CPA_GROK_BASE_URL",
      executable: "/usr/local/bin/grok",
      permissionPolicy: "deny",
      permissionTimeoutMs: 1000,
    },
  };
  const proj = projectAgentProfile(raw);
  const json = JSON.stringify(proj);
  assert.ok(!json.includes("sk-secret-value"));
  assert.ok(!json.includes("leak"));
  assert.ok(!("env" in proj));
  assert.ok(!("fake" in proj));
  assert.ok(!("grokAcp" in proj));
  assert.equal(proj.envKey, "CPA_GROK_API_KEY");
  assert.equal(proj.executable, "/usr/local/bin/grok");
  assert.equal(proj.permissionTimeoutMs, 1000);
});

test("profile delete: refuse while non-terminal session uses profile; allow after stop", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-del-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  const profiles = [
    ...seedProfiles(),
    mockAcpProfile("grok-acp-deletable", {
      logPath,
      permissionPolicy: "deny",
      requestPermission: false,
    }),
  ];
  // Register deletable via create after boot so catalog owns a pure grok-acp row.
  // For active session we need a startable profile — use mock inject id then delete that id.
  const ws = await makeWorkspace();
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    profiles,
  });
  try {
    const { workspaceId } = (
      await rpc(svc, "workspace.mount", { workspaceRoot: ws })
    ).result as { workspaceId: string };
    const box = (
      await rpc(svc, "docs.createNote", {
        workspaceId,
        name: "work-item",
        type: "prompt",
      })
    ).result as { id: string };
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: box.id,
      role: "executor",
      prompt: "hold session",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "grok-acp-deletable",
    });
    assert.ok(!started.error, JSON.stringify(started.error));

    const blocked = await rpc(svc, "profile.delete", { id: "grok-acp-deletable" });
    assert.ok(blocked.error, "delete must fail while session live");
    assert.match(blocked.error!.message, /non-terminal|session/i);

    // Still on disk / runtime.
    assert.ok(svc.runtime.getProfile("grok-acp-deletable"));

    await rpc(svc, "task.interrupt", { workspaceId, taskPath });
    await pollUntil(async () => {
      const list = await rpc(svc, "session.list", { workspaceId });
      const sessions = (list.result as { sessions: Array<{ state: string; profileId: string }> })
        .sessions;
      const mine = sessions.find((s) => s.profileId === "grok-acp-deletable");
      if (!mine) return true;
      return mine.state === "stopped" || mine.state === "failed" ? true : null;
    }, 12_000, "session terminal");

    const del = await rpc(svc, "profile.delete", { id: "grok-acp-deletable" });
    assert.ok(!del.error, JSON.stringify(del.error));
    assert.equal(svc.runtime.getProfile("grok-acp-deletable"), undefined);

    // Built-in and fake cannot be deleted.
    const noDefault = await rpc(svc, "profile.delete", {
      id: GROK_ACP_DEFAULT_PROFILE_ID,
    });
    assert.ok(noDefault.error);
    const noFake = await rpc(svc, "profile.delete", { id: FAKE_DEFAULT_PROFILE_ID });
    assert.ok(noFake.error);
    const noFakeUpd = await rpc(svc, "profile.update", {
      id: FAKE_DEFAULT_PROFILE_ID,
      displayName: "nope",
    });
    assert.ok(noFakeUpd.error);
  } finally {
    await svc.stop();
  }
});

test("permission timeout lookup uses runtime profile after catalog update", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-pcat-pto-"));
  const logPath = path.join(dataDir, "mock-acp-log.json");
  // Boot with a long timeout; update catalog to a short one before startSession.
  const profiles = [
    ...seedProfiles(),
    mockAcpProfile("grok-acp-timeout-live", {
      logPath,
      permissionPolicy: "ask",
      requestPermission: true,
      permissionTimeoutMs: 60_000,
    }),
  ];
  const ws = await makeWorkspace();
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: false,
    profiles,
  });
  try {
    // Hot update: service must not close over boot profiles array.
    const upd = await rpc(svc, "profile.update", {
      id: "grok-acp-timeout-live",
      permissionTimeoutMs: 400,
    });
    assert.ok(!upd.error, JSON.stringify(upd.error));
    assert.equal(
      svc.runtime.getProfile("grok-acp-timeout-live")?.grokAcp?.permissionTimeoutMs,
      400
    );

    const { workspaceId } = (
      await rpc(svc, "workspace.mount", { workspaceRoot: ws })
    ).result as { workspaceId: string };
    const box = (
      await rpc(svc, "docs.createNote", {
        workspaceId,
        name: "timeout-item",
        type: "prompt",
      })
    ).result as { id: string };
    const d = await rpc(svc, "task.dispatch", {
      workspaceId,
      boxId: box.id,
      role: "executor",
      prompt: "tool ask with updated timeout",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });
    const started = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "user",
      profileId: "grok-acp-timeout-live",
    });
    assert.ok(!started.error, JSON.stringify(started.error));

    const pending = await pollUntil(async () => {
      const list = await rpc(svc, "toolApproval.listPending", { workspaceId });
      const approvals = (
        list.result as { approvals: Array<{ id: string; expiresAt: string; createdAt: string }> }
      ).approvals;
      return approvals[0] ?? null;
    }, 12_000, "pending tool approval");

    const created = Date.parse(pending.createdAt);
    const expires = Date.parse(pending.expiresAt);
    const windowMs = expires - created;
    // Updated 400ms (+ small store skew) — must not still be the boot 60s.
    assert.ok(windowMs < 5_000, `expected short timeout window, got ${windowMs}ms`);
    assert.ok(windowMs >= 300, `timeout window too small: ${windowMs}ms`);

    const expired = await pollUntil(async () => {
      const got = await rpc(svc, "toolApproval.get", { approvalId: pending.id });
      if (got.error) return null;
      const approval = (got.result as { approval: { status: string } }).approval;
      return approval.status === "expired" ? approval : null;
    }, 8_000, "store expiry with updated timeout");
    assert.equal(expired.status, "expired");
  } finally {
    await svc.stop();
  }
});

test("validation: id / env key / URL / enum / positive int", async () => {
  await withService(async (svc) => {
    const badId = await rpc(svc, "profile.create", { id: "BAD_ID" });
    assert.ok(badId.error);
    assert.match(badId.error!.message, /id/i);

    const badEnv = await rpc(svc, "profile.create", {
      id: "grok-acp-bad-env",
      envKey: "not-valid-key!",
    });
    assert.ok(badEnv.error);
    assert.match(badEnv.error!.message, /envKey/i);

    const badUrl = await rpc(svc, "profile.create", {
      id: "grok-acp-bad-url",
      baseUrl: "ftp://x",
    });
    assert.ok(badUrl.error);
    assert.match(badUrl.error!.message, /baseUrl/i);

    const badPol = await rpc(svc, "profile.create", {
      id: "grok-acp-bad-pol",
      permissionPolicy: "yolo",
    });
    assert.ok(badPol.error);
    assert.match(badPol.error!.message, /permissionPolicy/i);

    const badMs = await rpc(svc, "profile.create", {
      id: "grok-acp-bad-ms",
      permissionTimeoutMs: 0,
    });
    assert.ok(badMs.error);
    assert.match(badMs.error!.message, /permissionTimeoutMs/i);

    // grok-acp-default editable; fake not.
    const editDefault = await rpc(svc, "profile.update", {
      id: GROK_ACP_DEFAULT_PROFILE_ID,
      displayName: "Grok ACP Custom",
    });
    assert.ok(!editDefault.error, JSON.stringify(editDefault.error));
  });
});
