/**
 * Desktop secondary surfaces: graph projection, settings helpers, contract gaps.
 * Pure model tests + light service smoke for provider.catalog / settings RPCs used by UI.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { scaffoldInWorkspace } from "../src/core/scaffold.js";
import { NodeFs } from "../src/fs/node-fs.js";
import { startLocalTentService } from "../src/service/service.js";
import { createServiceClient } from "../src/service/client.js";
import { CLIENT_METHODS } from "../src/service/types.js";
import {
  DESKTOP_CONTRACT_GAPS,
  contractGapIds,
  findContractGap,
} from "../src/desktop/renderer/main/contract-gaps.js";
import {
  buildGraphSelectionView,
  findGraphNode,
  flattenGraphNodes,
  verificationLevelLabel,
} from "../src/desktop/workbench/graph-model.js";
import {
  buildMcpServersPayload,
  buildSkillsPayload,
  ACCEPT_MODE_OPTIONS,
  launchSecretListRow,
  LAUNCH_SECRET_STORE_TYPE,
  mapProviderCatalogRows,
  mcpLaunchSecretStatusLine,
  mcpDraftsFromProjection,
  mcpSourceLine,
  CONNECTION_NEXT_SESSION_TIP,
  connectionDisplayLabel,
  retentionSummaryLine,
  setMcpEnabled,
  setSkillEnabled,
  skillDraftsFromProjection,
  skillSourceLine,
  validateLaunchSecretSet,
  validateMcpAddDraft,
  validateConnectionCreate,
  validateConnectionUpdate,
  validateRoleCreate,
  validateRoleUpdate,
  validateSkillAddDraft,
} from "../src/desktop/workbench/settings-model.js";

test("accept mode settings expose only canonical hard-cut values", () => {
  assert.deepEqual(
    ACCEPT_MODE_OPTIONS.map((option) => option.value),
    ["review-required", "auto-accept", "agent-decide"]
  );
});

test("contract gaps list missing desktop methods without inventing RPCs", () => {
  const ids = contractGapIds();
  assert.ok(ids.includes("graph.bulk"));
  // docs.move landed as the canonical structural move/reparent RPC — gap removed.
  assert.equal(ids.includes("docs.move-reparent"), false);
  assert.ok(CLIENT_METHODS.includes("docs.move"));
  assert.ok(ids.includes("node.permanent-delete"));
  assert.ok(ids.includes("session.logs-reload"));
  // type-tag-mutation closed once Service type/tags RPCs landed on CLIENT_METHODS.
  assert.equal(ids.includes("type-tag-mutation"), false);
  assert.ok(ids.includes("mcp.global-config"));
  // A2U pending batch: field-level holes (not missing listPending RPCs).
  assert.ok(ids.includes("toolApproval.params"));
  assert.ok(ids.includes("taskInput.global-list"));

  for (const gap of DESKTOP_CONTRACT_GAPS) {
    for (const m of gap.methods) {
      assert.equal(
        CLIENT_METHODS.includes(m as (typeof CLIENT_METHODS)[number]),
        false,
        `gap method ${m} should not already be in CLIENT_METHODS`
      );
    }
  }
  assert.equal(findContractGap("graph.bulk")?.fallback.includes("docs.backlinks"), true);
  assert.equal(
    findContractGap("graph.bulk")?.fallback.includes("docs.readForEdit"),
    true,
    "graph out-links use full body via docs.readForEdit, not truncated docs.get bodyPreview"
  );
});

test("flattenGraphNodes preserves tree order and depth", () => {
  const flat = flattenGraphNodes([
    {
      nodeId: "cx-a",
      path: "a",
      name: "A",
      type: "goal",
      coordination: true,
      children: [
        { nodeId: "cx-b", path: "a/b", name: "B", type: "prompt", coordination: false },
      ],
    },
    { nodeId: "cx-c", path: "c", name: "C", type: "prompt", coordination: false },
  ]);
  assert.deepEqual(
    flat.map((n) => `${n.depth}:${n.nodeId}`),
    ["0:cx-a", "1:cx-b", "0:cx-c"]
  );
  assert.equal(findGraphNode([{ nodeId: "cx-a", path: "a", name: "A", type: "goal", coordination: true, children: [{ nodeId: "cx-b", path: "a/b", name: "B", type: "prompt", coordination: false }] }], "cx-b")?.name, "B");
});

test("buildGraphSelectionView never invents edges", () => {
  const empty = buildGraphSelectionView({
    node: { nodeId: "cx-1", path: "x", name: "X", type: "prompt", coordination: false },
  });
  assert.equal(empty.backlinks.length, 0);
  assert.equal(empty.outLinks.length, 0);
  assert.equal(empty.backlinksError, null);

  const withErr = buildGraphSelectionView({
    node: null,
    backlinksError: "rpc failed",
  });
  assert.equal(withErr.backlinksError, "rpc failed");
  assert.equal(withErr.backlinks.length, 0);
});

test("verificationLevelLabel is closed and does not upgrade levels", () => {
  assert.equal(verificationLevelLabel("opt-in-live-probe"), "opt-in live probe");
  assert.equal(
    verificationLevelLabel("live-verified"),
    "live verified (this machine)"
  );
  assert.equal(
    verificationLevelLabel("live-e2e"),
    "opt-in live probe (legacy live-e2e)"
  );
  assert.equal(verificationLevelLabel("mock-tested"), "mock-tested");
  assert.equal(verificationLevelLabel("adapter-implemented"), "adapter only");
  assert.equal(verificationLevelLabel("totally-verified"), "totally-verified");
});

test("mapProviderCatalogRows preserves authoritative verificationLevel", () => {
  const rows = mapProviderCatalogRows([
    {
      adapterId: "grok-acp",
      verificationLevel: "opt-in-live-probe",
      canResume: true,
      nativeForeground: "verified",
    },
    {
      adapterId: "codex-acp",
      verificationLevel: "mock-tested",
      nativeForeground: "unverified",
    },
    {
      adapterId: "claude-acp",
      verificationLevel: "adapter-implemented",
      nativeForeground: "unsupported",
    },
  ]);
  assert.equal(rows[0]!.verificationLevel, "opt-in-live-probe");
  assert.equal(rows[0]!.levelLabel, "opt-in live probe");
  assert.equal(rows[1]!.levelLabel, "mock-tested");
  assert.equal(rows[1]!.verificationLevel, "mock-tested");
  assert.notEqual(rows[1]!.verificationLevel, "live-verified");
  assert.equal(rows[2]!.verificationLevel, "adapter-implemented");
  assert.equal(rows[2]!.levelLabel, "adapter only");
  // UI must not invent machine-local live-verified from weaker levels.
  for (const row of rows) {
    assert.notEqual(row.verificationLevel, "live-verified");
  }
});

test("settings form validators reject bad ids and accept clean payloads", () => {
  assert.equal(validateRoleCreate({ name: "" }).ok, false);
  assert.equal(validateRoleCreate({ name: "1bad" }).ok, false);
  const role = validateRoleCreate({ name: "executor", displayName: "执行" });
  assert.equal(role.ok, true);
  if (role.ok) {
    assert.equal(role.payload.name, "executor");
    assert.equal(role.payload.actor, "user");
  }

  assert.equal(validateRoleUpdate({ name: "" }).ok, false);
  const roleUp = validateRoleUpdate({
    name: "executor",
    roleId: "rl-abc",
    displayName: "执行者",
    prompt: "",
    description: "d",
  });
  assert.equal(roleUp.ok, true);
  if (roleUp.ok) {
    assert.equal(roleUp.payload.name, "executor");
    assert.equal(roleUp.payload.roleId, "rl-abc");
    assert.equal(roleUp.payload.displayName, "执行者");
    assert.equal(roleUp.payload.prompt, null);
    assert.equal("a2aPolicy" in roleUp.payload, false);
    assert.equal(roleUp.payload.actor, "user");
  }

  assert.equal(validateConnectionCreate({ connectionId: "Bad", provider: "grok", adapterId: "grok-acp" }).ok, false);
  const prof = validateConnectionCreate({
    connectionId: "my-agent",
    provider: "grok",
    adapterId: "grok-acp",
    model: "grok-4.5",
  });
  assert.equal(prof.ok, true);
  if (prof.ok) {
    assert.equal(prof.payload.connectionId, "my-agent");
    assert.equal(prof.payload.adapterId, "grok-acp");
    assert.equal(prof.payload.model, "grok-4.5");
  }

  // connection.update: id key only; adapterId never on payload; empty clears.
  assert.equal(validateConnectionUpdate({ connectionId: "" }).ok, false);
  assert.equal(validateConnectionUpdate({ connectionId: "BadId" }).ok, false);
  const profUp = validateConnectionUpdate({
    connectionId: "my-agent",
    displayName: "本地 Grok",
    model: "",
    envKey: "CPA_GROK_API_KEY",
    launchSecretRef: "vault-main",
  });
  assert.equal(profUp.ok, true);
  if (profUp.ok) {
    assert.equal(profUp.payload.connectionId, "my-agent");
    assert.equal(profUp.payload.displayName, "本地 Grok");
    assert.equal(profUp.payload.model, null);
    assert.equal(profUp.payload.envKey, "CPA_GROK_API_KEY");
    assert.equal(profUp.payload.launchSecretRef, "vault-main");
    assert.ok(!("adapterId" in profUp.payload));
    assert.ok(!("secret" in profUp.payload));
    assert.ok(!("apiKey" in profUp.payload));
    assert.ok(!("env" in profUp.payload));
  }
  const clearName = validateConnectionUpdate({ connectionId: "my-agent", displayName: "  " });
  assert.equal(clearName.ok, true);
  if (clearName.ok) assert.equal(clearName.payload.displayName, null);

  assert.equal(connectionDisplayLabel({ connectionId: "p1", displayName: "Label" }), "Label");
  assert.equal(connectionDisplayLabel({ connectionId: "p1", displayName: "" }), "p1");
  assert.match(CONNECTION_NEXT_SESSION_TIP, /下次会话生效/);

  assert.equal(validateLaunchSecretSet({ id: "k", secret: "" }).ok, false);
  const cred = validateLaunchSecretSet({ id: "api-key", secret: "s3cret", label: "main" });
  assert.equal(cred.ok, true);
  if (cred.ok) {
    assert.equal(cred.payload.secret, "s3cret");
    assert.equal(cred.payload.label, "main");
  }

  // credential list row: ref id + type + 已配置 — never secret fields.
  const crow = launchSecretListRow({
    id: "api-key",
    createdAt: "t0",
    updatedAt: "t1",
    label: "main",
  });
  assert.equal(crow.id, "api-key");
  assert.equal(crow.type, LAUNCH_SECRET_STORE_TYPE);
  assert.equal(crow.status, "已配置");
  assert.equal(crow.label, "main");
  assert.ok(!("secret" in crow));
  assert.ok(!("ciphertext" in crow));
});

test("Connection skills/mcp drafts: toggle, id/ref only, no displayName/secrets", () => {
  const skills = skillDraftsFromProjection([
    { name: "tent-task", path: "/home/u/.agents/skills/tent-task", enabled: true },
    { name: "review-helper", enabled: false },
  ]);
  assert.equal(skills.length, 2);
  assert.equal(skills[0]!.enabled, true);
  assert.equal(skills[1]!.enabled, false);
  assert.match(skillSourceLine(skills[0]!), /tent-task/);
  assert.match(skillSourceLine(skills[1]!), /name-only/);

  const toggled = setSkillEnabled(skills, "review-helper", true);
  assert.equal(toggled.find((s) => s.name === "review-helper")?.enabled, true);

  const skillWire = buildSkillsPayload(toggled);
  for (const row of skillWire) {
    assert.ok(row.name);
    assert.ok(!("displayName" in row));
    assert.ok(!("body" in row));
    assert.ok(!("secret" in row));
  }
  assert.equal(skillWire.find((s) => s.name === "review-helper")?.enabled, true);

  const mcps = mcpDraftsFromProjection([
    {
      name: "fs",
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "server"],
      envSecretRefs: { API_KEY: "mcp-key" },
    },
    {
      name: "remote",
      transport: "http",
      enabled: false,
      url: "https://mcp.example.com/mcp",
      headerSecretRefs: { Authorization: "missing-key" },
    },
  ]);
  assert.equal(mcps.length, 2);
  assert.match(mcpSourceLine(mcps[0]!), /stdio/);
  assert.match(mcpSourceLine(mcps[1]!), /http/);

  const disabled = setMcpEnabled(mcps, "fs", false);
  assert.equal(disabled.find((m) => m.name === "fs")?.enabled, false);

  const configured = new Set(["mcp-key"]);
  assert.match(mcpLaunchSecretStatusLine(mcps[0]!, configured), /mcp-key·已配置/);
  assert.match(mcpLaunchSecretStatusLine(mcps[1]!, configured), /missing-key·缺失/);
  // Status line never embeds secret-like values beyond ref ids.
  assert.equal(mcpLaunchSecretStatusLine(mcps[0]!, configured).includes("sk-"), false);

  const mcpWire = buildMcpServersPayload(disabled);
  const wireJson = JSON.stringify(mcpWire);
  assert.equal(wireJson.includes("displayName"), false);
  // No plaintext secret bags (substring-safe: envSecretRefs / header* are allowed).
  assert.equal(/"env"\s*:/.test(wireJson), false);
  assert.equal(/"headers"\s*:/.test(wireJson), false);
  assert.equal(/"secret"\s*:/.test(wireJson), false);
  assert.ok(wireJson.includes("envSecretRefs"));
  assert.ok(wireJson.includes("mcp-key"));
  assert.equal(mcpWire.find((m) => m.name === "fs")?.enabled, false);

  const addSkill = validateSkillAddDraft({ name: "tent-role" });
  assert.equal(addSkill.ok, true);
  assert.equal(validateSkillAddDraft({ name: "" }).ok, false);

  const addMcp = validateMcpAddDraft({
    name: "fs2",
    transport: "stdio",
    command: "npx",
    envSecretName: "API_KEY",
    envLaunchSecretRef: "vault-1",
  });
  assert.equal(addMcp.ok, true);
  if (addMcp.ok) {
    assert.deepEqual(addMcp.entry.envSecretRefs, { API_KEY: "vault-1" });
    assert.ok(!("env" in addMcp.entry));
  }
  assert.equal(
    validateMcpAddDraft({ name: "x", transport: "stdio", command: "" }).ok,
    false
  );
});

test("retentionSummaryLine is compact Chinese status", () => {
  const line = retentionSummaryLine({
    keepTerminalTasksDays: 30,
    candidateTaskCount: 2,
    candidateDeliveryCount: 4,
    warnings: ["a"],
  });
  assert.match(line, /30/);
  assert.match(line, /2/);
  assert.match(line, /4/);
  assert.match(line, /警告/);
});

test("desktop settings RPCs used by UI are on CLIENT_METHODS", () => {
  for (const m of [
    "workspace.settings",
    "workspace.settings.update",
    "workspace.agents",
    "workspace.agents.write",
    "registry.role.create",
    "registry.role.update",
    "registry.role.delete",
    "connection.list",
    "connection.get",
    "connection.create",
    "connection.update",
    "connection.delete",
    "provider.catalog",
    "settings.launchSecret.list",
    "settings.launchSecret.set",
    "settings.launchSecret.delete",
    "skill.list",
    "skill.install",
    "docs.backlinks",
    "docs.list",
    "docs.fork",
    "docs.importAttachment",
    "proposal.list",
    "proposal.resolve",
    "decisionRequest.listPending",
    "decisionRequest.get",
    "decisionRequest.respond",
    "decisionRequest.escalate",
    "toolApproval.listPending",
    "toolApproval.approveOnce",
    "toolApproval.deny",
    "taskInput.listPending",
    "task.sendInput",
    "delivery.list",
    "task.accept",
    "task.reject",
    "task.interrupt",
    "task.cancel",
    "operationalRetention.preview",
    "operationalRetention.purge",
  ]) {
    assert.ok(CLIENT_METHODS.includes(m as (typeof CLIENT_METHODS)[number]), m);
  }
});

test("desktop keeps Launch Secret controls inside Agent Connections, without a standalone credential surface", async () => {
  const source = await fs.readFile(
    path.join(process.cwd(), "src", "desktop", "renderer", "main", "settings.ts"),
    "utf8"
  );
  assert.match(source, /function renderLaunchSecretAdvanced\(\)/);
  assert.match(source, /renderRoutes\(\)[\s\S]*renderLaunchSecretAdvanced\(\)/);
  assert.doesNotMatch(source, /id:\s*"(?:credentials|launchSecrets)"/);
  assert.doesNotMatch(source, /label:\s*"凭证"/);
  assert.doesNotMatch(source, /renderCredentials|renderLaunchSecrets/);
});

test("service smoke: docs.backlinks + provider.catalog for graph/settings", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-surf-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "surf",
    nodes: [
      { name: "alpha", type: "prompt", body: "# alpha\nsee [[beta]]\n" },
      { name: "beta", type: "prompt", body: "# beta\n" },
    ],
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-surf-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = await client.mount(workspace) as { workspaceId: string };
    const list = await client.docsList(mounted.workspaceId);
    const flat: Array<{ nodeId: string; name: string }> = [];
    const walk = (nodes: Array<{ nodeId: string; name: string; children?: unknown[] }>) => {
      for (const n of nodes) {
        flat.push({ nodeId: n.nodeId, name: n.name });
        if (Array.isArray(n.children)) walk(n.children as typeof nodes);
      }
    };
    walk(list.nodes || []);
    const beta = flat.find((n) => n.name === "beta");
    assert.ok(beta, "beta concept present");

    const bl = await client.call<{ backlinks: Array<{ fromName: string }> }>("docs.backlinks", {
      workspaceId: mounted.workspaceId,
      nodeId: beta!.nodeId,
    });
    assert.ok(
      (bl.backlinks || []).some((b) => b.fromName === "alpha"),
      "alpha should backlink to beta"
    );

    const catalog = await client.providerCatalog();
    assert.ok(catalog.providers.length >= 1);
    for (const p of catalog.providers) {
      assert.ok(
        [
          "adapter-implemented",
          "mock-tested",
          "opt-in-live-probe",
          "live-verified",
        ].includes(p.verificationLevel),
        p.adapterId
      );
    }
    const rows = mapProviderCatalogRows(catalog.providers);
    assert.equal(rows.length, catalog.providers.length);
    // UI preserves the backend catalog instead of maintaining its own provider map.
    const optInRows = rows.filter((r) => r.verificationLevel === "opt-in-live-probe");
    const expectedOptIn = catalog.providers
      .filter((p) => p.verificationLevel === "opt-in-live-probe")
      .map((p) => p.adapterId);
    assert.deepEqual(
      optInRows.map((r) => r.adapterId),
      expectedOptIn
    );
    for (const [index, row] of rows.entries()) {
      assert.equal(
        row.verificationLevel,
        catalog.providers[index]?.verificationLevel,
        row.adapterId
      );
    }

    // connection.list / connection.get — safe metadata; id + displayName projection for settings CRUD.
    const listed = (await client.connectionList()) as {
      connections: Array<{
        connectionId: string;
        adapterId: string;
        displayName: string;
        testOnly?: boolean;
      }>;
    };
    assert.ok(Array.isArray(listed.connections));
    assert.ok(listed.connections.some((p) => p.connectionId === "grok-acp-default"));
    const listJson = JSON.stringify(listed);
    assert.ok(!/"env"\s*:/.test(listJson));
    assert.ok(!/sk-[a-zA-Z0-9]{8,}/.test(listJson));

    const got = (await client.connectionGet("grok-acp-default")) as {
      connection: { connectionId: string; adapterId: string; displayName: string };
    };
    assert.equal(got.connection.connectionId, "grok-acp-default");
    assert.equal(got.connection.adapterId, "grok-acp");
    assert.ok(typeof got.connection.displayName === "string");
    assert.equal(
      connectionDisplayLabel(got.connection),
      got.connection.displayName || got.connection.connectionId
    );

    const settings = await client.workspaceSettings(mounted.workspaceId) as {
      settings: { defaultAcceptMode?: string };
    };
    assert.ok(settings.settings);

    const agents = await client.workspaceAgents(mounted.workspaceId) as {
      content: string;
      exists: boolean;
      etag: string;
    };
    assert.equal(typeof agents.content, "string");
    assert.equal(typeof agents.etag, "string");
  } finally {
    await svc.stop();
  }
});
