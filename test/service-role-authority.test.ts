/**
 * Role authority MVP: registry.role.create/update/delete + allowedProfiles projection.
 * Layer: CLIENT_METHODS + user-only MutationBus + registry.roles.updated + startSession whitelist.
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
import { makeSessionId } from "../src/runtime/types.js";
import {
  CLIENT_METHODS,
  isClientMethod,
  RPC_A2A_DENIED,
  RPC_LIFECYCLE,
} from "../src/service/types.js";

async function makeWorkspace(name = "role-auth"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-auth-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nRole authority\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "dispatch", a2aPolicy: "allow", allowedProfiles: ["fake-default"] },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-role-auth-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

async function rpc(
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

test("CLIENT_METHODS includes registry.role.create/update/delete", () => {
  assert.ok(isClientMethod("registry.role.create"));
  assert.ok(isClientMethod("registry.role.update"));
  assert.ok(isClientMethod("registry.role.delete"));
  assert.ok(CLIENT_METHODS.includes("registry.role.create"));
  assert.ok(CLIENT_METHODS.includes("registry.roles"));
});

test("registry.roles projection returns allowedProfiles + roleId/displayName", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const listed = await rpc(svc, "registry.roles", { workspaceId });
    assert.ok(!listed.error, JSON.stringify(listed.error));
    const roles = (listed.result as {
      roles: Array<{
        roleId: string;
        name: string;
        displayName: string;
        a2aPolicy?: string;
        allowedProfiles?: string[];
      }>;
    }).roles;
    const orch = roles.find((r) => r.name === "orchestrator");
    assert.ok(orch);
    assert.ok(orch!.roleId.startsWith("rl-"));
    assert.equal(orch!.displayName, "orchestrator");
    assert.equal(orch!.a2aPolicy, "allow");
    assert.deepEqual(orch!.allowedProfiles, ["fake-default"]);
    const exec = roles.find((r) => r.name === "executor");
    assert.ok(exec);
    assert.ok(exec!.roleId.startsWith("rl-"));
    assert.equal(exec!.displayName, "executor");
    assert.equal(exec!.allowedProfiles, undefined);

    // Legacy roles.json without id stays legacy on disk after plain projection read
    const disk = JSON.parse(
      await fs.readFile(path.join(ws, ".tent", "roles.json"), "utf8")
    ) as { roles: Array<{ id?: string; name: string; displayName?: string }> };
    const diskOrch = disk.roles.find((r) => r.name === "orchestrator");
    assert.ok(diskOrch);
    assert.equal(diskOrch!.id, undefined, "projection/list must not persist backfill");
    assert.equal(diskOrch!.displayName, undefined);
  });
});

test("registry.role.create/update: user-only, MutationBus, one registry.roles.updated", async () => {
  const ws = await makeWorkspace("role-crud");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "registry.roles.updated") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    const denied = await rpc(svc, "registry.role.create", {
      workspaceId,
      name: "critic",
      prompt: "review",
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.match(denied.error!.message, /user-only/i);
    assert.equal(events.length, 0);

    const secretDenied = await rpc(svc, "registry.role.create", {
      workspaceId,
      name: "bad",
      secret: "sk-should-not",
    });
    assert.ok(secretDenied.error);
    assert.equal(secretDenied.error!.code, -32602);
    assert.equal(events.length, 0);

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const created = (await client.registryRoleCreate(workspaceId, {
      name: "critic",
      displayName: "评审",
      prompt: "挑问题",
      description: "reviewer",
      a2aPolicy: "allow",
      allowedProfiles: ["  fake-default ", "fake-default", ""],
    })) as {
      role: {
        roleId: string;
        name: string;
        displayName: string;
        prompt?: string;
        a2aPolicy?: string;
        allowedProfiles?: string[];
      };
    };
    assert.equal(created.role.name, "critic");
    assert.equal(created.role.displayName, "评审");
    assert.ok(created.role.roleId.startsWith("rl-"));
    assert.equal(created.role.a2aPolicy, "allow");
    assert.deepEqual(created.role.allowedProfiles, ["fake-default"]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, "create");
    assert.equal(events[0]!.name, "critic");
    assert.equal(events[0]!.roleId, created.role.roleId);
    assert.equal(events[0]!.displayName, "评审");

    // operational name rename rejected; displayName rename allowed
    const rename = await rpc(svc, "registry.role.update", {
      workspaceId,
      name: "critic",
      newName: "critic2",
      prompt: "x",
    });
    assert.ok(rename.error);
    assert.equal(rename.error!.code, -32602);
    assert.match(String(rename.error!.message), /rename|displayName|operational/i);
    assert.equal(events.length, 1);

    const label = await rpc(svc, "registry.role.update", {
      workspaceId,
      roleId: created.role.roleId,
      name: "critic",
      displayName: "评审官",
    });
    assert.ok(!label.error, JSON.stringify(label.error));
    assert.equal(
      (label.result as { role: { displayName: string; roleId: string; name: string } }).role
        .displayName,
      "评审官"
    );
    assert.equal(
      (label.result as { role: { name: string } }).role.name,
      "critic"
    );
    assert.equal(events.length, 2);

    const updated = (await client.registryRoleUpdate(workspaceId, "critic", {
      prompt: "挑关键问题",
      allowedProfiles: ["codex-acp", " fake-default "],
    })) as {
      role: { prompt?: string; allowedProfiles?: string[]; roleId: string };
    };
    assert.equal(updated.role.prompt, "挑关键问题");
    assert.deepEqual(updated.role.allowedProfiles, ["codex-acp", "fake-default"]);
    assert.equal(updated.role.roleId, created.role.roleId);
    assert.equal(events.length, 3);
    assert.equal(events[2]!.action, "update");

    // clear whitelist
    const cleared = (await client.registryRoleUpdate(workspaceId, "critic", {
      prompt: null,
      description: "",
      color: null,
      a2aPolicy: null,
      allowedProfiles: [],
      cli: null,
    })) as {
      role: {
        prompt?: string;
        description?: string;
        color?: string;
        a2aPolicy?: string;
        allowedProfiles?: string[];
        roleId: string;
      };
    };
    assert.equal(cleared.role.prompt, undefined);
    assert.equal(cleared.role.description, undefined);
    assert.equal(cleared.role.color, undefined);
    assert.equal(cleared.role.a2aPolicy, "deny");
    assert.equal(cleared.role.allowedProfiles, undefined);
    assert.equal(cleared.role.roleId, created.role.roleId);
    assert.equal(events.length, 4);

    // disk: role id present; no secrets
    const disk = JSON.parse(
      await fs.readFile(path.join(ws, ".tent", "roles.json"), "utf8")
    ) as { roles: Array<Record<string, unknown>> };
    const critic = disk.roles.find((r) => r.name === "critic");
    assert.ok(critic);
    assert.equal(critic!.id, created.role.roleId);
    assert.equal(critic!.displayName, "评审官");
    assert.equal("secret" in critic!, false);
    assert.equal(critic!.allowedProfiles, undefined);

    // failure does not emit
    const missing = await rpc(svc, "registry.role.update", {
      workspaceId,
      name: "no-such-role",
      prompt: "x",
    });
    assert.ok(missing.error);
    assert.equal(events.length, 4);

    unsub();
  });
});

test("registry.role.delete: confirmation, blocks active task, one event on success", async () => {
  const ws = await makeWorkspace("role-delete");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "registry.roles.updated") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    await client.registryRoleCreate(workspaceId, {
      name: "temp-role",
      prompt: "temp",
    });
    assert.equal(events.length, 1);

    // confirmation mismatch
    const badConfirm = await rpc(svc, "registry.role.delete", {
      workspaceId,
      name: "temp-role",
      confirmation: "wrong",
    });
    assert.ok(badConfirm.error);
    assert.equal(badConfirm.error!.code, -32602);
    assert.equal(events.length, 1);

    // non-user actor
    const denied = await rpc(svc, "registry.role.delete", {
      workspaceId,
      name: "temp-role",
      confirmation: "temp-role",
      actor: "executor",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.equal(events.length, 1);

    // active task blocks delete of executor
    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "work-item",
      type: "prompt",
    });
    assert.ok(!note.error, JSON.stringify(note.error));
    const boxId = (note.result as { id: string }).id;
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "executor",
      prompt: "block delete",
    });
    assert.ok(!d.error, JSON.stringify(d.error));

    const blocked = await rpc(svc, "registry.role.delete", {
      workspaceId,
      name: "executor",
      confirmation: "executor",
    });
    assert.ok(blocked.error);
    assert.equal(blocked.error!.code, RPC_LIFECYCLE);
    assert.match(String(blocked.error!.message), /active task/i);
    assert.equal(events.length, 1);

    // cancel task then delete temp-role ok
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.cancel", { workspaceId, taskPath });

    const deleted = (await client.registryRoleDelete(
      workspaceId,
      "temp-role",
      "temp-role"
    )) as { deleted: string };
    assert.equal(deleted.deleted, "temp-role");
    assert.equal(events.length, 2);
    assert.equal(events[1]!.action, "delete");
    assert.equal(events[1]!.name, "temp-role");

    const listed = await rpc(svc, "registry.roles", { workspaceId });
    const roles = (listed.result as { roles: { name: string }[] }).roles;
    assert.ok(!roles.some((r) => r.name === "temp-role"));

    unsub();
  });
});

test("registry.role.delete refuses live managed session", async () => {
  const ws = await makeWorkspace("role-live-session");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const started = await svc.runtime.startSession({
      sessionId: makeSessionId(),
      profileId: "fake-default",
      roleName: "executor",
      workspace: workspaceId,
      cwd: ws,
      runtimeWorkspace: { cwd: ws },
    });
    assert.ok(started.state === "live" || started.state === "starting");

    const events: unknown[] = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "registry.roles.updated") events.push(ev.payload);
    });

    const blocked = await rpc(svc, "registry.role.delete", {
      workspaceId,
      name: "executor",
      confirmation: "executor",
    });
    assert.ok(blocked.error);
    assert.equal(blocked.error!.code, RPC_LIFECYCLE);
    assert.match(String(blocked.error!.message), /active managed session/i);
    assert.equal(events.length, 0);
    unsub();
  });
});

test("ServiceClient registry role convenience + startSession allow whitelist", async () => {
  const ws = await makeWorkspace("role-client");
  await withService(async (svc) => {
    const workspaceId = await mount(svc, ws);
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });

    await client.registryRoleUpdate(workspaceId, "executor", {
      a2aPolicy: "allow",
      allowedProfiles: ["fake-default"],
    });

    const note = await rpc(svc, "docs.createNote", {
      workspaceId,
      name: "allow-box",
      type: "prompt",
    });
    const boxId = (note.result as { id: string }).id;
    const d = await rpc(svc, "task.dispatch", {
      parentActor: { kind: "user", id: "user" },
      reviewer: { kind: "user", id: "user" },
      workspaceId,
      boxId,
      role: "executor",
      prompt: "whitelist",
    });
    const taskPath = (d.result as { taskPath: string }).taskPath;
    await rpc(svc, "task.claim", { workspaceId, taskPath });

    const denied = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "not-listed",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, RPC_A2A_DENIED);

    const ok = await rpc(svc, "task.startSession", {
      workspaceId,
      taskPath,
      callerKind: "role",
      profileId: "fake-default",
    });
    assert.ok(!ok.error, JSON.stringify(ok.error));
  });
});
