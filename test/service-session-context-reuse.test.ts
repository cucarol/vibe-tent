/**
 * Production-path tests for managed Session context generation and continuity.
 * These intentionally exercise the real Local Service start/resume/replace paths.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAKE_ADAPTER_ID } from "../src/adapters/fake/index.js";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import {
  extractTaskUserPrompt,
  loadTaskEnvelope,
  patchTaskEnvelope,
  writeTaskEnvelope,
} from "../src/core/task.js";
import {
  buildTaskContextCard,
  isContextGenerationId,
  skillSetCompatibilityDigest,
} from "../src/core/task-context-card.js";
import { loadTent } from "../src/core/tree.js";
import { writeWorkspaceAgents } from "../src/core/workspace-agents.js";
import { NodeFs, SystemClock } from "../src/fs/node-fs.js";
import {
  calculateAgentConnectionLaunchDigest,
  createAgentConnectionSnapshot,
} from "../src/runtime/agent-connection.js";
import type { AgentConnectionConfig } from "../src/runtime/types.js";
import type { ProviderAdapter } from "../src/adapters/types.js";
import {
  appendCallerBootstrapSection,
  assertDurableContextCardRefsResolved,
  collectStableContextGeneration,
} from "../src/service/session-context-generation.js";
import { rpcCall } from "../src/service/http-server.js";
import { startLocalTentService } from "../src/service/service.js";
import { configureTestGitIdentity, git } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
type Svc = Awaited<ReturnType<typeof startLocalTentService>>;

const FAKE_RESUMABLE: AgentConnectionConfig = {
  connectionId: "fake-resumable",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  fake: { waitForSignal: true, canResume: true, sleepMs: 60_000, emitStdout: false },
};

const FAKE_OTHER: AgentConnectionConfig = {
  connectionId: "fake-other",
  provider: "fake",
  adapterId: FAKE_ADAPTER_ID,
  model: "other-model",
  fake: { waitForSignal: true, canResume: true, sleepMs: 60_000, emitStdout: false },
};

async function makeWorkspace(name = "ctx-continuity"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ctx-continuity-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name,
    nodes: [{ name: "inbox", type: "prompt", body: "# inbox\n" }],
  });
  await fsa.writeFile(
    ".tent/roles.json",
    `${JSON.stringify(
      {
        roles: [
          { id: "rl-orchestrator", name: "orchestrator", prompt: "dispatch work" },
          { id: "rl-executor", name: "executor", prompt: "do work" },
        ],
      },
      null,
      2
    )}\n`
  );
  await writeWorkspaceAgents(workspace, "# AGENTS for context generation tests\n");
  return workspace;
}

async function initGit(workspace: string): Promise<void> {
  await git(workspace, "init", "-q", "-b", "main");
  await configureTestGitIdentity(workspace);
  await fs.writeFile(path.join(workspace, ".gitignore"), ".tent/\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# repo\n");
  await git(workspace, "add", ".gitignore", "README.md", "AGENTS.md");
  await git(workspace, "commit", "-q", "-m", "init");
}

async function withService<T>(
  fn: (svc: Svc) => Promise<T>,
  opts?: { connections?: AgentConnectionConfig[]; packageRoot?: string }
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-ctx-data-"));
  const svc = await startLocalTentService({
    dataDir,
    writeEndpoint: true,
    connections: opts?.connections ?? [FAKE_RESUMABLE, FAKE_OTHER],
    ...(opts?.packageRoot ? { packageRoot: opts.packageRoot } : {}),
  });
  enableFakeNativeResume(svc);
  try {
    return await fn(svc);
  } finally {
    await svc.stop();
  }
}

/** Test-only native continuity hook; production ACP adapters provide this themselves. */
function enableFakeNativeResume(svc: Svc): void {
  const adapters = (svc.runtime as unknown as { adapters: Map<string, ProviderAdapter> }).adapters;
  const adapter = adapters.get(FAKE_ADAPTER_ID);
  assert.ok(adapter, "fake adapter must be registered");
  const originalCapabilities = adapter.capabilities.bind(adapter);
  adapter.capabilities = () => ({ ...originalCapabilities(), canResume: true });
  adapter.resumeManagedSession = async (plan, token, emit) => {
    if (plan.bootstrapPrompt) {
      const output = path.join(
        os.tmpdir(),
        `tent-bootstrap-${plan.sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.txt`
      );
      await fs.writeFile(output, plan.bootstrapPrompt, "utf8");
    }
    emit({ type: "session.live", sessionId: plan.sessionId, pid: 4242 });
    let alive = true;
    return {
      sessionId: plan.sessionId,
      pid: 4242,
      providerSessionId: token.providerSessionId ?? token.raw,
      isAlive: () => alive,
      stop: async () => {
        alive = false;
      },
    };
  };
}

