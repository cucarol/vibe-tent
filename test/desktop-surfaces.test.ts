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
  formatAllowedProfilesText,
  mapProviderCatalogRows,
  parseAllowedProfilesText,
  PROFILE_NEXT_SESSION_TIP,
  profileDisplayLabel,
  retentionSummaryLine,
  validateCredentialSet,
  validateProfileCreate,
  validateProfileUpdate,
  validateRoleCreate,
  validateRoleUpdate,
} from "../src/desktop/workbench/settings-model.js";

test("contract gaps list missing desktop methods without inventing RPCs", () => {
  const ids = contractGapIds();
  assert.ok(ids.includes("graph.bulk"));
  assert.ok(ids.includes("docs.move-reparent"));
  assert.ok(ids.includes("concept.permanent-delete"));
  assert.ok(ids.includes("session.logs-reload"));
  assert.ok(ids.includes("type-tag-mutation"));
  assert.ok(ids.includes("mcp.global-config"));
  // A2U pending batch: field-level holes (not missing listPending RPCs).
  assert.ok(ids.includes("toolApproval.params"));
  assert.ok(ids.includes("userAsk.agent-profile"));
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
      id: "cx-a",
      path: "a",
      name: "A",
      type: "goal",
      coordination: true,
      children: [
        { id: "cx-b", path: "a/b", name: "B", type: "note", coordination: false },
      ],
    },
    { id: "cx-c", path: "c", name: "C", type: "note", coordination: false },
  ]);
  assert.deepEqual(
    flat.map((n) => `${n.depth}:${n.id}`),
    ["0:cx-a", "1:cx-b", "0:cx-c"]
  );
  assert.equal(findGraphNode([{ id: "cx-a", path: "a", name: "A", type: "goal", coordination: true, children: [{ id: "cx-b", path: "a/b", name: "B", type: "note", coordination: false }] }], "cx-b")?.name, "B");
});

