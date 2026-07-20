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
  retentionSummaryLine,
  validateCredentialSet,
  validateProfileCreate,
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
  ]);
  assert.equal(rows[0]!.verificationLevel, "live-e2e");
  assert.equal(rows[1]!.levelLabel, "mock-tested");
  assert.notEqual(rows[1]!.verificationLevel, "live-e2e");
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