function rpc(svc: Svc, method: string, params?: Record<string, unknown>) {
  return rpcCall(svc.url, method, params, { token: svc.token });
}

async function mountWorkItem(svc: Svc, workspace: string) {
  const mounted = await rpc(svc, "workspace.mount", { workspaceRoot: workspace });
  assert.ok(!mounted.error, JSON.stringify(mounted.error));
  const workspaceId = (mounted.result as { workspaceId: string }).workspaceId;
  const nodeId = await createWorkItemNode(svc, workspaceId);
  return { workspaceId, nodeId };
}

let nodeSequence = 0;
async function createWorkItemNode(svc: Svc, workspaceId: string): Promise<string> {
  nodeSequence += 1;
  const created = await rpc(svc, "docs.createNote", {
    workspaceId,
    name: `work-item-${nodeSequence}`,
    type: "prompt",
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  return (created.result as { nodeId: string }).nodeId;
}

async function dispatchConnectionTask(
  svc: Svc,
  workspaceId: string,
  nodeId: string,
  prompt: string,
  connectionId = "fake-resumable"
) {
  const dispatched = await rpc(svc, "task.dispatch", {
    workspaceId,
    nodeIds: [nodeId],
    prompt,
    connectionId,
    parentActor: { kind: "role", id: "rl-orchestrator" },
    reviewer: { kind: "role", id: "rl-orchestrator" },
    callerKind: "user",
  });
  assert.ok(!dispatched.error, JSON.stringify(dispatched.error));
  return dispatched.result as { taskPath: string; session?: { sessionId: string } };
}

async function findFakeBootstrapPrompt(sessionId: string): Promise<string | null> {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  for (const candidate of [
    path.join(os.tmpdir(), `tent-bootstrap-${safe}.txt`),
    path.join(os.tmpdir(), `tent-bootstrap-${sessionId}.txt`),
  ]) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      // Try the next exact adapter output path.
    }
  }
  return null;
}

async function writeMinimalSkillPackage(
  root: string,
  tentTaskBody = "body-v1",
  tentTaskVersion = "1.0.0"
): Promise<void> {
  for (const name of ["tent-task", "tent-role"]) {
    const dir = path.join(root, "skills", name);
    await fs.mkdir(dir, { recursive: true });
    const body = name === "tent-task" ? tentTaskBody : "role-body-v1";
    const version = name === "tent-task" ? tentTaskVersion : "1.0.0";
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\nversion: "${version}"\n---\n\n# ${name}\n${body}\n`
    );
  }
}

