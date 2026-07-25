/**
 * Local Service proposal RPC: list / submit / resolve + events + CLI routing.
 * Separate from task delivery review (task-api §3).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadProposal } from "../src/core/proposal.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS, isClientMethod } from "../src/service/types.js";
import { runProposalSubmit } from "../src/cli/proposal-rpc.js";
import {
  isLegacyMutationCommand,
  listLegacyMutationCommands,
} from "../src/cli/tent.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxImport = import.meta.resolve("tsx");
const cliSource = path.resolve(repoRoot, "src/cli/tent.ts");

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(
  command: string,
  args: string[],
  cwd: string,
  envExtra: Record<string, string> = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...envExtra },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeWorkspace(name = "proposal-rpc"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-proposal-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nProposal service RPC\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          { name: "planner", prompt: "propose" },
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
  fn: (svc: Awaited<ReturnType<typeof startLocalTentService>>, dataDir: string) => Promise<T>
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-proposal-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    return await fn(svc, dataDir);
  } finally {
    await svc.stop();
  }
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountBox(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  name = "proposal-target"
) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: ws });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  const boxId = (created.result as { id: string }).id;
  return { workspaceId, boxId };
}

type ProposalRow = {
  path: string;
  boxId: string;
  role: string;
  status: string;
  createdAt?: string;
  body: string;
};

test("CLIENT_METHODS includes proposal.list/submit/resolve", () => {
  assert.ok(isClientMethod("proposal.list"));
  assert.ok(isClientMethod("proposal.submit"));
  assert.ok(isClientMethod("proposal.resolve"));
  assert.ok(CLIENT_METHODS.includes("proposal.list"));
  assert.equal(isClientMethod("proposal.apply"), false);
});

test("propose is not a sealed legacy direct-write mutation", () => {
  assert.equal(isLegacyMutationCommand("propose"), false);
  assert.ok(!listLegacyMutationCommands().includes("propose"));
});

test("proposal RPC: submit → list pending → accept → lists + file terminal", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountBox(svc, ws);

    const submitted = (await client.proposalSubmit(workspaceId, {
      boxId,
      role: "planner",
      body: "建议收窄验收标准",
    })) as { proposal: ProposalRow };
    assert.equal(submitted.proposal.status, "pending");
    assert.equal(submitted.proposal.boxId, boxId);
    assert.equal(submitted.proposal.role, "planner");
    assert.equal(submitted.proposal.body, "建议收窄验收标准");
    assert.equal(submitted.proposal.path, `temp/planner/proposals/${boxId}.md`);

    const pending = (await client.proposalList(workspaceId)) as { proposals: ProposalRow[] };
    assert.equal(pending.proposals.length, 1);
    assert.equal(pending.proposals[0]!.status, "pending");
    assert.equal(pending.proposals[0]!.path, submitted.proposal.path);

    const accepted = (await client.proposalResolve(
      workspaceId,
      submitted.proposal.path,
      "accept"
    )) as { proposal: ProposalRow };
    assert.equal(accepted.proposal.status, "accepted");
    assert.equal(accepted.proposal.body, "建议收窄验收标准");

    const pendingAfter = (await client.proposalList(workspaceId, { status: "pending" })) as {
      proposals: ProposalRow[];
    };
    assert.equal(pendingAfter.proposals.length, 0);

    const acceptedList = (await client.proposalList(workspaceId, { status: "accepted" })) as {
      proposals: ProposalRow[];
    };
    assert.equal(acceptedList.proposals.length, 1);
    assert.equal(acceptedList.proposals[0]!.path, submitted.proposal.path);
    assert.equal(acceptedList.proposals[0]!.status, "accepted");

    const fsa = new NodeFs(path.join(ws, ".tent"));
    const onDisk = await loadProposal(fsa, submitted.proposal.path);
    assert.equal(onDisk.status, "accepted");
    assert.equal(onDisk.body, "建议收窄验收标准");
  });
});

test("proposal RPC: reject then resubmit succeeds; second pending fails", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const { workspaceId, boxId } = await mountBox(svc, ws, "reject-resubmit");

    const first = (await client.proposalSubmit(workspaceId, {
      boxId,
      role: "planner",
      body: "first proposal",
    })) as { proposal: ProposalRow };

    const rejected = (await client.proposalResolve(
      workspaceId,
      first.proposal.path,
      "reject"
    )) as { proposal: ProposalRow };
    assert.equal(rejected.proposal.status, "rejected");

    const second = (await client.proposalSubmit(workspaceId, {
      boxId,
      role: "planner",
      body: "revised proposal",
    })) as { proposal: ProposalRow };
    assert.equal(second.proposal.status, "pending");
    assert.equal(second.proposal.body, "revised proposal");
    assert.equal(second.proposal.path, first.proposal.path);

    await assert.rejects(
      () =>
        client.proposalSubmit(workspaceId, {
          boxId,
          role: "planner",
          body: "duplicate pending",
        }),
      /already pending triage/
    );

    const pending = (await client.proposalList(workspaceId, { status: "pending" })) as {
      proposals: ProposalRow[];
    };
    assert.equal(pending.proposals.length, 1);
    assert.equal(pending.proposals[0]!.body, "revised proposal");
  });
});

test("proposal RPC: resolve actor != user denied; proposal remains pending", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountBox(svc, ws, "actor-deny");
    const submitted = await rpc(svc, "proposal.submit", {
      workspaceId,
      boxId,
      role: "planner",
      body: "needs user triage",
    });
    assert.ok(!submitted.error, JSON.stringify(submitted.error));
    const proposalPath = (submitted.result as { proposal: ProposalRow }).proposal.path;

    const denied = await rpc(svc, "proposal.resolve", {
      workspaceId,
      path: proposalPath,
      decision: "accept",
      actor: "planner",
    });
    assert.ok(denied.error);
    assert.equal(denied.error!.code, -32001);
    assert.match(denied.error!.message, /user-only|self-resolve/i);

    const pending = await rpc(svc, "proposal.list", { workspaceId, status: "pending" });
    assert.ok(!pending.error);
    const rows = (pending.result as { proposals: ProposalRow[] }).proposals;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "pending");
    assert.equal(rows[0]!.path, proposalPath);

    const fsa = new NodeFs(path.join(ws, ".tent"));
    assert.equal((await loadProposal(fsa, proposalPath)).status, "pending");
  });
});

test("proposal RPC: exactly one proposal.updated per success; zero on failed transition", async () => {
  const ws = await makeWorkspace();
  await withService(async (svc) => {
    const { workspaceId, boxId } = await mountBox(svc, ws, "events");
    const events: Array<Record<string, unknown>> = [];
    const unsub = svc.events.subscribe((ev) => {
      if (ev.type === "proposal.updated") {
        events.push(ev.payload as Record<string, unknown>);
      }
    });

    const submitted = await rpc(svc, "proposal.submit", {
      workspaceId,
      boxId,
      role: "planner",
      body: "event body",
    });
    assert.ok(!submitted.error, JSON.stringify(submitted.error));
    const proposalPath = (submitted.result as { proposal: ProposalRow }).proposal.path;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.path, proposalPath);
    assert.equal(events[0]!.status, "pending");
    assert.equal(events[0]!.reason, "proposal.submit");
    assert.equal(events[0]!.boxId, boxId);
    assert.equal(events[0]!.role, "planner");

    const failDup = await rpc(svc, "proposal.submit", {
      workspaceId,
      boxId,
      role: "planner",
      body: "should not emit",
    });
    assert.ok(failDup.error);
    assert.equal(events.length, 1, "failed submit must not emit");

    const failActor = await rpc(svc, "proposal.resolve", {
      workspaceId,
      path: proposalPath,
      decision: "accept",
      actor: "planner",
    });
    assert.ok(failActor.error);
    assert.equal(events.length, 1, "failed resolve must not emit");

    const accepted = await rpc(svc, "proposal.resolve", {
      workspaceId,
      path: proposalPath,
      decision: "accept",
      actor: "user",
    });
    assert.ok(!accepted.error, JSON.stringify(accepted.error));
    assert.equal(events.length, 2);
    assert.equal(events[1]!.status, "accepted");
    assert.equal(events[1]!.reason, "proposal.accept");
    assert.equal(events[1]!.path, proposalPath);

    const failAgain = await rpc(svc, "proposal.resolve", {
      workspaceId,
      path: proposalPath,
      decision: "reject",
      actor: "user",
    });
    assert.ok(failAgain.error);
    assert.equal(events.length, 2, "failed terminal re-resolve must not emit");

    unsub();
  });
});

test("in-workspace CLI propose uses Service; ServiceClient sees it (no direct-writer path)", async () => {
  const ws = await makeWorkspace("cli-propose");
  await withService(async (svc, dataDir) => {
    const observer = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mount = (await observer.mount(ws)) as { workspaceId: string };
    const created = (await observer.call("docs.createNote", {
      workspaceId: mount.workspaceId,
      name: "cli-target",
      type: "prompt",
    })) as { id: string };
    const boxId = created.id;

    // Injected client path (unit of CLI helper — sole Service write).
    const viaHelper = await runProposalSubmit(
      { boxId, role: "planner", body: "via service helper" },
      { client: observer, cwd: ws, dataDir }
    );
    assert.equal(viaHelper.exitCode, 0, viaHelper.stderr);
    assert.match(viaHelper.stdout, new RegExp(`temp/planner/proposals/${boxId}\\.md`));

    const listed = (await observer.proposalList(mount.workspaceId, { status: "pending" })) as {
      proposals: ProposalRow[];
    };
    assert.equal(listed.proposals.length, 1);
    assert.equal(listed.proposals[0]!.body, "via service helper");
    assert.equal(listed.proposals[0]!.role, "planner");

    // Attach from endpoint (real CLI attach path, not injected client).
    const created2 = (await observer.call("docs.createNote", {
      workspaceId: mount.workspaceId,
      name: "cli-attach-target",
      type: "prompt",
    })) as { id: string };
    const attachResult = await runProposalSubmit(
      { boxId: created2.id, role: "planner", body: "attach path body" },
      {
        cwd: ws,
        dataDir,
        attachOnly: true,
        packageRoot: repoRoot,
      }
    );
    assert.equal(attachResult.exitCode, 0, attachResult.stderr);
    assert.match(attachResult.stdout, /Proposal submitted for triage/);

    const listed2 = (await observer.proposalList(mount.workspaceId, {
      boxId: created2.id,
      status: "pending",
    })) as { proposals: ProposalRow[] };
    assert.equal(listed2.proposals.length, 1);
    assert.equal(listed2.proposals[0]!.body, "attach path body");

    // Full CLI process with TENT_SERVICE_DATA_DIR → attach same service.
    const created3 = (await observer.call("docs.createNote", {
      workspaceId: mount.workspaceId,
      name: "cli-process-target",
      type: "prompt",
    })) as { id: string };
    const bodyFile = path.join(ws, "proposal-body.md");
    await fs.writeFile(bodyFile, "cli process body\n", "utf8");
    const cli = await run(
      process.execPath,
      ["--import", tsxImport, cliSource, "propose", created3.id, bodyFile],
      ws,
      {
        TENT_ROLE: "planner",
        TENT_SERVICE_DATA_DIR: dataDir,
      }
    );
    assert.match(cli.stdout, new RegExp(`temp/planner/proposals/${created3.id}\\.md`));
    assert.equal(cli.stderr, "");

    const listed3 = (await observer.proposalList(mount.workspaceId, {
      boxId: created3.id,
      status: "pending",
    })) as { proposals: ProposalRow[] };
    assert.equal(listed3.proposals.length, 1);
    assert.equal(listed3.proposals[0]!.body, "cli process body");

    const fsa = new NodeFs(path.join(ws, ".tent"));
    const onDisk = await loadProposal(fsa, `temp/planner/proposals/${boxId}.md`);
    assert.equal(onDisk.status, "pending");
    assert.equal(onDisk.body, "via service helper");

    const health = await fetch(`${svc.url}/health`);
    assert.equal(health.status, 200);
  });
});
