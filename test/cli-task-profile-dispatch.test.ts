/**
 * CLI user-facing agentProfile dispatch form:
 *   tent task dispatch <boxId> --profile <profileId> [prompt...]
 * Must create assigneeKind=agentProfile + startSession (fake adapter only).
 * Role form remains unchanged and is never inferred from a bare profile-like string.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { loadRolesRegistry } from "../src/core/skillRoleRegistry.js";
import { loadTaskEnvelope } from "../src/core/task.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { runTaskCommand, taskHelpText } from "../src/cli/task-rpc.js";
import { startLocalTentService } from "../src/service/service.js";
import { rpcCall } from "../src/service/http-server.js";
import { configureTestGitIdentity, git } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function makeWorkspace(
  name = "cli-profile-dispatch",
  rolePolicies?: Record<string, "allow" | "ask" | "deny">,
  roleProfiles?: Record<string, string[]>
): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-ap-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    rules: "# RULES\n\nCLI agentProfile dispatch\n",
    boxes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    JSON.stringify(
      {
        roles: [
          {
            name: "executor",
            prompt: "do work",
            ...(rolePolicies?.executor ? { a2aPolicy: rolePolicies.executor } : {}),
            ...(rolePolicies?.executor === "allow"
              ? { allowedProfiles: roleProfiles?.executor ?? ["fake-default"] }
              : roleProfiles?.executor
                ? { allowedProfiles: roleProfiles.executor }
                : {}),
          },
          {
            name: "orchestrator",
            prompt: "dispatch work",
            ...(rolePolicies?.orchestrator
              ? { a2aPolicy: rolePolicies.orchestrator }
              : {}),
            ...(rolePolicies?.orchestrator === "allow"
              ? {
                  allowedProfiles:
                    roleProfiles?.orchestrator ?? ["fake-default"],
                }
              : roleProfiles?.orchestrator
                ? { allowedProfiles: roleProfiles.orchestrator }
                : {}),
          },
        ],
      },
      null,
      2
    ) + "\n"
  );
  return workspace;
}

async function initGitOnWorkspace(workspace: string): Promise<void> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md");
  await git(workspace, "commit", "-q", "-m", "init");
}

function rpc(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  method: string,
  params?: Record<string, unknown>
) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountWorkItem(
  svc: Awaited<ReturnType<typeof startLocalTentService>>,
  ws: string,
  name = "work-item"
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
  return {
    workspaceId,
    boxId: (created.result as { id: string }).id,
  };
}

function cliGlobals(ws: string, dataDir: string) {
  return {
    cwd: ws,
    dataDir,
    attachOnly: true as const,
    packageRoot: repoRoot,
  };
}

test("CLI help documents role and --profile dispatch forms", () => {
  const help = taskHelpText();
  assert.match(help, /tent task dispatch <boxId> <role>/);
  assert.match(help, /tent task dispatch <boxId> --profile <profileId>/);
  assert.match(help, /agentProfile/);
  // Low-level flag is not a primary command form; help may warn users not to pass it.
  assert.doesNotMatch(help, /tent task dispatch[^\n]*--assignee-kind/);
  assert.match(help, /Do not pass --assignee-kind|never inferred as a profile/i);
});

test("CLI --profile dispatch: agentProfile task + startSession (fake); no role registration", async () => {
  const ws = await makeWorkspace("cli-ap-basic");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-ap-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const { workspaceId, boxId } = await mountWorkItem(svc, ws);
    const beforeRoles = await loadRolesRegistry(new NodeFs(path.join(ws, ".tent")));
    const roleCount = beforeRoles.roles.length;

    const result = await runTaskCommand(
      "dispatch",
      [boxId, "--profile", "fake-default", "one-shot from cli", "--json"],
      { ...cliGlobals(ws, dataDir), json: true }
    );
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const parsed = JSON.parse(result.stdout) as {
      taskPath: string;
      state?: string;
      assigneeKind?: string;
      assignee?: string;
      initPath?: string;
      session?: {
        session?: { sessionId?: string; state?: string; profileId?: string };
        sessionId?: string;
        state?: string;
      };
    };
    assert.equal(parsed.assigneeKind, "agentProfile");
    assert.equal(parsed.assignee, "fake-default");
    assert.equal(parsed.state, "running");
    assert.equal(parsed.initPath, undefined);
    assert.match(parsed.taskPath, /^temp\/agent-profiles\/fake-default\/tasks\//);

    const nested = parsed.session?.session;
    const sessionId = nested?.sessionId ?? parsed.session?.sessionId;
    const sessionState = nested?.state ?? parsed.session?.state;
    assert.ok(sessionId, "managed session id must be returned");
    assert.match(String(sessionId), /^ss-/);
    assert.ok(sessionState, "managed session state must be returned");
    assert.ok(
      ["starting", "live", "waiting-user"].includes(String(sessionState)),
      `unexpected session state: ${sessionState}`
    );

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, parsed.taskPath);
    assert.equal(task.assigneeKind, "agentProfile");
    assert.equal(task.role, "fake-default");
    assert.equal(task.state, "running");
    assert.ok(task.sessionId);
    assert.equal(task.sessionId, sessionId);

    // No durable role registration / init for the profile id.
    assert.equal(await envFs.exists("temp/fake-default/init.md"), false);
    assert.equal(await envFs.exists("temp/fake-default"), false);
    const afterRoles = await loadRolesRegistry(envFs);
    assert.equal(afterRoles.roles.length, roleCount);
    assert.ok(!afterRoles.roles.some((r) => r.name === "fake-default"));

    // Text form also prints session id/state.
    const text = await runTaskCommand(
      "dispatch",
      [
        (
          await mountWorkItem(svc, ws, "work-item-text")
        ).boxId,
        "--profile",
        "fake-default",
        "--prompt",
        "text form",
      ],
      cliGlobals(ws, dataDir)
    );
    assert.equal(text.exitCode, 0, text.stderr + text.stdout);
    assert.match(text.stdout, /assigneeKind: agentProfile/);
    assert.match(text.stdout, /sessionId: ss-/);
    assert.match(text.stdout, /sessionState:/);
  } finally {
    await svc.stop();
  }
});

test("CLI role dispatch remains role path; bare profile-like string is not inferred", async () => {
  const ws = await makeWorkspace("cli-role-reg");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-role-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const { boxId } = await mountWorkItem(svc, ws, "role-box");

    const roleResult = await runTaskCommand(
      "dispatch",
      [boxId, "executor", "role path stays", "--json"],
      { ...cliGlobals(ws, dataDir), json: true }
    );
    assert.equal(roleResult.exitCode, 0, roleResult.stderr + roleResult.stdout);
    const roleParsed = JSON.parse(roleResult.stdout) as {
      taskPath: string;
      state?: string;
      assigneeKind?: string;
      initPath?: string;
      session?: unknown;
    };
    assert.equal(roleParsed.assigneeKind, "role");
    assert.equal(roleParsed.state, "queued");
    assert.equal(roleParsed.initPath, "temp/executor/init.md");
    assert.match(roleParsed.taskPath, /^temp\/executor\/tasks\//);
    assert.equal(roleParsed.session, undefined);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const task = await loadTaskEnvelope(envFs, roleParsed.taskPath);
    assert.equal(task.assigneeKind === "agentProfile" ? "agentProfile" : "role", "role");
    assert.equal(task.role, "executor");
    assert.ok(await envFs.exists("temp/executor/init.md"));
    assert.ok(await envFs.exists("temp/executor/manifest.yml"));

    // Bare "fake-default" is a role name attempt — never silent agentProfile.
    const bare = await runTaskCommand(
      "dispatch",
      [
        (await mountWorkItem(svc, ws, "bare-profile-name")).boxId,
        "fake-default",
        "must not become profile",
        "--json",
      ],
      { ...cliGlobals(ws, dataDir), json: true }
    );
    // Service may accept unknown role labels as durable role paths or fail;
    // either way it must NOT create agentProfile under agent-profiles/.
    if (bare.exitCode === 0) {
      const bareParsed = JSON.parse(bare.stdout) as {
        taskPath: string;
        assigneeKind?: string;
        state?: string;
        session?: unknown;
      };
      assert.notEqual(bareParsed.assigneeKind, "agentProfile");
      assert.doesNotMatch(bareParsed.taskPath, /agent-profiles/);
      assert.equal(bareParsed.state, "queued");
      assert.equal(bareParsed.session, undefined);
      const bareTask = await loadTaskEnvelope(envFs, bareParsed.taskPath);
      assert.notEqual(bareTask.assigneeKind, "agentProfile");
    } else {
      assert.match(bare.stderr + bare.stdout, /role|not found|invalid|unknown/i);
    }
  } finally {
    await svc.stop();
  }
});

test("CLI profile dispatch rejects ambiguous prompt / low-level flags; sub wires callerKind=role", async () => {
  const ws = await makeWorkspace(
    "cli-ap-flags",
    { orchestrator: "allow" },
    { orchestrator: ["fake-default"] }
  );
  await initGitOnWorkspace(ws);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-cli-ap-flags-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const { boxId } = await mountWorkItem(svc, ws, "flag-box");

    const bothPrompts = await runTaskCommand(
      "dispatch",
      [boxId, "--profile", "fake-default", "positional", "--prompt", "flag"],
      cliGlobals(ws, dataDir)
    );
    assert.notEqual(bothPrompts.exitCode, 0);
    assert.match(bothPrompts.stderr + bothPrompts.stdout, /not both|Usage:/i);

    const lowLevel = await runTaskCommand(
      "dispatch",
      [boxId, "--assignee-kind", "agentProfile", "fake-default", "x"],
      cliGlobals(ws, dataDir)
    );
    assert.notEqual(lowLevel.exitCode, 0);
    assert.match(lowLevel.stderr + lowLevel.stdout, /assignee-kind|--profile/i);

    const emptyProfile = await runTaskCommand(
      "dispatch",
      [boxId, "--profile", "", "x"],
      cliGlobals(ws, dataDir)
    );
    assert.notEqual(emptyProfile.exitCode, 0);

    const missingBox = await runTaskCommand(
      "dispatch",
      ["--profile", "fake-default", "x"],
      cliGlobals(ws, dataDir)
    );
    assert.notEqual(missingBox.exitCode, 0);

    // Sub profile: --as-sub --by → callerKind=role (A2A allow on orchestrator).
    const subBox = (await mountWorkItem(svc, ws, "sub-profile")).boxId;
    const sub = await runTaskCommand(
      "dispatch",
      [
        subBox,
        "--profile",
        "fake-default",
        "sub profile work",
        "--as-sub",
        "--by",
        "orchestrator",
        "--json",
      ],
      { ...cliGlobals(ws, dataDir), json: true }
    );
    assert.equal(sub.exitCode, 0, sub.stderr + sub.stdout);
    const subParsed = JSON.parse(sub.stdout) as {
      taskPath: string;
      asSub?: boolean;
      assigneeKind?: string;
      state?: string;
      session?: { session?: { sessionId?: string; state?: string } };
      workspaceLane?: { branch?: string; targetBranch?: string };
    };
    assert.equal(subParsed.assigneeKind, "agentProfile");
    assert.equal(subParsed.asSub, true);
    assert.equal(subParsed.state, "running");
    assert.ok(subParsed.session?.session?.sessionId || subParsed.session);
    assert.equal(subParsed.workspaceLane?.targetBranch, "tent-role/orchestrator");
    assert.match(String(subParsed.workspaceLane?.branch ?? ""), /^tent-task\//);

    const envFs = new NodeFs(path.join(ws, ".tent"));
    const subTask = await loadTaskEnvelope(envFs, subParsed.taskPath);
    assert.equal(subTask.assigneeKind, "agentProfile");
    assert.equal(subTask.asSub, true);
    assert.equal(subTask.dispatchedBy, "orchestrator");
    assert.ok(subTask.sessionId);
  } finally {
    await svc.stop();
  }
});