test("collectStableContextGeneration digests AGENTS, Skills, and Connection facts without taskId", async () => {
  const workspace = await makeWorkspace("collect");
  try {
    const connectionSnapshot = createAgentConnectionSnapshot(FAKE_RESUMABLE, {});
    const input = {
      workspaceRoot: workspace,
      workspaceIdentity: "ws-collect",
      packageRoot: repoRoot,
      packageVersion: "0.1.0",
      task: {
        sessionId: "ss-collect",
        contextCard: buildTaskContextCard({
          objective: "collect",
          acceptance: ["stable"],
          refs: {
            nodes: [{ id: [...(await loadTent(new NodeFs(path.join(workspace, ".tent")))).byId.keys()][0]! }],
            tasks: [],
            deliveries: [],
            git: [],
          },
        }),
      },
      session: { id: "ss-collect", connectionSnapshot },
      fs: new NodeFs(path.join(workspace, ".tent")),
    };
    const first = await collectStableContextGeneration(input);
    const sameFacts = await collectStableContextGeneration(input);
    assert.ok(isContextGenerationId(first.contextGeneration));
    assert.equal(first.contextGeneration, sameFacts.contextGeneration);
    assert.ok(first.tentTaskDigest);
    assert.equal(first.tentRoleDigest, "", "a Connection executor is not a durable Role");
    assert.equal(first.connectionLaunchDigest, connectionSnapshot.launchDigest);

    await writeWorkspaceAgents(workspace, "# AGENTS changed\n");
    const changed = await collectStableContextGeneration(input);
    assert.notEqual(changed.contextGeneration, first.contextGeneration);

    const userDirect = await collectStableContextGeneration(input);
    assert.ok(isContextGenerationId(userDirect.contextGeneration));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("assertDurableContextCardRefsResolved fails loud on missing Node, Task, or Delivery", async () => {
  const workspace = await makeWorkspace("refs");
  try {
    const fsa = new NodeFs(path.join(workspace, ".tent"));
    const nodeId = [...(await loadTent(fsa)).byId.keys()][0]!;
    const card = (refs: Parameters<typeof buildTaskContextCard>[0]["refs"]) =>
      buildTaskContextCard({ objective: "o", acceptance: ["a"], refs });

    await assertDurableContextCardRefsResolved(
      fsa,
      card({ nodes: [{ id: nodeId }], tasks: [], deliveries: [], git: [{ id: "HEAD" }] })
    );
    await assert.rejects(() =>
      assertDurableContextCardRefsResolved(
        fsa,
        card({ nodes: [{ id: "cx-doesnotexist" }], tasks: [], deliveries: [], git: [] })
      )
    );
    await assert.rejects(() =>
      assertDurableContextCardRefsResolved(
        fsa,
        card({ nodes: [{ id: nodeId }], tasks: [{ id: "tk-zzzzzzzz" }], deliveries: [], git: [] })
      )
    );
    await assert.rejects(() =>
      assertDurableContextCardRefsResolved(
        fsa,
        card({ nodes: [{ id: nodeId }], tasks: [], deliveries: [{ id: "dl-zzzzzzzz" }], git: [] })
      )
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Connection dispatch starts independent exact Sessions and persists each generation", async () => {
  const workspace = await makeWorkspace("dispatch-gen");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const firstResult = await dispatchConnectionTask(svc, workspaceId, nodeId, "Task one");
      const secondResult = await dispatchConnectionTask(
        svc,
        workspaceId,
        await createWorkItemNode(svc, workspaceId),
        "Task two"
      );
      const first = await loadTaskEnvelope(systemFs, firstResult.taskPath);
      const second = await loadTaskEnvelope(systemFs, secondResult.taskPath);
      assert.notEqual(extractTaskUserPrompt(first), extractTaskUserPrompt(second));
      assert.notEqual(first.id, second.id);
      assert.ok(isContextGenerationId(first.contextGeneration!));
      assert.notEqual(
        first.contextGeneration,
        second.contextGeneration,
        "different Node context must produce a different stable generation"
      );
      assert.notEqual(first.taskDeltaDigest, second.taskDeltaDigest);
      assert.equal(
        (await svc.runtime.registry.read(first.sessionId!))?.contextGeneration,
        first.contextGeneration
      );
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("same exact Task resumes native Session; replaceSession is the only explicit fresh recovery", async () => {
  const workspace = await makeWorkspace("resume-replace");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const dispatched = await dispatchConnectionTask(svc, workspaceId, nodeId, "resume me");
      const first = await loadTaskEnvelope(systemFs, dispatched.taskPath);
      const firstId = first.sessionId!;
      const firstRow = await svc.runtime.registry.read(firstId);
      assert.equal(firstRow?.connectionId, "fake-resumable");
      assert.equal(firstRow?.connectionSnapshot?.connectionId, "fake-resumable");
      assert.ok(firstRow?.resumeToken);

      await svc.runtime.stopSession(firstId, "user");
      const resumed = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: first.path,
        callerKind: "user",
      });
      assert.ok(!resumed.error, JSON.stringify(resumed.error));
      assert.equal(
        (resumed.result as { session: { sessionId: string; contextRestored?: boolean } }).session
          .sessionId,
        firstId
      );
      assert.equal((await svc.runtime.registry.read(firstId))?.contextRestored, true);

      await svc.runtime.stopSession(firstId, "user");
      const replaced = await rpc(svc, "task.replaceSession", {
        workspaceId,
        taskPath: first.path,
        callerKind: "user",
      });
      assert.ok(!replaced.error, JSON.stringify(replaced.error));
      const after = await loadTaskEnvelope(systemFs, first.path);
      assert.notEqual(after.sessionId, firstId);
      const replacement = await svc.runtime.registry.read(after.sessionId!);
      assert.equal(replacement?.contextRestored, false);
      assert.equal(replacement?.replacedSessionId, firstId);
      assert.equal((await svc.runtime.registry.read(firstId))?.replacedBySessionId, after.sessionId);
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("startSession fails loud for unresolved durable Node, Task, and Delivery refs", async () => {
  const workspace = await makeWorkspace("missing-refs");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const cases = [
        { bucket: "nodes", value: [{ id: "cx-missingnode" }] },
        { bucket: "tasks", value: [{ id: "tk-zzzzzzzz" }] },
        { bucket: "deliveries", value: [{ id: "dl-zzzzzzzz" }] },
      ] as const;
      for (const entry of cases) {
        const taskNodeId = entry.bucket === "nodes" ? nodeId : await createWorkItemNode(svc, workspaceId);
        const dispatched = await dispatchConnectionTask(
          svc,
          workspaceId,
          taskNodeId,
          `missing ${entry.bucket}`
        );
        const task = await loadTaskEnvelope(systemFs, dispatched.taskPath);
        assert.ok(task.sessionId);
        await svc.runtime.stopSession(task.sessionId!, "user");
        const contextCard = {
          ...task.contextCard,
          refs: { ...task.contextCard.refs, [entry.bucket]: entry.value },
        };
        await patchTaskEnvelope(systemFs, task.path, { contextCard });
        const started = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath: task.path,
          callerKind: "user",
        });
        assert.ok(started.error, `${entry.bucket} must fail loud`);
        assert.match(String(started.error.message), /could not be resolved|UNRESOLVED_REF/i);
      }
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("writeTaskEnvelope persists no dispatch-time generation and remains task-specific by delta", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tent-no-dispatch-gen-"));
  try {
    const systemFs = new NodeFs(root);
    const write = (id: string, nodeId: string, prompt: string) =>
      writeTaskEnvelope(systemFs, new SystemClock(), {
        id,
        sessionId: id === "tk-aaaaaaa1" ? "ss-contexta" : "ss-contextb",
        nodeRefs: [{ id: nodeId, path: `nodes/${nodeId}` }],
        manifestPath: `temp/sessions/${id === "tk-aaaaaaa1" ? "ss-contexta" : "ss-contextb"}/manifests/${id}.yml`,
        userPrompt: prompt,
        parentActor: { kind: "role", id: "rl-orchestrator" },
      });
    const aPath = await write("tk-aaaaaaa1", "cx-contexta", "objective A");
    const bPath = await write("tk-bbbbbbb2", "cx-contextb", "objective B");
    const a = await loadTaskEnvelope(systemFs, aPath);
    const b = await loadTaskEnvelope(systemFs, bPath);
    assert.equal(a.contextGeneration, undefined);
    assert.equal(b.contextGeneration, undefined);
    assert.notEqual(a.taskDeltaDigest, b.taskDeltaDigest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Connection dispatch captures immutable Connection and adapter provenance without purpose identity", async () => {
  const workspace = await makeWorkspace("connection-provenance");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const dispatched = await dispatchConnectionTask(svc, workspaceId, nodeId, "capture Connection");
      const after = await loadTaskEnvelope(systemFs, dispatched.taskPath);
      const row = await svc.runtime.registry.read(after.sessionId!);
      assert.ok(isContextGenerationId(after.contextGeneration!));
      assert.equal(row?.contextGeneration, after.contextGeneration);
      assert.equal(row?.connectionId, "fake-resumable");
      assert.equal(row?.adapterId, FAKE_ADAPTER_ID);
      assert.equal(row?.connectionSnapshot?.launchDigest, calculateAgentConnectionLaunchDigest(FAKE_RESUMABLE));
      assert.equal("purpose" in (row ?? {}), false);
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a different Agent Connection produces an independent Session and generation", async () => {
  const workspace = await makeWorkspace("connection-change");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const first = await dispatchConnectionTask(svc, workspaceId, nodeId, "Connection one");
      const second = await dispatchConnectionTask(
        svc,
        workspaceId,
        await createWorkItemNode(svc, workspaceId),
        "Connection two",
        "fake-other"
      );
      const a = await loadTaskEnvelope(systemFs, first.taskPath);
      const b = await loadTaskEnvelope(systemFs, second.taskPath);
      assert.notEqual(a.sessionId, b.sessionId);
      assert.notEqual(a.contextGeneration, b.contextGeneration);
      assert.equal((await svc.runtime.registry.read(b.sessionId!))?.connectionId, "fake-other");
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendCallerBootstrapSection never replaces official managed bootstrap", () => {
  const official =
    "--- Tent managed session bootstrap ---\nTent managed bootstrap invariant v1\n" +
    "--- End of stable Tent skill contracts ---\ndynamic card\n";
  assert.doesNotMatch(appendCallerBootstrapSection(official), /Caller bootstrap append/);
  const appended = appendCallerBootstrapSection(official, "CUSTOM_ONLY_TEXT");
  assert.match(appended, /managed session bootstrap/);
  assert.match(appended, /Caller bootstrap append/);
  assert.ok(appended.indexOf("managed session bootstrap") < appended.indexOf("CUSTOM_ONLY_TEXT"));
  assert.notEqual(appended.trim(), "CUSTOM_ONLY_TEXT");
});

test("Skill body/version and Connection launch facts participate in compatibility digests", () => {
  const bodyA = skillSetCompatibilityDigest([
    { name: "tent-task", bodyDigest: "body-a", version: "0.1.0" },
  ]);
  const bodyB = skillSetCompatibilityDigest([
    { name: "tent-task", bodyDigest: "body-b", version: "0.1.0" },
  ]);
  const versionB = skillSetCompatibilityDigest([
    { name: "tent-task", bodyDigest: "body-a", version: "0.2.0" },
  ]);
  assert.notEqual(bodyA, bodyB);
  assert.notEqual(bodyA, versionB);
  assert.notEqual(
    calculateAgentConnectionLaunchDigest({ connectionId: "r", provider: "one", adapterId: "a" }),
    calculateAgentConnectionLaunchDigest({ connectionId: "r", provider: "two", adapterId: "a" })
  );
});

test("Connection launch digest covers model, endpoint key, Skill, MCP, and credential references", () => {
  const base: AgentConnectionConfig = {
    connectionId: "same-connection",
    provider: "grok",
    adapterId: "grok-acp",
    command: "node",
    args: ["agent.js"],
    executable: "/usr/bin/grok",
    model: "grok-4",
    envKey: "XAI_API_KEY",
    credentialRef: "cred-main",
    baseUrlEnvKey: "XAI_BASE_URL",
    permissionPolicy: "deny",
    promptTimeoutMs: 60_000,
    skills: [{ name: "extra-skill", path: "/skills/extra", enabled: true }],
    mcpServers: [
      {
        name: "docs-mcp",
        transport: "stdio",
        enabled: true,
        command: "mcp-docs",
        args: ["--stdio"],
        envKeys: { API_TOKEN: "DOCS_TOKEN_ENV" },
        envCredentialRefs: { API_TOKEN: "cred-docs" },
        headerEnvKeys: {},
        headerCredentialRefs: {},
      },
    ],
  };
  const digest = calculateAgentConnectionLaunchDigest(base);
  const variants: AgentConnectionConfig[] = [
    { ...base, model: "grok-4-fast" },
    { ...base, baseUrlEnvKey: "XAI_BASE_URL_ALT" },
    { ...base, credentialRef: "cred-main-alt" },
    { ...base, skills: [{ name: "extra-skill", path: "/skills/v2", enabled: true }] },
    {
      ...base,
      mcpServers: [{ ...base.mcpServers![0]!, envCredentialRefs: { API_TOKEN: "cred-docs-alt" } }],
    },
  ];
  for (const variant of variants) {
    assert.notEqual(calculateAgentConnectionLaunchDigest(variant), digest);
  }
  const snapshot = createAgentConnectionSnapshot(base, { effectiveEndpointDigest: "sha256:endpoint" });
  assert.equal(snapshot.credentialRef, "cred-main");
  assert.equal(snapshot.mcpServers?.[0]?.envCredentialRefs?.API_TOKEN, "cred-docs");
  assert.equal(JSON.stringify(snapshot).includes("actual-secret"), false);
});

test("AGENTS and Skill drift resumes the same Session with refreshed full stable prefix", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skills-drift-"));
  const workspace = await makeWorkspace("live-drift");
  try {
    await writeMinimalSkillPackage(skillRoot);
    await initGit(workspace);
    await withService(
      async (svc) => {
        const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
        const systemFs = new NodeFs(path.join(workspace, ".tent"));
        const dispatched = await dispatchConnectionTask(svc, workspaceId, nodeId, "drift task");
        const first = await loadTaskEnvelope(systemFs, dispatched.taskPath);
        const sessionId = first.sessionId!;
        const generation = first.contextGeneration!;
        await svc.runtime.stopSession(sessionId, "user");

        await writeWorkspaceAgents(workspace, "# AGENTS drifted\n");
        await fs.writeFile(
          path.join(skillRoot, "skills", "tent-task", "SKILL.md"),
          "---\nname: tent-task\nversion: \"1.0.1\"\n---\n\n# tent-task\nbody-v2-mutated\n"
        );

        const resumed = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath: first.path,
          callerKind: "user",
        });
        assert.ok(!resumed.error, JSON.stringify(resumed.error));
        const after = await loadTaskEnvelope(systemFs, first.path);
        assert.equal(after.sessionId, sessionId, "context drift must not replace conversation identity");
        assert.notEqual(after.contextGeneration, generation);
        assert.equal((await svc.runtime.registry.read(sessionId))?.contextGeneration, after.contextGeneration);
        const bootstrap = await findFakeBootstrapPrompt(sessionId);
        assert.ok(bootstrap);
        assert.match(bootstrap!, /Tent managed session bootstrap/);
        assert.match(bootstrap!, /body-v2-mutated|AGENTS/i);
        assert.doesNotMatch(bootstrap!, /Tent managed session delta/);
      },
      { packageRoot: skillRoot }
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});

test("bootstrapPrompt appends on resumed same-Task start while stable prefix dedupes", async () => {
  const workspace = await makeWorkspace("bootstrap-append");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const dispatched = await dispatchConnectionTask(svc, workspaceId, nodeId, "bootstrap task");
      const first = await loadTaskEnvelope(systemFs, dispatched.taskPath);
      const sessionId = first.sessionId!;
      const fresh = await findFakeBootstrapPrompt(sessionId);
      assert.ok(fresh);
      assert.match(fresh!, /Tent managed session bootstrap/);
      assert.doesNotMatch(fresh!, /Caller bootstrap append/);

      await svc.runtime.stopSession(sessionId, "user");
      const resumed = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: first.path,
        callerKind: "user",
        bootstrapPrompt: "RESUME_CUSTOM_APPEND",
      });
      assert.ok(!resumed.error, JSON.stringify(resumed.error));
      assert.equal((await loadTaskEnvelope(systemFs, first.path)).sessionId, sessionId);
      const delta = await findFakeBootstrapPrompt(sessionId);
      assert.ok(delta);
      assert.match(delta!, /Tent managed session delta/);
      assert.match(delta!, /Caller bootstrap append/);
      assert.match(delta!, /RESUME_CUSTOM_APPEND/);
      assert.doesNotMatch(delta!, /Tent managed session bootstrap/);
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("empty Session contextGeneration is not resume authority when token and Connection snapshot are valid", async () => {
  const workspace = await makeWorkspace("empty-generation");
  try {
    await initGit(workspace);
    await withService(async (svc) => {
      const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
      const systemFs = new NodeFs(path.join(workspace, ".tent"));
      const dispatched = await dispatchConnectionTask(svc, workspaceId, nodeId, "resume without prior gen");
      const task = await loadTaskEnvelope(systemFs, dispatched.taskPath);
      const sessionId = task.sessionId!;
      await svc.runtime.stopSession(sessionId, "user");
      await svc.runtime.registry.update(sessionId, { contextGeneration: "" });

      const resumed = await rpc(svc, "task.startSession", {
        workspaceId,
        taskPath: task.path,
        callerKind: "user",
      });
      assert.ok(!resumed.error, JSON.stringify(resumed.error));
      assert.equal(
        (resumed.result as { session: { sessionId: string } }).session.sessionId,
        sessionId
      );
      const after = await loadTaskEnvelope(systemFs, task.path);
      assert.ok(isContextGenerationId(after.contextGeneration!));
      assert.equal((await svc.runtime.registry.read(sessionId))?.contextGeneration, after.contextGeneration);
      assert.match((await findFakeBootstrapPrompt(sessionId))!, /Tent managed session bootstrap/);
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("collector failure on exact-Task resume fails loud without launching a fresh Session", async () => {
  const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tent-skills-fail-"));
  const workspace = await makeWorkspace("collector-fail");
  try {
    await writeMinimalSkillPackage(skillRoot);
    await initGit(workspace);
    await withService(
      async (svc) => {
        const { workspaceId, nodeId } = await mountWorkItem(svc, workspace);
        const systemFs = new NodeFs(path.join(workspace, ".tent"));
        const missingSkill = await dispatchConnectionTask(
          svc,
          workspaceId,
          nodeId,
          "missing skill"
        );
        const beforeFailure = await loadTaskEnvelope(systemFs, missingSkill.taskPath);
        assert.ok(beforeFailure.sessionId);
        await svc.runtime.stopSession(beforeFailure.sessionId!, "user");
        await fs.rm(path.join(skillRoot, "skills", "tent-task", "SKILL.md"));
        const skillFailure = await rpc(svc, "task.startSession", {
          workspaceId,
          taskPath: missingSkill.taskPath,
          callerKind: "user",
        });
        assert.ok(skillFailure.error);
        assert.equal(
          (skillFailure.error as { data?: { code?: string } }).data?.code,
          "CONTEXT_GENERATION_COLLECT_FAILED"
        );
        const afterSkillFailure = await loadTaskEnvelope(systemFs, missingSkill.taskPath);
        assert.equal(afterSkillFailure.sessionId, beforeFailure.sessionId);
        assert.equal(afterSkillFailure.contextGeneration, beforeFailure.contextGeneration);
      },
      { packageRoot: skillRoot }
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(skillRoot, { recursive: true, force: true });
  }
});
