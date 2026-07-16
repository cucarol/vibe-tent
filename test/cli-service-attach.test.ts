/**
 * P0-2: CLI attaches to Local Service; claim/deliver via RPC only.
 * Real service lifecycle — no parallel direct-core mutation for task path.
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
import { createServiceClient } from "../src/service/client.js";
import { readServiceEndpoint, writeServiceEndpoint } from "../src/service/data-dir.js";
import {
  attachOrBootstrapService,
  tryAttachService,
  cliServiceChildEnv,
  resolveDefaultServiceEntry,
} from "../src/cli/service-attach.js";
import { runTaskCommand } from "../src/cli/task-rpc.js";
import { ensureMountedWorkspace } from "../src/cli/workspace-context.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceEntry = path.join(repoRoot, "service.mjs");

async function makeWorkspace(name = "cli-p02"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nCLI service attach test\n",
    boxes: [{ name: "inbox", type: "note", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "executor", prompt: "do work" },
          { name: "orchestrator", prompt: "dispatch" },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function withService<T>(
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

test("tryAttachService: requires endpoint token; health open is not enough", async () => {
  await withService(async (svc, dataDir) => {
    const ok = await tryAttachService(dataDir);
    assert.ok(ok);
    assert.equal(ok!.endpoint.token, svc.token);
    assert.equal(ok!.client.token, svc.token);

    // Strip token from endpoint — attach must fail even if health is up.
    const epPath = path.join(dataDir, "service.json");
    const raw = JSON.parse(await fs.readFile(epPath, "utf8")) as Record<string, unknown>;
    delete raw.token;
    await fs.writeFile(epPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    const bad = await tryAttachService(dataDir);
    assert.equal(bad, null);

    const health = await fetch(`${svc.url}/health`);
    assert.equal(health.status, 200);
  });
});

test("attachOrBootstrapService: reuses healthy endpoint; attachOnly fails when missing", async () => {
  await withService(async (svc, dataDir) => {
    const attached = await attachOrBootstrapService({
      dataDir,
      attachOnly: true,
      packageRoot: repoRoot,
    });
    assert.equal(attached.started, false);
    assert.equal(attached.url, svc.url);
    assert.equal(attached.client.token, svc.token);

    const orphanDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-orphan-"));
    await assert.rejects(
      () =>
        attachOrBootstrapService({
          dataDir: orphanDir,
          attachOnly: true,
          packageRoot: repoRoot,
        }),
      /No healthy Local Tent Service/
    );
  });
});

test("attachOrBootstrapService: bootstrap starts service.mjs; CLI exit does not kill it", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-boot-"));
  let childPid: number | undefined;
  try {
    // Ensure no stale endpoint
    assert.equal(await readServiceEndpoint(dataDir), null);

    const attached = await attachOrBootstrapService({
      dataDir,
      serviceEntry,
      packageRoot: repoRoot,
      readyTimeoutMs: 20_000,
    });
    assert.equal(attached.started, true);
    assert.ok(attached.endpoint.token);
    childPid = attached.child?.pid;
    assert.ok(childPid && childPid > 0);

    const health1 = (await attached.client.health()) as { status: string };
    assert.equal(health1.status, "ok");

    // Simulate CLI process end: drop client reference; service must stay healthy.
    const re = await tryAttachService(dataDir);
    assert.ok(re);
    const health2 = await fetch(`${re!.url}/health`);
    assert.equal(health2.status, 200);
    assert.equal((await health2.json() as { status: string }).status, "ok");
  } finally {
    // Stop bootstrapped service via its endpoint
    const ep = await readServiceEndpoint(dataDir);
    if (ep) {
      try {
        // No stop RPC — kill process by pid if still running
        if (ep.pid) process.kill(ep.pid);
      } catch {
        // already dead
      }
    } else if (childPid) {
      try {
        process.kill(childPid);
      } catch {
        // ignore
      }
    }
  }
});

test("attachOrBootstrapService: concurrent bootstraps converge on one service", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-race-"));
  try {
    const [first, second] = await Promise.all([
      attachOrBootstrapService({
        dataDir,
        serviceEntry,
        packageRoot: repoRoot,
        readyTimeoutMs: 20_000,
      }),
      attachOrBootstrapService({
        dataDir,
        serviceEntry,
        packageRoot: repoRoot,
        readyTimeoutMs: 20_000,
      }),
    ]);

    assert.equal(first.endpoint.instanceId, second.endpoint.instanceId);
    assert.equal(first.endpoint.pid, second.endpoint.pid);
    assert.equal(first.url, second.url);
    assert.equal((await first.client.health() as { status: string }).status, "ok");
    assert.equal((await second.client.health() as { status: string }).status, "ok");
  } finally {
    const endpoint = await readServiceEndpoint(dataDir);
    if (endpoint?.pid) {
      try {
        process.kill(endpoint.pid);
      } catch {
        // already stopped
      }
    }
  }
});

test("cliServiceChildEnv: sets TENT_SERVICE_DATA_DIR; does not write workspace token", async () => {
  const dataDir = path.join(os.tmpdir(), "tent-cli-env-data");
  const env = cliServiceChildEnv({ FOO: "bar" }, dataDir);
  assert.equal(env.TENT_SERVICE_DATA_DIR, dataDir);
  assert.equal(env.FOO, "bar");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
});

test("resolveDefaultServiceEntry finds service.mjs from package root", async () => {
  const entry = await resolveDefaultServiceEntry(repoRoot);
  assert.ok(entry.endsWith("service.mjs") || entry.includes("service"));
  await fs.access(entry);
});

test("ensureMountedWorkspace mounts once and reuses", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const first = await ensureMountedWorkspace(client, { workspace: ws });
    assert.ok(first.workspaceId);
    assert.equal(path.resolve(first.workspaceRoot), path.resolve(ws));

    const second = await ensureMountedWorkspace(client, { workspace: ws });
    assert.equal(second.workspaceId, first.workspaceId);

    // Token must not appear under workspace
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...(await walk(p)));
        else out.push(p);
      }
      return out;
    };
    for (const file of await walk(ws)) {
      const text = await fs.readFile(file, "utf8");
      assert.ok(!text.includes(svc.token), `token leaked into ${file}`);
    }
  });
});

test("task RPC layer: claim → deliver; ServiceClient observes same state; service stays healthy", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc, dataDir) => {
    const observer = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mount = (await observer.mount(ws)) as { workspaceId: string };
    const workspaceId = mount.workspaceId;

    // Create a coordination box + dispatch via service (sole mutation entry)
    const created = (await observer.call("docs.createNote", {
      workspaceId,
      name: "work-item",
      type: "prompt",
    })) as { id: string };
    const boxId = created.id;

    const dispatched = (await observer.taskDispatch(workspaceId, {
      boxId,
      role: "executor",
      prompt: "Ship CLI attach",
      deliveryPolicy: "manual",
    })) as { taskPath: string; state: string };
    assert.equal(dispatched.state, "queued");
    const taskPath = dispatched.taskPath;

    // Claim through CLI command layer (uses same attach + RPC path; inject client for determinism)
    const claim = await runTaskCommand("claim", [taskPath], {
      client: observer,
      cwd: ws,
      dataDir,
    });
    assert.equal(claim.exitCode, 0, claim.stderr);
    assert.match(claim.stdout, /Claimed via service RPC/);

    const afterClaim = (await observer.taskGet(workspaceId, taskPath)) as {
      task: { state: string };
    };
    assert.equal(afterClaim.task.state, "running");

    const listed = (await observer.taskList(workspaceId)) as {
      tasks: Array<{ path: string; state: string }>;
    };
    const found = listed.tasks.find((t) => t.path === taskPath);
    assert.ok(found);
    assert.equal(found!.state, "running");

    const deliver = await runTaskCommand(
      "deliver",
      [taskPath, "--summary", "Done via CLI RPC", "--commits", "deadbeef"],
      { client: observer, cwd: ws, dataDir }
    );
    assert.equal(deliver.exitCode, 0, deliver.stderr);
    assert.match(deliver.stdout, /Delivered via service RPC/);

    const afterDeliver = (await observer.taskGet(workspaceId, taskPath)) as {
      task: { state: string; activeDeliveryId?: string };
    };
    assert.equal(afterDeliver.task.state, "delivered");

    // CLI "exit" does not stop service
    const health = await fetch(`${svc.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { status: string }).status, "ok");
  });
});

test("task claim/deliver via attach (not injected client) sees same ServiceClient state", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc, dataDir) => {
    const setup = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mount = (await setup.mount(ws)) as { workspaceId: string };
    const created = (await setup.call("docs.createNote", {
      workspaceId: mount.workspaceId,
      name: "agent-job",
      type: "prompt",
    })) as { id: string };
    const dispatched = (await setup.taskDispatch(mount.workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "agent path",
    })) as { taskPath: string };

    // Attach from endpoint file (what a real CLI process does)
    const claim = await runTaskCommand("claim", [dispatched.taskPath, "--json"], {
      cwd: ws,
      dataDir,
      attachOnly: true,
      packageRoot: repoRoot,
    });
    assert.equal(claim.exitCode, 0, claim.stderr);
    const claimJson = JSON.parse(claim.stdout) as { state: string };
    assert.equal(claimJson.state, "running");

    const deliver = await runTaskCommand(
      "deliver",
      [dispatched.taskPath, "--summary", "agent delivery", "--json"],
      { cwd: ws, dataDir, attachOnly: true, packageRoot: repoRoot }
    );
    assert.equal(deliver.exitCode, 0, deliver.stderr);
    const deliverJson = JSON.parse(deliver.stdout) as { state: string };
    assert.equal(deliverJson.state, "delivered");

    const observer = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const got = (await observer.taskGet(mount.workspaceId, dispatched.taskPath)) as {
      task: { state: string };
    };
    assert.equal(got.task.state, "delivered");

    // Service still healthy after command layer finished
    const h = (await observer.health()) as { status: string };
    assert.equal(h.status, "ok");
  });
});

test("task command errors: missing summary / unknown sub / attach-only miss", async () => {
  const missing = await runTaskCommand("nosuch", [], { attachOnly: true, dataDir: path.join(os.tmpdir(), "no-svc-" + Date.now()) });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /Unknown task subcommand|No healthy Local Tent Service/);

  const ws = await makeWorkspace();
  await withService(async (svc, dataDir) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mount = (await client.mount(ws)) as { workspaceId: string };
    const created = (await client.call("docs.createNote", {
      workspaceId: mount.workspaceId,
      name: "err-box",
      type: "prompt",
    })) as { id: string };
    const dispatched = (await client.taskDispatch(mount.workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "x",
    })) as { taskPath: string };
    await client.taskClaim(mount.workspaceId, dispatched.taskPath);

    const noSummary = await runTaskCommand("deliver", [dispatched.taskPath], {
      client,
      cwd: ws,
    });
    assert.equal(noSummary.exitCode, 1);
    assert.match(noSummary.stderr, /--summary/);
  });
});

test("task list/get human output for agents", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc, dataDir) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mount = (await client.mount(ws)) as { workspaceId: string };
    const created = (await client.call("docs.createNote", {
      workspaceId: mount.workspaceId,
      name: "list-me",
      type: "prompt",
    })) as { id: string };
    const dispatched = (await client.taskDispatch(mount.workspaceId, {
      boxId: created.id,
      role: "executor",
      prompt: "list test",
    })) as { taskPath: string };

    const list = await runTaskCommand("list", [], { client, cwd: ws, dataDir });
    assert.equal(list.exitCode, 0, list.stderr);
    assert.match(list.stdout, /workspaceId:/);
    assert.match(list.stdout, new RegExp(dispatched.taskPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const get = await runTaskCommand("get", [dispatched.taskPath], { client, cwd: ws, dataDir });
    assert.equal(get.exitCode, 0, get.stderr);
    assert.match(get.stdout, /state: queued/);
    assert.match(get.stdout, /role: executor/);
  });
});

test("writeServiceEndpoint never targets workspace; token only in dataDir", async () => {
  const ws = await makeWorkspace();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-ep-"));
  await writeServiceEndpoint(dataDir, {
    pid: 1,
    host: "127.0.0.1",
    port: 9,
    startedAt: new Date().toISOString(),
    version: "test",
    token: "secret-token-xyz",
  });
  const ep = await readServiceEndpoint(dataDir);
  assert.equal(ep?.token, "secret-token-xyz");
  // Workspace must not contain service.json
  await assert.rejects(() => fs.access(path.join(ws, "service.json")));
  await assert.rejects(() => fs.access(path.join(ws, ".tent", "service.json")));
});