test("buildGraphSelectionView never invents edges", () => {
  const empty = buildGraphSelectionView({
    node: { id: "cx-1", path: "x", name: "X", type: "note", coordination: false },
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
  assert.equal(verificationLevelLabel("live-e2e"), "live E2E");
  assert.equal(verificationLevelLabel("mock-tested"), "mock-tested");
  assert.equal(verificationLevelLabel("adapter-implemented"), "adapter only");
  assert.equal(verificationLevelLabel("totally-verified"), "totally-verified");
});

test("mapProviderCatalogRows preserves authoritative verificationLevel", () => {
  const rows = mapProviderCatalogRows([
    { adapterId: "grok-acp", verificationLevel: "live-e2e", canResume: true },
    { adapterId: "codex-acp", verificationLevel: "mock-tested" },
    { adapterId: "claude-acp", verificationLevel: "adapter-implemented" },
  ]);
  assert.equal(rows[0]!.verificationLevel, "live-e2e");
  assert.equal(rows[0]!.levelLabel, "live E2E");
  assert.equal(rows[1]!.levelLabel, "mock-tested");
  assert.equal(rows[1]!.verificationLevel, "mock-tested");
  assert.notEqual(rows[1]!.verificationLevel, "live-e2e");
  assert.equal(rows[2]!.verificationLevel, "adapter-implemented");
  assert.equal(rows[2]!.levelLabel, "adapter only");
  // UI must not upgrade non-Grok entries.
  for (const row of rows.filter((r) => r.adapterId !== "grok-acp")) {
    assert.notEqual(row.verificationLevel, "live-e2e");
  }
});

test("settings form validators reject bad ids and accept clean payloads", () => {
  assert.equal(validateRoleCreate({ name: "" }).ok, false);
  assert.equal(validateRoleCreate({ name: "1bad" }).ok, false);
  const role = validateRoleCreate({ name: "executor", displayName: "执行", a2aPolicy: "ask" });
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
    a2aPolicy: "allow",
    allowedProfilesText: "grok-acp-default, other",
  });
  assert.equal(roleUp.ok, true);
  if (roleUp.ok) {
    assert.equal(roleUp.payload.name, "executor");
    assert.equal(roleUp.payload.roleId, "rl-abc");
    assert.equal(roleUp.payload.displayName, "执行者");
    assert.equal(roleUp.payload.prompt, null);
    assert.equal(roleUp.payload.a2aPolicy, "allow");
    assert.deepEqual(roleUp.payload.allowedProfiles, ["grok-acp-default", "other"]);
    assert.equal(roleUp.payload.actor, "user");
  }
  assert.deepEqual(parseAllowedProfilesText(" a, b  b "), ["a", "b"]);
  assert.equal(formatAllowedProfilesText(["x", "y"]), "x, y");

  assert.equal(validateProfileCreate({ id: "Bad", adapterId: "grok-acp" }).ok, false);
  const prof = validateProfileCreate({
    id: "my-agent",
    adapterId: "grok-acp",
    model: "grok-4.5",
  });
  assert.equal(prof.ok, true);
  if (prof.ok) {
    assert.equal(prof.payload.id, "my-agent");
    assert.equal(prof.payload.adapterId, "grok-acp");
    assert.equal(prof.payload.model, "grok-4.5");
  }

  // profile.update: id key only; adapterId never on payload; empty clears.
  assert.equal(validateProfileUpdate({ id: "" }).ok, false);
  assert.equal(validateProfileUpdate({ id: "BadId" }).ok, false);
  const profUp = validateProfileUpdate({
    id: "my-agent",
    displayName: "本地 Grok",
    model: "",
    envKey: "CPA_GROK_API_KEY",
    credentialRef: "vault-main",
  });
  assert.equal(profUp.ok, true);
  if (profUp.ok) {
    assert.equal(profUp.payload.id, "my-agent");
    assert.equal(profUp.payload.displayName, "本地 Grok");
    assert.equal(profUp.payload.model, null);
    assert.equal(profUp.payload.envKey, "CPA_GROK_API_KEY");
    assert.equal(profUp.payload.credentialRef, "vault-main");
    assert.ok(!("adapterId" in profUp.payload));
    assert.ok(!("secret" in profUp.payload));
    assert.ok(!("apiKey" in profUp.payload));
    assert.ok(!("env" in profUp.payload));
  }
  const clearName = validateProfileUpdate({ id: "my-agent", displayName: "  " });
  assert.equal(clearName.ok, true);
  if (clearName.ok) assert.equal(clearName.payload.displayName, null);

  assert.equal(profileDisplayLabel({ id: "p1", displayName: "Label" }), "Label");
  assert.equal(profileDisplayLabel({ id: "p1", displayName: "" }), "p1");
  assert.match(PROFILE_NEXT_SESSION_TIP, /下次会话生效/);

  assert.equal(validateCredentialSet({ id: "k", secret: "" }).ok, false);
  const cred = validateCredentialSet({ id: "api-key", secret: "s3cret", label: "main" });
  assert.equal(cred.ok, true);
  if (cred.ok) {
    assert.equal(cred.payload.secret, "s3cret");
    assert.equal(cred.payload.label, "main");
  }
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
    "profile.list",
    "profile.get",
    "profile.create",
    "profile.update",
    "profile.delete",
    "provider.catalog",
    "credential.list",
    "credential.set",
    "credential.delete",
    "skill.list",
    "skill.install",
    "docs.backlinks",
    "docs.list",
    "docs.fork",
    "docs.importAttachment",
    "proposal.list",
    "proposal.resolve",
    "userAsk.deny",
    "userAsk.listPending",
    "userAsk.reply",
    "a2a.listPending",
    "a2a.resolve",
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

test("service smoke: docs.backlinks + provider.catalog for graph/settings", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tent-surf-ws-"));
  const fsa = new NodeFs(workspace);
  await scaffoldInWorkspace(fsa, {
    name: "surf",
    rules: "# RULES\n",
    boxes: [
      { name: "alpha", type: "note", body: "# alpha\nsee [[beta]]\n" },
      { name: "beta", type: "note", body: "# beta\n" },
    ],
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tent-surf-data-"));
  const svc = await startLocalTentService({ dataDir, writeEndpoint: true });
  try {
    const client = createServiceClient({ baseUrl: svc.url, token: svc.token });
    const mounted = await client.mount(workspace) as { workspaceId: string };
    const list = await client.docsList(mounted.workspaceId) as {
      concepts: Array<{ id: string; name: string; children?: unknown[] }>;
    };
    const flat: Array<{ id: string; name: string }> = [];
    const walk = (nodes: Array<{ id: string; name: string; children?: unknown[] }>) => {
      for (const n of nodes) {
        flat.push({ id: n.id, name: n.name });
        if (Array.isArray(n.children)) walk(n.children as typeof nodes);
      }
    };
    walk(list.concepts || []);
    const beta = flat.find((n) => n.name === "beta");
    assert.ok(beta, "beta concept present");

    const bl = await client.call<{ backlinks: Array<{ fromName: string }> }>("docs.backlinks", {
      workspaceId: mounted.workspaceId,
      id: beta!.id,
    });
    assert.ok(
      (bl.backlinks || []).some((b) => b.fromName === "alpha"),
      "alpha should backlink to beta"
    );

    const catalog = await client.providerCatalog();
    assert.ok(catalog.providers.length >= 1);
    for (const p of catalog.providers) {
      assert.ok(
        ["adapter-implemented", "mock-tested", "live-e2e"].includes(p.verificationLevel),
        p.adapterId
      );
    }
    const rows = mapProviderCatalogRows(catalog.providers);
    assert.equal(rows.length, catalog.providers.length);
    // Only grok-acp may carry live-e2e; never upgrade other providers in UI mapping.
    const liveRows = rows.filter((r) => r.verificationLevel === "live-e2e");
    assert.deepEqual(
      liveRows.map((r) => r.adapterId),
      ["grok-acp"]
    );
    for (const row of rows) {
      if (row.adapterId !== "grok-acp") {
        assert.notEqual(row.verificationLevel, "live-e2e", row.adapterId);
      }
    }

    // profile.list / profile.get — safe metadata; id + displayName projection for settings CRUD.
    const listed = (await client.profileList()) as {
      profiles: Array<{
        id: string;
        adapterId: string;
        displayName: string;
        testOnly?: boolean;
      }>;
    };
    assert.ok(Array.isArray(listed.profiles));
    assert.ok(listed.profiles.some((p) => p.id === "grok-acp-default"));
    const listJson = JSON.stringify(listed);
    assert.ok(!/"env"\s*:/.test(listJson));
    assert.ok(!/sk-[a-zA-Z0-9]{8,}/.test(listJson));

    const got = (await client.profileGet("grok-acp-default")) as {
      profile: { id: string; adapterId: string; displayName: string };
    };
    assert.equal(got.profile.id, "grok-acp-default");
    assert.equal(got.profile.adapterId, "grok-acp");
    assert.ok(typeof got.profile.displayName === "string");
    assert.equal(profileDisplayLabel(got.profile), got.profile.displayName || got.profile.id);

    const settings = await client.workspaceSettings(mounted.workspaceId) as {
      settings: { defaultDeliveryPolicy?: string };
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
